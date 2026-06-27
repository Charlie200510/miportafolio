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

# Fallback manual (actualizable por env). Abril 2026 — referencia aproximada.
CETES_FALLBACK_DEFAULT = {
    "28":  9.50,
    "91":  9.25,
    "182": 9.10,
    "364": 9.00,
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


def obtener_cetes() -> Dict[str, Any]:
    """Devuelve tasas CETES por plazo. Intenta Banxico SIE, luego fallback."""
    token = _banxico_token()
    if token:
        tasas = _obtener_cetes_sie(token)
        if tasas:
            return {
                "tasas": tasas,
                "fuente": "banxico_sie",
                "actualizado": datetime.now().isoformat(timespec="seconds"),
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
        "actualizado": datetime.now().isoformat(timespec="seconds"),
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
        "generado":            datetime.now().isoformat(timespec="seconds"),
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
