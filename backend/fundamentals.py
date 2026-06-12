"""
fundamentals.py — Análisis fundamental por ticker.

Expone datos fundamentales (P/E, P/B, market cap, dividend yield, beta,
rango 52 semanas, earnings próximas) y los anota con valores "buenos/
regulares/caros" en un tono que ayuda al retail a interpretar qué
significan. Nada de recomendaciones de compra/venta.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional

import yfinance as yf


# ---- Rangos orientativos (heurísticas amigables para retail) --------------
# No son reglas duras; sirven para etiquetar métricas con un color.

def _evaluar_pe(pe: Optional[float]) -> Dict[str, Any]:
    if pe is None:
        return {"nivel": "sin_dato", "etiqueta": "Sin dato", "color": "zinc"}
    if pe <= 0:
        return {"nivel": "perdida", "etiqueta": "Empresa en pérdida", "color": "red"}
    if pe < 15:
        return {"nivel": "bajo",   "etiqueta": "Valuación baja",     "color": "green"}
    if pe < 25:
        return {"nivel": "medio",  "etiqueta": "Valuación razonable","color": "blue"}
    if pe < 40:
        return {"nivel": "alto",   "etiqueta": "Valuación alta",     "color": "amber"}
    return {"nivel": "muy_alto",   "etiqueta": "Muy cara",           "color": "red"}


def _evaluar_yield(y: Optional[float]) -> Dict[str, Any]:
    if y is None or y <= 0:
        return {"nivel": "sin",   "etiqueta": "Sin dividendos",   "color": "zinc"}
    if y < 0.015:
        return {"nivel": "bajo",  "etiqueta": "Yield bajo",       "color": "zinc"}
    if y < 0.035:
        return {"nivel": "medio", "etiqueta": "Yield moderado",   "color": "blue"}
    if y < 0.07:
        return {"nivel": "alto",  "etiqueta": "Yield alto",       "color": "green"}
    return {"nivel": "muy_alto",  "etiqueta": "Yield muy alto",   "color": "amber"}


def _evaluar_beta(b: Optional[float]) -> Dict[str, Any]:
    if b is None:
        return {"nivel": "sin_dato", "etiqueta": "Sin dato", "color": "zinc"}
    if b < 0.8:
        return {"nivel": "defensiva", "etiqueta": "Defensiva", "color": "blue"}
    if b < 1.2:
        return {"nivel": "mercado",  "etiqueta": "Mercado",   "color": "zinc"}
    if b < 1.6:
        return {"nivel": "agresiva", "etiqueta": "Agresiva",  "color": "amber"}
    return {"nivel": "muy_agresiva", "etiqueta": "Muy volátil","color": "red"}


def _escala_market_cap(mc: Optional[float]) -> Dict[str, Any]:
    if mc is None or mc <= 0:
        return {"escala": "sin_dato", "etiqueta": "Sin dato"}
    # Escala USD / MXN (yfinance regresa en la moneda del activo)
    if mc >= 2e11:
        return {"escala": "mega", "etiqueta": "Mega-cap"}
    if mc >= 1e10:
        return {"escala": "large", "etiqueta": "Large-cap"}
    if mc >= 2e9:
        return {"escala": "mid", "etiqueta": "Mid-cap"}
    if mc >= 3e8:
        return {"escala": "small", "etiqueta": "Small-cap"}
    return {"escala": "micro", "etiqueta": "Micro-cap"}


def _posicion_52w(precio: Optional[float], low: Optional[float], high: Optional[float]) -> Optional[float]:
    """Retorna posición 0..1 del precio dentro del rango 52w."""
    try:
        if precio is None or low is None or high is None:
            return None
        if high <= low:
            return None
        pos = (float(precio) - float(low)) / (float(high) - float(low))
        return max(0.0, min(1.0, pos))
    except (ValueError, TypeError):
        return None


def _safe_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        f = float(x)
        if f != f:  # NaN
            return None
        return f
    except (ValueError, TypeError):
        return None


def _safe_int(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        return int(x)
    except (ValueError, TypeError):
        return None


def _fundamentals_ticker(ticker: str) -> Dict[str, Any]:
    """Extrae fundamentales para un ticker desde yfinance."""
    out: Dict[str, Any] = {"ticker": ticker, "ok": False}
    try:
        t = yf.Ticker(ticker)
        info: Dict[str, Any] = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}

        # Precio actual (preferir fast_info)
        precio: Optional[float] = None
        try:
            fi = t.fast_info
            precio = _safe_float(getattr(fi, "last_price", None)) or _safe_float(fi.get("last_price")) if fi else None
        except Exception:
            precio = None
        if precio is None:
            precio = _safe_float(info.get("currentPrice")) or _safe_float(info.get("regularMarketPrice"))

        nombre = info.get("shortName") or info.get("longName") or ticker
        sector = info.get("sector")
        industria = info.get("industry")
        moneda = info.get("currency") or info.get("financialCurrency")

        market_cap = _safe_float(info.get("marketCap"))
        pe_trailing = _safe_float(info.get("trailingPE"))
        pe_forward  = _safe_float(info.get("forwardPE"))
        pb = _safe_float(info.get("priceToBook"))
        peg = _safe_float(info.get("pegRatio"))
        beta = _safe_float(info.get("beta"))

        dividend_yield = _safe_float(info.get("dividendYield"))
        # yfinance a veces regresa el yield como fracción (0.025) y a veces como % (2.5). Normalizar:
        if dividend_yield is not None and dividend_yield > 1:
            dividend_yield = dividend_yield / 100.0
        dividend_rate = _safe_float(info.get("dividendRate"))
        payout_ratio = _safe_float(info.get("payoutRatio"))

        low_52w  = _safe_float(info.get("fiftyTwoWeekLow"))
        high_52w = _safe_float(info.get("fiftyTwoWeekHigh"))
        pos_52w = _posicion_52w(precio, low_52w, high_52w)

        eps_trailing = _safe_float(info.get("trailingEps"))
        eps_forward  = _safe_float(info.get("forwardEps"))
        rev_growth = _safe_float(info.get("revenueGrowth"))
        earn_growth = _safe_float(info.get("earningsGrowth"))

        roe = _safe_float(info.get("returnOnEquity"))
        margenes = {
            "bruto":     _safe_float(info.get("grossMargins")),
            "operativo": _safe_float(info.get("operatingMargins")),
            "neto":      _safe_float(info.get("profitMargins")),
        }
        deuda_equity = _safe_float(info.get("debtToEquity"))

        proximas_earnings = None
        try:
            cal = t.calendar
            if cal is not None and not getattr(cal, "empty", True):
                # yfinance a veces devuelve DataFrame, a veces dict
                if hasattr(cal, "to_dict"):
                    d = cal.to_dict()
                    # Earnings Date puede ser lista o Timestamp
                    ed = d.get("Earnings Date") or d.get(0, {}).get("Earnings Date")
                    if ed:
                        proximas_earnings = str(ed)
                elif isinstance(cal, dict):
                    ed = cal.get("Earnings Date")
                    if ed:
                        proximas_earnings = str(ed[0]) if isinstance(ed, (list, tuple)) else str(ed)
        except Exception:
            proximas_earnings = None

        out.update({
            "ok":                True,
            "nombre":            nombre,
            "sector":            sector,
            "industria":         industria,
            "moneda":            moneda,
            "precio_actual":     precio,
            "market_cap":        market_cap,
            "market_cap_escala": _escala_market_cap(market_cap),
            "pe_trailing":       pe_trailing,
            "pe_trailing_eval":  _evaluar_pe(pe_trailing),
            "pe_forward":        pe_forward,
            "pb":                pb,
            "peg":               peg,
            "beta":              beta,
            "beta_eval":         _evaluar_beta(beta),
            "dividend_yield":    dividend_yield,
            "dividend_yield_eval": _evaluar_yield(dividend_yield),
            "dividend_rate":     dividend_rate,
            "payout_ratio":      payout_ratio,
            "low_52w":           low_52w,
            "high_52w":          high_52w,
            "pos_52w":           pos_52w,
            "eps_trailing":      eps_trailing,
            "eps_forward":       eps_forward,
            "revenue_growth":    rev_growth,
            "earnings_growth":   earn_growth,
            "roe":               roe,
            "margenes":          margenes,
            "debt_to_equity":    deuda_equity,
            "proximas_earnings": proximas_earnings,
        })
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"

    return out


def analizar_fundamentales(tickers: List[str]) -> Dict[str, Any]:
    """Analiza fundamentales de una lista de tickers en paralelo."""
    if not tickers:
        raise ValueError("Se requiere al menos un ticker")

    tickers = [str(t).strip() for t in tickers if t and str(t).strip()]
    if len(tickers) > 30:
        raise ValueError("Máximo 30 tickers por request")

    resultados: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futuros = {ex.submit(_fundamentals_ticker, t): t for t in tickers}
        for fut in as_completed(futuros):
            t = futuros[fut]
            try:
                resultados[t] = fut.result()
            except Exception as e:
                resultados[t] = {"ticker": t, "ok": False, "error": str(e)}

    # Preservar orden de entrada
    ordenados = [resultados[t] for t in tickers if t in resultados]

    # Resumen agregado (promedio ponderado no — aquí simple mediana/promedio)
    validos = [r for r in ordenados if r.get("ok")]
    def _prom(campo: str) -> Optional[float]:
        vals = [r[campo] for r in validos if isinstance(r.get(campo), (int, float))]
        if not vals:
            return None
        return sum(vals) / len(vals)

    resumen = {
        "num_tickers":    len(ordenados),
        "num_ok":         len(validos),
        "pe_promedio":    _prom("pe_trailing"),
        "yield_promedio": _prom("dividend_yield"),
        "beta_promedio":  _prom("beta"),
    }

    # Avisos educativos sobre el portafolio
    avisos: List[str] = []
    if resumen["pe_promedio"] is not None and resumen["pe_promedio"] > 30:
        avisos.append("El P/E promedio del portafolio está alto. Paga mucho por cada peso de utilidad — típico de empresas con expectativas de crecimiento fuerte.")
    if resumen["yield_promedio"] is not None and resumen["yield_promedio"] > 0.05:
        avisos.append("Yield promedio alto: recibes flujo vía dividendos, pero verifica que las empresas no estén distribuyendo más de lo que ganan.")
    if resumen["beta_promedio"] is not None and resumen["beta_promedio"] > 1.3:
        avisos.append("Beta promedio alta: tu portafolio se mueve más que el mercado. Más potencial arriba, pero también más golpes abajo.")

    return {
        "tickers":   ordenados,
        "resumen":   resumen,
        "avisos":    avisos,
    }


if __name__ == "__main__":
    import json as _json
    res = analizar_fundamentales(["AAPL", "MSFT"])
    print(_json.dumps(res, indent=2, default=str))
