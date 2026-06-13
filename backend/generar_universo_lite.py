"""
generar_universo_lite.py — Crea versión reducida del universo (~1000 tickers)
para poder commitearla a git sin exceder los 100MB que permite GitHub.

Lee universo_precios.csv (130MB+) y universo_info.json y genera:
  - universo_lite_precios.csv (~10-15MB)
  - universo_lite_info.json (~500KB)

Estrategia de selección (~1000 tickers):
  - Todas las "recomendadas" del universo (S&P top 30 + IPC top 18 + ETFs + cripto top 10)
  - Todos los IPC mexicanos
  - Todos los crypto disponibles
  - Top N del S&P 500 por liquidez (usando precio_actual * volumen aprox)
  - Una muestra balanceada de internacional

Para producción (Render) este es el archivo que se usa.
Para dev local, si existe universo_precios.csv (el completo) se usa ese.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


BACKEND_DIR = Path(__file__).parent
FULL_CSV  = BACKEND_DIR / "universo_precios.csv"
FULL_JSON = BACKEND_DIR / "universo_info.json"
LITE_CSV  = BACKEND_DIR / "universo_lite_precios.csv"
LITE_JSON = BACKEND_DIR / "universo_lite_info.json"

TARGET_TOTAL = 1000


def main():
    if not FULL_CSV.exists():
        raise FileNotFoundError(f"No existe {FULL_CSV}. Corre descargar_universo.py primero.")

    print(f"Leyendo {FULL_CSV.name}...")
    precios = pd.read_csv(FULL_CSV, index_col=0, parse_dates=True)
    info = json.loads(FULL_JSON.read_text(encoding="utf-8"))
    print(f"  Universo completo: {len(precios.columns)} tickers, {len(precios)} días")

    # Conjunto a mantener
    mantener = set()

    # 1. Todas las recomendadas
    recos = [t for t, m in info.items() if m.get("recomendada")]
    mantener.update(recos)
    print(f"  + {len(recos)} recomendadas")

    # 2. Todo lo mexicano (.MX) — el público mexicano es prioritario
    mx = [t for t in precios.columns if t.endswith(".MX")]
    mantener.update(mx)
    print(f"  + {len(mx)} mexicanas (.MX)")

    # 3. Toda la cripto
    crypto = [t for t in precios.columns if t.endswith("-USD")]
    mantener.update(crypto)
    print(f"  + {len(crypto)} cripto")

    # 4. ETFs líderes (todos los que tienen sector ETF / Índice)
    etfs = [t for t, m in info.items() if "ETF" in (m.get("sector") or "")]
    mantener.update(etfs)
    print(f"  + {len(etfs)} ETFs (acumulado: {len(mantener)})")

    # 5. Top USA acciones por precio (proxy de market cap; mejor que random)
    cuanto_falta = TARGET_TOTAL - len(mantener)
    if cuanto_falta > 0:
        us_tickers = [t for t in precios.columns
                      if t not in mantener
                      and not t.endswith((".MX", "-USD"))
                      and "." not in t]  # excluir internacionales
        # Ordenar por precio_actual (proxy de calidad/blue chip)
        us_con_precio = sorted(
            us_tickers,
            key=lambda t: info.get(t, {}).get("precio_actual", 0) or 0,
            reverse=True,
        )
        top_us = us_con_precio[:cuanto_falta]
        mantener.update(top_us)
        print(f"  + {len(top_us)} top USA acciones por precio")

    final = sorted(mantener & set(precios.columns))
    print(f"\nTickers finales: {len(final)}")

    # Generar archivos reducidos
    precios_lite = precios[final]
    info_lite = {t: info[t] for t in final if t in info}

    precios_lite.to_csv(LITE_CSV)
    with open(LITE_JSON, "w", encoding="utf-8") as f:
        json.dump(info_lite, f, indent=2, ensure_ascii=False)

    csv_mb = LITE_CSV.stat().st_size / 1024 / 1024
    json_kb = LITE_JSON.stat().st_size / 1024
    print(f"\nGenerados:")
    print(f"  {LITE_CSV.name}: {csv_mb:.1f} MB")
    print(f"  {LITE_JSON.name}: {json_kb:.1f} KB")
    print(f"\nEstos son los que se commitearán a git (la versión completa sigue gitignored).")


if __name__ == "__main__":
    main()
