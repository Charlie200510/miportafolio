# -*- coding: utf-8 -*-
"""Moneda, tipo de cambio y divisibilidad de cada emisora.

POR QUÉ ES UN MÓDULO Y NO UNA FUNCIÓN COPIADA
----------------------------------------------
Lo necesitan dos sitios que calculan cuánto dinero hace falta para armar una
cartera: perfiles.py y portafolio_optimo.py. Copiarlo en los dos es la clase de
duplicado que se desincroniza en silencio — si mañana se añade otra divisa o
cambia la fuente del tipo de cambio, uno de los dos se queda atrás y empieza a
dar mínimos que difieren entre pantallas sin que nadie sepa por qué.

EL TIPO DE CAMBIO IMPORTA. Los universos mezclan BMV y EE.UU.; sumar un precio
en dólares con uno en pesos da un mínimo 17 veces equivocado.
"""
from __future__ import annotations

import json
import pathlib
import time
from typing import Optional, Tuple

_DIR = pathlib.Path(__file__).parent
_INFO_FULL = _DIR / "universo_info.json"
_INFO_LITE = _DIR / "universo_lite_info.json"
_CACHE_MERCADOS = _DIR / "_cache_periodico" / "mercados_dashboard.json"

# Si no hay forma de saberlo se usa esto y se AVISA con la bandera de estimado.
# Nunca se calla: un mínimo calculado con un FX inventado, presentado como
# exacto, es peor que no dar el número.
FX_RESPALDO = 17.5
_FX_MAX_EDAD = 36 * 3600      # 36 h; el dólar no se mueve tanto en un día

_mem: dict = {"info": None, "fx": None}


def info_universo() -> dict:
    """Metadata del universo; de ahí sale la moneda y el sector de cada emisora."""
    if _mem["info"] is None:
        datos: dict = {}
        for p in (_INFO_FULL, _INFO_LITE):
            if p.exists():
                try:
                    with open(p, encoding="utf-8") as fh:
                        datos = json.load(fh)
                    break
                except Exception:
                    continue
        _mem["info"] = datos
    return _mem["info"]


def tipo_cambio() -> Tuple[float, bool]:
    """(USD/MXN, estimado). Lee el caché del Periódico; si está viejo, lo pide."""
    if _mem["fx"] is not None:
        return _mem["fx"]
    valor, estimado = None, True
    if _CACHE_MERCADOS.exists():
        try:
            with open(_CACHE_MERCADOS, encoding="utf-8") as fh:
                d = json.load(fh)
            fresco = (time.time() - float(d.get("_ts", 0))) < _FX_MAX_EDAD
            for x in ((d.get("data") or d).get("divisas") or []):
                if x.get("ticker") == "MXN=X" and x.get("precio"):
                    valor, estimado = float(x["precio"]), not fresco
                    break
        except Exception:
            pass
    if valor is None or estimado:
        try:
            import yfinance as yf
            h = yf.Ticker("MXN=X").history(period="5d", interval="1d", auto_adjust=True)
            c = h["Close"].dropna()
            if len(c):
                valor, estimado = float(c.iloc[-1]), False
        except Exception:
            pass
    if valor is None or not (5 < valor < 60):      # cordura: el peso no vale eso
        valor, estimado = FX_RESPALDO, True
    _mem["fx"] = (valor, estimado)
    return _mem["fx"]


def moneda_de(ticker: str, info: Optional[dict] = None) -> str:
    """Moneda en la que COTIZA la emisora (código ISO de tres letras).

    Antes solo se reconocían MXN y USD y todo lo demás caía a USD: CaixaBank
    (EUR) se convertía con el dólar y salía ~15% más barata; una emisora india
    (INR) salía ochenta veces más cara. El universo trae 106 así (euros,
    libras, rupias, coronas, reales, francos, dólares australianos)."""
    info = info if info is not None else info_universo()
    m = (info.get(ticker) or {}).get("moneda")
    if isinstance(m, str) and len(m) == 3 and m.isalpha():
        return m.upper()
    # Sin metadata manda el sufijo: misma regla que usa elegir_benchmark.
    return "MXN" if ticker.upper().endswith(".MX") else "USD"


# Dólares por unidad de cada moneda, SOLO de respaldo si Yahoo no contesta.
# Se multiplican por el USD/MXN vigente: los cruces contra el dólar se mueven
# mucho menos que contra el peso, así que el respaldo envejece despacio. Lo
# que salga de aquí va marcado como estimado.
_USD_POR_UNIDAD = {
    "EUR": 1.15, "GBP": 1.33, "CHF": 1.24, "AUD": 0.66, "CAD": 0.72,
    "INR": 0.0115, "BRL": 0.18, "NOK": 0.097, "SEK": 0.105, "DKK": 0.154,
    "JPY": 0.0067, "HKD": 0.128,
}
_CRUCES_MAX_EDAD = 12 * 3600


def _cruces() -> dict:
    """{moneda: pesos por unidad} para las monedas del universo que no son
    MXN ni USD. Una sola descarga por proceso cada 12 h."""
    c = _mem.get("cruces")
    if c and time.time() - c["_ts"] < c.get("_ttl", _CRUCES_MAX_EDAD):
        return c
    monedas = sorted({moneda_de(t) for t in info_universo()} - {"MXN", "USD"})
    vivos = {}
    if monedas:
        try:
            import yfinance as yf
            pares = [f"{m}MXN=X" for m in monedas]
            h = yf.download(pares, period="5d", interval="1d", auto_adjust=True,
                            progress=False, threads=False)
            cierre = h["Close"] if "Close" in h else h
            for m, par in zip(monedas, pares):
                try:
                    s = (cierre[par] if par in getattr(cierre, "columns", []) else cierre).dropna()
                    v = float(s.iloc[-1]) if len(s) else None
                except Exception:
                    v = None
                if v and v > 0:
                    vivos[m] = v
        except Exception:
            pass
        # Yahoo no publica todos los cruces contra el peso (INRMXN=X, NOKMXN=X,
        # SEKMXN=X y DKKMXN=X no existen). Para esos se pasa por el dólar:
        # "INR=X" son rupias por dólar, y USD/MXN entre eso da pesos por rupia.
        faltan = [m for m in monedas if m not in vivos]
        if faltan:
            try:
                import yfinance as yf
                fx, _ = tipo_cambio()
                pares = [f"{m}=X" for m in faltan]
                h = yf.download(pares, period="5d", interval="1d", auto_adjust=True,
                                progress=False, threads=False)
                cierre = h["Close"] if "Close" in h else h
                for m, par in zip(faltan, pares):
                    try:
                        s = (cierre[par] if par in getattr(cierre, "columns", []) else cierre).dropna()
                        por_dolar = float(s.iloc[-1]) if len(s) else None
                    except Exception:
                        por_dolar = None
                    if por_dolar and por_dolar > 0:
                        vivos[m] = fx / por_dolar
            except Exception:
                pass
    # Completo, se guarda 12 h. Si Yahoo falló en alguno, solo 15 min: con el
    # mismo plazo largo, un tropiezo de la red dejaba el respaldo fijo medio día.
    completo = all(m in vivos for m in monedas)
    c = {"_ts": time.time(), "vivos": vivos, "_ttl": _CRUCES_MAX_EDAD if completo else 15 * 60}
    _mem["cruces"] = c
    return c


def pesos_por(moneda: str) -> Tuple[float, bool]:
    """(pesos por una unidad de `moneda`, estimado)."""
    if moneda == "MXN":
        return 1.0, False
    fx, estimado = tipo_cambio()
    if moneda == "USD":
        return fx, estimado
    v = _cruces()["vivos"].get(moneda)
    if v:
        return v, False
    # Sin cruce en vivo: respaldo contra el dólar. Si ni eso hay, se trata como
    # dólar y se marca estimado; es lo que pasaba antes con TODAS.
    return fx * _USD_POR_UNIDAD.get(moneda, 1.0), True


def en_unidad_mayor(ticker: str, moneda: str, precio: float) -> float:
    """Londres cotiza en PENIQUES (GBp) aunque la moneda diga GBP: Shell sale
    a 3220.5, que son £32.20. Sin esto valía cien veces más."""
    if moneda == "GBP" and ticker.upper().endswith(".L"):
        return precio / 100.0
    return precio


def fraccionable(ticker: str, info: Optional[dict] = None) -> bool:
    """¿Se puede comprar un pedazo, o solo unidades enteras?

    Las criptos SÍ: nadie compra un bitcoin entero, se compran 0.002. Tratarlas
    como acciones enteras daba un mínimo de casi siete millones de pesos para
    una cartera cripto —el precio de un bitcoin entre su peso—, que es falso y
    en pantalla destruye la credibilidad de todo lo demás.

    Acciones y ETFs se asumen enteros. Algunos brokers mexicanos ya venden
    fracciones, pero no todos, así que el número conservador sirve para
    cualquiera: con fracciones hace falta menos, nunca más.
    """
    info = info if info is not None else info_universo()
    return ((info.get(ticker) or {}).get("sector") == "Criptomoneda"
            or ticker.upper().endswith("-USD"))


def a_pesos(ticker: str, precio: float, info: Optional[dict] = None) -> float:
    mon = moneda_de(ticker, info)
    fx, _ = pesos_por(mon)
    return en_unidad_mayor(ticker, mon, precio) * fx
