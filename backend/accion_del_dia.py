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
from datetime import datetime, timedelta
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
def _fecha_cdmx() -> str:
    """Fecha de hoy en CDMX (UTC-6, sin horario de verano desde 2022)."""
    return (datetime.utcnow() - timedelta(hours=6)).strftime("%Y-%m-%d")


def accion_del_dia(forzar: bool = False) -> Dict[str, Any]:
    """Selecciona la acción del día. Cambia a la medianoche de CDMX.

    Para que varíe día a día y no repita el mismo ticker dos días seguidos
    (salvo que domine claramente), el ranking combina el score canónico con un
    pequeño ajuste por desempeño reciente (últimos 5 días hábiles).
    """
    hoy = _fecha_cdmx()

    # Cache válido SOLO si es del mismo día CDMX → cambia a medianoche.
    cached = _CACHE.get("hoy")
    if not forzar and cached and cached.get("data", {}).get("fecha") == hoy:
        return cached["data"]

    disk_path = _CACHE_DIR / "hoy.json"
    previo_ticker = None
    if disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                d = json.load(f)
            prev_data = d.get("data", {})
            previo_ticker = (prev_data.get("accion") or {}).get("ticker")
            if not forzar and prev_data.get("fecha") == hoy:
                _CACHE["hoy"] = {"ts": d.get("_ts", 0), "data": prev_data}
                return prev_data
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

    # (rank, score, detalles). rank = score + ajuste por momentum reciente (±5 pts).
    puntuados: List[Tuple[float, int, Dict[str, Any]]] = []
    for ticker in candidatos:
        res = calcular_metricas_y_score(ticker, df_precios, info_all, serie_us, serie_mx)
        if res is None:
            continue
        score_t, det = res
        serie = df_precios[ticker].dropna()
        rec5 = float(serie.iloc[-1] / serie.iloc[-6] - 1) if len(serie) >= 6 else 0.0
        det["retorno_5d_pct"] = round(rec5 * 100, 2)
        rank = score_t + max(-5.0, min(5.0, rec5 * 100 * 0.5))
        puntuados.append((rank, score_t, det))

    if not puntuados:
        return {"ok": False, "error": "Ningún candidato pudo ser puntuado"}

    puntuados.sort(key=lambda x: x[0], reverse=True)

    # Anti-repetición: no repetir el ticker de ayer salvo que domine (margen ≥ 6).
    rank0, score, mejor = puntuados[0]
    if previo_ticker and mejor.get("ticker") == previo_ticker and len(puntuados) > 1:
        rank1, score1, segundo = puntuados[1]
        if (rank0 - rank1) < 6.0:
            score, mejor = score1, segundo

    nivel, nivel_color = MC.nivel_para_score(score)

    data = {
        "ok":             True,
        "fecha":          hoy,
        "actualizado_ts": int(time.time()),
        "accion":         mejor,
        "nivel":          nivel,
        "nivel_color":    nivel_color,
        "score":          score,
        "score_max":      100,
        "candidatos_evaluados": len(puntuados),
        "top_5":          [d for _, _, d in puntuados[:5]],
        "metodologia": (
            "Elegida por score canónico (alpha CAPM, Sharpe, fundamentales, "
            "momentum y liquidez), con un ajuste por desempeño reciente para que "
            "varíe día a día."
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


_RANKING_CACHE: Dict[str, Any] = {}
def ranking(n: int = 60, solo_recomendadas: bool = True) -> List[Dict[str, Any]]:
    """Universo rankeado por score canónico (mayor a menor). Cache por día CDMX.
    solo_recomendadas=True → set curado (~120, rápido, para Acción del Día/Analizar).
    solo_recomendadas=False → universo EXTENDIDO (todas las acciones con precios)."""
    hoy = _fecha_cdmx()
    ck = "r_rec" if solo_recomendadas else "r_all"
    c = _RANKING_CACHE.get(ck)
    if c and c.get("fecha") == hoy:
        return c["data"][:n]
    df = _cargar_precios()
    if df is None or df.empty:
        return []
    info_all = _cargar_info()
    serie_us = df["SPY"] if "SPY" in df.columns else None
    serie_mx = df["NAFTRAC.MX"] if "NAFTRAC.MX" in df.columns else None
    hay_rec = any(isinstance(v, dict) and v.get("recomendada") for v in info_all.values())
    out = []
    for t in df.columns:
        info = info_all.get(t, {})
        if not _es_candidato(t, info):
            continue
        if solo_recomendadas and hay_rec and not info.get("recomendada"):
            continue
        res = calcular_metricas_y_score(t, df, info_all, serie_us, serie_mx)
        if res is None:
            continue
        score, det = res
        out.append({
            "ticker":  det["ticker"], "nombre": det.get("nombre"), "sector": det.get("sector"),
            "score":   score, "beta": det.get("beta"), "sharpe": det.get("sharpe"),
            "alpha_anualizado": det.get("alpha_anualizado"), "precio": det.get("precio"),
            "es_mx":   det.get("es_mx"),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    _RANKING_CACHE[ck] = {"fecha": hoy, "data": out}
    return out[:n]
