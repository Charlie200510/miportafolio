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

# --- Re-exec desde una copia ------------------------------------------------
# Este script se actualiza a SÍ MISMO con el pull, y bash lee el archivo por
# offset mientras lo ejecuta: si el pull lo reemplaza a media corrida, bash
# sigue leyendo desde el byte donde iba y puede ejecutar basura. (Ya pasó: una
# corrida imprimió el texto de la versión anterior.) Nos copiamos a un temporal
# y corremos desde ahí, así el archivo que bash lee no cambia nunca.
# El repo se calcula ANTES y viaja por env, porque la copia en /tmp no podría
# deducirlo de su propia ruta.
if [[ -z "${MP_PULL_REPO:-}" ]]; then
  MP_PULL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export MP_PULL_REPO
fi

if [[ "${MP_PULL_REEXEC:-}" != "1" ]]; then
  export MP_PULL_REEXEC=1
  _copia="$(mktemp "${TMPDIR:-/tmp}/mp-pull.XXXXXX")"
  cat "${BASH_SOURCE[0]}" > "$_copia"
  trap 'rm -f "$_copia"' EXIT
  _rc=0
  bash "$_copia" "$@" || _rc=$?
  exit "$_rc"
fi

REPO="$MP_PULL_REPO"
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

# Última fecha con precios del universo lite. Se usa el python del venv porque
# es el único que tiene pandas. Devuelve vacío si algo falla: quien llama
# decide, esto nunca debe tumbar el deploy.
_fecha_universo() {
  local py="$REPO/.venv/bin/python"
  [[ -x "$py" ]] || py="$(command -v python3 || true)"
  [[ -x "$py" ]] || return 0
  "$py" - <<'PY' 2>/dev/null || true
import pandas as pd
try:
    df = pd.read_csv('backend/universo_lite_precios.csv', index_col=0, parse_dates=True)
    print(df.index.max().date())
except Exception:
    pass
PY
}
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
# Se descartan para que el fast-forward no aborte, PERO eso devuelve el CSV a la
# versión commiteada — que suele ir semanas atrás, porque el timer lo reescribe
# a diario mientras que el repo solo se refresca ~cada mes (workflow
# refrescar-universo). Antes eso dejaba producción sirviendo precios viejos
# hasta la corrida nocturna del timer; el paso 5b de abajo lo rehidrata.
datos_revertidos=0
# Respaldo de la versión FRESCA antes de descartarla. El paso 5b rehidrata
# después del pull, pero si esa descarga falla —Yahoo devolviendo poco fuera
# del horario del timer, por ejemplo— sin respaldo nos quedaríamos con el CSV
# commiteado, que suele ir semanas atrás. Es decir: el deploy dejaría
# producción PEOR de como la encontró. Con el respaldo, el peor caso es
# quedarse igual, que es lo que el paso 5b siempre dio por hecho.
RESPALDO_DATOS="$(mktemp -d "${TMPDIR:-/tmp}/mp-datos.XXXXXX")"
trap 'rm -rf "$RESPALDO_DATOS"' EXIT
fecha_respaldo="$(_fecha_universo)"   # frescura ANTES de tocar nada
paso "Descartando cambios locales de los archivos de datos"
for f in "${DATA_FILES[@]}"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || continue
  if ! git diff --quiet HEAD -- "$f"; then
    echo "  $f estaba modificado (corrida del timer) -> respaldo, descarto y rehidrato tras el pull"
    mkdir -p "$RESPALDO_DATOS/$(dirname "$f")"
    cp -p "$f" "$RESPALDO_DATOS/$f"
    git checkout -- "$f"
    datos_revertidos=1
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

# --- 5a. Purgar cachés DERIVADOS -------------------------------------------
# backend/_cache_topmovers sobrevive reinicios a propósito (TTL 30 min). Tras un
# deploy seguía sirviendo payloads calculados por el código ANTERIOR: el arreglo
# de top-movers parecía no haber subido porque la respuesta cacheada aún traía
# el ranking viejo. Son datos derivados y se regeneran en la primera petición.
# Se purga por GLOB, no por lista: enumerarlos a mano ya falló una vez —
# _cache_portafolio_optimo no estaba en la lista y siguió sirviendo la
# diversificación calculada con la fórmula vieja después de desplegar el
# arreglo. Cualquier caché nuevo queda cubierto sin tocar este script.
# OJO: el patrón es backend/_cache_* a propósito; backend/_datos/ (cuentas,
# trials, tombstones) NO coincide y jamás debe tocarse.
#
# Ahí vive también accion_del_dia_historial.json, que NO es un caché: es la
# memoria de qué emisoras ya salieron, y es lo que hace rotar la Acción del Día.
# Vivía dentro de _cache_accion_dia y este purgado la borraba en cada deploy,
# así que la sección se quedaba clavada en la misma acción. No la muevas de
# _datos/ ni la incluyas en el patrón de purga.
paso "Purgando cachés derivados"
shopt -s nullglob
for d in backend/_cache_*; do
  [[ -d "$d" ]] || continue
  n="$(find "$d" -type f | wc -l | tr -d ' ')"
  find "$d" -type f -delete 2>/dev/null || true
  echo "  $d -> $n archivo(s) borrados"
done
shopt -u nullglob

# --- 5b. Rehidratar el universo si el checkout lo dejó viejo ----------------
# El paso 2 devolvió los DATA_FILES a la versión commiteada. Si eso los hizo
# retroceder, se refresca AHORA en vez de esperar a la corrida nocturna del
# timer. actualizar_lite_diario.py es seguro por diseño: si la descarga falla o
# viene vacía, NO sobrescribe, así que en el peor caso nos quedamos como
# estábamos. El servicio hace su propio restart de gunicorn al terminar.
# La condición es la FRESCURA del dato, no si descartamos algo: si un deploy
# anterior ya lo revirtió, en la corrida siguiente no hay modificación local que
# descartar y aun así el CSV sigue viejo. Así también se cura un clon nuevo.
fecha_antes="$(_fecha_universo)"
hoy="$(date +%F)"
if [[ -n "$fecha_antes" && "$fecha_antes" == "$hoy" ]]; then
  echo "  universo ya al día ($fecha_antes) — nada que rehidratar"
elif [[ "$datos_revertidos" == "1" || -n "$fecha_antes" ]]; then
  paso "Rehidratando el universo (el CSV está en ${fecha_antes:-fecha desconocida}, hoy es $hoy)"
  if sudo systemctl start miportafolio-universo.service; then
    for i in $(seq 1 90); do
      sleep 2
      [[ "$(systemctl is-active miportafolio-universo.service)" != "active" ]] && break
    done
    fecha_despues="$(_fecha_universo)"
    if [[ -n "$fecha_despues" && "$fecha_despues" != "$fecha_antes" ]]; then
      verde "  universo al día: ${fecha_antes:-?} -> ${fecha_despues}"
    else
      rojo "  AVISO: el refresco no adelantó la fecha (quedó en ${fecha_despues:-?})."
      rojo "  No es fatal —el timer reintenta esta noche— pero revísalo:"
      rojo "    sudo journalctl -u miportafolio-universo.service -n 30 --no-pager"
    fi
  else
    rojo "  AVISO: no se pudo lanzar miportafolio-universo.service; el timer lo hará de noche."
  fi

  # Si tras todo esto el CSV sigue más viejo que el que había al empezar, se
  # devuelve el respaldo: es dato REAL que ya estaba sirviéndose, y perderlo
  # por un deploy es peor que no haber desplegado.
  fecha_final="$(_fecha_universo)"
  for f in "${DATA_FILES[@]}"; do
    [[ -f "$RESPALDO_DATOS/$f" ]] || continue
    if [[ -z "$fecha_final" || "$fecha_final" < "$fecha_respaldo" ]]; then
      cp -p "$RESPALDO_DATOS/$f" "$f"
      restaurado=1
    fi
  done
  if [[ "${restaurado:-0}" == "1" ]]; then
    rojo "  Restauro los datos que había antes del deploy (${fecha_respaldo}): la"
    rojo "  rehidratación no los superó y el CSV commiteado es más viejo."
    sudo systemctl restart miportafolio >/dev/null 2>&1 || true
  fi
else
  echo "  (los archivos de datos no retrocedieron: nada que rehidratar)"
fi

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

# El CÓDIGO en disco debe corresponder al commit desplegado: si el worktree
# quedó a medias, esto lo caza.
#
# Los DATA_FILES quedan FUERA de la comprobación a propósito: el paso 5b acaba
# de reescribirlos con los precios de hoy, así que por diseño difieren de HEAD
# justo después del deploy. (Aun sin el paso 5b diferirían en cuanto corriera el
# timer esa noche.) Incluirlos hacía fallar un deploy que en realidad salió bien.
_rutas_codigo=()
while IFS= read -r r; do _rutas_codigo+=(":(exclude)$r"); done < <(printf '%s\n' "${DATA_FILES[@]}")
if ! git diff --quiet HEAD -- frontend backend "${_rutas_codigo[@]}"; then
  rojo "ADVERTENCIA: frontend/ o backend/ difieren de HEAD justo después del deploy:"
  git status --porcelain --untracked-files=no -- frontend backend "${_rutas_codigo[@]}"
  fallo "el árbol no corresponde al commit desplegado."
fi

paso "Deploy OK"
echo "  commit:   $(git rev-parse --short HEAD) $(git log -1 --pretty=%s | cut -c1-70)"
echo "  servicio: $(systemctl is-active "$SERVICIO")"
echo "  salud:    ok"
echo
echo "Recuerda verificar desde fuera (no solo aquí):"
echo "  curl -s https://miportafolio.uk/api/health"
