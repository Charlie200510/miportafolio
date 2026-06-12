# ============================================================
#  MI PORTAFOLIO - Análisis dinámico con tickers arbitrarios
# ============================================================
#  Flujo:
#    1. Usuario envía lista de tickers al endpoint /api/analizar
#    2. Descargamos (o leemos del cache) precios históricos de
#       cada ticker + ambos benchmarks (^GSPC, ^MXX)
#    3. Descargamos metadata (sector/pais/moneda) por ticker
#    4. Corremos analizar_portafolio_desde_df() y devolvemos el JSON
#
#  Cache:
#    - Un CSV por ticker en cache_precios/
#    - Se considera válido si se actualizó hace <24h
#    - Evita re-descargar para cada request y acelera mucho el flujo
# ============================================================
import json
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable

import pandas as pd
import yfinance as yf

from analisis import (
    analizar_portafolio_desde_df,
    BENCHMARKS_POSIBLES,
)
from insights import generar_insights

BACKEND_DIR = Path(__file__).parent
CACHE_DIR = BACKEND_DIR / "cache_precios"
CACHE_INFO = BACKEND_DIR / "cache_info.json"
CACHE_DIR.mkdir(exist_ok=True)

# TTL del cache de precios: re-descarga si el archivo tiene más de 24h
CACHE_TTL_SEGUNDOS = 24 * 60 * 60
DIAS_HISTORIA = 730

# Límites del portafolio
MIN_TICKERS = 2
MAX_TICKERS = 20


# ------------------------------------------------------------
# Cache de metadata (info por ticker)
# ------------------------------------------------------------
def _leer_info_cache() -> dict:
    if CACHE_INFO.exists():
        try:
            with open(CACHE_INFO, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _escribir_info_cache(info: dict):
    try:
        with open(CACHE_INFO, "w", encoding="utf-8") as f:
            json.dump(info, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


# ------------------------------------------------------------
# Cache de precios por ticker
# ------------------------------------------------------------
def _cache_precios_path(ticker: str) -> Path:
    # Sanitizamos para nombre de archivo
    safe = ticker.replace("/", "_").replace("\\", "_")
    return CACHE_DIR / f"{safe}.csv"


def _cache_vigente(ruta: Path) -> bool:
    if not ruta.exists():
        return False
    edad = time.time() - ruta.stat().st_mtime
    return edad < CACHE_TTL_SEGUNDOS


def _leer_precios_cache(ticker: str) -> pd.Series | None:
    ruta = _cache_precios_path(ticker)
    if not _cache_vigente(ruta):
        return None
    try:
        s = pd.read_csv(ruta, index_col=0, parse_dates=True).iloc[:, 0]
        s.name = ticker
        return s
    except Exception:
        return None


def _guardar_precios_cache(ticker: str, serie: pd.Series):
    try:
        serie.to_frame(name=ticker).to_csv(_cache_precios_path(ticker))
    except Exception:
        pass


# ------------------------------------------------------------
# Descarga de precios + metadata
# ------------------------------------------------------------
def _descargar_precios(tickers: list[str]) -> pd.DataFrame:
    """
    Para cada ticker intenta cache; si no hay o venció, baja de Yahoo.
    Devuelve un DataFrame alineado por fechas, ffill+dropna.
    """
    fecha_fin = date.today()
    fecha_ini = fecha_fin - timedelta(days=DIAS_HISTORIA)

    series_por_ticker = {}
    descargar = []

    for t in tickers:
        cacheado = _leer_precios_cache(t)
        if cacheado is not None:
            series_por_ticker[t] = cacheado
        else:
            descargar.append(t)

    if descargar:
        datos = yf.download(
            tickers=descargar,
            start=fecha_ini.strftime("%Y-%m-%d"),
            end=fecha_fin.strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
            threads=True,
        )
        if "Close" not in datos.columns.get_level_values(0):
            raise RuntimeError("Yahoo no devolvió precios Close")
        close = datos["Close"]
        # Si era un solo ticker, yf devuelve DataFrame de una columna
        if isinstance(close, pd.Series):
            close = close.to_frame(name=descargar[0])
        for t in descargar:
            if t in close.columns:
                s = close[t].dropna()
                if len(s) >= 60:  # mínimo ~3 meses de historia
                    series_por_ticker[t] = s
                    _guardar_precios_cache(t, s)

    if not series_por_ticker:
        raise ValueError("Ningún ticker devolvió precios válidos")

    df = pd.concat(series_por_ticker.values(), axis=1, keys=series_por_ticker.keys())
    df = df.ffill().dropna()
    return df


def _descargar_info(tickers: Iterable[str], cache: dict) -> dict:
    """
    Actualiza cache de info para tickers que no están cacheados.
    Devuelve el sub-dict solo con los tickers pedidos.
    """
    faltantes = [t for t in tickers if t not in cache]
    for t in faltantes:
        try:
            i = yf.Ticker(t).info
            cache[t] = {
                "nombre":    i.get("longName") or i.get("shortName") or t,
                "sector":    i.get("sector") or "Desconocido",
                "industria": i.get("industry") or "Desconocido",
                "pais":      i.get("country") or "Desconocido",
                "moneda":    i.get("currency") or "Desconocido",
            }
        except Exception:
            cache[t] = {
                "nombre": t, "sector": "Desconocido",
                "industria": "Desconocido", "pais": "Desconocido",
                "moneda": "Desconocido",
            }
    return {t: cache[t] for t in tickers if t in cache}


# ------------------------------------------------------------
# Endpoint lógico: analizar portafolio dinámico
# ------------------------------------------------------------
def analizar(tickers: list[str], pesos: dict | None = None) -> dict:
    """
    Analiza un portafolio arbitrario definido por el usuario.
    Descarga precios (con cache) y corre el análisis completo.
    """
    # Validaciones
    tickers = [t.strip().upper() for t in tickers if t and t.strip()]
    if len(tickers) < MIN_TICKERS:
        raise ValueError(f"Necesitas al menos {MIN_TICKERS} acciones")
    if len(tickers) > MAX_TICKERS:
        raise ValueError(f"Máximo {MAX_TICKERS} acciones por portafolio")
    if len(set(tickers)) != len(tickers):
        raise ValueError("Hay acciones duplicadas en tu selección")

    # Descargamos activos del usuario + ambos benchmarks posibles
    tickers_a_descargar = tickers + list(BENCHMARKS_POSIBLES)
    try:
        precios_df = _descargar_precios(tickers_a_descargar)
    except Exception as e:
        raise RuntimeError(f"Fallo al descargar precios: {e}") from e

    # Tickers que sí quedaron en el DF (algunos pueden haber fallado)
    presentes = [t for t in tickers if t in precios_df.columns]
    if len(presentes) < MIN_TICKERS:
        faltantes = [t for t in tickers if t not in presentes]
        raise ValueError(
            f"No encontré suficiente historia para: {faltantes}. "
            "Verifica los tickers."
        )

    # Metadata con cache persistente
    info_cache = _leer_info_cache()
    info = _descargar_info(presentes, info_cache)
    # Persistimos el cache actualizado (incluye nuevos tickers aprendidos)
    _escribir_info_cache(info_cache)

    # Normalizamos pesos si vienen incompletos
    if pesos:
        pesos = {t: float(pesos[t]) for t in presentes if t in pesos}

    # Análisis completo (reutiliza la lógica de analisis.py)
    resultado = analizar_portafolio_desde_df(precios_df, info, pesos)

    # El frontend usa data.info_activos para mostrar nombre/sector.
    # Lo garantizamos embebido aunque analisis.py no lo incluya.
    if "info_activos" not in resultado:
        resultado["info_activos"] = info

    # Narrative hooks para la UI (y para la IA en pasos posteriores).
    resultado["insights"] = generar_insights(resultado)
    return resultado


# ------------------------------------------------------------
# Búsqueda de tickers (Yahoo Finance search endpoint)
# ------------------------------------------------------------
# Endpoint no-oficial pero estable que Yahoo usa en su propio sitio.
# Limitamos a 10 resultados y filtramos a equities/indexes.
_YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"


def buscar_ticker(query: str, limite: int = 10) -> list[dict]:
    """
    Busca tickers por nombre o símbolo usando Yahoo Finance.
    Devuelve una lista acotada con {ticker, nombre, tipo, exchange}.
    """
    import requests  # import perezoso, requests es opcional

    q = (query or "").strip()
    if len(q) < 2:
        return []

    params = {
        "q": q,
        "lang": "en-US",
        "region": "US",
        "quotesCount": limite,
        "newsCount": 0,
    }
    headers = {"User-Agent": "Mozilla/5.0"}

    try:
        r = requests.get(_YAHOO_SEARCH_URL, params=params, headers=headers, timeout=5)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        raise RuntimeError(f"Búsqueda de Yahoo falló: {e}") from e

    resultados = []
    for q in (data.get("quotes") or [])[:limite]:
        tipo = (q.get("quoteType") or "").upper()
        # Nos quedamos solo con acciones, ETFs e índices
        if tipo not in ("EQUITY", "ETF", "INDEX"):
            continue
        ticker = q.get("symbol")
        if not ticker:
            continue
        resultados.append({
            "ticker":   ticker,
            "nombre":   q.get("shortname") or q.get("longname") or ticker,
            "tipo":     tipo.lower(),
            "exchange": q.get("exchange") or "",
        })
    return resultados
