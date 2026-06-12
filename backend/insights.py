# ============================================================
#  INSIGHTS - Narrative hooks para el análisis del portafolio
# ============================================================
#  generar_insights(resultado) lee el JSON crudo del análisis
#  y devuelve una lista de "insights candidatos" que el frontend
#  muestra como tarjetas y (más adelante) la IA usará para
#  escribir explicaciones en lenguaje natural.
#
#  Cada insight:
#    {
#      "tipo":       "concentracion_sectorial" | "alpha" | ...
#      "severidad":  "alta" | "media" | "baja" | "positivo" | "info"
#      "titulo":     str corto (≤ 60 chars)
#      "detalle":    str con el contexto numérico
#      "orden":      int (menor = más arriba)
#      "datos":      dict con los números crudos (para IA)
#    }
#
#  Estilo / CNBV:
#  - Lenguaje informativo, nunca imperativo ("compra", "vende").
#  - Observación histórica, no recomendación personalizada.
# ============================================================
from __future__ import annotations


# Umbrales (ajustables). Todos en fracciones / pp.
UMBRAL_CONC_ALTA  = 0.60   # >60% del peso en un sector/país → alta
UMBRAL_CONC_MEDIA = 0.40   # 40-60% → media
UMBRAL_ALPHA_PP   = 2.0    # |alfa| > 2 pp/año → insight
UMBRAL_CORR_ALTA  = 0.85   # correlación > 0.85 → pareja muy redundante
UMBRAL_DSHARPE_ALTA  = 0.30
UMBRAL_DSHARPE_MEDIA = 0.10


def _benchmark_nombre(ticker: str) -> str:
    return {"^GSPC": "S&P 500", "^MXX": "IPC México"}.get(ticker or "", ticker or "benchmark")


# ------------------------------------------------------------
# 1) Concentración sectorial y por país
# ------------------------------------------------------------
def _insight_concentracion(resultado: dict) -> list[dict]:
    """Busca el sector/país con mayor peso y genera alerta si supera umbral."""
    out = []
    c = resultado.get("concentracion") or {}

    def _tomar_top(d):
        if not d:
            return None, 0.0
        k, v = max(d.items(), key=lambda kv: kv[1])
        return k, float(v)

    for campo, etiqueta in (("por_sector", "sector"), ("por_pais", "país")):
        top_k, top_v = _tomar_top(c.get(campo))
        if not top_k or top_k == "Desconocido":
            continue

        pct = top_v * 100  # backend guarda fracciones (0.65)
        if top_v >= UMBRAL_CONC_ALTA:
            out.append({
                "tipo":      f"concentracion_{etiqueta}",
                "severidad": "alta",
                "titulo":    f"Alta concentración en {top_k}",
                "detalle":   (f"{pct:.0f}% del peso está en el {etiqueta} {top_k}. "
                              f"Si ese {etiqueta} cae, tu portafolio baja casi igual."),
                "orden":     10,
                "datos":     {etiqueta: top_k, "peso_pct": round(pct, 1)},
            })
        elif top_v >= UMBRAL_CONC_MEDIA:
            out.append({
                "tipo":      f"concentracion_{etiqueta}",
                "severidad": "media",
                "titulo":    f"Peso importante en {top_k}",
                "detalle":   (f"{pct:.0f}% del portafolio está en el {etiqueta} {top_k}. "
                              f"No es extremo, pero sí una apuesta concentrada."),
                "orden":     30,
                "datos":     {etiqueta: top_k, "peso_pct": round(pct, 1)},
            })
    return out


# ------------------------------------------------------------
# 2) Alfa vs benchmark
# ------------------------------------------------------------
def _insight_alpha(resultado: dict) -> list[dict]:
    b = resultado.get("benchmark") or {}
    alpha = b.get("alpha_portafolio_pct")
    if alpha is None:
        return []

    nombre = _benchmark_nombre(b.get("ticker"))

    if alpha >= UMBRAL_ALPHA_PP:
        return [{
            "tipo":      "alpha_positivo",
            "severidad": "positivo",
            "titulo":    f"Superas al {nombre} en {alpha:.1f} pp/año",
            "detalle":   (f"Tu mezcla rindió {alpha:.1f} puntos porcentuales más al año "
                          f"que el {nombre} en este período. Rendimientos pasados no garantizan futuros."),
            "orden":     20,
            "datos":     {"alpha_pp": round(alpha, 2), "benchmark": b.get("ticker")},
        }]
    if alpha <= -UMBRAL_ALPHA_PP:
        sev = "alta" if alpha <= -5 else "media"
        return [{
            "tipo":      "alpha_negativo",
            "severidad": sev,
            "titulo":    f"Por debajo del {nombre} en {abs(alpha):.1f} pp/año",
            "detalle":   (f"Tu portafolio rindió {abs(alpha):.1f} puntos porcentuales menos al año "
                          f"que el {nombre} en el mismo período."),
            "orden":     15,
            "datos":     {"alpha_pp": round(alpha, 2), "benchmark": b.get("ticker")},
        }]
    return []


# ------------------------------------------------------------
# 3) Correlaciones altas (pares redundantes)
# ------------------------------------------------------------
def _insight_correlaciones(resultado: dict) -> list[dict]:
    corr = resultado.get("correlaciones") or {}
    tickers = list(corr.keys())
    if len(tickers) < 2:
        return []

    pares_altos = []
    for i, a in enumerate(tickers):
        for b in tickers[i + 1:]:
            v = corr.get(a, {}).get(b)
            if v is None:
                continue
            if v >= UMBRAL_CORR_ALTA:
                pares_altos.append((a, b, float(v)))

    if not pares_altos:
        return []

    pares_altos.sort(key=lambda x: -x[2])
    top = pares_altos[:3]
    detalle_pares = ", ".join(f"{a}–{b} ({v:.2f})" for a, b, v in top)
    n = len(pares_altos)

    sev = "alta" if n >= 3 else "media"
    return [{
        "tipo":      "correlacion_alta",
        "severidad": sev,
        "titulo":    (f"{n} par{'es' if n > 1 else ''} muy correlacionado{'s' if n > 1 else ''}"),
        "detalle":   (f"Se mueven casi igual (corr ≥ {UMBRAL_CORR_ALTA:.2f}): {detalle_pares}. "
                      f"Tener varios no agrega mucha diversificación."),
        "orden":     35,
        "datos":     {"pares": [{"a": a, "b": b, "corr": round(v, 3)} for a, b, v in top]},
    }]


# ------------------------------------------------------------
# 4) Mejora potencial del óptimo Markowitz
# ------------------------------------------------------------
def _insight_optimo(resultado: dict) -> list[dict]:
    opt = resultado.get("portafolio_optimo") or {}
    d = opt.get("delta_vs_actual") or {}
    ds = d.get("sharpe_ratio")
    if ds is None:
        return []

    dr = d.get("rendimiento_anualizado_pp")
    dv = d.get("volatilidad_anual_pp")

    if ds >= UMBRAL_DSHARPE_ALTA:
        sev = "alta"
        titulo = "Mezcla histórica puede ser bastante mejor"
    elif ds >= UMBRAL_DSHARPE_MEDIA:
        sev = "media"
        titulo = "Hay margen para mejorar tu mezcla"
    elif ds >= -0.05:
        return [{
            "tipo":      "optimo_cerca",
            "severidad": "positivo",
            "titulo":    "Tu mezcla ya está cerca del óptimo histórico",
            "detalle":   "Con los mismos activos, apenas ganarías ajustando pesos. Bien diversificado.",
            "orden":     50,
            "datos":     {"delta_sharpe": round(ds, 3)},
        }]
    else:
        return []

    parts = []
    if dr is not None:
        parts.append(f"{dr:+.1f} pp de rendimiento")
    if dv is not None:
        parts.append(f"{dv:+.1f} pp de volatilidad")
    if parts:
        detalle = (f"Con los mismos activos pero pesos óptimos, el Sharpe habría sido "
                   f"{ds:+.2f} ({', '.join(parts)}). Son números históricos.")
    else:
        detalle = f"Sharpe histórico habría sido {ds:+.2f} con otros pesos."

    return [{
        "tipo":      "optimo_mejor",
        "severidad": sev,
        "titulo":    titulo,
        "detalle":   detalle,
        "orden":     25,
        "datos":     {"delta_sharpe": round(ds, 3), "delta_rend_pp": dr, "delta_vol_pp": dv},
    }]


# ------------------------------------------------------------
# API pública
# ------------------------------------------------------------
def generar_insights(resultado: dict) -> list[dict]:
    """
    Devuelve una lista ordenada de insights candidatos a partir del JSON
    de análisis. Seguro ante campos faltantes: si no hay datos de algo,
    esa categoría simplemente no aporta.
    """
    insights = []
    for fn in (_insight_concentracion, _insight_alpha,
               _insight_correlaciones, _insight_optimo):
        try:
            insights.extend(fn(resultado))
        except Exception:
            # No tiramos el análisis completo si una regla falla
            continue

    # Orden: primero por 'orden' (menor = más arriba), luego severidad
    prio_sev = {"alta": 0, "media": 1, "positivo": 2, "baja": 3, "info": 4}
    insights.sort(key=lambda i: (i.get("orden", 100), prio_sev.get(i.get("severidad"), 99)))
    return insights
