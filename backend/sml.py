"""
sml.py — Security Market Line (CAPM) para valorar acciones.

⚠️ Esta vista USA metricas_canonicas para los cálculos de beta/alpha de
modo que el número coincida EXACTAMENTE con lo que ve el usuario en
Acción del Día y Analizar. Solo agrega la narrativa Infravalorada /
Bien valorada / Sobrevalorada encima.


Aplica el modelo CAPM clásico:

    E(R_i) = R_f + β_i × (E(R_m) - R_f)

donde:
    E(R_i) = retorno esperado del activo según su riesgo sistémico
    R_f    = tasa libre de riesgo (CETES 28d para MX, UST 3m para US)
    β_i    = beta del activo vs el mercado
    R_m    = retorno esperado del mercado (histórico SPY o NAFTRAC.MX)

Devuelve veredicto:
  - Si retorno_real > E(R_i) + margen → INFRAVALORADA (alpha positivo)
  - Si retorno_real < E(R_i) - margen → SOBREVALORADA (alpha negativo)
  - Si |retorno_real - E(R_i)| < margen → BIEN VALORADA

Limitaciones del modelo:
- CAPM asume mercado eficiente y distribución normal de retornos
- Beta histórica puede no representar el futuro
- No considera factores cualitativos (gobernanza, moats, regulación)
- En crypto o IPOs recientes no aplica bien
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd
import yfinance as yf


# Tasas libres de riesgo asumidas (anualizadas)
# Se pueden sobreescribir con CETES_28D / UST_3M env vars
RF_USD_DEFAULT = 0.045   # 4.5% — UST 3m aprox
RF_MXN_DEFAULT = 0.095   # 9.5% — CETES 28d aprox

# Premios de mercado históricos (retorno SP500 / IPC - tasa libre de riesgo)
PREMIO_MERCADO_USA = 0.06   # ~6% histórico USA
PREMIO_MERCADO_MX  = 0.04   # ~4% histórico México


def _benchmark_para(ticker: str) -> str:
    """SPY para tickers internacionales/US, NAFTRAC.MX para acciones MX."""
    if (ticker or "").upper().endswith(".MX"):
        return "NAFTRAC.MX"
    return "SPY"


def _es_crypto(ticker: str) -> bool:
    t = (ticker or "").upper()
    return t.endswith("-USD") or t.endswith("-USDT")


def _rf_para(ticker: str) -> float:
    """Tasa libre de riesgo en la moneda apropiada."""
    if (ticker or "").upper().endswith(".MX"):
        try:
            return float(os.environ.get("CETES_28D", RF_MXN_DEFAULT))
        except (TypeError, ValueError):
            return RF_MXN_DEFAULT
    try:
        return float(os.environ.get("UST_3M", RF_USD_DEFAULT))
    except (TypeError, ValueError):
        return RF_USD_DEFAULT


def _premio_mercado_para(ticker: str) -> float:
    if (ticker or "").upper().endswith(".MX"):
        return PREMIO_MERCADO_MX
    return PREMIO_MERCADO_USA


def _descargar_retornos(ticker: str, periodo: str = "5y") -> Optional[pd.Series]:
    """Descarga precios y devuelve retornos mensuales (no diarios)
    para reducir ruido y obtener una beta más estable."""
    try:
        hist = yf.Ticker(ticker).history(period=periodo, auto_adjust=True)
        if hist is None or hist.empty or "Close" not in hist.columns:
            return None
        precios = hist["Close"].dropna()
        if len(precios) < 60:
            return None
        # Resample mensual (último día del mes)
        mensuales = precios.resample("ME").last().dropna()
        if len(mensuales) < 12:
            return None
        return mensuales.pct_change().dropna()
    except Exception:
        return None


def _retorno_anualizado(retornos_mensuales: pd.Series) -> Optional[float]:
    """Retorno anualizado a partir de retornos mensuales."""
    if retornos_mensuales is None or retornos_mensuales.empty:
        return None
    try:
        retorno_medio_mensual = retornos_mensuales.mean()
        return float((1 + retorno_medio_mensual) ** 12 - 1)
    except Exception:
        return None


def _beta(retornos_activo: pd.Series, retornos_mercado: pd.Series) -> Optional[float]:
    """Beta = cov(activo, mercado) / var(mercado)."""
    try:
        comun = retornos_activo.index.intersection(retornos_mercado.index)
        if len(comun) < 12:
            return None
        ra = retornos_activo.loc[comun]
        rm = retornos_mercado.loc[comun]
        var_m = rm.var()
        if not var_m or var_m == 0:
            return None
        cov = ra.cov(rm)
        return float(cov / var_m)
    except Exception:
        return None


def _veredicto_desde_canon(canon: Dict[str, Any]) -> Dict[str, Any]:
    """Construye el output SML desde el bundle canónico."""
    beta = canon["beta"]
    alpha = canon["alpha_anualizado"]
    r_real = canon["retorno_real_anual"]
    r_esp = canon["retorno_esperado_capm"]

    margen = max(0.02, 0.015 * abs(beta))
    if alpha > margen:
        veredicto, color = "Infravalorada", "green"
        interp = (f"El retorno real anualizado ({r_real*100:.1f}%) supera al esperado "
                  f"por CAPM ({r_esp*100:.1f}%) en {alpha*100:+.1f} puntos. "
                  f"Está pagando más rendimiento del que justifica su riesgo sistémico, "
                  f"lo que el modelo interpreta como posible oportunidad.")
    elif alpha < -margen:
        veredicto, color = "Sobrevalorada", "red"
        interp = (f"El retorno real anualizado ({r_real*100:.1f}%) es menor al esperado "
                  f"por CAPM ({r_esp*100:.1f}%) por {abs(alpha)*100:.1f} puntos. "
                  f"Está pagando menos rendimiento del que demandaría su riesgo.")
    else:
        veredicto, color = "Bien valorada", "blue"
        interp = (f"El retorno real ({r_real*100:.1f}%) está alineado con lo que CAPM "
                  f"predice para su beta ({beta:.2f}). En equilibrio según el modelo.")

    if abs(beta) < 0.7:
        clase_beta = "Defensiva (β < 0.7)"
    elif abs(beta) < 1.2:
        clase_beta = "Mercado (β ≈ 1)"
    elif abs(beta) < 1.6:
        clase_beta = "Agresiva (β > 1.2)"
    else:
        clase_beta = "Muy volátil (β > 1.6)"

    return {
        "ok":                    True,
        "ticker":                canon["ticker"],
        "benchmark":             canon["benchmark"],
        "moneda":                canon["moneda"],
        "periodo":               "5 años de retornos mensuales",
        "tasa_libre_riesgo":     canon["tasa_libre_riesgo"],
        "premio_mercado":        canon["premio_mercado"],
        "beta":                  beta,
        "clase_beta":            clase_beta,
        "retorno_real_anual":    r_real,
        "retorno_esperado_sml":  r_esp,
        "alpha":                 alpha,
        "veredicto":             veredicto,
        "veredicto_color":       color,
        "interpretacion":        interp,
        "advertencia": (
            "El modelo CAPM/SML es una herramienta cuantitativa con supuestos fuertes "
            "(mercado eficiente, distribución normal, beta estable). Combínalo siempre "
            "con análisis cualitativo de la empresa."
        ),
    }


def evaluar_sml(ticker: str) -> Dict[str, Any]:
    """Evalúa el ticker contra la Security Market Line del CAPM.

    Usa metricas_canonicas como única fuente de verdad. Si el ticker está
    en el universo local, no descarga (instantáneo). Si no, descarga vía
    yfinance pero usa LA MISMA fórmula que el resto de las vistas.
    """
    ticker = (ticker or "").strip().upper()
    if not ticker:
        return {"ok": False, "error": "Ticker vacío"}

    if _es_crypto(ticker):
        return {
            "ok": False,
            "error": (
                "CAPM no aplica a criptomonedas. Su distribución de retornos no es "
                "normal y su beta vs mercado equity es estructuralmente inestable."
            ),
        }

    # Path rápido: si el ticker está en el universo local, usa el bundle canónico
    try:
        import accion_del_dia as _ad
        canon = _ad.score_para_ticker(ticker)
        if canon and canon.get("beta") is not None:
            return _veredicto_desde_canon(canon)
    except Exception:
        pass

    # Fallback: descarga vía yfinance y calcula con metricas_canonicas
    import metricas_canonicas as _MC
    import pandas as _pd

    benchmark = _MC.benchmark_para(ticker)
    moneda = _MC.moneda_para(ticker)
    rf = _MC.rf_para(ticker)

    # Descargar precios diarios (no retornos)
    try:
        import yfinance as _yf
        hist_t = _yf.Ticker(ticker).history(period="5y", auto_adjust=True)
        hist_m = _yf.Ticker(benchmark).history(period="5y", auto_adjust=True)
        if hist_t.empty or hist_m.empty:
            return {"ok": False, "error": f"Sin datos históricos para {ticker} o benchmark."}
        serie_t = hist_t["Close"].dropna()
        serie_m = hist_m["Close"].dropna()
    except Exception as e:
        return {"ok": False, "error": f"Error descargando datos: {e}"}

    metricas = _MC.calcular_metricas(ticker, serie_t, serie_m)
    if metricas is None:
        return {"ok": False, "error": "No se pudieron calcular métricas (poca historia)."}

    # Construir bundle con shape de canon para reusar el veredicto
    canon = {
        "ticker":                ticker,
        "benchmark":             benchmark,
        "moneda":                moneda,
        "beta":                  metricas["beta"],
        "alpha_anualizado":      metricas["alpha_anualizado"],
        "retorno_real_anual":    metricas["retorno_real_anual"],
        "retorno_esperado_capm": metricas["retorno_esperado_capm"],
        "tasa_libre_riesgo":     metricas["tasa_libre_riesgo"],
        "premio_mercado":        metricas["premio_mercado"],
    }
    return _veredicto_desde_canon(canon)
