"""
backtest.py — Re-corre un portafolio actual sobre periodos históricos.

Dado un set de tickers + pesos, simula cómo le hubiera ido al portafolio
en una ventana específica (COVID-2020, 2008, 2022, full history, etc.).

Devuelve:
  - Serie temporal del valor acumulado (base 100)
  - Métricas: retorno total, retorno anualizado, vol, Sharpe, max drawdown
  - Comparación contra benchmarks (S&P 500 = SPY, IPC = NAFTRAC.MX)
  - Drawdowns mayores y fechas
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
_UNIV_CSV  = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE

DIAS_HABILES = 252
TASA_LIBRE_RIESGO = 0.095

# Periodos predefinidos (presets) — fechas inclusivas
PERIODOS_PRESET = {
    "covid_crash":   {"nombre": "COVID Crash", "inicio": "2020-02-15", "fin": "2020-04-30",
                      "descripcion": "El crash más rápido de la historia. -34% del S&P en 33 días."},
    "covid_full":    {"nombre": "COVID + Recovery", "inicio": "2020-01-01", "fin": "2020-12-31",
                      "descripcion": "Año completo: del shock al rally. Stress + recuperación en V."},
    "rate_hike_2022": {"nombre": "Subida de tasas 2022", "inicio": "2022-01-01", "fin": "2022-12-31",
                      "descripcion": "Volcker 2.0: la Fed sube tasas y el S&P cae 19%."},
    "ano_2023":      {"nombre": "AI Rally 2023", "inicio": "2023-01-01", "fin": "2023-12-31",
                      "descripcion": "El año del despegue de NVDA y Magnificent 7."},
    "ano_2024":      {"nombre": "2024", "inicio": "2024-01-01", "fin": "2024-12-31",
                      "descripcion": "Año electoral USA. Recortes Fed, IPC mexicano lateral."},
    "ano_2025":      {"nombre": "2025", "inicio": "2025-01-01", "fin": "2025-12-31",
                      "descripcion": "Año más reciente completo."},
    "ultimo_ano":    {"nombre": "Últimos 12 meses", "inicio": None, "fin": None,
                      "descripcion": "Los últimos 252 días hábiles disponibles."},
    "completo":      {"nombre": "Historia completa", "inicio": None, "fin": None,
                      "descripcion": "Toda la historia disponible en el universo (~2 años)."},
}


def _cargar_precios() -> Optional[pd.DataFrame]:
    if not _UNIV_CSV.exists():
        return None
    try:
        df = pd.read_csv(_UNIV_CSV, index_col=0, parse_dates=True)
        return df.sort_index()
    except Exception:
        return None


def _max_drawdown(serie: pd.Series) -> tuple[float, pd.Timestamp, pd.Timestamp]:
    """Retorna (dd_pct_negativo, fecha_pico, fecha_valle)."""
    cum = serie / serie.iloc[0]
    peak = cum.cummax()
    dd = (cum - peak) / peak
    if dd.empty:
        return 0.0, serie.index[0], serie.index[-1]
    valle_idx = dd.idxmin()
    pico_idx = cum.loc[:valle_idx].idxmax()
    return float(dd.min()), pico_idx, valle_idx


def _drawdowns_top(serie: pd.Series, n: int = 3) -> list[dict]:
    """Encuentra los N drawdowns más grandes (no solapados)."""
    serie = serie.dropna()
    if len(serie) < 10:
        return []
    cum = serie / serie.iloc[0]
    peak = cum.cummax()
    dd = (cum - peak) / peak
    out = []
    used = set()
    for _ in range(n):
        if dd.empty:
            break
        # Encuentra valle global excluyendo zonas usadas
        candidatos = dd[~dd.index.isin(used)]
        if candidatos.empty or candidatos.min() > -0.005:
            break
        valle = candidatos.idxmin()
        # Pico anterior
        pico = cum.loc[:valle].idxmax()
        # Recovery (cuando el cum vuelve al pico)
        post_valle = cum.loc[valle:]
        target = cum.loc[pico]
        recovery_mask = post_valle >= target
        recovery = recovery_mask.idxmax() if recovery_mask.any() else None

        out.append({
            "magnitud_pct": round(float(dd[valle]) * 100, 2),
            "fecha_pico":   str(pico.date()),
            "fecha_valle":  str(valle.date()),
            "fecha_recovery": str(recovery.date()) if recovery is not None else None,
            "dias_caida":   (valle - pico).days,
            "dias_recovery": (recovery - valle).days if recovery is not None else None,
        })
        # Marcar la ventana como usada
        rango = pd.date_range(pico, recovery if recovery is not None else valle + pd.Timedelta(days=30))
        used.update(rango)
    return out


def _metricas(valor: pd.Series) -> dict:
    """Calcula métricas estándar de una serie de valor."""
    valor = valor.dropna()
    if len(valor) < 20:
        return {}
    rend = valor.pct_change().dropna()
    n = len(rend)
    ret_total = float(valor.iloc[-1] / valor.iloc[0] - 1)
    años = n / DIAS_HABILES
    ret_anual = (1 + ret_total) ** (1 / max(años, 1/DIAS_HABILES)) - 1 if años > 0 else 0
    vol_anual = float(rend.std() * np.sqrt(DIAS_HABILES))
    sharpe = (ret_anual - TASA_LIBRE_RIESGO) / vol_anual if vol_anual > 0 else 0.0
    max_dd, _, _ = _max_drawdown(valor)
    return {
        "retorno_total_pct":     round(ret_total * 100, 2),
        "retorno_anual_pct":     round(ret_anual * 100, 2),
        "volatilidad_anual_pct": round(vol_anual * 100, 2),
        "sharpe_ratio":          round(float(sharpe), 3),
        "max_drawdown_pct":      round(max_dd * 100, 2),
        "dias":                  n,
    }


def correr_backtest(tickers: list[str], pesos: dict[str, float],
                     periodo: str = "completo",
                     inicio: Optional[str] = None,
                     fin: Optional[str] = None) -> dict:
    """
    Args:
      tickers: lista de tickers en el portafolio
      pesos: dict {ticker: peso} (en pp 0-100 o fracción 0-1; se normaliza)
      periodo: clave de PERIODOS_PRESET o "custom"
      inicio, fin: si periodo='custom', fechas YYYY-MM-DD
    """
    if not tickers:
        raise ValueError("Necesitas al menos un ticker.")
    precios = _cargar_precios()
    if precios is None:
        raise ValueError("No hay universo de precios. Corre descargar_universo.py primero.")

    # Normalizar pesos a fracción 0-1
    suma = sum(pesos.get(t, 0) for t in tickers)
    if suma <= 0:
        # Equal weight si no hay pesos válidos
        peso_each = 1.0 / len(tickers)
        pesos_norm = {t: peso_each for t in tickers}
    else:
        pesos_norm = {t: pesos.get(t, 0) / suma for t in tickers}

    # Resolver periodo
    if periodo == "custom":
        if not inicio or not fin:
            raise ValueError("Para periodo='custom' se requiere inicio y fin.")
        fecha_ini = pd.Timestamp(inicio)
        fecha_fin = pd.Timestamp(fin)
    elif periodo in PERIODOS_PRESET:
        cfg = PERIODOS_PRESET[periodo]
        if cfg["inicio"]:
            fecha_ini = pd.Timestamp(cfg["inicio"])
        elif periodo == "ultimo_ano":
            fecha_ini = precios.index[-DIAS_HABILES] if len(precios) > DIAS_HABILES else precios.index[0]
        else:
            fecha_ini = precios.index[0]
        if cfg["fin"]:
            fecha_fin = pd.Timestamp(cfg["fin"])
        else:
            fecha_fin = precios.index[-1]
    else:
        raise ValueError(f"Periodo desconocido: {periodo}")

    # Filtrar tickers que existen en el CSV
    disponibles = [t for t in tickers if t in precios.columns]
    if not disponibles:
        raise ValueError("Ningún ticker del portafolio existe en el universo descargado.")
    if len(disponibles) < len(tickers):
        faltantes = [t for t in tickers if t not in disponibles]
    else:
        faltantes = []

    # Re-normalizar pesos solo entre los disponibles
    suma_d = sum(pesos_norm.get(t, 0) for t in disponibles)
    if suma_d <= 0:
        pesos_norm = {t: 1.0 / len(disponibles) for t in disponibles}
    else:
        pesos_norm = {t: pesos_norm.get(t, 0) / suma_d for t in disponibles}

    # Sub-frame del periodo
    sub = precios.loc[
        (precios.index >= fecha_ini) & (precios.index <= fecha_fin),
        disponibles
    ].copy()
    sub = sub.dropna(how="all")
    if len(sub) < 10:
        raise ValueError(
            f"No hay suficientes datos en ese periodo ({len(sub)} días). "
            "Prueba con un rango más amplio o que tu portafolio tenga tickers con más historia."
        )
    sub = sub.ffill().dropna()

    # Calcular valor del portafolio: rebalanceo virtual al inicio,
    # luego deja correr (peso varía con precio)
    inicial = sub.iloc[0]
    unidades = pd.Series({t: pesos_norm.get(t, 0) / inicial[t] if inicial[t] > 0 else 0
                          for t in disponibles})
    valor_diario = (sub * unidades).sum(axis=1)
    valor_diario = valor_diario / valor_diario.iloc[0] * 100  # base 100

    # Benchmarks
    benchmarks_data = {}
    for bm_t, bm_label in [("SPY", "S&P 500"), ("NAFTRAC.MX", "IPC México")]:
        if bm_t in precios.columns:
            bm_serie = precios.loc[
                (precios.index >= sub.index[0]) & (precios.index <= sub.index[-1]),
                bm_t
            ].ffill().dropna()
            if len(bm_serie) >= 10:
                bm_norm = bm_serie / bm_serie.iloc[0] * 100
                benchmarks_data[bm_label] = bm_norm

    # Construir series para JSON (down-sample si >300 puntos)
    def serializar(s: pd.Series) -> list[dict]:
        if len(s) > 300:
            paso = max(1, len(s) // 300)
            s = s.iloc[::paso]
        return [{"fecha": d.strftime("%Y-%m-%d"), "valor": round(float(v), 2)}
                for d, v in s.items()]

    metricas_port = _metricas(valor_diario)
    metricas_bm = {label: _metricas(s) for label, s in benchmarks_data.items()}
    drawdowns = _drawdowns_top(valor_diario, n=3)

    return {
        "ok": True,
        "periodo": {
            "id":          periodo,
            "nombre":      PERIODOS_PRESET.get(periodo, {}).get("nombre", "Custom"),
            "descripcion": PERIODOS_PRESET.get(periodo, {}).get("descripcion", ""),
            "inicio":      sub.index[0].strftime("%Y-%m-%d"),
            "fin":         sub.index[-1].strftime("%Y-%m-%d"),
            "dias":        len(sub),
        },
        "tickers_usados":  disponibles,
        "tickers_faltantes": faltantes,
        "pesos_normalizados": {t: round(pesos_norm[t], 4) for t in disponibles},
        "serie_valor":     serializar(valor_diario),
        "serie_benchmarks": {label: serializar(s) for label, s in benchmarks_data.items()},
        "metricas":        metricas_port,
        "metricas_benchmarks": metricas_bm,
        "drawdowns_top":   drawdowns,
        "presets":         {k: {"nombre": v["nombre"], "descripcion": v["descripcion"]}
                            for k, v in PERIODOS_PRESET.items()},
    }


def listar_periodos() -> dict:
    return PERIODOS_PRESET


if __name__ == "__main__":
    import json
    res = correr_backtest(
        tickers=["AAPL", "MSFT", "NVDA"],
        pesos={"AAPL": 0.4, "MSFT": 0.3, "NVDA": 0.3},
        periodo="covid_full",
    )
    print(json.dumps(res, indent=2, default=str)[:2000])
