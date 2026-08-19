"""
sms.py — Envío de SMS para verificar el teléfono al crear cuenta.

QUÉ HACE FALTA PARA QUE ESTO ENVÍE DE VERDAD
--------------------------------------------
Un proveedor con crédito. El código está escrito contra la API HTTP de Twilio
porque es la que cubre México sin trámite previo, pero la interfaz es una sola
función (`enviar`) y cambiar de proveedor es reescribir `_enviar_twilio`.

Variables de entorno (en el .env del servicio, junto a JWT_SECRET):

    SMS_PROVEEDOR=twilio
    TWILIO_ACCOUNT_SID=AC...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM=+1XXXXXXXXXX          # o, mejor:
    TWILIO_MESSAGING_SERVICE_SID=MG...

SIN CREDENCIALES NO SE ENVÍA NADA, y eso se dice en voz alta: `enviar` lanza
excepción y el endpoint la reporta. Un SMS que no sale y nadie ve es peor que un
error visible, porque el usuario se queda esperando un código que nunca llega.

En desarrollo, `SMS_MOCK_MODE=true` imprime el mensaje en el log en lugar de
enviarlo (y el endpoint devuelve el código para poder probar el flujo completo).

COSTOS Y ENTREGA EN MÉXICO
--------------------------
Cada SMS se cobra por mensaje. México exige que el remitente sea un número
capaz de enviar a MX; con un número long-code de EE.UU. la entrega funciona pero
puede filtrarse. Para volumen, lo correcto es un Messaging Service con un número
mexicano registrado. Nada de eso se puede resolver desde el código.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

_PROVEEDOR = (os.environ.get("SMS_PROVEEDOR") or "twilio").strip().lower()
_MOCK = (os.environ.get("SMS_MOCK_MODE") or "").lower() in ("1", "true", "yes")
_TIMEOUT = 12

# País por omisión de los números sin prefijo. La app es para inversionistas
# mexicanos: escribir 10 dígitos y que funcione es lo esperado aquí.
_LADA_DEFECTO = os.environ.get("SMS_LADA_DEFECTO", "52")


class SMSNoConfigurado(RuntimeError):
    """Falta el proveedor o sus credenciales. Se distingue de un fallo de red
    para que el endpoint pueda decir cuál de las dos cosas pasó."""


class TelefonoInvalido(ValueError):
    pass


def normalizar(telefono: str) -> str:
    """Devuelve el número en formato E.164 (+52...) o lanza TelefonoInvalido.

    Se aceptan las formas en que la gente escribe su teléfono de verdad:
    "55 1234 5678", "(55) 1234-5678", "044 55...", "+52 1 55...". Guardar todos
    en un solo formato es lo que permite que "un teléfono = una cuenta" sea
    comprobable: sin normalizar, el mismo número con y sin espacios son dos.
    """
    if not telefono:
        raise TelefonoInvalido("Escribe tu teléfono")
    t = re.sub(r"[^\d+]", "", str(telefono))

    if t.startswith("00"):          # prefijo internacional a la europea
        t = "+" + t[2:]

    if not t.startswith("+"):
        d = re.sub(r"\D", "", t)
        # 044 / 045 + 10 dígitos: la forma de marcar celulares antes de 2019.
        # Son TRECE dígitos en total, no doce; con la cuenta mal el prefijo se
        # quedaba pegado y salía un "+0445512345678" que ningún proveedor acepta.
        if len(d) == 13 and d.startswith(("044", "045")):
            d = d[3:]
        # Un "1" de larga distancia delante de los 10 dígitos, también obsoleto.
        if len(d) == 11 and d.startswith("1") and _LADA_DEFECTO == "52":
            d = d[1:]
        if len(d) == 10:
            t = "+" + _LADA_DEFECTO + d
        elif len(d) > 10:
            t = "+" + d
        else:
            raise TelefonoInvalido("El teléfono debe tener 10 dígitos")

    # Con lada explícita el "1" obsoleto también hay que quitarlo: "+52 1 55..."
    # es como todavía lo dicta mucha gente y como lo guardan agendas viejas.
    # Twilio lo rechaza (error 21211) porque son 11 dígitos donde caben 10.
    if t.startswith("+521") and len(t) == 14:
        t = "+52" + t[4:]

    digitos = t[1:]
    if not digitos.isdigit() or not (8 <= len(digitos) <= 15):
        raise TelefonoInvalido("Ese teléfono no parece válido")
    return "+" + digitos


def enmascarar(telefono: str) -> str:
    """+52 55 1234 5678 → •••• 5678. Para confirmar a qué número se envió sin
    reimprimir el número completo en una pantalla que alguien puede ver."""
    d = re.sub(r"\D", "", telefono or "")
    return "•••• " + d[-4:] if len(d) >= 4 else "••••"


def configurado() -> bool:
    """Si esto es False, el registro por teléfono no puede funcionar."""
    if _MOCK:
        return True
    if _PROVEEDOR == "twilio":
        return bool(os.environ.get("TWILIO_ACCOUNT_SID")
                    and os.environ.get("TWILIO_AUTH_TOKEN")
                    and (os.environ.get("TWILIO_FROM")
                         or os.environ.get("TWILIO_MESSAGING_SERVICE_SID")))
    return False


def enviar(telefono: str, texto: str) -> dict:
    """Envía un SMS. Lanza SMSNoConfigurado o RuntimeError; nunca falla en
    silencio."""
    numero = normalizar(telefono)

    if _MOCK:
        print(f"[sms] (mock) a {numero}: {texto}", flush=True)
        return {"ok": True, "proveedor": "mock", "id": None}

    if _PROVEEDOR != "twilio":
        raise SMSNoConfigurado(f"Proveedor de SMS desconocido: {_PROVEEDOR}")
    return _enviar_twilio(numero, texto)


def _enviar_twilio(numero: str, texto: str) -> dict:
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    desde = os.environ.get("TWILIO_FROM")
    servicio = os.environ.get("TWILIO_MESSAGING_SERVICE_SID")
    if not (sid and token and (desde or servicio)):
        raise SMSNoConfigurado(
            "Falta configurar el proveedor de SMS (TWILIO_ACCOUNT_SID, "
            "TWILIO_AUTH_TOKEN y TWILIO_FROM o TWILIO_MESSAGING_SERVICE_SID)")

    campos = {"To": numero, "Body": texto}
    # El Messaging Service manda sobre el número suelto: elige el remitente
    # adecuado por país, que es justo lo que hace falta para México.
    if servicio:
        campos["MessagingServiceSid"] = servicio
    else:
        campos["From"] = desde

    url = f"https://api.twilio.com/2010-04-01/Accounts/{urllib.parse.quote(sid)}/Messages.json"
    datos = urllib.parse.urlencode(campos).encode("utf-8")
    req = urllib.request.Request(url, data=datos, method="POST")
    import base64
    cred = base64.b64encode(f"{sid}:{token}".encode("utf-8")).decode("ascii")
    req.add_header("Authorization", "Basic " + cred)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            cuerpo = json.loads(r.read().decode("utf-8") or "{}")
        return {"ok": True, "proveedor": "twilio", "id": cuerpo.get("sid")}
    except urllib.error.HTTPError as e:
        detalle = ""
        try:
            detalle = json.loads(e.read().decode("utf-8") or "{}").get("message") or ""
        except Exception:
            pass
        # El código de Twilio se conserva: 21211 es número inválido, 21608 es
        # número no verificado en cuenta de prueba, 20003 credenciales malas.
        raise RuntimeError(f"Twilio {e.code}: {detalle or e.reason}") from e
    except Exception as e:
        raise RuntimeError(f"No se pudo contactar al proveedor de SMS: {e}") from e
