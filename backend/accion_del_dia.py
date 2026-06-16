"""
accion_del_dia.py — Selecciona "La acción del día".

Usa exclusivamente metricas_canonicas para que Beta/Alpha/Sharpe/Score
coincidan EXACTAMENTE con lo que el usuario ve en Analizar/SML/Deep Dive.

Pipeline:
  1. Cargar universo local (CSV de precios + JSON de info)
  2. Filtrar candidatos (no ETFs, no crypto, no índices)
  3. Para cada candidato: calcular bundle canónico de métricas + score
  4. Devolver el de mayor score, con razones y top 5
  5. Cache 24h en memoria y disco
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

import metricas_canonicas as MC


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
# Info del universo. Preferimos el archivo completo (dev) y caemos al lite, que
# es lo ÚNICO que se despliega en prod. El viejo info_activos.json era un stub
# de 3 tickers SIN el flag 'recomendada' ni 'sector' -> rompía todo el filtrado.
_INFO_FULL = _BACKEND_DIR / "universo_info.json"
_INFO_LITE = _BACKEND_DIR / "universo_lite_info.json"
_INFO_STUB = _BACKEND_DIR / "info_activos.json"

# Cache en memoria del DataFrame de precios (evita releer ~59MB en cada llamada;
# lo comparten Acción del Día y Portafolio Óptimo). Invalidado por mtime.
_PRECIOS_CACHE: Dict[str, Any] = {}

_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 24 * 60 * 60   # 24 horas
_CACHE_DIR = _BACKEND_DIR / "_cache_accion_dia"
_CACHE_DIR.mkdir(exist_ok=True)


# ─────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────
def _cargar_precios() -> Optional[pd.DataFrame]:
    csv = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
    if not csv.exists():
        return None
    try:
        mtime = csv.stat().st_mtime
        c = _PRECIOS_CACHE.get("df")
        if c is not None and c["path"] == str(csv) and c["mtime"] == mtime:
            return c["df"]
        df = pd.read_csv(csv, index_col=0, parse_dates=True).sort_index()
        _PRECIOS_CACHE["df"] = {"df": df, "mtime": mtime, "path": str(csv)}
        return df
    except Exception:
        return None


def _cargar_info() -> Dict[str, Any]:
    for p in (_INFO_FULL, _INFO_LITE, _INFO_STUB):
        if p.exists():
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                continue
    return {}


def _es_candidato(ticker: str, info: Dict[str, Any]) -> bool:
    """Filtra ETFs, fondos, crypto, índices."""
    t = ticker.upper()
    if MC.es_crypto(t):
        return False
    tipo = (info.get("tipo") or info.get("quoteType") or "").upper()
    if tipo in ("ETF", "MUTUALFUND", "INDEX", "FUTURE", "CRYPTOCURRENCY"):
        return False
    # El universo lite marca ETFs/índices en 'sector' (p.ej. "ETF / Índice"),
    # no en 'tipo'. Acción del Día debe ser una ACCIÓN, así que los excluimos.
    sector = (info.get("sector") or "").upper()
    if "ETF" in sector or "INDICE" in sector or "ÍNDICE" in sector:
        return False
    nombre = (info.get("nombre") or "").upper()
    if any(k in nombre for k in ("ETF", "FUND", "TRUST", "INDEX")):
        return False
    return True


def _fundamentales_de_info(info: Dict[str, Any]) -> Dict[str, Any]:
    """Extrae fundamentales en formato esperado por MC.score_compuesto."""
    return {
        "pe":             info.get("pe") or info.get("trailingPE") or info.get("forwardPE"),
        "roe":            info.get("roe") or info.get("returnOnEquity"),
        "margen_neto":    info.get("margen_neto") or info.get("profitMargins"),
        "debt_equity":    info.get("debt_equity") or info.get("debtToEquity"),
        "dividend_yield": info.get("dividend_yield") or info.get("dividendYield"),
    }


def _liquidez_diaria(info: Dict[str, Any], precio_actual: Optional[float]) -> float:
    vol = (info.get("averageVolume") or
           info.get("average_volume") or
           info.get("volumen_promedio") or 0)
    if vol and precio_actual:
        return float(vol) * float(precio_actual)
    return float(info.get("market_cap") or info.get("marketCap") or 0)


def calcular_metricas_y_score(
    ticker: str,
    df_precios: pd.DataFrame,
    info_all: Dict[str, Any],
    serie_mercado_us: Optional[pd.Series],
    serie_mercado_mx: Optional[pd.Series],
) -> Optional[Tuple[int, Dict[str, Any]]]:
    """Calcula métricas canónicas + score para UN ticker.

    Esta función es PÚBLICA porque otras vistas (Analizar, Deep Dive) la
    pueden llamar para obtener el mismo score que se mostró en Acción del Día.
    """
    if ticker not in df_precios.columns:
        return None
    serie = df_precios[ticker]

    es_mx = ticker.upper().endswith(".MX")
    serie_mkt = serie_mercado_mx if es_mx else serie_mercado_us
    if serie_mkt is None:
        return None

    metricas = MC.calcular_metricas(ticker, serie, serie_mkt)
    if metricas is None:
        return None

    info = info_all.get(ticker, {})
    fund = _fundamentales_de_info(info)
    precio_actual = float(serie.dropna().iloc[-1]) if len(serie.dropna()) else None
    liquidez = _liquidez_diaria(info, precio_actual)

    score, razones = MC.score_compuesto(metricas, fund, liquidez)

    # Normalizar fundamentales para mostrar
    fund_norm = dict(fund)
    for k in ("roe", "margen_neto", "dividend_yield"):
        if fund_norm.get(k) is not None and fund_norm[k] > 1:
            fund_norm[k] = fund_norm[k] / 100
    if fund_norm.get("debt_equity") is not None and fund_norm["debt_equity"] > 10:
        fund_norm["debt_equity"] = fund_norm["debt_equity"] / 100

    detalles = {
        # Identidad
        "ticker":     ticker,
        "nombre":     info.get("nombre") or ticker,
        "sector":     info.get("sector"),
        "industria":  info.get("industria") or info.get("industry"),
        "moneda":     metricas["moneda"],
        "es_mx":      es_mx,
        "precio":     round(precio_actual, 2) if precio_actual else None,

        # Métricas canónicas (mismas en TODAS las vistas)
        "beta":                  metricas["beta"],
        "alpha_anualizado":      metricas["alpha_anualizado"],
        "retorno_real_anual":    metricas["retorno_real_anual"],
        "retorno_esperado_capm": metricas["retorno_esperado_capm"],
        "volatilidad_anual":     metricas["volatilidad_anual"],
        "sharpe":                metricas["sharpe"],
        "momentum_3m":           metricas["momentum_3m"],
        "n_observaciones":       metricas["n_observaciones_beta"],
        "benchmark":             metricas["benchmark"],
        "tasa_libre_riesgo":     metricas["tasa_libre_riesgo"],
        "premio_mercado":        metricas["premio_mercado"],

        # Fundamentales
        "pe":             round(fund_norm["pe"], 2) if fund_norm.get("pe") else None,
        "roe":            round(fund_norm["roe"], 4) if fund_norm.get("roe") is not None else None,
        "margen_neto":    round(fund_norm["margen_neto"], 4) if fund_norm.get("margen_neto") is not None else None,
        "debt_equity":    round(fund_norm["debt_equity"], 2) if fund_norm.get("debt_equity") is not None else None,
        "dividend_yield": round(fund_norm["dividend_yield"], 4) if fund_norm.get("dividend_yield") else None,

        # Score
        "score":   score,
        "razones": razones,

        # Liquidez
        "valor_transado_dia": round(liquidez, 0) if liquidez else None,
    }
    return score, detalles


def score_para_ticker(ticker: str) -> Optional[Dict[str, Any]]:
    """Helper público: calcula score canónico para UN ticker arbitrario.

    Lo usa Analizar para mostrar el MISMO score que vió el usuario en
    Acción del Día, sin tener que recorrer todo el universo.
    """
    df = _cargar_precios()
    if df is None:
        return None
    info_all = _cargar_info()
    serie_us = df["SPY"] if "SPY" in df.columns else None
    serie_mx = df["NAFTRAC.MX"] if "NAFTRAC.MX" in df.columns else None
    res = calcular_metricas_y_score(ticker, df, info_all, serie_us, serie_mx)
    if res is None:
        return None
    _, detalles = res
    return detalles


# ─────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────
def accion_del_dia(forzar: bool = False) -> Dict[str, Any]:
    """Selecciona la acción del día. Cache 24h."""
    cached = _CACHE.get("hoy")
    if not forzar and cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]

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
    serie_us = df_precios["SPY"] if "SPY" in df_precios.columns else None
    serie_mx = df_precios["NAFTRAC.MX"] if "NAFTRAC.MX" in df_precios.columns else None
    if serie_us is None and serie_mx is None:
        return {"ok": False, "error": "Benchmarks (SPY/NAFTRAC.MX) no disponibles"}

    # Pool acotado: solo tickers 'recomendada' (set curado de ~120). Antes se
    # recorrían los ~1000 del universo -> ~34s, reventaba el timeout del free
    # tier. Si el info no trae el flag (stub viejo), caemos al universo filtrado.
    hay_recomendadas = any(
        isinstance(v, dict) and v.get("recomendada") for v in info_all.values()
    )
    candidatos = []
    for t in df_precios.columns:
        info = info_all.get(t, {})
        if not _es_candidato(t, info):
            continue
        if hay_recomendadas and not info.get("recomendada"):
            continue
        candidatos.append(t)

    if not candidatos:
        return {"ok": False, "error": "No hay candidatos en el universo"}

    puntuados: List[Tuple[int, Dict[str, Any]]] = []
    for ticker in candidatos:
        res = calcular_metricas_y_score(ticker, df_precios, info_all, serie_us, serie_mx)
        if res is not None:
            puntuados.append(res)

    if not puntuados:
        return {"ok": False, "error": "Ningún candidato pudo ser puntuado"}

    puntuados.sort(key=lambda x: x[0], reverse=True)
    score, mejor = puntuados[0]
    nivel, nivel_color = MC.nivel_para_score(score)

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
        "top_5":          [d for _, d in puntuados[:5]],
        "metodologia": (
            "Score canónico (0-100): Alpha SML/CAPM (hasta 30 pts) + Sharpe (10) + "
            "Fundamentales — PE, ROE, margen, deuda, dividendo (hasta 56 pts) + "
            "Momentum 3m (10) + Liquidez (5). Beta y alpha calculados con la "
            "metodología estándar académica: 5 años de retornos mensuales vs SPY "
            "(o NAFTRAC.MX para acciones .MX). El mismo cálculo se usa en TODAS "
            "las vistas — la beta que ves aquí es la misma de Analizar."
        ),
        "disclaimer": (
            "Sugerencia algorítmica automatizada, no asesoría financiera. "
            "Haz tu propio análisis antes de invertir."
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
