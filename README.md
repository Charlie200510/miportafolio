# Mi Portafolio

App fintech para retail mexicano: análisis de portafolios de inversión, optimización Markowitz, ISR, dashboard 10-K, simulador Monte Carlo y asistente IA. **No es asesoría financiera.**

🌐 https://miportafolio.app · 📧 soporte@miportafolio.app

## Stack

- **Backend**: Flask + yfinance + scipy + Postgres (SQLite local en dev)
- **Frontend**: vanilla JS + Tailwind CDN + Chart.js (PWA instalable)
- **IA**: Anthropic Claude API
- **Pagos**: MercadoPago (Preapproval recurrente $79 MXN/mes)
- **Hosting**: Render (free tier para beta, Starter en producción)

## Desarrollo local

```bash
# Backend
cd backend
pip install -r requirements.txt
cp .env.example .env  # llenar con tus keys
python3 app.py        # corre en :5001

# Frontend
# se sirve automáticamente desde Flask
```

Abrir http://127.0.0.1:5001

## Deploy

Ver [DEPLOY.md](./DEPLOY.md) — dos rutas: beta gratis ($0/mes) o producción comercial ($14 USD/mes).

## Documentación interna

- [`briefing_proyecto.md`](./briefing_proyecto.md) — estado del proyecto, arquitectura, roadmap
- [`DEPLOY.md`](./DEPLOY.md) — guía de despliegue
- [`backend/db_schema.sql`](./backend/db_schema.sql) — schema Postgres v1

## Estructura

```
portafolio-app/
├─ backend/             Flask + módulos análisis
│  ├─ app.py           Punto de entrada (rutas)
│  ├─ analizador.py    Score 1-100 por acción
│  ├─ analisis.py      Markowitz portfolio
│  ├─ explorador.py    Universo + análisis multi-ticker
│  ├─ perfiles.py      10 perfiles preformados
│  ├─ dashboard_financiero.py  KPIs 5Y por empresa
│  ├─ backtest.py / stress_test.py
│  ├─ brokers_mx.py / declaracion_sat.py / aportaciones.py
│  ├─ impuestos.py / dividendos.py / metas.py
│  ├─ alertas.py       Email SMTP
│  ├─ asistente.py     Claude API
│  ├─ payments.py      MercadoPago
│  ├─ auth.py          Magic-link
│  ├─ db.py            Helper Postgres/SQLite
│  └─ db_schema.sql    Schema producción
├─ frontend/
│  ├─ index.html       App principal
│  ├─ landing.html     Marketing
│  ├─ signup.html      Registro
│  ├─ terminos.html    TyC
│  ├─ privacidad.html  Aviso de Privacidad
│  ├─ app.js           Toda la lógica frontend
│  ├─ logo.png         Brand
│  ├─ manifest.webmanifest  PWA
│  └─ sw.js            Service worker
├─ render.yaml         Blueprint deploy
├─ Procfile            Gunicorn command
├─ runtime.txt         Python 3.11
└─ start.command       Doubleclick para arrancar dev
```

## Licencia

Privado. © 2026 Mi Portafolio. Todos los derechos reservados.
