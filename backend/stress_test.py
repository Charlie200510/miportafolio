"""
stress_test.py — Aplica shocks de escenario a un portafolio actual.

Diferente al backtest (que usa la HISTORIA real): aquí simulamos qué
pasaría HOY si ocurriera un shock similar a uno histórico, aplicando
betas/correlaciones a las posiciones actuales.

Escenarios:
  - covid_2020:    -34% S&P, -28% IPC, +40% USD
  - lehman_2008:   -38% S&P, -42% IPC, +20% USD
  - dotcom_2000:   -45% NASDAQ-100, -10% S&P, neutro USD
  - rate_shock:    +200bp tasas, -15% acciones long-duration
  - inflacion_alta: +500bp tasas, -10% acciones, +20% commodities
  - peso_collapse: USD/MXN +30%, IPC -15% en USD terms
  - custom:        el usuario define sus propios shocks por sector

Devuelve estimación del impacto en cada posición y total del portafolio.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


_BACKEND_DIR = Path(__file__).parent
_UNIV_CSV = _BACKEND_DIR / "universo_precios.csv"
_INFO_JSON = _BACKEND_DIR / "universo_info.json"


# Escenarios predefinidos. Cada shock se aplica al ticker según su clasificación.
# Las claves de "shocks" son criterios; la app calcula impacto por ticker
# usando metadata (sector, moneda, beta estimado).
ESCENARIOS = {
    "covid_2020": {
        "nombre": "COVID Crash (Mar 2020)",
        "emoji": "😷",
        "descripcion": "El crash más rápido de la historia. -34% S&P en 33 días, -28% IPC, peso a 25.50.",
        "duracion": "5-6 semanas",
        "shocks_default": {
            "Technology":         -0.30,
            "Consumer Cyclical":  -0.40,
            "Financial Services": -0.35,
            "Energy":             -0.55,
            "Healthcare":         -0.18,
            "Communication Services": -0.25,
            "Industrials":        -0.35,
            "Real Estate":        -0.40,
            "Consumer Defensive": -0.15,
            "Utilities":          -0.20,
            "Basic Materials":    -0.30,
            "Criptomoneda":       -0.50,
            "ETF / Índice":       -0.30,
            "default":            -0.30,
        },
        "shock_mxn":  -0.10,   # peso se devalúa, MXN baja en USD
        "shock_usd":   0.10,   # USD sube
    },
    "lehman_2008": {
        "nombre": "Crisis Financiera 2008",
        "emoji": "🏦",
        "descripcion": "Quiebra Lehman Brothers. -38% S&P en 6 meses, -42% IPC, USD/MXN +20%.",
        "duracion": "6-12 meses",
        "shocks_default": {
            "Financial Services": -0.55,
            "Real Estate":        -0.50,
            "Consumer Cyclical":  -0.40,
            "Energy":             -0.45,
            "Industrials":        -0.40,
            "Technology":         -0.35,
            "Communication Services": -0.30,
            "Healthcare":         -0.20,
            "Consumer Defensive": -0.15,
            "Utilities":          -0.25,
            "Basic Materials":    -0.40,
            "Criptomoneda":       -0.60,
            "ETF / Índice":       -0.38,
            "default":            -0.35,
        },
        "shock_mxn":  -0.15,
        "shock_usd":   0.18,
    },
    "dotcom_2000": {
        "nombre": "Crisis Punto-com (2000-2002)",
        "emoji": "💻",
        "descripcion": "Burbuja tech revienta. -78% NASDAQ-100, -45% S&P, IPC -22%.",
        "duracion": "24-30 meses",
        "shocks_default": {
            "Technology":         -0.65,
            "Communication Services": -0.55,
            "Consumer Cyclical":  -0.30,
            "Financial Services": -0.25,
            "Healthcare":         -0.10,
            "Energy":              0.20,   # subió en esa era
            "Industrials":        -0.20,
            "Consumer Defensive":  0.05,
            "Utilities":          -0.05,
            "Real Estate":        -0.10,
            "Basic Materials":     0.15,
            "Criptomoneda":       -0.50,   # no existían pero asumimos colapso correlacionado
            "ETF / Índice":       -0.40,
            "default":            -0.25,
        },
        "shock_mxn":  -0.05,
        "shock_usd":   0.05,
    },
    "rate_shock": {
        "nombre": "Subida abrupta de tasas (+200bp)",
        "emoji": "📈",
        "descripcion": "La Fed/Banxico sube tasas 200bp en un trimestre. Activos long-duration sufren más.",
        "duracion": "3-6 meses",
        "shocks_default": {
            "Technology":         -0.22,
            "Communication Services": -0.20,
            "Consumer Cyclical":  -0.18,
            "Real Estate":        -0.25,
            "Utilities":          -0.15,
            "Financial Services":  0.08,   # bancos se benefician
            "Energy":              0.05,
            "Healthcare":         -0.10,
            "Consumer Defensive": -0.08,
            "Industrials":        -0.12,
            "Basic Materials":    -0.12,
            "Criptomoneda":       -0.30,
            "ETF / Índice":       -0.15,
            "default":            -0.15,
        },
        "shock_mxn":   0.05,   # peso se aprecia con tasas altas Banxico
        "shock_usd":  -0.03,
    },
    "inflacion_alta": {
        "nombre": "Inflación 2022 (Volcker 2.0)",
        "emoji": "🔥",
        "descripcion": "Inflación >7%, Fed sube +500bp. S&P -19%, NASDAQ -33%, commodities suben.",
        "duracion": "12 meses",
        "shocks_default": {
            "Technology":         -0.30,
            "Communication Services": -0.35,
            "Consumer Cyclical":  -0.25,
            "Real Estate":        -0.28,
            "Utilities":          -0.10,
            "Financial Services": -0.15,
            "Energy":              0.40,
            "Healthcare":         -0.05,
            "Consumer Defensive":  0.00,
            "Industrials":        -0.10,
            "Basic Materials":     0.15,
            "Criptomoneda":       -0.65,
            "ETF / Índice":       -0.18,
            "default":            -0.18,
        },
        "shock_mxn":   0.02,
        "shock_usd":  -0.02,
    },
    "peso_collapse": {
        "nombre": "Crisis del peso (-30%)",
        "emoji": "🇲🇽",
        "descripcion": "USD/MXN sube 30%. Activos en MXN pierden valor en USD; activos USD se aprecian.",
        "duracion": "1-3 meses",
        "shocks_default": {
            # En MXN los precios se aguantan; en USD pierden ~25%
            "default":            0.0,
            "Criptomoneda":       0.0,
            "ETF / Índice":       0.0,
        },
        "shock_mxn":  -0.25,   # MXN cae 25% en USD terms
        "shock_usd":   0.30,   # USD sube 30%
    },
}


def _cargar_universo() -> tuple[Optional[pd.DataFrame], dict]:
    import json as _json
    info = {}
    if _INFO_JSON.exists():
        try:
            info = _json.loads(_INFO_JSON.read_text(encoding="utf-8"))
        except Exception:
            info = {}
    precios = None
    if _UNIV_CSV.exists():
        try:
            precios = pd.read_csv(_UNIV_CSV, index_col=0, parse_dates=True)
        except Exception:
            precios = None
    return precios, info


def _shock_ticker(ticker: str, info_t: dict, escenario: dict) -> float:
    """Calcula el shock que aplica a un ticker en un escenario."""
    # Sector-based
    sector = info_t.get("sector") or ""
    moneda = (info_t.get("moneda") or "").upper()
    shocks = escenario["shocks_default"]
    shock_sector = shocks.get(sector, shocks["default"])

    # Ajuste por moneda (acciones MXN sufren extra si MXN cae; acciones USD ganan)
    if moneda == "MXN":
        shock_moneda = escenario.get("shock_mxn", 0)
    elif moneda == "USD":
        shock_moneda = escenario.get("shock_usd", 0)
    else:
        shock_moneda = 0.0

    # Combinación: shocks compuestos (1+sec)*(1+mon) - 1
    return (1 + shock_sector) * (1 + shock_moneda) - 1


def correr_stress_test(tickers: list[str], pesos: dict[str, float],
                        precios_actuales: Optional[dict[str, float]] = None,
                        escenario: str = "covid_2020",
                        montos: Optional[dict[str, float]] = None) -> dict:
    """
    Args:
      tickers: tickers del portafolio
      pesos: dict {ticker: peso pp 0-100}
      precios_actuales: opcional, precios actuales en moneda local
      escenario: clave de ESCENARIOS o 'custom'
      montos: opcional, monto invertido en cada ticker (en MXN equivalente)
    """
    if escenario not in ESCENARIOS:
        raise ValueError(f"Escenario desconocido: {escenario}")

    cfg = ESCENARIOS[escenario]
    _, info = _cargar_universo()

    # Normalizar pesos a fracción
    suma = sum(pesos.get(t, 0) for t in tickers)
    if suma <= 0:
        pesos_frac = {t: 1.0 / len(tickers) for t in tickers}
    else:
        pesos_frac = {t: pesos.get(t, 0) / suma for t in tickers}

    # Aplicar shock por ticker
    impactos = []
    impacto_total = 0.0
    for t in tickers:
        info_t = info.get(t, {})
        shock = _shock_ticker(t, info_t, cfg)
        peso = pesos_frac.get(t, 0)
        contrib = shock * peso  # contribución al cambio total del portafolio
        impacto_total += contrib

        precio_actual = (precios_actuales or {}).get(t) or info_t.get("precio_actual")
        precio_post = round(precio_actual * (1 + shock), 4) if isinstance(precio_actual, (int, float)) else None

        impactos.append({
            "ticker":         t,
            "nombre":         info_t.get("nombre", t),
            "sector":         info_t.get("sector", "—"),
            "moneda":         info_t.get("moneda", "—"),
            "peso_pct":       round(peso * 100, 2),
            "shock_pct":      round(shock * 100, 2),
            "contribucion_pct": round(contrib * 100, 2),
            "precio_actual":  precio_actual,
            "precio_post":    precio_post,
        })

    # Ordenar por mayor impacto negativo
    impactos.sort(key=lambda x: x["contribucion_pct"])

    # Si dieron montos, calcular pérdida en MXN
    perdida_mxn = None
    if montos:
        perdida_mxn = 0.0
        for t in tickers:
            m = montos.get(t, 0)
            shock = next((i["shock_pct"] for i in impactos if i["ticker"] == t), 0) / 100
            perdida_mxn += m * shock

    return {
        "ok": True,
        "escenario": {
            "id":          escenario,
            "nombre":      cfg["nombre"],
            "emoji":       cfg["emoji"],
            "descripcion": cfg["descripcion"],
            "duracion":    cfg["duracion"],
            "shock_mxn_pct": round(cfg.get("shock_mxn", 0) * 100, 1),
            "shock_usd_pct": round(cfg.get("shock_usd", 0) * 100, 1),
        },
        "impactos":         impactos,
        "impacto_total_pct": round(impacto_total * 100, 2),
        "perdida_estimada_mxn": round(perdida_mxn, 2) if perdida_mxn is not None else None,
        "presets":          {k: {"nombre": v["nombre"], "emoji": v["emoji"],
                                  "descripcion": v["descripcion"]} for k,v in ESCENARIOS.items()},
    }


def listar_escenarios() -> dict:
    return {k: {"nombre": v["nombre"], "emoji": v["emoji"],
                "descripcion": v["descripcion"], "duracion": v["duracion"]}
            for k,v in ESCENARIOS.items()}


if __name__ == "__main__":
    import json
    res = correr_stress_test(
        tickers=["NVDA", "MSFT", "WALMEX.MX"],
        pesos={"NVDA": 50, "MSFT": 30, "WALMEX.MX": 20},
        escenario="covid_2020",
    )
    print(json.dumps(res, indent=2, default=str)[:1500])
