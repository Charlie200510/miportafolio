# ============================================================
#  CALCULADORA DE ISR MX + TAX-LOSS HARVESTING
# ============================================================
#  Aplica reglas generales del SAT para personas físicas que
#  operan acciones en BMV/BIVA (art. 129 LISR):
#
#    - 10% de ISR sobre la ganancia NETA del ejercicio fiscal
#      (ganancias realizadas − pérdidas realizadas).
#
#    - Las pérdidas netas de un año se pueden arrastrar hasta
#      10 ejercicios posteriores, pero SOLO para compensar
#      ganancias en bolsa de esos años.
#
#    - Se usa el método de costo promedio ponderado para
#      determinar la base de cada venta (mismo que `transacciones.py`).
#
#  Limitaciones importantes (avisadas al usuario):
#    - No cubre dividendos (retención diferente).
#    - No cubre ETFs extranjeros vía SIC con reglas especiales.
#    - No cubre derivados ni FIBRAS (tratamientos distintos).
#    - No sustituye a un contador.
# ============================================================
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import yfinance as yf


ISR_PCT = 10.0         # 10% sobre ganancia neta en bolsa MX (personas físicas)
ANOS_ARRASTRE = 10     # pérdida se arrastra hasta 10 ejercicios


# ------------------------------------------------------------
# Precios (para harvest)
# ------------------------------------------------------------
def _precio_fresco(t: str) -> float | None:
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
    if not tickers:
        return {}
    out: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for t, p in zip(tickers, ex.map(_precio_fresco, tickers)):
            if p is not None:
                out[t] = p
    return out


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def _parse_fecha(s: str):
    try:
        return datetime.strptime(s.strip(), "%Y-%m-%d")
    except Exception:
        return None


def _ano_fiscal(s: str) -> int | None:
    d = _parse_fecha(s)
    return d.year if d else None


# ------------------------------------------------------------
# Cálculo principal
# ------------------------------------------------------------
def calcular_impuestos(transacciones: list[dict], incluir_harvest: bool = True) -> dict:
    """
    Procesa transacciones cronológicamente, identifica ventas y su
    ganancia/pérdida realizada, agrupa por año fiscal, calcula ISR,
    y opcionalmente sugiere oportunidades de tax-loss harvesting.
    """
    if not transacciones:
        return {
            "por_ano": [],
            "perdidas_arrastrables": 0.0,
            "harvest": {"oportunidades": [], "disponible": True},
            "totales": {
                "ganancia_realizada_historica": 0.0,
                "isr_estimado_historico": 0.0,
                "ano_actual": datetime.now().year,
                "ganancia_neta_ano_actual": 0.0,
                "isr_estimado_ano_actual": 0.0,
            },
            "avisos": [
                "Aún no hay transacciones. Captura compras y ventas para ver tu situación fiscal."
            ],
        }

    # Normalizar mínimamente
    txs = []
    for raw in transacciones:
        ticker = str(raw.get("ticker") or "").strip().upper()
        tipo   = str(raw.get("tipo") or "").strip().lower()
        fecha  = str(raw.get("fecha") or "").strip()
        if not ticker or tipo not in ("compra", "venta") or not _parse_fecha(fecha):
            continue
        try:
            shares = float(raw.get("shares") or 0)
            precio = float(raw.get("precio_unitario") or 0)
            comis  = float(raw.get("comisiones") or 0)
        except (TypeError, ValueError):
            continue
        if shares <= 0 or precio <= 0:
            continue
        txs.append({
            "ticker": ticker,
            "tipo":   tipo,
            "fecha":  fecha,
            "shares": shares,
            "precio": precio,
            "comis":  comis,
            "moneda": str(raw.get("moneda") or "USD").strip().upper(),
        })

    # Orden cronológico (compras antes que ventas el mismo día)
    orden_tipo = {"compra": 0, "venta": 1}
    txs.sort(key=lambda t: (t["fecha"], orden_tipo[t["tipo"]]))

    # Estado por ticker para costo promedio
    estado: dict[str, dict] = {}
    eventos_venta = []  # cada venta con su ganancia/pérdida realizada

    for tx in txs:
        t = tx["ticker"]
        if t not in estado:
            estado[t] = {"shares": 0.0, "costo_total": 0.0}
        e = estado[t]
        bruto = tx["shares"] * tx["precio"]

        if tx["tipo"] == "compra":
            e["costo_total"] += bruto + tx["comis"]
            e["shares"]      += tx["shares"]
        else:  # venta
            if tx["shares"] > e["shares"] + 1e-9:
                continue  # ignorar ventas inválidas
            avg = e["costo_total"] / e["shares"] if e["shares"] > 0 else 0
            costo_venta = avg * tx["shares"]
            ingreso = bruto - tx["comis"]
            pnl = ingreso - costo_venta
            eventos_venta.append({
                "fecha":            tx["fecha"],
                "ano":              _ano_fiscal(tx["fecha"]),
                "ticker":           t,
                "shares":           tx["shares"],
                "precio_venta":     round(tx["precio"], 2),
                "costo_promedio":   round(avg, 4),
                "ingreso_neto":     round(ingreso, 2),
                "costo_base_venta": round(costo_venta, 2),
                "pnl_realizado":    round(pnl, 2),
                "tipo":             "ganancia" if pnl >= 0 else "perdida",
            })
            e["costo_total"] -= costo_venta
            e["shares"]      -= tx["shares"]

    # Agrupar por año fiscal
    ano_actual = datetime.now().year
    por_ano_dict: dict[int, dict] = {}
    for ev in eventos_venta:
        a = ev["ano"]
        if a not in por_ano_dict:
            por_ano_dict[a] = {
                "ano":                  a,
                "ganancias_realizadas": 0.0,
                "perdidas_realizadas":  0.0,  # valor positivo (magnitud)
                "ganancia_neta":        0.0,
                "isr_estimado":         0.0,
                "num_ventas":           0,
                "eventos":              [],
                "ya_declarado":         a < ano_actual,
            }
        g = por_ano_dict[a]
        if ev["pnl_realizado"] >= 0:
            g["ganancias_realizadas"] += ev["pnl_realizado"]
        else:
            g["perdidas_realizadas"] += abs(ev["pnl_realizado"])
        g["num_ventas"] += 1
        g["eventos"].append(ev)

    # Calcular neto e ISR por año + carry-forward de pérdidas
    por_ano_lista = sorted(por_ano_dict.values(), key=lambda x: x["ano"])
    perdidas_disponibles = 0.0  # pérdidas acumuladas de años previos

    for g in por_ano_lista:
        neto_crudo = g["ganancias_realizadas"] - g["perdidas_realizadas"]

        # Si neto positivo, compenso con pérdidas arrastradas
        perdida_usada = 0.0
        if neto_crudo > 0 and perdidas_disponibles > 0:
            perdida_usada = min(neto_crudo, perdidas_disponibles)
            perdidas_disponibles -= perdida_usada

        neto_final = neto_crudo - perdida_usada
        isr = max(0, neto_final) * (ISR_PCT / 100.0)

        # Si neto es negativo, esa pérdida pasa al pool de arrastre
        if neto_crudo < 0:
            perdidas_disponibles += abs(neto_crudo)

        g["ganancias_realizadas"] = round(g["ganancias_realizadas"], 2)
        g["perdidas_realizadas"]  = round(g["perdidas_realizadas"], 2)
        g["ganancia_bruta"]       = round(neto_crudo, 2)     # neto antes de arrastre
        g["ganancia_neta"]        = round(neto_final, 2)     # neto después de arrastre (= base gravable)
        g["ganancia_neta_final"]  = round(neto_final, 2)     # alias para el frontend
        g["perdida_arrastrada_usada"] = round(perdida_usada, 2)
        g["perdida_arrastre_usada"]   = round(perdida_usada, 2)   # alias
        g["isr_estimado"]         = round(isr, 2)

    # Oportunidades de harvesting
    harvest_oport = []
    harvest_info = {
        "oportunidades": [],
        "disponible": incluir_harvest,
        "ganancia_compensable_ano_actual": 0.0,
        "total_perdida_latente": 0.0,
    }

    if incluir_harvest:
        # ¿Cuánta ganancia hay pendiente de ISR este año?
        g_actual = next((g for g in por_ano_lista if g["ano"] == ano_actual), None)
        ganancia_compensable = g_actual["ganancia_neta"] if g_actual else 0.0
        harvest_info["ganancia_compensable_ano_actual"] = round(max(0, ganancia_compensable), 2)

        # Estado actual de posiciones: shares > 0 con precio actual
        tickers_activos = [t for t, e in estado.items() if e["shares"] > 1e-9]
        precios = _precios_de(tickers_activos)

        for t in tickers_activos:
            e = estado[t]
            shares = e["shares"]
            avg = e["costo_total"] / shares if shares > 0 else 0
            precio = precios.get(t)
            if precio is None:
                continue
            valor = shares * precio
            pnl_latente = valor - e["costo_total"]
            if pnl_latente >= -0.01:
                continue  # no hay pérdida, no aplica
            # Cuánto ISR te ahorrarías si vendes todo esto
            perdida_abs = abs(pnl_latente)
            compensa = min(perdida_abs, ganancia_compensable) if ganancia_compensable > 0 else 0
            ahorro_isr = compensa * (ISR_PCT / 100.0)

            caida_pct = ((precio - avg) / avg * 100.0) if avg > 0 else None
            harvest_oport.append({
                "ticker":             t,
                "shares":             round(shares, 6),
                "costo_promedio":     round(avg, 4),
                "precio_actual":      round(precio, 2),
                "valor_actual":       round(valor, 2),
                "perdida_latente":    round(pnl_latente, 2),
                "perdida_latente_abs": round(perdida_abs, 2),
                "compensaria":        round(compensa, 2),
                "compensa":           round(compensa, 2),   # alias para frontend
                "ahorro_isr":         round(ahorro_isr, 2),
                "caida_pct":          round(caida_pct, 2) if caida_pct is not None else None,
                "accion_sugerida": (
                    f"Vender las {int(shares)} shares de {t} generaría una pérdida realizada de "
                    f"${perdida_abs:,.2f}. "
                    + (f"Compensa ${compensa:,.2f} de tu ganancia actual → te ahorra ~${ahorro_isr:,.2f} de ISR."
                       if compensa > 0 else
                       "No tienes ganancia pendiente este año, pero la pérdida se puede arrastrar 10 años.")
                ),
            })

        # Orden: el que más ISR ahorra primero
        harvest_oport.sort(key=lambda x: -x["ahorro_isr"])
        harvest_info["oportunidades"] = harvest_oport
        harvest_info["total_perdida_latente"] = round(
            sum(x["perdida_latente"] for x in harvest_oport), 2
        )

    # Totales
    g_ano = next((g for g in por_ano_lista if g["ano"] == ano_actual), None)
    ganancia_ano = g_ano["ganancia_neta"] if g_ano else 0.0
    isr_ano = g_ano["isr_estimado"] if g_ano else 0.0

    ganancia_historica = sum(g["ganancia_neta"] for g in por_ano_lista if g["ganancia_neta"] > 0)
    isr_historico = sum(g["isr_estimado"] for g in por_ano_lista)

    # Avisos
    avisos = [
        "Estimación con reglas generales para personas físicas que operan acciones en BMV/BIVA "
        "(art. 129 LISR). Tu broker emite constancia fiscal — úsala como fuente oficial.",
        "No cubre dividendos, ETFs vía SIC ni FIBRAS (tratamientos distintos). "
        "Consulta a tu contador para casos complejos.",
    ]
    if perdidas_disponibles > 0:
        avisos.append(
            f"Tienes ${perdidas_disponibles:,.2f} de pérdidas de años anteriores que se pueden "
            "aplicar contra ganancias futuras (hasta 10 años), si las declaraste en su ejercicio."
        )

    return {
        "por_ano": por_ano_lista,
        "perdidas_arrastrables": round(perdidas_disponibles, 2),
        "harvest": harvest_info,
        "totales": {
            "ganancia_realizada_historica": round(ganancia_historica, 2),
            "isr_estimado_historico":       round(isr_historico, 2),
            "ano_actual":                   ano_actual,
            "ganancia_neta_ano_actual":     round(ganancia_ano, 2),
            "isr_estimado_ano_actual":      round(isr_ano, 2),
        },
        "avisos": avisos,
        "isr_pct": ISR_PCT,
    }
