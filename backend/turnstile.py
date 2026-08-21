"""
turnstile.py — Verificación de Cloudflare Turnstile para el registro web.

POR QUÉ NO HAY UN WORKER EN MEDIO
---------------------------------
El asistente de Cloudflare despliega un Worker que hace de intermediario entre
el navegador y `siteverify`. Existe para quien tiene un frontend SIN backend: la
regla real es que el secreto NUNCA viaje al navegador, y sin servidor propio un
Worker es la única forma de cumplirla.

Aquí sí hay servidor. `navegador → Flask → siteverify` cumple la misma regla con
una pieza menos que mantener, sin una URL de `workers.dev` extra que se pueda
caer por su cuenta, y con el secreto guardado donde ya viven los demás
(deploy/.env). Meter un Worker sería añadir un salto de red y un punto de fallo
para no ganar nada.

QUÉ PASA SI CLOUDFLARE NO CONTESTA
----------------------------------
Se distingue el token INVÁLIDO del servicio CAÍDO, y no se tratan igual:

  · token inválido, ausente o ya usado  → se rechaza el registro.
  · siteverify no responde (red, 5xx)   → se DEJA PASAR y se registra en el log.

Cerrar el registro entero porque un servicio de terceros tiene un mal minuto ya
salió mal una vez en este proyecto (el SMS obligatorio dejó la app sin altas
posibles). Las cuotas por IP y por dispositivo siguen puestas debajo, así que
dejar pasar durante una caída no abre la puerta: solo quita el cerrojo de más.

Env vars:
  TURNSTILE_SECRET_KEY   secreto del widget (NUNCA al cliente)
  TURNSTILE_SITEKEY      clave pública, la que va en el HTML
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
_TIMEOUT = 6          # segundos: es una llamada en la ruta del registro


class TurnstileInvalido(ValueError):
    """El token no es válido: falta, expiró, ya se usó o es de otro dominio."""


def sitekey() -> str:
    """Clave pública. Se sirve desde el backend en vez de estar escrita en el
    HTML para poder rotar el widget sin volver a desplegar el frontend."""
    return (os.environ.get("TURNSTILE_SITEKEY") or "").strip()


def _secreto() -> str:
    return (os.environ.get("TURNSTILE_SECRET_KEY") or "").strip()


def configurado() -> bool:
    """True si se puede verificar de verdad. Sin las dos claves, el módulo no
    finge: quien lo llama decide si eso significa dejar pasar o no."""
    return bool(_secreto() and sitekey())


def verificar(token: Optional[str], ip: Optional[str] = None) -> None:
    """Lanza TurnstileInvalido si el token no pasa. No lanza si el servicio no
    responde: ver la nota de arriba sobre caídas.

    `ip` es opcional y refuerza la comprobación: Cloudflare valida que el token
    se resolvió desde esa misma IP.
    """
    if not configurado():
        return                      # el que llama ya decidió qué hacer con esto

    token = (token or "").strip()
    if not token:
        raise TurnstileInvalido("Falta la verificación antibots. Recarga la página.")
    if len(token) > 2048:
        # Turnstile emite tokens de ~500 caracteres. Un valor enorme es basura o
        # un intento de saturar la llamada a siteverify.
        raise TurnstileInvalido("La verificación antibots no es válida. Recarga la página.")

    datos = {"secret": _secreto(), "response": token}
    if ip:
        datos["remoteip"] = ip

    try:
        req = urllib.request.Request(
            _VERIFY_URL,
            data=urllib.parse.urlencode(datos).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            cuerpo = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        # SERVICIO CAÍDO, no token malo: se deja pasar. El operador tiene que
        # poder verlo, porque si esto sale a cada rato la defensa está apagada
        # sin que nadie se entere.
        print(f"[turnstile] siteverify no respondió ({exc}); se deja pasar el "
              f"registro. Las cuotas por IP y dispositivo siguen activas.", flush=True)
        return

    if cuerpo.get("success") is True:
        return

    codigos = cuerpo.get("error-codes") or []
    # `internal-error` es de Cloudflare, no del usuario: se trata como caída.
    if "internal-error" in codigos:
        print(f"[turnstile] internal-error de Cloudflare; se deja pasar.", flush=True)
        return
    # Los dos primeros son fallos de CONFIGURACIÓN nuestra, no del visitante:
    # con el secreto mal puesto, rechazar sería cerrar el registro a todos.
    if "missing-input-secret" in codigos or "invalid-input-secret" in codigos:
        print(f"[turnstile] SECRETO MAL CONFIGURADO ({codigos}); se deja pasar. "
              f"Revisa TURNSTILE_SECRET_KEY en deploy/.env.", flush=True)
        return

    print(f"[turnstile] token rechazado: {codigos}", flush=True)
    if "timeout-or-duplicate" in codigos:
        raise TurnstileInvalido("Esa verificación ya se usó o expiró. Recarga la página.")
    raise TurnstileInvalido("No pudimos verificar que eres una persona. Recarga la página.")


if __name__ == "__main__":
    # Autoprueba: dice si está configurado y qué contesta siteverify a un token
    # de mentira (debe ser invalid-input-response, lo que prueba que el SECRETO
    # sí es correcto: con un secreto malo contestaría invalid-input-secret).
    print("sitekey    :", sitekey() or "(falta)")
    print("secreto    :", "presente" if _secreto() else "(falta)")
    print("configurado:", configurado())
    if configurado():
        try:
            verificar("token-de-mentira-para-probar")
            print("\nresultado  : se dejó pasar (mira el log de arriba)")
        except TurnstileInvalido as e:
            print("\nresultado  : rechazado ✓ —", e)
