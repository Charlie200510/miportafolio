"""
db.py — Helper de conexión a Postgres.

En desarrollo: usa SQLite local como fallback (data/local.db).
En producción: usa DATABASE_URL del entorno (Render/Railway lo inyectan automático).

Uso:
    from db import conn, query, execute, fetchone

    with conn() as c:
        users = query(c, "SELECT * FROM users WHERE email = %s", ('a@b.com',))
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Optional

DATABASE_URL = os.environ.get("DATABASE_URL", "")
USING_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# Heroku/Render a veces dan postgres:// que psycopg3 no acepta directo
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)


@contextmanager
def conn():
    """Context manager para una conexión transaccional."""
    if USING_PG:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError:
            raise RuntimeError(
                "psycopg no instalado. Agrega `psycopg[binary]>=3.1` a requirements.txt"
            )
        c = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()
    else:
        # Fallback SQLite para dev local
        import sqlite3
        from pathlib import Path
        data_dir = Path(__file__).parent / "_data"
        data_dir.mkdir(exist_ok=True)
        c = sqlite3.connect(str(data_dir / "local.db"))
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()


def query(c, sql: str, params: tuple = ()) -> list[dict]:
    """Ejecuta SELECT y devuelve filas como list de dicts."""
    cur = c.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    if USING_PG:
        return [dict(r) for r in rows]
    # SQLite
    return [dict(r) for r in rows]


def fetchone(c, sql: str, params: tuple = ()) -> Optional[dict]:
    cur = c.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    return dict(row) if row else None


def execute(c, sql: str, params: tuple = ()) -> int:
    """Ejecuta INSERT/UPDATE/DELETE. Devuelve rowcount."""
    cur = c.cursor()
    cur.execute(sql, params)
    return cur.rowcount


def init_schema():
    """Crea las tablas si no existen. Lee db_schema.sql y lo ejecuta."""
    from pathlib import Path
    schema_path = Path(__file__).parent / "db_schema.sql"
    if not schema_path.exists():
        raise FileNotFoundError(schema_path)
    sql = schema_path.read_text(encoding="utf-8")
    with conn() as c:
        cur = c.cursor()
        if USING_PG:
            cur.execute(sql)
        else:
            # SQLite no soporta varias features (UUID, JSONB, INET, triggers PG)
            # → en dev usa SQLite, pero solo para tablas básicas; warning si hay errores
            for stmt in sql.split(";"):
                s = stmt.strip()
                if not s or s.startswith("--"):
                    continue
                try:
                    cur.execute(s)
                except Exception as e:
                    print(f"  warn (sqlite): {s[:80]}... → {e}")
    print("  schema inicializado.")


if __name__ == "__main__":
    print(f"DATABASE_URL configurada: {'sí (Postgres)' if USING_PG else 'no (fallback SQLite)'}")
    init_schema()
