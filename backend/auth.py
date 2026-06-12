"""
Autenticacion ligera con magic links por email.

Diseno:
- Sin password. El usuario ingresa su correo, recibe un link con token de un solo uso.
- Los tokens expiran en 15 minutos.
- Al canjearse, se emite una sesion (cookie 'session_id') valida 30 dias.
- Persistencia en JSON plano (backend/_datos/sesiones.json) para no depender de DB.

Env vars:
- AUTH_BASE_URL         URL publica base para armar el magic link (default http://localhost:5001)
- AUTH_MAGIC_LINK_TTL   segundos (default 900)
- AUTH_SESSION_TTL      segundos (default 30 dias)
- AUTH_MOCK_MODE        'true' para imprimir el link en lugar de enviarlo por email
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Optional

# Reutilizamos el modulo de alertas para enviar correo.
try:
    from . import alertas as _alertas  # type: ignore
except Exception:  # pragma: no cover
    import alertas as _alertas  # type: ignore


_BASE_DIR = Path(__file__).resolve().parent
_DATA_DIR = _BASE_DIR / "_datos"
_DATA_DIR.mkdir(exist_ok=True)
_STORE_PATH = _DATA_DIR / "sesiones.json"

_LOCK = threading.Lock()

_MAGIC_TTL = int(os.environ.get("AUTH_MAGIC_LINK_TTL", "900"))
_SESSION_TTL = int(os.environ.get("AUTH_SESSION_TTL", str(30 * 24 * 3600)))
_BASE_URL = os.environ.get("AUTH_BASE_URL", "http://localhost:5001").rstrip("/")
_MOCK_MODE = os.environ.get("AUTH_MOCK_MODE", "").lower() in ("1", "true", "yes")


def _cargar() -> dict[str, Any]:
    if not _STORE_PATH.exists():
        return {"tokens": {}, "sesiones": {}, "usuarios": {}}
    try:
        return json.loads(_STORE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"tokens": {}, "sesiones": {}, "usuarios": {}}


def _guardar(data: dict[str, Any]) -> None:
    tmp = _STORE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_STORE_PATH)


def _limpiar_expirados(data: dict[str, Any]) -> None:
    ahora = time.time()
    tokens_vivos = {
        t: info for t, info in data.get("tokens", {}).items()
        if info.get("expira_en", 0) > ahora
    }
    sesiones_vivas = {
        s: info for s, info in data.get("sesiones", {}).items()
        if info.get("expira_en", 0) > ahora
    }
    data["tokens"] = tokens_vivos
    data["sesiones"] = sesiones_vivas


def _registrar_usuario(data: dict[str, Any], email: str) -> dict[str, Any]:
    email = email.strip().lower()
    usuarios = data.setdefault("usuarios", {})
    if email not in usuarios:
        usuarios[email] = {
            "email": email,
            "creado_en": time.time(),
            "ultima_sesion": None,
            "plan": "trial",
            "estado_pago": "inactivo",
        }
    return usuarios[email]


def solicitar_magic_link(email: str) -> dict[str, Any]:
    """Genera un token y lo envia por correo. Regresa metadata util para el cliente."""
    if not email or "@" not in email:
        raise ValueError("Email invalido")

    email = email.strip().lower()
    token = secrets.token_urlsafe(32)
    ahora = time.time()

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        _registrar_usuario(data, email)
        data.setdefault("tokens", {})[token] = {
            "email": email,
            "creado_en": ahora,
            "expira_en": ahora + _MAGIC_TTL,
            "usado": False,
        }
        _guardar(data)

    enlace = f"{_BASE_URL}/api/auth/verify?token={token}"
    enviado = False
    detalle = ""

    if _MOCK_MODE:
        print(f"[auth] MAGIC LINK para {email}: {enlace}")
        detalle = "mock_mode"
    else:
        try:
            asunto = "Tu acceso a portafolio-app"
            cuerpo_html = _html_magic_link(email, enlace)
            _alertas.enviar_correo(email, asunto, cuerpo_html)
            enviado = True
            detalle = "enviado"
        except Exception as exc:
            detalle = f"smtp_error: {exc}"

    return {
        "ok": True,
        "email": email,
        "expira_en": ahora + _MAGIC_TTL,
        "enviado": enviado,
        "detalle": detalle,
        # En mock mode devolvemos el enlace para facilitar pruebas locales.
        "enlace_debug": enlace if _MOCK_MODE else None,
    }


def verificar_token(token: str) -> dict[str, Any]:
    """Canjea un token por una sesion. Devuelve {session_id, email, expira_en}."""
    if not token:
        raise ValueError("Token vacio")

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        info = data.get("tokens", {}).get(token)
        if not info:
            raise ValueError("Token invalido o expirado")
        if info.get("usado"):
            raise ValueError("Token ya usado")

        email = info["email"]
        session_id = secrets.token_urlsafe(32)
        ahora = time.time()
        data["tokens"][token]["usado"] = True
        data.setdefault("sesiones", {})[session_id] = {
            "email": email,
            "creado_en": ahora,
            "expira_en": ahora + _SESSION_TTL,
        }
        usuarios = data.setdefault("usuarios", {})
        if email in usuarios:
            usuarios[email]["ultima_sesion"] = ahora
        _guardar(data)

    return {
        "ok": True,
        "session_id": session_id,
        "email": email,
        "expira_en": ahora + _SESSION_TTL,
    }


def obtener_sesion(session_id: Optional[str]) -> Optional[dict[str, Any]]:
    if not session_id:
        return None
    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        info = data.get("sesiones", {}).get(session_id)
        if not info:
            return None
        email = info["email"]
        usuario = data.get("usuarios", {}).get(email, {"email": email})
        return {
            "session_id": session_id,
            "email": email,
            "expira_en": info["expira_en"],
            "usuario": usuario,
        }


def cerrar_sesion(session_id: str) -> bool:
    if not session_id:
        return False
    with _LOCK:
        data = _cargar()
        if session_id in data.get("sesiones", {}):
            del data["sesiones"][session_id]
            _guardar(data)
            return True
    return False


def actualizar_plan(email: str, plan: str, estado_pago: str) -> dict[str, Any]:
    """Usado por el webhook de pagos para marcar suscripcion activa/cancelada."""
    email = email.strip().lower()
    with _LOCK:
        data = _cargar()
        usuarios = data.setdefault("usuarios", {})
        u = usuarios.setdefault(email, {"email": email, "creado_en": time.time()})
        u["plan"] = plan
        u["estado_pago"] = estado_pago
        u["actualizado_en"] = time.time()
        _guardar(data)
        return dict(u)


def _html_magic_link(email: str, enlace: str) -> str:
    return f"""<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e2e8f0;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 8px;font-size:22px">Tu acceso a portafolio-app</h1>
    <p style="margin:0 0 20px;color:#94a3b8">Hola {email}, este link es valido por 15 minutos y solo se puede usar una vez.</p>
    <a href="{enlace}" style="display:inline-block;background:#22c55e;color:#052e16;font-weight:600;padding:12px 18px;border-radius:10px;text-decoration:none">Entrar a mi portafolio</a>
    <p style="margin:24px 0 0;color:#64748b;font-size:12px">Si no lo solicitaste, ignora este mensaje.</p>
  </div>
</body></html>"""
