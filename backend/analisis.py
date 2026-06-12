# ============================================================
#  ANÁLISIS DE PORTAFOLIO DE INVERSIÓN (v3)
#  Mejoras vs v2:
#   - Análisis de concentración (sector / país / moneda)
#   - Series de tiempo (para gráficas del frontend):
#       · rendimiento acumulado del portafolio vs benchmark
#       · drawdown del portafolio a lo largo del tiempo
#       · volatilidad rolling de 30 días
#  Entrada:  precios_acciones.csv  (con columna ^GSPC)
#            info_activos.json     (sector/país/moneda por ticker)
#  Salida:   resultados.json
# ============================================================
import pandas as pd
import numpy as np
import json
from pathlib import Path
from scipy.optimize import minimize

# ============================================================
# CONFIGURACIÓN
# ============================================================
CARPETA = Path(__file__).parent
CSV_PATH = CARPETA / "precios_acciones.csv"
INFO_PATH = CARPETA / "info_activos.json"
JSON_PATH = CARPETA / "resultados.json"

DIAS_HABILES = 252                 # días hábiles en un año bursátil
TASA_LIBRE_RIESGO = 0.09           # Cetes 28 días en México (~9%)
# Benchmarks disponibles (se eligen automáticamente según moneda dominante)
BENCHMARK_US = "^GSPC"             # S&P 500
BENCHMARK_MX = "^MXX"              # IPC México
BENCHMARKS_POSIBLES = [BENCHMARK_US, BENCHMARK_MX]
# Si >= UMBRAL_MX del peso está en MXN, usamos IPC México como benchmark
UMBRAL_MX = 0.5
VENTANA_VOL_ROLLING = 30           # días para volatilidad móvil

# Pesos del portafolio. None = equal-weight.
# Ejemplo: {"AAPL": 0.5, "AMZN": 0.3, "BIMBOA.MX": 0.2}
PESOS_DEFAULT = None


# ============================================================
# HELPERS
# ============================================================
def calcular_max_drawdown(serie_precios):
    """Peor caída porcentual desde un pico hasta un valle posterior."""
    pico_historico = serie_precios.cummax()
    drawdown = (serie_precios / pico_historico - 1) * 100
    return float(drawdown.min())


def serie_a_lista_json_safe(serie, decimales=4):
    """
    Convierte una Series de pandas a lista compatible con JSON.
    Los NaN (p.ej. los primeros valores de un rolling) se vuelven None.
    """
    return [
        None if pd.isna(v) else round(float(v), decimales)
        for v in serie
    ]


def cargar_info_activos():
    """Lee info_activos.json si existe; si no, devuelve dict vacío."""
    if INFO_PATH.exists():
        with open(INFO_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def elegir_benchmark(pesos_dict, info):
    """
    Elige el benchmark relevante según la moneda dominante del portafolio.
      - Si >= UMBRAL_MX del peso total está en MXN → ^MXX (IPC México)
      - En cualquier otro caso → ^GSPC (S&P 500)
    Devuelve (ticker_benchmark, peso_mxn_total, peso_usd_total).
    """
    peso_mxn = 0.0
    peso_usd = 0.0
    for ticker, w in pesos_dict.items():
        moneda = info.get(ticker, {}).get("moneda", "Desconocido")
        if moneda == "MXN":
            peso_mxn += w
        elif moneda == "USD":
            peso_usd += w
    benchmark = BENCHMARK_MX if peso_mxn >= UMBRAL_MX else BENCHMARK_US
    return benchmark, round(peso_mxn, 4), round(peso_usd, 4)


def optimizar_sharpe(rend_diarios, tasa_libre_riesgo):
    """
    Markowitz simplificado (long-only, sin apalancamiento):
    busca los pesos que MAXIMIZAN el Sharpe ratio anualizado.

    Restricciones:
      - Suma de pesos = 1
      - Cada peso entre 0 y 1 (no se permite shortear)

    Devuelve dict con pesos óptimos y métricas anualizadas (en %).
    """
    tickers = list(rend_diarios.columns)
    n = len(tickers)
    media_diaria = rend_diarios.mean().values
    cov_diaria = rend_diarios.cov().values

    def metricas(w):
        rend_anual = float(w @ media_diaria) * DIAS_HABILES
        var_anual = float(w @ cov_diaria @ w) * DIAS_HABILES
        vol_anual = float(np.sqrt(var_anual))
        if vol_anual <= 0:
            return rend_anual, vol_anual, 0.0
        sharpe = (rend_anual - tasa_libre_riesgo) / vol_anual
        return rend_anual, vol_anual, sharpe

    # Queremos maximizar Sharpe → minimizamos su negativo
    def neg_sharpe(w):
        _, _, s = metricas(w)
        return -s

    restricciones = ({"type": "eq", "fun": lambda w: np.sum(w) - 1.0},)
    limites = tuple((0.0, 1.0) for _ in range(n))
    pesos_iniciales = np.array([1.0 / n] * n)

    resultado = minimize(
        neg_sharpe,
        pesos_iniciales,
        method="SLSQP",
        bounds=limites,
        constraints=restricciones,
        options={"ftol": 1e-9, "maxiter": 500, "disp": False},
    )

    if not resultado.success:
        # Fallback: equal-weight si el solver falla por alguna razón
        pesos_optimos = pesos_iniciales
    else:
        pesos_optimos = resultado.x

    # Limpieza: valores muy chiquitos a cero y renormalizar
    pesos_optimos = np.where(pesos_optimos < 1e-4, 0.0, pesos_optimos)
    suma = pesos_optimos.sum()
    if suma > 0:
        pesos_optimos = pesos_optimos / suma

    rend_opt, vol_opt, sharpe_opt = metricas(pesos_optimos)

    return {
        "pesos": {t: round(float(w), 4) for t, w in zip(tickers, pesos_optimos)},
        "rendimiento_anualizado_pct": round(rend_opt * 100, 2),
        "volatilidad_anual_pct": round(vol_opt * 100, 2),
        "sharpe_ratio": round(float(sharpe_opt), 3),
    }


# ============================================================
# FUNCIÓN PRINCIPAL
# ============================================================
def analizar_portafolio(pesos=None):
    """Versión que lee de disco (flujo original del proyecto)."""
    precios = pd.read_csv(CSV_PATH, index_col=0, parse_dates=True)
    info = cargar_info_activos()
    return analizar_portafolio_desde_df(precios, info, pesos)


def analizar_portafolio_desde_df(precios: pd.DataFrame, info: dict, pesos=None):
    """
    Análisis completo a partir de DataFrames en memoria.
    `precios` debe contener columnas de activos + opcionalmente columnas
    de benchmarks (cualquiera de BENCHMARKS_POSIBLES).
    `info` es el dict con metadata por ticker (sector/pais/moneda).
    """
    # Separar todos los benchmarks posibles del resto de activos
    benchmarks_en_csv = [b for b in BENCHMARKS_POSIBLES if b in precios.columns]
    precios_port = precios.drop(columns=benchmarks_en_csv) if benchmarks_en_csv else precios

    activos = list(precios_port.columns)
    n = len(activos)

    # ---- 2. PESOS ----
    if pesos is None:
        pesos_dict = {t: 1.0 / n for t in activos}
    else:
        pesos_dict = {t: float(pesos.get(t, 0)) for t in activos}
        suma = sum(pesos_dict.values())
        if suma <= 0:
            pesos_dict = {t: 1.0 / n for t in activos}
        elif abs(suma - 1.0) > 1e-6:
            pesos_dict = {t: w / suma for t, w in pesos_dict.items()}
    pesos_array = np.array([pesos_dict[t] for t in activos])

    # ---- 2b. ELEGIR BENCHMARK INTELIGENTE ----
    # Basado en la moneda dominante del portafolio, ya con pesos normalizados.
    benchmark_elegido, peso_mxn, peso_usd = elegir_benchmark(pesos_dict, info)
    if benchmark_elegido in precios.columns:
        precios_bench = precios[benchmark_elegido]
    else:
        # Fallback: usa cualquier benchmark disponible, o nada.
        precios_bench = precios[benchmarks_en_csv[0]] if benchmarks_en_csv else None
        if benchmarks_en_csv:
            benchmark_elegido = benchmarks_en_csv[0]
        else:
            benchmark_elegido = None

    # ---- 3. RENDIMIENTOS DIARIOS ----
    rend_diarios = precios_port.pct_change().dropna()

    # ---- 4. MÉTRICAS POR ACTIVO ----
    por_activo = {}
    for ticker in activos:
        precio_ini = float(precios_port[ticker].iloc[0])
        precio_fin = float(precios_port[ticker].iloc[-1])
        rend_total = (precio_fin / precio_ini - 1) * 100
        rend_anual = float(rend_diarios[ticker].mean() * DIAS_HABILES) * 100
        vol_anual = float(rend_diarios[ticker].std() * np.sqrt(DIAS_HABILES)) * 100
        sharpe = (
            (rend_anual - TASA_LIBRE_RIESGO * 100) / vol_anual
            if vol_anual > 0 else 0.0
        )
        max_dd = calcular_max_drawdown(precios_port[ticker])

        por_activo[ticker] = {
            "nombre": info.get(ticker, {}).get("nombre", ticker),
            "sector": info.get(ticker, {}).get("sector", "Desconocido"),
            "pais": info.get(ticker, {}).get("pais", "Desconocido"),
            "moneda": info.get(ticker, {}).get("moneda", "Desconocido"),
            "precio_inicial": round(precio_ini, 2),
            "precio_final": round(precio_fin, 2),
            "rendimiento_total_pct": round(rend_total, 2),
            "rendimiento_anualizado_pct": round(rend_anual, 2),
            "volatilidad_anual_pct": round(vol_anual, 2),
            "sharpe_ratio": round(sharpe, 3),
            "max_drawdown_pct": round(max_dd, 2),
        }

    # ---- 5. CORRELACIONES ----
    correl = rend_diarios.corr().round(3)
    correlaciones = {t: correl[t].to_dict() for t in activos}

    # ---- 6. PORTAFOLIO COMPUESTO ----
    rend_medio_anual_activos = (rend_diarios.mean() * DIAS_HABILES).values
    rend_port_anual = float(pesos_array @ rend_medio_anual_activos) * 100

    cov_anual = rend_diarios.cov().values * DIAS_HABILES
    vol_port_anual = float(np.sqrt(pesos_array @ cov_anual @ pesos_array)) * 100

    sharpe_port = (
        (rend_port_anual - TASA_LIBRE_RIESGO * 100) / vol_port_anual
        if vol_port_anual > 0 else 0.0
    )

    # Valor del portafolio a lo largo del tiempo (normalizado a 1 al inicio)
    precios_normalizados = precios_port / precios_port.iloc[0]
    valor_portafolio = (precios_normalizados * pesos_array).sum(axis=1)
    max_dd_port = calcular_max_drawdown(valor_portafolio)
    rend_total_port = float((valor_portafolio.iloc[-1] - 1) * 100)

    portafolio = {
        "pesos": {t: round(w, 4) for t, w in pesos_dict.items()},
        "rendimiento_total_pct": round(rend_total_port, 2),
        "rendimiento_anualizado_pct": round(rend_port_anual, 2),
        "volatilidad_anual_pct": round(vol_port_anual, 2),
        "sharpe_ratio": round(sharpe_port, 3),
        "max_drawdown_pct": round(max_dd_port, 2),
    }

    # ---- 6b. PORTAFOLIO ÓPTIMO (Markowitz, máx Sharpe) ----
    opt = optimizar_sharpe(rend_diarios, TASA_LIBRE_RIESGO)
    # Deltas contra el portafolio actual (cuánto mejoraría)
    opt["delta_vs_actual"] = {
        "rendimiento_anualizado_pp": round(opt["rendimiento_anualizado_pct"] - rend_port_anual, 2),
        "volatilidad_anual_pp":      round(opt["volatilidad_anual_pct"]      - vol_port_anual, 2),
        "sharpe_ratio":               round(opt["sharpe_ratio"]               - sharpe_port, 3),
    }
    portafolio_optimo = opt

    # ---- 7. BENCHMARK ----
    benchmark_info = None
    valor_bench = None
    if precios_bench is not None:
        bench_ini = float(precios_bench.iloc[0])
        bench_fin = float(precios_bench.iloc[-1])
        rend_bench_total = (bench_fin / bench_ini - 1) * 100
        rend_bench_diario = precios_bench.pct_change().dropna()
        rend_bench_anual = float(rend_bench_diario.mean() * DIAS_HABILES) * 100
        vol_bench_anual = float(rend_bench_diario.std() * np.sqrt(DIAS_HABILES)) * 100
        sharpe_bench = (
            (rend_bench_anual - TASA_LIBRE_RIESGO * 100) / vol_bench_anual
            if vol_bench_anual > 0 else 0.0
        )
        max_dd_bench = calcular_max_drawdown(precios_bench)
        alpha_pct = rend_port_anual - rend_bench_anual

        benchmark_info = {
            "ticker": benchmark_elegido,
            "rendimiento_total_pct": round(rend_bench_total, 2),
            "rendimiento_anualizado_pct": round(rend_bench_anual, 2),
            "volatilidad_anual_pct": round(vol_bench_anual, 2),
            "sharpe_ratio": round(sharpe_bench, 3),
            "max_drawdown_pct": round(max_dd_bench, 2),
            "alpha_portafolio_pct": round(float(alpha_pct), 2),
        }
        valor_bench = precios_bench / precios_bench.iloc[0]   # normalizado

    # ============================================================
    # 8. CONCENTRACIÓN (sector / país / moneda)
    # ============================================================
    # Para cada activo multiplicamos su PESO en el portafolio por la
    # categoría a la que pertenece. Después sumamos por categoría.
    # Ejemplo: si AAPL (sector=Technology, peso=0.5) y AMZN (sector=
    # Consumer Cyclical, peso=0.5), la concentración por sector es:
    #   Technology: 0.5,  Consumer Cyclical: 0.5
    def _agrupar_por(campo):
        """Agrega peso total por valor de 'campo' (sector/pais/moneda)."""
        agrupado = {}
        for t in activos:
            valor = info.get(t, {}).get(campo, "Desconocido")
            agrupado[valor] = agrupado.get(valor, 0) + pesos_dict[t]
        # Redondear y ordenar de mayor a menor
        return dict(sorted(
            ((k, round(v, 4)) for k, v in agrupado.items()),
            key=lambda x: -x[1]
        ))

    por_sector = _agrupar_por("sector")
    por_pais = _agrupar_por("pais")
    por_moneda = _agrupar_por("moneda")

    # Concentración máxima en un solo sector = "qué tan puesto todo en
    # una misma canasta estoy". >60% suele ser señal de alarma.
    concentracion_max_sector = max(por_sector.values()) * 100 if por_sector else 0

    concentracion = {
        "por_sector": por_sector,
        "por_pais": por_pais,
        "por_moneda": por_moneda,
        "num_sectores": len(por_sector),
        "num_paises": len(por_pais),
        "num_monedas": len(por_moneda),
        "concentracion_maxima_sector_pct": round(concentracion_max_sector, 2),
    }

    # ============================================================
    # 9. SERIES DE TIEMPO (para gráficas del frontend)
    # ============================================================
    # Todas alineadas a las mismas fechas. Valores en %.

    # 9a. Rendimiento acumulado del portafolio desde el día 1 (en %)
    rend_acum_port = (valor_portafolio - 1) * 100

    # 9b. Drawdown del portafolio en cada punto del tiempo
    pico_port = valor_portafolio.cummax()
    drawdown_port = (valor_portafolio / pico_port - 1) * 100

    # 9c. Volatilidad rolling de 30 días, anualizada
    # Primero rendimientos diarios del portafolio
    rend_diarios_port = valor_portafolio.pct_change()
    vol_rolling = (
        rend_diarios_port.rolling(VENTANA_VOL_ROLLING).std()
        * np.sqrt(DIAS_HABILES) * 100
    )

    # 9d. Rendimiento acumulado del benchmark (si existe)
    if valor_bench is not None:
        rend_acum_bench = (valor_bench - 1) * 100
        lista_bench = serie_a_lista_json_safe(rend_acum_bench, decimales=3)
    else:
        lista_bench = None

    fechas = [d.strftime("%Y-%m-%d") for d in valor_portafolio.index]

    series_tiempo = {
        "fechas": fechas,
        "rendimiento_acumulado_portafolio_pct": serie_a_lista_json_safe(rend_acum_port, 3),
        "rendimiento_acumulado_benchmark_pct": lista_bench,
        "drawdown_portafolio_pct": serie_a_lista_json_safe(drawdown_port, 3),
        "volatilidad_rolling_30d_pct": serie_a_lista_json_safe(vol_rolling, 2),
    }

    # ---- 10. EMPAQUETAR ----
    # Detectar monedas mixtas (ignoramos "Desconocido" para no falsos positivos)
    monedas_distintas = sorted({
        info.get(t, {}).get("moneda", "Desconocido")
        for t in activos
        if info.get(t, {}).get("moneda") and info.get(t, {}).get("moneda") != "Desconocido"
    })
    monedas_mixtas = len(monedas_distintas) > 1

    resultados = {
        "metadata": {
            "fecha_inicio": str(precios.index[0].date()),
            "fecha_fin": str(precios.index[-1].date()),
            "dias_observados": len(precios),
            "activos": activos,
            "tasa_libre_riesgo_pct": round(TASA_LIBRE_RIESGO * 100, 2),
            "benchmark": benchmark_elegido if benchmark_info else None,
            "peso_mxn": peso_mxn,
            "peso_usd": peso_usd,
            "monedas": monedas_distintas,
            "monedas_mixtas": monedas_mixtas,
        },
        "por_activo": por_activo,
        "correlaciones": correlaciones,
        "portafolio": portafolio,
        "portafolio_optimo": portafolio_optimo,
        "benchmark": benchmark_info,
        "concentracion": concentracion,
        "series_tiempo": series_tiempo,
    }
    return resultados


# ============================================================
# RESUMEN EN TERMINAL
# ============================================================
def imprimir_resumen(r):
    meta = r["metadata"]
    print(f"Periodo     : {meta['fecha_inicio']} a {meta['fecha_fin']}  ({meta['dias_observados']} días)")
    print(f"Activos     : {meta['activos']}")
    print(f"Tasa libre  : {meta['tasa_libre_riesgo_pct']}% (Cetes)")
    print(f"Benchmark   : {meta['benchmark'] or 'no disponible'}")
    print("-" * 60)

    print("\n=== MÉTRICAS POR ACTIVO ===")
    for t, m in r["por_activo"].items():
        print(f"\n{t} ({m['nombre']}) — {m['sector']} / {m['pais']}")
        print(f"  Rendimiento total      : {m['rendimiento_total_pct']:+.2f}%")
        print(f"  Rend. anualizado       : {m['rendimiento_anualizado_pct']:+.2f}%")
        print(f"  Volatilidad anual      : {m['volatilidad_anual_pct']:.2f}%")
        print(f"  Sharpe ratio           : {m['sharpe_ratio']:.3f}")
        print(f"  Máx. drawdown          : {m['max_drawdown_pct']:.2f}%")

    print("\n=== PORTAFOLIO ===")
    p = r["portafolio"]
    pesos_txt = ", ".join(f"{t}={w:.1%}" for t, w in p["pesos"].items())
    print(f"  Pesos                  : {pesos_txt}")
    print(f"  Rendimiento total      : {p['rendimiento_total_pct']:+.2f}%")
    print(f"  Rend. anualizado       : {p['rendimiento_anualizado_pct']:+.2f}%")
    print(f"  Volatilidad anual      : {p['volatilidad_anual_pct']:.2f}%")
    print(f"  Sharpe ratio           : {p['sharpe_ratio']:.3f}")
    print(f"  Máx. drawdown          : {p['max_drawdown_pct']:.2f}%")

    if r.get("portafolio_optimo"):
        o = r["portafolio_optimo"]
        d = o.get("delta_vs_actual", {})
        pesos_opt_txt = ", ".join(f"{t}={w:.1%}" for t, w in o["pesos"].items())
        print(f"\n=== PORTAFOLIO ÓPTIMO (máx Sharpe, Markowitz) ===")
        print(f"  Pesos óptimos          : {pesos_opt_txt}")
        print(f"  Rend. anualizado       : {o['rendimiento_anualizado_pct']:+.2f}%  ({d.get('rendimiento_anualizado_pp', 0):+.2f} pp)")
        print(f"  Volatilidad anual      : {o['volatilidad_anual_pct']:.2f}%  ({d.get('volatilidad_anual_pp', 0):+.2f} pp)")
        print(f"  Sharpe ratio           : {o['sharpe_ratio']:.3f}  ({d.get('sharpe_ratio', 0):+.3f})")

    if r["benchmark"]:
        b = r["benchmark"]
        print(f"\n=== BENCHMARK ({b['ticker']}) ===")
        print(f"  Rend. anualizado       : {b['rendimiento_anualizado_pct']:+.2f}%")
        print(f"  Volatilidad anual      : {b['volatilidad_anual_pct']:.2f}%")
        print(f"  Sharpe ratio           : {b['sharpe_ratio']:.3f}")
        print(f"  Máx. drawdown          : {b['max_drawdown_pct']:.2f}%")
        alpha = b["alpha_portafolio_pct"]
        veredicto = "le ganó al mercado" if alpha > 0 else "quedó por debajo del mercado"
        print(f"  Alfa del portafolio    : {alpha:+.2f}%  → {veredicto}")

    print("\n=== CONCENTRACIÓN ===")
    c = r["concentracion"]
    print(f"  Por sector ({c['num_sectores']}):")
    for k, v in c["por_sector"].items():
        print(f"    {k:<25} {v:.1%}")
    print(f"  Por país ({c['num_paises']}):")
    for k, v in c["por_pais"].items():
        print(f"    {k:<25} {v:.1%}")
    print(f"  Por moneda ({c['num_monedas']}):")
    for k, v in c["por_moneda"].items():
        print(f"    {k:<25} {v:.1%}")
    print(f"  Concentración máxima en un sector: {c['concentracion_maxima_sector_pct']:.1f}%")
    if c["concentracion_maxima_sector_pct"] > 60:
        print("  ⚠ ALERTA: más del 60% en un solo sector (baja diversificación)")

    st = r["series_tiempo"]
    print(f"\n=== SERIES DE TIEMPO (para gráficas) ===")
    print(f"  {len(st['fechas'])} puntos de datos diarios")
    print(f"  Series incluidas: rend. acumulado (portafolio/benchmark), drawdown, volatilidad rolling 30d")


if __name__ == "__main__":
    resultados = analizar_portafolio(PESOS_DEFAULT)
    imprimir_resumen(resultados)

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(resultados, f, indent=2, ensure_ascii=False)
    print(f"\nResultados guardados en: {JSON_PATH.name}")
