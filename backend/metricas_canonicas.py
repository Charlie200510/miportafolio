"""
metricas_canonicas.py — Única fuente de verdad para Beta, Alpha, Retorno,
Volatilidad, Sharpe y Score.

Antes había 3 cálculos distintos de Beta en el código (analisis/sml/accion_del_dia)
con diferentes frecuencias, períodos y fuentes. Resultado: la misma acción daba
β=0.85 en una vista y β=1.10 en otra. Eso confundía al usuario.

CONVENCIÓN CANÓNICA (académicamente estándar):
- Frecuencia: retornos MENSUALES (último día de cada mes)
- Período: 5 años (60 observaciones) con fallback a 3 años (36) o 1 año (12)
- Benchmark: SPY para tickers internacionales/US, NAFTRAC.MX para .MX
- Tasa libre de riesgo: UST 3m (USD) o CETES 28d (MXN)
- Premio de mercado: max(0.01, retorno_real_mercado_5y - rf)

CUALQUIER módulo que muestre Beta, Alpha o Score debe importar de aquí
y NO recalcular por su cuenta.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────
# Constantes canónicas
# ─────────────────────────────────────────────────────────
RF_USD_DEFAULT = 0.045   # UST 3m aprox
RF_MXN_DEFAULT = 0.095   # CETES 28d aprox
PREMIO_USD     = 0.06    # Premio histórico SP500
PREMIO_MXN     = 0.04    # Premio histórico IPC

# Tamaño mínimo de observaciones para tener una β estable
MIN_OBS_BETA = 12        # 1 año de meses
PREF_OBS_BETA = 60       # 5 años — ideal

# Para retorno anualizado desde precios diarios
DIAS_TRADING_ANUAL = 252


# ─────────────────────────────────────────────────────────
# Helpers de inferencia
# ─────────────────────────────────────────────────────────
def benchmark_para(ticker: str) -> str:
    """SPY para US/internacional, NAFTRAC.MX para .MX."""
    if (ticker or "").upper().endswith(".MX"):
        return "NAFTRAC.MX"
    return "SPY"


def moneda_para(ticker: str) -> str:
    return "MXN" if (ticker or "").upper().endswith(".MX") else "USD"


def es_crypto(ticker: str) -> bool:
    t = (ticker or "").upper()
    return t.endswith("-USD") or t.endswith("-USDT")


def rf_para(ticker: str) -> float:
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


def premio_mercado_para(ticker: str) -> float:
    if (ticker or "").upper().endswith(".MX"):
        return PREMIO_MXN
    return PREMIO_USD


# ─────────────────────────────────────────────────────────
# Cálculos básicos (sobre series de precios diarios)
# ─────────────────────────────────────────────────────────
def retornos_mensuales(serie_precios: pd.Series) -> Optional[pd.Series]:
    """Convierte serie de precios diarios a retornos mensuales (último día del mes)."""
    if serie_precios is None or len(serie_precios) == 0:
        return None
    s = serie_precios.dropna()
    if len(s) < 60:    # menos de ~3 meses → no es serio
        return None
    try:
        mensuales = s.resample("ME").last().dropna()
        if len(mensuales) < 12:
            return None
        return mensuales.pct_change().dropna()
    except Exception:
        return None


def retorno_anualizado_desde_mensuales(rets_mens: pd.Series) -> Optional[float]:
    """Retorno anualizado desde retornos mensuales (media geométrica)."""
    if rets_mens is None or rets_mens.empty:
        return None
    try:
        return float((1 + rets_mens.mean()) ** 12 - 1)
    except Exception:
        return None


def volatilidad_anualizada_desde_mensuales(rets_mens: pd.Series) -> Optional[float]:
    """Volatilidad anualizada (σ) desde retornos mensuales."""
    if rets_mens is None or rets_mens.empty:
        return None
    try:
        return float(rets_mens.std() * np.sqrt(12))
    except Exception:
        return None


# ─────────────────────────────────────────────────────────
# CANÓNICOS — Beta, Alpha, Sharpe
# ─────────────────────────────────────────────────────────
def beta_canonica(
    rets_activo_mens: pd.Series,
    rets_mercado_mens: pd.Series,
) -> Optional[float]:
    """Beta = cov(activo, mercado) / var(mercado), sobre retornos mensuales."""
    try:
        comun = rets_activo_mens.index.intersection(rets_mercado_mens.index)
        if len(comun) < MIN_OBS_BETA:
            return None
        ra = rets_activo_mens.loc[comun]
        rm = rets_mercado_mens.loc[comun]
        var = rm.var()
        if not var or var == 0:
            return None
        return float(ra.cov(rm) / var)
    except Exception:
        return None


def alpha_jensen(retorno_real: float, beta: float, rf: float, premio_mercado: float) -> float:
    """Alpha de Jensen = retorno_real − [rf + β × premio_mercado]."""
    return retorno_real - (rf + beta * premio_mercado)


def sharpe_canonico(rets_mens: pd.Series, rf_anual: float) -> Optional[float]:
    """Sharpe = (retorno - rf) / vol — anualizado, desde mensuales."""
    if rets_mens is None or rets_mens.empty:
        return None
    try:
        r_anual = retorno_anualizado_desde_mensuales(rets_mens)
        s_anual = volatilidad_anualizada_desde_mensuales(rets_mens)
        if not s_anual or s_anual == 0:
            return None
        return float((r_anual - rf_anual) / s_anual)
    except Exception:
        return None


# ─────────────────────────────────────────────────────────
# Bundle completo — todas las métricas canónicas en un solo objeto
# ─────────────────────────────────────────────────────────
def calcular_metricas(
    ticker: str,
    serie_precios: pd.Series,
    serie_mercado: pd.Series,
) -> Optional[Dict[str, Any]]:
    """Devuelve el bundle canónico para un ticker.

    Args:
        ticker: símbolo (AAPL, GFNORTE.MX, etc.)
        serie_precios: pd.Series con precios diarios del ticker (index DateTime)
        serie_mercado: pd.Series con precios diarios del benchmark (SPY/NAFTRAC.MX)

    Returns:
        Dict con: beta, alpha, retorno_real_anual, retorno_esperado_capm,
                  volatilidad_anual, sharpe, momentum_3m
        O None si no hay suficiente historia.
    """
    rets_activo = retornos_mensuales(serie_precios)
    rets_mkt    = retornos_mensuales(serie_mercado)
    if rets_activo is None or rets_mkt is None:
        return None

    beta = beta_canonica(rets_activo, rets_mkt)
    if beta is None:
        return None

    rf = rf_para(ticker)
    # Premio de mercado: histórico observado, con piso de 1%
    r_mkt_anual = retorno_anualizado_desde_mensuales(rets_mkt) or 0
    premio = max(0.01, r_mkt_anual - rf) if r_mkt_anual else premio_mercado_para(ticker)

    r_real_anual = retorno_anualizado_desde_mensuales(rets_activo) or 0
    r_esp_capm   = rf + beta * premio
    alpha        = alpha_jensen(r_real_anual, beta, rf, premio)
    vol_anual    = volatilidad_anualizada_desde_mensuales(rets_activo) or 0
    sharpe       = sharpe_canonico(rets_activo, rf) or 0

    # Momentum 3m (sobre precios diarios, últimos 63 días hábiles)
    momentum_3m = None
    try:
        s = serie_precios.dropna()
        if len(s) >= 63:
            momentum_3m = float((s.iloc[-1] / s.iloc[-63]) - 1)
    except Exception:
        pass

    return {
        "ticker":                ticker,
        "benchmark":             benchmark_para(ticker),
        "moneda":                moneda_para(ticker),
        "beta":                  round(beta, 3),
        "alpha_anualizado":      round(alpha, 4),
        "retorno_real_anual":    round(r_real_anual, 4),
        "retorno_esperado_capm": round(r_esp_capm, 4),
        "tasa_libre_riesgo":     round(rf, 4),
        "premio_mercado":        round(premio, 4),
        "volatilidad_anual":     round(vol_anual, 4),
        "sharpe":                round(sharpe, 3),
        "momentum_3m":           round(momentum_3m, 4) if momentum_3m is not None else None,
        "n_observaciones_beta":  len(rets_activo.index.intersection(rets_mkt.index)),
    }


# ─────────────────────────────────────────────────────────
# Score compuesto — única fuente
# ─────────────────────────────────────────────────────────
def score_compuesto(
    metricas: Dict[str, Any],
    fundamentales: Optional[Dict[str, Any]] = None,
    liquidez_valor_diaria: Optional[float] = None,
) -> Tuple[int, List[str]]:
    """Calcula el score compuesto canónico (0-100) y las razones.

    Mismo cálculo que se usa en Acción del Día, Analizar y cualquier otra vista.

    Args:
        metricas: bundle de calcular_metricas()
        fundamentales: {pe, roe, margen_neto, debt_equity, dividend_yield} opcional
        liquidez_valor_diaria: volumen × precio (USD/MXN diarios)

    Returns:
        (score 0-100, lista de razones)
    """
    f = fundamentales or {}
    score = 0
    razones: List[str] = []

    alpha = metricas.get("alpha_anualizado", 0) or 0
    beta  = metricas.get("beta", 1) or 1
    sharpe = metricas.get("sharpe", 0) or 0
    mom = metricas.get("momentum_3m", 0) or 0

    # === SML / Alpha (hasta 30 pts) ===
    if alpha > 0.05:
        score += 30
        razones.append(f"Alpha SML alto ({alpha*100:+.1f}% vs CAPM)")
    elif alpha > 0.02:
        score += 20
        razones.append(f"Alpha SML positivo ({alpha*100:+.1f}%)")
    elif alpha > 0:
        score += 8
        razones.append(f"Alpha ligeramente positivo ({alpha*100:+.1f}%)")
    elif alpha > -0.02:
        score += 3
    else:
        score -= 10

    # === Sharpe (hasta 10 pts) ===
    if sharpe > 1.0:
        score += 10
        razones.append(f"Sharpe excelente ({sharpe:.2f})")
    elif sharpe > 0.5:
        score += 6
        razones.append(f"Sharpe sólido ({sharpe:.2f})")
    elif sharpe > 0:
        score += 2

    # === Beta razonable (5 pts) ===
    if 0.7 <= abs(beta) <= 1.3:
        score += 5

    # === Fundamentales ===
    pe  = f.get("pe")
    roe = f.get("roe")
    margen = f.get("margen_neto")
    de  = f.get("debt_equity")
    dy  = f.get("dividend_yield")

    # Normalización defensiva
    if roe is not None and roe > 1:    roe /= 100
    if margen is not None and margen > 1: margen /= 100
    if dy is not None and dy > 1:       dy /= 100
    if de is not None and de > 10:      de /= 100

    if pe and 0 < pe < 60:
        if 8 <= pe <= 25:
            score += 15
            razones.append(f"P/E razonable ({pe:.1f})")
        elif pe < 8:
            score += 8
            razones.append(f"P/E bajo ({pe:.1f}) — value")
        elif pe < 35:
            score += 5

    if roe is not None:
        if roe > 0.20:
            score += 15
            razones.append(f"ROE excelente ({roe*100:.0f}%)")
        elif roe > 0.12:
            score += 10
            razones.append(f"ROE sólido ({roe*100:.0f}%)")
        elif roe > 0.05:
            score += 3
        elif roe < 0:
            score -= 10

    if margen is not None:
        if margen > 0.20:
            score += 10
            razones.append(f"Margen neto alto ({margen*100:.0f}%)")
        elif margen > 0.10:
            score += 6
        elif margen < 0:
            score -= 8

    if de is not None:
        if de < 0.5:
            score += 8
            razones.append(f"Deuda baja (D/E {de:.2f})")
        elif de < 1.0:
            score += 4
        elif de > 2.0:
            score -= 5

    if dy and dy > 0.02:
        score += min(8, int(dy * 200))
        razones.append(f"Dividend yield {dy*100:.1f}%")

    # === Momentum ===
    if 0.03 <= mom <= 0.20:
        score += 10
        razones.append(f"Momentum 3m sano (+{mom*100:.1f}%)")
    elif mom > 0.20:
        score += 4
        razones.append(f"Momentum 3m fuerte (+{mom*100:.1f}%)")
    elif mom < -0.15:
        score -= 6

    # === Liquidez ===
    if liquidez_valor_diaria and liquidez_valor_diaria >= 50_000_000:
        score += 5
    elif liquidez_valor_diaria and liquidez_valor_diaria < 1_000_000:
        score -= 5

    # Acotar a [0, 100]
    score = max(0, min(100, score))
    return score, razones


def nivel_para_score(score: int) -> Tuple[str, str]:
    """Devuelve (nivel, color) según el score canónico."""
    if score >= 60:
        return "Recomendación fuerte", "green"
    if score >= 40:
        return "Recomendación moderada", "blue"
    if score >= 25:
        return "Mención honorífica", "amber"
    return "Sin ganador claro", "zinc"
