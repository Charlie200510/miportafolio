"""
jwt_auth.py — Autenticación con JWT para apps móviles (Capacitor iOS).

Coexiste con auth.py (cookies/sesiones para web). En iOS no se usan
cookies porque WKWebView las maneja inconsistentemente entre versiones.

Token = Bearer JWT firmado con HS256. TTL: 30 días por default.
Payload: { sub: user_id, email: str, plan: str, iat, exp }

Si el token está bien firmado y no caducó, el endpoint inyecta `g.user`
con la info del usuario.

Uso desde un endpoint:
    from jwt_auth import requiere_user
    @app.route("/api/algo")
    @requiere_user
    def algo():
        # g.user disponible aquí: {id, email, plan}
        ...
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from functools import wraps
from typing import Any, Optional

from flask import g, jsonify, request


# Secret se carga del entorno; si no existe, generamos uno volátil (sólo dev)
_SECRET = os.environ.get("JWT_SECRET")
if not _SECRET:
    _SECRET = secrets.token_urlsafe(48)
    print("warn: JWT_SECRET no configurado, usando uno volátil (las sesiones se invalidan al reiniciar)")

JWT_ALG     = "HS256"
JWT_TTL_SEG = 60 * 60 * 24 * 30   # 30 días


# ─────────────────────────────────────────────────────────────────
# Encoding / decoding helpers
# ─────────────────────────────────────────────────────────────────
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(message: bytes) -> bytes:
    return hmac.new(_SECRET.encode("utf-8"), message, hashlib.sha256).digest()


def crear_jwt(user_id: str, email: str, plan: str = "trial",
              ttl_seg: int = JWT_TTL_SEG) -> str:
    now = int(time.time())
    header  = {"alg": JWT_ALG, "typ": "JWT"}
    payload = {"sub": user_id, "email": email, "plan": plan,
               "iat": now, "exp": now + ttl_seg}
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64url(_sign(f"{h}.{p}".encode()))
    return f"{h}.{p}.{sig}"


def validar_jwt(token: str) -> Optional[dict]:
    """Valida firma y exp. Devuelve payload si ok; None si inválido/expirado."""
    try:
        h, p, sig = token.split(".")
    except ValueError:
        return None
    expected = _b64url(_sign(f"{h}.{p}".encode()))
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        payload = json.loads(_b64url_decode(p).decode())
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


# ─────────────────────────────────────────────────────────────────
# Decorator de autenticación
# ─────────────────────────────────────────────────────────────────
def requiere_user(fn):
    """Decorator: extrae JWT del header Authorization y carga g.user.
    Si no hay token o es inválido, regresa 401."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "no_auth", "detalle": "Falta Bearer token"}), 401
        token = auth_header[7:].strip()
        payload = validar_jwt(token)
        if not payload:
            return jsonify({"error": "invalid_token", "detalle": "Token inválido o expirado"}), 401
        g.user = {"id": payload["sub"], "email": payload["email"], "plan": payload.get("plan", "trial")}
        return fn(*args, **kwargs)
    return wrapper


def usuario_opcional(fn):
    """Como requiere_user pero no falla si no hay token. g.user puede ser None."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.user = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            payload = validar_jwt(auth_header[7:].strip())
            if payload:
                g.user = {"id": payload["sub"], "email": payload["email"], "plan": payload.get("plan", "trial")}
        return fn(*args, **kwargs)
    return wrapper


if __name__ == "__main__":
    # Test rápido
    tok = crear_jwt("user-uuid-test", "test@example.com", "premium")
    print("Token:", tok[:80] + "...")
    decoded = validar_jwt(tok)
    print("Decoded:", decoded)
    print("Inválido (firmado mal):", validar_jwt(tok[:-5] + "xxxxx"))
