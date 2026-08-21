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

    /* IDENTIFICADOR DEL APARATO PARA LAS CUOTAS DE ALTA.
       El trial se cuenta por cuenta, así que la defensa está en el alta, y en
       iOS el eje fuerte es el DISPOSITIVO, no la IP: los operadores móviles
       comparten una IP entre miles de clientes, así que limitar por IP en un
       celular castiga a desconocidos y no frena al que quiere diez trials.
       identifierForVendor identifica el aparato sin permisos ni datos
       personales, y el servidor solo guarda su hash. Lo pide el contenedor y se
       manda en una cabecera; si no está, el backend cae a la IP. */
    try {
      var h = window.webkit && window.webkit.messageHandlers
              && window.webkit.messageHandlers.mpDispositivo;
      if (h && h.postMessage) h.postMessage({ accion: 'pedir' });
    } catch (_) {}
    window.mpDispositivoId = function (id) {
      try {
        if (id) window.MP_DISPOSITIVO = String(id).slice(0, 128);
      } catch (_) {}
    };

    // API keys PÚBLICAS de RevenueCat (Dashboard → Project → API keys → Public)
    // Key de PRODUCCIÓN de iOS (app-specific, conectada a App Store Connect).
    // Es una SDK key pública: es seguro que viva en el cliente. Tras cambiarla,
    // corre `npm run cap:sync:ios` en ios-app/ para que llegue al build.
    window.MP_REVENUECAT_KEY_IOS     = 'appl_RImxHCOwAIIjVMrbcYVYqvQjeiA';
    window.MP_REVENUECAT_KEY_ANDROID = 'goog_TODO_REEMPLAZAR';             // solo si lanzas Android

    // Identificador de la entitlement en el dashboard de RevenueCat.
    // DEBE coincidir con REVENUECAT_ENTITLEMENT del backend. Hoy en RevenueCat
    // y en el servidor es 'Mi Portafolio' — adjúntale los 3 productos.
    window.MP_RC_ENTITLEMENT = 'Mi Portafolio';

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
