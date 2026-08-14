// ============================================================
//  listas.js — Watchlist y tickers del widget, editables desde Analizar.
//
//  Dos listas que el usuario controla y que se consumen en sitios distintos:
//
//    · WATCHLIST → el mazo "Tu watchlist" del Periódico. Vive en localStorage
//      bajo la misma llave que ya usaba el botón ☆ del análisis, así que las
//      dos vías escriben en el mismo sitio y no hay dos verdades.
//
//    · WIDGET → el widget de pantalla de inicio de iOS, que es un proceso
//      APARTE y no puede leer localStorage. La lista se le pasa por el puente
//      nativo (window.webkit.messageHandlers.mpWidget), que la escribe en el
//      App Group compartido y pide a WidgetKit que recargue. En web no hay
//      widget: se guarda igual, para que al abrir la app nativa ya esté puesto.
// ============================================================
(function () {
  'use strict';

  const LS_WATCH  = 'miPortafolio.watchlist.v1';       // la misma que app.js
  const LS_WIDGET = 'miPortafolio.widgetTickers.v1';
  const MAX_WATCH  = 30;
  const MAX_WIDGET = 4;   // lo que cabe en un widget mediano sin encogerlo

  /* Los de fábrica son EXACTAMENTE los que el widget trae hardcodeados hoy, en
     el mismo orden. Así "volver a los de fábrica" devuelve lo que el usuario ya
     conocía, y un widget sin configurar se ve igual que siempre. */
  const WIDGET_DEFECTO = ['^MXX', 'USDMXN=X', 'SPY', 'CETES28'];
  const NOMBRE_FIJO = {
    '^MXX': 'IPC', 'USDMXN=X': 'USD/MXN', 'MXN=X': 'USD/MXN',
    'SPY': 'S&P 500', 'CETES28': 'CETES 28d',
  };

  const leer = (k, def) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return Array.isArray(v) ? v : def;
    } catch (_) { return def; }
  };
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const leerWatch  = () => leer(LS_WATCH, []);
  const leerWidget = () => leer(LS_WIDGET, WIDGET_DEFECTO.slice());

  // ── Puente al widget nativo ───────────────────────────────────────────
  /* WidgetKit corre fuera del WebView, así que la única forma de que vea esta
     lista es que el contenedor la copie al App Group. Si el puente no existe
     (web, o build sin la capability puesta) no se rompe nada: la lista queda
     guardada y el widget sigue con sus valores de fábrica. */
  function empujarAlWidget(tickers) {
    try {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mpWidget;
      // El puente exige `accion` (mismo protocolo que mpBloqueo y mpUI).
      if (h && h.postMessage) { h.postMessage({ accion: 'guardar', tickers }); return true; }
    } catch (_) {}
    return false;
  }

  // ── Pintado ───────────────────────────────────────────────────────────
  function chips(cont, tickers, quitar, vacio) {
    if (!cont) return;
    if (!tickers.length) {
      cont.innerHTML = `<p class="mp-chips-vacio">${vacio}</p>`;
      return;
    }
    cont.innerHTML = tickers.map(t => `
      <span class="mp-chip">
        <button type="button" class="mp-chip-nom" data-ir="${escaparAttr(t)}"
                title="Ver el análisis de ${escaparAttr(t)}">${escaparHtml(etiqueta(t))}</button>
        <button type="button" class="mp-chip-quitar" data-quitar="${escaparAttr(t)}"
                aria-label="Quitar ${escaparAttr(t)}">&times;</button>
      </span>`).join('');
    cont.querySelectorAll('[data-quitar]').forEach(b =>
      b.addEventListener('click', () => quitar(b.dataset.quitar)));
    cont.querySelectorAll('[data-ir]').forEach(b =>
      b.addEventListener('click', () => {
        // CETES no es un ticker analizable: no tiene emisora ni gráfica.
        if (b.dataset.ir === 'CETES28') return;
        if (window.analizarTicker) window.analizarTicker(b.dataset.ir);
      }));
  }

  const etiqueta = (t) => NOMBRE_FIJO[t] || t;
  const escaparHtml = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escaparAttr = escaparHtml;

  // ── Watchlist ─────────────────────────────────────────────────────────
  function pintarWatch() {
    chips(document.getElementById('wl-chips'), leerWatch(), quitarWatch,
          'Todavía no sigues ninguna. Búscala arriba y aparecerá en el Periódico.');
  }
  function agregarWatch(t) {
    t = String(t || '').trim().toUpperCase();
    if (!t) return;
    const a = leerWatch();
    if (a.includes(t)) { toast(`${t} ya está en tu watchlist.`); return; }
    if (a.length >= MAX_WATCH) { toast(`Tu watchlist llegó a ${MAX_WATCH}. Quita alguna antes.`); return; }
    a.push(t); guardar(LS_WATCH, a); pintarWatch();
    toast(`${t} agregada. Ya tiene tarjeta en el Periódico.`, 'success');
  }
  function quitarWatch(t) {
    guardar(LS_WATCH, leerWatch().filter(x => x !== t));
    pintarWatch();
  }

  // ── Widget ────────────────────────────────────────────────────────────
  function pintarWidget() {
    chips(document.getElementById('wg-chips'), leerWidget(), quitarWidget,
          'Sin tickers: el widget usará los de fábrica.');
    const est = document.getElementById('wg-estado');
    if (est) {
      const n = leerWidget().length;
      const nativo = !!(window.Capacitor && window.Capacitor.isNativePlatform
                        && window.Capacitor.isNativePlatform());
      est.textContent = nativo
        ? `${n} de ${MAX_WIDGET} · se aplica al salir de esta pantalla`
        : `${n} de ${MAX_WIDGET} · el widget solo existe en la app de iPhone`;
    }
  }
  function sincronizarWidget() {
    const t = leerWidget();
    guardar(LS_WIDGET, t);
    empujarAlWidget(t);
    pintarWidget();
  }
  function agregarWidget(t) {
    t = String(t || '').trim().toUpperCase();
    if (!t) return;
    const a = leerWidget();
    if (a.includes(t)) { toast(`${t} ya está en el widget.`); return; }
    if (a.length >= MAX_WIDGET) {
      toast(`El widget muestra ${MAX_WIDGET}. Quita uno para meter otro.`);
      return;
    }
    a.push(t); guardar(LS_WIDGET, a); sincronizarWidget();
    toast(`${etiqueta(t)} agregado al widget.`, 'success');
  }
  function quitarWidget(t) {
    guardar(LS_WIDGET, leerWidget().filter(x => x !== t));
    sincronizarWidget();
  }

  const toast = (m, tipo) => { if (window.toast) window.toast(m, tipo || 'info'); };

  // ── Arranque ──────────────────────────────────────────────────────────
  function iniciar() {
    const wl = document.getElementById('wl-buscar');
    const wg = document.getElementById('wg-buscar');
    if (!wl || wl.dataset.listo === '1') return;
    wl.dataset.listo = '1';

    // Se reutiliza el autocompletar que ya existe (app.js): mismo dropdown,
    // mismo endpoint (/api/buscar-ticker, que resuelve por nombre y cubre
    // acciones, ETFs y cripto) y mismo manejo de teclado que el resto de lupas.
    if (window.attachTickerAutocomplete) {
      window.attachTickerAutocomplete(wl, (ticker) => { agregarWatch(ticker); wl.value = ''; });
      if (wg) window.attachTickerAutocomplete(wg, (ticker) => { agregarWidget(ticker); wg.value = ''; });
    }
    // Enter sin elegir del dropdown: se toma lo tecleado tal cual.
    wl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && wl.value.trim()) { agregarWatch(wl.value); wl.value = ''; }
    });
    if (wg) wg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && wg.value.trim()) { agregarWidget(wg.value); wg.value = ''; }
    });

    const reset = document.getElementById('wg-reset');
    if (reset) reset.addEventListener('click', () => {
      guardar(LS_WIDGET, WIDGET_DEFECTO.slice());
      sincronizarWidget();
      toast('Widget de vuelta a IPC, dólar, S&P y CETES.', 'success');
    });

    pintarWatch();
    pintarWidget();
    // Al abrir la app se re-empuja: si el usuario editó la lista en el
    // navegador y luego entra por la app nativa, el widget se entera.
    empujarAlWidget(leerWidget());
  }

  document.addEventListener('DOMContentLoaded', iniciar);
  if (document.readyState !== 'loading') iniciar();
  // La vista Analizar puede montarse después; se reintenta al cambiar de tab.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.nav-tab')) setTimeout(iniciar, 300);
  });

  window.MPListas = {
    watchlist: leerWatch,
    widget: leerWidget,
    agregarWatch,
    refrescar: () => { pintarWatch(); pintarWidget(); },
    WIDGET_DEFECTO,
  };
})();
