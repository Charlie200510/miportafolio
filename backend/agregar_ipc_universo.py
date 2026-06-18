"""
agregar_ipc_universo.py — Rescata las emisoras del IPC que falten en el universo.

Por qué existe: el IPC-35 ya está listado en descargar_universo.py, pero algunas
emisoras grandes (GMEXICOB, GRUMAB, AC, ALFAA, CHDRAUIB, ELEKTRA…) a veces no
entran al universo porque fallaron al descargar en la corrida masiva (throttling
de Yahoo). Este script baja SOLO las que faltan, lento y con reintentos, y las
agrega a:
    - universo_lite_precios.csv   (serie de precios, columna nueva)
    - universo_lite_info.json     (metadata + fundamentales)
    - universo_info.json

IMPORTANTE: córrelo EN TU MAC (donde vive el repo), no en Render (disco efímero).
Luego haz commit + push de los 3 archivos. Requiere: pip install yfinance pandas

Seguro por diseño:
    - Si la descarga viene vacía, NO toca ningún archivo.
    - Hace respaldo .bak del CSV antes de escribir.
    - Solo agrega columnas/entradas nuevas; no borra ni reescribe las existentes.

Uso:
    python3 agregar_ipc_universo.py                 # solo las del IPC que falten
    python3 agregar_ipc_universo.py GMEXICOB.MX ...  # tickers específicos
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import pandas as pd

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

LITE_CSV = BACKEND / "universo_lite_precios.csv"
LITE_JSON = BACKEND / "universo_lite_info.json"
FULL_JSON = BACKEND / "universo_info.json"

# IPC-35 (S&P/BMV IPC). Actualízalo en cada rebalanceo del índice (~2 veces/año).
IPC_35 = [
    "AC.MX", "ALFAA.MX", "ALSEA.MX", "AMXB.MX", "ASURB.MX",
    "BBAJIOO.MX", "BIMBOA.MX", "BOLSAA.MX", "CEMEXCPO.MX", "CHDRAUIB.MX",
    "CUERVO.MX", "ELEKTRA.MX", "FEMSAUBD.MX", "GAPB.MX", "GCARSOA1.MX",
    "GCC.MX", "GENTERA.MX", "GFINBURO.MX", "GFNORTEO.MX", "GMEXICOB.MX",
    "GRUMAB.MX", "KIMBERA.MX", "KOFUBL.MX", "LABB.MX", "LIVEPOLC-1.MX",
    "MEGACPO.MX", "OMAB.MX", "ORBIA.MX", "PE&OLES.MX", "PINFRA.MX",
    "Q.MX", "RA.MX", "TLEVISACPO.MX", "VESTA.MX", "WALMEX.MX",
]


def _cargar_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _guardar_json(p: Path, data: dict) -> None:
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def main() -> int:
    import descargar_universo as du

    pedidos = [t.strip().upper() for t in sys.argv[1:] if t.strip()]
    objetivo = pedidos or IPC_35

    lite_info = _cargar_json(LITE_JSON)
    full_info = _cargar_json(FULL_JSON)

    faltan = [t for t in objetivo if t not in lite_info or t not in full_info]
    if not faltan:
        print("Todas las emisoras objetivo ya están en el universo. Nada que hacer.")
        return 0
    print(f"Faltan {len(faltan)}: {faltan}")

    # 1) Descargar precios (lento, reusa el chunking del descargador)
    print("Descargando precios…")
    df = du.descargar_precios(faltan)
    if df is None or getattr(df, "empty", True):
        print("La descarga de precios vino vacía → NO se modifica nada. Reintenta más tarde.")
        return 1

    con_precio = [t for t in faltan if t in df.columns and df[t].notna().any()]
    sin_precio = [t for t in faltan if t not in con_precio]
    if sin_precio:
        print(f"  (sin precios, se omiten por ahora: {sin_precio})")
    if not con_precio:
        print("Ninguna emisora trajo precios → NO se modifica nada.")
        return 1

    # 2) Mezclar precios en el CSV lite (respaldo antes de escribir)
    lite = pd.read_csv(LITE_CSV, index_col=0, parse_dates=True)
    shutil.copy(LITE_CSV, LITE_CSV.with_suffix(".csv.bak"))
    for t in con_precio:
        lite[t] = df[t].reindex(lite.index)   # alinear a las fechas del lite

    # 3) Info + fundamentales (uno por uno, con pausa para no disparar 429)
    for t in con_precio:
        try:
            _, info = du._info_de(t)
        except Exception as e:
            info = {"nombre": t, "pais": "Mexico", "moneda": "MXN"}
            print(f"  warn info {t}: {e}")
        info.setdefault("recomendada", True)   # del IPC → recomendada
        lite_info[t] = info
        full_info[t] = info
        time.sleep(2.0)

    # 4) Guardar todo
    lite.to_csv(LITE_CSV)
    _guardar_json(LITE_JSON, lite_info)
    _guardar_json(FULL_JSON, full_info)

    print("\n===== LISTO =====")
    print(f"  Agregadas: {con_precio}")
    print(f"  Respaldo CSV: {LITE_CSV.with_suffix('.csv.bak')}")
    print("  Ahora haz commit + push de:")
    print("    universo_lite_precios.csv  universo_lite_info.json  universo_info.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
