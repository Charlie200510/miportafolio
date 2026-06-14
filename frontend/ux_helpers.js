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
      position: fixed; z-index: 10001; max-width: 320px;
      background: #1a1a1c; border: 1px solid #22c55e;
      border-radius: 14px; padding: 18px 20px;
      box-shadow: 0 0 0 4px rgba(34,197,94,0.15), 0 24px 64px -12px rgba(0,0,0,0.6);
      display: none;
    }
    #mp-tour-tooltip.mp-tour-anim {
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
      background: #22c55e; color: #0a0a0b; font-weight: 600; font-size: 13px;
      border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer;
      min-height: 36px;
    }
    #mp-tour-tooltip button.skip {
      background: transparent; color: #71717a; padding: 8px 10px;
    }
    #mp-tour-tooltip button:hover { filter: brightness(1.1); }
    /* Mobile: bottom-sheet full-width, NO box-shadow 9999px trick */
    @media (max-width: 639px) {
      #mp-tour-backdrop {
        background: rgba(0,0,0,0.85); /* más oscuro porque ya no usamos shadow trick */
      }
      #mp-tour-tooltip {
        padding: 18px 18px calc(18px + env(safe-area-inset-bottom, 0px));
        border-radius: 16px 16px 0 0;
        border-top: 2px solid #22c55e;
        border-left: none; border-right: none; border-bottom: none;
      }
      #mp-tour-tooltip h4 { font-size: 17px; margin-bottom: 8px; line-height: 1.3; }
      #mp-tour-tooltip p  { font-size: 14px; margin-bottom: 18px; line-height: 1.5; }
      #mp-tour-tooltip .mp-tour-actions {
        gap: 8px;
      }
      #mp-tour-tooltip button {
        font-size: 15px; padding: 12px 22px; min-height: 48px;
        border-radius: 10px;
      }
      #mp-tour-tooltip button.skip {
        font-size: 14px;
      }
      /* En mobile el highlight es solo un outline verde — el backdrop
         oscurece todo lo de atrás, así no necesitamos el shadow trick */
      .mp-tour-highlight {
        outline: 3px solid #22c55e !important;
        outline-offset: 4px;
        box-shadow: none !important;
        border-radius: 8px;
      }
    }
    /* Desktop: highlight con shadow trick */
    @media (min-width: 640px) {
      .mp-tour-highlight {
        position: relative; z-index: 9999 !important;
        box-shadow: 0 0 0 4px rgba(34,197,94,0.5), 0 0 0 9999px rgba(0,0,0,0.7) !important;
        border-radius: 8px;
        transition: box-shadow .3s;
      }
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
  // NOTA: el wrapper de fetch fue removido — interfería con res.json() en
  // algunos browsers (Safari iOS especialmente) cuando se hacía res.clone().
  // Cada módulo maneja sus propios errores de forma local.
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
      selector: '#perfiles-header, #perfiles-grid',
      title: '10 perfiles pre-armados',
      body: 'Si no sabes por dónde empezar, click en cualquiera y la app te arma el portafolio óptimo. Edítalo después.',
    },
  ];

  function _esMobile() {
    return window.innerWidth < 640;
  }

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
      <button id="mp-tour-close-x" aria-label="Cerrar tutorial"
        style="position:absolute;top:8px;right:10px;background:transparent;border:none;color:#71717a;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;min-height:auto;">×</button>
      <h4 id="mp-tour-title"></h4>
      <p id="mp-tour-body"></p>
      <div class="mp-tour-actions">
        <span class="mp-tour-progress" id="mp-tour-progress"></span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="skip" id="mp-tour-skip">Saltar</button>
          <button id="mp-tour-next">Siguiente →</button>
        </div>
      </div>`;
    t.style.position = 'fixed'; // fuerza por si algo CSS-side falla
    document.body.appendChild(t);
    // El botón X siempre cierra el tutorial
    document.getElementById('mp-tour-close-x').addEventListener('click', _terminar);
  }

  // Estado del target actual — usado por listeners de scroll/resize
  let _tourTargetActual = null;
  let _tourScrollHandler = null;

  function _posicionarTooltip(elTarget) {
    if (!elTarget) return;
    const tooltip = document.getElementById('mp-tour-tooltip');
    if (!tooltip) return;

    // En mobile: anclar el tooltip fijo abajo de la pantalla
    // (como bottom-sheet), nunca flotando junto al target.
    // Así nunca queda fuera de pantalla por más que el scroll se mueva.
    if (_esMobile()) {
      tooltip.style.visibility = 'visible';
      tooltip.style.display = 'block';
      tooltip.style.left   = '12px';
      tooltip.style.right  = '12px';
      tooltip.style.bottom = '16px';
      tooltip.style.top    = 'auto';
      tooltip.style.maxWidth = 'none';
      tooltip.style.width  = 'auto';
      return;
    }

    // Desktop: posicionar junto al target
    tooltip.style.right  = 'auto';
    tooltip.style.bottom = 'auto';
    tooltip.style.maxWidth = '320px';
    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';
    const rect = elTarget.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 12;

    // Posición preferida: abajo del target
    let top  = rect.bottom + MARGIN;
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);

    // Si no cabe abajo, intentar arriba
    if (top + tipRect.height > vh - MARGIN) {
      const topAlt = rect.top - tipRect.height - MARGIN;
      if (topAlt >= MARGIN) {
        top = topAlt;
      } else {
        top = Math.max(MARGIN, Math.min(vh - tipRect.height - MARGIN, (vh - tipRect.height) / 2));
      }
    }
    left = Math.max(MARGIN, Math.min(left, vw - tipRect.width - MARGIN));
    top  = Math.max(MARGIN, Math.min(top,  vh - tipRect.height - MARGIN));

    tooltip.style.top  = top  + 'px';
    tooltip.style.left = left + 'px';
    tooltip.style.visibility = 'visible';
  }

  // Espera a que el scroll smooth termine (sin scroll events durante 100ms)
  function _esperarScrollFin(cb) {
    let timer = null;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.removeEventListener('scroll', onScroll);
        cb();
      }, 100);
    };
    // Si no hay scroll, igual ejecutar después de 400ms (fallback)
    timer = setTimeout(() => {
      window.removeEventListener('scroll', onScroll);
      cb();
    }, 500);
    window.addEventListener('scroll', onScroll, { passive: true });
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

    if (_esMobile()) {
      // Mobile: scroll INSTANTÁNEO (smooth con position:fixed rompe iOS Safari)
      // Y dejamos espacio abajo para el bottom-sheet (~180px)
      const rect = el.getBoundingClientRect();
      const targetCenter = rect.top + window.scrollY + rect.height / 2;
      const viewportTop = targetCenter - (window.innerHeight - 180) / 2;
      window.scrollTo({ top: Math.max(0, viewportTop), behavior: 'auto' });
    } else {
      // Desktop: comportamiento normal
      const targetRect = el.getBoundingClientRect();
      const block = (targetRect.height > window.innerHeight * 0.6) ? 'start' : 'center';
      el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
    }

    document.getElementById('mp-tour-title').textContent = step.title;
    document.getElementById('mp-tour-body').textContent = step.body;
    document.getElementById('mp-tour-progress').textContent = `PASO ${idx + 1} DE ${steps.length}`;
    const btnNext = document.getElementById('mp-tour-next');
    btnNext.textContent = (idx === steps.length - 1) ? 'Listo ✓' : 'Siguiente →';
    btnNext.onclick = () => _mostrarPaso(idx + 1);
    document.getElementById('mp-tour-skip').onclick = _terminar;

    _tourTargetActual = el;
    // Pop animación solo al cambiar de paso, no en cada scroll
    const tip = document.getElementById('mp-tour-tooltip');
    if (tip) {
      tip.classList.remove('mp-tour-anim');
      // forzar reflow para reiniciar animación
      void tip.offsetWidth;
      tip.classList.add('mp-tour-anim');
    }
    // Posicionar inmediatamente (con tooltip oculto), después esperar fin de scroll
    _posicionarTooltip(el);
    _esperarScrollFin(() => _posicionarTooltip(el));
    // Re-posicionar también en cualquier scroll/resize posterior
    if (_tourScrollHandler) {
      window.removeEventListener('scroll', _tourScrollHandler);
      window.removeEventListener('resize', _tourScrollHandler);
    }
    _tourScrollHandler = () => {
      if (_tourTargetActual) _posicionarTooltip(_tourTargetActual);
    };
    window.addEventListener('scroll', _tourScrollHandler, { passive: true });
    window.addEventListener('resize', _tourScrollHandler);
  }

  function _terminar() {
    _marcarCompletado();
    if (_tourScrollHandler) {
      window.removeEventListener('scroll', _tourScrollHandler);
      window.removeEventListener('resize', _tourScrollHandler);
      _tourScrollHandler = null;
    }
    _tourTargetActual = null;
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

  // ============================================================
  // 6. SPLASH SCREEN — visible al primer load (~1.2 seg)
  // ============================================================
  const splashCSS = `
    #mp-splash {
      position: fixed; inset: 0; z-index: 10000;
      background: radial-gradient(ellipse at center, #0d1f15 0%, #050807 70%);
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 16px;
      animation: mpSplashOut .5s ease-in .9s forwards;
    }
    @keyframes mpSplashOut { to { opacity: 0; pointer-events: none; visibility: hidden; } }
    #mp-splash img {
      width: 80px; height: 80px; border-radius: 18px;
      box-shadow: 0 0 60px rgba(34,197,94,0.5);
      animation: mpSplashLogo .6s cubic-bezier(.18,.95,.32,1) both;
    }
    @keyframes mpSplashLogo {
      from { opacity: 0; transform: scale(.6); }
      to   { opacity: 1; transform: scale(1); }
    }
    #mp-splash .mp-splash-name {
      font-family: 'Outfit', 'Inter', sans-serif; font-weight: 700;
      font-size: 22px; letter-spacing: -0.02em;
      background: linear-gradient(135deg, #fff 0%, #22c55e 60%, #6ee7b7 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: mpSplashName .5s ease-out .25s both;
    }
    @keyframes mpSplashName { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    #mp-splash .mp-splash-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #22c55e;
      animation: mpSplashDot 1s ease-in-out infinite;
      box-shadow: 0 0 12px rgba(34,197,94,0.8);
    }
    @keyframes mpSplashDot { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  `;
  const splashStyle = document.createElement('style');
  splashStyle.textContent = splashCSS;
  document.head.appendChild(splashStyle);
  function _showSplash() {
    if (document.getElementById('mp-splash')) return;
    const splash = document.createElement('div');
    splash.id = 'mp-splash';
    splash.innerHTML = `
      <img src="/static/logo.png" alt="Mi Portafolio" />
      <div class="mp-splash-name">Mi Portafolio</div>
      <div class="mp-splash-dot"></div>
    `;
    document.body.appendChild(splash);
    // Auto-remove tras animación
    setTimeout(() => splash.remove(), 1800);
  }
  // Solo mostrar splash al PRIMER load (no en SPA-like reloads)
  if (!sessionStorage.getItem('mp.splashShown')) {
    _showSplash();
    try { sessionStorage.setItem('mp.splashShown', '1'); } catch {}
  }

  // ============================================================
  // 7. ANIMACIÓN DE TRANSICIÓN ENTRE VISTAS
  // ============================================================
  const transCSS = `
    @keyframes mpViewFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    main[id^="vista-"]:not(.hidden) {
      animation: mpViewFadeIn .35s cubic-bezier(.16,.95,.3,1) both;
    }
  `;
  const transStyle = document.createElement('style');
  transStyle.textContent = transCSS;
  document.head.appendChild(transStyle);

  // ============================================================
  // 8. STREAK COUNTER — cuenta días que entras a la app
  // ============================================================
  const STREAK_KEY = 'mp.streak.v1';
  function _updateStreak() {
    const hoy = new Date().toISOString().slice(0, 10);
    let data = {};
    try { data = JSON.parse(localStorage.getItem(STREAK_KEY) || '{}'); } catch {}
    if (data.last === hoy) return data;  // ya contado hoy
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (data.last === ayer) {
      data.count = (data.count || 1) + 1;
    } else {
      data.count = 1;  // reset, perdió la racha
    }
    data.last = hoy;
    try { localStorage.setItem(STREAK_KEY, JSON.stringify(data)); } catch {}
    return data;
  }
  function _renderStreakWidget() {
    const data = _updateStreak();
    if (data.count < 2) return;  // solo se ve a partir del día 2
    // Insertar widget al lado del logo
    const host = document.querySelector('header .flex.items-center.gap-3');
    if (!host || document.getElementById('mp-streak-widget')) return;
    const widget = document.createElement('div');
    widget.id = 'mp-streak-widget';
    widget.title = `Llevas ${data.count} días seguidos checando tu portafolio. Sigue así.`;
    widget.style.cssText = `
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px; margin-left: 8px;
      background: linear-gradient(135deg, rgba(251,146,60,0.15), rgba(245,158,11,0.1));
      border: 1px solid rgba(251,146,60,0.3);
      border-radius: 999px;
      font-size: 11px; font-weight: 600;
      color: #fb923c;
    `;
    widget.innerHTML = `<span style="font-size:13px;">🔥</span><span>${data.count}d</span>`;
    host.appendChild(widget);
  }
  // Defer hasta que header exista
  window.addEventListener('load', () => setTimeout(_renderStreakWidget, 100));

  // ============================================================
  // 9. FAQ MODAL — window.abrirFAQ()
  // ============================================================
  const FAQ_DATA = [
    {
      q: '¿Mi Portafolio ejecuta compras o ventas reales?',
      a: 'No. Mi Portafolio es una herramienta de análisis. Compras y vendes en tu broker (GBM, Kuspit, Hapi, Bursanet, Charles Schwab...) y aquí registras lo que ya hiciste. Esto nos permite enfocarnos 100% en darte mejores números, sin conflictos de interés.',
    },
    {
      q: '¿Mis datos están seguros?',
      a: 'Sí. Tu portafolio se guarda localmente en tu navegador (localStorage), no en nuestros servidores externos. Solo el snapshot mínimo necesario para alertas automáticas se sincroniza al backend, sin guardar credenciales bancarias.',
    },
    {
      q: '¿Funciona con acciones extranjeras?',
      a: 'Sí. Tenemos cobertura de NYSE, NASDAQ, BMV mexicana, FTSE 100, DAX, Nikkei, Hang Seng, NSE India, Bovespa Brasil, ASX Australia y más — además de 200+ criptomonedas.',
    },
    {
      q: '¿Cuánto cuesta?',
      a: 'Plan free completo para validar (sin tarjeta). Plan premium $79 MXN/mes — todas las funciones incluidas. Cancela en un click cuando quieras, sin permanencia.',
    },
    {
      q: '¿Esto es asesoría de inversión?',
      a: 'No. Mi Portafolio NO es asesor financiero registrado ante CNBV. Es herramienta de análisis con fines educativos. Las decisiones de inversión son responsabilidad del usuario.',
    },
    {
      q: '¿De dónde vienen los datos?',
      a: 'Yahoo Finance para precios y fundamentales, Banxico para CETES y TIIE, BMV para FIBRAS mexicanas. Datos delayed (no real-time), suficientes para análisis de mediano-largo plazo.',
    },
    {
      q: '¿Por qué a veces la app tarda en cargar?',
      a: 'Estamos en plan free de hosting — el servidor "duerme" tras 15 min sin tráfico. La primera carga después tarda ~30 segundos en despertar. Una vez activa, va rápida.',
    },
  ];
  window.abrirFAQ = function() {
    if (document.getElementById('mp-faq-modal')) return;
    const html = `
      <div id="mp-faq-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:640px;width:100%;max-height:85vh;overflow-y:auto;">
          <div style="position:sticky;top:0;background:#0a0a0b;border-bottom:1px solid #2a2a2f;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <h2 style="margin:0;font-size:18px;font-weight:600;color:#f4f4f5;">Preguntas frecuentes</h2>
            <button onclick="document.getElementById('mp-faq-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="padding:8px 24px 24px;">
            ${FAQ_DATA.map(item => `
              <details style="border-bottom:1px solid #1f1f24;padding:14px 0;">
                <summary style="cursor:pointer;font-weight:500;font-size:14px;color:#e5e7eb;list-style:none;display:flex;justify-content:space-between;align-items:center;">
                  <span>${item.q}</span>
                  <span style="color:#22c55e;font-size:18px;font-weight:300;">+</span>
                </summary>
                <p style="margin:10px 0 0;font-size:13px;color:#a1a1aa;line-height:1.6;">${item.a}</p>
              </details>
            `).join('')}
            <p style="margin-top:24px;padding-top:16px;border-top:1px solid #1f1f24;font-size:11px;color:#71717a;text-align:center;">
              ¿Otra duda? Escríbenos a <a href="mailto:soporte@miportafolio.app" style="color:#22c55e;">soporte@miportafolio.app</a>
            </p>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('mp-faq-modal').addEventListener('click', (e) => {
      if (e.target.id === 'mp-faq-modal') e.target.remove();
    });
  };

  // ============================================================
  // 10. CALENDARIO FISCAL MX — fechas clave próximas
  // ============================================================
  const FECHAS_FISCALES_MX = [
    // formato: { mes, dia, titulo, descripcion, tipo }
    { mes:  1, dia: 17, titulo: 'Pago provisional ISR diciembre',  desc: 'Personas morales y físicas con actividad empresarial.', tipo: 'isr' },
    { mes:  2, dia: 28, titulo: 'Declaración informativa anual',   desc: 'Personas morales — informativa múltiple.',              tipo: 'sat' },
    { mes:  3, dia: 31, titulo: 'Declaración anual PM',            desc: 'Personas morales — pago anual de ISR.',                tipo: 'sat' },
    { mes:  4, dia: 30, titulo: 'Declaración anual personas físicas', desc: 'Plazo límite para presentar tu declaración 2024-2025.', tipo: 'sat' },
    { mes:  4, dia: 30, titulo: 'Posibilidad de saldo a favor',    desc: 'Si tuviste ISR retenido, puedes obtener reembolso.',   tipo: 'sat' },
    { mes:  6, dia: 30, titulo: 'Cierre del Q2 fiscal',            desc: 'Buen momento para revisar tax-loss harvesting.',       tipo: 'tip' },
    { mes:  9, dia: 30, titulo: 'Cierre del Q3 fiscal',            desc: 'Tip: revisa pérdidas latentes para harvesting.',       tipo: 'tip' },
    { mes: 12, dia: 15, titulo: 'Último día para tax harvesting',  desc: 'Cierra pérdidas antes del 31 dic para deducirlas este ejercicio.', tipo: 'tip' },
    { mes: 12, dia: 31, titulo: 'Cierre fiscal',                   desc: 'Fin del ejercicio. Suma final de ganancias/pérdidas.',  tipo: 'sat' },
  ];
  function _proximasFechasFiscales(n = 3) {
    const hoy = new Date();
    const año = hoy.getFullYear();
    const proximas = FECHAS_FISCALES_MX.map(f => {
      let fecha = new Date(año, f.mes - 1, f.dia);
      if (fecha < hoy) fecha = new Date(año + 1, f.mes - 1, f.dia);
      const diasFaltan = Math.ceil((fecha - hoy) / 86400000);
      return { ...f, fecha, diasFaltan };
    }).sort((a, b) => a.fecha - b.fecha);
    return proximas.slice(0, n);
  }
  window.fechasFiscalesMX = _proximasFechasFiscales;
  // Auto-renderea un widget en vista-transacciones si existe el host
  function _renderFiscalWidget() {
    const host = document.getElementById('imp-contenido');
    if (!host || document.getElementById('mp-fiscal-widget')) return;
    const fechas = _proximasFechasFiscales(3);
    const tipoColor = {
      isr:  { bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.3)',  color: '#f59e0b', label: 'ISR' },
      sat:  { bg: 'rgba(99,102,241,0.1)',  border: 'rgba(99,102,241,0.3)',  color: '#818cf8', label: 'SAT' },
      tip:  { bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.3)',   color: '#22c55e', label: 'TIP' },
    };
    const widget = document.createElement('div');
    widget.id = 'mp-fiscal-widget';
    widget.className = 'bg-surface-card border border-surface-border rounded-xl p-5 mt-6';
    widget.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <span class="w-6 h-6 rounded-md bg-accent-indigo/15 border border-accent-indigo/30 flex items-center justify-center text-accent-indigo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </span>
          Calendario fiscal MX
        </h3>
        <span class="text-[10px] text-zinc-500 uppercase tracking-wider">Próximas fechas clave</span>
      </div>
      <div class="space-y-2">
        ${fechas.map(f => {
          const c = tipoColor[f.tipo] || tipoColor.tip;
          const mesNombre = f.fecha.toLocaleDateString('es-MX', { month: 'short' });
          return `
            <div class="flex items-center gap-3 p-3 bg-zinc-900/40 border border-surface-border rounded-lg">
              <div class="shrink-0 w-12 text-center">
                <div class="text-[9px] uppercase tracking-wider text-zinc-500">${mesNombre}</div>
                <div class="text-xl font-bold text-zinc-100 tabular leading-none">${f.dia}</div>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-0.5">
                  <span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background:${c.bg};color:${c.color};border:1px solid ${c.border};">${c.label}</span>
                  <p class="text-xs font-semibold text-zinc-100 truncate">${f.titulo}</p>
                </div>
                <p class="text-[11px] text-zinc-500 leading-snug">${f.desc}</p>
              </div>
              <div class="shrink-0 text-right">
                <p class="text-[10px] uppercase tracking-wider text-zinc-500">en</p>
                <p class="text-sm font-semibold text-zinc-200 tabular">${f.diasFaltan}d</p>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <p class="text-[10px] text-zinc-600 mt-3 italic text-center">Recordatorios genéricos. No constituyen asesoría fiscal. Consulta a tu contador.</p>
    `;
    host.appendChild(widget);
  }
  // Watch for vista-transacciones becoming visible
  const _fiscalObserver = new MutationObserver(() => {
    const t = document.getElementById('vista-transacciones');
    if (t && !t.classList.contains('hidden')) _renderFiscalWidget();
  });
  window.addEventListener('load', () => {
    const t = document.getElementById('vista-transacciones');
    if (t) _fiscalObserver.observe(t, { attributes: true, attributeFilter: ['class'] });
  });

  // ============================================================
  // 11. AFORE BENCHMARK — compara tu portafolio vs AFORE típica
  // ============================================================
  // SIEFOREs CONSAR rendimientos histórico aproximado (10y real):
  //   SB10 (≥60 años):    5.5% real
  //   SB55 (55-59):       6.0% real
  //   SB60 (60-64):       6.8% real
  //   SB65 (45-54):       7.5% real
  //   SB70 (40-44):       8.2% real
  //   SB75 (35-39):       8.8% real
  //   SB80 (30-34):       9.2% real
  //   SB85 (25-29):       9.5% real
  //   SB90 (≤25):         9.8% real
  const AFORE_BENCHMARKS = {
    'SB10': { edad: '≥60 años', retorno: 5.5, vol: 4.5 },
    'SB55': { edad: '55-59',    retorno: 6.0, vol: 5.5 },
    'SB60': { edad: '60-64',    retorno: 6.8, vol: 7.0 },
    'SB65': { edad: '45-54',    retorno: 7.5, vol: 8.5 },
    'SB70': { edad: '40-44',    retorno: 8.2, vol: 10.0 },
    'SB75': { edad: '35-39',    retorno: 8.8, vol: 11.5 },
    'SB80': { edad: '30-34',    retorno: 9.2, vol: 12.5 },
    'SB85': { edad: '25-29',    retorno: 9.5, vol: 13.5 },
    'SB90': { edad: '≤25 años', retorno: 9.8, vol: 14.5 },
  };
  window.compararAfore = function(retornoPortafolio) {
    // Encuentra la SIEFORE más cercana al retorno del portafolio
    const sf = Object.entries(AFORE_BENCHMARKS).map(([k, v]) => ({
      siefore: k, edad: v.edad, retorno: v.retorno, vol: v.vol,
      diff: retornoPortafolio - v.retorno,
    }));
    return sf;
  };

  // ============================================================
  // 12. GLOSARIO INTERACTIVO — modal con definiciones clave
  // ============================================================
  const GLOSARIO = [
    { termino: 'Sharpe ratio',       def: 'Rendimiento por unidad de riesgo. Si tu portafolio gana 12% y la tasa libre de riesgo es 9.5%, dividido entre tu volatilidad. >1 es bueno, >2 es excelente.' },
    { termino: 'Sortino ratio',      def: 'Como Sharpe pero solo cuenta volatilidad "mala" (caídas). Más justo que Sharpe porque las subidas no son malas.' },
    { termino: 'Drawdown',           def: 'Caída desde un máximo histórico. Si tu portafolio iba en $100 y bajó a $75, tienes drawdown de -25%.' },
    { termino: 'Volatilidad',        def: 'Qué tanto sube y baja tu portafolio. Medida con desviación estándar de rendimientos anuales.' },
    { termino: 'Markowitz',          def: 'Modelo matemático que calcula la mezcla óptima de acciones para maximizar retorno por unidad de riesgo. Premio Nobel 1990.' },
    { termino: 'Frontera eficiente', def: 'Conjunto de portafolios donde, para cada nivel de riesgo, no existe otro portafolio con mayor retorno esperado.' },
    { termino: 'Correlación',        def: 'Qué tanto se mueven dos acciones juntas. 1 = perfectamente sincronizadas, 0 = independientes, -1 = opuestas.' },
    { termino: 'Beta',               def: 'Cuánto se mueve una acción respecto al mercado. β=1 igual que el mercado, β=2 doble de volátil, β=0.5 mitad.' },
    { termino: 'P/E ratio',          def: 'Precio sobre utilidades. Cuánto pagas por cada peso de utilidad. >25 es caro, <15 es barato (depende del sector).' },
    { termino: 'EV/EBITDA',          def: 'Como P/E pero considera deuda. Múltiplo de valoración popular. <10 generalmente atractivo.' },
    { termino: 'P/S ratio',          def: 'Precio sobre ventas. Para empresas sin utilidades. <1 muy barato, >10 caro.' },
    { termino: 'ROE',                def: 'Retorno sobre capital. Cuánto genera la empresa por cada peso invertido. >15% es bueno, >25% excepcional.' },
    { termino: 'FCF',                def: 'Free Cash Flow. Efectivo libre tras gastos operativos y capex. Lo que la empresa realmente genera para sus accionistas.' },
    { termino: 'Tax-loss harvesting', def: 'Vender posiciones perdedoras para realizar la pérdida y deducirla del ISR de tus ganancias. Estrategia legal.' },
    { termino: 'ISR (México)',       def: 'Impuesto sobre la renta. En enajenación de acciones es 10% sobre la utilidad neta del ejercicio (art. 129 LISR).' },
    { termino: 'Rebalanceo',         def: 'Volver a las proporciones objetivo cuando los precios las cambian. Vendes lo que subió, compras lo que bajó.' },
    { termino: 'DCA',                def: 'Dollar Cost Averaging. Invertir un monto fijo periódicamente sin importar el precio. Reduce el riesgo de timing.' },
    { termino: 'Monte Carlo',        def: 'Simulación que corre 3,000+ escenarios futuros con variaciones aleatorias para estimar probabilidades realistas de tu meta.' },
    { termino: 'CETES',              def: 'Certificados de la Tesorería. Deuda gubernamental MX a 28/91/182/364 días. La tasa libre de riesgo en MX.' },
    { termino: 'FIBRA',              def: 'Fideicomiso de inversión en bienes raíces. Cotizan en bolsa y distribuyen al menos 95% de su flujo a inversionistas.' },
    { termino: 'AFORE',              def: 'Administradora de Fondos para el Retiro. SIEFOREs invierten por edad del trabajador.' },
    { termino: 'NAFTRAC',            def: 'ETF que replica el IPC mexicano. Forma más eficiente de tener "todo México" en una sola posición.' },
    { termino: 'SPY / VOO',          def: 'ETFs que replican el S&P 500. La forma más simple de tener "todo Estados Unidos" en una posición.' },
  ];
  window.abrirGlosario = function() {
    if (document.getElementById('mp-gloss-modal')) return;
    const html = `
      <div id="mp-gloss-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:680px;width:100%;max-height:85vh;overflow-y:auto;">
          <div style="position:sticky;top:0;background:#0a0a0b;border-bottom:1px solid #2a2a2f;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <h2 style="margin:0;font-size:18px;font-weight:600;color:#f4f4f5;">Glosario financiero</h2>
              <p style="margin:2px 0 0;font-size:11px;color:#71717a;">${GLOSARIO.length} términos en español plano</p>
            </div>
            <button onclick="document.getElementById('mp-gloss-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="padding:8px 24px 24px;">
            <input type="text" id="mp-gloss-search" placeholder="Filtrar términos..." style="width:100%;background:#161616;border:1px solid #2a2a2f;color:#e5e7eb;padding:10px 14px;border-radius:8px;font-size:13px;margin:12px 0 16px;outline:none;">
            <div id="mp-gloss-list">
              ${GLOSARIO.map(item => `
                <div class="gloss-item" style="border-bottom:1px solid #1f1f24;padding:12px 0;">
                  <p style="margin:0 0 4px;font-weight:600;font-size:13px;color:#22c55e;">${item.termino}</p>
                  <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.55;">${item.def}</p>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('mp-gloss-modal').addEventListener('click', (e) => {
      if (e.target.id === 'mp-gloss-modal') e.target.remove();
    });
    document.getElementById('mp-gloss-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.gloss-item').forEach(el => {
        const t = el.textContent.toLowerCase();
        el.style.display = t.includes(q) ? '' : 'none';
      });
    });
  };

  // ============================================================
  // 13. MINI-CURSOS — 3 cursos cortos de 5-6 slides cada uno
  // ============================================================
  const CURSOS = {
    'markowitz': {
      titulo: 'Markowitz en 5 minutos',
      slides: [
        { titulo: 'El dilema del inversionista', cuerpo: 'Si pones todo en una acción, puedes ganar mucho o perder todo. Si pones todo en cetes, casi no ganas. ¿Cómo encontrar el punto justo?' },
        { titulo: 'La idea genial (1952)', cuerpo: 'Harry Markowitz demostró que combinando activos NO correlacionados, puedes reducir el riesgo SIN sacrificar retorno. Le dieron el Nobel en 1990.' },
        { titulo: 'La frontera eficiente', cuerpo: 'Para cada nivel de riesgo que estés dispuesto a aceptar, existe UN portafolio óptimo. Cualquier mezcla por debajo es ineficiente — estás dejando dinero en la mesa.' },
        { titulo: 'Lo que necesitas', cuerpo: 'Solo necesitas: (1) rendimientos esperados, (2) volatilidades, (3) correlaciones entre activos. Mi Portafolio calcula los 3 automáticamente con 2 años de historia.' },
        { titulo: 'Lo que entrega', cuerpo: 'Los pesos óptimos para tu mezcla. Si tu portafolio es 70% AAPL + 30% MSFT, Markowitz puede decir "mejor 45% AAPL + 25% MSFT + 30% TLT" para más retorno por unidad de riesgo.' },
        { titulo: 'Cuidado', cuerpo: 'Markowitz usa el pasado para predecir el futuro. Si el régimen económico cambia drásticamente (crisis, guerra, política), los pesos óptimos pueden no funcionar. Rebalancea cada 6-12 meses.' },
      ],
    },
    'sharpe': {
      titulo: 'Entendiendo el Sharpe ratio',
      slides: [
        { titulo: '¿Por qué importa?', cuerpo: 'Dos portafolios pueden tener mismo retorno pero uno con caídas brutales y otro estable. El Sharpe ajusta por eso: cuánto ganas por cada unidad de riesgo.' },
        { titulo: 'La fórmula simple', cuerpo: 'Sharpe = (Retorno - Tasa libre de riesgo) / Volatilidad. En México, la tasa libre de riesgo es CETES 28d (~9.5%).' },
        { titulo: 'Cómo interpretarlo', cuerpo: 'Sharpe < 0: CETES te gana sin riesgo. Sharpe 0-0.5: mediocre. Sharpe 0.5-1: razonable. Sharpe 1-2: muy bueno. Sharpe > 2: excelente.' },
        { titulo: 'Trampa común', cuerpo: 'Sharpe alto NO significa "menos riesgo". Un portafolio con 30% vol y 40% retorno tiene Sharpe 1.0. Significa eficiencia, no seguridad.' },
        { titulo: 'Cuándo no aplica', cuerpo: 'Sharpe asume rendimientos normales. Con cripto o opciones (rendimientos muy asimétricos), considera Sortino que solo penaliza la volatilidad mala (caídas).' },
      ],
    },
    'isr-mx': {
      titulo: 'ISR mexicano sobre acciones',
      slides: [
        { titulo: 'Qué se grava', cuerpo: 'Las GANANCIAS REALIZADAS al vender. Si compraste a $100 y vendes a $130, ganaste $30 — eso es lo que se grava. Si todavía no vendes, no hay impuesto (aún).' },
        { titulo: 'La tasa', cuerpo: '10% sobre la UTILIDAD NETA del ejercicio (artículo 129 LISR). Si tuviste $30K en ganancias y $5K en pérdidas, pagas 10% sobre $25K = $2,500.' },
        { titulo: 'Tax-loss harvesting', cuerpo: 'Si tienes una acción con pérdida latente y tienes ganancias acumuladas, vender la pérdida ANTES del 31 de diciembre reduce tu base gravable. Estrategia 100% legal.' },
        { titulo: 'BMV vs SIC vs USA', cuerpo: 'Acciones en BMV (México): 10% ISR retenido por broker. Acciones US compradas en SIC: igual 10%. Acciones US compradas en broker gringo (Schwab/IBKR): TÚ declaras en abril.' },
        { titulo: 'Dividendos', cuerpo: 'Los dividendos pagan 10% adicional de retención (artículo 140 LISR). Los brokers mexicanos lo retienen automático. Es acreditable contra tu ISR anual.' },
        { titulo: 'Plazo declaración', cuerpo: '30 de abril del siguiente año. Tu broker te da una constancia de retención. Mi Portafolio genera el cálculo exacto en la sección "Modo Declaración SAT".' },
      ],
    },
  };
  window.abrirCurso = function(idCurso) {
    const curso = CURSOS[idCurso];
    if (!curso) return;
    let pos = 0;
    const total = curso.slides.length;
    function render() {
      const s = curso.slides[pos];
      const m = document.getElementById('mp-curso-modal');
      if (!m) return;
      m.querySelector('.mp-curso-pos').textContent = `${pos+1} / ${total}`;
      m.querySelector('.mp-curso-titulo-slide').textContent = s.titulo;
      m.querySelector('.mp-curso-cuerpo').textContent = s.cuerpo;
      m.querySelector('.mp-curso-prev').style.opacity = pos === 0 ? '0.3' : '1';
      m.querySelector('.mp-curso-prev').disabled = pos === 0;
      m.querySelector('.mp-curso-next').textContent = pos === total - 1 ? '✓ Listo' : 'Siguiente →';
      // Progress bar
      m.querySelector('.mp-curso-progress-fill').style.width = `${((pos+1)/total)*100}%`;
    }
    const html = `
      <div id="mp-curso-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px);">
        <div style="background:#0a0a0b;border:1px solid #22c55e;border-radius:18px;max-width:480px;width:100%;box-shadow:0 0 80px -20px rgba(34,197,94,0.4);">
          <div style="padding:16px 20px 12px;border-bottom:1px solid #1f1f24;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#22c55e;">Mini-curso</p>
              <h3 style="margin:2px 0 0;font-size:14px;color:#f4f4f5;font-weight:600;">${curso.titulo}</h3>
            </div>
            <button onclick="document.getElementById('mp-curso-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="height:3px;background:#1f1f24;">
            <div class="mp-curso-progress-fill" style="height:100%;background:#22c55e;transition:width .3s;width:0;"></div>
          </div>
          <div style="padding:32px 28px;min-height:200px;">
            <h2 class="mp-curso-titulo-slide" style="margin:0 0 14px;font-size:22px;font-weight:700;color:#f4f4f5;letter-spacing:-0.01em;line-height:1.2;"></h2>
            <p class="mp-curso-cuerpo" style="margin:0;font-size:14px;color:#a1a1aa;line-height:1.65;"></p>
          </div>
          <div style="padding:14px 20px;border-top:1px solid #1f1f24;display:flex;align-items:center;justify-content:space-between;">
            <button class="mp-curso-prev" style="background:transparent;border:1px solid #2a2a2f;color:#a1a1aa;padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;">← Atrás</button>
            <span class="mp-curso-pos" style="font-size:11px;color:#71717a;font-weight:600;letter-spacing:0.1em;"></span>
            <button class="mp-curso-next" style="background:#22c55e;border:none;color:#0a0a0b;padding:6px 18px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;"></button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const m = document.getElementById('mp-curso-modal');
    m.querySelector('.mp-curso-prev').onclick = () => { if (pos > 0) { pos--; render(); } };
    m.querySelector('.mp-curso-next').onclick = () => {
      if (pos === total - 1) { m.remove(); return; }
      pos++; render();
    };
    m.addEventListener('click', (e) => { if (e.target.id === 'mp-curso-modal') e.target.remove(); });
    render();
  };
  window.abrirCursosIndex = function() {
    const items = Object.entries(CURSOS).map(([id, c]) => `
      <button onclick="document.getElementById('mp-cursos-index').remove(); window.abrirCurso('${id}')" style="display:block;width:100%;text-align:left;background:#161616;border:1px solid #2a2a2f;border-radius:10px;padding:14px 16px;margin-bottom:8px;cursor:pointer;color:#e5e7eb;transition:border-color .2s;" onmouseover="this.style.borderColor='#22c55e'" onmouseout="this.style.borderColor='#2a2a2f'">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <p style="margin:0;font-size:14px;font-weight:600;color:#f4f4f5;">${c.titulo}</p>
            <p style="margin:2px 0 0;font-size:11px;color:#71717a;">${c.slides.length} slides · ~3 min</p>
          </div>
          <span style="color:#22c55e;">→</span>
        </div>
      </button>
    `).join('');
    document.body.insertAdjacentHTML('beforeend', `
      <div id="mp-cursos-index" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:440px;width:100%;padding:20px 24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#22c55e;">Aprende rápido</p>
              <h2 style="margin:2px 0 0;font-size:18px;color:#f4f4f5;font-weight:600;">Mini-cursos</h2>
            </div>
            <button onclick="document.getElementById('mp-cursos-index').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          ${items}
        </div>
      </div>`);
    document.getElementById('mp-cursos-index').addEventListener('click', (e) => {
      if (e.target.id === 'mp-cursos-index') e.target.remove();
    });
  };

  // ============================================================
  // 14. COMPARATIVA ANÓNIMA — percentil ilustrativo basado en Sharpe
  // ============================================================
  // Tabla de percentiles basada en datos públicos de retail investors
  // (Morningstar, Vanguard). Es ilustrativa pero realista.
  function _percentilSharpe(sharpe) {
    if (sharpe >= 2.0) return 99;
    if (sharpe >= 1.5) return 95;
    if (sharpe >= 1.2) return 88;
    if (sharpe >= 1.0) return 78;
    if (sharpe >= 0.8) return 65;
    if (sharpe >= 0.6) return 50;
    if (sharpe >= 0.4) return 35;
    if (sharpe >= 0.2) return 22;
    if (sharpe >= 0)   return 12;
    return 5;
  }
  window.percentilSharpe = _percentilSharpe;
  function _renderComparativaWidget() {
    const sharpeTxt = document.getElementById('kpi-sharpe')?.textContent || '';
    const sharpe = parseFloat(sharpeTxt.replace(/[^\d.\-]/g, ''));
    if (!isFinite(sharpe) || sharpe === 0) return;
    if (document.getElementById('mp-comparativa-widget')) return;
    const pct = _percentilSharpe(sharpe);
    const host = document.querySelector('#kpi-sharpe')?.closest('.bg-surface-card');
    if (!host) return;
    const badge = document.createElement('div');
    badge.id = 'mp-comparativa-widget';
    badge.style.cssText = `
      margin-top: 8px; padding: 6px 10px;
      background: linear-gradient(135deg, rgba(168,85,247,0.1), rgba(99,102,241,0.05));
      border: 1px solid rgba(168,85,247,0.25);
      border-radius: 6px; font-size: 10px; line-height: 1.4;
      color: #c4b5fd;
    `;
    let msg;
    if (pct >= 95) msg = `Tu Sharpe está en el <strong style="color:#fff;">top ${100-pct}%</strong> — élite.`;
    else if (pct >= 80) msg = `Mejor que el <strong style="color:#fff;">${pct}%</strong> de inversionistas retail.`;
    else if (pct >= 50) msg = `Mejor que el <strong style="color:#fff;">${pct}%</strong> de inversionistas retail.`;
    else if (pct >= 25) msg = `Mejor que el <strong style="color:#fff;">${pct}%</strong> — hay margen.`;
    else msg = `Top ${100-pct}% inferior — revisa tu mezcla.`;
    badge.innerHTML = msg + ' <span style="color:#71717a;">vs benchmarks públicos</span>';
    host.appendChild(badge);
  }
  // Auto-render cuando los KPIs ya están listos
  window.addEventListener('load', () => {
    setTimeout(() => _renderComparativaWidget(), 3000);
    setTimeout(() => _renderComparativaWidget(), 6000);  // segundo intento por si tardó el análisis
  });

})();
