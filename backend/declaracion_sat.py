"""
declaracion_sat.py — Reporte anual ISR MX para declaración del SAT.

Toma las transacciones del usuario, filtra al ejercicio fiscal solicitado
y arma el formato que el contribuyente necesita para llenar su Declaración
Anual de Personas Físicas (Anexo 1 del Régimen de Enajenación de Bienes,
art. 129 LISR — 10% sobre utilidad neta).

Genera:
  - Tabla de operaciones cerradas (FIFO matching)
  - Total ganancias / pérdidas / utilidad neta
  - ISR estimado a pagar (10%)
  - Dividendos cobrados con su retención correspondiente
  - Notas y campos exactos para llenar en el SAT
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

# Reusamos la lógica de cierres FIFO que ya tiene impuestos.py
try:
    import impuestos as _imp
except Exception:
    _imp = None


def _ejercicio_actual() -> int:
    return date.today().year


def generar_declaracion_anual(transacciones: list[dict],
                              ejercicio: Optional[int] = None,
                              isr_pct: float = 0.10) -> dict:
    """
    Args:
      transacciones: lista de dicts con keys:
        ticker, tipo (compra|venta|dividendo), fecha (YYYY-MM-DD),
        shares (float), precio (float), comision (float), moneda, notas.
      ejercicio: año fiscal (default: año actual)
      isr_pct: tasa ISR (default 10%)

    Returns dict con todo lo necesario para llenar la declaración.
    """
    if _imp is None:
        raise RuntimeError("módulo impuestos no disponible")

    if ejercicio is None:
        ejercicio = _ejercicio_actual()

    # Reusar el motor de FIFO de impuestos.py
    res = _imp.calcular_isr(transacciones, ejercicio_fiscal=ejercicio, tasa_isr=isr_pct)

    # Cierres del año
    cierres_ano = res.get("cierres_realizados") or []
    dividendos_ano = [t for t in transacciones
                      if (t.get("tipo") or "").lower() == "dividendo"
                      and (t.get("fecha") or "").startswith(str(ejercicio))]

    total_ganancias = sum(c.get("ganancia_perdida_mxn", 0) for c in cierres_ano if c.get("ganancia_perdida_mxn", 0) > 0)
    total_perdidas  = sum(c.get("ganancia_perdida_mxn", 0) for c in cierres_ano if c.get("ganancia_perdida_mxn", 0) < 0)
    utilidad_neta = max(0, total_ganancias + total_perdidas)
    isr_pagar = utilidad_neta * isr_pct

    total_dividendos = sum(
        ((t.get("shares") or 0) * (t.get("precio") or 0))
        for t in dividendos_ano
    )

    # Operaciones por mes (para anexar gráfico/desglose)
    por_mes = {}
    for c in cierres_ano:
        fecha = c.get("fecha_venta") or c.get("fecha")
        if fecha:
            mes = fecha[:7]
            por_mes.setdefault(mes, {"ganancias": 0, "perdidas": 0, "n_ops": 0})
            g = c.get("ganancia_perdida_mxn", 0)
            if g > 0:
                por_mes[mes]["ganancias"] += g
            else:
                por_mes[mes]["perdidas"] += g
            por_mes[mes]["n_ops"] += 1

    # Texto-guía (qué casillas llenar en el SAT)
    guia_sat = [
        f"Régimen: 'Enajenación de bienes' (art. 129 LISR).",
        f"Apartado: 'Ingresos por enajenación de acciones en bolsa de valores'.",
        f"Ingresos acumulables: ${total_ganancias:,.2f} MXN.",
        f"Deducciones autorizadas (pérdidas del ejercicio): ${abs(total_perdidas):,.2f} MXN.",
        f"Utilidad neta del ejercicio: ${utilidad_neta:,.2f} MXN.",
        f"ISR a pagar (10%): ${isr_pagar:,.2f} MXN.",
        "Si aplica: pérdidas de ejercicios anteriores (10 años max) — revisa tus declaraciones previas.",
        f"Dividendos cobrados ({len(dividendos_ano)} eventos, ~${total_dividendos:,.2f}): se declaran "
        f"en 'Ingresos por dividendos'. La retención del 10% que ya hizo el broker es acreditable.",
    ]

    return {
        "ok": True,
        "ejercicio": ejercicio,
        "tasa_isr_pct": round(isr_pct * 100, 2),
        "totales": {
            "ganancias_realizadas_mxn": round(total_ganancias, 2),
            "perdidas_realizadas_mxn":  round(total_perdidas, 2),
            "utilidad_neta_mxn":        round(utilidad_neta, 2),
            "isr_a_pagar_mxn":          round(isr_pagar, 2),
            "dividendos_cobrados_mxn":  round(total_dividendos, 2),
            "num_operaciones_cerradas": len(cierres_ano),
            "num_dividendos":           len(dividendos_ano),
        },
        "por_mes": por_mes,
        "operaciones": cierres_ano,
        "dividendos": dividendos_ano,
        "guia_sat": guia_sat,
        "disclaimer": (
            "Este reporte es informativo y se basa en las transacciones que registraste. "
            "Verifica los montos contra los CFDI y constancias de retención que te entregue tu broker. "
            "Para casos complejos (operaciones internacionales, FATCA, doble tributación) consulta a un contador."
        ),
    }


if __name__ == "__main__":
    import json
    txs = [
        {"ticker": "AAPL", "tipo": "compra", "fecha": "2025-03-15", "shares": 10, "precio": 170, "moneda": "USD"},
        {"ticker": "AAPL", "tipo": "venta",  "fecha": "2025-11-20", "shares": 10, "precio": 220, "moneda": "USD"},
        {"ticker": "WALMEX.MX", "tipo": "compra", "fecha": "2025-01-05", "shares": 100, "precio": 70, "moneda": "MXN"},
        {"ticker": "WALMEX.MX", "tipo": "venta",  "fecha": "2025-06-15", "shares": 100, "precio": 65, "moneda": "MXN"},
    ]
    r = generar_declaracion_anual(txs, ejercicio=2025)
    print(json.dumps(r, indent=2, default=str))
