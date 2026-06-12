# ============================================================
#  REBALANCEO DE PORTAFOLIO
# ============================================================
#  Dado:
#    - posiciones actuales {ticker: shares_owned}
#    - pesos objetivo      {ticker: peso_fraccion}
#    - monto_extra (opcional) — dinero nuevo que se quiere agregar
#    - umbral_pp (opcional)   — mínima desviación para sugerir trade
#    - solo_comprar (opcional) — si True, no sugiere ventas
#
#  Calcula cuántas acciones comprar/vender para volver al target,
#  usando precios actuales de yfinance (fast_info, ~15 min delay).
#
#  Diseño:
#    - Redondeo de shares a int (acciones enteras).
#    - Manejo conservador: si el drift es menor al umbral, se queda en
#      "mantener" (evita trades por cambios triviales).
#    - Modo "solo agregar" distribuye el monto nuevo entre los
#      sub-representados hasta agotar o empatar.
#
#  Salida es 100% descriptiva. Mensajes estilo "requiere vender 3",
#  NUNCA "vende 3 acciones".
# ============================================================
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import yfinance as yf


# ------------------------------------------------------------
# Config
# ------------------------------------------------------------
UMBRAL_PP_DEFAULT = 2.0       # pp mínimo de drift para sugerir trade
ISR_MX_PCT = 10.0             # % de ISR aproximado sobre ganancias en bolsa (MX, persona física)


# ------------------------------------------------------------
# Precios
# ------------------------------------------------------------
def _precio_fresco(t: str) -> float | None:
    """Devuelve el último precio de un ticker. Devuelve None si falla."""
    try:
        info = yf.Ticker(t).fast_info
        for key in ("last_price", "lastPrice", "regular_market_price", "regularMarketPrice"):
            try:
                v = info[key] if hasattr(info, "__getitem__") else getattr(info, key, None)
                if v is not None:
                    return float(v)
            except (KeyError, TypeError):
                continue
        return None
    except Exception:
        return None


def _precios_de(tickers: list[str]) -> dict[str, float]:
    """Baja precios en paralelo. Devuelve solo los que respondieron."""
    out: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for t, p in zip(tickers, ex.map(_precio_fresco, tickers)):
            if p is not None:
                out[t] = p
    return out


# ------------------------------------------------------------
# Lógica principal
# ------------------------------------------------------------
def _frecuencia_sugerida(drift_promedio_pp: float) -> str:
    """Texto corto con sugerencia de cadencia según el drift observado."""
    if drift_promedio_pp < 1.5:
        return ("Con esta desviación, revisar cada 3–6 meses suele ser suficiente. "
                "Rebalancear demasiado seguido acumula costos sin mejorar mucho el resultado.")
    if drift_promedio_pp < 4.0:
        return ("Tu portafolio ya drifteó algo. Revisiones trimestrales son razonables "
                "para horizontes de 5+ años.")
    return ("El drift es considerable. Puede tener sentido rebalancear ahora y después "
            "revisar cada 3 meses para no volver a estirarte tanto.")


def calcular_rebalanceo(
    posiciones: dict[str, float],
    target_pesos: dict[str, float],
    monto_extra: float = 0.0,
    solo_comprar: bool = False,
    umbral_pp: float = UMBRAL_PP_DEFAULT,
) -> dict:
    """
    Calcula el plan de rebalanceo.

    Args:
        posiciones:    {ticker: shares_owned}   — lo que tiene el usuario hoy.
        target_pesos:  {ticker: weight_fraction} — suma ~1.0.
        monto_extra:   $ nuevo a agregar (opcional).
        solo_comprar:  si True, no sugiere ventas (útil para flujos de DCA).
        umbral_pp:     diferencia mínima de pp para sugerir un cambio.

    Returns:
        dict con:
            plan: lista por ticker con acción sugerida
            resumen: totales + cash remanente + sugerencias
    """
    # Validaciones básicas
    if not target_pesos:
        raise ValueError("Se requiere al menos un ticker en target_pesos")

    if monto_extra < 0:
        raise ValueError("monto_extra no puede ser negativo")

    # Normalizar target (por si suman 0.98 o 1.02 por redondeos)
    suma_target = sum(target_pesos.values())
    if suma_target <= 0:
        raise ValueError("La suma de pesos objetivo debe ser positiva")
    target_norm = {t: w / suma_target for t, w in target_pesos.items()}

    # Bajar precios actuales
    tickers = list(target_norm.keys())
    precios = _precios_de(tickers)

    # Si algún ticker no dio precio, no podemos calcular — lo reportamos
    faltantes = [t for t in tickers if t not in precios]
    if faltantes:
        return {
            "error": f"No pude obtener precio actual de: {', '.join(faltantes)}",
            "plan": [],
            "resumen": {},
        }

    # Valor actual por ticker y total
    valor_actual_por = {t: posiciones.get(t, 0) * precios[t] for t in tickers}
    valor_actual = sum(valor_actual_por.values())

    # Valor objetivo total = lo que ya tengo + lo que quiero agregar
    valor_objetivo_total = valor_actual + monto_extra

    if valor_objetivo_total <= 0:
        raise ValueError(
            "El valor total del portafolio es cero. Ingresa posiciones o un monto extra."
        )

    # Calcular plan por ticker
    plan = []
    for t in tickers:
        precio = precios[t]
        shares_actual = float(posiciones.get(t, 0))
        valor_act = shares_actual * precio

        peso_target_pct = target_norm[t] * 100
        peso_actual_pct = (valor_act / valor_actual * 100) if valor_actual > 0 else 0.0
        drift_pp = peso_actual_pct - peso_target_pct

        valor_objetivo_t = valor_objetivo_total * target_norm[t]
        shares_objetivo_exact = valor_objetivo_t / precio if precio > 0 else 0
        # Redondeo a acciones enteras (bolsa no acepta fracciones en MX, y
        # en USA la mayoría de brokers tampoco para retail)
        shares_objetivo = round(shares_objetivo_exact)
        shares_cambio = shares_objetivo - shares_actual

        # Decisión de acción
        accion = "mantener"
        razon = ""

        if shares_cambio > 0:
            accion = "comprar"
        elif shares_cambio < 0:
            if solo_comprar:
                accion = "mantener"
                razon = "modo solo-comprar: se mantiene aunque esté por encima del target."
                shares_cambio = 0
            else:
                accion = "vender"

        # Filtro por umbral
        if accion in ("comprar", "vender") and abs(drift_pp) < umbral_pp:
            razon = f"drift {drift_pp:+.2f} pp está por debajo del umbral {umbral_pp:.1f} pp — no amerita trade."
            accion = "mantener"
            shares_cambio = 0

        monto_cambio = shares_cambio * precio

        plan.append({
            "ticker":            t,
            "precio_actual":     round(precio, 2),
            "shares_actual":     round(shares_actual, 4),
            "valor_actual":      round(valor_act, 2),
            "peso_actual_pct":   round(peso_actual_pct, 2),
            "peso_target_pct":   round(peso_target_pct, 2),
            "drift_pp":          round(drift_pp, 2),
            "shares_objetivo":   int(shares_objetivo),
            "shares_cambio":     int(shares_cambio),
            "monto_cambio":      round(monto_cambio, 2),
            "accion":            accion,
            "razon":             razon,
        })

    # Resumen
    total_comprar = sum(p["monto_cambio"] for p in plan if p["shares_cambio"] > 0)
    total_vender  = sum(-p["monto_cambio"] for p in plan if p["shares_cambio"] < 0)
    trades = sum(1 for p in plan if p["accion"] != "mantener")

    # Cash remanente tras el plan (si solo_comprar, puede sobrar; si no, debería cuadrar)
    cash_usado = total_comprar - total_vender
    cash_remanente = monto_extra - cash_usado  # puede ser negativo si total_vender > monto_extra + total_comprar? No debería.
    if cash_remanente < 0 and not solo_comprar:
        # Significa que el plan requiere vender más de lo que se compra; es normal con drift
        cash_remanente = 0.0

    drifts_abs = [abs(p["drift_pp"]) for p in plan]
    drift_prom = sum(drifts_abs) / len(drifts_abs) if drifts_abs else 0.0

    # Aviso de impuestos MX (solo aplica si hay ventas)
    aviso_impuestos = None
    if total_vender > 0 and not solo_comprar:
        aviso_impuestos = (
            f"Vender acciones con ganancia genera ISR en México (aprox. {ISR_MX_PCT:.0f}% para "
            "personas físicas en operaciones bursátiles). Revisa tu costo promedio antes de ejecutar. "
            "Esta app no calcula tu base fiscal; eso corresponde a tu broker o contador."
        )

    resumen = {
        "valor_actual":        round(valor_actual, 2),
        "monto_extra":         round(monto_extra, 2),
        "valor_objetivo":      round(valor_objetivo_total, 2),
        "total_a_comprar":     round(total_comprar, 2),
        "total_a_vender":      round(total_vender, 2),
        "cash_remanente":      round(max(cash_remanente, 0.0), 2),
        "num_trades":          trades,
        "drift_promedio_pp":   round(drift_prom, 2),
        "umbral_pp":           umbral_pp,
        "modo":                "solo_comprar" if solo_comprar else "comprar_y_vender",
        "sugerencia_frecuencia": _frecuencia_sugerida(drift_prom),
        "aviso_impuestos":     aviso_impuestos,
    }

    return {
        "plan":    plan,
        "resumen": resumen,
    }
