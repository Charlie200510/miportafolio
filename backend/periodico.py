# ============================================================
#  PERIÓDICO FINANCIERO
# ============================================================
#  Genera el feed del tab "Periódico":
#    - Cierres diarios de los índices principales (S&P 500, NASDAQ,
#      Dow, IPC, Russell 2000) con sparkline de 5 días
#    - Noticias top del día (mezcla USA + México)
#    - Noticias específicas de los tickers del portafolio del usuario
#
#  Diseño:
#    - Cache en memoria con TTL (5 min cierres, 10 min noticias)
#    - Si yfinance falla para un ticker, lo omitimos sin tirar todo
#    - CNBV-safe: reportamos hechos, NO hacemos recomendaciones
# ============================================================
from __future__ import annotations

import time
import threading
from datetime import date, timedelta

import yfinance as yf
import pandas as pd


# ------------------------------------------------------------
# Configuración
# ------------------------------------------------------------
# Índices principales. Usamos ETFs en vez de los símbolos de índice
# directos (^GSPC, ^IXIC, etc.) porque yfinance devuelve datos más
# consistentes y sparkline más granular con los ETFs.
INDICES = [
    {"ticker": "SPY",        "nombre": "S&P 500",        "etiqueta": "USA · grandes caps",     "moneda": "USD"},
    {"ticker": "QQQ",        "nombre": "NASDAQ-100",     "etiqueta": "USA · tecnología",       "moneda": "USD"},
    {"ticker": "DIA",        "nombre": "Dow Jones 30",   "etiqueta": "USA · industriales",     "moneda": "USD"},
    {"ticker": "IWM",        "nombre": "Russell 2000",   "etiqueta": "USA · small caps",       "moneda": "USD"},
    {"ticker": "NAFTRAC.MX", "nombre": "IPC México",     "etiqueta": "México · principales",   "moneda": "MXN"},
]

# Índices mundiales
INDICES_MUNDIALES = [
    {"ticker": "^GDAXI",    "nombre": "DAX",            "etiqueta": "Alemania",        "moneda": "EUR"},
    {"ticker": "^FTSE",     "nombre": "FTSE 100",       "etiqueta": "Reino Unido",     "moneda": "GBP"},
    {"ticker": "^N225",     "nombre": "Nikkei 225",     "etiqueta": "Japón",           "moneda": "JPY"},
    {"ticker": "^HSI",      "nombre": "Hang Seng",      "etiqueta": "Hong Kong",       "moneda": "HKD"},
    {"ticker": "^BVSP",     "nombre": "Bovespa",        "etiqueta": "Brasil",          "moneda": "BRL"},
]

# Divisas
DIVISAS = [
    {"ticker": "MXN=X",     "nombre": "USD/MXN",        "etiqueta": "Dólar / Peso",    "moneda": "MXN"},
    {"ticker": "EURUSD=X",  "nombre": "EUR/USD",        "etiqueta": "Euro / Dólar",    "moneda": "USD"},
    {"ticker": "GBPUSD=X",  "nombre": "GBP/USD",        "etiqueta": "Libra / Dólar",   "moneda": "USD"},
    {"ticker": "JPY=X",     "nombre": "USD/JPY",        "etiqueta": "Dólar / Yen",     "moneda": "JPY"},
]

# Commodities (vía ETFs líquidos)
COMMODITIES = [
    {"ticker": "GLD",       "nombre": "Oro",            "etiqueta": "GLD · oz",        "moneda": "USD"},
    {"ticker": "SLV",       "nombre": "Plata",          "etiqueta": "SLV · oz",        "moneda": "USD"},
    {"ticker": "USO",       "nombre": "Petróleo WTI",   "etiqueta": "USO · barril",    "moneda": "USD"},
    {"ticker": "UNG",       "nombre": "Gas natural",    "etiqueta": "UNG · BTU",       "moneda": "USD"},
]

# Crypto top
CRYPTO_TOP = [
    {"ticker": "BTC-USD",   "nombre": "Bitcoin",        "etiqueta": "BTC",             "moneda": "USD"},
    {"ticker": "ETH-USD",   "nombre": "Ethereum",       "etiqueta": "ETH",             "moneda": "USD"},
    {"ticker": "BNB-USD",   "nombre": "BNB",            "etiqueta": "BNB",             "moneda": "USD"},
    {"ticker": "SOL-USD",   "nombre": "Solana",         "etiqueta": "SOL",             "moneda": "USD"},
    {"ticker": "XRP-USD",   "nombre": "XRP",            "etiqueta": "XRP",             "moneda": "USD"},
]

# Yields / Tasas / Volatilidad
TASAS_VOL = [
    {"ticker": "^TNX",      "nombre": "US 10Y Treasury", "etiqueta": "Yield 10 años", "moneda": "%"},
    {"ticker": "^IRX",      "nombre": "US 3M Treasury",  "etiqueta": "Yield 3 meses", "moneda": "%"},
    {"ticker": "^VIX",      "nombre": "VIX",             "etiqueta": "Índice del miedo","moneda": "%"},
]

# Sectores USA (vía ETFs sectoriales SPDR)
SECTORES_US = [
    {"ticker": "XLK",  "nombre": "Tecnología",          "etiqueta": "XLK",             "moneda": "USD"},
    {"ticker": "XLF",  "nombre": "Financiero",          "etiqueta": "XLF",             "moneda": "USD"},
    {"ticker": "XLV",  "nombre": "Salud",               "etiqueta": "XLV",             "moneda": "USD"},
    {"ticker": "XLY",  "nombre": "Consumo discrecional","etiqueta": "XLY",             "moneda": "USD"},
    {"ticker": "XLP",  "nombre": "Consumo básico",      "etiqueta": "XLP",             "moneda": "USD"},
    {"ticker": "XLE",  "nombre": "Energía",             "etiqueta": "XLE",             "moneda": "USD"},
    {"ticker": "XLI",  "nombre": "Industrial",          "etiqueta": "XLI",             "moneda": "USD"},
    {"ticker": "XLU",  "nombre": "Servicios públicos",  "etiqueta": "XLU",             "moneda": "USD"},
    {"ticker": "XLB",  "nombre": "Materiales",          "etiqueta": "XLB",             "moneda": "USD"},
    {"ticker": "XLRE", "nombre": "Bienes raíces",       "etiqueta": "XLRE",            "moneda": "USD"},
    {"ticker": "XLC",  "nombre": "Comunicación",        "etiqueta": "XLC",             "moneda": "USD"},
]

# TTL de caches (segundos)
TTL_CIERRES = 5 * 60         # 5 min
TTL_NOTICIAS = 10 * 60       # 10 min
TTL_NOTICIAS_PORT = 15 * 60  # 15 min
TTL_RESUMEN = 60 * 60        # 1 hora

# Cache thread-safe
_lock = threading.Lock()
_cache = {
    "cierres":          {"data": None, "ts": 0},
    "noticias_top":     {"data": None, "ts": 0},
    "resumen":          {"data": None, "ts": 0},
    "noticias_port":    {},  # {ticker_key: {"data": [...], "ts": ...}}
}


def _cache_get(key, ttl):
    with _lock:
        c = _cache.get(key)
        if c and c["data"] is not None and (time.time() - c["ts"]) < ttl:
            return c["data"]
    return None


def _cache_set(key, data):
    with _lock:
        _cache[key] = {"data": data, "ts": time.time()}


# ------------------------------------------------------------
# Cierres de índices
# ------------------------------------------------------------
def _cierre_de(idx: dict) -> dict | None:
    """Baja 10 días de historia y calcula el cambio del último día."""
    t = idx["ticker"]
    try:
        hist = yf.Ticker(t).history(period="10d", interval="1d", auto_adjust=True)
        if hist.empty or len(hist) < 2:
            return None
        closes = hist["Close"].dropna()
        if len(closes) < 2:
            return None
        ultimo  = float(closes.iloc[-1])
        anterior = float(closes.iloc[-2])
        cambio_pct = ((ultimo - anterior) / anterior) * 100 if anterior > 0 else 0.0

        # Sparkline: últimos 5 puntos (closes), normalizados al primer valor.
        sparkline = closes.tail(5).tolist()

        fecha_ultimo = closes.index[-1].date().isoformat() if hasattr(closes.index[-1], "date") else str(closes.index[-1])

        return {
            "ticker":       t,
            "nombre":       idx["nombre"],
            "etiqueta":     idx["etiqueta"],
            "moneda":       idx["moneda"],
            "precio":       round(ultimo, 2),
            "cambio_pct":   round(cambio_pct, 2),
            "cambio_abs":   round(ultimo - anterior, 2),
            "sparkline":    [round(x, 2) for x in sparkline],
            "fecha":        fecha_ultimo,
        }
    except Exception:
        return None


def cierres_indices() -> dict:
    """Devuelve cierres del día + sparkline de 5 días para los índices."""
    cached = _cache_get("cierres", TTL_CIERRES)
    if cached:
        return cached

    from concurrent.futures import ThreadPoolExecutor
    indices = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        for r in ex.map(_cierre_de, INDICES):
            if r is not None:
                indices.append(r)

    data = {
        "indices":  indices,
        "timestamp": time.time(),
    }
    _cache_set("cierres", data)
    return data


# ------------------------------------------------------------
# Mercados extendidos: índices mundiales, FX, commodities, crypto, yields, sectores
# ------------------------------------------------------------
def mercados_dashboard() -> dict:
    """Dashboard completo estilo Yahoo Finance Markets Overview.
    Devuelve TODOS los grupos en una sola request para minimizar llamadas."""
    cached = _cache_get("mercados_dashboard", TTL_CIERRES)
    if cached:
        return cached

    from concurrent.futures import ThreadPoolExecutor

    def _descargar_grupo(lista):
        results = []
        with ThreadPoolExecutor(max_workers=6) as ex:
            for r in ex.map(_cierre_de, lista):
                if r is not None:
                    results.append(r)
        return results

    # Ejecutar todos los grupos en paralelo
    with ThreadPoolExecutor(max_workers=7) as ex_outer:
        fut_us       = ex_outer.submit(_descargar_grupo, INDICES)
        fut_mundo    = ex_outer.submit(_descargar_grupo, INDICES_MUNDIALES)
        fut_divisas  = ex_outer.submit(_descargar_grupo, DIVISAS)
        fut_commod   = ex_outer.submit(_descargar_grupo, COMMODITIES)
        fut_crypto   = ex_outer.submit(_descargar_grupo, CRYPTO_TOP)
        fut_tasas    = ex_outer.submit(_descargar_grupo, TASAS_VOL)
        fut_sectores = ex_outer.submit(_descargar_grupo, SECTORES_US)

        indices_us     = fut_us.result()
        indices_mundo  = fut_mundo.result()
        divisas        = fut_divisas.result()
        commodities    = fut_commod.result()
        crypto         = fut_crypto.result()
        tasas_vol      = fut_tasas.result()
        sectores       = fut_sectores.result()

    # Ordenar sectores por cambio_pct descendente para el heatmap
    sectores.sort(key=lambda x: x.get("cambio_pct", 0), reverse=True)

    data = {
        "indices_us":    indices_us,
        "indices_mundo": indices_mundo,
        "divisas":       divisas,
        "commodities":   commodities,
        "crypto":        crypto,
        "tasas_vol":     tasas_vol,
        "sectores":      sectores,
        "timestamp":     time.time(),
    }
    _cache_set("mercados_dashboard", data)
    return data


# ------------------------------------------------------------
# Noticias — helper para normalizar el formato de yfinance.news
# ------------------------------------------------------------
def _normalizar_noticia(n: dict) -> dict | None:
    """yfinance.news a veces devuelve v1 (plano) y a veces v2 (anidado).
    Normalizamos a un shape estable."""
    try:
        # v2: dict con 'content' anidado
        if "content" in n and isinstance(n["content"], dict):
            c = n["content"]
            titulo = c.get("title") or ""
            resumen = c.get("summary") or c.get("description") or ""
            url = (c.get("clickThroughUrl") or {}).get("url") \
                  or (c.get("canonicalUrl") or {}).get("url") \
                  or ""
            proveedor = (c.get("provider") or {}).get("displayName") or ""
            fecha_pub = c.get("pubDate") or c.get("displayTime") or ""
            thumb = ((c.get("thumbnail") or {}).get("originalUrl")) or ""
        else:
            # v1: plano
            titulo = n.get("title") or ""
            resumen = n.get("summary") or ""
            url = n.get("link") or n.get("url") or ""
            proveedor = n.get("publisher") or n.get("source") or ""
            # yfinance v1 da providerPublishTime en segundos unix
            ts = n.get("providerPublishTime")
            if ts:
                fecha_pub = pd.Timestamp(ts, unit="s").isoformat()
            else:
                fecha_pub = ""
            thumb = ""
            th = n.get("thumbnail") or {}
            resolutions = th.get("resolutions") or []
            if resolutions:
                thumb = resolutions[0].get("url", "")

        if not titulo or not url:
            return None

        return {
            "titulo":    titulo.strip()[:200],
            "resumen":   (resumen or "").strip()[:300],
            "url":       url,
            "proveedor": proveedor,
            "fecha":     fecha_pub,
            "thumbnail": thumb,
        }
    except Exception:
        return None


# ------------------------------------------------------------
# Noticias top del día
# ------------------------------------------------------------
# Tickers semilla — pedimos news de índices/ETFs grandes porque
# yfinance asocia ahí las noticias "macro" del mercado.
TICKERS_NOTICIAS_TOP = ["SPY", "QQQ", "AAPL", "NVDA", "MSFT", "NAFTRAC.MX"]


def noticias_top(limite: int = 10) -> list[dict]:
    """Agrega noticias de los tickers semilla y deduplica por URL."""
    cached = _cache_get("noticias_top", TTL_NOTICIAS)
    if cached:
        return cached[:limite]

    vistas = set()
    out = []
    for t in TICKERS_NOTICIAS_TOP:
        try:
            lista = yf.Ticker(t).news or []
        except Exception:
            continue
        for n in lista:
            norm = _normalizar_noticia(n)
            if not norm:
                continue
            if norm["url"] in vistas:
                continue
            vistas.add(norm["url"])
            out.append(norm)

    # Ordenar por fecha desc si tenemos fechas parseables
    def _fecha_key(n):
        try:
            return pd.Timestamp(n.get("fecha") or "")
        except Exception:
            return pd.Timestamp("1970-01-01")

    out.sort(key=_fecha_key, reverse=True)
    _cache_set("noticias_top", out)
    return out[:limite]


# ------------------------------------------------------------
# Noticias específicas del portafolio del usuario
# ------------------------------------------------------------
def noticias_portafolio(tickers: list[str], limite: int = 12) -> list[dict]:
    """Trae noticias de los tickers del usuario. Cachea por ticker individual."""
    if not tickers:
        return []

    # Cache por firma del conjunto de tickers
    key = ",".join(sorted(tickers))
    with _lock:
        c = _cache["noticias_port"].get(key)
        if c and (time.time() - c["ts"]) < TTL_NOTICIAS_PORT:
            return c["data"][:limite]

    vistas = set()
    out = []
    for t in tickers:
        try:
            lista = yf.Ticker(t).news or []
        except Exception:
            continue
        for n in lista[:4]:   # máximo 4 por ticker
            norm = _normalizar_noticia(n)
            if not norm:
                continue
            if norm["url"] in vistas:
                continue
            vistas.add(norm["url"])
            norm["ticker_relacionado"] = t
            out.append(norm)

    # Ordenar por fecha desc
    def _fecha_key(n):
        try:
            return pd.Timestamp(n.get("fecha") or "")
        except Exception:
            return pd.Timestamp("1970-01-01")

    out.sort(key=_fecha_key, reverse=True)

    with _lock:
        _cache["noticias_port"][key] = {"data": out, "ts": time.time()}

    return out[:limite]


# ------------------------------------------------------------
# Resumen ejecutivo del día
# ------------------------------------------------------------
#  Combina los cierres de los índices + los 3 titulares más
#  recientes para armar un "brief" corto. Sin IA: es una plantilla
#  que rellena con datos reales, evitando inventar nada.
#
#  El tono es descriptivo, no prescriptivo (CNBV-safe):
#    "Los mercados cerraron…", NO "deberías comprar…"
# ------------------------------------------------------------
def _clasificar_dia(indices: list[dict]) -> dict:
    """Determina si el día fue alcista, bajista o mixto promediando
    el cambio % de los índices."""
    if not indices:
        return {"tipo": "info", "etiqueta": "sin datos", "promedio": 0.0}

    promedio = sum(i.get("cambio_pct", 0) for i in indices) / len(indices)
    positivos = sum(1 for i in indices if i.get("cambio_pct", 0) > 0)
    negativos = sum(1 for i in indices if i.get("cambio_pct", 0) < 0)

    if positivos == len(indices):
        tipo, etiqueta = "alcista", "día alcista"
    elif negativos == len(indices):
        tipo, etiqueta = "bajista", "día bajista"
    elif promedio > 0.3:
        tipo, etiqueta = "alcista", "jornada mayormente positiva"
    elif promedio < -0.3:
        tipo, etiqueta = "bajista", "jornada mayormente negativa"
    else:
        tipo, etiqueta = "mixto", "jornada mixta"

    return {"tipo": tipo, "etiqueta": etiqueta, "promedio": round(promedio, 2)}


def resumen_diario() -> dict:
    """Brief ejecutivo del día: cierres + 3 titulares top.
    Honesto sobre las fuentes (Yahoo Finance) y sin invenciones."""
    cached = _cache_get("resumen", TTL_RESUMEN)
    if cached:
        return cached

    # Datos base
    cierres = cierres_indices()
    indices = cierres.get("indices", [])
    noticias = noticias_top(limite=5)

    clase = _clasificar_dia(indices)

    # Frase 1 — mercados USA (S&P, NASDAQ, Dow si están disponibles)
    usa = [i for i in indices if i.get("moneda") == "USD"]
    mx  = [i for i in indices if i.get("moneda") == "MXN"]

    def _frase_region(lista, region):
        if not lista:
            return None
        partes = []
        for i in lista[:3]:
            signo = "+" if i["cambio_pct"] >= 0 else ""
            partes.append(f"{i['nombre']} {signo}{i['cambio_pct']:.2f}%")
        return f"En {region}: " + ", ".join(partes) + "."

    frases = []
    f_usa = _frase_region(usa, "EEUU")
    f_mx = _frase_region(mx, "México")
    if f_usa: frases.append(f_usa)
    if f_mx:  frases.append(f_mx)

    # Frase 2 — titulares destacados (los 3 más recientes con título corto)
    titulares = []
    for n in noticias[:8]:
        titulo = (n.get("titulo") or "").strip()
        # Preferimos titulares cortos/legibles
        if 15 <= len(titulo) <= 140:
            titulares.append({
                "titulo":    titulo,
                "proveedor": n.get("proveedor") or "",
                "url":       n.get("url") or "",
            })
        if len(titulares) >= 3:
            break

    # Fallback: si no encontramos 3 titulares cortos, usamos los primeros
    if len(titulares) < 3:
        for n in noticias[:3]:
            if all(t["url"] != n.get("url") for t in titulares):
                titulares.append({
                    "titulo":    (n.get("titulo") or "").strip(),
                    "proveedor": n.get("proveedor") or "",
                    "url":       n.get("url") or "",
                })
            if len(titulares) >= 3:
                break

    # Armamos el texto
    texto = " ".join(frases) if frases else "No hay datos de cierre disponibles."

    data = {
        "clasificacion":    clase,          # {tipo, etiqueta, promedio}
        "resumen_mercado":  texto,          # frase corta con cierres
        "titulares":        titulares,      # lista de {titulo, proveedor, url}
        "aviso":            "Información agregada de Yahoo Finance. No es asesoría de inversión.",
        "timestamp":        time.time(),
    }
    _cache_set("resumen", data)
    return data
