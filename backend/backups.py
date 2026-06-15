"""
backups.py — Backups en la nube del portafolio del usuario.

Permite al usuario hacer snapshots manuales o automáticos del estado completo
de su portafolio (tickers + pesos + transacciones + config alertas). Guardados
en la tabla `backups_nube` de Postgres con contraseña-free (identificado solo
por email).

Funcionalidades:
  - crear_backup(email, snapshot, nombre, automatico)
  - listar_backups(email, limit)
  - obtener_backup(backup_id, email)
  - eliminar_backup(backup_id, email)
  - limpiar_antiguos(email, max_manuales=10, max_automaticos=30)
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import db as _db


def crear_backup(email: str, snapshot: Dict[str, Any], nombre: Optional[str] = None,
                 automatico: bool = False) -> Dict[str, Any]:
    """Crea un backup nuevo. Devuelve {id, created_at, tamano_bytes}."""
    if not email or "@" not in email:
        raise ValueError("Email inválido")
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot debe ser un dict")
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, default=str)
    tamano = len(snapshot_json.encode("utf-8"))
    nombre = (nombre or "").strip()[:120] or None

    with _db.conn() as c:
        cur = c.cursor()
        if _db.USING_PG:
            cur.execute(
                """INSERT INTO backups_nube (user_email, nombre, snapshot, es_automatico, tamano_bytes)
                   VALUES (%s, %s, %s::jsonb, %s, %s)
                   RETURNING id, created_at, tamano_bytes""",
                (email.lower().strip(), nombre, snapshot_json, automatico, tamano),
            )
            row = cur.fetchone()
            return {"id": str(row["id"]), "created_at": row["created_at"].isoformat(),
                    "tamano_bytes": row["tamano_bytes"]}
        else:
            cur.execute(
                """INSERT INTO backups_nube (id, user_email, nombre, snapshot, es_automatico, tamano_bytes, created_at)
                   VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, datetime('now'))""",
                (email.lower().strip(), nombre, snapshot_json, automatico, tamano),
            )
            cur.execute("SELECT id, created_at, tamano_bytes FROM backups_nube WHERE rowid = last_insert_rowid()")
            row = cur.fetchone()
            return {"id": row["id"], "created_at": row["created_at"], "tamano_bytes": row["tamano_bytes"]}


def listar_backups(email: str, limit: int = 30) -> List[Dict[str, Any]]:
    """Lista metadata de backups (sin el contenido) ordenados por fecha desc."""
    if not email or "@" not in email:
        return []
    with _db.conn() as c:
        sql = """SELECT id, nombre, es_automatico, tamano_bytes, created_at
                 FROM backups_nube
                 WHERE user_email = {pl}
                 ORDER BY created_at DESC
                 LIMIT {pl}""".format(pl="%s" if _db.USING_PG else "?")
        rows = _db.query(c, sql, (email.lower().strip(), limit))
    return [
        {
            "id":             str(r["id"]),
            "nombre":         r.get("nombre"),
            "es_automatico":  bool(r.get("es_automatico")),
            "tamano_bytes":   r.get("tamano_bytes"),
            "created_at":     r["created_at"].isoformat() if hasattr(r["created_at"], "isoformat") else str(r["created_at"]),
        } for r in rows
    ]


def obtener_backup(backup_id: str, email: str) -> Optional[Dict[str, Any]]:
    """Devuelve el snapshot completo de un backup. Solo si pertenece al email."""
    if not backup_id or not email:
        return None
    with _db.conn() as c:
        sql = """SELECT id, nombre, snapshot, es_automatico, created_at
                 FROM backups_nube
                 WHERE id = {pl} AND user_email = {pl}""".format(pl="%s" if _db.USING_PG else "?")
        row = _db.fetchone(c, sql, (backup_id, email.lower().strip()))
    if not row:
        return None
    snap = row.get("snapshot")
    if isinstance(snap, str):
        try:
            snap = json.loads(snap)
        except Exception:
            snap = {}
    return {
        "id":            str(row["id"]),
        "nombre":        row.get("nombre"),
        "snapshot":      snap,
        "es_automatico": bool(row.get("es_automatico")),
        "created_at":    row["created_at"].isoformat() if hasattr(row["created_at"], "isoformat") else str(row["created_at"]),
    }


def eliminar_backup(backup_id: str, email: str) -> bool:
    """Elimina un backup. Solo si pertenece al email."""
    if not backup_id or not email:
        return False
    with _db.conn() as c:
        sql = "DELETE FROM backups_nube WHERE id = {pl} AND user_email = {pl}".format(
            pl="%s" if _db.USING_PG else "?")
        n = _db.execute(c, sql, (backup_id, email.lower().strip()))
    return n > 0


def limpiar_antiguos(email: str, max_manuales: int = 10, max_automaticos: int = 30) -> int:
    """Elimina backups viejos para mantener tamaño bajo control.
    Devuelve cuántos se eliminaron."""
    if not email:
        return 0
    eliminados = 0
    with _db.conn() as c:
        # Para cada tipo (manual/auto), conservar los N más recientes
        for es_auto, max_n in ((False, max_manuales), (True, max_automaticos)):
            sql_borrar = """DELETE FROM backups_nube
                            WHERE user_email = {pl}
                              AND es_automatico = {pl}
                              AND id NOT IN (
                                  SELECT id FROM backups_nube
                                  WHERE user_email = {pl} AND es_automatico = {pl}
                                  ORDER BY created_at DESC LIMIT {pl}
                              )""".format(pl="%s" if _db.USING_PG else "?")
            n = _db.execute(c, sql_borrar,
                            (email.lower().strip(), es_auto,
                             email.lower().strip(), es_auto, max_n))
            eliminados += n
    return eliminados
