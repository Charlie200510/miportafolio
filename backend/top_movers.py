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

# Cache en memoria + disco (sobrevive reinicios de Render)
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 30 * 60   # 30 min (los movers cambian poco a poco)
_CACHE_DIR = _BACKEND_DIR / "_cache_topmovers"
_CACHE_DIR.mkdir(exist_ok=True)


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
    # Cache en memoria
    cached = _CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]
    # Cache en disco (sobrevive reinicios)
    disk_path = _CACHE_DIR / f"{cache_key}.json"
    if disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                d = json.load(f)
            if d and (time.time() - d.get("_ts", 0)) < _CACHE_TTL:
                _CACHE[cache_key] = {"ts": d["_ts"], "data": d["data"]}
                return d["data"]
        except Exception:
            pass

    dias_map = {"dia": 1, "semana": 5, "mes": 21, "anio": 252}
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
    # Top N "más activos" — proxy de transacciones = volumen promedio × precio
    # (valor transado diariamente). Fallback: market_cap si no hay volumen.
    activos = []
    activos_candidatos = []
    for t in df.columns:
        info_t = info_all.get(t, {})
        vol = (info_t.get("averageVolume") or
               info_t.get("average_volume") or
               info_t.get("volumen_promedio") or 0)
        precio_t = df[t].iloc[-1] if t in df.columns and not df[t].empty else None
        valor_transado = 0
        if vol and precio_t and not pd.isna(precio_t):
            valor_transado = float(vol) * float(precio_t)
        else:
            # Fallback: market cap como proxy de "popularidad"
            valor_transado = (info_t.get("market_cap") or
                              info_t.get("marketCap") or 0)
        activos_candidatos.append((t, valor_transado))
    activos_candidatos.sort(key=lambda x: x[1], reverse=True)
    for t, vt in activos_candidatos[:n]:
        if t in retornos.index:
            item = _enriquecer(t, retornos[t])
            item["valor_transado"] = round(vt, 0)
            activos.append(item)

    data = {
        "ok":         True,
        "periodo":    periodo,
        "dias":       dias,
        "ganadores":  ganadores,
        "perdedores": perdedores,
        "populares":  activos,   # alias backward-compat
        "activos":    activos,
        "fecha":      df.index[-1].strftime("%Y-%m-%d") if len(df) else None,
        "universo_size": len(df.columns),
    }
    ts = time.time()
    _CACHE[cache_key] = {"ts": ts, "data": data}
    # Persistir en disco
    try:
        disk_path = _CACHE_DIR / f"{cache_key}.json"
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass
    return data
