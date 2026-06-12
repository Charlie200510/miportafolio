#!/bin/bash
# ============================================================
#  Mi Portafolio — setup git para deploy en Render (gratis)
#  Doble click para inicializar el repo y prepararlo
# ============================================================

cd "$(dirname "$0")"

echo ""
echo "================================================================"
echo "  Mi Portafolio — Setup git + GitHub"
echo "================================================================"
echo ""

# Verificar git instalado
if ! command -v git >/dev/null 2>&1; then
  echo "× Git no está instalado. Instala con: xcode-select --install"
  read -p "Presiona ENTER para salir..."
  exit 1
fi

# Verificar que .env NO se va a subir
if [ -f backend/.env ] && ! git check-ignore -q backend/.env 2>/dev/null; then
  if [ -d .git ]; then
    echo "⚠ .env detectado, verificando .gitignore..."
  fi
fi

# Inicializar repo si no existe
if [ ! -d .git ]; then
  echo "→ Inicializando repositorio git..."
  git init -b main
  git config user.email "cbarreda@itam.mx"
  git config user.name "Charlie Barreda"
fi

# Verificar que .env está bien ignorado
git add .gitignore
git rm --cached backend/.env 2>/dev/null  # por si ya estaba trackeado

# Add y commit
echo ""
echo "→ Agregando archivos..."
git add .

# Confirmar que .env NO se va a commitear
if git status --short | grep -q "\.env$"; then
  echo "× ERROR: .env aparece en el staging. Aborto para evitar leak de credenciales."
  read -p "Presiona ENTER para salir..."
  exit 1
fi

echo ""
echo "→ Haciendo commit inicial..."
git commit -m "Initial commit — Mi Portafolio v1.0 lista para deploy"

echo ""
echo "================================================================"
echo "  ✓ Repo local listo. Próximo paso:"
echo "================================================================"
echo ""
echo "  1. Ve a https://github.com/new"
echo "     - Nombre: miportafolio (o el que quieras)"
echo "     - Descripción: 'Análisis de portafolios para retail mexicano'"
echo "     - Privacy: Public o Private (a tu gusto)"
echo "     - NO marques 'Add README' ni '.gitignore' (ya tienes)"
echo "     - Click 'Create repository'"
echo ""
echo "  2. GitHub te muestra los comandos. COPIA solo estos dos:"
echo ""
echo "     git remote add origin https://github.com/TU_USUARIO/miportafolio.git"
echo "     git push -u origin main"
echo ""
echo "  3. Pégalos aquí abajo. Te pedirá tus credenciales de GitHub."
echo "     (usa Personal Access Token si te pide password, NO tu password normal)"
echo ""
echo "  4. Después: ve a https://render.com → New + → Blueprint → conecta el repo"
echo ""

read -p "Presiona ENTER cuando termines..."
