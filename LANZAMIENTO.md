# 🚀 LANZAMIENTO — Mi Portafolio (App Store + RevenueCat)

Todo lo que **debes hacer TÚ a mano** para lanzar. Ordenado por dependencias.
Lo que ya quedó hecho en el código está al final ("Ya hecho por Claude").

> Convenciones
> - 🔴 **BLOQUEANTE** = sin esto Apple rechaza o la monetización no funciona.
> - 🟡 = importante, hazlo antes de crecer.
> - Product IDs: `com.miportafolio.mensual`, `com.miportafolio.anual`, `com.miportafolio.lifetime`
> - Entitlement: **`Mi Portafolio`** (el que ya existe en RevenueCat y en el servidor)  ·  Bundle ID: **`app.miportafolio`**  ·  Dominio: **miportafolio.uk**

---

## 0) Orden recomendado (mapa)

1. App Store Connect → contrato Paid Apps + 3 productos IAP.
2. RevenueCat → app iOS + API keys + shared secret + entitlement `Mi Portafolio` + offering.
3. Pega la **Public key `appl_…`** en el código y recompila (1 línea + build).
4. Variables de entorno en el servidor Oracle (secretos de RevenueCat, JWT, etc.).
5. Endurece el servidor Oracle (firewall, SSH, fail2ban, updates).
6. Xcode → build, iconos, screenshots, privacy labels, envío a revisión.
7. Smoke tests y verificación de webhooks.

---

## 1) 🔴 App Store Connect

### 1.1 Contrato de apps de pago (Paid Apps Agreement)
`App Store Connect → Business / Agreements, Tax, and Banking`
- [ ] Acepta el **Paid Applications Agreement**.
- [ ] Completa **información fiscal** (W-8BEN como persona/empresa MX).
- [ ] Completa **datos bancarios** (cuenta CLABE MX) para depósitos.
- [ ] Estado del contrato debe quedar **"Active"** (si está "Pending", los IAP no se pueden probar ni vender).

### 1.2 Crear los 3 productos IAP
`Tu app → Monetization → In-App Purchases → (+)`

| Producto | Tipo | Product ID | Precio ref. |
|---|---|---|---|
| Mensual | **Auto-Renewable Subscription** | `com.miportafolio.mensual` | $65 MXN / mes |
| Anual | **Auto-Renewable Subscription** | `com.miportafolio.anual` | $650 MXN / año |
| Ilimitado | **Non-Consumable** | `com.miportafolio.lifetime` | $6,500 MXN (pago único) |

Detalles:
- [ ] Las dos suscripciones van en un mismo **Subscription Group** (ej. "Mi Portafolio Premium") para que el usuario pueda cambiar Mensual↔Anual.
- [ ] Ilimitado es **Non-Consumable** (NO va en el grupo de suscripciones).
- [ ] Para cada producto: nombre visible, descripción, y **precio** (elige el tier MXN más cercano; Apple fija los tiers).
- [ ] Sube un **screenshot de revisión** por producto (puede ser el paywall).
- [ ] Deja los 3 en estado **"Ready to Submit"** (se envían junto con el primer build).

### 1.3 App-Specific Shared Secret
`Tu app → App Information → App-Specific Shared Secret → Generate`
- [ ] **Cópialo.** Lo pegas en RevenueCat (paso 2.3). Es lo que deja a RevenueCat validar recibos de Apple server-side.

---

## 2) 🔴 RevenueCat (dashboard)

### 2.1 Crear proyecto y app
- [ ] Crea el proyecto (o usa el existente) → **+ New App → App Store**.
- [ ] **Bundle ID:** `app.miportafolio`.

### 2.2 API keys
`Project settings → API keys`
- [ ] Copia la **Public app-specific key de iOS** → empieza con **`appl_…`** (esta va en el cliente, paso 3).
- [ ] Copia la **Secret key** → empieza con **`sk_…`** (esta va SOLO en el servidor, paso 4: `REVENUECAT_SECRET_API_KEY`). ⚠️ Nunca la pongas en el código del cliente.

### 2.3 Conectar con App Store
`App settings → App Store → In-app purchase key / App-Specific Shared Secret`
- [ ] Pega el **App-Specific Shared Secret** del paso 1.3.

### 2.4 Entitlement
`Entitlements → (+)`
- [ ] Usa la entitlement existente con **identifier exacto: `Mi Portafolio`** (el backend y el cliente ya esperan ese nombre; respeta mayúsculas y el espacio).
- [ ] Adjúntale los **3 productos** (`com.miportafolio.mensual`, `.anual`, `.lifetime`).

### 2.5 Offering + Packages
`Offerings → crea un offering (márcalo como "current")`
- [ ] Package **Monthly** → `com.miportafolio.mensual`
- [ ] Package **Annual** → `com.miportafolio.anual`
- [ ] Package **Lifetime** → `com.miportafolio.lifetime`
> El paywall lee el offering **"current"** y lo ordena Mensual → Anual → **Ilimitado** automáticamente. Si no hay offering "current", el paywall muestra "No hay planes disponibles".

### 2.6 Webhook (validación server-side de compras)
`Project settings → Webhooks → + New`
- [ ] **URL:** `https://miportafolio.uk/api/payments/revenuecat/webhook`
- [ ] **Authorization header:** inventa un valor secreto largo (ej. `openssl rand -hex 32`). Ese MISMO valor lo pones en el servidor como `REVENUECAT_WEBHOOK_AUTH` (paso 4).

---

## 3) 🔴 Pegar la API key en el cliente y recompilar

Archivo: [`frontend/native-config.js`](frontend/native-config.js) (línea con `MP_REVENUECAT_KEY_IOS`).

- [ ] Reemplaza la key de test por la real:
  ```js
  window.MP_REVENUECAT_KEY_IOS = 'appl_TU_KEY_REAL';   // <- del paso 2.2
  ```
  (Hoy dice `test_LzkdpbEfhWFopkIxLeZeVomJlGY` = **Test Store**; con esa key Apple rechaza porque las compras son simuladas.)
- [ ] Re-sincroniza los assets al proyecto iOS:
  ```bash
  cd ~/Desktop/portafolio-app/ios-app
  npm run cap:sync:ios
  ```
- [ ] (Android, solo si lo lanzas) reemplaza también `MP_REVENUECAT_KEY_ANDROID` (`goog_…`).

---

## 4) 🔴 Variables de entorno del servidor (Oracle VM)

Van en `deploy/.env` de la VM (NO en git). Genera secretos con `openssl rand -hex 32`.

```bash
# --- Núcleo / auth ---
DATABASE_URL=postgresql://...neon...          # la misma de Neon
AUTH_BASE_URL=https://miportafolio.uk
JWT_SECRET=<openssl rand -hex 32>             # 🔴 sin esto los JWT se invalidan al reiniciar
CRON_SECRET=<openssl rand -hex 32>            # el MISMO en GitHub → Secrets (para alertas.yml)
TRIAL_DIAS=14

# --- Pagos / RevenueCat (server-side, fuente de verdad del premium) ---
REVENUECAT_SECRET_API_KEY=sk_...              # 🔴 Secret key del paso 2.2
REVENUECAT_ENTITLEMENT="Mi Portafolio"        # YA configurado en el server; debe coincidir con la entitlement del dashboard
REVENUECAT_WEBHOOK_AUTH=<el valor del paso 2.6>
STRICT_WEBHOOKS=1                             # 🟡 rechaza webhooks sin firma/secreto (prod)

# --- Pagos web (MercadoPago; opcional si sólo lanzas iOS ahora) ---
MERCADOPAGO_ACCESS_TOKEN=                     # vacío = pagos web en mock; lléñalo cuando cobres por web
MERCADOPAGO_WEBHOOK_SECRET=
MERCADOPAGO_PRECIO_MXN=65
MERCADOPAGO_BACK_URL=https://miportafolio.uk/static/index.html?paid=1

# --- Correo (magic links + alertas) ---
RESEND_API_KEY=re_...        # o SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM
RESEND_FROM=Mi Portafolio <no-reply@miportafolio.uk>

# --- NO poner en producción ---
# AUTH_MOCK_MODE   -> déjalo AUSENTE. Si lo pones =1, se habilita un endpoint
#                     que otorga premium sin pagar (solo para tu dev local).
# FLASK_DEBUG      -> ausente.
```

Aplicar en la VM:
```bash
ssh -i ~/.ssh/oracle.key ubuntu@140.84.165.219
cd ~/portafolio-app && git pull
nano deploy/.env                 # pega las variables de arriba
source .venv/bin/activate && pip install -r backend/requirements.txt
sudo systemctl restart miportafolio
sudo systemctl status miportafolio --no-pager
curl -s https://miportafolio.uk/api/payments/estado   # debe decir revenuecat_disponible:true
```

> ⚠️ Al intentar entrar por SSH desde esta sesión me rebotó `Permission denied (publickey)`
> con `~/.ssh/oracle.key` (usuarios `ubuntu` y `opc`). Verifica que esa sea la llave
> correcta / que su pública esté en `~/.ssh/authorized_keys` de la VM antes de correr lo de arriba.

---

## 5) 🟡 Endurecer el servidor Oracle (comandos exactos)

Hoy, desde fuera, están abiertos **22, 80, 443** (bien) y el 8000 de gunicorn está cerrado (bien). Falta blindar SSH y updates. Corre en la VM:

```bash
# 5.1 Actualizaciones de seguridad automáticas
sudo apt-get update && sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # elige "Yes"

# 5.2 fail2ban (banea IPs que revientan SSH)
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd

# 5.3 SSH solo con llave (sin password). PRIMERO confirma que entras con tu llave:
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/'   /etc/ssh/sshd_config
sudo sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'                 /etc/ssh/sshd_config
sudo systemctl restart ssh    # en Oracle a veces el servicio es 'sshd'

# 5.4 Firewall: solo 22/80/443 (Oracle usa iptables; ya hay reglas para 80/443)
sudo iptables -I INPUT 5 -p tcp --dport 22 -m state --state NEW -j ACCEPT
# (Además: en la consola de Oracle Cloud, revisa la Security List / NSG de la subred
#  y deja ingress SOLO en 22, 80, 443. El 8000 NUNCA debe abrirse al exterior.)
sudo netfilter-persistent save 2>/dev/null || sudo bash -c 'iptables-save > /etc/iptables/rules.v4'

# 5.5 Verificar que gunicorn NO escuche al exterior (debe ser 127.0.0.1:8000)
sudo ss -ltnp | grep 8000     # esperado: 127.0.0.1:8000
```

Headers/HTTPS: ya están OK en vivo (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy los pone Flask; Caddy fuerza HTTPS con Let's Encrypt). Tras el `git pull` de este cambio se agregará además **Content-Security-Policy**.

---

## 6) 🔴 Xcode — build y envío a revisión

```bash
cd ~/Desktop/portafolio-app/ios-app
npm run cap:sync:ios      # copia el frontend actualizado + la key real de RevenueCat
npx cap open ios          # abre Xcode
```
En Xcode / App Store Connect:
- [ ] **Signing:** Team correcto, Bundle ID `app.miportafolio`, firma automática.
- [ ] **Versión/Build:** 1.0 (build 1). Sube el build si repites.
- [ ] **App Icon:** ya hay 1024×1024 sin alpha. Verifica que no falte ningún tamaño en el Asset Catalog.
- [ ] **Product → Archive → Distribute App → App Store Connect**. Confirma en el Organizer que `aps-environment` quedó en *production* (firma automática lo hace).
- [ ] **Capabilities:** In-App Purchase activado.
- [ ] **Screenshots** (obligatorio): 6.7" (iPhone 15 Pro Max) y 6.5"; opcional 5.5" y iPad. Usa capturas reales del dashboard + paywall.
- [ ] **Privacy labels / Nutrition labels** en App Store Connect. Ya declaras en `PrivacyInfo.xcprivacy`: **Email** y **Purchase history** (App Functionality, no tracking), `UserDefaults` y `FileTimestamp`. Refléjalo en el cuestionario:
  - Data used: Email Address (App Functionality), Purchase History (App Functionality).
  - Tracking: **No**.
- [ ] **Descripción, keywords, categoría (Finance), soporte y URL de privacidad** (`https://miportafolio.uk/privacidad`) y términos (`/terminos`).
- [ ] **Disclaimer**: la app NO es asesor financiero registrado ante CNBV (ya está en el texto). Menciónalo en la descripción para evitar objeciones de la categoría finanzas.
- [ ] **App Review notes + cuenta demo:** ver la nota importante del paso 8. Adjunta un correo de prueba para que el revisor entre.
- [ ] Adjunta los **3 IAP** al enviar el build (se revisan juntos la primera vez).
- [ ] **Submit for Review**.

---

## 7) ✅ Smoke tests (después de desplegar servidor + subir build)

- [ ] `curl -s https://miportafolio.uk/api/payments/estado` → `revenuecat_disponible: true`, `entitlement: "Mi Portafolio"`.
- [ ] `curl -si https://miportafolio.uk/ | grep -i content-security-policy` → aparece la CSP.
- [ ] Bypass cerrado: `curl -s -X POST https://miportafolio.uk/api/payments/simular-aprobacion -H 'Content-Type: application/json' -d '{"preapproval_id":"x"}'` → **403** `no_disponible`.
- [ ] En **sandbox de iOS** (dispositivo real con Apple ID sandbox): compra Mensual → la hoja de Apple aparece → tras comprar, RevenueCat marca la entitlement `Mi Portafolio` y el webhook llega a `/api/payments/revenuecat/webhook`.
- [ ] Compra **Ilimitado** (lifetime) en sandbox → el usuario queda premium **permanente** (ya corregido server-side; antes lifetime no daba premium).
- [ ] **Restaurar compra** funciona (botón en el paywall).
- [ ] Cron de alertas (GitHub Actions → run manual) responde 200.

---

## 8) ⚠️ IMPORTANTE — límite conocido del "candado" en la app nativa

**Qué funciona hoy en iOS:** la compra por RevenueCat, la validación **server-side** del recibo (con la Secret key), el webhook, y que el estado premium se calcula en el servidor (no se puede falsificar desde el cliente). El endpoint que regalaba premium sin pagar quedó **cerrado**.

**El hueco que queda:** la app nativa da **acceso completo a un usuario anónimo** (a propósito, para que el revisor de Apple pueda evaluarla). El candado del trial de 14 días solo aplica a un usuario **con sesión iniciada**, pero en la app nativa el login por *magic link* abre Safari y **no crea sesión dentro de la app** (WKWebView no comparte cookies). Resultado: hoy en iOS nadie queda bloqueado y el "premium ✓" tampoco se refleja tras comprar.

**Consecuencia:** puedes **lanzar y cobrar** (las compras funcionan y se validan), pero el trial no se "endurece" por usuario en iOS hasta cerrar este login.

**Cómo cerrarlo (recomendado, siguiente iteración — necesita prueba en dispositivo):**
1. Backend: agregar login por **código OTP de 6 dígitos** (`/api/auth/otp/solicitar` + `/api/auth/otp/verificar` que devuelva un **JWT**). La base ya está lista: `jwt_auth.crear_jwt/validar_jwt` y `_sesion_actual()` **ya aceptan `Authorization: Bearer <JWT>`**, y el wrapper de fetch del cliente ya manda `mp.jwt.v1` si existe.
2. Frontend: en el paywall, tras pedir el correo mostrar un campo para el código y guardar el JWT en `localStorage['mp.jwt.v1']`.
3. Con eso, activar el gate real: aplicar en el backend un decorador `@requiere_acceso` (sesión + `_estado_plan['acceso']`) a los endpoints premium, devolviendo 402 si la prueba venció. (Nota: un usuario nuevo obtiene 14 días de trial, así que el revisor de Apple sigue pudiendo evaluar la app creando cuenta.)

> Para la primera revisión, en **App Review notes** aclara que la app es de acceso libre con prueba y que las compras son suscripciones/no-consumible reales; y deja un correo demo. Así evitas rechazo por "no se puede evaluar".

---

## ✅ Ya hecho por Claude (en el código, este commit)

**Seguridad (backend):**
- Cerrado el **bypass de pago** `/api/payments/simular-aprobacion` (403 salvo `AUTH_MOCK_MODE`; y solo suscripciones mock). *Antes: cualquiera se auto-otorgaba premium.*
- **IDOR mitigado (sin romper la web)** en `/api/backups` y `/api/backups/<id>`: si el usuario tiene sesión (cookie/JWT), el email se toma de la sesión y **no puede** operar sobre backups de otro; si no hay sesión, se conserva el modelo anónimo actual (email del cliente) para no romper la web. **Cierre total del IDOR anónimo → requiere gatear la sección tras login (§8).**
- **Relay de correo mitigado** en `/api/alertas/enviar` y push de `/api/push/test`: con sesión, el destino se fija al propio usuario; sin sesión se respeta el modelo actual pero con **rate limit estricto** (5/hora y 10/hora por IP) que corta el spam. **Cierre total → login gate (§8).**
- **Compras Ilimitado/lifetime** ahora otorgan premium (entitlement sin `expires_date`). *Antes: el comprador de por vida NO recibía premium.*
- **Webhooks fail-closed** opcional con `STRICT_WEBHOOKS=1` (MercadoPago y RevenueCat).
- **Rate limits** en endpoints caros: analizar, explorar, backtest, stress-test, portafolio-óptimo, fundamentals, deep-dive, reporte/pdf.
- **MAX_CONTENT_LENGTH** (2 MB) + caps de entrada (≤100 tickers, mensaje IA ≤4000 chars).
- **CSP** agregada a los security headers; dominios de producción añadidos a CORS.
- **CRON_SECRET** ya no se acepta por query string (se filtraba en logs); solo header Bearer, comparación en tiempo constante.
- **Identidad JWT** en `_sesion_actual()` (base para el login nativo del paso 8).
- Dependencias con **floors de seguridad** (gunicorn≥23, flask-cors≥6, requests≥2.32.4, sentry≥2.8, cryptography≥44); `runtime.txt` → Python 3.11.13.
- `.gitignore` endurecido (todas las variantes `.env`). **Auditoría: 0 secretos en el código ni en el historial de git.**

**RevenueCat (cliente):**
- Entitlement del cliente = **`premium`** (coincide con el backend).
- Paywall muestra **Mensual / Anual / Ilimitado** (relabel de "De por vida" → "Ilimitado").
- Product IDs documentados; assets iOS re-sincronizados (`www` + `public`).

**Lo que NO toqué (tú lo haces):** App Store Connect, dashboard de RevenueCat, y la **Public key `appl_…`** real (paso 3).
