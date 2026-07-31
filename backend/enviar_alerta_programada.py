"""
enviar_alerta_programada.py — Script CLI para alertas automáticas.

Lee `portafolio_snapshot.json` (creado por el frontend cuando el usuario
guarda su portafolio) y dispara la alerta indicada por argumento:

    python3 enviar_alerta_programada.py drift
    python3 enviar_alerta_programada.py precio
    python3 enviar_alerta_programada.py semanal
    python3 enviar_alerta_programada.py periodico    # newsletter matutino

No depende de Flask — importa alertas.py directamente y manda por SMTP
usando las credenciales de .env. Pensado para ejecutarse desde tareas
programadas (cron / Claude Scheduled).

El script carga `.env` automáticamente al arrancar (ANTHROPIC_API_KEY,
SMTP_*, etc.).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import yfinance as yf

# ---- Cargar .env igual que app.py --------------------------------------
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
        print(f"warn: error leyendo .env: {e}")
_cargar_env()

import alertas  # noqa: E402

BACKEND_DIR = Path(__file__).parent

import snapshots as _snaps  # noqa: E402  (contrato compartido con app.py)


def _cargar_snapshot(email: str | None = None) -> dict | None:
    """Con `email`, carga el snapshot de ESE destinatario. Sin él, usa el único
    que haya (comodidad para correr a mano); si hay varios, exige elegir para no
    mandarle a la persona equivocada."""
    if email:
        snap = _snaps.cargar(email)
        if snap is None:
            print(f"× No hay snapshot para {email}.")
            print("  Esa persona debe abrir la app y guardar su portafolio una vez.")
        return snap

    todos = list(_snaps.listar())
    if not todos:
        print(f"× No hay ningún snapshot en {_snaps.DIR_SNAPSHOTS}.")
        print("  Abre la app y guarda tu portafolio una vez para crearlo.")
        return None
    if len(todos) > 1:
        print(f"× Hay {len(todos)} snapshots y no dijiste a quién enviar.")
        print("  Usa: --email <correo>. Destinatarios disponibles:")
        for s in todos:
            print(f"    - {s.get('destinatario')}")
        return None
    return todos[0]


def _refrescar_precios(posiciones: list) -> list:
    """Antes de calcular alertas, intenta refrescar precios actuales vía
    yfinance.fast_info para que las alertas usen datos frescos."""
    if not posiciones:
        return posiciones
    tickers = list({p.get("ticker") for p in posiciones if p.get("ticker")})
    if not tickers:
        return posiciones
    precios = {}
    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            p = getattr(fi, "last_price", None) or fi.get("last_price") if fi else None
            if isinstance(p, (int, float)):
                precios[t] = float(p)
            # Cambio del día (close anterior vs precio actual)
            try:
                prev = getattr(fi, "previous_close", None) or fi.get("previous_close")
                if isinstance(prev, (int, float)) and isinstance(p, (int, float)) and prev > 0:
                    precios[t + "_cambio"] = (p - prev) / prev * 100.0
            except Exception:
                pass
        except Exception:
            pass

    enriched = []
    for pos in posiciones:
        t = pos.get("ticker")
        nuevo = dict(pos)
        if t in precios:
            nuevo["precio_actual"] = precios[t]
        if t + "_cambio" in precios:
            nuevo["cambio_pct"] = precios[t + "_cambio"]
        enriched.append(nuevo)
    return enriched


def _construir_payload(tipo: str, snap: dict) -> dict:
    """Arma el payload específico al tipo, con datos frescos de yfinance."""
    posiciones = _refrescar_precios(snap.get("posiciones") or [])

    if tipo == "drift":
        return {
            "pesos_objetivo": snap.get("pesos_objetivo") or {},
            "posiciones":     posiciones,
            "umbral_pp":      5.0,
        }
    if tipo in ("precio", "movimientos"):
        return {
            "posiciones": posiciones,
            "umbral_pct": 5.0,
        }
    if tipo == "periodico":
        # Newsletter matutino con cierres + titulares + cierres del portafolio
        try:
            import periodico as _peri
            resumen   = _peri.resumen_diario()
            cierres   = _peri.cierres_indices()
            tickers   = [p.get("ticker") for p in posiciones if p.get("ticker")]
            noticias  = _peri.noticias_portafolio(tickers[:10], limite=6) if tickers else []
        except Exception as e:
            print(f"warn: no se pudo cargar periodico.py: {e}")
            resumen, cierres, noticias = {}, {}, []
        return {
            "resumen":    resumen,
            "cierres":    cierres,
            "noticias":   noticias,
            "posiciones": posiciones,
        }
    if tipo in ("newsletter", "newsletter_semanal"):
        # Newsletter premium semanal — más profundo que el periódico diario
        try:
            import periodico as _peri
            resumen   = _peri.resumen_diario()
            cierres   = _peri.cierres_indices()
            tickers   = [p.get("ticker") for p in posiciones if p.get("ticker")]
            noticias  = _peri.noticias_portafolio(tickers[:10], limite=8) if tickers else []
        except Exception as e:
            print(f"warn: no se pudo cargar periodico.py: {e}")
            resumen, cierres, noticias = {}, {}, []
        # Top movers de la semana (los 5 tickers con mayor magnitud de cambio)
        movers = sorted(
            [p for p in posiciones if isinstance(p.get("cambio_pct"), (int, float))],
            key=lambda x: abs(x["cambio_pct"]), reverse=True,
        )[:5]
        # Tasa CETES referencia
        cetes_tasa = None
        try:
            import renta_fija_mx as _rf
            data = _rf.cetes_y_fibras() if hasattr(_rf, "cetes_y_fibras") else None
            if data and data.get("cetes"):
                for c in data["cetes"]:
                    if "28" in str(c.get("plazo", "")):
                        cetes_tasa = c.get("tasa_pct") or c.get("tasa")
                        break
        except Exception:
            pass
        return {
            "resumen":    resumen,
            "cierres":    cierres,
            "noticias":   noticias,
            "posiciones": posiciones,
            "metricas":   snap.get("metricas") or {},
            "top_movers": movers,
            "cetes":      cetes_tasa,
        }
    if tipo in ("semanal", "reporte_semanal"):
        # Top/bottom performers basados en cambio_pct si hay
        ranked = sorted(
            [p for p in posiciones if isinstance(p.get("cambio_pct"), (int, float))],
            key=lambda p: p["cambio_pct"], reverse=True,
        )
        top = [
            {"ticker": p["ticker"], "rendimiento_pct": round(p["cambio_pct"], 2),
             "nombre": p.get("nombre", p["ticker"])}
            for p in ranked[:3]
        ]
        bottom = [
            {"ticker": p["ticker"], "rendimiento_pct": round(p["cambio_pct"], 2),
             "nombre": p.get("nombre", p["ticker"])}
            for p in ranked[-3:][::-1]
        ]
        return {
            "metricas": snap.get("metricas") or {},
            "top": top,
            "bottom": bottom,
        }
    raise ValueError(f"Tipo desconocido: {tipo}")


def main():
    if len(sys.argv) < 2:
        print("Uso: python3 enviar_alerta_programada.py <drift|precio|semanal|periodico> [--email <correo>]")
        sys.exit(1)
    tipo = sys.argv[1].strip().lower()

    # --email <correo>: cuál de los snapshots usar. El cron lo pasa siempre,
    # porque hay uno por destinatario.
    email = None
    if "--email" in sys.argv:
        i = sys.argv.index("--email")
        if i + 1 >= len(sys.argv):
            print("× --email requiere un correo.")
            sys.exit(1)
        email = sys.argv[i + 1].strip().lower()

    snap = _cargar_snapshot(email)
    if not snap:
        sys.exit(1)

    destinatario = snap.get("destinatario") or os.environ.get("ALERTAS_DESTINATARIO") or os.environ.get("SMTP_FROM")
    if not destinatario or "@" not in destinatario:
        print("× No hay destinatario en snapshot ni en variables de entorno.")
        sys.exit(1)

    activas = snap.get("alertas_activas") or {}
    if not activas.get(tipo, True):
        print(f"  Alertas '{tipo}' están desactivadas en snapshot — no envío.")
        sys.exit(0)

    payload = _construir_payload(tipo, snap)
    nombre = snap.get("nombre") or "Inversionista"

    print(f"Enviando alerta '{tipo}' a {destinatario}…")
    res = alertas.enviar_alerta(
        tipo=tipo,
        destinatario=destinatario,
        nombre=nombre,
        payload=payload,
        dry_run=False,
    )
    print(f"Resultado: {json.dumps(res, indent=2, default=str, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
