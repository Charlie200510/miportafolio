"""
alertas.py — Sistema de alertas inteligentes por email.

Tipos de alerta soportadas:
  1. Drift de pesos: cuando la composición real se desvía >X pp del objetivo.
  2. Movimientos de precio: caídas o subidas >Y% en una sesión.
  3. Reporte semanal: resumen empaquetado de métricas y P&L.

El envío usa SMTP (configurable por env vars). Si no hay SMTP configurado,
devolvemos el cuerpo generado pero no disparamos el correo — útil para
preview del cliente o para integrarlo con otro transport (SendGrid,
Resend, etc.) desde el mismo email_html.

Env vars:
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  (SMTP_PORT por default 587, STARTTLS)
"""

from __future__ import annotations

import html
import os
import smtplib
import ssl
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


def estado_configuracion() -> Dict[str, Any]:
    cfg = _smtp_config()
    disponible = bool(cfg["host"] and cfg["user"] and cfg["pw"] and cfg["from"])
    return {
        "disponible": disponible,
        "host":       cfg["host"],
        "from":       cfg["from"],
        "faltantes":  [k for k in ("host", "user", "pw", "from") if not cfg.get(k)],
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


# ---- Envío SMTP -------------------------------------------------------------

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

    return {"ok": True, "enviado_a": destinatario, "subject": subject}


def enviar_correo(destinatario: str, subject: str, html_body: str, reply_to: Optional[str] = None) -> Dict[str, Any]:
    """Wrapper publico para que otros modulos (auth, pagos) manden correos transaccionales."""
    return _enviar_smtp(destinatario, subject, html_body, reply_to=reply_to)


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
    else:
        raise ValueError(f"Tipo de alerta desconocido: {tipo!r}")

    if dry_run:
        return {"ok": True, "dry_run": True, "subject": subject, "html": html_body}

    res = _enviar_smtp(destinatario, subject, html_body)
    res["subject"] = subject
    res["tipo"] = tipo
    res["fecha"] = datetime.now().isoformat(timespec="seconds")
    return res


if __name__ == "__main__":
    print("Estado SMTP:", estado_configuracion())
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
