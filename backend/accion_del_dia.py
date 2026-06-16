"""
accion_del_dia.py — Selecciona "La acción del día" combinando:

  1. Alpha SML (CAPM) — cuánto rinde más de lo que su riesgo justifica
  2. Calidad fundamental — PE razonable, ROE alto, margen sano, deuda baja
  3. Momentum — retorno positivo en los últimos meses
  4. Liquidez — volumen × precio (que sea operable)
  5. Tipo — preferimos acciones (no ETFs/crypto) y mezcla MX/US

Todo el cálculo es LOCAL (CSV de precios + JSON de info activos), sin
yfinance, para que el endpoint responda en menos de 1 segundo.

Cache 24h en disco.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
_INFO_PATH = _BACKEND_DIR / "info_activos.json"

_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 24 * 60 * 60   # 24 horas — la acción del día se rota una vez al día
_CACHE_DIR = _BACKEND_DIR / "_cache_accion_dia"
_CACHE_DIR.mkdir(exist_ok=True)


# Parámetros del CAPM simplificado (mismos defaults que sml.py)
RF_USD = 0.045
RF_MXN = 0.095
PREMIO_USD = 0.06
PREMIO_MXN = 0.04


# ─────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────
def _cargar_precios() -> Optional[pd.DataFrame]:
    csv = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
    if not csv.exists():
        return None
    try:
        return pd.read_csv(csv, index_col=0, parse_dates=True).sort_index()
    except Exception:
        return None


def _cargar_info() -> Dict[str, Any]:
    if not _INFO_PATH.exists():
        return {}
    try:
        with open(_INFO_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _retornos_mensuales(serie: pd.Series) -> Optional[pd.Series]:
    s = serie.dropna()
    if len(s) < 252:           # mínimo ~1 año
        return None
    try:
        mens = s.resample("ME").last().dropna()
        if len(mens) < 12:
            return None
        return mens.pct_change().dropna()
    except Exception:
        return None


def _retorno_anualizado(ret_mens: pd.Series) -> Optional[float]:
    try:
        return float((1 + ret_mens.mean()) ** 12 - 1)
    except Exception:
        return None


def _beta(rets_activo: pd.Series, rets_mkt: pd.Series) -> Optional[float]:
    try:
        comun = rets_activo.index.intersection(rets_mkt.index)
        if len(comun) < 12:
            return None
        ra, rm = rets_activo.loc[comun], rets_mkt.loc[comun]
        var = rm.var()
        if not var or var == 0:
            return None
        return float(ra.cov(rm) / var)
    except Exception:
        return None


# ─────────────────────────────────────────────────────────
# Filtros de candidatos
# ─────────────────────────────────────────────────────────
def _es_candidato(ticker: str, info: Dict[str, Any]) -> bool:
    """Filtra ETFs, fondos, crypto, índices."""
    t = ticker.upper()
    if "-USD" in t or "-USDT" in t:
        return False
    tipo = (info.get("tipo") or info.get("quoteType") or "").upper()
    if tipo in ("ETF", "MUTUALFUND", "INDEX", "FUTURE", "CRYPTOCURRENCY"):
        return False
    # Heurísticas por nombre
    nombre = (info.get("nombre") or "").upper()
    if any(k in nombre for k in ("ETF", "FUND", "TRUST", "INDEX")):
        return False
    return True


def _moneda(ticker: str) -> str:
    return "MXN" if ticker.upper().endswith(".MX") else "USD"


# ─────────────────────────────────────────────────────────
# Scoring por ticker
# ─────────────────────────────────────────────────────────
def _puntuar(
    ticker: str,
    df_precios: pd.DataFrame,
    info: Dict[str, Any],
    rets_spy: Optional[pd.Series],
    rets_naftrac: Optional[pd.Series],
) -> Optional[Tuple[int, Dict[str, Any]]]:
    """Devuelve (score, detalles) o None si no es scoreable."""
    if ticker not in df_precios.columns:
        return None
    serie = df_precios[ticker]
    rets_m = _retornos_mensuales(serie)
    if rets_m is None:
        return None

    es_mx = ticker.upper().endswith(".MX")
    rets_mkt = rets_naftrac if es_mx else rets_spy
    if rets_mkt is None:
        return None

    beta = _beta(rets_m, rets_mkt)
    if beta is None:
        return None

    rf = RF_MXN if es_mx else RF_USD
    premio = PREMIO_MXN if es_mx else PREMIO_USD
    r_real = _retorno_anualizado(rets_m) or 0.0
    r_esperado = rf + beta * premio
    alpha = r_real - r_esperado

    # Momentum: últimos 63 días (3 meses)
    momentum_3m = 0.0
    try:
        s = serie.dropna()
        if len(s) >= 63:
            momentum_3m = float((s.iloc[-1] / s.iloc[-63]) - 1)
    except Exception:
        pass

    # Fundamentales (todos opcionales)
    pe = info.get("pe") or info.get("trailingPE") or info.get("forwardPE")
    roe = info.get("roe") or info.get("returnOnEquity")
    margen = info.get("margen_neto") or info.get("profitMargins")
    de = info.get("debt_equity") or info.get("debtToEquity")
    div_yield = info.get("dividend_yield") or info.get("dividendYield")
    if div_yield and div_yield > 1:
        div_yield = div_yield / 100   # a veces viene en % (5.2) y a veces en frac (0.052)
    if roe and roe > 1:
        roe = roe / 100
    if margen and margen > 1:
        margen = margen / 100
    if de and de > 10:
        de = de / 100    # algunos vienen como 152 (=152%)

    # Liquidez
    vol = info.get("averageVolume") or info.get("average_volume") or 0
    precio_actual = float(serie.dropna().iloc[-1]) if len(serie.dropna()) else None
    valor_transado = (vol * precio_actual) if (vol and precio_actual) else 0

    # ── SCORING ──
    score = 0
    razones: List[str] = []

    # SML (peso fuerte: hasta 30)
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
        # alpha muy negativo penaliza
        score -= 10

    # PE razonable (entre 8 y 28)
    if pe and 0 < pe < 60:
        if 8 <= pe <= 25:
            score += 15
            razones.append(f"P/E razonable ({pe:.1f})")
        elif pe < 8:
            score += 8
            razones.append(f"P/E bajo ({pe:.1f}) — value")
        elif pe < 35:
            score += 5
        # pe > 35 sin puntos

    # ROE > 12%
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

    # Margen neto > 10%
    if margen is not None:
        if margen > 0.20:
            score += 10
            razones.append(f"Margen neto alto ({margen*100:.0f}%)")
        elif margen > 0.10:
            score += 6
        elif margen < 0:
            score -= 8

    # Deuda controlada
    if de is not None:
        if de < 0.5:
            score += 8
            razones.append(f"Deuda baja (D/E {de:.2f})")
        elif de < 1.0:
            score += 4
        elif de > 2.0:
            score -= 5

    # Dividendos
    if div_yield and div_yield > 0.02:
        score += min(8, int(div_yield * 200))   # 2%→4, 4%→8
        razones.append(f"Dividend yield {div_yield*100:.1f}%")

    # Momentum positivo pero no extremo
    if momentum_3m is not None:
        if 0.03 <= momentum_3m <= 0.20:
            score += 10
            razones.append(f"Momentum 3m sano (+{momentum_3m*100:.1f}%)")
        elif momentum_3m > 0.20:
            score += 4
            razones.append(f"Momentum 3m fuerte (+{momentum_3m*100:.1f}%)")
        elif momentum_3m < -0.15:
            score -= 6

    # Beta cerca de 1 (no defensiva extrema ni agresiva)
    if 0.7 <= abs(beta) <= 1.3:
        score += 5

    # Liquidez (que sea operable de verdad)
    if valor_transado >= 50_000_000:    # $50M USD/MXN diarios
        score += 5
    elif valor_transado < 1_000_000:
        score -= 5

    detalles = {
        "ticker": ticker,
        "nombre": info.get("nombre") or ticker,
        "sector": info.get("sector"),
        "industria": info.get("industria") or info.get("industry"),
        "moneda": _moneda(ticker),
        "es_mx": es_mx,
        "precio": round(precio_actual, 2) if precio_actual else None,
        "beta": round(beta, 2),
        "alpha_anualizado": round(alpha, 4),
        "retorno_real_anual": round(r_real, 4),
        "retorno_esperado_sml": round(r_esperado, 4),
        "momentum_3m": round(momentum_3m, 4) if momentum_3m is not None else None,
        "pe": round(pe, 2) if pe else None,
        "roe": round(roe, 4) if roe is not None else None,
        "margen_neto": round(margen, 4) if margen is not None else None,
        "debt_equity": round(de, 2) if de is not None else None,
        "dividend_yield": round(div_yield, 4) if div_yield else None,
        "valor_transado_dia": round(valor_transado, 0) if valor_transado else None,
        "score": score,
        "razones": razones,
    }
    return score, detalles


# ─────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────
def accion_del_dia(forzar: bool = False) -> Dict[str, Any]:
    """Selecciona y devuelve la acción del día. Cache 24h."""
    # Cache memoria
    cached = _CACHE.get("hoy")
    if not forzar and cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]

    # Cache disco (sobrevive reinicios)
    disk_path = _CACHE_DIR / "hoy.json"
    if not forzar and disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                d = json.load(f)
            if (time.time() - d.get("_ts", 0)) < _CACHE_TTL:
                _CACHE["hoy"] = {"ts": d["_ts"], "data": d["data"]}
                return d["data"]
        except Exception:
            pass

    df_precios = _cargar_precios()
    if df_precios is None or df_precios.empty:
        return {"ok": False, "error": "No hay datos del universo cargados"}

    info_all = _cargar_info()

    # Benchmarks
    rets_spy = None
    rets_naftrac = None
    if "SPY" in df_precios.columns:
        rets_spy = _retornos_mensuales(df_precios["SPY"])
    if "NAFTRAC.MX" in df_precios.columns:
        rets_naftrac = _retornos_mensuales(df_precios["NAFTRAC.MX"])

    if rets_spy is None and rets_naftrac is None:
        return {"ok": False, "error": "Benchmarks (SPY/NAFTRAC.MX) no disponibles"}

    # Construir candidatos: solo acciones individuales con historia
    candidatos = []
    for t in df_precios.columns:
        info = info_all.get(t, {})
        if not _es_candidato(t, info):
            continue
        candidatos.append((t, info))

    if not candidatos:
        return {"ok": False, "error": "No hay candidatos en el universo"}

    # Puntuar todos
    puntuados: List[Tuple[int, Dict[str, Any]]] = []
    for ticker, info in candidatos:
        res = _puntuar(ticker, df_precios, info, rets_spy, rets_naftrac)
        if res is not None:
            puntuados.append(res)

    if not puntuados:
        return {"ok": False, "error": "Ningún candidato pudo ser puntuado"}

    # Top scorer
    puntuados.sort(key=lambda x: x[0], reverse=True)
    score, mejor = puntuados[0]

    # Veredicto narrativo
    if score >= 60:
        nivel = "Recomendación fuerte"
        nivel_color = "green"
    elif score >= 40:
        nivel = "Recomendación moderada"
        nivel_color = "blue"
    elif score >= 25:
        nivel = "Mención honorífica"
        nivel_color = "amber"
    else:
        nivel = "Sin ganador claro hoy"
        nivel_color = "zinc"

    # Top 5 para ver el ranking
    top_5 = [d for _, d in puntuados[:5]]

    data = {
        "ok":             True,
        "fecha":          time.strftime("%Y-%m-%d"),
        "actualizado_ts": int(time.time()),
        "accion":         mejor,
        "nivel":          nivel,
        "nivel_color":    nivel_color,
        "score":          score,
        "score_max":      100,
        "candidatos_evaluados": len(puntuados),
        "top_5":          top_5,
        "metodologia": (
            "Score compuesto: Alpha SML (CAPM, hasta 30 pts) + Calidad fundamental "
            "(PE, ROE, margen, deuda, dividendo) + Momentum 3m + Liquidez. "
            "Excluye ETFs, fondos, índices y criptomonedas. Se rota cada 24h."
        ),
        "disclaimer": (
            "Esta es una sugerencia generada por un modelo cuantitativo automatizado, "
            "no asesoría financiera personalizada. Haz tu propio análisis antes de invertir."
        ),
    }

    ts = time.time()
    _CACHE["hoy"] = {"ts": ts, "data": data}
    try:
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass

    return data
