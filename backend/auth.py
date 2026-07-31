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

import hashlib
import html
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

# bcrypt para el hash de contraseñas. Import guardado: si no está instalado,
# el magic-link sigue funcionando y solo el auth por contraseña lo reporta.
try:
    import bcrypt as _bcrypt  # type: ignore
except Exception:  # pragma: no cover
    _bcrypt = None


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
    # OTPs: se conserva el historial de solicitudes de la última hora aunque el
    # código haya expirado (si se borrara, pedir códigos reiniciaría el límite).
    otps_vivos: dict[str, Any] = {}
    for e, info in (data.get("otp") or {}).items():
        sols = [t for t in info.get("solicitudes", []) if t > ahora - 3600]
        if info.get("expira_en", 0) > ahora or sols:
            info["solicitudes"] = sols
            otps_vivos[e] = info
    data["otp"] = otps_vivos
    _limpiar_tombstones(data)


# ─────────────────────────────────────────────────────────────────
# Tombstones de cuentas eliminadas (App Store 5.1.1v)
# ─────────────────────────────────────────────────────────────────
# El JWT de la app nativa vive 30 dias y no se puede invalidar por firma, y el
# store de usuarios es efimero (se reconstruye en cada deploy), asi que
# app.py sintetiza un usuario cuando el JWT es valido pero el registro no
# existe. Sin esta lista, una cuenta ELIMINADA seguia autenticando con su token
# viejo (y volvia a recibir un trial nuevo), y cualquier webhook de pago la
# resucitaba via actualizar_plan(). Guardamos solo un HASH del correo (no el
# correo) y lo purgamos al caducar el token, para no retener datos personales.
_TOMBSTONE_TTL = max(_SESSION_TTL, 30 * 24 * 3600)


def _hash_email(email: str) -> str:
    return hashlib.sha256(("cuenta-eliminada:" + (email or "").strip().lower()).encode("utf-8")).hexdigest()


def _limpiar_tombstones(data: dict[str, Any]) -> None:
    ahora = time.time()
    data["eliminados"] = {
        h: ts for h, ts in (data.get("eliminados") or {}).items()
        if isinstance(ts, (int, float)) and ts > ahora - _TOMBSTONE_TTL
    }


def _esta_eliminado(data: dict[str, Any], email: str) -> bool:
    """Version para usar DENTRO de _LOCK (que no es reentrante)."""
    if not email:
        return False
    return _hash_email(email) in (data.get("eliminados") or {})


def cuenta_eliminada(email: str) -> bool:
    """True si esta cuenta se elimino y su token viejo aun podria estar vivo."""
    email = (email or "").strip().lower()
    if not email:
        return False
    with _LOCK:
        return _esta_eliminado(_cargar(), email)


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
        # Alta explicita: si esa cuenta se habia eliminado, el usuario tiene
        # derecho a volver a registrarse — se levanta el tombstone.
        (data.get("eliminados") or {}).pop(_hash_email(email), None)
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
            # Al log del servidor: antes el único rastro de un fallo de envío
            # era el cuerpo de la respuesta HTTP, así que el correo podía estar
            # caído durante días sin que apareciera nada en journalctl.
            print(f"[auth] FALLO al enviar magic link a {email}: {exc}", flush=True)

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

    es_primera_sesion = False
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
            es_primera_sesion = usuarios[email].get("ultima_sesion") is None
            usuarios[email]["ultima_sesion"] = ahora
        _guardar(data)

    # Email de bienvenida (solo primera sesion). Fuera del lock para no
    # bloquear otras requests si el envio tarda.
    # La marca `bienvenida_enviada` se escribe DESPUÉS de que el envío salió: si
    # se pone antes (como estaba) y el envío falla, queda marcado como enviado y
    # nadie lo reintenta nunca. No bloquea el login: si falla, solo se registra.
    if es_primera_sesion:
        try:
            asunto = "Bienvenido a Mi Portafolio"
            cuerpo = _html_bienvenida(email)
            _alertas.enviar_correo(email, asunto, cuerpo)
            with _LOCK:
                data = _cargar()
                if email in data.get("usuarios", {}):
                    data["usuarios"][email]["bienvenida_enviada"] = True
                    _guardar(data)
        except Exception as exc:
            print(f"[auth] no se pudo enviar email de bienvenida a {email}: {exc}", flush=True)

    return {
        "ok": True,
        "session_id": session_id,
        "email": email,
        "expira_en": ahora + _SESSION_TTL,
        "primera_sesion": es_primera_sesion,
    }


def _html_bienvenida(email: str) -> str:
    """Email de bienvenida — onboarding rápido con los 3 primeros pasos."""
    nombre = (email or "").split("@")[0]
    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#fafafa;color:#18181b;">
<div style="max-width:600px;margin:20px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;padding:32px 28px;">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.8;">Mi Portafolio</p>
    <h1 style="margin:6px 0 0 0;font-size:26px;font-weight:700;">Bienvenido, {html.escape(nombre)}</h1>
    <p style="margin:8px 0 0 0;opacity:0.9;font-size:14px;">Tu análisis financiero profesional empieza ahora.</p>
  </div>
  <div style="padding:28px 24px;">
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
      Gracias por unirte. Mi Portafolio te da las mismas herramientas que usan los
      analistas profesionales — Markowitz, Sharpe, backtesting y stress tests — adaptadas
      al inversionista mexicano (BMV, SIC, ISR del 10%).
    </p>
    <h3 style="margin:24px 0 12px;font-size:14px;color:#16a34a;text-transform:uppercase;letter-spacing:1px;">Primeros pasos (5 min)</h3>
    <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:18px;margin-bottom:18px;">
      <p style="margin:0 0 12px;font-weight:600;">1 · Define tu portafolio</p>
      <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.5;">
        Ve a Mi Portafolio y pega 3-10 tickers. AAPL, NVDA, WALMEX.MX, GFNORTEO.MX, BTC-USD funcionan.
      </p>
    </div>
    <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:18px;margin-bottom:18px;">
      <p style="margin:0 0 12px;font-weight:600;">2 · Activa las alertas automáticas</p>
      <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.5;">
        En la pestaña Alertas, marca las 3 opciones (drift, precio, semanal) para recibir
        avisos importantes sobre tus inversiones sin tener que entrar a la app.
      </p>
    </div>
    <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:18px;margin-bottom:18px;">
      <p style="margin:0 0 12px;font-weight:600;">3 · Explora los perfiles pre-armados</p>
      <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.5;">
        Si quieres una mezcla óptima sin pensar mucho, abajo de la página principal hay 10
        portafolios pre-armados — desde conservador hasta agresivo.
      </p>
    </div>
    <div style="text-align:center;margin:28px 0 8px;">
      <a href="https://miportafolio.uk" style="display:inline-block;background:#22c55e;color:#0a0a0b;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:10px;font-size:15px;">Abrir Mi Portafolio →</a>
    </div>
  </div>
  <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:11px;color:#71717a;line-height:1.5;">
    Si tienes dudas, responde a este email — leemos todas.<br>
    NO somos asesor financiero registrado ante CNBV. Esta herramienta es educativa.
  </div>
</div></body></html>"""


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


def obtener_usuario(email: str) -> Optional[dict[str, Any]]:
    """Devuelve el registro del usuario por email (plan, creado_en, etc.) o None.

    Lo usa la resolucion de identidad por JWT (app nativa) para construir el
    estado de sesion sin cookie.
    """
    email = (email or "").strip().lower()
    if not email:
        return None
    with _LOCK:
        data = _cargar()
        u = data.get("usuarios", {}).get(email)
        return dict(u) if u else None


# ─────────────────────────────────────────────────────────────────
# Autenticación con correo + CONTRASEÑA (flujo principal de la app nativa)
# ─────────────────────────────────────────────────────────────────
PASSWORD_DISPONIBLE = _bcrypt is not None


def _validar_credenciales(email: str, password: str) -> str:
    email = (email or "").strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise ValueError("Correo inválido")
    if not password or len(password) < 8:
        raise ValueError("La contraseña debe tener al menos 8 caracteres")
    if len(password) > 128:
        raise ValueError("La contraseña es demasiado larga (máx 128)")
    return email


def _hash_password(password: str) -> str:
    # bcrypt trunca a 72 bytes; lo dejamos explícito para no depender del truncado silencioso.
    return _bcrypt.hashpw(password.encode("utf-8")[:72], _bcrypt.gensalt()).decode("utf-8")


def _verificar_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return _bcrypt.checkpw(password.encode("utf-8")[:72], hashed.encode("utf-8"))
    except Exception:
        return False


def registrar_con_password(email: str, password: str) -> dict[str, Any]:
    """Crea una cuenta nueva con contraseña. Inicia el trial (creado_en = ahora).
    Falla si el correo ya tiene cuenta (evita apropiación de cuentas existentes)."""
    if _bcrypt is None:
        raise RuntimeError("auth por contraseña no disponible (falta bcrypt en el servidor)")
    email = _validar_credenciales(email, password)
    ahora = time.time()
    with _LOCK:
        data = _cargar()
        usuarios = data.setdefault("usuarios", {})
        if email in usuarios:
            raise ValueError("Ese correo ya tiene una cuenta. Inicia sesión.")
        usuarios[email] = {
            "email": email,
            "creado_en": ahora,          # ← inicio del trial POR CUENTA (server-side)
            "ultima_sesion": ahora,
            "plan": "trial",
            "estado_pago": "inactivo",
            "password_hash": _hash_password(password),
            "auth": "password",
        }
        # Alta explicita: si esa cuenta se habia eliminado, el usuario tiene
        # derecho a volver a registrarse — se levanta el tombstone.
        (data.get("eliminados") or {}).pop(_hash_email(email), None)
        _guardar(data)
    return {"email": email, "creado_en": ahora, "plan": "trial", "nueva": True}


def login_con_password(email: str, password: str) -> dict[str, Any]:
    """Verifica correo+contraseña. Devuelve el usuario o lanza ValueError.
    Mensaje de error genérico (no revela si el correo existe)."""
    if _bcrypt is None:
        raise RuntimeError("auth por contraseña no disponible (falta bcrypt en el servidor)")
    email = (email or "").strip().lower()
    if not email or not password:
        raise ValueError("Correo o contraseña incorrectos")
    with _LOCK:
        data = _cargar()
        u = data.get("usuarios", {}).get(email)
        # Verifica SIEMPRE contra un hash (real o dummy) para gastar el mismo
        # tiempo y no filtrar por timing si el correo está o no registrado.
        real_hash = (u or {}).get("password_hash")
        ok = _verificar_password(password, real_hash or _DUMMY_HASH)
        if not (u and real_hash and ok):
            raise ValueError("Correo o contraseña incorrectos")
        u["ultima_sesion"] = time.time()
        _guardar(data)
        return dict(u)


# Hash "dummy" válido para gastar el mismo tiempo de cómputo cuando el correo no existe.
_DUMMY_HASH = (_bcrypt.hashpw(b"x", _bcrypt.gensalt()).decode("utf-8")) if _bcrypt else ""


# ─────────────────────────────────────────────────────────────────
# Login por código OTP de 6 dígitos (app nativa — LANZAMIENTO §8).
# El magic link abre Safari y no crea sesión dentro del WKWebView; el OTP
# se teclea dentro de la app y el endpoint devuelve un JWT.
# ─────────────────────────────────────────────────────────────────
_OTP_TTL = int(os.environ.get("AUTH_OTP_TTL", "600"))   # 10 minutos
_OTP_MAX_SOLICITUDES_HORA = 5                           # por email (por IP: Flask-Limiter)
_OTP_MAX_INTENTOS = 5                                   # códigos fallidos antes de invalidar


def _hash_otp(codigo: str) -> str:
    return hashlib.sha256(("otp:" + codigo).encode("utf-8")).hexdigest()


def solicitar_otp(email: str) -> dict[str, Any]:
    """Genera un código de 6 dígitos (un solo uso, expira en 10 min) y lo envía
    por correo. Máximo 5 solicitudes por hora por email; pedir un código nuevo
    invalida el anterior. Lanza PermissionError al exceder el límite."""
    if not email or "@" not in email or len(email) > 254:
        raise ValueError("Email invalido")

    email = email.strip().lower()
    codigo = f"{secrets.randbelow(1_000_000):06d}"
    ahora = time.time()

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        otps = data.setdefault("otp", {})
        previo = otps.get(email) or {}
        solicitudes = [t for t in previo.get("solicitudes", []) if t > ahora - 3600]
        if len(solicitudes) >= _OTP_MAX_SOLICITUDES_HORA:
            raise PermissionError("Demasiadas solicitudes. Inténtalo de nuevo en una hora.")
        solicitudes.append(ahora)
        otps[email] = {
            "codigo_hash": _hash_otp(codigo),
            "creado_en": ahora,
            "expira_en": ahora + _OTP_TTL,
            "intentos": 0,
            "solicitudes": solicitudes,
        }
        _guardar(data)

    enviado = False
    detalle = ""
    if _MOCK_MODE:
        print(f"[auth] OTP para {email}: {codigo}")
        detalle = "mock_mode"
    else:
        try:
            asunto = "Tu código de acceso a Mi Portafolio"
            _alertas.enviar_correo(email, asunto, _html_otp(email, codigo))
            enviado = True
            detalle = "enviado"
        except Exception as exc:
            detalle = f"smtp_error: {exc}"
            # Idem magic link: sin esto un OTP que nunca sale es invisible en el
            # log. El login nativo depende de este correo, así que el operador
            # necesita verlo (journalctl -u miportafolio | grep FALLO).
            print(f"[auth] FALLO al enviar OTP a {email}: {exc}", flush=True)

    return {
        "ok": True,
        "email": email,
        "expira_en": ahora + _OTP_TTL,
        "enviado": enviado,
        "detalle": detalle,
        # En mock mode devolvemos el código para facilitar pruebas locales.
        "codigo_debug": codigo if _MOCK_MODE else None,
    }


def verificar_otp(email: str, codigo: str) -> dict[str, Any]:
    """Valida el código (un solo uso). Devuelve el usuario, creándolo si es
    nuevo (el trial arranca en el primer login, igual que registro_con_password).
    Mensaje de error genérico: no revela si el correo tiene código pendiente."""
    email = (email or "").strip().lower()
    codigo = (codigo or "").strip()
    generico = ValueError("Código inválido o expirado")
    if not email or "@" not in email or len(codigo) != 6 or not codigo.isdigit():
        raise generico

    ahora = time.time()
    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        otps = data.setdefault("otp", {})
        info = otps.get(email)
        if not info or not info.get("codigo_hash") or info.get("expira_en", 0) <= ahora:
            raise generico
        if not secrets.compare_digest(_hash_otp(codigo), info["codigo_hash"]):
            info["intentos"] = info.get("intentos", 0) + 1
            if info["intentos"] >= _OTP_MAX_INTENTOS:
                # Demasiados fallos: invalida el código, conserva el historial
                # de solicitudes (el límite por hora sigue contando).
                info.pop("codigo_hash", None)
                info["expira_en"] = 0
            _guardar(data)
            raise generico
        # Éxito: un solo uso — se borra el código, queda el historial de solicitudes.
        otps[email] = {"solicitudes": info.get("solicitudes", [])}
        u = _registrar_usuario(data, email)
        u["ultima_sesion"] = ahora
        u.setdefault("auth", "otp")
        _guardar(data)
        return dict(u)


def _html_otp(email: str, codigo: str) -> str:
    return f"""<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e2e8f0;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 8px;font-size:22px">Tu código de acceso</h1>
    <p style="margin:0 0 20px;color:#94a3b8">Hola {html.escape(email)}, escribe este código en la app. Es válido por 10 minutos y solo se puede usar una vez.</p>
    <p style="margin:0;background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:14px 18px;text-align:center;font-size:32px;letter-spacing:10px;font-weight:700;color:#22c55e">{codigo}</p>
    <p style="margin:24px 0 0;color:#64748b;font-size:12px">Si no lo solicitaste, ignora este mensaje.</p>
  </div>
</body></html>"""


def crear_sesion(email: str) -> dict[str, Any]:
    """Crea una sesión (cookie session_id) para el correo dado. La usan los
    endpoints de registro/login para dejar cookie en web (en nativo se usa el JWT)."""
    email = (email or "").strip().lower()
    ahora = time.time()
    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        session_id = secrets.token_urlsafe(32)
        data.setdefault("sesiones", {})[session_id] = {
            "email": email, "creado_en": ahora, "expira_en": ahora + _SESSION_TTL,
        }
        _guardar(data)
    return {"session_id": session_id, "expira_en": ahora + _SESSION_TTL}


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
        # Cuenta ELIMINADA: un webhook tardio (cancelacion/renovacion de
        # MercadoPago o RevenueCat) no debe resucitarla via setdefault.
        if email not in usuarios and _esta_eliminado(data, email):
            return {}
        u = usuarios.setdefault(email, {"email": email, "creado_en": time.time()})
        u["plan"] = plan
        u["estado_pago"] = estado_pago
        u["actualizado_en"] = time.time()
        _guardar(data)
        return dict(u)


def eliminar_cuenta(email: str) -> dict[str, Any]:
    """
    Borra por completo la cuenta del usuario: su registro, todas sus sesiones y
    sus tokens pendientes. Requisito obligatorio de App Store (Guideline 5.1.1v)
    y Google Play para apps con creación de cuenta.

    También borra sus backups del portafolio en la nube y sus suscripciones
    push. La suscripción de pago (MercadoPago / App Store / Google Play) se
    cancela desde la tienda correspondiente; aquí solo eliminamos los datos en
    nuestro servidor.
    """
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("Email invalido")

    with _LOCK:
        data = _cargar()
        usuarios = data.setdefault("usuarios", {})
        existia = email in usuarios
        usuarios.pop(email, None)
        # Borrar sesiones y tokens asociados a ese email
        data["sesiones"] = {
            sid: info for sid, info in data.get("sesiones", {}).items()
            if (info or {}).get("email") != email
        }
        data["tokens"] = {
            tk: info for tk, info in data.get("tokens", {}).items()
            if (info or {}).get("email") != email
        }
        data.setdefault("otp", {}).pop(email, None)
        # Tombstone: invalida los JWT viejos (viven 30 dias y no se pueden
        # revocar por firma) y evita que un webhook resucite la cuenta.
        _limpiar_tombstones(data)
        data.setdefault("eliminados", {})[_hash_email(email)] = time.time()
        _guardar(data)

    # Datos en Postgres. NO se silencian los fallos: si algo queda sin borrar
    # hay que saberlo (antes un `except: pass` reportaba exito con datos vivos).
    errores: list[str] = []

    try:
        import backups as _backups  # type: ignore
        _backups.eliminar_todos_email(email)
    except Exception as exc:
        errores.append(f"backups: {exc}")

    try:
        import push as _push  # type: ignore
        if hasattr(_push, "eliminar_todas_email"):
            _push.eliminar_todas_email(email)
    except Exception as exc:
        errores.append(f"push: {exc}")

    # Snapshot del portafolio (correo, posiciones, pesos, transacciones y la
    # config de alertas). Si no se borra, sobrevive al borrado de la cuenta y el
    # cron le sigue mandando alertas a una cuenta que ya no existe.
    try:
        import snapshots as _snaps  # type: ignore
        _snaps.borrar_de_cuenta(email)
    except Exception as exc:
        errores.append(f"snapshots: {exc}")

    # El detalle del fallo se queda en el log del servidor; al cliente solo le
    # decimos que la limpieza fue parcial (no filtramos errores internos).
    if errores:
        print(f"[auth] eliminar_cuenta: limpieza parcial ({'; '.join(errores)})")

    return {"ok": True, "eliminada": existia, "email": email,
            "parcial": bool(errores)}


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
