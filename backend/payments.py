"""
Integracion de pagos con MercadoPago (plan $65 MXN/mes).

Diseno:
- Usamos la API de Preapproval (suscripciones recurrentes) de MercadoPago.
- Si no hay MERCADOPAGO_ACCESS_TOKEN configurado, arrancamos en 'mock mode':
  el front recibe un checkout_url ficticio y podemos simular 'aprobado' en dev.
- El webhook (/api/payments/webhook) recibe notificaciones 'preapproval' y
  actualiza el plan del usuario via auth.actualizar_plan().

Env vars:
- MERCADOPAGO_ACCESS_TOKEN      Access token de produccion o sandbox.
- MERCADOPAGO_PLAN_NOMBRE       Texto visible en el checkout (default 'Mi Portafolio Premium')
- MERCADOPAGO_PRECIO_MXN        Monto mensual (default 65.00)
- MERCADOPAGO_BACK_URL          URL a la que regresa el usuario tras pagar.
- MERCADOPAGO_WEBHOOK_SECRET    Si esta definido, se valida el header x-signature.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional

# Bitacora operativa. Va a stdout, que gunicorn manda a journalctl
# (`sudo journalctl -u miportafolio`). Sin esto, un webhook rechazado no dejaba
# NINGUN rastro: el cobro ocurria en MercadoPago, el plan no se activaba y el
# unico indicio era un 200 de 38 bytes en el log de accesos.
log = logging.getLogger("pagos")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[pagos] %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.propagate = False
log.setLevel(logging.INFO)

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

try:
    from . import auth as _auth  # type: ignore
except Exception:  # pragma: no cover
    import auth as _auth  # type: ignore


_BASE_DIR = Path(__file__).resolve().parent
_DATA_DIR = _BASE_DIR / "_datos"
_DATA_DIR.mkdir(exist_ok=True)
_STORE_PATH = _DATA_DIR / "pagos.json"

_MP_API = "https://api.mercadopago.com"
_PRECIO = float(os.environ.get("MERCADOPAGO_PRECIO_MXN", "65.00"))
_PRECIO_ANUAL = float(os.environ.get("MERCADOPAGO_PRECIO_ANUAL_MXN", "650.00"))
_PLAN_NOMBRE = os.environ.get("MERCADOPAGO_PLAN_NOMBRE", "Mi Portafolio Premium")

# Ciclos de cobro ofrecidos en WEB. El plan "Ilimitado" (pago unico) existe solo
# en iOS via RevenueCat y NO se ofrece aqui.
# OJO: MercadoPago solo acepta frequency_type "days" o "months" en
# auto_recurring. El anual es 12 meses, no frequency_type "years".
_CICLOS: dict[str, dict[str, Any]] = {
    "mensual": {
        "frequency": 1,
        "frequency_type": "months",
        "precio": _PRECIO,
        "etiqueta": "mensual",
        "sufijo": "/mes",
        "nombre": "Mensual",
        "reason": _PLAN_NOMBRE,
    },
    "anual": {
        "frequency": 12,
        "frequency_type": "months",
        "precio": _PRECIO_ANUAL,
        "etiqueta": "anual",
        "sufijo": "/año",
        "nombre": "Anual",
        "reason": f"{_PLAN_NOMBRE} (anual)",
        "badge": "2 meses gratis vs mensual",
    },
}
_CICLO_DEFAULT = "mensual"


def _ciclo(nombre: str | None) -> dict[str, Any]:
    c = (nombre or _CICLO_DEFAULT).strip().lower()
    if c not in _CICLOS:
        raise ValueError(f"ciclo invalido: {nombre!r} (usa 'mensual' o 'anual')")
    return _CICLOS[c]
_BACK_URL = os.environ.get("MERCADOPAGO_BACK_URL", "http://localhost:5001/static/index.html?paid=1")
_WEBHOOK_SECRET = os.environ.get("MERCADOPAGO_WEBHOOK_SECRET")

# Interruptores de seguridad:
# - AUTH_MOCK_MODE=1  habilita la simulacion de aprobacion de pagos (SOLO dev).
#   En produccion NUNCA debe estar activo: si lo esta, cualquiera se auto-otorga
#   premium. Por eso simular_aprobacion() se niega salvo que este flag este on.
# - STRICT_WEBHOOKS=1 exige firma/secreto valido en los webhooks (fail-closed).
#   Recomendado en produccion. Por default (off) se conserva el comportamiento
#   previo (acepta si no hay secreto) para no romper entornos ya desplegados.
MOCK_ENABLED = os.environ.get("AUTH_MOCK_MODE", "").lower() in ("1", "true", "yes")
STRICT_WEBHOOKS = os.environ.get("STRICT_WEBHOOKS", "").lower() in ("1", "true", "yes")

# --- RevenueCat (compras in-app de App Store / Google Play) ------------------
# RevenueCat unifica las compras de iOS y Android y nos da una sola "entitlement"
# llamada 'premium'. La fuente de verdad es server-side: verificamos contra la
# REST API de RevenueCat con la SECRET key (NUNCA exponer en el frontend).
_RC_API = "https://api.revenuecat.com/v1"
_RC_SECRET = os.environ.get("REVENUECAT_SECRET_API_KEY")          # sk_... (server-side)
_RC_ENTITLEMENT = os.environ.get("REVENUECAT_ENTITLEMENT", "premium")
_RC_WEBHOOK_AUTH = os.environ.get("REVENUECAT_WEBHOOK_AUTH")       # valor del header Authorization que configuras en el dashboard


def _token() -> Optional[str]:
    t = os.environ.get("MERCADOPAGO_ACCESS_TOKEN")
    return t.strip() if t else None


def estado_configuracion() -> dict[str, Any]:
    return {
        "disponible": bool(_token()) and requests is not None,
        "mock_mode": not bool(_token()),
        "plan": _PLAN_NOMBRE,
        "precio_mxn": _PRECIO,
        "moneda": "MXN",
        "frecuencia": "mensual",
        "trial_dias": 14,
        # Planes ofrecidos en WEB. El frontend los pinta desde aqui para que el
        # precio del paywall y el del checkout no puedan desincronizarse.
        "planes": [
            {
                "ciclo": c,
                "nombre": v["nombre"],
                "precio_mxn": v["precio"],
                "sufijo": v["sufijo"],
                "badge": v.get("badge"),
            }
            for c, v in _CICLOS.items()
        ],
        "revenuecat_disponible": bool(_RC_SECRET) and requests is not None,
        "entitlement": _RC_ENTITLEMENT,
    }


def _ofuscar(email: str | None) -> str:
    """Correo parcialmente oculto para la bitacora (no volcamos PII completa)."""
    e = (email or "").strip()
    if "@" not in e:
        return "(sin correo)"
    usuario, dominio = e.split("@", 1)
    visible = usuario[:2] if len(usuario) > 2 else usuario[:1]
    return f"{visible}***@{dominio}"


def _cargar_store() -> dict[str, Any]:
    if not _STORE_PATH.exists():
        return {"suscripciones": {}, "eventos": []}
    try:
        return json.loads(_STORE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"suscripciones": {}, "eventos": []}


def _guardar_store(data: dict[str, Any]) -> None:
    tmp = _STORE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_STORE_PATH)


def _cancelar_en_mp(pre_id: str) -> bool:
    """Cancela una suscripcion en MercadoPago. True si quedo cancelada."""
    tok = _token()
    if not tok or requests is None or not pre_id:
        return False
    try:
        r = requests.put(
            f"{_MP_API}/preapproval/{pre_id}",
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
            json={"status": "cancelled"},
            timeout=15,
        )
        ok = r.status_code < 400
        log.info("cancelar_mp id=%s http=%s ok=%s", pre_id, r.status_code, ok)
        return ok
    except Exception as e:
        log.warning("cancelar_mp id=%s fallo: %s", pre_id, e)
        return False


def _otras_suscripciones(data: dict[str, Any], email: str, excepto: str,
                         estados: tuple[str, ...]) -> list[str]:
    """IDs de otras suscripciones del mismo correo en alguno de esos estados."""
    return [
        pid for pid, s in (data.get("suscripciones") or {}).items()
        if pid != excepto
        and (s or {}).get("email") == email
        and str((s or {}).get("status") or "").lower() in estados
    ]


def crear_preapproval(email: str, ciclo: str | None = None) -> dict[str, Any]:
    """
    Crea una suscripcion recurrente (mensual o anual). Devuelve:
      {ok, checkout_url, preapproval_id, mock_mode, ciclo, precio_mxn}
    """
    if not email or "@" not in email:
        raise ValueError("Email invalido")

    email = email.strip().lower()
    cfg = _ciclo(ciclo)
    tok = _token()

    if not tok or requests is None:
        # Mock: generamos un id y un enlace simulado.
        pre_id = f"MOCK-{secrets.token_hex(8)}"
        data = _cargar_store()
        data.setdefault("suscripciones", {})[pre_id] = {
            "email": email,
            "status": "pending",
            "ciclo": cfg["etiqueta"],
            "precio_mxn": cfg["precio"],
            "mock": True,
            "creado_en": time.time(),
        }
        _guardar_store(data)
        return {
            "ok": True,
            "mock_mode": True,
            "preapproval_id": pre_id,
            "checkout_url": f"{_BACK_URL}&mock_preapproval={pre_id}",
            "plan": cfg["reason"],
            "ciclo": cfg["etiqueta"],
            "precio_mxn": cfg["precio"],
        }

    # Llamada real a MercadoPago.
    body = {
        "reason": cfg["reason"],
        "auto_recurring": {
            "frequency": cfg["frequency"],
            "frequency_type": cfg["frequency_type"],
            "transaction_amount": cfg["precio"],
            "currency_id": "MXN",
        },
        "back_url": _BACK_URL,
        "payer_email": email,
        "status": "pending",
    }
    resp = requests.post(
        f"{_MP_API}/preapproval",
        headers={
            "Authorization": f"Bearer {tok}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=20,
    )
    if resp.status_code >= 400:
        log.error("crear_preapproval ciclo=%s http=%s cuerpo=%s",
                  cfg["etiqueta"], resp.status_code, resp.text[:300])
        raise RuntimeError(f"MercadoPago respondio {resp.status_code}: {resp.text[:400]}")
    payload = resp.json()
    pre_id = str(payload.get("id"))
    checkout = payload.get("init_point") or payload.get("sandbox_init_point")

    data = _cargar_store()
    # Checkouts ABANDONADOS del mismo correo: si el usuario pidió el mensual,
    # se arrepintió y volvió por el anual, la primera suscripción se queda
    # "pending" y su link sigue siendo pagable. Si pagara las dos quedaría con
    # dos cobros recurrentes vivos. Cancelamos las pendientes anteriores; las
    # ya AUTORIZADAS no se tocan aquí (eso lo resuelve el webhook al activar).
    for viejo in _otras_suscripciones(data, email, pre_id, ("pending",)):
        if _cancelar_en_mp(viejo):
            data["suscripciones"][viejo]["status"] = "cancelled"
            data["suscripciones"][viejo]["cancelada_por"] = pre_id

    data.setdefault("suscripciones", {})[pre_id] = {
        "email": email,
        "status": payload.get("status", "pending"),
        "ciclo": cfg["etiqueta"],
        "precio_mxn": cfg["precio"],
        "mock": False,
        "creado_en": time.time(),
        "raw": {k: payload.get(k) for k in ("id", "status", "init_point", "date_created")},
    }
    _guardar_store(data)
    log.info("preapproval creado id=%s ciclo=%s monto=%s email=%s",
             pre_id, cfg["etiqueta"], cfg["precio"], _ofuscar(email))

    return {
        "ok": True,
        "mock_mode": False,
        "preapproval_id": pre_id,
        "checkout_url": checkout,
        "plan": cfg["reason"],
        "ciclo": cfg["etiqueta"],
        "precio_mxn": cfg["precio"],
    }


def simular_aprobacion(preapproval_id: str) -> dict[str, Any]:
    """Solo para mock mode / pruebas locales: marca una suscripcion como autorizada.

    SEGURIDAD: sin este guard, cualquiera podia auto-otorgarse premium
    (POST /suscribir -> POST /simular-aprobacion). Se niega salvo que
    AUTH_MOCK_MODE este explicitamente activo (dev). Ademas solo acepta
    suscripciones creadas en mock.
    """
    if not MOCK_ENABLED:
        raise PermissionError("simulacion_deshabilitada")
    data = _cargar_store()
    sus = data.get("suscripciones", {}).get(preapproval_id)
    if not sus:
        raise ValueError("Suscripcion no encontrada")
    if not sus.get("mock"):
        raise PermissionError("solo suscripciones mock pueden simularse")
    sus["status"] = "authorized"
    sus["autorizado_en"] = time.time()
    data.setdefault("eventos", []).append({
        "ts": time.time(),
        "tipo": "simulacion_aprobacion",
        "preapproval_id": preapproval_id,
    })
    _guardar_store(data)
    _auth.actualizar_plan(sus["email"], plan="premium", estado_pago="activo")
    return {"ok": True, "status": "authorized", "email": sus["email"]}


def _verificar_firma(headers: dict[str, str], raw_body: bytes, data_id: str = "") -> bool:
    """Valida el header x-signature de MercadoPago (formato ts=,v1=).

    La plantilla que MercadoPago firma es EXACTAMENTE:

        id:<data.id>;request-id:<x-request-id>;ts:<ts>;

    HMAC-SHA256 en hexadecimal, con el secreto del panel como llave y esa
    cadena como mensaje. El cuerpo de la petición NO entra en el HMAC, y los
    campos que no vengan en la notificación se omiten junto con su etiqueta.

    La versión anterior armaba `id:<x-request-id>;ts:<ts>;` + cuerpo: metía el
    request-id en el hueco del id, se saltaba el segmento request-id y
    concatenaba el cuerpo. Con eso la firma no podía coincidir jamás, así que
    con STRICT_WEBHOOKS=1 se rechazaban TODAS las notificaciones: el cobro se
    hacía en MercadoPago y el plan del usuario nunca se activaba.

    `data.id` se toma del query string (?data.id=…), que es lo que MercadoPago
    firma; el del cuerpo sirve de respaldo. Se prueban la forma tal cual y la
    minúscula porque la documentación pide minúsculas cuando el id es
    alfanumérico y no siempre llega así. Ambas variantes exigen el mismo
    secreto, así que probar las dos no debilita la verificación.
    """
    if not _WEBHOOK_SECRET:
        # Sin secreto: en modo estricto (prod) rechazamos; si no, aceptamos (dev).
        if STRICT_WEBHOOKS:
            log.error("webhook RECHAZADO: STRICT_WEBHOOKS=1 y no hay MERCADOPAGO_WEBHOOK_SECRET")
            return False
        log.warning("webhook ACEPTADO SIN FIRMA: no hay secreto y STRICT_WEBHOOKS esta apagado")
        return True

    sig = headers.get("x-signature") or headers.get("X-Signature")
    if not sig:
        log.warning("webhook RECHAZADO: sin header x-signature (data.id=%s)", data_id)
        return False
    parts = {}
    for p in sig.split(","):
        if "=" in p:
            k, v = p.strip().split("=", 1)
            parts[k] = v
    ts = parts.get("ts")
    v1 = parts.get("v1")
    if not (ts and v1):
        log.warning("webhook RECHAZADO: x-signature sin ts o v1 (data.id=%s)", data_id)
        return False

    req_id = headers.get("x-request-id") or headers.get("X-Request-Id") or ""

    def _mac(did: str, con_req: bool) -> str:
        trozos = []
        if did:
            trozos.append(f"id:{did};")
        if con_req and req_id:
            trozos.append(f"request-id:{req_id};")
        trozos.append(f"ts:{ts};")
        return hmac.new(_WEBHOOK_SECRET.encode(), "".join(trozos).encode(), sha256).hexdigest()

    did = str(data_id or "")
    # Variantes toleradas: id tal cual / en minuscula, y con o sin el segmento
    # request-id (MercadoPago lo omite en algunas notificaciones aunque mande el
    # header). Todas exigen el MISMO secreto, asi que probarlas no debilita nada.
    for candidato in {did, did.lower()}:
        for con_req in (True, False):
            if hmac.compare_digest(_mac(candidato, con_req), v1):
                return True

    # Diagnostico: sin esto, un secreto equivocado es indistinguible de un
    # atacante y no hay forma de depurarlo en produccion.
    #
    # Se registran los datos que manda MercadoPago (data.id, request-id, ts y la
    # firma v1 completa). Nada de eso es secreto: v1 es el HMAC que llega en la
    # peticion, y con el se puede recomputar el manifiesto correcto desde la VM
    # para saber si el secreto configurado es el equivocado. El SECRETO y el
    # v1 ESPERADO no se registran (solo la longitud del secreto).
    log.warning(
        "webhook RECHAZADO firma_invalida data.id=%s request-id=%s ts=%s "
        "v1_recibido=%s v1_esperado=%s… (secreto len=%d)",
        data_id, req_id or "(ausente)", ts, v1,
        _mac(did, True)[:8], len(_WEBHOOK_SECRET),
    )
    return False


_MAX_EVENTOS = 500


def procesar_webhook(
    headers: dict[str, str],
    raw_body: bytes,
    payload: dict[str, Any],
    data_id_query: str = "",
) -> dict[str, Any]:
    """
    Procesa una notificacion. Acepta los eventos 'preapproval' y actualiza el
    estado del plan del usuario. Guarda una bitacora ligera.

    `data_id_query` es el ?data.id= del query string, que es el valor que
    MercadoPago incluye en la firma. Si no viene, se cae al del cuerpo.

    A QUIEN se le acredita el premium
    ---------------------------------
    Al correo de la CUENTA que inicio el cobro (el que guardamos en el store al
    crear el preapproval), NO al `payer_email` que devuelve MercadoPago.

    Son cosas distintas: `payer_email` es el correo de la cuenta de MercadoPago
    con la que se pago. Quien se registro como `ana@itam.mx` y paga con su
    MercadoPago personal `ana.lopez@gmail.com` recibia el premium en una cuenta
    fantasma `ana.lopez@gmail.com` (creada ahi mismo por actualizar_plan) y se
    quedaba sin acceso en la suya, habiendo pagado. `payer_email` solo se usa
    como respaldo cuando el preapproval no esta en nuestro store.
    """
    tipo = payload.get("type") or payload.get("topic") or ""
    data_id = str(data_id_query or (payload.get("data") or {}).get("id") or payload.get("id") or "")

    if not _verificar_firma(headers, raw_body, data_id):
        # El error viaja al route, que responde 401. Un 200 aqui le dice a
        # MercadoPago "entregado" y no reintenta: el cobro quedaria hecho y el
        # plan sin activar, en silencio.
        return {"ok": False, "error": "firma_invalida"}

    log.info("webhook RECIBIDO tipo=%s data.id=%s firma=ok", tipo, data_id)

    evento = {
        "ts": time.time(),
        "tipo": tipo,
        "data_id": data_id,
        "headers": {k: v for k, v in headers.items() if k.lower().startswith("x-")},
    }

    estado_final = None
    email_final = None
    estado_mp = None
    email_mp = None

    if tipo in ("preapproval", "subscription_preapproval") and data_id and requests is not None and _token():
        resp = requests.get(
            f"{_MP_API}/preapproval/{data_id}",
            headers={"Authorization": f"Bearer {_token()}"},
            timeout=15,
        )
        if resp.status_code >= 400:
            # No lo damos por procesado: devolvemos error para responder 5xx y
            # que MercadoPago reintente. Antes se caia en silencio a estado
            # None y el evento se perdia para siempre.
            log.error("webhook consulta a MP FALLO id=%s http=%s cuerpo=%s",
                      data_id, resp.status_code, resp.text[:200])
            return {"ok": False, "error": "consulta_mp_fallida", "tipo": tipo}
        info = resp.json()
        estado_mp = (info.get("status") or "").lower()
        email_mp = (info.get("payer_email") or "").strip().lower() or None
        if estado_mp == "authorized":
            estado_final = "activo"
        elif estado_mp in ("cancelled", "paused", "finished"):
            estado_final = "inactivo"
        evento["status_mp"] = estado_mp

    data = _cargar_store()
    sus = (data.get("suscripciones") or {}).get(data_id) or {}
    email_store = (sus.get("email") or "").strip().lower() or None
    email_final = email_store or email_mp
    origen = "store" if email_store else "payer_email(respaldo)"
    if not email_store and email_mp:
        log.warning("webhook id=%s sin registro local; se usa payer_email de MP", data_id)

    # Idempotencia: MercadoPago reintenta y manda el mismo evento varias veces.
    # Si ya aplicamos ESTE estado a ESTE correo, no se vuelve a aplicar ni se
    # duplica la entrada en la bitacora.
    clave = f"{estado_mp}:{email_final}"
    duplicado = bool(sus) and sus.get("ultimo_aplicado") == clave
    evento["duplicado"] = duplicado

    if duplicado:
        log.info("webhook IDEMPOTENTE id=%s estado=%s email=%s (ya aplicado, se ignora)",
                 data_id, estado_mp, _ofuscar(email_final))
    elif email_final and estado_final:
        _auth.actualizar_plan(
            email_final,
            plan="premium" if estado_final == "activo" else "trial",
            estado_pago=estado_final,
        )
        log.info("webhook APLICADO id=%s status_mp=%s -> plan=%s email=%s (origen=%s)",
                 data_id, estado_mp, estado_final, _ofuscar(email_final), origen)
        if data_id in (data.get("suscripciones") or {}):
            data["suscripciones"][data_id]["status"] = estado_mp
            data["suscripciones"][data_id]["ultimo_aplicado"] = clave
        # Un solo cobro recurrente vivo por correo: al activar una suscripcion,
        # se cancelan en MercadoPago las OTRAS del mismo correo que sigan
        # pendientes o autorizadas (p.ej. pago el mensual y luego el anual).
        if estado_final == "activo":
            for otro in _otras_suscripciones(data, email_final, data_id, ("pending", "authorized")):
                if _cancelar_en_mp(otro):
                    data["suscripciones"][otro]["status"] = "cancelled"
                    data["suscripciones"][otro]["cancelada_por"] = data_id
                    log.info("webhook cancela suscripcion duplicada id=%s (gana %s) email=%s",
                             otro, data_id, _ofuscar(email_final))
    else:
        log.info("webhook SIN EFECTO id=%s tipo=%s status_mp=%s email=%s "
                 "(estado no accionable o sin correo)",
                 data_id, tipo, estado_mp, _ofuscar(email_final))

    if not duplicado:
        eventos = data.setdefault("eventos", [])
        eventos.append(evento)
        # Bitacora acotada: sin esto pagos.json crece sin limite y cada webhook
        # lo reescribe entero.
        if len(eventos) > _MAX_EVENTOS:
            del eventos[:-_MAX_EVENTOS]
    _guardar_store(data)

    return {"ok": True, "estado": estado_final, "email": email_final,
            "tipo": tipo, "duplicado": duplicado}


# ============================================================================
#  REVENUECAT — compras in-app (App Store / Google Play)
# ============================================================================
def revenuecat_configurado() -> bool:
    return bool(_RC_SECRET) and requests is not None


def _rc_entitlement_activa(subscriber: dict[str, Any]) -> bool:
    """True si la entitlement 'premium' del subscriber sigue vigente.

    Distingue tres casos:
      - Entitlement NO otorgada -> inactiva.
      - Entitlement otorgada SIN expires_date -> compra "Ilimitado"/lifetime
        (NON_RENEWING_PURCHASE). No expira nunca => ACTIVA. (Antes se trataba
        como inactiva y los compradores de por vida no recibian premium.)
      - Entitlement con expires_date -> activa solo si la fecha es futura.
    """
    ents = ((subscriber or {}).get("entitlements") or {})
    ent = ents.get(_RC_ENTITLEMENT)
    if not ent:
        return False
    exp = ent.get("expires_date")
    if not exp:
        # Lifetime / compra unica: sin expiracion = vigente para siempre.
        return True
    # expires_date viene en ISO-8601 UTC, ej "2026-07-15T00:00:00Z".
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
        return dt > datetime.now(timezone.utc)
    except Exception:
        # Si no podemos parsear pero existe la entitlement, ser conservadores: activa.
        return True


def revenuecat_verificar(app_user_id: str) -> dict[str, Any]:
    """
    Consulta la REST API de RevenueCat (server-side, con SECRET key) para saber si
    el usuario tiene la entitlement 'premium' activa, y sincroniza el plan local.

    `app_user_id` es el ID con el que el cliente hizo Purchases.logIn(...) —
    en nuestra app usamos el email del usuario.
    """
    email = (app_user_id or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("app_user_id (email) invalido")
    if not revenuecat_configurado():
        # Sin SECRET key no podemos verificar de forma segura. No otorgamos premium.
        return {"ok": False, "error": "revenuecat_no_configurado", "premium": False}

    import urllib.parse
    url = f"{_RC_API}/subscribers/{urllib.parse.quote(email, safe='')}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {_RC_SECRET}", "Content-Type": "application/json"},
        timeout=15,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"RevenueCat respondio {resp.status_code}: {resp.text[:300]}")
    subscriber = (resp.json() or {}).get("subscriber") or {}
    activa = _rc_entitlement_activa(subscriber)

    _auth.actualizar_plan(
        email,
        plan="premium" if activa else "trial",
        estado_pago="activo" if activa else "inactivo",
    )

    data = _cargar_store()
    data.setdefault("eventos", []).append({
        "ts": time.time(), "tipo": "revenuecat_verificar",
        "email": email, "premium": activa,
    })
    _guardar_store(data)
    return {"ok": True, "premium": activa, "email": email}


def revenuecat_webhook(headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    """
    Webhook server-authoritative de RevenueCat. En el dashboard configuras un
    header Authorization con un secreto; aqui lo validamos. La verdad final la
    confirmamos consultando la REST API (revenuecat_verificar) para no confiar
    ciegamente en el body.
    """
    if _RC_WEBHOOK_AUTH:
        auth = headers.get("Authorization") or headers.get("authorization") or ""
        if not hmac.compare_digest(auth.strip(), _RC_WEBHOOK_AUTH.strip()):
            return {"ok": False, "error": "auth_invalida"}
    elif STRICT_WEBHOOKS:
        # Modo estricto (prod): sin REVENUECAT_WEBHOOK_AUTH configurado no se
        # acepta ningun webhook (evita que un tercero POStee eventos falsos).
        return {"ok": False, "error": "webhook_no_configurado"}

    ev = (payload or {}).get("event") or {}
    app_user_id = ev.get("app_user_id") or ev.get("original_app_user_id")
    tipo = ev.get("type", "")

    data = _cargar_store()
    data.setdefault("eventos", []).append({
        "ts": time.time(), "tipo": f"rc:{tipo}", "app_user_id": app_user_id,
    })
    _guardar_store(data)

    if app_user_id and "@" in str(app_user_id) and revenuecat_configurado():
        try:
            return revenuecat_verificar(app_user_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, "tipo": tipo}
