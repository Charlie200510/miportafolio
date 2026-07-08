# Handoff — Publicar "Mi Portafolio" en Google Play

> Tarea EXCLUSIVA: llevar la app a Google Play. **NO tocar nada de iOS/App Store** — otra instancia de Claude maneja Apple en paralelo. Evita tocar `ios-app/ios/`, la firma de iOS y App Store Connect.

## Contexto del proyecto
- **App:** "Mi Portafolio" — herramienta de análisis de inversión para México. Es **Capacitor 7** (UI web + wrapper nativo). Bundle/applicationId: **`app.miportafolio`**.
- **Repo:** `~/Desktop/portafolio-app` (git; remote GitHub `Charlie200510/miportafolio`, rama `main`).
- **Proyecto Capacitor:** `~/Desktop/portafolio-app/ios-app/` → contiene `ios/` y `android/`. El frontend web vive en `~/Desktop/portafolio-app/frontend/` y se copia a `ios-app/www/` con **`npm run cap:sync`** (ese script reescribe rutas `/static/`→`/`; **usa siempre `npm run cap:sync`, NO `npx cap sync` directo**, o los assets dan 404 en el contenedor).
- **Backend:** Flask en servidor Oracle, dominio `https://miportafolio.uk` (detrás de Cloudflare, nube gris/naranja según el momento).
  - Deploy de backend/frontend: `ssh -i ~/Downloads/oci-portafolio-2026.key -o ServerAliveInterval=60 ubuntu@140.84.165.219`, luego `cd ~/portafolio-app && git pull && sudo systemctl restart miportafolio`.

## Estado actual (relevante para Android)
- RevenueCat ya integrado vía `@revenuecat/purchases-capacitor` (v11.x). **Entitlement identifier = "Mi Portafolio"** (con espacio).
- Server-side sync configurado en Oracle: `REVENUECAT_ENTITLEMENT="Mi Portafolio"`, `REVENUECAT_SECRET_API_KEY` (ya puesta), `REVENUECAT_WEBHOOK_AUTH=carlosbarredaserrano`. Webhook RevenueCat → `https://miportafolio.uk/api/payments/revenuecat/webhook`.
- **Pendiente clave:** en `frontend/native-config.js`, `window.MP_REVENUECAT_KEY_ANDROID = 'goog_TODO_REEMPLAZAR'` → falta la **public SDK key real de Google** de RevenueCat.
- Paywall con captura de correo inline + hard-gate de prueba de 14 días (implementado del lado web/nativo).
- Texto de ficha reutilizable en `~/Desktop/portafolio-app/APP_STORE_LISTING.md` (adáptalo a Google).

## Objetivo: publicar en Google Play

### 1. Build del AAB firmado
- Verifica `ios-app/android/` (si no existe: `cd ios-app && npx cap add android`).
- `cd ios-app && npm run cap:sync` para propagar el frontend a Android.
- En `android/app/build.gradle`: confirma `applicationId "app.miportafolio"`, define `versionCode` (entero, empezar en 1) y `versionName` ("1.0").
- Crea un **keystore** de firma release. ⚠️ **GUÁRDALO A SALVO (archivo + contraseñas)**; confírmalo con el usuario. Perderlo = imposible volver a actualizar la app. NO lo subas a git.
- Genera el **Android App Bundle (.aab)** release firmado (Android Studio → *Generate Signed Bundle/APK → Android App Bundle*, o `./gradlew bundleRelease` con `signingConfig`). Reporta la ruta del `.aab` y verifica que compile.

### 2. RevenueCat para Google
- Guía al usuario a crear una **Service Account de Google Cloud** con acceso en Play Console (Play Console → Setup → API access), y subir su **JSON** a RevenueCat (config de la app Android). El JSON es secreto: manéjalo local, no lo pegues en chat.
- Copia la **public SDK key de Google** (`goog_...`) desde RevenueCat → ponla en `frontend/native-config.js` reemplazando `goog_TODO_REEMPLAZAR`. Sube VERSION de `frontend/sw.js`, commitea y despliega a Oracle.

### 3. Ficha en Play Console
- Reutiliza y adapta el texto de `APP_STORE_LISTING.md`: **título** (30 car), **descripción corta** (80 car), **descripción larga** (4000 car). Mantén la divulgación de suscripción auto-renovable y el disclaimer de "no es asesoría de inversión".
- Gráficos: **ícono 512×512 PNG**, **feature graphic 1024×500**, **screenshots de teléfono** (mín. 2, hasta 8) y de **tablet 7" y 10"**. Genera screenshots con un emulador Android a tamaños válidos.
- **Content rating** (cuestionario IARC), **Data safety** (declara: se recopila correo + datos de uso; datos del portafolio locales en el dispositivo), **Privacy Policy URL** = `https://miportafolio.uk/privacidad`, categoría **Finanzas**, público objetivo (adultos).

### 4. Suscripción
- Play Console → **Monetize → Subscriptions**: crea el plan **$65 MXN/mes** (base plan mensual; opcional anual/de por vida si el usuario quiere). Los product IDs deben coincidir con lo que espera RevenueCat.
- Conéctalos en RevenueCat (offering + entitlement **"Mi Portafolio"**).

### 5. Subir y liberar
- Sube el `.aab` primero a **Closed testing**.
- ⚠️ **Cuentas personales nuevas:** Google exige **20 testers durante 14 días** en closed testing antes de habilitar Production. Ayuda al usuario a armar la lista de testers (correos) y el opt-in link.
- Cumplido el periodo → promueve a **Production** → envía a revisión (suele ser más rápido que Apple).

## Reglas / cuidados
- **NO tocar iOS** (otra instancia lo maneja): nada de `ios-app/ios/`, firma iOS, ni App Store Connect.
- **Keystore:** guárdalo a salvo, fuera de git; sin él no hay actualizaciones futuras.
- **Secretos:** el JSON de la service account y las API keys van en sus lugares (RevenueCat / archivos locales / env de Oracle), nunca en texto plano en el chat ni en git.
- Cambios de `frontend/` → **bump `sw.js` VERSION** + commit + deploy a Oracle. Usa `npm run cap:sync` (reescribe `/static/`).
- Datos fijos: bundle `app.miportafolio`; RevenueCat entitlement `"Mi Portafolio"`; dominio prod `https://miportafolio.uk`.

## Primer paso sugerido
Verificar el estado de `ios-app/android/`, correr `npm run cap:sync`, y hacer un **build de debug** en emulador para confirmar que la app Android arranca y carga datos (mismo patrón que iOS: si el shell carga pero no hay datos, revisar rutas `/static/` y `MP_API_BASE`). Luego seguir con el keystore + AAB release.
