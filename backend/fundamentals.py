"""
fundamentals.py — Análisis fundamental por ticker.

Expone datos fundamentales (P/E, P/B, market cap, dividend yield, beta,
rango 52 semanas, earnings próximas) y los anota con valores "buenos/
regulares/caros" en un tono que ayuda al retail a interpretar qué
significan. Nada de recomendaciones de compra/venta.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

import yfinance as yf

try:
    import data_fallback as _fallback  # type: ignore
except Exception:  # pragma: no cover
    _fallback = None  # type: ignore


# ----------------------------------------------------------------
# Cache de benchmarks (SPY, NAFTRAC.MX) para cálculo de beta
# ----------------------------------------------------------------
_BENCHMARK_CACHE: Dict[str, Tuple[float, Any]] = {}  # ticker -> (timestamp, series_retornos)
_BENCHMARK_TTL = 6 * 3600  # 6 horas
_BENCHMARK_LOCK = threading.Lock()

# ----------------------------------------------------------------
# Cache de fundamentales por ticker (evita re-pegarle a yfinance en
# cada análisis de portafolio y reduce los 429 "too many requests"
# cuando hay muchas acciones).
# ----------------------------------------------------------------
_FUND_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}  # ticker -> (timestamp, datos)
_FUND_TTL = 12 * 3600  # 12 horas
_FUND_LOCK = threading.Lock()


def _obtener_retornos_benchmark(symbol: str, periodo: str = "1y"):
    """Descarga cierres del benchmark y devuelve serie de retornos diarios.
    Cacheado 6 horas para no martillar yfinance."""
    with _BENCHMARK_LOCK:
        cached = _BENCHMARK_CACHE.get(symbol)
        if cached and (time.time() - cached[0]) < _BENCHMARK_TTL:
            return cached[1]
    try:
        hist = yf.Ticker(symbol).history(period=periodo, auto_adjust=True)
        if hist is None or hist.empty or "Close" not in hist.columns:
            return None
        retornos = hist["Close"].pct_change().dropna()
        if len(retornos) < 30:
            return None
        with _BENCHMARK_LOCK:
            _BENCHMARK_CACHE[symbol] = (time.time(), retornos)
        return retornos
    except Exception:
        return None


def _calcular_beta(ticker: str, benchmark: str = "SPY") -> Optional[float]:
    """Calcula beta = cov(ticker, benchmark) / var(benchmark) con ~1 año
    de retornos diarios. Devuelve None si no hay suficientes datos."""
    try:
        bench_ret = _obtener_retornos_benchmark(benchmark)
        if bench_ret is None:
            return None
        hist = yf.Ticker(ticker).history(period="1y", auto_adjust=True)
        if hist is None or hist.empty:
            return None
        ticker_ret = hist["Close"].pct_change().dropna()
        if len(ticker_ret) < 30:
            return None
        # Alinear fechas (intersección)
        comun = ticker_ret.index.intersection(bench_ret.index)
        if len(comun) < 30:
            return None
        tr = ticker_ret.loc[comun]
        br = bench_ret.loc[comun]
        var_b = br.var()
        if not var_b or var_b == 0:
            return None
        cov = tr.cov(br)
        beta = float(cov / var_b)
        # Sanity check: beta normalmente está en [-3, 3]
        if abs(beta) > 5:
            return None
        return round(beta, 3)
    except Exception:
        return None


def _benchmark_para(ticker: str) -> str:
    """Devuelve el benchmark apropiado: NAFTRAC.MX para acciones mexicanas,
    SPY para todo lo demás. Crypto no se evalúa contra benchmark."""
    if ticker.upper().endswith(".MX"):
        return "NAFTRAC.MX"
    return "SPY"


# ----------------------------------------------------------------
# Métricas de comportamiento (aplica a stocks, ETFs y crypto)
# ----------------------------------------------------------------
def _metricas_comportamiento(ticker: str) -> Dict[str, Any]:
    """Calcula métricas estadísticas que funcionan para CUALQUIER activo:
    volatilidad anualizada, Sharpe, Sortino, max drawdown, correlación.

    Útil especialmente para crypto y ETFs donde P/E y ROE no aplican.
    """
    out: Dict[str, Any] = {
        "volatilidad_anual":   None,
        "sharpe_ratio":        None,
        "sortino_ratio":       None,
        "max_drawdown":        None,
        "correlacion_sp500":   None,
        "retorno_1m":          None,
        "retorno_3m":          None,
        "retorno_1y":          None,
        "retorno_ytd":         None,
    }
    try:
        import numpy as np
        import pandas as pd
        from datetime import date

        hist = yf.Ticker(ticker).history(period="1y", auto_adjust=True)
        if hist is None or hist.empty or "Close" not in hist.columns:
            return out
        precios = hist["Close"].dropna()
        if len(precios) < 30:
            return out

        retornos = precios.pct_change().dropna()

        # Volatilidad anualizada (std diaria × sqrt(252))
        vol = float(retornos.std() * np.sqrt(252))
        out["volatilidad_anual"] = round(vol, 4)

        # Sharpe ratio: (retorno_anual - rf) / vol_anual
        # rf = 4.5% USD (UST 3m) o 9.5% MXN (CETES 28d)
        rf = 0.095 if ticker.upper().endswith(".MX") else 0.045
        retorno_anual = float((1 + retornos.mean()) ** 252 - 1)
        if vol > 0:
            sharpe = (retorno_anual - rf) / vol
            out["sharpe_ratio"] = round(sharpe, 3)

        # Sortino ratio (solo penaliza volatilidad negativa)
        retornos_neg = retornos[retornos < 0]
        if len(retornos_neg) > 5:
            downside_vol = float(retornos_neg.std() * np.sqrt(252))
            if downside_vol > 0:
                sortino = (retorno_anual - rf) / downside_vol
                out["sortino_ratio"] = round(sortino, 3)

        # Max drawdown
        cummax = precios.cummax()
        dd = (precios - cummax) / cummax
        out["max_drawdown"] = round(float(dd.min()), 4)

        # Correlación con SP500 (excepto si es SPY mismo)
        if ticker.upper() != "SPY":
            spy_ret = _obtener_retornos_benchmark("SPY")
            if spy_ret is not None:
                comun = retornos.index.intersection(spy_ret.index)
                if len(comun) >= 30:
                    corr = float(retornos.loc[comun].corr(spy_ret.loc[comun]))
                    out["correlacion_sp500"] = round(corr, 3)

        # Retornos en diferentes ventanas
        if len(precios) >= 21:
            out["retorno_1m"] = round(float(precios.iloc[-1] / precios.iloc[-21] - 1), 4)
        if len(precios) >= 63:
            out["retorno_3m"] = round(float(precios.iloc[-1] / precios.iloc[-63] - 1), 4)
        if len(precios) >= 200:
            out["retorno_1y"] = round(float(precios.iloc[-1] / precios.iloc[0] - 1), 4)

        # YTD: desde el primer día hábil del año actual
        try:
            año = date.today().year
            inicio_año = precios[precios.index >= f"{año}-01-01"]
            if len(inicio_año) >= 2:
                out["retorno_ytd"] = round(float(inicio_año.iloc[-1] / inicio_año.iloc[0] - 1), 4)
        except Exception:
            pass

    except Exception:
        pass
    return out


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


# ----------------------------------------------------------------
#  Derivar métricas desde los ESTADOS FINANCIEROS (flujo, resultados,
#  balance). Útil sobre todo para acciones mexicanas, donde el resumen
#  (.info con P/E, ROE) viene vacío pero los estados sí están disponibles.
#  De aquí calculamos FCF (que no existe en .info) y rellenamos ratios.
# ----------------------------------------------------------------
_ESTADOS_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_ESTADOS_TTL = 24 * 3600  # 24 h (los estados cambian por trimestre, no a diario)
_ESTADOS_LOCK = threading.Lock()


def _fila_estado(df, *nombres) -> Optional[float]:
    """Lee el valor más reciente (primera columna) de un renglón del estado,
    probando varios nombres alternativos por si yfinance cambia las etiquetas."""
    try:
        if df is None or getattr(df, "empty", True):
            return None
        for n in nombres:
            if n in df.index:
                serie = df.loc[n].dropna()
                if len(serie):
                    return float(serie.iloc[0])
    except Exception:
        return None
    return None


def _derivar_de_estados(ticker: str, market_cap: Optional[float] = None) -> Dict[str, Any]:
    """Baja los estados financieros de yfinance y deriva métricas.
    Devuelve un dict con fcf, fcf_yield, roe, margenes, deuda/capital, P/E, P/B.
    Cacheado 24h. Todo best-effort: si algo falla, ese campo queda en None."""
    with _ESTADOS_LOCK:
        c = _ESTADOS_CACHE.get(ticker)
        if c and (time.time() - c[0]) < _ESTADOS_TTL:
            return c[1]

    out: Dict[str, Any] = {}
    try:
        t = yf.Ticker(ticker)
        cf = bs = fin = None
        try: cf = t.cashflow
        except Exception: cf = None
        try: fin = t.financials
        except Exception: fin = None
        try: bs = t.balance_sheet
        except Exception: bs = None

        # --- Flujo de efectivo → FCF ---
        ocf = _fila_estado(cf, "Operating Cash Flow", "Total Cash From Operating Activities",
                           "Cash Flow From Continuing Operating Activities")
        capex = _fila_estado(cf, "Capital Expenditure", "Capital Expenditures")
        fcf = _fila_estado(cf, "Free Cash Flow")
        if fcf is None and ocf is not None and capex is not None:
            fcf = ocf + capex          # capex viene NEGATIVO en el estado
        out["operating_cash_flow"] = ocf
        out["capex"] = capex
        out["fcf"] = fcf

        # --- Resultados → utilidad, ventas, márgenes ---
        ni  = _fila_estado(fin, "Net Income", "Net Income Common Stockholders",
                           "Net Income From Continuing Operation Net Minority Interest")
        rev = _fila_estado(fin, "Total Revenue", "Operating Revenue")
        opi = _fila_estado(fin, "Operating Income", "Operating Income Or Loss", "EBIT")
        gp  = _fila_estado(fin, "Gross Profit")

        # --- Balance → capital y deuda ---
        eq  = _fila_estado(bs, "Stockholders Equity", "Total Stockholder Equity", "Common Stock Equity")
        debt = _fila_estado(bs, "Total Debt")
        if debt is None:
            ltd = _fila_estado(bs, "Long Term Debt")
            cd  = _fila_estado(bs, "Current Debt", "Current Debt And Capital Lease Obligation")
            if ltd is not None or cd is not None:
                debt = (ltd or 0.0) + (cd or 0.0)

        out["net_income"] = ni
        out["total_revenue"] = rev
        out["stockholders_equity"] = eq

        if ni is not None and rev:        out["margen_neto"] = round(ni / rev, 4)
        if opi is not None and rev:       out["margen_operativo"] = round(opi / rev, 4)
        if gp is not None and rev:        out["margen_bruto"] = round(gp / rev, 4)
        if ni is not None and eq and eq > 0:   out["roe"] = round(ni / eq, 4)
        if debt is not None and eq and eq > 0:  out["debt_to_equity"] = round(debt / eq * 100, 2)

        # --- Ratios de mercado (requieren market cap) ---
        if market_cap and market_cap > 0:
            if ni and ni > 0:   out["pe"] = round(market_cap / ni, 2)
            if eq and eq > 0:   out["pb"] = round(market_cap / eq, 2)
            if fcf and fcf != 0: out["fcf_yield"] = round(fcf / market_cap, 4)
    except Exception:
        pass

    with _ESTADOS_LOCK:
        _ESTADOS_CACHE[ticker] = (time.time(), out)
    return out


def _fundamentals_ticker(ticker: str, con_estados: bool = False) -> Dict[str, Any]:
    """Extrae fundamentales para un ticker desde yfinance.

    Si con_estados=True (o si faltan ratios clave), baja los estados financieros
    y calcula FCF + rellena lo que falte (clave para acciones mexicanas).

    Cachea el resultado OK por 12 h para no re-descargar en cada análisis de
    portafolio (clave para que P/E, P/B, PEG carguen cuando hay muchas
    acciones, evitando el rate-limit 429 de Yahoo)."""
    # 1) Cache hit
    with _FUND_LOCK:
        c = _FUND_CACHE.get(ticker)
        if c and (time.time() - c[0]) < _FUND_TTL:
            return c[1]

    out: Dict[str, Any] = {"ticker": ticker, "ok": False}
    try:
        t = yf.Ticker(ticker)
        info: Dict[str, Any] = {}
        # Reintento corto: ante un 429/respuesta vacía, esperar y reintentar
        # una vez en lugar de fallar (mejora la tasa de éxito con portafolios
        # grandes).
        for _intento in range(2):
            try:
                info = t.info or {}
            except Exception:
                info = {}
            if info:
                break
            time.sleep(0.8)

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
        # Beta canónica: misma que muestran Acción del Día / SML / Deep Dive
        # Si el ticker está en el universo local, sale instantáneo.
        beta = None
        try:
            import accion_del_dia as _ad
            canon = _ad.score_para_ticker(ticker)
            if canon and canon.get("beta") is not None:
                beta = canon["beta"]
        except Exception:
            beta = None
        # Si no está en el universo, usar el valor de yfinance.info como aproximación
        if beta is None:
            beta = _safe_float(info.get("beta"))

        # --- Fallbacks para PE ---
        # 1) Si no hay trailing pero sí EPS trailing y precio, calcular manual
        _eps_trailing_temp = _safe_float(info.get("trailingEps"))
        if pe_trailing is None and _eps_trailing_temp and _eps_trailing_temp > 0 and precio:
            pe_trailing = round(precio / _eps_trailing_temp, 2)
        # 2) Si todavía no hay PE pero sí forwardPE, usarlo como aproximación
        if pe_trailing is None and pe_forward and pe_forward > 0:
            pe_trailing = pe_forward
        # 3) Para ETFs, intentar obtener PE del fondo (yfinance a veces lo expone)
        if pe_trailing is None:
            etf_pe = _safe_float(info.get("trailingPE")) or _safe_float(info.get("priceToEarnings"))
            # quoteType=='ETF' a veces tiene yields pero no PE en info
            qtype = (info.get("quoteType") or "").upper()
            if qtype == "ETF":
                # Algunos ETFs exponen 'trailingPE' via fast_info diferente
                try:
                    fi2 = t.fast_info
                    if fi2:
                        etf_pe = etf_pe or _safe_float(getattr(fi2, "trailingPE", None))
                except Exception:
                    pass
            pe_trailing = etf_pe

        # --- Fallback para Beta: calcular con regresión vs SPY o NAFTRAC.MX ---
        if beta is None:
            # Skip cálculo para crypto (no tiene sentido contra equity)
            tk_upper = ticker.upper()
            es_crypto = ("-USD" in tk_upper) or ("-USDT" in tk_upper) or tk_upper.startswith("X:")
            if not es_crypto:
                # Protegido: un fallo de red aquí NO debe tumbar todo el análisis.
                try:
                    bench = _benchmark_para(ticker)
                    beta = _calcular_beta(ticker, benchmark=bench)
                except Exception:
                    beta = None

        # --- Fallback para PEG: si no viene, calcular = PE / earnings_growth ---
        if peg is None and pe_trailing is not None and pe_trailing > 0:
            eg = _safe_float(info.get("earningsGrowth"))
            if eg is not None and eg > 0:
                peg = round(pe_trailing / (eg * 100), 2)

        # --- Fallback para P/B: calcular = precio / bookValue ---
        if pb is None:
            book_value = _safe_float(info.get("bookValue"))
            if book_value and book_value > 0 and precio:
                pb = round(precio / book_value, 2)

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
        # Fallback: ROE = netIncome / totalEquity si vienen ambos
        if roe is None:
            ni = _safe_float(info.get("netIncomeToCommon"))
            te = _safe_float(info.get("totalStockholderEquity"))
            if ni and te and te > 0:
                roe = round(ni / te, 4)

        margenes = {
            "bruto":     _safe_float(info.get("grossMargins")),
            "operativo": _safe_float(info.get("operatingMargins")),
            "neto":      _safe_float(info.get("profitMargins")),
        }
        # Fallback: margen neto = netIncome / totalRevenue
        if margenes["neto"] is None:
            ni = _safe_float(info.get("netIncomeToCommon"))
            rev = _safe_float(info.get("totalRevenue"))
            if ni and rev and rev > 0:
                margenes["neto"] = round(ni / rev, 4)
        # Fallback: margen operativo = ebitda / revenue
        if margenes["operativo"] is None:
            ebitda = _safe_float(info.get("ebitda"))
            rev = _safe_float(info.get("totalRevenue"))
            if ebitda and rev and rev > 0:
                margenes["operativo"] = round(ebitda / rev, 4)

        deuda_equity = _safe_float(info.get("debtToEquity"))
        # Fallback: debt/equity = totalDebt / totalStockholderEquity
        if deuda_equity is None:
            td = _safe_float(info.get("totalDebt"))
            te = _safe_float(info.get("totalStockholderEquity"))
            if td and te and te > 0:
                deuda_equity = round(td / te * 100, 2)  # yfinance reporta como x100

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

        # Métricas de comportamiento (funcionan para crypto, ETFs, stocks).
        # Protegido: si falla la descarga del historial, seguimos con None.
        try:
            comportamiento = _metricas_comportamiento(ticker)
        except Exception:
            comportamiento = {k: None for k in (
                "volatilidad_anual", "sharpe_ratio", "sortino_ratio", "max_drawdown",
                "correlacion_sp500", "retorno_1m", "retorno_3m", "retorno_1y", "retorno_ytd")}

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
            # Métricas que SIEMPRE están (crypto, ETFs, stocks):
            "volatilidad_anual": comportamiento["volatilidad_anual"],
            "sharpe_ratio":      comportamiento["sharpe_ratio"],
            "sortino_ratio":     comportamiento["sortino_ratio"],
            "max_drawdown":      comportamiento["max_drawdown"],
            "correlacion_sp500": comportamiento["correlacion_sp500"],
            "retorno_1m":        comportamiento["retorno_1m"],
            "retorno_3m":        comportamiento["retorno_3m"],
            "retorno_1y":        comportamiento["retorno_1y"],
            "retorno_ytd":       comportamiento["retorno_ytd"],
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
            # True si yfinance no devolvió .info (mostramos lo que se pueda igual)
            "datos_parciales":   not bool(info),
        })
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        # RESCATE: aunque .info / fundamentales fallen, intentamos al menos las
        # métricas de comportamiento (solo dependen del historial de precios) y
        # devolvemos datos PARCIALES en vez de fallar por completo. Así "Analizar"
        # y "Fundamentales" muestran todo lo que se pueda para cualquier acción.
        try:
            comp = _metricas_comportamiento(ticker)
            if any(v is not None for v in comp.values()):
                out.update({
                    "ok":                True,
                    "datos_parciales":   True,
                    "nombre":            out.get("nombre") or ticker,
                    "volatilidad_anual": comp.get("volatilidad_anual"),
                    "sharpe_ratio":      comp.get("sharpe_ratio"),
                    "sortino_ratio":     comp.get("sortino_ratio"),
                    "max_drawdown":      comp.get("max_drawdown"),
                    "correlacion_sp500": comp.get("correlacion_sp500"),
                    "retorno_1m":        comp.get("retorno_1m"),
                    "retorno_3m":        comp.get("retorno_3m"),
                    "retorno_1y":        comp.get("retorno_1y"),
                    "retorno_ytd":       comp.get("retorno_ytd"),
                })
        except Exception:
            pass

    # Rellenar con ESTADOS FINANCIEROS: FCF (métrica nueva) + ratios faltantes.
    # Se hace si lo piden (con_estados) o si faltan ratios clave — el caso típico
    # de las acciones mexicanas, donde el resumen viene vacío pero los estados no.
    if out.get("ok") and (con_estados
                          or out.get("pe_trailing") is None
                          or out.get("pb") is None
                          or out.get("roe") is None
                          or (out.get("margenes") or {}).get("neto") is None):
        try:
            est = _derivar_de_estados(ticker, out.get("market_cap"))
            for k in ("fcf", "fcf_yield", "operating_cash_flow", "capex"):
                if out.get(k) is None and est.get(k) is not None:
                    out[k] = est[k]
            if out.get("pe_trailing") is None and est.get("pe") is not None:
                out["pe_trailing"] = est["pe"]
                out["pe_trailing_eval"] = _evaluar_pe(est["pe"])
            if out.get("pb") is None and est.get("pb") is not None:
                out["pb"] = est["pb"]
            if out.get("roe") is None and est.get("roe") is not None:
                out["roe"] = est["roe"]
            if out.get("debt_to_equity") is None and est.get("debt_to_equity") is not None:
                out["debt_to_equity"] = est["debt_to_equity"]
            marg = dict(out.get("margenes") or {})
            for sub, key in (("neto", "margen_neto"), ("operativo", "margen_operativo"), ("bruto", "margen_bruto")):
                if marg.get(sub) is None and est.get(key) is not None:
                    marg[sub] = est[key]
            out["margenes"] = marg
        except Exception:
            pass

    _tiene_fund = (any(out.get(k) is not None for k in ("pe_trailing", "pb", "roe", "fcf"))
                   or (out.get("margenes") or {}).get("neto") is not None)

    # Datos utilizables de yfinance → cachear y persistir como respaldo
    # (self-healing cache en BD, para servir si Yahoo falla en el futuro).
    if out.get("ok") and (not out.get("datos_parciales") or _tiene_fund):
        if not out.get("datos_parciales"):
            with _FUND_LOCK:
                _FUND_CACHE[ticker] = (time.time(), out)
        if _fallback is not None:
            try:
                _fallback.guardar_cache(ticker, out)
            except Exception:
                pass
        return out

    # yfinance no dio nada utilizable → recurrir a respaldos:
    #   1) caché en BD (última versión buena; cubre acciones mexicanas)
    #   2) proveedor externo Stooq/Alpha Vantage (solo EE.UU./cripto)
    if _fallback is not None:
        try:
            respaldo = _fallback.recuperar_fundamentales(ticker)
            if respaldo and respaldo.get("ok"):
                # Conservar las métricas de comportamiento que sí calculamos
                # localmente (volatilidad, Sharpe, retornos) si el respaldo no las trae.
                for k in ("volatilidad_anual", "sharpe_ratio", "sortino_ratio", "max_drawdown",
                          "correlacion_sp500", "retorno_1m", "retorno_3m", "retorno_1y", "retorno_ytd"):
                    if respaldo.get(k) is None and out.get(k) is not None:
                        respaldo[k] = out[k]
                return respaldo
        except Exception:
            pass

    return out


def analizar_fundamentales(tickers: List[str]) -> Dict[str, Any]:
    """Analiza fundamentales de una lista de tickers en paralelo."""
    if not tickers:
        raise ValueError("Se requiere al menos un ticker")

    tickers = [str(t).strip() for t in tickers if t and str(t).strip()]
    if len(tickers) > 30:
        raise ValueError("Máximo 30 tickers por request")

    resultados: Dict[str, Dict[str, Any]] = {}
    # 5 workers en vez de 8: reduce los 429 "too many requests" de Yahoo
    # cuando el portafolio tiene muchas acciones. La cache de _fundamentals_ticker
    # hace que recargas posteriores sean instantáneas.
    with ThreadPoolExecutor(max_workers=5) as ex:
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

    # Helper: promedio de un campo anidado (ej. margenes.neto)
    def _prom_anidado(campo: str, sub: str) -> Optional[float]:
        vals = []
        for r in validos:
            obj = r.get(campo) or {}
            v = obj.get(sub)
            if isinstance(v, (int, float)):
                vals.append(v)
        if not vals:
            return None
        return sum(vals) / len(vals)

    # Clasificar el portafolio por tipo de activo (para decidir qué métricas mostrar)
    n_crypto = sum(1 for r in validos if any(s in r.get("ticker", "").upper() for s in ("-USD", "-USDT")))
    n_etf    = sum(1 for r in validos if (r.get("ticker", "").upper() in {
        "SPY","VOO","IVV","VTI","QQQ","XLK","SMH","VXUS","VEA","VWO","EWZ","EWW","EWJ","EWY",
        "EWU","EWQ","EWP","EWT","FXI","XLF","XLE","XLV","XLY","XLP","XLI","XLU","XLB","XLRE",
        "TLT","BND","AGG","HYG","GLD","SLV","GDX","GDXJ","USO","FBTC","GBTC","IBIT","NAFTRAC.MX"
    }))
    n_stocks = len(validos) - n_crypto - n_etf

    resumen = {
        "num_tickers":    len(ordenados),
        "num_ok":         len(validos),
        "tipo_dominante": ("crypto" if n_crypto > n_etf + n_stocks else
                           "etf"    if n_etf > n_stocks else "stocks"),
        "composicion":    {"stocks": n_stocks, "etfs": n_etf, "crypto": n_crypto},
        # Fundamentales tradicionales (pueden ser None para crypto/ETFs)
        "pe_promedio":    _prom("pe_trailing"),
        "pb_promedio":    _prom("pb"),
        "peg_promedio":   _prom("peg"),
        "yield_promedio": _prom("dividend_yield"),
        "beta_promedio":  _prom("beta"),
        "roe_promedio":   _prom("roe"),
        "margen_neto_promedio":      _prom_anidado("margenes", "neto"),
        "margen_operativo_promedio": _prom_anidado("margenes", "operativo"),
        "debt_equity_promedio":      _prom("debt_to_equity"),
        # Métricas de comportamiento (SIEMPRE disponibles — funcionan para todo)
        "volatilidad_promedio":   _prom("volatilidad_anual"),
        "sharpe_promedio":        _prom("sharpe_ratio"),
        "sortino_promedio":       _prom("sortino_ratio"),
        "max_drawdown_promedio":  _prom("max_drawdown"),
        "correlacion_sp500_promedio": _prom("correlacion_sp500"),
        "retorno_1m_promedio":    _prom("retorno_1m"),
        "retorno_3m_promedio":    _prom("retorno_3m"),
        "retorno_1y_promedio":    _prom("retorno_1y"),
        "retorno_ytd_promedio":   _prom("retorno_ytd"),
    }

    # Avisos educativos sobre el portafolio
    avisos: List[str] = []

    # --- Explicar métricas faltantes (P/E, P/B, PEG, ROE, margen) ------------
    # Estas solo aplican a acciones de empresas; no a cripto ni a la mayoría de ETFs.
    metricas_empresa = [
        ("pe_promedio", "P/E"), ("pb_promedio", "P/B"), ("peg_promedio", "PEG"),
        ("roe_promedio", "ROE"), ("margen_neto_promedio", "margen neto"),
    ]
    faltantes = [nom for clave, nom in metricas_empresa if resumen[clave] is None]
    if faltantes:
        lista = ", ".join(faltantes)
        if n_stocks == 0:
            if n_crypto and not n_etf:
                razon = "solo tienes criptomonedas"
            elif n_etf and not n_crypto:
                razon = "solo tienes ETFs"
            else:
                razon = "no tienes acciones de empresas individuales (solo cripto y/o ETFs)"
            avisos.append(
                f"No se muestra {lista} porque {razon}: esas métricas miden a empresas "
                f"(utilidades, valor en libros) y no aplican a este tipo de activos. "
                f"Abajo sí ves volatilidad, Sharpe y rendimientos, que funcionan para todo."
            )
        else:
            avisos.append(
                f"{lista}: el promedio se calculó solo con las {n_stocks} "
                f"acción{'es' if n_stocks != 1 else ''} que reportan ese dato; "
                f"las posiciones sin el dato se ignoraron."
            )
    # Si hay cripto mezclada con acciones, aclarar que se ignoró en los ratios.
    if n_crypto and n_stocks and not faltantes:
        cripto_txt = "la cripto" if n_crypto == 1 else f"las {n_crypto} cripto"
        acc_txt = "tu acción" if n_stocks == 1 else f"tus {n_stocks} acciones"
        avisos.append(
            f"Se ignoró {cripto_txt} en P/E, P/B y PEG (no tienen utilidades ni valor "
            f"en libros); esos promedios usan solo {acc_txt}."
        )

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
