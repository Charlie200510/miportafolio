"""
modigliani_miller.py — Valuación por Modigliani-Miller con impuestos.

QUÉ CALCULA, Y POR QUÉ NO ES "ACTIVOS MENOS DEUDA"
--------------------------------------------------
La idea intuitiva es «equity = activos − deuda, y eso entre acciones da lo que
debería costar». La forma correcta de esa intuición NO usa los activos
CONTABLES, por dos razones:

  1. El equity contable es activos menos TODOS los pasivos, no solo la deuda.
     En Apple: activos 359 mil millones, deuda 99 → restar da 260, pero su
     equity real es 74. La diferencia son proveedores, ingresos diferidos y
     demás pasivos que no son deuda financiera.
  2. Aunque se restaran bien, el valor en libros mide lo que costó comprar los
     activos, no lo que producen. Una empresa vale por su flujo futuro.

Lo que sí es correcto es el puente que Modigliani-Miller hace posible: valuar
la empresa ENTERA (sin importar cómo se financia), sumarle el escudo fiscal de
la deuda, y de ahí restar la deuda neta para llegar al accionista.

    Proposición I con impuestos:   V_L = V_U + Tc · D

        V_U  valor de la empresa SIN deuda = NOPAT / r_0
        Tc·D escudo fiscal: los intereses son deducibles, así que endeudarse
             transfiere valor del fisco al accionista
        r_0  costo de capital DESAPALANCADO, vía beta de Hamada:
                 β_U = β_L / (1 + (1 − Tc)·D/E)
                 r_0 = rf + β_U · prima de mercado

    Puente al accionista:
        Equity = V_L − Deuda + Caja
        Precio = Equity / acciones en circulación

EL RESULTADO ES UN PISO, NO UN PRECIO JUSTO
-------------------------------------------
V_U = NOPAT / r_0 es una perpetuidad SIN CRECIMIENTO: supone que la empresa
gana lo mismo, para siempre. Para casi cualquier empresa sana eso queda por
debajo del mercado, y no es un fallo del modelo: es su supuesto.

Por eso el número que de verdad informa no es el precio MM sino el CRECIMIENTO
IMPLÍCITO: qué crecimiento perpetuo hay que suponer para justificar el precio
de hoy. Se despeja de la misma fórmula con crecimiento (Gordon):

        E_mkt = NOPAT·(1+g)/(r_0 − g) + Tc·D − D + Caja

Ahí la pregunta deja de ser "¿está cara?" —que depende de supuestos— y pasa a
ser "¿es creíble que crezca eso para siempre?", que sí se puede juzgar. Si a
una embotelladora madura el mercado le está pidiendo 8% perpetuo, eso dice algo.

DÓNDE NO APLICA, Y POR QUÉ SE NIEGA EN VEZ DE INVENTAR
------------------------------------------------------
  · Bancos y aseguradoras. No es falta de datos: en un banco la deuda ES la
    materia prima del negocio (los depósitos), no una decisión de financiamiento.
    El supuesto central de MM —que puedes separar la operación de cómo se
    financia— no se sostiene. Yahoo tampoco reporta EBIT para ellos.
  · Cripto y ETFs. No hay empresa que valuar.
  · EBIT negativo. Una perpetuidad de pérdidas no da un valor interpretable.

Preferimos no enseñar nada antes que enseñar un número con cara de precio
objetivo que no significa nada.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

try:
    from . import sml as _sml            # type: ignore
except Exception:                        # pragma: no cover
    import sml as _sml                   # type: ignore


_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHE_TTL = 6 * 3600        # los estados financieros cambian por trimestre
_LOCK = threading.Lock()

# Cotas de cordura. No son estética: sin ellas un dato podrido de Yahoo produce
# un precio objetivo absurdo, y un precio objetivo absurdo es peor que ninguno.
_TC_MIN, _TC_MAX = 0.05, 0.40      # tasa efectiva de impuestos plausible
_BETA_MIN = 0.25                   # betas de la BMV llegan a salir en 0.03
_R0_MIN = 0.03                     # un costo de capital menor infla sin límite

_SECTORES_EXCLUIDOS = {"financial services", "financial", "financials"}

_FILAS_EBIT = ["Operating Income", "EBIT", "Total Operating Income As Reported",
               "Operating Income Or Loss"]
_FILAS_IMPUESTOS = ["Tax Provision", "Income Tax Expense"]
_FILAS_PRETAX = ["Pretax Income", "Income Before Tax",
                 "Income Before Income Taxes"]
_FILAS_DEUDA = ["Total Debt"]
_FILAS_DEUDA_PARTES = ["Long Term Debt", "Current Debt",
                       "Short Long Term Debt", "Long Term Debt And Capital Lease Obligation"]
_FILAS_CAJA = ["Cash And Cash Equivalents",
               "Cash Cash Equivalents And Short Term Investments"]
_FILAS_ACTIVOS = ["Total Assets"]
_FILAS_PASIVOS = ["Total Liabilities Net Minority Interest", "Total Liabilities"]


def _fila(df, etiquetas) -> Optional[float]:
    """Primer valor no nulo de la primera etiqueta que exista.

    yfinance cambia los nombres de las filas entre versiones y entre mercados,
    así que se prueban varios alias en vez de confiar en uno.
    """
    if df is None or getattr(df, "empty", True):
        return None
    for etq in etiquetas:
        if etq in df.index:
            try:
                serie = df.loc[etq].dropna()
                if len(serie):
                    return float(serie.iloc[0])
            except Exception:
                continue
    return None


def _no_aplica(motivo: str) -> Dict[str, Any]:
    return {"ok": False, "aplica": False, "error": motivo}


def _faltan_datos(que: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "aplica": True,
        "error": f"No hay datos suficientes para valuar esta emisora: falta {que}.",
    }


def valuar_mm(ticker: str) -> Dict[str, Any]:
    """Valuación Modigliani-Miller con impuestos. Ver la nota de arriba."""
    ticker = (ticker or "").strip().upper()
    if not ticker:
        return _no_aplica("Ticker vacío.")

    with _LOCK:
        hit = _CACHE.get(ticker)
        if hit and (time.time() - hit["ts"]) < _CACHE_TTL:
            return hit["data"]

    res = _calcular(ticker)

    with _LOCK:
        _CACHE[ticker] = {"ts": time.time(), "data": res}
        if len(_CACHE) > 400:
            mas_viejo = min(_CACHE, key=lambda k: _CACHE[k]["ts"])
            _CACHE.pop(mas_viejo, None)
    return res


def _calcular(ticker: str) -> Dict[str, Any]:
    t = ticker.upper()
    if t.endswith("-USD") or t.endswith("-USDT"):
        return _no_aplica(
            "Modigliani-Miller valúa empresas por el flujo que producen sus "
            "activos. Una criptomoneda no tiene estados financieros que valuar."
        )

    try:
        import yfinance as yf
    except Exception:
        return _faltan_datos("la fuente de estados financieros")

    try:
        tk = yf.Ticker(t)
        info = tk.info or {}
    except Exception:
        return _faltan_datos("la ficha de la emisora")

    tipo = str(info.get("quoteType") or "").upper()
    if tipo in ("ETF", "MUTUALFUND", "INDEX", "CURRENCY"):
        return _no_aplica(
            "Esto es un fondo, no una empresa: no tiene EBIT ni estructura de "
            "capital propia que valuar con Modigliani-Miller."
        )

    sector = str(info.get("sector") or "").strip().lower()
    if sector in _SECTORES_EXCLUIDOS:
        return _no_aplica(
            "Modigliani-Miller no aplica a bancos ni aseguradoras. Su deuda no "
            "es una decisión de financiamiento sino la materia prima del "
            "negocio —los depósitos—, así que el supuesto de separar la "
            "operación de cómo se financia no se sostiene."
        )

    try:
        inc = tk.income_stmt
        bal = tk.balance_sheet
    except Exception:
        inc = bal = None
    if (inc is None or getattr(inc, "empty", True)):
        try:
            inc = tk.quarterly_income_stmt
        except Exception:
            pass
    if (bal is None or getattr(bal, "empty", True)):
        try:
            bal = tk.quarterly_balance_sheet
        except Exception:
            pass

    ebit = _fila(inc, _FILAS_EBIT)
    if ebit is None:
        return _faltan_datos("la utilidad operativa (EBIT)")
    if ebit <= 0:
        return _no_aplica(
            "La empresa reporta utilidad operativa negativa. Una perpetuidad de "
            "pérdidas no produce un valor interpretable, así que el modelo no "
            "dice nada útil aquí."
        )

    impuestos = _fila(inc, _FILAS_IMPUESTOS)
    pretax = _fila(inc, _FILAS_PRETAX)
    if impuestos is None or not pretax:
        return _faltan_datos("el impuesto pagado, necesario para el escudo fiscal")
    tc = impuestos / pretax if pretax else None
    if tc is None:
        return _faltan_datos("la tasa efectiva de impuestos")
    # Acotada: una tasa efectiva negativa (por un crédito fiscal puntual) o del
    # 90% (por un cargo extraordinario) no representa la carga estructural.
    tc = max(_TC_MIN, min(_TC_MAX, tc))

    deuda = _fila(bal, _FILAS_DEUDA)
    if deuda is None:
        partes = [_fila(bal, [e]) for e in _FILAS_DEUDA_PARTES]
        partes = [p for p in partes if p]
        deuda = sum(partes) if partes else None
    if deuda is None:
        return _faltan_datos("la deuda total del balance")
    caja = _fila(bal, _FILAS_CAJA) or 0.0

    acciones = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")
    try:
        acciones = float(acciones) if acciones else None
    except (TypeError, ValueError):
        acciones = None
    if not acciones or acciones <= 0:
        return _faltan_datos("el número de acciones en circulación")

    precio = info.get("currentPrice") or info.get("regularMarketPrice")
    try:
        precio = float(precio) if precio else None
    except (TypeError, ValueError):
        precio = None
    if not precio or precio <= 0:
        return _faltan_datos("el precio de mercado")

    # Beta: la NUESTRA, calculada de retornos contra su propio índice, no la de
    # Yahoo. Para la BMV Yahoo devuelve betas de 0.03 que hunden el costo de
    # capital hasta la tasa libre de riesgo e inflan la valuación al doble.
    beta_l = None
    try:
        s = _sml.evaluar_sml(t)
        if s.get("ok") or s.get("beta") is not None:
            beta_l = s.get("beta")
    except Exception:
        beta_l = None
    if beta_l is None:
        try:
            beta_l = float(info.get("beta")) if info.get("beta") else None
        except (TypeError, ValueError):
            beta_l = None
    if beta_l is None:
        return _faltan_datos("la beta contra su mercado")
    beta_l = max(_BETA_MIN, float(beta_l))

    rf = _sml._rf_para(t)
    prima = _sml._premio_mercado_para(t)

    # Desapalancar (Hamada) contra el equity de MERCADO, no el contable: la beta
    # observada ya refleja el apalancamiento que el mercado ve hoy.
    equity_mercado = acciones * precio
    beta_u = beta_l / (1.0 + (1.0 - tc) * (deuda / equity_mercado)) if equity_mercado else beta_l
    r0 = rf + beta_u * prima
    if r0 <= _R0_MIN:
        return _faltan_datos("un costo de capital plausible (salió demasiado bajo)")

    nopat = ebit * (1.0 - tc)
    escudo = tc * deuda
    equity_mercado = acciones * precio

    def _precio(g: float, r: float) -> Optional[float]:
        """Precio por acción bajo un par de supuestos (crecimiento, costo de capital).

        Es el mismo puente de MM, pero con la perpetuidad de Gordon en vez de la
        plana: V_U = NOPAT·(1+g)/(r − g).
        """
        if r - g < 0.005:
            # La perpetuidad diverge cuando el crecimiento alcanza al costo de
            # capital. No es un número grande: es que la fórmula deja de tener
            # sentido, y enseñar "$18,400" ahí sería mentir con precisión.
            return None
        vu = nopat * (1.0 + g) / (r - g)
        eq = vu + escudo - deuda + caja
        return (eq / acciones) if eq > 0 else None

    # ── Puente Modigliani-Miller (caso base, SIN crecimiento) ──────────────
    # Es el modelo tal cual: V_L = V_U + Tc·D, y de ahí al accionista. Se enseña
    # completo porque el puente ES el argumento; el precio suelto sería un
    # número sin razonamiento detrás.
    valor_sin_deuda = nopat / r0
    valor_empresa = valor_sin_deuda + escudo
    equity_mm = valor_empresa - deuda + caja
    if equity_mm <= 0:
        return _no_aplica(
            "Con estos supuestos la deuda se come el valor de la empresa: el "
            "modelo no deja valor para el accionista y el precio implícito no "
            "sería interpretable."
        )
    precio_mm = equity_mm / acciones

    # ── Supuestos implícitos en el precio de HOY ───────────────────────────
    # Dos formas de leer el mismo precio, cada una fijando una variable:
    #   · ¿qué crecimiento hay que suponer, si el costo de capital es el del CAPM?
    #   · ¿qué retorno está exigiendo el mercado, si la empresa no creciera nada?
    objetivo = equity_mercado - caja + deuda - escudo
    g_implicita = None
    if (objetivo + nopat) != 0:
        g = (objetivo * r0 - nopat) / (objetivo + nopat)
        if g < r0:
            g_implicita = g
    r0_implicito = (nopat / objetivo) if objetivo > 0 else None

    # ── Tabla de sensibilidad ──────────────────────────────────────────────
    # Centrada en el par que reproduce el precio de mercado, para que la celda
    # del medio SEA el precio de hoy. Así la tabla no discute con el mercado:
    # enseña qué tan frágil es ese precio ante un punto de más o de menos.
    g_centro = g_implicita if g_implicita is not None else 0.0
    PASO = 0.01                      # un punto porcentual por escalón
    eje_g  = [g_centro + k * PASO for k in (-2, -1, 0, 1, 2)]
    eje_r0 = [r0 + k * PASO for k in (-2, -1, 0, 1, 2)]
    celdas = [[_precio(gg, rr) for rr in eje_r0] for gg in eje_g]

    # Cuánto se mueve el precio con UN punto de cambio, para poder decirlo en
    # palabras en vez de obligar a leer la tabla.
    centro = celdas[2][2]
    sens_g  = None
    sens_r0 = None
    if centro:
        if celdas[3][2]:
            sens_g = celdas[3][2] / centro - 1.0
        if celdas[2][3]:
            sens_r0 = celdas[2][3] / centro - 1.0

    # Valor en libros como referencia: activos menos TODOS los pasivos, no solo
    # la deuda. Es el piso contable, no un precio objetivo.
    activos = _fila(bal, _FILAS_ACTIVOS)
    pasivos = _fila(bal, _FILAS_PASIVOS)
    libros_por_accion = None
    if activos and pasivos and activos > pasivos:
        libros_por_accion = (activos - pasivos) / acciones

    moneda = info.get("currency") or ("MXN" if t.endswith(".MX") else "USD")

    notas = [
        "El precio de mercado no se discute: se toma como dato y se despeja "
        "qué supuestos lo justifican.",
        f"Costo de capital base {r0:.1%} = tasa libre de riesgo {rf:.1%} + "
        f"beta desapalancada {beta_u:.2f} × prima de mercado {prima:.1%}.",
        f"Tasa efectiva de impuestos {tc:.1%}, del último ejercicio reportado "
        f"y acotada entre {_TC_MIN:.0%} y {_TC_MAX:.0%}.",
        "El escudo fiscal supone que la deuda se mantiene indefinidamente "
        "(Modigliani-Miller con impuestos: V_L = V_U + Tc·D).",
        "Las celdas vacías son combinaciones donde el crecimiento alcanza al "
        "costo de capital y la fórmula deja de tener sentido.",
    ]

    return {
        "ok": True,
        "aplica": True,
        "ticker": t,
        "moneda": moneda,
        "precio_mercado": precio,
        # Lo que NO es supuesto: sale de los estados financieros.
        "observado": {
            "ebit": ebit,
            "nopat": nopat,
            "tasa_impuestos": tc,
            "deuda": deuda,
            "caja": caja,
            "acciones": acciones,
            "escudo_fiscal": escudo,
            "capitalizacion": equity_mercado,
        },
        # El modelo tal cual: el puente completo hasta el precio MM.
        "puente": {
            "nopat": nopat,
            "valor_sin_deuda": valor_sin_deuda,
            "escudo_fiscal": escudo,
            "valor_empresa": valor_empresa,
            "menos_deuda": deuda,
            "mas_caja": caja,
            "equity": equity_mm,
            "precio_mm": precio_mm,
        },
        "mercado": {
            "precio": precio,
            "diferencia_pct": (precio_mm / precio - 1.0) if precio else None,
            "equity_mercado": equity_mercado,
        },
        # Lo que SÍ es supuesto, y qué valor implica el precio de hoy.
        "supuestos_implicitos": {
            "costo_capital_base": r0,
            "beta_apalancada": round(beta_l, 3),
            "beta_desapalancada": round(beta_u, 3),
            "tasa_libre_riesgo": rf,
            "prima_mercado": prima,
            "crecimiento_implicito": g_implicita,
            "costo_capital_implicito_sin_crecimiento": r0_implicito,
        },
        "sensibilidad": {
            "eje_crecimiento": eje_g,
            "eje_costo_capital": eje_r0,
            "celdas": celdas,
            "centro": {"fila": 2, "columna": 2},
            "precio_centro": centro,
            "cambio_por_punto_de_crecimiento": sens_g,
            "cambio_por_punto_de_costo_capital": sens_r0,
        },
        # ── COMPATIBILIDAD CON CLIENTES VIEJOS ─────────────────────────────
        # El backend se despliega para TODOS a la vez, pero el JS de cada quien
        # llega cuando su navegador decide refrescar la caché. Al renombrar
        # `supuestos` de array a objeto y quitar `entradas`, el frontend anterior
        # reventaba —hacía `(d.supuestos || []).map(...)` sobre un objeto— y la
        # tarjeta mostraba "No se pudo calcular ahora mismo" hasta que el usuario
        # recargara dos veces. Cambiar la forma de una respuesta ya publicada es
        # romper un contrato: estos dos campos lo mantienen.
        "entradas": {
            "ebit": ebit,
            "tasa_impuestos": tc,
            "deuda": deuda,
            "caja": caja,
            "acciones": acciones,
            "beta_apalancada": round(beta_l, 3),
            "beta_desapalancada": round(beta_u, 3),
            "tasa_libre_riesgo": rf,
            "prima_mercado": prima,
            "costo_capital_r0": r0,
        },
        "valor_libros_por_accion": libros_por_accion,
        "lectura": _lectura(precio, g_implicita, r0_implicito, r0, sens_g),
        # `supuestos` conserva su tipo original (lista de texto): el frontend
        # anterior lo recorre con .map y se rompería con cualquier otra cosa.
        "supuestos": notas,
        "notas": notas,
    }


def _lectura(precio: float, g: Optional[float], r0_impl: Optional[float],
             r0: float, sens_g: Optional[float]) -> str:
    """Una frase sobre QUÉ hay que creer para pagar el precio de hoy."""
    partes = []
    if g is not None:
        if g <= 0:
            partes.append(
                f"Para justificar el precio de hoy no hace falta suponer ningún "
                f"crecimiento: al precio actual el mercado descuenta {g:.1%}, es "
                f"decir que la empresa se encoja.")
        elif g <= 0.02:
            partes.append(
                f"Basta con suponer que la empresa crece {g:.1%} para siempre —poco "
                f"más que seguirle el paso a la inflación— para justificar el precio "
                f"de hoy.")
        elif g <= 0.05:
            partes.append(
                f"El precio de hoy exige creer en un crecimiento perpetuo de {g:.1%}: "
                f"exigente para una empresa madura, razonable para una que aún crece.")
        else:
            partes.append(
                f"El precio de hoy exige creer en un crecimiento perpetuo de {g:.1%}, "
                f"sostenido para siempre. La pregunta no es si la acción está cara, "
                f"sino si ese ritmo es creíble sin fecha de caducidad.")
    if r0_impl is not None:
        partes.append(
            f"Visto al revés: si la empresa no creciera nada, pagar este precio "
            f"equivale a exigirle un retorno de {r0_impl:.1%} anual "
            f"(el CAPM le pide {r0:.1%}).")
    if sens_g:
        partes.append(
            f"Es sensible: un punto porcentual más de crecimiento mueve el precio "
            f"{sens_g:+.0%}.")
    return " ".join(partes)
