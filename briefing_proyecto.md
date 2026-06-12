# Mi Portafolio — Estado del proyecto

App fintech para retail mexicano. **No es asesoría**, es herramienta de análisis. Suscripción $79 MXN/mes vía MercadoPago. Construida por Charlie (cbarreda@itam.mx).

## Stack
- **Backend**: Flask (port 5001) + yfinance + scipy + flask-cors. Lazy imports para módulos.
- **Frontend**: vanilla JS + Tailwind CDN + Chart.js + html2canvas. Tres archivos: `index.html`, `landing.html`, `signup.html`.
- **Storage**: localStorage (datos de usuario), `portafolio_snapshot.json` (para tareas programadas), `universo_precios.csv` + `universo_info.json` (~11K tickers).
- **Logo**: `/static/logo.png` (transparente). Brand verde `#22c55e`. Gold accent `#c9a96e` para dashboard financiero.

## Carpetas clave
- `~/Desktop/portafolio-app/backend/` — Flask app + módulos
- `~/Desktop/portafolio-app/frontend/` — index.html, landing.html, signup.html, app.js, logo.png
- `~/Desktop/portafolio-app/start.command` — doubleclick para arrancar dev server
- `.env` (no commitear) tiene ANTHROPIC_API_KEY, SMTP_*, MERCADOPAGO_*

## Módulos backend (lazy try/except en app.py)
| Módulo | Endpoint | Función |
|---|---|---|
| `analisis.py` | `/api/analizar`, `/api/resultados` | Markowitz portfolio (max Sharpe, frontera) |
| `analizador.py` | `/api/analizar/<ticker>` | Score 1-100 individual + Peer Comparison + Deep Dive (Claude) + Short Report |
| `dashboard_financiero.py` | `/api/dashboard/<ticker>` | KPIs (Revenue/NetIncome/FCF/EPS/ROE) + series 5Y |
| `explorador.py` | `/api/universo`, `/api/explorar` | Universo + análisis multi-ticker con score 0-100 de combinación |
| `perfiles.py` | `/api/perfiles` | 10 perfiles preformados con Markowitz multi-criterio (incluye Élite Quality + All-Weather Pro) |
| `backtest.py` | `/api/backtest` | Re-correr portafolio sobre periodos históricos |
| `stress_test.py` | `/api/stress-test` | Aplicar shocks de escenario |
| `brokers_mx.py` | `/api/brokers-mx` | Comparativa GBM/Kuspit/Hapi/Bursanet/Actinver/Vector/Schwab/IBKR |
| `declaracion_sat.py` | `/api/sat/declaracion-anual` | Reporte ISR anual MX (art. 129 LISR) |
| `aportaciones.py` | `/api/aportaciones/simular` | Simulador DCA |
| `impuestos.py` | `/api/impuestos/*` | ISR + tax-loss harvesting |
| `dividendos.py` | `/api/dividendos/*` | Calendario dividendos |
| `transacciones.py` | `/api/transacciones/*` | FIFO compra/venta |
| `metas.py` | `/api/metas/*` | Monte Carlo 3000 paths |
| `rebalanceo.py` | `/api/rebalanceo/*` | Sugerencias rebalanceo |
| `fundamentals.py` | `/api/fundamentals/*` | P/E, yield, market cap |
| `renta_fija_mx.py` | `/api/renta-fija/mx` | FIBRAS + CETES en vivo |
| `periodico.py` | `/api/periodico/*` | Noticias y cierres |
| `asistente.py` | `/api/asistente/*` | Claude API conversacional |
| `alertas.py` | `/api/alertas/*` | Drift / precio / semanal vía SMTP |
| `auth.py`, `payments.py` | `/api/auth/*`, `/api/payments/*` | Magic-link + MercadoPago Preapproval |
| `reporte_pdf.py` | `/api/reporte/pdf` | PDF mensual ReportLab |
| `sectores.py` | (helper) | Resolver sectores: nunca "Desconocido" |
| `descargar_universo.py` | (CLI) | Refresca universo_precios.csv (~11K tickers) |
| `enviar_alerta_programada.py` | (CLI) | Para tareas programadas — manda alertas |

## Frontend `app.js` (módulos IIFE)
Todos hacen `bind()` en DOMContentLoaded:
- `Picker` (multi-portafolio onboarding)
- `Explorador` (combinaciones), `Periodico`, `Rebalanceo`, `Transacciones`, `Impuestos`, `Metas`, `Asistente`
- `Fundamentales`, `RentaFija`, `Alertas`
- `Analizador` (individual + dashboard financiero)
- `Backtest`, `StressTest`, `Brokers`, `DeclaracionSat`, `Aportaciones`
- `PortfolioManager` (multi-portafolio, avatares letra+color)
- `CetesBench` (benchmark CETES)
- `TuMes`/`TuAno` alias (Wrapped mensual: 9 slides estilo Spotify, trading-card SVG por personalidad, html2canvas para compartir)

## Decisiones de producto importantes
- **Sin tarjeta para trial** ($79 es bajo para justificar fricción)
- **Wrapped mensual**: día 1 del mes auto-popup SOLO si el usuario lleva ≥30 días (`miPortafolio.firstUse.v1`). No hay botón manual.
- **Net Worth**: removido. Datos antiguos persisten en `localStorage['miPortafolio.netWorth.v1']`.
- **Multi-portafolio**: avatares letra+color (10 paletas), sin emojis. localStorage prefix `miPortafolio.{id}.{tickers|pesos|transacciones}.v1`.
- **Sectores**: `sectores.py.resolver_sector()` se aplica al cargar `universo_info.json` en `explorador.py`. Fallbacks por sufijo + ETF mapping. Nunca "Desconocido".
- **Iconos**: SVG Lucide en headers; emojis sólo en wrapped y trading cards (intencional).
- **Universo**: ~11,056 tickers (NASDAQ Trader full + S&P 500/400/600 + Russell 1000 + IPC + 190 cripto + 236 internacionales).

## Tabs en index.html (jerarquía visual)
**Primarios** (px-5 py-3.5, font-semibold): Mi portafolio · Analizar · Periódico
**Secundarios** (px-3 py-2.5, text-[11px], muted): Combinaciones · Rebalanceo · Transacciones e ISR · Metas · Asistente IA

Cada tab tiene `<main id="vista-XXX">`. `bindNav()` distingue `.nav-primary` vs `.nav-secondary` para colores correctos.

## Layout vista-portafolio (orden vertical)
1. Banner monedas mixtas (condicional)
2. Hero (título + retorno + 4 KPIs + CETES benchmark)
3. Insights
4. Benchmark vs índices
5. Portafolio óptimo (Markowitz)
6. Charts
7. Tabla de activos
8. Correlaciones + concentración
9. Backtest + Stress test
10. Alertas por email

## Tareas programadas
- `refrescar-universo-portafolios` — día 1 de mes 7am, corre `descargar_universo.py`
- `alerta-resumen-semanal` — lunes 8am
- `alerta-drift-diario` — Lun-Vie 9am (silencioso si no drift ≥5pp)
- `alerta-precios-diario` — Lun-Vie 5pm (silencioso si no mov ≥5%)

## Endpoints especiales
- `/`, `/landing`, `/signup` — HTMLs
- `/static/*` — frontend/*
- `/api/portafolio/snapshot` (POST) — debounce 1.5s en frontend, escribe `portafolio_snapshot.json` para tareas programadas

## Reinicio típico
```
lsof -ti:5001 | xargs kill -9 ; cd ~/Desktop/portafolio-app/backend && python3 app.py
```

---

# ROADMAP DE LANZAMIENTO

## Fase 0 — Estado actual (localhost dev)
App corre solo en Mac de Charlie. localStorage como storage. Single-user. No deployable como está.

## DECISIÓN ACTUAL: App Store directo (Capacitor wrapper)

Charlie cambió de estrategia: en lugar de PWA primero + iOS después, va **directo a App Store** vía Capacitor. Reutiliza ~90% del código JS/HTML existente, agrega features nativos mínimos para pasar Apple Review.

**Timeline estimado: ~14 semanas (3.5 meses)** desde Sprint 1.

### Sprints

| Sprint | Sem | Quién | Trabajo |
|---|---|---|---|
| 0 | 1 | Charlie | Apple Developer Program ($99/año) + decidir persona física vs SAS + Xcode instalado |
| 1 | 2-3 | Claude | Setup Capacitor sobre código actual, build proyecto Xcode, deploy backend a Render free |
| 2 | 4 | Claude | Refactor auth a JWT, CORS para capacitor://, Sign in with Apple plugin |
| 3 | 5-6 | Claude | Push notifications nativas, Face/Touch ID, share sheet, mobile responsive pass |
| 4 | 7-8 | Claude | StoreKit In-App Purchase ($79 MXN/mes), validación de receipts en backend |
| 5 | 9 | Claude | Privacy Manifest, app icon, splash screen, status bar config |
| 6 | 10 | Charlie | Screenshots App Store, descripción, ícono final, keywords ASO |
| 7 | 11-12 | Charlie + Claude | TestFlight beta interno (50 amigos), iterar feedback |
| 8 | 13-14 | Charlie | App Review (probable 1-2 rechazos + ajustes), aprobación |
| 9 | 15 | — | **Lanzamiento App Store** |

### Costos producción mínima

| Concepto | Costo |
|---|---|
| Apple Developer Program | $99 USD/año (~$1,700 MXN) |
| Render free backend | $0 (con cold start de 30s) |
| Anthropic API | ~$5 USD/mes |
| Apple Store cut (Small Business Program) | 15% de cada $79 MXN suscripción = $12 MXN |
| Constitución SAS (opcional, recomendado) | $8K MXN one-time |
| **Mínimo arranque** | **~$1,700 MXN único + $5 USD/mes** |

### Cambios técnicos clave para iOS

- **Auth**: JWT tokens en lugar de cookies (cookies no funcionan bien en WKWebView)
- **CORS**: agregar origin `capacitor://localhost` y `https://localhost` al Flask
- **Pagos**: StoreKit/IAP en iOS (NO MercadoPago — Apple lo prohibe in-app); web sigue con MP
- **Sign in with Apple**: requerido si hay otros métodos de login (magic-link cuenta)
- **Push notifications**: APNs vía capacitor-push-notifications (no web push)
- **Privacy Manifest** (`PrivacyInfo.xcprivacy`) declarando APIs sensibles usadas
- **Disclaimer financiero ULTRA visible** desde primer launch (Apple es estricta con apps fintech mexicanas)

### Estructura de directorios resultante

```
portafolio-app/
├─ backend/                 (sin cambios mayores; nueva ruta auth JWT)
├─ frontend/                (90% reutilizable; ajustes safe-area iOS)
├─ ios-app/                 NUEVO — proyecto Capacitor + Xcode
│  ├─ capacitor.config.ts
│  ├─ ios/                  Proyecto Xcode generado
│  ├─ www/                  Build estático del frontend (sync desde frontend/)
│  └─ package.json
├─ render.yaml              (backend)
├─ Procfile                 (backend)
└─ README.md
```

### Lo que NO hacemos en esta fase

- React Native rewrite (overkill para v1, agrega meses)
- Android (después de validar iOS y tener tracción)
- Web app pública (la PWA queda en pausa hasta tener tracción iOS)

---

## Fase 1 (descartada por ahora) — PWA primero

**1A: Beta gratis** (2-3 semanas, $0/mes) — para validar antes de invertir
**1B: Producción comercial** (5-6 semanas adicionales, ~$14 USD/mes + costos legales únicos) — para empezar a cobrar

### 1A — Beta gratis ($0)
- Render free tier: web service + Postgres + cron jobs (todo $0; web duerme tras 15 min, DB válida 90 días)
- Subdominio gratis `miportafolio.onrender.com` (no necesita dominio propio)
- Sin SAS, sin MercadoPago, sin TyC oficiales (con disclaimers básicos basta porque no se cobra)
- Anthropic Claude API usa los $5 USD free credit (~1000 análisis)
- 30-50 usuarios beta cerrados o invitación pública limitada

### 1B — Producción comercial (cuando valide PMF)

### Sem 1 — Constitución legal y dominio
- Constituir SAS o SAPI (~$8-15K MXN, vía notario o Tally/Mr. Empresa)
- Comprar dominio: `miportafolio.app` o equivalente (~$300 MXN/año en Cloudflare)
- Setup Cloudflare DNS + SSL
- Email profesional: `hola@`, `soporte@`, `legal@`

### Sem 2 — Migración multi-usuario
- Postgres en Render/Railway (free tier inicial)
- Migrar de JSON files a tablas:
  - `users` (id, email, created_at, plan, trial_end, mp_subscription_id)
  - `portafolios` (id, user_id, nombre, color, tickers JSON, pesos JSON, transacciones JSON)
  - `alertas_config` (user_id, drift_active, precio_active, semanal_active, destinatario)
  - `snapshots` (user_id, json_blob, updated_at) — reemplaza `portafolio_snapshot.json`
- Refactorizar endpoints para incluir `user_id` (validar sesión cookie)
- Mover localStorage data a backend al iniciar sesión

### Sem 3 — Deploy backend producción
- Render o Railway (Flask + Postgres + cron jobs nativos)
- Variables de entorno en secret manager (no .env en disco)
- Tareas programadas (refrescar-universo, alertas) → cron jobs del proveedor (no Claude Scheduled)
- Universo CSV: cargar a S3/R2 o disco persistente del proveedor

### Sem 4 — Pagos producción + legal
- MercadoPago Preapproval producción (requiere SAS lista)
- Términos y Condiciones (LFPDPPP-compliant)
- Aviso de Privacidad
- Aviso de cookies / consentimiento
- Disclaimer "NO es asesoría CNBV" prominente en footer y onboarding

### Sem 5 — Hardening y observabilidad
- Sentry (error tracking) — free tier
- Flask-Limiter (rate limiting per IP/user)
- Plausible / PostHog (analytics)
- UptimeRobot / BetterStack (uptime monitor)
- Status page público (status.miportafolio.app)
- Manejo seguro de errores (no exponer stack traces)
- CSRF tokens en formularios

### Sem 6 — UX y onboarding
- Mobile responsive pass (iPhone SE 375px → iPad)
- Empty states en todas las vistas
- Tutorial 3 pasos primer login
- Sample portfolio precargado (modo demo)
- 404 page + error pages
- OG images para social share
- Email de bienvenida + email "te quedan 3 días de trial"
- Cancelación 1-click (Profeco compliance)

### Sem 7-8 — Beta cerrado
- 20-50 usuarios (familia, ITAM, network)
- Captura feedback estructurado (form post-uso)
- Bugs críticos y fixes
- Testimonios para landing

### Sem 9 — Lanzamiento público
- Anuncio en redes (Twitter/Instagram/LinkedIn)
- ProductHunt si aplica
- Outreach a comunidades retail mexicanas (r/MexicoFinanciero, FB groups, Reforma Inversionista)

## Fase 2 — Lanzamiento iOS APP STORE (mes 4-9)

**Pre-requisitos:** ≥200 suscriptores activos en PWA validando product-market fit. Si no, no invertir en iOS aún.

### Mes 4-5 — Setup nativo
- Apple Developer Program ($99 USD/año)
- Bundle ID + provisioning profiles
- Capacitor wrap del frontend web (mantiene 90% del código JS/HTML actual)
- Migrar a directorio `mobile-app/` con Capacitor + Xcode project
- Mac con Xcode (ya lo tiene Charlie ✓), iPhone físico para tests

### Mes 5-6 — Features nativos mínimos para pasar review
- Push notifications nativas (no web push)
- Face ID / Touch ID para login
- Sign in with Apple (requerido si usas otros métodos de login)
- Share sheet nativa
- Pull-to-refresh nativo
- App icon + splash screen
- Privacy Manifest (privacy.xcprivacy)
- Privacy Nutrition Labels en App Store Connect

### Mes 6 — Reemplazar pagos por Apple IAP
- Subscriptions en App Store Connect ($79 MXN equivalente / mes)
- Apple toma 15% (Small Business Program — apps <$1M USD/año)
- Backend: validación de receipts vía StoreKit server API
- Mantener MercadoPago para usuarios web; IAP para usuarios iOS
- Cross-platform: usuario que pagó en web puede usar app iOS sin re-pagar (validar por user_id)

### Mes 6-7 — App Review
- Subir build a TestFlight, beta de 50-200 usuarios internos
- Iterar bugs reportados en TestFlight
- Submit a App Review (24-72h espera)
- Probable 1-2 rechazos → ajustar disclaimer financiero, copy, screenshots
- Especial atención: Apple es estricta con apps fintech mexicanas, asegurar que disclaimer "NO somos asesor CNBV" es muy visible

### Mes 7-8 — App Store Optimization
- Screenshots por dispositivo (iPhone 15, 14, SE, iPad)
- Video preview 30 segundos
- Keywords ASO (analizadas con Sensor Tower o AppFigures)
- Descripción optimizada
- Localización: español MX + inglés (audiencia bicultural)

### Mes 8-9 — Lanzamiento App Store
- Soft launch en MX primero
- Anuncio con preview en redes
- Email a subscriptores PWA invitándolos a descargar la app

## Costos estimados totales

| Concepto | Fase 1 (Web) | Fase 2 (iOS) |
|---|---|---|
| Constitución SAS | $8-15K MXN | — |
| Dominio + Cloudflare | $300 MXN/año | — |
| Hosting (Render Pro) | $20 USD/mes | $20 USD/mes |
| Postgres | incluido | incluido |
| Apple Developer | — | $99 USD/año |
| Sentry / monitoring | $0 (free tier) | $0 |
| Asesoría legal (TyC) | $3-5K MXN | — |
| Tu tiempo | 8-9 semanas | +4-6 semanas |
| **Total inicial** | **~$15-25K MXN + 2 meses** | **+$2K MXN + 2-3 meses** |

## Métricas para decidir avanzar a Fase 2
- ≥200 suscriptores activos pagando
- Churn mensual <8%
- NPS >40
- Demanda explícita de usuarios pidiendo app iOS
- Si después de 6 meses no se llega → no construir iOS, doblar en web

## Estado actual de la transición
- [ ] Constituir SAS
- [ ] Dominio + DNS
- [ ] Postgres + migración
- [ ] Deploy Render/Railway
- [ ] MP producción
- [ ] Términos legales
- [ ] Sentry + analytics
- [ ] Mobile responsive pass
- [ ] Onboarding + empty states
- [ ] Email automation
- [ ] Beta cerrado
- [ ] Launch web
- [ ] (Validar 200 users) → comenzar iOS
