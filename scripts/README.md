# Scripts de mantenimiento

## `actualizar_universo.sh`

Refresca el universo de tickers (~1000) desde Yahoo Finance y lo regenera en formato lite que se commitea a git. Render lo usa al hacer redeploy.

### Cuándo correrlo

**Recomendado: cada 4-8 semanas.** Razones para correrlo:

- Los precios del CSV se vuelven viejos (la app usa esos como cache de "universo disponible", aunque el análisis individual sí baja en vivo de yfinance)
- Aparecen IPOs nuevas que quieres incluir
- Agregaste nuevos tickers manualmente a las listas dentro de `descargar_universo.py`
- Pasaron meses y los rankings por tamaño cambiaron

**NO necesitas correrlo si:**
- Solo cambiaste código de la app
- Solo cambiaste UI
- Solo agregaste posts al blog

### Cómo correrlo

Desde la raíz del proyecto:

```bash
# Sin push automático (solo regenera localmente)
./scripts/actualizar_universo.sh

# Con commit + push automático (deploya a producción)
./scripts/actualizar_universo.sh --push

# Si ya descargaste antes y solo quieres regenerar el lite
./scripts/actualizar_universo.sh --skip-full
```

### Qué hace paso por paso

1. **Pre-flight:** verifica que `yfinance` y `pandas` estén instalados.
2. **Descarga completa:** corre `python3 backend/descargar_universo.py` que baja:
   - S&P 500 + Russell 3000 + NASDAQ-100 (~3-9K acciones US)
   - BMV / IPC México (~150 emisoras)
   - 200+ criptomonedas
   - ETFs líderes (~120)
   - Blue chips internacionales (~400)
   - Total: 10,000+ tickers analizados, ~1000 pasan los filtros de calidad
   - **Tiempo:** 15-30 min según conexión
   - **Salida:** `backend/universo_precios.csv` (~130MB, gitignored)
3. **Regenerar lite:** corre `generar_universo_lite.py` que selecciona ~1000 mejores:
   - Todas las "recomendadas"
   - Todas las mexicanas (.MX)
   - Toda la cripto
   - ETFs líderes
   - Top USA acciones por precio (proxy de blue chip)
   - **Salida:** `backend/universo_lite_precios.csv` (~10-15MB, sí va a git)
4. **Commit + push** (si pasas `--push`): hace todo el flow de git automático.

### Setup la primera vez

```bash
# 1. Instalar dependencias localmente
cd backend
pip install yfinance pandas requests --break-system-packages

# 2. Asegurarte que el script es ejecutable
chmod +x ../scripts/actualizar_universo.sh

# 3. Correr la primera vez (sin push para revisar resultado)
cd ..
./scripts/actualizar_universo.sh
```

### Logs y errores comunes

- **"yfinance no instalado":** corre el pip install de arriba.
- **"universo_precios.csv no existe":** quita el flag `--skip-full` para hacer la descarga completa.
- **Yahoo rate-limits a la mitad:** el script tiene pausas entre chunks. Si aún así falla, espera 30 min y vuelve a correrlo (continúa donde quedó si los archivos parciales están).
- **Sin cambios al pushear:** significa que los datos no cambiaron desde la última corrida. No es error.

### Para automatizar (opcional)

Si quieres correrlo cada mes sin recordar:

**Opción A — cron de macOS:**

```bash
# Edita tu crontab
crontab -e

# Agrega esta línea (corre el día 1 de cada mes a las 4 AM)
0 4 1 * * cd ~/Desktop/portafolio-app && ./scripts/actualizar_universo.sh --push >> /tmp/universo-update.log 2>&1
```

**Opción B — recordatorio en Calendar:** crea un evento recurrente mensual "Actualizar universo Mi Portafolio" con notificación para que lo corras manualmente.
