"""
descubrir_emergentes.py — Selecciona semanalmente un pool de acciones
EMERGENTES (chicas/medianas con potencial) para la Acción del Día.

Idea: la Acción del Día debe servir para DESCUBRIR, no repetir Google/GMéxico.
Este job revisa el caché de fundamentales (que tu Mac llena), filtra empresas
pequeñas/medianas en sectores en crecimiento con buen momentum/crecimiento, y
guarda la lista en el caché de BD bajo la clave "__POOL_EMERGENTES__".

Acción del Día lee ese pool y lo suma a sus candidatos. Como corre SEMANAL,
el pool se renueva solo conforme cambian el momentum y crecen nuevas emisoras.

AUTOSUFICIENTE. Antes solo leía el caché de fundamentales que llenaba la Mac
del autor, con el argumento de que Yahoo devolvía 401 "Invalid Crumb" a las IPs
de datacenter. Eso ya no es cierto: comprobado el 2026-08-26 desde la VM, .info
responde con marketCap, revenueGrowth y sector para tickers de EE.UU. y de la
BMV. Como en producción ese caché tenía 3 filas, el pool salía con 1 emisora y
Acción del Día se quedaba reciclando el mismo puñado de nombres cada 8 días.

Ahora el script se busca sus propios datos: filtra el universo por señales de
precio (gratis, salen del CSV), y enriquece por Yahoo solo a los que le faltan,
despacio y de forma incremental. Cada corrida semanal amplía el pool.

Uso:  python3 descubrir_emergentes.py [--n 40]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

_SECTORES_CRECIMIENTO = ("tech", "tecnolog", "energy", "energ", "semiconduct",
                         "software", "communication", "comunicac", "renewable",
                         "clean", "bio", "health", "salud", "industrial")

_CLAVE_POOL = "__POOL_EMERGENTES__"

_UNIV_LITE_CSV = BACKEND / "universo_lite_precios.csv"


def _tickers_desplegables() -> set[str]:
    """Tickers que de verdad están en el universo LITE (lo único que corre en
    prod). Acción del Día solo puede elegir candidatos que estén en este CSV de
    precios, así que el pool debe limitarse a ellos o no servirá de nada."""
    try:
        import csv
        with open(_UNIV_LITE_CSV, newline="") as f:
            cols = next(csv.reader(f))
        return {c.strip().upper() for c in cols if c.strip()}
    except Exception:
        return set()


def _mc_usd(fund: dict) -> float:
    mc = fund.get("market_cap")
    if not mc:
        return 0.0
    try:
        mc = float(mc)
    except (TypeError, ValueError):
        return 0.0
    if (fund.get("ticker") or "").upper().endswith(".MX"):
        mc /= 18.0   # MXN→USD aprox
    return mc


def _potencial(fund: dict) -> float:
    """Puntúa el 'potencial emergente'. Mayor = mejor candidata para descubrir."""
    mc = _mc_usd(fund)
    # Solo small/mid: el rango donde de verdad hay 'descubrimiento'
    if not (300e6 <= mc <= 20e9):
        return -1.0

    pot = 0.0
    # Crecimiento (último año + trimestre)
    r1y = fund.get("retorno_1y") or 0
    r3m = fund.get("retorno_3m") or 0
    rev = fund.get("revenue_growth") or fund.get("earnings_growth") or 0
    if r1y > 0.15: pot += min(20, r1y * 40)
    if 0.03 <= r3m <= 0.40: pot += 10           # momentum sano (no parabólico)
    if rev and rev > 0.10: pot += min(15, rev * 60)
    # Rentabilidad/calidad (no exigir mucho: son emergentes)
    roe = fund.get("roe")
    if roe and roe > 0.12: pot += 6
    margen = (fund.get("margenes") or {}).get("neto")
    if margen and margen > 0.08: pot += 4
    # Sector en crecimiento
    sector = (fund.get("sector") or "").lower()
    if any(s in sector for s in _SECTORES_CRECIMIENTO): pot += 12
    # Preferir el extremo chico del rango (más 'joya por descubrir')
    if mc < 5e9: pot += 6
    return pot


# Caché COMPARTIDO con portafolio_optimo.py: mismo archivo, mismo formato.
# Los dos necesitan las mismas fichas de Yahoo, así que lo que baja uno le
# sirve al otro y no se paga la llamada dos veces.
_VALUACION_PATH = BACKEND / "_datos" / "valuacion_cache.json"
_CAMPOS = ("marketCap", "sector", "industry", "revenueGrowth", "earningsGrowth",
           "returnOnEquity", "profitMargins", "operatingMargins", "currentPrice",
           "forwardPE", "trailingPE", "longName", "shortName")


def _leer_valuacion() -> dict:
    import json
    try:
        if _VALUACION_PATH.exists():
            with open(_VALUACION_PATH, encoding="utf-8") as f:
                return json.load(f) or {}
    except Exception:
        pass
    return {}


def _guardar_valuacion(d: dict) -> None:
    import json
    try:
        _VALUACION_PATH.parent.mkdir(exist_ok=True)
        tmp = _VALUACION_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        tmp.replace(_VALUACION_PATH)
    except Exception:
        pass


def _senales_de_precio() -> dict:
    """Momentum y retorno anual de TODO el universo, leídos del CSV.

    Es gratis y no toca la red, así que sirve para decidir a quién vale la pena
    preguntarle a Yahoo. Sin este filtro previo habría que enriquecer cientos de
    emisoras por corrida para encontrar unas pocas interesantes.
    """
    try:
        import pandas as pd
    except Exception:
        return {}
    if not _UNIV_LITE_CSV.exists():
        return {}
    try:
        df = pd.read_csv(_UNIV_LITE_CSV, index_col=0, parse_dates=True).sort_index()
    except Exception:
        return {}
    out = {}
    for t in df.columns:
        s_ = df[t].dropna()
        if len(s_) < 130:            # ~6 meses hábiles mínimos
            continue
        try:
            ult = float(s_.iloc[-1])
            if ult <= 1.0:           # centavos: ni liquidez ni interés
                continue
            r3m = ult / float(s_.iloc[-63]) - 1 if len(s_) >= 63 else 0.0
            r1y = ult / float(s_.iloc[-252]) - 1 if len(s_) >= 252 else 0.0
        except Exception:
            continue
        out[t.upper()] = {"r3m": r3m, "r1y": r1y, "precio": ult}
    return out


def enriquecer(limite: int = 80, pausa: float = 1.2, verbose: bool = True) -> int:
    """Baja de Yahoo las fichas que faltan, priorizando a las prometedoras.

    Incremental a propósito: `limite` por corrida, con pausa entre llamadas. Una
    tanda semanal de 80 cubre el universo desplegable en pocas semanas y evita
    el 429 que aparece cuando se piden cientos seguidas.
    """
    senales = _senales_de_precio()
    if not senales:
        if verbose:
            print("Sin señales de precio (¿falta el CSV del universo?). No enriquezco.")
        return 0
    cache = _leer_valuacion()

    # A quién preguntar primero: momentum sano (ni plano ni parabólico) y que
    # haya subido en el año. Es el perfil que describe a una emergente con
    # tracción, que es lo que este pool busca.
    # Las CURADAS entran con prioridad aunque no tengan pinta de emergentes:
    # sin su market cap, `_ajuste_descubrimiento` no puede castigarlas por
    # gigantes y competían como si fueran chicas. Saber que XOM es enorme vale
    # tanto como saber que DJCO es pequeña.
    try:
        import json as _j
        _info = _j.loads((BACKEND / "universo_lite_info.json").read_text(encoding="utf-8"))
        curadas = {t.upper() for t, v in _info.items()
                   if isinstance(v, dict) and v.get("recomendada")}
    except Exception:
        curadas = set()

    # Un ticker cuenta como PENDIENTE si no está, o si su ficha quedó vacía
    # hace más de una semana. Esa distinción importa: cuando la tanda encadena
    # cientos de llamadas, Yahoo empieza a devolver respuestas vacías por límite
    # de tasa, y guardarlas como definitivas envenena el caché para siempre. Fue
    # lo que pasó con XOM, CVX, CSCO, AVGO y COST: quedaron marcados como
    # consultados y sin market cap, y sin tamaño el filtro no puede castigarlos
    # por gigantes. Un vacío por rate-limit no es «no hay dato»: es «vuelve a
    # preguntar más tarde».
    _REINTENTO = 7 * 24 * 3600
    _ahora = time.time()

    def _pendiente(t):
        d = cache.get(t)
        if d is None:
            return True
        if d.get("marketCap") is not None:
            return False
        return (_ahora - float(d.get("_vacio") or 0)) > _REINTENTO

    faltan = [t for t in senales if _pendiente(t)]
    faltan.sort(key=lambda t: (
        0 if t in curadas else 1,                                  # curadas primero
        -(1 if 0.02 <= senales[t]["r3m"] <= 0.60 else 0),          # momentum sano
        -senales[t]["r1y"],
    ))

    try:
        import yfinance as yf
    except Exception:
        return 0
    import time as _t
    nuevos = 0
    for t in faltan[:limite]:
        try:
            iy = yf.Ticker(t).info or {}
        except Exception:
            iy = {}
        reg = {k: iy.get(k) for k in _CAMPOS if iy.get(k) is not None}
        if not reg.get("marketCap"):
            # Vacío: se anota CUÁNDO, para que la tanda avance ahora pero el
            # ticker vuelva a la cola dentro de una semana. Sin la marca de
            # tiempo, un fallo pasajero de Yahoo se volvía permanente.
            reg["_vacio"] = _ahora
        cache[t] = reg
        nuevos += 1
        if nuevos % 20 == 0:
            _guardar_valuacion(cache)
            if verbose:
                print(f"  enriquecidas {nuevos}/{min(limite, len(faltan))}...")
        _t.sleep(pausa)
    _guardar_valuacion(cache)
    if verbose:
        print(f"Enriquecidas {nuevos} emisoras. Caché: {len(cache)} en total, "
              f"{len(faltan) - nuevos} pendientes.")
    return nuevos


def _candidatos_desde_valuacion(senales: dict) -> list:
    """Convierte el caché compartido en candidatos con la forma que espera
    `_potencial()`, que fue escrita para las fichas del caché de la BD."""
    fichas = []
    for tk, v in _leer_valuacion().items():
        if not v or not v.get("marketCap"):
            continue                       # sin tamaño no se puede juzgar "chica"
        sen = senales.get(tk) or {}
        fichas.append({
            "ok": True,
            "ticker": tk,
            "nombre": tk,
            "sector": v.get("sector") or "",
            "market_cap": v.get("marketCap"),
            "retorno_1y": sen.get("r1y", 0.0),
            "retorno_3m": sen.get("r3m", 0.0),
            "revenue_growth": v.get("revenueGrowth"),
            "roe": v.get("returnOnEquity"),
            "margen_neto": v.get("profitMargins"),
        })
    return fichas


def generar_pool(n: int = 40, verbose: bool = True) -> list[str]:
    """Núcleo reutilizable: selecciona el pool de emergentes desde el caché y lo
    guarda en la BD. Devuelve la lista de tickers. Lo llama main() y también el
    prewarm (actualizar_mx_backup.py) al terminar, para que sea 100% automático."""
    import data_fallback as fb

    senales = _senales_de_precio()

    # Dos fuentes que se suman:
    #   a) el caché de fundamentales de la BD (lo llena el prewarm, si corre)
    #   b) el caché compartido con el optimizador, que este script llena solo
    # La (b) es la que hace que esto funcione sin depender de ninguna máquina
    # en concreto: antes, con la (a) vacía en la VM, el pool salía con 1 emisora.
    cache = dict(fb.listar_cache_todos() or {})
    propios = _candidatos_desde_valuacion(senales)
    for f in propios:
        cache.setdefault(f["ticker"], f)

    if not cache:
        if verbose:
            print("Sin datos en ninguna de las dos fuentes. Corre --enriquecer primero.")
        return []

    # Solo tickers que están en el universo lite (los únicos que Acción del Día
    # puede elegir en prod). Si por alguna razón no se puede leer, no filtramos.
    desplegables = _tickers_desplegables()

    candidatos = []
    for tk, fund in cache.items():
        if not isinstance(fund, dict) or not fund.get("ok"):
            continue
        if fund.get("_es_fondo"):              # ETFs/fondos no son 'acciones emergentes'
            continue
        t = tk.upper()
        if "-USD" in t or "-USDT" in t:        # cripto fuera
            continue
        if desplegables and t not in desplegables:   # fuera del universo lite → inservible en prod
            continue
        pot = _potencial(fund)
        if pot > 0:
            candidatos.append((pot, tk, fund.get("nombre"), fund.get("sector")))

    candidatos.sort(reverse=True, key=lambda x: x[0])
    top = candidatos[:n]
    tickers = [tk for _, tk, _, _ in top]

    fb.guardar_cache(_CLAVE_POOL, {
        "ok": True,
        "tickers": tickers,
        "generado": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_evaluados": len(cache),
    })

    if verbose:
        print(f"===== POOL EMERGENTES ({len(tickers)}) =====")
        for pot, tk, nom, sec in top:
            print(f"  {pot:5.1f}  {tk:14s} {sec or '—':22s} {nom or ''}")
        print(f"Guardado en BD bajo '{_CLAVE_POOL}'. Acción del Día ya lo usará.")
    return tickers


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40, help="tamaño del pool de emergentes")
    ap.add_argument("--enriquecer", type=int, default=0, metavar="N",
                    help="baja de Yahoo hasta N fichas que falten, antes de generar el pool")
    ap.add_argument("--pausa", type=float, default=1.2,
                    help="segundos entre llamadas a Yahoo (default 1.2)")
    args = ap.parse_args()
    if args.enriquecer:
        enriquecer(limite=args.enriquecer, pausa=args.pausa)
    generar_pool(n=args.n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
