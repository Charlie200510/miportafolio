"""
Integracion de pagos con MercadoPago (plan $79 MXN/mes).

Diseno:
- Usamos la API de Preapproval (suscripciones recurrentes) de MercadoPago.
- Si no hay MERCADOPAGO_ACCESS_TOKEN configurado, arrancamos en 'mock mode':
  el front recibe un checkout_url ficticio y podemos simular 'aprobado' en dev.
- El webhook (/api/payments/webhook) recibe notificaciones 'preapproval' y
  actualiza el plan del usuario via auth.actualizar_plan().

Env vars:
- MERCADOPAGO_ACCESS_TOKEN      Access token de produccion o sandbox.
- MERCADOPAGO_PLAN_NOMBRE       Texto visible en el checkout (default 'Mi Portafolio Premium')
- MERCADOPAGO_PRECIO_MXN        Monto mensual (default 79.00)
- MERCADOPAGO_BACK_URL          URL a la que regresa el usuario tras pagar.
- MERCADOPAGO_WEBHOOK_SECRET    Si esta definido, se valida el header x-signature.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional

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
_PRECIO = float(os.environ.get("MERCADOPAGO_PRECIO_MXN", "79.00"))
_PLAN_NOMBRE = os.environ.get("MERCADOPAGO_PLAN_NOMBRE", "Mi Portafolio Premium")
_BACK_URL = os.environ.get("MERCADOPAGO_BACK_URL", "http://localhost:5001/static/index.html?paid=1")
_WEBHOOK_SECRET = os.environ.get("MERCADOPAGO_WEBHOOK_SECRET")

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
        "revenuecat_disponible": bool(_RC_SECRET) and requests is not None,
        "entitlement": _RC_ENTITLEMENT,
    }


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


def crear_preapproval(email: str) -> dict[str, Any]:
    """
    Crea una suscripcion recurrente. Devuelve:
      {ok, checkout_url, preapproval_id, mock_mode}
    """
    if not email or "@" not in email:
        raise ValueError("Email invalido")

    email = email.strip().lower()
    tok = _token()

    if not tok or requests is None:
        # Mock: generamos un id y un enlace simulado.
        pre_id = f"MOCK-{secrets.token_hex(8)}"
        data = _cargar_store()
        data.setdefault("suscripciones", {})[pre_id] = {
            "email": email,
            "status": "pending",
            "mock": True,
            "creado_en": time.time(),
        }
        _guardar_store(data)
        return {
            "ok": True,
            "mock_mode": True,
            "preapproval_id": pre_id,
            "checkout_url": f"{_BACK_URL}&mock_preapproval={pre_id}",
            "plan": _PLAN_NOMBRE,
            "precio_mxn": _PRECIO,
        }

    # Llamada real a MercadoPago.
    body = {
        "reason": _PLAN_NOMBRE,
        "auto_recurring": {
            "frequency": 1,
            "frequency_type": "months",
            "transaction_amount": _PRECIO,
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
        raise RuntimeError(f"MercadoPago respondio {resp.status_code}: {resp.text[:400]}")
    payload = resp.json()
    pre_id = str(payload.get("id"))
    checkout = payload.get("init_point") or payload.get("sandbox_init_point")

    data = _cargar_store()
    data.setdefault("suscripciones", {})[pre_id] = {
        "email": email,
        "status": payload.get("status", "pending"),
        "mock": False,
        "creado_en": time.time(),
        "raw": {k: payload.get(k) for k in ("id", "status", "init_point", "date_created")},
    }
    _guardar_store(data)

    return {
        "ok": True,
        "mock_mode": False,
        "preapproval_id": pre_id,
        "checkout_url": checkout,
        "plan": _PLAN_NOMBRE,
        "precio_mxn": _PRECIO,
    }


def simular_aprobacion(preapproval_id: str) -> dict[str, Any]:
    """Solo para mock mode / pruebas locales: marca una suscripcion como autorizada."""
    data = _cargar_store()
    sus = data.get("suscripciones", {}).get(preapproval_id)
    if not sus:
        raise ValueError("Suscripcion no encontrada")
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


def _verificar_firma(headers: dict[str, str], raw_body: bytes) -> bool:
    """Valida el header x-signature de MercadoPago (formato ts=,v1=)."""
    if not _WEBHOOK_SECRET:
        return True  # sin secreto -> aceptamos (modo dev)
    sig = headers.get("x-signature") or headers.get("X-Signature")
    if not sig:
        return False
    parts = {}
    for p in sig.split(","):
        if "=" in p:
            k, v = p.strip().split("=", 1)
            parts[k] = v
    ts = parts.get("ts")
    v1 = parts.get("v1")
    if not (ts and v1):
        return False
    manifest = f"id:{headers.get('x-request-id','')};ts:{ts};".encode() + raw_body
    mac = hmac.new(_WEBHOOK_SECRET.encode(), manifest, sha256).hexdigest()
    return hmac.compare_digest(mac, v1)


def procesar_webhook(headers: dict[str, str], raw_body: bytes, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Procesa una notificacion. Acepta los eventos 'preapproval' y actualiza el
    estado del plan del usuario. Guarda una bitacora ligera.
    """
    if not _verificar_firma(headers, raw_body):
        return {"ok": False, "error": "firma_invalida"}

    tipo = payload.get("type") or payload.get("topic") or ""
    data_id = (payload.get("data") or {}).get("id") or payload.get("id")
    evento = {
        "ts": time.time(),
        "tipo": tipo,
        "data_id": data_id,
        "headers": {k: v for k, v in headers.items() if k.lower().startswith("x-")},
    }

    estado_final = None
    email_final = None

    if tipo in ("preapproval", "subscription_preapproval") and data_id and requests is not None and _token():
        resp = requests.get(
            f"{_MP_API}/preapproval/{data_id}",
            headers={"Authorization": f"Bearer {_token()}"},
            timeout=15,
        )
        if resp.status_code < 400:
            info = resp.json()
            email_final = info.get("payer_email")
            estado = (info.get("status") or "").lower()
            if estado in ("authorized",):
                estado_final = "activo"
            elif estado in ("cancelled", "paused", "finished"):
                estado_final = "inactivo"
            evento["status_mp"] = estado

    data = _cargar_store()
    data.setdefault("eventos", []).append(evento)
    if email_final and estado_final:
        _auth.actualizar_plan(email_final, plan="premium" if estado_final == "activo" else "trial", estado_pago=estado_final)
    _guardar_store(data)

    return {"ok": True, "estado": estado_final, "email": email_final, "tipo": tipo}


# ============================================================================
#  REVENUECAT — compras in-app (App Store / Google Play)
# ============================================================================
def revenuecat_configurado() -> bool:
    return bool(_RC_SECRET) and requests is not None


def _rc_entitlement_activa(subscriber: dict[str, Any]) -> bool:
    """True si la entitlement 'premium' del subscriber sigue vigente."""
    ents = ((subscriber or {}).get("entitlements") or {})
    ent = ents.get(_RC_ENTITLEMENT) or {}
    exp = ent.get("expires_date")
    if not exp:
        return False
    # expires_date viene en ISO-8601 UTC, ej "2026-07-15T00:00:00Z".
    # Una entitlement sin fecha de expiración futura = inactiva.
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
