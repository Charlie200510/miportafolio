// ============================================================
//  ux_helpers.js — Polish UX para Mi Portafolio
// ============================================================
//  Bundle de 5 helpers que se cargan después de app.js:
//    1. Toasts/notificaciones (window.toast)
//    2. Tooltips en métricas (data-tooltip="..." en cualquier elemento)
//    3. Skeleton loaders (window.skeleton)
//    4. Tutorial interactivo primer visita
//    5. Manejo de errores humanizado
// ============================================================
(function() {
  'use strict';

  // ============================================================
  // CSS injection (todo en uno para no agregar otro <link>)
  // ============================================================
  const css = `
    /* ── 1. TOASTS ── */
    #mp-toast-host {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none;
    }
    .mp-toast {
      pointer-events: auto;
      background: #1a1a1c; border: 1px solid #2a2a2f;
      border-radius: 12px; padding: 12px 16px;
      display: flex; align-items: center; gap: 10px;
      font-size: 13px; color: #e5e7eb;
      min-width: 260px; max-width: 380px;
      box-shadow: 0 12px 32px -8px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04);
      animation: mpToastIn .35s cubic-bezier(.16,.95,.3,1) both;
    }
    .mp-toast.out { animation: mpToastOut .25s ease-in forwards; }
    .mp-toast .mp-toast-icon { flex-shrink: 0; width: 18px; height: 18px; }
    .mp-toast.success { border-color: rgba(34,197,94,.4); }
    .mp-toast.success .mp-toast-icon { color: #22c55e; }
    .mp-toast.error   { border-color: rgba(244,63,94,.4); }
    .mp-toast.error   .mp-toast-icon { color: #f43f5e; }
    .mp-toast.info    .mp-toast-icon { color: #38bdf8; }
    .mp-toast.warn    { border-color: rgba(245,158,11,.4); }
    .mp-toast.warn    .mp-toast-icon { color: #f59e0b; }
    @keyframes mpToastIn  { from { opacity:0; transform: translateY(20px) scale(.95); } to { opacity:1; transform: translateY(0) scale(1); } }
    @keyframes mpToastOut { to { opacity:0; transform: translateY(20px) scale(.95); } }

    /* ── 2. TOOLTIPS ── */
    [data-tooltip] { position: relative; cursor: help; }
    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%);
      background: #1a1a1c; color: #e5e7eb;
      padding: 8px 12px; border-radius: 8px;
      border: 1px solid #2a2a2f;
      font-size: 11px; line-height: 1.4;
      white-space: normal; width: max-content; max-width: 240px;
      z-index: 100;
      opacity: 0; pointer-events: none;
      transition: opacity .15s, transform .15s;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    [data-tooltip]:hover::after {
      opacity: 1;
      transform: translateX(-50%) translateY(-2px);
    }

    /* ── 3. SKELETON LOADERS ── */
    @keyframes mpSkeletonPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .mp-skeleton {
      background: linear-gradient(90deg, #1a1a1c 0%, #2a2a2f 50%, #1a1a1c 100%);
      background-size: 200% 100%;
      animation: mpSkeletonShimmer 1.4s linear infinite;
      border-radius: 6px;
      display: inline-block;
    }
    @keyframes mpSkeletonShimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* ── 4. TUTORIAL OVERLAY ── */
    #mp-tour-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      z-index: 9998; backdrop-filter: blur(2px);
      display: none;
    }
    #mp-tour-tooltip {
      position: fixed; z-index: 9999; max-width: 320px;
      background: #1a1a1c; border: 1px solid #22c55e;
      border-radius: 14px; padding: 18px 20px;
      box-shadow: 0 0 0 4px rgba(34,197,94,0.15), 0 24px 64px -12px rgba(0,0,0,0.6);
      display: none;
      animation: mpTourPop .35s cubic-bezier(.18,.95,.32,1) both;
    }
    @keyframes mpTourPop { from { opacity:0; transform: scale(.92); } to { opacity:1; transform: scale(1); } }
    #mp-tour-tooltip h4 {
      font-size: 14px; font-weight: 600; color: #f4f4f5; margin: 0 0 6px 0;
    }
    #mp-tour-tooltip p {
      font-size: 12px; color: #a1a1aa; line-height: 1.5; margin: 0 0 14px 0;
    }
    #mp-tour-tooltip .mp-tour-actions {
      display: flex; justify-content: space-between; align-items: center;
    }
    #mp-tour-tooltip .mp-tour-progress {
      font-size: 10px; color: #71717a; letter-spacing: 0.1em;
    }
    #mp-tour-tooltip button {
      background: #22c55e; color: #0a0a0b; font-weight: 600; font-size: 12px;
      border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer;
    }
    #mp-tour-tooltip button.skip {
      background: transparent; color: #71717a; padding: 6px 8px;
    }
    #mp-tour-tooltip button:hover { filter: brightness(1.1); }
    .mp-tour-highlight {
      position: relative; z-index: 9999 !important;
      box-shadow: 0 0 0 4px rgba(34,197,94,0.5), 0 0 0 9999px rgba(0,0,0,0.7) !important;
      border-radius: 8px;
      transition: box-shadow .3s;
    }
  `;
  const style = document.createElement('style');
  style.id = 'mp-ux-helpers-styles';
  style.textContent = css;
  document.head.appendChild(style);

  // ============================================================
  // 1. TOAST SYSTEM — window.toast(msg, type, duration)
  // ============================================================
  let toastHost = null;
  function _ensureToastHost() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement('div');
    toastHost.id = 'mp-toast-host';
    document.body.appendChild(toastHost);
    return toastHost;
  }
  const _icons = {
    success: '<svg class="mp-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg class="mp-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg class="mp-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warn:    '<svg class="mp-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  window.toast = function(msg, type = 'info', duration = 3500) {
    const host = _ensureToastHost();
    const el = document.createElement('div');
    el.className = 'mp-toast ' + type;
    el.innerHTML = (_icons[type] || _icons.info) + '<span>' + String(msg) + '</span>';
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, duration);
  };

  // ============================================================
  // 5. ERROR HUMANIZATION — wrapper de fetch que traduce errores
  // ============================================================
  const _humanError = (status, msg) => {
    if (status === 0 || !navigator.onLine) return 'Sin conexión a internet. Revisa tu wifi e intenta de nuevo.';
    if (status === 401 || status === 403) return 'Tu sesión expiró. Recarga la página.';
    if (status === 404) return 'No encontramos lo que buscas. Puede que esté siendo procesado.';
    if (status === 429) return 'Estás haciendo muchas peticiones. Espera 10 segundos.';
    if (status === 500 || status === 502 || status === 503) return 'El servidor tuvo un problema. Intenta en 30 segundos.';
    if (status === 504) return 'La petición tardó mucho. Refresca e intenta de nuevo.';
    if (msg) return msg;
    return 'Algo salió mal. Intenta de nuevo.';
  };
  const _origFetch = window.fetch;
  window.fetch = function(url, init) {
    return _origFetch(url, init).then(async (res) => {
      if (!res.ok && typeof url === 'string' && url.includes('/api/')) {
        // Solo loguear errores de API silenciosamente, no toast automático
        // (los módulos individuales deciden si mostrar toast)
        try {
          const body = await res.clone().json();
          if (!body._humanized) body._humanized = _humanError(res.status, body.error || body.detalle);
        } catch (_) {}
      }
      return res;
    }).catch((err) => {
      // Network errors completos
      if (err && err.message && err.message.includes('Failed to fetch')) {
        window.toast(_humanError(0), 'error', 4000);
      }
      throw err;
    });
  };
  window.humanError = _humanError;

  // ============================================================
  // 3. SKELETON LOADERS — window.skeleton(width, height)
  // ============================================================
  window.skeleton = function(width = '100%', height = '16px') {
    return `<span class="mp-skeleton" style="width:${width}; height:${height};"></span>`;
  };

  // ============================================================
  // 2. TOOLTIPS — auto-binding (CSS hace el trabajo)
  // ============================================================
  // Solo expone helper para agregar tooltip programáticamente
  window.tooltip = function(el, text) {
    if (el) el.setAttribute('data-tooltip', text);
  };

  // ============================================================
  // 4. TUTORIAL INTERACTIVO (primer visita)
  // ============================================================
  const TOUR_KEY = 'mp.tourCompleted.v1';
  const TOUR_STEPS = [
    {
      selector: '.nav-tab.nav-primary[data-vista="portafolio"]',
      title: 'Tu Portafolio',
      body: 'Aquí ves el análisis de tus inversiones: rendimiento, Sharpe, drawdowns y comparativa contra el mercado.',
    },
    {
      selector: '.nav-tab.nav-primary[data-vista="analizar"]',
      title: 'Analiza una acción',
      body: 'Pega cualquier ticker (AAPL, NVDA, WALMEX.MX, BTC-USD...) y te damos score 1-100, comparación con peers y dashboard 10-K.',
    },
    {
      selector: '.nav-tab.nav-primary[data-vista="periodico"]',
      title: 'Periódico financiero',
      body: 'Resumen diario de mercados, cierres de tus tickers y noticias relevantes.',
    },
    {
      selector: '#perfiles-grid',
      title: '10 perfiles pre-armados',
      body: 'Si no sabes por dónde empezar, click en cualquiera y la app te arma el portafolio óptimo. Edítalo después.',
    },
  ];

  function _yaCompletado() {
    try { return localStorage.getItem(TOUR_KEY) === '1'; } catch { return false; }
  }
  function _marcarCompletado() {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch {}
  }
  function _esDemoMode() {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  }
  function _tienePortafolio() {
    try {
      const raw = localStorage.getItem('miPortafolio.tickers.v1');
      const t = raw ? JSON.parse(raw) : [];
      return Array.isArray(t) && t.length >= 2;
    } catch { return false; }
  }

  function _crearOverlay() {
    if (document.getElementById('mp-tour-backdrop')) return;
    const b = document.createElement('div');
    b.id = 'mp-tour-backdrop';
    document.body.appendChild(b);
    const t = document.createElement('div');
    t.id = 'mp-tour-tooltip';
    t.innerHTML = `
      <h4 id="mp-tour-title"></h4>
      <p id="mp-tour-body"></p>
      <div class="mp-tour-actions">
        <span class="mp-tour-progress" id="mp-tour-progress"></span>
        <div>
          <button class="skip" id="mp-tour-skip">Saltar</button>
          <button id="mp-tour-next">Siguiente →</button>
        </div>
      </div>`;
    document.body.appendChild(t);
  }

  function _posicionarTooltip(elTarget) {
    const tooltip = document.getElementById('mp-tour-tooltip');
    const rect = elTarget.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let top = rect.bottom + 12;
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    // Si se sale por abajo, ponerlo arriba
    if (top + tipRect.height > window.innerHeight - 20) {
      top = rect.top - tipRect.height - 12;
    }
    // Ajustar horizontalmente para no salirse
    left = Math.max(12, Math.min(left, window.innerWidth - tipRect.width - 12));
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function _mostrarPaso(idx) {
    const steps = TOUR_STEPS;
    // Limpiar highlight anterior
    document.querySelectorAll('.mp-tour-highlight').forEach(el => el.classList.remove('mp-tour-highlight'));
    if (idx >= steps.length) {
      _terminar();
      return;
    }
    const step = steps[idx];
    const el = document.querySelector(step.selector);
    if (!el) {
      // Si el elemento no existe, saltar al siguiente
      _mostrarPaso(idx + 1);
      return;
    }
    el.classList.add('mp-tour-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const tooltip = document.getElementById('mp-tour-tooltip');
    document.getElementById('mp-tour-title').textContent = step.title;
    document.getElementById('mp-tour-body').textContent = step.body;
    document.getElementById('mp-tour-progress').textContent = `PASO ${idx + 1} DE ${steps.length}`;
    const btnNext = document.getElementById('mp-tour-next');
    btnNext.textContent = (idx === steps.length - 1) ? 'Listo ✓' : 'Siguiente →';
    btnNext.onclick = () => _mostrarPaso(idx + 1);
    document.getElementById('mp-tour-skip').onclick = _terminar;

    tooltip.style.display = 'block';
    setTimeout(() => _posicionarTooltip(el), 50);
  }

  function _terminar() {
    _marcarCompletado();
    document.getElementById('mp-tour-backdrop')?.remove();
    document.getElementById('mp-tour-tooltip')?.remove();
    document.querySelectorAll('.mp-tour-highlight').forEach(el => el.classList.remove('mp-tour-highlight'));
  }

  function _iniciarTour() {
    _crearOverlay();
    document.getElementById('mp-tour-backdrop').style.display = 'block';
    _mostrarPaso(0);
  }

  // Auto-trigger: si es modo demo O primer visita SIN portafolio guardado
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (_yaCompletado()) return;
      if (_esDemoMode() || !_tienePortafolio()) {
        _iniciarTour();
      }
    }, 2500); // dar tiempo a que cargue todo
  });

  // Expone para llamarse manualmente desde un botón "?"
  window.iniciarTour = () => {
    try { localStorage.removeItem(TOUR_KEY); } catch {}
    _iniciarTour();
  };

})();
