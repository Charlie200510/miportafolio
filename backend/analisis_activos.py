"""
analisis_activos.py — Análisis específico por TIPO de activo.

El análisis de la app se diseñó para acciones (FCF, P/E, márgenes, ROE). Al
pedir un ETF o una criptomoneda esos bloques salían vacíos y la pantalla se
veía a medias. Este módulo produce, para cada tipo, las métricas que SÍ
aplican, usando únicamente las fuentes que la app ya usa (yfinance, el universo
local y sml._descargar_close).

REGLA DE ORO
------------
Si un dato no está disponible, la clave NO se incluye en la respuesta. Nada de
None, "N/D" ni guiones: el frontend pinta solo lo que llega, así que un bloque
sin datos simplemente no existe en la pantalla. Por eso casi todo se construye
con `_poner(dic, clave, valor)`, que ignora los vacíos.

Cada métrica viaja con su propia explicación en lenguaje llano (`_ayuda`), igual
que ya hace la app con las acciones.
"""
from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import yfinance as yf

DIAS_ANUAL = 365          # cripto opera todos los días
DIAS_HABILES = 252        # renta variable

# Armar un perfil cuesta 7-13 s: baja series de 5 años del activo, de su
# benchmark y de 2-3 comparables. Nada de eso cambia dentro del mismo día, así
# que se cachea en memoria. Sin esto, volver a abrir el mismo ETF pagaba el
# costo completo cada vez.
_TTL_PERFIL = 6 * 60 * 60
_cache_perfil: Dict[str, tuple] = {}
_lock_perfil = threading.Lock()


def _cacheado(clave: str):
    with _lock_perfil:
        v = _cache_perfil.get(clave)
    if v and (time.time() - v[0]) < _TTL_PERFIL:
        return v[1]
    return None


def _guardar(clave: str, valor: Dict[str, Any]) -> Dict[str, Any]:
    with _lock_perfil:
        _cache_perfil[clave] = (time.time(), valor)
    return valor


# ─────────────────────────────────────────────────────────────
#  Utilidades
# ─────────────────────────────────────────────────────────────
def _poner(d: Dict[str, Any], clave: str, valor: Any) -> None:
    """Escribe solo si el valor existe y es utilizable. La omisión ES la
    política de datos faltantes; no hay ningún '—' en toda esta capa."""
    if valor is None:
        return
    if isinstance(valor, float) and (math.isnan(valor) or math.isinf(valor)):
        return
    if isinstance(valor, (list, dict, str)) and len(valor) == 0:
        return
    d[clave] = valor


def _num(v) -> Optional[float]:
    try:
        if v is None:
            return None
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _redondear(v: Optional[float], n: int = 4) -> Optional[float]:
    return None if v is None else round(v, n)


def _por_fecha(s: Optional[pd.Series]) -> Optional[pd.Series]:
    """Indexa la serie por FECHA, sin hora ni zona horaria.

    Las dos fuentes de precios no coinciden en formato: el universo local viene
    tz-naive y Yahoo devuelve tz-aware (America/Mexico_City para la BMV,
    America/New_York para EE.UU.). Cruzar una con otra levantaba
    "Cannot join tz-naive with tz-aware", que `_beta_corr` se tragaba y
    reportaba como n=0 — o sea, la beta y la correlación de un ETF contra su
    índice desaparecían del análisis sin dejar rastro de por qué. Normalizar
    aquí lo arregla para todos los consumidores a la vez."""
    if s is None:
        return None
    try:
        idx = pd.DatetimeIndex(s.index)
        if idx.tz is not None:
            idx = idx.tz_localize(None)
        s = pd.Series(s.values, index=idx.normalize(), name=getattr(s, "name", None))
        return s[~s.index.duplicated(keep="last")]
    except Exception:
        return s


def _serie(ticker: str, period: str = "5y") -> Optional[pd.Series]:
    """Cierres diarios. Primero el universo local (instantáneo), luego Yahoo."""
    try:
        import accion_del_dia as _ad
        df = _ad._cargar_precios()
        if df is not None and ticker in df.columns:
            s = df[ticker].dropna()
            if len(s) > 30:
                return _por_fecha(s)
    except Exception:
        pass
    try:
        import sml as _sml
        s = _sml._descargar_close(ticker, period=period)
        if s is not None and len(s) > 30:
            return _por_fecha(s.dropna())
    except Exception:
        pass
    return None


def _primer_dia(ticker: str):
    """Primer día con precio. Para los ETF de la BMV es la única forma de saber
    desde cuándo existe el producto: Yahoo no expone su fecha de constitución."""
    try:
        h = yf.Ticker(ticker).history(period="max")
        if h is not None and not h.empty:
            return h.index.min().to_pydatetime().astimezone(timezone.utc)
    except Exception:
        pass
    return None


def _volumen_medio(ticker: str, dias: int = 252) -> Optional[float]:
    """Volumen diario promedio del último año, del historial."""
    try:
        h = yf.Ticker(ticker).history(period="1y")
        if h is not None and not h.empty and "Volume" in h:
            v = h["Volume"].tail(dias)
            v = v[v > 0]
            if len(v) > 20:
                return float(round(v.mean()))
    except Exception:
        pass
    return None


def _yield_calculado(tk: "yf.Ticker") -> Optional[float]:
    """Dividendos repartidos en los últimos 12 meses / precio. Cuando Yahoo no
    publica el campo `yield` —todos los ETF de la BMV— este cálculo sí existe,
    porque los pagos individuales sí están en el historial."""
    try:
        div = tk.dividends
        if div is None or len(div) == 0:
            return None
        ult = div[div.index >= (div.index.max() - pd.Timedelta(days=370))]
        pagado = float(ult.sum())
        if pagado <= 0:
            return None
        # Si el último pago es de hace más de año y medio, el fondo dejó de
        # repartir y publicar un yield sería engañoso.
        if (pd.Timestamp.now(tz=div.index.tz) - div.index.max()).days > 550:
            return None
        h = tk.history(period="5d")
        precio = float(h["Close"].iloc[-1]) if h is not None and not h.empty else None
        if not precio:
            return None
        return pagado / precio
    except Exception:
        return None


def _rets(s: pd.Series) -> pd.Series:
    return s.pct_change().dropna()


def _vol_anual(s: pd.Series, dias: Optional[int] = None, base: int = DIAS_HABILES) -> Optional[float]:
    """Volatilidad anualizada sobre los últimos `dias` cierres."""
    try:
        r = _rets(s if dias is None else s.iloc[-(dias + 1):])
        if len(r) < 10:
            return None
        return float(r.std() * np.sqrt(base))
    except Exception:
        return None


def _max_drawdown(s: pd.Series) -> Optional[float]:
    """Caída máxima de pico a valle, como fracción negativa."""
    try:
        pico = s.cummax()
        dd = (s / pico) - 1.0
        return float(dd.min())
    except Exception:
        return None


def _sharpe(s: pd.Series, rf: float, base: int = DIAS_HABILES) -> Optional[float]:
    try:
        r = _rets(s)
        if len(r) < 30:
            return None
        vol = float(r.std() * np.sqrt(base))
        if not vol:
            return None
        ret = float((1 + r.mean()) ** base - 1)
        return (ret - rf) / vol
    except Exception:
        return None


def _sortino(s: pd.Series, rf: float, base: int = DIAS_HABILES) -> Optional[float]:
    """Como Sharpe pero castigando SOLO la volatilidad a la baja."""
    try:
        r = _rets(s)
        if len(r) < 30:
            return None
        malos = r[r < 0]
        if len(malos) < 5:
            return None
        dd = float(malos.std() * np.sqrt(base))
        if not dd:
            return None
        ret = float((1 + r.mean()) ** base - 1)
        return (ret - rf) / dd
    except Exception:
        return None


def _beta_corr(s: pd.Series, m: pd.Series) -> Dict[str, Optional[float]]:
    """Beta y correlación contra una referencia, sobre retornos diarios comunes."""
    try:
        ra, rm = _rets(s), _rets(m)
        comun = ra.index.intersection(rm.index)
        if len(comun) < 60:
            return {"beta": None, "correlacion": None, "n": len(comun)}
        a, b = ra.loc[comun], rm.loc[comun]
        var = float(b.var())
        beta = float(a.cov(b) / var) if var else None
        return {"beta": beta, "correlacion": float(a.corr(b)), "n": len(comun)}
    except Exception as exc:
        # Sin esta línea, un desajuste de índices se veía igual que "no hay
        # datos suficientes" y el bloque desaparecía sin explicación.
        print(f"[analisis] beta/correlación falló: {type(exc).__name__}: {exc}", flush=True)
        return {"beta": None, "correlacion": None, "n": 0}


def _ayuda(texto: str) -> str:
    return texto


# ─────────────────────────────────────────────────────────────
#  ETFs
# ─────────────────────────────────────────────────────────────
# Comparables curados por categoría. Se usan para la tabla "contra sus pares":
# 2-3 ETFs que replican algo parecido, para que el costo y el desempeño se lean
# en contexto y no en el vacío.
_COMPARABLES_ETF = {
    "VOO":  ["SPY", "IVV"],          "SPY": ["VOO", "IVV"],
    "IVV":  ["VOO", "SPY"],          "VTI": ["ITOT", "VOO"],
    "QQQ":  ["VGT", "XLK"],          "VGT": ["QQQ", "XLK"],
    "XLK":  ["QQQ", "VGT"],          "VXUS": ["VEA", "VWO"],
    "VEA":  ["VXUS", "IEFA"],        "VWO": ["IEMG", "VXUS"],
    "EWW":  ["NAFTRAC.MX", "VWO"],
    "NAFTRAC.MX": ["EWW", "MEXTRAC.MX"],
    "GLD":  ["IAU", "SLV"],          "SLV": ["GLD", "IAU"],
    "TLT":  ["IEF", "BND"],          "BND": ["AGG", "TLT"],
    "AGG":  ["BND", "TLT"],          "HYG": ["JNK", "AGG"],
    "IBIT": ["FBTC", "GBTC"],        "FBTC": ["IBIT", "GBTC"],
    "XLF":  ["VFH", "SPY"],          "XLE": ["VDE", "SPY"],
    "XLV":  ["VHT", "SPY"],          "XLY": ["VCR", "SPY"],
    "XLP":  ["VDC", "SPY"],          "XLI": ["VIS", "SPY"],
    "XLU":  ["VPU", "SPY"],          "XLB": ["VAW", "SPY"],
    "XLRE": ["VNQ", "SPY"],          "XLC": ["VOX", "SPY"],
    "IWM":  ["VTWO", "SPY"],         "DIA": ["SPY", "VOO"],
}

# ETFs listados en el SIC (Sistema Internacional de Cotizaciones) de la BMV que
# la app menciona con más frecuencia. Solo se usa para dar el contexto fiscal
# mexicano; si el ticker no está aquí, el bloque se OMITE en vez de adivinar.
_SIC_CONOCIDOS = {
    "VOO", "SPY", "IVV", "VTI", "QQQ", "VT", "VXUS", "VEA", "VWO",
    "IVVPESO.MX", "NAFTRAC.MX", "MEXTRAC.MX",
}

# Índice que replica y gestora, para los ETF donde Yahoo NO lo expone (todo el
# mercado mexicano, entre otros). Son datos ESTRUCTURALES del producto —qué
# índice sigue y quién lo administra—, no cifras que cambien con el mercado, y
# por eso se pueden curar sin riesgo de servir un número viejo. Deliberadamente
# NO se cura el TER: ese sí cambia, y preferimos omitir el dato a inventarlo.
_CATALOGO_ETF = {
    "NAFTRAC.MX": {"indice": "S&P/BMV IPC", "gestora": "BlackRock (iShares)",
                   "categoria": "Renta variable México · mercado amplio",
                   "simbolo_indice": "^MXX",
                   "figura_legal": "Trac (fondo de inversión en instrumentos de "
                                   "renta variable, listado en la BMV)"},
    "MEXTRAC.MX": {"indice": "S&P/BMV IPC", "gestora": "BlackRock (iShares)",
                   "categoria": "Renta variable México · mercado amplio",
                   "simbolo_indice": "^MXX",
                   "figura_legal": "Trac (fondo de inversión en instrumentos de "
                                   "renta variable, listado en la BMV)"},
    "VOO":  {"indice": "S&P 500", "simbolo_indice": "^GSPC"},
    "SPY":  {"indice": "S&P 500", "simbolo_indice": "^GSPC"},
    "IVV":  {"indice": "S&P 500", "simbolo_indice": "^GSPC"},
    "QQQ":  {"indice": "Nasdaq-100", "simbolo_indice": "^NDX"},
    "VTI":  {"indice": "CRSP US Total Market"},
    "IWM":  {"indice": "Russell 2000", "simbolo_indice": "^RUT"},
    "DIA":  {"indice": "Dow Jones Industrial Average", "simbolo_indice": "^DJI"},
    "VXUS": {"indice": "FTSE Global All Cap ex US"},
    "VEA":  {"indice": "FTSE Developed All Cap ex US"},
    "VWO":  {"indice": "FTSE Emerging Markets All Cap"},
    "EWW":  {"indice": "MSCI Mexico IMI 25/50"},
    "TLT":  {"indice": "ICE US Treasury 20+ Year"},
    "BND":  {"indice": "Bloomberg US Aggregate Float Adjusted"},
    "AGG":  {"indice": "Bloomberg US Aggregate Bond"},
    "HYG":  {"indice": "iBoxx USD Liquid High Yield"},
    # Sectoriales del S&P 500 (Select Sector SPDR). Aparecen arriba en el
    # screener y sin esto la columna de nombre repetía el ticker.
    "XLK":  {"indice": "S&P 500 · Tecnología"},
    "XLF":  {"indice": "S&P 500 · Financiero"},
    "XLI":  {"indice": "S&P 500 · Industrial"},
    "XLE":  {"indice": "S&P 500 · Energía"},
    "XLV":  {"indice": "S&P 500 · Salud"},
    "XLY":  {"indice": "S&P 500 · Consumo discrecional"},
    "XLP":  {"indice": "S&P 500 · Consumo básico"},
    "XLU":  {"indice": "S&P 500 · Servicios públicos"},
    "XLB":  {"indice": "S&P 500 · Materiales"},
    "XLRE": {"indice": "S&P 500 · Bienes raíces"},
    "XLC":  {"indice": "S&P 500 · Comunicaciones"},
    "ACWI": {"indice": "MSCI ACWI (mundo desarrollado + emergente)"},
    "VT":   {"indice": "FTSE Global All Cap"},
    "GLD":  {"indice": "Precio del oro (lingote físico)"},
    "IAU":  {"indice": "Precio del oro (lingote físico)"},
    "SLV":  {"indice": "Precio de la plata (lingote físico)"},
}

_SECTOR_ES = {
    "technology": "Tecnología", "financial_services": "Servicios financieros",
    "healthcare": "Salud", "consumer_cyclical": "Consumo discrecional",
    "consumer_defensive": "Consumo básico", "communication_services": "Comunicaciones",
    "industrials": "Industrial", "energy": "Energía", "utilities": "Servicios públicos",
    "basic_materials": "Materiales", "realestate": "Bienes raíces",
}


def _frecuencia_dividendos(tk: yf.Ticker) -> Optional[str]:
    """Deduce la frecuencia de reparto contando pagos del último año."""
    try:
        div = tk.dividends
        if div is None or len(div) == 0:
            return None
        ultimo_ano = div[div.index >= (div.index.max() - pd.Timedelta(days=370))]
        n = len(ultimo_ano)
        if n >= 11:
            return "mensual"
        if n >= 3:
            return "trimestral"
        if n == 2:
            return "semestral"
        if n == 1:
            return "anual"
        return None
    except Exception:
        return None


def analisis_etf(ticker: str, info: Dict[str, Any], moneda: str = "USD") -> Dict[str, Any]:
    """Perfil completo de un ETF. Solo incluye lo que realmente hay."""
    _hit = _cacheado("etf:" + ticker)
    if _hit is not None:
        return _hit
    out: Dict[str, Any] = {"tipo": "etf", "ticker": ticker}
    tk = yf.Ticker(ticker)

    # ── Qué replica y de quién es ────────────────────────────────────────
    ident: Dict[str, Any] = {}
    fo = {}
    try:
        fd = tk.funds_data
        fo = fd.fund_overview or {}
    except Exception:
        fd, fo = None, {}
    cur = _CATALOGO_ETF.get(ticker.upper(), {})
    _poner(ident, "indice", cur.get("indice"))
    _poner(ident, "categoria", fo.get("categoryName") or info.get("category") or cur.get("categoria"))
    _poner(ident, "gestora", fo.get("family") or info.get("fundFamily") or cur.get("gestora"))
    _poner(ident, "figura_legal", fo.get("legalType") or info.get("legalType")
           or cur.get("figura_legal"))
    _poner(ident, "moneda", info.get("currency") or moneda)
    # Yahoo reporta "YHD" —una bolsa fantasma— para varios instrumentos de la
    # BMV. Enseñarle eso al usuario no informa de nada; el sufijo .MX sí dice
    # con certeza dónde cotiza.
    _bolsa = info.get("exchange")
    if ticker.upper().endswith(".MX"):
        _bolsa = "BMV"
    elif _bolsa in ("YHD", "", None):
        _bolsa = None
    _poner(ident, "bolsa", _bolsa)
    # Antigüedad. Yahoo solo trae fundInceptionDate para los ETF de EE.UU.; para
    # los de la BMV se deduce del primer día con precio, que es un hecho
    # verificable (desde cuándo cotiza) y no una estimación.
    inicio = _num(info.get("fundInceptionDate"))
    d0 = None
    if inicio:
        try:
            d0 = datetime.fromtimestamp(inicio, tz=timezone.utc)
        except Exception:
            d0 = None
    if d0 is None:
        d0 = _primer_dia(ticker)
    if d0 is not None:
        _poner(ident, "inicio", d0.date().isoformat())
        _poner(ident, "anios_operando", round((datetime.now(timezone.utc) - d0).days / 365.25, 1))
    _poner(out, "identidad", ident)

    # ── Costo y tamaño ───────────────────────────────────────────────────
    costo: Dict[str, Any] = {}
    ter = None
    try:
        ops = fd.fund_operations if fd is not None else None
        if ops is not None and not ops.empty and ticker in ops.columns:
            fila = ops[ticker]
            ter = _num(fila.get("Annual Report Expense Ratio"))
            _poner(costo, "rotacion_cartera", _redondear(_num(fila.get("Annual Holdings Turnover"))))
            prom = _num(ops.get("Category Average", pd.Series()).get("Annual Report Expense Ratio"))
            _poner(costo, "ter_promedio_categoria", _redondear(prom))
    except Exception:
        pass
    if ter is None:
        ter = _num(info.get("annualReportExpenseRatio"))
    _poner(costo, "ter", _redondear(ter))
    aum = _num(info.get("totalAssets")) or _num(info.get("netAssets"))
    _poner(costo, "aum", aum)
    _poner(out, "costo", costo)

    # ── Reparto de dividendos ────────────────────────────────────────────
    reparto: Dict[str, Any] = {}
    dy = _num(info.get("yield")) or _num(info.get("trailingAnnualDividendYield"))
    if dy is not None and dy > 1:      # a veces viene en porcentaje
        dy = dy / 100.0
    if dy is None:
        # Calculado: lo repartido en los últimos 12 meses entre el precio. Es lo
        # mismo que publica Yahoo, pero sale de los pagos reales, así que existe
        # también para los ETF de la BMV, donde ese campo viene vacío.
        dy = _yield_calculado(tk)
    _poner(reparto, "dividend_yield", _redondear(dy))
    _poner(reparto, "frecuencia", _frecuencia_dividendos(tk))
    _poner(out, "reparto", reparto)

    # ── Composición ──────────────────────────────────────────────────────
    comp: Dict[str, Any] = {}
    try:
        th = fd.top_holdings if fd is not None else None
        if th is not None and not th.empty:
            filas = []
            for sym, fila in th.head(10).iterrows():
                peso = _num(fila.get("Holding Percent"))
                if peso is None:
                    continue
                filas.append({"ticker": str(sym), "nombre": str(fila.get("Name") or sym),
                              "peso": round(peso, 5)})
            if filas:
                comp["principales"] = filas
                comp["peso_top10"] = round(sum(f["peso"] for f in filas), 5)
    except Exception:
        pass
    try:
        sw = fd.sector_weightings if fd is not None else None
        if sw:
            sectores = [{"sector": _SECTOR_ES.get(k, k.replace("_", " ").capitalize()),
                         "peso": round(float(v), 5)}
                        for k, v in sw.items() if _num(v)]
            sectores.sort(key=lambda x: -x["peso"])
            if sectores:
                comp["sectores"] = sectores
    except Exception:
        pass
    try:
        ac = fd.asset_classes if fd is not None else None
        if ac:
            clases = [{"clase": k.replace("Position", ""), "peso": round(float(v), 5)}
                      for k, v in ac.items() if _num(v) and float(v) > 0.0005]
            if clases:
                comp["clases_activo"] = clases
    except Exception:
        pass
    _poner(out, "composicion", comp)

    # ── Riesgo y desempeño ───────────────────────────────────────────────
    s = _serie(ticker, period="5y")
    if s is not None and len(s) > 60:
        import metricas_canonicas as _mc
        rf = _mc.rf_para(ticker)
        # Contra su ÍNDICE, no contra un ETF hermano: la sección promete
        # "fidelidad de la réplica" y eso solo se mide contra lo replicado.
        # benchmark_para() devuelve el propio ticker para NAFTRAC —es el proxy
        # del mercado mexicano— y entonces el bloque entero se omitía.
        bench_tk = cur.get("simbolo_indice") or _mc.benchmark_para(ticker)
        riesgo: Dict[str, Any] = {}
        _poner(riesgo, "volatilidad_anual", _redondear(_vol_anual(s)))
        _poner(riesgo, "max_drawdown", _redondear(_max_drawdown(s)))
        _poner(riesgo, "sharpe", _redondear(_sharpe(s, rf), 2))
        _poner(riesgo, "sortino", _redondear(_sortino(s, rf), 2))
        _poner(riesgo, "liquidez_volumen_prom",
               _num(info.get("averageVolume"))
               or _num(info.get("averageDailyVolume3Month"))
               or _volumen_medio(ticker))
        if bench_tk != ticker:
            m = _serie(bench_tk, period="5y")
            if m is not None:
                bc = _beta_corr(s, m)
                _poner(riesgo, "benchmark", bench_tk)
                _poner(riesgo, "beta_vs_benchmark", _redondear(bc["beta"], 2))
                _poner(riesgo, "correlacion_benchmark", _redondear(bc["correlacion"], 2))
        _poner(out, "riesgo", riesgo)

    # ── Contra sus pares ─────────────────────────────────────────────────
    pares = _COMPARABLES_ETF.get(ticker, [])[:3]
    filas_par = []
    for p in pares:
        try:
            i2 = yf.Ticker(p).info or {}
            ter2 = _num(i2.get("annualReportExpenseRatio"))
            if ter2 is None:
                try:
                    o2 = yf.Ticker(p).funds_data.fund_operations
                    if o2 is not None and p in o2.columns:
                        ter2 = _num(o2[p].get("Annual Report Expense Ratio"))
                except Exception:
                    pass
            fila = {"ticker": p}
            _poner(fila, "nombre", i2.get("shortName") or i2.get("longName"))
            _poner(fila, "ter", _redondear(ter2))
            _poner(fila, "aum", _num(i2.get("totalAssets")) or _num(i2.get("netAssets")))
            s2 = _serie(p, period="5y")
            if s2 is not None:
                _poner(fila, "volatilidad_anual", _redondear(_vol_anual(s2)))
                import metricas_canonicas as _mc2
                _poner(fila, "sharpe", _redondear(_sharpe(s2, _mc2.rf_para(p)), 2))
            if len(fila) > 1:
                filas_par.append(fila)
        except Exception:
            continue
    if filas_par:
        propio = {"ticker": ticker}
        _poner(propio, "ter", _redondear(ter))
        _poner(propio, "aum", aum)
        if s is not None:
            import metricas_canonicas as _mc3
            _poner(propio, "volatilidad_anual", _redondear(_vol_anual(s)))
            _poner(propio, "sharpe", _redondear(_sharpe(s, _mc3.rf_para(ticker)), 2))
        _poner(out, "comparables", [propio] + filas_par)

    # ── Contexto para el inversionista mexicano ──────────────────────────
    mx: Dict[str, Any] = {}
    if ticker.upper().endswith(".MX"):
        mx["cotiza"] = "BMV (mercado local)"
        # El costo anual y la cartera de los ETF locales no están en ninguna
        # fuente pública automatizable: Yahoo no tiene datos de fondo para la
        # BMV. En vez de dejar un hueco mudo —o peor, inventar la cifra— se
        # dice dónde está el dato.
        mx["donde_ver_costo"] = (
            "El costo anual (TER) y la lista de posiciones de los ETF locales no "
            "se publican en las fuentes de datos que alimentan esta app. Vienen en "
            "la ficha técnica del emisor y en el prospecto, que están en el sitio "
            "de la gestora y en la ficha del instrumento en bmv.com.mx.")
        mx["nota"] = ("Al cotizar en la BMV en pesos, la compraventa se liquida en "
                      "moneda local. La ganancia por venta de acciones y ETFs en bolsa "
                      "mexicana causa el ISR del 10% del Artículo 129 de la LISR, que "
                      "retiene el intermediario.")
    elif ticker.upper() in _SIC_CONOCIDOS:
        mx["cotiza"] = "SIC (Sistema Internacional de Cotizaciones, BMV)"
        mx["nota"] = ("Se puede comprar desde un broker mexicano vía el SIC, en pesos. "
                      "Al ser un emisor extranjero, los dividendos suelen llegar ya con "
                      "retención en el país de origen, y la ganancia de capital se "
                      "acumula en tu declaración anual: no aplica la retención "
                      "definitiva del 10% de las acciones locales. Consulta a un "
                      "contador para tu caso.")
    if (info.get("currency") or "USD").upper() != "MXN":
        mx["exposicion_cambiaria"] = (
            "Está denominado en " + str(info.get("currency") or "USD") + ": tu "
            "rendimiento en pesos también depende del tipo de cambio. Si el peso se "
            "aprecia frente a esa moneda, tu ganancia medida en pesos se reduce "
            "aunque el ETF suba.")
    _poner(out, "mexico", mx)

    _poner(out, "glosario", {
        "ter": _ayuda("Costo anual que el fondo te descuenta automáticamente del "
                      "rendimiento. 0.03% significa 30 pesos al año por cada 100,000 "
                      "invertidos. Es lo único del ETF que sí conoces por adelantado."),
        "aum": _ayuda("Cuánto dinero administra el fondo en total. Más activos suele "
                      "significar más liquidez y menos riesgo de que lo cierren."),
        "peso_top10": _ayuda("Qué tanto pesan sus 10 posiciones más grandes. Arriba de "
                             "40% el ETF depende mucho de pocos nombres: diversifica "
                             "menos de lo que su nombre sugiere."),
        "beta_vs_benchmark": _ayuda("Cuánto se mueve frente a su índice de referencia. "
                                    "1.0 = se mueve igual; 1.2 = amplifica 20% los "
                                    "movimientos, para bien y para mal."),
        "correlacion_benchmark": _ayuda("Qué tan de la mano van. Cerca de 1 significa "
                                        "que replica bien; muy por debajo indica que "
                                        "se aparta del índice."),
        "sharpe": _ayuda("Rendimiento por unidad de riesgo total. Más alto es mejor; "
                         "arriba de 1 se considera bueno."),
        "sortino": _ayuda("Como el Sharpe, pero solo castiga las caídas. Útil porque a "
                          "nadie le molesta la volatilidad cuando es hacia arriba."),
        "max_drawdown": _ayuda("La peor caída de pico a valle que ha tenido. Es el dolor "
                               "máximo que habrías tenido que aguantar sin vender."),
        "volatilidad_anual": _ayuda("Qué tanto oscila su precio en un año. 15% es típico "
                                    "de un índice amplio; arriba de 30% es un fondo "
                                    "sectorial o de nicho."),
    })
    return _guardar("etf:" + ticker, out)


# ─────────────────────────────────────────────────────────────
#  Criptomonedas
# ─────────────────────────────────────────────────────────────
# Referencia de tamaño. No es un ranking en vivo (eso exigiría otra fuente de
# datos): sirve para situar la capitalización en un orden de magnitud.
_CRIPTO_GRANDES = ["BTC-USD", "ETH-USD", "XRP-USD", "BNB-USD", "SOL-USD",
                   "DOGE-USD", "ADA-USD", "TRX-USD", "AVAX-USD", "LINK-USD"]


def _percentil_volatilidad(s: pd.Series, vol_actual: Optional[float]) -> Optional[float]:
    """En qué percentil histórico cae la volatilidad de hoy (ventanas de 30d)."""
    if vol_actual is None:
        return None
    try:
        r = _rets(s)
        if len(r) < 400:
            return None
        rodante = r.rolling(30).std() * np.sqrt(DIAS_ANUAL)
        rodante = rodante.dropna()
        if len(rodante) < 200:
            return None
        return float((rodante < vol_actual).mean())
    except Exception:
        return None


def analisis_cripto(ticker: str, info: Dict[str, Any]) -> Dict[str, Any]:
    """Perfil completo de una criptomoneda. Tono EDUCATIVO, nunca prescriptivo."""
    _hit = _cacheado("crypto:" + ticker)
    if _hit is not None:
        return _hit
    out: Dict[str, Any] = {"tipo": "crypto", "ticker": ticker}
    s = _serie(ticker, period="5y")

    # ── Tamaño ───────────────────────────────────────────────────────────
    tam: Dict[str, Any] = {}
    mcap = _num(info.get("marketCap"))
    _poner(tam, "market_cap", mcap)
    if mcap:
        mayores = 0
        for otro in _CRIPTO_GRANDES:
            if otro.upper() == ticker.upper():
                continue
            try:
                m2 = _num((yf.Ticker(otro).info or {}).get("marketCap"))
                if m2 and m2 > mcap:
                    mayores += 1
            except Exception:
                continue
        _poner(tam, "posicion_aprox", mayores + 1)
        _poner(tam, "universo_comparado", len(_CRIPTO_GRANDES))
    _poner(out, "tamano", tam)

    # ── Suministro ───────────────────────────────────────────────────────
    sup: Dict[str, Any] = {}
    circ = _num(info.get("circulatingSupply"))
    maxi = _num(info.get("maxSupply"))
    _poner(sup, "circulante", circ)
    _poner(sup, "maximo", maxi)
    if circ and maxi and maxi > 0:
        emitido = circ / maxi
        _poner(sup, "emitido", round(emitido, 4))
        _poner(sup, "por_emitir", round(1 - emitido, 4))
        if emitido >= 0.95:
            lectura = ("Ya está emitido casi todo el suministro: queda muy poca "
                       "dilución futura por delante.")
        elif emitido >= 0.75:
            lectura = ("La mayor parte ya circula, pero todavía falta emitir una "
                       "porción que diluye a los tenedores actuales.")
        else:
            lectura = ("Falta emitir una parte grande del suministro: la oferta "
                       "seguirá creciendo y eso presiona el precio a la baja si la "
                       "demanda no crece al mismo ritmo.")
        _poner(sup, "lectura", lectura)
    elif circ and not maxi:
        _poner(sup, "lectura", "No tiene tope de emisión declarado: el suministro puede "
                               "crecer indefinidamente, que es lo contrario de un "
                               "activo con escasez programada.")
    _poner(out, "suministro", sup)

    if s is None or len(s) < 60:
        return _guardar("crypto:" + ticker, out)

    rf = 0.045
    # ── Volatilidad ──────────────────────────────────────────────────────
    vol: Dict[str, Any] = {}
    v30 = _vol_anual(s, 30, base=DIAS_ANUAL)
    _poner(vol, "vol_30d", _redondear(v30))
    _poner(vol, "vol_90d", _redondear(_vol_anual(s, 90, base=DIAS_ANUAL)))
    _poner(vol, "vol_365d", _redondear(_vol_anual(s, 365, base=DIAS_ANUAL)))
    pct = _percentil_volatilidad(s, v30)
    if pct is not None:
        _poner(vol, "percentil_historico", round(pct, 3))
        if pct >= 0.8:
            _poner(vol, "lectura", "Está más volátil que en el 80% de su historia: "
                                   "movimientos así de bruscos son la excepción, no la norma.")
        elif pct <= 0.2:
            _poner(vol, "lectura", "Está más tranquila que en el 80% de su historia. "
                                   "Los periodos de calma en cripto suelen ser cortos.")
        else:
            _poner(vol, "lectura", "Su volatilidad está en el rango habitual de su propia historia.")
    _poner(out, "volatilidad", vol)

    # ── Caídas ───────────────────────────────────────────────────────────
    caidas: Dict[str, Any] = {}
    _poner(caidas, "max_drawdown", _redondear(_max_drawdown(s)))
    try:
        ath = float(s.max())
        actual = float(s.iloc[-1])
        _poner(caidas, "maximo_historico", round(ath, 2))
        _poner(caidas, "distancia_ath", round(actual / ath - 1, 4))
        idx_ath = s.idxmax()
        _poner(caidas, "fecha_ath", str(pd.Timestamp(idx_ath).date()))
    except Exception:
        pass
    _poner(out, "caidas", caidas)

    # ── Riesgo-rendimiento ───────────────────────────────────────────────
    rr: Dict[str, Any] = {}
    _poner(rr, "sharpe", _redondear(_sharpe(s, rf, base=DIAS_ANUAL), 2))
    _poner(rr, "sortino", _redondear(_sortino(s, rf, base=DIAS_ANUAL), 2))
    _poner(out, "riesgo_rendimiento", rr)

    # ── ¿Diversifica de verdad? ──────────────────────────────────────────
    div: Dict[str, Any] = {}
    if ticker.upper() != "BTC-USD":
        btc = _serie("BTC-USD", period="5y")
        if btc is not None:
            bc = _beta_corr(s, btc)
            _poner(div, "beta_btc", _redondear(bc["beta"], 2))
            _poner(div, "correlacion_btc", _redondear(bc["correlacion"], 2))
    spy = _serie("SPY", period="5y")
    if spy is not None:
        bc = _beta_corr(s, spy)
        _poner(div, "beta_sp500", _redondear(bc["beta"], 2))
        _poner(div, "correlacion_sp500", _redondear(bc["correlacion"], 2))
    corr_btc = div.get("correlacion_btc")
    corr_spy = div.get("correlacion_sp500")
    if corr_btc is not None and corr_btc >= 0.75:
        div["lectura"] = ("Se mueve casi igual que Bitcoin. Tenerla ADEMÁS de BTC "
                          "diversifica poco: en la práctica es una apuesta con más "
                          "amplitud al mismo factor.")
    elif corr_spy is not None and corr_spy >= 0.5:
        div["lectura"] = ("Su correlación con el S&P 500 es alta: en las caídas "
                          "fuertes de bolsa tiende a caer también, justo cuando se "
                          "esperaría que un activo 'descorrelacionado' ayudara.")
    elif corr_spy is not None:
        div["lectura"] = ("Su correlación con el S&P 500 es baja: históricamente se ha "
                          "movido por razones distintas a las de la bolsa.")
    _poner(out, "diversificacion", div)

    # ── Liquidez y rango ─────────────────────────────────────────────────
    liq: Dict[str, Any] = {}
    volumen = _num(info.get("volume24Hr")) or _num(info.get("averageVolume"))
    _poner(liq, "volumen_diario", volumen)
    if volumen and mcap:
        ratio = volumen / mcap
        _poner(liq, "volumen_sobre_mcap", round(ratio, 4))
        if ratio >= 0.05:
            _poner(liq, "lectura", "Se opera un volumen alto respecto a su tamaño: "
                                   "entrar y salir no debería mover el precio.")
        elif ratio >= 0.01:
            _poner(liq, "lectura", "Liquidez normal para su tamaño.")
        else:
            _poner(liq, "lectura", "Se opera poco respecto a su tamaño: en un momento "
                                   "de estrés puede costar salir sin castigar el precio.")
    try:
        ult = s.iloc[-90:]
        _poner(liq, "rango_90d_min", round(float(ult.min()), 2))
        _poner(liq, "rango_90d_max", round(float(ult.max()), 2))
        _poner(liq, "precio_actual", round(float(s.iloc[-1]), 2))
    except Exception:
        pass
    _poner(out, "liquidez", liq)

    # ── Lectura de riesgo y dimensionamiento (EDUCATIVO) ─────────────────
    # NO es una recomendación de compra/venta: es aritmética de cuánto duele una
    # caída histórica según el peso que le des. La app no dice qué hacer.
    v = vol.get("vol_365d") or vol.get("vol_90d") or vol.get("vol_30d")
    mdd = caidas.get("max_drawdown")
    if v is not None or mdd is not None:
        dim: Dict[str, Any] = {}
        _poner(dim, "encabezado", "Qué tanto pesaría en tu portafolio")
        if mdd is not None:
            ejemplos = []
            for peso in (0.01, 0.03, 0.05, 0.10):
                ejemplos.append({"peso": peso, "impacto": round(peso * mdd, 4)})
            dim["ejemplos"] = ejemplos
            dim["explicacion"] = (
                "Si volviera a repetirse su peor caída histórica "
                f"({abs(mdd) * 100:.0f}%), así se vería el golpe sobre el TOTAL de tu "
                "portafolio según el porcentaje que representara. Es aritmética, no "
                "un pronóstico ni una sugerencia de cuánto comprar.")
        if v is not None:
            dim["volatilidad_contexto"] = (
                f"Con una volatilidad anual de {v * 100:.0f}%, moverse "
                f"±{v * 100 / math.sqrt(12):.0f}% en un mes cualquiera es normal para "
                "este activo, sin que haya pasado nada extraordinario.")
        dim["aviso"] = ("Contenido educativo. Mi Portafolio no es asesor de inversiones "
                        "registrado ante la CNBV y esto no es una recomendación de "
                        "compra o venta.")
        _poner(out, "dimensionamiento", dim)

    _poner(out, "glosario", {
        "market_cap": _ayuda("Precio por el número de monedas en circulación. Es el "
                             "tamaño del activo, no cuánto dinero le ha entrado."),
        "emitido": _ayuda("Qué porcentaje del suministro máximo ya existe. Mientras más "
                          "falte por emitir, más dilución futura para quien ya tiene."),
        "vol_365d": _ayuda("Qué tanto oscila su precio en un año. Para comparar: el S&P "
                           "500 ronda 15-20%; arriba de 60% es territorio muy volátil."),
        "percentil_historico": _ayuda("Dónde cae la volatilidad de hoy dentro de toda su "
                                      "historia. 0.9 significa que solo ha estado más "
                                      "agitada el 10% del tiempo."),
        "max_drawdown": _ayuda("La peor caída de pico a valle que ha tenido. El dolor "
                               "máximo que habrías aguantado sin vender."),
        "distancia_ath": _ayuda("Qué tan lejos está de su máximo histórico. -50% "
                                "significa que tendría que duplicarse para volver ahí."),
        "correlacion_btc": _ayuda("Qué tanto se mueve junto con Bitcoin. Cerca de 1 "
                                  "significa que aporta poca diversificación si ya "
                                  "tienes BTC."),
        "correlacion_sp500": _ayuda("Qué tanto se mueve junto con la bolsa "
                                    "estadounidense. Baja correlación es lo que se "
                                    "busca de un activo que diversifica de verdad."),
        "volumen_sobre_mcap": _ayuda("Cuánto se opera al día respecto a su tamaño. "
                                     "Mide qué tan fácil es entrar y salir."),
        "sortino": _ayuda("Como el Sharpe, pero solo castiga las caídas. Útil porque a "
                          "nadie le molesta la volatilidad cuando es hacia arriba."),
    })
    return _guardar("crypto:" + ticker, out)


# ─────────────────────────────────────────────────────────────
#  Narrativa por tipo (sustituye al deep dive de empresa)
# ─────────────────────────────────────────────────────────────
def narrativa_por_tipo(tipo: str, ticker: str, nombre: str,
                       perfil: Dict[str, Any]) -> Dict[str, str]:
    """Texto narrativo del tipo CORRECTO de activo.

    El deep dive de acciones habla de modelo de negocio, foso competitivo y
    márgenes. Para un ETF eso no significa nada (no tiene negocio: replica un
    índice) y para una cripto tampoco. Aquí se arma la narrativa con los ejes
    que sí aplican: réplica/costo/diversificación para ETFs, y
    suministro/volatilidad/correlación para cripto.
    """
    if tipo == "etf":
        ident = perfil.get("identidad") or {}
        costo = perfil.get("costo") or {}
        comp = perfil.get("composicion") or {}
        riesgo = perfil.get("riesgo") or {}
        partes = {}

        cat = ident.get("categoria")
        gest = ident.get("gestora")
        qué = f"{nombre} es un fondo cotizado"
        if ident.get("indice"):
            qué += f" que replica el índice {ident['indice']}"
        elif cat:
            qué += f" de la categoría {cat}"
        if gest:
            qué += f", gestionado por {gest}"
        qué += ("."
                " No es una empresa: no tiene ventas ni utilidades propias. Su trabajo"
                " es replicar una canasta, así que lo que importa es qué tan fiel es la"
                " réplica, cuánto cobra por hacerla y qué tanto diversifica.")
        partes["que_es"] = qué

        ter = costo.get("ter")
        if ter is not None:
            prom = costo.get("ter_promedio_categoria")
            t = (f"Cobra {ter * 100:.2f}% anual de comisión.")
            if prom:
                rel = "por debajo" if ter < prom else ("por encima" if ter > prom else "en línea con")
                t += (f" Eso está {rel} del promedio de su categoría ({prom * 100:.2f}%).")
            t += (" El costo se descuenta del rendimiento todos los años, así que es la"
                  " única variable de un ETF que sí puedes conocer por adelantado.")
            partes["costo"] = t

        top10 = comp.get("peso_top10")
        if top10 is not None:
            n_sec = len(comp.get("sectores") or [])
            t = f"Sus 10 mayores posiciones concentran {top10 * 100:.0f}% del fondo."
            if top10 > 0.4:
                t += (" Es una concentración alta: aunque tenga cientos de emisoras,"
                      " su rendimiento lo deciden en buena medida unos pocos nombres.")
            else:
                t += " La concentración es moderada: el peso está bien repartido."
            if n_sec:
                t += f" La cartera se reparte entre {n_sec} sectores."
            partes["diversificacion"] = t

        beta = riesgo.get("beta_vs_benchmark")
        corr = riesgo.get("correlacion_benchmark")
        if beta is not None or corr is not None:
            t = ""
            if corr is not None:
                t += (f"Su correlación con {riesgo.get('benchmark', 'su índice')} es"
                      f" {corr:.2f}")
                t += (", así que sigue de cerca a su referencia. " if corr > 0.9
                      else ", así que se aparta bastante de su referencia. ")
            if beta is not None:
                t += (f"Con beta {beta:.2f}, "
                      + ("amplifica" if beta > 1.05 else ("amortigua" if beta < 0.95 else "acompaña"))
                      + " los movimientos del mercado.")
            partes["replica"] = t.strip()
        return partes

    if tipo == "crypto":
        sup = perfil.get("suministro") or {}
        vol = perfil.get("volatilidad") or {}
        div = perfil.get("diversificacion") or {}
        caidas = perfil.get("caidas") or {}
        partes = {}

        partes["que_es"] = (
            f"{nombre} es un activo digital. No tiene ingresos, utilidades ni flujo de"
            " caja, así que no se puede valuar con P/E, márgenes ni ROE: no hay nada"
            " que dividir. Lo que sí se puede medir es su escasez programada, cuánto"
            " oscila y si de verdad diversifica un portafolio.")

        if sup.get("lectura"):
            base = ""
            if sup.get("emitido") is not None:
                base = f"Ya circula {sup['emitido'] * 100:.0f}% del suministro máximo. "
            partes["suministro"] = base + sup["lectura"]

        v = vol.get("vol_365d") or vol.get("vol_90d")
        if v is not None:
            t = (f"Su volatilidad anual es de {v * 100:.0f}%, contra el 15-20% típico de"
                 " un índice de bolsa amplio. ")
            if vol.get("lectura"):
                t += vol["lectura"]
            partes["volatilidad"] = t.strip()

        if caidas.get("max_drawdown") is not None:
            t = (f"Su peor caída histórica fue de {abs(caidas['max_drawdown']) * 100:.0f}%.")
            if caidas.get("distancia_ath") is not None:
                d = caidas["distancia_ath"]
                t += (" Hoy está en su máximo histórico." if d > -0.01 else
                      f" Hoy cotiza {abs(d) * 100:.0f}% por debajo de su máximo histórico.")
            partes["caidas"] = t

        if div.get("lectura"):
            partes["correlacion"] = div["lectura"]
        return partes

    return {}
