"""
asistente.py — IA conversacional sobre el portafolio del usuario.

Expone `chat(mensaje, historial, contexto_portafolio)` que consulta la
API de Anthropic (Claude) y regresa la respuesta del asistente. El
contexto del portafolio se inyecta como system prompt para que las
respuestas sean específicas a lo que el usuario tiene.

Requiere la variable de entorno ANTHROPIC_API_KEY.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import requests

# ---- Config -----------------------------------------------------------------

# Endpoint oficial de la Messages API
API_URL = "https://api.anthropic.com/v1/messages"

# Modelo por defecto (editable vía env ANTHROPIC_MODEL)
DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")

ANTHROPIC_VERSION = "2023-06-01"

# Tope de historial para no gastar tokens (pares user+assistant)
MAX_HISTORIAL_TURNOS = 12

# Máximo de tokens de salida
MAX_TOKENS_SALIDA = 1024


SYSTEM_PROMPT_BASE = """Eres el asistente financiero de portafolio-app, una plataforma mexicana de inversión para retail.

Tu objetivo: ayudar al usuario a entender su portafolio, sus números y conceptos de inversión, en español claro y sin jerga innecesaria. Respondes como alguien con conocimiento financiero pero en tono cercano, no acartonado.

Reglas estrictas:
- NUNCA des recomendaciones específicas de compra/venta ("compra X", "vende Y"). En lugar de eso, educa al usuario sobre trade-offs y factores a considerar.
- NUNCA prometas rendimientos. Todo rendimiento pasado ≠ futuro.
- Siempre que hables de números del portafolio del usuario, apóyate en los datos del CONTEXTO DEL PORTAFOLIO que recibes. No inventes cifras.
- Si el usuario pregunta algo que no se puede contestar con el contexto dado, dilo claramente y sugiere qué acción tomaría en la app (ej: "activa tus transacciones para que pueda verlo").
- Si detectas un sesgo o concentración riesgosa (p. ej. >50% en un solo ticker), menciónalo con delicadeza.
- Formato: respuestas concisas. Usa listas o bullets solo cuando realmente ayuden. No inventes tablas con muchas columnas; prefiere prosa.
- Moneda: el contexto indica la moneda. Si es mixta, recuérdalo al usuario.
- Cuando hables de impuestos, menciona ISR MX (10% sobre utilidades netas, art. 129 LISR) si aplica.
- Si el usuario pide asesoría legal o fiscal, aclara que esto es informativo, no asesoría profesional."""


def _build_context_block(contexto: Optional[Dict[str, Any]]) -> str:
    """Convierte el dict de contexto en un bloque de texto compacto para el system prompt."""
    if not contexto:
        return "CONTEXTO DEL PORTAFOLIO: (el usuario aún no ha cargado un portafolio)."

    lineas: List[str] = ["CONTEXTO DEL PORTAFOLIO:"]

    tickers = contexto.get("tickers") or []
    pesos = contexto.get("pesos") or {}
    if tickers:
        tks = []
        for t in tickers:
            w = pesos.get(t)
            if w is not None:
                try:
                    tks.append(f"{t} ({float(w) * 100:.1f}%)")
                except (ValueError, TypeError):
                    tks.append(t)
            else:
                tks.append(t)
        lineas.append(f"- Tickers ({len(tickers)}): " + ", ".join(tks))

    port = contexto.get("portafolio_metrics") or {}
    if port:
        ret = port.get("rendimiento_anualizado_pct")
        vol = port.get("volatilidad_anual_pct")
        shp = port.get("sharpe_ratio")
        parts = []
        if ret is not None:
            parts.append(f"retorno anualizado {ret:.2f}%")
        if vol is not None:
            parts.append(f"volatilidad {vol:.2f}%")
        if shp is not None:
            parts.append(f"Sharpe {shp:.2f}")
        if parts:
            lineas.append("- Métricas históricas: " + ", ".join(parts))

    totales = contexto.get("transacciones_totales") or {}
    if totales:
        partes = []
        for k, etiqueta in [
            ("invertido", "invertido"),
            ("valor_actual", "valor actual"),
            ("pnl_absoluto", "P&L"),
            ("pnl_pct", "P&L %"),
        ]:
            v = totales.get(k)
            if v is None:
                continue
            try:
                if k == "pnl_pct":
                    partes.append(f"{etiqueta} {float(v):.2f}%")
                else:
                    partes.append(f"{etiqueta} ${float(v):,.0f}")
            except (ValueError, TypeError):
                pass
        if partes:
            lineas.append("- Transacciones reales: " + ", ".join(partes))

    por_ticker = contexto.get("por_ticker") or []
    if por_ticker:
        filas = []
        for p in por_ticker[:10]:
            t = p.get("ticker", "?")
            pnl = p.get("pnl_pct")
            shares = p.get("shares_actuales")
            if pnl is not None and shares is not None:
                try:
                    filas.append(f"{t}: {float(shares):.2f} shares, P&L {float(pnl):.1f}%")
                except (ValueError, TypeError):
                    pass
        if filas:
            lineas.append("- Posiciones: " + "; ".join(filas))

    if contexto.get("moneda_mixta"):
        lineas.append("- ⚠ El portafolio tiene monedas mixtas (MX + US).")

    if contexto.get("notas"):
        for n in (contexto["notas"] or [])[:5]:
            lineas.append(f"- Nota: {n}")

    return "\n".join(lineas)


def _build_system_prompt(contexto: Optional[Dict[str, Any]]) -> str:
    contexto_txt = _build_context_block(contexto)
    return SYSTEM_PROMPT_BASE + "\n\n" + contexto_txt


def _sanitizar_historial(historial: Optional[List[Dict[str, Any]]]) -> List[Dict[str, str]]:
    """Filtra y tope el historial a pares válidos {role, content}."""
    if not historial:
        return []
    limpio: List[Dict[str, str]] = []
    for msg in historial:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        limpio.append({"role": role, "content": content.strip()})
    # Limitar: últimos MAX_HISTORIAL_TURNOS*2 mensajes
    if len(limpio) > MAX_HISTORIAL_TURNOS * 2:
        limpio = limpio[-(MAX_HISTORIAL_TURNOS * 2):]
    return limpio


def chat(
    mensaje: str,
    historial: Optional[List[Dict[str, Any]]] = None,
    contexto_portafolio: Optional[Dict[str, Any]] = None,
    modelo: Optional[str] = None,
    temperature: float = 0.4,
) -> Dict[str, Any]:
    """
    Llama a Claude vía Messages API con el mensaje del usuario.

    Returns:
        {
          "respuesta": str,          # texto del asistente
          "modelo":   str,
          "uso":      {...}|None,    # tokens si la API los regresa
        }
    Lanza ValueError si falta la API key o hay error HTTP.
    """
    if not mensaje or not mensaje.strip():
        raise ValueError("El mensaje no puede estar vacío.")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError(
            "ANTHROPIC_API_KEY no está configurada. "
            "Agrega tu API key en la variable de entorno y reinicia el backend."
        )

    system_prompt = _build_system_prompt(contexto_portafolio)
    historial_limpio = _sanitizar_historial(historial)

    # Concatenar el nuevo mensaje del usuario
    messages = list(historial_limpio) + [{"role": "user", "content": mensaje.strip()}]

    body = {
        "model": modelo or DEFAULT_MODEL,
        "max_tokens": MAX_TOKENS_SALIDA,
        "system": system_prompt,
        "messages": messages,
        "temperature": temperature,
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    try:
        r = requests.post(API_URL, headers=headers, json=body, timeout=45)
    except requests.exceptions.Timeout:
        raise ValueError("La API de Claude tardó demasiado en responder. Intenta de nuevo.")
    except requests.exceptions.RequestException as e:
        raise ValueError(f"Error de red al contactar la API de Claude: {e}")

    if r.status_code != 200:
        try:
            err = r.json()
            msg = err.get("error", {}).get("message") or str(err)
        except Exception:
            msg = r.text[:500]
        raise ValueError(f"La API de Claude regresó {r.status_code}: {msg}")

    data = r.json()
    bloques = data.get("content") or []
    partes: List[str] = []
    for b in bloques:
        if isinstance(b, dict) and b.get("type") == "text":
            partes.append(b.get("text", ""))
    respuesta = "".join(partes).strip()

    return {
        "respuesta": respuesta,
        "modelo": data.get("model", body["model"]),
        "uso": data.get("usage"),
    }


def estado_configuracion() -> Dict[str, Any]:
    """Devuelve si el asistente está listo (API key presente)."""
    return {
        "disponible": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "modelo": DEFAULT_MODEL,
    }


if __name__ == "__main__":
    print("Estado:", estado_configuracion())
    ctx = {
        "tickers": ["AAPL", "MSFT"],
        "pesos": {"AAPL": 0.6, "MSFT": 0.4},
        "portafolio_metrics": {
            "rendimiento_anualizado_pct": 18.3,
            "volatilidad_anual_pct": 22.1,
            "sharpe_ratio": 0.83,
        },
    }
    print("\nSystem prompt generado:\n")
    print(_build_system_prompt(ctx))
