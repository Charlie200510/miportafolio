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
    /* z-index por encima del paywall (99999) y del modal de cuenta (100000):
       si un toast queda detrás del overlay, el error es invisible. */
    #mp-toast-host {
      position: fixed; bottom: 24px; right: 24px; z-index: 100001;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none;
    }
    .mp-toast {
      pointer-events: auto;
      background: var(--sup-panel); border: 1px solid var(--regla);
      border-radius: var(--radio-tarjeta); padding: 12px 16px;
      display: flex; align-items: center; gap: 10px;
      font-size: 13px; color: var(--tinta-1);
      min-width: 260px; max-width: 380px;
      box-shadow: 0 12px 32px -8px rgba(26,26,24,.12), 0 0 0 1px rgba(26,26,24,.05);
      animation: mpToastIn .16s cubic-bezier(.2,0,.2,1) both;
    }
    .mp-toast.out { animation: mpToastOut .12s cubic-bezier(.2,0,.2,1) forwards; }
    .mp-toast .mp-toast-icon { flex-shrink: 0; width: 18px; height: 18px; }
    .mp-toast.success { border-color: rgba(156,93,18,.4); }
    .mp-toast.success .mp-toast-icon { color: var(--sello); }
    .mp-toast.error   { border-color: rgba(174,50,35,.4); }
    .mp-toast.error   .mp-toast-icon { color: var(--baja); }
    .mp-toast.info    .mp-toast-icon { color: var(--sello); }
    .mp-toast.warn    { border-color: rgba(156,93,18,.4); }
    .mp-toast.warn    .mp-toast-icon { color: var(--sello); }
    /* Sin rebote ni escalado: sólo un desplazamiento corto de 160ms. */
    @keyframes mpToastIn  { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
    @keyframes mpToastOut { to { opacity:0; transform: translateY(8px); } }

    /* ── 2. TOOLTIPS ── */
    [data-tooltip] { position: relative; cursor: help; }
    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%);
      background: var(--sup-panel); color: var(--tinta-1);
      padding: 8px 12px; border-radius: var(--radio-chico);
      border: 1px solid var(--regla);
      font-size: 11px; line-height: 1.4;
      white-space: normal; width: max-content; max-width: 240px;
      z-index: 100;
      opacity: 0; pointer-events: none;
      transition: opacity .15s, transform .15s;
      box-shadow: 0 8px 24px rgba(26,26,24,.12);
    }
    [data-tooltip]:hover::after {
      opacity: 1;
      transform: translateX(-50%) translateY(-2px);
    }

    /* ── 3. SKELETON LOADERS estilo Bloomberg ── */
    @keyframes mpSkeletonShimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .bbg-skel {
      background: var(--sup-panel);
      background-size: 200% 100%;
      animation: mpSkeletonShimmer 1.6s ease-in-out infinite;
      border-radius: var(--radio-chico);
      display: inline-block;
      vertical-align: middle;
    }
    .bbg-skel-line { display: block; height: 10px; margin: 6px 0; border-radius: 999px; }
    .bbg-skel-line.lg { height: 14px; }
    .bbg-skel-line.sm { height: 8px; }
    .bbg-skel-pill { display:inline-block; width: 56px; height: 18px; border-radius: 999px; }

    /* Card skeleton — caja con borde tenue + líneas internas */
    .bbg-skel-card {
      background: rgba(26,26,24,.05);
      border: 1px solid rgba(26,26,24,.05);
      border-radius: var(--radio-tarjeta);
      padding: 14px;
      display: flex; flex-direction: column; gap: 6px;
      min-height: 86px;
    }
    .bbg-skel-card .bbg-skel-line { margin: 4px 0; }

    /* Tile compacto para mercados / divisas / commodities */
    .bbg-skel-tile {
      background: rgba(26,26,24,.05);
      border: 1px solid rgba(26,26,24,.05);
      border-radius: var(--radio-tarjeta);
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 4px;
      min-height: 64px;
    }

    /* Bloomberg ticker tape — barra horizontal estilo cinta */
    .bbg-tape {
      display:flex; gap: 18px; overflow: hidden;
      padding: 8px 12px;
      background: rgba(26,26,24,.05);
      border: 1px solid rgba(26,26,24,.05);
      border-radius: var(--radio-tarjeta);
    }
    .bbg-tape .bbg-skel-line { margin: 0; }

    /* Compatibilidad con el viejo .mp-skeleton */
    .mp-skeleton {
      background: linear-gradient(90deg, rgba(26,26,24,.05) 0%, rgba(26,26,24,.10) 50%, rgba(26,26,24,.05) 100%);
      background-size: 200% 100%;
      animation: mpSkeletonShimmer 1.6s ease-in-out infinite;
      border-radius: var(--radio-chico);
      display: inline-block;
    }

    /* ── 4. TUTORIAL OVERLAY ── */
    #mp-tour-backdrop {
      position: fixed; inset: 0; background: rgba(26,26,24,.40);
      z-index: 9998; backdrop-filter: blur(2px);
      display: none;
    }
    #mp-tour-tooltip {
      position: fixed; z-index: 10001; max-width: 320px;
      background: var(--sup-panel); border: 1px solid var(--sello);
      border-radius: var(--radio-tarjeta); padding: 18px 20px;
      box-shadow: 0 0 0 4px rgba(156,93,18,0.15), 0 24px 64px -12px rgba(26,26,24,.12);
      display: none;
    }
    #mp-tour-tooltip.mp-tour-anim {
      animation: mpTourPop .35s cubic-bezier(.18,.95,.32,1) both;
    }
    @keyframes mpTourPop { from { opacity:0; transform: scale(.92); } to { opacity:1; transform: scale(1); } }
    #mp-tour-tooltip h4 {
      font-size: 14px; font-weight: 600; color: var(--tinta-1); margin: 0 0 6px 0;
    }
    #mp-tour-tooltip p {
      font-size: 12px; color: var(--tinta-3); line-height: 1.5; margin: 0 0 14px 0;
    }
    #mp-tour-tooltip .mp-tour-actions {
      display: flex; justify-content: space-between; align-items: center;
    }
    #mp-tour-tooltip .mp-tour-progress {
      font-size: 10px; color: var(--tinta-4); letter-spacing: 0.1em;
    }
    #mp-tour-tooltip button {
      background: var(--sello); color: var(--sup); font-weight: 600; font-size: 13px;
      border: none; padding: 8px 16px; border-radius: var(--radio); cursor: pointer;
      min-height: 36px;
    }
    #mp-tour-tooltip button.skip {
      background: transparent; color: var(--tinta-4); padding: 8px 10px;
    }
    #mp-tour-tooltip button:hover { filter: brightness(1.1); }
    /* Mobile: bottom-sheet full-width, NO box-shadow 9999px trick */
    @media (max-width: 639px) {
      #mp-tour-backdrop {
        background: rgba(26,26,24,.40); /* más oscuro porque ya no usamos shadow trick */
      }
      #mp-tour-tooltip {
        padding: 18px 18px calc(18px + env(safe-area-inset-bottom, 0px));
        border-radius: var(--radio-tarjeta) var(--radio-tarjeta) 0 0;
        border-top: 2px solid var(--sello);
        border-left: none; border-right: none; border-bottom: none;
      }
      #mp-tour-tooltip h4 { font-size: 17px; margin-bottom: 8px; line-height: 1.3; }
      #mp-tour-tooltip p  { font-size: 14px; margin-bottom: 18px; line-height: 1.5; }
      #mp-tour-tooltip .mp-tour-actions {
        gap: 8px;
      }
      #mp-tour-tooltip button {
        font-size: 15px; padding: 12px 22px; min-height: 48px;
        border-radius: var(--radio);
      }
      #mp-tour-tooltip button.skip {
        font-size: 14px;
      }
      /* En mobile el highlight es solo un outline verde — el backdrop
         oscurece todo lo de atrás, así no necesitamos el shadow trick */
      .mp-tour-highlight {
        outline: 3px solid var(--sello) !important;
        outline-offset: 4px;
        box-shadow: none !important;
        border-radius: var(--radio);
      }
    }
    /* Desktop: highlight con shadow trick */
    @media (min-width: 640px) {
      .mp-tour-highlight {
        position: relative; z-index: 9999 !important;
        box-shadow: 0 0 0 4px rgba(156,93,18,0.5), 0 0 0 9999px rgba(26,26,24,.40) !important;
        border-radius: var(--radio);
        transition: box-shadow .3s;
      }
    }

    /* ====================================================================
       MOBILE POLISH — overhaul de espaciado/tamaños para que se sienta
       como app nativa en lugar de "web responsive". Solo aplica < 768px.
       ==================================================================== */
    @media (max-width: 767px) {
      /* --- Base: tap feedback nativo y safe areas iOS --- */
      html {
        -webkit-tap-highlight-color: rgba(156,93,18,0.15);
        -webkit-text-size-adjust: 100%;
      }
      body {
        padding-left:  env(safe-area-inset-left,  0);
        padding-right: env(safe-area-inset-right, 0);
      }
      /* Botones y links: active state con scale (feedback táctil nativo) */
      button, a, [role="button"], .nav-tab {
        -webkit-tap-highlight-color: transparent;
      }
      button:active, a:active, [role="button"]:active, .nav-tab:active {
        transform: scale(0.97);
        transition: transform .08s;
      }

      /* --- Inputs: 48px+ alto y 16px font-size (evita zoom iOS) --- */
      input[type="text"], input[type="email"], input[type="tel"],
      input[type="number"], input[type="search"], input[type="password"],
      input[type="date"], input[type="url"], select, textarea {
        font-size: 16px !important;
        min-height: 44px;
        padding: 10px 12px;
        border-radius: var(--radio);
      }
      textarea { min-height: 80px; }
      /* Inputs especiales para teclados móviles inteligentes */
      input[inputmode="decimal"], input[inputmode="numeric"] {
        font-size: 16px !important;
      }

      /* --- Botones touch-friendly (44px+ alto) --- */
      button:not(.mp-toast-close):not(#mp-tour-close-x):not(.mpm-icon-btn):not(.nav-tab),
      .btn, [type="submit"], [type="button"] {
        min-height: 44px;
      }
      /* Tab nav: más alto y con scroll horizontal suave */
      .nav-tab {
        min-height: 48px !important;
        font-size: 13px !important;
        padding: 10px 14px !important;
        scroll-snap-align: start;
      }
      /* Contenedor de tabs: scroll horizontal sin scrollbar */
      nav, [class*="nav-"], header [class*="flex"] {
        scrollbar-width: none;
      }
      nav::-webkit-scrollbar, [class*="nav-"]::-webkit-scrollbar {
        display: none;
      }

      /* --- Padding mobile-first en cards --- */
      .bg-surface-card {
        padding: 14px !important;
        border-radius: var(--radio-tarjeta) !important;
      }
      .bg-surface-card.p-3, .bg-surface-card.p-3\\.5 {
        padding: 12px !important;
      }
      .bg-surface-card.p-6, .bg-surface-card.p-8 {
        padding: 16px !important;
      }

      /* --- Grids: gap reducido y stack más temprano --- */
      .grid.gap-3 { gap: 8px !important; }
      .grid.gap-4 { gap: 10px !important; }
      .grid.gap-5, .grid.gap-6 { gap: 12px !important; }

      /* --- Tipografía: jerarquía más legible en pantalla chica --- */
      body {
        font-size: 14px;
        line-height: 1.55;
      }
      h1, .text-3xl, .text-4xl { font-size: 22px !important; line-height: 1.2 !important; }
      /* El :not() es obligatorio. Sin él, este !important aplastaba a 19px
         CUALQUIER h2, incluido el título de pantalla (.mp-titulo-vista, 30px):
         "El mercado hoy" se renderizaba 2px MÁS CHICO que el nombre de un
         ticker dentro de una tarjeta. Jerarquía invertida en el teléfono más
         común del público. Solo 2 de los 17 h2 del markup llevan clase mp-,
         así que la excepción no afecta a nada más. */
      h2:not([class*="mp-"]), .text-2xl { font-size: 19px !important; line-height: 1.25 !important; }
      h3:not([class*="mp-"]), .text-xl  { font-size: 16px !important; line-height: 1.3 !important; }
      .text-lg      { font-size: 15px !important; }
      .text-sm      { font-size: 13px !important; }
      .text-xs      { font-size: 12px !important; }
      .text-\\[10px\\], .text-\\[11px\\] { font-size: 11px !important; }
      /* Tabular numbers (KPIs): más grandes para destacar */
      .tabular.text-3xl, .text-3xl.tabular { font-size: 26px !important; }
      .tabular.text-2xl, .text-2xl.tabular { font-size: 22px !important; }

      /* --- Spacings entre secciones --- */
      main:not(:has(.mp-mazos)), .container, section:not([class*="mp-"]) {
        padding-left:  14px !important;
        padding-right: 14px !important;
      }
      section:not([class*="mp-"]) + section:not([class*="mp-"]) { margin-top: 16px !important; }
      .mt-10 { margin-top: 18px !important; }
      .mt-8  { margin-top: 14px !important; }
      .my-8  { margin-top: 14px !important; margin-bottom: 14px !important; }

      /* --- Header principal sticky con sombra al scroll --- */
      header.sticky, header[class*="sticky"] {
        padding: 10px 14px !important;
        backdrop-filter: saturate(180%) blur(20px);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        background: var(--sup-grad-a) !important;
        border-bottom: 1px solid rgba(26,26,24,.05);
      }

      /* --- Tablas: scroll horizontal con shadow indicator --- */
      .overflow-x-auto {
        -webkit-overflow-scrolling: touch;
        scroll-snap-type: x proximity;
      }
      table { font-size: 12px !important; }
      th, td { padding: 8px 10px !important; white-space: nowrap; }

      /* --- Modales fullscreen en mobile (los que aún no lo son) --- */
      .fixed.inset-0 > div:not(#mp-tour-mobile):not(#mp-splash) {
        max-height: calc(100vh - env(safe-area-inset-top, 0) - env(safe-area-inset-bottom, 0) - 32px);
        max-width: calc(100vw - 24px) !important;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }

      /* --- Footer: padding reducido + safe area bottom --- */
      footer {
        padding-left:  14px !important;
        padding-right: 14px !important;
        padding-bottom: calc(20px + env(safe-area-inset-bottom, 0)) !important;
        font-size: 11px !important;
      }
      footer .flex.items-center.gap-3 { flex-wrap: wrap; gap: 8px !important; }
      footer .text-right { text-align: left !important; }

      /* --- Toast: posicionado bottom con safe area --- */
      #mp-toast-host {
        bottom: calc(20px + env(safe-area-inset-bottom, 0)) !important;
        left: 12px !important; right: 12px !important;
        top: auto !important;
      }
      #mp-toast-host > div {
        max-width: none !important;
        width: 100% !important;
      }

      /* --- Reducir animaciones que se sienten lentas en mobile ---
         OJO CON EL SELECTOR: esto era el universal (asterisco) y, como
         transition-property vale "all" por defecto, poner duración a TODOS
         los elementos encendía la transición de CUALQUIER propiedad que
         cambiara — incluidas height y width puestas desde JS. Efecto real:
         medir un elemento justo después de asignarle alto devolvía un valor a
         medio camino (los mazos del Periódico quedaban cortados porque la
         pista se medía a sí misma en pleno vuelo). Ahora solo se acortan las
         animaciones de lo que YA declaraba transición. */
      [class*="transition"], [class*="animate"], .fade-up,
      button, a, [role="button"], .nav-tab {
        animation-duration: 0.25s !important;
        transition-duration: 0.18s !important;
      }

      /* --- Pull-to-refresh disable en iOS (la app tiene su propio refresh) --- */
      html, body {
        overscroll-behavior-y: contain;
      }

      /* --- Botones del banner demo / CTAs principales: más grandes --- */
      .bg-accent-green, [class*="bg-accent-"] {
        min-height: 44px;
      }
      /* Excepción: badges y spans pequeños */
      span.bg-accent-green, span[class*="bg-accent-"],
      .text-\\[10px\\].bg-accent-green, .text-\\[11px\\].bg-accent-green {
        min-height: auto !important;
      }

      /* --- Headers de sección con menos space-y excesivo --- */
      .space-y-6 > * + * { margin-top: 14px !important; }
      .space-y-8 > * + * { margin-top: 16px !important; }
      .space-y-10 > * + * { margin-top: 18px !important; }

      /* --- Inputs de búsqueda: ícono visible, padding correcto --- */
      input[type="search"], input[placeholder*="uscar"], input[placeholder*="iltrar"] {
        padding-left: 12px;
      }
    }

    /* ====================================================================
       MOBILE POLISH ROUND 2 — fixes específicos a estructura existente
       ==================================================================== */
    @media (max-width: 767px) {
      /* --- HEADER PRINCIPAL: compacto, no roba espacio --- */
      header.sticky {
        padding: 8px 12px !important;
      }
      /* Logo: 28px en lugar de 40px */
      header img[alt="Mi Portafolio"], header img[alt*="Portafolio"] {
        width: 30px !important;
        height: 30px !important;
        border-radius: var(--radio-chico) !important;
      }
      /* Ocultar el subtítulo "Análisis de inversión" en mobile (espacio precioso) */
      header h1 + p { display: none !important; }
      /* Título del header más compacto */
      header h1 {
        font-size: 14px !important;
        line-height: 1 !important;
      }
      /* Selector de portafolio: sin border-left feo, más compacto */
      header .border-l { border-left: none !important; padding-left: 4px !important; margin-left: 4px !important; }
      header #port-selector-btn {
        padding: 6px 8px !important;
        font-size: 12px !important;
      }
      /* Ocultar nombre largo del portafolio en mobile (queda el avatar) */
      header #port-active-nombre {
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: inline-block;
        font-size: 12px;
      }
      /* Botón ? de ayuda: más compacto */
      header button[onclick*="iniciarTour"], header button[title*="utorial"] {
        padding: 6px !important;
        min-width: 32px;
      }

      /* --- NAV TABS: forzar 1 línea con scroll horizontal ---
         Los selectores se anclan a #mp-topbar y NO a nav.sticky: desde que
         header y sub-nav se pegaron como un solo bloque, el sticky vive en
         #mp-topbar y el nav ya no lleva esa clase, así que estas reglas
         habían dejado de aplicar por completo.

         Y el ancla importa por otra razón: .nav-tab no es solo la pestaña
         de navegación, es el hook de ruteo de bindNav(), así que también lo
         llevan tarjetas de contenido dentro de main. Sin acotar, el
         white-space:nowrap de aquí impedía que sus párrafos rompieran
         línea y metía hasta 371px de scroll horizontal en iPhone. */
      #mp-topbar nav > div {
        flex-wrap: nowrap !important;
        overflow-x: auto !important;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        padding-left: 12px !important;
        padding-right: 12px !important;
      }
      #mp-topbar nav > div::-webkit-scrollbar { display: none; }
      #mp-topbar nav .hidden.sm\\:block { display: none !important; } /* Divider vertical: oculto */
      #mp-topbar .nav-tab {
        flex-shrink: 0 !important;
        white-space: nowrap !important;
        padding: 8px 12px !important;
        font-size: 11px !important;
        min-height: 44px !important;
      }

      /* --- SECTIONS: padding lateral consistente ---
         Las secciones del sistema de diseño (clases mp-) quedan FUERA: su
         espaciado sale de la escala de --paso-N y estas reglas se lo pisaban
         con números sueltos (14/12), que es exactamente lo que hacía que el
         Periódico se sintiera de otra app que el resto de la pantalla. */
      .max-w-7xl:not([class*="mp-"]) {
        padding-left: 14px !important;
        padding-right: 14px !important;
      }
      section.max-w-7xl:not([class*="mp-"]), main > section:not([class*="mp-"]) {
        padding-top: 12px !important;
        padding-bottom: 12px !important;
      }

      /* --- GRIDS de tickers: 1 columna full-width en mobile --- */
      #pick-curado-lista,
      #universo-lista,
      #perfiles-grid {
        grid-template-columns: 1fr !important;
      }
      /* Cards de tickers más altas y picables */
      #pick-curado-lista > *,
      #universo-lista > * {
        min-height: 52px !important;
        padding: 10px 12px !important;
      }

      /* --- KPI grids (grid-cols-2) ya está bien en mobile, solo gap --- */
      .grid.grid-cols-2 { gap: 8px !important; }
      /* En pantallas MUY chicas (<360px) hasta los KPIs van apilados */
      @media (max-width: 359px) {
        .grid.grid-cols-2 { grid-template-columns: 1fr !important; }
      }

      /* --- "TU PORTAFOLIO" card: más compacta + botón visible siempre --- */
      [class*="bg-surface-card"]:has(#pick-resumen-count),
      [class*="bg-surface-card"]:has([id*="pick-resumen"]) {
        position: sticky;
        bottom: 0;
        z-index: 20;
        margin-left: -14px;
        margin-right: -14px;
        border-radius: var(--radio-tarjeta) var(--radio-tarjeta) 0 0;
        border-bottom: none;
        padding: 12px 14px !important;
        background: var(--sup-panel) !important;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 -10px 30px -10px rgba(26,26,24,.12);
      }

      /* --- Botones disabled: que se vea mejor su estado disabled --- */
      button:disabled {
        opacity: 0.5 !important;
      }

      /* --- Textos descriptivos largos: line-clamp en mobile para no robar espacio --- */
      section p.text-xs.text-zinc-500,
      section p.text-\\[11px\\].text-zinc-500,
      section p.text-zinc-600.text-\\[11px\\] {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* --- Headers de sección (h2, h3): margen reducido --- */
      h1, h2, h3 { margin-bottom: 8px !important; }
      h1 + p, h2 + p, h3 + p { margin-top: 4px !important; }

      /* --- Filtros buttons (Todas/Top/MX/US/Cripto): tamaño consistente --- */
      [class*="filter-btn"], .pick-filtro, .nav-filter {
        min-height: 36px !important;
        padding: 8px 12px !important;
        font-size: 12.5px !important;
        white-space: nowrap;
      }

      /* --- Search inputs (lupa + texto): más prominentes --- */
      input[placeholder*="uscar"],
      input[id="pick-buscar"], input[id="universo-buscar"] {
        font-size: 16px !important;
        padding: 12px 14px 12px 38px !important;
        min-height: 48px !important;
        background-position: 12px center !important;
      }
    }

    /* ====================================================================
       MOBILE EXTRA SMALL (< 380px) — iPhones SE/Mini
       ==================================================================== */
    @media (max-width: 379px) {
      body { font-size: 13.5px; }
      /* Mismo :not() que arriba: los títulos del sistema (clase mp-) llevan su
         propia escala y no deben aplastarse. */
      h1:not([class*="mp-"]), .text-3xl, .text-4xl { font-size: 20px !important; }
      h2:not([class*="mp-"]), .text-2xl { font-size: 17px !important; }
      .bg-surface-card { padding: 12px !important; }
      /* El padding lateral NO se toca en las secciones del sistema: la pista de
         mazos y la cabecera del Periódico ya definen su propio aire con la
         escala de espaciado, y bajarlo a 10px descuadraba la retícula. */
      main:not(:has(.mp-mazos)), .container, section:not([class*="mp-"]) {
        padding-left: 10px !important;
        padding-right: 10px !important;
      }
      .nav-tab { font-size: 12px !important; padding: 8px 10px !important; }
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
  // Azúcar toast.success(msg) / .error / .info / .warn. La forma canónica sigue
  // siendo toast(msg, tipo), pero es fácil escribir la variante con punto por
  // costumbre y antes eso lanzaba TypeError silencioso.
  ['success', 'error', 'info', 'warn'].forEach((t) => {
    window.toast[t] = (msg, duration) => window.toast(msg, t, duration);
  });

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
  // Bloomberg-style skeletons (window.bbgSkel.*)
  // ============================================================
  window.bbgSkel = {
    // Línea de texto (block)
    line(width = '100%', cls = '') {
      return `<span class="bbg-skel bbg-skel-line ${cls}" style="width:${width};"></span>`;
    },
    // Pill / chip (badge de retorno %)
    pill(width = '52px') {
      return `<span class="bbg-skel bbg-skel-pill" style="width:${width};"></span>`;
    },
    // Tile compacto (ETF / divisa / commodity)
    tile() {
      return `<div class="bbg-skel-tile">
        <span class="bbg-skel bbg-skel-line sm" style="width:50%"></span>
        <span class="bbg-skel bbg-skel-line lg" style="width:80%"></span>
        <span class="bbg-skel bbg-skel-line sm" style="width:35%"></span>
      </div>`;
    },
    // Card grande con título + 3 líneas de detalle
    card() {
      return `<div class="bbg-skel-card">
        <span class="bbg-skel bbg-skel-line lg" style="width:60%"></span>
        <span class="bbg-skel bbg-skel-line" style="width:90%"></span>
        <span class="bbg-skel bbg-skel-line" style="width:75%"></span>
        <span class="bbg-skel bbg-skel-line sm" style="width:45%"></span>
      </div>`;
    },
    // Grid de N tiles
    tileGrid(n = 6, cols = 3) {
      const tiles = Array.from({length:n}, () => this.tile()).join('');
      return `<div class="grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));gap:10px">${tiles}</div>`;
    },
    // Cinta horizontal estilo ticker tape
    tape(n = 5) {
      const items = Array.from({length:n}, () => `
        <span class="bbg-skel bbg-skel-line lg" style="width:90px"></span>
      `).join('');
      return `<div class="bbg-tape">${items}</div>`;
    },
    // Llena un contenedor con un grid de N tiles
    fillTiles(elOrId, n = 6, cols = 3) {
      const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
      if (el) el.innerHTML = this.tileGrid(n, cols);
    },
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
      selector: '#onboarding-chooser, #portafolio-optimo-card',
      title: 'Arma tu portafolio',
      body: 'Elige "Automático" y mueve el slider a tu nivel de riesgo (volatilidad): te armamos la mezcla óptima con Markowitz. O elige "Manual" para escoger tus acciones tú mismo.',
    },
  ];

  function _esMobile() {
    // Múltiples checks porque iOS Safari puede reportar innerWidth raro
    // 1) Media query (más confiable que innerWidth)
    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) return true;
    // 2) Pointer coarse = touch device (iOS, Android)
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900) return true;
    // 3) Fallback al check viejo
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
        style="position:absolute;top:8px;right:10px;background:transparent;border:none;color:var(--tinta-4);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;min-height:auto;">×</button>
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

  // ============================================================
  // MOBILE TUTORIAL — wizard fullscreen totalmente independiente
  // ============================================================
  // No toca el DOM existente, no scrollea, no posiciona nada relativo
  // a elementos. Solo un modal fullscreen con 4 pantallas y botón gigante.
  // Imposible que falle por stacking context, iOS Safari, etc.
  function _iniciarTourMobile() {
    if (document.getElementById('mp-tour-mobile')) return;
    let idx = 0;
    const total = TOUR_STEPS.length;

    const html = `
      <div id="mp-tour-mobile" style="
        position: fixed; inset: 0; z-index: 999999;
        background: var(--sup);
        display: flex; flex-direction: column;
        padding: env(safe-area-inset-top, 16px) 20px env(safe-area-inset-bottom, 16px);
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      ">
        <!-- Header con close -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;">
          <span id="mpm-progreso" style="font-size:11px;font-weight:600;letter-spacing:0.15em;color:var(--sello);text-transform:uppercase;"></span>
          <button id="mpm-cerrar" aria-label="Cerrar tutorial" style="
            background: rgba(26,26,24,.05);
            border: none; color: var(--tinta-1);
            width: 36px; height: 36px; border-radius: 50%;
            font-size: 20px; cursor: pointer; padding: 0;
            display: flex; align-items: center; justify-content: center;
          ">×</button>
        </div>

        <!-- Contenido central -->
        <div style="flex:1; display:flex; flex-direction:column; justify-content:center; padding: 40px 0;">
          <div id="mpm-icono" style="
            width: 64px; height: 64px; border-radius: var(--radio-tarjeta);
            background: var(--sup-panel);
            display: flex; align-items: center; justify-content: center;
            font-size: 32px; margin-bottom: 24px;
            box-shadow: 0 0 40px rgba(156,93,18,0.3);
          "><span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M4 19V11"/><path d="M10 19V6"/><path d="M16 19V14"/><path d="M22 19H2"/></svg></span></div>
          <h2 id="mpm-titulo" style="
            font-size: 26px; font-weight: 700; color: var(--tinta-1);
            margin: 0 0 14px; letter-spacing: -0.02em; line-height: 1.2;
          "></h2>
          <p id="mpm-cuerpo" style="
            font-size: 16px; color: var(--tinta-3);
            margin: 0; line-height: 1.55;
          "></p>
        </div>

        <!-- Footer con dots y botón gigante -->
        <div style="padding-bottom: 8px;">
          <div id="mpm-dots" style="display:flex;justify-content:center;gap:6px;margin-bottom:20px;"></div>
          <button id="mpm-siguiente" style="
            display: block; width: 100%;
            background: var(--sello); color: var(--sup);
            border: none; border-radius: var(--radio);
            padding: 18px;
            font-size: 17px; font-weight: 700;
            cursor: pointer;
            box-shadow: 0 8px 24px -8px rgba(156,93,18,0.6);
            -webkit-tap-highlight-color: transparent;
          "></button>
          <button id="mpm-saltar" style="
            display: block; width: 100%;
            background: transparent; color: var(--tinta-4);
            border: none; padding: 14px;
            font-size: 14px; cursor: pointer; margin-top: 4px;
          ">Saltar tutorial</button>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.body.style.overflow = 'hidden';

    const ICONOS = ['<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M4 19V11"/><path d="M10 19V6"/><path d="M16 19V14"/><path d="M22 19H2"/></svg></span>', '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg></span>', '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="2.5" y="5" width="19" height="14"/><path d="M6 9h7"/><path d="M6 13h7"/><path d="M6 16h4"/><path d="M16 9h3v7h-3z"/></svg></span>', '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg></span>'];

    function render() {
      const step = TOUR_STEPS[idx];
      document.getElementById('mpm-progreso').textContent = `Paso ${idx+1} de ${total}`;
      document.getElementById('mpm-titulo').textContent = step.title;
      document.getElementById('mpm-cuerpo').textContent = step.body;
      document.getElementById('mpm-icono').innerHTML = ICONOS[idx] || ICONOS[0];
      document.getElementById('mpm-siguiente').textContent = (idx === total-1) ? 'Empezar a usar la app' : 'Siguiente';
      // Dots
      const dots = TOUR_STEPS.map((_, i) =>
        `<span style="width:${i===idx?'24':'8'}px;height:8px;border-radius:999px;background:${i===idx?MP_COLOR.sello:MP_COLOR.reglaFuerte};transition:width .25s;"></span>`
      ).join('');
      document.getElementById('mpm-dots').innerHTML = dots;
    }

    function cerrar() {
      _marcarCompletado();
      document.body.style.overflow = '';
      document.getElementById('mp-tour-mobile')?.remove();
    }
    function siguiente() {
      if (idx === total - 1) { cerrar(); return; }
      idx++;
      render();
    }

    document.getElementById('mpm-siguiente').addEventListener('click', siguiente);
    document.getElementById('mpm-saltar').addEventListener('click', cerrar);
    document.getElementById('mpm-cerrar').addEventListener('click', cerrar);

    render();
  }

  function _iniciarTour() {
    if (_esMobile()) {
      _iniciarTourMobile();
      return;
    }
    _crearOverlay();
    document.getElementById('mp-tour-backdrop').style.display = 'block';
    _mostrarPaso(0);
  }

  // Auto-trigger: si es modo demo O primer visita SIN portafolio guardado.
  //
  // Solo con sesión iniciada. El tour se monta con z-index 999999 y la pantalla
  // de acceso con 99998, así que en una visita anónima el tour tapaba el
  // formulario: cuatro pasos explicando funciones que todavía no se pueden
  // tocar, y detrás, escondido, el único control que servía para algo.
  window.addEventListener('load', () => {
    setTimeout(async () => {
      if (_yaCompletado()) return;
      try {
        const e = await window.__mpSesionLista;
        if (!e || !e.autenticado) return;
      } catch (_) { return; }
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
      background: radial-gradient(ellipse at center, var(--sup-panel) 0%, var(--sup-hondo) 70%);
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 16px;
      animation: mpSplashOut .5s ease-in .9s forwards;
    }
    @keyframes mpSplashOut { to { opacity: 0; pointer-events: none; visibility: hidden; } }
    #mp-splash img {
      width: 80px; height: 80px; border-radius: var(--radio-tarjeta);
      box-shadow: 0 0 60px rgba(156,93,18,0.5);
      animation: mpSplashLogo .6s cubic-bezier(.18,.95,.32,1) both;
    }
    @keyframes mpSplashLogo {
      from { opacity: 0; transform: scale(.6); }
      to   { opacity: 1; transform: scale(1); }
    }
    #mp-splash .mp-splash-name {
      font-family: 'Source Serif 4', Georgia, serif; font-weight: 700;
      font-size: 22px; letter-spacing: -0.02em;
      background: var(--sup-panel);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: mpSplashName .5s ease-out .25s both;
    }
    @keyframes mpSplashName { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    #mp-splash .mp-splash-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--sello);
      animation: mpSplashDot 1s ease-in-out infinite;
      box-shadow: 0 0 12px rgba(156,93,18,0.8);
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
    if (document.getElementById('mp-streak-widget')) return;

    // Se inserta en el cluster IZQUIERDO del header, junto al logo, por id.
    //
    // OJO: antes esto era querySelector('header .flex.items-center.gap-3'), que
    // matchea DOS elementos —el wrapper externo (que además lleva
    // justify-between) y el cluster izquierdo— y querySelector devuelve el
    // PRIMERO, o sea el equivocado. El chip quedaba como tercer hijo de un
    // contenedor space-between, así que Flex repartía tres bloques en vez de
    // dos: el cluster derecho se iba al centro y "Suscribirse" terminaba encima
    // del avatar del portafolio. Por eso hay que anclar por id y NO por clases.
    const host = document.getElementById('header-left');
    // Sin el ancla no se inserta en ningún otro lado: es mejor quedarse sin chip
    // (es decorativo) que volver a romper el header.
    if (!host) return;

    const widget = document.createElement('div');
    widget.id = 'mp-streak-widget';
    widget.className = 'mp-streak-chip';
    widget.title = `Llevas ${data.count} días seguidos checando tu portafolio. Sigue así.`;
    // El número va en su propio span para poder ocultarlo por CSS en la variante
    // compacta sin volver a tocar el DOM.
    // Marca gráfica propia (barras ascendentes) en vez del emoji del fuego:
    // la app no debe apoyarse en el set de emoji del sistema para su identidad.
    widget.innerHTML =
      `<span class="mp-streak-ico mp-marca" aria-hidden="true">` +
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">` +
          `<path d="M4 19V13"/><path d="M10 19V9"/><path d="M16 19V5"/><path d="M22 19H2"/>` +
        `</svg>` +
      `</span><span class="mp-streak-num">${data.count}d</span>`;
    host.appendChild(widget);
  }

  // Estilos del chip de racha. Van en CSS (no inline) para poder degradarlo por
  // ancho de pantalla con media queries.
  //
  // PRIORIDAD del header en pantallas angostas: "Suscribirse" y "Mi cuenta"
  // siempre completos y clickeables — son lo que el revisor de Apple tiene que
  // encontrar (2.1(b) y 5.1.1(v)). La racha es decorativa y cede primero:
  //   < 500px  (iPhone vertical): oculta. Medido: el header necesita 399px solo
  //            para logo+avatar+chip+botones y no caben ni sin el chip a 375px.
  //   500-767px: compacta, solo el fuego (el contador vive en el tooltip).
  //   >= 768px (iPad y iPhone horizontal): completa con el contador.
  const streakCSS = `
    .mp-streak-chip {
      display: none;                 /* por defecto oculta: se habilita por MQ */
      align-items: center; gap: 5px;
      flex: none;                    /* nunca se comprime ni corta el número */
      padding: 3px 7px;
      background: transparent;
      border: 1px solid rgba(156,93,18,0.4);
      border-radius: 999px;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-variant-numeric: tabular-nums lining-nums;
      font-size: 10.5px; font-weight: 500; line-height: 1;
      letter-spacing: 0.04em;
      color: var(--sello);
      white-space: nowrap;
    }
    .mp-streak-ico { width: 11px; height: 11px; line-height: 1; }
    .mp-streak-ico svg { width: 100%; height: 100%; }
    @media (min-width: 500px) {
      .mp-streak-chip { display: inline-flex; padding: 4px 8px; }
      .mp-streak-chip .mp-streak-num { display: none; }   /* compacta */
    }
    @media (min-width: 768px) {
      .mp-streak-chip { padding: 4px 10px; }
      .mp-streak-chip .mp-streak-num { display: inline; } /* completa */
    }
  `;
  const streakStyle = document.createElement('style');
  streakStyle.textContent = streakCSS;
  document.head.appendChild(streakStyle);
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
      a: 'Pruébala gratis 14 días, sin tarjeta. Después $65 MXN/mes con todas las funciones incluidas. Cancela en un click cuando quieras, sin permanencia.',
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
      <div id="mp-faq-modal" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);max-width:640px;width:100%;max-height:85vh;overflow-y:auto;">
          <div style="position:sticky;top:0;background:var(--sup);border-bottom:1px solid var(--regla);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <h2 style="margin:0;font-size:18px;font-weight:600;color:var(--tinta-1);">Preguntas frecuentes</h2>
            <button onclick="document.getElementById('mp-faq-modal').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="padding:8px 24px 24px;">
            ${FAQ_DATA.map(item => `
              <details style="border-bottom:1px solid var(--regla);padding:14px 0;">
                <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--tinta-1);list-style:none;display:flex;justify-content:space-between;align-items:center;">
                  <span>${item.q}</span>
                  <span style="color:var(--sello);font-size:18px;font-weight:300;">+</span>
                </summary>
                <p style="margin:10px 0 0;font-size:13px;color:var(--tinta-3);line-height:1.6;">${item.a}</p>
              </details>
            `).join('')}
            <p style="margin-top:24px;padding-top:16px;border-top:1px solid var(--regla);font-size:11px;color:var(--tinta-4);text-align:center;">
              ¿Otra duda? Escríbenos a <a href="mailto:soporte@miportafolio.app" style="color:var(--sello);">soporte@miportafolio.app</a>
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
      isr:  { bg: 'rgba(156,93,18,0.1)',  border: 'rgba(156,93,18,0.3)',  color: MP_COLOR.sello, label: 'ISR' },
      sat:  { bg: 'rgba(156,93,18,0.1)',  border: 'rgba(156,93,18,0.3)',  color: MP_COLOR.sello, label: 'SAT' },
      tip:  { bg: 'rgba(156,93,18,0.1)',   border: 'rgba(156,93,18,0.3)',   color: MP_COLOR.sello, label: 'TIP' },
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
      <div class="mt-4 pt-4 border-t border-surface-border flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between">
        <p class="text-[10px] text-zinc-600 italic flex-1">Recordatorios genéricos. No constituyen asesoría fiscal.</p>
        <button id="mp-fiscal-export-ics" class="text-[11px] px-3 py-2 rounded border border-accent-indigo/30 text-accent-indigo hover:bg-accent-indigo/10 transition font-medium whitespace-nowrap" title="Descarga las fechas SAT + earnings de tus tickers como archivo .ics para Google Calendar / Apple Calendar / Outlook">
          ↓ Descargar a tu calendario (.ics)
        </button>
      </div>
    `;
    host.appendChild(widget);
    document.getElementById('mp-fiscal-export-ics')?.addEventListener('click', () => {
      try {
        let tickers = [];
        try { tickers = JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]'); } catch {}
        const params = new URLSearchParams({
          tickers:    (tickers || []).join(','),
          earnings:   '1',
          dividendos: '1',
          fiscal:     '1',
        });
        const url = `/api/calendario/ics?${params.toString()}`;
        // Forzar download
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mi-portafolio.ics';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.toast && window.toast('Calendario descargado. Ábrelo para importar a Google/Apple Calendar.', 'success', 5000);
      } catch (e) {
        window.toast && window.toast('Error generando calendario: ' + e.message, 'error');
      }
    });
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
      <div id="mp-gloss-modal" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);max-width:680px;width:100%;max-height:85vh;overflow-y:auto;">
          <div style="position:sticky;top:0;background:var(--sup);border-bottom:1px solid var(--regla);padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <h2 style="margin:0;font-size:18px;font-weight:600;color:var(--tinta-1);">Glosario financiero</h2>
              <p style="margin:2px 0 0;font-size:11px;color:var(--tinta-4);">${GLOSARIO.length} términos en español plano</p>
            </div>
            <button onclick="document.getElementById('mp-gloss-modal').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="padding:8px 24px 24px;">
            <input type="text" id="mp-gloss-search" placeholder="Filtrar términos..." style="width:100%;background:var(--sup-panel);border:1px solid var(--regla);color:var(--tinta-1);padding:10px 14px;border-radius:var(--radio);font-size:13px;margin:12px 0 16px;outline:none;">
            <div id="mp-gloss-list">
              ${GLOSARIO.map(item => `
                <div class="gloss-item" style="border-bottom:1px solid var(--regla);padding:12px 0;">
                  <p style="margin:0 0 4px;font-weight:600;font-size:13px;color:var(--sello);">${item.termino}</p>
                  <p style="margin:0;font-size:12px;color:var(--tinta-3);line-height:1.55;">${item.def}</p>
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
      <div id="mp-curso-modal" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px);">
        <div style="background:var(--sup);border:1px solid var(--sello);border-radius:var(--radio-tarjeta);max-width:480px;width:100%;box-shadow:0 0 80px -20px rgba(156,93,18,0.4);">
          <div style="padding:16px 20px 12px;border-bottom:1px solid var(--regla);display:flex;align-items:center;justify-content:space-between;">
            <div>
              <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--sello);">Mini-curso</p>
              <h3 style="margin:2px 0 0;font-size:14px;color:var(--tinta-1);font-weight:600;">${curso.titulo}</h3>
            </div>
            <button onclick="document.getElementById('mp-curso-modal').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="height:3px;background:var(--regla);">
            <div class="mp-curso-progress-fill" style="height:100%;background:var(--sello);transition:width .3s;width:0;"></div>
          </div>
          <div style="padding:32px 28px;min-height:200px;">
            <h2 class="mp-curso-titulo-slide" style="margin:0 0 14px;font-size:22px;font-weight:700;color:var(--tinta-1);letter-spacing:-0.01em;line-height:1.2;"></h2>
            <p class="mp-curso-cuerpo" style="margin:0;font-size:14px;color:var(--tinta-3);line-height:1.65;"></p>
          </div>
          <div style="padding:14px 20px;border-top:1px solid var(--regla);display:flex;align-items:center;justify-content:space-between;">
            <button class="mp-curso-prev" style="background:transparent;border:1px solid var(--regla);color:var(--tinta-3);padding:6px 14px;border-radius:var(--radio);font-size:12px;cursor:pointer;">← Atrás</button>
            <span class="mp-curso-pos" style="font-size:11px;color:var(--tinta-4);font-weight:600;letter-spacing:0.1em;"></span>
            <button class="mp-curso-next" style="background:var(--sello);border:none;color:var(--sup);padding:6px 18px;border-radius:var(--radio);font-size:12px;font-weight:600;cursor:pointer;"></button>
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
      <button onclick="document.getElementById('mp-cursos-index').remove(); window.abrirCurso('${id}')" style="display:block;width:100%;text-align:left;background:var(--sup-panel);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:14px 16px;margin-bottom:8px;cursor:pointer;color:var(--tinta-1);transition:border-color .2s;" onmouseover="this.style.borderColor=MP_COLOR.sello" onmouseout="this.style.borderColor=MP_COLOR.regla">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <p style="margin:0;font-size:14px;font-weight:600;color:var(--tinta-1);">${c.titulo}</p>
            <p style="margin:2px 0 0;font-size:11px;color:var(--tinta-4);">${c.slides.length} slides · ~3 min</p>
          </div>
          <span style="color:var(--sello);">→</span>
        </div>
      </button>
    `).join('');
    document.body.insertAdjacentHTML('beforeend', `
      <div id="mp-cursos-index" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);max-width:440px;width:100%;padding:20px 24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--sello);">Aprende rápido</p>
              <h2 style="margin:2px 0 0;font-size:18px;color:var(--tinta-1);font-weight:600;">Mini-cursos</h2>
            </div>
            <button onclick="document.getElementById('mp-cursos-index').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;line-height:1;">×</button>
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
      background: var(--sup-panel);
      border: 1px solid rgba(156,93,18,0.25);
      border-radius: var(--radio-chico); font-size: 10px; line-height: 1.4;
      color: var(--sello);
    `;
    let msg;
    if (pct >= 95) msg = `Tu Sharpe está en el <strong style="color:var(--tinta-1);">top ${100-pct}%</strong> — élite.`;
    else if (pct >= 80) msg = `Mejor que el <strong style="color:var(--tinta-1);">${pct}%</strong> de inversionistas retail.`;
    else if (pct >= 50) msg = `Mejor que el <strong style="color:var(--tinta-1);">${pct}%</strong> de inversionistas retail.`;
    else if (pct >= 25) msg = `Mejor que el <strong style="color:var(--tinta-1);">${pct}%</strong> — hay margen.`;
    else msg = `Top ${100-pct}% inferior — revisa tu mezcla.`;
    badge.innerHTML = msg + ' <span style="color:var(--tinta-4);">vs benchmarks públicos</span>';
    host.appendChild(badge);
  }
  // Auto-render cuando los KPIs ya están listos
  window.addEventListener('load', () => {
    setTimeout(() => _renderComparativaWidget(), 3000);
    setTimeout(() => _renderComparativaWidget(), 6000);  // segundo intento por si tardó el análisis
  });

})();
