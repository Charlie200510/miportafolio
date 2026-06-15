"""
push.py — Web Push notifications (iOS 16.4+, Android, Desktop).

Funciones:
  - vapid_public_key(): devuelve la public key VAPID para que el frontend
    se suscriba
  - guardar_suscripcion(email, subscription): persiste el endpoint del browser
  - eliminar_suscripcion(email, endpoint): unsuscribe
  - enviar_notificacion(email, titulo, body, url, icon): manda a TODOS los
    devices de ese email
  - generar_vapid_keys(): one-time, para generar el par de claves al setup

Env vars necesarias:
  VAPID_PUBLIC_KEY    — clave pública (base64url)
  VAPID_PRIVATE_KEY   — clave privada (base64url)
  VAPID_CLAIM_EMAIL   — mailto:soporte@miportafolio.app (sub claim de JWT)

Si VAPID_PRIVATE_KEY no está configurada, las funciones devuelven errors
graciosamente — la app sigue funcionando sin push.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import db as _db


VAPID_PUBLIC  = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_CLAIM   = os.environ.get("VAPID_CLAIM_EMAIL", "mailto:soporte@miportafolio.app").strip()


def vapid_disponible() -> bool:
    return bool(VAPID_PUBLIC and VAPID_PRIVATE)


def vapid_public_key() -> str:
    return VAPID_PUBLIC


def guardar_suscripcion(email: str, subscription: Dict[str, Any],
                        user_agent: Optional[str] = None) -> Dict[str, Any]:
    """Persiste la suscripción de Web Push del browser.
    subscription es el objeto retornado por PushManager.subscribe()."""
    if not email or "@" not in email:
        raise ValueError("Email inválido")
    endpoint = (subscription or {}).get("endpoint")
    keys = (subscription or {}).get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not (endpoint and p256dh and auth):
        raise ValueError("Subscription incompleta (falta endpoint/keys.p256dh/keys.auth)")

    with _db.conn() as c:
        if _db.USING_PG:
            cur = c.cursor()
            cur.execute("""
                INSERT INTO push_subscriptions (user_email, endpoint, p256dh_key, auth_key, user_agent)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (endpoint) DO UPDATE SET
                    user_email = EXCLUDED.user_email,
                    p256dh_key = EXCLUDED.p256dh_key,
                    auth_key = EXCLUDED.auth_key,
                    user_agent = EXCLUDED.user_agent,
                    activo = true,
                    last_used_at = now()
                RETURNING id
            """, (email.lower().strip(), endpoint, p256dh, auth, user_agent))
            row = cur.fetchone()
            return {"ok": True, "id": str(row["id"])}
        else:
            cur = c.cursor()
            cur.execute("""
                INSERT OR REPLACE INTO push_subscriptions
                (id, user_email, endpoint, p256dh_key, auth_key, user_agent, created_at, activo)
                VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, datetime('now'), 1)
            """, (email.lower().strip(), endpoint, p256dh, auth, user_agent))
            return {"ok": True}


def eliminar_suscripcion(email: str, endpoint: str) -> bool:
    if not email or not endpoint:
        return False
    with _db.conn() as c:
        sql = """UPDATE push_subscriptions SET activo = false
                 WHERE user_email = {pl} AND endpoint = {pl}""".format(
                 pl="%s" if _db.USING_PG else "?")
        n = _db.execute(c, sql, (email.lower().strip(), endpoint))
    return n > 0


def listar_suscripciones(email: str) -> List[Dict[str, Any]]:
    if not email:
        return []
    with _db.conn() as c:
        sql = """SELECT id, endpoint, p256dh_key, auth_key, user_agent, created_at
                 FROM push_subscriptions
                 WHERE user_email = {pl} AND activo = true
                 ORDER BY created_at DESC""".format(pl="%s" if _db.USING_PG else "?")
        rows = _db.query(c, sql, (email.lower().strip(),))
    return rows


def enviar_notificacion(email: str, titulo: str, body: str,
                        url: str = "/", icon: str = "/static/logo.png",
                        tag: Optional[str] = None) -> Dict[str, Any]:
    """Manda push a TODAS las suscripciones activas de ese email.
    Devuelve {ok, enviados, fallidos, errores}."""
    if not vapid_disponible():
        return {"ok": False, "error": "VAPID keys no configuradas"}
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        return {"ok": False, "error": "pywebpush no instalado"}

    subs = listar_suscripciones(email)
    if not subs:
        return {"ok": True, "enviados": 0, "fallidos": 0, "errores": [], "info": "sin suscripciones"}

    payload = json.dumps({
        "title": titulo,
        "body": body,
        "icon": icon,
        "badge": icon,
        "url": url,
        "tag": tag or "miportafolio",
    })

    enviados, fallidos, errores = 0, 0, []
    endpoints_invalidos = []
    for s in subs:
        sub = {
            "endpoint": s["endpoint"],
            "keys": {"p256dh": s["p256dh_key"], "auth": s["auth_key"]},
        }
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=VAPID_PRIVATE,
                vapid_claims={"sub": VAPID_CLAIM},
            )
            enviados += 1
        except WebPushException as e:
            fallidos += 1
            errores.append({"endpoint": s["endpoint"][:60], "error": str(e)[:200]})
            # Si el endpoint regresó 410 (gone) o 404, marcarlo como inactivo
            if e.response is not None and e.response.status_code in (404, 410):
                endpoints_invalidos.append(s["endpoint"])
        except Exception as e:
            fallidos += 1
            errores.append({"endpoint": s["endpoint"][:60], "error": str(e)[:200]})

    # Limpieza: marcar inactivos los endpoints muertos
    if endpoints_invalidos:
        try:
            with _db.conn() as c:
                for ep in endpoints_invalidos:
                    sql = "UPDATE push_subscriptions SET activo = false WHERE endpoint = {pl}".format(
                        pl="%s" if _db.USING_PG else "?")
                    _db.execute(c, sql, (ep,))
        except Exception:
            pass

    return {"ok": True, "enviados": enviados, "fallidos": fallidos, "errores": errores}


def generar_vapid_keys() -> Dict[str, str]:
    """Genera un par VAPID nuevo. CLI helper para setup inicial.
    Devuelve {public, private} en formato base64url para guardar en env."""
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        import base64
    except ImportError:
        raise RuntimeError("cryptography library no instalada")

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # Encoding base64url sin padding (formato VAPID estándar)
    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

    # Public key: uncompressed point (65 bytes: 0x04 + x + y)
    pub_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    # Private key: raw 32 bytes
    priv_int = private_key.private_numbers().private_value
    priv_bytes = priv_int.to_bytes(32, "big")

    return {
        "public":  _b64url(pub_bytes),
        "private": _b64url(priv_bytes),
    }


if __name__ == "__main__":
    print("Generando par VAPID...")
    keys = generar_vapid_keys()
    print(f"\nVAPID_PUBLIC_KEY={keys['public']}")
    print(f"VAPID_PRIVATE_KEY={keys['private']}")
    print("\nGuárdalas en las env vars de Render.")
