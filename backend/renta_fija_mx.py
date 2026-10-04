"""
renta_fija_mx.py — FIBRAS mexicanas + CETES en vivo.

Agrupa dos fuentes de "renta" de bajo riesgo relativo para inversionistas
mexicanos:

1. FIBRAS (Fideicomisos de Inversión en Bienes Raíces) cotizando en BMV:
   pagan distribuciones trimestrales de ~90% de sus utilidades. Ideales
   para ingreso pasivo.

2. CETES (Certificados de la Tesorería) — la "tasa libre de riesgo" MX.

FIBRAS: vía yfinance (tickers con sufijo .MX).
CETES:  intenta API pública Banxico (SIE) con token opcional, si no hay
        usa valores de respaldo configurables por env var.
"""

from __future__ import annotations

import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
import yfinance as yf


# ---- FIBRAS curadas ---------------------------------------------------------

FIBRAS_CURADAS: List[Dict[str, str]] = [
    {"ticker": "FUNO11.MX",       "nombre": "FibraUno",               "sector": "Diversificada"},
    {"ticker": "FIBRAMQ12.MX",    "nombre": "MacQuarie México",       "sector": "Industrial"},
    {"ticker": "DANHOS13.MX",     "nombre": "Danhos",                 "sector": "Comercial / Oficinas"},
    {"ticker": "FIBRAPL14.MX",    "nombre": "Prologis Property",      "sector": "Industrial"},
    {"ticker": "TERRA13.MX",      "nombre": "Terrafina",              "sector": "Industrial"},
    {"ticker": "FSHOP13.MX",      "nombre": "Fibra Shop",             "sector": "Centros comerciales"},
    {"ticker": "FIHO12.MX",       "nombre": "Fibra Hotel",            "sector": "Hotelería"},
    {"ticker": "FMTY14.MX",       "nombre": "Fibra Monterrey",        "sector": "Diversificada"},
    {"ticker": "FIBRAHD14.MX",    "nombre": "Fibra HD",               "sector": "Industrial / Comercial"},
    {"ticker": "FINN13.MX",       "nombre": "Fibra Inn",              "sector": "Hotelería"},
]


def _safe_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        f = float(x)
        return None if f != f else f
    except (ValueError, TypeError):
        return None


def _evaluar_yield(y: Optional[float]) -> str:
    if y is None or y <= 0:
        return "sin_dato"
    if y < 0.05:
        return "bajo"
    if y < 0.08:
        return "atractivo"
    if y < 0.12:
        return "muy_alto"
    return "extremo"


def _fibra_info(entrada: Dict[str, str]) -> Dict[str, Any]:
    ticker = entrada["ticker"]
    out: Dict[str, Any] = {
        "ticker":  ticker,
        "nombre":  entrada.get("nombre"),
        "sector":  entrada.get("sector"),
        "ok":      False,
    }
    try:
        t = yf.Ticker(ticker)
        info: Dict[str, Any] = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}

        precio: Optional[float] = None
        try:
            fi = t.fast_info
            precio = _safe_float(getattr(fi, "last_price", None))
        except Exception:
            precio = None
        if precio is None:
            precio = _safe_float(info.get("regularMarketPrice")) or _safe_float(info.get("currentPrice"))

        y = _safe_float(info.get("dividendYield"))
        if y is not None and y > 1:
            y = y / 100.0

        rate = _safe_float(info.get("dividendRate"))
        mc = _safe_float(info.get("marketCap"))
        low52  = _safe_float(info.get("fiftyTwoWeekLow"))
        high52 = _safe_float(info.get("fiftyTwoWeekHigh"))

        pos_52w = None
        try:
            if precio and low52 and high52 and high52 > low52:
                pos_52w = max(0.0, min(1.0, (precio - low52) / (high52 - low52)))
        except (ValueError, TypeError):
            pos_52w = None

        out.update({
            "ok":             True,
            "precio":         precio,
            "dividend_yield": y,
            "dividend_rate":  rate,
            "market_cap":     mc,
            "low_52w":        low52,
            "high_52w":       high52,
            "pos_52w":        pos_52w,
            "yield_nivel":    _evaluar_yield(y),
            "moneda":         info.get("currency") or "MXN",
        })
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"

    return out


def obtener_fibras() -> List[Dict[str, Any]]:
    """Pulls FIBRAs data en paralelo."""
    resultados: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_fibra_info, e): e["ticker"] for e in FIBRAS_CURADAS}
        for fut in as_completed(futs):
            t = futs[fut]
            try:
                resultados[t] = fut.result()
            except Exception as e:
                resultados[t] = {"ticker": t, "ok": False, "error": str(e)}

    # Preservar orden; ordenar por yield descendente (los OK primero)
    ok = [resultados[e["ticker"]] for e in FIBRAS_CURADAS if resultados.get(e["ticker"], {}).get("ok")]
    falla = [resultados[e["ticker"]] for e in FIBRAS_CURADAS if not resultados.get(e["ticker"], {}).get("ok")]
    ok.sort(key=lambda r: (r.get("dividend_yield") or 0), reverse=True)
    return ok + falla


# ---- CETES ------------------------------------------------------------------

# IDs de las series de Banxico SIE
SIE_SERIES = {
    "28":  "SF43936",    # CETES 28 días
    "91":  "SF43939",    # CETES 91 días
    "182": "SF43942",    # CETES 182 días
    "364": "SF43945",    # CETES 364 días
}

# Respaldo (actualizable por env CETES_<plazo>) para cuando Banxico no
# contesta o no hay token. Eran valores de abril de 2026 (28 días en 9.50%) y
# en octubre la tasa real era 6.01%: el respaldo viejo hacía que en local, o
# en una caída de Banxico, toda la app comparara contra una CETES que ya no
# existía. Banxico SIE, subasta del 1 de octubre de 2026.
CETES_FALLBACK_DEFAULT = {
    "28":  6.01,
    "91":  6.73,
    "182": 7.01,
    "364": 7.44,
}


def _banxico_token() -> Optional[str]:
    return os.environ.get("BANXICO_SIE_TOKEN")


def _obtener_cetes_sie(token: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """Consulta SIE de Banxico. Regresa None si falla."""
    out: Dict[str, Dict[str, Any]] = {}
    try:
        ids = ",".join(SIE_SERIES.values())
        url = f"https://www.banxico.org.mx/SieAPIRest/service/v1/series/{ids}/datos/oportuno"
        r = requests.get(url, headers={"Bmx-Token": token}, timeout=10)
        if r.status_code != 200:
            return None
        data = r.json().get("bmx", {}).get("series") or []
        # Mapeo inverso: serie id -> plazo
        id_to_plazo = {v: k for k, v in SIE_SERIES.items()}
        for s in data:
            sid = s.get("idSerie")
            plazo = id_to_plazo.get(sid)
            datos = s.get("datos") or []
            if not plazo or not datos:
                continue
            ultimo = datos[-1]
            try:
                tasa = float(str(ultimo.get("dato")).replace(",", "."))
            except (ValueError, TypeError):
                continue
            out[plazo] = {"tasa_pct": tasa, "fecha": ultimo.get("fecha"), "fuente": "banxico_sie"}
        return out or None
    except Exception:
        return None


def _ahora_cdmx_iso() -> str:
    """Hora de CDMX con su offset. datetime.now() da la hora de la VM (UTC) sin
    zona, y la app la pintaba como si fuera local: seis horas adelantada."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Mexico_City")).isoformat(timespec="seconds")
    except Exception:
        return datetime.now().astimezone().isoformat(timespec="seconds")


_MEM_CETES: Dict[str, Any] = {"ts": 0.0, "d": None, "ttl": 0}
# Caché COMPARTIDA entre los workers de gunicorn: con una en memoria por
# proceso, uno podía seguir con la tasa de la mañana y otro con la de la
# subasta nueva, y el chip y el análisis enseñaban dos CETES distintas.
_ARCHIVO_CETES = Path(__file__).resolve().parent / "_cache_renta_fija" / "cetes.json"


def _leer_cetes_disco() -> Optional[Dict[str, Any]]:
    try:
        import json as _json
        with open(_ARCHIVO_CETES, encoding="utf-8") as fh:
            return _json.load(fh)
    except Exception:
        return None


def _escribir_cetes_disco(reg: Dict[str, Any]) -> None:
    try:
        import json as _json
        _ARCHIVO_CETES.parent.mkdir(parents=True, exist_ok=True)
        tmp = _ARCHIVO_CETES.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            _json.dump(reg, fh, ensure_ascii=False)
        tmp.replace(_ARCHIVO_CETES)          # atómico: nadie lee un archivo a medias
    except Exception:
        pass


def obtener_cetes() -> Dict[str, Any]:
    """Tasas CETES por plazo (Banxico SIE o respaldo), con caché por proceso.

    El chip, el Cuadernillo y todos los cálculos (cetes_28_pct) leen de aquí:
    con una caché aparte para el análisis y ninguna para el chip, podían
    enseñar tasas distintas el día que Banxico publicara una nueva. 6 h si
    vino de Banxico; 15 min si cayó al respaldo, para reintentar pronto."""
    import time as _t
    ahora = _t.time()
    # Memoria del proceso solo 60 s: lo que manda es el archivo compartido.
    if _MEM_CETES["d"] is not None and ahora - _MEM_CETES["ts"] < min(60, _MEM_CETES["ttl"]):
        return _MEM_CETES["d"]
    reg = _leer_cetes_disco()
    if reg and isinstance(reg.get("d"), dict) and ahora - float(reg.get("ts", 0)) < float(reg.get("ttl", 0)):
        _MEM_CETES.update(ts=ahora, d=reg["d"], ttl=float(reg["ttl"]))
        return reg["d"]
    d = _obtener_cetes_sin_cache()
    ttl = 6 * 3600 if d.get("fuente") == "banxico_sie" else 15 * 60
    _escribir_cetes_disco({"ts": ahora, "ttl": ttl, "d": d})
    _MEM_CETES.update(ts=ahora, d=d, ttl=ttl)
    return d


def _obtener_cetes_sin_cache() -> Dict[str, Any]:
    """Devuelve tasas CETES por plazo. Intenta Banxico SIE, luego fallback."""
    token = _banxico_token()
    if token:
        tasas = _obtener_cetes_sie(token)
        if tasas:
            return {
                "tasas": tasas,
                "fuente": "banxico_sie",
                "actualizado": _ahora_cdmx_iso(),
            }

    # Fallback configurable por env
    tasas: Dict[str, Dict[str, Any]] = {}
    for plazo, default in CETES_FALLBACK_DEFAULT.items():
        env_key = f"CETES_{plazo}"
        try:
            v = float(os.environ.get(env_key, default))
        except (ValueError, TypeError):
            v = default
        tasas[plazo] = {"tasa_pct": v, "fecha": None, "fuente": "fallback"}

    return {
        "tasas":       tasas,
        "fuente":      "fallback",
        "actualizado": None,
        "nota":        "Usando valores de respaldo. Configura BANXICO_SIE_TOKEN para tasas en vivo.",
    }


# ---- La tasa libre de riesgo en pesos, UNA sola para toda la app ------------
#
# El chip de arriba y el Cuadernillo enseñaban la CETES 28 días de Banxico (en
# octubre, 6.01%), mientras la flotación, la regata, el copo, los Sharpe y la
# fila "Contra CETES" usaban un 9.5% escrito a mano en siete módulos. En la
# misma pantalla salía "CETES 28d 6.01%" arriba y "CETES pagó 9.5%" abajo.
# Todos leen ahora de aquí, y de la misma caché que el chip (obtener_cetes).


def cetes_28_pct() -> tuple:
    """(tasa de CETES 28 días en %, fuente: 'banxico_sie' | 'fallback').
    Sin caché propia: lee la de obtener_cetes(), la misma que usa el chip."""
    pct, fuente = None, "fallback"
    try:
        d = obtener_cetes()
        pct = float(d["tasas"]["28"]["tasa_pct"])
        fuente = d.get("fuente") or "fallback"
    except Exception:
        pass
    if not pct or not (0 < pct < 50):
        pct, fuente = CETES_FALLBACK_DEFAULT["28"], "fallback"
    return pct, fuente


def tasa_libre_mx() -> float:
    """CETES 28 días vigente como FRACCIÓN (0.0601), para los Sharpe y Sortino."""
    return cetes_28_pct()[0] / 100.0


# ---- Lo que CETES PAGÓ en una ventana de tiempo -----------------------------
#
# Comparar un rendimiento de 5 años contra la CETES de HOY favorece o castiga a
# la cartera según por dónde ande la tasa: en octubre de 2026 CETES pagaba 6.01%,
# pero en los cinco años anteriores pagó 9.27% al año compuesto (11.9% en 2023).
# Las comparaciones históricas (flotación, regata, "Contra CETES", Sharpe,
# backtests) usan lo que CETES pagó en ESA MISMA ventana. "CETES paga hoy" y la
# SML/CAPM, que miran hacia adelante, siguen con la tasa vigente.
#
# La serie es la CETES 28 días de Banxico (SF43936), una subasta por semana. En la
# VM se baja con el token y se guarda un día; sin token o si Banxico no contesta,
# se usa la copia versionada (cetes_28_historico.csv, datos públicos), extendida
# con la tasa vigente para las semanas que le falten.
_CSV_HISTORICO = Path(__file__).resolve().parent / "cetes_28_historico.csv"
_ARCHIVO_HISTORICO = Path(__file__).resolve().parent / "_cache_renta_fija" / "cetes_28_historico.json"
_MEM_HIST: Dict[str, Any] = {"ts": 0.0, "serie": None}
# El score corre sobre miles de emisoras con las mismas ventanas: se memoriza.
_MEMO_PERIODO: Dict[Any, Any] = {}


def _historico_banxico(token: str) -> Optional[List[List[Any]]]:
    try:
        hoy = datetime.now().strftime("%Y-%m-%d")
        url = (f"https://www.banxico.org.mx/SieAPIRest/service/v1/series/"
               f"{SIE_SERIES['28']}/datos/2005-01-01/{hoy}")
        r = requests.get(url, headers={"Bmx-Token": token}, timeout=30)
        if r.status_code != 200:
            return None
        out = []
        for d in r.json()["bmx"]["series"][0]["datos"]:
            dd, mm, aa = d["fecha"].split("/")
            try:
                out.append([f"{aa}-{mm}-{dd}", float(str(d["dato"]).replace(",", "."))])
            except (ValueError, TypeError):
                continue
        return out or None
    except Exception:
        return None


def serie_cetes_28():
    """pandas.Series de la CETES 28 días (%), indexada por fecha de subasta."""
    import time as _t
    import json as _json
    import pandas as pd
    ahora = _t.time()
    if _MEM_HIST["serie"] is not None and ahora - _MEM_HIST["ts"] < 3600:
        return _MEM_HIST["serie"]
    filas = None
    try:
        with open(_ARCHIVO_HISTORICO, encoding="utf-8") as fh:
            reg = _json.load(fh)
        if ahora - float(reg.get("ts", 0)) < 24 * 3600:
            filas = reg.get("filas")
    except Exception:
        pass
    if not filas:
        token = _banxico_token()
        if token:
            filas = _historico_banxico(token)
            if filas:
                try:
                    _ARCHIVO_HISTORICO.parent.mkdir(parents=True, exist_ok=True)
                    tmp = _ARCHIVO_HISTORICO.with_suffix(".tmp")
                    with open(tmp, "w", encoding="utf-8") as fh:
                        _json.dump({"ts": ahora, "filas": filas}, fh)
                    tmp.replace(_ARCHIVO_HISTORICO)
                except Exception:
                    pass
    if filas:
        serie = pd.Series({pd.Timestamp(f): v for f, v in filas}).sort_index()
    else:
        try:
            df = pd.read_csv(_CSV_HISTORICO, parse_dates=["fecha"])
            serie = df.set_index("fecha")["tasa_pct"].sort_index()
        except Exception:
            serie = pd.Series(dtype=float)
    # Las semanas que falten hasta hoy, con la tasa vigente.
    hoy = pd.Timestamp(datetime.now().date())
    if len(serie) == 0 or serie.index[-1] < hoy - pd.Timedelta(days=7):
        serie.loc[hoy] = cetes_28_pct()[0]
    _MEM_HIST.update(ts=ahora, serie=serie)
    return serie


def cetes_periodo(inicio, fin) -> Optional[Dict[str, Any]]:
    """Lo que pagó CETES 28 días entre `inicio` y `fin`, reinvirtiendo.

    compuesto_pct: rendimiento anual compuesto (comparable con un CAGR).
    promedio_pct:  promedio simple de la tasa (el que va en un Sharpe).
    None si la ventana no se puede medir."""
    try:
        import pandas as pd
        ini, fi = pd.Timestamp(inicio).normalize(), pd.Timestamp(fin).normalize()
        if ini.tzinfo is not None:
            ini = ini.tz_localize(None)
        if fi.tzinfo is not None:
            fi = fi.tz_localize(None)
        if fi <= ini:
            return None
        s = serie_cetes_28()
        clave = (str(ini.date()), str(fi.date()), id(s))
        if clave in _MEMO_PERIODO:
            return _MEMO_PERIODO[clave]
        if len(s) == 0 or s.index[0] > ini:
            return None
        dias = pd.date_range(ini, fi, freq="D")
        r = s.reindex(s.index.union(dias)).ffill().reindex(dias).dropna()
        if len(r) < 2:
            return None
        crec = float((1 + r / 100.0 / 360.0).prod())
        res = {
            "compuesto_pct": round((crec ** (365.0 / len(r)) - 1) * 100, 2),
            "promedio_pct":  round(float(r.mean()), 2),
            "desde": str(ini.date()), "hasta": str(fi.date()),
        }
        if len(_MEMO_PERIODO) > 5000:
            _MEMO_PERIODO.clear()
        _MEMO_PERIODO[clave] = res
        return res
    except Exception:
        return None


def tasa_libre_periodo(inicio, fin, compuesta: bool = False) -> float:
    """CETES 28 días de la ventana, como FRACCIÓN. compuesta=False: promedio
    simple (va con un rendimiento anualizado por media aritmética, ×252);
    compuesta=True: rendimiento anual compuesto (va con un CAGR o con (1+μ)^252−1).
    Si la ventana no se puede medir, la tasa vigente."""
    c = cetes_periodo(inicio, fin)
    if not c:
        return tasa_libre_mx()
    return (c["compuesto_pct"] if compuesta else c["promedio_pct"]) / 100.0


# ---- Curvas de rendimiento (US vía FRED + MX vía CETES) ---------------------

def _fred_key() -> Optional[str]:
    return os.environ.get("FRED_API_KEY")


# Tesoro de EE.UU. — Constant Maturity (FRED). (plazo, años, series_id)
FRED_CURVA_US = [
    ("1M",  1/12,  "DGS1MO"),
    ("3M",  0.25,  "DGS3MO"),
    ("6M",  0.5,   "DGS6MO"),
    ("1A",  1.0,   "DGS1"),
    ("2A",  2.0,   "DGS2"),
    ("3A",  3.0,   "DGS3"),
    ("5A",  5.0,   "DGS5"),
    ("7A",  7.0,   "DGS7"),
    ("10A", 10.0,  "DGS10"),
    ("20A", 20.0,  "DGS20"),
    ("30A", 30.0,  "DGS30"),
]

# CETES (Banxico) — el corto plazo de la curva MX. (plazo, años, key de obtener_cetes)
CETES_CURVA_MX = [
    ("28d",  28/365,  "28"),
    ("91d",  91/365,  "91"),
    ("182d", 182/365, "182"),
    ("364d", 364/365, "364"),
]

# Cache en memoria (las curvas cambian 1 vez al día como mucho).
_CURVA_CACHE: Dict[str, Any] = {}
_CURVA_TTL = 12 * 60 * 60   # 12 horas


def _fred_ultimo_valor(series_id: str, key: str) -> Optional[Dict[str, Any]]:
    """Último valor válido de una serie FRED (salta los '.' de días sin dato)."""
    try:
        url = ("https://api.stlouisfed.org/fred/series/observations"
               f"?series_id={series_id}&api_key={key}&file_type=json"
               "&sort_order=desc&limit=8")
        r = requests.get(url, timeout=12)
        if r.status_code != 200:
            return None
        for obs in r.json().get("observations", []):
            v = obs.get("value")
            if v not in (None, "", "."):
                try:
                    return {"tasa": float(v), "fecha": obs.get("date")}
                except (TypeError, ValueError):
                    continue
    except Exception:
        return None
    return None


def obtener_curva_us() -> Dict[str, Any]:
    """Curva del Tesoro de EE.UU. (1M→30A) desde FRED. Requiere FRED_API_KEY."""
    key = _fred_key()
    if not key:
        return {"ok": False, "puntos": [], "fuente": "fred",
                "nota": "Falta FRED_API_KEY para la curva del Tesoro de EE.UU."}

    puntos: List[Dict[str, Any]] = []
    fecha = None
    # En paralelo: 11 series, rápido.
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_fred_ultimo_valor, sid, key): (plazo, anios)
                for (plazo, anios, sid) in FRED_CURVA_US}
        res = {}
        for fut in as_completed(futs):
            plazo, anios = futs[fut]
            d = fut.result()
            if d:
                res[plazo] = (anios, d)
    for (plazo, anios, _sid) in FRED_CURVA_US:
        if plazo in res:
            anios_v, d = res[plazo]
            puntos.append({"plazo": plazo, "anios": round(anios_v, 3), "tasa": round(d["tasa"], 2)})
            fecha = fecha or d["fecha"]
    if not puntos:
        return {"ok": False, "puntos": [], "fuente": "fred",
                "nota": "FRED no devolvió datos (¿key inválida?)."}
    return {"ok": True, "puntos": puntos, "fecha": fecha, "fuente": "FRED · US Treasury"}


def obtener_curva_mx() -> Dict[str, Any]:
    """Curva CETES (corto plazo MX) reusando obtener_cetes() (Banxico SIE)."""
    cetes = obtener_cetes()
    tasas = cetes.get("tasas", {})
    puntos: List[Dict[str, Any]] = []
    fecha = None
    for (plazo, anios, key) in CETES_CURVA_MX:
        t = tasas.get(key)
        if t and isinstance(t.get("tasa_pct"), (int, float)):
            puntos.append({"plazo": plazo, "anios": round(anios, 3),
                           "tasa": round(float(t["tasa_pct"]), 2)})
            fecha = fecha or t.get("fecha")
    fuente = "Banxico SIE · CETES" if cetes.get("fuente") == "banxico_sie" else "CETES (respaldo)"
    return {"ok": bool(puntos), "puntos": puntos, "fecha": fecha, "fuente": fuente}


def obtener_curvas() -> Dict[str, Any]:
    """Curvas US (Tesoro/FRED) + MX (CETES/Banxico) con cache de 12h."""
    import time
    c = _CURVA_CACHE.get("data")
    if c and (time.time() - c["ts"]) < _CURVA_TTL:
        return c["payload"]
    payload = {
        "ok": True,
        "us": obtener_curva_us(),
        "mx": obtener_curva_mx(),
        "actualizado": _ahora_cdmx_iso(),
    }
    _CURVA_CACHE["data"] = {"ts": time.time(), "payload": payload}
    return payload


# ---- API agregada -----------------------------------------------------------

def obtener_panel_renta_fija() -> Dict[str, Any]:
    fibras = obtener_fibras()
    cetes = obtener_cetes()

    # Promedio de yield FIBRAs (solo las OK y con yield)
    yields = [f.get("dividend_yield") for f in fibras if f.get("ok") and isinstance(f.get("dividend_yield"), (int, float)) and f["dividend_yield"] > 0]
    yield_prom = (sum(yields) / len(yields)) if yields else None

    # Comparación con CETE 28
    cete28 = cetes.get("tasas", {}).get("28", {}).get("tasa_pct")
    spread = None
    if yield_prom is not None and cete28 is not None:
        spread = yield_prom * 100 - cete28  # yield viene como fracción

    # Avisos
    avisos: List[str] = []
    if cete28 is not None:
        avisos.append(
            f"CETES a 28 días están en {cete28:.2f}%. "
            "Representan el rendimiento sin riesgo de crédito en MXN."
        )
    if yield_prom is not None and cete28 is not None:
        if spread > 2:
            avisos.append(
                f"Las FIBRAS pagan en promedio {yield_prom*100:.2f}%, "
                f"{spread:.2f} puntos arriba de CETES 28d. "
                "Compensación atractiva por el riesgo inmobiliario."
            )
        elif spread > 0:
            avisos.append(
                f"FIBRAS rinden en promedio {yield_prom*100:.2f}% vs {cete28:.2f}% de CETES. "
                "Spread pequeño — considera si el riesgo extra vale la pena."
            )
        else:
            avisos.append(
                "Las FIBRAS en promedio rinden menos que CETES. "
                "Analiza bien antes de asumir riesgo inmobiliario."
            )

    return {
        "fibras":              fibras,
        "cetes":               cetes,
        "yield_fibras_prom":   yield_prom,
        "spread_vs_cetes_28":  spread,
        "avisos":              avisos,
        "generado":            _ahora_cdmx_iso(),
    }


if __name__ == "__main__":
    import json
    panel = obtener_panel_renta_fija()
    # Resumen
    print("CETES:")
    for plazo, d in panel["cetes"]["tasas"].items():
        print(f"  {plazo} días: {d['tasa_pct']:.2f}% ({d['fuente']})")
    print(f"\nFIBRAS analizadas: {len(panel['fibras'])}")
    ok = [f for f in panel["fibras"] if f.get("ok")]
    print(f"OK: {len(ok)}")
    print(f"Yield prom: {panel.get('yield_fibras_prom')}")
    print(f"Spread vs CETES 28: {panel.get('spread_vs_cetes_28')}")
