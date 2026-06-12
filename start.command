#!/bin/bash
# Doble-click para arrancar portafolio-app en http://127.0.0.1:5001
cd "$(dirname "$0")/backend" || exit 1
echo "============================================================"
echo "  Portafolio App - arrancando servidor en :5001"
echo "  Ctrl+C para detener."
echo "============================================================"
# Matar cualquier instancia vieja en el puerto 5001
lsof -ti:5001 2>/dev/null | xargs -r kill -9 2>/dev/null
exec python3 app.py
