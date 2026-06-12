"""
dashboard_financiero.py — Dashboard financiero por acción.

Extrae estado de resultados, flujo de efectivo y balance de yfinance
para construir un dashboard tipo "10-K resumido" con:

  - KPIs: Revenue, Net Income, FCF, EPS Diluted, ROE (último FY + YoY)
  - Series 5Y: revenue, FCF, EPS, márgenes (gross/operating/net)

Robusto a tickers sin estados financieros (cripto, ETFs, ADRs raros).
"""
from __future__ import annotations

from typing import Any, Optional

import pandas as pd
import yfinance as yf


# ─────────────────────────────────────────────────────────────────
# Helpers — buscar filas en DataFrames de yfinance
# ─────────────────────────────────────────────────────────────────
def _row(df: Optional[pd.DataFrame], *labels: str) -> Optional[pd.Series]:
    """Busca la primera fila cuyo nombre matchee alguno de los labels (case-insensitive)."""
    if df is None or df.empty:
        return None
    idx_lower = {str(i).lower(): i for i in df.index}
    for label in labels:
        ll = label.lower()
        if ll in idx_lower:
            return df.loc[idx_lower[ll]]
        # match parcial
        for k_lower, k_orig in idx_lower.items():
            if ll in k_lower:
                return df.loc[k_orig]
    return None


def _to_yearly_dict(serie: Optional[pd.Series]) -> dict[str, float]:
    """Convierte Series con index = pd.Timestamp en {YYYY: float}."""
    if serie is None:
        return {}
    out = {}
    for fecha, valor in serie.items():
        try:
            ano = pd.Timestamp(fecha).year
            v = float(valor)
            if v == v:  # not NaN
                out[str(ano)] = v
        except Exception:
            continue
    return out


def _yoy(serie_dict: dict[str, float]) -> Optional[float]:
    """Crecimiento YoY del último vs penúltimo año disponible."""
    if not serie_dict:
        return None
    años = sorted(serie_dict.keys(), reverse=True)
    if len(años) < 2:
        return None
    cur, prev = serie_dict[años[0]], serie_dict[años[1]]
    if prev == 0 or prev is None or cur is None:
        return None
    return (cur - prev) / abs(prev)


def _ultimo(serie_dict: dict[str, float]) -> Optional[float]:
    if not serie_dict:
        return None
    años = sorted(serie_dict.keys(), reverse=True)
    return serie_dict[años[0]]


def _last_n(serie_dict: dict[str, float], n: int = 5) -> dict[str, float]:
    """Devuelve los últimos N años en orden cronológico ascendente."""
    if not serie_dict:
        return {}
    años = sorted(serie_dict.keys())[-n:]
    return {a: serie_dict[a] for a in años}


def _safe_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        f = float(x)
        if f != f:
            return None
        return f
    except (ValueError, TypeError):
        return None


# ─────────────────────────────────────────────────────────────────
# API pública
# ─────────────────────────────────────────────────────────────────
def obtener_dashboard(ticker: str) -> dict[str, Any]:
    """Construye el dashboard financiero de un ticker."""
    ticker = (ticker or "").strip().upper()
    if not ticker:
        raise ValueError("Ticker requerido")

    try:
        tk = yf.Ticker(ticker)
        info = tk.info or {}
        nombre = info.get("longName") or info.get("shortName") or ticker
        moneda_reporte = info.get("financialCurrency") or info.get("currency") or "USD"

        # Estados financieros anuales — yfinance v2 expone .income_stmt / .cashflow / .balance_sheet
        income = None
        cashflow = None
        balance = None
        try: income   = tk.income_stmt
        except Exception: pass
        try: cashflow = tk.cashflow
        except Exception: pass
        try: balance  = tk.balance_sheet
        except Exception: pass

        # Si están vacíos, intentar las versiones legacy (.financials, .cashflow_statement)
        if income is None or income.empty:
            try: income = tk.financials
            except Exception: pass

        # ── Income statement ─────────────────────────────────────
        revenue_d   = _to_yearly_dict(_row(income, "Total Revenue", "TotalRevenue", "Revenue", "Operating Revenue"))
        gross_d     = _to_yearly_dict(_row(income, "Gross Profit"))
        op_inc_d    = _to_yearly_dict(_row(income, "Operating Income", "Total Operating Income As Reported"))
        net_inc_d   = _to_yearly_dict(_row(income, "Net Income", "Net Income Common Stockholders"))
        eps_d       = _to_yearly_dict(_row(income, "Diluted EPS", "Basic EPS"))

        # ── Cashflow ─────────────────────────────────────────────
        cfo_d  = _to_yearly_dict(_row(cashflow, "Operating Cash Flow", "Total Cash From Operating Activities", "Cash Flow From Continuing Operating Activities"))
        capex_d = _to_yearly_dict(_row(cashflow, "Capital Expenditure", "Capital Expenditures"))
        fcf_d  = _to_yearly_dict(_row(cashflow, "Free Cash Flow"))

        # Si FCF no viene directo, calcularlo
        if not fcf_d and cfo_d:
            fcf_d = {a: cfo_d[a] + capex_d.get(a, 0) for a in cfo_d}  # capex viene como negativo en yf

        # ── Balance / ROE ────────────────────────────────────────
        equity_d = _to_yearly_dict(_row(balance, "Stockholders Equity", "Total Stockholder Equity", "Common Stock Equity"))

        # ROE = net income / equity (usa último FY)
        roe = None
        if net_inc_d and equity_d:
            ano_ult = sorted(set(net_inc_d.keys()) & set(equity_d.keys()), reverse=True)
            if ano_ult and equity_d[ano_ult[0]] > 0:
                roe = net_inc_d[ano_ult[0]] / equity_d[ano_ult[0]]
        # Fallback: yf info ROE
        if roe is None:
            roe = _safe_float(info.get("returnOnEquity"))

        # ── Márgenes anuales ─────────────────────────────────────
        margen_gross_d = {}
        margen_op_d    = {}
        margen_net_d   = {}
        for a in revenue_d:
            rev = revenue_d[a]
            if rev <= 0:
                continue
            if a in gross_d:   margen_gross_d[a] = gross_d[a]   / rev
            if a in op_inc_d:  margen_op_d[a]    = op_inc_d[a]  / rev
            if a in net_inc_d: margen_net_d[a]   = net_inc_d[a] / rev

        # ── KPIs último FY + YoY ─────────────────────────────────
        kpis = {
            "revenue": {
                "valor":      _ultimo(revenue_d),
                "yoy":        _yoy(revenue_d),
                "label":      "Ingresos totales",
            },
            "net_income": {
                "valor":      _ultimo(net_inc_d),
                "yoy":        _yoy(net_inc_d),
                "label":      "Utilidad neta",
            },
            "fcf": {
                "valor":      _ultimo(fcf_d),
                "yoy":        _yoy(fcf_d),
                "label":      "Free Cash Flow",
            },
            "eps_diluted": {
                "valor":      _ultimo(eps_d),
                "yoy":        _yoy(eps_d),
                "label":      "EPS diluted",
            },
            "roe": {
                "valor":      roe,
                "yoy":        None,
                "label":      "ROE",
                "es_pct":     True,
            },
        }

        # ── Series 5Y ────────────────────────────────────────────
        n_anos = 5
        series = {
            "revenue":  _last_n(revenue_d, n_anos),
            "fcf":      _last_n(fcf_d, n_anos),
            "eps":      _last_n(eps_d, n_anos),
            "net_income": _last_n(net_inc_d, n_anos),
            "margen_gross":     _last_n(margen_gross_d, n_anos),
            "margen_operating": _last_n(margen_op_d, n_anos),
            "margen_net":       _last_n(margen_net_d, n_anos),
        }

        # FY más reciente reportado
        all_anos = set()
        for d in (revenue_d, net_inc_d, fcf_d, eps_d):
            all_anos.update(d.keys())
        fy_actual = max(all_anos) if all_anos else None

        return {
            "ok":              True,
            "ticker":          ticker,
            "nombre":          nombre,
            "moneda_reporte":  moneda_reporte,
            "fy_actual":       fy_actual,
            "kpis":            kpis,
            "series":          series,
            "tiene_datos":     bool(revenue_d or fcf_d or eps_d),
        }
    except Exception as e:
        return {"ok": False, "ticker": ticker, "error": f"{type(e).__name__}: {e}"}


if __name__ == "__main__":
    import json
    r = obtener_dashboard("AAPL")
    print(json.dumps(r, indent=2, default=str))
