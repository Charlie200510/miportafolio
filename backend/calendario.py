"""
calendario.py — Genera archivos .ics con eventos financieros relevantes
para los tickers del portafolio del usuario.

Eventos soportados:
  - earnings (fecha de reporte trimestral)
  - dividendos (ex-dividend dates próximos)
  - fechas fiscales SAT México (constantes)

El usuario descarga el .ics desde la app y lo importa a Google Calendar,
Apple Calendar, Outlook, etc. Sin OAuth, sin permisos, sin login adicional.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import yfinance as yf


# ============================================================
# Fechas fiscales fijas para inversionistas mexicanos
# (mismas que las del frontend ux_helpers.js para consistencia)
# ============================================================
FECHAS_FISCALES_MX = [
    {"fecha": "01-31", "titulo": "Declaración informativa retenciones (DIM)",
     "descripcion": "Fecha límite para presentar la DIM del año anterior."},
    {"fecha": "02-17", "titulo": "Constancias de retenciones disponibles",
     "descripcion": "Tu broker debe entregarte las constancias del año anterior."},
    {"fecha": "03-31", "titulo": "Inicio declaración anual personas físicas",
     "descripcion": "Abre la plataforma del SAT para presentar declaración anual."},
    {"fecha": "04-30", "titulo": "Cierre declaración anual personas físicas",
     "descripcion": "Último día para declarar y pagar ISR del año fiscal anterior."},
    {"fecha": "12-15", "titulo": "Ventana de tax-loss harvesting",
     "descripcion": "Última oportunidad para vender posiciones con pérdida y reducir ISR."},
    {"fecha": "12-31", "titulo": "Cierre del ejercicio fiscal",
     "descripcion": "Las ventas después de esta fecha cuentan para el próximo ejercicio."},
]


def _formatear_fecha_ics(d: date) -> str:
    """Formato YYYYMMDD para evento all-day."""
    return d.strftime("%Y%m%d")


def _escapar_texto_ics(texto: str) -> str:
    """Escapa caracteres especiales en valores ICS."""
    return (texto or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _uid(prefijo: str, contenido: str) -> str:
    """UID estable basado en hash para que re-importar no duplique eventos."""
    h = hashlib.md5(f"{prefijo}|{contenido}".encode()).hexdigest()[:16]
    return f"{prefijo}-{h}@miportafolio.uk"


def _earnings_proximos(tickers: List[str], dias_max: int = 180) -> List[Dict[str, Any]]:
    """Para cada ticker, intenta obtener la próxima fecha de earnings vía yfinance."""
    eventos = []
    limite = date.today() + timedelta(days=dias_max)
    for t in tickers:
        try:
            yt = yf.Ticker(t)
            cal = getattr(yt, "calendar", None)
            if cal is None:
                continue
            # yfinance puede devolver dict o DataFrame según versión
            fechas = []
            if isinstance(cal, dict):
                for k in ("Earnings Date", "earnings_date", "earningsDate"):
                    v = cal.get(k)
                    if v is None:
                        continue
                    if isinstance(v, (list, tuple)):
                        fechas.extend(v)
                    else:
                        fechas.append(v)
            else:
                # DataFrame
                try:
                    fila = cal.loc["Earnings Date"] if "Earnings Date" in cal.index else None
                    if fila is not None:
                        for x in (fila if hasattr(fila, "__iter__") else [fila]):
                            fechas.append(x)
                except Exception:
                    pass
            for f in fechas:
                if hasattr(f, "to_pydatetime"):
                    f = f.to_pydatetime().date()
                elif isinstance(f, datetime):
                    f = f.date()
                if not isinstance(f, date):
                    continue
                if date.today() <= f <= limite:
                    eventos.append({
                        "ticker":      t,
                        "fecha":       f,
                        "tipo":        "earnings",
                        "titulo":      f"Earnings: {t}",
                        "descripcion": f"Reporte trimestral esperado de {t}. Verifica la hora exacta con tu broker.",
                    })
        except Exception:
            continue
    return eventos


def _dividendos_proximos(tickers: List[str]) -> List[Dict[str, Any]]:
    """Próximos ex-dividend dates si yfinance los reporta."""
    eventos = []
    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            ex = getattr(fi, "ex_dividend_date", None) if fi else None
            if ex is None:
                continue
            if isinstance(ex, datetime):
                ex = ex.date()
            elif isinstance(ex, (int, float)):
                # timestamp Unix
                ex = datetime.fromtimestamp(ex).date()
            if not isinstance(ex, date):
                continue
            if ex >= date.today():
                eventos.append({
                    "ticker":      t,
                    "fecha":       ex,
                    "tipo":        "dividendo",
                    "titulo":      f"Ex-Dividend: {t}",
                    "descripcion": f"Última fecha para comprar {t} y tener derecho al próximo dividendo.",
                })
        except Exception:
            continue
    return eventos


def _eventos_fiscales_mx(años: int = 1) -> List[Dict[str, Any]]:
    """Genera los eventos del calendario fiscal mexicano para los próximos N años."""
    eventos = []
    hoy = date.today()
    for año_offset in range(años + 1):
        año = hoy.year + año_offset
        for f in FECHAS_FISCALES_MX:
            try:
                mes, dia = f["fecha"].split("-")
                fecha_evento = date(año, int(mes), int(dia))
                if fecha_evento >= hoy:
                    eventos.append({
                        "ticker":      "",
                        "fecha":       fecha_evento,
                        "tipo":        "fiscal_mx",
                        "titulo":      f["titulo"],
                        "descripcion": f["descripcion"] + " (Fecha fija del calendario SAT)",
                    })
            except Exception:
                continue
    return eventos


def generar_ics(
    tickers: List[str],
    incluir_earnings: bool = True,
    incluir_dividendos: bool = True,
    incluir_fiscal_mx: bool = True,
) -> str:
    """Genera el contenido del archivo .ics con todos los eventos solicitados."""
    eventos: List[Dict[str, Any]] = []
    tickers = [t.strip().upper() for t in (tickers or []) if t and t.strip()]

    if tickers and incluir_earnings:
        eventos.extend(_earnings_proximos(tickers))
    if tickers and incluir_dividendos:
        eventos.extend(_dividendos_proximos(tickers))
    if incluir_fiscal_mx:
        eventos.extend(_eventos_fiscales_mx(años=1))

    # Header ICS
    lineas = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Mi Portafolio//ES",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Mi Portafolio",
        "X-WR-CALDESC:Earnings, dividendos y fechas fiscales SAT (México)",
        "X-WR-TIMEZONE:America/Mexico_City",
    ]

    ahora = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    for ev in eventos:
        uid = _uid(ev["tipo"], f"{ev.get('ticker','')}-{ev['fecha'].isoformat()}-{ev['titulo']}")
        fecha = _formatear_fecha_ics(ev["fecha"])
        fecha_fin = _formatear_fecha_ics(ev["fecha"] + timedelta(days=1))
        lineas.extend([
            "BEGIN:VEVENT",
            f"UID:{uid}",
            f"DTSTAMP:{ahora}",
            f"DTSTART;VALUE=DATE:{fecha}",
            f"DTEND;VALUE=DATE:{fecha_fin}",
            f"SUMMARY:{_escapar_texto_ics(ev['titulo'])}",
            f"DESCRIPTION:{_escapar_texto_ics(ev['descripcion'])}",
            f"CATEGORIES:{_escapar_texto_ics(ev['tipo'].upper())}",
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ])

    lineas.append("END:VCALENDAR")
    return "\r\n".join(lineas) + "\r\n"
