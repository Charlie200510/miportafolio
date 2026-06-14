# ============================================================
#  PERFILES SUGERIDOS v2 — multi-criterio + baja correlación
# ============================================================
#  Cada perfil define un UNIVERSO CANDIDATO amplio (15-30 tickers)
#  y un OBJETIVO. La construcción del portafolio final tiene 3 pasos:
#
#    1. SCORE DE CALIDAD por ticker (de la historia de precios):
#         - Sharpe anualizado
#         - Sortino (downside-adjusted Sharpe)
#         - Calmar (retorno / max drawdown)
#         - Volatilidad consistente (no spikes)
#         - Tendencia 6m positiva
#       → cada ticker recibe un score 0-100.
#
#    2. SELECCIÓN POR DIVERSIFICACIÓN:
#         Algoritmo greedy que arranca con el ticker de mejor score
#         y va añadiendo el siguiente con mejor (score - α·correlación
#         promedio con los ya elegidos). Resultado: N_OBJETIVO tickers
#         con buena calidad individual y baja correlación entre sí.
#
#    3. OPTIMIZACIÓN MARKOWITZ sobre los seleccionados:
#         min_vol     → mínima varianza (long-only)
#         max_sharpe  → tangencia
#         max_ret     → máximo retorno con cap de volatilidad
#         risk_parity → contribución de riesgo igual
#
#  Esto garantiza para cada perfil:
#    - Cada acción es individualmente "buena" (alto score multi-criterio)
#    - Las acciones no están redundantemente correlacionadas
#    - El portafolio final vive sobre la frontera eficiente del universo
# ============================================================
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from scipy.optimize import minimize


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
_UNIV_CSV  = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE

DIAS_HABILES = 252
TASA_LIBRE_RIESGO = 0.095
MIN_DIAS_HISTORIA = 252           # ahora pedimos ≥1 año para perfilar quality
MIN_WEIGHT = 1e-3
N_OBJETIVO_DEFAULT = 7            # tickers en el portafolio final
ALPHA_CORRELACION = 0.5           # peso de la diversificación vs calidad
MIN_TICKERS_FINAL = 4             # nunca menos de 4 acciones


# ============================================================
#  PERFILES — universos candidatos amplios
# ============================================================
PERFILES = [
    {
        "id": "conservador_mx",
        "nombre": "Conservador Mexicano",
        "emoji": "🇲🇽",
        "nivel_riesgo": "bajo",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "min_vol",
        "n_objetivo": 8,
        "thesis": "Blue chips de la BMV + FIBRAS + NAFTRAC. Mínima varianza con baja correlación entre emisoras mexicanas.",
        "descripcion": (
            "Perfil ilustrativo enfocado a estabilidad y baja exposición cambiaria. "
            "Universo amplio de blue chips de la BMV, FIBRAS de calidad y el NAFTRAC. "
            "Selecciona ~8 emisoras con mejor combinación de Sharpe/Calmar/baja "
            "volatilidad y baja correlación entre ellas; luego optimiza para mínima "
            "varianza. 100% MXN."
        ),
        "universo": [
            # Blue chips IPC
            "WALMEX.MX", "FEMSAUBD.MX", "GFNORTEO.MX", "GMEXICOB.MX", "AMXB.MX",
            "KIMBERA.MX", "GRUMAB.MX", "BIMBOA.MX", "AC.MX", "CEMEXCPO.MX",
            "ASURB.MX", "GAPB.MX", "OMAB.MX", "ALSEA.MX", "ORBIA.MX",
            "PINFRA.MX", "MEGACPO.MX",
            # FIBRAS
            "FUNO11.MX", "FIBRAMQ12.MX", "FIBRAPL14.MX", "FMTY14.MX",
            # Indexado
            "NAFTRAC.MX",
        ],
    },
    {
        "id": "crecimiento_usa_tech",
        "nombre": "Crecimiento USA Tech",
        "emoji": "🚀",
        "nivel_riesgo": "alto",
        "horizonte": "mediano-largo plazo (3-10 años)",
        "objetivo": "max_ret",
        "n_objetivo": 7,
        "thesis": "Mega-caps tech + semis + plataformas + QQQ. Alta calidad multi-criterio, controlada por correlación para no duplicar betas.",
        "descripcion": (
            "Perfil ilustrativo de alta agresividad. Universo de las grandes "
            "tecnológicas, semiconductores líderes y plataformas. Filtra por calidad "
            "(Sharpe + Sortino + tendencia 6m positiva) y diversifica entre "
            "subsectores (semis vs SaaS vs internet) usando correlación. Optimiza "
            "para máximo retorno con cap de volatilidad ~1.5× tangencia."
        ),
        "universo": [
            "NVDA", "MSFT", "AAPL", "GOOGL", "META", "AMZN", "AVGO", "TSLA",
            "AMD", "ORCL", "CRM", "ADBE", "NFLX", "CSCO", "QCOM", "INTC",
            "MU", "AMAT", "LRCX", "PANW", "SHOP", "QQQ", "VGT", "SOXX",
        ],
    },
    {
        "id": "indexacion_global",
        "nombre": "Indexación Global ETF",
        "emoji": "📊",
        "nivel_riesgo": "medio",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "max_sharpe",
        "n_objetivo": 6,
        "thesis": "Cesta de ETFs diversificados (acciones US/global, bonos, oro, emergentes). Sharpe óptimo con baja correlación cruzada por construcción.",
        "descripcion": (
            "Perfil ilustrativo siguiendo la filosofía Bogle/Buffett: indexarse "
            "globalmente con costos bajos. Universo de ETFs líderes que cubren US "
            "total market, internacional desarrollado, emergentes, bonos, oro y "
            "real estate. La selección busca mejor Sharpe con baja correlación "
            "entre clases de activo (acciones vs bonos vs commodities)."
        ),
        "universo": [
            "VTI", "VOO", "SPY", "QQQ", "VEA", "VWO", "IEFA", "IEMG",
            "AGG", "BND", "TLT", "LQD", "HYG", "GLD", "SLV", "VNQ",
            "DIA", "IWM", "MDY",
        ],
    },
    {
        "id": "diversificado_global",
        "nombre": "Diversificado Global",
        "emoji": "🌎",
        "nivel_riesgo": "medio",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "max_sharpe",
        "n_objetivo": 9,
        "thesis": "Mezcla equilibrada US + MX + Europa + Asia + bonos. Tangencia Markowitz con diversificación geográfica y por moneda.",
        "descripcion": (
            "Perfil ilustrativo para inversores que buscan equilibrio peso/dólar/euro/yen. "
            "Universo amplio cruzando regiones, sectores y monedas. La selección "
            "favorece tickers con baja correlación entre regiones, lo que reduce "
            "el riesgo idiosincrático y de tipo de cambio."
        ),
        "universo": [
            # US grandes
            "VOO", "QQQ", "AAPL", "MSFT", "JNJ", "PG", "JPM", "V",
            # MX
            "WALMEX.MX", "FEMSAUBD.MX", "GFNORTEO.MX", "NAFTRAC.MX",
            # Internacional
            "VEA", "VWO", "ASML.AS", "NESN.SW", "TM", "BABA",
            "TSM", "NVO", "SAP",
            # Refugio
            "GLD", "TLT", "BND",
        ],
    },
    {
        "id": "dividendos_estables",
        "nombre": "Dividendos Estables",
        "emoji": "💰",
        "nivel_riesgo": "bajo-medio",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "min_vol",
        "n_objetivo": 8,
        "thesis": "Empresas con décadas pagando dividendo creciente, defensivas. Mínima varianza sobre un universo de quality dividend payers.",
        "descripcion": (
            "Perfil ilustrativo orientado a flujo de efectivo estable. Universo de "
            "Dividend Aristocrats: empresas que han subido dividendos 25+ años "
            "consecutivos, en sectores defensivos (consumo, salud, utilities, "
            "industriales maduros). Selecciona por baja volatilidad y baja "
            "correlación; minimiza varianza."
        ),
        "universo": [
            "KO", "PEP", "JNJ", "PG", "WMT", "MCD", "MMM", "CL",
            "ED", "SO", "DUK", "NEE", "T", "VZ", "IBM", "XOM", "CVX",
            "JPM", "WFC", "BAC", "ABBV", "PFE", "MRK", "WALMEX.MX", "FEMSAUBD.MX",
            "VYM", "SCHD",  # ETFs de dividendos
        ],
    },
    {
        "id": "cripto_core",
        "nombre": "Cripto Core",
        "emoji": "₿",
        "nivel_riesgo": "muy alto",
        "horizonte": "mediano plazo (3-7 años) y mucho estómago",
        "objetivo": "max_sharpe",
        "n_objetivo": 6,
        "thesis": "BTC + ETH + alts líderes. Tangencia Markowitz con diversificación entre layer-1, DeFi y memecoins.",
        "descripcion": (
            "Perfil ilustrativo exclusivo cripto. Universo amplio de top 15 por "
            "market cap. La selección busca diversificar entre store-of-value "
            "(BTC), smart contracts (ETH/SOL/AVAX/ADA), DeFi (LINK/UNI/AAVE) y "
            "alts grandes — minimizando correlación entre ellos. Volatilidad "
            "esperada: 60-100% anual. Solo dinero perdible."
        ),
        "universo": [
            "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD",
            "ADA-USD", "AVAX-USD", "DOT-USD", "LINK-USD", "POL28321-USD",
            "DOGE-USD", "LTC-USD", "ATOM-USD", "NEAR-USD", "FIL-USD",
            "UNI7083-USD", "AAVE-USD", "HYPE32196-USD",
        ],
    },
    {
        "id": "value_defensivo",
        "nombre": "Value Defensivo",
        "emoji": "🛡️",
        "nivel_riesgo": "bajo-medio",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "min_vol",
        "n_objetivo": 7,
        "thesis": "Empresas value (P/E bajo, márgenes estables, deuda controlada) en sectores defensivos. Mínima varianza con baja correlación.",
        "descripcion": (
            "Perfil ilustrativo estilo Buffett-Munger. Universo de empresas con "
            "fundamentales sólidos cotizando a valuaciones razonables: bancos "
            "money-center, consumo básico, salud y energía mayor. Selecciona por "
            "Sharpe + baja drawdown; diversifica por sector vía correlación."
        ),
        "universo": [
            "BRK-B", "JPM", "BAC", "WFC", "C", "GS", "MS",
            "JNJ", "PFE", "MRK", "ABT", "TMO", "UNH", "CVS",
            "KO", "PEP", "PG", "WMT", "COST", "MCD",
            "XOM", "CVX", "COP", "PSX",
        ],
    },
    {
        "id": "internacional_em",
        "nombre": "Internacional + Emergentes",
        "emoji": "🌍",
        "nivel_riesgo": "medio-alto",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "max_sharpe",
        "n_objetivo": 8,
        "thesis": "ADRs y blue chips fuera de EEUU: Asia, Europa, Latam. Diversifica por moneda y región con correlación controlada.",
        "descripcion": (
            "Perfil ilustrativo para reducir dependencia del mercado USA. Universo "
            "de ADRs líderes (TSM, BABA, NVO, ASML, MELI) más ETFs regionales. "
            "Selecciona por Sharpe ajustado y baja correlación entre regiones — "
            "captura crecimiento global sin concentración."
        ),
        "universo": [
            "TSM", "BABA", "JD", "PDD", "BIDU", "NIO",
            "NVO", "SAP", "ASML", "TM", "SONY", "MUFG",
            "MELI", "VALE", "PBR", "ITUB", "SHOP", "RY",
            "VEA", "VWO", "EFA", "EEM", "INDA", "MCHI", "EWZ", "EWJ",
        ],
    },
    {
        "id": "elite_quality",
        "nombre": "Élite Quality",
        "emoji": "💠",
        "nivel_riesgo": "bajo-medio",
        "horizonte": "largo plazo (5+ años)",
        "objetivo": "max_sharpe",
        "n_objetivo": 8,
        "thesis": "Quality compounders + oro: las acciones individuales con mejor Sharpe/Sortino/Calmar histórico, mezcladas con metal precioso para anclar drawdown.",
        "descripcion": (
            "Perfil ilustrativo construido SOLO sobre tickers que históricamente "
            "puntean alto en cada criterio del score: Walmart, JNJ, Costco, "
            "PepsiCo y compañía (consumo defensivo de baja volatilidad), "
            "GLD/IAU (oro como ancla), TSM y LLY (crecimiento de calidad). "
            "Markowitz tangencia sobre un universo pre-filtrado de wide-moat "
            "compounders. Diseñado para que el score promedio del perfil sea "
            "el más alto del catálogo."
        ),
        "universo": [
            # Quality consumer (el corazón del perfil — Sharpe/vol bajísimos)
            "WMT", "COST", "KO", "PEP", "PG", "MCD", "MO", "CL", "HRL", "MKC",
            # Healthcare premium
            "JNJ", "LLY", "ABBV", "MRK", "UNH",
            # Wide-moat clásicos
            "BRK-B", "V", "MA", "MMC", "MCO", "SPGI",
            # Tech con foso (sólo los más estables)
            "MSFT", "GOOGL", "AVGO", "ORCL", "TSM",
            # Oro / metales (excelente Sortino y diversifica vs equity)
            "GLD", "IAU",
            # Defensivos quality ETFs
            "SCHD", "VIG",
        ],
    },
    {
        "id": "all_weather",
        "nombre": "All-Weather Pro",
        "emoji": "⚖️",
        "nivel_riesgo": "bajo",
        "horizonte": "muy largo plazo (10+ años)",
        "objetivo": "risk_parity",
        "n_objetivo": 8,
        "thesis": "All-Weather de Ray Dalio + defensivos premium. Mezcla oro, bonos, equity y consumer staples para Calmar ratio sobresaliente y drawdowns mínimos.",
        "descripcion": (
            "Perfil ilustrativo de máxima resiliencia. Combina oro (refugio), "
            "bonos US (deflación / recesión), TIPS (inflación), real estate "
            "(crecimiento + inflación), equity ETFs (crecimiento) y un núcleo "
            "de consumer staples ultra-defensivos (KO, JNJ, WMT, PG) que "
            "anclan el portafolio en cualquier régimen. Risk parity asigna el "
            "peso para que cada clase contribuya igual al riesgo total. El "
            "resultado: drawdowns excepcionalmente bajos y score de calidad "
            "rivalizando con el de Élite Quality."
        ),
        "universo": [
            # Oro / metales (motor del score por baja vol + tendencia)
            "GLD", "IAU", "SLV",
            # Bonos US — todo el espectro
            "TLT", "VGLT", "AGG", "BND", "IEF", "SHY", "BSV", "TIP", "VTIP",
            # Bonos corporativos investment grade
            "LQD", "VCIT",
            # Real estate
            "VNQ", "XLRE", "VICI",
            # Equity defensivo (no growth, baja vol)
            "VOO", "SCHD", "VYM",
            # Consumer staples como ancla (tickers individuales con score alto)
            "JNJ", "WMT", "KO", "PG", "PEP", "MCD", "MO", "BRK-B",
            # Utilities (baja vol)
            "XLU", "VPU",
        ],
    },
]


# -----------------------------------------------------------------------
#  Carga de precios
# -----------------------------------------------------------------------
def _cargar_precios() -> Optional[pd.DataFrame]:
    if not _UNIV_CSV.exists():
        return None
    try:
        df = pd.read_csv(_UNIV_CSV, index_col=0, parse_dates=True)
        return df.sort_index()
    except Exception:
        return None


# -----------------------------------------------------------------------
#  MÉTRICAS POR TICKER (multi-criterio)
# -----------------------------------------------------------------------
def _metricas_ticker(precios_t: pd.Series) -> dict:
    """Calcula métricas de calidad para una sola serie de precios."""
    serie = precios_t.dropna()
    if len(serie) < 60:
        return {}
    rend = serie.pct_change().dropna()
    if len(rend) < 60:
        return {}

    media_d = float(rend.mean())
    std_d = float(rend.std())
    ret_anual = media_d * DIAS_HABILES
    vol_anual = std_d * np.sqrt(DIAS_HABILES)

    # Sharpe
    sharpe = (ret_anual - TASA_LIBRE_RIESGO) / vol_anual if vol_anual > 0 else 0.0

    # Sortino: usa solo desviación de retornos negativos
    rend_neg = rend[rend < 0]
    if len(rend_neg) > 5:
        downside = float(rend_neg.std()) * np.sqrt(DIAS_HABILES)
        sortino = (ret_anual - TASA_LIBRE_RIESGO) / downside if downside > 0 else 0.0
    else:
        sortino = sharpe

    # Max drawdown
    cum = (1 + rend).cumprod()
    runmax = cum.cummax()
    dd = (cum - runmax) / runmax
    max_dd = float(dd.min()) if len(dd) else 0.0  # negativo

    # Calmar = retorno / |max_dd|
    calmar = ret_anual / abs(max_dd) if max_dd < -0.001 else 0.0

    # Tendencia 6m: pendiente del log-precio normalizada
    n6 = min(126, len(serie))
    serie6 = serie.iloc[-n6:]
    if len(serie6) > 30:
        x = np.arange(len(serie6))
        y = np.log(serie6.values)
        slope = float(np.polyfit(x, y, 1)[0]) * DIAS_HABILES  # log-return anual
    else:
        slope = ret_anual

    return {
        "ret_anual":  ret_anual,
        "vol_anual":  vol_anual,
        "sharpe":     sharpe,
        "sortino":    sortino,
        "max_dd":     max_dd,
        "calmar":     calmar,
        "tendencia":  slope,
    }


def _score_calidad(m: dict) -> float:
    """Combina las métricas en un score 0-100. Ponderación pensada para
    capturar los mismos ejes que el analizador individual: rentabilidad,
    estabilidad, recompensa por riesgo y momentum."""
    if not m:
        return 0.0

    def norm(val, bueno, malo):
        if val is None: return 0.5
        if bueno > malo:
            if val >= bueno: return 1.0
            if val <= malo:  return 0.0
            return (val - malo) / (bueno - malo)
        else:
            if val <= bueno: return 1.0
            if val >= malo:  return 0.0
            return (malo - val) / (malo - bueno)

    sub = {
        "sharpe":    norm(m["sharpe"],    0.8, -0.2),   # Sharpe>0.8 excelente
        "sortino":   norm(m["sortino"],   1.0, -0.2),
        "calmar":    norm(m["calmar"],    0.5,  0.0),
        "max_dd":    norm(m["max_dd"],   -0.10, -0.50), # menor drawdown = mejor
        "tendencia": norm(m["tendencia"], 0.20, -0.10),
        "vol":       norm(m["vol_anual"], 0.15, 0.60),  # volatilidades muy altas penalizan
    }
    pesos = {"sharpe": 25, "sortino": 20, "calmar": 15, "max_dd": 15, "tendencia": 15, "vol": 10}
    score = sum(sub[k] * pesos[k] for k in pesos)
    return round(score, 1)


# -----------------------------------------------------------------------
#  SELECCIÓN POR DIVERSIFICACIÓN (greedy)
# -----------------------------------------------------------------------
def _seleccionar_diversificado(
    candidatos: list[str],
    scores: dict[str, float],
    cov: pd.DataFrame,
    n_objetivo: int,
    alpha: float = ALPHA_CORRELACION,
) -> list[str]:
    """Greedy: arranca con el de mejor score y va añadiendo el siguiente
    con mayor (score normalizado − α·correlación promedio con seleccionados)."""
    if not candidatos:
        return []
    # Ordenar candidatos por score descendente
    cand = sorted(candidatos, key=lambda t: scores.get(t, 0), reverse=True)
    seleccionados = [cand[0]]
    restantes = cand[1:]

    # Matriz de correlación a partir de la covarianza
    std = np.sqrt(np.diag(cov))
    std_safe = np.where(std == 0, 1, std)
    corr_mat = cov.values / np.outer(std_safe, std_safe)
    corr_df = pd.DataFrame(corr_mat, index=cov.index, columns=cov.columns)

    while len(seleccionados) < n_objetivo and restantes:
        mejor_t = None
        mejor_v = -1e9
        for t in restantes:
            if t not in corr_df.columns:
                continue
            # Correlación promedio con los ya seleccionados
            corrs = [abs(corr_df.loc[t, s]) for s in seleccionados if s in corr_df.columns]
            corr_avg = float(np.mean(corrs)) if corrs else 0.0
            # Normalizar score a 0..1
            s_norm = scores.get(t, 0) / 100.0
            valor = s_norm - alpha * corr_avg
            if valor > mejor_v:
                mejor_v = valor
                mejor_t = t
        if mejor_t is None:
            break
        seleccionados.append(mejor_t)
        restantes.remove(mejor_t)

    return seleccionados


# -----------------------------------------------------------------------
#  OPTIMIZADORES MARKOWITZ
# -----------------------------------------------------------------------
def _pesos_min_vol(cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    w0 = np.full(n, 1 / n)
    res = minimize(
        lambda w: float(w @ cov @ w),
        w0, method="SLSQP",
        bounds=tuple((0.0, 1.0) for _ in range(n)),
        constraints=({"type": "eq", "fun": lambda w: w.sum() - 1.0},),
        options={"ftol": 1e-10, "maxiter": 500, "disp": False},
    )
    return res.x if res.success else w0


def _pesos_max_sharpe(mu: np.ndarray, cov: np.ndarray, rf_diaria: float) -> np.ndarray:
    n = len(mu)
    w0 = np.full(n, 1 / n)

    def neg_sharpe(w):
        ret = float(w @ mu) * DIAS_HABILES
        vol = float(np.sqrt(max(w @ cov @ w * DIAS_HABILES, 0.0)))
        if vol <= 0:
            return 0.0
        return -(ret - rf_diaria * DIAS_HABILES) / vol

    res = minimize(
        neg_sharpe, w0, method="SLSQP",
        bounds=tuple((0.0, 1.0) for _ in range(n)),
        constraints=({"type": "eq", "fun": lambda w: w.sum() - 1.0},),
        options={"ftol": 1e-9, "maxiter": 500, "disp": False},
    )
    return res.x if res.success else w0


def _pesos_max_ret_capado(mu: np.ndarray, cov: np.ndarray, vol_max_anual: float) -> np.ndarray:
    n = len(mu)
    w0 = np.full(n, 1 / n)

    def restr_vol(w):
        var_anual = float(w @ cov @ w) * DIAS_HABILES
        return vol_max_anual ** 2 - var_anual

    res = minimize(
        lambda w: -float(w @ mu) * DIAS_HABILES, w0, method="SLSQP",
        bounds=tuple((0.0, 1.0) for _ in range(n)),
        constraints=(
            {"type": "eq",   "fun": lambda w: w.sum() - 1.0},
            {"type": "ineq", "fun": restr_vol},
        ),
        options={"ftol": 1e-9, "maxiter": 500, "disp": False},
    )
    return res.x if res.success else w0


def _pesos_risk_parity(cov: np.ndarray) -> np.ndarray:
    """Cada ticker contribuye igual al riesgo total."""
    n = cov.shape[0]
    w0 = np.full(n, 1 / n)

    def objetivo(w):
        port_var = w @ cov @ w
        if port_var <= 0:
            return 1e6
        marginal = cov @ w
        rc = w * marginal  # contribuciones de riesgo
        rc_target = port_var / n
        return float(np.sum((rc - rc_target) ** 2))

    res = minimize(
        objetivo, w0, method="SLSQP",
        bounds=tuple((0.001, 1.0) for _ in range(n)),
        constraints=({"type": "eq", "fun": lambda w: w.sum() - 1.0},),
        options={"ftol": 1e-10, "maxiter": 500, "disp": False},
    )
    return res.x if res.success else w0


def _limpiar_pesos(w: np.ndarray, min_w: float = MIN_WEIGHT) -> np.ndarray:
    w = np.where(w < min_w, 0.0, w)
    s = w.sum()
    return w / s if s > 0 else w


def _optimizar(rend_diarios: pd.DataFrame, objetivo: str) -> tuple[np.ndarray, dict]:
    mu = rend_diarios.mean().values
    cov = rend_diarios.cov().values
    rf_diaria = TASA_LIBRE_RIESGO / DIAS_HABILES

    if objetivo == "min_vol":
        w = _pesos_min_vol(cov)
    elif objetivo == "max_sharpe":
        w = _pesos_max_sharpe(mu, cov, rf_diaria)
    elif objetivo == "max_ret":
        w_tan = _pesos_max_sharpe(mu, cov, rf_diaria)
        vol_tan = float(np.sqrt(w_tan @ cov @ w_tan * DIAS_HABILES))
        vol_cap = max(vol_tan * 1.5, 0.01)
        w = _pesos_max_ret_capado(mu, cov, vol_cap)
    elif objetivo == "risk_parity":
        w = _pesos_risk_parity(cov)
    else:
        w = np.full(len(mu), 1 / len(mu))

    w = _limpiar_pesos(w)
    ret_anual = float(w @ mu) * DIAS_HABILES
    var_anual = float(w @ cov @ w) * DIAS_HABILES
    vol_anual = float(np.sqrt(max(var_anual, 0.0)))
    sharpe = (ret_anual - TASA_LIBRE_RIESGO) / vol_anual if vol_anual > 0 else 0.0

    # Diversificación: 1 - correlación promedio entre tickers ponderada por peso
    std = np.sqrt(np.diag(cov))
    std_safe = np.where(std == 0, 1, std)
    corr = cov / np.outer(std_safe, std_safe)
    n = len(w)
    if n > 1:
        # Peso conjunto: cuánto contribuye cada par
        corrs_pond = []
        for i in range(n):
            for j in range(i + 1, n):
                if w[i] > 0 and w[j] > 0:
                    corrs_pond.append((w[i] * w[j], abs(corr[i, j])))
        if corrs_pond:
            total_w = sum(c[0] for c in corrs_pond)
            corr_prom = sum(c[0] * c[1] for c in corrs_pond) / total_w if total_w > 0 else 0
            diversificacion = 1.0 - corr_prom
        else:
            diversificacion = 1.0
    else:
        diversificacion = 0.0

    metricas = {
        "retorno_anual_pct":      round(ret_anual * 100, 2),
        "volatilidad_anual_pct":  round(vol_anual * 100, 2),
        "sharpe_ratio":           round(sharpe, 3),
        "diversificacion":        round(diversificacion, 3),
    }
    return w, metricas


# -----------------------------------------------------------------------
#  API PÚBLICA
# -----------------------------------------------------------------------
def _construir_perfil(p: dict, precios: pd.DataFrame, universo_set: Optional[set]) -> Optional[dict]:
    universo_perfil = list(p["universo"])
    if universo_set is not None:
        universo_perfil = [t for t in universo_perfil if t in universo_set]

    # Filtrar por presencia en CSV de precios
    universo_perfil = [t for t in universo_perfil if t in precios.columns]
    if len(universo_perfil) < MIN_TICKERS_FINAL:
        return None

    # Sub-historia común
    sub = precios[universo_perfil].dropna(how="all")
    # Quedarse con tickers que tengan suficiente historia
    validos = []
    metricas_por_ticker = {}
    scores = {}
    for t in universo_perfil:
        serie = sub[t].dropna()
        if len(serie) < MIN_DIAS_HISTORIA:
            continue
        m = _metricas_ticker(serie)
        if not m:
            continue
        validos.append(t)
        metricas_por_ticker[t] = m
        scores[t] = _score_calidad(m)

    if len(validos) < MIN_TICKERS_FINAL:
        return None

    # Filtrar candidatos con score muy bajo (< 25) — basura
    validos = [t for t in validos if scores[t] >= 25]
    if len(validos) < MIN_TICKERS_FINAL:
        # Si nos quedamos cortos, relajamos
        validos = sorted(metricas_por_ticker.keys(), key=lambda t: scores[t], reverse=True)[:max(MIN_TICKERS_FINAL, p.get("n_objetivo", N_OBJETIVO_DEFAULT))]

    # Sub-frame solo con válidos y filas completas
    sub_v = precios[validos].dropna()
    if len(sub_v) < MIN_DIAS_HISTORIA:
        return None
    rend = sub_v.pct_change().dropna()
    cov = rend.cov()

    # Selección por diversificación
    n_obj = max(MIN_TICKERS_FINAL, min(p.get("n_objetivo", N_OBJETIVO_DEFAULT), len(validos)))
    seleccionados = _seleccionar_diversificado(validos, scores, cov, n_obj)

    if len(seleccionados) < MIN_TICKERS_FINAL:
        return None

    # Optimización Markowitz sobre los seleccionados
    sub_sel = precios[seleccionados].dropna()
    if len(sub_sel) < MIN_DIAS_HISTORIA:
        return None
    rend_sel = sub_sel.pct_change().dropna()
    w, metricas = _optimizar(rend_sel, p["objetivo"])

    # Asegurar que al menos MIN_TICKERS_FINAL queden con peso > 0
    pesos = {}
    for t, wi in zip(seleccionados, w):
        if wi > MIN_WEIGHT:
            pesos[t] = round(float(wi), 4)

    if len(pesos) < MIN_TICKERS_FINAL:
        # Forzar a re-incluir los que se cayeron, equal weight entre seleccionados
        pesos = {t: round(1.0 / len(seleccionados), 4) for t in seleccionados}
        # Recalcular métricas con equal weight
        w_eq = np.full(len(seleccionados), 1.0 / len(seleccionados))
        mu = rend_sel.mean().values
        cov_arr = rend_sel.cov().values
        ret_anual = float(w_eq @ mu) * DIAS_HABILES
        var_anual = float(w_eq @ cov_arr @ w_eq) * DIAS_HABILES
        vol_anual = float(np.sqrt(max(var_anual, 0.0)))
        sharpe = (ret_anual - TASA_LIBRE_RIESGO) / vol_anual if vol_anual > 0 else 0.0
        metricas = {
            "retorno_anual_pct":     round(ret_anual * 100, 2),
            "volatilidad_anual_pct": round(vol_anual * 100, 2),
            "sharpe_ratio":          round(sharpe, 3),
            "diversificacion":       metricas.get("diversificacion", 0),
        }

    # Renormalizar pesos
    suma = sum(pesos.values())
    if suma > 0:
        pesos = {t: round(w / suma, 4) for t, w in pesos.items()}

    score_promedio = round(sum(scores[t] for t in seleccionados) / len(seleccionados), 1)

    return {
        "id":             p["id"],
        "nombre":         p["nombre"],
        "emoji":          p["emoji"],
        "nivel_riesgo":   p["nivel_riesgo"],
        "horizonte":      p["horizonte"],
        "thesis":         p["thesis"],
        "descripcion":    p["descripcion"],
        "objetivo":       p["objetivo"],
        "tickers":        list(pesos.keys()),
        "pesos":          pesos,
        "num_activos":    len(pesos),
        "metricas":       metricas,
        "score_promedio": score_promedio,
        "scores":         {t: scores[t] for t in seleccionados},
        "metodo":         "multi_criterio_" + p["objetivo"],
    }


def listar_perfiles(universo_tickers: Optional[set[str]] = None) -> list[dict]:
    """Devuelve los perfiles con pesos óptimos calculados al vuelo."""
    precios = _cargar_precios()
    if precios is None:
        # Fallback: equal weight de los primeros n del universo si no hay CSV
        out = []
        for p in PERFILES:
            n = min(p.get("n_objetivo", N_OBJETIVO_DEFAULT), len(p["universo"]))
            tickers = p["universo"][:max(MIN_TICKERS_FINAL, n)]
            pesos = {t: round(1.0 / len(tickers), 4) for t in tickers}
            out.append({
                "id":          p["id"],
                "nombre":      p["nombre"],
                "emoji":       p["emoji"],
                "nivel_riesgo": p["nivel_riesgo"],
                "horizonte":   p["horizonte"],
                "thesis":      p["thesis"],
                "descripcion": p["descripcion"],
                "objetivo":    p["objetivo"],
                "tickers":     tickers,
                "pesos":       pesos,
                "num_activos": len(tickers),
                "metricas":    None,
                "metodo":      "fallback_sin_precios",
            })
        return out

    out = []
    for p in PERFILES:
        try:
            res = _construir_perfil(p, precios, universo_tickers)
            if res:
                out.append(res)
        except Exception as e:
            # Log pero no abortar — un perfil falla, los demás siguen
            print(f"× perfil {p['id']} falló: {e}")
    return out


if __name__ == "__main__":
    import json
    perfs = listar_perfiles()
    for p in perfs:
        print(f"\n{p['emoji']}  {p['nombre']}  ({p['objetivo']}, n={p['num_activos']})")
        print(f"   métricas: {p.get('metricas')}")
        print(f"   score promedio: {p.get('score_promedio')}")
        print(f"   pesos: {json.dumps(p['pesos'], indent=2)}")
