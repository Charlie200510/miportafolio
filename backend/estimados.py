"""
estimados.py — Consenso de analistas + próximos earnings vía Finnhub.

Finnhub (tier gratis, 60 req/min) cubre principalmente acciones de EE.UU.:
  - /stock/recommendation  → tendencia de recomendaciones (buy/hold/sell)
  - /stock/price-target    → objetivo de precio (a veces premium → se omite)
  - /calendar/earnings     → próximas fechas de reporte + EPS estimado

Para acciones .MX Finnhub casi no trae datos → se devuelve vacío y la UI lo
indica. Las fechas de earnings de México ya se cubren con yfinance (calendario.py).

Todo best-effort: si falta la key o la red falla, devuelve estructura vacía
sin romper nada. Cachea por ticker (6h) para respetar el rate-limit.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import requests

_BASE = "https://finnhub.io/api/v1"
_CACHE: Dict[str, Any] = {}
_TTL = 6 * 60 * 60   # 6 horas


def _key() -> Optional[str]:
    return os.environ.get("FINNHUB_API_KEY")


def _get(path: str, params: Dict[str, Any]) -> Optional[Any]:
    key = _key()
    if not key:
        return None
    params = dict(params)
    params["token"] = key
    try:
        r = requests.get(f"{_BASE}{path}", params=params, timeout=12)
        if r.status_code != 200:   # 401/403 (sin acceso/premium), 429 (rate-limit)
            return None
        return r.json()
    except Exception:
        return None


def _recomendaciones(ticker: str) -> Optional[Dict[str, Any]]:
    data = _get("/stock/recommendation", {"symbol": ticker})
    if not isinstance(data, list) or not data:
        return None
    # El más reciente (Finnhub lo regresa ordenado desc, pero ordenamos por si acaso)
    data.sort(key=lambda d: d.get("period", ""), reverse=True)
    r = data[0]
    sb = int(r.get("strongBuy") or 0)
    b  = int(r.get("buy") or 0)
    h  = int(r.get("hold") or 0)
    s  = int(r.get("sell") or 0)
    ss = int(r.get("strongSell") or 0)
    total = sb + b + h + s + ss
    if total == 0:
        return None
    # Veredicto simple por mayoría ponderada
    score = (sb * 2 + b - s - ss * 2)
    if score > total * 0.4:
        veredicto = "Compra fuerte"
    elif score > 0:
        veredicto = "Compra"
    elif score < -total * 0.4:
        veredicto = "Venta"
    elif score < 0:
        veredicto = "Reducir"
    else:
        veredicto = "Mantener"
    return {
        "periodo": r.get("period"),
        "strong_buy": sb, "buy": b, "hold": h, "sell": s, "strong_sell": ss,
        "total_analistas": total,
        "veredicto": veredicto,
    }


def _price_target(ticker: str) -> Optional[Dict[str, Any]]:
    data = _get("/stock/price-target", {"symbol": ticker})
    if not isinstance(data, dict) or not data.get("targetMean"):
        return None
    return {
        "objetivo_medio":   data.get("targetMean"),
        "objetivo_mediana": data.get("targetMedian"),
        "objetivo_alto":    data.get("targetHigh"),
        "objetivo_bajo":    data.get("targetLow"),
        "actualizado":      data.get("lastUpdated"),
    }


def _proximos_earnings(ticker: str) -> Optional[Dict[str, Any]]:
    hoy = datetime.utcnow().date()
    params = {
        "symbol": ticker,
        "from": hoy.isoformat(),
        "to": (hoy + timedelta(days=120)).isoformat(),
    }
    data = _get("/calendar/earnings", params)
    cal = (data or {}).get("earningsCalendar") if isinstance(data, dict) else None
    if not cal:
        return None
    cal.sort(key=lambda d: d.get("date", ""))
    e = cal[0]
    return {
        "fecha":          e.get("date"),
        "eps_estimado":   e.get("epsEstimate"),
        "ingresos_estim": e.get("revenueEstimate"),
        "hora":           e.get("hour"),   # bmo=antes de abrir, amc=después de cerrar
        "trimestre":      e.get("quarter"),
        "anio":           e.get("year"),
    }


def estimados_para(ticker: str) -> Dict[str, Any]:
    """Consenso + objetivo de precio + próximos earnings de un ticker."""
    ticker = (ticker or "").upper().strip()
    if not ticker:
        return {"ok": False, "error": "ticker vacío"}

    ck = f"est_{ticker}"
    c = _CACHE.get(ck)
    if c and (time.time() - c["ts"]) < _TTL:
        return c["data"]

    if not _key():
        out = {"ok": False, "disponible": False,
                "nota": "Falta FINNHUB_API_KEY para consenso de analistas."}
        return out

    es_mx = ticker.endswith(".MX")
    rec = None if es_mx else _recomendaciones(ticker)
    pt  = None if es_mx else _price_target(ticker)
    ear = None if es_mx else _proximos_earnings(ticker)

    disponible = any([rec, pt, ear])
    out = {
        "ok": True,
        "ticker": ticker,
        "disponible": disponible,
        "recomendaciones": rec,
        "price_target": pt,
        "proximos_earnings": ear,
        "fuente": "Finnhub",
        "nota": ("Finnhub (gratis) cubre acciones de EE.UU.; para .MX usa la fecha "
                 "de earnings de la sección de análisis." if es_mx and not disponible
                 else None),
    }
    _CACHE[ck] = {"ts": time.time(), "data": out}
    return out
