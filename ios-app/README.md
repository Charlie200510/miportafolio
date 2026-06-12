# Mi Portafolio — iOS (Capacitor)

Wrapper iOS de la app web de Mi Portafolio. Comparte 90% del código con `frontend/` (vanilla JS + HTML + CSS) y agrega features nativos.

## Pre-requisitos en el Mac

- **Node.js 18+** — `brew install node` (si no tienes brew: https://brew.sh)
- **Xcode 15+** — App Store, gratis (~50GB, tarda 1h)
- **Cocoapods** — `sudo gem install cocoapods`
- **Apple Developer Program activo** — https://developer.apple.com/programs/

## Setup (primera vez, ~10 min)

```bash
cd ios-app

# 1. Instalar dependencias Node + Capacitor
npm install

# 2. Generar proyecto Xcode + sync inicial del frontend
npm run cap:add:ios

# 3. Instalar pods (Cocoapods toma 5-10 min)
cd ios/App && pod install && cd ../..

# 4. Abrir en Xcode
npm run cap:open
```

En Xcode:
1. Click en el proyecto **App** (arriba izquierda)
2. Tab **Signing & Capabilities**
3. Selecciona tu **Team** (tu Apple Developer account)
4. Bundle ID: `app.miportafolio.ios` (cambialo a algo único si está tomado)

## Workflow día a día

Cuando tocas código del frontend (`../frontend/*.html`, `../frontend/app.js`, etc.):

```bash
cd ios-app
npm run cap:sync         # copia frontend/ → www/ y propaga a Xcode
```

Después en Xcode: ⌘B (build) y ⌘R (run en simulador o iPhone conectado).

## Configuración del backend

La app iOS hace fetch a las URLs absolutas. La API base se controla por `window.MP_API_BASE` en `frontend/app.js`:

- En **navegador / web**: vacío → llamadas relativas a `/api/...`
- En **Capacitor iOS**: detecta y usa `https://miportafolio.onrender.com/api/...` (o tu URL de producción)

Para desarrollo con backend local:
1. Levantar Flask: `cd ../backend && python3 app.py`
2. Verifica que tu Mac y iPhone estén en la **misma WiFi**
3. Encuentra tu IP local: `ipconfig getifaddr en0` (ej: `192.168.1.42`)
4. En `capacitor.config.ts`, descomenta y ajusta:
   ```ts
   server: { url: 'http://192.168.1.42:5001', cleartext: true, ... }
   ```
5. `npm run cap:sync` y rebuild en Xcode

## Submit a App Store

1. En Xcode: **Product → Archive**
2. Window → Organizer → selecciona el archive
3. **Distribute App** → **App Store Connect** → **Upload**
4. En https://appstoreconnect.apple.com:
   - Crear nueva versión
   - Subir screenshots (5.5", 6.5", 6.7" iPhone)
   - Descripción + keywords
   - Privacy Nutrition Labels
   - Submit for Review
5. Apple revisa en 24-72h

## Features nativos planeados (Sprint 2-4)

- [x] Status bar dark + safe areas
- [x] Splash screen con logo
- [ ] Sign in with Apple (Sprint 2)
- [ ] Push notifications (drift, alertas) (Sprint 3)
- [ ] Face ID / Touch ID login (Sprint 3)
- [ ] Share sheet nativa (Sprint 3)
- [ ] In-App Purchase $79 MXN/mes (Sprint 4)
- [ ] Privacy Manifest (Sprint 5)
