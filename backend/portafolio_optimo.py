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
# LOS TAMAÑOS SUBIERON AL PONER EL TOPE DE 10% POR EMISORA. Es aritmética, no
# preferencia: con un máximo de 10% hacen falta 10 posiciones solo para llegar
# al 100%, y con exactamente 10 la única solución posible es 10% en cada una
# —equiponderado, sin optimización—. Los tamaños de antes (8 y 9 en los niveles
# altos) hacían el tope directamente infactible: 8 × 10% = 80% invertido.
# Con 14-18 nombres el optimizador conserva margen real para repartir.
# ─────────────────────────────────────────────────────────
# Tope duro por emisora, igual en los diez niveles. Que un nivel agresivo
# permitiera 25% en una sola acción no era "más riesgo", era riesgo NO
# COMPENSADO: el mercado no paga por el riesgo específico de una empresa, solo
# por el sistemático. Concentrar en una emisora añade varianza sin añadir
# retorno esperado, que es justo lo contrario de maximizar retorno por unidad
# de riesgo.
_MAX_POR_EMISORA = 0.10

# Se sube al cambiar las REGLAS (tope, objetivo, restricciones). Invalida caché.
_VERSION_ALGORITMO = 8

# Más candidatos entre los que elegir. Con 40 y un tope del 10% por emisora, el
# optimizador se quedaba sin dónde repartir: 7 u 8 de las posiciones acababan
# PEGADAS al tope, o sea que la "optimización" era casi equiponderar los mejores
# y el nivel de riesgo apenas movía la cartera.
_MAX_CANDIDATOS = 90

# Tope por SECTOR. El límite del 10% por emisora no diversifica por sí solo: diez
# tecnológicas al 10% son diez formas de apostar a lo mismo. El riesgo que de
# verdad hace daño en una caída es el sectorial, no el de una empresa suelta.
_MAX_POR_SECTOR = 0.30

NIVELES = {
    1:  {"vol_objetivo": 0.06, "n_acciones": 20, "etiqueta": "Conservador",
         "descripcion": "Preservación de capital. Vol objetivo ~6%."},
    2:  {"vol_objetivo": 0.08, "n_acciones": 20, "etiqueta": "Conservador+",
         "descripcion": "Capital con ingreso. Vol objetivo ~8%."},
    3:  {"vol_objetivo": 0.1, "n_acciones": 20, "etiqueta": "Moderado bajo",
         "descripcion": "Crecimiento con cautela. Vol objetivo ~10%."},
    4:  {"vol_objetivo": 0.12, "n_acciones": 20, "etiqueta": "Moderado",
         "descripcion": "Balance retorno/riesgo. Vol objetivo ~12%."},
    5:  {"vol_objetivo": 0.14, "n_acciones": 22, "etiqueta": "Balanceado",
         "descripcion": "Similar al S&P500. Vol objetivo ~14%."},
    6:  {"vol_objetivo": 0.16, "n_acciones": 22, "etiqueta": "Balanceado+",
         "descripcion": "Por encima de mercado. Vol objetivo ~16%."},
    7:  {"vol_objetivo": 0.18, "n_acciones": 24, "etiqueta": "Crecimiento",
         "descripcion": "Sobreponderar growth. Vol objetivo ~18%."},
    8:  {"vol_objetivo": 0.2, "n_acciones": 24, "etiqueta": "Crecimiento+",
         "descripcion": "Convicción alta. Vol objetivo ~20%."},
    9:  {"vol_objetivo": 0.225, "n_acciones": 26, "etiqueta": "Agresivo",
         "descripcion": "Alta volatilidad por mayor retorno. Vol objetivo ~22.5%."},
    10: {"vol_objetivo": 0.25, "n_acciones": 26, "etiqueta": "Muy agresivo",
         "descripcion": "Máxima exposición a renta variable. Vol objetivo ~25%."},
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


# ─────────────────────────────────────────────────────────
# Sectores: enriquecer lo que el universo dejó en "Desconocido"
# ─────────────────────────────────────────────────────────
# El universo se construye con `descargar_universo.py`, que escribe
# literalmente "Desconocido" en el sector de todo lo que no es ETF: nunca se lo
# pidió a Yahoo. Resultado: el 96% del universo y el 23% del set curado —casi
# todas las emisoras mexicanas— sin sector.
#
# Eso hacía IMPOSIBLE diversificar por sector, y peor, imposible siquiera
# medirlo: las carteras salían con "Desconocido" al 54-88% y parecían
# diversificadas cuando nadie sabía si lo estaban. Poner una restricción de
# sector sobre ese dato habría sido teatro.
#
# Se enriquece SOLO lo que hace falta (el set curado son ~171 tickers, de los
# que faltan ~39) y se cachea en disco, porque cada consulta es una llamada a
# Yahoo y el dato no cambia.
_SECTORES_PATH = _BACKEND_DIR / "_datos" / "sectores_cache.json"
_SECTORES_MEM: Dict[str, str] = {}
_SIN_SECTOR = {None, "", "Desconocido", "desconocido"}


def _sectores_cache() -> Dict[str, str]:
    global _SECTORES_MEM
    if _SECTORES_MEM:
        return _SECTORES_MEM
    try:
        if _SECTORES_PATH.exists():
            with open(_SECTORES_PATH, encoding="utf-8") as f:
                _SECTORES_MEM = json.load(f) or {}
    except Exception:
        _SECTORES_MEM = {}
    return _SECTORES_MEM


def _guardar_sectores(d: Dict[str, str]) -> None:
    try:
        _SECTORES_PATH.parent.mkdir(exist_ok=True)
        tmp = _SECTORES_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        tmp.replace(_SECTORES_PATH)
    except Exception:
        pass


def _enriquecer_sectores(tickers, info_all: Dict[str, Any], limite: int = 120) -> None:
    """Rellena el sector de los tickers que lo tengan en 'Desconocido'.

    Escribe sobre `info_all` en memoria y deja el resultado cacheado en disco.
    `limite` acota cuántas consultas a Yahoo se hacen por ejecución: con la
    caché fría se completa en dos o tres pasadas en vez de bloquear la primera.
    """
    cache = _sectores_cache()
    pendientes = []
    for t in tickers:
        actual = (info_all.get(t) or {}).get("sector")
        if actual not in _SIN_SECTOR:
            continue
        if t in cache:
            info_all.setdefault(t, {})["sector"] = cache[t]
        else:
            pendientes.append(t)

    if not pendientes:
        return
    try:
        import yfinance as yf
    except Exception:
        return
    nuevos = 0
    for t in pendientes[:limite]:
        try:
            sec = (yf.Ticker(t).info or {}).get("sector")
        except Exception:
            sec = None
        # Se cachea TAMBIÉN el fallo, como "Desconocido": si no, cada corrida
        # volvería a preguntar por los mismos tickers sin sector en Yahoo.
        cache[t] = sec or "Desconocido"
        info_all.setdefault(t, {})["sector"] = cache[t]
        nuevos += 1
    if nuevos:
        _guardar_sectores(cache)


def _liquidez_diaria(info: Dict[str, Any], precio: Optional[float]) -> float:
    vol = (info.get("averageVolume") or info.get("average_volume") or 0)
    if vol and precio:
        return float(vol) * float(precio)
    return float(info.get("market_cap") or info.get("marketCap") or 0)


# ─────────────────────────────────────────────────────────
# Selección de candidatos para Markowitz
# ─────────────────────────────────────────────────────────
def _preseleccion_barata(df_precios: pd.DataFrame, info_all: Dict[str, Any],
                         tope: int = 800) -> List[str]:
    """Triaje sobre el universo COMPLETO, sin puntuar.

    El optimizador miraba solo las ~171 emisoras marcadas `recomendada`, que es
    una lista curada a mano: el resto del universo —casi 9,000 tickers— no se
    consideraba nunca, por buena que fuera una emisora.

    Puntuar los 9,000 con el score canónico cuesta ~49 s (5.5 ms cada uno), que
    es inaceptable en una petición. Así que primero se tria con operaciones
    vectorizadas sobre la matriz de precios —milisegundos— y solo los que pasan
    llegan al score caro.

    El filtro no pretende elegir buenas empresas, solo descartar lo que no es
    invertible: sin historia suficiente para estimar covarianzas, o de precio
    tan bajo que el spread se come cualquier resultado. El orden lo pone un
    proxy barato de retorno ajustado por riesgo; la decisión real la sigue
    tomando el score canónico después.
    """
    try:
        # 1) Historia suficiente para que la covarianza signifique algo.
        validos = df_precios.notna().sum()
        cols = validos[validos >= 500].index

        # 2) Fuera lo que no es una acción/ETF invertible.
        descartar = set()
        for t in cols:
            info = info_all.get(t) or {}
            tipo = (info.get("tipo") or info.get("quoteType") or "").upper()
            if tipo in ("CRYPTOCURRENCY", "MUTUALFUND", "INDEX", "FUTURE"):
                descartar.add(t)
            elif MC.es_crypto(t):
                descartar.add(t)
            else:
                # APALANCADOS E INVERSOS FUERA. SOXL (3x semiconductores) o KORU
                # (3x Corea) puntúan altísimo en cualquier proxy de retorno tras
                # un buen semestre, pero se reajustan a diario: en un lateral
                # pierden valor aunque el índice acabe igual. No son una versión
                # "más agresiva" del subyacente, son otro instrumento, y no
                # tienen sitio en una cartera que se arma para mantener.
                nom = (info.get("nombre") or "").upper()
                if any(k in nom for k in ("3X", "2X", "ULTRA", "LEVERAGED",
                                          "INVERSE", "-1X", "SHORT ", "BEAR")):
                    descartar.add(t)
        cols = [c for c in cols if c not in descartar]
        if not cols:
            return []

        sub = df_precios[cols].tail(378)          # ~18 meses hábiles
        ultimo = sub.ffill().iloc[-1]
        cols = [c for c in cols if float(ultimo.get(c) or 0) >= 5.0]   # sin centavos
        if not cols:
            return []

        # 3) Orden por retorno ajustado por riesgo, todo vectorizado.
        sub = df_precios[cols].tail(378).ffill()
        rets = sub.pct_change().dropna(how="all")
        vol = rets.std() * (252 ** 0.5)
        ret = sub.iloc[-1] / sub.iloc[0] - 1.0

        # PISO DE VOLATILIDAD. Sin él, el proxy retorno/volatilidad se dispara
        # justo donde la volatilidad tiende a cero, y los primeros puestos se
        # llenaban de ETFs de deuda ultracorta —SGOV, SHV, BILZ, MINT, GBIL—:
        # un cociente enorme que no viene de buen retorno sino de un
        # denominador diminuto. Además duplican el papel que ya cubre CETES,
        # que sí es el instrumento correcto para esa función y no paga comisión
        # de ETF. Aquí se busca renta variable.
        vol = vol[vol >= 0.04]
        proxy = (ret.reindex(vol.index) / vol)
        proxy = proxy.replace([float("inf"), float("-inf")], float("nan")).dropna()

        ordenados = list(proxy.sort_values(ascending=False).index)
    except Exception:
        ordenados = []

    # Las curadas entran SIEMPRE: son la lista con la que el producto se probó,
    # y el triaje no debe poder tirarlas por un mal semestre.
    curadas = [t for t, v in info_all.items()
               if isinstance(v, dict) and v.get("recomendada") and t in df_precios.columns]
    vistos = set()
    salida = []
    for t in curadas + ordenados:
        if t not in vistos:
            vistos.add(t)
            salida.append(t)
        if len(salida) >= tope:
            break
    return salida


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

    # Universo COMPLETO, triado barato antes de puntuar. Antes este bucle
    # recorría df_precios entero pero descartaba todo lo que no fuera
    # `recomendada`: de 8,934 tickers solo competían 171.
    for t in _preseleccion_barata(df_precios, info_all):
        info = info_all.get(t, {})
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


def _repartir_con_tope(crudos: Dict[str, float], objetivo: float,
                       tope: float) -> Dict[str, float]:
    """Reparte `objetivo` respetando un peso máximo por posición.

    `_repartir_exacto` normaliza proporcionalmente, y al hacerlo puede empujar a
    los mayores por encima del tope —justo lo que pasaba al recortar a los N
    mejores—. Aquí se reparte por rondas: se recorta a quien pase del límite y
    su excedente se reparte entre quienes aún tienen holgura, hasta que nadie
    lo rebase o ya no quepa más.

    Si el objetivo no cabe bajo el tope (por ejemplo 8 posiciones con tope 10%
    solo llegan al 80%), se devuelve lo que sí cabe: es preferible enseñar una
    cartera al 80% —y que el efectivo se vea— a inflar pesos por encima de una
    regla que la propia pantalla promete.
    """
    if not crudos or objetivo <= 0 or tope <= 0:
        return {}
    tickers = list(crudos)
    techo_total = tope * len(tickers)
    meta = min(objetivo, techo_total)

    pesos = {t: max(0.0, float(w)) for t, w in crudos.items()}
    total = sum(pesos.values())
    if total <= 0:
        pesos = {t: 1.0 for t in tickers}
        total = float(len(tickers))
    pesos = {t: w / total * meta for t, w in pesos.items()}

    for _ in range(24):                       # converge en 2-3; el tope es por si acaso
        exceso = 0.0
        holgura = []
        for t in tickers:
            if pesos[t] > tope:
                exceso += pesos[t] - tope
                pesos[t] = tope
            elif pesos[t] < tope:
                holgura.append(t)
        if exceso <= 1e-12 or not holgura:
            break
        margen = sum(tope - pesos[t] for t in holgura)
        if margen <= 1e-12:
            break
        repartible = min(exceso, margen)
        for t in holgura:                     # a prorrata del margen disponible
            pesos[t] += repartible * ((tope - pesos[t]) / margen)

    # El cierre exacto a cuatro decimales lo sigue haciendo el método del resto
    # mayor, pero ya sobre pesos que caben bajo el tope.
    return _repartir_exacto(pesos, sum(pesos.values()))


def _optimizar_markowitz(
    df_rets: pd.DataFrame,
    vol_objetivo_anual: float,
    rf_anual: float,
    max_peso: float = 0.10,
    sectores: Optional[Dict[str, str]] = None,
    max_sector: float = 1.0,
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
    # ENCOGIMIENTO MÁS FUERTE AL AMPLIAR EL UNIVERSO. Era 0.5 (mitad muestra,
    # mitad modelo) cuando el optimizador elegía entre 171 candidatos curados.
    # Al abrirlo a todo el universo pasa a elegir entre ~800, y Markowitz es un
    # maximizador de errores de estimación: cuantos más activos mire, más
    # probable es que el "mejor" de la muestra lo sea por suerte y no por
    # calidad. Se vio de inmediato — el Sharpe superaba 2.8 en el nivel
    # conservador, que no es creíble fuera de muestra. Con 0.7 manda el modelo
    # (CAPM) y la muestra solo inclina.
    _ENCOGIMIENTO = 0.3     # 30% muestra, 70% modelo
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
    # ── Alfa contra la SML ─────────────────────────────────────────────────
    # "Llegar a la SML" significa que la cartera gane AL MENOS lo que el CAPM
    # predice para el riesgo sistemático que carga:
    #     alfa = retorno − (rf + beta_cartera · premio de mercado)
    # Un alfa negativo es una cartera que asume beta y no cobra por ella: está
    # POR DEBAJO de la línea, y eso no se puede defender ante nadie.
    #
    # Se pide como restricción, no como objetivo, para no acabar eligiendo la
    # cartera de mayor alfa aunque tenga peor Sharpe. Lo que se maximiza sigue
    # siendo retorno por unidad de riesgo; la SML es el suelo.
    betas_v = betas.values if var_mkt > 0 else np.zeros(n)

    # Una máscara 0/1 por sector con más de un candidato. Los sectores con un
    # solo nombre no necesitan restricción: ya los limita el tope por emisora.
    mascaras_sector = []
    if sectores and max_sector < 1.0:
        from collections import defaultdict
        grupos = defaultdict(list)
        for i, t in enumerate(df_rets.columns):
            sec = (sectores.get(t) or "Desconocido")
            grupos[sec].append(i)
        for sec, idxs in grupos.items():
            # "Desconocido" NO se restringe: agrupar lo que no se pudo clasificar
            # trataría como un sector a un cajón de sastre, y el límite caería
            # sobre emisoras que quizá no tienen nada que ver entre sí.
            if sec == "Desconocido" or len(idxs) < 2:
                continue
            m = np.zeros(n)
            m[idxs] = 1.0
            mascaras_sector.append(m)

    def alfa_p(w):
        return ret_p(w) - (rf_anual + float(w @ betas_v) * _PREMIO_MERCADO)

    def _en_frontera(vol_obj, con_sml=True):
        """Mejor Sharpe DENTRO de la banda de riesgo del nivel.

        Antes esto maximizaba RETORNO sujeto a vol <= objetivo. Cuando la
        restricción aprieta las dos cosas coinciden; cuando no —los niveles
        altos, cuyo objetivo queda por encima de la cartera tangente— maximizar
        retorno empuja más allá de la tangente y EMPEORA el retorno por unidad
        de riesgo, que es justo lo que se quería maximizar.

        Se optimiza Sharpe, pero dentro de una BANDA [0.85·objetivo, objetivo],
        no solo con techo. Sin el piso, todos los niveles por encima de la
        tangente colapsarían en la misma cartera —el bug que ya se corrigió una
        vez— y el nivel 10 dejaría de significar nada. Con banda, cada nivel
        entrega la mejor relación retorno/riesgo DENTRO del riesgo que el
        usuario eligió, que es lo que promete la pantalla.
        """
        restr = [
            {"type": "eq",   "fun": lambda w: np.sum(w) - 1.0},
            {"type": "ineq", "fun": lambda w, v=vol_obj: v - vol_p(w)},          # techo
            {"type": "ineq", "fun": lambda w, v=vol_obj: vol_p(w) - v * 0.85},   # piso
        ]
        # Ningún sector por encima de `max_sector`. El tope por emisora no
        # diversifica solo: diez tecnológicas al 10% son diez formas de apostar
        # a lo mismo, y en una caída sectorial se hunden juntas.
        for _mask in mascaras_sector:
            restr.append({"type": "ineq",
                          "fun": lambda w, m=_mask: max_sector - float(w @ m)})
        if con_sml:
            restr.append({"type": "ineq", "fun": lambda w: alfa_p(w)})           # alfa >= 0
        r = minimize(neg_sharpe, w_maxsharpe, method="SLSQP",
                     bounds=bounds, constraints=restr,
                     options={"maxiter": 400, "ftol": 1e-9})
        return r

    peso_cash = 0.0
    sml_cumplida = True
    res_front = _en_frontera(vol_objetivo_anual, con_sml=True)
    if not (res_front.success and vol_p(res_front.x) <= vol_objetivo_anual * 1.02):
        # Con estos candidatos no hay ninguna combinación que llegue a la SML
        # dentro de la banda de riesgo. Se resuelve sin esa restricción y se
        # DEVUELVE el dato: una cartera bajo la línea es información, no algo
        # que deba taparse eligiendo otra solución en silencio.
        alt = _en_frontera(vol_objetivo_anual, con_sml=False)
        if alt.success:
            res_front = alt
            sml_cumplida = False
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
    # Posición final frente a la SML, ya con el efectivo dentro (beta 0, renta rf).
    _beta_final = float(w_final @ betas_v)
    _alfa_final = retorno_esp - (rf_anual + _beta_final * _PREMIO_MERCADO)
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
        # Posición frente a la SML. Se devuelve SIEMPRE, también cuando no se
        # cumple: una cartera por debajo de la línea es un dato que el usuario
        # tiene derecho a ver, no algo que deba desaparecer del payload.
        # El alfa se mide sobre la cartera COMPLETA, efectivo incluido. `alfa_p`
        # trabaja con pesos que suman 1 (dentro del optimizador siempre es así),
        # pero en la rama con efectivo w_final suma menos y el retorno real lleva
        # además `efectivo × rf`. Sin ese término el alfa salía subestimado y el
        # nivel 1 se reportaba bajo la SML cuando no lo estaba.
        "beta_portafolio":       round(_beta_final, 3),
        "alfa_vs_sml":           round(_alfa_final, 4),
        "sobre_la_sml":          bool(sml_cumplida and _alfa_final >= -1e-6),
        "max_peso_emisora":      round(max_peso, 4),
        "peso_mayor":            round(float(np.max(w_final)), 4),
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
        max_peso = _MAX_POR_EMISORA
        nivel = max(1, min(10, int(round((v - 0.06) / 0.19 * 9 + 1))))
        cache_key = f"vol_{int(round(v * 100))}"
    else:
        nivel = max(1, min(10, int(nivel_riesgo)))
        params = NIVELES[nivel]
        max_peso = _MAX_POR_EMISORA
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
    # La clave dependía SOLO de los datos, así que al cambiar las REGLAS del
    # optimizador seguía sirviendo carteras calculadas con las anteriores hasta
    # que caducara el TTL de 6 horas. Se versiona el algoritmo: cualquier cambio
    # de reglas sube ese número y las cachés viejas quedan huérfanas al instante.
    cache_key += f"_alg{_VERSION_ALGORITMO}"

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
    candidatos = _seleccionar_candidatos(df_precios, info_all, nivel, max_candidatos=_MAX_CANDIDATOS)
    if len(candidatos) < 5:
        return {"ok": False, "error": "No hay suficientes candidatos con score positivo"}

    # Sector real de los candidatos antes de repartir: sin esto, la restricción
    # de concentración por sector operaría sobre un campo que en su mayoría dice
    # "Desconocido" y no restringiría nada.
    _enriquecer_sectores(candidatos, info_all)

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
        max_peso=max_peso,   # tope duro por emisora (ver _MAX_POR_EMISORA)
        sectores={t: (info_all.get(t) or {}).get("sector") or "Desconocido"
                  for t in candidatos},
        max_sector=_MAX_POR_SECTOR,
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
    #    OJO: repartir sin tope rompía la regla del 10% en el último paso. Al
    #    recortar a los N mejores, el peso de los que se caen se reparte entre
    #    los que quedan proporcionalmente, y eso empujaba a los mayores por
    #    encima del máximo —así salía un 15.56% con el tope en 15%—. De nada
    #    sirve imponer el límite en el optimizador si el post-proceso lo deshace.
    #    Qué se hace con el efectivo se decide ANTES de repartir, porque cambia
    #    el objetivo del reparto:
    #      · si es significativo  → se vuelve una posición en CETES (abajo) y el
    #        reparto de acciones va sobre (1 − esa parte);
    #      · si es un residuo de redondeo (<0.5%) → NO se deja colgando. Antes se
    #        quedaba como "efectivo 0.2%" y las posiciones sumaban 99.78%: un
    #        sobrante invisible que no es ni cartera ni instrumento. Se reparte
    #        entre las acciones, siempre respetando el tope.
    _cash_bruto = float(resultado.get("peso_cash") or 0.0)
    _cash_es_posicion = _cash_bruto > 0.005
    _objetivo_acciones = (1.0 - _cash_bruto) if _cash_es_posicion else 1.0

    reparto = _repartir_con_tope({a["ticker"]: a["peso"] for a in acciones},
                                 _objetivo_acciones,
                                 _MAX_POR_EMISORA)
    for a in acciones:
        a["peso"] = reparto.get(a["ticker"], 0.0)
        a["peso_pct"] = round(a["peso"] * 100, 2)
    acciones = [a for a in acciones if a["peso"] > 0]

    # 6) El "efectivo" pasa a ser una posición REAL en CETES.
    #
    #    Antes, cuando el objetivo de volatilidad quedaba por debajo de lo que
    #    puede dar cualquier combinación de acciones, el resto aparecía como una
    #    rebanada gris de "cash". Eso es una abstracción que nadie puede comprar:
    #    el usuario veía 49% de su cartera en algo sin nombre ni forma de
    #    ejecutarlo. CETES sí se compra, en cetesdirecto y desde $100.
    #
    #    NO le aplica el tope del 10%. Ese límite existe contra el riesgo
    #    específico de una EMPRESA, y CETES es deuda del gobierno federal: no hay
    #    riesgo idiosincrático que diversificar. Capearlo al 10% dejaría al nivel
    #    conservador sin forma de bajar la volatilidad, que es justo su trabajo.
    _cash = _cash_bruto
    if _cash_es_posicion:
        try:
            import renta_fija_mx as _rf
            _tasa = ((_rf.obtener_cetes() or {}).get("tasas") or {}).get("28", {}).get("tasa_pct")
        except Exception:
            _tasa = None
        acciones.append({
            "ticker":   "CETES28",
            "nombre":   "CETES 28 días",
            "sector":   "Renta fija MX",
            "peso":     round(_cash, 4),
            "peso_pct": round(_cash * 100, 2),
            # CETES se colocan a descuento sobre un valor nominal de $10 MXN.
            "precio":   10.0,
            "es_mx":    True,
            # Marca para que la interfaz no lo trate como una acción: no tiene
            # gráfica, ni score, ni se compra por un broker con ticker.
            "es_renta_fija": True,
            "tasa_pct": _tasa,
        })
        _cash = 0.0
    else:
        # Residuo absorbido por las acciones: ya no queda efectivo que reportar.
        _cash = 0.0

    data = {
        "ok":                    True,
        "nivel":                 nivel,
        "etiqueta":              params["etiqueta"],
        "descripcion":           params["descripcion"],
        "vol_objetivo":          params["vol_objetivo"],
        "fecha":                 time.strftime("%Y-%m-%d"),
        "actualizado_ts":        int(time.time()),

        # Regla de concentración y posición frente a la SML.
        "max_peso_emisora":      resultado.get("max_peso_emisora"),
        "peso_mayor":            max((a["peso"] for a in acciones), default=0.0),
        "beta_portafolio":       resultado.get("beta_portafolio"),
        "alfa_vs_sml":           resultado.get("alfa_vs_sml"),
        "sobre_la_sml":          resultado.get("sobre_la_sml"),

        # Métricas del portafolio
        "retorno_esperado":      resultado["retorno_esperado"],
        "volatilidad_anual":     resultado["volatilidad_anual"],
        "sharpe":                resultado["sharpe"],
        # Se conserva la clave por compatibilidad, pero ya siempre en 0: lo que
        # antes era efectivo ahora es una posición en CETES dentro de `acciones`.
        "peso_cash":             _cash,
        "n_acciones":            len(acciones),
        "diversificacion_pct":   resultado["diversificacion_pct"],

        # Composición
        "acciones":              acciones,

        # Metodología
        "metodologia": (
            "Optimización media-varianza (Markowitz) con tres reglas duras. "
            "PRIMERA: ninguna emisora puede pasar del 10% de la cartera. El "
            "mercado no paga por el riesgo específico de una empresa, solo por el "
            "sistemático, así que concentrar añade varianza sin añadir retorno "
            "esperado. SEGUNDA: se maximiza el retorno por unidad de riesgo "
            "(Sharpe) dentro de la banda de volatilidad del nivel elegido, no el "
            "retorno a secas: pasada la cartera tangente, exprimir más retorno "
            "empeora la relación riesgo/retorno. TERCERA: la cartera debe quedar "
            "sobre la Línea del Mercado de Valores (SML), es decir ganar al menos "
            "lo que el CAPM predice para el beta que carga; si con los candidatos "
            "disponibles no se puede, se dice. El retorno esperado no es el promedio histórico "
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
