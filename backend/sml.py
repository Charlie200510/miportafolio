"""
sml.py — Security Market Line (CAPM) para valorar acciones.

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


def evaluar_sml(ticker: str) -> Dict[str, Any]:
    """Evalúa el ticker contra la Security Market Line del CAPM."""
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

    benchmark = _benchmark_para(ticker)
    rf = _rf_para(ticker)
    moneda = "MXN" if ticker.endswith(".MX") else "USD"

    # Descargar retornos del activo y del benchmark
    retornos_activo = _descargar_retornos(ticker, "5y")
    retornos_mercado = _descargar_retornos(benchmark, "5y")

    if retornos_activo is None:
        return {"ok": False, "error": f"No se pudo obtener histórico de {ticker} (mínimo 12 meses)."}
    if retornos_mercado is None:
        return {"ok": False, "error": f"No se pudo obtener histórico del benchmark ({benchmark})."}

    # Cálculos
    beta = _beta(retornos_activo, retornos_mercado)
    if beta is None:
        return {"ok": False, "error": "No se pudo calcular beta (insuficientes datos comunes)."}

    retorno_real_anual = _retorno_anualizado(retornos_activo)
    retorno_mercado_anual = _retorno_anualizado(retornos_mercado)

    # Premio de mercado: histórico observado o el default
    if retorno_mercado_anual is not None:
        premio_mercado = max(0.01, retorno_mercado_anual - rf)
    else:
        premio_mercado = _premio_mercado_para(ticker)

    # SML — retorno esperado según riesgo sistémico
    retorno_esperado_sml = rf + beta * premio_mercado

    # Alpha (de Jensen) — retorno real menos esperado
    alpha = (retorno_real_anual or 0) - retorno_esperado_sml

    # Veredicto basado en alpha anualizado
    # Margen aumenta con beta: activos más volátiles tienen más ruido
    margen = max(0.02, 0.015 * abs(beta))
    if alpha > margen:
        veredicto = "Infravalorada"
        veredicto_color = "green"
        interpretacion = (
            f"El retorno real anualizado ({retorno_real_anual*100:.1f}%) supera al esperado "
            f"por CAPM ({retorno_esperado_sml*100:.1f}%) en {alpha*100:+.1f} puntos. "
            f"Eso significa que está pagando más rendimiento del que justifica su riesgo sistémico, "
            f"lo que el modelo interpreta como una posible oportunidad."
        )
    elif alpha < -margen:
        veredicto = "Sobrevalorada"
        veredicto_color = "red"
        interpretacion = (
            f"El retorno real anualizado ({retorno_real_anual*100:.1f}%) es menor al esperado "
            f"por CAPM ({retorno_esperado_sml*100:.1f}%) por {abs(alpha)*100:.1f} puntos. "
            f"Está pagando menos rendimiento del que demandaría su riesgo, "
            f"lo que el modelo interpreta como cara para su perfil."
        )
    else:
        veredicto = "Bien valorada"
        veredicto_color = "blue"
        interpretacion = (
            f"El retorno real ({retorno_real_anual*100:.1f}%) está alineado con lo que CAPM "
            f"predice para su beta ({beta:.2f}). En equilibrio según el modelo."
        )

    # Clasificación de beta
    if beta < 0.7:
        clase_beta = "Defensiva (β < 0.7)"
    elif beta < 1.2:
        clase_beta = "Mercado (β ≈ 1)"
    elif beta < 1.6:
        clase_beta = "Agresiva (β > 1.2)"
    else:
        clase_beta = "Muy volátil (β > 1.6)"

    return {
        "ok":                True,
        "ticker":            ticker,
        "benchmark":         benchmark,
        "moneda":            moneda,
        "periodo":           "5 años de retornos mensuales",
        "tasa_libre_riesgo": round(rf, 4),
        "premio_mercado":    round(premio_mercado, 4),
        "beta":              round(beta, 3),
        "clase_beta":        clase_beta,
        "retorno_mercado_anual": round(retorno_mercado_anual or 0, 4),
        "retorno_real_anual":    round(retorno_real_anual or 0, 4),
        "retorno_esperado_sml":  round(retorno_esperado_sml, 4),
        "alpha":             round(alpha, 4),
        "veredicto":         veredicto,
        "veredicto_color":   veredicto_color,
        "interpretacion":    interpretacion,
        "advertencia": (
            "El modelo CAPM/SML es una herramienta cuantitativa con supuestos fuertes "
            "(mercado eficiente, distribución normal, beta estable). Combínalo siempre "
            "con análisis cualitativo de la empresa."
        ),
    }
