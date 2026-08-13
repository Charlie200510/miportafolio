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
    # (ticker, score, liquidez, vol_anual, beta) — vol y beta hacen falta para
    # que el nivel de riesgo pueda inclinar el ranking.
    candidatos: List[Tuple[str, float, float, Optional[float], Optional[float]]] = []

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
        score, det = res
        precio = float(df_precios[t].dropna().iloc[-1]) if df_precios[t].dropna().size else 0
        liq = _liquidez_diaria(info, precio)
        candidatos.append((t, score, liq, det.get("volatilidad_anual"), det.get("beta")))

    # Ranking final: el nivel SÍ cambia a quién se prefiere.
    #
    # Este bloque decía exactamente esto en un comentario y luego ordenaba solo
    # por score, así que los diez niveles recibían la MISMA lista de candidatos.
    # Combinado con el optimizador —que ademAs mezclaba con efectivo en vez de
    # moverse por la frontera— el resultado era que los diez niveles devolvían
    # el mismo puñado de acciones, unas veces escaladas y otras idénticas.
    #
    # Ahora el score se ajusta con la volatilidad y la beta del propio ticker:
    #   - Conservador (1-3): premia vol baja y beta baja. Una acción que se
    #     mueve la mitad que el mercado sube posiciones aunque su score sea
    #     menor, porque es la que hace posible el objetivo de 6% de vol.
    #   - Agresivo (8-10): al revés, premia vol alta; sin candidatos volátiles
    #     es IMPOSIBLE llegar a un objetivo de 28% y todos los niveles altos
    #     terminan en el mismo sitio.
    #   - Medios (4-7): el score canónico manda, sin sesgo.
    for i, (t, score, liq, vol, beta) in enumerate(candidatos):
        if vol is None:
            ajuste = 0.0
        elif nivel <= 3:
            # Vol de referencia 20%: por debajo suma, por encima resta.
            ajuste = (0.20 - vol) * 120
            if beta is not None:
                ajuste += (1.0 - min(beta, 2.5)) * 8
        elif nivel >= 8:
            ajuste = (vol - 0.20) * 120
            if beta is not None:
                ajuste += (min(beta, 2.5) - 1.0) * 8
        else:
            ajuste = 0.0
        candidatos[i] = (t, score + ajuste, liq, vol, beta)

    candidatos.sort(key=lambda x: x[1], reverse=True)
    return [c[0] for c in candidatos[:max_candidatos]]


# ─────────────────────────────────────────────────────────
# Optimizador Markowitz
# ─────────────────────────────────────────────────────────
def _repartir_exacto(crudos: Dict[str, float], objetivo: float) -> Dict[str, float]:
    """Reparte `objetivo` (p.ej. 1.0 = 100%) entre `crudos` de forma que la suma
    cierre EXACTA a cuatro decimales.

    Se trabaja en enteros de una diezmilésima con el método del resto mayor.
    Redondear cada peso por su cuenta y confiar en que sumen no funciona: dejaba
    residuos de ±0.0002 y la lista del usuario mostraba 99.98% en vez de 100%.
    """
    total = sum(crudos.values())
    if total <= 0 or objetivo <= 0:
        return {}
    meta = int(round(objetivo * 10000))
    exactos = {t: w / total * meta for t, w in crudos.items()}
    base = {t: int(v) for t, v in exactos.items()}
    faltan = meta - sum(base.values())
    # La unidad sobrante va a quien más parte decimal perdió al truncar.
    for t in sorted(exactos, key=lambda k: exactos[k] - base[k], reverse=True)[:max(0, faltan)]:
        base[t] += 1
    return {t: v / 10000 for t, v in base.items()}


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
    mu_bruto = df_rets.mean() * 12   # retorno mensual → anual (aprox. lineal OK aquí)
    cov = df_rets.cov() * 12         # cov mensual → anual

    # ENCOGIMIENTO DE LOS RETORNOS ESPERADOS HACIA CAPM.
    #
    # Markowitz con medias históricas crudas es un maximizador de errores de
    # estimación: se vuelca sobre lo que MÁS subió en la muestra y proyecta esa
    # racha hacia adelante. Al pasar de "cartera tangente + efectivo" a "máximo
    # retorno sujeto a volatilidad", el nivel 10 pasó a prometer 75% anual —dos
    # años buenos de NVDA extrapolados—, un número que ni es defendible en
    # pantalla ni sirve para decidir.
    #
    # El ancla NO puede ser la media del propio grupo: los candidatos salen de
    # un set curado de ganadores, así que esa media ya viene inflada y encoger
    # hacia ella apenas corrige. Se encoge hacia la expectativa CAPM de cada
    # activo, rf + beta·premio, con el mercado aproximado por la cartera
    # equiponderada de los propios candidatos. Eso conserva la señal relativa
    # —un activo de beta alta sigue esperando más, y por eso los niveles siguen
    # dando carteras distintas— pero le quita la extrapolación de la racha.
    _ENCOGIMIENTO = 0.5     # mitad muestra, mitad modelo
    _PREMIO_MERCADO = 0.055 # premio por riesgo de renta variable, anual
    mercado = df_rets.mean(axis=1)
    var_mkt = float(mercado.var())
    if var_mkt > 0:
        betas = df_rets.apply(lambda c: float(c.cov(mercado)) / var_mkt)
        betas = betas.clip(0.0, 2.5)
        mu_capm = rf_anual + betas * _PREMIO_MERCADO
    else:
        mu_capm = pd.Series(rf_anual + _PREMIO_MERCADO, index=df_rets.columns)
    mu = mu_bruto * _ENCOGIMIENTO + mu_capm * (1 - _ENCOGIMIENTO)

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

    # Segunda pasada: MOVERSE POR LA FRONTERA hasta el objetivo de volatilidad.
    #
    # Antes esto se resolvía mezclando la cartera tangente con efectivo:
    #     w_final = w_maxsharpe * (vol_objetivo / vol_maxsharpe)
    # Teóricamente impecable (es la línea del mercado de capitales) y en la
    # práctica un desastre para lo que la pantalla promete:
    #   · Los diez niveles devolvían LAS MISMAS acciones. Un nivel 1 era el
    #     nivel 7 multiplicado por 0.33, no una selección más defensiva.
    #   · Los pesos no sumaban 100%: en nivel 1 sumaban 30.7% y el 69.3%
    #     restante solo aparecía como una rebanada gris en una barra.
    #   · Por encima de la vol de la cartera tangente (aquí ~19.75%) no había
    #     nada que hacer —no se apalanca—, así que los niveles 8, 9 y 10
    #     devolvían un portafolio idéntico entre sí.
    #
    # Ahora, para cada objetivo se resuelve el punto de la frontera eficiente:
    #     max retorno   sujeto a   vol <= objetivo,  suma(w) = 1,  0 <= wi <= max
    # Eso da una cartera DISTINTA por nivel —más defensiva abajo, más agresiva
    # arriba— y siempre invertida al 100%.
    def _en_frontera(vol_obj):
        restr = [
            {"type": "eq",   "fun": lambda w: np.sum(w) - 1.0},
            {"type": "ineq", "fun": lambda w, v=vol_obj: v - vol_p(w)},   # vol <= objetivo
        ]
        r = minimize(lambda w: -ret_p(w), w_maxsharpe, method="SLSQP",
                     bounds=bounds, constraints=restr,
                     options={"maxiter": 300, "ftol": 1e-8})
        return r

    peso_cash = 0.0
    res_front = _en_frontera(vol_objetivo_anual)
    if res_front.success and vol_p(res_front.x) <= vol_objetivo_anual * 1.02:
        w_final = res_front.x
    else:
        # El objetivo está por DEBAJO de lo que puede dar cualquier combinación
        # de estos activos: ni la cartera de mínima varianza baja tanto. Ahí sí
        # hace falta efectivo, y entonces es un dato real que hay que enseñar,
        # no un residuo. Se busca primero la mínima varianza posible.
        r_minvar = minimize(vol_p, w_maxsharpe, method="SLSQP",
                            bounds=bounds,
                            constraints=[{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}],
                            options={"maxiter": 300, "ftol": 1e-9})
        w_riesgo = r_minvar.x if r_minvar.success else w_maxsharpe
        vol_min = vol_p(w_riesgo)
        if vol_min > vol_objetivo_anual and vol_min > 0:
            alpha = max(0.0, min(1.0, vol_objetivo_anual / vol_min))
            w_final = w_riesgo * alpha
            peso_cash = 1.0 - alpha
        else:
            w_final = w_riesgo

    retorno_esp = float(w_final @ mu.values) + peso_cash * rf_anual
    vol_final = float(np.sqrt(w_final @ cov.values @ w_final))
    sharpe = (retorno_esp - rf_anual) / vol_final if vol_final > 0 else 0

    # Pesos como dict, filtrando el polvo (<0.5%) que el optimizador deja.
    #
    # RENORMALIZAR ES OBLIGATORIO, no cosmético: al tirar las posiciones
    # diminutas se pierde ese porcentaje, y sin repartirlo la lista que ve el
    # usuario suma 99.2% en vez de 100%. Se reparte proporcionalmente entre las
    # que quedan, dentro de la parte invertida (por si hay efectivo).
    crudos = {t: float(w) for t, w in zip(df_rets.columns, w_final) if w > 0.005}
    pesos = _repartir_exacto(crudos, 1.0 - peso_cash)

    # Diversificación: qué fracción del riesgo se eliminó al combinar los activos.
    #
    # La versión anterior comparaba la varianza total contra la suma de las
    # varianzas ponderadas (solo la diagonal de la covarianza):
    #     1 - (w' Σ w) / Σ wi² σi²
    # Eso es estructuralmente NEGATIVO en cualquier cartera normal: con
    # correlaciones positivas —lo típico entre acciones— la varianza del
    # portafolio SUPERA a la suma de la diagonal, así que el cociente pasa de 1
    # y la resta sale en rojo. En pantalla se veía "DIVERSIFICACIÓN -62%", que
    # no significa nada.
    #
    # Se usa el diversification ratio, que es la medida estándar: se compara la
    # volatilidad real contra la que tendría la MISMA cartera si todo estuviera
    # perfectamente correlacionado (Σ wi σi, el peor caso sin diversificar).
    # Queda acotado en [0, 1): 0% = no ganaste nada juntando estos activos,
    # 60% = eliminaste el 60% del riesgo que tendrías sin diversificar.
    vol_individuales = np.sqrt(np.clip(np.diag(cov.values), 0, None))
    vol_sin_diversificar = float(np.sum(w_final * vol_individuales))
    if vol_sin_diversificar > 0:
        pct_diversificable_eliminado = 1 - (vol_final / vol_sin_diversificar)
    else:
        pct_diversificable_eliminado = 0.0
    # Blindaje numérico: con pesos largos el ratio no puede salir de [0,1), pero
    # un redondeo raro no debe volver a poner un porcentaje absurdo en pantalla.
    pct_diversificable_eliminado = max(0.0, min(1.0, pct_diversificable_eliminado))

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
def _frontera_eficiente(df_rets, optimo=None, seleccionados=None, n_puntos=28):
    """Frontera eficiente LONG-ONLY: misma restricción que el portafolio real
    (sin ventas en corto, pesos ≥ 0), para que el punto óptimo (la estrella)
    caiga SOBRE la curva y no debajo de una frontera teórica inalcanzable.

    Para cada retorno objetivo, minimiza la varianza con pesos largos que suman 1.
    Si scipy falla, cae a la frontera analítica clásica.
    """
    cols = list(df_rets.columns)
    n = len(cols)
    if n < 2:
        return None
    mu = df_rets.mean().values * 12.0
    cov = df_rets.cov().values * 12.0

    curva = []
    try:
        from scipy.optimize import minimize
        rmin, rmax = float(mu.min()), float(mu.max())
        if rmax > rmin:
            bounds = [(0.0, 1.0)] * n
            w0 = np.ones(n) / n

            def _var(w):
                return float(w @ cov @ w)

            for k in range(n_puntos):
                r = rmin + (rmax - rmin) * k / (n_puntos - 1)
                cons = (
                    {"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)},
                    {"type": "eq", "fun": (lambda w, _r=r: float(w @ mu - _r))},
                )
                res = minimize(_var, w0, method="SLSQP", bounds=bounds,
                               constraints=cons, options={"maxiter": 120, "ftol": 1e-8})
                if res.success:
                    v = float(np.sqrt(max(_var(res.x), 0.0)))
                    curva.append({"vol": round(v * 100, 2), "ret": round(r * 100, 2)})
            # Quedarnos con la parte EFICIENTE (de la mínima varianza hacia arriba)
            if curva:
                i_gmv = min(range(len(curva)), key=lambda i: curva[i]["vol"])
                curva = curva[i_gmv:]
    except Exception:
        curva = []

    if not curva:
        return _frontera_analitica(df_rets, optimo, seleccionados, 40)

    sel = seleccionados or set()
    activos = [{
        "ticker": cols[i],
        "vol":    round(float(np.sqrt(max(cov[i, i], 0.0))) * 100, 2),
        "ret":    round(float(mu[i]) * 100, 2),
        "sel":    cols[i] in sel,
    } for i in range(n)]
    opt = None
    if optimo and optimo.get("vol") is not None and optimo.get("ret") is not None:
        opt = {"vol": round(float(optimo["vol"]) * 100, 2), "ret": round(float(optimo["ret"]) * 100, 2)}
    return {"curva": curva, "activos": activos, "optimo": opt}


def _frontera_analitica(df_rets, optimo=None, seleccionados=None, n_puntos=40):
    """Frontera eficiente clásica (cierre analítico de Markowitz; solo numpy).
    Fallback si scipy no está disponible. OJO: permite ventas en corto, así que
    queda por ENCIMA de lo alcanzable long-only.
    """
    cols = list(df_rets.columns)
    if len(cols) < 2:
        return None
    mu = df_rets.mean().values * 12.0
    cov = df_rets.cov().values * 12.0
    try:
        inv = np.linalg.pinv(cov)
    except Exception:
        return None
    ones = np.ones(len(mu))
    A = float(ones @ inv @ ones)
    B = float(ones @ inv @ mu)
    C = float(mu @ inv @ mu)
    D = A * C - B * B
    if A <= 0 or D <= 0:
        return None
    r_gmv = B / A                       # retorno del global-minimum-variance
    lo = min(r_gmv, float(mu.min()))
    hi = float(mu.max())
    if hi <= lo:
        return None
    curva = []
    for k in range(n_puntos):
        r = lo + (hi - lo) * k / (n_puntos - 1)
        var = (A * r * r - 2 * B * r + C) / D
        if var > 0:
            curva.append({"vol": round(float(np.sqrt(var)) * 100, 2), "ret": round(r * 100, 2)})
    sel = seleccionados or set()
    activos = [{
        "ticker": cols[i],
        "vol":    round(float(np.sqrt(max(cov[i, i], 0.0))) * 100, 2),
        "ret":    round(float(mu[i]) * 100, 2),
        "sel":    cols[i] in sel,
    } for i in range(len(cols))]
    opt = None
    if optimo and optimo.get("vol") is not None and optimo.get("ret") is not None:
        opt = {"vol": round(float(optimo["vol"]) * 100, 2), "ret": round(float(optimo["ret"]) * 100, 2)}
    return {"curva": curva, "activos": activos, "optimo": opt}


def portafolio_optimo(nivel_riesgo: int = 5, vol_objetivo: Optional[float] = None,
                      forzar: bool = False) -> Dict[str, Any]:
    """Genera el portafolio óptimo.

    Dos modos:
      - vol_objetivo: volatilidad objetivo (σ anual) — el modo "pro" del slider.
        Acepta 14 o 0.14; se clampa a 5%–35%. El nº de acciones se interpola.
      - nivel_riesgo (1-10): modo legacy mapeado en NIVELES.
    """
    if vol_objetivo is not None:
        v = float(vol_objetivo)
        if v > 1:
            v = v / 100.0                       # acepta "14" o "0.14"
        v = max(0.05, min(0.35, v))             # clamp 5%–35%
        n_acc = max(8, min(12, int(round(12 - (v - 0.06) / 0.22 * 4))))
        etiqueta = ("Conservador" if v < 0.09 else "Moderado" if v < 0.13
                    else "Balanceado" if v < 0.17 else "Crecimiento" if v < 0.22
                    else "Agresivo")
        params = {
            "vol_objetivo": v, "n_acciones": n_acc, "etiqueta": etiqueta,
            "descripcion": f"Objetivo de volatilidad ~{v*100:.0f}% anual (desviación estándar σ).",
        }
        max_peso = 0.25 if v >= 0.20 else 0.15
        nivel = max(1, min(10, int(round((v - 0.06) / 0.22 * 9 + 1))))
        cache_key = f"vol_{int(round(v * 100))}"
    else:
        nivel = max(1, min(10, int(nivel_riesgo)))
        params = NIVELES[nivel]
        max_peso = 0.25 if nivel >= 8 else 0.15
        cache_key = f"nivel_{nivel}"
    # La huella de los datos entra en la clave. El CSV del universo lo reescribe
    # a diario un timer de systemd; con una clave que solo dependía del nivel, un
    # cambio de datos no invalidaba nada y el portafolio seguía siendo el de
    # antes hasta que expiraran las 6 horas. Ahora datos nuevos = clave nueva.
    try:
        _fuente = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
        cache_key += "_" + str(int(_fuente.stat().st_mtime))
    except Exception:
        pass

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
        max_peso=max_peso,   # agresivo permite más concentración
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

    # 5) Reducir a top N según el nivel.
    #    Al recortar hay que repartir lo que se cae entre las que quedan, y con
    #    el mismo método exacto: aquí estaba la segunda fuente de listas que
    #    sumaban 99.98%. Y se reparte sobre (1 - efectivo), no sobre 1: si hay
    #    posición en efectivo, renormalizar a 1 haría que el total pasara de 100%.
    n_max = params["n_acciones"]
    if len(acciones) > n_max:
        acciones = acciones[:n_max]
    reparto = _repartir_exacto({a["ticker"]: a["peso"] for a in acciones},
                               1.0 - float(resultado["peso_cash"]))
    for a in acciones:
        a["peso"] = reparto.get(a["ticker"], 0.0)
        a["peso_pct"] = round(a["peso"] * 100, 2)
    acciones = [a for a in acciones if a["peso"] > 0]

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
            "Optimización media-varianza (Markowitz). Para cada nivel se busca el "
            "punto de la frontera eficiente que MAXIMIZA el retorno esperado sin "
            "pasar de la volatilidad objetivo, con pesos positivos y un tope por "
            "posición, de modo que cada nivel da una cartera distinta y siempre "
            "invertida al 100%. El retorno esperado no es el promedio histórico "
            "crudo: se encoge a medio camino de la expectativa CAPM (rf + β·premio) "
            "porque extrapolar la racha reciente es lo que hace que este tipo de "
            "optimizador se vuelque sobre lo que más subió. Solo cuando la "
            "volatilidad objetivo queda por debajo de lo que puede dar cualquier "
            "combinación de estos activos aparece una posición en efectivo "
            "(CETES/UST), y entonces se muestra como una posición más."
        ),
        "disclaimer": (
            "Backtesting sobre historia pasada. No garantiza rendimientos futuros. "
            "Considera tu horizonte, impuestos y situación personal antes de invertir."
        ),
    }

    # 6) Frontera eficiente (para graficar riesgo/retorno; solo numpy)
    try:
        data["frontera"] = _frontera_eficiente(
            df_rets,
            optimo={"vol": resultado["volatilidad_anual"], "ret": resultado["retorno_esperado"]},
            seleccionados={a["ticker"] for a in acciones},
        )
    except Exception:
        data["frontera"] = None

    ts = time.time()
    _CACHE[cache_key] = {"ts": ts, "data": data}
    try:
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass

    return data
