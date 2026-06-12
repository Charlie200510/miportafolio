"""
brokers_mx.py — Comparativa curada de brokers mexicanos.

Datos referenciales — verifica con cada broker antes de abrir cuenta.
Última revisión: 2026-04.
"""
from __future__ import annotations
from typing import Optional


BROKERS = [
    {
        "id": "gbm",
        "nombre": "GBM Plus",
        "logo_emoji": "🟢",
        "tipo": ["Acciones MX", "Acciones US", "ETFs", "FIBRAS", "Bonos", "Crypto"],
        "minimo_apertura_mxn": 100,
        "comision_mx_pct":   0.25,    # % por trade en BMV
        "comision_us_usd":   0.0,     # comisión por trade en USA
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.5,
        "fortalezas": ["Sin mínimo real (100 MXN)", "App muy fluida", "Acceso a SIC con 0 USD comisión",
                        "Soporte por chat 24/7", "Cripto integrado"],
        "debilidades": ["Spread cambiario un poco alto", "Cobra por extracción de pesos a otro banco"],
        "ideal_para": "Inversionista mexicano que quiere todo en una sola app, sin mínimos.",
        "url": "https://www.gbm.com",
    },
    {
        "id": "kuspit",
        "nombre": "Kuspit",
        "logo_emoji": "🔵",
        "tipo": ["Acciones MX", "Acciones US", "ETFs", "FIBRAS", "Bonos"],
        "minimo_apertura_mxn": 100,
        "comision_mx_pct":   0.25,
        "comision_us_usd":   0.0,
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.6,
        "fortalezas": ["Comisiones bajas", "Plataforma simple", "Buena UX"],
        "debilidades": ["Catálogo de ETFs internacionales más limitado", "Sin opciones, futuros"],
        "ideal_para": "Inversionista novato/intermedio que quiere algo limpio sin sobrecargas.",
        "url": "https://www.kuspit.com",
    },
    {
        "id": "hapi",
        "nombre": "Hapi",
        "logo_emoji": "🟡",
        "tipo": ["Acciones US", "ETFs US", "Crypto"],
        "minimo_apertura_mxn": 0,
        "comision_mx_pct":   None,   # no acceso BMV
        "comision_us_usd":   0.0,
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.4,
        "fortalezas": ["Comisión 0 USD en acciones US", "Sin mínimo", "Fraccional shares (compra fracciones)",
                        "Buena experiencia mobile-first"],
        "debilidades": ["Solo USA y cripto, no BMV", "Aún catálogo limitado en ETFs",
                         "Spread cambiario es donde se monetizan"],
        "ideal_para": "Quien quiere comprar acciones gringas con poco capital y sin comisiones.",
        "url": "https://www.hapi.com",
    },
    {
        "id": "bursanet",
        "nombre": "Bursanet (Banorte Casa de Bolsa)",
        "logo_emoji": "🔴",
        "tipo": ["Acciones MX", "Acciones US", "ETFs", "FIBRAS", "Bonos"],
        "minimo_apertura_mxn": 0,
        "comision_mx_pct":   0.25,
        "comision_us_usd":   2.0,    # ~ $2-5 USD por trade en SIC
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.7,
        "fortalezas": ["Respaldo de Banorte", "Acceso a IPOs locales", "Reportes fiscales bien hechos"],
        "debilidades": ["UX más anticuada", "Comisión por trade en SIC", "App más torpe"],
        "ideal_para": "Quien ya es cliente Banorte y quiere todo bajo el mismo techo.",
        "url": "https://www.bursanet.mx",
    },
    {
        "id": "actinver",
        "nombre": "Actinver",
        "logo_emoji": "🟠",
        "tipo": ["Acciones MX", "Acciones US", "ETFs", "FIBRAS", "Bonos", "CETES", "Fondos"],
        "minimo_apertura_mxn": 100000,
        "comision_mx_pct":   0.30,
        "comision_us_usd":   3.0,
        "fee_anual_mxn":     0,
        "fee_inactividad":   500,
        "tipo_cambio_spread_pct": 0.6,
        "fortalezas": ["Asesoría personal incluida (con cierto saldo)", "Análisis fundamental propio",
                        "Acceso pleno a CETES, Udibonos, AAA"],
        "debilidades": ["Mínimo alto ($100k)", "Comisiones más caras", "Cobra por inactividad"],
        "ideal_para": "Inversionista con capital >$200k que valora asesoría humana.",
        "url": "https://www.actinver.com",
    },
    {
        "id": "vector",
        "nombre": "Vector Casa de Bolsa",
        "logo_emoji": "🟣",
        "tipo": ["Acciones MX", "Acciones US", "ETFs", "FIBRAS", "Bonos", "Fondos", "Derivados"],
        "minimo_apertura_mxn": 50000,
        "comision_mx_pct":   0.30,
        "comision_us_usd":   5.0,
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.5,
        "fortalezas": ["Acceso a derivados (futuros, opciones)", "Buena ejecución institucional",
                        "Reportes fiscales pulidos"],
        "debilidades": ["Mínimo medio-alto", "App menos pulida que GBM/Kuspit"],
        "ideal_para": "Inversionista con experiencia que quiere hedging o instrumentos sofisticados.",
        "url": "https://www.vector.com.mx",
    },
    {
        "id": "schwab",
        "nombre": "Charles Schwab International",
        "logo_emoji": "🇺🇸",
        "tipo": ["Acciones US", "ETFs US", "Bonos US", "Opciones", "Mutual Funds"],
        "minimo_apertura_mxn": 25000 * 17,  # 25K USD ≈ 425k MXN
        "comision_mx_pct":   None,
        "comision_us_usd":   0.0,
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.0,    # tú depositas USD directos
        "fortalezas": ["Comisión 0 USD en acciones US", "Acceso completo al mercado USA",
                        "Bonos USA Treasury directos", "Fondos Schwab sin comisión",
                        "Estabilidad institucional (Goliath)"],
        "debilidades": ["Mínimo $25,000 USD", "Necesitas depositar USD (transferencia internacional)",
                         "No accede a BMV", "Tax forms USA — declaración compleja"],
        "ideal_para": "Inversionista con capital >$500K MXN que quiere acceso pleno al mercado USA y bonos Treasury.",
        "url": "https://www.schwab.com",
    },
    {
        "id": "ibkr",
        "nombre": "Interactive Brokers (IBKR)",
        "logo_emoji": "⚡",
        "tipo": ["Acciones globales", "ETFs", "Bonos", "Opciones", "Futuros", "Forex", "Crypto"],
        "minimo_apertura_mxn": 0,
        "comision_mx_pct":   None,
        "comision_us_usd":   0.005,  # ~ 1 USD por trade chico (tiered)
        "fee_anual_mxn":     0,
        "fee_inactividad":   0,
        "tipo_cambio_spread_pct": 0.02,  # spread mínimo + $2 USD fee FX
        "fortalezas": ["Acceso a 150+ mercados mundiales", "Comisiones más bajas de la industria",
                        "Spread cambiario casi inexistente", "API para algos", "Margen barato"],
        "debilidades": ["Plataforma compleja", "UX no para principiantes",
                         "Sin acceso a BMV mexicano (solo SIC indirecto)"],
        "ideal_para": "Inversionista avanzado que opera múltiples mercados y quiere comisiones mínimas.",
        "url": "https://www.interactivebrokers.com",
    },
]


def listar_brokers() -> list[dict]:
    return BROKERS


def comparar_para_ticker(ticker: str, monto_mxn: float = 10000.0) -> list[dict]:
    """Para un ticker dado, calcula costo total estimado (comisión + spread FX si aplica)
    de comprar `monto_mxn` MXN en cada broker que lo ofrezca."""
    es_mx = ticker.endswith(".MX")
    es_us = (not es_mx) and (not ticker.endswith("-USD")) and ("." not in ticker)
    es_crypto = ticker.endswith("-USD")

    out = []
    for b in BROKERS:
        # ¿Este broker ofrece este tipo?
        ok = False
        comision_mxn = 0.0
        nota = ""
        if es_mx and "Acciones MX" in b["tipo"]:
            ok = True
            if b["comision_mx_pct"] is not None:
                comision_mxn = monto_mxn * b["comision_mx_pct"] / 100
        elif es_us and ("Acciones US" in b["tipo"] or "Acciones globales" in b["tipo"]):
            ok = True
            comision_mxn = (b["comision_us_usd"] or 0) * 17  # MXN ~ 17/USD
            spread_pct = b.get("tipo_cambio_spread_pct", 0)
            spread_mxn = monto_mxn * spread_pct / 100
            comision_mxn += spread_mxn
            if spread_pct > 0:
                nota = f"+ {spread_pct}% spread cambiario MXN→USD"
        elif es_crypto and "Crypto" in b["tipo"]:
            ok = True
            comision_mxn = monto_mxn * 0.5 / 100  # crypto típicamente ~0.5%
            nota = "Spread crypto ~0.5%"
        if ok:
            out.append({
                "broker": b["nombre"],
                "id":     b["id"],
                "emoji":  b["logo_emoji"],
                "comision_estimada_mxn": round(comision_mxn, 2),
                "monto_neto_mxn":        round(monto_mxn - comision_mxn, 2),
                "nota":                  nota,
            })
    out.sort(key=lambda x: x["comision_estimada_mxn"])
    return out


if __name__ == "__main__":
    import json
    print(json.dumps(comparar_para_ticker("AAPL", 10000), indent=2))
