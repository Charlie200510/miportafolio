# ============================================================
#  SERVIDOR FLASK - Portafolio App
# ============================================================
# Sirve:
#   GET /                  → la página web (frontend/index.html)
#   GET /static/<archivo>  → archivos estáticos del frontend
#   GET /api/resultados    → el JSON con el análisis del portafolio
#   GET /api/info-activos  → metadata de las empresas (sector/pais/moneda)
#
# En HTML pensarías: "¿cómo expongo un JSON al navegador?"
# En Flask: defines una ruta y devuelves el contenido.
# ============================================================
from pathlib import Path
import os

# ---- Cargar .env si existe (sin depender de python-dotenv) ----------
# Esto deja disponibles ANTHROPIC_API_KEY, SMTP_*, etc. para los módulos
# que se importen abajo.
def _cargar_env():
    env_file = Path(__file__).parent / ".env"
    if not env_file.exists():
        return
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception as e:
        print(f"  warn: error leyendo .env: {e}")
_cargar_env()

from flask import Flask, Response, jsonify, send_from_directory, abort, request
from flask_cors import CORS
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
import subprocess
import sys
from typing import Optional

# Explorador (lazy import: si no hay universo todavía, los endpoints
# devuelven error en lugar de tirar el servidor al arrancar)
try:
    import explorador as _explorador
except Exception as _e:
    _explorador = None
    _explorador_error = str(_e)

# Mi Portafolio (análisis dinámico con tickers arbitrarios + cache).
# Lazy import igual que explorador.
try:
    import mi_portafolio as _mi_portafolio
except Exception as _e:
    _mi_portafolio = None
    _mi_portafolio_error = str(_e)

# Perfiles sugeridos (portafolios pre-armados).
try:
    import perfiles as _perfiles
except Exception as _e:
    _perfiles = None
    _perfiles_error = str(_e)

# Periódico financiero (cierres, noticias).
try:
    import periodico as _periodico
except Exception as _e:
    _periodico = None
    _periodico_error = str(_e)

# Rebalanceo de portafolio.
try:
    import rebalanceo as _rebalanceo
except Exception as _e:
    _rebalanceo = None
    _rebalanceo_error = str(_e)

# Tracking real de transacciones.
try:
    import transacciones as _transacciones
except Exception as _e:
    _transacciones = None
    _transacciones_error = str(_e)

# Calculadora de ISR MX + tax-loss harvesting.
try:
    import impuestos as _impuestos
except Exception as _e:
    _impuestos = None
    _impuestos_error = str(_e)

# Simulador de metas (Monte Carlo).
try:
    import metas as _metas
except Exception as _e:
    _metas = None
    _metas_error = str(_e)

# Calendario de dividendos + proyección de ingreso pasivo.
try:
    import dividendos as _dividendos
except Exception as _e:
    _dividendos = None
    _dividendos_error = str(_e)

# Asistente IA (Claude) sobre el portafolio.
try:
    import asistente as _asistente
except Exception as _e:
    _asistente = None
    _asistente_error = str(_e)

# Análisis fundamental por ticker (P/E, yield, market cap, earnings).
try:
    import fundamentals as _fundamentals
except Exception as _e:
    _fundamentals = None
    _fundamentals_error = str(_e)

# Análisis individual con score 1-100 (Peer Comparison + Deep Dive + Short Report).
try:
    import analizador as _analizador
except Exception as _e:
    _analizador = None
    _analizador_error = str(_e)

# Dashboard financiero por acción (KPIs + series 5Y).
try:
    import dashboard_financiero as _dashboard
except Exception as _e:
    _dashboard = None
    _dashboard_error = str(_e)

# JWT auth (para Capacitor iOS — convive con cookies de auth.py para web).
try:
    import jwt_auth as _jwt
except Exception as _e:
    _jwt = None
    _jwt_error = str(_e)

# Backtest histórico de portafolio.
try:
    import backtest as _backtest
except Exception as _e:
    _backtest = None
    _backtest_error = str(_e)

# Stress test de escenarios.
try:
    import stress_test as _stress
except Exception as _e:
    _stress = None
    _stress_error = str(_e)

# Comparativa de brokers MX.
try:
    import brokers_mx as _brokers
except Exception as _e:
    _brokers = None
    _brokers_error = str(_e)

# Declaración SAT anual.
try:
    import declaracion_sat as _sat
except Exception as _e:
    _sat = None
    _sat_error = str(_e)

# Aportaciones recurrentes (DCA).
try:
    import aportaciones as _aportaciones
except Exception as _e:
    _aportaciones = None
    _aportaciones_error = str(_e)

# Generador de reporte PDF mensual.
try:
    import reporte_pdf as _reporte_pdf
except Exception as _e:
    _reporte_pdf = None
    _reporte_pdf_error = str(_e)

# FIBRAS MX + CETES en vivo.
try:
    import renta_fija_mx as _renta_fija
except Exception as _e:
    _renta_fija = None
    _renta_fija_error = str(_e)

# Alertas por email (drift, movimientos, reporte semanal).
try:
    import alertas as _alertas
except Exception as _e:
    _alertas = None
    _alertas_error = str(_e)

# Autenticacion con magic links + pagos MercadoPago.
try:
    import auth as _auth
except Exception as _e:
    _auth = None
    _auth_error = str(_e)

try:
    import payments as _payments
except Exception as _e:
    _payments = None
    _payments_error = str(_e)

# ------------------------------------------------------------
# Config de rutas
# ------------------------------------------------------------
BACKEND_DIR  = Path(__file__).parent          # .../portafolio-app/backend
PROJECT_DIR  = BACKEND_DIR.parent              # .../portafolio-app
FRONTEND_DIR = PROJECT_DIR / "frontend"        # .../portafolio-app/frontend

# Le decimos a Flask dónde están los archivos estáticos del frontend
app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path="/static",
)

# ── Auto-inicializar schema Postgres al arrancar (idempotente) ──
# En Render free no hay Shell, así que el schema lo crea el server solo.
try:
    import db as _db
    if _db.DATABASE_URL.startswith(("postgres://", "postgresql://")):
        try:
            _db.init_schema()
            print("✓ DB schema verificado/inicializado")
        except Exception as _se:
            print(f"warn: no se pudo inicializar schema DB: {_se}")
except Exception as _de:
    print(f"warn: módulo db no disponible: {_de}")

# CORS — incluye orígenes de Capacitor iOS para que la app móvil pueda llamar al API
CORS(app,
    origins=[
        "capacitor://localhost",        # Capacitor iOS production
        "https://localhost",             # Capacitor iOS dev
        "ionic://localhost",             # Ionic legacy
        "http://localhost",
        "http://127.0.0.1",
        "http://127.0.0.1:5001",
        "http://localhost:5001",
        # Producción: agregar tu dominio Render aquí
        # "https://miportafolio.onrender.com",
        # "https://miportafolio.app",
    ],
    supports_credentials=True,
    expose_headers=["Authorization"],
    allow_headers=["Content-Type", "Authorization"],
)


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def _leer_json(ruta: Path):
    """Lee un JSON y lo devuelve como dict. None si no existe."""
    if not ruta.exists():
        return None
    with open(ruta, "r", encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------
# Rutas
# ------------------------------------------------------------
@app.route("/")
def home():
    """Sirve el index.html del frontend."""
    index = FRONTEND_DIR / "index.html"
    if not index.exists():
        return (
            "<h1>Frontend no encontrado</h1>"
            f"<p>No existe: {index}</p>", 500
        )
    return send_from_directory(str(FRONTEND_DIR), "index.html")


# ── PWA: service worker desde la raíz para tener scope "/" ──────
@app.route("/sw.js")
def pwa_service_worker():
    resp = send_from_directory(str(FRONTEND_DIR), "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/manifest.webmanifest")
def pwa_manifest():
    return send_from_directory(str(FRONTEND_DIR), "manifest.webmanifest")


# ── Páginas legales ─────────────────────────────────────────────
@app.route("/terminos")
def pagina_terminos():
    return send_from_directory(str(FRONTEND_DIR), "terminos.html")


@app.route("/privacidad")
def pagina_privacidad():
    return send_from_directory(str(FRONTEND_DIR), "privacidad.html")


@app.route("/api/resultados")
def api_resultados():
    """Devuelve el análisis del portafolio (resultados.json)."""
    ruta = BACKEND_DIR / "resultados.json"
    data = _leer_json(ruta)
    if data is None:
        return jsonify({
            "error": "resultados.json no existe",
            "hint": "Corre primero: python analisis.py"
        }), 404
    return jsonify(data)


@app.route("/api/info-activos")
def api_info_activos():
    """Devuelve metadata de cada acción (sector/pais/moneda)."""
    ruta = BACKEND_DIR / "info_activos.json"
    data = _leer_json(ruta)
    if data is None:
        # No es fatal — el frontend funciona sin esto
        return jsonify({}), 200
    return jsonify(data)


@app.route("/api/health")
def health():
    """Endpoint simple para verificar que el server vive."""
    return jsonify({
        "status": "ok",
        "tiene_resultados": (BACKEND_DIR / "resultados.json").exists(),
        "tiene_info_activos": (BACKEND_DIR / "info_activos.json").exists(),
        "tiene_universo": (BACKEND_DIR / "universo_precios.csv").exists(),
    })


# ------------------------------------------------------------
# EXPLORADOR: universo + análisis de selección
# ------------------------------------------------------------
@app.route("/api/universo")
def api_universo():
    """Devuelve la lista de tickers disponibles en el universo curado."""
    if _explorador is None:
        return jsonify({
            "error": "explorador no cargado",
            "detalle": _explorador_error
        }), 500
    try:
        return jsonify(_explorador.listar_universo())
    except FileNotFoundError as e:
        return jsonify({
            "error": str(e),
            "hint": "Corre primero: python descargar_universo.py"
        }), 404


@app.route("/api/explorar", methods=["POST"])
def api_explorar():
    """
    Analiza una selección de tickers del universo.
    Body JSON: {"tickers": ["AAPL", "MSFT", "BIMBOA.MX", ...]}
    """
    if _explorador is None:
        return jsonify({
            "error": "explorador no cargado",
            "detalle": _explorador_error
        }), 500

    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers", [])

    if not isinstance(tickers, list):
        return jsonify({"error": "tickers debe ser un arreglo"}), 400

    try:
        resultado = _explorador.analizar_seleccion(tickers)
        return jsonify(resultado)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({
            "error": str(e),
            "hint": "Corre primero: python descargar_universo.py"
        }), 404
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# MI PORTAFOLIO: análisis dinámico con tickers arbitrarios
# ------------------------------------------------------------
@app.route("/api/analizar", methods=["POST"])
def api_analizar():
    """
    Analiza un portafolio definido por el usuario.
    Body JSON: {"tickers": ["AAPL", "BIMBOA.MX", ...], "pesos": {"AAPL": 0.5, ...}}
    Los pesos son opcionales; si no vienen, se usa equal-weight.
    """
    if _mi_portafolio is None:
        return jsonify({
            "error": "mi_portafolio no cargado",
            "detalle": _mi_portafolio_error
        }), 500

    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers", [])
    pesos = body.get("pesos")  # opcional

    if not isinstance(tickers, list):
        return jsonify({"error": "tickers debe ser un arreglo"}), 400

    try:
        resultado = _mi_portafolio.analizar(tickers, pesos)
        return jsonify(resultado)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


@app.route("/api/buscar-ticker")
def api_buscar_ticker():
    """
    Busca tickers por nombre o símbolo usando Yahoo Finance.
    Query: /api/buscar-ticker?q=apple
    """
    if _mi_portafolio is None:
        return jsonify({
            "error": "mi_portafolio no cargado",
            "detalle": _mi_portafolio_error
        }), 500

    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify([])

    try:
        resultados = _mi_portafolio.buscar_ticker(q, limite=10)
        return jsonify(resultados)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# PERFILES: portafolios pre-armados sugeridos
# ------------------------------------------------------------
@app.route("/api/perfiles")
def api_perfiles():
    """Devuelve la lista de perfiles sugeridos, filtrando tickers
    que no están en el universo disponible y renormalizando pesos."""
    if _perfiles is None:
        return jsonify({
            "error": "perfiles no cargado",
            "detalle": _perfiles_error
        }), 500

    # Cargamos el universo para filtrar tickers inexistentes
    universo_set = None
    if _explorador is not None:
        try:
            univ = _explorador.listar_universo()
            universo_set = {t["ticker"] for t in univ.get("tickers", [])}
        except Exception:
            universo_set = None

    try:
        return jsonify(_perfiles.listar_perfiles(universo_set))
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# PRECIOS ACTUALES (cuasi-real, vía yfinance fast_info)
# ------------------------------------------------------------
def _precio_actual_de(t: str) -> tuple[str, dict]:
    """Pide a yfinance el último precio de un ticker. fast_info es
    órdenes de magnitud más rápido que .info."""
    import yfinance as yf
    try:
        info = yf.Ticker(t).fast_info
        # fast_info es un dict-like; claves distintas según versión.
        precio = None
        for key in ("last_price", "lastPrice", "regular_market_price", "regularMarketPrice"):
            try:
                v = info[key] if hasattr(info, "__getitem__") else getattr(info, key, None)
                if v is not None:
                    precio = float(v)
                    break
            except (KeyError, TypeError):
                continue
        if precio is None:
            return t, {"precio": None, "error": "sin precio"}
        return t, {"precio": round(precio, 2), "error": None}
    except Exception as e:
        return t, {"precio": None, "error": str(e)[:80]}


@app.route("/api/precios-actuales", methods=["POST"])
def api_precios_actuales():
    """
    Refresca los precios de una lista de tickers usando yfinance fast_info.
    Los precios de Yahoo suelen tener ~15 min de retraso vs el mercado real,
    pero son lo más actualizado que tenemos sin contratar feed pagado.

    Body JSON: {"tickers": ["AAPL", "MSFT", ...]}
    Respuesta: {
      "precios": {"AAPL": {"precio": 229.35, "error": null}, ...},
      "hora_actualizacion": "2026-04-18T14:52:30"
    }
    """
    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers", [])

    if not isinstance(tickers, list) or not tickers:
        return jsonify({"error": "tickers debe ser un arreglo no vacío"}), 400

    # Límite prudente para no saturar Yahoo ni nuestro rate limit
    if len(tickers) > 100:
        return jsonify({"error": "máximo 100 tickers por request"}), 400

    # Deduplicar preservando orden
    vistos = set()
    tickers_unicos = [t for t in tickers if not (t in vistos or vistos.add(t))]

    precios = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futuros = [ex.submit(_precio_actual_de, t) for t in tickers_unicos]
        for f in as_completed(futuros):
            try:
                t, d = f.result()
                precios[t] = d
            except Exception as e:
                # No dejamos que un ticker reviente todo el request
                continue

    return jsonify({
        "precios": precios,
        "hora_actualizacion": datetime.now().isoformat(timespec="seconds"),
        "aviso": "Precios con retraso aprox. 15 min (fuente: Yahoo Finance).",
    })


# ------------------------------------------------------------
# PERIÓDICO FINANCIERO
# ------------------------------------------------------------
@app.route("/api/periodico/cierres")
def api_periodico_cierres():
    """Cierres diarios de los índices principales + sparkline 5d."""
    if _periodico is None:
        return jsonify({
            "error": "periodico no cargado",
            "detalle": _periodico_error
        }), 500
    try:
        return jsonify(_periodico.cierres_indices())
    except Exception as e:
        return jsonify({"error": f"fallo cierres: {e}"}), 500


@app.route("/api/periodico/resumen")
def api_periodico_resumen():
    """Brief ejecutivo del día (cierres + top titulares). Cacheado 1h."""
    if _periodico is None:
        return jsonify({
            "error": "periodico no cargado",
            "detalle": _periodico_error
        }), 500
    try:
        return jsonify(_periodico.resumen_diario())
    except Exception as e:
        return jsonify({"error": f"fallo resumen: {e}"}), 500


@app.route("/api/periodico/noticias")
def api_periodico_noticias():
    """Noticias top del día (agregadas de índices/ETFs grandes)."""
    if _periodico is None:
        return jsonify({
            "error": "periodico no cargado",
            "detalle": _periodico_error
        }), 500
    try:
        limite = int(request.args.get("limite", 10))
        limite = max(1, min(limite, 20))
        return jsonify(_periodico.noticias_top(limite=limite))
    except Exception as e:
        return jsonify({"error": f"fallo noticias: {e}"}), 500


@app.route("/api/periodico/noticias-portafolio", methods=["POST"])
def api_periodico_noticias_portafolio():
    """Noticias de los tickers del portafolio del usuario.
    Body: {"tickers": ["AAPL", ...]}"""
    if _periodico is None:
        return jsonify({
            "error": "periodico no cargado",
            "detalle": _periodico_error
        }), 500

    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers", [])
    if not isinstance(tickers, list):
        return jsonify({"error": "tickers debe ser un arreglo"}), 400
    if len(tickers) > 25:
        tickers = tickers[:25]

    try:
        return jsonify(_periodico.noticias_portafolio(tickers))
    except Exception as e:
        return jsonify({"error": f"fallo noticias portafolio: {e}"}), 500


# ------------------------------------------------------------
# REBALANCEO
# ------------------------------------------------------------
@app.route("/api/rebalanceo", methods=["POST"])
def api_rebalanceo():
    """
    Calcula el plan de rebalanceo.
    Body JSON: {
      "posiciones":    {"AAPL": 10, "MSFT": 5, ...},
      "target_pesos":  {"AAPL": 0.5, "MSFT": 0.5, ...},
      "monto_extra":   0,
      "solo_comprar":  false,
      "umbral_pp":     2.0
    }
    """
    if _rebalanceo is None:
        return jsonify({
            "error": "rebalanceo no cargado",
            "detalle": _rebalanceo_error
        }), 500

    body = request.get_json(silent=True) or {}
    posiciones    = body.get("posiciones") or {}
    target_pesos  = body.get("target_pesos") or {}
    monto_extra   = float(body.get("monto_extra") or 0)
    solo_comprar  = bool(body.get("solo_comprar") or False)
    umbral_pp     = float(body.get("umbral_pp") or 2.0)

    if not isinstance(posiciones, dict) or not isinstance(target_pesos, dict):
        return jsonify({"error": "posiciones y target_pesos deben ser objetos"}), 400

    try:
        res = _rebalanceo.calcular_rebalanceo(
            posiciones=posiciones,
            target_pesos=target_pesos,
            monto_extra=monto_extra,
            solo_comprar=solo_comprar,
            umbral_pp=umbral_pp,
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# TRACKING DE TRANSACCIONES
# ------------------------------------------------------------
@app.route("/api/transacciones/calcular", methods=["POST"])
def api_transacciones_calcular():
    """
    Calcula el snapshot del portafolio real a partir de las transacciones.
    Body JSON: {"transacciones": [ {ticker, tipo, fecha, shares, precio_unitario, moneda, comisiones}, ... ]}
    """
    if _transacciones is None:
        return jsonify({
            "error": "transacciones no cargado",
            "detalle": _transacciones_error
        }), 500

    body = request.get_json(silent=True) or {}
    txs = body.get("transacciones") or []

    if not isinstance(txs, list):
        return jsonify({"error": "transacciones debe ser una lista"}), 400

    if len(txs) > 1000:
        return jsonify({"error": "máximo 1000 transacciones por request"}), 400

    try:
        res = _transacciones.calcular_portafolio(txs)
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# IMPUESTOS (ISR MX + tax-loss harvesting)
# ------------------------------------------------------------
@app.route("/api/impuestos/calcular", methods=["POST"])
def api_impuestos_calcular():
    """
    Calcula ISR estimado a partir de transacciones reales y sugiere
    oportunidades de tax-loss harvesting.

    Body JSON: {
      "transacciones":    [ {ticker, tipo, fecha, shares, precio_unitario, ...} ],
      "incluir_harvest":  true  // opcional
    }
    """
    if _impuestos is None:
        return jsonify({
            "error": "impuestos no cargado",
            "detalle": _impuestos_error
        }), 500

    body = request.get_json(silent=True) or {}
    txs = body.get("transacciones") or []
    incluir_harvest = bool(body.get("incluir_harvest", True))

    if not isinstance(txs, list):
        return jsonify({"error": "transacciones debe ser una lista"}), 400

    if len(txs) > 1000:
        return jsonify({"error": "máximo 1000 transacciones por request"}), 400

    try:
        res = _impuestos.calcular_impuestos(txs, incluir_harvest=incluir_harvest)
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# METAS (Monte Carlo)
# ------------------------------------------------------------
@app.route("/api/metas/perfiles")
def api_metas_perfiles():
    """Perfiles preset de retorno/volatilidad para el slider."""
    if _metas is None:
        return jsonify({"error": "metas no cargado", "detalle": _metas_error}), 500
    try:
        return jsonify(_metas.listar_perfiles_retorno())
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


@app.route("/api/metas/simular", methods=["POST"])
def api_metas_simular():
    """
    Corre Monte Carlo y regresa distribución + probabilidad de meta.
    Body JSON:
    {
      "capital_inicial":      100000,
      "aporte_mensual":       5000,
      "horizonte_anos":       25,
      "retorno_anual":        0.08,
      "volatilidad_anual":    0.11,
      "inflacion_anual":      0.04,
      "meta_monto":           5000000,          // o meta_ingreso_mensual
      "meta_ingreso_mensual": null,
      "tasa_retiro_segura":   0.04,
      "num_simulaciones":     3000,
      "seed":                 null
    }
    """
    if _metas is None:
        return jsonify({"error": "metas no cargado", "detalle": _metas_error}), 500

    body = request.get_json(silent=True) or {}

    def _num(k, default=0.0):
        v = body.get(k)
        if v is None:
            return default
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    try:
        res = _metas.simular_meta(
            capital_inicial    = _num("capital_inicial",    0.0),
            aporte_mensual     = _num("aporte_mensual",     0.0),
            horizonte_anos     = _num("horizonte_anos",     20.0),
            retorno_anual      = _num("retorno_anual",      0.08),
            volatilidad_anual  = _num("volatilidad_anual",  0.11),
            inflacion_anual    = _num("inflacion_anual",    0.04),
            meta_monto         = _num("meta_monto",         0.0) or None,
            meta_ingreso_mensual = _num("meta_ingreso_mensual", 0.0) or None,
            tasa_retiro_segura = _num("tasa_retiro_segura", 0.04),
            num_simulaciones   = int(_num("num_simulaciones", 3000)),
            seed               = int(body["seed"]) if body.get("seed") is not None else None,
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# DIVIDENDOS (calendario + proyección de ingreso pasivo)
# ------------------------------------------------------------
@app.route("/api/dividendos/portafolio", methods=["POST"])
def api_dividendos_portafolio():
    """
    Analiza dividendos del portafolio.
    Body JSON admite tres modos (el primero que tenga datos válidos gana):
    {
      "posiciones": {"AAPL": {"shares": 10, "costo_promedio": 150}, ...},
      // o shares como float: {"AAPL": 10, "MSFT": 5}
      "tickers":    ["AAPL", "MSFT"],
      "pesos":      {"AAPL": 0.6, "MSFT": 0.4},
      "capital_supuesto": 100000,
      "anos_historia": 3,
      "meta_ingreso_mensual": 30000
    }
    """
    if _dividendos is None:
        return jsonify({"error": "dividendos no cargado", "detalle": _dividendos_error}), 500

    body = request.get_json(silent=True) or {}

    try:
        res = _dividendos.analizar_dividendos_portafolio(
            posiciones           = body.get("posiciones"),
            tickers              = body.get("tickers"),
            pesos                = body.get("pesos"),
            capital_supuesto     = float(body["capital_supuesto"]) if body.get("capital_supuesto") else None,
            anos_historia        = int(body.get("anos_historia") or 3),
            meta_ingreso_mensual = float(body["meta_ingreso_mensual"]) if body.get("meta_ingreso_mensual") else None,
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# ASISTENTE IA (Claude sobre el portafolio)
# ------------------------------------------------------------
@app.route("/api/asistente/estado", methods=["GET"])
def api_asistente_estado():
    """Regresa si el asistente está listo (API key configurada)."""
    if _asistente is None:
        return jsonify({
            "disponible": False,
            "error": "asistente no cargado",
            "detalle": _asistente_error,
        }), 200
    try:
        return jsonify(_asistente.estado_configuracion())
    except Exception as e:
        return jsonify({"disponible": False, "error": str(e)}), 200


@app.route("/api/asistente/chat", methods=["POST"])
def api_asistente_chat():
    """
    Body JSON:
    {
      "mensaje":   "¿qué tan diversificado estoy?",
      "historial": [{"role":"user"|"assistant", "content":"..."}, ...],
      "tickers":   ["AAPL", ...],
      "pesos":     {"AAPL":0.6, ...},
      "transacciones": [...]   // opcional
    }
    """
    if _asistente is None:
        return jsonify({"error": "asistente no cargado", "detalle": _asistente_error}), 500

    body = request.get_json(silent=True) or {}
    mensaje = (body.get("mensaje") or "").strip()
    if not mensaje:
        return jsonify({"error": "mensaje vacío"}), 400

    # Construir contexto del portafolio en el servidor combinando analizar + transacciones
    contexto: dict = {}
    tickers = body.get("tickers") or []
    pesos = body.get("pesos") or {}
    if tickers:
        contexto["tickers"] = list(tickers)
    if pesos:
        contexto["pesos"] = dict(pesos)

    # Métricas del portafolio (si hay tickers): reutiliza mi_portafolio.analizar
    try:
        if tickers and _mi_portafolio is not None:
            res_analisis = _mi_portafolio.analizar(
                list(tickers),
                dict(pesos) if pesos else None,
            )
            port = (res_analisis or {}).get("portafolio") or {}
            if port:
                contexto["portafolio_metrics"] = {
                    "rendimiento_anualizado_pct": port.get("rendimiento_anualizado_pct"),
                    "volatilidad_anual_pct":      port.get("volatilidad_anual_pct"),
                    "sharpe_ratio":               port.get("sharpe_ratio"),
                }
    except Exception:
        pass

    # Si hay transacciones, traer totales y P&L por ticker
    txs = body.get("transacciones")
    try:
        if txs and _transacciones is not None:
            res_tx = _transacciones.calcular_portafolio(txs)
            totales = (res_tx or {}).get("totales") or {}
            if totales:
                contexto["transacciones_totales"] = {
                    "invertido":      totales.get("invertido"),
                    "valor_actual":   totales.get("valor_actual"),
                    "pnl_absoluto":   totales.get("pnl_absoluto"),
                    "pnl_pct":        totales.get("pnl_pct"),
                }
            por_ticker = (res_tx or {}).get("por_ticker") or []
            if por_ticker:
                contexto["por_ticker"] = [
                    {
                        "ticker":          p.get("ticker"),
                        "shares_actuales": p.get("shares_actuales"),
                        "pnl_pct":         p.get("pnl_pct"),
                    }
                    for p in por_ticker
                ]
    except Exception:
        pass

    # Moneda mixta si hay tickers .MX y sin-sufijo
    if tickers:
        tiene_mx = any(str(t).upper().endswith(".MX") for t in tickers)
        tiene_us = any(not str(t).upper().endswith(".MX") for t in tickers)
        if tiene_mx and tiene_us:
            contexto["moneda_mixta"] = True

    try:
        out = _asistente.chat(
            mensaje=mensaje,
            historial=body.get("historial"),
            contexto_portafolio=contexto,
        )
        return jsonify(out)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# REPORTE MENSUAL PDF
# ------------------------------------------------------------
@app.route("/api/reporte/pdf", methods=["POST"])
def api_reporte_pdf():
    """
    Genera el PDF del reporte mensual.
    Body JSON:
    {
      "tickers":        ["AAPL", ...],
      "pesos":          {...},          // opcional
      "transacciones":  [...],          // opcional
      "mes":            4,              // 1..12 opcional
      "anio":           2026,           // opcional
      "nombre_usuario": "Charlie"       // opcional
    }
    """
    if _reporte_pdf is None:
        return jsonify({"error": "reporte_pdf no cargado", "detalle": _reporte_pdf_error}), 500

    from datetime import datetime as _dt
    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers") or []
    pesos   = body.get("pesos")  or {}
    txs     = body.get("transacciones") or []
    mes     = body.get("mes")
    anio    = body.get("anio")
    nombre  = (body.get("nombre_usuario") or "Inversionista").strip()

    datos: dict = {}

    # Métricas del portafolio
    try:
        if tickers and _mi_portafolio is not None:
            res_an = _mi_portafolio.analizar(list(tickers), dict(pesos) if pesos else None)
            port = (res_an or {}).get("portafolio") or {}
            if port:
                datos["portafolio_metrics"] = {
                    "rendimiento_anualizado_pct": port.get("rendimiento_anualizado_pct"),
                    "volatilidad_anual_pct":      port.get("volatilidad_anual_pct"),
                    "sharpe_ratio":               port.get("sharpe_ratio"),
                }
            # Insights del portafolio si vienen
            ins = (res_an or {}).get("insights") or []
            if ins:
                datos["insights"] = [
                    i.get("mensaje") if isinstance(i, dict) else str(i)
                    for i in ins if i
                ][:8]
    except Exception:
        pass

    # Totales y posiciones desde transacciones
    try:
        if txs and _transacciones is not None:
            res_tx = _transacciones.calcular_portafolio(txs)
            totales = (res_tx or {}).get("totales") or {}
            if totales:
                datos["totales"] = {
                    "invertido":    totales.get("invertido"),
                    "valor_actual": totales.get("valor_actual"),
                    "pnl_absoluto": totales.get("pnl_absoluto"),
                    "pnl_pct":      totales.get("pnl_pct"),
                }
            posiciones = (res_tx or {}).get("por_ticker") or []
            if posiciones:
                datos["posiciones"] = [
                    {
                        "ticker":          p.get("ticker"),
                        "shares_actuales": p.get("shares_actuales"),
                        "precio_actual":   p.get("precio_actual"),
                        "valor_actual":    p.get("valor_actual"),
                        "peso_pct":        p.get("peso_pct"),
                        "pnl_pct":         p.get("pnl_pct"),
                    }
                    for p in posiciones
                ]
    except Exception:
        pass

    # Movimientos del mes solicitado
    try:
        if txs:
            now = _dt.now()
            m_obj = int(mes or now.month)
            a_obj = int(anio or now.year)
            movs_mes = []
            for t in txs:
                fecha = (t.get("fecha") or "").strip()
                if not fecha or len(fecha) < 7:
                    continue
                try:
                    y, mo = int(fecha[:4]), int(fecha[5:7])
                except ValueError:
                    continue
                if y == a_obj and mo == m_obj:
                    movs_mes.append({
                        "fecha":           fecha,
                        "ticker":          t.get("ticker"),
                        "tipo":            t.get("tipo"),
                        "shares":          t.get("shares"),
                        "precio_unitario": t.get("precio_unitario"),
                    })
            datos["movimientos_mes"] = movs_mes
    except Exception:
        pass

    # Dividendos proyectados (reutiliza módulo si está)
    try:
        if _dividendos is not None and datos.get("posiciones"):
            posiciones_dict = {}
            for p in datos["posiciones"]:
                if p.get("shares_actuales") and p["shares_actuales"] > 0:
                    posiciones_dict[p["ticker"]] = {
                        "shares":         p["shares_actuales"],
                        "costo_promedio": p.get("precio_actual"),
                    }
            if posiciones_dict:
                res_div = _dividendos.analizar_dividendos_portafolio(posiciones=posiciones_dict)
                tot_div = (res_div or {}).get("totales") or {}
                if tot_div:
                    datos["dividendos"] = tot_div
    except Exception:
        pass

    try:
        pdf_bytes = _reporte_pdf.generar_reporte(
            datos, mes=mes, anio=anio, nombre_usuario=nombre
        )
        fname = _reporte_pdf.nombre_archivo_pdf(mes, anio)
        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{fname}"',
                "Content-Length":      str(len(pdf_bytes)),
            },
        )
    except Exception as e:
        return jsonify({"error": f"fallo generando PDF: {e}"}), 500


# ------------------------------------------------------------
# FUNDAMENTALES (P/E, yield, market cap, earnings, etc.)
# ------------------------------------------------------------
@app.route("/api/fundamentals/portafolio", methods=["POST"])
def api_fundamentals_portafolio():
    """
    Body JSON: {"tickers": ["AAPL", "MSFT", ...]}
    """
    if _fundamentals is None:
        return jsonify({"error": "fundamentals no cargado", "detalle": _fundamentals_error}), 500

    body = request.get_json(silent=True) or {}
    tickers = body.get("tickers") or []
    if not isinstance(tickers, list):
        return jsonify({"error": "tickers debe ser un arreglo"}), 400

    try:
        res = _fundamentals.analizar_fundamentales(tickers)
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# ANALIZADOR INDIVIDUAL (score 1-100 + Peer + Deep Dive + Short Report)
# ------------------------------------------------------------
@app.route("/api/analizar/<path:ticker>", methods=["GET"])
def api_analizar_ticker(ticker):
    if _analizador is None:
        return jsonify({"error": "analizador no cargado", "detalle": _analizador_error}), 500
    try:
        res = _analizador.analizar_accion(ticker)
        if not res.get("ok"):
            return jsonify(res), 404
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# DASHBOARD FINANCIERO POR ACCIÓN
# ------------------------------------------------------------
@app.route("/api/dashboard/<path:ticker>", methods=["GET"])
def api_dashboard(ticker):
    if _dashboard is None:
        return jsonify({"error": "dashboard no cargado", "detalle": _dashboard_error}), 500
    try:
        res = _dashboard.obtener_dashboard(ticker)
        if not res.get("ok"):
            return jsonify(res), 404
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# BACKTEST HISTÓRICO
# ------------------------------------------------------------
@app.route("/api/backtest", methods=["POST"])
def api_backtest():
    """Body JSON: {tickers: [...], pesos: {t:peso_pp}, periodo: "covid_full"|"custom",
       inicio?: "YYYY-MM-DD", fin?: "YYYY-MM-DD"}"""
    if _backtest is None:
        return jsonify({"error": "backtest no cargado", "detalle": _backtest_error}), 500
    body = request.get_json(silent=True) or {}
    try:
        res = _backtest.correr_backtest(
            tickers=body.get("tickers") or [],
            pesos=body.get("pesos") or {},
            periodo=body.get("periodo") or "completo",
            inicio=body.get("inicio"),
            fin=body.get("fin"),
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


@app.route("/api/backtest/periodos", methods=["GET"])
def api_backtest_periodos():
    if _backtest is None:
        return jsonify({"error": "backtest no cargado"}), 500
    return jsonify(_backtest.listar_periodos())


# ------------------------------------------------------------
# STRESS TEST
# ------------------------------------------------------------
@app.route("/api/stress-test", methods=["POST"])
def api_stress_test():
    """Body JSON: {tickers: [...], pesos: {t:peso_pp}, escenario: "covid_2020",
       montos?: {t: monto_mxn}}"""
    if _stress is None:
        return jsonify({"error": "stress_test no cargado", "detalle": _stress_error}), 500
    body = request.get_json(silent=True) or {}
    try:
        res = _stress.correr_stress_test(
            tickers=body.get("tickers") or [],
            pesos=body.get("pesos") or {},
            escenario=body.get("escenario") or "covid_2020",
            montos=body.get("montos"),
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


@app.route("/api/stress-test/escenarios", methods=["GET"])
def api_stress_escenarios():
    if _stress is None:
        return jsonify({"error": "stress no cargado"}), 500
    return jsonify(_stress.listar_escenarios())


# ------------------------------------------------------------
# BROKERS MX
# ------------------------------------------------------------
@app.route("/api/brokers-mx", methods=["GET"])
def api_brokers_mx():
    if _brokers is None:
        return jsonify({"error": "brokers no cargado"}), 500
    return jsonify({"brokers": _brokers.listar_brokers()})


@app.route("/api/brokers-mx/comparar/<path:ticker>", methods=["GET"])
def api_brokers_comparar(ticker):
    if _brokers is None:
        return jsonify({"error": "brokers no cargado"}), 500
    monto = float(request.args.get("monto", 10000))
    return jsonify({
        "ticker": ticker,
        "monto_mxn": monto,
        "comparativa": _brokers.comparar_para_ticker(ticker, monto),
    })


# ------------------------------------------------------------
# DECLARACIÓN SAT ANUAL
# ------------------------------------------------------------
@app.route("/api/sat/declaracion-anual", methods=["POST"])
def api_sat_declaracion():
    """Body JSON: {transacciones: [...], ejercicio: 2025}"""
    if _sat is None:
        return jsonify({"error": "sat no cargado", "detalle": _sat_error}), 500
    body = request.get_json(silent=True) or {}
    try:
        res = _sat.generar_declaracion_anual(
            transacciones=body.get("transacciones") or [],
            ejercicio=body.get("ejercicio"),
        )
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": f"fallo: {e}"}), 500


# ------------------------------------------------------------
# APORTACIONES RECURRENTES (DCA)
# ------------------------------------------------------------
@app.route("/api/aportaciones/simular", methods=["POST"])
def api_aportaciones_simular():
    """Body JSON: {monto_periodico, frecuencia, anios, retorno_anual_pct, inflacion_anual_pct, aporte_inicial}"""
    if _aportaciones is None:
        return jsonify({"error": "aportaciones no cargado"}), 500
    body = request.get_json(silent=True) or {}
    try:
        res = _aportaciones.simular_dca(
            monto_periodico=float(body.get("monto_periodico", 0)),
            frecuencia=body.get("frecuencia") or "mensual",
            anios=float(body.get("anios", 10)),
            retorno_anual_pct=float(body.get("retorno_anual_pct", 8.0)),
            inflacion_anual_pct=float(body.get("inflacion_anual_pct", 4.0)),
            aporte_inicial=float(body.get("aporte_inicial", 0)),
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo: {e}"}), 500


# ------------------------------------------------------------
# RENTA FIJA MX (FIBRAS + CETES)
# ------------------------------------------------------------
@app.route("/api/renta-fija/mx", methods=["GET"])
def api_renta_fija_mx():
    if _renta_fija is None:
        return jsonify({"error": "renta_fija no cargado", "detalle": _renta_fija_error}), 500
    try:
        return jsonify(_renta_fija.obtener_panel_renta_fija())
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


# ------------------------------------------------------------
# ALERTAS POR EMAIL
# ------------------------------------------------------------
@app.route("/api/alertas/estado", methods=["GET"])
def api_alertas_estado():
    if _alertas is None:
        return jsonify({"disponible": False, "error": _alertas_error}), 200
    return jsonify(_alertas.estado_configuracion())


@app.route("/api/alertas/preview", methods=["POST"])
def api_alertas_preview():
    """
    Construye el HTML de una alerta sin enviarla. Útil para previsualizar.
    Body JSON:
    {
      "tipo":    "drift" | "precio" | "semanal",
      "nombre":  "Charlie",
      "payload": {...}   // específico al tipo
    }
    """
    if _alertas is None:
        return jsonify({"error": "alertas no cargado", "detalle": _alertas_error}), 500

    body = request.get_json(silent=True) or {}
    try:
        res = _alertas.enviar_alerta(
            tipo=body.get("tipo") or "",
            destinatario=body.get("destinatario") or "preview@example.com",
            nombre=body.get("nombre") or "Inversionista",
            payload=body.get("payload") or {},
            dry_run=True,
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo inesperado: {e}"}), 500


@app.route("/api/portafolio/snapshot", methods=["POST"])
def api_portafolio_snapshot():
    """Guarda un snapshot del portafolio del usuario (tickers, pesos
    objetivo, posiciones, transacciones) en el backend para que las
    tareas programadas puedan calcular alertas sin necesidad del
    navegador. Body JSON con la estructura completa."""
    body = request.get_json(silent=True) or {}
    snap = {
        "actualizado":   datetime.now().isoformat(timespec="seconds"),
        "destinatario":  (body.get("destinatario") or "").strip(),
        "nombre":        body.get("nombre") or "Inversionista",
        "pesos_objetivo": body.get("pesos_objetivo") or {},
        "posiciones":    body.get("posiciones") or [],
        "transacciones": body.get("transacciones") or [],
        "metricas":      body.get("metricas") or {},
        "alertas_activas": body.get("alertas_activas") or {
            "drift": False, "precio": False, "semanal": False,
        },
    }
    try:
        ruta = Path(__file__).parent / "portafolio_snapshot.json"
        ruta.write_text(json.dumps(snap, indent=2, ensure_ascii=False), encoding="utf-8")
        return jsonify({"ok": True, "actualizado": snap["actualizado"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alertas/enviar", methods=["POST"])
def api_alertas_enviar():
    """
    Envía realmente el correo. Requiere SMTP_* configurado.
    Body JSON:
    {
      "tipo":          "drift" | "precio" | "semanal",
      "destinatario":  "user@email.com",
      "nombre":        "Charlie",
      "payload":       {...}
    }
    """
    if _alertas is None:
        return jsonify({"error": "alertas no cargado", "detalle": _alertas_error}), 500

    body = request.get_json(silent=True) or {}
    destinatario = (body.get("destinatario") or "").strip()
    if not destinatario or "@" not in destinatario:
        return jsonify({"error": "destinatario inválido"}), 400

    try:
        res = _alertas.enviar_alerta(
            tipo=body.get("tipo") or "",
            destinatario=destinatario,
            nombre=body.get("nombre") or "Inversionista",
            payload=body.get("payload") or {},
            dry_run=False,
        )
        return jsonify(res)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"fallo enviando email: {e}"}), 500


# ------------------------------------------------------------
# AUTH: magic-link + sesiones
# ------------------------------------------------------------
def _cookie_sesion(resp: Response, session_id: str, max_age: int) -> Response:
    resp.set_cookie(
        "session_id", session_id,
        max_age=max_age, httponly=True, samesite="Lax", path="/",
    )
    return resp


def _sesion_actual() -> Optional[dict]:
    if _auth is None:
        return None
    sid = request.cookies.get("session_id")
    return _auth.obtener_sesion(sid)


@app.route("/api/auth/estado")
def api_auth_estado():
    if _auth is None:
        return jsonify({"autenticado": False, "error": "auth no disponible"}), 200
    ses = _sesion_actual()
    if not ses:
        return jsonify({"autenticado": False}), 200
    return jsonify({
        "autenticado": True,
        "email": ses["email"],
        "usuario": ses.get("usuario", {}),
        "expira_en": ses["expira_en"],
    })


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    if _auth is None:
        return jsonify({"error": "auth no disponible"}), 500
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip()
    if not email or "@" not in email:
        return jsonify({"error": "email invalido"}), 400
    try:
        res = _auth.solicitar_magic_link(email)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/verify")
def api_auth_verify():
    if _auth is None:
        return jsonify({"error": "auth no disponible"}), 500
    token = request.args.get("token", "").strip()
    if not token:
        return jsonify({"error": "token requerido"}), 400
    try:
        res = _auth.verificar_token(token)
        # Redirige al front con la sesion ya puesta.
        redirect_url = "/static/index.html?bienvenido=1"
        resp = Response(
            f"<html><head><meta http-equiv='refresh' content='0;url={redirect_url}'></head>"
            f"<body>Sesion iniciada. Redirigiendo a <a href='{redirect_url}'>tu portafolio</a>...</body></html>",
            mimetype="text/html",
        )
        max_age = int(res["expira_en"] - __import__("time").time())
        return _cookie_sesion(resp, res["session_id"], max_age=max(60, max_age))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    if _auth is None:
        return jsonify({"error": "auth no disponible"}), 500
    sid = request.cookies.get("session_id")
    if sid:
        _auth.cerrar_sesion(sid)
    resp = jsonify({"ok": True})
    resp.set_cookie("session_id", "", max_age=0, path="/")
    return resp


# ------------------------------------------------------------
# PAGOS: MercadoPago preapproval ($79 MXN / mes)
# ------------------------------------------------------------
@app.route("/api/payments/estado")
def api_payments_estado():
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    return jsonify(_payments.estado_configuracion())


@app.route("/api/payments/suscribir", methods=["POST"])
def api_payments_suscribir():
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    ses = _sesion_actual()
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or (ses or {}).get("email") or "").strip().lower()
    if not email:
        return jsonify({"error": "email requerido (o inicia sesion antes)"}), 400
    try:
        return jsonify(_payments.crear_preapproval(email))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/payments/simular-aprobacion", methods=["POST"])
def api_payments_simular():
    """Solo util en mock mode / dev."""
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    body = request.get_json(silent=True) or {}
    pre_id = (body.get("preapproval_id") or "").strip()
    if not pre_id:
        return jsonify({"error": "preapproval_id requerido"}), 400
    try:
        return jsonify(_payments.simular_aprobacion(pre_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/payments/webhook", methods=["POST"])
def api_payments_webhook():
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    raw = request.get_data()
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    headers = {k: v for k, v in request.headers.items()}
    try:
        res = _payments.procesar_webhook(headers, raw, payload)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# Landing page publica (marketing) — se sirve en /landing.
@app.route("/landing")
def api_landing():
    index = FRONTEND_DIR / "landing.html"
    if not index.exists():
        return jsonify({"error": "landing.html no encontrado"}), 404
    return send_from_directory(str(FRONTEND_DIR), "landing.html")


@app.route("/signup")
def api_signup_page():
    index = FRONTEND_DIR / "signup.html"
    if not index.exists():
        return jsonify({"error": "signup.html no encontrado"}), 404
    return send_from_directory(str(FRONTEND_DIR), "signup.html")


# ------------------------------------------------------------
# Arranque
# ------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("  Portafolio App - Servidor de desarrollo")
    print("=" * 60)
    print(f"  Backend:  {BACKEND_DIR}")
    print(f"  Frontend: {FRONTEND_DIR}")
    print(f"  Abre:     http://127.0.0.1:5001")
    print("=" * 60)
    # macOS usa el puerto 5000 para AirPlay Receiver, por eso usamos 5001.
    app.run(host="127.0.0.1", port=5001, debug=True)
