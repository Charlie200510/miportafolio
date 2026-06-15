"""
optimizador_fiscal.py — Algoritmo de optimización fiscal mexicana.

Pregunta que responde: "Necesito vender $X MXN de mi portafolio.
¿En qué orden vendo qué posiciones para minimizar el ISR que pago?"

Estrategia: vende primero las posiciones con pérdida (reducen base
gravable), después las que están "neutras" o casi neutras, y por
último las que tienen ganancias grandes. Considera:

- Ganancias y pérdidas realizadas YA acumuladas en el año
- Pérdidas de años anteriores arrastrables (vigencia 10 años)
- Posiciones actuales con costo promedio y valor de mercado actual

Devuelve un plan ordenado de qué vender para reducir ISR máximo
posible, comparado vs vender al azar.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


TASA_ISR = 0.10  # 10% sobre utilidades de capital en MX (Art. 129 LISR)


def _calcular_costo_promedio(transacciones: List[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    """Por ticker, calcula shares actuales y costo promedio ponderado."""
    pos = {}
    for tx in sorted(transacciones, key=lambda x: x.get("fecha", "")):
        t = tx.get("ticker", "").upper()
        if not t:
            continue
        tipo = (tx.get("tipo") or "compra").lower()
        sh = float(tx.get("shares") or 0)
        pr = float(tx.get("precio") or 0)
        if sh <= 0 or pr <= 0:
            continue
        if t not in pos:
            pos[t] = {"shares": 0.0, "costo_total": 0.0}
        if tipo.startswith("c"):
            pos[t]["shares"] += sh
            pos[t]["costo_total"] += sh * pr
        elif tipo.startswith("v"):
            # Venta reduce shares y mantiene costo promedio
            if pos[t]["shares"] > 0:
                costo_prom = pos[t]["costo_total"] / pos[t]["shares"]
                shares_vendidas = min(sh, pos[t]["shares"])
                pos[t]["shares"] -= shares_vendidas
                pos[t]["costo_total"] -= shares_vendidas * costo_prom
                if pos[t]["shares"] < 0.001:
                    pos[t]["shares"] = 0.0
                    pos[t]["costo_total"] = 0.0
    # Calcular costo promedio final
    return {
        t: {
            "shares": v["shares"],
            "costo_promedio": v["costo_total"] / v["shares"] if v["shares"] > 0 else 0.0,
            "costo_total": v["costo_total"],
        }
        for t, v in pos.items()
        if v["shares"] > 0
    }


def _ganancia_realizada_ano(transacciones: List[Dict[str, Any]], ano: int) -> float:
    """Ganancia/pérdida neta YA realizada en el año fiscal en curso."""
    # Necesitamos calcular costo promedio en orden cronológico
    pos_running = {}
    realizada = 0.0
    for tx in sorted(transacciones, key=lambda x: x.get("fecha", "")):
        t = (tx.get("ticker") or "").upper()
        tipo = (tx.get("tipo") or "compra").lower()
        sh = float(tx.get("shares") or 0)
        pr = float(tx.get("precio") or 0)
        fecha = tx.get("fecha", "")
        if not t or sh <= 0 or pr <= 0:
            continue
        if t not in pos_running:
            pos_running[t] = {"shares": 0.0, "costo": 0.0}
        if tipo.startswith("c"):
            pos_running[t]["shares"] += sh
            pos_running[t]["costo"] += sh * pr
        elif tipo.startswith("v") and pos_running[t]["shares"] > 0:
            costo_prom = pos_running[t]["costo"] / pos_running[t]["shares"]
            shares_v = min(sh, pos_running[t]["shares"])
            ganancia = shares_v * (pr - costo_prom)
            # Solo contar si la venta es del año en cuestión
            if fecha.startswith(str(ano)):
                realizada += ganancia
            pos_running[t]["shares"] -= shares_v
            pos_running[t]["costo"] -= shares_v * costo_prom
    return realizada


def optimizar_venta(
    transacciones: List[Dict[str, Any]],
    precios_actuales: Dict[str, float],
    monto_a_vender_mxn: float,
    ano_fiscal: int,
    perdidas_anteriores: float = 0.0,
) -> Dict[str, Any]:
    """
    Calcula el plan óptimo de venta para minimizar ISR.

    Args:
        transacciones: lista de compras/ventas históricas
        precios_actuales: dict {ticker: precio_actual_mxn}
        monto_a_vender_mxn: cuánto necesitas liquidar
        ano_fiscal: año en curso (ej. 2026)
        perdidas_anteriores: pérdidas acumuladas de años previos compensables

    Returns:
        plan ordenado de ventas con impacto fiscal proyectado
    """
    posiciones = _calcular_costo_promedio(transacciones)
    if not posiciones:
        return {"error": "No hay posiciones disponibles para vender."}

    # Calcular ganancia/pérdida latente de cada posición
    items = []
    for t, info in posiciones.items():
        precio_actual = precios_actuales.get(t)
        if not precio_actual or precio_actual <= 0:
            continue
        valor_actual = info["shares"] * precio_actual
        ganancia_total = valor_actual - info["costo_total"]
        ganancia_por_share = precio_actual - info["costo_promedio"]
        items.append({
            "ticker":           t,
            "shares":           round(info["shares"], 4),
            "costo_promedio":   round(info["costo_promedio"], 4),
            "precio_actual":    round(precio_actual, 4),
            "valor_actual":     round(valor_actual, 2),
            "ganancia_total":   round(ganancia_total, 2),
            "ganancia_pct":     round(ganancia_total / info["costo_total"] * 100, 2) if info["costo_total"] > 0 else 0,
            "ganancia_share":   round(ganancia_por_share, 4),
        })

    # Ordenar: primero pérdidas (más negativas primero), después neutras, después ganancias chicas, después ganancias grandes
    # Esto minimiza la utilidad gravable
    items_ordenados = sorted(items, key=lambda x: x["ganancia_share"])

    ganancia_realizada_ano = _ganancia_realizada_ano(transacciones, ano_fiscal)

    # Construir plan: vender items en orden hasta cubrir el monto deseado
    plan = []
    monto_restante = monto_a_vender_mxn
    impacto_fiscal = 0.0
    for item in items_ordenados:
        if monto_restante <= 0:
            break
        valor_disponible = item["valor_actual"]
        if valor_disponible <= 0:
            continue
        # Cuánto vender de este item
        if monto_restante >= valor_disponible:
            # Vender todo
            monto_vendido = valor_disponible
            shares_vender = item["shares"]
            ganancia_realizada = item["ganancia_total"]
        else:
            # Vender solo parcial
            fraccion = monto_restante / valor_disponible
            monto_vendido = monto_restante
            shares_vender = round(item["shares"] * fraccion, 4)
            ganancia_realizada = round(item["ganancia_total"] * fraccion, 2)
        plan.append({
            "ticker":              item["ticker"],
            "shares_vender":       shares_vender,
            "precio_actual":       item["precio_actual"],
            "monto_mxn":           round(monto_vendido, 2),
            "ganancia_realizada":  round(ganancia_realizada, 2),
            "categoria":           ("pérdida" if ganancia_realizada < 0 else
                                    "neutra" if abs(ganancia_realizada) < 100 else "ganancia"),
        })
        impacto_fiscal += ganancia_realizada
        monto_restante -= monto_vendido

    # Calcular ISR proyectado
    # Base gravable = ganancia realizada del año + impacto plan - pérdidas anteriores
    base_gravable_total = ganancia_realizada_ano + impacto_fiscal - perdidas_anteriores
    if base_gravable_total < 0:
        # Sin ISR, además se acumulan pérdidas a años futuros
        isr_a_pagar = 0
        sobrante_perdida = -base_gravable_total
        base_gravable_total = 0
    else:
        isr_a_pagar = base_gravable_total * TASA_ISR
        sobrante_perdida = 0

    # Estimación naive: vender al azar (vendría siendo el promedio ponderado por valor)
    if items:
        total_valor = sum(i["valor_actual"] for i in items)
        total_ganancia = sum(i["ganancia_total"] for i in items)
        ratio_ganancia = total_ganancia / total_valor if total_valor > 0 else 0
        impacto_naive = monto_a_vender_mxn * ratio_ganancia
        isr_naive = max(0, (ganancia_realizada_ano + impacto_naive - perdidas_anteriores) * TASA_ISR)
        ahorro_isr = round(isr_naive - isr_a_pagar, 2)
    else:
        ahorro_isr = 0

    return {
        "ok": True,
        "monto_solicitado_mxn":      monto_a_vender_mxn,
        "monto_cubierto_mxn":        round(monto_a_vender_mxn - monto_restante, 2),
        "ano_fiscal":                ano_fiscal,
        "ganancia_realizada_ano":    round(ganancia_realizada_ano, 2),
        "impacto_plan_mxn":          round(impacto_fiscal, 2),
        "base_gravable_proyectada":  round(base_gravable_total, 2),
        "isr_proyectado":            round(isr_a_pagar, 2),
        "isr_vendiendo_al_azar":     round((ganancia_realizada_ano + impacto_naive - perdidas_anteriores) * TASA_ISR, 2) if items else 0,
        "ahorro_isr_mxn":            ahorro_isr,
        "perdida_arrastrable":       round(sobrante_perdida, 2),
        "plan":                      plan,
        "posiciones_disponibles":    items_ordenados,
        "advertencia":               "Cálculo educativo. Para tu declaración real consulta a un contador.",
    }
