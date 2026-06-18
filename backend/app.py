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

# ── Compresión gzip/brotli automática (reduce JSON/HTML ~70-85%) ──
try:
    from flask_compress import Compress
    # Configuración: comprimir JSON, HTML, JS, CSS, SVG; mínimo 500 bytes
    app.config["COMPRESS_MIMETYPES"] = [
        "application/json", "text/html", "text/css", "text/xml",
        "application/javascript", "application/xml", "image/svg+xml",
    ]
    app.config["COMPRESS_LEVEL"] = 6
    app.config["COMPRESS_MIN_SIZE"] = 500
    Compress(app)
    print("✓ flask-compress activo (gzip/brotli)")
except Exception as _e:
    print(f"⚠ flask-compress no disponible: {_e}")

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
# Memoria: gc.collect() después de requests pesadas (free tier 512 MB)
# Las rutas que cargan pandas DataFrames grandes generan basura que no
# se libera por default. Forzar GC reduce los OOM kills de Render.
# ------------------------------------------------------------
import gc as _gc
_PESADAS = ("/api/analizar", "/api/backtest", "/api/stress-test",
            "/api/perfiles", "/api/universo", "/api/explorar",
            "/api/rebalanceo", "/api/dividendos", "/api/fundamentals",
            "/api/dashboard", "/api/reporte/pdf", "/api/alertas/enviar",
            "/api/cron/")

@app.after_request
def _gc_after_heavy(response):
    try:
        path = request.path or ""
        if any(path.startswith(p) for p in _PESADAS):
            _gc.collect()
    except Exception:
        pass
    return response


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


# ── CRON externo (cron-job.org gratis) ──────────────────────────
# Endpoints protegidos para disparar las tareas programadas desde
# servicios externos como cron-job.org, UptimeRobot Pings, etc.
# Configurar variable CRON_SECRET en Render con un string random.
import os as _os_cron
import json as _json_cron
import subprocess as _sub_cron
from pathlib import Path as _Path_cron

CRON_SECRET = _os_cron.environ.get("CRON_SECRET", "")


def _check_cron_auth(req) -> bool:
    """Verifica el bearer token o query param `secret`."""
    if not CRON_SECRET:
        return False
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and auth[7:] == CRON_SECRET:
        return True
    if req.args.get("secret") == CRON_SECRET:
        return True
    return False


@app.route("/api/_keepalive", methods=["GET", "HEAD"])
def api_keepalive():
    """Ping ultra-ligero para evitar que Render free duerma.
    Llamar cada 10 min desde cron-job.org (sin secret necesario, es read-only)."""
    import time as _t
    return jsonify({"ok": True, "ts": int(_t.time()), "service": "miportafolio"}), 200


# Estado global del warmup (compartido entre request handler y background thread)
import threading as _threading_warmup
_warmup_lock = _threading_warmup.Lock()
_warmup_estado = {
    "corriendo":       False,
    "iniciado_ts":     None,
    "terminado_ts":    None,
    "duracion_seg":    None,
    "endpoints_ok":    0,
    "endpoints_total": 0,
    "detalle":         {},
    "ultimo_error":    None,
}


def _ejecutar_warmup_blocking():
    """Hace TODO el warmup en orden. Llamado en background thread."""
    import time as _t
    t0 = _t.time()
    resultados = {}

    with _warmup_lock:
        _warmup_estado["corriendo"]    = True
        _warmup_estado["iniciado_ts"]  = int(t0)
        _warmup_estado["terminado_ts"] = None
        _warmup_estado["detalle"]      = {}

    def _paso(nombre, fn):
        ts_paso = _t.time()
        try:
            r = fn()
            resultados[nombre] = r if isinstance(r, dict) else {"ok": bool(r)}
        except Exception as e:
            resultados[nombre] = {"ok": False, "error": str(e)}
        # Publicar progreso parcial cada paso
        with _warmup_lock:
            _warmup_estado["detalle"][nombre] = {
                **resultados[nombre],
                "duracion_seg": round(_t.time() - ts_paso, 2),
            }

    # 1) Resumen del día
    def _r1():
        import periodico as _p
        d = _p.resumen_diario()
        return {"ok": bool(d), "size": len(str(d))}
    _paso("resumen", _r1)

    # 2) Mercados (lo más pesado: indices US + mundo + divisas + commodities + tasas + crypto + sectores)
    def _r2():
        import periodico as _p
        d = _p.mercados_dashboard()
        return {"ok": bool(d), "size": len(str(d or ""))}
    _paso("mercados", _r2)

    # 3) Noticias top
    def _r3():
        import periodico as _p
        d = _p.noticias_top(12)
        return {"ok": bool(d), "n": len(d) if d else 0}
    _paso("noticias", _r3)

    # 4) Top movers — 3 períodos
    for periodo in ("dia", "semana", "mes"):
        def _rm(p=periodo):
            import top_movers as _tm
            d = _tm.top_movers(p, 3)
            return {"ok": d.get("ok", False)}
        _paso(f"movers_{periodo}", _rm)

    # 5) Acción del día
    def _r5():
        import accion_del_dia as _ad
        d = _ad.accion_del_dia()
        return {
            "ok":     d.get("ok", False),
            "ticker": d.get("accion", {}).get("ticker") if d.get("ok") else None,
        }
    _paso("accion_dia", _r5)

    # 6) Portafolio óptimo nivel 5 (el default que el frontend carga al abrir).
    #    Calienta también el cache en memoria del DataFrame de precios, que
    #    comparten Acción del Día y el optimizador.
    def _r6():
        import portafolio_optimo as _po
        d = _po.portafolio_optimo(nivel_riesgo=5)
        return {"ok": d.get("ok", False), "n": len(d.get("acciones", [])) if d.get("ok") else 0}
    _paso("portafolio_optimo_5", _r6)

    # Resumen final
    elapsed = round(_t.time() - t0, 2)
    ok_count = sum(1 for r in resultados.values() if r.get("ok"))
    with _warmup_lock:
        _warmup_estado["corriendo"]       = False
        _warmup_estado["terminado_ts"]    = int(_t.time())
        _warmup_estado["duracion_seg"]    = elapsed
        _warmup_estado["endpoints_ok"]    = ok_count
        _warmup_estado["endpoints_total"] = len(resultados)


def _lanzar_warmup_background():
    """Lanza warmup en background si no hay otro corriendo."""
    with _warmup_lock:
        if _warmup_estado["corriendo"]:
            return False
        _warmup_estado["corriendo"] = True   # claim antes de soltar el lock
    th = _threading_warmup.Thread(target=_ejecutar_warmup_blocking,
                                   daemon=True, name="warmup-worker")
    th.start()
    return True


@app.route("/api/_warmup", methods=["GET", "POST"])
def api_warmup():
    """Pre-calienta el cache de todos los endpoints pesados del periódico.

    Por default es FIRE-AND-FORGET: responde 200 OK en <100ms y ejecuta el
    warmup en background. Esto evita el timeout de 30s de cron-job.org.

    Pasa ?wait=1 para esperar al resultado (útil para debugging local).

    Auth: ?secret=<CRON_SECRET> o Authorization: Bearer <CRON_SECRET>
    """
    if not _check_cron_auth(request):
        return jsonify({"error": "unauthorized"}), 401

    esperar = (request.args.get("wait") or "").lower() in ("1", "true", "yes")

    if esperar:
        # Modo síncrono (solo para debugging)
        _ejecutar_warmup_blocking()
        with _warmup_lock:
            return jsonify({
                "ok":              True,
                "modo":            "sincrono",
                "endpoints_ok":    _warmup_estado["endpoints_ok"],
                "endpoints_total": _warmup_estado["endpoints_total"],
                "duracion_seg":    _warmup_estado["duracion_seg"],
                "detalle":         _warmup_estado["detalle"],
            })

    # Modo fire-and-forget (default)
    lanzado = _lanzar_warmup_background()
    with _warmup_lock:
        return jsonify({
            "ok":        True,
            "modo":      "background",
            "lanzado":   lanzado,
            "ya_corria": not lanzado,
            "mensaje":   ("Warmup encolado en background — consultar progreso en /api/_warmup/status"
                          if lanzado else
                          "Warmup ya estaba corriendo — consultar /api/_warmup/status"),
        })


@app.route("/api/_warmup/status", methods=["GET"])
def api_warmup_status():
    """Consulta el estado del último warmup (público — sin secret)."""
    with _warmup_lock:
        return jsonify(dict(_warmup_estado))


# Lanzar UN warmup al arrancar el server (con delay para no bloquear el boot)
def _warmup_inicial():
    import time as _t
    _t.sleep(5)   # esperar 5s para que el server termine de arrancar
    try:
        _ejecutar_warmup_blocking()
        print("✓ warmup inicial completado")
    except Exception as e:
        print(f"⚠ warmup inicial falló: {e}")


try:
    _threading_warmup.Thread(target=_warmup_inicial, daemon=True,
                              name="warmup-inicial").start()
    print("✓ warmup inicial encolado (corre en 5s)")
except Exception as _e:
    print(f"⚠ no pude encolar warmup inicial: {_e}")


@app.route("/api/cron/<tipo>", methods=["GET", "POST"])
def api_cron_dispatch(tipo):
    """Despacha una tarea programada. Tipos válidos: drift, precio, semanal.

    Auth: header `Authorization: Bearer <CRON_SECRET>` o ?secret=<CRON_SECRET>.
    """
    if not _check_cron_auth(request):
        return jsonify({"error": "unauthorized"}), 401

    tipo = (tipo or "").strip().lower()

    # Pre-carga de acciones mexicanas (.MX) al caché de BD. Tarda ~2 min (más que
    # el timeout HTTP), así que corre en segundo plano y respondemos de inmediato.
    if tipo in ("prewarm-mx", "prewarm_mx", "mx-backup"):
        import threading
        script_mx = _Path_cron(__file__).parent / "actualizar_mx_backup.py"
        def _run_prewarm():
            try:
                _sub_cron.run(["python3", str(script_mx)],
                              cwd=str(_Path_cron(__file__).parent), timeout=1800)
            except Exception:
                pass
        threading.Thread(target=_run_prewarm, daemon=True).start()
        return jsonify({"ok": True, "tipo": "prewarm-mx", "status": "iniciado en segundo plano"}), 202

    if tipo not in ("drift", "precio", "semanal", "periodico", "newsletter", "newsletter_semanal"):
        return jsonify({"error": f"tipo desconocido: {tipo}",
                        "validos": ["drift", "precio", "semanal", "periodico", "newsletter"]}), 400

    # Verificar que existe el snapshot del usuario (escrito por el frontend)
    snap_path = _Path_cron(__file__).parent / "portafolio_snapshot.json"
    if not snap_path.exists():
        return jsonify({"ok": True, "skipped": True,
                        "razon": "no hay snapshot del portafolio aún"}), 200

    # Verificar que esta alerta está activada en el snapshot
    try:
        with open(snap_path, encoding="utf-8") as f:
            snap = _json_cron.load(f)
        activas = snap.get("alertas_activas") or {}
        if not activas.get(tipo, False):
            return jsonify({"ok": True, "skipped": True,
                            "razon": f"alerta '{tipo}' desactivada por el usuario"}), 200
    except Exception as e:
        return jsonify({"error": f"no se pudo leer snapshot: {e}"}), 500

    # Disparar el script CLI
    try:
        script = _Path_cron(__file__).parent / "enviar_alerta_programada.py"
        result = _sub_cron.run(
            ["python3", str(script), tipo],
            capture_output=True, text=True, timeout=45,
            cwd=str(_Path_cron(__file__).parent),
        )
        return jsonify({
            "ok":        result.returncode == 0,
            "tipo":      tipo,
            "exit_code": result.returncode,
            "stdout":    result.stdout[-1000:],  # últimas 1000 chars
            "stderr":    result.stderr[-500:],
        }), 200 if result.returncode == 0 else 500
    except _sub_cron.TimeoutExpired:
        return jsonify({"error": "timeout en script de alerta"}), 504
    except Exception as e:
        return jsonify({"error": f"fallo ejecutando: {e}"}), 500


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


# ── SEO: robots.txt y sitemap.xml en raíz ────────────────────────
@app.route("/robots.txt")
def seo_robots():
    return send_from_directory(str(FRONTEND_DIR), "robots.txt", mimetype="text/plain")


@app.route("/sitemap.xml")
def seo_sitemap():
    return send_from_directory(str(FRONTEND_DIR), "sitemap.xml", mimetype="application/xml")


# ── Verificación de propiedad: Google Search Console y Bing ──────
# Archivos tipo google<hash>.html o BingSiteAuth.xml en raíz
@app.route("/<path:filename>")
def archivo_raiz(filename):
    """Sirve archivos de verificación (Google/Bing) en la raíz del sitio.
    Solo permite la whitelist específica."""
    if not (filename.startswith("google") and filename.endswith(".html")) \
       and filename not in ("BingSiteAuth.xml",):
        abort(404)
    ruta = FRONTEND_DIR / filename
    if not ruta.exists() or not ruta.is_file():
        abort(404)
    # Mime type correcto según el archivo
    if filename.endswith(".xml"):
        return send_from_directory(str(FRONTEND_DIR), filename, mimetype="application/xml")
    return send_from_directory(str(FRONTEND_DIR), filename)


# ── Páginas legales ─────────────────────────────────────────────
@app.route("/terminos")
def pagina_terminos():
    return send_from_directory(str(FRONTEND_DIR), "terminos.html")


@app.route("/privacidad")
def pagina_privacidad():
    return send_from_directory(str(FRONTEND_DIR), "privacidad.html")


# ── Blog ────────────────────────────────────────────────────────
@app.route("/blog")
@app.route("/blog/")
def blog_index():
    return send_from_directory(str(FRONTEND_DIR / "blog"), "index.html")


@app.route("/blog/_styles.css")
def blog_styles():
    """CSS compartido para todos los posts del blog."""
    return send_from_directory(str(FRONTEND_DIR / "blog"), "_styles.css", mimetype="text/css")


@app.route("/blog/<slug>")
def blog_post(slug):
    """Sirve un post de blog por slug. Solo permite caracteres seguros."""
    import re as _re
    if not _re.match(r"^[a-z0-9-]{1,100}$", slug):
        abort(404)
    ruta = FRONTEND_DIR / "blog" / f"{slug}.html"
    if not ruta.exists():
        abort(404)
    return send_from_directory(str(FRONTEND_DIR / "blog"), f"{slug}.html")


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
    # Cuántos resultados quiere el cliente
    limite = int(request.args.get("limite") or 25)
    limite = max(5, min(50, limite))

    try:
        resultados = _mi_portafolio.buscar_ticker(q, limite=limite)
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


@app.route("/api/periodico/mercados")
def api_periodico_mercados():
    """Dashboard completo estilo Yahoo Markets: índices US + mundo + FX +
    commodities + crypto + tasas/VIX + sectores. Una sola request."""
    if _periodico is None:
        return jsonify({"error": "periodico no cargado"}), 500
    try:
        return jsonify(_periodico.mercados_dashboard())
    except Exception as e:
        return jsonify({"error": f"fallo mercados: {e}"}), 500


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

    # Métricas + insights: preferir lo que el frontend YA mandó (evita re-descargar
    # de yfinance, que es lento/frágil y colgaba el endpoint). Recalcular solo si falta.
    if body.get("portafolio_metrics"):
        datos["portafolio_metrics"] = body["portafolio_metrics"]
    if body.get("insights"):
        datos["insights"] = [
            (i.get("mensaje") if isinstance(i, dict) else str(i)) for i in body["insights"] if i
        ][:12]
    if "portafolio_metrics" not in datos:
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
                if "insights" not in datos:
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

    # --- Datos extra para el PDF profesional (todos opcionales) ---
    # Si el frontend ya envió estos datos en el body, usarlos. Si no, intentar
    # generarlos a partir del análisis del portafolio.
    if body.get("comportamiento"):
        datos["comportamiento"] = body["comportamiento"]
    if body.get("concentracion"):
        datos["concentracion"] = body["concentracion"]
    if body.get("fundamentales"):
        datos["fundamentales"] = body["fundamentales"]
    if body.get("fiscal"):
        datos["fiscal"] = body["fiscal"]
    if body.get("benchmarks"):
        datos["benchmarks"] = body["benchmarks"]

    # Si el análisis del portafolio ya generó concentración, también pasarla
    try:
        if tickers and _mi_portafolio is not None and "concentracion" not in datos:
            # Re-extraer del análisis previo si está
            res_an_again = _mi_portafolio.analizar(list(tickers), dict(pesos) if pesos else None)
            conc = (res_an_again or {}).get("concentracion") or {}
            if conc:
                datos["concentracion"] = {
                    "por_sector": conc.get("por_sector"),
                    "por_pais":   conc.get("por_pais"),
                    "por_moneda": conc.get("por_moneda"),
                }
    except Exception:
        pass

    # Fundamentales agregados si fundamentals.py disponible
    try:
        if _fundamentals is not None and tickers and "fundamentales" not in datos:
            res_fund = _fundamentals.analizar_fundamentales(list(tickers))
            resumen_fund = (res_fund or {}).get("resumen") or {}
            if resumen_fund:
                datos["fundamentales"] = resumen_fund
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


@app.route("/api/push/public-key", methods=["GET"])
def api_push_public_key():
    """Devuelve la VAPID public key (necesaria para PushManager.subscribe)."""
    try:
        import push as _push
        return jsonify({
            "ok":           _push.vapid_disponible(),
            "public_key":   _push.vapid_public_key(),
            "disponible":   _push.vapid_disponible(),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/push/subscribe", methods=["POST"])
def api_push_subscribe():
    """Body: {email, subscription} → guarda la suscripción del browser."""
    try:
        import push as _push
        body = request.get_json(silent=True) or {}
        email = (body.get("email") or "").strip().lower()
        if not email or "@" not in email:
            return jsonify({"ok": False, "error": "email requerido"}), 400
        sub = body.get("subscription") or {}
        ua = request.headers.get("User-Agent", "")[:200]
        res = _push.guardar_suscripcion(email, sub, ua)
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": f"subscribe fallo: {e}"}), 500


@app.route("/api/push/unsubscribe", methods=["POST"])
def api_push_unsubscribe():
    """Body: {email, endpoint} → marca la suscripción como inactiva."""
    try:
        import push as _push
        body = request.get_json(silent=True) or {}
        email = (body.get("email") or "").strip().lower()
        endpoint = body.get("endpoint")
        if not email or not endpoint:
            return jsonify({"ok": False, "error": "email y endpoint requeridos"}), 400
        ok = _push.eliminar_suscripcion(email, endpoint)
        return jsonify({"ok": ok})
    except Exception as e:
        return jsonify({"ok": False, "error": f"unsubscribe fallo: {e}"}), 500


@app.route("/api/push/test", methods=["POST"])
def api_push_test():
    """Body: {email, titulo?, body?} → manda push de prueba."""
    try:
        import push as _push
        body = request.get_json(silent=True) or {}
        email = (body.get("email") or "").strip().lower()
        if not email:
            return jsonify({"ok": False, "error": "email requerido"}), 400
        res = _push.enviar_notificacion(
            email=email,
            titulo=body.get("titulo") or "🚀 Push funcionando",
            body=body.get("body") or "Tu Mi Portafolio puede mandarte notificaciones ahora.",
            url=body.get("url") or "/",
        )
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": f"push test fallo: {e}"}), 500


@app.route("/api/backups", methods=["GET", "POST"])
def api_backups():
    """Cloud backups del portafolio.
    POST {email, snapshot, nombre?, automatico?} → crea backup
    GET ?email=... → lista metadata de backups"""
    try:
        import backups as _bk
        if request.method == "POST":
            body = request.get_json(silent=True) or {}
            email = (body.get("email") or "").strip().lower()
            if not email or "@" not in email:
                return jsonify({"ok": False, "error": "email requerido"}), 400
            snap = body.get("snapshot") or {}
            res = _bk.crear_backup(
                email=email,
                snapshot=snap,
                nombre=body.get("nombre"),
                automatico=bool(body.get("automatico", False)),
            )
            # Limpiar viejos automáticamente
            try: _bk.limpiar_antiguos(email)
            except Exception: pass
            return jsonify({"ok": True, **res})
        else:
            email = (request.args.get("email") or "").strip().lower()
            if not email or "@" not in email:
                return jsonify({"ok": False, "error": "email requerido"}), 400
            backups = _bk.listar_backups(email, limit=30)
            return jsonify({"ok": True, "total": len(backups), "backups": backups})
    except Exception as e:
        return jsonify({"ok": False, "error": f"backup fallo: {e}"}), 500


@app.route("/api/backups/<backup_id>", methods=["GET", "DELETE"])
def api_backup_single(backup_id):
    """GET → devuelve snapshot completo. DELETE → elimina backup."""
    try:
        import backups as _bk
        email = (request.args.get("email") or "").strip().lower()
        if not email or "@" not in email:
            return jsonify({"ok": False, "error": "email requerido"}), 400
        if request.method == "DELETE":
            ok = _bk.eliminar_backup(backup_id, email)
            return jsonify({"ok": ok})
        else:
            data = _bk.obtener_backup(backup_id, email)
            if not data:
                return jsonify({"ok": False, "error": "backup no encontrado"}), 404
            return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "error": f"backup op fallo: {e}"}), 500


@app.route("/api/alertas/evaluar-reglas", methods=["POST"])
def api_alertas_evaluar_reglas():
    """Evalúa una lista de reglas multi-condición contra el snapshot + precios.
    Body: {reglas: [...], precios_actuales?: {...}}
    Devuelve qué reglas se disparan ahora."""
    try:
        import alertas_avanzadas as _aa
        body = request.get_json(silent=True) or {}
        reglas = body.get("reglas") or []
        precios = body.get("precios_actuales") or {}
        snap_path = _Path_cron(__file__).parent / "portafolio_snapshot.json"
        snap = {}
        if snap_path.exists():
            with open(snap_path, encoding="utf-8") as f:
                snap = _json_cron.load(f)
        ctx = _aa.construir_contexto_desde_snapshot(snap, precios)
        disparadas = _aa.evaluar_reglas(reglas, ctx)
        return jsonify({
            "ok":         True,
            "total":      len(reglas),
            "disparadas": disparadas,
            "contexto":   ctx,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"eval reglas fallo: {e}"}), 500


@app.route("/api/screener", methods=["POST"])
def api_screener():
    """Filtra el universo de tickers por múltiples criterios.
    Body: {tipo, mercado, sector, pe_min, pe_max, yield_min, yield_max,
           beta_min, beta_max, market_cap_min, market_cap_max,
           retorno_1y_min, solo_recomendadas, limit}"""
    try:
        import screener as _sc
        criterios = request.get_json(silent=True) or {}
        resultados = _sc.filtrar(criterios)
        return jsonify({"ok": True, "total": len(resultados), "resultados": resultados})
    except Exception as e:
        return jsonify({"ok": False, "error": f"screener fallo: {e}"}), 500


@app.route("/api/optimizador-fiscal", methods=["POST"])
def api_optimizador_fiscal():
    """Calcula el plan óptimo de venta para minimizar ISR.
    Body: {transacciones, precios_actuales, monto_a_vender_mxn, ano_fiscal, perdidas_anteriores?}"""
    try:
        import optimizador_fiscal as _of
        body = request.get_json(silent=True) or {}
        result = _of.optimizar_venta(
            transacciones        = body.get("transacciones") or [],
            precios_actuales     = body.get("precios_actuales") or {},
            monto_a_vender_mxn   = float(body.get("monto_a_vender_mxn") or 0),
            ano_fiscal           = int(body.get("ano_fiscal") or 2026),
            perdidas_anteriores  = float(body.get("perdidas_anteriores") or 0),
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"ok": False, "error": f"optimizador fallo: {e}"}), 500


@app.route("/api/sml/<path:ticker>", methods=["GET"])
def api_sml(ticker):
    """Evalúa el ticker contra la Security Market Line (CAPM).
    Devuelve beta, retorno esperado SML, alpha y veredicto."""
    try:
        import sml as _sml
        return jsonify(_sml.evaluar_sml(ticker))
    except Exception as e:
        return jsonify({"ok": False, "error": f"SML fallo: {e}"}), 500


@app.route("/api/periodico/top-movers", methods=["GET"])
def api_periodico_top_movers():
    """Top tickers por ganadores, perdedores y populares del periodo.
    Query: ?periodo=dia|semana|mes&n=3"""
    try:
        import top_movers as _tm
        periodo = (request.args.get("periodo") or "dia").lower()
        n = int(request.args.get("n", 3))
        return jsonify(_tm.top_movers(periodo, n))
    except Exception as e:
        return jsonify({"ok": False, "error": f"top movers fallo: {e}"}), 500


@app.route("/api/precios-live", methods=["GET", "POST"])
def api_precios_live():
    """Precios cuasi-live para una lista de tickers.
    GET  ?tickers=AAPL,TSLA,...
    POST {"tickers": ["AAPL", ...]}
    Cache 30s con mercados abiertos, 1h con mercados cerrados."""
    try:
        import precios_live as _pl
        if request.method == "POST":
            body = request.get_json(silent=True) or {}
            tickers = body.get("tickers") or []
        else:
            raw = request.args.get("tickers") or ""
            tickers = [t for t in raw.split(",") if t.strip()]
        return jsonify(_pl.precios_live(tickers))
    except Exception as e:
        return jsonify({"ok": False, "error": f"precios live falló: {e}"}), 500


@app.route("/api/portafolio-optimo", methods=["GET"])
def api_portafolio_optimo():
    """Genera portafolio óptimo Markowitz para nivel de riesgo (1-10).
    ?nivel=5 → balanceado. Cache 6h."""
    try:
        import portafolio_optimo as _po
        forzar = (request.args.get("forzar") or "").lower() in ("1", "true", "yes")
        vol = request.args.get("vol")
        if vol not in (None, ""):
            return jsonify(_po.portafolio_optimo(vol_objetivo=float(vol), forzar=forzar))
        nivel = int(request.args.get("nivel") or 5)
        return jsonify(_po.portafolio_optimo(nivel_riesgo=nivel, forzar=forzar))
    except Exception as e:
        return jsonify({"ok": False, "error": f"portafolio optimo falló: {e}"}), 500


@app.route("/api/historico/<ticker>", methods=["GET"])
def api_historico(ticker):
    """Serie de cierres de un ticker. Primero del universo local; si no está,
    cae a Yahoo Finance (universo extendido), como el resto de la app.
    ?rango=1M|3M|6M|1A|5A|MAX  ·  ?puntos=N para muestrear (sparklines)."""
    try:
        import accion_del_dia as _ad
        df = _ad._cargar_precios()
        ticker = (ticker or "").strip().upper()
        rango = (request.args.get("rango") or "1A").upper()
        dias = {"1M": 21, "3M": 63, "6M": 126, "1A": 252, "5A": 252 * 5, "MAX": 10 ** 9}.get(rango, 252)
        if df is not None and ticker in df.columns:
            s = df[ticker].dropna().iloc[-dias:]
        else:
            # Fallback a Yahoo Finance con reintentos (universo extendido)
            import sml as _sml
            period = {"1M": "1mo", "3M": "3mo", "6M": "6mo", "1A": "1y",
                      "5A": "5y", "MAX": "max"}.get(rango, "1y")
            s = _sml._descargar_close(ticker, period=period)
            if s is None or len(s) == 0:
                return jsonify({"ok": False, "error": "ticker no encontrado en el universo ni en Yahoo"}), 404
            s = s.dropna()
        # Muestreo opcional para sparklines (menos puntos = payload chico)
        try:
            puntos = int(request.args.get("puntos") or 0)
        except ValueError:
            puntos = 0
        if puntos and len(s) > puntos:
            paso = max(1, len(s) // puntos)
            s = s.iloc[::paso]
        return jsonify({
            "ok":      True,
            "ticker":  ticker,
            "rango":   rango,
            "fechas":  [d.strftime("%Y-%m-%d") for d in s.index],
            "precios": [round(float(v), 4) for v in s.values],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"histórico falló: {e}"}), 500


@app.route("/api/ranking", methods=["GET"])
def api_ranking():
    """Universo curado ordenado por score canónico (mayor a menor)."""
    try:
        import accion_del_dia as _ad
        n = int(request.args.get("n") or 60)
        return jsonify({"ok": True, "items": _ad.ranking(n=n)})
    except Exception as e:
        return jsonify({"ok": False, "error": f"ranking falló: {e}"}), 500


@app.route("/api/periodico/sectores", methods=["GET"])
def api_periodico_sectores():
    """Performance de los sectores USA (ETFs SPDR) sobre el periodo pedido,
    calculada desde el universo local. ?periodo=dia|semana|mes|anio."""
    try:
        import accion_del_dia as _ad
        import periodico as _p
        periodo = (request.args.get("periodo") or "dia").lower()
        dias = {"dia": 1, "semana": 5, "mes": 21, "anio": 252}.get(periodo, 1)
        df = _ad._cargar_precios()
        out = []
        if df is not None:
            for s in _p.SECTORES_US:
                t = s["ticker"]
                if t not in df.columns:
                    continue
                serie = df[t].dropna()
                if len(serie) < dias + 1:
                    continue
                cambio = (float(serie.iloc[-1]) / float(serie.iloc[-dias - 1]) - 1) * 100
                out.append({
                    "ticker":     t,
                    "nombre":     s["nombre"],
                    "etiqueta":   s["etiqueta"],
                    "cambio_pct": round(cambio, 2),
                })
        out.sort(key=lambda x: x["cambio_pct"], reverse=True)
        return jsonify({"ok": True, "periodo": periodo, "sectores": out})
    except Exception as e:
        return jsonify({"ok": False, "error": f"sectores falló: {e}"}), 500


@app.route("/api/watchlist", methods=["POST"])
def api_watchlist():
    """Datos para la lista de seguimiento: último precio, cambio del día y
    sparkline (últimos ~30 cierres) — desde el universo local, sin yfinance.
    Body: {tickers: [...]}."""
    try:
        import accion_del_dia as _ad
        body = request.get_json(silent=True) or {}
        tickers = [str(t).strip().upper() for t in (body.get("tickers") or []) if t][:50]
        df = _ad._cargar_precios()
        info = _ad._cargar_info()
        out = []
        if df is not None and tickers:
            for t in tickers:
                if t not in df.columns:
                    continue
                s = df[t].dropna()
                if len(s) < 2:
                    continue
                precio = float(s.iloc[-1])
                prev = float(s.iloc[-2])
                cambio = (precio / prev - 1) * 100 if prev else 0.0
                sp = s.iloc[-30:]
                paso = max(1, len(sp) // 20)
                meta = info.get(t, {})
                out.append({
                    "ticker":     t,
                    "nombre":     meta.get("nombre") or t,
                    "precio":     round(precio, 2),
                    "cambio_pct": round(cambio, 2),
                    "moneda":     meta.get("moneda") or ("MXN" if t.endswith(".MX") else "USD"),
                    "spark":      [round(float(v), 4) for v in sp.iloc[::paso].values],
                })
        return jsonify({"ok": True, "items": out})
    except Exception as e:
        return jsonify({"ok": False, "error": f"watchlist falló: {e}"}), 500


@app.route("/api/score/<path:ticker>", methods=["GET"])
def api_score_ticker(ticker):
    """Devuelve el score canónico para UN ticker.
    Misma metodología que se usa en Acción del Día → coincide siempre."""
    try:
        import accion_del_dia as _ad
        d = _ad.score_para_ticker((ticker or "").strip().upper())
        if d is None:
            return jsonify({"ok": False, "error": f"No se pudo puntuar {ticker} (sin historia o fuera del universo)"})
        return jsonify({"ok": True, **d})
    except Exception as e:
        return jsonify({"ok": False, "error": f"score falló: {e}"}), 500


@app.route("/api/periodico/accion-del-dia", methods=["GET"])
def api_periodico_accion_del_dia():
    """Selecciona la "Acción del día" con score compuesto:
    SML alpha + fundamentales + momentum + liquidez. Cache 24h."""
    try:
        import accion_del_dia as _ad
        forzar = (request.args.get("forzar") or "").lower() in ("1", "true", "yes")
        return jsonify(_ad.accion_del_dia(forzar=forzar))
    except Exception as e:
        return jsonify({"ok": False, "error": f"acción del día falló: {e}"}), 500


@app.route("/api/deep-dive/<path:ticker>", methods=["GET"])
def api_deep_dive(ticker):
    """Análisis profundo automático de un ticker BMV (o cualquier ticker).
    Devuelve métricas + comparativa contra peers mexicanos + narrativa."""
    try:
        import deep_dive_bmv as _dd
        return jsonify(_dd.deep_dive(ticker))
    except Exception as e:
        return jsonify({"ok": False, "error": f"deep dive fallo: {e}"}), 500


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


@app.route("/api/calendario/ics", methods=["GET", "POST"])
def api_calendario_ics():
    """Genera un .ics descargable con earnings, dividendos y fechas fiscales MX.

    GET  /api/calendario/ics?tickers=AAPL,MSFT&fiscal=1&earnings=1&dividendos=1
    POST {"tickers": ["AAPL","MSFT"], "fiscal": true, ...}

    Respuesta: archivo .ics (text/calendar) que el usuario importa a Google
    Calendar, Apple Calendar, Outlook, etc.
    """
    try:
        import calendario as _cal
        if request.method == "POST":
            body = request.get_json(silent=True) or {}
            tickers = body.get("tickers") or []
            incl_earn = bool(body.get("earnings", True))
            incl_div  = bool(body.get("dividendos", True))
            incl_fisc = bool(body.get("fiscal", True))
        else:
            raw_tickers = (request.args.get("tickers") or "").strip()
            tickers = [t.strip() for t in raw_tickers.split(",") if t.strip()]
            incl_earn = request.args.get("earnings", "1") != "0"
            incl_div  = request.args.get("dividendos", "1") != "0"
            incl_fisc = request.args.get("fiscal", "1") != "0"

        ics = _cal.generar_ics(
            tickers=tickers,
            incluir_earnings=incl_earn,
            incluir_dividendos=incl_div,
            incluir_fiscal_mx=incl_fisc,
        )
        return Response(
            ics,
            mimetype="text/calendar; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=mi-portafolio.ics"},
        )
    except Exception as e:
        return jsonify({"error": f"fallo generando .ics: {e}"}), 500


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
@app.route("/api/auth/magiclink", methods=["POST"])  # alias (lo usa signup.html)
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


@app.route("/api/auth/eliminar-cuenta", methods=["POST", "DELETE"])
def api_auth_eliminar_cuenta():
    """Borra la cuenta del usuario autenticado y todos sus datos en el servidor.
    Requisito de App Store (5.1.1v) y Google Play."""
    if _auth is None:
        return jsonify({"error": "auth no disponible"}), 500
    ses = _sesion_actual()
    if not ses or not ses.get("email"):
        return jsonify({"error": "Debes iniciar sesion para borrar tu cuenta."}), 401
    try:
        res = _auth.eliminar_cuenta(ses["email"])
        resp = jsonify(res)
        resp.set_cookie("session_id", "", max_age=0, path="/")
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ------------------------------------------------------------
# PAGOS: MercadoPago preapproval ($65 MXN / mes)
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


# ------------------------------------------------------------
# PAGOS in-app (App Store / Google Play) via RevenueCat
# ------------------------------------------------------------
@app.route("/api/payments/revenuecat/sync", methods=["POST"])
def api_payments_revenuecat_sync():
    """
    El cliente nativo llama esto tras una compra/restauración. Confirmamos la
    entitlement de forma SEGURA contra la REST API de RevenueCat (no confiamos
    en el cliente) y devolvemos si quedó premium.
    Body: {email?}  (si hay sesión, se usa el email de la sesión)
    """
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    ses = _sesion_actual()
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or (ses or {}).get("email") or "").strip().lower()
    if not email:
        return jsonify({"error": "email requerido (o inicia sesion antes)"}), 400
    try:
        return jsonify(_payments.revenuecat_verificar(email))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/payments/revenuecat/webhook", methods=["POST"])
def api_payments_revenuecat_webhook():
    if _payments is None:
        return jsonify({"error": "pagos no disponibles"}), 500
    raw = request.get_data()
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    headers = {k: v for k, v in request.headers.items()}
    try:
        return jsonify(_payments.revenuecat_webhook(headers, payload))
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
