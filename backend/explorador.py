# ============================================================
#  EXPLORADOR DE COMBINACIONES (Markowitz multi-ticker)
# ============================================================
#  Dado un subconjunto de tickers del universo curado, calcula:
#    - Métricas equal-weight (baseline)
#    - Portafolio óptimo por Markowitz (máx Sharpe)
#    - Diferencias entre ambos
#
#  Pensado para alimentar el endpoint /api/explorar con una
#  llamada en memoria (sin escribir CSVs cada vez).
# ============================================================
from pathlib import Path
import json
import numpy as np
import pandas as pd

from analisis import (
    DIAS_HABILES,
    TASA_LIBRE_RIESGO,
    calcular_max_drawdown,
    optimizar_sharpe,
)

BACKEND_DIR = Path(__file__).parent
UNIVERSO_PRECIOS_FULL = BACKEND_DIR / "universo_precios.csv"
UNIVERSO_INFO_FULL    = BACKEND_DIR / "universo_info.json"
UNIVERSO_PRECIOS_LITE = BACKEND_DIR / "universo_lite_precios.csv"
UNIVERSO_INFO_LITE    = BACKEND_DIR / "universo_lite_info.json"

# Usar versión completa si existe (dev local con 11K tickers),
# si no, usar lite (~1000 tickers, commiteada para producción)
if UNIVERSO_PRECIOS_FULL.exists():
    UNIVERSO_PRECIOS = UNIVERSO_PRECIOS_FULL
    UNIVERSO_INFO    = UNIVERSO_INFO_FULL
else:
    UNIVERSO_PRECIOS = UNIVERSO_PRECIOS_LITE
    UNIVERSO_INFO    = UNIVERSO_INFO_LITE

# Límites razonables en tickers que el usuario puede seleccionar
MIN_TICKERS = 2
MAX_TICKERS = 15


# ------------------------------------------------------------
# Carga perezosa del universo (cache en memoria)
# ------------------------------------------------------------
_cache = {"precios": None, "info": None}


def _cargar_universo():
    """Lee CSV + info del universo una sola vez y cachea en memoria."""
    if _cache["precios"] is None:
        if not UNIVERSO_PRECIOS.exists():
            raise FileNotFoundError(
                f"No existe {UNIVERSO_PRECIOS.name}. "
                "Corre primero: python descargar_universo.py"
            )
        _cache["precios"] = pd.read_csv(
            UNIVERSO_PRECIOS, index_col=0, parse_dates=True
        )
    if _cache["info"] is None:
        if UNIVERSO_INFO.exists():
            with open(UNIVERSO_INFO, encoding="utf-8") as f:
                _cache["info"] = json.load(f)
        else:
            _cache["info"] = {}
        # Aplicar resolver de sectores: reemplaza "Desconocido" por sectores reales
        try:
            import sectores as _sec
            _sec.patch_info(_cache["info"])
        except Exception as _e:
            print(f"warn: no se pudo aplicar sectores resolver: {_e}")
    return _cache["precios"], _cache["info"]


def listar_universo():
    """Devuelve la lista de tickers disponibles con metadata.
    Incluye precio_actual y flag recomendada para que la UI destaque
    un subconjunto y muestre el precio de cada acción.
    """
    precios, info = _cargar_universo()
    tickers = list(precios.columns)
    out = []
    for t in tickers:
        m = info.get(t, {})
        # Precio actual: preferimos el que guardó descargar_universo.py,
        # si no existe caemos al último close del CSV.
        precio = m.get("precio_actual")
        if precio is None and t in precios.columns:
            serie = precios[t].dropna()
            if len(serie):
                precio = round(float(serie.iloc[-1]), 2)
        out.append({
            "ticker": t,
            "nombre": m.get("nombre", t),
            "sector": m.get("sector", "Desconocido"),
            "pais":   m.get("pais",   "Desconocido"),
            "moneda": m.get("moneda", "Desconocido"),
            "precio": precio,
            "recomendada": bool(m.get("recomendada", False)),
        })
    # Ordenar: recomendadas primero, luego MX antes que US, luego alfabético
    out.sort(key=lambda x: (
        0 if x["recomendada"] else 1,
        0 if x["moneda"] == "MXN" else 1,
        x["ticker"],
    ))
    return {
        "tickers": out,
        "periodo": {
            "inicio": str(precios.index[0].date()),
            "fin":    str(precios.index[-1].date()),
            "dias":   len(precios),
        },
    }


# ------------------------------------------------------------
# Métricas de un portafolio con pesos dados
# ------------------------------------------------------------
def _metricas_portafolio(precios_sel, pesos_array):
    rend_diarios = precios_sel.pct_change().dropna()
    media_diaria = rend_diarios.mean().values
    cov_diaria = rend_diarios.cov().values

    rend_anual = float(pesos_array @ media_diaria) * DIAS_HABILES * 100
    vol_anual = float(np.sqrt(pesos_array @ cov_diaria @ pesos_array)) * np.sqrt(DIAS_HABILES) * 100
    sharpe = (
        (rend_anual - TASA_LIBRE_RIESGO * 100) / vol_anual
        if vol_anual > 0 else 0.0
    )

    # Max drawdown (simulando cartera normalizada)
    precios_norm = precios_sel / precios_sel.iloc[0]
    valor = (precios_norm * pesos_array).sum(axis=1)
    max_dd = calcular_max_drawdown(valor)
    rend_total = float((valor.iloc[-1] - 1) * 100)

    return {
        "rendimiento_total_pct": round(rend_total, 2),
        "rendimiento_anualizado_pct": round(rend_anual, 2),
        "volatilidad_anual_pct": round(vol_anual, 2),
        "sharpe_ratio": round(float(sharpe), 3),
        "max_drawdown_pct": round(max_dd, 2),
    }


# ------------------------------------------------------------
# Análisis principal
# ------------------------------------------------------------
def analizar_seleccion(tickers):
    """
    Dado un arreglo de tickers, devuelve:
      - metadata del periodo
      - portafolio equal-weight (baseline)
      - portafolio óptimo (Markowitz max Sharpe)
      - deltas
      - info de cada ticker
    """
    # Validación de entrada
    if not tickers or len(tickers) < MIN_TICKERS:
        raise ValueError(f"Necesitas al menos {MIN_TICKERS} tickers")
    if len(tickers) > MAX_TICKERS:
        raise ValueError(f"Máximo {MAX_TICKERS} tickers por análisis")
    if len(set(tickers)) != len(tickers):
        raise ValueError("Hay tickers duplicados en la selección")

    precios_univ, info_univ = _cargar_universo()

    faltantes = [t for t in tickers if t not in precios_univ.columns]
    if faltantes:
        raise ValueError(f"Tickers fuera del universo: {faltantes}")

    precios_sel = precios_univ[tickers].dropna()
    if len(precios_sel) < 60:
        raise ValueError(
            "No hay suficiente historia común entre los tickers seleccionados"
        )

    rend_diarios = precios_sel.pct_change().dropna()

    # Baseline: equal-weight
    n = len(tickers)
    pesos_eq = np.array([1.0 / n] * n)
    metricas_eq = _metricas_portafolio(precios_sel, pesos_eq)

    # Óptimo: Markowitz
    opt = optimizar_sharpe(rend_diarios, TASA_LIBRE_RIESGO)
    # Las métricas del óptimo vienen en formato ya %. Normalizamos.
    opt_metricas = {
        "rendimiento_anualizado_pct": opt["rendimiento_anualizado_pct"],
        "volatilidad_anual_pct":      opt["volatilidad_anual_pct"],
        "sharpe_ratio":               opt["sharpe_ratio"],
    }

    delta = {
        "rendimiento_anualizado_pp": round(
            opt_metricas["rendimiento_anualizado_pct"]
            - metricas_eq["rendimiento_anualizado_pct"], 2),
        "volatilidad_anual_pp": round(
            opt_metricas["volatilidad_anual_pct"]
            - metricas_eq["volatilidad_anual_pct"], 2),
        "sharpe_ratio": round(
            opt_metricas["sharpe_ratio"]
            - metricas_eq["sharpe_ratio"], 3),
    }

    # Info de cada ticker
    info_por_ticker = {
        t: {
            "nombre": info_univ.get(t, {}).get("nombre", t),
            "sector": info_univ.get(t, {}).get("sector", "Desconocido"),
            "pais":   info_univ.get(t, {}).get("pais",   "Desconocido"),
            "moneda": info_univ.get(t, {}).get("moneda", "Desconocido"),
        } for t in tickers
    }

    # Correlaciones de la selección
    correl = rend_diarios.corr().round(3)
    correlaciones = {t: correl[t].to_dict() for t in tickers}

    # =====================================================================
    # SCORE 0-100 + comentarios cualitativos
    # =====================================================================
    score_data = _calcular_score_combinacion(
        tickers=tickers,
        info_por_ticker=info_por_ticker,
        opt_metricas=opt_metricas,
        delta=delta,
        correl=correl,
    )

    return {
        "metadata": {
            "tickers": tickers,
            "fecha_inicio": str(precios_sel.index[0].date()),
            "fecha_fin":    str(precios_sel.index[-1].date()),
            "dias_observados": len(precios_sel),
            "tasa_libre_riesgo_pct": round(TASA_LIBRE_RIESGO * 100, 2),
        },
        "info_activos": info_por_ticker,
        "equal_weight": {
            "pesos": {t: round(1.0 / n, 4) for t in tickers},
            **metricas_eq,
        },
        "optimo": {
            "pesos": opt["pesos"],
            **opt_metricas,
        },
        "delta": delta,
        "correlaciones": correlaciones,
        "score": score_data,
    }


def _calcular_score_combinacion(tickers, info_por_ticker, opt_metricas, delta, correl):
    """Score 0-100 multi-criterio para una combinación de tickers,
    con comentarios cualitativos por componente."""

    n_tickers = len(tickers)
    sharpe = float(opt_metricas.get("sharpe_ratio", 0))
    vol    = float(opt_metricas.get("volatilidad_anual_pct", 0))
    ret    = float(opt_metricas.get("rendimiento_anualizado_pct", 0))

    # ---- 1) Sharpe del óptimo (30 pts) ----
    if sharpe >= 1.5:   sub_sharpe = 30
    elif sharpe >= 1.0: sub_sharpe = 24
    elif sharpe >= 0.5: sub_sharpe = 17
    elif sharpe >= 0.0: sub_sharpe = 10
    else:               sub_sharpe = 2

    # ---- 2) Correlación promedio entre tickers (20 pts) ----
    # Toma matriz de correlación, ignora diagonal, promedia abs(corr)
    if n_tickers >= 2:
        corr_vals = []
        for i, t1 in enumerate(tickers):
            for t2 in tickers[i+1:]:
                if t1 in correl.columns and t2 in correl.index:
                    c = abs(float(correl.loc[t1, t2]))
                    corr_vals.append(c)
        corr_prom = sum(corr_vals) / len(corr_vals) if corr_vals else 0.5
    else:
        corr_prom = 1.0

    if corr_prom < 0.30:   sub_corr = 20
    elif corr_prom < 0.50: sub_corr = 15
    elif corr_prom < 0.70: sub_corr = 9
    elif corr_prom < 0.85: sub_corr = 4
    else:                  sub_corr = 1

    # ---- 3) Mejora Markowitz vs equal-weight (15 pts) ----
    delta_sharpe = float(delta.get("sharpe_ratio", 0))
    if delta_sharpe >= 0.20:    sub_mejora = 15
    elif delta_sharpe >= 0.10:  sub_mejora = 11
    elif delta_sharpe >= 0.05:  sub_mejora = 7
    elif delta_sharpe >= 0:     sub_mejora = 4
    else:                       sub_mejora = 0

    # ---- 4) Diversificación geográfica (10 pts) ----
    paises = set()
    for t, m in info_por_ticker.items():
        p = m.get("pais", "")
        # Agrupar regiones macro
        if p in ("United States",): paises.add("US")
        elif p == "Mexico":         paises.add("MX")
        elif p in ("Global",):      paises.add("Crypto")
        elif p:                     paises.add("INTL")
    n_regiones = len(paises)
    if n_regiones >= 3:   sub_geo = 10
    elif n_regiones == 2: sub_geo = 7
    else:                 sub_geo = 3

    # ---- 5) Diversificación sectorial (10 pts) ----
    sectores = set()
    for t, m in info_por_ticker.items():
        s = m.get("sector") or "Desconocido"
        if s in ("Desconocido", "ETF / Índice", "Internacional"):
            continue  # no cuentan como sector único
        sectores.add(s)
    n_sectores = len(sectores)
    if n_sectores >= 5:   sub_sec = 10
    elif n_sectores == 4: sub_sec = 8
    elif n_sectores == 3: sub_sec = 6
    elif n_sectores == 2: sub_sec = 3
    else:                 sub_sec = 1

    # ---- 6) Diversificación por moneda (5 pts) ----
    monedas = {m.get("moneda") for m in info_por_ticker.values() if m.get("moneda")}
    n_monedas = len(monedas)
    if n_monedas >= 3:   sub_mon = 5
    elif n_monedas == 2: sub_mon = 4
    else:                sub_mon = 1

    # ---- 7) Tamaño del portafolio (5 pts) ----
    if 5 <= n_tickers <= 8:   sub_size = 5
    elif 4 == n_tickers or 9 <= n_tickers <= 10: sub_size = 4
    elif n_tickers == 3:      sub_size = 3
    elif n_tickers >= 11:     sub_size = 2  # más difícil de mantener
    else:                     sub_size = 1

    # ---- 8) Volatilidad razonable (5 pts) ----
    if vol < 12:        sub_vol = 5
    elif vol < 20:      sub_vol = 4
    elif vol < 30:      sub_vol = 3
    elif vol < 45:      sub_vol = 2
    else:               sub_vol = 1

    componentes = {
        "sharpe":     sub_sharpe,
        "correlacion": sub_corr,
        "mejora_markowitz": sub_mejora,
        "geografia":  sub_geo,
        "sectores":   sub_sec,
        "monedas":    sub_mon,
        "tamaño":     sub_size,
        "volatilidad": sub_vol,
    }
    pesos = {
        "sharpe": 30, "correlacion": 20, "mejora_markowitz": 15,
        "geografia": 10, "sectores": 10, "monedas": 5,
        "tamaño": 5, "volatilidad": 5,
    }
    total = round(sum(componentes.values()), 1)
    total = max(0, min(100, total))

    # ---- Veredicto final ----
    if total >= 80:
        veredicto = {"nivel": "excelente",  "etiqueta": "Excelente combinación", "color": "green"}
    elif total >= 65:
        veredicto = {"nivel": "buena",      "etiqueta": "Buena combinación",     "color": "green"}
    elif total >= 50:
        veredicto = {"nivel": "razonable",  "etiqueta": "Combinación razonable", "color": "blue"}
    elif total >= 35:
        veredicto = {"nivel": "débil",      "etiqueta": "Combinación débil",     "color": "amber"}
    else:
        veredicto = {"nivel": "pobre",      "etiqueta": "Combinación pobre",     "color": "red"}

    # ---- Comentarios cualitativos por dimensión ----
    comentarios = []

    # Sharpe
    if sharpe >= 1.5:
        comentarios.append({"tipo": "fortaleza", "icono": "🚀",
            "texto": f"Sharpe del óptimo de {sharpe:.2f} — entras en territorio élite. Por cada unidad de riesgo, sacas mucho retorno."})
    elif sharpe >= 1.0:
        comentarios.append({"tipo": "fortaleza", "icono": "✓",
            "texto": f"Sharpe sólido de {sharpe:.2f}. La compensación riesgo/retorno es buena."})
    elif sharpe < 0.5:
        comentarios.append({"tipo": "riesgo", "icono": "⚠",
            "texto": f"Sharpe bajo ({sharpe:.2f}). Por la volatilidad que asumes, no estás obteniendo retorno suficiente. Revisa la mezcla."})

    # Correlación
    if corr_prom < 0.30:
        comentarios.append({"tipo": "fortaleza", "icono": "🌐",
            "texto": f"Tus activos están casi descorrelacionados (corr promedio {corr_prom:.2f}). Eso es lo que un buen portafolio debe tener."})
    elif corr_prom > 0.75:
        comentarios.append({"tipo": "riesgo", "icono": "⚠",
            "texto": f"Correlación promedio muy alta ({corr_prom:.2f}). Tus activos se mueven en sincronía — cuando uno baja, todos bajan. Diversifica más."})
    elif corr_prom > 0.55:
        comentarios.append({"tipo": "atención", "icono": "•",
            "texto": f"Correlación moderada ({corr_prom:.2f}). Hay margen para diversificar agregando otra región o sector."})

    # Mejora Markowitz
    if delta_sharpe >= 0.15:
        comentarios.append({"tipo": "fortaleza", "icono": "🎯",
            "texto": f"Markowitz mejora tu Sharpe en {delta_sharpe:.2f} pp vs equal-weight. Vale la pena seguir los pesos óptimos."})
    elif delta_sharpe < 0.02:
        comentarios.append({"tipo": "atención", "icono": "•",
            "texto": "Markowitz casi no mejora vs equal-weight. Esto pasa cuando los activos son muy similares — considera ampliar el universo."})

    # Geografía
    if n_regiones <= 1 and "MX" in paises:
        comentarios.append({"tipo": "riesgo", "icono": "🇲🇽",
            "texto": "100% expuesto al peso mexicano. Riesgo cambiario alto. Considera agregar un ETF como SPY o VOO."})
    elif n_regiones <= 1 and "US" in paises:
        comentarios.append({"tipo": "atención", "icono": "🇺🇸",
            "texto": "Solo USA. Considera agregar exposure a México o emergentes para diversificar región."})
    elif n_regiones >= 3:
        comentarios.append({"tipo": "fortaleza", "icono": "🌎",
            "texto": f"Diversificación geográfica fuerte: {n_regiones} regiones. Reduces riesgo idiosincrático por país."})

    # Sectores
    if n_sectores >= 5:
        comentarios.append({"tipo": "fortaleza", "icono": "📊",
            "texto": f"Cubres {n_sectores} sectores distintos. Cuando un sector colapsa, los demás pueden compensar."})
    elif n_sectores <= 2 and n_tickers >= 4:
        comentarios.append({"tipo": "riesgo", "icono": "⚠",
            "texto": f"Concentración sectorial alta ({n_sectores} sector(es)). Una recesión sectorial te golpea de lleno."})

    # Monedas
    if n_monedas >= 3:
        comentarios.append({"tipo": "fortaleza", "icono": "💱",
            "texto": f"Tu cartera vive en {n_monedas} monedas. Hedge natural contra movimientos cambiarios."})

    # Tamaño
    if n_tickers <= 2:
        comentarios.append({"tipo": "riesgo", "icono": "•",
            "texto": "Solo 2 tickers — muy concentrado. Lo ideal para retail está entre 5 y 8 posiciones."})
    elif n_tickers > 12:
        comentarios.append({"tipo": "atención", "icono": "•",
            "texto": f"{n_tickers} tickers es muchísimo para un portafolio retail. Difícil de monitorear y rebalancear."})

    # Volatilidad
    if vol >= 35:
        comentarios.append({"tipo": "riesgo", "icono": "📉",
            "texto": f"Volatilidad anual {vol:.1f}% — drawdowns brutales son esperables. Asegúrate que tu estómago lo aguante."})
    elif vol < 10:
        comentarios.append({"tipo": "atención", "icono": "•",
            "texto": f"Volatilidad bajísima ({vol:.1f}%). Tranquilidad sí, pero también poco upside. Revisa si vale el riesgo cero."})

    # Mensaje de cierre según veredicto
    if total >= 80:
        comentarios.append({"tipo": "cierre", "icono": "🏆",
            "texto": "Esta combinación es muy sólida. Pocos cambios necesarios."})
    elif total < 35:
        comentarios.append({"tipo": "cierre", "icono": "🔧",
            "texto": "Hay oportunidades claras de mejora. Considera diversificar más por sector y región."})

    return {
        "score":       total,
        "veredicto":   veredicto,
        "componentes": componentes,
        "pesos":       pesos,
        "comentarios": comentarios,
        "metricas_brutas": {
            "correlacion_promedio": round(corr_prom, 3),
            "n_regiones":           n_regiones,
            "n_sectores":           n_sectores,
            "n_monedas":            n_monedas,
            "n_tickers":            n_tickers,
        },
    }
