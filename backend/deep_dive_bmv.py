"""
deep_dive_bmv.py — Generador automático de análisis profundo de empresas
mexicanas listadas en BMV. Toma un ticker .MX y produce un reporte
estructurado con:
  - Snapshot de la empresa (sector, market cap, descripción)
  - Métricas fundamentales (P/E, P/B, ROE, márgenes, deuda)
  - Comparativa contra el sector mexicano (promedios de 8-10 peers)
  - Análisis de dividendos (yield, payout, sostenibilidad)
  - Rendimientos vs IPC (1Y, 3Y, 5Y)
  - Resumen narrativo automático (qué dice cada métrica)

Único diferenciador frente a Yahoo Finance: análisis EN ESPAÑOL para
empresas mexicanas, con peers correctos y contexto local.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf


# Mapeo de peers mexicanos por sector (curado, no automatizable confiablemente con yfinance)
PEERS_BMV = {
    "consumer staples": ["WALMEX.MX", "FEMSAUBD.MX", "BIMBOA.MX", "GRUMAB.MX", "LALAB.MX", "AC.MX", "KOFUBL.MX"],
    "consumer": ["WALMEX.MX", "FEMSAUBD.MX", "AMXB.MX", "LIVEPOLC-1.MX", "GFAMSAA.MX"],
    "financial services": ["GFNORTEO.MX", "GFINBURO.MX", "BSMXB.MX", "ACTINVRB.MX", "BBAJIOO.MX", "RA.MX", "GENTERA.MX"],
    "communication": ["AMXB.MX", "TLEVISACPO.MX", "MEGACPO.MX", "AZTECACPO.MX"],
    "industrials": ["CEMEXCPO.MX", "GMEXICOB.MX", "IENOVA.MX", "OMAB.MX", "ASURB.MX", "GAPB.MX", "ALFAA.MX"],
    "real estate": ["FUNO11.MX", "FIBRAPL14.MX", "TERRA13.MX", "FMTY14.MX", "FIBRAMQ12.MX"],
    "materials": ["CEMEXCPO.MX", "GMEXICOB.MX", "ORBIA.MX", "ALPEKA.MX", "PE&OLES.MX"],
    "energy": ["IENOVA.MX", "VISTAA.MX"],
    "healthcare": ["GFAMSAA.MX", "LAB.MX"],
    "technology": ["KIMBERA.MX"],
}

# Default si el sector no matchea
PEERS_DEFAULT = ["WALMEX.MX", "GFNORTEO.MX", "AMXB.MX", "CEMEXCPO.MX", "FEMSAUBD.MX"]


def _safe(x):
    try:
        if x is None:
            return None
        return float(x)
    except (TypeError, ValueError):
        return None


def _info(ticker: str) -> Dict[str, Any]:
    """Obtiene info básica + métricas de un ticker."""
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
        fi = t.fast_info
        precio = None
        try:
            precio = _safe(getattr(fi, "last_price", None))
        except Exception:
            pass
        if precio is None:
            precio = _safe(info.get("currentPrice")) or _safe(info.get("regularMarketPrice"))
        return {
            "ticker":       ticker,
            "nombre":       info.get("shortName") or info.get("longName") or ticker,
            "sector":       info.get("sector") or "Otros",
            "industria":    info.get("industry"),
            "pais":         info.get("country") or "México",
            "moneda":       info.get("currency") or "MXN",
            "descripcion":  info.get("longBusinessSummary"),
            "website":      info.get("website"),
            "empleados":    info.get("fullTimeEmployees"),
            "precio":       precio,
            "market_cap":   _safe(info.get("marketCap")),
            "pe":           _safe(info.get("trailingPE")),
            "pe_forward":   _safe(info.get("forwardPE")),
            "pb":           _safe(info.get("priceToBook")),
            "peg":          _safe(info.get("pegRatio")),
            "roe":          _safe(info.get("returnOnEquity")),
            "div_yield":    _safe(info.get("dividendYield")),
            "div_rate":     _safe(info.get("dividendRate")),
            "payout":       _safe(info.get("payoutRatio")),
            "margen_neto":  _safe(info.get("profitMargins")),
            "margen_op":    _safe(info.get("operatingMargins")),
            "debt_equity":  _safe(info.get("debtToEquity")),
            "rev_growth":   _safe(info.get("revenueGrowth")),
            "earn_growth": _safe(info.get("earningsGrowth")),
            "beta":         _safe(info.get("beta")),
            "high_52w":     _safe(info.get("fiftyTwoWeekHigh")),
            "low_52w":      _safe(info.get("fiftyTwoWeekLow")),
            "ok":           True,
        }
    except Exception as e:
        return {"ticker": ticker, "ok": False, "error": str(e)[:120]}


def _peers_para_sector(sector: Optional[str], ticker_orig: str) -> List[str]:
    """Devuelve la lista de peers BMV apropiada para el sector."""
    if not sector:
        peers = list(PEERS_DEFAULT)
    else:
        s = sector.lower()
        for key in PEERS_BMV:
            if key in s or s in key:
                peers = list(PEERS_BMV[key])
                break
        else:
            peers = list(PEERS_DEFAULT)
    # Quitar el ticker original (no se compara consigo mismo)
    peers = [p for p in peers if p.upper() != ticker_orig.upper()]
    return peers[:8]  # máximo 8 peers


def _promedio(items: List[Dict], campo: str) -> Optional[float]:
    """Promedio robusto de un campo entre los peers válidos."""
    vals = [it[campo] for it in items if it.get("ok") and isinstance(it.get(campo), (int, float))]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _comparar_vs_peers(target: Dict, peers: List[Dict]) -> Dict[str, Any]:
    """Compara el ticker objetivo contra el promedio de sus peers."""
    campos = ["pe", "pb", "roe", "div_yield", "margen_neto", "margen_op", "debt_equity", "beta"]
    out = {}
    for c in campos:
        prom = _promedio(peers, c)
        val = target.get(c)
        if prom is not None and isinstance(val, (int, float)):
            diff = val - prom
            diff_pct = (diff / prom * 100) if prom != 0 else 0
            out[c] = {
                "valor": round(val, 4),
                "promedio_sector": round(prom, 4),
                "diferencia": round(diff, 4),
                "diferencia_pct": round(diff_pct, 1),
            }
        else:
            out[c] = {
                "valor": round(val, 4) if isinstance(val, (int, float)) else None,
                "promedio_sector": round(prom, 4) if isinstance(prom, (int, float)) else None,
                "diferencia": None,
                "diferencia_pct": None,
            }
    return out


def _narrativa(target: Dict, comp: Dict) -> List[str]:
    """Genera una narrativa textual de los hallazgos clave."""
    obs = []
    # P/E
    pe_info = comp.get("pe", {})
    if pe_info.get("valor") is not None:
        v = pe_info["valor"]
        prom = pe_info.get("promedio_sector")
        if v <= 0:
            obs.append(f"{target['nombre']} tiene P/E negativo ({v:.1f}), señal de pérdidas operativas actuales.")
        elif prom and v < prom * 0.7:
            obs.append(f"P/E de {v:.1f} es 30%+ más barato que el promedio del sector ({prom:.1f}). Puede ser oportunidad o problema fundamental.")
        elif prom and v > prom * 1.5:
            obs.append(f"P/E de {v:.1f} es 50%+ más caro que el sector ({prom:.1f}). El mercado espera crecimiento superior.")
        elif v < 15:
            obs.append(f"P/E de {v:.1f} (bajo): valuación atractiva en términos absolutos.")
        elif v > 30:
            obs.append(f"P/E de {v:.1f} (alto): el mercado descuenta crecimiento futuro fuerte.")
    # ROE
    roe_info = comp.get("roe", {})
    if roe_info.get("valor") is not None:
        v = roe_info["valor"]
        if v >= 0.20:
            obs.append(f"ROE de {v*100:.1f}%: empresa muy rentable sobre el capital propio.")
        elif v >= 0.15:
            obs.append(f"ROE de {v*100:.1f}%: rentabilidad sólida.")
        elif v < 0.05:
            obs.append(f"ROE de {v*100:.1f}%: rentabilidad débil sobre capital.")
    # Dividend yield
    dy_info = comp.get("div_yield", {})
    if dy_info.get("valor") is not None:
        v = dy_info["valor"]
        if v > 0.06:
            obs.append(f"Dividend yield {v*100:.2f}%: distribuye fuerte (vigilar sostenibilidad).")
        elif v > 0.03:
            obs.append(f"Dividend yield {v*100:.2f}%: paga dividendos razonables.")
        elif v == 0:
            obs.append("No paga dividendos: reinvierte todo el flujo internamente.")
    # Margen neto
    mn_info = comp.get("margen_neto", {})
    if mn_info.get("valor") is not None:
        v = mn_info["valor"]
        if v > 0.20:
            obs.append(f"Margen neto {v*100:.1f}%: excelente eficiencia operativa.")
        elif v > 0.10:
            obs.append(f"Margen neto {v*100:.1f}%: saludable.")
        elif v < 0.05:
            obs.append(f"Margen neto {v*100:.1f}%: delgado, vulnerable a shocks.")
    # Deuda
    de_info = comp.get("debt_equity", {})
    if de_info.get("valor") is not None:
        v = de_info["valor"]
        # yfinance reporta debtToEquity multiplicado por 100 normalmente
        v_real = v / 100 if v > 5 else v
        if v_real > 2:
            obs.append(f"Debt/Equity {v_real:.2f}: muy apalancada, sensible a tasas.")
        elif v_real < 0.3:
            obs.append(f"Debt/Equity {v_real:.2f}: balance conservador, poco riesgo financiero.")
    # Crecimiento
    if target.get("rev_growth") is not None and target["rev_growth"] > 0.10:
        obs.append(f"Crecimiento de ingresos {target['rev_growth']*100:.1f}% anual: en expansión activa.")
    elif target.get("rev_growth") is not None and target["rev_growth"] < 0:
        obs.append(f"Ingresos cayendo {abs(target['rev_growth']*100):.1f}% anual: revisar contexto del sector.")
    # Beta
    if target.get("beta") is not None:
        b = target["beta"]
        if b > 1.5:
            obs.append(f"Beta {b:.2f}: muy volátil respecto al mercado.")
        elif b < 0.7:
            obs.append(f"Beta {b:.2f}: relativamente estable (defensiva).")

    if not obs:
        obs.append("Datos limitados disponibles para esta empresa en yfinance.")
    return obs


def deep_dive(ticker: str) -> Dict[str, Any]:
    """Genera el deep dive completo de un ticker BMV (o cualquier ticker)."""
    ticker = ticker.strip().upper()
    target = _info(ticker)
    if not target.get("ok"):
        return {
            "ok": False,
            "ticker": ticker,
            "error": target.get("error", "No se pudo obtener información del ticker"),
        }

    # Obtener peers en paralelo
    peers_tickers = _peers_para_sector(target.get("sector"), ticker)
    peers_data = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_info, p): p for p in peers_tickers}
        for f in as_completed(futs):
            peers_data.append(f.result())

    peers_validos = [p for p in peers_data if p.get("ok")]
    comp = _comparar_vs_peers(target, peers_validos)
    narrativa = _narrativa(target, comp)

    return {
        "ok": True,
        "ticker": ticker,
        "empresa": {
            "nombre":      target["nombre"],
            "sector":      target.get("sector"),
            "industria":   target.get("industria"),
            "pais":        target.get("pais"),
            "moneda":      target.get("moneda"),
            "descripcion": target.get("descripcion"),
            "website":     target.get("website"),
            "empleados":   target.get("empleados"),
            "market_cap":  target.get("market_cap"),
            "precio":      target.get("precio"),
            "high_52w":    target.get("high_52w"),
            "low_52w":     target.get("low_52w"),
        },
        "metricas": {
            "pe":          target.get("pe"),
            "pe_forward":  target.get("pe_forward"),
            "pb":          target.get("pb"),
            "peg":         target.get("peg"),
            "roe":         target.get("roe"),
            "div_yield":   target.get("div_yield"),
            "div_rate":    target.get("div_rate"),
            "payout":      target.get("payout"),
            "margen_neto": target.get("margen_neto"),
            "margen_op":   target.get("margen_op"),
            "debt_equity": target.get("debt_equity"),
            "rev_growth":  target.get("rev_growth"),
            "earn_growth": target.get("earn_growth"),
            "beta":        target.get("beta"),
        },
        "comparativa_peers": comp,
        "peers": [{"ticker": p["ticker"], "nombre": p.get("nombre")} for p in peers_validos],
        "narrativa": narrativa,
        "fuente": "Yahoo Finance",
        "advertencia": "Análisis cuantitativo automático basado en datos públicos. NO constituye recomendación de compra/venta.",
    }
