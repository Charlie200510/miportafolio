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

# Envío de SMS para verificar el teléfono al crear cuenta. Import guardado: si
# el módulo o su proveedor no están, el registro por teléfono lo reporta y el
# resto del auth sigue funcionando.
try:
    from . import sms as _sms  # type: ignore
except Exception:  # pragma: no cover
    try:
        import sms as _sms  # type: ignore
    except Exception:
        _sms = None  # type: ignore

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
    # Registros a medias (teléfono sin confirmar). Se conserva el historial de
    # solicitudes de la última hora para que el límite por número siga contando
    # aunque el código haya caducado.
    pend_vivos: dict[str, Any] = {}
    for tel, info in (data.get("registros_pendientes") or {}).items():
        sols = [t for t in info.get("solicitudes", []) if t > ahora - 3600]
        if info.get("expira_en", 0) > ahora or sols:
            info["solicitudes"] = sols
            pend_vivos[tel] = info
    data["registros_pendientes"] = pend_vivos
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


class AltaRequiereTelefono(ValueError):
    """La cuenta no existe y esta vía no puede crearla.

    El alta solo ocurre por el registro con teléfono verificado. El magic link y
    el OTP por correo sirven para ENTRAR a una cuenta que ya existe, no para
    crearla: si pudieran, bastaría pedir un enlace para tener cuenta sin pasar
    nunca por el SMS y la verificación no serviría de nada."""


def _registrar_usuario(data: dict[str, Any], email: str,
                       permitir_alta: bool = True) -> dict[str, Any]:
    email = email.strip().lower()
    usuarios = data.setdefault("usuarios", {})
    if email not in usuarios and not permitir_alta:
        raise AltaRequiereTelefono(
            "No hay ninguna cuenta con ese correo. Crea tu cuenta con tu "
            "teléfono para confirmarlo por SMS.")
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


def solicitar_magic_link(email: str, ip: Optional[str] = None,
                         dispositivo: Optional[str] = None) -> dict[str, Any]:
    """Genera un token y lo envia por correo. Regresa metadata util para el cliente."""
    if not email or "@" not in email:
        raise ValueError("Email invalido")

    email = email.strip().lower()
    token = secrets.token_urlsafe(32)
    ahora = time.time()

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        # El enlace SÍ puede dar de alta (es la puerta de signup.html), pero
        # pasando por el mismo guardián que el registro con contraseña: sin eso,
        # las defensas cubrirían una puerta y dejarían dos abiertas.
        if email not in (data.get("usuarios") or {}):
            verificar_alta(data, email, ip=ip, dispositivo=dispositivo)
            nuevo = True
        else:
            nuevo = False
        _registrar_usuario(data, email)
        data.setdefault("tokens", {})[token] = {
            "email": email,
            "creado_en": ahora,
            "expira_en": ahora + _MAGIC_TTL,
            "usado": False,
        }
        _guardar(data)

    if nuevo:
        _apuntar_origen_seguro(ip, dispositivo)

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


# ─────────────────────────────────────────────────────────────────
#  Antiabuso de trials
# ─────────────────────────────────────────────────────────────────
# El trial se cuenta desde `creado_en` de la CUENTA, así que una cuenta nueva es
# un trial nuevo. Sin esto, la forma más barata de no pagar nunca es escribir
# otro correo, y las dos variantes más fáciles no requieren ni un buzón nuevo:
#
#   carlos+1@gmail.com   →  el "+algo" lo ignora el proveedor
#   car.los@gmail.com    →  Gmail (y solo Gmail) ignora los puntos
#
# La clave canónica NO sustituye al correo: la cuenta se guarda tal como se
# escribió, para que el usuario entre con lo que él recuerda. Solo sirve para
# detectar que un alta nueva es la misma dirección de una cuenta que ya existe.
_DOMINIOS_MAS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "yahoo.com", "yahoo.com.mx", "icloud.com", "me.com", "proton.me",
    "protonmail.com", "fastmail.com",
}
# Solo Gmail ignora los puntos. Aplicarlo a otros dominios fusionaría cuentas
# legítimamente distintas (en Outlook, car.los@ y carlos@ son dos personas).
_DOMINIOS_PUNTO = {"gmail.com", "googlemail.com"}

# Correos de un solo uso. Lista corta a propósito: son los que aparecen primero
# al buscar "temp mail", que es lo que hace quien quiere otro trial, no un
# atacante dedicado. Contra alguien decidido no hay lista que alcance; esto
# frena al que solo busca lo fácil.
_DOMINIOS_DESECHABLES = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com",
    "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
    "throwawaymail.com", "yopmail.com", "getnada.com", "nada.email",
    "dispostable.com", "trashmail.com", "maildrop.cc", "mailnesia.com",
    "fakeinbox.com", "tempinbox.com", "mohmal.com", "emailondeck.com",
    "moakt.com", "tmpmail.org", "inboxkitten.com", "mailsac.com",
    "spamgourmet.com", "grr.la", "spam4.me", "byom.de", "harakirimail.com",
    "email-temp.com", "tmail.ws", "burnermail.io", "anonaddy.me",
}


class CorreoDesechable(ValueError):
    """Dominio de un solo uso: no sirve para sostener una cuenta."""


# ── Cuotas de alta por origen ────────────────────────────────────────────────
# El trial se cuenta por cuenta, así que la defensa tiene que estar en el ALTA.
# Se cuentan las altas por dos ejes y se guardan HASHEADAS: no hace falta saber
# la IP ni el dispositivo de nadie, solo si ese mismo origen ya abrió varias.
#
#   IP        → sirve en web y en iOS, pero es un eje FLOJO: los operadores
#               móviles comparten una IP entre miles de clientes (CGNAT) y una
#               oficina o un café salen todos por la misma. El tope es alto a
#               propósito: frena al que abre diez cuentas en una tarde, no al
#               que comparte red con un vecino.
#   DISPOSITIVO → solo iOS, y es el eje FUERTE: identifica el aparato, no la
#               red. Lo manda el contenedor nativo (identifierForVendor).
#
# Ventana móvil de 30 días: un tope "de por vida" castigaría para siempre a una
# IP de operador, y uno diario no frena a quien espera al día siguiente.
_ALTAS_VENTANA = 30 * 24 * 3600
_ALTAS_MAX_IP = 6            # una red compartida cabe; diez trials seguidos no
_ALTAS_MAX_DISPOSITIVO = 2   # el mismo iPhone: la propia y una más


class CuotaDeAltas(PermissionError):
    """Ese origen ya abrió demasiadas cuentas en la ventana."""


def _hash_origen(valor: str) -> str:
    """Hash con la sal del proceso. Guardar IPs en claro sería recolectar datos
    personales que no necesitamos: solo hace falta poder CONTAR."""
    # Sal fija del despliegue. Si no se define, una constante: el objetivo del
    # hash es no guardar IPs en claro, no resistir a quien ya tiene el archivo.
    sal = os.environ.get("AUTH_SAL_ORIGEN") or "mp-origen-altas"
    return hashlib.sha256((sal + "|" + (valor or "")).encode()).hexdigest()[:32]


def _contar_altas(data: dict[str, Any], eje: str, valor: str) -> int:
    if not valor:
        return 0
    ahora = time.time()
    reg = ((data.get("altas") or {}).get(eje) or {}).get(_hash_origen(valor)) or []
    return sum(1 for t in reg if (ahora - t) < _ALTAS_VENTANA)


def _apuntar_alta(data: dict[str, Any], eje: str, valor: str) -> None:
    if not valor:
        return
    ahora = time.time()
    altas = data.setdefault("altas", {}).setdefault(eje, {})
    clave = _hash_origen(valor)
    reg = [t for t in (altas.get(clave) or []) if (ahora - t) < _ALTAS_VENTANA]
    reg.append(ahora)
    altas[clave] = reg[-20:]           # no crece sin límite


def verificar_alta(data: dict[str, Any], email: str,
                   ip: Optional[str] = None,
                   dispositivo: Optional[str] = None) -> None:
    """Todo lo que tiene que ser cierto para poder crear una cuenta.

    Vive en UN sitio porque hay varias puertas —contraseña, magic link, OTP— y
    una defensa que solo cubre una puerta no defiende nada.
    """
    _rechazar_desechable(email)
    gemelo = _duplicado_canonico(data, email)
    if gemelo:
        raise ValueError("Ese correo ya tiene una cuenta (la creaste como "
                         f"{gemelo}). Inicia sesión.")
    if dispositivo and _contar_altas(data, "dispositivo", dispositivo) >= _ALTAS_MAX_DISPOSITIVO:
        raise CuotaDeAltas(
            "Este dispositivo ya creó varias cuentas. Inicia sesión con la que "
            "ya tienes, o escríbenos si necesitas otra.")
    if ip and _contar_altas(data, "ip", ip) >= _ALTAS_MAX_IP:
        raise CuotaDeAltas(
            "Se crearon demasiadas cuentas desde esta conexión. Inténtalo más "
            "tarde o inicia sesión con la que ya tienes.")


def _apuntar_origen_seguro(ip: Optional[str], dispositivo: Optional[str]) -> None:
    """El alta ya ocurrió: si apuntar el origen falla, no se puede deshacer la
    cuenta ni tiene sentido reventar la respuesta. Se registra y se sigue."""
    try:
        registrar_origen(ip=ip, dispositivo=dispositivo)
    except Exception as exc:
        print(f"[auth] no se pudo apuntar el origen del alta: {exc}", flush=True)


def registrar_origen(ip: Optional[str] = None,
                     dispositivo: Optional[str] = None) -> None:
    """Apunta el alta consumada. Se llama DESPUÉS de crear, no antes: si se
    contara al intentar, un error de tecleo gastaría cuota."""
    with _LOCK:
        data = _cargar()
        _apuntar_alta(data, "ip", ip or "")
        _apuntar_alta(data, "dispositivo", dispositivo or "")
        _guardar(data)


def clave_email(email: str) -> str:
    """Forma canónica de un correo, SOLO para detectar duplicados."""
    email = (email or "").strip().lower()
    if "@" not in email:
        return email
    usuario, _, dominio = email.rpartition("@")
    if dominio in _DOMINIOS_MAS:
        usuario = usuario.split("+", 1)[0]
    if dominio in _DOMINIOS_PUNTO:
        usuario = usuario.replace(".", "")
    return f"{usuario}@{dominio}" if usuario else email


def _rechazar_desechable(email: str) -> None:
    dominio = (email or "").strip().lower().rpartition("@")[2]
    if dominio in _DOMINIOS_DESECHABLES:
        raise CorreoDesechable(
            "Ese proveedor de correo es temporal. Usa un correo tuyo de verdad "
            "para poder recuperar tu cuenta.")


def _duplicado_canonico(data: dict[str, Any], email: str) -> Optional[str]:
    """Devuelve el correo de la cuenta existente que es LA MISMA dirección."""
    clave = clave_email(email)
    for otro in (data.get("usuarios") or {}):
        if otro != email and clave_email(otro) == clave:
            return otro
    return None


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


def registrar_con_password(email: str, password: str,
                           telefono: Optional[str] = None,
                           ip: Optional[str] = None,
                           dispositivo: Optional[str] = None) -> dict[str, Any]:
    """Crea una cuenta nueva con contraseña. Inicia el trial (creado_en = ahora).
    Falla si el correo ya tiene cuenta (evita apropiación de cuentas existentes).

    `telefono` se guarda SIN verificar. Esta ruta es el respaldo para cuando el
    servidor no tiene proveedor de SMS: el camino normal es
    solicitar_registro_telefono + confirmar_registro_telefono, donde el número
    queda verificado. Guardarlo igual permite pedir la confirmación después, en
    cuanto haya credenciales, sin volver a preguntárselo al usuario."""
    if _bcrypt is None:
        raise RuntimeError("auth por contraseña no disponible (falta bcrypt en el servidor)")
    email = _validar_credenciales(email, password)
    ahora = time.time()
    with _LOCK:
        data = _cargar()
        usuarios = data.setdefault("usuarios", {})
        if email in usuarios:
            raise ValueError("Ese correo ya tiene una cuenta. Inicia sesión.")
        # Un solo guardián para las tres puertas: desechables, alias del mismo
        # buzón y cuotas por IP y por dispositivo.
        verificar_alta(data, email, ip=ip, dispositivo=dispositivo)
        usuarios[email] = {
            "email": email,
            "creado_en": ahora,          # ← inicio del trial POR CUENTA (server-side)
            "ultima_sesion": ahora,
            "plan": "trial",
            "estado_pago": "inactivo",
            "password_hash": _hash_password(password),
            "auth": "password",
        }
        if telefono and _sms is not None:
            try:
                usuarios[email]["telefono"] = _sms.normalizar(telefono)
                usuarios[email]["telefono_verificado"] = False
            except Exception:
                pass          # un teléfono mal escrito no debe tumbar el alta
        # Alta explicita: si esa cuenta se habia eliminado, el usuario tiene
        # derecho a volver a registrarse — se levanta el tombstone.
        (data.get("eliminados") or {}).pop(_hash_email(email), None)
        _guardar(data)
    # Se apunta DESPUÉS de crear: si se contara al intentar, un error de
    # tecleo gastaría cuota.
    _apuntar_origen_seguro(ip, dispositivo)
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


def solicitar_otp(email: str, ip: Optional[str] = None,
                  dispositivo: Optional[str] = None) -> dict[str, Any]:
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
        # El OTP también puede dar de alta (es la puerta de la app nativa). Se
        # comprueba AQUÍ y no al verificar: si el alta no va a poder ocurrir,
        # mandar el correo gasta un envío y deja al usuario esperando.
        if email not in (data.get("usuarios") or {}):
            verificar_alta(data, email, ip=ip, dispositivo=dispositivo)
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
        nuevo = email not in (data.get("usuarios") or {})
        u = _registrar_usuario(data, email)
        u["ultima_sesion"] = ahora
        u.setdefault("auth", "otp")
        _guardar(data)
        return dict(u)


# ─────────────────────────────────────────────────────────────────
# Verificación de teléfono por SMS al crear cuenta
# ─────────────────────────────────────────────────────────────────
# POR QUÉ EL REGISTRO QUEDA "PENDIENTE"
# La cuenta NO se crea al pedir el código: se guarda un registro a medias
# (correo + hash de contraseña + teléfono) y solo al confirmar el código nace el
# usuario. Si se creara antes, cualquiera podría ocupar un correo ajeno con solo
# empezar el registro, y el correo quedaría bloqueado para su dueño real.
#
# UN TELÉFONO = UNA CUENTA. Es lo único que hace que verificar sirva de algo: si
# el mismo número puede registrar cuentas sin límite, el SMS solo añade costo y
# fricción sin frenar nada.
_TEL_TTL = int(os.environ.get("AUTH_TEL_TTL", "600"))    # 10 minutos
_TEL_MAX_SOLICITUDES_HORA = 4      # por número (por IP lo limita Flask-Limiter)
_TEL_MAX_INTENTOS = 5              # códigos fallidos antes de invalidar


def _hash_codigo_tel(codigo: str) -> str:
    return hashlib.sha256(("tel:" + codigo).encode("utf-8")).hexdigest()


def sms_disponible() -> bool:
    """False si no hay proveedor configurado. El endpoint lo usa para decir la
    verdad en vez de dejar al usuario esperando un SMS que no va a llegar."""
    return bool(_sms is not None and _sms.configurado())


def telefono_de(email: str) -> Optional[str]:
    u = obtener_usuario(email) or {}
    return u.get("telefono")


def _duenio_de_telefono(data: dict[str, Any], telefono: str) -> Optional[str]:
    for correo, u in (data.get("usuarios") or {}).items():
        if u.get("telefono") == telefono:
            return correo
    return None


def solicitar_registro_telefono(email: str, password: str, telefono: str) -> dict[str, Any]:
    """Paso 1 del registro: valida todo, guarda el registro pendiente y manda el
    código por SMS. La cuenta todavía NO existe.

    Lanza ValueError (dato malo), PermissionError (límite) o RuntimeError (el
    SMS no salió). Nunca deja un pendiente guardado si el envío falló: eso haría
    creer al usuario que el código va en camino.
    """
    if _sms is None:
        raise RuntimeError("El envío de SMS no está disponible en el servidor")
    email = _validar_credenciales(email, password)    # valida formato y largo
    _rechazar_desechable(email)
    tel = _sms.normalizar(telefono)
    codigo = f"{secrets.randbelow(1_000_000):06d}"
    ahora = time.time()

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        if email in (data.get("usuarios") or {}):
            raise ValueError("Ese correo ya tiene una cuenta. Inicia sesión.")
        gemelo = _duplicado_canonico(data, email)
        if gemelo:
            # Se comprueba aquí y no al confirmar: mandar un SMS para una cuenta
            # que de todas formas no se va a crear es gastar un envío de balde.
            raise ValueError("Ese correo ya tiene una cuenta (la creaste como "
                             f"{gemelo}). Inicia sesión.")
        otro = _duenio_de_telefono(data, tel)
        if otro:
            # No se dice de QUIÉN es: eso convertiría el registro en un buscador
            # de "¿este número tiene cuenta?".
            raise ValueError("Ese teléfono ya está en uso por otra cuenta.")

        pend = data.setdefault("registros_pendientes", {})
        previo = pend.get(tel) or {}
        solicitudes = [t for t in previo.get("solicitudes", []) if t > ahora - 3600]
        if len(solicitudes) >= _TEL_MAX_SOLICITUDES_HORA:
            raise PermissionError("Demasiados códigos para ese número. Inténtalo en una hora.")
        solicitudes.append(ahora)
        pend[tel] = {
            "email": email,
            "password_hash": _hash_password(password),
            "codigo_hash": _hash_codigo_tel(codigo),
            "creado_en": ahora,
            "expira_en": ahora + _TEL_TTL,
            "intentos": 0,
            "solicitudes": solicitudes,
        }
        _guardar(data)

    texto = (f"Mi Portafolio: tu codigo es {codigo}. "
             f"Vence en {_TEL_TTL // 60} minutos. No lo compartas.")
    try:
        _sms.enviar(tel, texto)
    except Exception as exc:
        # El pendiente se deja EN PIE (con su código) para que "Reenviar" no
        # tenga que rehacer la validación, pero el error sube tal cual: la
        # pantalla tiene que decir que no se pudo enviar.
        print(f"[auth] FALLO al enviar SMS a {_sms.enmascarar(tel)}: {exc}", flush=True)
        raise

    return {
        "ok": True,
        "telefono_enmascarado": _sms.enmascarar(tel),
        "expira_en": ahora + _TEL_TTL,
        # Solo en mock mode, para poder probar el flujo completo sin proveedor.
        "codigo_debug": codigo if getattr(_sms, "_MOCK", False) else None,
    }


def confirmar_registro_telefono(telefono: str, codigo: str) -> dict[str, Any]:
    """Paso 2: valida el código y CREA la cuenta con el teléfono ya verificado.
    Mensaje genérico: no revela si ese número tiene un registro pendiente."""
    if _sms is None:
        raise RuntimeError("El envío de SMS no está disponible en el servidor")
    tel = _sms.normalizar(telefono)
    codigo = (codigo or "").strip()
    generico = ValueError("Código inválido o expirado")
    if len(codigo) != 6 or not codigo.isdigit():
        raise generico

    ahora = time.time()
    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        pend = data.setdefault("registros_pendientes", {})
        info = pend.get(tel)
        if not info or not info.get("codigo_hash") or info.get("expira_en", 0) <= ahora:
            raise generico
        if not secrets.compare_digest(_hash_codigo_tel(codigo), info["codigo_hash"]):
            info["intentos"] = info.get("intentos", 0) + 1
            if info["intentos"] >= _TEL_MAX_INTENTOS:
                info.pop("codigo_hash", None)
                info["expira_en"] = 0
            _guardar(data)
            raise generico

        email = info["email"]
        usuarios = data.setdefault("usuarios", {})
        # Se vuelve a comprobar aquí: entre el paso 1 y el 2 alguien pudo
        # registrar ese correo o ese teléfono por otra vía.
        if email in usuarios:
            pend.pop(tel, None)
            _guardar(data)
            raise ValueError("Ese correo ya tiene una cuenta. Inicia sesión.")
        if _duenio_de_telefono(data, tel):
            pend.pop(tel, None)
            _guardar(data)
            raise ValueError("Ese teléfono ya está en uso por otra cuenta.")

        usuarios[email] = {
            "email": email,
            "creado_en": ahora,          # ← el trial arranca aquí, no en el paso 1
            "ultima_sesion": ahora,
            "plan": "trial",
            "estado_pago": "inactivo",
            "password_hash": info["password_hash"],
            "auth": "password",
            "telefono": tel,
            "telefono_verificado": True,
            "telefono_verificado_en": ahora,
        }
        # Alta explícita: si esa cuenta se había eliminado, se levanta el tombstone.
        (data.get("eliminados") or {}).pop(_hash_email(email), None)
        pend.pop(tel, None)              # un solo uso
        _guardar(data)

    return {"email": email, "creado_en": ahora, "plan": "trial", "nueva": True,
            "telefono": tel}


def solicitar_codigo_telefono(email: str, telefono: str) -> dict[str, Any]:
    """Verificación de teléfono para una cuenta que YA existe.

    Hace falta porque el registro con contraseña no es la única puerta: el magic
    link y el OTP por correo también crean cuentas. Esas quedan sin teléfono, y
    esto es lo que les permite completarlo desde la app.
    """
    if _sms is None:
        raise RuntimeError("El envío de SMS no está disponible en el servidor")
    email = (email or "").strip().lower()
    tel = _sms.normalizar(telefono)
    codigo = f"{secrets.randbelow(1_000_000):06d}"
    ahora = time.time()

    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        u = (data.get("usuarios") or {}).get(email)
        if not u:
            raise ValueError("Esa cuenta no existe")
        otro = _duenio_de_telefono(data, tel)
        if otro and otro != email:
            raise ValueError("Ese teléfono ya está en uso por otra cuenta.")

        pend = data.setdefault("registros_pendientes", {})
        previo = pend.get(tel) or {}
        solicitudes = [t for t in previo.get("solicitudes", []) if t > ahora - 3600]
        if len(solicitudes) >= _TEL_MAX_SOLICITUDES_HORA:
            raise PermissionError("Demasiados códigos para ese número. Inténtalo en una hora.")
        solicitudes.append(ahora)
        # Mismo almacén que el registro nuevo, pero sin password_hash: la marca
        # `solo_verificar` distingue los dos casos al confirmar.
        pend[tel] = {
            "email": email,
            "solo_verificar": True,
            "codigo_hash": _hash_codigo_tel(codigo),
            "creado_en": ahora,
            "expira_en": ahora + _TEL_TTL,
            "intentos": 0,
            "solicitudes": solicitudes,
        }
        _guardar(data)

    texto = (f"Mi Portafolio: tu codigo es {codigo}. "
             f"Vence en {_TEL_TTL // 60} minutos. No lo compartas.")
    try:
        _sms.enviar(tel, texto)
    except Exception as exc:
        print(f"[auth] FALLO al enviar SMS a {_sms.enmascarar(tel)}: {exc}", flush=True)
        raise

    return {"ok": True, "telefono_enmascarado": _sms.enmascarar(tel),
            "expira_en": ahora + _TEL_TTL,
            "codigo_debug": codigo if getattr(_sms, "_MOCK", False) else None}


def confirmar_codigo_telefono(telefono: str, codigo: str) -> dict[str, Any]:
    """Confirma el teléfono de una cuenta existente (contraparte de
    solicitar_codigo_telefono)."""
    if _sms is None:
        raise RuntimeError("El envío de SMS no está disponible en el servidor")
    tel = _sms.normalizar(telefono)
    codigo = (codigo or "").strip()
    generico = ValueError("Código inválido o expirado")
    if len(codigo) != 6 or not codigo.isdigit():
        raise generico

    ahora = time.time()
    with _LOCK:
        data = _cargar()
        _limpiar_expirados(data)
        pend = data.setdefault("registros_pendientes", {})
        info = pend.get(tel)
        if not info or not info.get("solo_verificar") or not info.get("codigo_hash") \
                or info.get("expira_en", 0) <= ahora:
            raise generico
        if not secrets.compare_digest(_hash_codigo_tel(codigo), info["codigo_hash"]):
            info["intentos"] = info.get("intentos", 0) + 1
            if info["intentos"] >= _TEL_MAX_INTENTOS:
                info.pop("codigo_hash", None)
                info["expira_en"] = 0
            _guardar(data)
            raise generico

        email = info["email"]
        u = (data.get("usuarios") or {}).get(email)
        if not u:
            raise generico
        if _duenio_de_telefono(data, tel) not in (None, email):
            pend.pop(tel, None)
            _guardar(data)
            raise ValueError("Ese teléfono ya está en uso por otra cuenta.")
        u["telefono"] = tel
        u["telefono_verificado"] = True
        u["telefono_verificado_en"] = ahora
        pend.pop(tel, None)
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
