#!/usr/bin/env bash
#
# Deploy idempotente en la VM de Oracle (miportafolio.uk).
#
#   bash ~/portafolio-app/deploy/pull.sh
#
# Hace: saneamiento de los archivos de datos -> fetch -> fast-forward ->
# restart del servicio -> verificación. Falla ruidosamente y con exit != 0 si
# algo no queda como debe; nunca deja el servicio a medias en silencio.
#
# POR QUÉ EXISTE
# --------------
# El timer systemd `miportafolio-universo.timer` reescribe a diario, in-place:
#     backend/universo_lite_precios.csv
#     backend/universo_lite_info.json
# Esos dos archivos SÍ están trackeados, así que cualquier commit que los toque
# (el workflow mensual `refrescar-universo` los commitea) choca con la copia
# local y `git pull` aborta.
#
# Peor: en algún momento se les puso el bit `skip-worktree` para que el timer
# dejara de ensuciar `git status`. Efecto real: `git status` los reporta
# limpios, `git diff` sale vacío y `git checkout -- <archivo>` / `git restore`
# son NO-OPS SILENCIOSOS sobre ellos... pero `git pull` sigue abortando con
#     "error: Your local changes to the following files would be overwritten"
# El fetch entra (origin/main avanza) y el fast-forward no, así que el servidor
# se queda clavado en un commit viejo sirviendo código antiguo, sin ninguna
# señal evidente. Fue exactamente lo que pasó entre 2026-07-17 y 2026-07-30.
#
# Por eso este script LIMPIA el bit skip-worktree antes de descartar. No lo
# vuelvas a poner: rompe todos los pulls futuros que toquen esos archivos.
#
# NUNCA toca backend/_datos/ (cuentas, trials, tombstones; gitignored y sin
# respaldo). Tampoco lee deploy/.env: ese archivo tiene valores sin comillas
# (RESEND_FROM) que revientan al hacer `source`.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICIO="miportafolio"
RAMA="main"
SALUD="http://127.0.0.1:8000/api/health"

# Archivos de datos que el timer muta y que se pueden descartar sin pérdida:
# el timer los regenera esa misma noche con los precios del día.
DATA_FILES=(
  "backend/universo_lite_precios.csv"
  "backend/universo_lite_info.json"
)

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

fallo() { rojo "FALLO: $*"; exit 1; }
trap 'rojo "FALLO en la línea $LINENO. El deploy quedó INCOMPLETO — revísalo."' ERR

cd "$REPO"
paso "Repo: $REPO"

# --- 0. Sanidad -------------------------------------------------------------
[[ -d .git ]] || fallo "$REPO no es un repo git."

# _datos jamás debe estar trackeado. Si lo estuviera, un checkout podría
# sobrescribir cuentas de usuarios reales.
if git ls-files --error-unmatch backend/_datos >/dev/null 2>&1; then
  fallo "backend/_datos/ está TRACKEADO en git. Aborto: un pull podría sobrescribir las cuentas. Sácalo del índice antes de continuar."
fi

rama_actual="$(git rev-parse --abbrev-ref HEAD)"
[[ "$rama_actual" == "$RAMA" ]] || fallo "estás en '$rama_actual', no en '$RAMA'."

if [[ -f .git/index.lock ]]; then
  fallo ".git/index.lock existe. Si no hay ningún git corriendo (ps aux | grep git), bórralo a mano y reintenta."
fi

# --- 1. Quitar skip-worktree de los archivos de datos -----------------------
paso "Saneando el índice de los archivos de datos"
for f in "${DATA_FILES[@]}"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || { echo "  (omitido, no trackeado: $f)"; continue; }
  flag="$(git ls-files -v "$f" | cut -c1)"
  if [[ "$flag" != "H" ]]; then
    echo "  $f tenía la bandera '$flag' -> la quito"
    git update-index --no-skip-worktree "$f"
    git update-index --no-assume-unchanged "$f" 2>/dev/null || true
  else
    echo "  $f OK (H)"
  fi
done

# --- 2. Descartar SOLO los archivos de datos --------------------------------
paso "Descartando cambios locales de los archivos de datos"
for f in "${DATA_FILES[@]}"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || continue
  if ! git diff --quiet HEAD -- "$f"; then
    echo "  $f estaba modificado (corrida del timer) -> descarto; el timer lo regenera hoy en la noche"
    git checkout -- "$f"
  else
    echo "  $f sin cambios"
  fi
done

# --- 3. Cualquier OTRA modificación local se respeta y aborta ---------------
# No descartamos trabajo que no sea de los archivos de datos: si alguien editó
# algo en el servidor, hay que verlo antes de perderlo.
otros="$(git status --porcelain --untracked-files=no)"
if [[ -n "$otros" ]]; then
  rojo "Hay cambios locales que NO son de los archivos de datos:"
  echo "$otros"
  fallo "revísalos y decide a mano (commit, stash o checkout). No los descarto por ti."
fi
verde "Árbol limpio."

# --- 4. Fetch + fast-forward ------------------------------------------------
paso "Trayendo origin/$RAMA"
git fetch --prune origin "$RAMA"

antes="$(git rev-parse HEAD)"
objetivo="$(git rev-parse "origin/$RAMA")"

if [[ "$antes" == "$objetivo" ]]; then
  echo "  Ya estabas en $(git rev-parse --short HEAD) — nada que traer."
else
  echo "  $(git rev-parse --short "$antes") -> $(git rev-parse --short "$objetivo")"
  git merge --ff-only "origin/$RAMA"
fi

# --- 5. Verificar que el checkout quedó donde debe --------------------------
ahora="$(git rev-parse HEAD)"
[[ "$ahora" == "$objetivo" ]] || fallo "HEAD ($ahora) != origin/$RAMA ($objetivo) después del merge."
verde "HEAD = origin/$RAMA = $(git rev-parse --short HEAD)"

# --- 6. Restart ------------------------------------------------------------
paso "Reiniciando $SERVICIO"
sudo systemctl restart "$SERVICIO"

for i in $(seq 1 15); do
  sleep 1
  estado="$(systemctl is-active "$SERVICIO" || true)"
  [[ "$estado" == "active" ]] && break
done
[[ "$estado" == "active" ]] || {
  rojo "El servicio quedó en estado '$estado'. Últimas líneas del log:"
  sudo journalctl -u "$SERVICIO" -n 30 --no-pager || true
  fallo "$SERVICIO no está active."
}
verde "$SERVICIO active (running)."

# --- 7. Verificación funcional ---------------------------------------------
# systemd reporta "active" en cuanto forkea, pero gunicorn tarda ~20s en hacer
# bind (importa el stack de datos y encola el warmup). La comprobación real es
# HTTP, con presupuesto de sobra: quedarse corto aquí da falsas alarmas de
# deploy roto cuando en realidad solo faltaba esperar.
paso "Verificando que la app responde (puede tardar ~20-30s en escuchar)"
salud=""
for i in $(seq 1 40); do
  salud="$(curl -fsS -m 10 "$SALUD" 2>/dev/null || true)"
  if [[ "$salud" == *'"ok"'* ]]; then
    echo "  respondió al intento $i (~$((i * 2))s)"
    break
  fi
  sleep 2
done
[[ "$salud" == *'"ok"'* ]] || {
  rojo "Respuesta de $SALUD: ${salud:-<vacía>}"
  sudo journalctl -u "$SERVICIO" -n 30 --no-pager || true
  fallo "/api/health no responde ok."
}
verde "/api/health -> ok"

# El código en disco debe corresponder al commit desplegado: si el worktree
# quedó a medias, esto lo caza.
if ! git diff --quiet HEAD -- frontend backend; then
  rojo "ADVERTENCIA: frontend/ o backend/ difieren de HEAD justo después del deploy:"
  git status --porcelain --untracked-files=no -- frontend backend
  fallo "el árbol no corresponde al commit desplegado."
fi

paso "Deploy OK"
echo "  commit:   $(git rev-parse --short HEAD) $(git log -1 --pretty=%s | cut -c1-70)"
echo "  servicio: $(systemctl is-active "$SERVICIO")"
echo "  salud:    ok"
echo
echo "Recuerda verificar desde fuera (no solo aquí):"
echo "  curl -s https://miportafolio.uk/api/health"
