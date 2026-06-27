"""
refrescar_ranking_full.py — Descarga SOLO precios del universo completo y
regenera el ranking del screener en Neon (clave __RANKING_FULL__).

Por qué funciona en GitHub Actions: los PRECIOS de Yahoo SÍ se bajan desde IPs
de datacenter (yfinance.download), a diferencia de los fundamentales (.info →
401 "Invalid Crumb"). Los fundamentales para el score vienen del caché de Neon
(lo llena el prewarm de la Mac, que sí tiene IP residencial). Así el screener
cubre el universo COMPLETO y se refresca solo, sin depender de que la Mac esté
prendida.

Flujo:
  1. Construye la lista del universo (mismas fuentes que descargar_universo).
  2. Descarga SOLO precios (rápido, no bloqueado).
  3. Guarda universo_precios.csv para que accion_del_dia.ranking lo use.
  4. Genera el ranking completo y lo guarda en Neon.

Uso:  DATABASE_URL=<neon> python3 refrescar_ranking_full.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))


def construir_universo() -> list[str]:
    import descargar_universo as du
    fuentes: list[str] = []
    for fn in (du.obtener_sp500, du.obtener_sp400_midcap, du.obtener_sp600_smallcap,
               du.obtener_nasdaq100, du.obtener_dow_jones, du.obtener_russell1000,
               du.obtener_nasdaqtrader_full):
        try:
            fuentes += fn() or []
        except Exception as e:
            print(f"  warn {fn.__name__}: {e}")
    universo = sorted(set(
        fuentes + du.BMV_COMPLETO + du.ETFS_INDICES + du.CRYPTO_TICKERS + du.INTERNACIONALES
    ))
    return universo


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("ERROR: falta DATABASE_URL (Neon). No hay dónde guardar el ranking.")
        return 1

    import descargar_universo as du
    import accion_del_dia as ad

    print("Construyendo lista del universo…")
    universo = construir_universo()
    print(f"  {len(universo)} tickers candidatos")

    print("Descargando SOLO precios (esto sí funciona desde datacenter)…")
    precios = du.descargar_precios(universo)
    if precios is None or precios.empty:
        print("ERROR: no se descargaron precios.")
        return 1
    print(f"  {len(precios.columns)} tickers con precios · {len(precios)} días")

    # Guardar el CSV completo para que accion_del_dia.ranking() lo lea.
    ruta = BACKEND / "universo_precios.csv"
    precios.to_csv(ruta)
    print(f"  guardado {ruta}")

    # Invalidar el cache en memoria por si acaso y generar el ranking completo.
    ad._PRECIOS_CACHE.pop("df", None)
    print("Generando ranking del universo completo → Neon…")
    rows = ad.generar_ranking_full()
    print(f"LISTO: ranking de {len(rows)} tickers guardado en Neon (__RANKING_FULL__).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
