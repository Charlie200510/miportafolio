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

  function plataforma() {
    try { if (Caps && Caps.getPlatform) return Caps.getPlatform(); } catch (_) {}
    return 'web';
  }
  function esNativo() {
    try { return !!(Caps && Caps.isNativePlatform && Caps.isNativePlatform()); } catch (_) { return false; }
  }

  // -------------------------------------------------- estado del usuario
  async function estadoUsuario() {
    try {
      const r = await fetch('/api/auth/estado');
      return (await r.json()) || { autenticado: false };
    } catch (_) { return { autenticado: false }; }
  }
  async function emailActual() {
    const e = await estadoUsuario();
    return (e && e.email) ? String(e.email).toLowerCase() : '';
  }
  async function esPremium() {
    const e = await estadoUsuario();
    return _esPremiumEstado(e);
  }
  function _esPremiumEstado(e) {
    if (!e) return false;
    if (e.premium === true) return true;               // campo del gate (backend)
    return ((e.usuario && e.usuario.plan) || '') === 'premium';
  }

  // -------------------------------------------------- RevenueCat (nativo)
  function rcPlugin() {
    const P = (Caps && Caps.Plugins) || {};
    return P.Purchases || P.PurchasesPlugin || P.RevenueCat || null;
  }
  async function rcInit(email) {
    const RC = rcPlugin();
    if (!RC) throw new Error('El módulo de compras no está disponible en esta versión.');
    const key = plataforma() === 'ios' ? window.MP_REVENUECAT_KEY_IOS : window.MP_REVENUECAT_KEY_ANDROID;
    if (!key) throw new Error('Configuración de compras incompleta.');
    try { await RC.configure({ apiKey: key, appUserID: email || undefined }); } catch (_) {}
    if (email && RC.logIn) { try { await RC.logIn({ appUserID: email }); } catch (_) {} }
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
    // Confirmar la entitlement de forma segura en el servidor (fuente de verdad)
    await fetch('/api/payments/revenuecat/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
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
    await RC.restorePurchases();
    const r = await fetch('/api/payments/revenuecat/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const j = await r.json();
    if (j && j.premium) {
      cerrar(true);   // también libera el candado
      toast('Tu suscripción se restauró correctamente.');
      try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
    } else {
      cerrar();       // en modo bloqueante NO cierra
      toast('No encontramos una suscripción activa para restaurar.');
    }
    return j;
  }

  // -------------------------------------------------- MercadoPago (web)
  async function comprarWeb(email) {
    const r = await fetch('/api/payments/suscribir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const j = await r.json();
    if (j && j.checkout_url) { window.location.href = j.checkout_url; return; }
    throw new Error((j && j.error) || 'No se pudo iniciar el pago.');
  }

  // -------------------------------------------------- UI
  function toast(msg) {
    try { if (window.MP && MP.toast) return MP.toast(msg); } catch (_) {}
    try { if (window.mostrarToast) return window.mostrarToast(msg); } catch (_) {}
    alert(msg);
  }

  let _overlay = null;
  let _bloqueante = false;   // hard paywall: prueba vencida sin premium
  let _email = '';           // correo de la sesión o capturado en el paywall
  let _pkgs = [];            // paquetes del offering actual (nativo)
  function cerrar(force) {
    if (_bloqueante && force !== true) return;   // no se puede cerrar el candado
    if (_overlay) { _overlay.remove(); _overlay = null; }
    _bloqueante = false;
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
         <span style="color:#22c55e;flex:0 0 auto">✓</span><span>${b}</span></li>`).join('');

    if (premium) {
      const gestion = nativo
        ? `<button data-x="manage" style="${BTN_SEC};margin-bottom:8px">Gestionar suscripción</button>` : '';
      return `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700">Ya eres Premium ✓</h2>
        <p style="color:#a1a1aa;margin:0 0 18px">Tienes acceso a todas las funciones. ¡Gracias por tu apoyo!</p>
        ${gestion}<button data-x="close" style="${BTN_SEC}">Cerrar</button>`;
    }

    // Bloque legal/precio según plataforma
    const bloquePrecio = nativo
      ? `<p style="color:#a1a1aa;font-size:13px;margin:6px 0 0">
           Elige tu plan. Las suscripciones se renuevan automáticamente y puedes cancelarlas
           cuando quieras desde los Ajustes de tu cuenta de ${plataforma() === 'ios' ? 'App Store' : 'Google Play'}.
           El plan De por vida es un pago único, sin renovación.</p>`
      : `<div style="font-size:28px;font-weight:800;margin:2px 0">14 días gratis</div>
         <p style="color:#a1a1aa;font-size:13px;margin:6px 0 0">
           Luego ${PRECIO_TXT}. Cancela en un click, sin permanencia. Pago seguro con MercadoPago.</p>`;

    // Sin sesión: capturamos el correo AQUÍ MISMO (sin dead-end). El correo
    // liga la compra (appUserID de RevenueCat) y dispara un magic link para
    // acceso web/otros dispositivos — pero la compra NO depende de abrirlo.
    const captura = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <input data-x="email-input" type="email" inputmode="email" autocapitalize="none" autocomplete="email"
          placeholder="tu@correo.com"
          style="width:100%;background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:13px 14px;font-size:15px;color:#fafafa;outline:none;box-sizing:border-box">
        <button data-x="email-continuar" style="${BTN_PRI}">Continuar</button>
        <p style="color:#71717a;font-size:11px;margin:2px 0 0;text-align:center">
          Ligamos tu compra a este correo y te enviamos un enlace de acceso para la web y tus otros dispositivos.</p>
      </div>${nativo ? `<button data-x="restore" style="${BTN_SEC};margin-top:8px">Restaurar compra</button>` : ''}`;

    const cta = !email
      ? captura
      : nativo
      ? `<div data-x="planes" style="display:flex;flex-direction:column;gap:8px">
           <p style="color:#71717a;font-size:13px;text-align:center;margin:4px 0">Cargando planes…</p>
         </div>
         <button data-x="restore" style="${BTN_SEC}">Restaurar compra</button>`
      : `<button data-x="buy" style="${BTN_PRI}">Empezar prueba gratis</button>`;

    const legal = `<p style="color:#52525b;font-size:11px;margin:14px 0 0;text-align:center">
        Al continuar aceptas los <a href="/terminos" style="color:#71717a">Términos</a> y la
        <a href="/privacidad" style="color:#71717a">Privacidad</a>.</p>`;

    const titulo = bloqueante ? 'Tu prueba de 14 días terminó' : 'Mi Portafolio Premium';
    const subtitulo = bloqueante
      ? 'Suscríbete para seguir usando todo el análisis profesional.'
      : 'Desbloquea todo el análisis profesional.';
    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">${titulo}</h2>
      <p style="color:#a1a1aa;margin:0 0 14px;font-size:14px">${subtitulo}</p>
      ${bloquePrecio}
      <ul style="list-style:none;padding:0;margin:16px 0;font-size:14px;color:#e4e4e7">${benef}</ul>
      <div style="display:flex;flex-direction:column;gap:8px">${cta}</div>
      ${legal}`;
  }

  const BTN_PRI = 'width:100%;background:#22c55e;color:#052e16;font-weight:700;border:0;border-radius:12px;padding:14px;font-size:15px;cursor:pointer';
  const BTN_SEC = 'width:100%;background:transparent;color:#a1a1aa;font-weight:600;border:1px solid #27272a;border-radius:12px;padding:12px;font-size:14px;cursor:pointer';

  // Renderiza los paquetes del offering en el overlay abierto (usa _email
  // como appUserID vía rcInit dentro de cargarPaquetes)
  function _cargarPlanesEnOverlay() {
    if (!_overlay) return;
    const cont = _overlay.querySelector('[data-x="planes"]');
    if (!cont) return;
    cargarPaquetes(_email).then((pkgs) => {
      _pkgs = pkgs;
      if (!_overlay) return;
      const c = _overlay.querySelector('[data-x="planes"]');
      if (!c) return;
      const NOMBRE = { MONTHLY: 'Mensual', ANNUAL: 'Anual', LIFETIME: 'De por vida' };
      c.innerHTML = pkgs.map((p, i) => {
        const prod = p.product || {};
        const nombre = NOMBRE[p.packageType] || prod.title || p.identifier;
        const precio = prod.priceString || '';
        const sufijo = p.packageType === 'MONTHLY' ? '/mes'
                     : p.packageType === 'ANNUAL'  ? '/año'
                     : p.packageType === 'LIFETIME' ? ' · pago único' : '';
        const destacado = p.packageType === 'ANNUAL';
        return `<button data-x="buy" data-pkg="${i}"
          style="${destacado ? BTN_PRI : BTN_SEC};display:flex;justify-content:space-between;align-items:center">
          <span>${nombre}</span><span style="font-weight:800">${precio}${sufijo}</span>
        </button>`;
      }).join('');
    }).catch((e) => {
      const c = _overlay && _overlay.querySelector('[data-x="planes"]');
      if (c) c.innerHTML = `<p style="color:#f87171;font-size:13px;text-align:center;margin:4px 0">${(e && e.message) || 'No se pudieron cargar los planes.'}</p>`;
    });
  }

  async function abrir(opts) {
    const bloqueante = !!(opts && opts.bloqueante);
    if (_overlay && _bloqueante) return;      // el candado ya está en pantalla
    cerrar(true);
    _bloqueante = bloqueante;
    _email = await emailActual();
    const premium = await esPremium();

    const btnCerrar = bloqueante ? '' :
      `<button data-x="close" aria-label="Cerrar" style="position:absolute;top:14px;right:14px;background:transparent;border:0;color:#71717a;font-size:22px;cursor:pointer;line-height:1">×</button>`;
    _overlay = document.createElement('div');
    _overlay.setAttribute('role', 'dialog');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)';
    _overlay.innerHTML = `
      <div style="position:relative;max-width:420px;width:100%;background:#0f0f11;border:1px solid #27272a;border-radius:20px;padding:24px;color:#fafafa;font-family:system-ui,-apple-system,sans-serif;max-height:90vh;overflow:auto">
        ${btnCerrar}
        <div data-x="body">${vista(_email, premium, bloqueante)}</div>
      </div>`;
    document.body.appendChild(_overlay);

    if (esNativo() && !premium && _email) _cargarPlanesEnOverlay();

    // Enter en el campo de correo = Continuar
    _overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target && ev.target.getAttribute && ev.target.getAttribute('data-x') === 'email-input') {
        ev.preventDefault();
        const b = _overlay.querySelector('[data-x="email-continuar"]');
        if (b) b.click();
      }
    });

    _overlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-x]');
      if (!el) { if (ev.target === _overlay) cerrar(); return; }
      const act = el.getAttribute('data-x');
      if (act === 'close') return cerrar();
      if (act === 'manage') {
        // "Customer center": portal de gestión de la suscripción (App Store / Google Play)
        try {
          const info = await customerInfo();
          const url = (info && info.managementURL) || 'https://apps.apple.com/account/subscriptions';
          const B = (Caps && Caps.Plugins && Caps.Plugins.Browser);
          if (B && B.open) await B.open({ url }); else window.open(url, '_blank');
        } catch (_) { toast('No se pudo abrir la gestión de suscripción.'); }
        return;
      }
      if (act === 'restore') {
        el.disabled = true; el.textContent = 'Restaurando…';
        try { await restaurar(); } catch (e) { toast(e.message || 'Error al restaurar'); el.disabled = false; el.textContent = 'Restaurar compra'; }
        return;
      }
      if (act === 'email-continuar') {
        const inp = _overlay.querySelector('[data-x="email-input"]');
        const v = ((inp && inp.value) || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast('Escribe un correo válido.'); return; }
        _email = v;
        // Magic link para acceso web/otros dispositivos. Fire-and-forget:
        // la compra en iOS la autentica Apple y NO depende de abrir el correo.
        fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: v })
        }).catch(() => {});
        const body = _overlay.querySelector('[data-x="body"]');
        if (body) body.innerHTML = vista(_email, false, _bloqueante);
        if (esNativo()) _cargarPlanesEnOverlay();
        return;
      }
      if (act === 'buy') {
        if (!_email) { toast('Escribe tu correo para continuar.'); return; }
        el.disabled = true; const prev = el.textContent; el.textContent = 'Procesando…';
        try {
          if (esNativo()) {
            const idx = parseInt(el.getAttribute('data-pkg') || '0', 10);
            const pkg = _pkgs[idx];
            if (!pkg) throw new Error('Plan no disponible, intenta de nuevo.');
            await comprarNativo(_email, pkg);
            cerrar(true);   // compra hecha: libera también el candado
            toast('¡Listo! Ya eres Premium.');
            try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
          } else {
            await comprarWeb(_email);    // redirige al checkout de MercadoPago
          }
        } catch (e) {
          if (esCancelacion(e)) {        // cerró la hoja de pago: silencioso
            el.disabled = false; el.textContent = prev;
            return;
          }
          toast(e.message || 'No se pudo completar la compra.');
          el.disabled = false; el.textContent = prev;
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

  // ------------------------------------------------ GATE (hard paywall)
  // premium o trial vigente -> acceso normal. Prueba vencida sin premium ->
  // overlay bloqueante. Sin sesión (demo / revisores de Apple) -> acceso
  // completo: el candado solo aplica a cuentas con la prueba vencida.

  let _btnHTMLOriginal = null;
  function _refrescarBotonHeader(e) {
    const btn = document.getElementById('btn-premium-header');
    if (!btn) return;
    if (_btnHTMLOriginal === null) _btnHTMLOriginal = btn.innerHTML;
    if (_esPremiumEstado(e)) {
      if (!btn.dataset.premium) { btn.dataset.premium = '1'; btn.textContent = 'Premium ✓'; }
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
      strip.style.cssText = 'display:block;width:100%;background:rgba(245,158,11,.10);border:0;border-bottom:1px solid rgba(245,158,11,.25);color:#fcd34d;font-size:11px;font-weight:600;padding:5px 12px;text-align:center;cursor:pointer;font-family:inherit';
      const hdr = document.querySelector('header');
      if (hdr) hdr.appendChild(strip); else document.body.prepend(strip);
      strip.addEventListener('click', () => abrir());
    }
    const d = e.dias_restantes;
    strip.textContent = d > 0
      ? `Prueba gratis: te quedan ${d} ${d === 1 ? 'día' : 'días'} · Hazte Premium →`
      : 'Tu prueba termina hoy · Hazte Premium →';
  }

  async function verificarAcceso() {
    let e = null;
    try { e = await estadoUsuario(); } catch (_) {}
    _renderTrialStrip(e);
    _refrescarBotonHeader(e);
    if (!e || !e.autenticado) return;                    // demo/revisores: sin candado
    if (_esPremiumEstado(e) || e.plan !== 'expirado') {
      if (_bloqueante) cerrar(true);                     // se volvió premium: liberar
      return;
    }
    abrir({ bloqueante: true });
  }

  document.addEventListener('DOMContentLoaded', verificarAcceso);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verificarAcceso();
  });
  window.addEventListener('mp:premium-actualizado', verificarAcceso);

  window.MPPaywall = { abrir, cerrar, esPremium, restaurar, requierePremium, plataforma, esNativo, customerInfo, entitlementActiva, verificarAcceso };
})();
