# Deploy a producción — Mi Portafolio

Dos rutas según en qué fase estés.

---

# RUTA A — Beta gratuito (validación, $0/mes)

Si quieres lanzar para que 20-200 personas lo prueben gratis y validar product-market fit antes de invertir dinero, esto es lo que necesitas:

## 0a. Pre-requisitos (todo gratis)

- [ ] Cuenta GitHub con el repo pusheado
- [ ] Tarjeta de crédito **solo para verificar identidad en Render** (NO te cobran nada en plan free)
- [ ] Dominio (opcional — puedes usar el subdominio gratis `tu-app.onrender.com`)

## 1a. Render free tier (10 min)

1. Crea cuenta en https://render.com
2. **Connect repository** → selecciona el repo
3. Render detecta `render.yaml` y crea automáticamente:
   - **Web service** (plan free, $0)
   - **Postgres** (plan free, $0 por 90 días)
   - **4 cron jobs** (plan free)
4. En env vars, define los `sync: false`:
   - `ANTHROPIC_API_KEY` — del console.anthropic.com (vienes con $5 USD free credit)
   - `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
   - **MercadoPago déjalo vacío** — no vas a cobrar todavía
5. URL pública: `https://miportafolio.onrender.com` (o el subdominio que asigne Render)

## Limitaciones del free tier

- **El web service se duerme tras 15 min sin tráfico.** Primera carga después de dormir tarda ~30 segundos. Para beta es aceptable; si te molesta, hay opciones:
  - Setup UptimeRobot (gratis) que pinguea cada 5 min → mantiene despierto. Pero gastas las 750h gratis al mes más rápido.
  - Pasar a Render Starter: **$7 USD/mes** y nunca duerme.
- **Postgres free dura 90 días.** Después se borra. Antes de eso:
  - Exportar data con `pg_dump` y migrar a Supabase free (500MB)
  - O upgrader a Render Starter Postgres ($7 USD/mes)

## Con qué te quedas en beta gratis

- Web app accesible 24/7 (con ocasional cold start de 30s)
- Postgres con datos persistidos por 90 días
- Cron jobs corriendo (alertas semanales, refresh universo, etc.)
- Anthropic IA usable hasta agotar $5 USD de credit (aprox 1000 análisis IA)
- Total: **$0/mes**

## Cuándo migrar de beta a producción

Métricas para decidir invertir:
- ≥30 usuarios activos semanalmente, O
- ≥3 personas pidiéndote pagar el servicio, O
- Estás cerca de los 90 días del Postgres free

---

# RUTA B — Producción comercial ($14-30 USD/mes)

Cuando ya validaste y vas a cobrar:

## 0b. Pre-requisitos

- [ ] Beta validado con métricas reales
- [ ] Tarjeta de crédito (cargo recurrente $14 USD/mes en Render)
- [ ] Dominio comprado (Cloudflare, Namecheap, o Google Domains)
- [ ] Razón social constituida (SAS o SAPI) — necesaria para MercadoPago

---

## 1. Render — Backend + Postgres (15 min de setup activo)

1. Crear cuenta en https://render.com (gratis para registrarse)
2. **Connect repository** → selecciona el repo de GitHub
3. Render detecta `render.yaml` y propone crear los servicios automáticamente. Acepta.
4. Espera ~5 min mientras se aprovisiona la DB y el primer build corre.
5. En el dashboard, ve a `miportafolio-app` → **Environment** y rellena los valores `sync: false`:
   - `ANTHROPIC_API_KEY` — de console.anthropic.com
   - `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — credenciales del proveedor (Outlook/Gmail con app password)
   - `MERCADOPAGO_ACCESS_TOKEN` — del dashboard MP
   - `MERCADOPAGO_WEBHOOK_SECRET` — el que generes en MP
   - `SENTRY_DSN` (opcional) — de sentry.io
6. **Database setup**:
   - Una vez que la DB esté `available`, abre `psql` desde el panel
   - Pega el contenido de `backend/db_schema.sql`
   - O alternativamente: corre `python3 backend/db.py` (lo hace automáticamente leyendo el archivo)

## 2. Cloudflare — DNS + HTTPS (10 min)

1. En Cloudflare, agrega tu dominio
2. Cambia los nameservers en tu registrar al que te dé Cloudflare
3. Crea un CNAME:
   - **Name**: `@` (o subdominio)
   - **Target**: `tu-app.onrender.com` (lo da Render)
   - **Proxy**: activado (nube naranja)
4. SSL/TLS → modo **Full (strict)**
5. Espera 5-10 min para propagación
6. En Render: **Settings → Custom Domain** → agrega `miportafolio.app` → seguir instrucciones

## 3. MercadoPago producción (1-2 días, requiere SAS lista)

1. Verifica tu cuenta empresarial en MP (sube acta constitutiva, RFC, comprobante domicilio)
2. Activa **Suscripciones / Preapproval** desde Configuración
3. Genera **Access Token de producción** (no sandbox)
4. Configura webhook URL: `https://miportafolio.app/api/payments/webhook`
5. Genera el `MERCADOPAGO_WEBHOOK_SECRET` y guárdalo en Render env vars
6. Test: usa una tarjeta real con monto bajo, valida que el webhook llegue

## 4. Constitución legal (paralelo, 2-3 semanas)

1. Constituye **SAPI de C.V.** o **SAS** (Tally / MrEmpresa ~$8K MXN online)
2. Tramita RFC en SAT
3. Abre cuenta bancaria empresarial
4. Conecta a MercadoPago para depósitos

## 5. Cron jobs

Se aprovisionan automáticamente vía `render.yaml`:
- `refresca-universo` — día 1 de mes, 7am MX
- `alerta-resumen-semanal` — lunes 8am MX
- `alerta-drift` — lun-vie 9am MX
- `alerta-precios` — lun-vie 5pm MX

## 6. Observabilidad opcional

- **Sentry**: crea proyecto Python/Flask, copia DSN al env var `SENTRY_DSN`
- **UptimeRobot**: monitor del endpoint `/` cada 5 min, gratis hasta 50 monitores
- **Plausible**: $9 USD/mes; pega script en `<head>` de `index.html`

## 7. Costos mensuales

| Concepto | Costo |
|---|---|
| Render web ($7) + DB ($7) | $14 USD |
| Cron jobs | $0 (free first 750h) |
| Cloudflare | $0 |
| Anthropic Claude API | ~$5 USD |
| Sentry / UptimeRobot | $0 |
| Plausible (opcional) | $9 USD |
| **Total fijo** | **~$28 USD/mes** |

Con 10 suscriptores cubres costos. Con 50 hay margen.

## 8. Smoke tests post-deploy

- [ ] `/landing` carga
- [ ] `/api/perfiles` devuelve JSON
- [ ] `/api/universo` devuelve tickers
- [ ] Signup → email magic-link llega
- [ ] Pago real con $79 MXN → preapproval authorized
- [ ] Cron refresca-universo termina sin error
- [ ] Sentry recibe eventos de prueba

## 9. Rollback

1. Render → **Manual Deploy** → commit anterior → **Deploy**
2. BD corrupta: restore desde backup (Render mantiene 7 días)
3. MP falla: env var `MERCADOPAGO_ACCESS_TOKEN=''` deshabilita pagos temp
