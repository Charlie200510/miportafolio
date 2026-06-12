"""
aportaciones.py — Simulador de aportaciones recurrentes (DCA).

Calcula proyección de un plan de aportaciones (Dollar Cost Averaging):
  - Aportación regular cada periodo (semanal, quincenal, mensual)
  - Tasa esperada de retorno
  - Inflación esperada
  - Horizonte (años)

Devuelve valor proyectado nominal y real, total aportado, gananceia
y serie temporal mes a mes.
"""
from __future__ import annotations

from typing import Optional


FRECUENCIA_PERIODOS = {
    "semanal":   52,
    "quincenal": 26,
    "mensual":   12,
}


def simular_dca(monto_periodico: float,
                frecuencia: str = "mensual",
                anios: float = 10,
                retorno_anual_pct: float = 8.0,
                inflacion_anual_pct: float = 4.0,
                aporte_inicial: float = 0.0) -> dict:
    """
    Args:
      monto_periodico: cuánto aportas cada periodo (en MXN)
      frecuencia: "semanal" | "quincenal" | "mensual"
      anios: horizonte en años
      retorno_anual_pct: tasa real esperada (ej: 8% para portafolio diversificado MX)
      inflacion_anual_pct: para calcular valor real
      aporte_inicial: monto inicial (lump sum)
    """
    if monto_periodico < 0 or anios <= 0:
        raise ValueError("Monto y años deben ser positivos.")
    if frecuencia not in FRECUENCIA_PERIODOS:
        raise ValueError(f"Frecuencia desconocida: {frecuencia}")

    n_por_anio = FRECUENCIA_PERIODOS[frecuencia]
    total_periodos = int(anios * n_por_anio)
    r_anual = retorno_anual_pct / 100
    r_periodo = (1 + r_anual) ** (1 / n_por_anio) - 1
    pi_anual = inflacion_anual_pct / 100

    # Serie mes a mes (siempre 12 puntos por año para gráfico parejo)
    pasos_anuales = 12
    n_pasos = int(anios * pasos_anuales)
    r_paso = (1 + r_anual) ** (1 / pasos_anuales) - 1
    aportes_por_paso = monto_periodico * (n_por_anio / pasos_anuales)

    serie = []
    valor = aporte_inicial
    aportado = aporte_inicial
    for i in range(n_pasos + 1):
        serie.append({
            "periodo":    i,
            "anio":       round(i / pasos_anuales, 2),
            "valor":      round(valor, 2),
            "aportado":   round(aportado, 2),
            "valor_real": round(valor / ((1 + pi_anual) ** (i / pasos_anuales)), 2),
        })
        # Aportar al final del paso, después aplicar retorno
        valor = (valor + aportes_por_paso) * (1 + r_paso)
        aportado += aportes_por_paso

    valor_final = serie[-1]["valor"]
    aportado_total = serie[-1]["aportado"]
    valor_real_final = serie[-1]["valor_real"]
    ganancia = valor_final - aportado_total

    # Multiplicador estilo "el dinero se hizo X veces"
    multiplicador = (valor_final / aportado_total) if aportado_total > 0 else 0

    return {
        "ok": True,
        "parametros": {
            "monto_periodico":      round(monto_periodico, 2),
            "frecuencia":           frecuencia,
            "anios":                round(anios, 2),
            "retorno_anual_pct":    round(retorno_anual_pct, 2),
            "inflacion_anual_pct":  round(inflacion_anual_pct, 2),
            "aporte_inicial":       round(aporte_inicial, 2),
        },
        "totales": {
            "aportado_total":       round(aportado_total, 2),
            "valor_final_nominal":  round(valor_final, 2),
            "valor_final_real":     round(valor_real_final, 2),
            "ganancia_nominal":     round(ganancia, 2),
            "multiplicador":        round(multiplicador, 2),
            "ganancia_pct":         round((ganancia / aportado_total) * 100, 2) if aportado_total > 0 else 0,
        },
        "serie": serie,
    }


def comparar_dca_vs_lump_sum(monto_total: float,
                              anios: float,
                              frecuencia: str = "mensual",
                              retorno_anual_pct: float = 8.0,
                              inflacion_anual_pct: float = 4.0) -> dict:
    """
    Compara dos estrategias con el mismo monto total:
      A) Lump sum hoy
      B) DCA repartido en `anios`
    """
    if monto_total <= 0 or anios <= 0:
        raise ValueError("Monto y años deben ser positivos.")
    n_por_anio = FRECUENCIA_PERIODOS.get(frecuencia, 12)
    monto_periodico = monto_total / (anios * n_por_anio)

    sim_dca = simular_dca(monto_periodico, frecuencia, anios, retorno_anual_pct, inflacion_anual_pct, 0)
    sim_lump = simular_dca(0, frecuencia, anios, retorno_anual_pct, inflacion_anual_pct, monto_total)

    return {
        "monto_total": monto_total,
        "anios":       anios,
        "dca":         sim_dca,
        "lump_sum":    sim_lump,
        "diferencia": {
            "lump_sum_minus_dca_mxn": round(
                sim_lump["totales"]["valor_final_nominal"] - sim_dca["totales"]["valor_final_nominal"], 2),
            "ganador": "lump_sum" if sim_lump["totales"]["valor_final_nominal"] > sim_dca["totales"]["valor_final_nominal"] else "dca",
        },
    }


if __name__ == "__main__":
    import json
    r = simular_dca(2000, "mensual", anios=10, retorno_anual_pct=8.0)
    print("DCA $2000 mensuales 10 años:")
    print(json.dumps(r["totales"], indent=2))
