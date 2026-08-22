// ============================================================
//  Mi Portafolio — Paywall híbrido (web + apps nativas)
// ============================================================
//
//  Regla de negocio:
//   - WEB  (navegador / PWA): cobro por MercadoPago ($65 MXN/mes, 14 días
//     gratis). Usa /api/payments/suscribir y redirige al checkout.
//   - APP NATIVA (iOS / Android): compra in-app obligatoria por las reglas de
//     Apple/Google. Usa RevenueCat. La compra se confirma server-side en
//     /api/payments/revenuecat/sync.
//
//  CUMPLIMIENTO ANTI-STEERING (Apple Guideline 3.1.1 / Google):
//   Dentro de la app nativa NO se menciona ni se enlaza el pago por web /
//   MercadoPago / precios externos. Solo se muestra la compra de la tienda,
//   el botón "Restaurar compra" (obligatorio en iOS) y el aviso de
//   renovación automática.
//
//  Config inyectada por el wrapper nativo (ver ios-app/README):
//     window.MP_REVENUECAT_KEY_IOS     = 'appl_xxx';
//     window.MP_REVENUECAT_KEY_ANDROID = 'goog_xxx';
//
//  API pública:
//     await MPPaywall.esPremium()      -> bool
//     MPPaywall.abrir()                -> muestra el modal correcto
//     await MPPaywall.restaurar()      -> restaura compras (nativo)
//     MPPaywall.requierePremium(fn)    -> ejecuta fn solo si es premium, si no abre paywall
//  Auto-bind: cualquier elemento con [data-mp-paywall] abre el paywall al click.
// ============================================================
(function () {
  'use strict';

  const PRECIO_TXT = '$65 MXN/mes';
  const Caps = window.Capacitor;

  // Techo de tiempo para la red y para el SDK de compras. Sin esto, un fetch o
  // un getOfferings() colgado (cold start del backend, sandbox de Apple, red
  // del revisor) dejaba el paywall en "Cargando planes…" para siempre — o peor,
  // hacía que tocar "Suscribirse" no mostrara NADA. Causa más probable del
  // rechazo por Guideline 2.1(b) en el build 1.0(4).
  const TIMEOUT_RED_MS       = 6000;
  const TIMEOUT_OFFERINGS_MS = 10000;

  // Precios de REFERENCIA (LANZAMIENTO §1.2 / App Store Connect). Solo se usan
  // para que la pantalla nunca quede vacía: cuando RevenueCat responde, sus
  // precios reales (localizados por la tienda) tienen prioridad.
  const PLANES_REF = [
    { tipo: 'MONTHLY',  nombre: 'Mensual',   precio: '$65 MXN',    sufijo: '/mes' },
    { tipo: 'ANNUAL',   nombre: 'Anual',     precio: '$650 MXN',   sufijo: '/año', badge: '2 meses gratis vs mensual' },
    { tipo: 'LIFETIME', nombre: 'Ilimitado', precio: '$6,500 MXN', sufijo: ' · pago único' },
  ];

  // Planes de WEB (MercadoPago). "Ilimitado" NO existe aquí: es pago único de
  // la tienda y sólo se ofrece en iOS. Igual que arriba, son de REFERENCIA:
  // /api/payments/estado manda los reales y los sustituye, de modo que el
  // precio del paywall y el del checkout no puedan desincronizarse.
  const PLANES_WEB_REF = [
    { ciclo: 'mensual', nombre: 'Mensual', precio: '$65 MXN',  sufijo: '/mes' },
    { ciclo: 'anual',   nombre: 'Anual',   precio: '$650 MXN', sufijo: '/año', badge: '2 meses gratis vs mensual' },
  ];

  // Resuelve con `fallback` si la promesa tarda más de ms (nunca rechaza).
  function conTimeout(promesa, ms, fallback) {
    return Promise.race([
      Promise.resolve(promesa).catch(() => fallback),
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }
  // Rechaza a los ms (para hacer race con algo que sí debe fallar visiblemente).
  function rechazaEn(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  }

  function plataforma() {
    try { if (Caps && Caps.getPlatform) return Caps.getPlatform(); } catch (_) {}
    return 'web';
  }
  function esNativo() {
    try { return !!(Caps && Caps.isNativePlatform && Caps.isNativePlatform()); } catch (_) { return false; }
  }

  // -------------------------------------------------- estado del usuario
  /* La sitekey de Turnstile la sirve el backend en /api/auth/estado, así que se
     puede rotar el widget sin volver a desplegar el frontend. Las funciones que
     la usan para pintar están en la sección AUTH; la variable vive aquí, junto a
     lo único que la escribe.

     ESTA DECLARACIÓN NO ES DECORATIVA: sin ella la asignación de abajo es a una
     variable inexistente, y bajo 'use strict' eso LANZA. Como la sitekey solo
     viene en la respuesta cuando NO hay sesión, el error salía exactamente en el
     caso en que el candado tiene que funcionar: estadoUsuario() lo tragaba, lo
     reportaba como "el servidor no contestó" y el gate dejaba pasar sin cuenta. */
  let _tsSitekey = '';

  function _guardarSitekey(e) {
    // Nada de lo que pase aquí puede tumbar la comprobación de acceso: esta
    // función solo cachea un dato opcional del antibot.
    try {
      if (e && typeof e.turnstile_sitekey === 'string' && e.turnstile_sitekey) {
        _tsSitekey = e.turnstile_sitekey;
      }
    } catch (_) {}
  }

  async function estadoUsuario() {
    // no-store + timestamp: el WKWebView puede cachear el GET y dejar el
    // estado premium desactualizado justo después de una compra.
    //
    // El fallback lleva _sinRespuesta para poder distinguir "no hay sesión" de
    // "no contestó el servidor". Son lo mismo en este objeto y desde que el
    // gate aplica también en web, confundirlos significa enseñar la pantalla de
    // acceso a alguien que sí tiene sesión solo porque su red tardó 6 segundos.
    // Mismo criterio que account.js.
    return conTimeout((async () => {
      const r = await fetch('/api/auth/estado?t=' + Date.now(), { cache: 'no-store' });
      const e = (await r.json()) || { autenticado: false, _sinRespuesta: true };
      _guardarSitekey(e);
      return e;
    })(), TIMEOUT_RED_MS, { autenticado: false, _sinRespuesta: true });
  }
  async function emailActual() {
    const e = await estadoUsuario();
    return (e && e.email) ? String(e.email).toLowerCase() : '';
  }
  // Premium EFECTIVO = servidor (sesión) O entitlement del SDK en la app nativa.
  // Esto permite comprar SIN cuenta: RevenueCat valida la compra en el dispositivo
  // con el usuario anónimo y la app desbloquea aunque el servidor no tenga sesión.
  // (El servidor sigue siendo la fuente de verdad para usuarios CON sesión.)
  let _sdkPremium = false;
  async function refrescarSDKPremium() {
    if (!esNativo()) { _sdkPremium = false; return false; }
    // Solo actualizamos ante una RESPUESTA DEFINITIVA del SDK: así un reembolso o
    // caducidad quita el acceso en el próximo arranque, mientras que un fallo
    // transitorio (plugin no listo, timeout) NO le quita el Premium a un
    // comprador legítimo (conserva el último valor conocido).
    // conTimeout: si el plugin no responde, NO bloqueamos el arranque ni el
    // paywall (se conserva el último valor conocido).
    const info = await conTimeout((async () => {
      const RC = await rcInit(await emailActual());
      const r = await RC.getCustomerInfo();
      return { ok: true, info: (r && (r.customerInfo || r)) || null };
    })(), TIMEOUT_OFFERINGS_MS, null);
    if (info && info.ok) _sdkPremium = entitlementActiva(info.info);
    return _sdkPremium;
  }
  async function esPremium() {
    const e = await estadoUsuario();
    if (_esPremiumEstado(e)) return true;               // servidor: fuente de verdad
    // El entitlement del SDK solo cuenta si hay sesión que lo respalde: sin ella
    // la app no puede afirmar que alguien es premium (ver _premiumEfectivo).
    if (esNativo() && e && e.autenticado) return await refrescarSDKPremium();
    return false;
  }
  function _esPremiumEstado(e) {
    if (!e) return false;
    if (e.premium === true) return true;               // campo del gate (backend)
    return ((e.usuario && e.usuario.plan) || '') === 'premium';
  }

  // Premium EFECTIVO para la interfaz: EXIGE sesión.
  //
  // El entitlement del SDK por sí solo NO alcanza. Sin esta regla la app podía
  // afirmar "suscrito" sin ninguna sesión detrás: la compra vive en el Apple ID,
  // así que sobrevive a eliminar la cuenta de la app, y quedaba un estado
  // imposible (premium + sin sesión + sin gate) del que no había salida.
  // Con sesión, el servidor sigue siendo la fuente de verdad y el SDK solo
  // adelanta el desbloqueo tras comprar.
  function _premiumEfectivo(e) {
    if (!(e && e.autenticado)) return false;
    return _esPremiumEstado(e) || _sdkPremium;
  }

  // Re-vincula a la cuenta ACTUAL una compra que ya vive en el Apple ID.
  // Se llama tras iniciar sesión o crear cuenta: es lo que evita que alguien que
  // pagó pierda lo que pagó al cambiar de cuenta (p.ej. después de eliminar la
  // anterior). restorePurchases() adjunta el recibo del dispositivo al appUserID
  // actual, y el servidor lo confirma contra la REST API de RevenueCat.
  // Silencioso salvo que SÍ encuentre una compra: tras un registro normal (sin
  // compra) no debe salir ningún aviso.
  async function _revincularCompra(email) {
    if (!esNativo() || !email) return false;
    try {
      const RC = await rcInit(email);                 // logIn: aliasa lo anónimo
      let premium = false;
      try {
        const r = await conTimeout(RC.restorePurchases(), TIMEOUT_OFFERINGS_MS, null);
        premium = entitlementActiva((r && (r.customerInfo || r)) || null);
      } catch (_) {}
      // El servidor manda: verifica la entitlement server-side y marca la cuenta.
      try {
        const rs = await fetch('/api/payments/revenuecat/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const j = await rs.json().catch(() => ({}));
        if (j && typeof j.premium === 'boolean') premium = j.premium;
      } catch (_) {}
      _sdkPremium = premium;
      if (premium) {
        toast('Recuperamos tu suscripción y quedó ligada a esta cuenta.', 'success', 6000);
        try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
      }
      return premium;
    } catch (_) { return false; }
  }

  // -------------------------------------------------- RevenueCat (nativo)
  function rcPlugin() {
    const P = (Caps && Caps.Plugins) || {};
    return P.Purchases || P.PurchasesPlugin || P.RevenueCat || null;
  }
  let _rcConfigured = false;   // configure() se llama UNA sola vez (evita warning/reset del SDK)
  let _rcUser = null;          // último appUserID identificado (para no repetir logIn)
  async function rcInit(email) {
    const RC = rcPlugin();
    if (!RC) throw new Error('El módulo de compras no está disponible en esta versión.');
    const key = plataforma() === 'ios' ? window.MP_REVENUECAT_KEY_IOS : window.MP_REVENUECAT_KEY_ANDROID;
    if (!key) throw new Error('Configuración de compras incompleta.');
    if (!_rcConfigured) {
      // Arranca ANÓNIMO si no hay correo: se puede comprar sin cuenta.
      try { await RC.configure({ apiKey: key, appUserID: email || undefined }); _rcConfigured = true; } catch (_) {}
    }
    // Identifica al usuario SOLO si inició sesión (opcional, para multi-dispositivo).
    if (email && email !== _rcUser && RC.logIn) {
      try { await RC.logIn({ appUserID: email }); _rcUser = email; } catch (_) {}
    }
    return RC;
  }
  // Carga los paquetes del offering actual, ordenados mensual → anual → de por vida
  async function cargarPaquetes(email) {
    const RC = await rcInit(email);
    const offerings = await RC.getOfferings();
    const current = offerings && (offerings.current || (offerings.all && (offerings.all.default || Object.values(offerings.all)[0])));
    const pkgs = (current && current.availablePackages) || [];
    if (!pkgs.length) throw new Error('No hay planes disponibles por ahora.');
    const orden = { MONTHLY: 0, ANNUAL: 1, LIFETIME: 2 };
    return pkgs.slice().sort((a, b) => (orden[a.packageType] ?? 9) - (orden[b.packageType] ?? 9));
  }

  // El usuario cerró la hoja de pago: no es un error, no mostrar alerta roja
  function esCancelacion(e) {
    if (!e) return false;
    if (e.userCancelled === true) return true;
    const m = String((e.message || '') + ' ' + (e.code || '')).toLowerCase();
    return m.includes('cancel');
  }

  async function comprarNativo(email, pkg) {
    const RC = await rcInit(email);
    await RC.purchasePackage({ aPackage: pkg });          // abre la hoja de pago nativa
    _sdkPremium = true;                                   // compra ok: desbloqueo local inmediato
    // Solo si hay sesión (correo) confirmamos server-side (fuente de verdad +
    // multi-dispositivo). En compra ANÓNIMA no hay a quién sincronizar: la
    // entitlement del SDK (validada por RevenueCat en el dispositivo) basta.
    if (email) {
      try {
        await fetch('/api/payments/revenuecat/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
      } catch (_) {}
    }
  }

  // CustomerInfo del SDK (estado local inmediato; el servidor sigue siendo la
  // fuente de verdad vía /api/payments/revenuecat/sync)
  async function customerInfo() {
    if (!esNativo()) return null;
    try {
      const RC = await rcInit(await emailActual());
      const r = await RC.getCustomerInfo();
      return (r && r.customerInfo) || r || null;
    } catch (_) { return null; }
  }
  function entitlementActiva(info) {
    const act = (info && info.entitlements && info.entitlements.active) || {};
    const nombre = window.MP_RC_ENTITLEMENT || 'premium';
    return !!(act[nombre] || act['premium'] || act['Mi Portafolio']);
  }
  async function restaurar() {
    if (!esNativo()) return { ok: false, error: 'Solo en la app' };
    const email = await emailActual();
    const RC = await rcInit(email);
    const r = await RC.restorePurchases();
    // Fuente inmediata: la entitlement del SDK tras restaurar (funciona anónimo).
    let premium = entitlementActiva((r && (r.customerInfo || r)) || null);
    // Si hay sesión, el servidor confirma (multi-dispositivo).
    if (email) {
      try {
        const rs = await fetch('/api/payments/revenuecat/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const j = await rs.json();
        if (j && typeof j.premium === 'boolean') premium = j.premium;
      } catch (_) {}
    }
    _sdkPremium = premium;
    if (premium) {
      cerrar(true);   // también libera el candado
      toast('Tu suscripción se restauró correctamente.');
      try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
    } else {
      cerrar();       // en modo bloqueante NO cierra
      toast('No encontramos una suscripción activa para restaurar.');
    }
    return { ok: true, premium: premium };
  }

  // -------------------------------------------------- MercadoPago (web)
  async function comprarWeb(email, ciclo) {
    const r = await fetch('/api/payments/suscribir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ciclo: ciclo || 'mensual' })
    });
    const j = await r.json();
    if (j && j.checkout_url) { window.location.href = j.checkout_url; return; }
    throw new Error((j && j.error) || 'No se pudo iniciar el pago.');
  }

  // -------------------------------------------------- UI
  function toast(msg, tipo, duracion) {
    // window.toast lo define ux_helpers.js (se carga antes que este archivo).
    // Se reenvía la duración: los mensajes de error de envío son largos y con
    // los 3.5s por defecto no alcanzan a leerse.
    try { if (window.toast) return window.toast(msg, tipo || 'info', duracion); } catch (_) {}
    try { if (window.MP && MP.toast) return MP.toast(msg); } catch (_) {}
    alert(msg);
  }

  let _overlay = null;
  let _bloqueante = false;   // hard paywall: prueba vencida sin premium
  let _email = '';           // correo de la sesión o capturado en el paywall
  let _pkgs = [];            // paquetes del offering actual (nativo)
  function cerrar(force) {
    if (_bloqueante && force !== true) return;   // no se puede cerrar el candado
    const habia = !!_overlay;
    if (_overlay) { _overlay.remove(); _overlay = null; }
    _bloqueante = false;
    // Al cerrar, re-consultar el estado: si la compra ocurrió dentro del
    // paywall, el botón del header debe pasar a "Premium ✓" sin recargar.
    if (habia) setTimeout(() => { try { verificarAcceso(); } catch (_) {} }, 60);
  }

  const BENEFICIOS = [
    'Portafolio óptimo y frontera eficiente',
    'Simulación Monte Carlo y plan de rebalanceo',
    'Análisis profundo (Deep Dive) y valuación SML',
    'Screener avanzado y ranking por score',
    'Reporte mensual en PDF y alertas',
  ];

  function vista(email, premium, bloqueante) {
    const nativo = esNativo();
    const benef = BENEFICIOS.map(b =>
      `<li style="display:flex;gap:8px;align-items:flex-start;margin:6px 0">
         <span style="color:var(--sello);flex:0 0 auto">✓</span><span>${b}</span></li>`).join('');

    if (premium) {
      const gestion = nativo
        ? `<button data-x="manage" style="${BTN_SEC};margin-bottom:8px">Gestionar suscripción</button>` : '';
      return `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700">Tu suscripción está activa ✓</h2>
        <p style="color:var(--tinta-3);margin:0 0 18px">Tienes acceso a todas las funciones. ¡Gracias por tu apoyo!</p>
        ${gestion}<button data-x="close" style="${BTN_SEC}">Cerrar</button>`;
    }

    // Bloque legal/precio según plataforma
    const bloquePrecio = nativo
      ? `<p style="color:var(--tinta-3);font-size:13px;margin:6px 0 0">
           Elige tu plan. Las suscripciones se renuevan automáticamente y puedes cancelarlas
           cuando quieras desde los Ajustes de tu cuenta de ${plataforma() === 'ios' ? 'App Store' : 'Google Play'}.
           El plan Ilimitado es un pago único, sin renovación.</p>`
      : `<div style="font-size:28px;font-weight:800;margin:2px 0">14 días gratis</div>
         <p style="color:var(--tinta-3);font-size:13px;margin:6px 0 0">
           Luego elige tu plan. Las suscripciones se renuevan automáticamente
           (cada mes o cada año, según el plan) hasta que canceles. Cancela en un
           click, sin permanencia. Pago seguro con MercadoPago.</p>`;

    /* Web SIN sesión. Antes aquí se capturaba el correo para mandar un magic
       link; ahora se manda a la pantalla de acceso, que es la única que crea
       cuentas (correo + contraseña) y la que lleva el antibot.

       No es un paso de más: MercadoPago necesita el correo del pagador y la
       suscripción se liga a la cuenta, así que en algún momento hay que tenerla.
       Pedirla aquí con un segundo formulario solo servía para tener dos sitios
       donde escribir el correo y uno de ellos sin contraseña. */
    const captura = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <button data-x="login-opcional" style="${BTN_PRI}">Crear cuenta o iniciar sesión</button>
        <p style="color:var(--tinta-4);font-size:11px;margin:2px 0 0;text-align:center;line-height:1.5">
          Tu suscripción queda ligada a tu cuenta, así que la puedes usar
          en cualquier dispositivo.</p>
      </div>`;

    // Link de login OPCIONAL en nativo: sincroniza Premium entre dispositivos.
    // NO es requisito para comprar (se puede pagar con el usuario anónimo).
    const loginOpcional = `<button data-x="login-opcional"
        style="background:none;border:0;color:var(--tinta-4);font-size:12px;text-decoration:underline;cursor:pointer;padding:8px 0 0;width:100%">
        ${email ? 'Sesión iniciada: ' + email : '¿Ya tienes cuenta? Inicia sesión para sincronizar'}</button>`;

    // NATIVO: planes directos (compra sin cuenta) + restaurar + login opcional.
    // WEB: si hay correo, botón de prueba; si no, captura de correo para MercadoPago.
    const cta = nativo
      ? `<div data-x="planes" style="display:flex;flex-direction:column;gap:8px">${
             // Se siembra con los precios de referencia (no con "Cargando…") por
             // si _cargarPlanesEnOverlay nunca llega a correr: la pantalla de
             // compra jamás debe quedar vacía (Guideline 2.1(b)).
             _htmlPlanesRef('')
           }</div>
         <button data-x="restore" style="${BTN_SEC}">Restaurar compra</button>
         ${loginOpcional}`
      : email
      ? `<div data-x="planes-web" style="display:flex;flex-direction:column;gap:8px">${
             // Sembrado con los precios de referencia (no con "Cargando…") por
             // si _cargarPlanesWeb no llega a correr: la pantalla de compra
             // nunca debe quedar vacía.
             PLANES_WEB_REF.map(_botonPlan).join('')
           }</div>`
      : captura;

    const legal = _legalHTML();

    const titulo = bloqueante ? 'Tu prueba terminó' : 'Suscríbete a Mi Portafolio';
    const subtitulo = bloqueante
      ? 'Suscríbete para seguir usando Mi Portafolio.'
      : 'Desbloquea todo el análisis profesional.';
    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">${titulo}</h2>
      <p style="color:var(--tinta-3);margin:0 0 14px;font-size:14px">${subtitulo}</p>
      ${bloquePrecio}
      <ul style="list-style:none;padding:0;margin:16px 0;font-size:14px;color:var(--tinta-2)">${benef}</ul>
      <div style="display:flex;flex-direction:column;gap:8px">${cta}</div>
      ${legal}`;
  }

  const BTN_PRI = 'width:100%;background:var(--sello-solido);color:var(--sup);font-weight:600;border:1px solid var(--sello-solido);border-radius:var(--radio-tarjeta);padding:14px;font-size:15px;cursor:pointer;font-family:inherit;letter-spacing:-.005em';
  const BTN_SEC = 'width:100%;background:transparent;color:var(--tinta-1);font-weight:600;border:1px solid var(--regla-fuerte);border-radius:var(--radio-tarjeta);padding:12px;font-size:14px;cursor:pointer;font-family:inherit';
  // font-size:16px en inputs evita el auto-zoom de iOS al enfocar.
  const INP = 'width:100%;background:var(--sup-panel);border:1px solid var(--regla-fuerte);border-radius:var(--radio-tarjeta);padding:13px 14px;font-size:16px;color:var(--tinta-1);outline:none;box-sizing:border-box';
  const BTN_LINK = 'background:none;border:0;color:var(--tinta-4);font-size:12px;text-decoration:underline;cursor:pointer;padding:6px 0;width:100%';

  // El correo se interpola en varias plantillas de este archivo; lo escapamos
  // para no romper el HTML con un valor raro tecleado en el input.
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // En nativo el bundle local no sirve /terminos ni /privacidad (el WKWebView
  // caería al index): se enlaza a la web de producción y el click se abre con
  // el plugin Browser (ver act === 'legal' en los handlers).
  function _legalHTML(prefijo) {
    const base = esNativo() ? (window.MP_API_BASE || 'https://miportafolio.uk').replace(/\/$/, '') : '';
    const intro = prefijo || 'Al continuar aceptas los';
    return `<p style="color:var(--tinta-4);font-size:11px;margin:14px 0 0;text-align:center">${intro} <a href="${base}/terminos" data-x="legal" style="color:var(--tinta-4)">Términos</a> y la <a href="${base}/privacidad" data-x="legal" style="color:var(--tinta-4)">Privacidad</a>.</p>`;
  }
  async function _abrirLegal(ev, el) {
    if (!esNativo()) return;                    // web: navegación normal del <a>
    ev.preventDefault();
    const url = el.getAttribute('href');
    const B = (Caps && Caps.Plugins && Caps.Plugins.Browser);
    // Si el plugin Browser falla, se cae a window.open en vez de no hacer nada:
    // Apple exige que los links a Términos y Privacidad funcionen (3.1.2), y un
    // toque que no abre nada se lee como app incompleta (2.2).
    try {
      if (B && B.open) await B.open({ url });
      else window.open(url, '_blank');
    } catch (_) {
      try { window.open(url, '_blank'); } catch (_) {}
    }
  }

  // Portal de gestión de la suscripción (App Store / Google Play). Lo usa el
  // paywall y también la pantalla "Mi cuenta".
  async function abrirGestion() {
    try {
      const info = await conTimeout(customerInfo(), TIMEOUT_OFFERINGS_MS, null);
      const url = (info && info.managementURL) || 'https://apps.apple.com/account/subscriptions';
      const B = (Caps && Caps.Plugins && Caps.Plugins.Browser);
      if (B && B.open) await B.open({ url }); else window.open(url, '_blank');
    } catch (_) { toast('No se pudo abrir la gestión de suscripción.', 'error'); }
  }

  // Aviso global de "la sesión cambió" (login OTP, alta con contraseña, logout,
  // borrado de cuenta): quien lo escuche se re-renderiza SIN recargar.
  function notificarSesion() {
    try { window.dispatchEvent(new Event('mp:sesion-actualizada')); } catch (_) {}
  }

  // ---------------------------------------------- planes (offerings + fallback)
  const NOMBRE_PLAN = { MONTHLY: 'Mensual', ANNUAL: 'Anual', LIFETIME: 'Ilimitado' };

  // Un botón de plan. `o.idx` presente = paquete real de RevenueCat; ausente =
  // precio de referencia (el handler de compra resuelve el paquete al tocarlo).
  function _botonPlan(o) {
    const destacado = o.tipo === 'ANNUAL' || o.ciclo === 'anual';
    // Badge de ahorro: $650/año vs $65×12 = 2 meses gratis (LANZAMIENTO §1.2)
    const izquierda = o.badge
      ? `<span style="display:flex;flex-direction:column;align-items:flex-start;gap:2px">
           <span>${o.nombre}</span>
           <span style="background:rgba(26,26,24,.14);color:${destacado ? MP_COLOR.sup : MP_COLOR.sello};border:1px solid ${destacado ? 'rgba(26,26,24,.35)' : 'rgba(156,93,18,.4)'};font-family:IBM Plex Mono,ui-monospace,monospace;font-size:9px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:999px;white-space:nowrap">${o.badge}</span>
         </span>`
      : `<span>${o.nombre}</span>`;
    const pkgAttr = (o.idx == null) ? '' : ` data-pkg="${o.idx}"`;
    // data-ciclo sólo lo llevan los planes de web: es lo que se manda a
    // /api/payments/suscribir para elegir mensual o anual.
    const cicloAttr = o.ciclo ? ` data-ciclo="${o.ciclo}"` : '';
    return `<button data-x="buy" data-plan="${o.tipo || ''}"${pkgAttr}${cicloAttr}
      style="${destacado ? BTN_PRI : BTN_SEC};display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left">
      ${izquierda}<span style="font-weight:800;white-space:nowrap">${o.precio}${o.sufijo}</span>
    </button>`;
  }

  const NOTA = 'color:var(--tinta-4);font-size:11px;text-align:center;margin:6px 0 0;line-height:1.5';

  // Error inline dentro del bloque de planes (msg vacío = lo limpia).
  // Devuelve false si no hay dónde pintarlo (p.ej. paywall web).
  function _errEnPlanes(msg) {
    const c = _overlay && _overlay.querySelector('[data-x="planes"]');
    if (!c) return false;
    let p = c.querySelector('[data-x="err-compra"]');
    if (!msg) { if (p) p.remove(); return true; }
    if (!p) {
      p = document.createElement('p');
      p.setAttribute('data-x', 'err-compra');
      p.style.cssText = 'color:var(--baja);font-size:12px;text-align:center;margin:8px 0 0;line-height:1.5';
      c.appendChild(p);
    }
    p.textContent = msg;
    return true;
  }

  function _htmlPlanesRef(nota) {
    return PLANES_REF.map(p => _botonPlan(p)).join('') + (nota || '');
  }

  function _htmlPlanesReales(pkgs) {
    return pkgs.map((p, i) => {
      const prod = p.product || {};
      return _botonPlan({
        idx: i,
        tipo: p.packageType || '',
        nombre: NOMBRE_PLAN[p.packageType] || prod.title || p.identifier,
        precio: prod.priceString || '',
        sufijo: p.packageType === 'MONTHLY' ? '/mes'
              : p.packageType === 'ANNUAL'  ? '/año'
              : p.packageType === 'LIFETIME' ? ' · pago único' : '',
        badge: p.packageType === 'ANNUAL' ? '2 meses gratis vs mensual' : '',
      });
    }).join('');
  }

  // Renderiza los paquetes del offering en el overlay abierto (usa _email como
  // appUserID vía rcInit dentro de cargarPaquetes).
  //
  // La pantalla NUNCA queda vacía ni en "Cargando…": se pintan de inmediato los
  // 3 planes con precios de referencia y, cuando RevenueCat responde (o falla /
  // vence el timeout de 10 s), se sustituyen por los reales o se deja el aviso
  // con botón de reintento. Requisito del rechazo 2.1(b).
  function _cargarPlanesEnOverlay() {
    if (!_overlay) return;
    const cont = _overlay.querySelector('[data-x="planes"]');
    if (!cont) return;
    cont.innerHTML = _htmlPlanesRef(
      `<p style="${NOTA}">Confirmando precios con la App Store…</p>`);

    let vencido = false;
    const reloj = new Promise((_, rej) => setTimeout(() => {
      vencido = true; rej(new Error('timeout'));
    }, TIMEOUT_OFFERINGS_MS));

    Promise.race([cargarPaquetes(_email), reloj]).then((pkgs) => {
      // Log para depurar en dispositivo físico (Safari → Web Inspector).
      console.info('[MPPaywall] offerings OK ·', pkgs.length, 'paquetes ·',
        pkgs.map(p => (p.packageType || '?') + '=' + (((p.product || {}).priceString) || '?')).join(' '));
      _pkgs = pkgs;
      const c = _overlay && _overlay.querySelector('[data-x="planes"]');
      if (c) c.innerHTML = _htmlPlanesReales(pkgs);
    }).catch((e) => {
      const motivo = vencido ? 'timeout ' + TIMEOUT_OFFERINGS_MS + 'ms' : ((e && e.message) || 'error');
      console.info('[MPPaywall] offerings FALLO ·', motivo,
        '· plataforma=' + plataforma(),
        '· plugin=' + !!rcPlugin(),
        '· key=' + !!(plataforma() === 'ios' ? window.MP_REVENUECAT_KEY_IOS : window.MP_REVENUECAT_KEY_ANDROID));
      const c = _overlay && _overlay.querySelector('[data-x="planes"]');
      if (!c) return;
      c.innerHTML = _htmlPlanesRef(
        `<p style="color:var(--sello);font-size:12px;text-align:center;margin:8px 0 0;line-height:1.5">
           No pudimos confirmar los precios con la App Store. Los de arriba son de referencia;
           al comprar verás el precio exacto de tu región.</p>
         <button data-x="reintentar-planes" style="${BTN_SEC};margin-top:8px">Reintentar</button>`);
    });
  }

  // Planes de WEB desde el backend (/api/payments/estado). El backend es la
  // única fuente de precio: si alguien cambia MERCADOPAGO_PRECIO_ANUAL_MXN, el
  // paywall lo refleja sin tocar este archivo, y nunca puede anunciar un precio
  // distinto al que se cobra en el checkout. Si falla, se quedan los de
  // referencia ya pintados (no se vacía ni se bloquea la compra).
  function _cargarPlanesWeb() {
    if (!_overlay || esNativo()) return;
    conTimeout((async () => {
      const r = await fetch('/api/payments/estado', { cache: 'no-store' });
      return await r.json();
    })(), TIMEOUT_RED_MS, null).then((cfg) => {
      const planes = cfg && Array.isArray(cfg.planes) ? cfg.planes : null;
      if (!planes || !planes.length) return;
      const c = _overlay && _overlay.querySelector('[data-x="planes-web"]');
      if (!c) return;
      c.innerHTML = planes.map(p => _botonPlan({
        ciclo: p.ciclo,
        nombre: p.nombre,
        precio: '$' + Number(p.precio_mxn).toLocaleString('es-MX') + ' MXN',
        sufijo: p.sufijo,
        badge: p.badge,
      })).join('');
    }).catch(() => { /* se quedan los de referencia */ });
  }

  // Cada plataforma confirma sus precios con su propia fuente: la tienda vía
  // RevenueCat en nativo, el backend en web.
  function _cargarPlanes() {
    if (esNativo()) _cargarPlanesEnOverlay(); else _cargarPlanesWeb();
  }

  /* Aquí vivía el login por código OTP de 6 dígitos: _pedirOTP(), la pantalla
     del código, la de "no pudimos enviarte el código" y sus tres botones.

     Se retira con el magic link. Las dos eran vías de entrar SIN CONTRASEÑA
     —quien leyera el correo entraba— y además creaban la cuenta si el correo no
     existía, o sea que cada una era otro trial de 14 días por regalar y otra
     puerta que mantener a la par de las defensas del registro.

     Ahora hay una sola: correo + contraseña, la que pinta abrirAuth(). Sus
     rutas en el backend ya no existen (app.py, "UNA SOLA PUERTA"), así que
     dejar estas pantallas habría sido ofrecer un flujo que responde 404. */

  // El overlay se monta SIN esperar a la red. Antes `abrir()` hacía dos awaits
  // (estado de sesión + entitlement del SDK) ANTES de crear el nodo: si el
  // backend estaba en cold start o el plugin de compras no respondía, tocar
  // "Suscribirse" no mostraba absolutamente nada. Ahora se pinta al instante
  // con el último estado conocido y, cuando la sesión/entitlement resuelven, se
  // re-pinta el cuerpo. (Guideline 2.1(b): el paywall no puede ser invisible.)
  function abrir(opts) {
    const bloqueante = !!(opts && opts.bloqueante);
    if (_overlay && _bloqueante) return;      // el candado ya está en pantalla
    cerrar(true);
    _bloqueante = bloqueante;
    const premium = false;                    // optimista: se corrige al resolver

    const btnCerrar = bloqueante ? '' :
      `<button data-x="close" aria-label="Cerrar" style="position:absolute;top:14px;right:14px;background:transparent;border:0;color:var(--tinta-4);font-size:22px;cursor:pointer;line-height:1">×</button>`;
    _overlay = document.createElement('div');
    _overlay.setAttribute('role', 'dialog');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(26,26,24,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    _overlay.innerHTML = `
      <div style="position:relative;max-width:420px;width:100%;background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:24px;color:var(--tinta-1);font-family:system-ui,-apple-system,sans-serif;max-height:90vh;overflow:auto">
        ${btnCerrar}
        <div data-x="body">${vista(_email, premium, bloqueante)}</div>
      </div>`;
    document.body.appendChild(_overlay);
    const _propio = _overlay;                 // para no re-pintar un overlay ya cerrado

    if (!premium) _cargarPlanes();   // nativo: planes aunque NO haya correo (anónimo)

    // Sesión y entitlement EN SEGUNDO PLANO: si cambian algo, se re-pinta.
    (async () => {
      const e = await estadoUsuario();
      const email = (e && e.email) ? String(e.email).toLowerCase() : '';
      let esPrem = _premiumEfectivo(e);
      // El SDK solo se consulta si hay sesión: sin ella no se afirma premium.
      if (!esPrem && esNativo() && e && e.autenticado) esPrem = await refrescarSDKPremium();
      if (_overlay !== _propio) return;                      // se cerró o se reabrió
      if (email === _email && !esPrem) return;               // nada nuevo que pintar
      _email = email;
      const body = _propio.querySelector('[data-x="body"]');
      if (!body) return;
      body.innerHTML = vista(_email, esPrem, _bloqueante);
      if (!esPrem) _cargarPlanes();
    })();

    // Enter en el campo de correo = Continuar; en el de código = Verificar
    _overlay.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !ev.target || !ev.target.getAttribute) return;
      const dx = ev.target.getAttribute('data-x');
      const destino = dx === 'email-input' ? 'email-continuar' : null;
      if (!destino) return;
      ev.preventDefault();
      const b = _overlay.querySelector(`[data-x="${destino}"]`);
      if (b) b.click();
    });

    _overlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-x]');
      if (!el) { if (ev.target === _overlay) cerrar(); return; }
      const act = el.getAttribute('data-x');
      if (act === 'close') return cerrar();
      if (act === 'legal') return _abrirLegal(ev, el);
      if (act === 'manage') return void abrirGestion();
      if (act === 'reintentar-planes') { _cargarPlanesEnOverlay(); return; }
      if (act === 'restore') {
        el.disabled = true; el.textContent = 'Restaurando…';
        try { await restaurar(); } catch (e) { toast(e.message || 'Error al restaurar'); el.disabled = false; el.textContent = 'Restaurar compra'; }
        return;
      }
      if (act === 'login-opcional') {
        /* Antes esto pintaba su propia captura de correo y mandaba un código o
           un enlace. Ya no: iniciar sesión es UNA pantalla en toda la app, la de
           correo + contraseña, y tener una segunda versión aquí era mantener dos
           formularios de acceso que podían divergir.

           Tampoco es "opcional" desde que el candado exige cuenta para usar la
           app: entrar es el camino, no un extra para sincronizar. */
        _authModo = 'ingresar';
        cerrar(true);
        abrirAuth();
        return;
      }
      // 'volver' ("Volver a los planes") existía para las pantallas del código
      // OTP, que ya no están. Sin ningún botón que lo emita, se retira.
      /* 'email-continuar' pedía el correo aquí y mandaba un código (nativo) o un
         magic link (web). Las dos vías se retiraron: hay una sola pantalla de
         acceso y es la de correo + contraseña. El botón que llevaba aquí ahora
         abre esa pantalla directamente. */

      if (act === 'buy') {
        // La compra en nativo SIEMPRE va ligada a la cuenta (sin ruta anónima):
        // si no hay sesión, se envía a crear cuenta / iniciar sesión primero.
        if (esNativo() && !_email) { cerrar(true); abrirAuth(); return; }
        // innerHTML (no textContent): los botones de plan llevan nombre, badge
        // y precio como nodos; con textContent se perdían al restaurar.
        el.disabled = true; const prev = el.innerHTML; el.textContent = 'Procesando…';
        _errEnPlanes('');
        try {
          if (esNativo()) {
            const idxAttr = el.getAttribute('data-pkg');
            let pkg = (idxAttr == null) ? null : _pkgs[parseInt(idxAttr, 10)];
            if (!pkg) {
              // Botón con precio de REFERENCIA (RevenueCat no había respondido):
              // se intenta cargar el offering ahora y comprar el plan elegido.
              const tipo = el.getAttribute('data-plan') || '';
              try {
                const pkgs = await Promise.race([cargarPaquetes(_email), rechazaEn(TIMEOUT_OFFERINGS_MS)]);
                _pkgs = pkgs;
                pkg = pkgs.filter(p => p.packageType === tipo)[0] || null;
              } catch (_) { pkg = null; }
            }
            if (!pkg) throw new Error('No pudimos conectar con la App Store para completar la compra. Revisa tu conexión e intenta de nuevo.');
            await comprarNativo(_email, pkg);   // _email siempre presente (compra ligada a la cuenta)
            cerrar(true);   // compra hecha: libera también el candado
            toast('¡Listo! Tu suscripción está activa.');
            try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
          } else {
            if (!_email) { toast('Escribe tu correo para continuar.'); el.disabled = false; el.innerHTML = prev; return; }
            // Sin data-ciclo (paywall viejo cacheado) se cae al mensual, que es
            // el comportamiento previo.
            const ciclo = el.getAttribute('data-ciclo') || 'mensual';
            await comprarWeb(_email, ciclo);   // redirige al checkout de MercadoPago
          }
        } catch (e) {
          el.disabled = false; el.innerHTML = prev;
          if (esCancelacion(e)) return;  // cerró la hoja de pago: silencioso
          // Inline: el toast vive detrás del overlay en algunos casos, y el
          // error de una compra tiene que verse sí o sí.
          const msg = e.message || 'No se pudo completar la compra.';
          if (!_errEnPlanes(msg)) toast(msg);
        }
      }
    });
  }

  // Ejecuta fn solo si el usuario es premium; si no, abre el paywall.
  async function requierePremium(fn) {
    if (await esPremium()) { return fn && fn(); }
    abrir();
    return null;
  }

  // Auto-bind de cualquier botón [data-mp-paywall]
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-mp-paywall]');
    if (el) { ev.preventDefault(); abrir(); }
  });

  // ------------------------------------------------ AUTH in-app (correo+contraseña)
  // Flujo PRINCIPAL de la app nativa: crea sesión DENTRO de la app (JWT guardado
  // en localStorage 'mp.jwt.v1', que el wrapper de fetch envía como Bearer) sin
  // depender del magic-link/Safari. El trial de 14 días se cuenta POR CUENTA en
  // el servidor (creado_en). En web NO se fuerza esta pantalla.
  let _authOverlay = null;
  let _authModo = 'registro';   // 'registro' | 'ingresar'
  function cerrarAuth() { if (_authOverlay) { _authOverlay.remove(); _authOverlay = null; } }

  function _authCuerpo(err) {
    const reg = _authModo === 'registro';
    const errHTML = err ? `<p style="color:var(--baja);font-size:13px;margin:0 0 10px">${err}</p>` : '';
    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">${reg ? 'Crea tu cuenta' : 'Inicia sesión'}</h2>
      <p style="color:var(--tinta-3);margin:0 0 14px;font-size:14px">${reg ? '14 días gratis. Sin tarjeta.' : 'Bienvenido de vuelta.'}</p>
      ${errHTML}
      <div style="display:flex;flex-direction:column;gap:8px">
        <input data-x="auth-email" type="email" inputmode="email" autocapitalize="none" autocorrect="off" autocomplete="username"
          placeholder="tu@correo.com" style="${INP}">
        <input data-x="auth-pass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"
          placeholder="Contraseña (mín. 8)" style="${INP}">
        <!-- SOLO correo y contraseña. El teléfono se pidió un tiempo para
             verificar por SMS, pero eso costaba dinero por cada registro y las
             cuotas por IP y por dispositivo hacen el mismo trabajo gratis: un
             campo más que no defiende nada solo estorba al que se registra. -->
        ${reg ? `
        <!-- Turnstile se pinta aquí (solo web). El hueco existe siempre para no
             mover el layout cuando aparece. -->
        <div data-x="turnstile" style="min-height:0"></div>` : ''}
        <button data-x="auth-submit" style="${BTN_PRI}">${reg ? 'Crear cuenta' : 'Entrar'}</button>
        <button data-x="auth-toggle" style="${BTN_LINK}">${reg ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Crea una gratis'}</button>
        <!-- Los planes y precios se pueden consultar SIN cuenta: esta pantalla
             es lo primero que ve el revisor de Apple y no debe esconder las
             compras in-app (Guideline 2.1(b)). La compra sí pide cuenta. -->
        <button data-x="auth-planes" style="${BTN_SEC}">Ver planes y precios</button>
      </div>
      <!-- Quien ya compró y llega aquí sin cuenta (p.ej. eliminó la anterior)
           necesita saber que su compra no se perdió: al entrar se re-vincula
           sola con _revincularCompra(). -->
      <p style="color:var(--tinta-4);font-size:11px;margin:12px 0 0;text-align:center;line-height:1.5">
        ¿Ya compraste una suscripción? Entra o crea tu cuenta y la recuperamos
        automáticamente.</p>
      ${_legalHTML()}`;
  }

  /* Pantalla del código. Es su propio cuerpo, no un campo más del formulario:
     al llegar aquí la cuenta TODAVÍA no existe —el servidor solo guardó un
     registro pendiente— y hay que dejar claro que el paso que falta es el SMS,
     con la vía de salida por si el número estaba mal. */
  /* La pantalla de "escribe el código" del registro por SMS vivía aquí. Se
     retira junto con el campo de teléfono: sin nada que la invoque, era código
     muerto en la ruta más sensible de la app. La verificación por SMS sigue en
     el backend (auth.solicitar_registro_telefono) por si algún día se retoma.

     El registro es ahora correo + contraseña, y punto. */

  /* ── Turnstile: el antibot del registro (SOLO web) ───────────────────────
     El backend verifica el token contra siteverify; aquí solo se pinta el
     widget y se lee lo que emite.

     TODO ESTE BLOQUE ES A PRUEBA DE FALLOS A PROPÓSITO. Es una defensa
     opcional montada sobre la pantalla que impide usar la app sin cuenta, y ya
     pasó una vez que un error aquí tumbara esa pantalla y dejara entrar a
     cualquiera. Un antibot que no carga debe degradar a "sin antibot" —el
     servidor sigue teniendo las cuotas por IP y por dispositivo—, nunca a "sin
     candado". De ahí que ninguna de estas funciones pueda lanzar.

     En nativo no aplica: no hay navegador que resolver el reto y las cuotas por
     dispositivo (IDFV) cubren esa puerta. */
  let _tsWidgetId = null;
  let _tsScriptPedido = false;

  const _tsAplica = () => !!_tsSitekey && !esNativo();

  function _tsCargarScript() {
    if (_tsScriptPedido || window.turnstile) return;
    _tsScriptPedido = true;
    try {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true;
      // Al llegar el script el hueco ya está pintado: hay que montar de nuevo.
      s.onload = () => _tsMontar();
      s.onerror = () => { _tsScriptPedido = false; };   // sin widget, no sin registro
      document.head.appendChild(s);
    } catch (_) { _tsScriptPedido = false; }
  }

  function _tsMontar() {
    try {
      if (!_tsAplica()) return;
      // Solo el modo registro tiene hueco; "ingresar" no lleva antibot.
      const hueco = _authOverlay && _authOverlay.querySelector('[data-x="turnstile"]');
      if (!hueco) return;
      if (!window.turnstile) { _tsCargarScript(); return; }
      hueco.innerHTML = '';
      _tsWidgetId = window.turnstile.render(hueco, {
        sitekey: _tsSitekey,
        action: 'turnstile-spin-v1',
        theme: 'auto',
        size: 'flexible',
      });
    } catch (_) { _tsWidgetId = null; }
  }

  /* Cadena vacía si no hay widget. El backend distingue "no configurado" de
     "token inválido", así que un vacío no cierra el registro por su cuenta. */
  function _tsToken() {
    try {
      if (!_tsAplica() || !window.turnstile || _tsWidgetId == null) return '';
      return window.turnstile.getResponse(_tsWidgetId) || '';
    } catch (_) { return ''; }
  }

  // Los tokens son de un solo uso: tras un error hay que pedir otro.
  function _tsReiniciar() {
    try {
      if (window.turnstile && _tsWidgetId != null) window.turnstile.reset(_tsWidgetId);
    } catch (_) {}
  }

  function abrirAuth() {
    /* `isConnected`, no solo "existe": si el nodo se sacó del DOM sin pasar por
       cerrarAuth(), la referencia sigue viva apuntando a un nodo desconectado y
       este return dejaba el candado imposible de volver a pintar —la pantalla
       que impide usar la app sin cuenta, inutilizada por una variable obsoleta.
       Con isConnected se vuelve a montar en cuanto no está puesto de verdad. */
    if (_authOverlay && _authOverlay.isConnected) return;
    _authOverlay = null;
    cerrar(true);                     // no dejar el paywall abierto detrás
    _authOverlay = document.createElement('div');
    _authOverlay.setAttribute('role', 'dialog');
    _authOverlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--sup);display:flex;align-items:center;justify-content:center;padding:16px';
    _authOverlay.innerHTML = `<div style="max-width:420px;width:100%;background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:24px;color:var(--tinta-1);font-family:system-ui,-apple-system,sans-serif;max-height:92vh;overflow:auto"><div data-x="auth-body">${_authCuerpo('')}</div></div>`;
    document.body.appendChild(_authOverlay);
    _tsMontar();

    _authOverlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { const b = _authOverlay.querySelector('[data-x="auth-submit"]'); if (b) { ev.preventDefault(); b.click(); } }
    });

    _authOverlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-x]'); if (!el) return;
      const act = el.getAttribute('data-x');
      if (act === 'legal') return _abrirLegal(ev, el);
      // Repintar el cuerpo destruye el nodo del widget, así que se vuelve a
      // montar después de cada repintado (error, cambio de modo…).
      const setErr = (m) => {
        const b = _authOverlay && _authOverlay.querySelector('[data-x="auth-body"]');
        if (b) { b.innerHTML = _authCuerpo(m); _tsMontar(); }
      };
      if (act === 'auth-toggle') {
        _authModo = (_authModo === 'registro') ? 'ingresar' : 'registro';
        setErr('');
        return;
      }
      if (act === 'auth-planes') {
        // El paywall se monta ENCIMA del gate (z 99999 > 99998); al cerrarlo se
        // vuelve a esta pantalla. No cerramos el gate para no perder el paso.
        abrir();
        return;
      }

      /* Éxito: guarda el JWT, cierra y re-vincula la compra si la hay. Lo usan
         el login normal y la confirmación del código, así que vive aparte. */
      const entrar = (j, email) => {
        if (j.token) { try { localStorage.setItem('mp.jwt.v1', j.token); } catch (_) {} }
        cerrarAuth();
        notificarSesion();
        if (esNativo()) _revincularCompra(email).finally(() => verificarAcceso());
        else verificarAcceso();
      };

            if (act === 'auth-submit') {
        const email = ((_authOverlay.querySelector('[data-x="auth-email"]') || {}).value || '').trim().toLowerCase();
        const pass  =  (_authOverlay.querySelector('[data-x="auth-pass"]')  || {}).value || '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr('Escribe un correo válido.');
        if (pass.length < 8) return setErr('La contraseña debe tener al menos 8 caracteres.');
        el.disabled = true; el.textContent = 'Un momento…';
        try {
          const reg = _authModo === 'registro';
          const ruta = reg ? '/api/auth/registro' : '/api/auth/ingresar';
          const r = await fetch(ruta, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify(reg ? { email, password: pass, turnstile: _tsToken() }
                                     : { email, password: pass })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            // El correo no tiene cuenta: se pasa a la pantalla de registro con
            // el aviso, en vez de dejar al usuario reintentando su contraseña.
            if (j.requiere_registro && !reg) {
              _authModo = 'registro';
              return setErr('Todavía no tienes cuenta con ese correo. Créala aquí.');
            }
            // El token de Turnstile es de UN SOLO USO: sin reiniciarlo, el
            // reintento llegaría con uno gastado y el error hablaría de bots
            // cuando el problema era otro.
            if (reg) _tsReiniciar();
            return setErr(j.error || 'No se pudo completar. Intenta de nuevo.');
          }
          if (j.token) { try { localStorage.setItem('mp.jwt.v1', j.token); } catch (_) {} }
          cerrarAuth();
          notificarSesion();     // re-render de "Mi cuenta" sin recargar
          // Re-vincula a esta cuenta una compra que ya viva en el Apple ID (por
          // ejemplo si eliminó su cuenta anterior y creó una nueva): así quien
          // pagó no pierde lo que pagó. No bloquea el acceso si falla.
          if (esNativo()) {
            _revincularCompra(email).finally(() => verificarAcceso());
          } else {
            verificarAcceso();
          }
        } catch (_) {
          setErr('Sin conexión. Intenta de nuevo.');
        }
      }
    });
  }

  /* ── Teléfono pendiente en cuentas que entraron por otra puerta ──────────
     El registro con contraseña ya exige teléfono, pero el magic link y el OTP
     por correo también crean cuentas y esas nacen sin él. Esto lo pide ahí.

     PIDE, NO BLOQUEA. Un muro duro dejaría fuera de su propia cuenta a todos
     los que se registraron antes de este cambio, y —más grave— al revisor de
     Apple, que entra por una puerta que no pregunta el teléfono y no
     necesariamente puede recibir un SMS en su número de prueba: quedarse
     atorado ahí es un rechazo. Se pregunta una vez por sesión y la app sigue
     funcionando si lo deja para después.
     Si el servidor no puede enviar SMS (sms_activo false) no se pregunta nada:
     ofrecer un código que no va a llegar es peor que no ofrecer nada. */
  /* Aquí vivía el aviso que pedía el teléfono a las cuentas creadas por magic
     link u OTP. Se retira con el resto: si el registro ya no pide teléfono,
     perseguir a quien no lo tiene es pedir un dato que la app decidió no usar. */

  // ------------------------------------------------ GATE (hard paywall)
  // Sin sesión              -> pantalla de acceso. No se usa la app sin cuenta.
  // Premium o trial vigente -> acceso normal.
  // Prueba vencida          -> overlay bloqueante (hard paywall).
  //
  // La primera línea decía lo contrario ("sin sesión -> acceso completo") de
  // cuando la web se usaba entera sin cuenta y el candado solo cazaba trials
  // vencidos.

  let _btnHTMLOriginal = null;
  function _refrescarBotonHeader(e) {
    const btn = document.getElementById('btn-premium-header');
    if (!btn) return;
    if (_btnHTMLOriginal === null) _btnHTMLOriginal = btn.innerHTML;
    if (_premiumEfectivo(e)) {        // servidor O compra (SDK), pero CON sesión
      if (!btn.dataset.premium) { btn.dataset.premium = '1'; btn.textContent = 'Suscrito ✓'; }
    } else if (btn.dataset.premium) {
      delete btn.dataset.premium; btn.innerHTML = _btnHTMLOriginal;
    }
  }

  // Franja delgada bajo la barra superior: "te quedan X días" (solo en trial)
  function _renderTrialStrip(e) {
    let strip = document.getElementById('mp-trial-strip');
    const activo = e && e.autenticado && e.plan === 'trial' && e.dias_restantes != null;
    if (!activo) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement('button');
      strip.id = 'mp-trial-strip';
      // El estilo vive en mp-editorial.css (.mp-franja-prueba). Estaba aquí en
      // cssText con colores y tipografía a mano, que es justo lo que hacía que
      // esta franja no se pareciera a nada más de la app.
      strip.className = 'mp-franja-prueba';
      const hdr = document.querySelector('header');
      if (hdr) hdr.appendChild(strip); else document.body.prepend(strip);
      strip.addEventListener('click', () => abrir());
    }
    const d = e.dias_restantes;
    strip.textContent = d > 0
      ? `Prueba gratis: te quedan ${d} ${d === 1 ? 'día' : 'días'} · Suscríbete →`
      : 'Tu prueba termina hoy · Suscríbete →';
  }

  /* ¿El servidor confirmó una sesión en ALGÚN momento de esta carga? Es lo que
     permite tratar distinto "todavía no has entrado" y "entraste y la red tuvo
     un bache", sin tener que elegir entre dejar pasar a cualquiera o echar al
     que sí pagó. No se guarda en localStorage a propósito: al recargar la
     página hay que volver a demostrar la sesión, y un valor persistido sería un
     "estoy dentro" que el cliente puede escribirse a sí mismo. */
  let _sesionConfirmada = false;

  let _reintento = null;
  function _reintentarPronto() {
    if (_reintento) return;                  // uno a la vez, no una avalancha
    _reintento = setTimeout(() => { _reintento = null; verificarAcceso(); }, 4000);
  }

  /* ¿Hay un JWT nuestro guardado y todavía vigente? Prueba de que ESTE
     navegador tuvo sesión, y solo se usa para un caso: abrir la app SIN RED.

     Sin esto, quien ya entró y abre la app en el metro o en un avión se queda
     mirando la pantalla de acceso —sin poder pasarla, porque iniciar sesión
     también necesita red— con sus datos en caché ahí detrás. El service worker
     precachea la app justo para que eso funcione.

     No es un permiso, y no reabre el agujero: quien nunca entró no tiene JWT, y
     un visitante nuevo sigue topándose con el candado. Cuando el servidor dice
     explícitamente que no hay sesión, esto NO se consulta: ese caso ya cierra
     más abajo. Solo cubre "no contestó".

     Se lee `exp` sin verificar la firma, que el cliente no puede comprobar. Da
     igual: los datos los sirve el servidor, que sí valida la firma en cada
     petición, así que un JWT inventado no destapa nada — deja ver el armazón
     vacío de la app, y para eso basta con borrar un nodo del DOM. */
  function _jwtLocalVigente() {
    try {
      const t = localStorage.getItem('mp.jwt.v1');
      if (!t) return false;
      const partes = t.split('.');
      if (partes.length !== 3) return false;
      const cuerpo = JSON.parse(atob(partes[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !!cuerpo && typeof cuerpo.exp === 'number' && cuerpo.exp * 1000 > Date.now();
    } catch (_) { return false; }
  }

  async function verificarAcceso() {
    let e = null;
    try { e = await estadoUsuario(); } catch (_) {}
    const authed = !!(e && e.autenticado);
    if (authed) _sesionConfirmada = true;

    // NATIVO sin cuenta: SIEMPRE exige registro/login (el trial se cuenta
    // por-cuenta), incluso si hay una compra activa en el Apple ID.
    //
    // Antes había una excepción: si _sdkPremium era true se cerraba el gate y se
    // devolvía, para no forzar a crear cuenta a quien hubiera comprado anónimo.
    // El problema es que la compra vive en el Apple ID y sobrevive a eliminar la
    // cuenta de la app, así que tras el borrado el entitlement seguía activo, el
    // gate no volvía NUNCA y la app quedaba en un limbo: "premium", sin sesión y
    // sin forma de iniciar sesión ni crear cuenta. Es la ruta exacta que recorre
    // el revisor de Apple (le exigen probar el borrado de cuenta), o sea rechazo.
    //
    // Ahora el gate siempre vuelve. La compra NO se pierde: al iniciar sesión o
    // crear cuenta, _revincularCompra() la restaura y la liga a la cuenta nueva.
    // El gate aplica en las DOS plataformas. Antes la web se usaba entera sin
    // cuenta; ahora también exige registro, así que sin sesión se muestra la
    // pantalla de acceso en vez de la app.
    //
    // Solo se monta donde vive la app (index.html carga este script; landing,
    // signup, legales y blog no), así que las páginas públicas no se tocan.
    if (!e || e._sinRespuesta) {
      /* El servidor no contestó. Antes esto era un `return` seco y ahí estaba el
         agujero: cualquier fallo al pedir el estado —incluida una excepción en
         nuestro propio código— se leía como "no sé" y la app quedaba abierta sin
         cuenta. "No sé" no puede significar "pasa".

         Pero cerrar siempre tampoco vale: expulsaría por una red lenta a quien
         sí tiene sesión. Los dos casos se distinguen por si ya se confirmó una
         sesión en esta carga:

           · nunca confirmada  → no se ha ganado el acceso: candado y reintento.
           · ya confirmada     → es un bache de red: no se toca la pantalla.

         Y una excepción para el arranque sin red: si este navegador guarda un
         JWT vigente, ya tuvo sesión antes, así que se le deja ver la app en
         caché en vez de una pantalla de acceso que sin red no puede pasar. */
      if (!_sesionConfirmada && !_jwtLocalVigente()) abrirAuth();
      // Se reintenta SIEMPRE mientras no haya confirmación: es lo que hace que
      // el candado aparezca solo en cuanto el servidor conteste que no hay
      // sesión (token revocado, cuenta borrada) y que se cierre en cuanto
      // conteste que sí.
      if (!_sesionConfirmada) _reintentarPronto();
      return;
    }

    if (!authed) {
      // Sin sesión no se afirma premium, y se olvida lo que el SDK dijo de la
      // cuenta anterior (si no, quedaba en memoria durante toda la sesión).
      _sdkPremium = false;
      _rcUser = null;
      // El servidor es explícito: no hay sesión. Se olvida la que hubiera para
      // que un cierre de sesión o un borrado de cuenta no deje al siguiente
      // fallo de red heredando el permiso del inquilino anterior.
      _sesionConfirmada = false;
      _refrescarBotonHeader(null);
      _renderTrialStrip(null);
      abrirAuth();
      return;
    }

    cerrarAuth();                                        // autenticado: fuera pantalla de acceso
    _renderTrialStrip(e);
    _refrescarBotonHeader(e);
    if (_premiumEfectivo(e) || e.plan !== 'expirado') {
      if (_bloqueante) cerrar(true);                     // trial vigente / suscrito: liberar candado
      return;
    }
    abrir({ bloqueante: true });                         // día 15+ sin suscripción: hard paywall neutro
  }

  document.addEventListener('DOMContentLoaded', () => {
    /* EL CANDADO NO ESPERA A LA TIENDA. Antes esto era
           refrescarSDKPremium().then(verificarAcceso, verificarAcceso)
       y el resultado, medido en el simulador, era que la app se quedaba entre
       15 y 25 segundos ABIERTA y usable sin cuenta antes de aparecer el candado:
       RevenueCat tiene 10 s de timeout y por dentro consulta el estado de sesión
       con otros 6 s. Nadie lo había visto porque en web esa rama no corre.

       Es lo mismo que el candado dejando pasar por un error de red: la app queda
       accesible mientras se resuelve algo que no debería mandar. Y si hay sesión
       o no lo dice el SERVIDOR, no la tienda, así que la espera no aportaba nada
       a esa decisión.

       Ahora se decide de inmediato con lo que dice el servidor, y el entitlement
       del SDK —que solo sirve para reconocer a un comprador ANÓNIMO que vuelve—
       se consulta EN PARALELO; cuando llega, se vuelve a evaluar. */
    verificarAcceso();
    if (esNativo()) refrescarSDKPremium().then(verificarAcceso, verificarAcceso);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verificarAcceso();
  });
  window.addEventListener('mp:premium-actualizado', verificarAcceso);

  // Al quedar sin sesión (logout o cuenta eliminada) el gate nativo se re-arma.
  window.addEventListener('mp:sesion-actualizada', () => { verificarAcceso(); });

  window.MPPaywall = {
    abrir, cerrar, esPremium, restaurar, requierePremium, plataforma, esNativo,
    customerInfo, entitlementActiva, verificarAcceso, abrirAuth, cerrarAuth,
    // Reutilizados por account.js (pantalla "Mi cuenta"): mismo mecanismo
    // nativo para los links legales y para el portal de la suscripción.
    abrirGestion, legalHTML: _legalHTML, abrirLegal: _abrirLegal, notificarSesion,
  };
})();
