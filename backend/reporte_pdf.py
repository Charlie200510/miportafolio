"""
reporte_pdf.py — Genera el reporte mensual del portafolio en PDF.

Usa reportlab para armar un documento A4 con:
  - Encabezado con mes y nombre del usuario
  - Resumen ejecutivo (capital, P&L, retorno, Sharpe)
  - Posiciones actuales
  - Movimientos del mes
  - Dividendos proyectados (si aplica)
  - Avisos / insights del mes
  - Disclaimer

Endpoint relacionado: POST /api/reporte/pdf
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Dict, List, Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# ---- Paleta (matching frontend dark accents, pero en papel claro) -----------
PRIMARY      = colors.HexColor("#1f2937")   # texto principal
MUTED        = colors.HexColor("#6b7280")   # texto secundario
BORDER       = colors.HexColor("#d4d4d8")   # líneas
SOFT_BG      = colors.HexColor("#f5f5f5")   # fondos suaves
ACCENT_GREEN = colors.HexColor("#22c55e")
ACCENT_RED   = colors.HexColor("#ef4444")
ACCENT_BLUE  = colors.HexColor("#3b82f6")
ACCENT_AMBER = colors.HexColor("#f59e0b")
ACCENT_PURPLE = colors.HexColor("#8b5cf6")


MESES_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]


def _mk_styles():
    ss = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle(
            "h1", parent=ss["Heading1"],
            fontName="Helvetica-Bold", fontSize=22, leading=26,
            textColor=PRIMARY, spaceAfter=6,
        ),
        "h2": ParagraphStyle(
            "h2", parent=ss["Heading2"],
            fontName="Helvetica-Bold", fontSize=13, leading=16,
            textColor=PRIMARY, spaceBefore=14, spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "body", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=10, leading=14,
            textColor=PRIMARY,
        ),
        "muted": ParagraphStyle(
            "muted", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=9, leading=12,
            textColor=MUTED,
        ),
        "tiny": ParagraphStyle(
            "tiny", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=8, leading=10,
            textColor=MUTED,
        ),
        "meta": ParagraphStyle(
            "meta", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=9, leading=12,
            textColor=MUTED, alignment=TA_RIGHT,
        ),
    }


def _fmt_money(x: Optional[float], simbolo: str = "$") -> str:
    if x is None:
        return "—"
    try:
        return f"{simbolo}{float(x):,.0f}"
    except (ValueError, TypeError):
        return "—"


def _fmt_money_full(x: Optional[float], simbolo: str = "$") -> str:
    if x is None:
        return "—"
    try:
        return f"{simbolo}{float(x):,.2f}"
    except (ValueError, TypeError):
        return "—"


def _fmt_pct(x: Optional[float], decimales: int = 2) -> str:
    if x is None:
        return "—"
    try:
        return f"{float(x):.{decimales}f}%"
    except (ValueError, TypeError):
        return "—"


def _color_pnl(v: Optional[float]):
    if v is None:
        return PRIMARY
    try:
        return ACCENT_GREEN if float(v) >= 0 else ACCENT_RED
    except (ValueError, TypeError):
        return PRIMARY


def _kpi_row(kpis: List[Dict[str, Any]]) -> Table:
    """Construye una fila de KPIs (4 columnas)."""
    n = len(kpis)
    if n == 0:
        return Spacer(1, 1)
    styles = _mk_styles()

    data_row = []
    for k in kpis:
        labelP = Paragraph(
            f"<font size=8 color='#6b7280'>{k['label'].upper()}</font>",
            styles["muted"],
        )
        colorHex = {
            "green": ACCENT_GREEN, "red": ACCENT_RED, "blue": ACCENT_BLUE,
            "amber": ACCENT_AMBER, "purple": ACCENT_PURPLE,
        }.get(k.get("color"), PRIMARY)
        valueP = Paragraph(
            f"<font size=15 color='{colorHex.hexval()}'><b>{k['value']}</b></font>",
            styles["body"],
        )
        subP = Paragraph(
            f"<font size=8 color='#6b7280'>{k.get('sub','')}</font>",
            styles["muted"],
        )
        cell = [labelP, Spacer(1, 2), valueP, Spacer(1, 2), subP]
        data_row.append(cell)

    t = Table([data_row], colWidths=[4.2 * cm] * n)
    t.setStyle(TableStyle([
        ("BOX",        (0, 0), (-1, -1), 0.25, BORDER),
        ("INNERGRID",  (0, 0), (-1, -1), 0.25, BORDER),
        ("VALIGN",     (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",(0, 0), (-1, -1), 8),
        ("RIGHTPADDING",(0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, -1), SOFT_BG),
    ]))
    return t


def _tabla_posiciones(posiciones: List[Dict[str, Any]], moneda: str = "$") -> Table:
    header = ["Ticker", "Shares", "Precio", "Valor", "Peso %", "P&L %"]
    rows: List[List[Any]] = [header]
    for p in posiciones or []:
        pnl_pct = p.get("pnl_pct")
        pnl_str = _fmt_pct(pnl_pct, 1) if pnl_pct is not None else "—"
        peso = p.get("peso_pct")
        peso_str = _fmt_pct(peso, 1) if peso is not None else "—"
        rows.append([
            p.get("ticker") or "—",
            f"{p.get('shares_actuales') or 0:.2f}",
            _fmt_money_full(p.get("precio_actual"), moneda),
            _fmt_money(p.get("valor_actual"), moneda),
            peso_str,
            pnl_str,
        ])

    t = Table(rows, colWidths=[2.4 * cm, 2.2 * cm, 2.4 * cm, 2.8 * cm, 2.0 * cm, 2.0 * cm])
    style = [
        ("BACKGROUND",   (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR",    (0, 0), (-1, 0), colors.white),
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("ALIGN",        (1, 0), (-1, -1), "RIGHT"),
        ("ALIGN",        (0, 0), (0, -1), "LEFT"),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW",    (0, 0), (-1, 0), 0.25, BORDER),
        ("INNERGRID",    (0, 1), (-1, -1), 0.25, BORDER),
        ("BOX",          (0, 0), (-1, -1), 0.25, BORDER),
        ("TOPPADDING",   (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT_BG]),
    ]
    # Colorear P&L por fila
    for i, p in enumerate(posiciones or [], start=1):
        pnl_pct = p.get("pnl_pct")
        if pnl_pct is not None:
            style.append(("TEXTCOLOR", (5, i), (5, i), _color_pnl(pnl_pct)))

    t.setStyle(TableStyle(style))
    return t


def _tabla_movimientos(movs: List[Dict[str, Any]]) -> Table:
    header = ["Fecha", "Ticker", "Tipo", "Shares", "Precio"]
    rows: List[List[Any]] = [header]
    for m in movs or []:
        rows.append([
            m.get("fecha") or "—",
            m.get("ticker") or "—",
            (m.get("tipo") or "").upper(),
            f"{m.get('shares') or 0:.2f}",
            _fmt_money_full(m.get("precio_unitario")),
        ])
    if len(rows) == 1:
        rows.append(["—", "Sin movimientos en el mes", "", "", ""])
    t = Table(rows, colWidths=[2.6 * cm, 2.4 * cm, 1.8 * cm, 2.0 * cm, 2.4 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR",    (0, 0), (-1, 0), colors.white),
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("ALIGN",        (3, 0), (-1, -1), "RIGHT"),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW",    (0, 0), (-1, 0), 0.25, BORDER),
        ("INNERGRID",    (0, 1), (-1, -1), 0.25, BORDER),
        ("BOX",          (0, 0), (-1, -1), 0.25, BORDER),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT_BG]),
    ]))
    return t


def _pie_pagina(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(
        2 * cm, 1.2 * cm,
        "Portafolio App · Este reporte es informativo y no constituye asesoría de inversión.",
    )
    canvas.drawRightString(
        A4[0] - 2 * cm, 1.2 * cm,
        f"Página {doc.page}",
    )
    canvas.restoreState()


# ---- API pública ----------------------------------------------------------

def generar_reporte(
    datos: Dict[str, Any],
    mes: Optional[int] = None,
    anio: Optional[int] = None,
    nombre_usuario: str = "Inversionista",
) -> bytes:
    """
    Genera el PDF del reporte mensual.

    `datos` debe incluir (los faltantes se omiten gracefully):
        {
          "portafolio_metrics": {...},
          "totales":            {invertido, valor_actual, pnl_absoluto, pnl_pct},
          "posiciones":         [...],
          "movimientos_mes":    [...],
          "dividendos":         {ingreso_anual_estimado, ingreso_mensual_promedio, yield_portafolio_pct, ...} | None,
          "insights":           [str, ...]
        }
    """
    now = datetime.now()
    mes_n = mes or now.month
    anio_n = anio or now.year
    mes_nombre = MESES_ES[(mes_n - 1) % 12]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        title=f"Reporte {mes_nombre} {anio_n} — {nombre_usuario}",
        author="Portafolio App",
    )
    styles = _mk_styles()
    story: List[Any] = []

    # ---- Encabezado ------------------------------------------------------
    cabecera = Table(
        [[
            Paragraph(f"<b>Reporte Mensual</b>", styles["h1"]),
            Paragraph(
                f"<font size=9 color='#6b7280'>{mes_nombre} {anio_n}<br/>"
                f"Generado {now.strftime('%d/%m/%Y %H:%M')}</font>",
                styles["meta"],
            ),
        ]],
        colWidths=[11 * cm, 6 * cm],
    )
    cabecera.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(cabecera)
    story.append(Paragraph(
        f"Para: <b>{nombre_usuario}</b>", styles["muted"]))
    story.append(Spacer(1, 4 * mm))

    # Línea separadora
    linea = Table([[""]], colWidths=[17 * cm], rowHeights=[0.6])
    linea.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.6, PRIMARY)]))
    story.append(linea)
    story.append(Spacer(1, 6 * mm))

    # ---- Resumen ejecutivo ---------------------------------------------
    story.append(Paragraph("Resumen ejecutivo", styles["h2"]))

    totales = datos.get("totales") or {}
    port    = datos.get("portafolio_metrics") or {}

    valor_actual = totales.get("valor_actual")
    pnl_abs      = totales.get("pnl_absoluto")
    pnl_pct      = totales.get("pnl_pct")
    invertido    = totales.get("invertido")

    retorno_anual = port.get("rendimiento_anualizado_pct")
    sharpe        = port.get("sharpe_ratio")
    volatilidad   = port.get("volatilidad_anual_pct")

    pnl_color = "green" if (pnl_abs or 0) >= 0 else "red"

    kpis = [
        {"label": "Valor actual",   "value": _fmt_money(valor_actual),   "sub": f"Invertido: {_fmt_money(invertido)}"},
        {"label": "P&L absoluto",   "value": _fmt_money(pnl_abs),        "sub": _fmt_pct(pnl_pct, 2),                      "color": pnl_color},
        {"label": "Retorno anual",  "value": _fmt_pct(retorno_anual, 2), "sub": f"Volatilidad {_fmt_pct(volatilidad,1)}"},
        {"label": "Sharpe",         "value": f"{sharpe:.2f}" if sharpe is not None else "—", "sub": "Retorno por unidad de riesgo"},
    ]
    story.append(_kpi_row(kpis))

    # ---- Narrativa del mes ----------------------------------------------
    story.append(Paragraph("Cómo te fue este mes", styles["h2"]))

    msg_pnl = "Tu portafolio subió" if (pnl_abs or 0) >= 0 else "Tu portafolio bajó"
    narrativa = (
        f"{msg_pnl} <b>{_fmt_money(abs(pnl_abs) if pnl_abs is not None else 0)}</b> "
        f"({_fmt_pct(pnl_pct, 2)} sobre lo invertido). "
    )
    if retorno_anual is not None:
        ctx = "encima del promedio histórico de acciones (~10%)" if retorno_anual > 10 else \
              "por debajo del promedio histórico de acciones (~10%)"
        narrativa += f"Tu retorno anualizado ({_fmt_pct(retorno_anual,1)}) está {ctx}. "
    if sharpe is not None:
        if sharpe > 1:
            narrativa += "Tu Sharpe ratio es sólido — estás siendo compensado bien por el riesgo que tomas."
        elif sharpe > 0.5:
            narrativa += "Tu Sharpe ratio es razonable, aunque hay espacio para mejorarlo."
        else:
            narrativa += "Tu Sharpe ratio está bajo — estás asumiendo mucho riesgo para el retorno obtenido."

    story.append(Paragraph(narrativa, styles["body"]))

    # ---- Posiciones -----------------------------------------------------
    posiciones = datos.get("posiciones") or []
    if posiciones:
        story.append(Paragraph("Posiciones al cierre", styles["h2"]))
        story.append(_tabla_posiciones(posiciones))

    # ---- Movimientos del mes -------------------------------------------
    movs = datos.get("movimientos_mes") or []
    story.append(Paragraph(f"Movimientos de {mes_nombre}", styles["h2"]))
    if movs:
        story.append(Paragraph(
            f"{len(movs)} transacciones registradas este mes.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        story.append(_tabla_movimientos(movs))
    else:
        story.append(Paragraph(
            "No hubo compras ni ventas registradas durante este mes.",
            styles["muted"],
        ))

    # ---- Dividendos ----------------------------------------------------
    div = datos.get("dividendos")
    if div and (div.get("ingreso_anual_estimado") or 0) > 0:
        story.append(Paragraph("Ingreso pasivo proyectado", styles["h2"]))
        div_kpis = [
            {"label": "Dividendos 12 meses", "value": _fmt_money(div.get("ingreso_anual_estimado")),
             "sub": f"~{_fmt_money(div.get('ingreso_mensual_promedio'))}/mes", "color": "green"},
            {"label": "Yield portafolio",    "value": _fmt_pct(div.get("yield_portafolio_pct"), 2),
             "sub": f"YoC: {_fmt_pct(div.get('yield_on_cost_pct'), 2)}"},
            {"label": "Paga dividendos",     "value": f"{div.get('num_tickers_pagan',0)} de {div.get('num_tickers_pagan',0) + div.get('num_tickers_no_pagan',0)}",
             "sub": "tickers del portafolio"},
            {"label": "Valor invertido",     "value": _fmt_money(div.get("valor_invertido")),
             "sub": f"valor actual {_fmt_money(div.get('valor_actual'))}"},
        ]
        story.append(_kpi_row(div_kpis))

    # ---- Insights / avisos ---------------------------------------------
    insights = datos.get("insights") or []
    if insights:
        story.append(Paragraph("Lo que deberías saber", styles["h2"]))
        for i in insights[:8]:
            story.append(Paragraph(f"• {i}", styles["body"]))

    # ---- Disclaimer ----------------------------------------------------
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(
        "<i>Este reporte se generó automáticamente a partir de tus tickers y transacciones. "
        "La información es educativa y no constituye asesoría de inversión. "
        "El rendimiento pasado no garantiza rendimientos futuros.</i>",
        styles["tiny"],
    ))

    doc.build(story, onFirstPage=_pie_pagina, onLaterPages=_pie_pagina)
    return buf.getvalue()


def nombre_archivo_pdf(mes: Optional[int] = None, anio: Optional[int] = None) -> str:
    now = datetime.now()
    m = mes or now.month
    a = anio or now.year
    return f"reporte_portafolio_{a:04d}_{m:02d}.pdf"


if __name__ == "__main__":
    # Sanity test
    pdf = generar_reporte({
        "portafolio_metrics": {
            "rendimiento_anualizado_pct": 12.34,
            "volatilidad_anual_pct": 18.2,
            "sharpe_ratio": 0.78,
        },
        "totales": {
            "invertido": 100000, "valor_actual": 118500,
            "pnl_absoluto": 18500, "pnl_pct": 18.5,
        },
        "posiciones": [
            {"ticker": "AAPL", "shares_actuales": 10, "precio_actual": 185.2,
             "valor_actual": 1852, "peso_pct": 45.1, "pnl_pct": 22.4},
            {"ticker": "MSFT", "shares_actuales": 5,  "precio_actual": 420.1,
             "valor_actual": 2100, "peso_pct": 54.9, "pnl_pct": 15.2},
        ],
        "movimientos_mes": [
            {"fecha": "2026-04-05", "ticker": "AAPL", "tipo": "compra",
             "shares": 2, "precio_unitario": 182.4},
        ],
        "dividendos": {
            "ingreso_anual_estimado": 12450,
            "ingreso_mensual_promedio": 1037.5,
            "yield_portafolio_pct": 2.4,
            "yield_on_cost_pct": 2.8,
            "num_tickers_pagan": 2, "num_tickers_no_pagan": 0,
            "valor_invertido": 100000, "valor_actual": 118500,
        },
        "insights": [
            "Tu retorno del mes superó al S&P 500 (+2.1 pp).",
            "Apple representa el 45% de tu cartera — concentración alta.",
        ],
    }, nombre_usuario="Charlie")
    with open("/tmp/reporte_test.pdf", "wb") as f:
        f.write(pdf)
    print(f"PDF generado: /tmp/reporte_test.pdf ({len(pdf)} bytes)")
