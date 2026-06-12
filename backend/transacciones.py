# ============================================================
#  TRACKING REAL DE TRANSACCIONES
# ============================================================
#  Toma la lista de compras/ventas que el usuario capturó y
#  calcula:
#    - Shares actuales por ticker
#    - Costo promedio ponderado (método aceptado por SAT MX)
#    - Valor invertido histórico
#    - Valor actual de mercado (usando precios frescos)
#    - Ganancia/pérdida no realizada ($ y %)
#    - Ganancia/pérdida realizada (de ventas pasadas)
#    - ROI total
#
#  Método fiscal: costo promedio ponderado. Es lo que usa el
#  SAT por default para personas físicas que no llevan
#  contabilidad formal. Cuando el usuario vende, la "base" de
#  esa venta es el costo promedio hasta ese momento.
#
#  Las transacciones se ordenan por fecha y se procesan en
#  orden cronológico. Si una venta excede las shares
#  disponibles en ese momento, se registra error.
# ============================================================
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import yfinance as yf


# ------------------------------------------------------------
# Precios
# ------------------------------------------------------------
def _precio_fresco(t: str) -> float | None:
    """Último precio del ticker vía yfinance fast_info."""
    try:
        info = yf.Ticker(t).fast_info
        for key in ("last_price", "lastPrice", "regular_market_price", "regularMarketPrice"):
            try:
                v = info[key] if hasattr(info, "__getitem__") else getattr(info, key, None)
                if v is not None:
                    return float(v)
            except (KeyError, TypeError):
                continue
        return None
    except Exception:
        return None


def _precios_de(tickers: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    if not tickers:
        return out
    with ThreadPoolExecutor(max_workers=10) as ex:
        for t, p in zip(tickers, ex.map(_precio_fresco, tickers)):
            if p is not None:
                out[t] = p
    return out


# ------------------------------------------------------------
# Validación y normalización
# ------------------------------------------------------------
def _normalizar_tx(tx: dict) -> dict:
    """Deja una transacción con todos los campos en formato canónico."""
    return {
        "id":              str(tx.get("id") or ""),
        "ticker":          str(tx.get("ticker") or "").strip().upper(),
        "tipo":            str(tx.get("tipo") or "").strip().lower(),  # "compra" / "venta"
        "fecha":           str(tx.get("fecha") or "").strip(),
        "shares":          float(tx.get("shares") or 0),
        "precio_unitario": float(tx.get("precio_unitario") or 0),
        "moneda":          str(tx.get("moneda") or "USD").strip().upper(),
        "comisiones":      float(tx.get("comisiones") or 0),
        "notas":           str(tx.get("notas") or ""),
    }


def _validar_tx(tx: dict) -> str | None:
    """Devuelve mensaje de error o None si es válida."""
    if not tx["ticker"]:
        return "Falta ticker"
    if tx["tipo"] not in ("compra", "venta"):
        return f"Tipo inválido: {tx['tipo']}"
    if tx["shares"] <= 0:
        return "Las shares deben ser mayores a 0"
    if tx["precio_unitario"] <= 0:
        return "El precio debe ser mayor a 0"
    try:
        datetime.strptime(tx["fecha"], "%Y-%m-%d")
    except ValueError:
        return f"Fecha inválida: {tx['fecha']} (usar YYYY-MM-DD)"
    return None


# ------------------------------------------------------------
# Cálculo principal
# ------------------------------------------------------------
def calcular_portafolio(transacciones: list[dict]) -> dict:
    """
    Procesa todas las transacciones y devuelve snapshot del portafolio.

    Usa costo promedio ponderado. Al vender, la ganancia realizada es
    shares_vendidas * (precio_venta - costo_promedio_al_momento).

    Returns:
        {
            por_ticker: [
                {ticker, shares_actuales, costo_promedio, valor_invertido,
                 precio_actual, valor_actual, pnl_no_realizado, pnl_no_realizado_pct,
                 pnl_realizado, primera_compra, ultima_operacion, num_operaciones}
            ],
            totales: {invertido, valor_actual, pnl_no_realizado, pnl_realizado,
                      pnl_total, roi_pct, num_operaciones, num_tickers_activos},
            errores: [ {tx_id, msg} ],
        }
    """
    if not transacciones:
        return {
            "por_ticker": [],
            "totales": {
                "invertido": 0.0,
                "valor_actual": 0.0,
                "pnl_no_realizado": 0.0,
                "pnl_realizado": 0.0,
                "pnl_total": 0.0,
                "roi_pct": 0.0,
                "num_operaciones": 0,
                "num_tickers_activos": 0,
            },
            "errores": [],
        }

    # Normalizar y validar
    errores = []
    txs = []
    for raw in transacciones:
        tx = _normalizar_tx(raw)
        err = _validar_tx(tx)
        if err:
            errores.append({"tx_id": tx["id"], "msg": err})
            continue
        txs.append(tx)

    # Orden cronológico (y por tipo dentro del mismo día: compras antes que ventas)
    orden_tipo = {"compra": 0, "venta": 1}
    txs.sort(key=lambda t: (t["fecha"], orden_tipo.get(t["tipo"], 2)))

    # Estado por ticker mientras procesamos
    estado: dict[str, dict] = {}

    for tx in txs:
        t = tx["ticker"]
        if t not in estado:
            estado[t] = {
                "shares":          0.0,
                "costo_total":     0.0,  # suma de (shares * precio) de compras, con ventas bajando proporcional
                "pnl_realizado":   0.0,
                "invertido_total": 0.0,  # suma histórica de dinero puesto (compras)
                "primera_compra":  None,
                "ultima_operacion": None,
                "num_operaciones": 0,
            }
        e = estado[t]

        bruto = tx["shares"] * tx["precio_unitario"]
        comis = tx["comisiones"]

        if tx["tipo"] == "compra":
            # Sumar al costo total y shares
            e["costo_total"]     += bruto + comis
            e["shares"]          += tx["shares"]
            e["invertido_total"] += bruto + comis
            if e["primera_compra"] is None:
                e["primera_compra"] = tx["fecha"]

        elif tx["tipo"] == "venta":
            if tx["shares"] > e["shares"] + 1e-9:
                errores.append({
                    "tx_id": tx["id"],
                    "msg": f"Venta de {tx['shares']} {t} excede las {e['shares']} que tenías el {tx['fecha']}",
                })
                continue

            # Costo promedio antes de la venta
            avg = e["costo_total"] / e["shares"] if e["shares"] > 0 else 0
            costo_de_venta = avg * tx["shares"]

            # Ganancia realizada = ingreso - costo - comisiones
            ingreso_neto = bruto - comis
            e["pnl_realizado"] += ingreso_neto - costo_de_venta

            # Actualizar estado
            e["costo_total"] -= costo_de_venta
            e["shares"]      -= tx["shares"]

        e["ultima_operacion"] = tx["fecha"]
        e["num_operaciones"] += 1

    # Bajar precios para tickers con shares > 0
    tickers_activos = [t for t, e in estado.items() if e["shares"] > 1e-9]
    precios = _precios_de(tickers_activos)

    # Armar output por ticker
    por_ticker = []
    total_invertido = 0.0
    total_valor_actual = 0.0
    total_pnl_realizado = 0.0
    total_pnl_no_realizado = 0.0
    total_operaciones = 0

    for t, e in estado.items():
        shares = e["shares"]
        costo_total = e["costo_total"]
        avg = (costo_total / shares) if shares > 1e-9 else 0

        precio_actual = precios.get(t)
        valor_actual = (shares * precio_actual) if (precio_actual is not None and shares > 1e-9) else 0

        pnl_nr = (valor_actual - costo_total) if precio_actual is not None else None
        pnl_nr_pct = ((pnl_nr / costo_total) * 100) if (pnl_nr is not None and costo_total > 0) else None

        por_ticker.append({
            "ticker":               t,
            "shares_actuales":      round(shares, 6),
            "costo_promedio":       round(avg, 4),
            "valor_invertido":      round(costo_total, 2),
            "precio_actual":        round(precio_actual, 2) if precio_actual is not None else None,
            "valor_actual":         round(valor_actual, 2),
            "pnl_no_realizado":     round(pnl_nr, 2) if pnl_nr is not None else None,
            "pnl_no_realizado_pct": round(pnl_nr_pct, 2) if pnl_nr_pct is not None else None,
            "pnl_realizado":        round(e["pnl_realizado"], 2),
            "invertido_historico":  round(e["invertido_total"], 2),
            "primera_compra":       e["primera_compra"],
            "ultima_operacion":     e["ultima_operacion"],
            "num_operaciones":      e["num_operaciones"],
            "activo":               shares > 1e-9,
        })

        total_invertido += costo_total  # remanente invertido hoy
        total_valor_actual += valor_actual
        total_pnl_realizado += e["pnl_realizado"]
        if pnl_nr is not None:
            total_pnl_no_realizado += pnl_nr
        total_operaciones += e["num_operaciones"]

    # Ordenar: activos primero, por valor actual desc
    por_ticker.sort(key=lambda x: (not x["activo"], -x["valor_actual"]))

    pnl_total = total_pnl_realizado + total_pnl_no_realizado
    # ROI: ganancia total / capital invertido hoy (remanente)
    roi_pct = (pnl_total / total_invertido * 100) if total_invertido > 0 else 0.0

    num_activos = sum(1 for x in por_ticker if x["activo"])

    return {
        "por_ticker": por_ticker,
        "totales": {
            "invertido":             round(total_invertido, 2),
            "valor_actual":          round(total_valor_actual, 2),
            "pnl_no_realizado":      round(total_pnl_no_realizado, 2),
            "pnl_realizado":         round(total_pnl_realizado, 2),
            "pnl_total":             round(pnl_total, 2),
            "roi_pct":               round(roi_pct, 2),
            "num_operaciones":       total_operaciones,
            "num_tickers_activos":   num_activos,
        },
        "errores": errores,
    }
