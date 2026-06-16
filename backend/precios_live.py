"""
precios_live.py — Endpoint ligero para refresh de precios en tiempo cuasi-real.

Filosofía:
- yfinance.fast_info devuelve el último precio reportado por Yahoo (15-20 min
  delay para US equities, similar para MX). Es lo más rápido que ofrece yfinance.
- Para evitar bombardear yfinance con N requests por usuario activo, cacheamos
  cada precio individual por 30 segundos.
- El frontend hace polling cada 30 seg solo cuando la pestaña está visible.
- Markets cerrados (sab/dom) → cache 1h, polling pausado en frontend.

Comparado con WebSockets de verdad: WS requiere mantener conexiones abiertas,
worker eventlet/gevent, y se rompe en Render free tier cuando el servidor
duerme. Polling con cache 30s es ~equivalente en UX, sin esa fragilidad.
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

import yfinance as yf


_BACKEND_DIR = Path(__file__).parent
_CACHE_DIR = _BACKEND_DIR / "_cache_precios_live"
_CACHE_DIR.mkdir(exist_ok=True)

# Cache en memoria — key: ticker, value: {ts, precio, prev_close, change_pct}
_CACHE: Dict[str, Dict[str, Any]] = {}
_LOCK = Lock()

TTL_MERCADO_ABIERTO = 30          # 30 seg cuando mercados abiertos
TTL_MERCADO_CERRADO = 60 * 60     # 1 h cuando cerrados


# ─────────────────────────────────────────────────────────
# Detectar si mercados están abiertos
# ─────────────────────────────────────────────────────────
def _markets_abiertos(ticker: str) -> bool:
    """Heurística: lun-vie 09:30-16:00 hora local del mercado."""
    now = datetime.now()
    if now.weekday() >= 5:        # sábado o domingo
        return False
    # NYSE (US): 9:30-16:00 ET
    # BMV (MX): 8:30-15:00 CT (mismas horas que NYSE en ET porque +0 vs ET)
    # Crypto: 24/7
    t = (ticker or "").upper()
    if t.endswith("-USD") or t.endswith("-USDT"):
        return True
    # Para acciones, ventana amplia 8:30-15:30 hora MX (que cubre NY pre/after)
    h = now.hour
    return 8 <= h <= 16


def _ttl_para(ticker: str) -> int:
    return TTL_MERCADO_ABIERTO if _markets_abiertos(ticker) else TTL_MERCADO_CERRADO


# ─────────────────────────────────────────────────────────
# Cache helpers
# ─────────────────────────────────────────────────────────
def _cache_get(ticker: str) -> Optional[Dict[str, Any]]:
    ttl = _ttl_para(ticker)
    with _LOCK:
        c = _CACHE.get(ticker)
        if c and (time.time() - c["ts"]) < ttl:
            return c
    return None


def _cache_set(ticker: str, data: Dict[str, Any]) -> None:
    with _LOCK:
        _CACHE[ticker] = {**data, "ts": time.time()}


# ─────────────────────────────────────────────────────────
# Fetch de un ticker
# ─────────────────────────────────────────────────────────
def _fetch_uno(ticker: str) -> Dict[str, Any]:
    """Devuelve {precio, prev_close, change, change_pct, moneda}."""
    cached = _cache_get(ticker)
    if cached:
        return {**cached, "cached": True}

    try:
        t = yf.Ticker(ticker)
        # fast_info es ~10x más rápido que info, y suficiente para precio actual
        info = t.fast_info

        precio = float(info.get("last_price") or info.get("lastPrice") or 0)
        if not precio:
            return {"ok": False, "error": f"sin precio para {ticker}"}

        prev = float(info.get("previous_close") or info.get("previousClose") or 0)
        change = precio - prev if prev else 0
        change_pct = (change / prev * 100) if prev else 0
        moneda = info.get("currency") or ("MXN" if ticker.upper().endswith(".MX") else "USD")

        out = {
            "ok":         True,
            "ticker":     ticker,
            "precio":     round(precio, 4),
            "prev_close": round(prev, 4) if prev else None,
            "change":     round(change, 4),
            "change_pct": round(change_pct, 4),
            "moneda":     moneda,
            "cached":     False,
        }
        _cache_set(ticker, out)
        return out
    except Exception as e:
        return {"ok": False, "error": f"error fetching {ticker}: {e}"}


# ─────────────────────────────────────────────────────────
# Entry point — batch
# ─────────────────────────────────────────────────────────
def precios_live(tickers: List[str]) -> Dict[str, Any]:
    """Devuelve precios actuales para una lista de tickers."""
    tickers = [t.strip().upper() for t in (tickers or []) if t and t.strip()]
    if not tickers:
        return {"ok": False, "error": "Lista de tickers vacía"}
    # Limita a 30 por request para no saturar
    if len(tickers) > 30:
        tickers = tickers[:30]

    out = {}
    for t in tickers:
        out[t] = _fetch_uno(t)

    return {
        "ok":     True,
        "ts":     int(time.time()),
        "precios": out,
        "mercados_abiertos": _markets_abiertos("AAPL"),  # proxy general
    }
