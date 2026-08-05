"""
top_movers.py — Top tickers del universo por ganadores, perdedores y movimiento.

Lee el universo local (~500-9000 tickers) y calcula:
  - Top N que más subieron en el período (día / semana / mes / año)
  - Top N que más cayeron
  - Top N con mayor movimiento absoluto dentro del universo recomendado

Usa el CSV de precios local — sin yfinance, para que sea rápido.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


_BACKEND_DIR = Path(__file__).parent
_UNIV_FULL = _BACKEND_DIR / "universo_precios.csv"
_UNIV_LITE = _BACKEND_DIR / "universo_lite_precios.csv"
# El info "grande" va emparejado con cada CSV; info_activos.json es el último
# recurso (en la práctica trae solo 3 tickers, por eso el nombre salía
# duplicado con el ticker y el sector siempre en null).
_INFO_FULL = _BACKEND_DIR / "universo_info.json"
_INFO_LITE = _BACKEND_DIR / "universo_lite_info.json"
_INFO_PATH = _BACKEND_DIR / "info_activos.json"

# Cache en memoria + disco (sobrevive reinicios de Render)
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 30 * 60   # 30 min (los movers cambian poco a poco)
_CACHE_DIR = _BACKEND_DIR / "_cache_topmovers"
_CACHE_DIR.mkdir(exist_ok=True)

# Piso de precio: por debajo de $1 un tick de un centavo ya mueve el 5-10%, así
# que el ranking se llenaba de penny stocks (448 tickers del universo cotizan
# bajo $1) y tapaba cualquier movimiento con significado de mercado.
_PRECIO_MIN = 1.00

# Ventana máxima para el "cambio del día". El código anterior retrocedía SIN
# límite buscando un cierre distinto, así que un ticker con la serie congelada
# (p. ej. SDM, ocho sesiones en 1.85) reportaba como movimiento de hoy un salto
# de hace meses. Si en esta ventana no hubo cambio, el ticker simplemente no
# tiene movimiento diario que reportar.
_MAX_SESIONES_DIA = 5

# El CSV guarda precios SIN ajustar por splits, así que un reverse split se ve
# como un salto instantáneo (INHD pasó de 1.05 a 39.49 de una sesión a otra y
# encabezaba el ranking con un +2,891% que nunca existió). Ningún valor real
# multiplica por 4 su precio en una sola sesión: si pasa, es corporativo o dato
# sucio, y el ticker queda fuera del período afectado.
_SALTO_MAX_SESION = 4.0


def _cargar_precios() -> Optional[pd.DataFrame]:
    """Carga el universo local de precios. Devuelve (df, es_full)."""
    csv = _UNIV_FULL if _UNIV_FULL.exists() else _UNIV_LITE
    if not csv.exists():
        return None
    try:
        df = pd.read_csv(csv, index_col=0, parse_dates=True)
        return df.sort_index()
    except Exception:
        return None


def _cargar_info() -> Dict[str, Any]:
    """Metadatos del universo, emparejados con el CSV que se cargó.

    Se prueba primero el info del universo correspondiente (que sí trae nombre,
    sector, moneda y la marca `recomendada` de los ~500/9000 tickers) y solo al
    final info_activos.json.
    """
    candidatos = [_INFO_FULL, _INFO_LITE] if _UNIV_FULL.exists() else [_INFO_LITE, _INFO_FULL]
    candidatos.append(_INFO_PATH)
    for ruta in candidatos:
        if not ruta.exists():
            continue
        try:
            with open(ruta, encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict) and d:
                return d
        except Exception:
            continue
    return {}


def _finito(x: Any) -> Optional[float]:
    """Devuelve el número solo si es finito; si no, None.

    Es la guarda que faltaba: un precio base de 0 hacía que el retorno saliera
    `inf`, y `json.dumps` de Python emite `Infinity` a pelo — que NO es JSON
    válido. `JSON.parse` del navegador lo rechazaba, el fetch del frontend
    lanzaba y el panel entero terminaba en "Respuesta vacía del servidor".
    """
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _calcular_retornos(df: pd.DataFrame, dias: int) -> pd.Series:
    """Retorno desde hace N días al hoy, por ticker.

    Un precio solo es válido si es finito y ESTRICTAMENTE positivo: con base 0
    la división da ±inf y con base negativa el retorno pierde sentido (salían
    cosas como -113%, imposible en una posición larga porque un precio no baja
    de cero). Se descarta ese ruido en vez de propagarlo al JSON.
    """
    if df is None or df.empty:
        return pd.Series(dtype=float)

    ultimo = pd.to_numeric(df.iloc[-1], errors="coerce")

    if dias <= 1:
        # Cambio del DÍA: comparar contra el último cierre DISTINTO por ticker,
        # saltando fines de semana/feriados con precio arrastrado (evita el 0%
        # falso), pero solo dentro de _MAX_SESIONES_DIA sesiones: más atrás ya
        # no es "hoy" y se estaba colando movimiento de hace meses.
        prev = {}
        for col in df.columns:
            s = pd.to_numeric(df[col], errors="coerce").dropna()
            s = s[s > 0]                     # los ceros no son cotización real
            base = None
            if len(s) >= 2:
                last = float(s.iloc[-1])
                ventana = s.iloc[-(_MAX_SESIONES_DIA + 1):-1].values[::-1]
                for v in ventana:
                    if float(v) != last:
                        base = float(v)
                        break
            prev[col] = base
        primer = pd.Series(prev, dtype=float)
    elif len(df) < dias + 1:
        # Si no hay tanto historial, usa el primer día disponible
        primer = pd.to_numeric(df.iloc[0], errors="coerce")
    else:
        primer = pd.to_numeric(df.iloc[-dias - 1], errors="coerce")

    # Solo tickers con AMBOS extremos finitos y por encima del piso de precio.
    primer = primer.reindex(df.columns)
    ultimo = ultimo.reindex(df.columns)
    validos = (
        primer.notna() & ultimo.notna()
        & np.isfinite(primer) & np.isfinite(ultimo)
        & (primer >= _PRECIO_MIN) & (ultimo >= _PRECIO_MIN)
    )
    primer = primer[validos]
    ultimo = ultimo[validos]

    ret = (ultimo - primer) / primer
    # Cinturón y tirantes: si algo se colara, aquí muere.
    ret = ret.replace([np.inf, -np.inf], np.nan).dropna()
    ret = ret[ret > -1.0]                    # < -100% es imposible

    # Fuera los tickers con un salto de sesión imposible dentro de la ventana
    # (splits y dato sucio en una serie sin ajustar).
    sospechosos = _con_salto_anomalo(df, max(int(dias), 1), ret.index)
    if sospechosos:
        ret = ret.drop(index=[t for t in sospechosos if t in ret.index])

    return ret.sort_values(ascending=False)


def _con_salto_anomalo(df: pd.DataFrame, dias: int, columnas) -> set:
    """Tickers cuyo precio se multiplica/divide por más de _SALTO_MAX_SESION
    entre dos sesiones consecutivas dentro de la ventana analizada."""
    try:
        cols = [c for c in columnas if c in df.columns]
        if not cols:
            return set()
        # +2 filas de holgura para incluir el salto justo en el borde.
        ventana = df[cols].iloc[-(dias + 2):]
        v = ventana.apply(pd.to_numeric, errors="coerce")
        v = v.where(v > 0)
        razon = v / v.shift(1)
        razon = razon.replace([np.inf, -np.inf], np.nan)
        extremo = razon.max(skipna=True)
        minimo = razon.min(skipna=True)
        malos = set(extremo[extremo > _SALTO_MAX_SESION].index)
        malos |= set(minimo[minimo < (1.0 / _SALTO_MAX_SESION)].index)
        return malos
    except Exception:
        return set()


def top_movers(periodo: str = "dia", n: int = 3) -> Dict[str, Any]:
    """Calcula top tickers por período.

    periodo: 'dia' (1d), 'semana' (5d), 'mes' (21d)
    n: cuántos en cada categoría
    """
    cache_key = f"{periodo}_{n}"
    # Cache en memoria
    cached = _CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]
    # Cache en disco (sobrevive reinicios)
    disk_path = _CACHE_DIR / f"{cache_key}.json"
    if disk_path.exists():
        try:
            with open(disk_path, encoding="utf-8") as f:
                d = json.load(f)
            if d and (time.time() - d.get("_ts", 0)) < _CACHE_TTL:
                _CACHE[cache_key] = {"ts": d["_ts"], "data": d["data"]}
                return d["data"]
        except Exception:
            pass

    dias_map = {"dia": 1, "semana": 5, "mes": 21, "anio": 252}
    dias = dias_map.get(periodo, 1)

    df = _cargar_precios()
    if df is None or df.empty:
        return {"ok": False, "error": "No hay datos del universo cargados"}

    info_all = _cargar_info()

    retornos = _calcular_retornos(df, dias)
    if retornos.empty:
        return {"ok": False, "error": "No se pudieron calcular retornos"}

    def _enriquecer(ticker: str, retorno: float) -> Dict[str, Any]:
        info = info_all.get(ticker) or {}
        precio_actual = _finito(df[ticker].iloc[-1]) if ticker in df.columns else None
        ret_pct = _finito(retorno)
        nombre = (info.get("nombre") or "").strip()
        return {
            "ticker":      ticker,
            # Si el nombre coincide con el ticker no aporta nada y el frontend
            # lo pintaba dos veces seguidas ("INHD INHD").
            "nombre":      nombre if nombre and nombre.upper() != ticker.upper() else None,
            "sector":      info.get("sector"),
            "precio":      round(precio_actual, 2) if precio_actual is not None else None,
            "retorno_pct": round(ret_pct * 100, 2) if ret_pct is not None else None,
            "moneda":      info.get("moneda") or "USD",
            "es_mx":       ticker.upper().endswith(".MX"),
            "es_crypto":   ticker.upper().endswith("-USD"),
        }

    # Top N ganadores (más subieron)
    ganadores = [_enriquecer(t, r) for t, r in retornos.head(n).items()]
    # Top N perdedores (más cayeron)
    perdedores = [_enriquecer(t, r) for t, r in retornos.tail(n).iloc[::-1].items()]

    # ── Tercer panel ──────────────────────────────────────────────────────
    # Antes intentaba ser "más transacciones" con volumen × precio, pero NINGÚN
    # archivo de info del universo trae volumen ni capitalización: el valor
    # transado quedaba en 0 para los ~500 tickers y, como el sort de Python es
    # estable, el "ranking" terminaba siendo el orden alfabético de las columnas
    # (1INCH-USD, AAPL, AAVE-USD…) presentado como si fuera volumen.
    #
    # Se sustituye por algo que SÍ se puede calcular con los datos que hay:
    # el mayor movimiento absoluto dentro del universo marcado como
    # `recomendada` (los nombres grandes del S&P 500 y del IPC). Si no hubiera
    # ninguno marcado, se cae a todo el universo.
    recomendados = [t for t in retornos.index
                    if (info_all.get(t) or {}).get("recomendada")]
    base_mov = recomendados if len(recomendados) >= n else list(retornos.index)
    movidas = sorted(base_mov, key=lambda t: abs(float(retornos[t])), reverse=True)[:n]
    activos = []
    for t in movidas:
        item = _enriquecer(t, retornos[t])
        item["movimiento_abs_pct"] = abs(item["retorno_pct"]) if item["retorno_pct"] is not None else None
        # Se conserva la clave por compatibilidad con clientes viejos, pero ya
        # no se finge un dato de volumen que no existe.
        item["valor_transado"] = None
        activos.append(item)

    data = {
        "ok":         True,
        "periodo":    periodo,
        "dias":       dias,
        "ganadores":  ganadores,
        "perdedores": perdedores,
        "populares":  activos,   # alias backward-compat
        "activos":    activos,
        # Le dice al cliente QUÉ está viendo en el tercer panel, para que la
        # etiqueta no afirme algo que el dato no respalda.
        "criterio_activos": ("movimiento_abs_recomendadas"
                             if base_mov is recomendados else "movimiento_abs_universo"),
        "fecha":      df.index[-1].strftime("%Y-%m-%d") if len(df) else None,
        "universo_size": len(df.columns),
    }
    ts = time.time()
    _CACHE[cache_key] = {"ts": ts, "data": data}
    # Persistir en disco
    try:
        disk_path = _CACHE_DIR / f"{cache_key}.json"
        with open(disk_path, "w", encoding="utf-8") as f:
            json.dump({"_ts": ts, "data": data}, f, ensure_ascii=False, default=str)
    except Exception:
        pass
    return data
