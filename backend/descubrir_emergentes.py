"""
descubrir_emergentes.py — Selecciona semanalmente un pool de acciones
EMERGENTES (chicas/medianas con potencial) para la Acción del Día.

Idea: la Acción del Día debe servir para DESCUBRIR, no repetir Google/GMéxico.
Este job revisa el caché de fundamentales (que tu Mac llena), filtra empresas
pequeñas/medianas en sectores en crecimiento con buen momentum/crecimiento, y
guarda la lista en el caché de BD bajo la clave "__POOL_EMERGENTES__".

Acción del Día lee ese pool y lo suma a sus candidatos. Como corre SEMANAL,
el pool se renueva solo conforme cambian el momentum y crecen nuevas emisoras.

NO descarga de Yahoo (solo lee el caché de la BD) → no lo bloquean, es rápido,
y puede correr en Render por cron.

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


def generar_pool(n: int = 40, verbose: bool = True) -> list[str]:
    """Núcleo reutilizable: selecciona el pool de emergentes desde el caché y lo
    guarda en la BD. Devuelve la lista de tickers. Lo llama main() y también el
    prewarm (actualizar_mx_backup.py) al terminar, para que sea 100% automático."""
    import data_fallback as fb

    cache = fb.listar_cache_todos()
    if not cache:
        if verbose:
            print("Caché de fundamentales vacío. Corre primero el prewarm. Nada que hacer.")
        return []

    candidatos = []
    for tk, fund in cache.items():
        if not isinstance(fund, dict) or not fund.get("ok"):
            continue
        if fund.get("_es_fondo"):              # ETFs/fondos no son 'acciones emergentes'
            continue
        t = tk.upper()
        if "-USD" in t or "-USDT" in t:        # cripto fuera
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
    args = ap.parse_args()
    generar_pool(n=args.n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
