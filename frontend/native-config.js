// ============================================================
//  Configuración SOLO para la app nativa (iOS / Android)
// ============================================================
//  Este archivo se carga ANTES de app.js. En navegador web no hace nada
//  (las llamadas siguen siendo relativas /api/...). Dentro de Capacitor:
//   - apunta el API a producción (Render)
//   - expone las API keys PÚBLICAS de RevenueCat
//
//  IMPORTANTE: las keys "appl_..." y "goog_..." de RevenueCat son PÚBLICAS
//  (SDK keys) y es seguro incluirlas aquí. La SECRET key (sk_...) va SOLO en
//  el backend como variable de entorno, NUNCA aquí.
//
//  >>> Reemplaza los valores marcados con TODO antes de compilar la app. <<<
// ============================================================
(function () {
  'use strict';
  try {
    // Detección robusta: el objeto Capacitor puede no estar inyectado aún al
    // parsear este script, pero el scheme capacitor: solo existe en la app iOS.
    var nativo = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
      || window.location.protocol === 'capacitor:';
    if (!nativo) return;

    // URL del backend en producción (ajústala si cambias de hosting/dominio)
    window.MP_API_BASE = 'https://miportafolio.uk';

    // API keys PÚBLICAS de RevenueCat (Dashboard → Project → API keys → Public)
    // ⚠️⚠️ BLOQUEANTE: hoy es la key del TEST STORE (compras SIMULADAS, no
    // conectadas a App Store Connect). Con esta key Apple RECHAZA la app.
    // Antes de archivar el build de producción, reemplaza por la key 'appl_...'
    // real (RevenueCat → Project → API keys → Public app-specific de iOS) y corre
    // `npm run cap:sync:ios` en ios-app/. Ver LANZAMIENTO.md.
    window.MP_REVENUECAT_KEY_IOS     = 'test_LzkdpbEfhWFopkIxLeZeVomJlGY';  // TODO -> appl_...
    window.MP_REVENUECAT_KEY_ANDROID = 'goog_TODO_REEMPLAZAR';             // solo si lanzas Android

    // Identificador de la entitlement en el dashboard de RevenueCat.
    // DEBE coincidir con REVENUECAT_ENTITLEMENT del backend (default: 'premium').
    // Crea esta entitlement en RevenueCat y adjúntale los 3 productos.
    window.MP_RC_ENTITLEMENT = 'premium';

    // Product IDs de los 3 productos (App Store Connect + RevenueCat). El paywall
    // los muestra dinámicamente desde el offering "current"; esta lista es solo
    // referencia/documentación (el orden lo fija packageType MONTHLY/ANNUAL/LIFETIME):
    //   com.miportafolio.mensual   → Mensual  ($65 MXN/mes)
    //   com.miportafolio.anual     → Anual    ($650 MXN/año)
    //   com.miportafolio.lifetime  → Ilimitado ($6500 MXN, pago único)
    window.MP_RC_PRODUCTS = {
      mensual:  'com.miportafolio.mensual',
      anual:    'com.miportafolio.anual',
      lifetime: 'com.miportafolio.lifetime',
    };
  } catch (_) {}
})();
