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
    // ⚠️ key del TEST STORE (compras simuladas, sin App Store Connect).
    // Antes de mandar a revisión: reemplazar por la key 'appl_...' de producción.
    window.MP_REVENUECAT_KEY_IOS     = 'test_LzkdpbEfhWFopkIxLeZeVomJlGY';
    window.MP_REVENUECAT_KEY_ANDROID = 'goog_TODO_REEMPLAZAR';

    // Identificador de la entitlement en el dashboard de RevenueCat.
    // Debe coincidir con REVENUECAT_ENTITLEMENT en el backend.
    window.MP_RC_ENTITLEMENT = 'Mi Portafolio';
  } catch (_) {}
})();
