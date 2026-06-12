# ============================================================
#  DESCARGADOR DE PRECIOS HISTÓRICOS DE ACCIONES
#  Para alguien que sabe HTML pero está aprendiendo Python
# ============================================================
# --- IMPORTAR LIBRERÍAS ---
# En HTML usas <script src="..."> para cargar código externo.
# En Python usas "import" para lo mismo.
import yfinance as yf          # La librería que habla con Yahoo Finance
import pandas as pd            # Sirve para manejar tablas de datos (como Excel en código)
from datetime import date, timedelta  # Para trabajar con fechas
from pathlib import Path       # Para manejar rutas de archivos de forma portable
# ============================================================
# 1. DEFINIR QUÉ ACCIONES QUEREMOS Y DE QUÉ PERIODO
# ============================================================
# En Python, una lista se escribe con corchetes [ ]
# Es como un array en JavaScript: ["valor1", "valor2"]
acciones = ["AMZN", "AAPL", "BIMBOA.MX"]
# BENCHMARKS: índices que usamos como "regla" para comparar el portafolio
# ^GSPC = S&P 500 (las 500 empresas más grandes de EE.UU.)
# ^MXX  = IPC México (las 35 empresas más grandes de la BMV)
# Descargamos ambos para que analisis.py escoja el relevante según
# la moneda dominante del portafolio (benchmark inteligente).
BENCHMARKS = ["^GSPC", "^MXX"]
# date.today() devuelve la fecha de hoy
# timedelta(days=730) significa "730 días" (2 años aproximado)
# Al restarlos obtenemos la fecha de hace 2 años
fecha_fin   = date.today()
fecha_inicio = fecha_fin - timedelta(days=730)
# Convertimos las fechas a texto en formato "YYYY-MM-DD"
# .strftime() es como .toLocaleDateString() en JavaScript
inicio_str = fecha_inicio.strftime("%Y-%m-%d")
fin_str    = fecha_fin.strftime("%Y-%m-%d")
print(f"Descargando datos del {inicio_str} al {fin_str}")
print(f"Acciones: {acciones}   |   Benchmarks: {BENCHMARKS}")
print("-" * 50)
# ============================================================
# 2. DESCARGAR LOS DATOS
# ============================================================
# yf.download() es la función principal de yfinance
# Le decimos qué acciones, desde cuándo y hasta cuándo
# "auto_adjust=True" ajusta los precios por splits y dividendos
# Combinamos la lista de acciones con los benchmarks para una sola descarga
tickers_a_descargar = acciones + BENCHMARKS
datos = yf.download(
    tickers     = tickers_a_descargar,  # Acciones + índice de referencia
    start       = inicio_str,           # Fecha de inicio como texto
    end         = fin_str,              # Fecha de fin como texto
    auto_adjust = True                  # Ajuste automático de precios
)
# "datos" es un DataFrame: piénsalo como una tabla de Excel en Python
# Tiene filas (días) y columnas (precios: Open, High, Low, Close, Volume)
print("Datos descargados exitosamente.")
print(f"Filas (días de mercado): {len(datos)}")
print(f"Columnas disponibles: {list(datos.columns.get_level_values(0).unique())}")
print()
# ============================================================
# 3. QUEDARNOS SOLO CON EL PRECIO DE CIERRE
# ============================================================
# "Close" es el precio al que cerró la acción ese día
# datos["Close"] extrae solo esa columna de toda la tabla
# Es como hacer document.querySelector(".close") en JS
precios_cierre = datos["Close"]
# .dropna() elimina filas donde falten datos
# (algunos días una bolsa abre y la otra no)
precios_cierre = precios_cierre.dropna()
print("Primeras 5 filas de precios de cierre:")
print(precios_cierre.head())   # .head() muestra las primeras 5 filas
print()
print("Últimas 5 filas de precios de cierre:")
print(precios_cierre.tail())   # .tail() muestra las últimas 5 filas
print()
# ============================================================
# 4. ESTADÍSTICAS BÁSICAS DE CADA ACCIÓN
# ============================================================
print("=" * 50)
print("ESTADÍSTICAS BÁSICAS")
print("=" * 50)
# Recorremos cada acción con un for loop
# En JS sería: acciones.forEach(ticker => { ... })
for ticker in acciones:
    precio_actual = precios_cierre[ticker].iloc[-1]   # .iloc[-1] = último valor (el más reciente)
    precio_hace2y = precios_cierre[ticker].iloc[0]    # .iloc[0]  = primer valor (el más antiguo)
    # Calculamos el rendimiento total en 2 años
    rendimiento = ((precio_actual - precio_hace2y) / precio_hace2y) * 100
    # Calculamos la volatilidad (desviación estándar de los rendimientos diarios)
    # .pct_change() calcula el % de cambio día a día
    # .std() calcula la desviación estándar
    # * (252 ** 0.5) anualiza la volatilidad (252 = días hábiles en un año)
    volatilidad_anual = precios_cierre[ticker].pct_change().std() * (252 ** 0.5) * 100
    # f"..." es un f-string: como template literals en JS (` ${variable} `)
    print(f"\n{ticker}")
    print(f"  Precio hace 2 años : ${precio_hace2y:.2f}")   # :.2f = 2 decimales
    print(f"  Precio actual      : ${precio_actual:.2f}")
    print(f"  Rendimiento 2 años : {rendimiento:+.1f}%")    # :+.1f = muestra el signo + o -
    print(f"  Volatilidad anual  : {volatilidad_anual:.1f}%")
# ============================================================
# 5. GUARDAR LOS DATOS EN UN ARCHIVO CSV
# ============================================================
# .to_csv() exporta el DataFrame a un archivo separado por comas
# Es como guardar un Excel, pero en formato .csv
# Usamos Path(__file__).parent para que SIEMPRE se guarde en la carpeta
# backend/ (donde vive este script), sin importar desde dónde lo corras.
ruta_csv = Path(__file__).parent / "precios_acciones.csv"
precios_cierre.to_csv(ruta_csv)
print()
print("=" * 50)
print(f"Datos guardados en: {ruta_csv}")
print("Puedes abrirlo en Excel para verificar los datos.")
print("=" * 50)

# ============================================================
# 6. METADATA DE CADA ACCIÓN (sector, país, moneda)
# ============================================================
# yf.Ticker(ticker).info devuelve un diccionario GRANDE con todo
# tipo de datos de la empresa: sector, industria, país, moneda,
# capitalización, P/E, etc. Nosotros solo guardamos los campos
# que usaremos para analizar la CONCENTRACIÓN del portafolio.
#
# Ejemplo: si alguien tiene AAPL+MSFT+GOOGL, técnicamente tiene
# 3 acciones, pero sectorialmente está 100% en Technology. Este
# análisis lo revela.
import json   # módulo estándar de Python para JSON

print("\nDescargando metadata (sector/país) de cada acción...")
info_activos = {}
for ticker in acciones:
    try:
        info = yf.Ticker(ticker).info   # llamada HTTP a Yahoo
        info_activos[ticker] = {
            "nombre":    info.get("longName") or info.get("shortName") or ticker,
            "sector":    info.get("sector") or "Desconocido",
            "industria": info.get("industry") or "Desconocido",
            "pais":      info.get("country") or "Desconocido",
            "moneda":    info.get("currency") or "Desconocido",
        }
        print(f"  {ticker:<12} → {info_activos[ticker]['sector']} / "
              f"{info_activos[ticker]['pais']} / {info_activos[ticker]['moneda']}")
    except Exception as e:
        # Si Yahoo falla para un ticker, no tumbamos todo el script
        info_activos[ticker] = {
            "nombre": ticker, "sector": "Desconocido",
            "industria": "Desconocido", "pais": "Desconocido",
            "moneda": "Desconocido",
        }
        print(f"  {ticker:<12} → error obteniendo info ({e})")

ruta_info = Path(__file__).parent / "info_activos.json"
with open(ruta_info, "w", encoding="utf-8") as f:
    json.dump(info_activos, f, indent=2, ensure_ascii=False)
print(f"Metadata guardada en: {ruta_info.name}")
