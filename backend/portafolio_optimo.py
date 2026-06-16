"""
portafolio_optimo.py — Optimizador mean-variance (Markowitz).

Genera el mejor portafolio posible para un nivel de riesgo objetivo,
eliminando riesgo idiosincrático por diversificación y maximizando Sharpe.

Pipeline:
  1. Cargar precios diarios del universo local
  2. Filtrar candidatos líquidos y con historia suficiente
  3. Calcular retorno esperado y matriz de covarianzas (anualizada)
  4. Resolver mean-variance:
        max Sharpe sujeto a vol = vol_objetivo, suma_pesos=1, pesos>=0
  5. Devolver pesos + métricas + razones de selección

Nivel de riesgo (1-10):
   1 = Conservador     → vol_objetivo 6%   (ETFs bonos + dividend stocks)
   3 = Moderado-Bajo   → vol_objetivo 10%  (mix balanceado)
   5 = Balanceado      → vol_objetivo 14%  (similar a SP500)
   7 = Crecimiento     → vol_objetivo 18%  (más tech / growth)
  10 = Agresivo        → vol_objetivo 25%  (concentrado en alpha alto)

Tamaño del portafolio: ajustado al nivel
   N=12 acciones (conservador) → N=8 (agresivo)
   Más acciones = más diversificación = menos riesgo idiosincrático
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

import metricas_canonicas as MC


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
# Ver nota en accion_del_dia.py: el stub info_activos.json no trae 'recomendada'
# ni 'sector'. Preferimos universo_info.json (dev) y caemos al lite (prod).
_INFO_FULL = _BACKEND_DIR / "universo_info.json"
_INFO_LITE = _BACKEND_DIR / "universo_lite_info.json"
_INFO_STUB = _BACKEND_DIR / "info_activos.json"

_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 6 * 60 * 60   # 6 horas (matriz de covarianzas no cambia rápido)
_CACHE_DIR = _BACKEND_DIR / "_cache_portafolio_optimo"
_CACHE_DIR.mkdir(exist_ok=True)


# ─────────────────────────────────────────────────────────
# Mapeo nivel de riesgo → parámetros del optimizador
# ─────────────────────────────────────────────────────────
NIVELES = {
    1:  {"vol_objetivo": 0.06, "n_acciones": 12, "etiqueta": "Conservador",
         "descripcion": "Preservación de capital. Vol objetivo ~6%."},
    2:  {"vol_objetivo": 0.08, "n_acciones": 12, "etiqueta": "Conservador+",
         "descripcion": "Capital con ingreso. Vol objetivo ~8%."},
    3:  {"vol_objetivo": 0.10, "n_acciones": 11, "etiqueta": "Moderado bajo",
         "descripcion": "Crecimiento con cautela. Vol objetivo ~10%."},
    4:  {"vol_objetivo": 0.12, "n_acciones": 11, "etiqueta": "Moderado",
         "descripcion": "Balance retorno/riesgo. Vol objetivo ~12%."},
    5:  {"vol_objetivo": 0.14, "n_acciones": 10, "etiqueta": "Balanceado",
         "descripcion": "Similar al S&P500. Vol objetivo ~14%."},
    6:  {"vol_objetivo": 0.16, "n_acciones": 10, "etiqueta": "Balanceado+",
         "descripcion": "Por encima de mercado. Vol objetivo ~16%."},
    7:  {"vol_objetivo": 0.18, "n_acciones": 9, "etiqueta": "Crecimiento",
         "descripcion": "Sobreponderar growth. Vol objetivo ~18%."},
    8:  {"vol_objetivo": 0.21, "n_acciones": 9, "etiqueta": "Crecimiento+",
         "descripcion": "Convicción alta. Vol objetivo ~21%."},
    9:  {"vol_objetivo": 0.24, "n_acciones": 8, "etiqueta": "Agresivo",
         "descripcion": "Alta volatilidad por mayor retorno. Vol objetivo ~24%."},
    10: {"vol_objetivo": 0.28, "n_acciones": 8, "etiqueta": "Muy agresivo",
         "descripcion": "Máxima convicción. Vol objetivo ~28%."},
}


# ─────────────────────────────────────────────────────────
# Carga de datos
# ─────────────────────────────────────────────────────────
def _cargar_precios() -> Optional[pd.DataFrame]:
    # Reusa el DataFrame ya cacheado por accion_del_dia (misma fuente), para no
    # tener dos copias de ~29MB en memoria — importa en el free tier (512MB).
    try:
        import accion_del_dia as _ad
        return _ad._cargar_precios()
    except Exception:
        csv = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
        if not csv.exists():
            return None
        try:
            return pd.read_csv(csv, index_col=0, parse_dates=True).sort_index()
        except Exception:
            return None


def _cargar_info() -> Dict[str, Any]:
    for p in (_INFO_FULL, _INFO_LITE, _INFO_STUB):
        if p.exists():
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                continue
    return {}


def _liquidez_diaria(info: Dict[str, Any], precio: Optional[float]) -> float:
    vol = (info.get("averageVolume") or info.get("average_volume") or 0)
    if vol and precio:
        return float(vol) * float(precio)
    return float(info.get("market_cap") or info.get("marketCap") or 0)


# ─────────────────────────────────────────────────────────
# Selección de candidatos para Markowitz
# ─────────────────────────────────────────────────────────
def _seleccionar_candidatos(
    df_precios: pd.DataFrame,
    info_all: Dict[str, Any],
    nivel: int,
    max_candidatos: int = 40,
) -> List[str]:
    """Pre-selecciona ~40 tickers candidatos para el optimizador.

    No le pasamos 1000 a scipy porque la matriz de covarianzas se vuelve
    inestable. Filtramos por liquidez y luego por score canónico.
    """
    candidatos: List[Tuple[str, float, float]] = []   # (ticker, score, liquidez)

    # Para no llamar score_para_ticker() 1000 veces, hacemos shortcut:
    # importamos accion_del_dia que ya cachea el universo
    import accion_del_dia as _ad

    serie_us = df_precios["SPY"] if "SPY" in df_precios.columns else None
    serie_mx = df_precios["NAFTRAC.MX"] if "NAFTRAC.MX" in df_precios.columns else None

    hay_recomendadas = any(
        isinstance(v, dict) and v.get("recomendada") for v in info_all.values()
    )

    for t in df_precios.columns:
        info = info_all.get(t, {})
        # Filtro de calidad: solo 'recomendada' (set curado ~120). Reemplaza el
        # viejo filtro de liquidez, que dependía de averageVolume/market_cap —
        # campos ausentes en el universo lite, por lo que descartaba TODO y el
        # optimizador se quedaba sin candidatos (no devolvía portafolio).
        if hay_recomendadas and not info.get("recomendada"):
            continue
        # Excluir crypto, fondos, índices, futuros. Los ETFs SÍ se permiten: los
        # niveles conservadores los necesitan para bajar la volatilidad objetivo.
        tipo = (info.get("tipo") or info.get("quoteType") or "").upper()
        if tipo in ("CRYPTOCURRENCY", "MUTUALFUND", "INDEX", "FUTURE"):
            continue
        if MC.es_crypto(t):
            continue

        # Score canónico
        res = _ad.calcular_metricas_y_score(t, df_precios, info_all, serie_us, serie_mx)
        if res is None:
            continue
        score, _ = res
        precio = float(df_precios[t].dropna().iloc[-1]) if df_precios[t].dropna().size else 0
        liq = _liquidez_diaria(info, precio)
        candidatos.append((t, score, liq))

    # Ranking final: ajustar el peso del score por nivel
    # Conservador (1-3) prefiere baja vol → bonus para tickers con sharpe alto y beta baja
    # Agresivo (8-10) prefiere alpha alto sin importar vol
    candidatos.sort(key=lambda x: x[1], reverse=True)
    return [c[0] for c in candidatos[:max_candidatos]]


# ─────────────────────────────────────────────────────────
# Optimizador Markowitz
# ─────────────────────────────────────────────────────────
def _optimizar_markowitz(
    df_rets: pd.DataFrame,
    vol_objetivo_anual: float,
    rf_anual: float,
    max_peso: float = 0.20,
) -> Optional[Dict[str, Any]]:
    """Resuelve max Sharpe sujeto a vol_anual <= vol_objetivo.

    Args:
        df_rets: matriz de retornos mensuales (filas=fechas, cols=tickers)
        vol_objetivo_anual: vol objetivo (ej 0.14)
        rf_anual: tasa libre de riesgo anualizada
        max_peso: peso máximo por ticker (cap para evitar concentración)

    Returns:
        {pesos, retorno_esperado, vol, sharpe, ...}
    """
    if df_rets.empty or df_rets.shape[1] < 3:
        return None

    # Limpiar tickers con demasiados NaN
    df_rets = df_rets.dropna(axis=1, thresh=int(df_rets.shape[0] * 0.7))
    df_rets = df_rets.dropna()
    if df_rets.shape[1] < 3 or df_rets.shape[0] < 12:
        return None

    n = df_rets.shape[1]
    mu = df_rets.mean() * 12      # retorno mensual → anual (aproximación lineal OK aquí)
    cov = df_rets.cov() * 12      # cov mensual → anual

    # Búsqueda aleatoria + optimización local con scipy.minimize
    try:
        from scipy.optimize import minimize
    except Exception:
        return None

    def vol_p(w):
        return float(np.sqrt(w @ cov.values @ w))

    def ret_p(w):
        return float(w @ mu.values)

    def neg_sharpe(w):
        v = vol_p(w)
        if v == 0:
            return 0
        return -(ret_p(w) - rf_anual) / v

    # Restricciones: suma_pesos=1, pesos en [0, max_peso]
    constraints = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
    bounds = [(0.0, max_peso) for _ in range(n)]

    # Inicializar con pesos iguales
    w0 = np.ones(n) / n

    # Primera pasada: maximizar Sharpe sin restricción de vol
    res_sharpe = minimize(neg_sharpe, w0, method="SLSQP",
                          bounds=bounds, constraints=constraints,
                          options={"maxiter": 200, "ftol": 1e-7})
    if not res_sharpe.success:
        return None
    w_maxsharpe = res_sharpe.x
    vol_maxsharpe = vol_p(w_maxsharpe)

    # Segunda pasada: ajustar al vol objetivo
    # Si vol_maxsharpe > vol_objetivo, mezclar con cash (rf) para reducir vol
    # Si vol_maxsharpe < vol_objetivo, usar tal cual (no apalancamos)
    if vol_maxsharpe > vol_objetivo_anual:
        # Combinación: alpha*risky + (1-alpha)*rf, donde alpha = vol_obj / vol_maxsharpe
        alpha = vol_objetivo_anual / vol_maxsharpe
        w_final = w_maxsharpe * alpha
        peso_cash = 1.0 - alpha
    else:
        w_final = w_maxsharpe
        peso_cash = 0.0

    retorno_esp = float(w_final @ mu.values) + peso_cash * rf_anual
    vol_final = float(np.sqrt(w_final @ cov.values @ w_final))
    sharpe = (retorno_esp - rf_anual) / vol_final if vol_final > 0 else 0

    # Pesos como dict, filtrar los <0.5% para limpiar
    pesos = {t: round(float(w), 4) for t, w in zip(df_rets.columns, w_final) if w > 0.005}

    # Diversificación: medir cuánto del riesgo viene de la covarianza vs idiosincrático
    # Riesgo idiosincrático = sum(w_i^2 * var_i) — si los pesos están bien diversificados, esto es bajo
    var_idiosin = float(np.sum(w_final**2 * np.diag(cov.values)))
    var_total = float(w_final @ cov.values @ w_final)
    pct_diversificable_eliminado = (1 - var_total / var_idiosin) if var_idiosin > 0 else 0

    return {
        "pesos":                 pesos,
        "peso_cash":             round(peso_cash, 4),
        "retorno_esperado":      round(retorno_esp, 4),
        "volatilidad_anual":     round(vol_final, 4),
        "sharpe":                round(sharpe, 3),
        "n_acciones":            len(pesos),
        "diversificacion_pct":   round(pct_diversificable_eliminado * 100, 1),
    }


# ─────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────
def portafolio_optimo(nivel_riesgo: int = 5, forzar: bool = False) -> Dict[str, Any]:
    """Genera el portafolio óptimo para el nivel de riesgo indicado (1-10)."""
    nivel = max(1, min(10, int(nivel_riesgo)))

    # Cache
    cache_key = f"nivel_{nivel}"
    cached = _CACHE.get(cache_key)
    if not forzar and cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]

    disk_path = _CACHE_DIR / f"{cache_key}.json"
    if not forzar and disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                d = json.load(f)
            if (time.time() - d.get("_ts", 0)) < _CACHE_TTL:
                _CACHE[cache_key] = {"ts": d["_ts"], "data": d["data"]}
                return d["data"]
        except Exception:
            pass

    params = NIVELES[nivel]
    df_precios = _cargar_precios()
    if df_precios is None or df_precios.empty:
        return {"ok": False, "error": "Universo no disponible"}

    info_all = _cargar_info()

    # 1) Pre-seleccionar candidatos
    candidatos = _seleccionar_candidatos(df_precios, info_all, nivel, max_candidatos=40)
    if len(candidatos) < 5:
        return {"ok": False, "error": "No hay suficientes candidatos con score positivo"}

    # 2) Construir matriz de retornos mensuales para los candidatos
    rets = {}
    for t in candidatos:
        if t not in df_precios.columns:
            continue
        r = MC.retornos_mensuales(df_precios[t])
        if r is not None and len(r) >= 24:
            rets[t] = r
    if len(rets) < 5:
        return {"ok": False, "error": "Insuficiente historia común entre candidatos"}

    df_rets = pd.DataFrame(rets).dropna()
    if df_rets.shape[0] < 24:
        return {"ok": False, "error": f"Solo {df_rets.shape[0]} meses comunes; necesito 24+"}

    # 3) Optimizar
    rf = MC.RF_USD_DEFAULT  # asume USD; un usuario mexicano puede hedgear con CETES
    resultado = _optimizar_markowitz(
        df_rets,
        vol_objetivo_anual=params["vol_objetivo"],
        rf_anual=rf,
        max_peso=0.25 if nivel >= 8 else 0.15,   # agresivo permite más concentración
    )
    if resultado is None:
        return {"ok": False, "error": "Optimizador no convergió"}

    # 4) Enriquecer pesos con metadata
    acciones = []
    for t, peso in sorted(resultado["pesos"].items(), key=lambda x: -x[1]):
        info = info_all.get(t, {})
        precio = float(df_precios[t].dropna().iloc[-1]) if t in df_precios.columns else None
        acciones.append({
            "ticker":  t,
            "nombre":  info.get("nombre") or t,
            "sector":  info.get("sector"),
            "peso":    round(peso, 4),
            "peso_pct": round(peso * 100, 2),
            "precio":  round(precio, 2) if precio else None,
            "es_mx":   t.upper().endswith(".MX"),
        })

    # 5) Reducir a top N según el nivel
    n_max = params["n_acciones"]
    if len(acciones) > n_max:
        acciones_top = acciones[:n_max]
        # Re-normalizar pesos
        suma = sum(a["peso"] for a in acciones_top)
        for a in acciones_top:
            a["peso"] = round(a["peso"] / suma, 4)
            a["peso_pct"] = round(a["peso"] * 100, 2)
        acciones = acciones_top

    data = {
        "ok":                    True,
        "nivel":                 nivel,
        "etiqueta":              params["etiqueta"],
        "descripcion":           params["descripcion"],
        "vol_objetivo":          params["vol_objetivo"],
        "fecha":                 time.strftime("%Y-%m-%d"),
        "actualizado_ts":        int(time.time()),

        # Métricas del portafolio
        "retorno_esperado":      resultado["retorno_esperado"],
        "volatilidad_anual":     resultado["volatilidad_anual"],
        "sharpe":                resultado["sharpe"],
        "peso_cash":             resultado["peso_cash"],
        "n_acciones":            len(acciones),
        "diversificacion_pct":   resultado["diversificacion_pct"],

        # Composición
        "acciones":              acciones,

        # Metodología
        "metodologia": (
            "Optimización mean-variance (Markowitz): se selecciona el portafolio "
            "de pesos positivos que maximiza Sharpe sujeto a vol_objetivo. La "
            "diversificación elimina riesgo idiosincrático al combinar activos "
            "con baja correlación. Si el portafolio de máximo Sharpe excede la "
            "vol objetivo, se combina con cash (CETES/UST) para bajarla."
        ),
        "disclaimer": (
            "Backtesting sobre historia pasada. No garantiza rendimientos futuros. "
            "Considera tu horizonte, impuestos y situación personal antes de invertir."
        ),
    }

    ts = time.time()
    _CACHE[cache_key] = {"ts": ts, "data": data}
    try:
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass

    return data
