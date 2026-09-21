#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cliente mínimo de la API de App Store Connect.

    python3 deploy/asc.py builds        # los builds subidos, del más nuevo al más viejo
    python3 deploy/asc.py versiones     # las versiones de la tienda y su estado
    python3 deploy/asc.py resenas       # las reseñas de los usuarios

    from asc import req, APP            # como módulo, para consultas sueltas
    req("GET", f"/v1/apps/{APP}/builds?limit=10")

POR QUÉ ESTÁ AQUÍ Y NO EN UN TEMPORAL
--------------------------------------
Vivía en un directorio temporal y se ha perdido tres veces, y cada vez hubo que
reescribirlo a media subida. Consultar el estado de un build es parte del
release, así que va versionado con el resto del release.

LA LLAVE NO ESTÁ EN EL REPO Y NO DEBE ESTARLO. Vive en
~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8, que es donde la buscan
también `altool` y `xcodebuild`. Si falta, este script lo dice y no sigue.
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

KEY_ID = os.environ.get("ASC_KEY_ID", "5T2N2W66Q8")
ISSUER = os.environ.get("ASC_ISSUER", "28f32e72-0ad4-4ce1-ac44-536001e28056")
APP = os.environ.get("ASC_APP_ID", "6786917173")
BASE = "https://api.appstoreconnect.apple.com"

# Los dos sitios donde puede estar la llave, en orden de preferencia.
_CANDIDATAS = [
    pathlib.Path.home() / ".appstoreconnect" / "private_keys" / f"AuthKey_{KEY_ID}.p8",
    pathlib.Path.home() / "Downloads" / f"AuthKey_{KEY_ID}.p8",
]


def _llave() -> str:
    for p in _CANDIDATAS:
        if p.exists():
            return p.read_text()
    raise SystemExit(
        f"No encuentro AuthKey_{KEY_ID}.p8. Debería estar en:\n  "
        + "\n  ".join(str(p) for p in _CANDIDATAS))


def token() -> str:
    """JWT ES256 válido 20 minutos (Apple rechaza los de más de 20)."""
    import jwt  # PyJWT
    ahora = int(time.time())
    return jwt.encode(
        {"iss": ISSUER, "iat": ahora, "exp": ahora + 1200, "aud": "appstoreconnect-v1"},
        _llave(), algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})


def req(metodo: str, ruta: str, cuerpo=None):
    """Llama a la API. Devuelve el JSON, o {'_e': código, '_b': texto} si falla.

    No lanza en los 4xx a propósito: muchas consultas normales devuelven 404
    (una versión que aún no existe) y tratar eso como excepción obliga a
    envolver cada llamada en un try.
    """
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    r = urllib.request.Request(
        BASE + ruta, data=datos, method=metodo,
        headers={"Authorization": f"Bearer {token()}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            crudo = x.read()
            return json.loads(crudo) if crudo else {}
    except urllib.error.HTTPError as e:
        return {"_e": e.code, "_b": e.read().decode("utf-8", "replace")[:600]}


def _builds():
    r = req("GET", f"/v1/apps/{APP}/builds?limit=20")
    ds = r.get("data")
    if ds is None:
        return print("  ", str(r)[:300])
    # La API no ordena de forma fiable; se ordena aquí por fecha de subida.
    ds.sort(key=lambda d: d["attributes"].get("uploadedDate") or "", reverse=True)
    for d in ds[:10]:
        a = d["attributes"]
        print(f"   build {str(a.get('version')):>4} · {str(a.get('processingState')):12} · "
              f"{str(a.get('uploadedDate'))[:19]}")


def _versiones():
    r = req("GET", f"/v1/apps/{APP}/appStoreVersions?limit=8")
    for d in r.get("data", []):
        a = d["attributes"]
        print(f"   {a['versionString']:8} {a['appStoreState']:24} id={d['id']}")


def _resenas():
    r = req("GET", f"/v1/apps/{APP}/customerReviews?limit=20&sort=-createdDate")
    ds = r.get("data")
    if ds is None:
        return print("  ", str(r)[:300])
    print(f"   {len(ds)} reseñas")
    for d in ds:
        a = d["attributes"]
        print(f"   {a.get('rating')}★ [{a.get('territory')}] {(a.get('title') or '')[:52]}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "builds"
    {"builds": _builds, "versiones": _versiones, "resenas": _resenas}.get(
        cmd, lambda: print(__doc__))()
