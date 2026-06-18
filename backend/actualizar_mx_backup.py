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


def _tickers_mx() -> list[str]:
    """Junta las emisoras .MX del universo completo y del lite (dedupe)."""
    tickers: set[str] = set()
    for nombre in ("universo_info.json", "universo_lite_info.json"):
        p = BACKEND / nombre
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                for k in d:
                    if str(k).upper().endswith(".MX"):
                        tickers.add(str(k).upper())
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
    ap.add_argument("--pausa", type=float, default=1.5, help="segundos entre cada emisora")
    args = ap.parse_args()

    try:
        import fundamentals as _f
    except Exception as e:
        print(f"ERROR importando fundamentals: {e}")
        return 1

    tickers = _tickers_mx()
    if not tickers:
        print("No se encontraron emisoras .MX en el universo.")
        return 0

    print(f"Pre-cargando {len(tickers)} emisoras .MX (pausa {args.pausa}s)…")
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
