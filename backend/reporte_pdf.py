"""
reporte_pdf.py — Genera el reporte profesional del portafolio en PDF.

Versión PRO (Sprint 2):
  - Portada con branding y mes/año grande
  - Índice de secciones
  - Resumen ejecutivo (4 KPIs principales)
  - Comportamiento estadístico (vol, Sharpe, Sortino, max DD, correlación)
  - Análisis de concentración (sector, país, moneda)
  - Posiciones detalladas
  - Movimientos del periodo
  - Dividendos proyectados
  - Análisis fiscal MX (ISR proyectado + oportunidades de harvest)
  - Comparativa vs benchmarks (SP500, IPC, SIEFOREs)
  - Insights automáticos
  - Disclaimer expandido + número de página

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
    KeepTogether,
)


# ---- Paleta ---------------------------------------------------------------
PRIMARY      = colors.HexColor("#0a0a0b")
INK          = colors.HexColor("#1f2937")
MUTED        = colors.HexColor("#6b7280")
BORDER       = colors.HexColor("#e4e4e7")
SOFT_BG      = colors.HexColor("#fafafa")
SOFT_BG2     = colors.HexColor("#f0f9ff")
ACCENT_GREEN = colors.HexColor("#16a34a")
ACCENT_RED   = colors.HexColor("#dc2626")
ACCENT_BLUE  = colors.HexColor("#2563eb")
ACCENT_AMBER = colors.HexColor("#d97706")
ACCENT_PURPLE = colors.HexColor("#7c3aed")
BRAND        = colors.HexColor("#22c55e")


MESES_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]


# ============================================================
#  HELPERS DE FORMATO
# ============================================================
def _mk_styles():
    ss = getSampleStyleSheet()
    return {
        "title_cover": ParagraphStyle(
            "title_cover", parent=ss["Heading1"],
            fontName="Helvetica-Bold", fontSize=44, leading=50,
            textColor=PRIMARY, alignment=TA_LEFT, spaceAfter=0,
        ),
        "subtitle_cover": ParagraphStyle(
            "subtitle_cover", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=18, leading=22,
            textColor=MUTED, alignment=TA_LEFT,
        ),
        "h1": ParagraphStyle(
            "h1", parent=ss["Heading1"],
            fontName="Helvetica-Bold", fontSize=24, leading=28,
            textColor=PRIMARY, spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "h2", parent=ss["Heading2"],
            fontName="Helvetica-Bold", fontSize=15, leading=18,
            textColor=PRIMARY, spaceBefore=18, spaceAfter=8,
        ),
        "h3": ParagraphStyle(
            "h3", parent=ss["Heading3"],
            fontName="Helvetica-Bold", fontSize=11, leading=14,
            textColor=INK, spaceBefore=10, spaceAfter=6,
        ),
        "eyebrow": ParagraphStyle(
            "eyebrow", parent=ss["BodyText"],
            fontName="Helvetica-Bold", fontSize=9, leading=11,
            textColor=BRAND, spaceAfter=2,
        ),
        "body": ParagraphStyle(
            "body", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=10.5, leading=15,
            textColor=INK, spaceAfter=4,
        ),
        "muted": ParagraphStyle(
            "muted", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=9, leading=12,
            textColor=MUTED,
        ),
        "tiny": ParagraphStyle(
            "tiny", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=8, leading=11,
            textColor=MUTED,
        ),
        "meta": ParagraphStyle(
            "meta", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=9, leading=12,
            textColor=MUTED, alignment=TA_RIGHT,
        ),
        "kpi_label": ParagraphStyle(
            "kpi_label", parent=ss["BodyText"],
            fontName="Helvetica-Bold", fontSize=8, leading=10,
            textColor=MUTED, spaceAfter=2,
        ),
        "kpi_value": ParagraphStyle(
            "kpi_value", parent=ss["BodyText"],
            fontName="Helvetica-Bold", fontSize=17, leading=20,
            textColor=PRIMARY,
        ),
        "kpi_sub": ParagraphStyle(
            "kpi_sub", parent=ss["BodyText"],
            fontName="Helvetica", fontSize=8, leading=10,
            textColor=MUTED, spaceBefore=2,
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


def _fmt_pct_frac(x: Optional[float], decimales: int = 2) -> str:
    """Para valores en fracción (0.05 = 5%)."""
    if x is None:
        return "—"
    try:
        return f"{float(x) * 100:.{decimales}f}%"
    except (ValueError, TypeError):
        return "—"


def _fmt_pct_signed(x: Optional[float], decimales: int = 2) -> str:
    if x is None:
        return "—"
    try:
        v = float(x)
        sign = "+" if v >= 0 else ""
        return f"{sign}{v:.{decimales}f}%"
    except (ValueError, TypeError):
        return "—"


# ============================================================
#  COMPONENTES VISUALES
# ============================================================
def _kpi_card(label: str, value: str, sub: str = "", color: Optional[colors.Color] = None) -> Table:
    """Una sola card de KPI."""
    styles = _mk_styles()
    color_val = (color or PRIMARY).hexval()
    _esc = lambda s: str(s).replace("&", "&amp;")
    labelP = Paragraph(f"<font size=8 color='#6b7280'><b>{_esc(label.upper())}</b></font>", styles["muted"])
    valueP = Paragraph(f"<font size=17 color='{color_val}'><b>{_esc(value)}</b></font>", styles["body"])
    subP   = Paragraph(f"<font size=8 color='#6b7280'>{_esc(sub)}</font>", styles["muted"]) if sub else Paragraph("", styles["tiny"])
    return [labelP, Spacer(1, 3), valueP, Spacer(1, 3), subP]


def _kpi_row(kpis: List[Dict[str, Any]], n_cols: Optional[int] = None) -> Table:
    """Fila de KPIs. Si n_cols se especifica, hace grid de varias filas."""
    if not kpis:
        return Spacer(1, 1)
    color_map = {
        "green": ACCENT_GREEN, "red": ACCENT_RED, "blue": ACCENT_BLUE,
        "amber": ACCENT_AMBER, "purple": ACCENT_PURPLE,
    }
    cells = [_kpi_card(k["label"], str(k.get("value", "—")), k.get("sub", ""),
                        color_map.get(k.get("color"))) for k in kpis]

    n = len(cells)
    if n_cols is None:
        # Auto: 4 por fila max
        n_cols = min(4, n)

    rows = []
    for i in range(0, n, n_cols):
        row = cells[i:i + n_cols]
        # Rellenar con celdas vacías si la fila no completa
        while len(row) < n_cols:
            row.append([Spacer(1, 1)])
        rows.append(row)

    col_width = (17 * cm) / n_cols
    t = Table(rows, colWidths=[col_width] * n_cols)
    t.setStyle(TableStyle([
        ("BOX",        (0, 0), (-1, -1), 0.4, BORDER),
        ("INNERGRID",  (0, 0), (-1, -1), 0.4, BORDER),
        ("VALIGN",     (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",(0, 0), (-1, -1), 10),
        ("RIGHTPADDING",(0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, -1), SOFT_BG),
    ]))
    return t


def _tabla_distribucion(titulo: str, dist: Dict[str, float], top_n: int = 10) -> Table:
    """Tabla de distribución con barras de progreso ASCII."""
    if not dist:
        return Paragraph("Sin datos disponibles.", _mk_styles()["muted"])
    items = sorted(dist.items(), key=lambda x: -x[1])[:top_n]
    total = sum(v for _, v in items)
    header = ["Categoría", "Peso", "Barra"]
    rows = [header]
    for cat, peso in items:
        pct = (peso / total * 100) if total > 0 else 0
        # Barra ASCII proporcional
        n_bloques = int(pct / 5)  # cada bloque = 5%
        barra = "█" * n_bloques + "░" * (20 - n_bloques)
        rows.append([str(cat), f"{pct:.1f}%", barra])

    t = Table(rows, colWidths=[7 * cm, 2.5 * cm, 7.5 * cm])
    t.setStyle(TableStyle([
        ("FONTNAME",        (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",        (0, 0), (-1, -1), 9),
        ("BACKGROUND",      (0, 0), (-1, 0), SOFT_BG),
        ("TEXTCOLOR",       (0, 0), (-1, 0), PRIMARY),
        ("LINEBELOW",       (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW",       (0, 1), (-1, -1), 0.25, BORDER),
        ("ALIGN",           (1, 1), (1, -1), "RIGHT"),
        ("FONTNAME",        (2, 1), (2, -1), "Courier"),
        ("TEXTCOLOR",       (2, 1), (2, -1), BRAND),
        ("LEFTPADDING",     (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",    (0, 0), (-1, -1), 8),
        ("TOPPADDING",      (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",   (0, 0), (-1, -1), 6),
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
            _fmt_money_full(p.get("precio_actual")),
            _fmt_money(p.get("valor_actual")),
            peso_str,
            pnl_str,
        ])

    t = Table(rows, colWidths=[3.4 * cm, 2.4 * cm, 2.8 * cm, 2.8 * cm, 2.2 * cm, 2.4 * cm])
    style = TableStyle([
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 8.5),
        ("BACKGROUND",   (0, 0), (-1, 0), SOFT_BG),
        ("TEXTCOLOR",    (0, 0), (-1, 0), PRIMARY),
        ("LINEBELOW",    (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW",    (0, 1), (-1, -1), 0.2, BORDER),
        ("ALIGN",        (1, 1), (-1, -1), "RIGHT"),
        ("ALIGN",        (0, 0), (0, -1), "LEFT"),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("FONTNAME",     (0, 1), (0, -1), "Courier-Bold"),
    ])
    # Colorear P&L
    for i, p in enumerate(posiciones or [], start=1):
        pnl_pct = p.get("pnl_pct")
        if pnl_pct is not None:
            color = ACCENT_GREEN if pnl_pct >= 0 else ACCENT_RED
            style.add("TEXTCOLOR", (5, i), (5, i), color)
            style.add("FONTNAME", (5, i), (5, i), "Helvetica-Bold")
    t.setStyle(style)
    return t


def _tabla_movimientos(movs: List[Dict[str, Any]]) -> Table:
    header = ["Fecha", "Ticker", "Tipo", "Shares", "Precio", "Total"]
    rows: List[List[Any]] = [header]
    for m in movs or []:
        tipo = (m.get("tipo") or "").capitalize()
        rows.append([
            m.get("fecha") or "—",
            m.get("ticker") or "—",
            tipo,
            f"{m.get('shares') or 0:.2f}",
            _fmt_money_full(m.get("precio")),
            _fmt_money(m.get("total")),
        ])

    t = Table(rows, colWidths=[2.6 * cm, 2.8 * cm, 1.8 * cm, 2.2 * cm, 2.6 * cm, 2.6 * cm])
    style = TableStyle([
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 8.5),
        ("BACKGROUND",   (0, 0), (-1, 0), SOFT_BG),
        ("LINEBELOW",    (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW",    (0, 1), (-1, -1), 0.2, BORDER),
        ("ALIGN",        (3, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("FONTNAME",     (1, 1), (1, -1), "Courier-Bold"),
    ])
    # Colorear tipo
    for i, m in enumerate(movs or [], start=1):
        tipo = (m.get("tipo") or "").lower()
        if tipo.startswith("c"):
            style.add("TEXTCOLOR", (2, i), (2, i), ACCENT_GREEN)
        elif tipo.startswith("v"):
            style.add("TEXTCOLOR", (2, i), (2, i), ACCENT_RED)
    t.setStyle(style)
    return t


def _tabla_comparativa(comparativa: List[Dict[str, Any]]) -> Table:
    """Tabla comparativa vs benchmarks."""
    header = ["Benchmark", "Retorno", "Volatilidad", "Sharpe", "Max DD"]
    rows = [header]
    for c in comparativa:
        rows.append([
            c.get("nombre", "—"),
            _fmt_pct_signed(c.get("retorno_pct"), 2),
            _fmt_pct(c.get("volatilidad_pct"), 1),
            f"{c.get('sharpe'):.2f}" if c.get("sharpe") is not None else "—",
            _fmt_pct_signed(c.get("max_dd_pct"), 1),
        ])
    t = Table(rows, colWidths=[4.5 * cm, 2.8 * cm, 2.8 * cm, 2.4 * cm, 2.5 * cm])
    t.setStyle(TableStyle([
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("BACKGROUND",   (0, 0), (-1, 0), SOFT_BG),
        ("BACKGROUND",   (0, 1), (-1, 1), SOFT_BG2),
        ("LINEBELOW",    (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW",    (0, 1), (-1, -1), 0.2, BORDER),
        ("ALIGN",        (1, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING",   (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
    ]))
    return t


def _pie_pagina(canvas, doc):
    """Footer + número de página."""
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    page_num = canvas.getPageNumber()
    if page_num > 1:  # No mostrar en la portada
        canvas.drawCentredString(A4[0] / 2, 1.0 * cm,
                                  f"Mi Portafolio · miportafolio.uk · Página {page_num}")
        canvas.drawRightString(A4[0] - 2 * cm, 1.0 * cm,
                                datetime.now().strftime("%d %b %Y"))
    canvas.restoreState()


# ============================================================
#  GENERADOR PRINCIPAL
# ============================================================
def generar_reporte(
    datos: Dict[str, Any],
    mes: Optional[int] = None,
    anio: Optional[int] = None,
    nombre_usuario: str = "Inversionista",
) -> bytes:
    """
    Genera el PDF profesional del portafolio.

    `datos` (todos opcionales — secciones se omiten si faltan):
        {
          "portafolio_metrics": {sharpe_ratio, volatilidad_anual_pct,
                                  rendimiento_anualizado_pct, max_drawdown_pct, ...},
          "totales":            {invertido, valor_actual, pnl_absoluto, pnl_pct},
          "posiciones":         [...],
          "movimientos_mes":    [...],
          "dividendos":         {ingreso_anual_estimado, ...},
          "insights":           [str, ...],
          "comportamiento":     {volatilidad_anual, sharpe_ratio, sortino_ratio,
                                  max_drawdown, correlacion_sp500, retorno_1m,
                                  retorno_3m, retorno_ytd, retorno_1y},
          "concentracion":      {por_sector: {Tech: 0.4, ...}, por_pais: {...},
                                  por_moneda: {...}},
          "fundamentales":      {pe_promedio, pb_promedio, peg_promedio,
                                  yield_promedio, beta_promedio, roe_promedio,
                                  margen_neto_promedio, ...},
          "fiscal":             {ano, ganancia_realizada_ano, isr_proyectado,
                                  perdidas_disponibles, oportunidades_harvest:
                                  [{ticker, perdida_latente, ahorro_isr}, ...]},
          "benchmarks":         [{nombre: "S&P 500", retorno_pct, volatilidad_pct,
                                  sharpe, max_dd_pct}, ...]
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
        topMargin=2 * cm, bottomMargin=2 * cm,
        title=f"Reporte {mes_nombre} {anio_n} — {nombre_usuario}",
        author="Mi Portafolio",
        subject="Reporte profesional de portafolio de inversión",
    )
    styles = _mk_styles()
    story: List[Any] = []

    # ========================================================
    #  PORTADA COMPACTA — todo en la primera página
    # ========================================================
    story.append(Spacer(1, 0.5 * cm))

    # Brand mark
    brand_table = Table([[
        Paragraph("<font size=11 color='#22c55e'><b>● MI PORTAFOLIO</b></font>", styles["body"]),
        Paragraph("<font size=8 color='#6b7280'>miportafolio.uk</font>", styles["meta"]),
    ]], colWidths=[10 * cm, 7 * cm])
    brand_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(brand_table)

    story.append(Spacer(1, 1.3 * cm))

    # Título principal
    story.append(Paragraph(
        "<font size=10 color='#6b7280' face='Helvetica-Bold'>REPORTE DEL PORTAFOLIO</font>",
        styles["eyebrow"],
    ))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph(f"{mes_nombre} {anio_n}", styles["title_cover"]))
    story.append(Spacer(1, 4 * mm))

    # Línea decorativa
    linea = Table([[""]], colWidths=[6 * cm], rowHeights=[2])
    linea.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 2, BRAND)]))
    story.append(linea)
    story.append(Spacer(1, 6 * mm))

    # Para usuario
    story.append(Paragraph(
        f"<font size=11 color='#1f2937'>Preparado para</font> "
        f"<font size=13 color='#0a0a0b'><b>{nombre_usuario}</b></font>",
        styles["body"],
    ))
    story.append(Spacer(1, 8 * mm))

    # KPIs principales en portada
    totales = datos.get("totales") or {}
    valor_actual = totales.get("valor_actual")
    pnl_pct = totales.get("pnl_pct")
    portfolio_metrics = datos.get("portafolio_metrics") or {}

    portada_kpis = [
        {"label": "Valor del portafolio", "value": _fmt_money(valor_actual)},
        {"label": "Rendimiento total", "value": _fmt_pct(pnl_pct, 2),
         "color": "green" if (pnl_pct or 0) >= 0 else "red"},
        {"label": "Sharpe ratio", "value": f"{portfolio_metrics.get('sharpe_ratio', 0):.2f}" if portfolio_metrics.get('sharpe_ratio') else "—"},
    ]
    story.append(_kpi_row(portada_kpis, n_cols=3))

    # Footer de portada
    story.append(Spacer(1, 1 * cm))
    story.append(Paragraph(
        f"<font size=9 color='#6b7280'>Generado el {now.strftime('%d de %B de %Y a las %H:%M')}</font>",
        styles["muted"],
    ))

    # ========================================================
    #  ÍNDICE COMPACTO (en la misma página de portada)
    # ========================================================
    story.append(Spacer(1, 1.2 * cm))
    story.append(Paragraph("<font size=9 color='#6b7280' face='Helvetica-Bold'>EN ESTE REPORTE</font>", styles["eyebrow"]))
    story.append(Spacer(1, 3 * mm))

    _comp = datos.get("comportamiento") or {}
    _conc = datos.get("concentracion") or {}
    _fund = datos.get("fundamentales") or {}
    _div  = datos.get("dividendos") or {}
    # Mismas condiciones EXACTAS que usa el cuerpo, para que la numeración cuadre.
    secciones_disponibles = ["Resumen ejecutivo"]
    if _comp and any(v is not None for v in _comp.values()):
        secciones_disponibles.append("Comportamiento estadístico")
    if _conc.get("por_sector") or _conc.get("por_pais") or _conc.get("por_moneda"):
        secciones_disponibles.append("Análisis de concentración")
    if datos.get("posiciones"):
        secciones_disponibles.append("Posiciones al cierre")
    if _fund and any(v is not None for v in _fund.values() if not isinstance(v, dict)):
        secciones_disponibles.append("Fundamentales del portafolio")
    if datos.get("movimientos_mes"):
        secciones_disponibles.append(f"Movimientos de {mes_nombre}")
    if (_div.get("ingreso_anual_estimado") or 0) > 0:
        secciones_disponibles.append("Ingreso pasivo proyectado")
    if datos.get("fiscal"):
        secciones_disponibles.append("Análisis fiscal mexicano")
    if datos.get("benchmarks"):
        secciones_disponibles.append("Comparativa vs benchmarks")
    if datos.get("insights"):
        secciones_disponibles.append("Observaciones del periodo")

    def _sn(nombre):
        """Número de sección (alineado con el índice). 00 si no está."""
        try:
            return f"{secciones_disponibles.index(nombre) + 1:02d}"
        except ValueError:
            return "00"

    # Lista compacta inline en 2 columnas
    half = (len(secciones_disponibles) + 1) // 2
    col_a = secciones_disponibles[:half]
    col_b = secciones_disponibles[half:]
    while len(col_b) < len(col_a):
        col_b.append("")
    indice_rows = []
    for i, (a, b) in enumerate(zip(col_a, col_b)):
        idx_a = f"<font size=9 color='#22c55e'><b>{i+1:02d}.</b></font> <font size=10>{a}</font>" if a else ""
        idx_b = f"<font size=9 color='#22c55e'><b>{i+1+half:02d}.</b></font> <font size=10>{b}</font>" if b else ""
        indice_rows.append([Paragraph(idx_a, styles["body"]), Paragraph(idx_b, styles["body"])])
    if indice_rows:
        indice_table = Table(indice_rows, colWidths=[8.5 * cm, 8.5 * cm])
        indice_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(indice_table)

    story.append(PageBreak())

    # ========================================================
    #  RESUMEN EJECUTIVO
    # ========================================================
    story.append(Paragraph(f"{_sn('Resumen ejecutivo')} · Resumen ejecutivo", styles["h1"]))
    story.append(Spacer(1, 4 * mm))

    pnl_abs   = totales.get("pnl_absoluto")
    invertido = totales.get("invertido")
    retorno_anual = portfolio_metrics.get("rendimiento_anualizado_pct")
    sharpe        = portfolio_metrics.get("sharpe_ratio")
    volatilidad   = portfolio_metrics.get("volatilidad_anual_pct")
    pnl_color = "green" if (pnl_abs or 0) >= 0 else "red"

    resumen_kpis = [
        {"label": "Valor actual",   "value": _fmt_money(valor_actual),   "sub": f"Invertido: {_fmt_money(invertido)}"},
        {"label": "P&L absoluto",   "value": _fmt_money(pnl_abs),        "sub": _fmt_pct(pnl_pct, 2), "color": pnl_color},
        {"label": "Retorno anual",  "value": _fmt_pct(retorno_anual, 2), "sub": f"Volatilidad {_fmt_pct(volatilidad, 1)}"},
        {"label": "Sharpe",         "value": f"{sharpe:.2f}" if sharpe is not None else "—", "sub": "Retorno por unidad de riesgo"},
    ]
    story.append(_kpi_row(resumen_kpis))
    story.append(Spacer(1, 6 * mm))

    # Narrativa
    story.append(Paragraph("Cómo te fue", styles["h2"]))
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
            narrativa += "Tu Sharpe ratio es <b>sólido</b> — estás siendo compensado bien por el riesgo que tomas."
        elif sharpe > 0.5:
            narrativa += "Tu Sharpe ratio es <b>razonable</b>, aunque hay espacio para mejorarlo."
        else:
            narrativa += "Tu Sharpe ratio está <b>bajo</b> — estás asumiendo mucho riesgo para el retorno obtenido."
    story.append(Paragraph(narrativa, styles["body"]))

    # ========================================================
    #  COMPORTAMIENTO ESTADÍSTICO (comparte página con resumen)
    # ========================================================
    comp = datos.get("comportamiento")
    if comp:
        # Solo agregar si hay al menos un valor no-null
        if any(v is not None for v in comp.values()):
            story.append(Spacer(1, 8 * mm))
            story.append(Paragraph(f"{_sn('Comportamiento estadístico')} · Comportamiento estadístico", styles["h2"]))
            story.append(Paragraph(
                "Métricas de riesgo y rendimiento que aplican a cualquier tipo de activo.",
                styles["muted"],
            ))
            story.append(Spacer(1, 3 * mm))
            comp_kpis = []
            if comp.get("volatilidad_anual") is not None:
                comp_kpis.append({"label": "Volatilidad anual", "value": _fmt_pct_frac(comp["volatilidad_anual"], 1)})
            if comp.get("sharpe_ratio") is not None:
                comp_kpis.append({"label": "Sharpe", "value": f"{comp['sharpe_ratio']:.2f}"})
            if comp.get("sortino_ratio") is not None:
                comp_kpis.append({"label": "Sortino", "value": f"{comp['sortino_ratio']:.2f}"})
            if comp.get("max_drawdown") is not None:
                comp_kpis.append({"label": "Max DD 1Y", "value": _fmt_pct_frac(comp["max_drawdown"], 1), "color": "red"})
            if comp.get("correlacion_sp500") is not None:
                comp_kpis.append({"label": "Correlación S&P 500", "value": f"{comp['correlacion_sp500']:.2f}"})
            for lab, key in [("Retorno 1M", "retorno_1m"), ("Retorno YTD", "retorno_ytd"), ("Retorno 1Y", "retorno_1y")]:
                v = comp.get(key)
                if v is not None:
                    comp_kpis.append({"label": lab, "value": _fmt_pct_frac(v, 2), "color": "green" if v >= 0 else "red"})
            if comp_kpis:
                _nc = 3 if len(comp_kpis) in (3, 5, 6) else min(4, len(comp_kpis))
                story.append(_kpi_row(comp_kpis, n_cols=_nc))

    # ========================================================
    #  CONCENTRACIÓN (nueva página solo si hay datos suficientes)
    # ========================================================
    conc = datos.get("concentracion")
    if conc and (conc.get("por_sector") or conc.get("por_pais") or conc.get("por_moneda")):
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Análisis de concentración')} · Análisis de concentración", styles["h2"]))
        story.append(Paragraph(
            "Cómo se distribuye el peso de tu portafolio. Concentraciones &gt;40% en un solo "
            "sector/país sugieren revisar diversificación.",
            styles["muted"],
        ))
        if conc.get("por_sector"):
            story.append(Paragraph("Por sector", styles["h3"]))
            story.append(_tabla_distribucion("Sector", conc["por_sector"]))
        if conc.get("por_pais"):
            story.append(Paragraph("Por país", styles["h3"]))
            story.append(_tabla_distribucion("País", conc["por_pais"]))
        if conc.get("por_moneda"):
            story.append(Paragraph("Por moneda", styles["h3"]))
            story.append(_tabla_distribucion("Moneda", conc["por_moneda"]))

    # ========================================================
    #  POSICIONES + FUNDAMENTALES (juntos cuando posiciones es chica)
    # ========================================================
    posiciones = datos.get("posiciones") or []
    fund = datos.get("fundamentales")

    if posiciones:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Posiciones al cierre')} · Posiciones al cierre", styles["h2"]))
        story.append(Paragraph(
            f"{len(posiciones)} posiciones activas en el portafolio.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        story.append(_tabla_posiciones(posiciones))

    if fund and any(v is not None for v in fund.values() if not isinstance(v, dict)):
        # Si posiciones es chica (<8), poner fundamentales en la misma página
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Fundamentales del portafolio')} · Fundamentales del portafolio", styles["h2"]))
        story.append(Paragraph(
            "Promedios de las métricas fundamentales de tus posiciones (solo las disponibles).",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        fund_kpis = []
        if fund.get("pe_promedio") is not None:
            fund_kpis.append({"label": "P/E promedio", "value": f"{fund['pe_promedio']:.1f}"})
        if fund.get("pb_promedio") is not None:
            fund_kpis.append({"label": "P/B promedio", "value": f"{fund['pb_promedio']:.2f}"})
        if fund.get("peg_promedio") is not None:
            fund_kpis.append({"label": "PEG promedio", "value": f"{fund['peg_promedio']:.2f}"})
        if fund.get("yield_promedio") is not None:
            fund_kpis.append({"label": "Dividend yield", "value": _fmt_pct_frac(fund["yield_promedio"], 2), "color": "green"})
        if fund.get("beta_promedio") is not None:
            fund_kpis.append({"label": "Beta promedio", "value": f"{fund['beta_promedio']:.2f}"})
        if fund.get("roe_promedio") is not None:
            fund_kpis.append({"label": "ROE promedio", "value": _fmt_pct_frac(fund["roe_promedio"], 1)})
        if fund.get("margen_neto_promedio") is not None:
            fund_kpis.append({"label": "Margen neto", "value": _fmt_pct_frac(fund["margen_neto_promedio"], 1)})
        if fund.get("debt_equity_promedio") is not None:
            fund_kpis.append({"label": "Debt/Equity", "value": f"{fund['debt_equity_promedio']:.2f}"})
        if fund_kpis:
            story.append(_kpi_row(fund_kpis, n_cols=min(4, len(fund_kpis))))

    # ========================================================
    #  MOVIMIENTOS — solo si hay movimientos
    # ========================================================
    movs = datos.get("movimientos_mes") or []
    if movs:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Movimientos de ' + mes_nombre)} · Movimientos de {mes_nombre}", styles["h2"]))
        story.append(Paragraph(
            f"{len(movs)} transacciones registradas este mes.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        story.append(_tabla_movimientos(movs))

    # ========================================================
    #  DIVIDENDOS
    # ========================================================
    div = datos.get("dividendos")
    if div and (div.get("ingreso_anual_estimado") or 0) > 0:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Ingreso pasivo proyectado')} · Ingreso pasivo proyectado", styles["h2"]))
        story.append(Paragraph(
            "Dividendos esperados con base en los pagos históricos. Aproximación.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
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

    # ========================================================
    #  ANÁLISIS FISCAL MX
    # ========================================================
    fiscal = datos.get("fiscal")
    if fiscal:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Análisis fiscal mexicano')} · Análisis fiscal mexicano", styles["h2"]))
        ano_fiscal = fiscal.get("ano") or anio_n
        story.append(Paragraph(
            f"ISR ejercicio {ano_fiscal} (Art. 129 LISR — 10% sobre utilidades realizadas).",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        ganancia_realizada = fiscal.get("ganancia_realizada_ano")
        isr_proyectado = fiscal.get("isr_proyectado")
        perdidas_disp = fiscal.get("perdidas_disponibles", 0)
        fiscal_kpis = [
            {"label": f"Ganancia realizada {ano_fiscal}", "value": _fmt_money(ganancia_realizada),
             "sub": "lo que ya vendiste",
             "color": "green" if (ganancia_realizada or 0) >= 0 else "red"},
            {"label": "ISR proyectado", "value": _fmt_money(isr_proyectado),
             "sub": "10% sobre ganancia neta", "color": "amber"},
            {"label": "Pérdidas disponibles", "value": _fmt_money(perdidas_disp),
             "sub": "de años anteriores"},
        ]
        story.append(_kpi_row(fiscal_kpis, n_cols=3))

        oportunidades = fiscal.get("oportunidades_harvest") or []
        if oportunidades:
            story.append(Paragraph("Oportunidades de tax-loss harvesting", styles["h2"]))
            story.append(Paragraph(
                "Posiciones con pérdida latente que, al venderse antes del 31 de diciembre, "
                "reducen tu base gravable.",
                styles["muted"],
            ))
            harvest_rows = [["Ticker", "Pérdida latente", "Ahorro ISR"]]
            for o in oportunidades[:10]:
                harvest_rows.append([
                    o.get("ticker", "—"),
                    _fmt_money(o.get("perdida_latente")),
                    _fmt_money(o.get("ahorro_isr")),
                ])
            t = Table(harvest_rows, colWidths=[5 * cm, 5 * cm, 5 * cm])
            t.setStyle(TableStyle([
                ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
                ("BACKGROUND",   (0, 0), (-1, 0), SOFT_BG),
                ("LINEBELOW",    (0, 0), (-1, 0), 0.6, INK),
                ("LINEBELOW",    (0, 1), (-1, -1), 0.2, BORDER),
                ("ALIGN",        (1, 0), (-1, -1), "RIGHT"),
                ("TEXTCOLOR",    (1, 1), (1, -1), ACCENT_RED),
                ("TEXTCOLOR",    (2, 1), (2, -1), ACCENT_GREEN),
                ("FONTNAME",     (0, 1), (0, -1), "Courier-Bold"),
                ("TOPPADDING",   (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
            ]))
            story.append(t)

    # ========================================================
    #  COMPARATIVA VS BENCHMARKS
    # ========================================================
    bench = datos.get("benchmarks")
    if bench:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Comparativa vs benchmarks')} · Comparativa vs benchmarks", styles["h2"]))
        story.append(Paragraph(
            "Tu portafolio vs los índices de referencia.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        story.append(_tabla_comparativa(bench))

    # ========================================================
    #  INSIGHTS
    # ========================================================
    insights = datos.get("insights") or []
    if insights:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f"{_sn('Observaciones del periodo')} · Observaciones del periodo", styles["h2"]))
        story.append(Paragraph(
            "Hallazgos automáticos detectados al analizar tu portafolio.",
            styles["muted"],
        ))
        story.append(Spacer(1, 3 * mm))
        for i in insights[:12]:
            story.append(Paragraph(f"<font color='#22c55e'>●</font> {i}", styles["body"]))

    # ========================================================
    #  DISCLAIMER FINAL (compacto al fondo, sin nueva página)
    # ========================================================
    story.append(Spacer(1, 8 * mm))
    linea_final = Table([[""]], colWidths=[17 * cm], rowHeights=[0.5])
    linea_final.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER)]))
    story.append(linea_final)
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(
        "<b>Aviso legal.</b> Reporte generado automáticamente con datos de Yahoo Finance. "
        "Mi Portafolio NO es asesor financiero registrado ante CNBV — toda la información "
        "es educativa e ilustrativa. Los cálculos fiscales son aproximaciones; para tu "
        "declaración consulta un contador. El rendimiento histórico no garantiza rendimientos "
        "futuros. Las decisiones de inversión son responsabilidad del usuario.",
        styles["muted"],
    ))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(
        f"<font size=8 color='#6b7280'>Mi Portafolio · miportafolio.uk · "
        f"Generado {now.strftime('%d/%m/%Y %H:%M')}</font>",
        styles["tiny"],
    ))

    doc.build(story, onFirstPage=_pie_pagina, onLaterPages=_pie_pagina)
    return buf.getvalue()


def nombre_archivo_pdf(mes: Optional[int] = None, anio: Optional[int] = None) -> str:
    now = datetime.now()
    m = mes or now.month
    a = anio or now.year
    return f"mi-portafolio-{a}-{m:02d}.pdf"
