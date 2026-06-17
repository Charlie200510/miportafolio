"""
generar_universo_lite.py — Crea versión reducida del universo para commitear a git.

Lee el universo (universo_precios.csv completo si existe; si no, el lite previo) y
genera:
  - universo_lite_precios.csv  (500 tickers × 5 años diarios → ~15MB)
  - universo_lite_info.json

Estrategia de selección (TARGET_TOTAL = 500):
  NÚCLEO (siempre se mantiene, mientras quepa):
    - Benchmarks SPY + NAFTRAC.MX (imprescindibles para métricas canónicas)
    - Todo lo mexicano (.MX)            → público mexicano es prioritario
    - Toda la cripto (-USD)
    - Todas las "recomendadas"
    - ETFs líderes (sector "ETF / Índice")
  RELLENO (hasta llegar a 500):
    - Primero: tickers MÁS USADOS por los usuarios, si existe ticker_usage.json
      (ranking que produce el endpoint /api/admin/ticker-usage). Así el universo
      se va sesgando hacia lo que la gente realmente consulta.
    - Luego: top USA por precio_actual (proxy de blue-chip) para completar.

Ventana temporal: últimos ANIOS años (5). Las métricas canónicas usan 5 años de
retornos mensuales, así que recortar a 5 años no pierde nada y reduce el archivo
~a la mitad (carga más rápida en el free tier de Render — 512MB RAM).
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

BACKEND_DIR = Path(__file__).parent
FULL_CSV   = BACKEND_DIR / "universo_precios.csv"
FULL_JSON  = BACKEND_DIR / "universo_info.json"
LITE_CSV   = BACKEND_DIR / "universo_lite_precios.csv"
LITE_JSON  = BACKEND_DIR / "universo_lite_info.json"
USAGE_JSON = BACKEND_DIR / "ticker_usage.json"   # opcional: ranking por uso real

TARGET_TOTAL = 500
ANIOS = 5
BENCHMARKS = ("SPY", "NAFTRAC.MX")
# Mega-caps / tickers populares que SIEMPRE deben estar en el lite, para que el
# análisis rápido y local cubra lo que la gente más busca (p.ej. AAPL).
MUST_INCLUDE = (
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "AVGO",
    "JPM", "V", "MA", "WMT", "COST", "NFLX", "DIS", "KO", "PEP", "MCD", "NKE",
    "BAC", "XOM", "CVX", "JNJ", "PG", "HD", "UNH", "ADBE", "CRM", "AMD", "QCOM",
    "ORCL", "CSCO", "IBM", "INTC", "PYPL", "SBUX", "BA", "T", "VZ", "PFE",
    "MRK", "ABBV", "LLY", "QQQ", "VOO", "BTC-USD", "ETH-USD",
)


def _cargar_usage() -> list[str]:
    """Lista de tickers ordenada por uso (más usado primero). Vacía si no existe."""
    if not USAGE_JSON.exists():
        return []
    try:
        data = json.loads(USAGE_JSON.read_text(encoding="utf-8"))
        # Acepta {"ticker": count, ...} o ["T1","T2",...] o [["T",count],...]
        if isinstance(data, dict):
            return [t for t, _ in sorted(data.items(), key=lambda kv: kv[1], reverse=True)]
        if isinstance(data, list):
            if data and isinstance(data[0], (list, tuple)):
                return [t for t, _ in sorted(data, key=lambda x: x[1], reverse=True)]
            return list(data)
    except Exception:
        pass
    return []


def seleccionar_tickers(cols: list[str], info: dict, usage: list[str]) -> list[str]:
    """Devuelve hasta TARGET_TOTAL tickers según la estrategia documentada arriba."""
    colset = set(cols)

    def en_universo(ts):
        return [t for t in ts if t in colset]

    # ── Núcleo (orden = prioridad para recortar si algún día excede 500) ──
    mantener: list[str] = []
    vistos: set[str] = set()

    def add(ts):
        for t in ts:
            if t in colset and t not in vistos:
                vistos.add(t)
                mantener.append(t)

    add([b for b in BENCHMARKS])                                       # benchmarks
    add(en_universo(list(MUST_INCLUDE)))                               # mega-caps populares
    add(en_universo([t for t in cols if t.endswith(".MX")]))           # mexicanas
    add([t for t, m in info.items() if m.get("recomendada")])          # recomendadas
    add([t for t, m in info.items() if "ETF" in (m.get("sector") or "")])  # ETFs
    add(en_universo([t for t in cols if t.endswith("-USD")]))          # cripto

    # Si el núcleo ya excede el target, recortamos respetando la prioridad de orden.
    if len(mantener) >= TARGET_TOTAL:
        return sorted(mantener[:TARGET_TOTAL])

    # ── Relleno hasta TARGET_TOTAL ──
    # 1) Por uso real (usuarios). 2) Top USA por precio_actual (proxy blue-chip).
    add([t for t in usage if not t.endswith(("-USD",))])               # usados (no recripto, ya entró)

    if len(mantener) < TARGET_TOTAL:
        us = [t for t in cols
              if t not in vistos
              and not t.endswith((".MX", "-USD"))
              and "." not in t]
        us.sort(key=lambda t: info.get(t, {}).get("precio_actual", 0) or 0, reverse=True)
        add(us[: TARGET_TOTAL - len(mantener)])

    return sorted(mantener[:TARGET_TOTAL])


def generar(source_csv: Path, source_json: Path):
    print(f"Leyendo {source_csv.name}...")
    info = json.loads(source_json.read_text(encoding="utf-8"))
    cols = list(pd.read_csv(source_csv, index_col=0, nrows=0).columns)
    print(f"  Universo fuente: {len(cols)} tickers")

    usage = _cargar_usage()
    if usage:
        print(f"  Ranking de uso disponible: {len(usage)} tickers (sesga el relleno)")

    final = seleccionar_tickers(cols, info, usage)
    print(f"  Seleccionados: {len(final)} tickers (target {TARGET_TOTAL})")

    # Leer SOLO las columnas seleccionadas + la de fechas (mucho menos memoria
    # que cargar el full de 8934 columnas).
    idx_name = cols_index_name(source_csv)
    keep = set(final) | {idx_name}
    precios = pd.read_csv(source_csv, index_col=0, parse_dates=True,
                          usecols=lambda c: c in keep)
    precios = precios.sort_index()

    # Recorte a últimos ANIOS años
    if len(precios):
        corte = precios.index.max() - pd.DateOffset(years=ANIOS)
        precios = precios.loc[precios.index >= corte]
    print(f"  Ventana: {precios.index.min().date()} → {precios.index.max().date()} ({len(precios)} días)")

    info_lite = {t: info[t] for t in final if t in info}

    precios.to_csv(LITE_CSV)
    with open(LITE_JSON, "w", encoding="utf-8") as f:
        json.dump(info_lite, f, indent=2, ensure_ascii=False)

    mb = LITE_CSV.stat().st_size / 1024 / 1024
    kb = LITE_JSON.stat().st_size / 1024
    print(f"\nGenerados:\n  {LITE_CSV.name}: {mb:.1f} MB\n  {LITE_JSON.name}: {kb:.1f} KB")


def cols_index_name(csv_path: Path) -> str:
    """Nombre de la primera columna (índice de fechas) del CSV."""
    head = pd.read_csv(csv_path, nrows=0)
    return head.columns[0] if len(head.columns) else "Date"


def main():
    # Fuente: el universo completo si existe (dev / tarea semanal), si no el lite previo.
    if FULL_CSV.exists():
        generar(FULL_CSV, FULL_JSON)
    elif LITE_CSV.exists():
        print("(universo_precios.csv no existe; regenero desde el lite previo)")
        generar(LITE_CSV, LITE_JSON)
    else:
        raise FileNotFoundError("No hay universo_precios.csv ni universo_lite_precios.csv.")


if __name__ == "__main__":
    main()
