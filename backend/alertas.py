"""
alertas.py — Sistema de alertas inteligentes por email.

Tipos de alerta soportadas:
  1. Drift de pesos: cuando la composición real se desvía >X pp del objetivo.
  2. Movimientos de precio: caídas o subidas >Y% en una sesión.
  3. Reporte semanal: resumen empaquetado de métricas y P&L.

Transports soportados (en orden de preferencia):
  1. Resend (recomendado): API simple, 100 emails/día gratis.
     Env vars: RESEND_API_KEY, RESEND_FROM (ej. "Mi Portafolio <alerts@miportafolio.uk>")
  2. SMTP (Gmail, Outlook, etc.): fallback si no hay RESEND_API_KEY.
     Env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
     (SMTP_PORT por default 587, STARTTLS)
"""

from __future__ import annotations

import html
import json
import os
import smtplib
import ssl
import urllib.request
import urllib.error
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional, Tuple


# ---- Config SMTP ------------------------------------------------------------

def _smtp_config() -> Dict[str, Any]:
    return {
        "host": os.environ.get("SMTP_HOST"),
        "port": int(os.environ.get("SMTP_PORT") or 587),
        "user": os.environ.get("SMTP_USER"),
        "pw":   os.environ.get("SMTP_PASS"),
        "from": os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER"),
    }


def _resend_config() -> Dict[str, Any]:
    return {
        "api_key": os.environ.get("RESEND_API_KEY"),
        "from":    os.environ.get("RESEND_FROM") or "Mi Portafolio <onboarding@resend.dev>",
    }


def estado_configuracion() -> Dict[str, Any]:
    resend = _resend_config()
    smtp   = _smtp_config()
    resend_ok = bool(resend["api_key"])
    smtp_ok   = bool(smtp["host"] and smtp["user"] and smtp["pw"] and smtp["from"])
    transport = "resend" if resend_ok else ("smtp" if smtp_ok else None)
    return {
        "disponible": resend_ok or smtp_ok,
        "transport":  transport,
        "host":       smtp["host"],
        "from":       resend["from"] if resend_ok else smtp["from"],
        "faltantes":  [] if (resend_ok or smtp_ok) else
                      ["RESEND_API_KEY (recomendado)", "o SMTP_HOST/USER/PASS/FROM"],
    }


# ---- Detección de alertas ---------------------------------------------------

def detectar_drift(
    pesos_objetivo: Dict[str, float],
    posiciones: List[Dict[str, Any]],
    umbral_pp: float = 5.0,
) -> List[Dict[str, Any]]:
    """
    Regresa lista de alertas de drift.
    `posiciones` puede traer peso_pct (0..100) por ticker, o calculamos desde valor_actual.

    Ejemplo de alerta:
      {"ticker": "AAPL", "objetivo_pct": 40.0, "real_pct": 48.5, "drift_pp": 8.5, "direccion": "sobre"}
    """
    if not pesos_objetivo or not posiciones:
        return []

    # Normalizar pesos_objetivo a porcentajes 0..100
    total_obj = sum(float(v) for v in pesos_objetivo.values() if v is not None)
    if total_obj <= 0:
        return []
    if total_obj <= 1.5:
        # Venían como fracciones 0..1
        pesos_obj_pct = {k: float(v) * 100.0 for k, v in pesos_objetivo.items()}
    else:
        pesos_obj_pct = {k: float(v) for k, v in pesos_objetivo.items()}

    # Calcular pesos reales si no vienen
    pesos_reales: Dict[str, float] = {}
    peso_total = sum(
        (p.get("peso_pct") or 0) for p in posiciones
        if isinstance(p.get("peso_pct"), (int, float))
    )
    if peso_total > 50:  # ya vienen en %
        for p in posiciones:
            if p.get("ticker") and p.get("peso_pct") is not None:
                pesos_reales[p["ticker"]] = float(p["peso_pct"])
    else:
        # Calcular desde valor_actual
        total = sum((p.get("valor_actual") or 0) for p in posiciones)
        if total <= 0:
            return []
        for p in posiciones:
            if p.get("ticker") and p.get("valor_actual"):
                pesos_reales[p["ticker"]] = 100.0 * float(p["valor_actual"]) / total

    alertas: List[Dict[str, Any]] = []
    for ticker, obj in pesos_obj_pct.items():
        real = pesos_reales.get(ticker, 0.0)
        drift = real - obj
        if abs(drift) >= umbral_pp:
            alertas.append({
                "ticker":       ticker,
                "objetivo_pct": round(obj, 2),
                "real_pct":     round(real, 2),
                "drift_pp":     round(drift, 2),
                "direccion":    "sobre" if drift > 0 else "bajo",
            })

    alertas.sort(key=lambda a: abs(a["drift_pp"]), reverse=True)
    return alertas


def detectar_movimientos_precio(
    posiciones: List[Dict[str, Any]],
    umbral_pct: float = 5.0,
) -> List[Dict[str, Any]]:
    """
    Regresa lista de tickers con cambio diario (o retorno) > umbral.
    Busca en la posición campos como `cambio_pct_dia`, `retorno_dia_pct`, o `retorno_pct`.
    """
    alertas: List[Dict[str, Any]] = []
    for p in posiciones or []:
        cambio = (
            p.get("cambio_pct_dia") or
            p.get("retorno_dia_pct") or
            p.get("retorno_pct")
        )
        if cambio is None:
            continue
        try:
            c = float(cambio)
        except (ValueError, TypeError):
            continue
        if abs(c) >= umbral_pct:
            alertas.append({
                "ticker":      p.get("ticker"),
                "cambio_pct":  round(c, 2),
                "precio":      p.get("precio_actual") or p.get("precio"),
                "direccion":   "subida" if c > 0 else "caida",
                "magnitud":    "extrema" if abs(c) >= 10 else "importante",
            })
    alertas.sort(key=lambda a: abs(a["cambio_pct"]), reverse=True)
    return alertas


# ---- Plantillas HTML --------------------------------------------------------

def _html_base(titulo: str, cuerpo: str, footer_extra: str = "") -> str:
    return f"""\
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{html.escape(titulo)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#fafafa;color:#18181b;">
  <div style="max-width:600px;margin:20px auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
    <div style="background:#0a0a0a;color:#ffffff;padding:20px 24px;">
      <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a1a1aa;">portafolio-app</p>
      <h1 style="margin:6px 0 0 0;font-size:20px;font-weight:600;">{html.escape(titulo)}</h1>
    </div>
    <div style="padding:24px;">
      {cuerpo}
    </div>
    <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:11px;color:#71717a;line-height:1.5;">
      {footer_extra}
      Este email se envió automáticamente por portafolio-app.<br>
      No constituye asesoría de inversión.
    </div>
  </div>
</body>
</html>
"""


def render_alerta_drift(nombre: str, alertas: List[Dict[str, Any]]) -> Tuple[str, str]:
    """Regresa (subject, html) para email de drift."""
    n = len(alertas)
    subject = f"⚖️ Drift detectado en tu portafolio ({n})"

    filas = ""
    for a in alertas:
        color = "#ef4444" if a["direccion"] == "sobre" else "#3b82f6"
        signo = "+" if a["drift_pp"] > 0 else ""
        filas += f"""
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;font-weight:600;">{html.escape(a['ticker'])}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:right;color:#71717a;">{a['objetivo_pct']:.1f}%</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:right;color:#18181b;">{a['real_pct']:.1f}%</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:right;color:{color};font-weight:600;">{signo}{a['drift_pp']:.2f} pp</td>
        </tr>
        """

    cuerpo = f"""
    <p style="margin:0 0 12px 0;">Hola {html.escape(nombre)},</p>
    <p style="margin:0 0 16px 0;line-height:1.55;">
      Detectamos que tu portafolio se ha desviado de los pesos objetivo. Los siguientes activos
      tienen un drift importante que podría convenir revisar:
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#71717a;">Ticker</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#71717a;">Objetivo</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#71717a;">Actual</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#71717a;">Drift</th>
        </tr>
      </thead>
      <tbody>{filas}</tbody>
    </table>
    <p style="margin:16px 0 0 0;font-size:13px;color:#52525b;line-height:1.55;">
      Puedes rebalancear desde la pestaña "Rebalanceo" en la app. No siempre es necesario
      rebalancear — un drift de &lt;10 pp suele ser tolerable según tu estrategia.
    </p>
    """
    return subject, _html_base("Alerta de drift", cuerpo)


def render_alerta_precio(nombre: str, alertas: List[Dict[str, Any]]) -> Tuple[str, str]:
    caidas = [a for a in alertas if a["direccion"] == "caida"]
    subidas = [a for a in alertas if a["direccion"] == "subida"]

    if caidas and not subidas:
        emoji = "📉"
        titulo = "Caídas importantes hoy"
    elif subidas and not caidas:
        emoji = "🚀"
        titulo = "Subidas importantes hoy"
    else:
        emoji = "⚡"
        titulo = "Movimientos importantes hoy"

    subject = f"{emoji} {titulo} en tu portafolio"

    filas = ""
    for a in alertas:
        color = "#22c55e" if a["direccion"] == "subida" else "#ef4444"
        signo = "+" if a["cambio_pct"] > 0 else ""
        precio = a.get("precio")
        precio_str = f"${precio:,.2f}" if isinstance(precio, (int, float)) else "—"
        filas += f"""
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;font-weight:600;">{html.escape(a.get('ticker') or '—')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:right;color:#52525b;">{precio_str}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:right;color:{color};font-weight:700;font-size:15px;">{signo}{a['cambio_pct']:.2f}%</td>
        </tr>
        """

    cuerpo = f"""
    <p style="margin:0 0 12px 0;">Hola {html.escape(nombre)},</p>
    <p style="margin:0 0 16px 0;line-height:1.55;">
      {len(alertas)} {"activo" if len(alertas)==1 else "activos"} de tu portafolio
      {"tuvo" if len(alertas)==1 else "tuvieron"} movimientos importantes hoy.
      Los grandes cambios diarios suelen ser ruido — no reacciones a ciegas.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#71717a;">Ticker</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#71717a;">Precio</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#71717a;">Cambio</th>
        </tr>
      </thead>
      <tbody>{filas}</tbody>
    </table>
    """
    return subject, _html_base(titulo, cuerpo)


def render_reporte_semanal(
    nombre: str,
    metricas: Dict[str, Any],
    top_performers: Optional[List[Dict[str, Any]]] = None,
    bottom_performers: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, str]:
    subject = "📊 Tu resumen semanal"

    pnl = metricas.get("pnl_semana_pct")
    color_pnl = "#22c55e" if (pnl or 0) >= 0 else "#ef4444"
    signo = "+" if (pnl or 0) >= 0 else ""
    pnl_str = f"{signo}{pnl:.2f}%" if isinstance(pnl, (int, float)) else "—"
    valor = metricas.get("valor_actual")
    valor_str = f"${valor:,.0f}" if isinstance(valor, (int, float)) else "—"

    def _filas_perf(lista: Optional[List[Dict[str, Any]]], positivo: bool) -> str:
        if not lista:
            return ""
        filas = ""
        for x in lista[:3]:
            ret = x.get("retorno_pct")
            if not isinstance(ret, (int, float)):
                continue
            color = "#22c55e" if ret >= 0 else "#ef4444"
            sig = "+" if ret >= 0 else ""
            filas += f"""
            <tr>
              <td style="padding:6px 0;font-weight:600;font-size:13px;">{html.escape(x.get('ticker') or '—')}</td>
              <td style="padding:6px 0;text-align:right;color:{color};font-weight:600;font-size:13px;">{sig}{ret:.2f}%</td>
            </tr>
            """
        return filas

    cuerpo = f"""
    <p style="margin:0 0 12px 0;">Hola {html.escape(nombre)},</p>
    <p style="margin:0 0 20px 0;line-height:1.55;">Aquí está tu resumen de la semana:</p>
    <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:16px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div>
          <p style="margin:0;font-size:11px;text-transform:uppercase;color:#71717a;letter-spacing:1px;">Valor actual</p>
          <p style="margin:4px 0 0 0;font-size:22px;font-weight:700;">{valor_str}</p>
        </div>
        <div style="text-align:right;">
          <p style="margin:0;font-size:11px;text-transform:uppercase;color:#71717a;letter-spacing:1px;">P&amp;L semana</p>
          <p style="margin:4px 0 0 0;font-size:22px;font-weight:700;color:{color_pnl};">{pnl_str}</p>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:16px;">
      <div style="flex:1;padding:14px;border:1px solid #e4e4e7;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;color:#71717a;">🏆 Mejores</p>
        <table style="width:100%;border-collapse:collapse;">{_filas_perf(top_performers, True)}</table>
      </div>
      <div style="flex:1;padding:14px;border:1px solid #e4e4e7;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;color:#71717a;">🧊 Peores</p>
        <table style="width:100%;border-collapse:collapse;">{_filas_perf(bottom_performers, False)}</table>
      </div>
    </div>

    <p style="margin:16px 0 0 0;font-size:13px;color:#52525b;line-height:1.55;">
      Abre la app para ver el detalle completo, correr simulaciones o exportar tu reporte mensual en PDF.
    </p>
    """
    return subject, _html_base("Resumen semanal", cuerpo)


def render_periodico_diario(
    nombre: str,
    resumen: Dict[str, Any],
    cierres: Dict[str, Any],
    noticias: List[Dict[str, Any]],
    posiciones: List[Dict[str, Any]],
) -> Tuple[str, str]:
    """Newsletter matutino con cierres, titulares y noticias de tus tickers."""
    fecha_hoy = datetime.now().strftime("%A %d de %B").capitalize()
    clase = resumen.get("clasificacion") or {}
    emoji = "📈" if clase.get("tipo") == "positivo" else ("📉" if clase.get("tipo") == "negativo" else "📊")
    etiqueta_dia = clase.get("etiqueta") or "Mercados mixtos"
    subject = f"{emoji} Mi Portafolio · {etiqueta_dia} · {fecha_hoy.split(',')[0] if ',' in fecha_hoy else fecha_hoy}"

    # Bloque de cierres de índices
    indices = (cierres.get("indices") or [])[:5]
    filas_indices = ""
    for idx in indices:
        cambio = idx.get("cambio_pct")
        if not isinstance(cambio, (int, float)):
            continue
        color = "#16a34a" if cambio >= 0 else "#dc2626"
        signo = "+" if cambio >= 0 else ""
        precio = idx.get("precio_actual")
        precio_str = f"${precio:,.2f}" if isinstance(precio, (int, float)) else "—"
        filas_indices += f"""
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;font-size:13px;">{html.escape(idx.get('nombre') or '—')}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:12px;color:#71717a;">{precio_str}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:right;color:{color};font-weight:700;font-size:13px;">{signo}{cambio:.2f}%</td>
        </tr>"""

    # Bloque de titulares (top 3 del mercado general)
    titulares = resumen.get("titulares") or []
    items_titulares = ""
    for t in titulares[:3]:
        titulo = (t.get("titulo") or "").strip()
        proveedor = t.get("proveedor") or ""
        url = t.get("url") or "#"
        items_titulares += f"""
        <div style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
          <a href="{html.escape(url)}" style="color:#18181b;text-decoration:none;font-weight:600;font-size:14px;line-height:1.4;">{html.escape(titulo)}</a>
          <p style="margin:4px 0 0;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.05em;">{html.escape(proveedor)}</p>
        </div>"""

    # Bloque de noticias del portafolio (si hay)
    bloque_portafolio = ""
    if noticias:
        items_port = ""
        for n in noticias[:5]:
            titulo = (n.get("titulo") or "").strip()
            ticker = n.get("ticker") or ""
            url = n.get("url") or "#"
            items_port += f"""
            <div style="padding:10px 0;border-bottom:1px solid #f5f5f5;">
              <p style="margin:0 0 3px;font-size:10px;color:#16a34a;font-weight:700;letter-spacing:0.08em;">{html.escape(ticker)}</p>
              <a href="{html.escape(url)}" style="color:#18181b;text-decoration:none;font-weight:600;font-size:13px;line-height:1.4;">{html.escape(titulo)}</a>
            </div>"""
        bloque_portafolio = f"""
        <h3 style="margin:24px 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;">Tus tickers</h3>
        <div>{items_port}</div>"""

    cuerpo = f"""
    <p style="margin:0 0 4px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">{html.escape(fecha_hoy)}</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#18181b;">Hola {html.escape(nombre)}, aquí está el resumen del día:</p>

    <div style="background:linear-gradient(135deg,#fafafa,#f4f4f5);border:1px solid #e4e4e7;border-radius:10px;padding:16px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;line-height:1.55;color:#27272a;">{html.escape(resumen.get('resumen_mercado') or 'No hay datos de cierre disponibles.')}</p>
    </div>

    <h3 style="margin:0 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;">Cierres de hoy</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tbody>{filas_indices or '<tr><td style="padding:12px;color:#71717a;font-size:12px;">Datos no disponibles ahora.</td></tr>'}</tbody>
    </table>

    <h3 style="margin:0 0 4px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;">Titulares del día</h3>
    <div>{items_titulares or '<p style="padding:12px;color:#71717a;font-size:12px;">Sin titulares disponibles.</p>'}</div>

    {bloque_portafolio}

    <p style="margin:24px 0 0;font-size:12px;color:#52525b;line-height:1.55;">
      Datos de Yahoo Finance. Esto es información agregada, NO asesoría de inversión.
      Para ver tu portafolio completo, <a href="https://miportafolio.uk" style="color:#16a34a;font-weight:600;">abre la app</a>.
    </p>"""

    return subject, _html_base(f"Periódico · {fecha_hoy.split(',')[0] if ',' in fecha_hoy else fecha_hoy}", cuerpo)


def render_newsletter_semanal(
    nombre: str,
    resumen: Dict[str, Any],
    cierres: Dict[str, Any],
    noticias: List[Dict[str, Any]],
    posiciones: List[Dict[str, Any]],
    metricas: Dict[str, Any],
    top_movers: List[Dict[str, Any]],
    cetes: Optional[float] = None,
) -> Tuple[str, str]:
    """Newsletter semanal premium — más profundo que el periódico diario.
    Incluye: cierres macro, análisis de portafolio, top movers de tus tickers,
    contexto mexicano (CETES, FX), 5 titulares destacados."""
    fecha_hoy = datetime.now().strftime("%A %d de %B").capitalize()
    semana_num = datetime.now().isocalendar()[1]
    subject = f"📊 Tu semana en el mercado — Semana {semana_num}"

    # === Sección 1: Resumen macro ===
    indices = (cierres.get("indices") or [])[:5]
    filas_macro = ""
    for idx in indices:
        cambio_semana = idx.get("cambio_semana_pct") or idx.get("cambio_pct")
        if not isinstance(cambio_semana, (int, float)):
            continue
        color = "#16a34a" if cambio_semana >= 0 else "#dc2626"
        signo = "+" if cambio_semana >= 0 else ""
        precio = idx.get("precio_actual")
        precio_str = f"${precio:,.2f}" if isinstance(precio, (int, float)) else "—"
        filas_macro += f"""
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-weight:600;font-size:13px;">{html.escape(idx.get('nombre') or '—')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:12px;color:#71717a;">{precio_str}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:{color};font-weight:700;font-size:14px;">{signo}{cambio_semana:.2f}%</td>
        </tr>"""

    # === Sección 2: Performance de tu portafolio ===
    pnl_semana = metricas.get("pnl_semana_pct")
    valor_actual = metricas.get("valor_actual")
    color_pnl = "#16a34a" if (pnl_semana or 0) >= 0 else "#dc2626"
    signo_pnl = "+" if (pnl_semana or 0) >= 0 else ""
    pnl_str = f"{signo_pnl}{pnl_semana:.2f}%" if isinstance(pnl_semana, (int, float)) else "—"
    valor_str = f"${valor_actual:,.0f}" if isinstance(valor_actual, (int, float)) else "—"

    # === Sección 3: Top movers de TUS tickers ===
    movers_html = ""
    if top_movers:
        items_movers = ""
        for m in top_movers[:5]:
            cambio = m.get("cambio_pct") or m.get("retorno_semana")
            if not isinstance(cambio, (int, float)):
                continue
            color = "#16a34a" if cambio >= 0 else "#dc2626"
            signo = "+" if cambio >= 0 else ""
            items_movers += f"""
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f5f5f5;">
              <div>
                <p style="margin:0;font-weight:700;font-size:14px;color:#18181b;">{html.escape(m.get('ticker') or '')}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#71717a;">{html.escape((m.get('nombre') or '')[:40])}</p>
              </div>
              <p style="margin:0;font-weight:700;font-size:16px;color:{color};">{signo}{cambio:.2f}%</p>
            </div>"""
        movers_html = f"""
        <h3 style="margin:24px 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">📊 Top movers de tu portafolio</h3>
        <div>{items_movers}</div>
        """

    # === Sección 4: Titulares destacados ===
    titulares_html = ""
    titulares = resumen.get("titulares") or []
    if titulares:
        items_tit = ""
        for t in titulares[:5]:
            titulo = (t.get("titulo") or "").strip()
            url = t.get("url") or "#"
            prov = t.get("proveedor") or ""
            items_tit += f"""
            <div style="padding:12px 0;border-bottom:1px solid #f5f5f5;">
              <a href="{html.escape(url)}" style="color:#18181b;text-decoration:none;font-weight:600;font-size:13px;line-height:1.4;">{html.escape(titulo)}</a>
              <p style="margin:4px 0 0;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.05em;">{html.escape(prov)}</p>
            </div>"""
        titulares_html = f"""
        <h3 style="margin:24px 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">📰 Lo más relevante de la semana</h3>
        <div>{items_tit}</div>
        """

    # === Sección 5: Contexto mexicano ===
    cetes_html = ""
    if cetes is not None:
        cetes_html = f"""
        <div style="padding:14px;background:linear-gradient(135deg,#fafafa,#f4f4f5);border:1px solid #e4e4e7;border-radius:10px;margin-top:18px;">
          <p style="margin:0;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">CETES 28 días (referencia MXN)</p>
          <p style="margin:6px 0 0;font-size:22px;font-weight:700;color:#16a34a;font-family:monospace;">{cetes:.2f}%</p>
          <p style="margin:4px 0 0;font-size:11px;color:#71717a;">Tu tasa libre de riesgo. Tu portafolio debería superarla por al menos {cetes + 2:.1f}% para justificar el riesgo equity.</p>
        </div>
        """

    cuerpo = f"""
    <p style="margin:0 0 4px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Semana {semana_num} · {html.escape(fecha_hoy)}</p>
    <p style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#18181b;">Hola {html.escape(nombre)}, este es tu resumen completo de la semana.</p>

    <div style="background:linear-gradient(135deg,rgba(34,197,94,0.06),rgba(34,197,94,0.02));border:1px solid rgba(34,197,94,0.25);border-radius:14px;padding:20px;margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;">
        <div>
          <p style="margin:0;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">Tu portafolio esta semana</p>
          <p style="margin:6px 0 0;font-size:32px;font-weight:800;color:{color_pnl};line-height:1;">{pnl_str}</p>
        </div>
        <div style="text-align:right;">
          <p style="margin:0;font-size:11px;color:#71717a;">Valor actual</p>
          <p style="margin:2px 0 0;font-size:20px;font-weight:700;color:#18181b;font-family:monospace;">{valor_str}</p>
        </div>
      </div>
    </div>

    <h3 style="margin:24px 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">🌎 Mercados globales esta semana</h3>
    <table style="width:100%;border-collapse:collapse;">
      <tbody>{filas_macro or '<tr><td style="padding:14px;color:#71717a;font-size:12px;">Datos no disponibles ahora.</td></tr>'}</tbody>
    </table>

    {movers_html}

    {titulares_html}

    {cetes_html}

    <div style="margin:32px 0 0;padding:20px;background:#0a0a0b;border-radius:12px;text-align:center;">
      <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">Para profundizar</p>
      <a href="https://miportafolio.uk" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#0a0a0b;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">Abrir Mi Portafolio →</a>
      <p style="margin:12px 0 0;font-size:11px;color:#a1a1aa;">Backtests, stress tests, AFOREs y todas las herramientas en la app.</p>
    </div>

    <p style="margin:20px 0 0;font-size:11px;color:#71717a;line-height:1.5;">
      Datos de Yahoo Finance + Banxico. Esto es información agregada, NO asesoría de inversión.
    </p>"""

    return subject, _html_base(f"Semana {semana_num} en el mercado", cuerpo)


# ---- Envío vía Resend (recomendado) ----------------------------------------

def _enviar_resend(destinatario: str, subject: str, html_body: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
    cfg = _resend_config()
    if not cfg["api_key"]:
        raise ValueError("RESEND_API_KEY no configurado en variables de entorno.")

    payload: Dict[str, Any] = {
        "from":    cfg["from"],
        "to":      [destinatario],
        "subject": subject,
        "html":    html_body,
    }
    if reply_to:
        payload["reply_to"] = reply_to

    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type":  "application/json",
            # api.resend.com está detrás de Cloudflare y su WAF bloquea el
            # User-Agent por defecto de urllib ("Python-urllib/3.x") con
            # HTTP 403 "error code: 1010" — la petición ni llega a Resend, así
            # que el correo falla siempre. Hay que mandar un UA propio.
            "User-Agent":    "miportafolio/1.0 (+https://miportafolio.uk)",
            "Accept":        "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            return {"ok": True, "enviado_a": destinatario, "subject": subject,
                    "transport": "resend", "id": data.get("id")}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Resend HTTP {e.code}: {err_body}") from e


# ---- Envío SMTP (fallback) -------------------------------------------------

def _enviar_smtp(destinatario: str, subject: str, html_body: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
    cfg = _smtp_config()
    if not (cfg["host"] and cfg["user"] and cfg["pw"] and cfg["from"]):
        raise ValueError(
            "SMTP no configurado. Define SMTP_HOST, SMTP_USER, SMTP_PASS y SMTP_FROM."
        )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = cfg["from"]
    msg["To"] = destinatario
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    ctx = ssl.create_default_context()
    with smtplib.SMTP(cfg["host"], cfg["port"], timeout=20) as server:
        server.starttls(context=ctx)
        server.login(cfg["user"], cfg["pw"])
        server.sendmail(cfg["from"], [destinatario], msg.as_string())

    return {"ok": True, "enviado_a": destinatario, "subject": subject, "transport": "smtp"}


def _enviar(destinatario: str, subject: str, html_body: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
    """Despacha al transport disponible: Resend tiene preferencia, SMTP es fallback."""
    if _resend_config()["api_key"]:
        return _enviar_resend(destinatario, subject, html_body, reply_to=reply_to)
    return _enviar_smtp(destinatario, subject, html_body, reply_to=reply_to)


def enviar_correo(destinatario: str, subject: str, html_body: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
    """Wrapper publico para que otros modulos (auth, pagos) manden correos transaccionales."""
    return _enviar(destinatario, subject, html_body, reply_to=reply_to)


def enviar_alerta(
    tipo: str,
    destinatario: str,
    nombre: str = "Inversionista",
    payload: Optional[Dict[str, Any]] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Construye y envía el email apropiado al tipo. Si dry_run=True, sólo
    regresa el HTML sin mandar.
    """
    payload = payload or {}
    tipo = (tipo or "").strip().lower()

    if tipo == "drift":
        alertas = detectar_drift(
            pesos_objetivo = payload.get("pesos_objetivo") or {},
            posiciones     = payload.get("posiciones") or [],
            umbral_pp      = float(payload.get("umbral_pp") or 5.0),
        )
        if not alertas:
            return {"ok": True, "mensaje": "Sin drift detectado — no se envió email.", "alertas": []}
        subject, html_body = render_alerta_drift(nombre, alertas)
    elif tipo in ("precio", "movimientos"):
        alertas = detectar_movimientos_precio(
            posiciones = payload.get("posiciones") or [],
            umbral_pct = float(payload.get("umbral_pct") or 5.0),
        )
        if not alertas:
            return {"ok": True, "mensaje": "Sin movimientos grandes — no se envió email.", "alertas": []}
        subject, html_body = render_alerta_precio(nombre, alertas)
    elif tipo in ("semanal", "reporte_semanal"):
        subject, html_body = render_reporte_semanal(
            nombre=nombre,
            metricas=payload.get("metricas") or {},
            top_performers=payload.get("top"),
            bottom_performers=payload.get("bottom"),
        )
    elif tipo == "periodico":
        subject, html_body = render_periodico_diario(
            nombre=nombre,
            resumen=payload.get("resumen") or {},
            cierres=payload.get("cierres") or {},
            noticias=payload.get("noticias") or [],
            posiciones=payload.get("posiciones") or [],
        )
    elif tipo in ("newsletter", "newsletter_semanal"):
        subject, html_body = render_newsletter_semanal(
            nombre=nombre,
            resumen=payload.get("resumen") or {},
            cierres=payload.get("cierres") or {},
            noticias=payload.get("noticias") or [],
            posiciones=payload.get("posiciones") or [],
            metricas=payload.get("metricas") or {},
            top_movers=payload.get("top_movers") or [],
            cetes=payload.get("cetes"),
        )
    else:
        raise ValueError(f"Tipo de alerta desconocido: {tipo!r}")

    if dry_run:
        return {"ok": True, "dry_run": True, "subject": subject, "html": html_body}

    res = _enviar(destinatario, subject, html_body)
    res["subject"] = subject
    res["tipo"] = tipo
    res["fecha"] = datetime.now().isoformat(timespec="seconds")
    return res


if __name__ == "__main__":
    print("Estado email:", estado_configuracion())
    # Dry run de drift
    res = enviar_alerta(
        tipo="drift",
        destinatario="test@example.com",
        nombre="Charlie",
        payload={
            "pesos_objetivo": {"AAPL": 40, "MSFT": 30, "GOOGL": 30},
            "posiciones": [
                {"ticker": "AAPL", "peso_pct": 48.5},
                {"ticker": "MSFT", "peso_pct": 24.0},
                {"ticker": "GOOGL", "peso_pct": 27.5},
            ],
            "umbral_pp": 5.0,
        },
        dry_run=True,
    )
    print(f"Dry run OK. Subject: {res['subject']}")
    print(f"HTML length: {len(res['html'])} chars")
