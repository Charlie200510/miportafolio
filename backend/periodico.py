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

import json
import time
import threading
from datetime import date, timedelta
from pathlib import Path

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

# TTL de caches (segundos) — aumentados para mejor performance
# Los mercados no se mueven tanto minuto a minuto; 15-30 min es suficiente
TTL_CIERRES = 15 * 60        # 15 min (antes 5 min)
TTL_NOTICIAS = 30 * 60       # 30 min (antes 10 min)
TTL_NOTICIAS_PORT = 30 * 60  # 30 min (antes 15 min)
TTL_RESUMEN = 2 * 60 * 60    # 2 horas (antes 1 hora)

# Cache persistente en disco (sobrevive reinicios de Render)
_CACHE_DIR = Path(__file__).parent / "_cache_periodico"
_CACHE_DIR.mkdir(exist_ok=True)

# Cache thread-safe
_lock = threading.Lock()
_cache = {
    "cierres":          {"data": None, "ts": 0},
    "noticias_top":     {"data": None, "ts": 0},
    "resumen":          {"data": None, "ts": 0},
    "noticias_port":    {},  # {ticker_key: {"data": [...], "ts": ...}}
}


def _cache_get(key, ttl):
    """Lee primero del cache en memoria. Si expiró pero hay disco, lo carga."""
    with _lock:
        c = _cache.get(key)
        if c and c.get("data") is not None and (time.time() - c["ts"]) < ttl:
            return c["data"]

    # Fallback: cache en disco (sobrevive reinicios de Render)
    disk_path = _CACHE_DIR / f"{key}.json"
    if disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                cached = json.load(f)
            ts = cached.get("_ts", 0)
            if (time.time() - ts) < ttl:
                data = cached.get("data")
                # Repopular cache en memoria
                with _lock:
                    _cache[key] = {"data": data, "ts": ts}
                return data
        except Exception:
            pass
    return None


def _cache_set(key, data):
    """Guarda en memoria Y en disco (best-effort)."""
    ts = time.time()
    with _lock:
        _cache[key] = {"data": data, "ts": ts}
    # Persistir en disco para sobrevivir reinicios
    try:
        disk_path = _CACHE_DIR / f"{key}.json"
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass  # No es crítico si falla el disco


# ------------------------------------------------------------
# Cierres de índices
# ------------------------------------------------------------
# Sesiones que abarca cada ventana, y cuánta historia hay que bajar para
# cubrirla con holgura. Un "mes" son ~21 sesiones hábiles, no 30 días.
_DIAS_PERIODO = {"dia": 1, "semana": 5, "mes": 21, "anio": 252}
_HISTORIA_PERIODO = {"dia": "10d", "semana": "1mo", "mes": "3mo", "anio": "2y"}


def _cierre_de(idx: dict, periodo: str = "dia") -> dict | None:
    """Cambio del instrumento sobre la ventana pedida (día/semana/mes/año).

    Antes solo calculaba el cambio del último día. La ventana la elige el
    usuario en el Periódico, y "el S&P bajó 0.3%" contra "subió 22% en el año"
    son dos lecturas distintas del mismo instrumento; con solo el día, un lunes
    tranquilo dejaba la sección entera en ±0.2%.
    """
    t = idx["ticker"]
    dias = _DIAS_PERIODO.get(periodo, 1)
    try:
        hist = yf.Ticker(t).history(period=_HISTORIA_PERIODO.get(periodo, "10d"),
                                    interval="1d", auto_adjust=True)
        if hist.empty or len(hist) < 2:
            return None
        closes = hist["Close"].dropna()
        if len(closes) < 2:
            return None
        ultimo  = float(closes.iloc[-1])
        # Si no hay tanta historia como pide la ventana se usa el primer cierre
        # disponible: para un instrumento que lleva 4 meses cotizando, "en el
        # año" es todo lo que existe, y eso es más útil que no decir nada.
        idx_atras = max(0, len(closes) - 1 - dias)
        anterior = float(closes.iloc[idx_atras])
        cambio_pct = ((ultimo - anterior) / anterior) * 100 if anterior > 0 else 0.0

        # Sparkline: para el día siguen siendo 5 puntos; en ventanas largas se
        # muestrea la ventana completa, o la línea no tendría nada que ver con
        # el porcentaje de al lado.
        if dias <= 1:
            sparkline = closes.tail(5).tolist()
        else:
            ventana = closes.iloc[idx_atras:]
            paso = max(1, len(ventana) // 24)
            sparkline = ventana.iloc[::paso].tolist()[-24:]

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
            "periodo":      periodo,
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
def mercados_dashboard(periodo: str = "dia") -> dict:
    """Dashboard completo estilo Yahoo Finance Markets Overview.
    Devuelve TODOS los grupos en una sola request para minimizar llamadas.

    `periodo` (dia|semana|mes|anio) cambia la ventana del porcentaje. Cada una
    tiene su propia entrada de caché: son ~50 instrumentos por llamada y
    recalcularlos en cada cambio de pestaña sería castigar a Yahoo sin motivo.
    """
    periodo = periodo if periodo in _DIAS_PERIODO else "dia"
    clave = "mercados_dashboard" if periodo == "dia" else f"mercados_dashboard_{periodo}"
    cached = _cache_get(clave, TTL_CIERRES)
    if cached:
        return cached

    from concurrent.futures import ThreadPoolExecutor

    def _descargar_grupo(lista):
        results = []
        with ThreadPoolExecutor(max_workers=6) as ex:
            for r in ex.map(lambda i: _cierre_de(i, periodo), lista):
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
    _cache_set(clave, data)
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
# yfinance asocia ahí las noticias "macro" del mercado. Se amplió con
# semillas de cripto, tasas y BMV para que las cinco categorías del mazo de
# Periódico tengan de dónde llenarse (antes todo caía en "global").
TICKERS_NOTICIAS_TOP = [
    "SPY", "QQQ", "AAPL", "NVDA", "MSFT",          # global / EEUU
    "NAFTRAC.MX", "WALMEX.MX", "GFNORTEO.MX",      # México
    "BTC-USD", "ETH-USD",                          # cripto
    "^TNX", "TLT",                                 # macro y tasas
]

# ── Categorías de las tarjetas del Periódico ────────────────────────────────
# El color de cada tarjeta CODIFICA la categoría (ver MP_CATEGORIAS en app.js;
# las claves de aquí y las de allá tienen que coincidir exactamente).
#   mx        · mercado mexicano (BMV / IPC)
#   global    · mercados globales
#   cripto    · criptomonedas
#   posicion  · noticias de tus posiciones  (se asigna en el cliente/portafolio)
#   macro     · macro y tasas
CAT_MX, CAT_GLOBAL, CAT_CRIPTO, CAT_POSICION, CAT_MACRO = (
    "mx", "global", "cripto", "posicion", "macro")

_SEMILLA_CATEGORIA = {
    "SPY": CAT_GLOBAL, "QQQ": CAT_GLOBAL, "AAPL": CAT_GLOBAL,
    "NVDA": CAT_GLOBAL, "MSFT": CAT_GLOBAL,
    "NAFTRAC.MX": CAT_MX, "WALMEX.MX": CAT_MX, "GFNORTEO.MX": CAT_MX,
    "BTC-USD": CAT_CRIPTO, "ETH-USD": CAT_CRIPTO,
    "^TNX": CAT_MACRO, "TLT": CAT_MACRO,
}

# Palabras del titular que MANDAN sobre el ticker semilla: una nota sobre la
# Fed que llegó colgada de SPY es macro, no "mercados globales".
_PALABRAS_CATEGORIA = [
    (CAT_CRIPTO, ("bitcoin", "ethereum", "crypto", "cripto", "solana", "xrp",
                  "stablecoin", "blockchain", "altcoin", "token")),
    (CAT_MACRO,  ("fed", "federal reserve", "inflation", "inflación", "cpi",
                  "treasury", "yield", "rate cut", "rate hike", "banxico",
                  "tasa de interés", "jobs report", "payrolls", "gdp", "pib",
                  "recession", "recesión", "tariff", "arancel")),
    (CAT_MX,     ("mexico", "méxico", "mexican", "bmv", "ipc", "peso mexicano",
                  "banxico", "cetes")),
]


def _categoria_de(noticia: dict, semilla: str) -> str:
    """Categoría de una noticia: primero el titular, luego el ticker semilla."""
    texto = f"{noticia.get('titulo', '')} {noticia.get('resumen', '')}".lower()
    for cat, palabras in _PALABRAS_CATEGORIA:
        if any(p in texto for p in palabras):
            return cat
    return _SEMILLA_CATEGORIA.get(semilla, CAT_GLOBAL)


def _fecha_key(n):
    """Orden por fecha de publicación, descendente. Las no parseables al final."""
    try:
        return pd.Timestamp(n.get("fecha") or "")
    except Exception:
        return pd.Timestamp("1970-01-01")


def _descargar_noticias_top() -> list[dict]:
    """Baja y normaliza las noticias de todas las semillas (sin tocar caché)."""
    vistas: dict[str, dict] = {}
    out: list[dict] = []
    for t in TICKERS_NOTICIAS_TOP:
        try:
            lista = yf.Ticker(t).news or []
        except Exception:
            continue
        for n in lista:
            norm = _normalizar_noticia(n)
            if not norm:
                continue
            ya = vistas.get(norm["url"])
            if ya is not None:
                # La misma nota colgada de dos semillas: no se duplica, se le
                # suma el ticker. Así el chip de "tickers relacionados" de la
                # tarjeta sale completo en vez de con uno solo.
                if t not in ya["tickers"]:
                    ya["tickers"].append(t)
                continue
            norm["tickers"] = [t]
            norm["categoria"] = _categoria_de(norm, t)
            vistas[norm["url"]] = norm
            out.append(norm)

    out.sort(key=_fecha_key, reverse=True)
    return out


def noticias_top(limite: int = 10) -> list[dict]:
    """Noticias top del día. Caché corto (TTL_NOTICIAS) sobre el diario."""
    cached = _cache_get("noticias_top", TTL_NOTICIAS)
    if cached:
        return cached[:limite]
    out = _descargar_noticias_top()
    _cache_set("noticias_top", out)
    return out[:limite]


# ------------------------------------------------------------
# Caché DIARIO de noticias (una corrida por la mañana, hora CDMX)
# ------------------------------------------------------------
#  El mazo de noticias del Periódico no necesita refrescarse cada 30 min: es una
#  edición del día, como un periódico de verdad. Se arma una vez por la mañana
#  y se sirve igual toda la jornada, con refresco manual desde la UI.
#
#  Por qué disco y no solo memoria: gunicorn corre varios workers y se reinicia
#  en cada deploy; el archivo es lo único que comparten y que sobrevive. El
#  purgado de cachés de deploy/pull.sh (backend/_cache_*) lo borra, y eso está
#  bien: la primera petición del día siguiente lo reconstruye.
HORA_EDICION_CDMX = 7          # a partir de las 7:00 CDMX ya hay edición nueva
_ARCHIVO_DIARIO = _CACHE_DIR / "noticias_diarias.json"
_lock_diario = threading.Lock()


def _ahora_cdmx():
    """Hora de Ciudad de México. El servidor corre en UTC, así que la fecha de
    la edición NO puede salir de date.today(): a las 20:00 CDMX ya es el día
    siguiente en UTC y la edición se habría 'renovado' a media tarde."""
    from datetime import datetime, timezone, timedelta
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Mexico_City"))
    except Exception:
        # Sin tzdata (imagen mínima): CDMX es UTC-6 todo el año desde 2022,
        # cuando México eliminó el horario de verano.
        return datetime.now(timezone.utc) - timedelta(hours=6)


def _edicion_vigente() -> str:
    """Etiqueta de la edición que toca ahora mismo, formato YYYY-MM-DD.

    Antes de HORA_EDICION_CDMX sigue vigente la edición de AYER: si a las 6 am
    se marcara ya la de hoy, el caché se invalidaría y el primer usuario del día
    se comería la descarga completa (~20 s) en vez de leer la edición previa."""
    ahora = _ahora_cdmx()
    if ahora.hour < HORA_EDICION_CDMX:
        return (ahora.date() - timedelta(days=1)).isoformat()
    return ahora.date().isoformat()


def _leer_diario() -> dict | None:
    try:
        if not _ARCHIVO_DIARIO.exists():
            return None
        with open(_ARCHIVO_DIARIO, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) and d.get("noticias") else None
    except Exception:
        return None


def _escribir_diario(d: dict) -> None:
    try:
        tmp = _ARCHIVO_DIARIO.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        tmp.replace(_ARCHIVO_DIARIO)     # atómico: nadie lee un archivo a medias
    except Exception:
        pass


def noticias_diarias(limite: int = 24, forzar: bool = False) -> dict:
    """Edición del día del mazo de noticias.

    Devuelve SIEMPRE un dict con la misma forma, para que el cliente nunca se
    quede en "Cargando…":
      {ok, noticias[], edicion, generado_en, degradado, error?}

    `degradado=True` significa que la descarga falló y se está sirviendo la
    edición anterior; el cliente lo dice explícitamente en vez de fingir que el
    dato es de hoy.
    """
    edicion = _edicion_vigente()
    previo = _leer_diario()

    if not forzar and previo and previo.get("edicion") == edicion:
        return {**previo, "noticias": previo["noticias"][:limite], "degradado": False}

    with _lock_diario:
        # Otro worker pudo generarla mientras esperábamos el lock.
        previo = _leer_diario()
        if not forzar and previo and previo.get("edicion") == edicion:
            return {**previo, "noticias": previo["noticias"][:limite], "degradado": False}

        try:
            noticias = _descargar_noticias_top()
        except Exception as e:
            noticias, err = [], str(e)
        else:
            err = None

        if not noticias:
            if previo and previo.get("noticias"):
                # Se sirve la edición vieja marcada como tal: mucho mejor que
                # una sección en blanco.
                return {**previo, "noticias": previo["noticias"][:limite],
                        "degradado": True,
                        "error": err or "La fuente de noticias no respondió."}
            return {"ok": False, "noticias": [], "edicion": edicion,
                    "generado_en": None, "degradado": True,
                    "error": err or "La fuente de noticias no respondió."}

        d = {
            "ok": True,
            "noticias": noticias,
            "edicion": edicion,
            "generado_en": _ahora_cdmx().isoformat(timespec="seconds"),
        }
        _escribir_diario(d)
        # El caché corto comparte los datos: una sola descarga sirve a los dos.
        _cache_set("noticias_top", noticias)
        return {**d, "noticias": noticias[:limite], "degradado": False}


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
            norm["tickers"] = [t]
            # Todo lo que sale del portafolio del usuario va a la categoría
            # "tus posiciones", sin importar de qué hable: el color de la
            # tarjeta responde a POR QUÉ le importa a este usuario.
            norm["categoria"] = CAT_POSICION
            out.append(norm)

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
        "aviso":            "",
        "timestamp":        time.time(),
    }
    _cache_set("resumen", data)
    return data
