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
    const plan = (e && e.usuario && e.usuario.plan) || '';
    return plan === 'premium';
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
  async function comprarNativo(email) {
    const RC = await rcInit(email);
    const offerings = await RC.getOfferings();
    const current = offerings && (offerings.current || (offerings.all && (offerings.all.default || Object.values(offerings.all)[0])));
    const pkgs = (current && current.availablePackages) || [];
    if (!pkgs.length) throw new Error('No hay planes disponibles por ahora.');
    const pkg = pkgs[0];
    await RC.purchasePackage({ aPackage: pkg });          // abre la hoja de pago nativa
    // Confirmar la entitlement de forma segura en el servidor
    await fetch('/api/payments/revenuecat/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
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
    cerrar();
    if (j && j.premium) toast('Tu suscripción se restauró correctamente.');
    else toast('No encontramos una suscripción activa para restaurar.');
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
  function cerrar() { if (_overlay) { _overlay.remove(); _overlay = null; } }

  const BENEFICIOS = [
    'Portafolio óptimo y frontera eficiente',
    'Simulación Monte Carlo y plan de rebalanceo',
    'Análisis profundo (Deep Dive) y valuación SML',
    'Screener avanzado y ranking por score',
    'Reporte mensual en PDF y alertas',
  ];

  function vista(email, premium) {
    const nativo = esNativo();
    const benef = BENEFICIOS.map(b =>
      `<li style="display:flex;gap:8px;align-items:flex-start;margin:6px 0">
         <span style="color:#22c55e;flex:0 0 auto">✓</span><span>${b}</span></li>`).join('');

    if (premium) {
      return `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700">Ya eres Premium ✓</h2>
        <p style="color:#a1a1aa;margin:0 0 18px">Tienes acceso a todas las funciones. ¡Gracias por tu apoyo!</p>
        <button data-x="close" style="${BTN_SEC}">Cerrar</button>`;
    }

    // Bloque legal/precio según plataforma
    const bloquePrecio = nativo
      ? `<div style="font-size:28px;font-weight:800;margin:2px 0">${PRECIO_TXT}</div>
         <p style="color:#a1a1aa;font-size:13px;margin:6px 0 0">
           Suscripción mensual con renovación automática. Puedes cancelarla cuando quieras
           desde los Ajustes de tu cuenta de ${plataforma() === 'ios' ? 'App Store' : 'Google Play'}.</p>`
      : `<div style="font-size:28px;font-weight:800;margin:2px 0">14 días gratis</div>
         <p style="color:#a1a1aa;font-size:13px;margin:6px 0 0">
           Luego ${PRECIO_TXT}. Cancela en un click, sin permanencia. Pago seguro con MercadoPago.</p>`;

    const cta = nativo
      ? `<button data-x="buy" style="${BTN_PRI}">Suscribirme — ${PRECIO_TXT}</button>
         <button data-x="restore" style="${BTN_SEC}">Restaurar compra</button>`
      : `<button data-x="buy" style="${BTN_PRI}">${email ? 'Empezar prueba gratis' : 'Inicia sesión para suscribirte'}</button>`;

    const legal = `<p style="color:#52525b;font-size:11px;margin:14px 0 0;text-align:center">
        Al continuar aceptas los <a href="/terminos" style="color:#71717a">Términos</a> y la
        <a href="/privacidad" style="color:#71717a">Privacidad</a>.</p>`;

    return `
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700">Mi Portafolio Premium</h2>
      <p style="color:#a1a1aa;margin:0 0 14px;font-size:14px">Desbloquea todo el análisis profesional.</p>
      ${bloquePrecio}
      <ul style="list-style:none;padding:0;margin:16px 0;font-size:14px;color:#e4e4e7">${benef}</ul>
      <div style="display:flex;flex-direction:column;gap:8px">${cta}</div>
      ${legal}`;
  }

  const BTN_PRI = 'width:100%;background:#22c55e;color:#052e16;font-weight:700;border:0;border-radius:12px;padding:14px;font-size:15px;cursor:pointer';
  const BTN_SEC = 'width:100%;background:transparent;color:#a1a1aa;font-weight:600;border:1px solid #27272a;border-radius:12px;padding:12px;font-size:14px;cursor:pointer';

  async function abrir() {
    cerrar();
    const email = await emailActual();
    const premium = await esPremium();

    _overlay = document.createElement('div');
    _overlay.setAttribute('role', 'dialog');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)';
    _overlay.innerHTML = `
      <div style="position:relative;max-width:420px;width:100%;background:#0f0f11;border:1px solid #27272a;border-radius:20px;padding:24px;color:#fafafa;font-family:system-ui,-apple-system,sans-serif;max-height:90vh;overflow:auto">
        <button data-x="close" aria-label="Cerrar" style="position:absolute;top:14px;right:14px;background:transparent;border:0;color:#71717a;font-size:22px;cursor:pointer;line-height:1">×</button>
        <div data-x="body">${vista(email, premium)}</div>
      </div>`;
    document.body.appendChild(_overlay);

    _overlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-x]');
      if (!el) { if (ev.target === _overlay) cerrar(); return; }
      const act = el.getAttribute('data-x');
      if (act === 'close') return cerrar();
      if (act === 'restore') {
        el.disabled = true; el.textContent = 'Restaurando…';
        try { await restaurar(); } catch (e) { toast(e.message || 'Error al restaurar'); el.disabled = false; el.textContent = 'Restaurar compra'; }
        return;
      }
      if (act === 'buy') {
        if (!email) {
          // No hay sesión: mandamos al login (web). En nativo también se requiere cuenta.
          cerrar();
          try { location.hash = '#login'; } catch (_) {}
          toast('Inicia sesión con tu correo para suscribirte.');
          return;
        }
        el.disabled = true; const prev = el.textContent; el.textContent = 'Procesando…';
        try {
          if (esNativo()) {
            await comprarNativo(email);
            cerrar();
            toast('¡Listo! Ya eres Premium.');
            try { window.dispatchEvent(new Event('mp:premium-actualizado')); } catch (_) {}
          } else {
            await comprarWeb(email);     // redirige al checkout de MercadoPago
          }
        } catch (e) {
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

  window.MPPaywall = { abrir, cerrar, esPremium, restaurar, requierePremium, plataforma, esNativo };
})();
