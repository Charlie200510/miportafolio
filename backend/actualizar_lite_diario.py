"""
actualizar_lite_diario.py — Refresco DIARIO y ligero del universo lite.

A diferencia de descargar_universo.py (8934 tickers, 30-45 min), esto solo baja
los ~500 tickers que YA están en universo_lite_precios.csv, y solo el último mes
de precios, para actualizar los cierres recientes sin rehacer toda la historia.

Pensado para correr cada día hábil después del cierre. Mantiene la ventana de
5 años (recorta lo más viejo) y actualiza `precio_actual` en universo_lite_info.json.

Seguro por diseño: si la descarga falla o viene vacía, NO sobreescribe nada.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

BACKEND = Path(__file__).parent
LITE_CSV = BACKEND / "universo_lite_precios.csv"
LITE_JSON = BACKEND / "universo_lite_info.json"
ANIOS = 5


def fusionar(df_viejo: pd.DataFrame, df_nuevo: pd.DataFrame, anios: int = ANIOS) -> pd.DataFrame:
    """Combina el histórico con los precios recientes, recorta a `anios` años.

    - Conserva toda la historia previa.
    - Sobreescribe / agrega las filas recientes con los datos nuevos.
    - Recorta a los últimos `anios` años.
    - Conserva exactamente las columnas (tickers) del histórico, en su orden.
    """
    cols = list(df_viejo.columns)
    df_nuevo = df_nuevo.reindex(columns=cols)
    combinado = df_viejo.combine_first(df_nuevo)   # une índices, conserva lo viejo
    combinado.update(df_nuevo)                     # refresca donde hay dato nuevo
    combinado = combinado.sort_index()
    corte = combinado.index.max() - pd.DateOffset(years=anios)
    combinado = combinado.loc[combinado.index >= corte]
    return combinado[cols]


def main():
    if not LITE_CSV.exists():
        print("ERROR: no existe universo_lite_precios.csv"); sys.exit(1)

    df = pd.read_csv(LITE_CSV, index_col=0, parse_dates=True).sort_index()
    tickers = list(df.columns)
    print(f"Universo lite: {len(tickers)} tickers, hasta {df.index[-1].date()}")

    import yfinance as yf
    bajado = yf.download(tickers, period="1mo", interval="1d",
                         auto_adjust=True, progress=False, threads=True)
    nuevos = bajado["Close"] if "Close" in getattr(bajado, "columns", []) else bajado
    if isinstance(nuevos, pd.Series):
        nuevos = nuevos.to_frame()
    nuevos = nuevos.dropna(how="all")

    # Guarda de seguridad: si Yahoo no devolvió nada útil, no tocar el archivo.
    cobertura = nuevos.iloc[-1].notna().mean() if len(nuevos) else 0
    if len(nuevos) == 0 or cobertura < 0.5:
        print(f"ABORTA: descarga vacía o pobre (cobertura {cobertura:.0%}). No sobreescribo.")
        sys.exit(2)

    combinado = fusionar(df, nuevos)
    combinado.to_csv(LITE_CSV)

    # Actualizar precio_actual en el info
    try:
        info = json.loads(LITE_JSON.read_text(encoding="utf-8"))
        ult = combinado.ffill().iloc[-1]
        actualizados = 0
        for t in tickers:
            v = ult.get(t)
            if t in info and pd.notna(v):
                info[t]["precio_actual"] = round(float(v), 2)
                actualizados += 1
        LITE_JSON.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"precio_actual actualizado en {actualizados} tickers")
    except Exception as e:
        print(f"aviso: no pude actualizar el info json: {e}")

    print(f"OK: {combinado.shape[1]} tickers, {len(combinado)} días, hasta {combinado.index[-1].date()}")


if __name__ == "__main__":
    main()
