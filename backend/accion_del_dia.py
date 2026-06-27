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


# Cache del mapa de fundamentales de Neon (1 sola query, refrescado por día CDMX).
# Lo llena el prewarm (actualizar_mx_backup.py). Es la fuente que hace que el
# score de las US/MX funcione aunque Yahoo bloquee los fundamentales desde el
# server (el JSON del universo casi no los trae).
_FUND_NEON_CACHE: Dict[str, Any] = {}


def _fund_neon_map() -> Dict[str, Dict[str, Any]]:
    """{TICKER: fundamentales} desde el caché de Neon. Cache por día CDMX para no
    consultar la BD en cada cálculo (después de la 1ª vez es un lookup en dict)."""
    hoy = _fecha_cdmx()
    c = _FUND_NEON_CACHE.get("map")
    if c and c.get("fecha") == hoy:
        return c["data"]
    out: Dict[str, Dict[str, Any]] = {}
    try:
        import data_fallback as _fb
        for tk, fund in (_fb.listar_cache_todos() or {}).items():
            if isinstance(fund, dict) and fund.get("ok"):
                out[str(tk).upper()] = fund
    except Exception:
        pass
    _FUND_NEON_CACHE["map"] = {"fecha": hoy, "data": out}
    return out


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


def _fundamentales_de_info(
    info: Dict[str, Any],
    fund_neon: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Extrae fundamentales en formato esperado por MC.score_compuesto.

    Prefiere el JSON del universo y, si falta algún dato, cae al caché de Neon
    (lo llena el prewarm; cubre US y MX que el universo no trae por el bloqueo
    de Yahoo desde el server)."""
    pe  = info.get("pe") or info.get("trailingPE") or info.get("forwardPE")
    roe = info.get("roe") if info.get("roe") is not None else info.get("returnOnEquity")
    margen = info.get("margen_neto") if info.get("margen_neto") is not None else info.get("profitMargins")
    de  = info.get("debt_equity") if info.get("debt_equity") is not None else info.get("debtToEquity")
    dy  = info.get("dividend_yield") if info.get("dividend_yield") is not None else info.get("dividendYield")

    fn = fund_neon or {}
    if fn:
        if pe is None:     pe = fn.get("pe_trailing") or fn.get("pe_forward")
        if roe is None:    roe = fn.get("roe")
        if margen is None: margen = (fn.get("margenes") or {}).get("neto")
        if de is None:     de = fn.get("debt_to_equity")
        if dy is None:     dy = fn.get("dividend_yield")

    return {
        "pe":             pe,
        "roe":            roe,
        "margen_neto":    margen,
        "debt_equity":    de,
        "dividend_yield": dy,
    }


def _liquidez_diaria(info: Dict[str, Any], precio_actual: Optional[float]) -> float:
    vol = (info.get("averageVolume") or
           info.get("average_volume") or
           info.get("volumen_promedio") or 0)
    if vol and precio_actual:
        return float(vol) * float(precio_actual)
    return float(info.get("market_cap") or info.get("marketCap") or 0)


# Sectores en crecimiento que el usuario quiere "descubrir"
_SECTORES_CRECIMIENTO = ("tech", "tecnolog", "energy", "energ", "semiconduct",
                         "software", "communication", "comunicac", "renewable",
                         "clean", "bio", "health")

# Mega-caps archiconocidas: la feature es para DESCUBRIR, no repetir Google/GMéxico.
_ARCHICONOCIDAS = {
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "NFLX",
    "JPM", "V", "MA", "WMT", "JNJ", "PG", "KO", "DIS", "BAC",
    "WALMEX.MX", "AMXB.MX", "GMEXICOB.MX", "FEMSAUBD.MX", "GFNORTEO.MX", "GCARSOA1.MX",
}


def _ajuste_descubrimiento(det: Dict[str, Any], info: Dict[str, Any]) -> float:
    """Sesga Acción del Día hacia acciones chicas/emergentes en sectores en
    crecimiento, y castiga las mega-caps archiconocidas. NO cambia el score que
    se muestra (ese sigue siendo el canónico), solo a QUIÉN se elige como ganador."""
    aj = 0.0
    tk = (det.get("ticker") or "").upper()
    if tk in _ARCHICONOCIDAS:
        aj -= 20

    mc = info.get("market_cap") or info.get("marketCap")
    if mc:
        try:
            mc = float(mc)
            if det.get("es_mx"):
                mc /= 18.0   # MXN→USD aprox para comparar magnitudes
            if mc > 200e9:     aj -= 16   # gigante archiconocida
            elif mc > 50e9:    aj -= 8
            elif mc > 15e9:    aj -= 3
            elif mc >= 500e6:  aj += 8    # small/mid: el sweet spot emergente
            else:              aj -= 4    # micro: demasiado ilíquida/especulativa
        except (TypeError, ValueError):
            pass

    sector = (det.get("sector") or "").lower()
    if any(s in sector for s in _SECTORES_CRECIMIENTO):
        aj += 6

    mom = det.get("momentum_3m") or 0
    if 0.05 <= mom <= 0.40:
        aj += 4   # subiendo con fuerza sana → potencial real
    return aj


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
    fund_neon = _fund_neon_map().get(ticker.upper())
    fund = _fundamentales_de_info(info, fund_neon)
    precio_actual = float(serie.dropna().iloc[-1]) if len(serie.dropna()) else None
    liquidez = _liquidez_diaria(info, precio_actual)
    market_cap = info.get("market_cap") or info.get("marketCap")
    if market_cap is None and fund_neon:
        market_cap = fund_neon.get("market_cap")
    if not liquidez and market_cap:
        try:
            liquidez = float(market_cap)
        except (TypeError, ValueError):
            pass

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
        "market_cap": market_cap,

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
    # Pool de emergentes (lo refresca semanalmente descubrir_emergentes.py).
    # Estas entran como candidatas AUNQUE no estén marcadas 'recomendada'.
    pool_emergentes = set()
    try:
        import data_fallback as _fb
        _pe = _fb.leer_cache("__POOL_EMERGENTES__")
        if _pe and _pe.get("tickers"):
            pool_emergentes = {str(t).upper() for t in _pe["tickers"]}
    except Exception:
        pass

    candidatos = []
    for t in df_precios.columns:
        info = info_all.get(t, {})
        if not _es_candidato(t, info):
            continue
        en_pool = t.upper() in pool_emergentes
        if hay_recomendadas and not info.get("recomendada") and not en_pool:
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
        rank = (score_t
                + max(-5.0, min(5.0, rec5 * 100 * 0.5))           # desempeño reciente
                + _ajuste_descubrimiento(det, info_all.get(ticker, {})))  # sesgo emergentes
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

    # Enriquecer la acción ganadora con fundamentales en vivo (P/E, ROE, margen)
    # si el universo aún no los trae. Se cachea junto con el resto del día.
    try:
        import fundamentals as _f
        ft = _f._fundamentals_ticker(mejor.get("ticker", ""))
        if isinstance(ft, dict):
            if mejor.get("pe") is None and ft.get("pe_trailing") is not None:
                mejor["pe"] = ft["pe_trailing"]
            if mejor.get("roe") is None and ft.get("roe") is not None:
                mejor["roe"] = ft["roe"]
            if mejor.get("margen_neto") is None and ft.get("margen_neto") is not None:
                mejor["margen_neto"] = ft["margen_neto"]
    except Exception:
        pass

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
            "Pensada para DESCUBRIR: se elige por score canónico (alpha CAPM, "
            "Sharpe, fundamentales, momentum) pero favoreciendo acciones chicas/"
            "medianas en sectores en crecimiento (tecnología, energía…) y dejando "
            "fuera a las mega-caps que ya todos conocen. El score mostrado es el "
            "mismo que verás en Analizar."
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
            # Fundamentales (merge universo + caché Neon) para el screener:
            "pe":             det.get("pe"),
            "dividend_yield": det.get("dividend_yield"),
            "market_cap":     det.get("market_cap"),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    _RANKING_CACHE[ck] = {"fecha": hoy, "data": out}
    return out[:n]
