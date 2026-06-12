# ============================================================
#  CALENDARIO Y PROYECCIÓN DE DIVIDENDOS
# ============================================================
#  Para cada ticker del portafolio:
#    - Descarga historial de dividendos (yfinance)
#    - Detecta frecuencia (mensual / trimestral / semestral / anual)
#    - Estima dividendo anual esperado
#    - Proyecta próximos 12 meses de pagos
#    - Calcula yield actual y yield on cost (si se pasa avg_cost)
#
#  Al agregar por portafolio:
#    - Ingreso anual estimado
#    - Ingreso mensual promedio
#    - Calendario unificado por fecha
#    - % de portafolio que genera dividendos vs crecimiento puro
#
#  Limitaciones:
#    - yfinance es la fuente, sus datos pueden diferir de lo oficial.
#    - No aplica retención fiscal de ISR sobre dividendos (10% en MX).
#    - Estimación de próximos pagos es proyección, no garantía.
# ============================================================
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from statistics import median

import pandas as pd
import yfinance as yf


# ------------------------------------------------------------
# Helpers de frecuencia
# ------------------------------------------------------------
def _detectar_frecuencia(fechas: list[datetime]) -> tuple[str, int, float]:
    """
    Devuelve (etiqueta, pagos_por_ano, dias_entre_pagos_mediana).
    """
    if len(fechas) < 2:
        return ("desconocida", 0, 0.0)

    fechas_ord = sorted(fechas)
    intervalos = [
        (fechas_ord[i] - fechas_ord[i - 1]).days
        for i in range(1, len(fechas_ord))
    ]
    # Mediana resistente a outliers (splits, pagos especiales)
    intervalo_m = median(intervalos)

    # Clasificación heurística
    if intervalo_m <= 40:
        return ("Mensual", 12, intervalo_m)
    if intervalo_m <= 70:
        return ("Bimestral", 6, intervalo_m)
    if intervalo_m <= 110:
        return ("Trimestral", 4, intervalo_m)
    if intervalo_m <= 200:
        return ("Semestral", 2, intervalo_m)
    return ("Anual", 1, intervalo_m)


def _precio_actual(ticker: str) -> float | None:
    try:
        info = yf.Ticker(ticker).fast_info
        for key in ("last_price", "lastPrice", "regular_market_price", "regularMarketPrice"):
            try:
                v = info[key] if hasattr(info, "__getitem__") else getattr(info, key, None)
                if v is not None:
                    return float(v)
            except (KeyError, TypeError):
                continue
    except Exception:
        return None
    return None


# ------------------------------------------------------------
# Análisis de un ticker
# ------------------------------------------------------------
def _analizar_ticker(
    ticker: str,
    shares: float,
    precio_actual: float | None = None,
    costo_promedio: float | None = None,
    anos_historia: int = 3,
) -> dict:
    """
    Para un ticker, devuelve frecuencia, dividendo anual estimado,
    yield actual, yield on cost y próximos pagos proyectados.
    """
    base = {
        "ticker":              ticker,
        "shares":              round(shares, 6),
        "paga_dividendos":     False,
        "frecuencia":          None,
        "pagos_por_ano":       0,
        "ultimo_dividendo":    None,
        "ultima_fecha":        None,
        "dividendo_anual_estimado": 0.0,
        "ingreso_anual_ticker":     0.0,
        "ingreso_proximo_12m":      0.0,
        "yield_actual_pct":    None,
        "yield_on_cost_pct":   None,
        "precio_actual":       round(precio_actual, 2) if precio_actual is not None else None,
        "costo_promedio":      round(costo_promedio, 4) if costo_promedio is not None else None,
        "proximos_pagos":      [],
        "mensaje":             None,
    }

    try:
        tk = yf.Ticker(ticker)
        serie = tk.dividends  # Series indexada por fecha
    except Exception:
        base["mensaje"] = "No se pudo obtener historial de dividendos."
        return base

    if serie is None or serie.empty:
        base["mensaje"] = "No paga dividendos actualmente."
        return base

    # Filtrar a últimos N años
    ahora_tz = serie.index.tz if getattr(serie.index, "tz", None) else None
    if ahora_tz is not None:
        corte = pd.Timestamp.now(tz=ahora_tz) - pd.DateOffset(years=anos_historia)
    else:
        corte = pd.Timestamp.now() - pd.DateOffset(years=anos_historia)
    serie_reciente = serie[serie.index >= corte]
    if serie_reciente.empty:
        base["mensaje"] = f"Sin dividendos en los últimos {anos_historia} años."
        return base

    fechas = [d.to_pydatetime().replace(tzinfo=None) for d in serie_reciente.index]
    montos = [float(x) for x in serie_reciente.values]

    etiqueta, pagos_ano, intervalo = _detectar_frecuencia(fechas)
    ultimo_div = montos[-1]
    ultima_fecha = fechas[-1]

    # Dividendo anual estimado: suma de los últimos N pagos si es un año completo,
    # si no, último dividendo × pagos_por_ano
    un_ano_atras = datetime.now() - timedelta(days=365)
    pagos_ultimo_ano = [m for f, m in zip(fechas, montos) if f >= un_ano_atras]
    if len(pagos_ultimo_ano) >= pagos_ano * 0.8:
        dividendo_anual = sum(pagos_ultimo_ano)
    else:
        dividendo_anual = ultimo_div * pagos_ano

    ingreso_anual = dividendo_anual * shares

    # Yield actual (sobre precio de mercado)
    yield_actual = None
    if precio_actual is not None and precio_actual > 0:
        yield_actual = dividendo_anual / precio_actual * 100.0

    # Yield on cost (sobre costo promedio pagado)
    yield_cost = None
    if costo_promedio is not None and costo_promedio > 0:
        yield_cost = dividendo_anual / costo_promedio * 100.0

    # Proyección de próximos 12 meses de pagos
    proximos = []
    if pagos_ano > 0 and intervalo > 0:
        # Próxima fecha ~ última + intervalo
        siguiente = ultima_fecha + timedelta(days=int(round(intervalo)))
        monto_est = dividendo_anual / pagos_ano
        horizonte = datetime.now() + timedelta(days=365)
        while siguiente <= horizonte and len(proximos) < 14:
            if siguiente >= datetime.now() - timedelta(days=5):
                proximos.append({
                    "fecha_estimada": siguiente.strftime("%Y-%m-%d"),
                    "monto_por_share": round(monto_est, 4),
                    "monto_total":     round(monto_est * shares, 2),
                })
            siguiente += timedelta(days=int(round(intervalo)))

    ingreso_prox = sum(p["monto_total"] for p in proximos)

    base.update({
        "paga_dividendos":            True,
        "frecuencia":                 etiqueta,
        "pagos_por_ano":              pagos_ano,
        "ultimo_dividendo":           round(ultimo_div, 4),
        "ultima_fecha":               ultima_fecha.strftime("%Y-%m-%d"),
        "dividendo_anual_estimado":   round(dividendo_anual, 4),
        "ingreso_anual_ticker":       round(ingreso_anual, 2),
        "ingreso_proximo_12m":        round(ingreso_prox, 2),
        "yield_actual_pct":           round(yield_actual, 2) if yield_actual is not None else None,
        "yield_on_cost_pct":          round(yield_cost, 2)   if yield_cost   is not None else None,
        "proximos_pagos":             proximos,
        "mensaje":                    None,
    })
    return base


# ------------------------------------------------------------
# Resolver posiciones (shares por ticker) a partir de input flexible
# ------------------------------------------------------------
def _resolver_posiciones(
    posiciones: dict | None,
    tickers: list | None,
    pesos: dict | None,
    capital_supuesto: float | None,
) -> dict[str, dict]:
    """
    Regresa dict {ticker: {shares, costo_promedio}}.
    Tres modos de entrada:
      1. posiciones = {ticker: {shares, costo_promedio?}} o {ticker: shares_float}
      2. tickers + pesos + capital_supuesto → calcular shares implícitas
         con precio actual: shares = capital * peso / precio_actual
      3. tickers solo: equal-weight sobre capital_supuesto (default 100,000)
    """
    out: dict[str, dict] = {}

    if posiciones and isinstance(posiciones, dict):
        for t, v in posiciones.items():
            t = str(t).strip().upper()
            if not t:
                continue
            if isinstance(v, dict):
                shares = float(v.get("shares") or 0)
                avg    = v.get("costo_promedio")
                try:
                    avg = float(avg) if avg is not None else None
                except (TypeError, ValueError):
                    avg = None
            else:
                try:
                    shares = float(v)
                except (TypeError, ValueError):
                    shares = 0.0
                avg = None
            if shares > 0:
                out[t] = {"shares": shares, "costo_promedio": avg}
        if out:
            return out

    # Modo 2/3: inferir desde tickers + pesos + capital
    if tickers and isinstance(tickers, list):
        tickers = [str(t).strip().upper() for t in tickers if str(t).strip()]
        if not tickers:
            return out

        cap = float(capital_supuesto) if capital_supuesto else 100000.0
        if cap <= 0:
            cap = 100000.0

        # Pesos efectivos
        if pesos and isinstance(pesos, dict):
            pesos_n = {t: float(pesos.get(t) or 0) for t in tickers}
            suma = sum(pesos_n.values())
            if suma > 0:
                pesos_n = {k: v / suma for k, v in pesos_n.items()}
            else:
                pesos_n = {t: 1.0 / len(tickers) for t in tickers}
        else:
            pesos_n = {t: 1.0 / len(tickers) for t in tickers}

        # Bajar precios en paralelo
        with ThreadPoolExecutor(max_workers=10) as ex:
            precios_list = list(ex.map(_precio_actual, tickers))
        precios = dict(zip(tickers, precios_list))

        for t in tickers:
            p = precios.get(t)
            if p is None or p <= 0:
                continue
            monto_asignado = cap * pesos_n.get(t, 0)
            shares = monto_asignado / p
            if shares > 0:
                out[t] = {"shares": shares, "costo_promedio": p}  # costo = precio actual (supuesto)

    return out


# ------------------------------------------------------------
# API principal
# ------------------------------------------------------------
def analizar_dividendos_portafolio(
    posiciones: dict | None = None,
    tickers: list | None = None,
    pesos: dict | None = None,
    capital_supuesto: float | None = None,
    anos_historia: int = 3,
    meta_ingreso_mensual: float | None = None,
) -> dict:
    """
    Devuelve análisis de dividendos para el portafolio.
    """
    pos = _resolver_posiciones(posiciones, tickers, pesos, capital_supuesto)
    if not pos:
        return {
            "por_ticker":        [],
            "calendario":        [],
            "totales": {
                "ingreso_anual_estimado":  0.0,
                "ingreso_mensual_promedio": 0.0,
                "yield_portafolio_pct":    0.0,
                "yield_on_cost_pct":       None,
                "valor_invertido":         0.0,
                "valor_actual":            0.0,
                "pct_genera_dividendos":   0.0,
                "num_tickers_pagan":       0,
                "num_tickers_no_pagan":    0,
            },
            "progreso_meta":     None,
            "avisos": [
                "Sin posiciones válidas para analizar dividendos."
            ],
        }

    # Bajar precios de todos los tickers en paralelo
    tickers_lista = list(pos.keys())
    with ThreadPoolExecutor(max_workers=10) as ex:
        precios_list = list(ex.map(_precio_actual, tickers_lista))
    precios = dict(zip(tickers_lista, precios_list))

    # Analizar cada ticker en paralelo
    resultados = []
    def _job(t):
        p = pos[t]
        return _analizar_ticker(
            t,
            shares=p["shares"],
            precio_actual=precios.get(t),
            costo_promedio=p.get("costo_promedio"),
            anos_historia=anos_historia,
        )

    with ThreadPoolExecutor(max_workers=10) as ex:
        resultados = list(ex.map(_job, tickers_lista))

    # Agregar valores de mercado y costo
    for r in resultados:
        t = r["ticker"]
        p = precios.get(t)
        shares = pos[t]["shares"]
        avg = pos[t].get("costo_promedio")
        r["valor_actual"]     = round(p * shares, 2) if p else None
        r["valor_invertido"]  = round(avg * shares, 2) if avg else None

    # Totales
    ingreso_anual_total = sum(r["ingreso_anual_ticker"] for r in resultados)
    ingreso_mensual     = ingreso_anual_total / 12.0

    valor_actual_total     = sum((r["valor_actual"]    or 0) for r in resultados)
    valor_invertido_total  = sum((r["valor_invertido"] or 0) for r in resultados)

    yield_portafolio = (
        ingreso_anual_total / valor_actual_total * 100.0
        if valor_actual_total > 0 else 0.0
    )
    yield_on_cost = (
        ingreso_anual_total / valor_invertido_total * 100.0
        if valor_invertido_total > 0 else None
    )

    # ¿Qué % del portafolio genera dividendos?
    valor_genera = sum(
        (r["valor_actual"] or 0) for r in resultados if r["paga_dividendos"]
    )
    pct_genera = (valor_genera / valor_actual_total * 100.0) if valor_actual_total > 0 else 0.0

    num_pagan    = sum(1 for r in resultados if r["paga_dividendos"])
    num_no_pagan = len(resultados) - num_pagan

    # Calendario unificado
    calendario = []
    for r in resultados:
        for pago in r["proximos_pagos"]:
            calendario.append({
                "fecha":          pago["fecha_estimada"],
                "ticker":         r["ticker"],
                "monto_total":    pago["monto_total"],
                "monto_por_share": pago["monto_por_share"],
                "shares":         r["shares"],
                "frecuencia":     r["frecuencia"],
            })
    calendario.sort(key=lambda x: x["fecha"])

    # Ordenar por ticker: los que pagan primero, por ingreso anual desc
    resultados.sort(key=lambda r: (not r["paga_dividendos"], -r["ingreso_anual_ticker"]))

    # Progreso vs meta de ingreso mensual
    progreso_meta = None
    if meta_ingreso_mensual and meta_ingreso_mensual > 0:
        cubierto = ingreso_mensual / meta_ingreso_mensual
        faltante_mensual = max(0, meta_ingreso_mensual - ingreso_mensual)
        # Cuánto capital más necesitaría (a yield actual) para cubrir la meta
        capital_extra = None
        if yield_portafolio > 0 and faltante_mensual > 0:
            capital_extra = faltante_mensual * 12 / (yield_portafolio / 100.0)
        progreso_meta = {
            "meta_ingreso_mensual":       round(meta_ingreso_mensual, 2),
            "ingreso_mensual_actual":     round(ingreso_mensual, 2),
            "pct_cubierto":               round(cubierto, 4),
            "faltante_mensual":           round(faltante_mensual, 2),
            "capital_extra_necesario":    round(capital_extra, 2) if capital_extra else None,
        }

    # Avisos
    avisos = []
    if num_pagan == 0:
        avisos.append(
            "Ninguna de tus posiciones paga dividendos actualmente. "
            "Si buscas ingreso pasivo, considera ETFs como VOO, SCHD o FIBRAS en México."
        )
    elif pct_genera < 30:
        avisos.append(
            f"Solo el {pct_genera:.0f}% de tu portafolio genera dividendos. "
            "El resto depende de apreciación de precio para dar retorno."
        )

    avisos.append(
        "Los dividendos en México tributan al 10% de ISR (retención final). "
        "Los ETFs del SIC pueden tener retención extra en origen."
    )

    return {
        "por_ticker":     resultados,
        "calendario":     calendario[:24],  # máximo 24 próximos pagos
        "totales": {
            "ingreso_anual_estimado":   round(ingreso_anual_total, 2),
            "ingreso_mensual_promedio": round(ingreso_mensual, 2),
            "yield_portafolio_pct":     round(yield_portafolio, 2),
            "yield_on_cost_pct":        round(yield_on_cost, 2) if yield_on_cost is not None else None,
            "valor_invertido":          round(valor_invertido_total, 2),
            "valor_actual":             round(valor_actual_total, 2),
            "pct_genera_dividendos":    round(pct_genera, 2),
            "num_tickers_pagan":        num_pagan,
            "num_tickers_no_pagan":     num_no_pagan,
        },
        "progreso_meta":  progreso_meta,
        "avisos":         avisos,
    }
