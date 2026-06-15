#!/usr/bin/env bash
# ============================================================
#  actualizar_universo.sh — Actualiza el universo de tickers
#  desde Yahoo Finance, regenera la versión lite y opcionalmente
#  hace commit + push a GitHub para que Render redeploye.
#
#  Uso:
#    ./scripts/actualizar_universo.sh           # solo regenera, no pushea
#    ./scripts/actualizar_universo.sh --push    # regenera y pushea
#    ./scripts/actualizar_universo.sh --skip-full   # usa el CSV ya descargado
#
#  Tiempo total esperado:
#    Descarga completa: ~15-30 min (1000+ tickers × 10 años)
#    Solo regenerar lite: ~30 seg (si ya está el CSV completo)
#
#  Recomendación de frecuencia: cada 4-8 semanas.
# ============================================================
set -e  # exit on error

# Color helpers
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'  # No Color

print_step() {
  echo ""
  echo -e "${CYAN}┌──────────────────────────────────────────────┐${NC}"
  echo -e "${CYAN}│${NC} $1"
  echo -e "${CYAN}└──────────────────────────────────────────────┘${NC}"
}

# Detectar la raíz del proyecto (asume que este script vive en scripts/)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
BACKEND_DIR="$PROJECT_ROOT/backend"

# Flags
DO_PUSH=false
SKIP_FULL=false
for arg in "$@"; do
  case $arg in
    --push) DO_PUSH=true ;;
    --skip-full) SKIP_FULL=true ;;
    -h|--help)
      echo "Uso: $0 [--push] [--skip-full]"
      echo "  --push       commit + git push al terminar (deploya Render)"
      echo "  --skip-full  no descarga, solo regenera el lite del CSV existente"
      exit 0
      ;;
  esac
done

print_step "Pre-flight: verificar dependencias"
cd "$BACKEND_DIR"
if ! python3 -c "import yfinance" 2>/dev/null; then
  echo -e "${RED}✗ yfinance no instalado. Corre:${NC}"
  echo "    pip install yfinance pandas requests --break-system-packages"
  exit 1
fi
echo -e "${GREEN}✓ Python + dependencias OK${NC}"

# Mostrar tamaños actuales
print_step "Estado actual"
if [ -f universo_lite_precios.csv ]; then
  csv_size=$(du -h universo_lite_precios.csv | cut -f1)
  fecha_csv=$(stat -f "%Sm" -t "%Y-%m-%d" universo_lite_precios.csv 2>/dev/null || stat -c "%y" universo_lite_precios.csv | cut -d' ' -f1)
  echo "  universo_lite_precios.csv: $csv_size (última modificación: $fecha_csv)"
fi
if [ -f universo_lite_info.json ]; then
  json_size=$(du -h universo_lite_info.json | cut -f1)
  echo "  universo_lite_info.json: $json_size"
fi

# Paso 1: descargar el universo completo (a menos que --skip-full)
if [ "$SKIP_FULL" = "false" ]; then
  print_step "Paso 1/2: Descargar universo completo desde Yahoo Finance"
  echo -e "${YELLOW}⏱  Esto tarda 15-30 min. Verás progreso en pantalla.${NC}"
  echo ""
  python3 descargar_universo.py
  echo ""
  echo -e "${GREEN}✓ Universo completo descargado${NC}"
else
  print_step "Paso 1/2: SKIP descarga (--skip-full activo)"
  if [ ! -f universo_precios.csv ]; then
    echo -e "${RED}✗ universo_precios.csv no existe. Corre sin --skip-full la primera vez.${NC}"
    exit 1
  fi
  echo "  Usando universo_precios.csv ya existente"
fi

# Paso 2: generar versión lite (la que va a git/Render)
print_step "Paso 2/2: Regenerar versión lite para commit"
python3 generar_universo_lite.py
echo -e "${GREEN}✓ universo_lite regenerado${NC}"

# Mostrar nuevos tamaños
print_step "Resultados"
csv_size=$(du -h universo_lite_precios.csv | cut -f1)
json_size=$(du -h universo_lite_info.json | cut -f1)
n_tickers=$(python3 -c "import pandas as pd; print(len(pd.read_csv('universo_lite_precios.csv', index_col=0, parse_dates=True, nrows=1).columns))")
n_dias=$(python3 -c "import pandas as pd; print(len(pd.read_csv('universo_lite_precios.csv', index_col=0, parse_dates=True)))")
echo "  Tickers: $n_tickers"
echo "  Días de historia: $n_dias"
echo "  CSV: $csv_size"
echo "  JSON: $json_size"

# Paso 3 opcional: commit + push
if [ "$DO_PUSH" = "true" ]; then
  print_step "Paso 3: Commit y push a GitHub"
  cd "$PROJECT_ROOT"

  # Limpiar locks que el sandbox a veces deja
  rm -f .git/HEAD.lock .git/index.lock 2>/dev/null || true

  if git diff --quiet -- backend/universo_lite_precios.csv backend/universo_lite_info.json; then
    echo -e "${YELLOW}⚠ Sin cambios en universo_lite — nada que commitear.${NC}"
  else
    git add backend/universo_lite_precios.csv backend/universo_lite_info.json
    fecha=$(date +%Y-%m-%d)
    git commit -m "chore: refresh universo lite — $fecha

Actualización mensual del universo de tickers desde Yahoo Finance.
Tickers: $n_tickers · Días: $n_dias · CSV: $csv_size"
    echo -e "${GREEN}✓ Commit creado${NC}"

    echo -e "${CYAN}Pusheando a GitHub...${NC}"
    git push origin main
    echo -e "${GREEN}✓ Push completado — Render redeployará automáticamente en ~2 min${NC}"
  fi
else
  print_step "Hecho (sin push)"
  echo "  Para deployar los cambios a producción, corre:"
  echo -e "  ${CYAN}cd $PROJECT_ROOT${NC}"
  echo -e "  ${CYAN}git add backend/universo_lite_precios.csv backend/universo_lite_info.json${NC}"
  echo -e "  ${CYAN}git commit -m 'chore: refresh universo'${NC}"
  echo -e "  ${CYAN}git push origin main${NC}"
  echo ""
  echo "  O vuelve a correr con --push para hacerlo automáticamente."
fi

echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  ✓ ACTUALIZACIÓN COMPLETADA                   │${NC}"
echo -e "${GREEN}└──────────────────────────────────────────────┘${NC}"
