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
    info = info if info is not None else info_universo()
    m = (info.get(ticker) or {}).get("moneda")
    if m in ("MXN", "USD"):
        return m
    # Sin metadata manda el sufijo: misma regla que usa elegir_benchmark.
    return "MXN" if ticker.upper().endswith(".MX") else "USD"


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
    fx, _ = tipo_cambio()
    return precio * fx if moneda_de(ticker, info) == "USD" else precio
