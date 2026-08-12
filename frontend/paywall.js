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
      return (await r.json()) || { autenticado: false, _sinRespuesta: true };
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

    // Captura de correo — SOLO en web (MercadoPago necesita el correo del pagador).
    const captura = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <input data-x="email-input" type="email" inputmode="email" autocapitalize="none" autocomplete="email"
          placeholder="tu@correo.com"
          style="width:100%;background:var(--sup-panel);border:1px solid var(--regla-fuerte);border-radius:2px;padding:13px 14px;font-size:15px;color:var(--tinta-1);outline:none;box-sizing:border-box">
        <button data-x="email-continuar" style="${BTN_PRI}">Continuar</button>
        <p style="color:var(--tinta-4);font-size:11px;margin:2px 0 0;text-align:center">
          Te enviamos un enlace de acceso a este correo.</p>
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

  const BTN_PRI = 'width:100%;background:var(--sello-solido);color:var(--sup);font-weight:600;border:1px solid var(--sello-solido);border-radius:2px;padding:14px;font-size:15px;cursor:pointer;font-family:inherit;letter-spacing:-.005em';
  const BTN_SEC = 'width:100%;background:transparent;color:var(--tinta-1);font-weight:600;border:1px solid var(--regla-fuerte);border-radius:2px;padding:12px;font-size:14px;cursor:pointer;font-family:inherit';
  // font-size:16px en inputs evita el auto-zoom de iOS al enfocar.
  const INP = 'width:100%;background:var(--sup-panel);border:1px solid var(--regla-fuerte);border-radius:2px;padding:13px 14px;font-size:16px;color:var(--tinta-1);outline:none;box-sizing:border-box';
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
           <span style="background:rgba(26,26,24,.14);color:${destacado ? MP_COLOR.sup : MP_COLOR.sello};border:1px solid ${destacado ? 'rgba(26,26,24,.35)' : 'rgba(156,93,18,.4)'};font-family:IBM Plex Mono,ui-monospace,monospace;font-size:9px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:2px;white-space:nowrap">${o.badge}</span>
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

  // ---------------------------------------------- OTP (login nativo — LANZAMIENTO §8)
  // El magic link abre Safari y la sesión no llega al WKWebView. En la app el
  // usuario teclea un código de 6 dígitos y el JWT se guarda en 'mp.jwt.v1'
  // (el wrapper de fetch de app.js lo manda como Authorization: Bearer).
  async function _pedirOTP(correo) {
    const r = await fetch('/api/auth/otp/solicitar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ email: correo }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'No se pudo enviar el código.');
    // El endpoint responde 200 {ok:true, enviado:false} cuando el código se
    // generó pero el correo NO salió (proveedor caído, credencial inválida).
    // Antes se avanzaba a "Revisa tu correo" de todos modos y el usuario se
    // quedaba esperando para siempre un código que nunca iba a llegar, sin
    // ninguna salida visible. Lo tratamos como error con bandera propia para
    // poder ofrecer la contraseña como alternativa.
    //
    // OJO con el orden: en AUTH_MOCK_MODE (desarrollo) el backend también manda
    // enviado:false, pero incluye codigo_debug porque el código va a la consola
    // en lugar del correo. Eso NO es un fallo. Mismo criterio y mismo orden que
    // signup.html con enlace_debug.
    if (j && j.codigo_debug) return j;
    if (j && j.enviado === false) {
      const err = new Error('No pudimos enviarte el código por correo.');
      err.noEnviado = true;
      throw err;
    }
    return j;
  }

  // Pantalla de fallo de envío. NUNCA dejar al usuario en "Revisa tu correo"
  // cuando sabemos que el correo no salió: aquí se le dice la verdad y se le
  // da la ruta que sí funciona (correo + contraseña, el flujo principal de la
  // app nativa, que no depende de que salga ningún correo).
  function _otpFalloCuerpo(correo) {
    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">No pudimos enviarte el código</h2>
      <p style="color:var(--tinta-3);margin:0 0 12px;font-size:14px;line-height:1.55">
        Generamos tu código, pero el correo a
        <span style="color:var(--tinta-2)">${_esc(correo)}</span> no salió: el servicio de
        envíos no está respondiendo. No es tu culpa y no tiene que ver con tu cuenta.</p>
      <p style="color:var(--tinta-3);margin:0 0 14px;font-size:14px;line-height:1.55">
        Puedes entrar ahora mismo con tu <strong style="color:var(--tinta-2)">contraseña</strong>,
        que no depende del correo. Si aún no tienes una, puedes crear tu cuenta ahí mismo.</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button data-x="otp-usar-password" style="${BTN_PRI}">Entrar con contraseña</button>
        <button data-x="otp-reintentar-envio" style="${BTN_SEC}">Reintentar el envío</button>
        <button data-x="volver" style="${BTN_LINK}">Volver a los planes</button>
      </div>`;
  }

  function _otpCuerpo(correo, err) {
    const errHTML = err ? `<p style="color:var(--baja);font-size:13px;margin:0 0 10px">${err}</p>` : '';
    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">Revisa tu correo</h2>
      <p style="color:var(--tinta-3);margin:0 0 14px;font-size:14px">Enviamos un código de 6 dígitos a
        <span style="color:var(--tinta-2)">${_esc(correo)}</span>. Expira en 10 minutos.</p>
      ${errHTML}
      <div style="display:flex;flex-direction:column;gap:8px">
        <input data-x="otp-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
          autocomplete="one-time-code" placeholder="000000"
          style="${INP};text-align:center;letter-spacing:8px;font-weight:700">
        <button data-x="otp-verificar" style="${BTN_PRI}">Verificar</button>
        <button data-x="otp-reenviar" style="${BTN_LINK}">Reenviar código</button>
        <button data-x="volver" style="${BTN_SEC}">Volver a los planes</button>
      </div>`;
  }

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
      <div style="position:relative;max-width:420px;width:100%;background:var(--sup);border:1px solid var(--regla);border-radius:2px;padding:24px;color:var(--tinta-1);font-family:system-ui,-apple-system,sans-serif;max-height:90vh;overflow:auto">
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
      const destino = dx === 'email-input' ? 'email-continuar'
                    : dx === 'otp-input'   ? 'otp-verificar' : null;
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
        // Mostrar captura de correo (login OPCIONAL para sincronizar). En la
        // app el acceso es con código OTP (dentro de la app); en web, enlace.
        const body = _overlay.querySelector('[data-x="body"]');
        if (body) body.innerHTML = `
          <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">Inicia sesión</h2>
          <p style="color:var(--tinta-3);margin:0 0 14px;font-size:14px">Opcional. Sincroniza tu suscripción entre tus dispositivos. No es necesario para comprar ni para usar la prueba.</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input data-x="email-input" type="email" inputmode="email" autocapitalize="none" autocomplete="email"
              placeholder="tu@correo.com"
              style="width:100%;background:var(--sup-panel);border:1px solid var(--regla-fuerte);border-radius:2px;padding:13px 14px;font-size:15px;color:var(--tinta-1);outline:none;box-sizing:border-box">
            <button data-x="email-continuar" style="${BTN_PRI}">${esNativo() ? 'Enviarme un código' : 'Enviarme el enlace'}</button>
            <button data-x="volver" style="${BTN_SEC}">Volver a los planes</button>
          </div>`;
        return;
      }
      if (act === 'otp-verificar') {
        const inp = _overlay.querySelector('[data-x="otp-input"]');
        const cod = ((inp && inp.value) || '').trim();
        const body = _overlay.querySelector('[data-x="body"]');
        if (!/^\d{6}$/.test(cod)) {
          if (body) body.innerHTML = _otpCuerpo(_email, 'Escribe el código de 6 dígitos que te enviamos.');
          return;
        }
        el.disabled = true; el.textContent = 'Verificando…';
        try {
          const r = await fetch('/api/auth/otp/verificar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ email: _email, codigo: cod }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (body) body.innerHTML = _otpCuerpo(_email, j.error || 'Código inválido o expirado.');
            return;
          }
          // Sesión dentro de la app: el wrapper de fetch manda este JWT como Bearer.
          if (j.token) { try { localStorage.setItem('mp.jwt.v1', j.token); } catch (_) {} }
          // Identifica la cuenta en RevenueCat (aliasa una compra anónima previa).
          if (esNativo()) { try { await rcInit(_email); } catch (_) {} }
          // La sesión cambió: "Mi cuenta" (y quien escuche) se re-renderiza sin
          // recargar. Bug del build 4: el widget de cuenta solo se pintaba en
          // DOMContentLoaded, así que tras el login por OTP no aparecía.
          notificarSesion();
          toast('Sesión iniciada como ' + _email + '.', 'success');
          if (body) { body.innerHTML = vista(_email, false, _bloqueante); _cargarPlanes(); }
          try { verificarAcceso(); } catch (_) {}
        } catch (_) {
          if (body) body.innerHTML = _otpCuerpo(_email, 'Sin conexión. Intenta de nuevo.');
        }
        return;
      }
      if (act === 'otp-reenviar' || act === 'otp-reintentar-envio') {
        const etiqueta = el.textContent;
        el.disabled = true; el.textContent = 'Enviando…';
        try {
          await _pedirOTP(_email);
          // Volvemos (o regresamos) a la pantalla del código: si veníamos del
          // fallo y el reintento funcionó, hay que dejar el input a la vista.
          const body = _overlay.querySelector('[data-x="body"]');
          if (body) {
            body.innerHTML = _otpCuerpo(_email, '');
            const oi = _overlay.querySelector('[data-x="otp-input"]');
            if (oi) oi.focus();
          }
          toast('Te enviamos un código nuevo a ' + _email + '.');
        } catch (e) {
          if (e && e.noEnviado) {
            // El correo sigue sin salir: pantalla honesta con la alternativa,
            // no un toast que se desvanece y deja la misma pantalla mintiendo.
            const body = _overlay.querySelector('[data-x="body"]');
            if (body) body.innerHTML = _otpFalloCuerpo(_email);
            return;
          }
          el.disabled = false; el.textContent = etiqueta;
          toast(e.message || 'No se pudo enviar el código.');
        }
        return;
      }
      if (act === 'otp-usar-password') {
        // El gate de correo+contraseña es el flujo principal de la app nativa y
        // no depende de que salga ningún correo. Lo abrimos en modo "ingresar";
        // si la persona no tiene contraseña, ahí mismo puede crear la cuenta.
        _authModo = 'ingresar';
        abrirAuth();
        return;
      }
      if (act === 'volver') {
        const body = _overlay.querySelector('[data-x="body"]');
        if (body) { body.innerHTML = vista(_email, false, _bloqueante); _cargarPlanes(); }
        return;
      }
      if (act === 'email-continuar') {
        const inp = _overlay.querySelector('[data-x="email-input"]');
        const v = ((inp && inp.value) || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast('Escribe un correo válido.'); return; }
        _email = v;
        const body = _overlay.querySelector('[data-x="body"]');
        if (esNativo()) {
          // App nativa: login con código OTP DENTRO de la app. El magic link
          // abriría Safari y la sesión nunca llegaría al WKWebView (§8).
          const prev = el.textContent;
          el.disabled = true; el.textContent = 'Enviando…';
          try {
            await _pedirOTP(v);
            if (body) body.innerHTML = _otpCuerpo(v, '');
            const oi = _overlay.querySelector('[data-x="otp-input"]');
            if (oi) oi.focus();
          } catch (e) {
            if (e && e.noEnviado) {
              // No mandar a "Revisa tu correo" cuando el correo no salió.
              if (body) body.innerHTML = _otpFalloCuerpo(v);
              return;
            }
            el.disabled = false; el.textContent = prev;
            toast(e.message || 'No se pudo enviar el código.');
          }
          return;
        }
        // Web: magic link para acceso multi-dispositivo. El pago con
        // MercadoPago no depende de abrir el correo, así que no bloqueamos el
        // flujo — pero tampoco afirmamos que se envió sin saberlo: antes era
        // fire-and-forget con un toast de éxito incondicional.
        if (body) { body.innerHTML = vista(_email, false, _bloqueante); _cargarPlanes(); }
        (async () => {
          try {
            const r = await fetch('/api/auth/login', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: v })
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'falló la solicitud');
            if (j && j.enlace_debug) { toast('Modo prueba: el enlace salió en la consola del servidor.'); return; }
            if (j && j.enviado === false) {
              toast('No pudimos enviarte el enlace a ' + v + '. Puedes seguir aquí y suscribirte; '
                  + 'para entrar desde otro dispositivo intenta más tarde.', 'error', 7000);
              return;
            }
            toast('Te enviamos un enlace de acceso a ' + v + '.');
          } catch (_) {
            toast('No pudimos enviarte el enlace a ' + v + '. Revisa tu conexión e intenta de nuevo.', 'error', 6000);
          }
        })();
        return;
      }
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

  function abrirAuth() {
    if (_authOverlay) return;
    cerrar(true);                     // no dejar el paywall abierto detrás
    _authOverlay = document.createElement('div');
    _authOverlay.setAttribute('role', 'dialog');
    _authOverlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--sup);display:flex;align-items:center;justify-content:center;padding:16px';
    _authOverlay.innerHTML = `<div style="max-width:420px;width:100%;background:var(--sup);border:1px solid var(--regla);border-radius:2px;padding:24px;color:var(--tinta-1);font-family:system-ui,-apple-system,sans-serif;max-height:92vh;overflow:auto"><div data-x="auth-body">${_authCuerpo('')}</div></div>`;
    document.body.appendChild(_authOverlay);

    _authOverlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { const b = _authOverlay.querySelector('[data-x="auth-submit"]'); if (b) { ev.preventDefault(); b.click(); } }
    });

    _authOverlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-x]'); if (!el) return;
      const act = el.getAttribute('data-x');
      if (act === 'legal') return _abrirLegal(ev, el);
      const setErr = (m) => { const b = _authOverlay && _authOverlay.querySelector('[data-x="auth-body"]'); if (b) b.innerHTML = _authCuerpo(m); };
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
      if (act === 'auth-submit') {
        const email = ((_authOverlay.querySelector('[data-x="auth-email"]') || {}).value || '').trim().toLowerCase();
        const pass  =  (_authOverlay.querySelector('[data-x="auth-pass"]')  || {}).value || '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr('Escribe un correo válido.');
        if (pass.length < 8) return setErr('La contraseña debe tener al menos 8 caracteres.');
        el.disabled = true; el.textContent = 'Un momento…';
        try {
          const ruta = (_authModo === 'registro') ? '/api/auth/registro' : '/api/auth/ingresar';
          const r = await fetch(ruta, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ email: email, password: pass })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return setErr(j.error || 'No se pudo completar. Intenta de nuevo.');
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

  // ------------------------------------------------ GATE (hard paywall)
  // premium o trial vigente -> acceso normal. Prueba vencida sin premium ->
  // overlay bloqueante. Sin sesión (demo / revisores de Apple) -> acceso
  // completo: el candado solo aplica a cuentas con la prueba vencida.

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
      strip.style.cssText = 'display:block;width:100%;background:rgba(156,93,18,.10);border:0;border-bottom:1px solid rgba(156,93,18,.25);color:var(--sello);font-size:10.5px;font-weight:500;padding:5px 12px;text-align:center;cursor:pointer;font-family:IBM Plex Mono,ui-monospace,monospace;letter-spacing:.04em';
      const hdr = document.querySelector('header');
      if (hdr) hdr.appendChild(strip); else document.body.prepend(strip);
      strip.addEventListener('click', () => abrir());
    }
    const d = e.dias_restantes;
    strip.textContent = d > 0
      ? `Prueba gratis: te quedan ${d} ${d === 1 ? 'día' : 'días'} · Suscríbete →`
      : 'Tu prueba termina hoy · Suscríbete →';
  }

  async function verificarAcceso() {
    let e = null;
    try { e = await estadoUsuario(); } catch (_) {}
    const authed = !!(e && e.autenticado);

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
    // Si el servidor no contestó no sabemos nada: dejar la pantalla como está y
    // reintentar en el próximo ciclo (visibilitychange). Cerrar el candado aquí
    // expulsaría a quien sí tiene sesión por una red lenta.
    if (!e || e._sinRespuesta) return;

    if (!authed) {
      // Sin sesión no se afirma premium, y se olvida lo que el SDK dijo de la
      // cuenta anterior (si no, quedaba en memoria durante toda la sesión).
      _sdkPremium = false;
      _rcUser = null;
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
    // En nativo, consulta el entitlement del SDK al arrancar: reconoce a un
    // comprador ANÓNIMO que vuelve a abrir la app (el servidor no lo conoce).
    if (esNativo()) refrescarSDKPremium().then(verificarAcceso, verificarAcceso);
    else verificarAcceso();
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
