// ============================================================
//  Mi Portafolio — Widget de cuenta (sesión + borrar cuenta)
// ============================================================
//  Muestra el correo de la sesión y ofrece "Cerrar sesión" y
//  "Eliminar mi cuenta". El borrado de cuenta es REQUISITO de
//  App Store (Guideline 5.1.1v) y Google Play para apps con login.
// ============================================================
(function () {
  'use strict';

  async function estado() {
    try {
      const r = await fetch('/api/auth/estado');
      return (await r.json()) || { autenticado: false };
    } catch (_) { return { autenticado: false }; }
  }

  async function cerrarSesion() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    // En nativo la sesión es un JWT en localStorage: hay que borrarlo o la
    // sesión persistiría pese al logout. (No borra el portafolio local.)
    try { localStorage.removeItem('mp.jwt.v1'); } catch (_) {}
    location.reload();
  }

  async function eliminarCuenta() {
    const ok1 = confirm(
      '¿Eliminar tu cuenta de forma permanente?\n\n' +
      'Se borrarán tu cuenta y tus datos en el servidor. Esta acción NO se puede deshacer.\n\n' +
      'Nota: si tienes una suscripción activa, cancélala también desde la App Store / Google Play / MercadoPago.'
    );
    if (!ok1) return;
    const txt = prompt('Para confirmar, escribe ELIMINAR');
    if ((txt || '').trim().toUpperCase() !== 'ELIMINAR') return;

    try {
      const r = await fetch('/api/auth/eliminar-cuenta', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'No se pudo eliminar la cuenta.');
      // Limpiar datos locales (portafolio, jwt, etc.)
      try {
        Object.keys(localStorage).filter(k => k.startsWith('mp.')).forEach(k => localStorage.removeItem(k));
      } catch (_) {}
      alert('Tu cuenta fue eliminada. ¡Gracias por haber usado Mi Portafolio!');
      location.href = '/landing';
    } catch (e) {
      alert(e.message || 'Error al eliminar la cuenta.');
    }
  }

  async function render() {
    const box = document.getElementById('cuenta-widget');
    if (!box) return;
    const e = await estado();
    if (!e || !e.autenticado) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    box.classList.remove('hidden');
    box.classList.add('flex');
    box.innerHTML =
      '<span class="text-zinc-700">·</span>' +
      '<span class="text-zinc-500">' + (e.email ? escapeHTML(e.email) : 'Mi cuenta') + '</span>' +
      '<button id="cw-logout" class="text-zinc-400 hover:text-zinc-200 transition cursor-pointer">Cerrar sesión</button>' +
      '<button id="cw-delete" class="text-accent-red/80 hover:text-accent-red transition cursor-pointer">Eliminar mi cuenta</button>';

    const lo = document.getElementById('cw-logout');
    const de = document.getElementById('cw-delete');
    if (lo) lo.addEventListener('click', cerrarSesion);
    if (de) de.addEventListener('click', eliminarCuenta);
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  window.MPCuenta = { render, eliminarCuenta, cerrarSesion };
})();
