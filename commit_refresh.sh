#!/bin/bash
# Generado por scheduled task — 2026-06-14
# El commit ya está hecho localmente. Solo falta hacer push a GitHub.
# Ejecutar desde Terminal: bash ~/Desktop/portafolio-app/commit_refresh.sh

set -e
cd ~/Desktop/portafolio-app

echo "Pusheando commit: $(git log --oneline -1)"
git push

echo ""
echo "✅ Deploy iniciado en Render. Disponible en ~3 min: https://miportafolio.uk"
