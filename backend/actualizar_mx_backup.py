"""
actualizar_mx_backup.py — Pre-carga de acciones mexicanas (.MX) al caché de BD.

Qué hace (pensado para correr como tarea programada, p.ej. cada noche):
  1. Toma todas las emisoras .MX del universo (universo_info.json + lite).
  2. Las baja de Yahoo UNA por UNA, lento (sleep entre cada una) → sin 429.
  3. Cada fetch bueno se guarda solo en el caché de BD (fundamentals_cache),
     vía fundamentals._fundamentals_ticker(..., con_estados=True), que ya
     persiste el resultado. Así las .MX quedan con respaldo caliente.
  4. Genera un REPORTE DE HUECOS: qué emisoras Yahoo no cubre o cubre incompleto,
     para decidir con datos si vale la pena una fuente oficial (CNBV/XBRL).

Seguro por diseño: si una emisora falla, se registra y sigue con la siguiente;
nunca rompe el resto.

Uso:
    python3 actualizar_mx_backup.py            # todas las .MX
    python3 actualizar_mx_backup.py --pausa 2  # 2s entre cada una (default 1.5)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).parent
DATOS = BACKEND / "_datos"
DATOS.mkdir(exist_ok=True)
REPORTE = DATOS / "mx_backup_reporte.json"

sys.path.insert(0, str(BACKEND))


def _tickers(solo_mx: bool = True, lite_only: bool = False) -> list[str]:
    """Junta tickers del universo (dedupe).
    solo_mx=True → solo .MX; False → todo el universo.
    lite_only=True → solo el universo lite (~500, lo que de verdad usa la app)."""
    tickers: set[str] = set()
    fuentes = ("universo_lite_info.json",) if lite_only else ("universo_info.json", "universo_lite_info.json")
    for nombre in fuentes:
        p = BACKEND / nombre
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                for k in d:
                    ku = str(k).upper()
                    if solo_mx and not ku.endswith(".MX"):
                        continue
                    # crypto/forex no tienen fundamentales tradicionales → omitir
                    if "-USD" in ku or "-USDT" in ku:
                        continue
                    tickers.add(ku)
        except Exception as e:
            print(f"  warn leyendo {nombre}: {e}")
    return sorted(tickers)


def _clasificar(fund: dict) -> str:
    """completo | parcial | sin_datos según lo que trajo Yahoo."""
    if not fund or not fund.get("ok"):
        return "sin_datos"
    tiene_ratio = any(fund.get(k) is not None for k in ("pe_trailing", "pb", "roe", "fcf")) \
        or (fund.get("margenes") or {}).get("neto") is not None
    tiene_precio = fund.get("precio_actual") is not None
    if tiene_ratio and tiene_precio:
        return "completo"
    if tiene_precio or tiene_ratio:
        return "parcial"
    return "sin_datos"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pausa", type=float, default=4.0,
                    help="segundos entre cada emisora (más alto = menos rate-limit 429 de Yahoo)")
    ap.add_argument("--todas", action="store_true",
                    help="todo el universo (no solo .MX). Ideal corriéndolo desde tu Mac.")
    ap.add_argument("--lite", action="store_true",
                    help="con --todas, limita al universo lite (~500, lo que usa la app)")
    args = ap.parse_args()

    try:
        import fundamentals as _f
    except Exception as e:
        print(f"ERROR importando fundamentals: {e}")
        return 1

    tickers = _tickers(solo_mx=not args.todas, lite_only=args.lite)
    if not tickers:
        print("No se encontraron tickers en el universo.")
        return 0

    alcance = ("todo el universo" + (" lite" if args.lite else "")) if args.todas else "emisoras .MX"
    print(f"Pre-cargando {len(tickers)} tickers ({alcance}, pausa {args.pausa}s)…")
    reporte = {"completo": [], "parcial": [], "sin_datos": []}
    t0 = time.time()

    for i, tk in enumerate(tickers, 1):
        try:
            fund = _f._fundamentals_ticker(tk, con_estados=True)
            cat = _clasificar(fund)
        except Exception as e:
            cat = "sin_datos"
            print(f"  [{i}/{len(tickers)}] {tk}: EXCEPCIÓN {e}")
        reporte[cat].append(tk)
        print(f"  [{i}/{len(tickers)}] {tk}: {cat}")
        time.sleep(max(0.0, args.pausa))

    resumen = {
        "generado_en": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total": len(tickers),
        "completo": len(reporte["completo"]),
        "parcial": len(reporte["parcial"]),
        "sin_datos": len(reporte["sin_datos"]),
        "huecos_parcial": reporte["parcial"],
        "huecos_sin_datos": reporte["sin_datos"],
    }
    try:
        REPORTE.write_text(json.dumps(resumen, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"  warn escribiendo reporte: {e}")

    dur = time.time() - t0
    print("\n===== RESUMEN =====")
    print(f"  Total .MX:   {resumen['total']}")
    print(f"  Completo:    {resumen['completo']}")
    print(f"  Parcial:     {resumen['parcial']}  {reporte['parcial']}")
    print(f"  Sin datos:   {resumen['sin_datos']}  {reporte['sin_datos']}")
    print(f"  Reporte:     {REPORTE}")
    print(f"  Duración:    {dur:.0f}s")
    print("Los huecos (parcial/sin_datos) son las emisoras candidatas a una fuente oficial (CNBV/XBRL).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
