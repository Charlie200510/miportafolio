"""
alertas_avanzadas.py — Sistema de alertas multi-condición.

Permite al usuario crear reglas custom tipo:
  "Avísame si NVDA cae >5% Y el VIX > 25"
  "Avísame si AAPL baja del 52w-low O si su P/E sube de 40"
  "Avísame si mi portafolio drift > 10pp O si CETES sube de 11%"

Cada regla = lista de condiciones + operador lógico (AND/OR).
Cada condición: campo, operador, valor.

Las reglas se guardan en el snapshot del usuario y se evalúan cuando
el cron dispara la alerta diaria.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# Operadores soportados
OPERADORES = {
    "mayor":       lambda a, b: a is not None and b is not None and a > b,
    "mayor_igual": lambda a, b: a is not None and b is not None and a >= b,
    "menor":       lambda a, b: a is not None and b is not None and a < b,
    "menor_igual": lambda a, b: a is not None and b is not None and a <= b,
    "igual":       lambda a, b: a is not None and b is not None and abs(a - b) < 0.0001,
    "cambia_pct":  lambda a, b: a is not None and b is not None and abs(a) >= abs(b),
}


def evaluar_condicion(condicion: Dict[str, Any], contexto: Dict[str, Any]) -> bool:
    """Evalúa una sola condición contra el contexto actual.

    condicion = {"campo": "precio_NVDA", "operador": "menor", "valor": 100}
    contexto  = {"precio_NVDA": 95, "vix": 22, "drift_pp": 7, ...}
    """
    campo = condicion.get("campo")
    op = condicion.get("operador")
    valor = condicion.get("valor")
    if not campo or not op:
        return False
    valor_actual = contexto.get(campo)
    func = OPERADORES.get(op)
    if not func:
        return False
    try:
        return bool(func(valor_actual, valor))
    except (TypeError, ValueError):
        return False


def evaluar_regla(regla: Dict[str, Any], contexto: Dict[str, Any]) -> Dict[str, Any]:
    """Evalúa una regla completa (conjunto de condiciones).

    regla = {
        "nombre": "Alerta crítica NVDA",
        "operador_logico": "AND",  // o "OR"
        "condiciones": [
            {"campo": "precio_NVDA", "operador": "menor", "valor": 100},
            {"campo": "vix", "operador": "mayor", "valor": 25},
        ],
        "activa": True,
    }
    """
    if not regla.get("activa", True):
        return {"disparada": False, "razon": "regla desactivada"}

    condiciones = regla.get("condiciones") or []
    if not condiciones:
        return {"disparada": False, "razon": "sin condiciones definidas"}

    logico = (regla.get("operador_logico") or "AND").upper()
    resultados = [evaluar_condicion(c, contexto) for c in condiciones]
    if logico == "AND":
        disparada = all(resultados)
    elif logico == "OR":
        disparada = any(resultados)
    else:
        disparada = False

    return {
        "disparada":         disparada,
        "nombre":            regla.get("nombre", "Regla sin nombre"),
        "condiciones_eval":  [
            {
                "campo":    c.get("campo"),
                "operador": c.get("operador"),
                "valor_esperado": c.get("valor"),
                "valor_actual":   contexto.get(c.get("campo")),
                "cumple":         r,
            }
            for c, r in zip(condiciones, resultados)
        ],
    }


def evaluar_reglas(reglas: List[Dict[str, Any]], contexto: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Evalúa una lista de reglas y devuelve solo las disparadas."""
    disparadas = []
    for r in reglas or []:
        result = evaluar_regla(r, contexto)
        if result.get("disparada"):
            disparadas.append({"regla": r, **result})
    return disparadas


def construir_contexto_desde_snapshot(snap: Dict[str, Any], precios_actuales: Dict[str, float]) -> Dict[str, Any]:
    """Construye el contexto de evaluación a partir del snapshot y precios."""
    ctx = {}
    # Precios actuales por ticker
    for t, p in (precios_actuales or {}).items():
        ctx[f"precio_{t.upper()}"] = p
    # Métricas del portafolio
    metricas = snap.get("metricas") or {}
    for k, v in metricas.items():
        ctx[k] = v
    # Posiciones
    for pos in snap.get("posiciones") or []:
        t = (pos.get("ticker") or "").upper()
        if not t:
            continue
        if pos.get("cambio_pct") is not None:
            ctx[f"cambio_{t}"] = pos["cambio_pct"]
        if pos.get("peso_pct") is not None:
            ctx[f"peso_{t}"] = pos["peso_pct"]
    return ctx
