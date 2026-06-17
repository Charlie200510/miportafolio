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
    var nativo = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (!nativo) return;

    // URL del backend en producción (ajústala si cambias de hosting/dominio)
    window.MP_API_BASE = 'https://miportafolio.onrender.com';

    // API keys PÚBLICAS de RevenueCat (Dashboard → Project → API keys → Public)
    window.MP_REVENUECAT_KEY_IOS     = 'appl_TODO_REEMPLAZAR';
    window.MP_REVENUECAT_KEY_ANDROID = 'goog_TODO_REEMPLAZAR';
  } catch (_) {}
})();
