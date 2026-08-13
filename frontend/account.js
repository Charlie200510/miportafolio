// ============================================================
//  Mi Portafolio — Pantalla "Mi cuenta" (sesión, plan, borrado)
// ============================================================
//  App Store Guideline 5.1.1(v): si la app permite CREAR una cuenta, debe
//  ofrecer DENTRO de la app un camino claro para ELIMINARLA. El revisor del
//  build 1.0(4) no la encontró porque vivía en un widget del footer que,
//  además, solo se pintaba en DOMContentLoaded (tras iniciar sesión con OTP
//  no aparecía hasta recargar) y confirmaba con confirm()/prompt() nativos.
//
//  Esta pantalla es la ÚNICA implementación:
//    - Se abre con el botón fijo "Mi cuenta" del header (data-vista="cuenta").
//      Son 2 toques desde el arranque: [Mi cuenta] → [Eliminar mi cuenta].
//    - Se re-renderiza ante cualquier cambio de sesión (login OTP, logout,
//      borrado) SIN recargar, escuchando 'mp:sesion-actualizada'.
//    - El borrado usa un modal HTML propio de 3 pasos (consecuencias →
//      escribir ELIMINAR → confirmación explícita), nunca confirm()/prompt(),
//      que en WKWebView se ven mal y prompt() puede no aparecer.
//
//  Estilos INLINE a propósito, igual que paywall.js: Tailwind llega por CDN y
//  en la app nativa puede no cargar (sin red, primer arranque). Una pantalla
//  que Apple exige encontrar no puede depender de un CDN externo.
// ============================================================
(function () {
  'use strict';

  const TIMEOUT_MS = 8000;

  // ---------------------------------------------------------- estilos
  const CARD   = 'background:var(--sup-panel);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:18px;margin:0 0 14px';
  const H2     = 'margin:0 0 6px;font-size:16px;font-weight:700;color:var(--tinta-1)';
  const P      = 'margin:0 0 12px;font-size:13px;color:var(--tinta-3);line-height:1.55';
  const BTN_PRI = 'width:100%;background:var(--sello);color:var(--sup);font-weight:700;border:0;border-radius:var(--radio-tarjeta);padding:14px;font-size:15px;cursor:pointer;font-family:inherit';
  const BTN_SEC = 'width:100%;background:transparent;color:var(--tinta-2);font-weight:600;border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:12px;font-size:14px;cursor:pointer;font-family:inherit';
  const BTN_DAN = 'width:100%;background:transparent;color:var(--baja);font-weight:700;border:1px solid rgba(174,50,35,.45);border-radius:var(--radio-tarjeta);padding:13px;font-size:14px;cursor:pointer;font-family:inherit';
  const BTN_DAN_SOLIDO = 'width:100%;background:var(--baja);color:var(--tinta-1);font-weight:700;border:0;border-radius:var(--radio-tarjeta);padding:14px;font-size:15px;cursor:pointer;font-family:inherit';
  // font-size:16px evita el auto-zoom de iOS al enfocar el input.
  const INP    = 'width:100%;background:var(--sup-panel);border:1px solid var(--regla-fuerte);border-radius:var(--radio-tarjeta);padding:13px 14px;font-size:16px;color:var(--tinta-1);outline:none;box-sizing:border-box;font-family:inherit';
  const COL    = 'display:flex;flex-direction:column;gap:8px';

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function esNativo() {
    try {
      if (window.MPPaywall && MPPaywall.esNativo) return MPPaywall.esNativo();
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (_) { return false; }
  }

  function toast(msg, tipo) {
    try { if (window.toast) return window.toast(msg, tipo || 'info'); } catch (_) {}
  }

  // Promesa con techo de tiempo: en la app nativa un fetch puede quedarse
  // colgado (backend en cold start, red del revisor) y la pantalla NO puede
  // quedarse en "Cargando…" para siempre.
  function conTimeout(promesa, ms, fallback) {
    return Promise.race([
      Promise.resolve(promesa).catch(() => fallback),
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }

  // ---------------------------------------------------------- estado
  //  Dos intentos: el backend vive en un plan que arranca en frío y puede
  //  tardar. Si aun así no contesta NO decimos "no has iniciado sesión" (eso
  //  volvería a esconder el borrado de cuenta justo cuando el revisor de Apple
  //  abre la app con el servidor dormido): se marca _sinRespuesta y, si hay un
  //  JWT local, se muestra la cuenta igual — el endpoint de borrado autentica
  //  con ese token.
  async function estado() {
    const intento = () => conTimeout((async () => {
      const r = await fetch('/api/auth/estado?t=' + Date.now(), { cache: 'no-store' });
      return (await r.json()) || { autenticado: false };
    })(), TIMEOUT_MS, null);

    let e = await intento();
    if (!e) {
      await new Promise(r => setTimeout(r, 1500));
      e = await intento();
    }
    if (e) return e;

    const local = sesionLocal();
    return { autenticado: false, _sinRespuesta: true, _emailLocal: local };
  }

  // Correo de la sesión nativa leído del JWT guardado en localStorage. Solo
  // para MOSTRARLO cuando el servidor no responde: el servidor sigue siendo
  // quien valida el token en cada llamada.
  function sesionLocal() {
    try {
      const tk = localStorage.getItem('mp.jwt.v1');
      if (!tk) return '';
      const p = tk.split('.')[1];
      if (!p) return '';
      const json = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(json) || {};
      return payload.email ? String(payload.email).toLowerCase() : '';
    } catch (_) { return ''; }
  }

  function fmtFecha(ts) {
    try {
      return new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) { return ''; }
  }

  // Texto del plan + fecha cuando aplica (trial: fin de la prueba).
  function textoPlan(e) {
    if (e && e._sinRespuesta && e._emailLocal) {
      return { titulo: 'Sin confirmar', detalle: 'No pudimos leer tu plan porque el servidor no respondió.', color: MP_COLOR.tinta3 };
    }
    if (!e || !e.autenticado) return { titulo: 'Sin sesión', detalle: '', color: MP_COLOR.tinta3 };
    if (e.plan === 'premium' || e.premium === true) {
      return { titulo: 'Premium activo', detalle: 'Tienes acceso a todas las funciones.', color: MP_COLOR.sello };
    }
    const dias = (e.dias_restantes == null) ? null : Number(e.dias_restantes);
    let fin = '';
    try {
      const creado = Number((e.usuario || {}).creado_en || 0);
      const trial = Number(e.trial_dias || 0);
      if (creado > 0 && trial > 0) fin = fmtFecha((creado + trial * 86400) * 1000);
    } catch (_) {}
    if (e.plan === 'trial') {
      const d = (dias == null) ? '' : (dias > 0
        ? 'Te ' + (dias === 1 ? 'queda 1 día' : 'quedan ' + dias + ' días') + '.'
        : 'Termina hoy.');
      return {
        titulo: 'Prueba gratis',
        detalle: (d + (fin ? ' Finaliza el ' + fin + '.' : '')).trim(),
        color: MP_COLOR.sello,
      };
    }
    if (e.plan === 'expirado') {
      return {
        titulo: 'Prueba terminada',
        detalle: (fin ? 'Finalizó el ' + fin + '. ' : '') + 'Suscríbete para seguir usando el análisis completo.',
        color: MP_COLOR.baja,
      };
    }
    return { titulo: 'Cuenta activa', detalle: '', color: MP_COLOR.tinta3 };
  }

  function legalHTML() {
    try {
      if (window.MPPaywall && MPPaywall.legalHTML) return MPPaywall.legalHTML('Consulta los');
    } catch (_) {}
    return '';
  }

  // ---------------------------------------------------------- render
  function cuerpo(e) {
    const plan = textoPlan(e);
    const nativo = esNativo();
    // Sin respuesta del servidor pero con JWT local: se trata como sesión
    // "sin confirmar" y se ofrece igual el borrado (el endpoint valida el token).
    const sinRespuesta = !!(e && e._sinRespuesta);
    const emailLocal = (e && e._emailLocal) || '';
    const autenticado = !!(e && e.autenticado) || (sinRespuesta && !!emailLocal);
    const correo = (e && e.email) || emailLocal;
    const premium = !!(e && e.autenticado) && (e.plan === 'premium' || e.premium === true);

    const avisoRed = sinRespuesta
      ? `<p style="margin:0 0 12px;font-size:12px;color:var(--sello);line-height:1.5">No pudimos contactar al servidor para confirmar tu sesión. Puede estar despertando: vuelve a intentar en unos segundos.</p>`
      : '';

    // ── Sesión ────────────────────────────────────────────────
    const sesion = autenticado
      ? `<div style="${CARD}">
           <p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--tinta-4)">Sesión</p>
           <p style="margin:0 0 14px;font-size:16px;font-weight:600;color:var(--tinta-1);word-break:break-all">${escapeHTML(correo)}</p>
           <p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--tinta-4)">Plan</p>
           <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${plan.color}">${plan.titulo}</p>
           ${plan.detalle ? `<p style="${P}">${escapeHTML(plan.detalle)}</p>` : ''}
           ${avisoRed}
           <div style="${COL}">
             <button data-a="logout" style="${BTN_SEC}">Cerrar sesión</button>
             ${sinRespuesta ? `<button data-a="recargar" style="${BTN_SEC}">Volver a comprobar</button>` : ''}
           </div>
         </div>`
      : `<div style="${CARD}">
           <p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--tinta-4)">Sesión</p>
           <p style="margin:0 0 10px;font-size:16px;font-weight:600;color:var(--tinta-1)">No has iniciado sesión</p>
           <p style="${P}">Sin cuenta no guardamos ningún dato tuyo en el servidor: tu portafolio vive solo en este
             dispositivo. Crea una cuenta para sincronizarlo y respaldarlo.</p>
           ${avisoRed}
           <div style="${COL}">
             <button data-a="entrar" style="${BTN_PRI}">Iniciar sesión o crear cuenta</button>
             <button data-a="recargar" style="${BTN_SEC}">Volver a comprobar</button>
           </div>
         </div>`;

    // ── Suscripción ───────────────────────────────────────────
    //  Bloque explícito: los revisores de App Store buscan las compras in-app
    //  también aquí (Guideline 2.1(b) del rechazo del build 4).
    const gestionar = (nativo && premium)
      ? `<button data-a="gestionar" style="${BTN_SEC}">Gestionar suscripción en la App Store</button>` : '';
    const restaurar = nativo
      ? `<button data-a="restaurar" style="${BTN_SEC}">Restaurar compra</button>` : '';
    const suscripcion = `
      <div style="${CARD}">
        <h2 style="${H2}">Suscripción</h2>
        <p style="${P}">${premium
          ? 'Tu suscripción está activa. Puedes gestionarla o cancelarla desde los Ajustes de tu cuenta de la App Store.'
          : 'Consulta los planes disponibles, sus precios y las condiciones de renovación automática.'}</p>
        <div style="${COL}">
          <button data-a="planes" style="${BTN_PRI}">${premium ? 'Ver mi plan' : 'Ver planes y suscribirme'}</button>
          ${gestionar}
          ${restaurar}
        </div>
      </div>`;

    // ── Eliminar cuenta (5.1.1v) ─────────────────────────────
    const eliminar = autenticado
      ? `<div style="background:rgba(174,50,35,.05);border:1px solid rgba(174,50,35,.28);border-radius:var(--radio-tarjeta);padding:18px;margin:0 0 14px">
           <h2 style="${H2}">Eliminar mi cuenta</h2>
           <p style="${P}">Al eliminar tu cuenta borramos de forma <strong style="color:var(--tinta-1)">permanente e irreversible</strong>
             todos tus datos en el servidor:</p>
           <ul style="list-style:none;padding:0;margin:0 0 12px;font-size:13px;color:var(--tinta-2)">
             <li style="display:flex;gap:8px;margin:5px 0"><span style="color:var(--baja)">•</span><span>Tu cuenta y tu correo (${escapeHTML(correo)})</span></li>
             <li style="display:flex;gap:8px;margin:5px 0"><span style="color:var(--baja)">•</span><span>Todas tus sesiones abiertas y códigos de acceso pendientes</span></li>
             <li style="display:flex;gap:8px;margin:5px 0"><span style="color:var(--baja)">•</span><span>Tus respaldos del portafolio en la nube</span></li>
             <li style="display:flex;gap:8px;margin:5px 0"><span style="color:var(--baja)">•</span><span>Tus suscripciones a notificaciones</span></li>
             <li style="display:flex;gap:8px;margin:5px 0"><span style="color:var(--baja)">•</span><span>Los datos guardados en este dispositivo</span></li>
           </ul>
           <p style="margin:0 0 14px;font-size:12px;color:var(--tinta-3);line-height:1.55">
             No se puede deshacer y no podremos recuperar la información después.
             ${nativo ? 'Si tienes una suscripción activa, recuerda cancelarla aparte en Ajustes → Apple ID → Suscripciones de la App Store: eliminar la cuenta no cancela el cobro.' : 'Si tienes una suscripción activa, cancélala también desde la tienda donde la contrataste.'}</p>
           <button data-a="eliminar" style="${BTN_DAN}">Eliminar mi cuenta</button>
         </div>`
      : `<div style="${CARD}">
           <h2 style="${H2}">Eliminar mi cuenta</h2>
           <p style="margin:0;font-size:13px;color:var(--tinta-3);line-height:1.55">Inicia sesión para poder eliminar tu cuenta y todos tus datos del servidor.</p>
         </div>`;

    return sesion + suscripcion + eliminar +
      `<div style="text-align:center">${legalHTML()}</div>`;
  }

  let _cargando = false;
  // OJO: nombre distinto a pintarModal() — dos `function pintar` en el mismo
  // scope se sobrescriben por hoisting y esta se volvía un no-op silencioso.
  function pintarCuenta(e) {
    const box = document.getElementById('cuenta-contenido');
    if (!box) return;
    try {
      box.innerHTML = cuerpo(e);
    } catch (_) {
      // Nunca dejar la pantalla vacía o atorada, ni con un error de JS.
      box.innerHTML = `<div style="${CARD}">
        <h2 style="${H2}">Mi cuenta</h2>
        <p style="${P}">No pudimos mostrar tu cuenta en este momento.</p>
        <button data-a="recargar" style="${BTN_SEC}">Volver a comprobar</button></div>`;
    }
    // El widget viejo del footer ya no existe: esta pantalla es la única
    // implementación. Mantenemos el enlace del footer como segundo acceso.
    const pill = document.getElementById('cuenta-footer-email');
    if (pill) pill.textContent = (e && e.autenticado && e.email) ? e.email : '';
  }

  async function render() {
    if (!document.getElementById('cuenta-contenido')) return;
    // Coalescer, NO descartar: si llega un cambio de sesión mientras hay una
    // consulta en vuelo, se vuelve a consultar al terminar. Descartarlo dejaba
    // la pantalla con el estado viejo — el mismo bug que rechazó Apple.
    if (_cargando) { _pendiente = true; return; }
    _cargando = true;
    try {
      if (_ultimoEstado) pintarCuenta(_ultimoEstado);   // respuesta instantánea al re-entrar
      do {
        _pendiente = false;
        const e = await estado();
        _ultimoEstado = e;
        pintarCuenta(e);
      } while (_pendiente);
    } finally {
      _cargando = false;
    }
  }
  let _ultimoEstado = null;
  let _pendiente = false;

  // ---------------------------------------------------------- acciones
  async function cerrarSesion() {
    try { await conTimeout(fetch('/api/auth/logout', { method: 'POST' }), TIMEOUT_MS, null); } catch (_) {}
    // En nativo la sesión es un JWT en localStorage: hay que borrarlo o la
    // sesión persistiría pese al logout. (No borra el portafolio local.)
    try { localStorage.removeItem('mp.jwt.v1'); } catch (_) {}
    toast('Cerraste sesión.', 'info');
    notificarSesion();
  }

  // Aviso global de "la sesión cambió": esta pantalla y el paywall se
  // re-renderizan sin recargar (bug del build 4: el widget solo se pintaba
  // en DOMContentLoaded, así que tras el login por OTP no aparecía).
  function notificarSesion() {
    try { window.dispatchEvent(new Event('mp:sesion-actualizada')); } catch (_) {}
  }

  function limpiarLocal() {
    try {
      Object.keys(localStorage)
        .filter(k => k.indexOf('mp.') === 0)          // incluye mp.jwt.v1
        .forEach(k => localStorage.removeItem(k));
    } catch (_) {}
    try { localStorage.removeItem('mp.jwt.v1'); } catch (_) {}
  }

  // ---------------------------------------------------------- modal de borrado
  //  3 pasos con UI propia (nunca confirm()/prompt()):
  //   1) consecuencias → Cancelar / Continuar
  //   2) escribir ELIMINAR con validación inline
  //   3) confirmación explícita de que la cuenta fue eliminada
  //  z-index 100000: por encima del overlay de auth del paywall (99998), que
  //  se re-arma al quedar sin sesión — el revisor DEBE ver el paso 3.
  let _modal = null;
  function cerrarModal(recargarEstado) {
    if (_modal) { _modal.remove(); _modal = null; }
    document.documentElement.style.removeProperty('overflow');
    if (recargarEstado) render();
  }

  function caja(inner) {
    return `<div style="position:relative;max-width:440px;width:100%;background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:24px;color:var(--tinta-1);font-family:system-ui,-apple-system,sans-serif;max-height:88vh;overflow:auto;-webkit-overflow-scrolling:touch">${inner}</div>`;
  }

  function paso1(email) {
    return caja(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:700">¿Eliminar tu cuenta?</h2>
      <p style="margin:0 0 12px;font-size:14px;color:var(--tinta-3);line-height:1.6">
        Vas a eliminar <strong style="color:var(--tinta-1)">${escapeHTML(email)}</strong>.
        Esta acción es <strong style="color:var(--baja)">permanente e irreversible</strong>.</p>
      <div style="background:var(--sup-panel);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:14px;margin:0 0 14px">
        <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:var(--tinta-1)">Se borrará:</p>
        <ul style="list-style:none;padding:0;margin:0;font-size:13px;color:var(--tinta-2)">
          <li style="display:flex;gap:8px;margin:4px 0"><span style="color:var(--baja)">•</span><span>Tu cuenta y tu correo</span></li>
          <li style="display:flex;gap:8px;margin:4px 0"><span style="color:var(--baja)">•</span><span>Tus sesiones y códigos de acceso</span></li>
          <li style="display:flex;gap:8px;margin:4px 0"><span style="color:var(--baja)">•</span><span>Tus respaldos del portafolio en la nube</span></li>
          <li style="display:flex;gap:8px;margin:4px 0"><span style="color:var(--baja)">•</span><span>Tus notificaciones y los datos de este dispositivo</span></li>
        </ul>
      </div>
      <p style="margin:0 0 16px;font-size:12px;color:var(--tinta-3);line-height:1.55">
        ${esNativo()
          ? 'Si tienes una suscripción activa, cancélala aparte en Ajustes → Apple ID → Suscripciones de la App Store. Eliminar la cuenta no cancela el cobro.'
          : 'Si tienes una suscripción activa, cancélala también desde la tienda donde la contrataste. Eliminar la cuenta no cancela el cobro.'}</p>
      <div style="${COL}">
        <button data-m="continuar" style="${BTN_DAN}">Continuar</button>
        <button data-m="cancelar" style="${BTN_SEC}">Cancelar</button>
      </div>`);
  }

  function paso2(email, err) {
    return caja(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:700">Confirma la eliminación</h2>
      <p style="margin:0 0 14px;font-size:14px;color:var(--tinta-3);line-height:1.6">
        Para eliminar <strong style="color:var(--tinta-1)">${escapeHTML(email)}</strong> escribe
        <strong style="color:var(--tinta-1)">ELIMINAR</strong> en el campo de abajo.</p>
      ${err ? `<p data-m="err" style="margin:0 0 10px;font-size:13px;color:var(--baja)">${escapeHTML(err)}</p>` : ''}
      <div style="${COL}">
        <input data-m="input" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false"
          autocomplete="off" placeholder="ELIMINAR" aria-label="Escribe ELIMINAR para confirmar"
          style="${INP};text-align:center;letter-spacing:3px;font-weight:700">
        <button data-m="confirmar" style="${BTN_DAN_SOLIDO}">Eliminar mi cuenta permanentemente</button>
        <button data-m="cancelar" style="${BTN_SEC}">Cancelar</button>
      </div>`);
  }

  function paso3(email) {
    return caja(`
      <div style="text-align:center">
        <div style="width:56px;height:56px;margin:0 auto 14px;border-radius:999px;background:rgba(156,93,18,.12);border:1px solid rgba(156,93,18,.4);display:flex;align-items:center;justify-content:center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--sello)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700">Tu cuenta fue eliminada</h2>
        <p style="margin:0 0 14px;font-size:14px;color:var(--tinta-3);line-height:1.6">
          Eliminamos <strong style="color:var(--tinta-2)">${escapeHTML(email)}</strong> y todos sus datos de nuestros
          servidores, junto con los datos guardados en este dispositivo. La app quedó sin sesión.</p>
        <p style="margin:0 0 18px;font-size:12px;color:var(--tinta-4);line-height:1.55">
          ${esNativo()
            ? 'Recuerda: si tenías una suscripción activa, cancélala en Ajustes → Apple ID → Suscripciones.'
            : 'Recuerda: si tenías una suscripción activa, cancélala en la tienda donde la contrataste.'}</p>
        <button data-m="listo" style="${BTN_PRI}">Entendido</button>
      </div>`);
  }

  function pintarModal(html) {
    if (_modal) _modal.innerHTML = html;
  }

  function abrirModalEliminar(email) {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.setAttribute('role', 'dialog');
    _modal.setAttribute('aria-modal', 'true');
    _modal.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(26,26,24,.40);display:flex;align-items:center;justify-content:center;padding:16px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)';
    _modal.innerHTML = paso1(email);
    document.body.appendChild(_modal);
    document.documentElement.style.overflow = 'hidden';

    let borrada = false;

    _modal.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !borrada) { ev.preventDefault(); cerrarModal(false); return; }
      if (ev.key === 'Enter' && ev.target && ev.target.getAttribute && ev.target.getAttribute('data-m') === 'input') {
        ev.preventDefault();
        const b = _modal.querySelector('[data-m="confirmar"]');
        if (b) b.click();
      }
    });

    _modal.addEventListener('click', async (ev) => {
      const el = ev.target.closest && ev.target.closest('[data-m]');
      if (!el) return;
      const act = el.getAttribute('data-m');

      if (act === 'cancelar') return cerrarModal(false);
      if (act === 'listo') {
        cerrarModal(true);
        notificarSesion();
        return;
      }
      if (act === 'continuar') {
        pintarModal(paso2(email, ''));
        const i = _modal.querySelector('[data-m="input"]');
        if (i) setTimeout(() => { try { i.focus(); } catch (_) {} }, 30);
        return;
      }
      if (act === 'confirmar') {
        const inp = _modal.querySelector('[data-m="input"]');
        const txt = ((inp && inp.value) || '').trim().toUpperCase();
        if (txt !== 'ELIMINAR') {
          pintarModal(paso2(email, 'Escribe exactamente ELIMINAR para confirmar.'));
          const i = _modal.querySelector('[data-m="input"]');
          if (i) { i.value = (inp && inp.value) || ''; setTimeout(() => { try { i.focus(); } catch (_) {} }, 30); }
          return;
        }
        el.disabled = true;
        const prev = el.textContent;
        el.textContent = 'Eliminando…';
        try {
          const r = await fetch('/api/auth/eliminar-cuenta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            const msg = (r.status === 401)
              ? 'Tu sesión expiró. Cierra este cuadro, inicia sesión de nuevo y vuelve a intentarlo.'
              : (j && j.error) || 'No pudimos eliminar la cuenta. Intenta de nuevo.';
            pintarModal(paso2(email, msg));
            return;
          }
          borrada = true;
          limpiarLocal();
          pintarModal(paso3(email));
        } catch (_) {
          pintarModal(paso2(email, 'Sin conexión con el servidor. Revisa tu red e intenta de nuevo.'));
        }
        // Si seguimos en el paso 2 (error), rehabilitamos el botón.
        const b = _modal && _modal.querySelector('[data-m="confirmar"]');
        if (b && !borrada) { b.disabled = false; b.textContent = prev; }
      }
    });
  }

  // API pública compatible con la versión anterior del widget.
  async function eliminarCuenta() {
    const e = _ultimoEstado || await estado();
    // Con sesión confirmada por el servidor, o con un JWT local cuando el
    // servidor no contestó (el endpoint autentica con ese token).
    const correo = (e && e.email) || (e && e._emailLocal) || '';
    if (!correo) {
      toast('Inicia sesión para poder eliminar tu cuenta.', 'warn');
      try { if (window.MPPaywall && MPPaywall.abrirAuth) MPPaywall.abrirAuth(); } catch (_) {}
      return;
    }
    abrirModalEliminar(correo);
  }

  // ---------------------------------------------------------- eventos de la vista
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('#vista-cuenta [data-a], #vista-cuenta [data-x="legal"]');
    if (!el) return;
    if (el.getAttribute('data-x') === 'legal') {
      // Mecanismo NATIVO ya existente en paywall.js: en Capacitor abre
      // https://miportafolio.uk/... con el plugin Browser (el bundle local no
      // sirve /terminos ni /privacidad).
      try { if (window.MPPaywall && MPPaywall.abrirLegal) return MPPaywall.abrirLegal(ev, el); } catch (_) {}
      return;
    }
    const act = el.getAttribute('data-a');
    ev.preventDefault();
    if (act === 'logout')     return void cerrarSesion();
    if (act === 'eliminar')   return void eliminarCuenta();
    if (act === 'recargar')   return void render();
    if (act === 'planes')     { try { MPPaywall.abrir(); } catch (_) {} return; }
    if (act === 'entrar')     { try { MPPaywall.abrirAuth(); } catch (_) {} return; }
    if (act === 'gestionar')  { try { MPPaywall.abrirGestion(); } catch (_) {} return; }
    if (act === 'restaurar') {
      el.disabled = true; const prev = el.textContent; el.textContent = 'Restaurando…';
      Promise.resolve()
        .then(() => MPPaywall.restaurar())
        .catch((err) => toast((err && err.message) || 'No se pudo restaurar la compra.', 'error'))
        .then(() => { el.disabled = false; el.textContent = prev; render(); });
      return;
    }
  });

  // Re-render ante cualquier cambio de sesión o de plan, sin recargar.
  window.addEventListener('mp:sesion-actualizada', () => { render(); });
  window.addEventListener('mp:premium-actualizado', () => { render(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }

  window.MPCuenta = { render, eliminarCuenta, cerrarSesion, abrirModalEliminar };
})();
