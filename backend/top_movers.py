"""
top_movers.py — Top tickers del universo por ganadores, perdedores y volumen.

Lee el universo local (~1000 tickers) y calcula:
  - Top N que más subieron en el período (día / semana / mes)
  - Top N que más cayeron
  - Top N más activos por volumen

Usa el CSV de precios local (universo_lite_precios.csv) — sin yfinance,
para que sea rápido.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
_INFO_PATH = _BACKEND_DIR / "info_activos.json"

# Cache simple en memoria (15 min)
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 15 * 60


def _cargar_precios() -> Optional[pd.DataFrame]:
    """Carga el universo local de precios."""
    csv = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
    if not csv.exists():
        return None
    try:
        df = pd.read_csv(csv, index_col=0, parse_dates=True)
        return df.sort_index()
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


def _calcular_retornos(df: pd.DataFrame, dias: int) -> pd.Series:
    """Retorno desde hace N días al hoy, por ticker."""
    if df is None or df.empty:
        return pd.Series(dtype=float)
    if len(df) < dias + 1:
        # Si no hay tanto historial, usa el primer día disponible
        primer = df.iloc[0]
    else:
        primer = df.iloc[-dias - 1]
    ultimo = df.iloc[-1]
    ret = (ultimo - primer) / primer
    return ret.dropna().sort_values(ascending=False)


def top_movers(periodo: str = "dia", n: int = 3) -> Dict[str, Any]:
    """Calcula top tickers por período.

    periodo: 'dia' (1d), 'semana' (5d), 'mes' (21d)
    n: cuántos en cada categoría
    """
    cache_key = f"{periodo}_{n}"
    cached = _CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]

    dias_map = {"dia": 1, "semana": 5, "mes": 21}
    dias = dias_map.get(periodo, 1)

    df = _cargar_precios()
    if df is None or df.empty:
        return {"ok": False, "error": "No hay datos del universo cargados"}

    info_all = _cargar_info()

    retornos = _calcular_retornos(df, dias)
    if retornos.empty:
        return {"ok": False, "error": "No se pudieron calcular retornos"}

    def _enriquecer(ticker: str, retorno: float) -> Dict[str, Any]:
        info = info_all.get(ticker, {})
        precio_actual = df[ticker].iloc[-1] if ticker in df.columns else None
        return {
            "ticker":      ticker,
            "nombre":      info.get("nombre") or ticker,
            "sector":      info.get("sector"),
            "precio":      round(float(precio_actual), 2) if precio_actual is not None else None,
            "retorno_pct": round(float(retorno) * 100, 2),
            "moneda":      info.get("moneda", "USD"),
            "es_mx":       ticker.upper().endswith(".MX"),
            "es_crypto":   ticker.upper().endswith("-USD"),
        }

    # Top N ganadores (más subieron)
    ganadores = [_enriquecer(t, r) for t, r in retornos.head(n).items()]
    # Top N perdedores (más cayeron)
    perdedores = [_enriquecer(t, r) for t, r in retornos.tail(n).iloc[::-1].items()]
    # Top N "populares" — proxy: las acciones con mayor market cap del universo
    populares = []
    populares_candidatos = [
        (t, info_all.get(t, {}).get("market_cap") or info_all.get(t, {}).get("marketCap") or 0)
        for t in df.columns if t in info_all
    ]
    populares_candidatos.sort(key=lambda x: x[1], reverse=True)
    for t, _ in populares_candidatos[:n]:
        if t in retornos.index:
            populares.append(_enriquecer(t, retornos[t]))

    data = {
        "ok":         True,
        "periodo":    periodo,
        "dias":       dias,
        "ganadores":  ganadores,
        "perdedores": perdedores,
        "populares":  populares,
        "fecha":      df.index[-1].strftime("%Y-%m-%d") if len(df) else None,
        "universo_size": len(df.columns),
    }
    _CACHE[cache_key] = {"ts": time.time(), "data": data}
    return data
