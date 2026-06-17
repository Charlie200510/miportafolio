# Mi Portafolio — Publicar en App Store y Google Play

Guía completa para sacar la app a las dos tiendas con el modelo de cobro **híbrido**:

- **Web (navegador / PWA):** cobro con **MercadoPago** — 14 días gratis, luego $65 MXN/mes.
- **App nativa (iOS / Android):** **compra in-app obligatoria** (regla de Apple/Google), gestionada con **RevenueCat**.

La app web NO se reescribe: se "envuelve" con **Capacitor** (carpeta `ios-app/`, que ahora compila **iOS y Android**).

---

## 1. Qué quedó listo en el código (ya hecho)

- `frontend/paywall.js` — paywall que detecta plataforma y enruta el cobro:
  - web → `/api/payments/suscribir` (MercadoPago)
  - nativo → compra in-app vía RevenueCat → confirma en `/api/payments/revenuecat/sync`
  - cumple **anti-steering**: dentro de la app NO se menciona ni enlaza el pago web.
  - incluye botón **"Restaurar compra"** (obligatorio en iOS) y aviso de renovación automática.
- `frontend/native-config.js` — inyecta `MP_API_BASE` y las API keys **públicas** de RevenueCat solo dentro de la app.
- Backend (`payments.py` + `app.py`): verificación **server-side** segura de la suscripción in-app
  (`/api/payments/revenuecat/sync`) y webhook (`/api/payments/revenuecat/webhook`).
- `ios-app/` ahora soporta **Android** además de iOS (Capacitor cross-platform) y usa el plugin oficial
  `@revenuecat/purchases-capacitor`.

### Cómo disparar el paywall desde la UI
Cualquier botón con el atributo abre el paywall correcto:
```html
<button data-mp-paywall>Hazte Premium</button>
```
O por código: `MPPaywall.abrir()`. Para bloquear una función premium:
```js
MPPaywall.requierePremium(() => abrirReportePDF());
```

---

## 2. Lo que TIENES que hacer tú (cuentas y configuración)

> Estas cosas requieren tus credenciales/cuentas y por seguridad las haces tú, no yo.

### a) Cuentas de desarrollador
- **Apple Developer Program** — $99 USD/año · https://developer.apple.com/programs/
- **Google Play Console** — $25 USD una sola vez · https://play.google.com/console/signup

### b) RevenueCat (gratis hasta ~$2.5k USD/mes de ventas)
1. Crea cuenta en https://www.revenuecat.com y un proyecto "Mi Portafolio".
2. Crea una **entitlement** llamada `premium`.
3. Crea un **producto/offering** de suscripción mensual a $65 MXN, y conéctalo en App Store Connect y Google Play (mismo precio en ambas).
4. Copia las **Public API keys** (`appl_...` para iOS, `goog_...` para Android) y pégalas en
   `frontend/native-config.js` (reemplaza los `TODO`).
5. Copia la **Secret API key** (`sk_...`) y ponla como variable de entorno en Render (ver abajo). **NUNCA** la pongas en el frontend.

### c) Variables de entorno en Render (backend)
```
REVENUECAT_SECRET_API_KEY = sk_xxx        # secret key del dashboard de RevenueCat
REVENUECAT_ENTITLEMENT    = premium       # (opcional, ya es el default)
REVENUECAT_WEBHOOK_AUTH   = <un secreto que tú inventes>
```
Y en RevenueCat → Project → Integrations → Webhooks:
- URL: `https://miportafolio.onrender.com/api/payments/revenuecat/webhook`
- Authorization header: el mismo valor de `REVENUECAT_WEBHOOK_AUTH`.

(Las de MercadoPago — `MERCADOPAGO_ACCESS_TOKEN`, etc. — son para el cobro web y ya están documentadas en `payments.py`.)

---

## 3. Compilar y subir (en tu Mac)

```bash
cd ios-app
npm install                 # instala Capacitor + plugins (incluye Android e iOS)

# iOS
npm run cap:add:ios
cd ios/App && pod install && cd ../..
npm run cap:open:ios        # abre Xcode → Signing & Team → Archive → subir a App Store Connect

# Android
npm run cap:add:android
npm run cap:open:android     # abre Android Studio → genera un .aab firmado → subir a Play Console
```

Cuando cambies cualquier cosa del frontend después:
```bash
cd ios-app && npm run cap:sync    # copia frontend/ → www/ y propaga a iOS y Android
```

Requisitos en el Mac: Node 18+, Xcode 15+, CocoaPods (`sudo gem install cocoapods`), Android Studio + JDK 17.

---

## 4. Checklist de revisión de tiendas (para que NO te rechacen)

### Apple (las causas de rechazo más comunes)
- [ ] **Guideline 3.1.1 — anti-steering:** dentro de la app, cero menciones/enlaces a pago externo. (Ya cumplido en `paywall.js`; no agregues botones de "paga en la web" en la app.)
- [ ] **Guideline 5.1.1(v) — borrar cuenta:** si la app permite crear cuenta, DEBE permitir **eliminarla desde dentro de la app**. ⚠️ **Falta implementar** (ver §5).
- [ ] **Guideline 4.2 — funcionalidad mínima:** no debe sentirse "solo un sitio web". Activa al menos push y Face ID / Touch ID (los plugins ya están en `package.json`).
- [ ] **Privacy Manifest** (`PrivacyInfo.xcprivacy`): usa la plantilla `ios-app/PrivacyInfo.xcprivacy` y agrégala al target App en Xcode.
- [ ] **Nutrition Labels** de privacidad en App Store Connect (qué datos recopilas: email, uso).
- [ ] Suscripción auto-renovable con su descripción, precio y enlace a Términos/Privacidad (ya en el paywall).

### Google Play
- [ ] **Play Billing** para la suscripción (RevenueCat lo maneja).
- [ ] **Data safety form** en Play Console.
- [ ] **Política de privacidad** pública (ya tienes `/privacidad`).
- [ ] Opción de **borrar cuenta** (Google también lo exige) — mismo punto que Apple.
- [ ] Target API level reciente (Android Studio te avisa).

---

## 5. Lo único que falta en código: borrar cuenta in-app

Apple **y** Google rechazan apps con login que no dejan borrar la cuenta desde dentro.
Hay que añadir un endpoint `DELETE /api/auth/cuenta` (que borre el usuario y sus datos) y un
botón "Eliminar mi cuenta" en Ajustes. **Avísame y lo implemento** — es ~30 min.

---

## 6. Nota de mensajería (importante)

El copy se alineó al modelo **prueba de 14 días → $65 MXN/mes** en landing, signup y términos.
(Antes el landing decía "free forever", lo cual contradecía el cobro.)
