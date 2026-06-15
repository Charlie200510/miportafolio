"""
screener.py — Filtra el universo de tickers por múltiples criterios.

Permite hacer queries tipo "dame todas las acciones MX con yield > 3%,
P/E < 20, beta < 1.2, market cap > $10B". Filtra en memoria los datos
del universo + metadata, sin llamar a yfinance.

Criterios soportados:
  - tipo (acciones, etfs, crypto)
  - mercado (MX, US, internacional)
  - sector (Technology, Financial, etc.)
  - min/max P/E
  - min/max yield
  - min/max beta
  - min/max market cap (en USD)
  - mín. rendimiento 1Y
  - solo recomendadas (top tickers curados)
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import json


_BACKEND_DIR = Path(__file__).parent
_INFO_PATH = _BACKEND_DIR / "info_activos.json"


def _cargar_info() -> Dict[str, Any]:
    """Carga el JSON de info_activos generado por descargar_universo.py."""
    if not _INFO_PATH.exists():
        return {}
    try:
        with open(_INFO_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _detectar_mercado(ticker: str, info: Dict) -> str:
    t = ticker.upper()
    if t.endswith(".MX"):
        return "MX"
    if t.endswith("-USD") or t.endswith("-USDT"):
        return "Crypto"
    if "." in t:
        # Otros sufijos: .TO, .L, .HK, etc.
        return "INTL"
    return "US"


def _es_etf(ticker: str, info: Dict) -> bool:
    t = ticker.upper()
    # Heurística por nombre y por ticker conocido
    etf_known = {"SPY", "VOO", "IVV", "VTI", "QQQ", "XLK", "VXUS", "VEA", "VWO",
                 "EWZ", "EWW", "EWJ", "EWY", "EWU", "EWQ", "EWP", "EWT", "FXI",
                 "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE",
                 "TLT", "BND", "AGG", "HYG", "GLD", "SLV", "GDX", "GDXJ", "USO",
                 "FBTC", "GBTC", "IBIT", "NAFTRAC.MX"}
    if t in etf_known:
        return True
    nombre = (info.get("nombre", "") if info else "").lower()
    return any(kw in nombre for kw in ("etf", "trust", "ishares", "vanguard", "spdr", "fund"))


def filtrar(criterios: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Devuelve lista de tickers que cumplen todos los criterios.

    Criterios soportados (todos opcionales):
      tipo: 'acciones' | 'etfs' | 'crypto'
      mercado: 'MX' | 'US' | 'INTL' | 'Crypto'
      sector: string (case-insensitive substring match)
      pe_min, pe_max: float
      yield_min, yield_max: float (en fracción, 0.03 = 3%)
      beta_min, beta_max: float
      market_cap_min, market_cap_max: float (en USD)
      retorno_1y_min: float
      solo_recomendadas: bool
      limit: int (max resultados, default 100)
    """
    info_all = _cargar_info()
    if not info_all:
        return []

    limit = int(criterios.get("limit", 100))
    resultados = []

    for ticker, info in info_all.items():
        if not isinstance(info, dict):
            continue

        # Detectar tipo y mercado
        mercado = _detectar_mercado(ticker, info)
        es_etf_val = _es_etf(ticker, info)
        es_crypto = mercado == "Crypto"

        if criterios.get("tipo") == "acciones" and (es_etf_val or es_crypto):
            continue
        if criterios.get("tipo") == "etfs" and not es_etf_val:
            continue
        if criterios.get("tipo") == "crypto" and not es_crypto:
            continue

        # Mercado
        if criterios.get("mercado") and mercado != criterios["mercado"]:
            continue

        # Sector
        if criterios.get("sector"):
            s_query = criterios["sector"].lower()
            s_real = (info.get("sector") or "").lower()
            if s_query not in s_real:
                continue

        # P/E
        pe = info.get("pe_trailing") or info.get("pe")
        if criterios.get("pe_min") is not None and (pe is None or pe < criterios["pe_min"]):
            continue
        if criterios.get("pe_max") is not None and (pe is None or pe > criterios["pe_max"]):
            continue

        # Yield (fracción)
        yld = info.get("dividend_yield") or info.get("yield")
        if criterios.get("yield_min") is not None and (yld is None or yld < criterios["yield_min"]):
            continue
        if criterios.get("yield_max") is not None and (yld is None or yld > criterios["yield_max"]):
            continue

        # Beta
        beta = info.get("beta")
        if criterios.get("beta_min") is not None and (beta is None or beta < criterios["beta_min"]):
            continue
        if criterios.get("beta_max") is not None and (beta is None or beta > criterios["beta_max"]):
            continue

        # Market cap
        mc = info.get("market_cap") or info.get("marketCap")
        if criterios.get("market_cap_min") is not None and (mc is None or mc < criterios["market_cap_min"]):
            continue
        if criterios.get("market_cap_max") is not None and (mc is None or mc > criterios["market_cap_max"]):
            continue

        # Retorno 1Y
        r1y = info.get("retorno_1y") or info.get("performance_1y")
        if criterios.get("retorno_1y_min") is not None and (r1y is None or r1y < criterios["retorno_1y_min"]):
            continue

        # Recomendadas
        if criterios.get("solo_recomendadas") and not info.get("recomendada"):
            continue

        resultados.append({
            "ticker":      ticker,
            "nombre":      info.get("nombre"),
            "sector":      info.get("sector"),
            "mercado":     mercado,
            "pe":          pe,
            "yield":       yld,
            "beta":        beta,
            "market_cap":  mc,
            "retorno_1y":  r1y,
            "precio":      info.get("precio"),
            "moneda":      info.get("moneda"),
            "es_etf":      es_etf_val,
            "recomendada": bool(info.get("recomendada")),
        })

    # Ordenar por market cap descendente como default (más relevantes primero)
    resultados.sort(key=lambda x: x.get("market_cap") or 0, reverse=True)
    return resultados[:limit]
