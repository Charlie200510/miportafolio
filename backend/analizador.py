"""
analizador.py — Análisis individual por acción con score 1-100.

Combina tres bloques inspirados en la metodología "Deep Research Report":
  1. Peer Comparison: P/S TTM y forward, EV/EBITDA, gross margin, YoY
     revenue growth y un Value/Growth Score (P/S TTM / revenue growth %).
  2. Deep Dive: business model, moat, catalyst, asymmetry — narrativa
     generada con Claude (opcional, si hay ANTHROPIC_API_KEY).
  3. Short Report: 3 risks (accounting, customer concentration, threats).

El score 1-100 es DETERMINÍSTICO a partir de las métricas cuantitativas
(no depende de la narrativa de la IA), así que siempre regresa un número
aunque Claude no esté configurado.
"""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import yfinance as yf

import fundamentals as _fund


# ============================================================
#  PEERS — competidores por industria (curado para los más comunes)
# ============================================================
_PEERS_CURADO: Dict[str, List[str]] = {
    # Tech mega-caps
    "AAPL":  ["MSFT", "GOOGL"],
    "MSFT":  ["AAPL", "GOOGL"],
    "GOOGL": ["META", "MSFT"],
    "GOOG":  ["META", "MSFT"],
    "META":  ["GOOGL", "SNAP"],
    "AMZN":  ["WMT", "MSFT"],
    "NVDA":  ["AMD", "AVGO"],
    "AMD":   ["NVDA", "INTC"],
    "INTC":  ["AMD", "NVDA"],
    "AVGO":  ["NVDA", "AMD"],
    "NFLX":  ["DIS", "WBD"],
    "TSLA":  ["F", "GM"],
    # Banks USA
    "JPM":   ["BAC", "WFC"],
    "BAC":   ["JPM", "WFC"],
    "WFC":   ["JPM", "BAC"],
    "GS":    ["MS", "JPM"],
    "MS":    ["GS", "JPM"],
    # Consumer staples
    "KO":    ["PEP", "KDP"],
    "PEP":   ["KO", "MNST"],
    "WMT":   ["COST", "TGT"],
    "COST":  ["WMT", "TGT"],
    "PG":    ["UL", "CL"],
    "JNJ":   ["PFE", "MRK"],
    # Energy
    "XOM":   ["CVX", "COP"],
    "CVX":   ["XOM", "COP"],
    # ETFs (peers = otros índices)
    "SPY":   ["VOO", "IVV"],
    "VOO":   ["SPY", "IVV"],
    "QQQ":   ["VGT", "XLK"],
    "VTI":   ["SPY", "ITOT"],
    # MX blue chips
    "WALMEX.MX":   ["SORIANAB.MX", "CHDRAUIB.MX"],
    "FEMSAUBD.MX": ["KOFUBL.MX", "AC.MX"],
    "GFNORTEO.MX": ["BSMXB.MX", "BBAJIOO.MX"],
    "AMXB.MX":     ["TLEVISACPO.MX", "MEGACPO.MX"],
    "NAFTRAC.MX":  ["MEXTRAC.MX"],
    # Crypto (peers = otras layer-1 grandes)
    "BTC-USD":  ["ETH-USD"],
    "ETH-USD":  ["BTC-USD", "SOL-USD"],
    "SOL-USD":  ["ETH-USD", "AVAX-USD"],
    "BNB-USD":  ["ETH-USD", "SOL-USD"],
    "XRP-USD":  ["ADA-USD", "DOGE-USD"],
}


def _peers_de(ticker: str, fund: Dict[str, Any]) -> List[str]:
    """Encuentra hasta 2 peers para un ticker dado."""
    if ticker in _PEERS_CURADO:
        return _PEERS_CURADO[ticker][:2]
    # Fallback: pedir peers vía yfinance
    try:
        tk = yf.Ticker(ticker)
        info = tk.info or {}
        recos = info.get("recommendationKey")  # no sirve, intentamos otra cosa
        # No hay un buen API. Devolvemos vacío.
        _ = recos
    except Exception:
        pass
    return []


# ============================================================
#  PEER COMPARISON
# ============================================================
def _value_growth_score(ps_ttm: Optional[float], rev_growth: Optional[float]) -> Optional[float]:
    """P/S TTM dividido por revenue growth en %. Lower is better.
    rev_growth viene como fracción (0.20 = 20%) — convertimos a %."""
    if ps_ttm is None or rev_growth is None:
        return None
    growth_pct = rev_growth * 100.0
    if growth_pct <= 0:
        return None  # crecimiento nulo/negativo no admite ratio
    return round(ps_ttm / growth_pct, 2)


def _evaluar_value_growth(score: Optional[float]) -> Dict[str, Any]:
    if score is None:
        return {"nivel": "sin_dato", "etiqueta": "Sin dato", "color": "zinc"}
    if score < 0.3:
        return {"nivel": "excelente", "etiqueta": "Crece más de lo que cuesta", "color": "green"}
    if score < 0.6:
        return {"nivel": "bueno",     "etiqueta": "Buen ratio precio/crecimiento", "color": "green"}
    if score < 1.2:
        return {"nivel": "razonable", "etiqueta": "Razonable",                  "color": "blue"}
    if score < 2.5:
        return {"nivel": "caro",      "etiqueta": "Caro vs su crecimiento",    "color": "amber"}
    return {"nivel": "muy_caro",      "etiqueta": "Muy caro vs su crecimiento","color": "red"}


def _ev_ebitda_de(ticker: str) -> Optional[float]:
    """Trata de sacar EV/EBITDA de yfinance.info (campo enterpriseToEbitda)."""
    try:
        info = yf.Ticker(ticker).info or {}
        ev_ebitda = info.get("enterpriseToEbitda")
        if isinstance(ev_ebitda, (int, float)) and ev_ebitda > 0:
            return float(ev_ebitda)
    except Exception:
        pass
    return None


def _ps_de(ticker: str) -> Dict[str, Optional[float]]:
    try:
        info = yf.Ticker(ticker).info or {}
        ps_ttm = info.get("priceToSalesTrailing12Months")
        # Forward P/S no existe directo; lo aproximamos: P/S TTM / (1+rev_growth)
        rev_g = info.get("revenueGrowth")
        ps_fwd = None
        if isinstance(ps_ttm, (int, float)) and isinstance(rev_g, (int, float)) and (1 + rev_g) > 0:
            ps_fwd = round(ps_ttm / (1 + rev_g), 2)
        return {"ps_ttm": ps_ttm, "ps_forward": ps_fwd}
    except Exception:
        return {"ps_ttm": None, "ps_forward": None}


def _peer_row(ticker: str) -> Dict[str, Any]:
    """Métricas mínimas para una fila de peer comparison."""
    fund = _fund._fundamentals_ticker(ticker)
    ps   = _ps_de(ticker)
    ev_ebitda = _ev_ebitda_de(ticker)
    rev_growth = fund.get("revenue_growth")
    gross = (fund.get("margenes") or {}).get("bruto")
    vg_score = _value_growth_score(ps.get("ps_ttm"), rev_growth)
    return {
        "ticker":          ticker,
        "nombre":          fund.get("nombre") or ticker,
        "ps_ttm":          ps.get("ps_ttm"),
        "ps_forward":      ps.get("ps_forward"),
        "ev_ebitda":       ev_ebitda,
        "gross_margin":    gross,
        "rev_growth_yoy":  rev_growth,
        "value_growth_score":   vg_score,
        "value_growth_eval":    _evaluar_value_growth(vg_score),
    }


def _peer_comparison(ticker: str, fund: Dict[str, Any]) -> Dict[str, Any]:
    peers = _peers_de(ticker, fund)
    todos = [ticker] + peers
    filas: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        for fila in ex.map(_peer_row, todos):
            filas.append(fila)
    return {
        "ticker_objetivo": ticker,
        "peers":           peers,
        "filas":           filas,
    }


# ============================================================
#  SCORE 1-100 — formula determinística
# ============================================================
def _norm(val: Optional[float], bueno: float, malo: float) -> float:
    """Normaliza un valor a 0..1, donde 1 = bueno, 0 = malo. Lineal entre los dos extremos."""
    if val is None:
        return 0.5  # neutro si no hay dato
    if bueno > malo:  # mayor = mejor
        if val >= bueno:
            return 1.0
        if val <= malo:
            return 0.0
        return (val - malo) / (bueno - malo)
    else:  # menor = mejor
        if val <= bueno:
            return 1.0
        if val >= malo:
            return 0.0
        return (malo - val) / (malo - bueno)


def _score(fund: Dict[str, Any], peer: Dict[str, Any]) -> Dict[str, Any]:
    """Calcula score 1-100 desglosado por criterio."""
    # Métricas base
    rev_growth = fund.get("revenue_growth")
    gross = (fund.get("margenes") or {}).get("bruto")
    roe   = fund.get("roe")
    debt_eq = fund.get("debt_to_equity")
    pos_52w = fund.get("pos_52w")
    pe = fund.get("pe_trailing")
    ev_ebitda = None
    vg_score = None
    # Tomamos del peer comparison la fila del propio ticker
    for fila in (peer.get("filas") or []):
        if fila["ticker"] == fund.get("ticker"):
            ev_ebitda = fila.get("ev_ebitda")
            vg_score  = fila.get("value_growth_score")
            break

    # ---- Sub-scores 0..1 ------------------------------------------------
    # 1. Value/Growth Score: lower is better. <0.3 excelente, >2.5 muy caro.
    s_vg     = _norm(vg_score, bueno=0.3, malo=2.5)
    # 2. Gross margin: >0.5 excelente, <0.15 malo.
    s_gross  = _norm(gross, bueno=0.50, malo=0.15)
    # 3. Revenue growth YoY: >0.20 excelente, <0 malo.
    s_growth = _norm(rev_growth, bueno=0.20, malo=0.0)
    # 4. EV/EBITDA: <10 excelente, >30 caro.
    s_ev     = _norm(ev_ebitda, bueno=10.0, malo=30.0)
    # 5. ROE: >0.20 excelente, <0 malo.
    s_roe    = _norm(roe, bueno=0.20, malo=0.0)
    # 6. Debt/Equity: <0.5 excelente, >2.0 riesgoso. (yfinance lo devuelve en %.)
    if debt_eq is not None and debt_eq > 5:  # likely viene como % → 50 = 0.5
        debt_eq = debt_eq / 100.0
    s_debt   = _norm(debt_eq, bueno=0.5, malo=2.0)
    # 7. P/E trailing: <15 excelente, >40 caro. Si es <0 (pérdida) → 0.
    if pe is not None and pe <= 0:
        s_pe = 0.0
    else:
        s_pe = _norm(pe, bueno=15.0, malo=40.0)
    # 8. Posición 52w: queremos comprar barato, no en el techo. <0.5 mejor que >0.9.
    s_52w = _norm(pos_52w, bueno=0.30, malo=0.95)

    # ---- Pesos (suman 100) ----------------------------------------------
    pesos = {
        "value_growth":  20,
        "gross_margin":  15,
        "rev_growth":    15,
        "ev_ebitda":     12,
        "roe":           12,
        "debt_equity":   10,
        "pe":             8,
        "pos_52w":        8,
    }
    componentes = {
        "value_growth":  round(s_vg     * pesos["value_growth"],  1),
        "gross_margin":  round(s_gross  * pesos["gross_margin"],  1),
        "rev_growth":    round(s_growth * pesos["rev_growth"],    1),
        "ev_ebitda":     round(s_ev     * pesos["ev_ebitda"],     1),
        "roe":           round(s_roe    * pesos["roe"],           1),
        "debt_equity":   round(s_debt   * pesos["debt_equity"],   1),
        "pe":            round(s_pe     * pesos["pe"],            1),
        "pos_52w":       round(s_52w    * pesos["pos_52w"],       1),
    }
    total = round(sum(componentes.values()), 1)
    # Garantizar 1..100
    total = max(1.0, min(100.0, total))

    if total >= 75:
        veredicto = {"nivel": "muy_recomendable", "etiqueta": "Muy recomendable",  "color": "green"}
    elif total >= 60:
        veredicto = {"nivel": "recomendable",     "etiqueta": "Recomendable",      "color": "green"}
    elif total >= 45:
        veredicto = {"nivel": "neutral",          "etiqueta": "Neutral",           "color": "blue"}
    elif total >= 30:
        veredicto = {"nivel": "poco",             "etiqueta": "Poco recomendable", "color": "amber"}
    else:
        veredicto = {"nivel": "no",               "etiqueta": "No recomendable",   "color": "red"}

    return {
        "score":       total,
        "veredicto":   veredicto,
        "componentes": componentes,
        "pesos":       pesos,
    }


# ============================================================
#  DEEP DIVE & SHORT REPORT — narrativas (Claude API, opcional)
# ============================================================
def _claude_narrativas(ticker: str, fund: Dict[str, Any]) -> Dict[str, Any]:
    """Llama a Claude para generar Deep Dive y Short Report.
    Si no hay API key o falla, regresa textos mínimos basados en datos."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return _narrativa_fallback(ticker, fund)

    nombre = fund.get("nombre") or ticker
    sector = fund.get("sector") or "—"
    industria = fund.get("industria") or "—"

    prompt = f"""Eres un analista de equity research escribiendo un brief para retail mexicano. La acción es **{nombre} ({ticker})**, sector {sector}, industria {industria}.

Devuélveme tu análisis EXCLUSIVAMENTE como JSON válido, con esta forma exacta:

{{
  "deep_dive": {{
    "business_model": "...",
    "moat": "...",
    "catalyst": "...",
    "asymmetry": "..."
  }},
  "short_report": {{
    "accounting": "...",
    "customer_concentration": "...",
    "competitive_threats": "..."
  }}
}}

Requisitos por campo:
- business_model: 2-3 frases. Cómo gana dinero la empresa, en español plano.
- moat: 2-3 frases. Top 3 competidores y si tiene ventaja tecnológica/patente única.
- catalyst: 2-3 frases. Próximos lanzamientos, aprobaciones o partnerships en los siguientes 12 meses.
- asymmetry: 2-3 frases. ¿Hay un piso de valuación bajo y techo de crecimiento alto? ¿Por qué sí o no?
- accounting: 1-2 frases sobre red flags contables conocidos.
- customer_concentration: 1-2 frases sobre dependencia de clientes/regiones (busca en notas 10-K si aplica).
- competitive_threats: 1-2 frases sobre amenazas competitivas concretas.

NO escribas nada antes ni después del JSON. NO uses ```json fences. Sólo el JSON crudo."""

    body = {
        "model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929"),
        "max_tokens": 1200,
        "system": "Eres analista financiero. Responde sólo JSON válido.",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    try:
        import requests
        r = requests.post("https://api.anthropic.com/v1/messages", headers=headers, json=body, timeout=45)
        if r.status_code != 200:
            return _narrativa_fallback(ticker, fund)
        data = r.json()
        bloques = data.get("content") or []
        texto = "".join(b.get("text", "") for b in bloques if isinstance(b, dict) and b.get("type") == "text").strip()
        # Limpiar posibles fences
        if texto.startswith("```"):
            texto = texto.strip("`")
            if texto.lower().startswith("json"):
                texto = texto[4:].strip()
        parsed = json.loads(texto)
        # Validar shape mínimo
        if "deep_dive" in parsed and "short_report" in parsed:
            return {"fuente": "claude", **parsed}
    except Exception:
        pass
    return _narrativa_fallback(ticker, fund)


def _narrativa_fallback(ticker: str, fund: Dict[str, Any]) -> Dict[str, Any]:
    """Cuando no hay Claude API: narrativa basada en metadata."""
    nombre = fund.get("nombre") or ticker
    sector = fund.get("sector") or "sector no disponible"
    industria = fund.get("industria") or ""
    return {
        "fuente": "datos",
        "deep_dive": {
            "business_model": f"{nombre} opera en {sector} ({industria}). Configura tu ANTHROPIC_API_KEY para recibir un análisis cualitativo más profundo.",
            "moat":           "Sin análisis cualitativo disponible. Verifica market share, patentes y barreras de entrada manualmente.",
            "catalyst":       "Sin catalizadores específicos identificados. Revisa el calendario de earnings y noticias del sector.",
            "asymmetry":      "Análisis de asimetría no disponible. Compara la valuación histórica vs el crecimiento esperado.",
        },
        "short_report": {
            "accounting":             "Revisa el último 10-K (o equivalente local) en busca de cambios en políticas contables.",
            "customer_concentration": "Verifica en el 10-K la sección de 'risk factors' por concentración de clientes.",
            "competitive_threats":    "Identifica los principales competidores y compara su crecimiento de ingresos.",
        },
    }


# ============================================================
#  API pública
# ============================================================
def analizar_accion(ticker: str) -> Dict[str, Any]:
    """Análisis completo para una sola acción.

    Returns dict con: ticker, fundamentales, peer_comparison, deep_dive,
    short_report, score (1..100) y veredicto.
    """
    if not ticker or not ticker.strip():
        raise ValueError("Ticker requerido")

    ticker = ticker.strip().upper()

    # 1. Fundamentales
    fund = _fund._fundamentals_ticker(ticker)
    if not fund.get("ok"):
        return {
            "ticker": ticker,
            "ok":     False,
            "error":  fund.get("error", "No se pudieron descargar fundamentales."),
        }

    # 2. Peer comparison
    try:
        peer = _peer_comparison(ticker, fund)
    except Exception as e:
        peer = {"ticker_objetivo": ticker, "peers": [], "filas": [], "error": str(e)}

    # 3. Score determinístico
    sc = _score(fund, peer)

    # 4. Narrativas (Claude o fallback)
    narrativas = _claude_narrativas(ticker, fund)

    return {
        "ticker":           ticker,
        "ok":               True,
        "nombre":           fund.get("nombre"),
        "sector":           fund.get("sector"),
        "industria":        fund.get("industria"),
        "moneda":           fund.get("moneda"),
        "precio_actual":    fund.get("precio_actual"),
        "fundamentales":    fund,
        "peer_comparison":  peer,
        "deep_dive":        narrativas.get("deep_dive"),
        "short_report":     narrativas.get("short_report"),
        "narrativa_fuente": narrativas.get("fuente"),
        "score":            sc["score"],
        "veredicto":        sc["veredicto"],
        "score_componentes": sc["componentes"],
        "score_pesos":       sc["pesos"],
    }


if __name__ == "__main__":
    import sys
    t = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    res = analizar_accion(t)
    print(json.dumps(res, indent=2, default=str, ensure_ascii=False))
