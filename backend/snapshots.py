"""
snapshots.py — Snapshots del portafolio, UNO POR DESTINATARIO.

Por qué existe
--------------
Antes había un único archivo global `backend/portafolio_snapshot.json`. Ese
archivo es lo único que habilita las alertas recurrentes por correo: el cron lee
`alertas_activas` y `destinatario` de ahí. Con más de un usuario, cada POST a
/api/portafolio/snapshot sobrescribía el del anterior, así que SOLO el último en
guardar recibía alertas — y todos los demás seguían viendo "alerta activa" en la
interfaz, sin ninguna señal de que no les iba a llegar nada.

El contrato de rutas y nombres vive aquí y no duplicado en app.py y en
enviar_alerta_programada.py: si las dos implementaciones divergen, el escritor
guarda en un lugar y el lector busca en otro, y las alertas se rompen en
silencio (que es justo el tipo de fallo que estamos eliminando).

Nombre de archivo
-----------------
Se deriva del correo con sha256, no del correo tal cual: los correos traen
caracteres que no son seguros como nombre de archivo, varían en mayúsculas y
permitirían salirse del directorio. El correo real va DENTRO del JSON.

NOTA: este directorio NO es backend/_datos/ (cuentas de usuarios). Son datos
derivados y regenerables: si se borran, el usuario los recrea al guardar su
portafolio. Va gitignored.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterator

BACKEND_DIR = Path(__file__).parent
DIR_SNAPSHOTS = BACKEND_DIR / "_snapshots"

# Archivo del esquema viejo (global, un solo usuario). Se sigue leyendo para
# migrarlo, pero ya no se escribe.
RUTA_LEGACY = BACKEND_DIR / "portafolio_snapshot.json"

# Tope de snapshots procesados por corrida del cron. No es una cuota de
# producto: es un freno para que un directorio inesperadamente grande no cuelgue
# la petición del cron. Si se alcanza, quien llame debe avisarlo (no truncar en
# silencio).
MAX_POR_CORRIDA = 50


def _normalizar(email: str) -> str:
    return (email or "").strip().lower()


def nombre_archivo(email: str) -> str:
    h = hashlib.sha256(_normalizar(email).encode("utf-8")).hexdigest()
    return f"{h[:32]}.json"


def ruta_de(email: str) -> Path:
    return DIR_SNAPSHOTS / nombre_archivo(email)


def guardar(snap: dict[str, Any]) -> Path:
    """Escribe el snapshot del destinatario que trae dentro. Escritura atómica
    (tmp + replace) para que el cron nunca lea un JSON a medio escribir."""
    email = _normalizar(snap.get("destinatario"))
    if not email or "@" not in email:
        raise ValueError("el snapshot necesita un destinatario con @ para poder guardarse")
    snap = dict(snap)
    snap["destinatario"] = email

    DIR_SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    destino = ruta_de(email)
    fd, tmp = tempfile.mkstemp(dir=str(DIR_SNAPSHOTS), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(snap, f, indent=2, ensure_ascii=False)
        os.replace(tmp, destino)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return destino


def cargar(email: str) -> dict[str, Any] | None:
    p = ruta_de(email)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def borrar(email: str) -> bool:
    """Se usa cuando alguien cambia su correo de alertas: si no se borra el
    snapshot viejo, la dirección anterior sigue recibiendo alertas para siempre
    (y puede ser de otra persona, si hubo un dedazo)."""
    email = _normalizar(email)
    if not email:
        return False
    try:
        ruta_de(email).unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def borrar_de_cuenta(email: str) -> list[str]:
    """Borra TODO snapshot que pertenezca a esta cuenta, para App Store 5.1.1(v):
    al eliminar la cuenta no puede sobrevivir nada asociado.

    Busca por dos campos porque el correo de ALERTAS puede no ser el de la
    cuenta (el panel de alertas deja poner otro):
      - `destinatario`  = a dónde se mandan las alertas
      - `cuenta_email`  = la sesión que guardó el snapshot, cuando había una

    Si no se borrara, quedarían en el servidor el correo, las posiciones, los
    pesos y las transacciones de una cuenta ya eliminada, y el cron le seguiría
    mandando alertas. Devuelve la lista de correos cuyos snapshots se borraron.
    """
    email = _normalizar(email)
    if not email:
        return []
    borrados: list[str] = []
    if not DIR_SNAPSHOTS.exists():
        return borrados
    for p in sorted(DIR_SNAPSHOTS.glob("*.json")):
        try:
            snap = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(snap, dict):
            continue
        if email in (_normalizar(snap.get("destinatario")),
                     _normalizar(snap.get("cuenta_email"))):
            p.unlink(missing_ok=True)
            borrados.append(_normalizar(snap.get("destinatario")))
    return borrados


def migrar_legacy() -> str | None:
    """Mueve el archivo global viejo al esquema por destinatario. Idempotente.
    Devuelve el correo migrado, o None si no había nada que migrar."""
    if not RUTA_LEGACY.exists():
        return None
    try:
        snap = json.loads(RUTA_LEGACY.read_text(encoding="utf-8"))
    except Exception:
        return None
    email = _normalizar(snap.get("destinatario"))
    if not email or "@" not in email:
        # Sin destinatario no servía para alertas de todos modos.
        return None
    if not ruta_de(email).exists():
        try:
            guardar(snap)
        except Exception:
            return None
    try:
        RUTA_LEGACY.rename(RUTA_LEGACY.with_suffix(".json.migrado"))
    except OSError:
        pass
    return email


def listar() -> Iterator[dict[str, Any]]:
    """Todos los snapshots, migrando antes el archivo viejo si existe."""
    migrar_legacy()
    if not DIR_SNAPSHOTS.exists():
        return
    for p in sorted(DIR_SNAPSHOTS.glob("*.json")):
        try:
            snap = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(snap, dict) and _normalizar(snap.get("destinatario")):
            yield snap


def con_alerta_activa(tipo: str) -> tuple[list[dict[str, Any]], int]:
    """Snapshots con la alerta `tipo` encendida. Devuelve (lista, omitidos_por_tope)."""
    encontrados: list[dict[str, Any]] = []
    omitidos = 0
    for snap in listar():
        activas = snap.get("alertas_activas") or {}
        if not activas.get(tipo, False):
            continue
        if len(encontrados) >= MAX_POR_CORRIDA:
            omitidos += 1
            continue
        encontrados.append(snap)
    return encontrados, omitidos
