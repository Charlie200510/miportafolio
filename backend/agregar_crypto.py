"""
Parche ligero: agrega las criptomonedas de descargar_universo.CRYPTO_TICKERS
al universo existente (universo_precios.csv + universo_info.json) sin
re-descargar todo el S&P 500 e IPC.

Útil cuando ya tienes el universo bajado y solo quieres sumar cripto.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

from descargar_universo import (
    CRYPTO_TICKERS,
    RECOMENDADAS,
    DIAS_HISTORIA,
    _info_de,
)

BACKEND_DIR = Path(__file__).parent
CSV = BACKEND_DIR / "universo_precios.csv"
INFO = BACKEND_DIR / "universo_info.json"


def _descargar_crypto() -> pd.DataFrame:
    fin = date.today()
    inicio = fin - timedelta(days=DIAS_HISTORIA)
    print(f"Descargando {len(CRYPTO_TICKERS)} cripto ({inicio} → {fin})…")
    data = yf.download(
        CRYPTO_TICKERS,
        start=inicio.isoformat(),
        end=fin.isoformat(),
        progress=False,
        auto_adjust=True,
        group_by="ticker",
        threads=True,
    )
    # En yfinance el formato cambia según la cantidad de tickers
    if isinstance(data.columns, pd.MultiIndex):
        closes = {}
        for t in CRYPTO_TICKERS:
            if t in data.columns.get_level_values(0):
                sub = data[t]
                col = "Close" if "Close" in sub.columns else "Adj Close"
                closes[t] = sub[col]
        precios = pd.DataFrame(closes)
    else:
        # Solo un ticker: formato plano
        precios = data[["Close"]].rename(columns={"Close": CRYPTO_TICKERS[0]})
    precios.index = pd.to_datetime(precios.index)
    # Sólo días de historia en común (la última fila suele estar incompleta).
    precios = precios.dropna(how="all")
    return precios


def _merge_precios(existentes: pd.DataFrame, cripto: pd.DataFrame) -> pd.DataFrame:
    # Indices al mismo tipo (datetime) y sin tz.
    existentes.index = pd.to_datetime(existentes.index)
    if existentes.index.tz is not None:
        existentes.index = existentes.index.tz_localize(None)
    if cripto.index.tz is not None:
        cripto.index = cripto.index.tz_localize(None)

    # Las cripto tienen días extra (trading 24/7). Alineamos al índice
    # de acciones para que Markowitz no se confunda.
    cripto_alineado = cripto.reindex(existentes.index, method="pad")

    # Drop columnas cripto que ya estaban (para evitar duplicar).
    for t in CRYPTO_TICKERS:
        if t in existentes.columns:
            existentes = existentes.drop(columns=[t])

    return pd.concat([existentes, cripto_alineado], axis=1)


def main():
    if not CSV.exists() or not INFO.exists():
        print("× No existe el universo todavía. Corre primero descargar_universo.py")
        return

    precios = pd.read_csv(CSV, index_col=0, parse_dates=True)
    info = json.loads(INFO.read_text(encoding="utf-8"))

    cripto_precios = _descargar_crypto()
    if cripto_precios.empty:
        print("× No se pudo descargar ninguna cripto.")
        return
    print(f"  OK: {len(cripto_precios.columns)} cripto, {len(cripto_precios)} días")

    precios = _merge_precios(precios, cripto_precios)

    # Metadata — usamos el helper de descargar_universo.
    for t in CRYPTO_TICKERS:
        _, meta = _info_de(t)
        if t in cripto_precios.columns:
            serie = cripto_precios[t].dropna()
            meta["precio_actual"] = round(float(serie.iloc[-1]), 2) if len(serie) else None
        else:
            meta["precio_actual"] = None
        meta["recomendada"] = t in RECOMENDADAS
        info[t] = meta

    precios.to_csv(CSV)
    with open(INFO, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)

    print(f"\nListo. Universo actualizado:")
    print(f"  {CSV}  ({len(precios.columns)} tickers)")
    print(f"  {INFO} ({len(info)} entradas)")


if __name__ == "__main__":
    main()
