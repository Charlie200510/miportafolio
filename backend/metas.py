# ============================================================
#  SIMULADOR DE METAS — MONTE CARLO
# ============================================================
#  Responde preguntas como:
#    "Si invierto $5,000 al mes durante 25 años, ¿a qué
#     probabilidad llego a $5,000,000 MXN?"
#    "¿Cuánto acumularía en el escenario pesimista / optimista?"
#
#  Método: simulación de Monte Carlo con movimiento browniano
#  geométrico simplificado. Para cada mes, sorteamos un retorno
#  aleatorio de una distribución normal con media y desviación
#  típica anualizadas que el usuario escoge (o un perfil preset).
#
#  Luego aplicamos:
#     V[t+1] = V[t] * (1 + r_t) + aporte_mensual
#
#  Corremos N simulaciones (default 3000) y reportamos percentiles.
#
#  Los resultados se presentan tanto en valores nominales como
#  en valores reales (deflactados por inflación) porque un
#  usuario que va a vivir del dinero dentro de 25 años necesita
#  saber qué poder de compra le queda.
# ============================================================
from __future__ import annotations

import math
import numpy as np


# ------------------------------------------------------------
# Perfiles preset (retorno / volatilidad anuales)
# ------------------------------------------------------------
PERFILES = {
    "conservador": {
        "nombre": "Conservador",
        "retorno_anual":     0.05,   # ~5% nominal (mix bonos/dividendos)
        "volatilidad_anual": 0.06,   # baja volatilidad
        "descripcion": "Mayormente bonos y dividendos. Menos sube, menos baja.",
    },
    "moderado": {
        "nombre": "Moderado",
        "retorno_anual":     0.08,   # ~8% (60/40 clásico)
        "volatilidad_anual": 0.11,
        "descripcion": "Portafolio 60/40 clásico. El punto medio razonable.",
    },
    "agresivo": {
        "nombre": "Agresivo (100% acciones)",
        "retorno_anual":     0.10,   # ~10% (S&P 500 histórico)
        "volatilidad_anual": 0.17,
        "descripcion": "Similar al S&P 500. Sube más en el tiempo, pero aguantas caídas fuertes.",
    },
    "muy_agresivo": {
        "nombre": "Muy agresivo (tech/emergentes)",
        "retorno_anual":     0.12,
        "volatilidad_anual": 0.24,
        "descripcion": "Acciones de alto crecimiento. Retornos potencialmente más altos, pero con sustos.",
    },
}


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def _anualizado_a_mensual(r_anual: float, sigma_anual: float) -> tuple[float, float]:
    """Convierte mu y sigma anuales a mensuales (aprox. estándar)."""
    # Media mensual para que (1+mu_m)^12 ≈ (1+r_anual). Usamos log para estabilidad.
    mu_m    = math.log(1.0 + r_anual) / 12.0
    sigma_m = sigma_anual / math.sqrt(12.0)
    return mu_m, sigma_m


def _lista_meses_resumen(num_meses: int) -> list[int]:
    """Índices de mes para reportar en la serie percentil (mes 0, 12, 24, ...)."""
    if num_meses <= 12:
        return list(range(0, num_meses + 1))
    # Un punto por año
    pts = list(range(0, num_meses + 1, 12))
    if pts[-1] != num_meses:
        pts.append(num_meses)
    return pts


# ------------------------------------------------------------
# Simulación principal
# ------------------------------------------------------------
def simular_meta(
    capital_inicial: float,
    aporte_mensual: float,
    horizonte_anos: float,
    retorno_anual: float = 0.08,
    volatilidad_anual: float = 0.11,
    inflacion_anual: float = 0.04,
    meta_monto: float | None = None,
    meta_ingreso_mensual: float | None = None,
    tasa_retiro_segura: float = 0.04,
    num_simulaciones: int = 3000,
    seed: int | None = None,
) -> dict:
    """
    Corre Monte Carlo y regresa distribución del valor final + probabilidad
    de alcanzar la meta + serie temporal de percentiles para graficar.

    Args:
        capital_inicial:      Lo que ya tiene invertido hoy.
        aporte_mensual:       Lo que aporta cada mes (constante).
        horizonte_anos:       Años hasta la meta.
        retorno_anual:        Expectativa de retorno anual (e.g., 0.08 = 8%).
        volatilidad_anual:    Desviación típica anual (e.g., 0.15).
        inflacion_anual:      Para valores reales (default 4% MX).
        meta_monto:           Meta en pesos/dólares. Opcional.
        meta_ingreso_mensual: Meta como ingreso mensual en retiro. Si se usa,
                              convierte a meta_monto = meta_mensual * 12 / tasa_retiro.
        tasa_retiro_segura:   Regla del 4% por default (safe withdrawal rate).
        num_simulaciones:     Cuántos caminos simular (default 3000).
        seed:                 Para reproducibilidad.

    Returns:
        dict con probabilidad, percentiles, paths muestra, etc.
    """
    # ---- Validaciones -----------------------------------------
    if capital_inicial < 0:
        raise ValueError("capital_inicial no puede ser negativo")
    if aporte_mensual < 0:
        raise ValueError("aporte_mensual no puede ser negativo")
    if horizonte_anos <= 0 or horizonte_anos > 60:
        raise ValueError("horizonte_anos debe estar entre 0 y 60 años")
    if retorno_anual < -0.5 or retorno_anual > 0.5:
        raise ValueError("retorno_anual debe estar entre -50% y 50%")
    if volatilidad_anual < 0 or volatilidad_anual > 1.0:
        raise ValueError("volatilidad_anual debe estar entre 0 y 100%")
    if num_simulaciones < 200 or num_simulaciones > 20000:
        num_simulaciones = max(200, min(num_simulaciones, 20000))

    # ---- Derivar meta efectiva -------------------------------
    meta_efectiva = None
    meta_origen = None
    if meta_ingreso_mensual and meta_ingreso_mensual > 0:
        if tasa_retiro_segura <= 0:
            tasa_retiro_segura = 0.04
        meta_efectiva = meta_ingreso_mensual * 12.0 / tasa_retiro_segura
        meta_origen = "ingreso_mensual"
    elif meta_monto and meta_monto > 0:
        meta_efectiva = float(meta_monto)
        meta_origen = "monto"

    # ---- Parámetros simulación -------------------------------
    meses = int(round(horizonte_anos * 12))
    if meses <= 0:
        meses = 1
    mu_m, sigma_m = _anualizado_a_mensual(retorno_anual, volatilidad_anual)

    rng = np.random.default_rng(seed)
    # returns shape: (N, meses)
    returns = rng.normal(mu_m, sigma_m, size=(num_simulaciones, meses))
    # Para evitar retornos mensuales que destruyan el portafolio (bound <= -95%)
    returns = np.clip(returns, -0.95, 1.5)

    # ---- Simulación (vectorizada por pasos) -------------------
    V = np.empty((num_simulaciones, meses + 1), dtype=np.float64)
    V[:, 0] = capital_inicial
    for t in range(meses):
        V[:, t + 1] = V[:, t] * (1.0 + returns[:, t]) + aporte_mensual

    valor_final = V[:, -1]

    # ---- Deflactar a reales ---------------------------------
    factor_inflacion = (1.0 + inflacion_anual) ** horizonte_anos
    valor_final_real = valor_final / factor_inflacion

    # ---- Percentiles --------------------------------------
    def _pct(arr, q):
        return float(np.percentile(arr, q))

    percentiles_nom = {
        "p5":  _pct(valor_final,  5),
        "p10": _pct(valor_final, 10),
        "p25": _pct(valor_final, 25),
        "p50": _pct(valor_final, 50),
        "p75": _pct(valor_final, 75),
        "p90": _pct(valor_final, 90),
        "p95": _pct(valor_final, 95),
    }
    percentiles_real = {
        "p5":  _pct(valor_final_real,  5),
        "p10": _pct(valor_final_real, 10),
        "p25": _pct(valor_final_real, 25),
        "p50": _pct(valor_final_real, 50),
        "p75": _pct(valor_final_real, 75),
        "p90": _pct(valor_final_real, 90),
        "p95": _pct(valor_final_real, 95),
    }

    # ---- Probabilidad de meta ---------------------------------
    prob_meta = None
    meses_mediana_meta = None
    if meta_efectiva is not None:
        alcanzaron = valor_final >= meta_efectiva
        prob_meta = float(alcanzaron.mean())

        # ¿En qué mes (mediana) se cruza la meta?
        # Encuentra primer mes >= meta por simulación
        cruzados = (V >= meta_efectiva)
        # argmax encuentra el primer True; si no hay True, argmax=0 → filtramos
        hay_cruce = cruzados.any(axis=1)
        if hay_cruce.any():
            # argmax sobre axis 1 da el índice del primer True
            idx = np.argmax(cruzados, axis=1)
            idx_con_cruce = idx[hay_cruce]
            meses_mediana_meta = int(np.median(idx_con_cruce))
        else:
            meses_mediana_meta = None

    # ---- Serie temporal de percentiles para graficar ----------
    meses_reporte = _lista_meses_resumen(meses)
    serie = []
    for m in meses_reporte:
        col = V[:, m]
        col_real = col / ((1.0 + inflacion_anual) ** (m / 12.0))
        serie.append({
            "mes": m,
            "anos": round(m / 12.0, 2),
            "p10":  round(float(np.percentile(col, 10)), 2),
            "p50":  round(float(np.percentile(col, 50)), 2),
            "p90":  round(float(np.percentile(col, 90)), 2),
            "p10_real": round(float(np.percentile(col_real, 10)), 2),
            "p50_real": round(float(np.percentile(col_real, 50)), 2),
            "p90_real": round(float(np.percentile(col_real, 90)), 2),
        })

    # ---- Paths muestra (para mostrar "caminos" distintos) -----
    # Tomamos 20 paths, uno cada N//20
    num_muestra = min(20, num_simulaciones)
    step = max(1, num_simulaciones // num_muestra)
    idx_muestra = list(range(0, num_simulaciones, step))[:num_muestra]
    paths_muestra = []
    for i in idx_muestra:
        path = V[i, meses_reporte].tolist()
        paths_muestra.append([round(p, 2) for p in path])

    # ---- Totales ----------------------------------------------
    total_aportado = aporte_mensual * meses
    crecimiento_mediano = percentiles_nom["p50"] - capital_inicial - total_aportado

    # ---- Escenarios didácticos --------------------------------
    escenarios = [
        {
            "nombre":  "Pesimista",
            "etiqueta": "P10 (1 de cada 10 peores casos)",
            "valor_nominal": round(percentiles_nom["p10"], 2),
            "valor_real":    round(percentiles_real["p10"], 2),
            "descripcion":   "Si todo sale mal: inflación alta, crisis, malos años.",
        },
        {
            "nombre":  "Esperado",
            "etiqueta": "P50 (mediana)",
            "valor_nominal": round(percentiles_nom["p50"], 2),
            "valor_real":    round(percentiles_real["p50"], 2),
            "descripcion":   "El centro de la distribución: 50% de probabilidad de superarlo.",
        },
        {
            "nombre":  "Optimista",
            "etiqueta": "P90 (1 de cada 10 mejores casos)",
            "valor_nominal": round(percentiles_nom["p90"], 2),
            "valor_real":    round(percentiles_real["p90"], 2),
            "descripcion":   "Si las cosas salen bien: mercados alcistas sostenidos.",
        },
    ]

    return {
        "parametros": {
            "capital_inicial":   round(capital_inicial, 2),
            "aporte_mensual":    round(aporte_mensual, 2),
            "horizonte_anos":    round(horizonte_anos, 2),
            "horizonte_meses":   meses,
            "retorno_anual":     round(retorno_anual, 4),
            "volatilidad_anual": round(volatilidad_anual, 4),
            "inflacion_anual":   round(inflacion_anual, 4),
            "num_simulaciones":  num_simulaciones,
            "tasa_retiro_segura": round(tasa_retiro_segura, 4),
        },
        "meta": {
            "tipo":              meta_origen,
            "monto":             round(meta_efectiva, 2) if meta_efectiva is not None else None,
            "ingreso_mensual":   round(meta_ingreso_mensual, 2) if meta_ingreso_mensual else None,
            "probabilidad":      round(prob_meta, 4) if prob_meta is not None else None,
            "meses_mediana":     meses_mediana_meta,
            "anos_mediana":      round(meses_mediana_meta / 12.0, 2) if meses_mediana_meta else None,
        },
        "totales": {
            "total_aportado":       round(total_aportado, 2),
            "capital_inicial":      round(capital_inicial, 2),
            "crecimiento_mediano":  round(crecimiento_mediano, 2),
            "valor_esperado":       round(float(valor_final.mean()), 2),
            "valor_mediano":        round(percentiles_nom["p50"], 2),
            "valor_mediano_real":   round(percentiles_real["p50"], 2),
        },
        "percentiles":      percentiles_nom,
        "percentiles_real": percentiles_real,
        "escenarios":       escenarios,
        "serie":            serie,
        "paths_muestra":    paths_muestra,
    }


# ------------------------------------------------------------
# API: lista de perfiles preset
# ------------------------------------------------------------
def listar_perfiles_retorno() -> dict:
    """Devuelve los perfiles preset de retorno/volatilidad para el frontend."""
    return {
        "perfiles": [
            {"id": k, **v} for k, v in PERFILES.items()
        ]
    }
