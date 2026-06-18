"""
data_fallback.py — Respaldo de datos cuando yfinance falla o no trae el ticker.

Orden de respaldo (lo usa fundamentals._fundamentals_ticker):
  1. Caché en base de datos (self-healing): cada fetch BUENO de yfinance se
     guarda y se sirve cuando Yahoo falla. Cubre TODO, incluidas las acciones
     mexicanas (.MX) que ningún proveedor gratis externo cubre bien. Es una
     consulta por ticker (no carga nada en memoria; no afecta el arranque).
  2. Proveedor externo gratis — SOLO EE.UU./cripto (no México):
       - Alpha Vantage (OVERVIEW): fundamentales.  Env: ALPHAVANTAGE_API_KEY
       - Stooq (CSV, sin API key): precio de respaldo.

Todo es best-effort: si la BD o la red fallan, devuelve None sin romper nada.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

try:
    from . import db as _db  # type: ignore
except Exception:  # pragma: no cover
    import db as _db  # type: ignore


_AV_KEY = os.environ.get("ALPHAVANTAGE_API_KEY")
_AV_URL = "https://www.alphavantage.co/query"

_tabla_lista = False
_tabla_lock = threading.Lock()


def _es_mx_o_cripto(ticker: str) -> bool:
    t = (ticker or "").upper()
    return t.endswith(".MX") or "-USD" in t or "-USDT" in t or t.startswith("X:")


# ----------------------------------------------------------------------------
#  Caché en base de datos (self-healing) — cubre TODO, incluido México
# ----------------------------------------------------------------------------
def _ensure_tabla() -> bool:
    global _tabla_lista
    if _tabla_lista:
        return True
    with _tabla_lock:
        if _tabla_lista:
            return True
        try:
            with _db.conn() as c:
                cur = c.cursor()
                cur.execute(
                    """CREATE TABLE IF NOT EXISTS fundamentals_cache (
                           ticker     TEXT PRIMARY KEY,
                           data       TEXT NOT NULL,
                           updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                       )"""
                )
            _tabla_lista = True
            return True
        except Exception:
            return False


def guardar_cache(ticker: str, data: Dict[str, Any]) -> None:
    """Guarda (upsert) los fundamentales buenos de un ticker como respaldo."""
    if not ticker or not data:
        return
    if not _ensure_tabla():
        return
    payload = json.dumps(data, default=str, ensure_ascii=False)
    tk = ticker.upper()
    try:
        with _db.conn() as c:
            if _db.USING_PG:
                _db.execute(
                    c,
                    """INSERT INTO fundamentals_cache (ticker, data, updated_at)
                       VALUES (%s, %s, now())
                       ON CONFLICT (ticker)
                       DO UPDATE SET data = EXCLUDED.data, updated_at = now()""",
                    (tk, payload),
                )
            else:
                _db.execute(
                    c,
                    """INSERT OR REPLACE INTO fundamentals_cache (ticker, data, updated_at)
                       VALUES (?, ?, CURRENT_TIMESTAMP)""",
                    (tk, payload),
                )
    except Exception:
        pass


def leer_cache(ticker: str) -> Optional[Dict[str, Any]]:
    """Devuelve la última versión buena guardada de un ticker, o None."""
    if not ticker or not _ensure_tabla():
        return None
    pl = "%s" if _db.USING_PG else "?"
    try:
        with _db.conn() as c:
            row = _db.fetchone(
                c, f"SELECT data FROM fundamentals_cache WHERE ticker = {pl}", (ticker.upper(),)
            )
        if not row or not row.get("data"):
            return None
        data = json.loads(row["data"])
        data["ok"] = True
        data["fuente_respaldo"] = "cache"
        return data
    except Exception:
        return None


# ----------------------------------------------------------------------------
#  Proveedores externos gratis (EE.UU. / cripto — NO México)
# ----------------------------------------------------------------------------
def _http_json(url: str, timeout: int = 15) -> Optional[Dict[str, Any]]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MiPortafolio/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
        return json.loads(body) if body else None
    except Exception:
        return None


def alphavantage_fundamentales(ticker: str) -> Optional[Dict[str, Any]]:
    """Fundamentales de Alpha Vantage (OVERVIEW). Solo EE.UU.; requiere API key."""
    if not _AV_KEY or _es_mx_o_cripto(ticker):
        return None
    url = _AV_URL + "?" + urllib.parse.urlencode(
        {"function": "OVERVIEW", "symbol": ticker.upper(), "apikey": _AV_KEY}
    )
    d = _http_json(url)
    # Respuesta vacía, rate-limit ("Note"/"Information") o símbolo inexistente
    if not d or not d.get("Symbol"):
        return None

    def f(k: str) -> Optional[float]:
        v = d.get(k)
        if v in (None, "", "None", "-", "NaN"):
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    return {
        "ticker":        ticker.upper(),
        "ok":            True,
        "fuente_respaldo": "alphavantage",
        "datos_parciales": False,
        "nombre":        d.get("Name") or ticker.upper(),
        "sector":        d.get("Sector"),
        "industria":     d.get("Industry"),
        "moneda":        d.get("Currency") or "USD",
        "market_cap":    f("MarketCapitalization"),
        "pe_trailing":   f("TrailingPE") or f("PERatio"),
        "pe_forward":    f("ForwardPE"),
        "pb":            f("PriceToBookRatio"),
        "peg":           f("PEGRatio"),
        "roe":           f("ReturnOnEquityTTM"),          # ya viene en fracción
        "dividend_yield": f("DividendYield"),             # ya viene en fracción
        "beta":          f("Beta"),
        "margenes": {
            "neto":      f("ProfitMargin"),
            "operativo": f("OperatingMarginTTM"),
            "bruto":     None,
        },
    }


def stooq_precio(ticker: str) -> Optional[float]:
    """Último cierre vía Stooq (CSV, sin API key). Solo EE.UU."""
    if _es_mx_o_cripto(ticker):
        return None
    sym = ticker.lower()
    if "." not in sym:
        sym = sym + ".us"
    url = f"https://stooq.com/q/l/?s={urllib.parse.quote(sym)}&f=sd2t2ohlcv&h&e=csv"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            txt = resp.read().decode("utf-8", "replace")
        lineas = txt.strip().splitlines()
        if len(lineas) < 2:
            return None
        fila = dict(zip(lineas[0].split(","), lineas[1].split(",")))
        cierre = fila.get("Close")
        if cierre and cierre not in ("N/D", ""):
            return float(cierre)
    except Exception:
        return None
    return None


# ----------------------------------------------------------------------------
#  Entrada principal: recuperar fundamentales cuando yfinance no dio datos
# ----------------------------------------------------------------------------
def fuente_oficial_mx(ticker: str) -> Optional[Dict[str, Any]]:
    """
    HOOK para una fuente oficial mexicana (CNBV/BMV en XBRL), como último
    respaldo cuando Yahoo NO cubre una emisora .MX.

    Hoy es un stub que devuelve None (no rompe nada). Cuando el "reporte de
    huecos" (actualizar_mx_backup.py) muestre qué emisoras importantes faltan,
    aquí se enchufa el parser de XBRL de la CNBV SOLO para esas. El sitio
    bmv.com.mx no se puede scrapear server-side (es 100% JavaScript), por eso
    la fuente correcta son los estados financieros XBRL que las empresas
    presentan ante la CNBV.
    """
    if not (ticker or "").upper().endswith(".MX"):
        return None
    # TODO: implementar parser XBRL CNBV para las emisoras del reporte de huecos.
    return None


def recuperar_fundamentales(ticker: str) -> Optional[Dict[str, Any]]:
    """
    Intenta recuperar fundamentales de respaldo, en orden:
      1) caché en BD (instantáneo, gratis, cubre México — pre-cargado por
         actualizar_mx_backup.py)
      2) Alpha Vantage (solo EE.UU./cripto, rate-limited)
      3) fuente oficial mexicana (CNBV/XBRL) — hook, hoy stub
    Devuelve el dict de fundamentales o None.
    """
    # 1) Caché en BD (última versión buena)
    cached = leer_cache(ticker)
    if cached:
        return cached

    # 2) Proveedor externo (solo EE.UU./cripto)
    ext = alphavantage_fundamentales(ticker)
    if ext and ext.get("ok"):
        if ext.get("precio_actual") is None:
            p = stooq_precio(ticker)
            if p is not None:
                ext["precio_actual"] = p
        return ext

    # 3) Último recurso para .MX: fuente oficial (hook listo, hoy vacío)
    oficial = fuente_oficial_mx(ticker)
    if oficial and oficial.get("ok"):
        return oficial

    return None
