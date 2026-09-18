#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Siembra el registro de trials con las cuentas que ya existen.

    python3 deploy/sembrar_trials.py            # en seco: solo dice qué haría
    python3 deploy/sembrar_trials.py --aplicar   # escribe, con respaldo previo

POR QUÉ EXISTE
--------------
El registro de trials (auth.py, `data["trials"]`) impide que borrar la cuenta y
volver a registrarse estrene otros 14 días: la cuenta nueva hereda la fecha de
alta de la vieja. Pero solo sabe de las altas que ocurrieron DESPUÉS de que
existiera el registro.

Sin sembrarlo, todas las cuentas anteriores tienen una pasada gratis: borran,
se re-registran con el mismo correo, y como el registro está vacío estrenan
trial. Esto apunta la fecha de alta de cada cuenta viva para que eso no pase.

Es idempotente: se puede correr varias veces. Nunca adelanta una fecha ya
guardada, así que volver a correrlo no regala trials.

SOBRE EL RESPALDO
-----------------
backend/_datos/ está en .gitignore y NO tiene respaldo automático: si este
archivo se corrompe se pierden todas las cuentas. Por eso se copia antes de
escribir, y la copia se queda al lado con la fecha en el nombre.
"""
import json
import pathlib
import shutil
import sys
import time

RAIZ = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "backend"))

STORE = RAIZ / "backend" / "_datos" / "sesiones.json"


def main() -> int:
    aplicar = "--aplicar" in sys.argv

    if not STORE.exists():
        print(f"No existe {STORE}. ¿Es la máquina correcta?")
        return 1

    import auth  # después de ajustar sys.path

    data = json.loads(STORE.read_text(encoding="utf-8"))
    usuarios = data.get("usuarios") or {}
    previos = dict(data.get("trials") or {})

    print(f"  {len(usuarios)} cuentas · {len(previos)} entradas ya en el registro\n")

    nuevas, ya_estaban, filas = 0, 0, []
    for email, u in sorted(usuarios.items()):
        creado = u.get("creado_en")
        if not isinstance(creado, (int, float)) or creado <= 0:
            filas.append((email, "sin fecha de alta: se omite", None))
            continue
        ejes = auth._ejes_de(email=email, telefono=u.get("telefono"))
        antes = auth._trial_previo(data, ejes)
        auth._apuntar_trial(data, ejes, float(creado))
        dias = (time.time() - float(creado)) / 86400
        estado = "premium" if u.get("plan") == "premium" else (
            f"trial vencido ({dias:.0f}d)" if dias > 14 else f"en trial ({14 - int(dias)}d)")
        if antes is None:
            nuevas += 1
            filas.append((email, estado, "apuntado"))
        else:
            ya_estaban += 1
            filas.append((email, estado, "ya estaba"))

    for email, estado, marca in filas:
        # Se muestra el correo recortado: este script se corre en una terminal
        # compartida y el listado completo de clientes no tiene por qué quedar
        # en el historial.
        usuario, _, dominio = email.rpartition("@")
        visible = (usuario[:3] + "…@" + dominio) if len(usuario) > 3 else email
        print(f"   {visible:34} {estado:24} {marca or ''}")

    print(f"\n  {nuevas} por apuntar · {ya_estaban} ya estaban")

    if not aplicar:
        print("\n  EN SECO: no se escribió nada. Para aplicarlo:")
        print("    python3 deploy/sembrar_trials.py --aplicar")
        return 0

    if nuevas == 0:
        print("\n  Nada que escribir.")
        return 0

    respaldo = STORE.with_name(f"sesiones.{time.strftime('%Y%m%d-%H%M%S')}.bak.json")
    shutil.copy2(STORE, respaldo)
    tmp = STORE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STORE)
    print(f"\n  Escrito. Respaldo en {respaldo.name}")
    print(f"  Si algo sale mal: cp {respaldo.name} sesiones.json (mismo directorio)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
