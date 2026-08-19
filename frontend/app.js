// ============================================================
//  Mi Portafolio - Frontend logic (web + Capacitor iOS)
// ============================================================
//
//  Detección de plataforma + base URL del API:
//  - En navegador web normal: API_BASE = '' (paths relativos /api/...)
//  - En Capacitor iOS: API_BASE = window.MP_API_BASE (URL absoluta a Render)
//
//  Para producción iOS, define en Capacitor app:
//    window.MP_API_BASE = 'https://miportafolio.onrender.com';
//  (se inyecta vía script tag en el index cargado por Capacitor)
//
// ============================================================
const IS_CAPACITOR = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const API_BASE = (window.MP_API_BASE || '').replace(/\/$/, '');

// ============================================================================
//  MP_COLOR — paleta única para el JS
// ============================================================================
//  La fuente de verdad es :root en mp-tokens.css. Aquí NO se redefine el tema:
//  se LEE del CSSOM, así que cambiar un token en el CSS cambia también las
//  gráficas, los SVG generados por JS y los estilos en línea, sin tocar este
//  archivo. Los valores literales son solo red de seguridad por si esta hoja
//  aún no se aplicó (nunca debería: los <link> van en <head> y estos scripts
//  al final de <body>).
//
//  Dónde usar cada cosa:
//    · valor CSS en una plantilla  →  var(--token)   (directo, sin JS)
//    · valor que consume JS        →  MP_COLOR.x     (Chart.js, canvas)
const MP_COLOR = (() => {
  const respaldo = {
    sup: '#EFF1F5', supPanel: '#FFFFFF', supAlto: '#FFFFFF', supHondo: '#E4E7EE',
    regla: '#E1E4EB', reglaSuave: '#EDEFF3', reglaFuerte: '#C3C8D4',
    tinta1: '#14161B', tinta2: '#3B404A', tinta3: '#585E6B', tinta4: '#5A6170',
    sello: '#8C520C', selloVivo: '#6F4009', selloSolido: '#8C520C', sobreSello: '#FFFFFF',
    alza: '#0F5C33', baja: '#962418',
  };
  const tokens = {
    sup: '--sup', supPanel: '--sup-panel', supAlto: '--sup-alto', supHondo: '--sup-hondo',
    regla: '--regla', reglaSuave: '--regla-suave', reglaFuerte: '--regla-fuerte',
    tinta1: '--tinta-1', tinta2: '--tinta-2', tinta3: '--tinta-3', tinta4: '--tinta-4',
    sello: '--sello', selloVivo: '--sello-vivo', selloSolido: '--sello-solido',
    sobreSello: '--sobre-sello', alza: '--alza', baja: '--baja',
  };
  const out = {};
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch (_) {}
  for (const k in tokens) {
    let v = '';
    try { v = (cs && cs.getPropertyValue(tokens[k]) || '').trim(); } catch (_) {}
    out[k] = v || respaldo[k];
  }
  // Tintes translúcidos derivados (Chart.js necesita el valor, no var()).
  out.rgba = (hex, a) => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  };
  return out;
})();
window.MP_COLOR = MP_COLOR;

// Wrapper de fetch que prefija API_BASE para llamadas a /api/
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, init) {
  if (typeof url === 'string' && url.startsWith('/api/') && API_BASE) {
    url = API_BASE + url;
    init = init || {};
    init.credentials = init.credentials || 'omit';
    // Inyectar JWT si existe (auth en iOS)
    try {
      const tk = localStorage.getItem('mp.jwt.v1');
      if (tk) {
        init.headers = Object.assign({}, init.headers || {}, { 'Authorization': 'Bearer ' + tk });
      }
    } catch (_) {}
  }
  return _origFetch(url, init);
};

// ── Carga en frío: sesión lista + reintentos ────────────────────────────────
// Una sola lectura de /api/auth/estado, memoizada: (a) garantiza que el
// token/cookie esté resuelto ANTES de pedir datos (evita el error transitorio
// en nativo cuando el fetch sale sin Authorization) y (b) "despierta" el backend.
window.__mpSesionLista = (async () => {
  try {
    const r = await fetch('/api/auth/estado?t=' + Date.now(), { cache: 'no-store' });
    return await r.json();
  } catch (_) { return { autenticado: false }; }
})();

// fetch de JSON con reintentos para cold-start del backend. NO reintenta errores
// 4xx (auth/entrada) — solo 5xx/red/429 (servidor frío o caído momentáneamente).
async function fetchJsonRetry(url, init, opts) {
  const { intentos = 2, delay = 3500, onRetry = null } = (opts || {});
  let ultimoErr;
  for (let i = 0; i <= intentos; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const j = await res.json().catch(() => ({}));
        const e = new Error((j && j.error) || ('HTTP ' + res.status));
        e.status = res.status; e.body = j; throw e;   // 4xx: no reintentar
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);   // 5xx: reintentable
      return await res.json();
    } catch (err) {
      ultimoErr = err;
      if (err && err.status && err.status < 500 && err.status !== 429) throw err;
      if (i < intentos) { if (onRetry) try { onRetry(i + 1); } catch (_) {} await new Promise(r => setTimeout(r, delay)); continue; }
      throw ultimoErr;
    }
  }
  throw ultimoErr;
}

// ── Autocompletar por NOMBRE o ticker, reutilizable en TODAS las lupas ───────
// Crea su propio dropdown (no requiere HTML extra) y usa /api/buscar-ticker
// (Yahoo: soporta nombre parcial, ticker, ETFs, crypto, índices). Al elegir,
// rellena el input con el ticker correcto y llama onPick(ticker, item) si se pasa.
window.attachTickerAutocomplete = function (input, onPick) {
  if (!input || input.dataset.acWired) return;
  input.dataset.acWired = '1';
  const wrap = input.parentElement || input;
  try { if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative'; } catch (_) {}
  const box = document.createElement('div');
  box.className = 'hidden absolute z-30 left-0 right-0 mt-1 bg-surface-card border border-surface-border rounded-md shadow-lg max-h-56 overflow-y-auto text-sm';
  wrap.appendChild(box);
  let items = [], sel = -1, timer = null, seq = 0, ignorarProximo = false;
  const hide = () => { box.classList.add('hidden'); box.innerHTML = ''; sel = -1; };
  function render() {
    if (!items.length) { hide(); return; }
    box.innerHTML = items.map((r, i) =>
      `<div data-i="${i}" class="px-3 py-2 cursor-pointer ${i === sel ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/25'}">
         <span class="font-semibold text-zinc-100">${r.ticker}</span>
         <span class="text-zinc-400 ml-1">${String(r.nombre || '').slice(0, 44)}</span>
         ${r.tipo ? `<span class="text-[10px] text-zinc-600 ml-1">${r.tipo}</span>` : ''}
       </div>`).join('');
    box.classList.remove('hidden');
  }
  function pick(i) {
    const r = items[i]; if (!r) return;
    input.value = r.ticker;
    hide();
    /* El evento `input` que sigue es NUESTRO, no del usuario: sirve para que
       el resto de la app se entere del valor nuevo. Sin esta marca, el
       manejador de abajo lo tomaba por tecleo, programaba una búsqueda a 220ms
       y el desplegable volvía a abrirse solo —encima de un campo que el onPick
       pudo haber vaciado ya, como hace el buscador de "Tus listas"—. */
    clearTimeout(timer);
    ignorarProximo = true;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    ignorarProximo = false;
    if (typeof onPick === 'function') onPick(r.ticker, r);
  }
  async function buscar(q) {
    const mine = ++seq;
    try {
      const res = await fetch('/api/buscar-ticker?q=' + encodeURIComponent(q) + '&limite=12');
      const body = await res.json();
      if (mine !== seq) return;             // respuesta obsoleta
      items = Array.isArray(body) ? body.slice(0, 12) : [];
      sel = -1; render();
    } catch (_) { hide(); }
  }
  input.addEventListener('input', () => {
    if (ignorarProximo) return;              // lo disparó pick(), no el usuario
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => buscar(q), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { hide(); }
  });
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('[data-i]');
    if (el) { e.preventDefault(); pick(parseInt(el.dataset.i, 10)); }
  });
  document.addEventListener('click', (e) => { if (e.target !== input && !box.contains(e.target)) hide(); });
};

// Cablea el autocompletar en todas las lupas de resolución (input -> ticker).
// #cmp-input y #pick-buscar YA tienen su propio buscador por nombre; no se tocan.
function bindAutocompletes() {
  const lupas = ['an-input', 'dd-input', 'sml-input', 'comprar-ticker-input', 'tx-form-ticker', 'brokers-ticker'];
  lupas.forEach(id => {
    const el = document.getElementById(id);
    if (el) window.attachTickerAutocomplete(el);
  });
}

// ============================================================
//  Carga /api/resultados y /api/info-activos y renderiza:
//   - hero (KPIs del portafolio)
//   - comparación vs benchmark (con alpha)
//   - gráfica de rendimiento acumulado
//   - gráfica de drawdown
//   - tabla de activos
//   - heatmap de correlaciones
//   - concentración (sector / país / moneda)
//   - volatilidad móvil 30d
//
//  El frontend es DEFENSIVO: si resultados.json es v2 (sin
//  concentracion ni series_tiempo), esas secciones se esconden
//  gracilmente y el resto sigue funcionando.
// ============================================================

// --- utilidades -------------------------------------------------------------

const fmtPct = (v, decimales = 2, signo = true) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = signo && v > 0 ? '+' : '';
  return `${s}${v.toFixed(decimales)}%`;
};

const fmtNum = (v, decimales = 2) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(decimales);
};

const claseColor = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return 'text-zinc-300';
  if (v > 0.01) return 'text-accent-green';
  if (v < -0.01) return 'text-accent-red';
  return 'text-zinc-300';
};

const $ = (id) => document.getElementById(id);

// ============================================================================
//  MP_GRAFICA — tema ÚNICO de Chart.js (estética de prensa sobre papel)
// ============================================================================
// Un solo objeto de configuración para TODAS las gráficas de la app, en vez de
// estilos dispersos por cada `new Chart(...)`:
//   · líneas de 1.5–2px, sin relleno ni gradiente bajo la curva
//   · el benchmark siempre punteado y recesivo
//   · sin gridlines verticales en ejes de tiempo; las horizontales son
//     hairlines en gris cálido (--regla), del mismo peso que las de la página
//   · ejes recesivos: la línea del eje desaparece, mandan las etiquetas
//   · etiquetas de eje y tooltip en monoespaciada con cifras tabulares
// Cambiar aquí cambia la app entera. Los valores salen de MP_COLOR, que a su
// vez los lee de mp-tokens.css: el tema de las gráficas NO se define aparte.
const MP_GRAFICA = {
  sup:         MP_COLOR.sup,
  panel:       MP_COLOR.supPanel,
  regla:       MP_COLOR.regla,
  reglaFuerte: MP_COLOR.reglaFuerte,
  tinta1:      MP_COLOR.tinta1,
  tinta2:      MP_COLOR.tinta2,
  tinta3:      MP_COLOR.tinta3,
  sello:       MP_COLOR.sello,
  alza:        MP_COLOR.alza,
  baja:        MP_COLOR.baja,
  mono:        "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
  sans:        "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",

  /* Trazo principal: la serie del usuario. */
  serie(color, opts = {}) {
    return {
      borderColor: color || this.sello,
      backgroundColor: 'transparent',
      fill: false,              // nunca relleno con gradiente
      tension: 0,               // trazo de prensa: recto, sin suavizado
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHoverBackgroundColor: color || this.sello,
      pointHoverBorderWidth: 0,
      ...opts,
    };
  },

  /* Trazo de referencia: benchmark punteado y en tinta apagada. */
  referencia(opts = {}) {
    return {
      borderColor: this.tinta3,
      borderDash: [3, 3],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 3,
      ...opts,
    };
  },

  /* Tooltip común: ficha de datos impresa —papel con filete de tinta—, no
     la burbuja oscura de fábrica (sobre papel claro se veía como un agujero). */
  tooltip(callbacks = {}) {
    return {
      backgroundColor: this.panel,
      borderColor: this.tinta1,
      borderWidth: 1,
      cornerRadius: 2,
      padding: 9,
      displayColors: false,
      titleColor: this.tinta1,
      titleFont: { family: this.mono, size: 10, weight: '600' },
      bodyColor: this.tinta2,
      bodyFont: { family: this.mono, size: 11 },
      ...(Object.keys(callbacks).length ? { callbacks } : {}),
    };
  },

  /* Eje de tiempo: sin gridlines verticales, etiquetas mono. */
  ejeTiempo(extra = {}) {
    return {
      grid: { display: false, drawTicks: false },
      border: { color: this.regla },
      ticks: {
        color: this.tinta3,
        font: { family: this.mono, size: 9.5 },
        maxTicksLimit: 6,
        autoSkip: true,
        maxRotation: 0,
        padding: 6,
      },
      ...extra,
    };
  },

  /* Eje de valor: hairlines horizontales tenues, etiquetas mono. */
  ejeValor(extra = {}) {
    return {
      grid: { color: this.regla, drawTicks: false, lineWidth: 1 },
      border: { display: false },
      ticks: {
        color: this.tinta3,
        font: { family: this.mono, size: 9.5 },
        maxTicksLimit: 5,
        padding: 8,
      },
      ...extra,
    };
  },

  /* Leyenda: rótulos mono, marcas cuadradas y pequeñas. */
  leyenda(display = false) {
    return {
      display,
      labels: {
        color: this.tinta3,
        font: { family: this.mono, size: 10 },
        boxWidth: 8, boxHeight: 2, usePointStyle: false, padding: 14,
      },
    };
  },

  /* Base compartida por cualquier gráfica de la app. */
  base(opts = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 160 },     // micro-interacción sobria
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: this.leyenda(false), tooltip: this.tooltip() },
      ...opts,
    };
  },
};
window.MP_GRAFICA = MP_GRAFICA;

// Defaults de Chart.js para el tema claro.
// OJO: Chart.js carga con `defer` (ver index.html), asi que puede NO estar
// definido cuando app.js se evalua. Sin la guarda, esta linea lanzaba
// "Cannot set properties of undefined (setting 'color')", lo que abortaba TODA
// la evaluacion de app.js -> no se registraba el DOMContentLoaded -> ningun
// boton se enlazaba -> SPA congelado. Aplicamos de forma guardada y de nuevo
// en 'load', cuando el script diferido ya ejecuto.
function _aplicarChartDefaults() {
  if (typeof Chart === 'undefined' || !Chart.defaults) return;
  Chart.defaults.color = MP_GRAFICA.tinta3;
  Chart.defaults.borderColor = MP_GRAFICA.regla;
  Chart.defaults.font.family = MP_GRAFICA.mono;
  Chart.defaults.font.size = 10;
  Chart.defaults.elements.line.tension = 0;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.arc.borderColor = MP_GRAFICA.panel;
  Chart.defaults.elements.arc.borderWidth = 1;
  Chart.defaults.plugins.tooltip.cornerRadius = 2;
}
_aplicarChartDefaults();
window.addEventListener('load', _aplicarChartDefaults);

// --- persistencia del portafolio del usuario --------------------------------
// v2: guarda tickers + pesos (fracciones que suman 1). Retrocompatible con v1.
const LS_KEY = 'miPortafolio.tickers.v1';
const LS_KEY_PESOS = 'miPortafolio.pesos.v1';

function leerPortafolioGuardado() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return arr;
  } catch {
    return null;
  }
}

function leerPesosGuardados() {
  try {
    const raw = localStorage.getItem(LS_KEY_PESOS);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

function guardarPortafolio(tickers, pesos /* dict {ticker: fraccion} */) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tickers));
    if (pesos) localStorage.setItem(LS_KEY_PESOS, JSON.stringify(pesos));
  } catch {}
  // Sincronizar snapshot al backend (para alertas programadas)
  enviarSnapshotBackend();
}

// --- snapshot al backend (para tareas programadas) -------------------------
const LS_KEY_ALERTAS_CFG = 'miPortafolio.alertasCfg.v1';

function leerCfgAlertas() {
  try {
    const raw = localStorage.getItem(LS_KEY_ALERTAS_CFG);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Último correo de alertas que el backend llegó a registrar, para poder pedirle
// que borre ese snapshot cuando el usuario cambia de dirección.
let _destinatarioPrevio = (() => { try { return (leerCfgAlertas() || {}).destinatario || ''; } catch { return ''; } })();

function guardarCfgAlertas(cfg) {
  const previo = (leerCfgAlertas() || {}).destinatario || '';
  if (previo && previo !== (cfg.destinatario || '')) _destinatarioPrevio = previo;
  try { localStorage.setItem(LS_KEY_ALERTAS_CFG, JSON.stringify(cfg)); } catch {}
  return enviarSnapshotBackend();
}

let _snapshotPending = null;
let _snapshotEspera = null;
// Devuelve una promesa que resuelve {ok, error} cuando el POST (después del
// debounce) termina. Antes era fire-and-forget con `catch {}` y el comentario
// "no es crítico", que era falso: este snapshot es lo ÚNICO que habilita las
// alertas recurrentes por correo (el cron lee alertas_activas de ahí). Si el
// POST se perdía, la UI seguía prometiendo "se mandan automáticamente" y no
// llegaba ningún correo nunca, sin señal para nadie.
function enviarSnapshotBackend() {
  // Debounce 1.5s para no spamear cada cambio
  if (_snapshotPending) clearTimeout(_snapshotPending);
  if (!_snapshotEspera) {
    const e = {};
    e.promesa = new Promise((res) => { e.resolver = res; });
    _snapshotEspera = e;
  }
  const espera = _snapshotEspera;
  _snapshotPending = setTimeout(async () => {
    _snapshotEspera = null;
    let resultado = { ok: false, error: 'no se intentó' };
    try {
      const tickers = leerPortafolioGuardado() || [];
      const pesosFrac = leerPesosGuardados() || {};
      // Pesos en pp para coincidir con detectar_drift (que espera pp)
      const pesos_objetivo = {};
      Object.entries(pesosFrac).forEach(([t, v]) => { pesos_objetivo[t] = v * 100; });
      // Posiciones — del state.universo si está cargado
      let posiciones = [];
      try {
        const uniMap = (typeof state !== 'undefined' && state.universo)
          ? new Map(state.universo.map(x => [x.ticker, x])) : new Map();
        posiciones = tickers.map(t => {
          const u = uniMap.get(t) || {};
          return {
            ticker: t,
            nombre: u.nombre || t,
            peso_pct: pesos_objetivo[t] || 0,
            precio_actual: u.precio || null,
          };
        });
      } catch {}
      let txs = [];
      try {
        const raw = localStorage.getItem('miPortafolio.transacciones.v1');
        if (raw) txs = JSON.parse(raw) || [];
      } catch {}
      const cfg = leerCfgAlertas() || { destinatario: '', activas: {drift:false, precio:false, semanal:false} };
      const body = {
        destinatario:    cfg.destinatario || '',
        // Para que el backend borre el snapshot del correo anterior: si no, la
        // dirección vieja sigue recibiendo alertas para siempre (y puede ser de
        // alguien más si hubo un dedazo al teclearla).
        destinatario_anterior: _destinatarioPrevio || '',
        nombre:          'Charlie',
        pesos_objetivo,
        posiciones,
        transacciones:   txs,
        alertas_activas: cfg.activas || {drift:false, precio:false, semanal:false},
        metricas:        {},
      };
      const res = await fetch('/api/portafolio/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('el servidor respondió ' + res.status);
      const j = await res.json().catch(() => ({}));
      if (j && j.ok === false) throw new Error(j.error || 'el servidor no lo guardó');
      resultado = { ok: true };
    } catch (e) {
      resultado = { ok: false, error: (e && e.message) || 'sin conexión' };
      console.warn('[snapshot] no se pudo guardar en el servidor:', resultado.error);
    }
    espera.resolver(resultado);
  }, 1500);
  return espera.promesa;
}

function borrarPortafolioGuardado() {
  try {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_KEY_PESOS);
  } catch {}
}

// --- charts registry (para destruir al re-analizar) ------------------------
const _charts = {};
function _destroyChart(id) {
  if (_charts[id]) {
    try { _charts[id].destroy(); } catch {}
    delete _charts[id];
  }
}

// --- mostrar onboarding vs dashboard ---------------------------------------
// Selector de dos caminos en el onboarding: chooser → 'manual' | 'auto'
function _onbModo(m) {
  const ch = $('onboarding-chooser'), man = $('modo-manual'), aut = $('modo-auto');
  if (!ch || !man || !aut) return;
  ch.classList.toggle('hidden', m !== 'chooser');
  man.classList.toggle('hidden', m !== 'manual');
  aut.classList.toggle('hidden', m !== 'auto');
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#chooser-auto')) {
    _onbModo('auto');
    // Se pide aquí, al abrir la vista, no en el arranque de la app.
    if (typeof PortafolioOptimo !== 'undefined') PortafolioOptimo.asegurarCargado();
  }
  else if (e.target.closest('#chooser-manual')) _onbModo('manual');
  else if (e.target.closest('#chooser-ejemplo')) _verEjemplo();
  else if (e.target.closest('.onboarding-volver')) _onbModo('chooser');
});

// Carga el portafolio de muestra y entra directo al análisis. Existía solo tras
// ?demo=1, que en la app nativa es inalcanzable porque no hay barra de
// direcciones: sin esto, quien abre la app por primera vez —incluido el
// revisor de App Store— ve todas las pantallas en cero.
async function _verEjemplo() {
  _cargarPortafolioDemo();
  const tickers = leerPortafolioGuardado();
  const pesos = leerPesosGuardados();
  mostrarDashboard();
  await analizarYRender(tickers, pesos);
}

function mostrarOnboarding() {
  $('portafolio-onboarding').classList.remove('hidden');
  $('portafolio-dashboard').classList.add('hidden');
  $('btn-editar-portafolio').classList.add('hidden');
  $('btn-perfiles-portafolio')?.classList.add('hidden');
  $('btn-exportar-pdf')?.classList.add('hidden');
  _onbModo('chooser');
}

function mostrarDashboard() {
  $('portafolio-onboarding').classList.add('hidden');
  $('portafolio-dashboard').classList.remove('hidden');
  $('btn-editar-portafolio').classList.remove('hidden');
  $('btn-perfiles-portafolio')?.classList.remove('hidden');
  $('btn-exportar-pdf')?.classList.remove('hidden');
}

// --- carga principal --------------------------------------------------------

// ============================================================
// MODO DEMO — ?demo=1 en la URL precarga portafolio sample
// ============================================================
function _modoDemo() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('demo') === '1';
  } catch { return false; }
}

function _cargarPortafolioDemo() {
  // Portafolio de muestra, TODO en pesos y todo en la BMV.
  //
  // Antes mezclaba tickers de EE.UU., de México y cripto. Se cambió porque el
  // cálculo de transacciones suma los importes sin convertir divisa (guarda el
  // campo `moneda` pero no lo aplica), así que una cartera mixta produce un
  // "invertido" que suma pesos con dólares y sale mal. Con todo en MXN las
  // cifras cuadran, y de paso el ejemplo cae justo en el terreno que distingue
  // a la app: banca, telecom, consumo y una FIBRA de la Bolsa Mexicana, que es
  // sobre lo que aplica el ISR del art. 129 LISR.
  const tickersSample = ['AMXB.MX', 'GFNORTEO.MX', 'FUNO11.MX', 'FEMSAUBD.MX', 'WALMEX.MX', 'CEMEXCPO.MX', 'BIMBOA.MX', 'ORBIA.MX'];
  const pesosFracSample = {
    'AMXB.MX':     0.142,
    'GFNORTEO.MX': 0.168,
    'FUNO11.MX':   0.175,
    'FEMSAUBD.MX': 0.133,
    'WALMEX.MX':   0.124,
    'CEMEXCPO.MX': 0.113,
    'BIMBOA.MX':   0.087,
    'ORBIA.MX':    0.058,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tickersSample));
    localStorage.setItem(LS_KEY_PESOS, JSON.stringify(pesosFracSample));
    // Tickers y pesos solos dejan vacías las pantallas que dependen del
    // historial de operaciones: ISR, tax-loss harvesting y P&L realizado.
    // Son justo las que distinguen a la app, así que el ejemplo tiene que
    // traerlas pobladas o no enseña nada.
    if (!localStorage.getItem(LS_KEY_TX)) {
      localStorage.setItem(LS_KEY_TX, JSON.stringify(_TRANSACCIONES_DEMO));
    }
  } catch {}
}

// Operaciones de muestra. Los precios son cierres reales de la BMV en cada
// fecha, así que el P&L cuadra contra el mercado en vez de ser inventado.
// La composición es deliberada:
//   · ganancias (AMXB, CEMEX, GFNORTE, FUNO) → rendimiento y P&L no realizado
//   · tres posiciones en pérdida (WALMEX, BIMBO, ORBIA) → el tax-loss harvesting
//     tiene material que proponer, que es media pantalla de ISR
//   · dos ventas cerradas → hay utilidad realizada y por tanto ISR que estimar
const _TRANSACCIONES_DEMO = [
  { id: 'demo-01', ticker: 'AMXB.MX',     tipo: 'compra', fecha: '2024-03-28', shares: 3000, precio_unitario: 14.72,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-02', ticker: 'CEMEXCPO.MX', tipo: 'compra', fecha: '2024-03-28', shares: 2500, precio_unitario: 14.49,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-03', ticker: 'FEMSAUBD.MX', tipo: 'compra', fecha: '2024-03-28', shares: 200,  precio_unitario: 185.06, moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-04', ticker: 'WALMEX.MX',   tipo: 'compra', fecha: '2024-03-28', shares: 800,  precio_unitario: 62.80,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-05', ticker: 'BIMBOA.MX',   tipo: 'compra', fecha: '2024-03-28', shares: 500,  precio_unitario: 74.96,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-06', ticker: 'ORBIA.MX',    tipo: 'compra', fecha: '2024-03-28', shares: 900,  precio_unitario: 34.60,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-07', ticker: 'GFNORTEO.MX', tipo: 'compra', fecha: '2024-09-30', shares: 300,  precio_unitario: 116.90, moneda: 'MXN', comisiones: 0, notas: 'Ejemplo' },
  { id: 'demo-08', ticker: 'FUNO11.MX',   tipo: 'compra', fecha: '2024-09-30', shares: 2000, precio_unitario: 19.60,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo · FIBRA' },
  // Ventas parciales: dejan utilidad realizada, que es lo que grava el ISR.
  { id: 'demo-09', ticker: 'AMXB.MX',     tipo: 'venta',  fecha: '2026-02-27', shares: 1000, precio_unitario: 22.45,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo · toma de utilidad' },
  { id: 'demo-10', ticker: 'CEMEXCPO.MX', tipo: 'venta',  fecha: '2026-02-27', shares: 800,  precio_unitario: 21.57,  moneda: 'MXN', comisiones: 0, notas: 'Ejemplo · toma de utilidad' },
];

function _activarBannerDemo() {
  const banner = $('demo-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  // El header también es sticky top-0; al añadir el banner, ajusto el header
  // para que se pegue debajo del banner. Banner mide ~38px.
  document.querySelectorAll('header.sticky, nav.sticky').forEach(el => {
    const cur = parseInt(el.style.top || '0', 10) || 0;
    el.style.top = (cur + 38) + 'px';
  });
}

async function init() {
  // Si viene con ?demo=1 y el usuario no tiene portafolio, precargamos uno sample
  const esDemo = _modoDemo();
  if (esDemo) {
    const tickersExistentes = leerPortafolioGuardado();
    if (!tickersExistentes || tickersExistentes.length < 2) {
      _cargarPortafolioDemo();
    }
    _activarBannerDemo();
  }

  const tickers = leerPortafolioGuardado();
  if (!tickers || tickers.length < 2) {
    // Primera vez: mostrar picker
    mostrarOnboarding();
    Picker.cargar();
    return;
  }

  // Usuario ya tiene portafolio: analizar
  const pesos = leerPesosGuardados();
  await analizarYRender(tickers, pesos);
}

function renderRiesgoAvanzado(data) {
  const ra = data && data.riesgo_avanzado;
  const sec = $('seccion-riesgo');
  const grid = $('riesgo-avanzado-grid');
  if (!sec || !grid) return;
  if (!ra) { sec.classList.add('hidden'); return; }
  const pct = v => v == null ? '—' : `${v.toFixed(2)}%`;
  const num = v => v == null ? '—' : v.toFixed(2);
  const tiles = [
    { label: 'VaR 95% · 1 día', val: pct(ra.var_95_1d_pct), cls: 'text-accent-amber', hint: 'Pérdida que no deberías exceder en un día malo (19 de cada 20 días).' },
    { label: 'VaR 99% · 1 día', val: pct(ra.var_99_1d_pct), cls: 'text-accent-red', hint: 'Pérdida máxima esperada en un día muy malo (99% de confianza).' },
    { label: 'CVaR 95%', val: pct(ra.cvar_95_1d_pct), cls: 'text-accent-red', hint: 'Pérdida promedio en el peor 5% de los días (riesgo de cola).' },
    { label: 'Sortino', val: num(ra.sortino), cls: (ra.sortino > 1 ? 'text-accent-green' : 'text-zinc-100'), hint: 'Como Sharpe pero solo castiga las caídas. Arriba de 1 es bueno.' },
    { label: 'Calmar', val: num(ra.calmar), cls: (ra.calmar > 1 ? 'text-accent-green' : 'text-zinc-100'), hint: 'Retorno anual ÷ peor caída histórica. Más alto, mejor.' },
    { label: 'Beta', val: num(ra.beta), cls: 'text-zinc-100', hint: 'Sensibilidad vs el mercado. 1 = igual; mayor a 1 = más volátil.' },
  ];
  grid.innerHTML = tiles.map(t => `
    <div class="bg-zinc-900/40 rounded-lg p-3">
      <p class="text-[10px] text-zinc-500 uppercase tracking-wider">${t.label}</p>
      <p class="text-[18px] font-bold tabular ${t.cls}">${t.val}</p>
      <p class="text-[10px] text-zinc-600 mt-1 leading-snug">${t.hint}</p>
    </div>`).join('');
  sec.classList.remove('hidden');
}

async function analizarYRender(tickers, pesos /* dict opcional */) {
  mostrarDashboard();
  // Estado de carga en hero
  $('hero-titulo').textContent = `Analizando ${tickers.length} posiciones…`;
  $('hero-subtitulo').textContent = tickers.join(' · ');
  $('hero-retorno').textContent = '…';

  let data;
  try {
    const payload = { tickers };
    if (pesos && Object.keys(pesos).length) payload.pesos = pesos;
    // Reintenta ante cold-start (no ante 4xx). Mientras, mantiene el estado de carga.
    data = await fetchJsonRetry('/api/analizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { intentos: 2, delay: 3500, onRetry: (n) => {
      $('hero-titulo').textContent = `Despertando servidor… (${n}/2)`;
    } });
  } catch (err) {
    console.error(err);
    $('hero-titulo').textContent = 'No pude analizar tu portafolio';
    $('hero-subtitulo').textContent = (err.message || 'Error') + ' · Toca Editar para ajustar la selección.';
    $('hero-retorno').textContent = '—';
    return;
  }

  // info de activos viene embebida en la respuesta v3
  const info = data.info_activos || {};

  // Destruye charts previos (por si re-analizan)
  _destroyChart('chart-acumulado');
  _destroyChart('chart-drawdown');
  _destroyChart('chart-rolling-vol');
  // Oculta sección óptimo (se re-mostrará si aplica)
  const seccionOpt = $('seccion-optimo');
  if (seccionOpt) seccionOpt.classList.add('hidden');
  // Oculta banner monedas (se re-mostrará si aplica)
  const banner = $('banner-monedas');
  if (banner) banner.classList.add('hidden');

  renderMeta(data);
  renderHero(data);
  renderCuadernilloMexico(data);
  renderInsights(data);
  renderBenchmark(data);
  renderPortafolioOptimo(data);
  renderChartAcumulado(data);
  renderChartDrawdown(data);
  renderChartRollingVol(data);
  renderTablaActivos(data, info);
  renderCorrelaciones(data);
  renderConcentracion(data, info);
  renderRiesgoAvanzado(data);

  // Fundamentales (async, no bloquea)
  if (typeof Fundamentales !== 'undefined') {
    Fundamentales.cargar();
  }
}

// --- META ------------------------------------------------------------------

function renderMeta(data) {
  const m = data.metadata || {};
  const inicio = m.fecha_inicio;
  const fin    = m.fecha_fin;
  const activos = (m.activos || []).length;

  if (inicio && fin) {
    const fmt = (s) => {
      const [y, mo, d] = s.split('-');
      return `${d}/${mo}/${y}`;
    };
    $('meta-periodo').innerHTML = `
      <span class="w-1.5 h-1.5 rounded-full bg-accent-green"></span>
      <span>Período: ${fmt(inicio)} — ${fmt(fin)}</span>
    `;
  }

  const benchName = (t) => t === '^GSPC' ? 'S&P 500'
                      : t === '^MXX'  ? 'IPC México'
                      : (t || '');
  $('benchmark-label').textContent = m.benchmark
    ? `Benchmark: ${benchName(m.benchmark)}`
    : '';

  // Banner de monedas mixtas (solo si aplica)
  const banner = $('banner-monedas');
  if (banner && m.monedas_mixtas && Array.isArray(m.monedas) && m.monedas.length > 1) {
    const lista = m.monedas.join(' y ');
    const ls = $('banner-monedas-lista');
    if (ls) ls.textContent = lista;
    banner.classList.remove('hidden');
  }
}

// --- TITULAR ---------------------------------------------------------------
// Convierte los números que ya calculó el backend en una frase con voz de nota
// periodística ("Tu cartera le gana al mercado por doce puntos") en vez del
// típico rótulo de dashboard. No inventa nada: sólo redacta lo que hay en
// `data` — spread contra el benchmark, drawdown, Sharpe y las observaciones.

const _NUM_PALABRA = ['cero','un','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez',
  'once','doce','trece','catorce','quince','dieciséis','diecisiete','dieciocho','diecinueve','veinte',
  'veintiún','veintidós','veintitrés','veinticuatro','veinticinco','veintiséis','veintisiete',
  'veintiocho','veintinueve','treinta'];

// Los diarios escriben con letra las cantidades pequeñas.
function _enPalabras(n) {
  const e = Math.round(Math.abs(n));
  return e <= 30 ? _NUM_PALABRA[e] : String(e);
}

function redactarTitular(data) {
  const p = data.portafolio || {};
  const m = data.metadata || {};
  const b = data.benchmark || {};
  const activos = m.activos || [];
  const insights = Array.isArray(data.insights) ? data.insights : [];

  if (!activos.length) {
    return { titular: 'Tu portafolio, todavía sin posiciones',
             balazo: 'Agrega al menos dos emisoras para que podamos analizarlo.' };
  }

  const ret1y   = p.rendimiento_1y_pct ?? p.rendimiento_anualizado_pct;
  const sharpe  = p.sharpe_ratio;
  const ddMax   = p.max_drawdown_pct;
  // /api/analizar devuelve el exceso ya calculado en benchmark.alpha_portafolio_pct.
  const alpha   = b.alpha_portafolio_pct ??
                  ((p.rendimiento_anualizado_pct != null && b.rendimiento_anualizado_pct != null)
                    ? p.rendimiento_anualizado_pct - b.rendimiento_anualizado_pct : null);
  const nombreB = b.ticker === '^GSPC' ? 'el S&P 500'
                : b.ticker === '^MXX'  ? 'el IPC'
                : b.ticker ? b.ticker : 'el mercado';

  // "a el S&P 500" → "al S&P 500"; "de el IPC" → "del IPC".
  const contraer = (s) => s.replace(/\ba el\b/g, 'al').replace(/\bde el\b/g, 'del');
  const capitalizar = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  let titular;
  if (alpha != null && Math.abs(alpha) >= 1) {
    const puntos = _enPalabras(alpha);
    const plural = Math.round(Math.abs(alpha)) === 1 ? 'punto' : 'puntos';
    titular = alpha > 0
      ? `Tu cartera le gana a ${nombreB} por ${puntos} ${plural}`
      : `${nombreB} le saca ${puntos} ${plural} a tu cartera`;
  } else if (alpha != null) {
    titular = `Tu cartera va a la par de ${nombreB}`;
  } else if (ret1y != null && ret1y >= 0) {
    titular = `Tu cartera cierra el año en terreno positivo`;
  } else if (ret1y != null) {
    titular = `Tu cartera cierra el año en números rojos`;
  } else {
    titular = `${activos.length} ${activos.length === 1 ? 'posición' : 'posiciones'} bajo análisis`;
  }

  // Balazo: la segunda línea de una nota, con el matiz que falta.
  const partes = [];
  if (sharpe != null) {
    partes.push(sharpe >= 1
      ? `El Sharpe de ${sharpe.toFixed(2)} dice que el rendimiento sí paga el riesgo asumido.`
      : sharpe >= 0.5
        ? `Con un Sharpe de ${sharpe.toFixed(2)}, el rendimiento apenas compensa el riesgo.`
        : sharpe >= 0
          ? `Un Sharpe de ${sharpe.toFixed(2)} deja a los CETES peleando de tú a tú.`
          : `Un Sharpe negativo (${sharpe.toFixed(2)}) significa que los CETES te habrían ido mejor.`);
  }
  if (ddMax != null && Math.abs(ddMax) >= 5) {
    partes.push(`La peor caída del periodo llegó a ${Math.abs(ddMax).toFixed(1)}%.`);
  }
  const critico = insights.find(i => i.severidad === 'critico' || i.severidad === 'alto');
  if (critico && critico.titulo) partes.push(`${critico.titulo}.`);

  return { titular: capitalizar(contraer(titular)), balazo: partes.slice(0, 2).join(' ') };
}

// --- HERO ------------------------------------------------------------------

function renderHero(data) {
  const p = data.portafolio || {};
  const m = data.metadata || {};
  const activos = m.activos || [];

  // El titular se redacta con voz de nota sobre los datos ya calculados; la
  // enumeración de tickers baja a la línea de firma.
  const { titular, balazo } = redactarTitular(data);
  $('hero-titulo').textContent = titular;
  const balazoEl = $('hero-balazo');
  if (balazoEl) balazoEl.textContent = balazo;
  $('hero-subtitulo').textContent = activos.length
    ? `${activos.length} ${activos.length === 1 ? 'posición' : 'posiciones'} · ${activos.join(' · ')}`
    : '';

  // Retorno del último año (en hero, NO el total)
  // Si la serie de tiempo tiene los datos, calculamos el retorno de los últimos 252 días hábiles.
  // Como fallback, usamos rendimiento_anualizado_pct (el del periodo completo anualizado).
  let retorno1y = p.rendimiento_1y_pct;
  if (retorno1y == null && data.serie_tiempo && Array.isArray(data.serie_tiempo.portafolio_pct)) {
    const serie = data.serie_tiempo.portafolio_pct;
    if (serie.length >= 252) {
      // serie está en % acumulado desde día 0
      const final = serie[serie.length - 1];
      const hace1y = serie[serie.length - 252];
      // (1 + final/100) / (1 + hace1y/100) - 1
      const ratio_final = 1 + final / 100;
      const ratio_inicial = 1 + hace1y / 100;
      retorno1y = (ratio_final / ratio_inicial - 1) * 100;
    } else if (serie.length > 0) {
      retorno1y = serie[serie.length - 1];
    }
  }
  if (retorno1y == null) retorno1y = p.rendimiento_anualizado_pct;
  const heroEl = $('hero-retorno');
  heroEl.textContent = fmtPct(retorno1y);
  heroEl.className = `text-4xl sm:text-5xl font-bold tabular mt-1 ${claseColor(retorno1y)}`;

  // Período: siempre últimos 12 meses
  if (m.dias_observados && m.dias_observados < 252) {
    const meses = Math.round(m.dias_observados / 21);
    $('hero-periodo').textContent = `Últimos ~${meses} meses`;
  } else {
    $('hero-periodo').textContent = `Últimos 12 meses`;
  }

  // KPIs
  // Retorno PROMEDIO ANUAL: usa el CAGR de los últimos 5 años; si no hay tanta
  // historia, cae al anualizado del periodo completo.
  const ra = (p.rendimiento_prom_anual_5y_pct != null)
    ? p.rendimiento_prom_anual_5y_pct
    : p.rendimiento_anualizado_pct;
  $('kpi-retorno-anual').textContent = fmtPct(ra);
  $('kpi-retorno-anual').className = `text-2xl font-semibold tabular mt-1 ${claseColor(ra)}`;
  $('kpi-retorno-anual-ctx').textContent = ra >= 0
    ? 'Promedio por año (últimos 5 años)'
    : 'Pérdida promedio por año (últimos 5 años)';

  const vol = p.volatilidad_anual_pct;
  $('kpi-vol').textContent = fmtPct(vol, 1, false);
  $('kpi-vol-ctx').textContent = interpretarVol(vol);

  const sh = p.sharpe_ratio;
  $('kpi-sharpe').textContent = fmtNum(sh, 2);
  $('kpi-sharpe').className = `text-2xl font-semibold tabular mt-1 ${claseColor(sh)}`;
  $('kpi-sharpe-ctx').textContent = interpretarSharpe(sh);

  const dd = p.max_drawdown_pct;
  $('kpi-dd').textContent = fmtPct(dd, 1);
  $('kpi-dd-ctx').textContent = 'Peor caída desde un máximo';
}

function interpretarVol(v) {
  if (v === null || v === undefined) return '—';
  if (v < 12) return 'Baja · portafolio conservador';
  if (v < 20) return 'Moderada';
  if (v < 30) return 'Alta · movimientos fuertes';
  return 'Muy alta · riesgo elevado';
}

function interpretarSharpe(s) {
  if (s === null || s === undefined) return '—';
  if (s >= 1)    return 'Excelente relación riesgo/retorno';
  if (s >= 0.5)  return 'Buena relación riesgo/retorno';
  if (s >= 0)    return 'Supera a una tasa libre de riesgo';
  return 'No compensa el riesgo asumido';
}

// --- INSIGHTS (observaciones) ----------------------------------------------

const SEV_STYLES = {
  alta:      { bar: 'bg-accent-red',     badge: 'bg-accent-red/10 text-accent-red border-accent-red/20',       label: 'Importante', icon: 'alert' },
  media:     { bar: 'bg-accent-amber',   badge: 'bg-amber-500/10 text-accent-amber border-amber-500/20',        label: 'Atención',   icon: 'alert' },
  positivo:  { bar: 'bg-accent-green',   badge: 'bg-accent-green/10 text-accent-green border-accent-green/20',  label: 'Bien',       icon: 'check' },
  baja:      { bar: 'bg-zinc-600',       badge: 'bg-zinc-800 text-zinc-400 border-zinc-700',                    label: 'Nota',       icon: 'info' },
  info:      { bar: 'bg-accent-blue',    badge: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',     label: 'Info',       icon: 'info' },
};

const ICON_SVG = {
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  info:  '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
};

function renderInsights(data) {
  const seccion = $('seccion-insights');
  const grid = $('insights-grid');
  const count = $('insights-count');
  const insights = Array.isArray(data.insights) ? data.insights : [];

  if (!seccion || !grid) return;

  if (!insights.length) {
    seccion.classList.add('hidden');
    return;
  }
  seccion.classList.remove('hidden');
  count.textContent = `${insights.length} ${insights.length === 1 ? 'observación' : 'observaciones'}`;

  grid.innerHTML = insights.map(ins => {
    const style = SEV_STYLES[ins.severidad] || SEV_STYLES.info;
    const icon = ICON_SVG[style.icon] || ICON_SVG.info;
    return `
      <div class="bg-surface-card border border-surface-border rounded-xl overflow-hidden flex hover:border-zinc-700 transition">
        <div class="w-1 ${style.bar} shrink-0"></div>
        <div class="p-4 flex-1 min-w-0">
          <div class="flex items-start justify-between gap-3 mb-1.5">
            <div class="flex items-center gap-2 min-w-0">
              <svg class="w-4 h-4 shrink-0 ${style.bar.replace('bg-', 'text-')}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
              <h4 class="text-sm font-semibold text-zinc-100 truncate">${escapeHtml(ins.titulo || '')}</h4>
            </div>
            <span class="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border shrink-0 ${style.badge}">${style.label}</span>
          </div>
          <p class="text-xs text-zinc-400 leading-relaxed">${escapeHtml(ins.detalle || '')}</p>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- BENCHMARK -------------------------------------------------------------

function renderBenchmark(data) {
  const p = data.portafolio || {};
  const b = data.benchmark  || {};

  const alpha = b.alpha_portafolio_pct;
  const alphaEl = $('alpha-valor');
  alphaEl.textContent = fmtPct(alpha);
  alphaEl.className = `text-3xl font-bold tabular mt-1 ${claseColor(alpha)}`;

  const benchName = (b.ticker === '^GSPC') ? 'S&P 500'
                  : (b.ticker === '^MXX')  ? 'IPC México'
                  : (b.ticker || 'benchmark');

  $('alpha-explicacion').textContent = alpha >= 0
    ? `Tu portafolio superó al ${benchName} en ${fmtPct(alpha, 2, false)} al año`
    : `Tu portafolio rindió ${fmtPct(Math.abs(alpha), 2, false)} menos que el ${benchName} al año`;

  // Badge circular
  const badge = $('alpha-badge');
  if (alpha >= 0) {
    badge.className = 'w-16 h-16 rounded-full flex items-center justify-center bg-accent-green/10 text-accent-green shadow-glow-green';
  } else {
    badge.className = 'w-16 h-16 rounded-full flex items-center justify-center bg-accent-red/10 text-accent-red shadow-glow-red';
    // flecha hacia abajo
    badge.querySelector('svg').innerHTML = '<polyline points="3 7 9 13 13 9 21 17"></polyline>';
  }

  $('chart-bench-label').textContent = benchName;

  // Comparativa
  $('cmp-retorno-tu').textContent    = fmtPct(p.rendimiento_anualizado_pct);
  $('cmp-retorno-tu').className = `text-sm font-semibold tabular ${claseColor(p.rendimiento_anualizado_pct)}`;
  $('cmp-retorno-bench').textContent = fmtPct(b.rendimiento_anualizado_pct);

  $('cmp-vol-tu').textContent    = fmtPct(p.volatilidad_anual_pct, 1, false);
  $('cmp-vol-bench').textContent = fmtPct(b.volatilidad_anual_pct, 1, false);

  $('cmp-sharpe-tu').textContent    = fmtNum(p.sharpe_ratio, 2);
  $('cmp-sharpe-tu').className = `text-sm font-semibold tabular ${claseColor(p.sharpe_ratio)}`;
  $('cmp-sharpe-bench').textContent = fmtNum(b.sharpe_ratio, 2);

  $('cmp-dd-tu').textContent    = fmtPct(p.max_drawdown_pct, 1);
  $('cmp-dd-bench').textContent = fmtPct(b.max_drawdown_pct, 1);
}

// --- PORTAFOLIO ÓPTIMO (Markowitz) ----------------------------------------

function renderPortafolioOptimo(data) {
  const seccion = $('seccion-optimo');
  const opt = data.portafolio_optimo;
  const p   = data.portafolio || {};
  if (!seccion || !opt || !opt.pesos) return;

  seccion.classList.remove('hidden');

  const d = opt.delta_vs_actual || {};

  // Mejora de Sharpe (hero-number)
  const dSharpe = d.sharpe_ratio;
  const sharpeEl = $('opt-delta-sharpe');
  if (dSharpe !== undefined && dSharpe !== null) {
    const s = dSharpe > 0 ? '+' : '';
    sharpeEl.textContent = `${s}${dSharpe.toFixed(2)}`;
    sharpeEl.className = `text-2xl font-bold tabular ${dSharpe > 0.01 ? 'text-accent-green' : dSharpe < -0.01 ? 'text-accent-red' : 'text-zinc-300'}`;
  }

  // Pesos actuales vs óptimos (barras side-by-side)
  const pesosAct = p.pesos || {};
  const pesosOpt = opt.pesos || {};
  const tickers = Object.keys(pesosOpt);

  const rows = tickers.map(t => {
    const wa = (pesosAct[t] || 0) * 100;
    const wo = (pesosOpt[t] || 0) * 100;
    const maxW = Math.max(wa, wo, 1);
    return `
      <div>
        <div class="flex items-center justify-between text-[11px] mb-1">
          <span class="font-medium text-zinc-200">${t}</span>
          <span class="text-zinc-500 tabular">${wa.toFixed(1)}% <span class="text-zinc-700 mx-1">→</span> <span class="text-zinc-200 font-semibold">${wo.toFixed(1)}%</span></span>
        </div>
        <div class="space-y-1">
          <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div class="h-full bg-zinc-500" style="width:${(wa / maxW) * 100}%"></div>
          </div>
          <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div class="h-full bg-accent-blue" style="width:${(wo / maxW) * 100}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  $('opt-pesos').innerHTML = rows + `
    <div class="flex items-center gap-4 pt-2 text-[10px] text-zinc-500">
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-sm bg-zinc-500"></span>Actual</span>
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-sm bg-accent-blue"></span>Óptimo</span>
    </div>
  `;

  // Métricas
  const dppSign = (v, suffix = ' pp') => {
    if (v === null || v === undefined) return '—';
    const s = v > 0 ? '+' : '';
    return `${s}${v.toFixed(2)}${suffix}`;
  };
  const colorDelta = (v, mejorSiBaja = false) => {
    if (v === null || v === undefined || Math.abs(v) < 0.01) return 'text-zinc-500';
    const bueno = mejorSiBaja ? v < 0 : v > 0;
    return bueno ? 'text-accent-green' : 'text-accent-red';
  };

  $('opt-rend-actual').textContent = fmtPct(p.rendimiento_anualizado_pct, 1);
  $('opt-rend-opt').textContent    = fmtPct(opt.rendimiento_anualizado_pct, 1);
  $('opt-rend-delta').textContent  = dppSign(d.rendimiento_anualizado_pp);
  $('opt-rend-delta').className    = `text-xs tabular w-16 text-right ${colorDelta(d.rendimiento_anualizado_pp)}`;

  $('opt-vol-actual').textContent = fmtPct(p.volatilidad_anual_pct, 1, false);
  $('opt-vol-opt').textContent    = fmtPct(opt.volatilidad_anual_pct, 1, false);
  $('opt-vol-delta').textContent  = dppSign(d.volatilidad_anual_pp);
  $('opt-vol-delta').className    = `text-xs tabular w-16 text-right ${colorDelta(d.volatilidad_anual_pp, true)}`;

  $('opt-sharpe-actual').textContent = fmtNum(p.sharpe_ratio, 2);
  $('opt-sharpe-opt').textContent    = fmtNum(opt.sharpe_ratio, 2);
  $('opt-sharpe-delta').textContent  = (d.sharpe_ratio === undefined || d.sharpe_ratio === null)
    ? '—' : `${d.sharpe_ratio > 0 ? '+' : ''}${d.sharpe_ratio.toFixed(2)}`;
  $('opt-sharpe-delta').className    = `text-xs tabular w-16 text-right ${colorDelta(d.sharpe_ratio)}`;

  // Explicación natural
  const dr = d.rendimiento_anualizado_pp;
  const dv = d.volatilidad_anual_pp;
  let txt = 'Con los mismos activos pero otros pesos, ';
  if (dr > 0 && dv < 0)      txt += `habrías ganado más rendimiento y con menos volatilidad.`;
  else if (dr > 0 && dv >= 0) txt += `habrías ganado más rendimiento aceptando una vol similar o mayor.`;
  else if (dr <= 0 && dv < 0) txt += `habrías reducido la volatilidad manteniendo un rendimiento parecido.`;
  else                         txt += `tu asignación actual ya está cerca del óptimo.`;
  txt += ' Rendimientos pasados no garantizan resultados futuros.';
  $('opt-explicacion').textContent = txt;
}

// --- CHART: rendimiento acumulado -----------------------------------------

function renderChartAcumulado(data) {
  const st = data.series_tiempo;
  const canvas = $('chart-acumulado');
  const empty  = $('chart-acumulado-empty');

  // Backend v3 usa sufijo _pct y los valores ya están en porcentaje
  const port  = st && (st.rendimiento_acumulado_portafolio_pct || st.rendimiento_acumulado_portafolio);
  const bench = (st && (st.rendimiento_acumulado_benchmark_pct || st.rendimiento_acumulado_benchmark)) || [];

  if (!st || !st.fechas || !port) {
    canvas.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  canvas.classList.remove('hidden');
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  const fechas = st.fechas;

  // Serie del usuario en tinta de sello; benchmark punteado y recesivo.
  const datasets = [
    { label: 'Portafolio', data: port, ...MP_GRAFICA.serie(MP_GRAFICA.tinta1) },
  ];

  if (bench.length) {
    datasets.push({ label: 'Benchmark', data: bench, ...MP_GRAFICA.referencia() });
  }

  _charts['chart-acumulado'] = new Chart(canvas, {
    type: 'line',
    data: { labels: fechas, datasets },
    options: chartOptionsPct(),
  });
}

// --- CHART: drawdown -------------------------------------------------------

function renderChartDrawdown(data) {
  const st = data.series_tiempo;
  const canvas = $('chart-drawdown');
  const empty  = $('chart-drawdown-empty');

  const dd = st && (st.drawdown_portafolio_pct || st.drawdown_portafolio);

  if (!st || !st.fechas || !dd) {
    canvas.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    return;
  }
  canvas.classList.remove('hidden');
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  _charts['chart-drawdown'] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: st.fechas,
      datasets: [{
        label: 'Drawdown',
        data: dd,
        // El drawdown es dirección de mercado: rojo legítimo, sin relleno.
        ...MP_GRAFICA.serie(MP_GRAFICA.baja),
      }],
    },
    options: chartOptionsPct({ y_max: 0 }),
  });
}

// --- CHART: volatilidad rolling -------------------------------------------

function renderChartRollingVol(data) {
  const st = data.series_tiempo;
  const canvas = $('chart-rolling-vol');
  const empty  = $('chart-rolling-vol-empty');
  const seccion = $('seccion-rolling-vol');

  const vol30 = st && (st.volatilidad_rolling_30d_pct || st.volatilidad_rolling_30d);

  if (!st || !st.fechas || !vol30) {
    canvas.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    // Esconde la sección entera si no hay nada de series_tiempo
    if (!st) seccion.classList.add('hidden');
    return;
  }
  seccion.classList.remove('hidden');
  canvas.classList.remove('hidden');
  empty.classList.add('hidden');
  empty.classList.remove('flex');

  _charts['chart-rolling-vol'] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: st.fechas,
      datasets: [{
        label: 'Vol 30d',
        data: vol30,
        ...MP_GRAFICA.serie(MP_GRAFICA.sello, { borderWidth: 1.5 }),
      }],
    },
    options: chartOptionsPct(),
  });
}

// --- opciones comunes chart.js --------------------------------------------

// Opciones para series en porcentaje. Todo el estilo sale de MP_GRAFICA: aquí
// solo queda lo específico de estas gráficas (formato de fecha y de %).
function chartOptionsPct(opts = {}) {
  return MP_GRAFICA.base({
    plugins: {
      legend: MP_GRAFICA.leyenda(false),
      tooltip: MP_GRAFICA.tooltip({
        label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(2) + '%'}`,
      }),
    },
    scales: {
      x: MP_GRAFICA.ejeTiempo({
        ticks: {
          color: MP_GRAFICA.tinta3,
          font: { family: MP_GRAFICA.mono, size: 9.5 },
          maxTicksLimit: 6, autoSkip: true, maxRotation: 0, padding: 6,
          callback: function (val) {
            const label = this.getLabelForValue(val);
            if (!label) return '';
            // formato "MMM YY"
            const [y, m] = label.split('-');
            const mes = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][parseInt(m, 10) - 1] || m;
            return `${mes} ${y.slice(2)}`;
          },
        },
      }),
      y: MP_GRAFICA.ejeValor({
        ticks: {
          color: MP_GRAFICA.tinta3,
          font: { family: MP_GRAFICA.mono, size: 9.5 },
          maxTicksLimit: 5, padding: 8,
          callback: (v) => `${v.toFixed(0)}%`,
        },
        ...(opts.y_max !== undefined ? { max: opts.y_max } : {}),
      }),
    },
  });
}

// --- TABLA de activos -----------------------------------------------------

function renderTablaActivos(data, info) {
  const activos = data.por_activo || {};
  const pesos   = (data.portafolio && data.portafolio.pesos) || {};
  const tickers = Object.keys(activos);

  $('activos-count').textContent = `${tickers.length} activo${tickers.length === 1 ? '' : 's'}`;

  if (!tickers.length) {
    $('tabla-activos').innerHTML = `<tr><td colspan="8" class="px-5 py-8 text-center text-zinc-500 text-xs">Sin datos</td></tr>`;
    return;
  }

  const rows = tickers.map(t => {
    const a = activos[t] || {};
    const peso = (pesos[t] || 0) * 100;
    const meta = info[t] || {};
    const sector = meta.sector || '—';
    const nombre = meta.nombre || t;

    return `
      <tr class="hover:bg-surface-hover transition">
        <td class="px-5 py-3">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-semibold text-zinc-300">
              ${t.split('.')[0].slice(0, 3)}
            </div>
            <div>
              <div class="font-medium text-zinc-100 text-sm">${t}</div>
              <div class="text-[11px] text-zinc-500 truncate max-w-[180px]">${nombre}</div>
            </div>
          </div>
        </td>
        <td class="px-5 py-3 hidden md:table-cell text-xs text-zinc-400">${sector}</td>
        <td class="px-5 py-3 text-right tabular text-sm">${fmtPct(peso, 1, false)}</td>
        <td class="px-5 py-3 text-right tabular text-sm ${claseColor(a.rendimiento_total_pct)}">${fmtPct(a.rendimiento_total_pct, 1)}</td>
        <td class="px-5 py-3 text-right tabular text-sm hidden sm:table-cell ${claseColor(a.rendimiento_anualizado_pct)}">${fmtPct(a.rendimiento_anualizado_pct, 1)}</td>
        <td class="px-5 py-3 text-right tabular text-sm text-zinc-300 hidden md:table-cell">${fmtPct(a.volatilidad_anual_pct, 1, false)}</td>
        <td class="px-5 py-3 text-right tabular text-sm ${claseColor(a.sharpe_ratio)}">${fmtNum(a.sharpe_ratio)}</td>
        <td class="px-5 py-3 text-right tabular text-sm text-accent-red hidden lg:table-cell">${fmtPct(a.max_drawdown_pct, 1)}</td>
      </tr>
    `;
  }).join('');

  $('tabla-activos').innerHTML = rows;
}

// --- CORRELACIONES (heatmap CSS grid) -------------------------------------

function renderCorrelaciones(data) {
  const corr = data.correlaciones || {};
  const tickers = Object.keys(corr);
  const grid = $('correlaciones-grid');

  if (!tickers.length) {
    grid.innerHTML = `<div class="text-xs text-zinc-500 py-8 text-center">Sin datos</div>`;
    return;
  }

  // Color interpola entre rojo (correlación alta, malo para diversificación) y azul (negativa)
  const color = (v) => {
    // rango esperado: -1..1
    if (v === null || v === undefined) return MP_COLOR.supPanel;
    // Escala bipolar sobre papel: correlación positiva (mueve todo junto, mal
    // para diversificar) tiñe de --baja; negativa (diversifica de verdad)
    // tiñe de --alza. Alfas bajos para que la tinta del número siga leyéndose.
    if (v >= 1 - 0.001) return MP_COLOR.rgba(MP_COLOR.baja, 0.34);  // diagonal
    if (v >= 0) {
      const a = Math.min(1, v);
      return MP_COLOR.rgba(MP_COLOR.baja, 0.05 + a * 0.28);
    }
    const a = Math.min(1, -v);
    return MP_COLOR.rgba(MP_COLOR.alza, 0.05 + a * 0.28);
  };

  // Construcción del grid
  const nCols = tickers.length + 1;
  let html = `<div class="inline-grid gap-1 min-w-full" style="grid-template-columns: auto repeat(${tickers.length}, minmax(48px, 1fr));">`;
  // Header row
  html += `<div></div>`;
  tickers.forEach(t => {
    html += `<div class="text-[10px] text-zinc-400 text-center pb-1 font-medium truncate">${t}</div>`;
  });
  // Body rows
  tickers.forEach(r => {
    html += `<div class="text-[10px] text-zinc-400 pr-2 flex items-center justify-end font-medium truncate">${r}</div>`;
    tickers.forEach(c => {
      const v = corr[r] && corr[r][c];
      const bg = color(v);
      const txt = v === null || v === undefined ? '—' : v.toFixed(2);
      html += `<div class="corr-cell aspect-square rounded-md flex items-center justify-center text-[10px] tabular font-medium text-zinc-100 border border-zinc-800"
                    style="background:${bg};"
                    title="${r} vs ${c}: ${txt}">${txt}</div>`;
    });
  });
  html += `</div>`;

  // Leyenda
  html += `
    <div class="flex items-center justify-between mt-4 text-[10px] text-zinc-500">
      <div class="flex items-center gap-1.5">
        <span class="w-3 h-3 rounded" style="background: rgba(156,93,18,0.5)"></span>
        <span>Negativa</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="w-3 h-3 rounded bg-zinc-900"></span>
        <span>Neutral</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span>Alta</span>
        <span class="w-3 h-3 rounded" style="background: rgba(174,50,35,0.5)"></span>
      </div>
    </div>
  `;

  grid.innerHTML = html;
}

// --- CONCENTRACIÓN --------------------------------------------------------

// ETFs y fondos conocidos: mapeo manual para que no salgan como "Desconocido"
const _ETF_MAP = {
  // Broad market US
  'SPY': {sector:'ETF Mercado amplio (USA)', pais:'Estados Unidos', moneda:'USD'},
  'VOO': {sector:'ETF Mercado amplio (USA)', pais:'Estados Unidos', moneda:'USD'},
  'IVV': {sector:'ETF Mercado amplio (USA)', pais:'Estados Unidos', moneda:'USD'},
  'VTI': {sector:'ETF Mercado amplio (USA)', pais:'Estados Unidos', moneda:'USD'},
  // Tech
  'QQQ': {sector:'ETF Tecnología', pais:'Estados Unidos', moneda:'USD'},
  'XLK': {sector:'ETF Tecnología', pais:'Estados Unidos', moneda:'USD'},
  'SMH': {sector:'ETF Semiconductores', pais:'Estados Unidos', moneda:'USD'},
  // Internacional
  'VXUS': {sector:'ETF Mercado internacional', pais:'Global', moneda:'USD'},
  'VEA':  {sector:'ETF Mercados desarrollados', pais:'Global', moneda:'USD'},
  'VWO':  {sector:'ETF Mercados emergentes', pais:'Global', moneda:'USD'},
  'EWZ':  {sector:'ETF Brasil', pais:'Brasil', moneda:'USD'},
  'EWW':  {sector:'ETF México', pais:'México', moneda:'USD'},
  'EWJ':  {sector:'ETF Japón', pais:'Japón', moneda:'USD'},
  'EWY':  {sector:'ETF Corea del Sur', pais:'Corea del Sur', moneda:'USD'},
  'EWU':  {sector:'ETF Reino Unido', pais:'Reino Unido', moneda:'USD'},
  'EWQ':  {sector:'ETF Francia', pais:'Francia', moneda:'USD'},
  'EWP':  {sector:'ETF España', pais:'España', moneda:'USD'},
  'EWT':  {sector:'ETF Taiwán', pais:'Taiwán', moneda:'USD'},
  'FXI':  {sector:'ETF China', pais:'China', moneda:'USD'},
  // Sectoriales US
  'XLF': {sector:'ETF Financiero', pais:'Estados Unidos', moneda:'USD'},
  'XLE': {sector:'ETF Energía', pais:'Estados Unidos', moneda:'USD'},
  'XLV': {sector:'ETF Salud', pais:'Estados Unidos', moneda:'USD'},
  'XLY': {sector:'ETF Consumo discrecional', pais:'Estados Unidos', moneda:'USD'},
  'XLP': {sector:'ETF Consumo básico', pais:'Estados Unidos', moneda:'USD'},
  'XLI': {sector:'ETF Industrial', pais:'Estados Unidos', moneda:'USD'},
  'XLU': {sector:'ETF Servicios públicos', pais:'Estados Unidos', moneda:'USD'},
  'XLB': {sector:'ETF Materiales', pais:'Estados Unidos', moneda:'USD'},
  'XLRE':{sector:'ETF Bienes raíces', pais:'Estados Unidos', moneda:'USD'},
  // Renta fija
  'TLT': {sector:'ETF Bonos largo plazo', pais:'Estados Unidos', moneda:'USD'},
  'BND': {sector:'ETF Bonos agregado', pais:'Estados Unidos', moneda:'USD'},
  'AGG': {sector:'ETF Bonos agregado', pais:'Estados Unidos', moneda:'USD'},
  'HYG': {sector:'ETF Bonos high yield', pais:'Estados Unidos', moneda:'USD'},
  // Commodities y metales
  'GLD': {sector:'ETF Oro', pais:'Global', moneda:'USD'},
  'SLV': {sector:'ETF Plata', pais:'Global', moneda:'USD'},
  'GDX': {sector:'ETF Mineras de oro', pais:'Global', moneda:'USD'},
  'GDXJ':{sector:'ETF Mineras junior', pais:'Global', moneda:'USD'},
  'USO': {sector:'ETF Petróleo', pais:'Global', moneda:'USD'},
  // Crypto-related
  'FBTC':{sector:'ETF Bitcoin spot', pais:'Global', moneda:'USD'},
  'GBTC':{sector:'ETF Bitcoin spot', pais:'Global', moneda:'USD'},
  'IBIT':{sector:'ETF Bitcoin spot', pais:'Global', moneda:'USD'},
  // BMV México
  'NAFTRAC.MX': {sector:'ETF Mercado amplio (México)', pais:'México', moneda:'MXN'},
  'IPC.MX':     {sector:'ETF Mercado amplio (México)', pais:'México', moneda:'MXN'},
};

function _inferirCategoria(ticker, meta) {
  const t = (ticker || '').toUpperCase();
  // 1) ETFs conocidos (mapeo manual)
  if (_ETF_MAP[t]) return _ETF_MAP[t];
  // 2) Crypto: termina en -USD, -USDT
  if (t.endsWith('-USD') || t.endsWith('-USDT')) {
    return {sector: 'Criptomonedas', pais: 'Global', moneda: 'USD'};
  }
  // 3) Tickers .MX (BMV)
  if (t.endsWith('.MX')) {
    return {
      sector: meta.sector || 'BMV (acción mexicana)',
      pais:   meta.pais   || 'México',
      moneda: meta.moneda || 'MXN',
    };
  }
  // 4) ETFs no mapeados pero detectables por nombre/sector vacío
  const nombre = (meta.nombre || '').toLowerCase();
  if (nombre.includes('etf') || nombre.includes('trust') || nombre.includes('fund') ||
      nombre.includes('ishares') || nombre.includes('vanguard') || nombre.includes('spdr')) {
    return {
      sector: meta.sector || 'ETF / Fondo',
      pais:   meta.pais   || 'Global',
      moneda: meta.moneda || 'USD',
    };
  }
  // 5) Sin sufijo → asumir USA (la mayoría de NYSE/Nasdaq no usa sufijo)
  return {
    sector: meta.sector || 'Otros',
    pais:   meta.pais   || 'Estados Unidos',
    moneda: meta.moneda || 'USD',
  };
}

function renderConcentracion(data, info) {
  const cont = $('concentracion-contenido');
  const c = data.concentracion;

  // Si no hay sección "concentracion" intentamos inferir desde pesos + info_activos
  let sectores, paises, monedas;

  if (c && (c.por_sector || c.por_pais || c.por_moneda)) {
    // Backend v3 guarda decimales (0.3333 = 33.33%), convertimos a porcentaje
    const toP = (obj) => obj
      ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v * 100]))
      : null;
    sectores = toP(c.por_sector);
    paises   = toP(c.por_pais);
    monedas  = toP(c.por_moneda);
  } else if (info && Object.keys(info).length && data.portafolio && data.portafolio.pesos) {
    const pesos = data.portafolio.pesos;
    sectores = {}; paises = {}; monedas = {};
    for (const t of Object.keys(pesos)) {
      const w = pesos[t];
      const meta = info[t] || {};
      const cat = _inferirCategoria(t, meta);
      sectores[cat.sector] = (sectores[cat.sector] || 0) + w * 100;
      paises[cat.pais]     = (paises[cat.pais]     || 0) + w * 100;
      monedas[cat.moneda]  = (monedas[cat.moneda]  || 0) + w * 100;
    }
  }

  if (!sectores && !paises && !monedas) {
    cont.innerHTML = `
      <div class="text-xs text-zinc-500 py-8 text-center leading-relaxed">
        Para ver concentración por sector, país y moneda,<br>
        regenera tu análisis con la versión más reciente.
      </div>
    `;
    return;
  }

  cont.innerHTML = `
    <div class="space-y-5">
      ${renderBarGroup('Por sector', sectores)}
      ${renderBarGroup('Por país',   paises)}
      ${renderBarGroup('Por moneda', monedas)}
    </div>
  `;
}

function renderBarGroup(titulo, obj) {
  if (!obj) return '';
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';

  const maxPeso = entries[0][1];
  const palette = [MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.baja, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello];

  const rows = entries.map(([k, v], idx) => `
    <div>
      <div class="flex items-center justify-between text-xs">
        <span class="text-zinc-300 truncate">${k}</span>
        <span class="tabular text-zinc-400">${v.toFixed(1)}%</span>
      </div>
      <div class="mt-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div class="h-full rounded-full" style="width: ${(v / Math.max(maxPeso, 1)) * 100}%; background:${palette[idx % palette.length]}"></div>
      </div>
    </div>
  `).join('');

  // Alerta si hay concentración >60%
  const alta = entries.find(([, v]) => v >= 60);
  const warn = alta ? `
    <div class="mt-2 text-[11px] text-accent-amber flex items-start gap-1.5">
      <svg class="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      Alta concentración en <span class="font-semibold">${alta[0]}</span> (${alta[1].toFixed(0)}%)
    </div>` : '';

  return `
    <div>
      <p class="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">${titulo}</p>
      <div class="space-y-2">${rows}</div>
      ${warn}
    </div>
  `;
}

// ============================================================
// EXPLORADOR DE COMBINACIONES
// ============================================================
const Explorador = (() => {
  const state = {
    universo: [],              // [{ticker, nombre, sector, pais, moneda}]
    periodo: null,
    seleccionados: new Set(),
    cargado: false,
    analizando: false,
  };

  const MIN = 2;
  const MAX = 15;

  // --- cargar universo ------------------------------------------------------
  async function cargarUniverso(intento = 0) {
    if (state.cargado) return;
    try {
      const res = await fetch('/api/universo');
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      if (!body || !Array.isArray(body.tickers)) throw new Error('respuesta vacía');
      state.universo = body.tickers;
      state.periodo = body.periodo;
      state.cargado = true;
      renderMeta();
      renderLista();
    } catch (err) {
      // Reintentar hasta 2 veces (cold start de Render free tier puede tardar)
      if (intento < 2) {
        $('universo-lista').innerHTML = `
          <div class="col-span-full text-xs text-zinc-500 py-8 text-center">
            Cargando universo… ${intento + 1}/3
          </div>`;
        setTimeout(() => cargarUniverso(intento + 1), 4000);
        return;
      }
      $('universo-lista').innerHTML = `
        <div class="col-span-full text-xs text-accent-red py-8 text-center">
          No se pudo cargar el universo. Recarga la página.
          <button onclick="location.reload()" class="ml-2 px-2 py-1 bg-accent-red/20 rounded text-xs">↻ Recargar</button>
        </div>`;
    }
  }

  function renderMeta() {
    const p = state.periodo;
    if (!p) return;
    $('universo-meta').textContent =
      `${state.universo.length} acciones · ${p.inicio} a ${p.fin}`;
  }

  function renderLista(filtro = '') {
    const q = filtro.trim().toLowerCase();
    const lista = state.universo.filter(t =>
      !q ||
      t.ticker.toLowerCase().includes(q) ||
      t.nombre.toLowerCase().includes(q) ||
      (t.sector || '').toLowerCase().includes(q)
    );

    if (!lista.length) {
      $('universo-lista').innerHTML = `
        <div class="col-span-full text-xs text-zinc-500 py-6 text-center">
          Sin resultados para "${filtro}"
        </div>`;
      return;
    }

    $('universo-lista').innerHTML = lista.map(t => {
      const sel = state.seleccionados.has(t.ticker);
      const disabled = !sel && state.seleccionados.size >= MAX;
      const flag = t.moneda === 'MXN' ? 'MX' : (t.moneda === 'USD' ? 'US' : '·');
      const flagCls = t.moneda === 'MXN'
        ? 'bg-accent-green/10 text-accent-green border-accent-green/20'
        : 'bg-accent-blue/10 text-accent-blue border-accent-blue/20';
      return `
        <button data-ticker="${t.ticker}" class="univ-item text-left p-2.5 rounded-lg border transition flex items-center gap-2.5
          ${sel
            ? 'bg-accent-blue/10 border-accent-blue/40'
            : 'border-surface-border hover:border-zinc-600 hover:bg-zinc-900/50'}
          ${disabled ? 'opacity-40 cursor-not-allowed' : ''}"
          ${disabled ? 'disabled' : ''}>
          <span class="text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded border ${flagCls}">${flag}</span>
          <span class="flex-1 min-w-0">
            <span class="block text-[13px] font-medium text-zinc-100 truncate">${t.ticker}</span>
            <span class="block text-[10px] text-zinc-500 truncate">${t.nombre}</span>
          </span>
          ${sel ? `
            <svg class="w-3.5 h-3.5 text-accent-blue shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>` : ''}
        </button>
      `;
    }).join('');
  }

  function renderSeleccion() {
    const n = state.seleccionados.size;
    $('seleccion-contador').textContent = `${n} de ${MAX}`;

    const chipsEl = $('seleccion-chips');
    if (n === 0) {
      chipsEl.innerHTML = `<span class="text-xs text-zinc-600">Selecciona al menos ${MIN} acciones</span>`;
    } else {
      chipsEl.innerHTML = Array.from(state.seleccionados).map(t => `
        <button data-remove="${t}" class="chip-remove inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md pl-2 pr-1 py-1 text-[11px] text-zinc-200 transition">
          <span>${t}</span>
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `).join('');
    }

    const btn = $('btn-analizar');
    btn.disabled = n < MIN || state.analizando;
    btn.textContent = state.analizando ? 'Analizando…' : `Analizar mezcla${n >= MIN ? ` (${n})` : ''}`;
  }

  function toggle(ticker) {
    if (state.seleccionados.has(ticker)) {
      state.seleccionados.delete(ticker);
    } else if (state.seleccionados.size < MAX) {
      state.seleccionados.add(ticker);
    }
    renderLista($('universo-buscar').value);
    renderSeleccion();
  }

  // --- análisis -------------------------------------------------------------
  async function analizar() {
    const tickers = Array.from(state.seleccionados);
    if (tickers.length < MIN) return;

    state.analizando = true;
    renderSeleccion();
    $('seleccion-error').classList.add('hidden');

    try {
      const res = await fetch('/api/explorar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'fallo al analizar');
      renderResultados(body);
    } catch (err) {
      const e = $('seleccion-error');
      e.textContent = err.message;
      e.classList.remove('hidden');
    } finally {
      state.analizando = false;
      renderSeleccion();
    }
  }

  function renderScoreCombinacion(data) {
    const cont = $('explorador-resultados');
    if (!cont) return;
    // Crear/reusar el host del score como primer hijo del contenedor
    let host = $('exp-score-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'exp-score-host';
      cont.insertBefore(host, cont.firstChild);
    }
    const sc = data.score;
    if (!sc) { host.innerHTML = ''; return; }

    const colorMap = {
      green: { ring: 'border-accent-green', text: 'text-accent-green', bg: 'bg-accent-green/10', glow: 'shadow-glow-green' },
      blue:  { ring: 'border-accent-blue',  text: 'text-accent-blue',  bg: 'bg-accent-blue/10',  glow: '' },
      amber: { ring: 'border-accent-amber', text: 'text-accent-amber', bg: 'bg-accent-amber/10', glow: '' },
      red:   { ring: 'border-accent-red',   text: 'text-accent-red',   bg: 'bg-accent-red/10',   glow: 'shadow-glow-red' },
    };
    const col = colorMap[sc.veredicto.color] || colorMap.blue;

    const compLabels = {
      sharpe:           ['Sharpe del óptimo',  '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></svg></span>'],
      correlacion:      ['Diversificación',    '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg></span>'],
      mejora_markowitz: ['Mejora vs equal-weight', '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg></span>'],
      geografia:        ['Regiones',           '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg></span>'],
      sectores:         ['Sectores',           '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M4 19V11"/><path d="M10 19V6"/><path d="M16 19V14"/><path d="M22 19H2"/></svg></span>'],
      monedas:          ['Monedas',            '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10"/><path d="M14.5 9.5H10.7a1.8 1.8 0 0 0 0 3.6h2.6a1.8 1.8 0 0 1 0 3.6H9.5"/></svg></span>'],
      'tamaño':         ['Tamaño',             '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="2.5" y="8" width="19" height="8"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/></svg></span>'],
      volatilidad:      ['Volatilidad',        '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M3 7 9 13l4-4 8 8"/><path d="M15 17h6v-6"/></svg></span>'],
    };

    const componentes = Object.entries(sc.componentes).map(([k, v]) => {
      const [label, icon] = compLabels[k] || [k, '·'];
      const peso = sc.pesos[k] || 0;
      const pct = peso > 0 ? Math.round((v / peso) * 100) : 0;
      const bar = pct >= 75 ? 'bg-accent-green' : pct >= 50 ? 'bg-accent-blue' : pct >= 25 ? 'bg-accent-amber' : 'bg-accent-red';
      return `
        <div class="bg-zinc-900/40 border border-surface-border rounded-lg p-2.5">
          <div class="flex items-center justify-between text-[10px] mb-1">
            <span class="text-zinc-300">${icon} ${label}</span>
            <span class="text-zinc-500 tabular">${v}/${peso}</span>
          </div>
          <div class="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div class="h-full ${bar} rounded-full transition-all" style="width:${pct}%"></div>
          </div>
        </div>`;
    }).join('');

    const tipoColors = {
      fortaleza: { color: 'text-accent-green', bg: 'bg-accent-green/5 border-accent-green/20' },
      riesgo:    { color: 'text-accent-red',   bg: 'bg-accent-red/5 border-accent-red/20' },
      atención:  { color: 'text-accent-amber', bg: 'bg-accent-amber/5 border-accent-amber/20' },
      cierre:    { color: 'text-accent-purple',bg: 'bg-accent-purple/5 border-accent-purple/20' },
    };
    const comentariosHTML = (sc.comentarios || []).map(c => {
      const t = tipoColors[c.tipo] || tipoColors['atención'];
      return `
        <div class="${t.bg} border rounded-lg p-3 flex items-start gap-2.5">
          <span class="text-base shrink-0">${escapeHtml(c.icono || '•')}</span>
          <p class="text-xs text-zinc-300 leading-relaxed">${escapeHtml(c.texto)}</p>
        </div>`;
    }).join('');

    host.innerHTML = `
      <section class="bg-surface-card border border-surface-border rounded-2xl p-6 mb-6">
        <div class="flex items-start justify-between flex-wrap gap-5">
          <div class="flex items-center gap-5">
            <div class="relative inline-flex items-center justify-center w-28 h-28 rounded-full border-4 ${col.ring} ${col.bg} ${col.glow}">
              <div class="text-center">
                <p class="text-3xl font-bold tabular ${col.text} leading-none">${Math.round(sc.score)}</p>
                <p class="text-[9px] uppercase tracking-wider ${col.text} mt-1">/ 100</p>
              </div>
            </div>
            <div>
              <p class="text-xs uppercase tracking-wider text-zinc-500">Evaluación de la combinación</p>
              <h3 class="text-2xl font-bold ${col.text} mt-1">${escapeHtml(sc.veredicto.etiqueta)}</h3>
              <p class="text-[11px] text-zinc-500 mt-2">
                ${sc.metricas_brutas.n_tickers} activos · ${sc.metricas_brutas.n_sectores} sectores ·
                ${sc.metricas_brutas.n_regiones} regiones · ${sc.metricas_brutas.n_monedas} monedas ·
                corr promedio ${sc.metricas_brutas.correlacion_promedio.toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        <div class="mt-6 pt-5 border-t border-surface-border">
          <p class="text-xs uppercase tracking-wider text-zinc-500 mb-3">Desglose del score (100 pts máx)</p>
          <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">${componentes}</div>
        </div>

        ${comentariosHTML ? `
          <div class="mt-6 pt-5 border-t border-surface-border">
            <p class="text-xs uppercase tracking-wider text-zinc-500 mb-3">Análisis cualitativo</p>
            <div class="grid sm:grid-cols-2 gap-2.5">${comentariosHTML}</div>
          </div>
        ` : ''}

        <p class="text-[10px] text-zinc-600 mt-5 italic leading-relaxed">
          Score determinístico basado en métricas cuantitativas. No constituye asesoría de inversión.
        </p>
      </section>
    `;
  }

  function renderResultados(data) {
    const cont = $('explorador-resultados');
    cont.classList.remove('hidden');

    const eq  = data.equal_weight;
    const opt = data.optimo;
    const d   = data.delta;
    const m   = data.metadata;

    // Render score 0-100 al inicio del contenedor
    renderScoreCombinacion(data);

    $('exp-periodo').textContent =
      `${m.fecha_inicio} a ${m.fecha_fin} · ${m.dias_observados} días · ${m.tickers.length} activos`;

    // Mejora de Sharpe
    const ds = d.sharpe_ratio;
    const dsEl = $('exp-delta-sharpe');
    dsEl.textContent = `${ds > 0 ? '+' : ''}${ds.toFixed(2)}`;
    dsEl.className = `text-2xl font-bold tabular ${ds > 0.01 ? 'text-accent-green' : ds < -0.01 ? 'text-accent-red' : 'text-zinc-300'}`;

    // Pesos
    const tickers = m.tickers;
    const pesosEq  = eq.pesos;
    const pesosOpt = opt.pesos;
    $('exp-pesos').innerHTML = tickers.map(t => {
      const we = (pesosEq[t]  || 0) * 100;
      const wo = (pesosOpt[t] || 0) * 100;
      const maxW = Math.max(we, wo, 1);
      const nombre = (data.info_activos[t] || {}).nombre || t;
      return `
        <div>
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span class="font-medium text-zinc-200 truncate" title="${nombre}">${t}</span>
            <span class="text-zinc-500 tabular">${we.toFixed(1)}% <span class="text-zinc-700 mx-1">→</span> <span class="text-zinc-200 font-semibold">${wo.toFixed(1)}%</span></span>
          </div>
          <div class="space-y-1">
            <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
              <div class="h-full bg-zinc-500" style="width:${(we / maxW) * 100}%"></div>
            </div>
            <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
              <div class="h-full bg-accent-blue" style="width:${(wo / maxW) * 100}%"></div>
            </div>
          </div>
        </div>
      `;
    }).join('') + `
      <div class="flex items-center gap-4 pt-2 text-[10px] text-zinc-500">
        <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-sm bg-zinc-500"></span>Equal-weight</span>
        <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-sm bg-accent-blue"></span>Óptimo</span>
      </div>`;

    // Métricas
    const dpp = (v) => (v === null || v === undefined) ? '—'
      : `${v > 0 ? '+' : ''}${v.toFixed(2)} pp`;
    const colorDelta = (v, mejorSiBaja = false) => {
      if (v === null || v === undefined || Math.abs(v) < 0.01) return 'text-zinc-500';
      const bueno = mejorSiBaja ? v < 0 : v > 0;
      return bueno ? 'text-accent-green' : 'text-accent-red';
    };

    $('exp-rend-eq').textContent  = fmtPct(eq.rendimiento_anualizado_pct, 1);
    $('exp-rend-opt').textContent = fmtPct(opt.rendimiento_anualizado_pct, 1);
    $('exp-rend-delta').textContent = dpp(d.rendimiento_anualizado_pp);
    $('exp-rend-delta').className = `text-xs tabular w-16 text-right ${colorDelta(d.rendimiento_anualizado_pp)}`;

    $('exp-vol-eq').textContent  = fmtPct(eq.volatilidad_anual_pct, 1, false);
    $('exp-vol-opt').textContent = fmtPct(opt.volatilidad_anual_pct, 1, false);
    $('exp-vol-delta').textContent = dpp(d.volatilidad_anual_pp);
    $('exp-vol-delta').className = `text-xs tabular w-16 text-right ${colorDelta(d.volatilidad_anual_pp, true)}`;

    $('exp-sharpe-eq').textContent  = fmtNum(eq.sharpe_ratio, 2);
    $('exp-sharpe-opt').textContent = fmtNum(opt.sharpe_ratio, 2);
    $('exp-sharpe-delta').textContent = (d.sharpe_ratio === null || d.sharpe_ratio === undefined)
      ? '—' : `${d.sharpe_ratio > 0 ? '+' : ''}${d.sharpe_ratio.toFixed(2)}`;
    $('exp-sharpe-delta').className = `text-xs tabular w-16 text-right ${colorDelta(d.sharpe_ratio)}`;

    $('exp-dd-eq').textContent = fmtPct(eq.max_drawdown_pct, 1);

    const dr = d.rendimiento_anualizado_pp;
    const dv = d.volatilidad_anual_pp;
    let txt = 'Con los mismos activos pero otros pesos, ';
    if (dr > 0 && dv < 0)       txt += 'hubieras ganado más rendimiento con menos volatilidad.';
    else if (dr > 0 && dv >= 0) txt += 'hubieras ganado más rendimiento aceptando vol similar o mayor.';
    else if (dr <= 0 && dv < 0) txt += 'hubieras reducido la volatilidad manteniendo un rendimiento parecido.';
    else                        txt += 'el equal-weight ya está cerca del óptimo histórico.';
    txt += ' Rendimientos pasados no garantizan resultados futuros.';
    $('exp-explicacion').textContent = txt;

    // Scroll a resultados
    cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- event wiring --------------------------------------------------------
  function bind() {
    $('universo-buscar').addEventListener('input', (e) => renderLista(e.target.value));
    $('universo-lista').addEventListener('click', (e) => {
      const btn = e.target.closest('.univ-item');
      if (!btn || btn.disabled) return;
      toggle(btn.dataset.ticker);
    });
    $('seleccion-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip-remove');
      if (!btn) return;
      toggle(btn.dataset.remove);
    });
    $('btn-analizar').addEventListener('click', analizar);
  }

  return { cargarUniverso, bind };
})();

// ============================================================
// PORTAFOLIO ÓPTIMO: slider de riesgo (1-10) + Markowitz optimization
//  - Reemplaza los 10 perfiles pre-armados
//  - Llama a /api/portafolio-optimo?nivel=N (cache backend 6h)
//  - Permite al usuario "Usar este portafolio" → carga en Mi Portafolio
// ============================================================
const PortafolioOptimo = (() => {
  const state = {
    vol: 14,           // volatilidad objetivo (σ anual) en %
    data:  null,
    reqSeq: 0,         // id de petición: solo se renderiza la MÁS reciente
    debounceTimer: null,
    cargado: false,    // ya se pintó con datos buenos al menos una vez
    enVuelo: false,    // hay una petición en curso (evita duplicar al reabrir)
  };
  // Etiqueta según σ (debe coincidir con el backend portafolio_optimo.py)
  function _etiquetaVol(v) {
    return v < 9 ? 'Conservador' : v < 13 ? 'Moderado'
         : v < 17 ? 'Balanceado' : v < 22 ? 'Crecimiento' : 'Agresivo';
  }

  const NIVELES_LABELS = {
    1:'Conservador', 2:'Conservador+', 3:'Moderado bajo', 4:'Moderado',
    5:'Balanceado',  6:'Balanceado+',  7:'Crecimiento',   8:'Crecimiento+',
    9:'Agresivo',    10:'Muy agresivo',
  };

  // Colores rotativos para la barra apilada (más distinguibles que random)
  const PALETA = [
    MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.baja,
    MP_COLOR.sello, MP_COLOR.alza, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello,
    MP_COLOR.sello, MP_COLOR.sello,
  ];

  function pintarSkeletons() {
    const S = window.bbgSkel;
    if (!S) return;
    const mets = document.getElementById('po-metricas');
    if (mets) {
      mets.innerHTML = Array.from({length:4}, () => `
        <div class="bg-zinc-900/40 rounded-lg p-3">
          ${S.line('60%','sm')}${S.line('80%','lg')}
        </div>
      `).join('');
    }
    const comp = document.getElementById('po-composicion');
    if (comp) {
      comp.innerHTML = Array.from({length:5}, () => `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-zinc-900/30">
          ${S.line('40px','sm')}<div class="flex-1">${S.line('70%','sm')}</div>${S.line('45px','sm')}
        </div>
      `).join('');
    }
  }

  function pintarMetricas(d) {
    const c = document.getElementById('po-metricas');
    if (!c) return;
    const pct = (v) => v == null ? '—' : `${(v*100).toFixed(1)}%`;
    const metricas = [
      { label: 'Retorno esperado', valor: pct(d.retorno_esperado),
        cls: d.retorno_esperado > 0 ? 'text-accent-green' : 'text-accent-red' },
      { label: 'Volatilidad',      valor: pct(d.volatilidad_anual) },
      { label: 'Sharpe',           valor: d.sharpe.toFixed(2),
        cls: d.sharpe > 1 ? 'text-accent-green' : d.sharpe > 0.5 ? 'text-accent-blue' : 'text-zinc-300' },
      { label: 'Diversificación',  valor: `${d.diversificacion_pct.toFixed(0)}%` },
    ];
    c.innerHTML = metricas.map(m => `
      <div class="bg-zinc-900/40 rounded-lg p-3">
        <p class="text-[10px] text-zinc-500 uppercase tracking-wider">${m.label}</p>
        <p class="text-[15px] font-bold tabular ${m.cls || 'text-zinc-100'}">${m.valor}</p>
      </div>
    `).join('');
  }

  function pintarComposicion(d) {
    const cont = document.getElementById('po-composicion');
    const nEl  = document.getElementById('po-n-acciones');
    if (!cont) return;
    if (nEl) {
      const cash = d.peso_cash > 0.005 ? ` + ${(d.peso_cash*100).toFixed(1)}% cash` : '';
      nEl.textContent = `${d.n_acciones} acciones${cash}`;
    }
    cont.innerHTML = d.acciones.map((a, i) => {
      const color = PALETA[i % PALETA.length];
      const bandera = a.es_mx ? 'MX' : 'US';
      const banderaCls = a.es_mx ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
                                  : 'bg-accent-blue/10 text-accent-blue border-accent-blue/30';
      return `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-zinc-900/40 hover:bg-zinc-900/70 transition">
          <span style="background:${color}" class="w-1 h-8 rounded-full shrink-0"></span>
          <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border ${banderaCls} tabular shrink-0">${bandera}</span>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-semibold text-zinc-100 truncate tabular">${a.ticker}</p>
            <p class="text-[10px] text-zinc-500 truncate">${(a.nombre || '').slice(0,40)}</p>
          </div>
          <div class="text-right shrink-0">
            <p class="text-[14px] font-bold text-zinc-100 tabular">${a.peso_pct.toFixed(1)}%</p>
            ${a.precio ? `<p class="text-[10px] text-zinc-500 tabular">${a.es_mx?'$':'US$'}${a.precio.toFixed(2)}</p>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function pintarBarra(d) {
    const cont = document.getElementById('po-barra-apilada');
    if (!cont) return;
    cont.innerHTML = d.acciones.map((a,i) => {
      const color = PALETA[i % PALETA.length];
      return `<div style="width:${a.peso*100}%;background:${color}" title="${a.ticker} ${a.peso_pct.toFixed(1)}%"></div>`;
    }).join('') + (d.peso_cash > 0.005
      ? `<div style="width:${d.peso_cash*100}%;background:var(--regla-fuerte)" title="Cash ${(d.peso_cash*100).toFixed(1)}%"></div>`
      : '');
  }

  function pintarLabels(volFrac, etiqueta, descripcion, metodologia) {
    const lbl = document.getElementById('po-nivel-label');
    const pct = Math.round((volFrac || 0) * 100);
    if (lbl) lbl.textContent = `${pct}% · ${etiqueta || _etiquetaVol(pct)}`;
    const desc = document.getElementById('po-descripcion');
    if (desc) desc.textContent = descripcion || '';
    const meto = document.getElementById('po-metodologia');
    if (meto) meto.textContent = metodologia || '';
  }

  function pintarError(msg) {
    const c = document.getElementById('po-metricas');
    if (c) c.innerHTML = `<div class="col-span-full text-xs text-accent-red py-4 text-center">${msg}</div>`;
    const comp = document.getElementById('po-composicion');
    if (comp) comp.innerHTML = '';
    const barra = document.getElementById('po-barra-apilada');
    if (barra) barra.innerHTML = '';
  }

  let _frontChart = null;
  function pintarFrontera(d) {
    const cv = document.getElementById('po-frontera-canvas');
    if (!cv || typeof Chart === 'undefined') return;
    const fr = d && d.frontera;
    if (!fr || !Array.isArray(fr.curva) || !fr.curva.length) {
      if (_frontChart) { _frontChart.destroy(); _frontChart = null; }
      return;
    }
    if (_frontChart) _frontChart.destroy();
    const curva = fr.curva.map(p => ({ x: p.vol, y: p.ret }));
    const activos = (fr.activos || []);
    const selPts = activos.filter(a => a.sel).map(a => ({ x: a.vol, y: a.ret, ticker: a.ticker }));
    const otros = activos.filter(a => !a.sel).map(a => ({ x: a.vol, y: a.ret, ticker: a.ticker }));
    const opt = fr.optimo ? [{ x: fr.optimo.vol, y: fr.optimo.ret }] : [];
    _frontChart = new Chart(cv.getContext('2d'), {
      type: 'scatter',
      data: { datasets: [
        { type: 'line', label: 'Frontera eficiente', data: curva, order: 1,
          ...MP_GRAFICA.serie(MP_GRAFICA.sello) },
        { label: 'Tu portafolio', data: opt, backgroundColor: MP_GRAFICA.sello,
          pointStyle: 'rectRot', radius: 9, borderColor: MP_GRAFICA.tinta1, borderWidth: 1, order: 0 },
        { label: 'En el portafolio', data: selPts, backgroundColor: MP_GRAFICA.tinta1,
          pointStyle: 'rect', radius: 3.5, order: 2 },
        { label: 'Otras candidatas', data: otros, backgroundColor: MP_GRAFICA.reglaFuerte,
          pointStyle: 'rect', radius: 2.5, order: 3 },
      ] },
      options: MP_GRAFICA.base({
        plugins: {
          legend: MP_GRAFICA.leyenda(true),
          tooltip: MP_GRAFICA.tooltip({ label: (ctx) => {
            const r = ctx.raw; const tk = r.ticker ? r.ticker + ': ' : '';
            return `${tk}σ ${r.x}% · ret ${r.y}%`;
          } }),
        },
        scales: {
          x: MP_GRAFICA.ejeValor({ title: { display: true, text: 'Volatilidad σ (%)', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } } }),
          y: MP_GRAFICA.ejeValor({ title: { display: true, text: 'Retorno esperado (%)', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } } }),
        },
      }),
    });
  }

  async function cargar(vol) {
    const myReq = ++state.reqSeq;   // marca esta petición como la más reciente
    state.enVuelo = true;
    pintarSkeletons();
    try {
      // Esperar a que la sesión esté resuelta ANTES de pedir. Este endpoint
      // pasa por @requiere_acceso, que en la app nativa responde 401
      // "cuenta_requerida" cuando la petición sale sin Authorization; en web
      // anónimo devuelve 200, por eso el fallo solo se veía en el teléfono.
      await window.__mpSesionLista;
      if (myReq !== state.reqSeq) return;

      // Reintentos para el arranque en frío del backend: sin esto, un 5xx
      // pasajero dejaba la tarjeta con un error permanente.
      const d = await fetchJsonRetry(`/api/portafolio-optimo?vol=${vol}`, undefined, { intentos: 2, delay: 2500 });
      if (myReq !== state.reqSeq) return;   // ya llegó una más nueva → descartar ésta
      if (!d) throw new Error('Respuesta vacía');
      if (!d.ok) throw new Error(d.error || 'error');
      state.cargado = true;
      state.data = d;
      pintarLabels(d.vol_objetivo, d.etiqueta, d.descripcion, d.metodologia);
      pintarMetricas(d);
      pintarComposicion(d);
      pintarBarra(d);
      pintarFrontera(d);
    } catch (e) {
      if (myReq !== state.reqSeq) return;
      // 401 no es un fallo del optimizador: es que no hay sesión. Decirlo tal
      // cual, en vez de "no pude generar el portafolio", que manda a buscar el
      // problema donde no está.
      const sinCuenta = e && (e.status === 401 || e.body?.error === 'cuenta_requerida');
      const vencido   = e && (e.status === 402 || e.body?.error === 'acceso_requerido');
      pintarError(
        sinCuenta ? 'Inicia sesión para generar tu portafolio óptimo.'
        : vencido ? 'Tu prueba terminó. Suscríbete para volver a generarlo.'
        : `No pude generar el portafolio: ${e.message}`
      );
    } finally {
      if (myReq === state.reqSeq) state.enVuelo = false;
    }
  }

  // Carga perezosa: solo cuando se abre la vista automática. Antes se pedía en
  // el arranque, así que el error de una petición que el usuario nunca hizo
  // quedaba pintado esperándolo al entrar, y solo se limpiaba al mover el
  // slider. De paso, quien nunca abre esta pantalla ya no paga la petición.
  //
  // Si el intento anterior falló, reintenta al reabrir: se comprueba `cargado`
  // (hubo éxito), no `reqSeq` (hubo intento).
  function asegurarCargado() {
    if (state.cargado || state.enVuelo) return;
    cargar(state.vol);
  }

  function debounceCargar(vol) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => cargar(vol), 350);
  }

  function bind() {
    const slider = document.getElementById('po-slider');
    if (slider) {
      slider.addEventListener('input', (e) => {
        state.vol = parseInt(e.target.value, 10) || 14;
        // Label se actualiza inmediato
        const lbl = document.getElementById('po-nivel-label');
        if (lbl) lbl.textContent = `${state.vol}% · ${_etiquetaVol(state.vol)}`;
        // Cargar con debounce
        debounceCargar(state.vol);
      });
    }
    const regen = document.getElementById('po-regenerar');
    if (regen) regen.addEventListener('click', () => {
      // Usa state.vol, no state.nivel: `nivel` nunca existió en el estado, así
      // que salía "nivel=undefined" y el backend respondía 500 al hacer
      // int('undefined'). La recarga posterior heredaba el mismo undefined.
      fetch(`/api/portafolio-optimo?vol=${state.vol}&forzar=1`).then(() => cargar(state.vol));
    });
    const usar = document.getElementById('po-usar');
    if (usar) usar.addEventListener('click', () => {
      if (!state.data || !state.data.acciones) return;
      // Cargar en el picker (selección + pesos)
      try {
        const tickers = state.data.acciones.map(a => ({
          ticker: a.ticker, nombre: a.nombre, peso: a.peso_pct,
          moneda: a.es_mx ? 'MXN' : 'USD', precio: a.precio,
        }));
        // Si existe el Picker, lo precargamos
        if (typeof Picker !== 'undefined' && Picker.cargarDesdeOptimo) {
          Picker.cargarDesdeOptimo(tickers);
        } else {
          // Fallback: localStorage
          localStorage.setItem('mp.portafolioOptimoPropuesto', JSON.stringify(tickers));
        }
        // window.toast(msg, tipo) — la forma canónica de ux_helpers.js. Antes
        // llamaba a window.toast.success(...), que no existe: lanzaba
        // TypeError y se comía el resultado en el catch de abajo.
        if (window.toast) window.toast(`Portafolio óptimo cargado: ${tickers.length} acciones`, 'success');
      } catch (e) {
        if (window.toast) window.toast('No pude cargar el portafolio', 'error');
      }
    });
    // Sin carga inicial aquí a propósito: la dispara asegurarCargado() cuando
    // se abre la vista automática.
  }

  return { bind, cargar, asegurarCargado };
})();

// ============================================================
// PICKER: onboarding de "Mi portafolio" (paso 1 tickers + paso 2 pesos)
//  - Lista del universo completo (S&P 500 + IPC) con precio y ✦ recomendadas
//  - Buscador con fallback a Yahoo Finance (cualquier ticker)
//  - Paso 2: editor de pesos (inputs + slider) antes de analizar
// ============================================================
const Picker = (() => {
  const state = {
    universo: [],
    seleccionados: new Map(),   // Map<ticker, {ticker, nombre, moneda, precio, recomendada}>
    pesos:         new Map(),   // Map<ticker, pct 0-100>
    cargado: false,
    yahooTimer: null,
    yahooSeq: 0,
    filtro: 'todas',            // todas | recomendadas | mx | us | crypto
  };

  // Helper: detecta si un ticker es cripto (termina en -USD o sector cripto)
  function esCripto(t) {
    return /-USD$/.test(t.ticker) || /cripto/i.test(t.sector || '') || /crypto/i.test(t.sector || '');
  }

  const MIN = 2;
  const MAX = 20;
  const TOLERANCIA = 0.5;       // suma de pesos válida ∈ [99.5, 100.5]

  // ---- Formatos --------------------------------------------------------
  function fmtPrecio(t) {
    if (t.precio === null || t.precio === undefined) return '';
    const simbolo = t.moneda === 'MXN' ? '$' : '$';
    const sufijo = t.moneda === 'MXN' ? ' MXN' : (t.moneda === 'USD' ? '' : '');
    return `${simbolo}${t.precio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sufijo}`;
  }

  // ---- Universo ---------------------------------------------------------
  async function cargar(intento = 0) {
    if (state.cargado) return;
    try {
      const res = await fetch('/api/universo');
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      if (!body || !Array.isArray(body.tickers)) throw new Error('respuesta vacía');
      state.universo = body.tickers;
      state.cargado = true;
      const n = state.universo.length;
      const recos = state.universo.filter(x => x.recomendada).length;
      $('pick-curado-meta').textContent = `· ${n} acciones`;
      renderCurado('');
      // Auto-refresh de precios en background (no bloqueante)
      // Solo refrescamos los recomendados para no saturar.
      const recosTickers = state.universo.filter(x => x.recomendada).map(x => x.ticker).slice(0, 50);
      if (recosTickers.length) refrescarPrecios(recosTickers);
    } catch (err) {
      // Reintentar hasta 2 veces (cold start de Render)
      if (intento < 2) {
        $('pick-curado-lista').innerHTML = `
          <div class="col-span-full py-8 text-center">
            <p class="text-xs text-zinc-500">Despertando servidor… ${intento + 1}/3</p>
          </div>`;
        setTimeout(() => cargar(intento + 1), 4000);
        return;
      }
      $('pick-curado-lista').innerHTML = `
        <div class="col-span-full py-8 text-center">
          <div class="w-12 h-12 rounded-xl bg-accent-amber/10 border border-accent-amber/30 flex items-center justify-center mx-auto mb-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-accent-amber">
              <path d="M1 1l22 22M4 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2"/><polyline points="22 6 12 13"/>
            </svg>
          </div>
          <p class="text-sm font-semibold text-zinc-200 mb-1">Sin conexión al universo</p>
          <p class="text-[11px] text-zinc-500 max-w-xs mx-auto leading-relaxed">
            El servidor está despertando o sin conexión. Espera 30 segundos y refresca la página.
          </p>
          <button onclick="location.reload()" class="mt-3 px-3 py-1.5 bg-accent-amber/20 text-accent-amber rounded text-xs">↻ Recargar</button>
        </div>`;
    }
    renderSeleccion();
    cargarPerfiles();
  }

  function filtrarUniverso(q) {
    const s = (q || '').trim().toLowerCase();
    return state.universo.filter(t => {
      if (state.filtro === 'recomendadas' && !t.recomendada) return false;
      if (state.filtro === 'mx' && t.moneda !== 'MXN') return false;
      if (state.filtro === 'us' && (t.moneda !== 'USD' || esCripto(t))) return false;
      if (state.filtro === 'crypto' && !esCripto(t)) return false;
      if (s) {
        return t.ticker.toLowerCase().includes(s)
          || (t.nombre || '').toLowerCase().includes(s)
          || (t.sector || '').toLowerCase().includes(s);
      }
      return true;
    });
  }

  function renderCurado(filtro) {
    const cont = $('pick-curado-lista');
    if (!state.universo.length) return;
    const lista = filtrarUniverso(filtro);
    if (!lista.length) {
      cont.innerHTML = `<div class="col-span-full text-xs text-zinc-500 py-4 text-center">
        Sin resultados para este filtro. Prueba buscar en Yahoo arriba.
      </div>`;
      return;
    }
    const TOPE_PICKER = 300;
    const visible = lista.slice(0, TOPE_PICKER);
    const html = visible.map(t => itemHTML(t, 'curado')).join('');
    const hint = lista.length > TOPE_PICKER
      ? `<div class="col-span-full text-[10px] text-zinc-600 text-center py-2">Mostrando ${TOPE_PICKER} de ${lista.length} resultados — usa el buscador para acotar.</div>`
      : '';
    cont.innerHTML = html + hint;
  }

  function itemHTML(t, origen) {
    const sel = state.seleccionados.has(t.ticker);
    const disabled = !sel && state.seleccionados.size >= MAX;
    const mon = t.moneda || '';
    const cripto = esCripto(t);
    const flag = cripto ? '₿' : (mon === 'MXN' ? 'MX' : (mon === 'USD' ? 'US' : (origen === 'yahoo' ? 'Y!' : '·')));
    const flagCls = cripto
      ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
      : mon === 'MXN'
        ? 'bg-accent-green/10 text-accent-green border-accent-green/20'
        : mon === 'USD'
          ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'
          : origen === 'yahoo'
            ? 'bg-amber-500/10 text-accent-amber border-amber-500/20'
            : 'bg-zinc-800 text-zinc-500 border-zinc-700';

    const reco = t.recomendada;
    const borderSel = sel
      ? 'bg-accent-green/10 border-accent-green/50'
      : reco
        ? 'border-amber-500/25 bg-amber-500/[0.03] hover:border-amber-500/50 hover:bg-amber-500/[0.06]'
        : 'border-surface-border hover:border-zinc-600 hover:bg-zinc-900/50';

    const precio = fmtPrecio(t);
    const precioHtml = precio
      ? `<span class="text-[10px] text-zinc-400 tabular shrink-0">${precio}</span>`
      : '';

    return `
      <button data-ticker="${t.ticker}"
              data-nombre="${(t.nombre || '').replace(/"/g, '&quot;')}"
              data-moneda="${mon}"
              data-precio="${t.precio ?? ''}"
              data-reco="${reco ? '1' : '0'}"
        class="pick-item text-left p-2.5 rounded-lg border transition flex items-center gap-2.5
          ${borderSel} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}"
        ${disabled ? 'disabled' : ''}>
        <span class="text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded border ${flagCls}">${flag}</span>
        <span class="flex-1 min-w-0">
          <span class="flex items-center gap-1">
            ${reco ? '<span class="text-accent-amber text-[11px] leading-none">✦</span>' : ''}
            <span class="text-[13px] font-medium text-zinc-100 truncate">${t.ticker}</span>
          </span>
          <span class="block text-[10px] text-zinc-500 truncate">${escapeHtml(t.nombre || '')}</span>
        </span>
        ${precioHtml}
        ${sel ? `
          <svg class="w-3.5 h-3.5 text-accent-green shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>` : ''}
      </button>
    `;
  }

  function renderSeleccion() {
    const n = state.seleccionados.size;
    $('pick-contador').textContent = `${n} de ${MAX}`;

    const chipsEl = $('pick-chips');
    if (n === 0) {
      chipsEl.innerHTML = `<span class="text-xs text-zinc-600">Selecciona al menos ${MIN} acciones</span>`;
    } else {
      chipsEl.innerHTML = Array.from(state.seleccionados.values()).map(t => `
        <button data-remove="${t.ticker}" class="pick-chip-remove inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md pl-2 pr-1 py-1 text-[11px] text-zinc-200 transition">
          <span>${t.ticker}</span>
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `).join('');
    }

    const btn = $('pick-siguiente');
    btn.disabled = n < MIN;
    btn.textContent = n >= MIN ? `Siguiente: ajustar pesos (${n}) →` : 'Siguiente: ajustar pesos →';
  }

  function toggle(ticker, nombre, moneda, precio, reco) {
    if (state.seleccionados.has(ticker)) {
      state.seleccionados.delete(ticker);
    } else if (state.seleccionados.size < MAX) {
      state.seleccionados.set(ticker, {
        ticker, nombre, moneda,
        precio: precio !== undefined && precio !== null && precio !== '' ? Number(precio) : null,
        recomendada: reco === '1' || reco === true,
      });
    }
    renderCurado($('pick-buscar').value);
    renderYahoo();
    renderSeleccion();
  }

  function setFiltro(f) {
    state.filtro = f;
    document.querySelectorAll('.pick-filtro').forEach(b => {
      const activo = b.dataset.filtro === f;
      b.classList.toggle('text-zinc-300', activo);
      b.classList.toggle('bg-zinc-900', activo);
      b.classList.toggle('text-zinc-500', !activo);
    });
    renderCurado($('pick-buscar').value);
  }

  // ---- Búsqueda Yahoo (debounced) ---------------------------------------
  let yahooCache = [];
  function renderYahoo() {
    const cont = $('pick-resultados-yahoo');
    const lista = $('pick-yahoo-lista');
    if (!yahooCache.length) {
      cont.classList.add('hidden');
      return;
    }
    cont.classList.remove('hidden');
    lista.innerHTML = yahooCache.map(t => itemHTML(t, 'yahoo')).join('');
  }

  async function buscarYahoo(query) {
    const q = (query || '').trim();
    if (q.length < 2) {
      yahooCache = [];
      renderYahoo();
      $('pick-buscar-status').textContent = '';
      return;
    }
    const seq = ++state.yahooSeq;
    $('pick-buscar-status').textContent = 'buscando…';
    try {
      const res = await fetch('/api/buscar-ticker?q=' + encodeURIComponent(q) + '&limite=25');
      const body = await res.json();
      if (seq !== state.yahooSeq) return;
      if (!res.ok) throw new Error(body.error || 'fallo Yahoo');
      const curadoSet = new Set(state.universo.map(x => x.ticker));
      yahooCache = (body || []).filter(x => !curadoSet.has(x.ticker)).slice(0, 20);
      $('pick-buscar-status').textContent = yahooCache.length ? `${yahooCache.length} desde Yahoo` : 'sin coincidencias extra';
    } catch (err) {
      yahooCache = [];
      $('pick-buscar-status').textContent = 'Yahoo no respondió';
    }
    renderYahoo();
  }

  function onBuscarInput(e) {
    const v = e.target.value;
    renderCurado(v);
    clearTimeout(state.yahooTimer);
    state.yahooTimer = setTimeout(() => buscarYahoo(v), 300);
  }

  // ============================================================
  // PASO 2 · EDITOR DE PESOS
  // ============================================================
  function mostrarPaso(cual /* 'tickers' | 'pesos' */) {
    $('paso-tickers').classList.toggle('hidden', cual !== 'tickers');
    $('paso-pesos').classList.toggle('hidden', cual !== 'pesos');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function irAPesos() {
    const tickers = Array.from(state.seleccionados.keys());
    if (tickers.length < MIN) return;

    // Si hay pesos guardados para exactamente estos tickers, precargar.
    // Si no, equal-weight.
    const guardados = leerPesosGuardados();
    const equal = 100 / tickers.length;
    state.pesos.clear();
    tickers.forEach(t => {
      const v = guardados && guardados[t] !== undefined ? guardados[t] * 100 : equal;
      state.pesos.set(t, v);
    });
    renderPesos();
    mostrarPaso('pesos');
  }

  function renderPesos() {
    const cont = $('pesos-filas');
    const tickers = Array.from(state.seleccionados.keys());
    cont.innerHTML = tickers.map(t => {
      const meta = state.seleccionados.get(t) || {};
      const pct = state.pesos.get(t) ?? 0;
      const precio = fmtPrecio(meta);
      return `
        <div class="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_160px_auto] gap-3 items-center">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              ${meta.recomendada ? '<span class="text-accent-amber text-[11px]">✦</span>' : ''}
              <span class="text-sm font-medium text-zinc-100 truncate">${t}</span>
              <span class="text-[11px] text-zinc-500 truncate">${escapeHtml(meta.nombre || '')}</span>
            </div>
            <input type="range" min="0" max="100" step="0.5" value="${pct.toFixed(1)}"
                   data-w-ticker="${t}"
                   class="pesos-slider w-full mt-1 accent-emerald-500" />
          </div>
          <div class="text-[10px] text-zinc-500 text-right hidden sm:block">
            ${precio ? precio : '—'}
          </div>
          <div class="flex items-center gap-1">
            <input type="number" min="0" max="100" step="0.1" value="${pct.toFixed(1)}"
                   data-w-ticker="${t}"
                   class="pesos-input w-20 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-sm text-zinc-100 tabular text-right focus:outline-none focus:border-accent-green" />
            <span class="text-xs text-zinc-500">%</span>
          </div>
        </div>
      `;
    }).join('');
    updateTotal();
  }

  function updateTotal() {
    let suma = 0;
    state.pesos.forEach(v => { suma += (isFinite(v) ? v : 0); });
    const el = $('pesos-total');
    const st = $('pesos-status');
    const btn = $('pesos-analizar');

    el.textContent = `${suma.toFixed(1)}%`;
    const dentro = Math.abs(suma - 100) <= TOLERANCIA;
    el.className = `text-2xl font-bold tabular ${dentro ? 'text-accent-green' : (suma > 100 ? 'text-accent-red' : 'text-accent-amber')}`;
    if (dentro) {
      st.textContent = '✓ Listo para analizar';
      st.className = 'text-[11px] text-accent-green';
    } else if (suma > 100) {
      st.textContent = `Excede por ${(suma - 100).toFixed(1)} pp`;
      st.className = 'text-[11px] text-accent-red';
    } else {
      st.textContent = `Falta ${(100 - suma).toFixed(1)} pp`;
      st.className = 'text-[11px] text-accent-amber';
    }
    btn.disabled = !dentro;
  }

  function onPesosInput(e) {
    const t = e.target.dataset.wTicker;
    if (!t) return;
    let v = parseFloat(e.target.value);
    if (!isFinite(v) || v < 0) v = 0;
    if (v > 100) v = 100;
    state.pesos.set(t, v);
    // Sincronizar slider<->input sin re-render completo (evita perder focus)
    document.querySelectorAll(`[data-w-ticker="${CSS.escape(t)}"]`).forEach(el => {
      if (el !== e.target) el.value = v.toFixed(1);
    });
    updateTotal();
  }

  function distribuirIgual() {
    const n = state.pesos.size;
    const v = 100 / n;
    state.pesos.forEach((_, k) => state.pesos.set(k, v));
    renderPesos();
  }

  function escalarA100() {
    let suma = 0;
    state.pesos.forEach(v => { suma += v; });
    if (suma <= 0) { distribuirIgual(); return; }
    const factor = 100 / suma;
    state.pesos.forEach((v, k) => state.pesos.set(k, v * factor));
    renderPesos();
  }

  async function analizar() {
    const tickers = Array.from(state.pesos.keys());
    const pesosFrac = {};
    let suma = 0;
    state.pesos.forEach((v, k) => { suma += v; });
    if (Math.abs(suma - 100) > TOLERANCIA) return;

    state.pesos.forEach((v, k) => { pesosFrac[k] = v / 100; });

    $('pesos-error').classList.add('hidden');
    $('pesos-loading').classList.remove('hidden');
    $('pesos-analizar').disabled = true;

    guardarPortafolio(tickers, pesosFrac);
    try {
      await analizarYRender(tickers, pesosFrac);
    } finally {
      $('pesos-loading').classList.add('hidden');
    }
  }

  // ============================================================
  // PERFILES SUGERIDOS
  // ============================================================
  const perfilesCache = [];

  async function cargarPerfiles(intento = 0) {
    const grid = $('perfiles-grid');
    if (!grid) return;
    if (!grid.querySelector('.perfil-card')) {
      grid.innerHTML = `<div class="col-span-full mp-vacio">Calculando perfiles…</div>`;
    }
    try {
      const res = await fetch('/api/perfiles');
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      if (!Array.isArray(body)) throw new Error('respuesta vacía');
      perfilesCache.splice(0, perfilesCache.length, ...(body || []));
      renderPerfiles();
    } catch (err) {
      // Reintentar hasta 2 veces (cold start de Render puede tardar)
      if (intento < 2) {
        grid.innerHTML = `
          <div class="col-span-full text-xs text-zinc-500 py-4 text-center">
            Cargando perfiles… ${intento + 1}/3
          </div>`;
        setTimeout(() => cargarPerfiles(intento + 1), 4000);
        return;
      }
      grid.innerHTML = `
        <div class="col-span-full text-xs text-zinc-500 py-4 text-center">
          Perfiles no disponibles.
          <button onclick="location.reload()" class="ml-2 px-2 py-1 bg-zinc-700 rounded text-xs hover:bg-zinc-600">↻ Recargar</button>
        </div>`;
    }
  }

  function renderPerfiles() {
    const grid = $('perfiles-grid');
    if (!grid) return;
    if (!perfilesCache.length) {
      grid.innerHTML = `
        <div class="col-span-full text-xs text-zinc-500 py-4 text-center">
          No hay perfiles sugeridos disponibles.
        </div>`;
      return;
    }
    // El nivel de riesgo ya NO se colorea: verde y rojo quedan reservados para
    // dirección de mercado, y aquí el dato lo dice la palabra ("bajo", "muy
    // alto") junto a la volatilidad, que está a la vista en la misma tarjeta.
    const objetivoLabel = {
      'min_vol':     'Mín. varianza',
      'max_sharpe':  'Máx. Sharpe',
      'max_ret':     'Máx. retorno',
      'risk_parity': 'Risk parity',
    };
    grid.innerHTML = perfilesCache.map(p => {
      const tickersPreview = (p.tickers || []).slice(0, 4).join(' · ');
      const extras = (p.tickers || []).length > 4 ? ` +${p.tickers.length - 4}` : '';
      const obj = objetivoLabel[p.objetivo] || '';
      const m = p.metricas;
      const sc = p.score_promedio;
      const div = m && m.diversificacion != null ? m.diversificacion : null;
      const nf = (x, d = 1) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : '—';
      const metricasHTML = m ? `
        <div class="grid grid-cols-3 gap-1 pt-2 border-t border-surface-border">
          <div>
            <p class="mp-etq">Ret. anual</p>
            <p class="text-[12px] font-semibold tabular ${Number(m.retorno_anual_pct) >= 0 ? 'mp-alza' : 'mp-baja'}">${nf(m.retorno_anual_pct)}%</p>
          </div>
          <div>
            <p class="mp-etq">Volatilidad</p>
            <p class="text-[12px] font-semibold tabular text-zinc-100">${nf(m.volatilidad_anual_pct)}%</p>
          </div>
          <div>
            <p class="mp-etq">Sharpe</p>
            <p class="text-[12px] font-semibold tabular text-zinc-100">${nf(m.sharpe_ratio, 2)}</p>
          </div>
        </div>
        ${(sc != null || div != null) ? `
        <div class="grid grid-cols-2 gap-1 pt-1.5">
          ${sc != null ? `
          <div>
            <p class="mp-etq">Calidad</p>
            <p class="text-[11px] font-semibold tabular text-zinc-100">${Math.round(sc)}<span class="text-zinc-600">/100</span></p>
          </div>` : ''}
          ${div != null ? `
          <div>
            <p class="mp-etq">Diversif.</p>
            <p class="text-[11px] font-semibold tabular text-zinc-100">${(div * 100).toFixed(0)}%</p>
          </div>` : ''}
        </div>` : ''}` : '';
      const nActivos = p.num_activos || (p.tickers || []).length;
      return `
        <button data-perfil="${p.id}"
          class="perfil-card mp-celda text-left transition flex flex-col gap-2 min-h-[220px]">
          <div class="mp-sec">
            <span class="mp-sec-etq">${escapeHtml(p.nivel_riesgo)}</span>
            ${obj ? `<span class="mp-sec-fin mp-firma">${escapeHtml(obj)}</span>` : ''}
          </div>
          <h4 class="font-serif text-[17px] font-semibold text-zinc-100 leading-tight"
              style="font-family:var(--ff-serif);letter-spacing:-.015em">${escapeHtml(p.nombre)}</h4>
          <p class="text-[11.5px] text-zinc-400 leading-snug line-clamp-3">${escapeHtml(p.thesis)}</p>
          ${metricasHTML}
          <div class="mt-auto pt-2 border-t border-surface-border">
            <p class="mp-firma truncate"><span class="tabular">${nActivos}</span> activos · ${escapeHtml(tickersPreview)}${extras}</p>
            <p class="text-[11px] mt-1" style="color:var(--sello)">Usar esta mezcla &rarr;</p>
          </div>
        </button>
      `;
    }).join('');
  }

  async function aplicarPerfil(idPerfil) {
    const p = perfilesCache.find(x => x.id === idPerfil);
    if (!p) return;
    // Asegurar que el universo esté cargado (necesitamos metadata para renderPesos)
    if (!state.cargado) await cargar();

    const univMap = new Map(state.universo.map(x => [x.ticker, x]));
    state.seleccionados.clear();
    state.pesos.clear();

    (p.tickers || []).forEach(t => {
      const u = univMap.get(t);
      state.seleccionados.set(t, u ? {
        ticker: t,
        nombre: u.nombre,
        moneda: u.moneda,
        precio: u.precio,
        recomendada: u.recomendada,
      } : { ticker: t, nombre: t, moneda: '', precio: null, recomendada: false });
      const pesoPct = (p.pesos && p.pesos[t] !== undefined) ? p.pesos[t] * 100 : 0;
      state.pesos.set(t, pesoPct);
    });

    // Normalizar por si los pesos no suman exactamente 100 (por redondeos)
    let suma = 0;
    state.pesos.forEach(v => { suma += v; });
    if (suma > 0 && Math.abs(suma - 100) > 0.05) {
      const factor = 100 / suma;
      state.pesos.forEach((v, k) => state.pesos.set(k, v * factor));
    }

    renderSeleccion();
    renderPesos();
    mostrarPaso('pesos');
  }

  // ============================================================
  // REFRESCO DE PRECIOS (cuasi-real vía Yahoo)
  // ============================================================
  let refrescando = false;

  async function refrescarPrecios(tickersOpt) {
    const estado = $('pick-precios-estado');
    if (refrescando) return;

    // Default: tickers visibles actualmente (filtrados) + los seleccionados
    let tickers = tickersOpt;
    if (!tickers || !tickers.length) {
      const visibles = filtrarUniverso($('pick-buscar').value || '')
        .slice(0, 80)  // tope para no saturar
        .map(x => x.ticker);
      const sel = Array.from(state.seleccionados.keys());
      tickers = Array.from(new Set([...sel, ...visibles])).slice(0, 100);
    }
    if (!tickers.length) return;

    refrescando = true;
    if (estado) {
      estado.classList.remove('hidden');
      estado.textContent = `Actualizando ${tickers.length} precios…`;
    }

    try {
      const res = await fetch('/api/precios-actuales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'fallo refresco');

      const precios = body.precios || {};
      // Actualizar state.universo
      state.universo.forEach(t => {
        const p = precios[t.ticker];
        if (p && p.precio !== null && p.precio !== undefined) {
          t.precio = p.precio;
        }
      });
      // Actualizar también la selección (para que el paso 2 muestre precios frescos)
      state.seleccionados.forEach((meta, k) => {
        const p = precios[k];
        if (p && p.precio !== null && p.precio !== undefined) {
          meta.precio = p.precio;
        }
      });

      const hora = (body.hora_actualizacion || '').split('T')[1] || '';
      if (estado) {
        estado.textContent = `Precios actualizados a las ${hora.slice(0, 5)} · ~15 min de retraso (Yahoo)`;
      }
      renderCurado($('pick-buscar').value || '');
      // Si el paso 2 está visible, re-render para precios nuevos
      if (!$('paso-pesos').classList.contains('hidden')) renderPesos();
    } catch (err) {
      if (estado) estado.textContent = `No pude actualizar precios: ${err.message}`;
    } finally {
      refrescando = false;
    }
  }

  // ---- Bind --------------------------------------------------------------
  function bind() {
    // Paso 1
    $('pick-buscar').addEventListener('input', onBuscarInput);

    $('portafolio-onboarding').addEventListener('click', (e) => {
      const perfil = e.target.closest('.perfil-card');
      if (perfil) {
        aplicarPerfil(perfil.dataset.perfil);
        return;
      }
      const filtro = e.target.closest('.pick-filtro');
      if (filtro) {
        setFiltro(filtro.dataset.filtro);
        return;
      }
      const add = e.target.closest('.pick-item');
      if (add && !add.disabled) {
        toggle(
          add.dataset.ticker,
          add.dataset.nombre || add.dataset.ticker,
          add.dataset.moneda,
          add.dataset.precio,
          add.dataset.reco,
        );
        return;
      }
      const rem = e.target.closest('.pick-chip-remove');
      if (rem) {
        toggle(rem.dataset.remove);
      }
    });

    $('pick-siguiente').addEventListener('click', irAPesos);

    // Refrescar precios
    const btnRefrescar = $('pick-refrescar-precios');
    if (btnRefrescar) {
      btnRefrescar.addEventListener('click', () => refrescarPrecios());
    }

    // Paso 2
    $('pesos-atras').addEventListener('click', () => mostrarPaso('tickers'));
    $('pesos-equal').addEventListener('click', distribuirIgual);
    $('pesos-normalizar').addEventListener('click', escalarA100);
    $('pesos-analizar').addEventListener('click', analizar);

    $('pesos-filas').addEventListener('input', onPesosInput);
  }

  function resetYPrecargar(tickersPrevios) {
    state.seleccionados.clear();
    const univMap = new Map(state.universo.map(x => [x.ticker, x]));
    (tickersPrevios || []).forEach(t => {
      const u = univMap.get(t);
      state.seleccionados.set(t, u ? {
        ticker: t,
        nombre: u.nombre,
        moneda: u.moneda,
        precio: u.precio,
        recomendada: u.recomendada,
      } : { ticker: t, nombre: t });
    });
    mostrarPaso('tickers');
    cargar();
    renderCurado($('pick-buscar').value || '');
    renderSeleccion();
    if (!perfilesCache.length) cargarPerfiles();
  }

  // Carga un portafolio óptimo generado por Markowitz directamente al picker
  // tickersConPesos: [{ticker, nombre, peso, moneda, precio}]
  function cargarDesdeOptimo(tickersConPesos) {
    state.seleccionados.clear();
    state.pesos.clear();
    tickersConPesos.forEach(t => {
      state.seleccionados.set(t.ticker, {
        ticker: t.ticker,
        nombre: t.nombre,
        moneda: t.moneda,
        precio: t.precio,
        recomendada: true,
      });
      state.pesos.set(t.ticker, t.peso);
    });
    mostrarPaso('pesos');     // saltar directo al paso 2
    if (typeof renderPesos === 'function') renderPesos();
    if (typeof renderSeleccion === 'function') renderSeleccion();
    // Scroll suave al paso de pesos
    setTimeout(() => {
      const pasoPesos = document.getElementById('paso-pesos');
      if (pasoPesos) pasoPesos.scrollIntoView({behavior:'smooth', block:'start'});
    }, 100);
  }

  return { cargar, bind, resetYPrecargar, refrescarPrecios, cargarPerfiles, cargarDesdeOptimo };
})();

// ============================================================
// PERIÓDICO (cierres + noticias)
// ============================================================
// ============================================================
// WATCHLIST (lista de seguimiento) + sparklines
// ============================================================
const WATCH_KEY = 'miPortafolio.watchlist.v1';
function leerWatchlist() {
  try { const a = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function enWatchlist(t) { return leerWatchlist().includes((t || '').toUpperCase()); }
/* La watchlist se edita desde DOS sitios que ahora conviven en la misma
   pantalla: el ☆ del resultado del análisis y las fichas de "Tus listas". Sin
   avisar del cambio, quitar una emisora en un sitio dejaba al otro pintado como
   si siguiera ahí. El evento es el punto de encuentro; quien pinte watchlist
   debe escucharlo. */
function _avisarWatchlist() {
  try { document.dispatchEvent(new CustomEvent('mp:watchlist')); } catch (_) {}
}
function toggleWatchlist(t) {
  t = (t || '').toUpperCase(); if (!t) return false;
  const a = leerWatchlist(); const i = a.indexOf(t);
  if (i >= 0) a.splice(i, 1); else a.push(t);
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(a)); } catch {}
  _avisarWatchlist();
  return a.includes(t);
}
window.avisarWatchlist = _avisarWatchlist;

/* El ☆ se repinta solo cuando la lista cambia desde otro sitio. */
document.addEventListener('mp:watchlist', () => {
  const b = document.getElementById('an-watch-btn');
  if (!b) return;
  const tk = b.dataset.ticker;
  if (!tk) return;
  const activo = enWatchlist(tk);
  b.textContent = activo ? '★' : '☆';
  b.classList.toggle('text-accent-amber', activo);
  b.classList.toggle('text-zinc-600', !activo);
});
function _sparklineSVG(vals, w = 70, h = 22) {
  if (!Array.isArray(vals) || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  const pts = vals.map((v, i) =>
    `${(i / (vals.length - 1) * w).toFixed(1)},${(h - (v - min) / rng * (h - 2) - 1).toFixed(1)}`
  ).join(' ');
  const col = vals[vals.length - 1] >= vals[0] ? MP_COLOR.sello : MP_COLOR.baja;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
/* renderWatchlist() vivía aquí y pintaba #periodico-watchlist, la lista con
   sparklines del Periódico viejo. Ese markup desapareció con el rediseño de
   mazos: la watchlist ahora es el mazo 2 (Periodico.mazoWatchlist), que usa el
   MISMO endpoint /api/watchlist. La función se elimina en vez de dejarla
   apuntando a un id inexistente. leerWatchlist/toggleWatchlist siguen arriba:
   los usa el botón ☆ de Analizar. */

// ============================================================
// COMPARAR ACCIONES (overlay precio base 100 + métricas lado a lado)
// ============================================================
window.iniciarComparar = (function () {
  let inited = false;
  const PAL = [MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello];
  const state = { tickers: [], rango: '1A', chart: null };
  let universo = [];
  async function _cargarUniverso() {
    if (universo.length) return;
    try {
      const r = await fetch('/api/universo');
      const b = await r.json();
      if (b && Array.isArray(b.tickers)) universo = b.tickers;
    } catch {}
  }
  function _resolver(q) {
    q = (q || '').trim().toUpperCase();
    if (!q) return null;
    if (universo.some(u => u.ticker === q)) return q;       // ya es ticker válido
    const m = universo.find(u => (u.nombre || '').toUpperCase().includes(q));
    return m ? m.ticker : q;                                // nombre → ticker, o tal cual
  }
  function _renderSug(q) {
    const box = document.getElementById('cmp-sug'); if (!box) return;
    q = (q || '').trim().toLowerCase();
    if (q.length < 1 || !universo.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const ms = universo.filter(u =>
      u.ticker.toLowerCase().startsWith(q) || (u.nombre || '').toLowerCase().includes(q)
    ).slice(0, 7);
    if (!ms.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = ms.map(u => `
      <button data-sug-tk="${escapeHtml(u.ticker)}" class="cmp-sug-item w-full text-left px-3 py-2 hover:bg-zinc-900/70 flex items-center gap-2">
        <span class="text-xs font-mono text-zinc-100 shrink-0">${escapeHtml(u.ticker)}</span>
        <span class="text-[10px] text-zinc-500 truncate">${escapeHtml(u.nombre || '')}</span>
      </button>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.cmp-sug-item').forEach(b => b.addEventListener('click', () => {
      agregar(b.dataset.sugTk);
      const inp = $('cmp-input'); if (inp) inp.value = '';
      box.classList.add('hidden'); box.innerHTML = '';
    }));
  }

  function chips() {
    const c = $('cmp-chips'); if (!c) return;
    c.innerHTML = state.tickers.map((t, i) => `
      <span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border tabular" style="border-color:${PAL[i]}66;color:${PAL[i]}">
        ${escapeHtml(t)}<button data-cmp-del="${escapeHtml(t)}" class="cmp-del hover:text-accent-red ml-0.5">✕</button>
      </span>`).join('');
    c.querySelectorAll('.cmp-del').forEach(b => b.addEventListener('click', () => quitar(b.dataset.cmpDel)));
  }
  function agregar(t) {
    t = _resolver(t);
    if (!t || state.tickers.includes(t) || state.tickers.length >= 4) return;
    state.tickers.push(t); chips(); comparar();
  }
  function quitar(t) { state.tickers = state.tickers.filter(x => x !== t); chips(); comparar(); }

  async function comparar() {
    const vacio = $('cmp-vacio'), cv = $('cmp-canvas'), tabla = $('cmp-tabla');
    if (state.tickers.length < 2) {
      if (state.chart) { state.chart.destroy(); state.chart = null; }
      if (vacio) vacio.classList.remove('hidden');
      if (tabla) tabla.innerHTML = '';
      return;
    }
    const datos = await Promise.all(state.tickers.map(async t => {
      const [h, s] = await Promise.all([
        fetch(`/api/historico/${encodeURIComponent(t)}?rango=${state.rango}`).then(r => r.json()).catch(() => null),
        fetch(`/api/score/${encodeURIComponent(t)}`).then(r => r.json()).catch(() => null),
      ]);
      return { t, h, s };
    }));
    const validos = datos.filter(d => d.h && d.h.ok && Array.isArray(d.h.precios) && d.h.precios.length > 1);
    if (validos.length < 2) {
      if (state.chart) { state.chart.destroy(); state.chart = null; }
      if (vacio) vacio.classList.remove('hidden');
      if (tabla) tabla.innerHTML = `<p class="text-xs text-zinc-500 text-center py-4">No encontré datos suficientes para esos tickers en el universo.</p>`;
      return;
    }
    if (vacio) vacio.classList.add('hidden');
    const L = Math.min(...validos.map(d => d.h.precios.length));
    const labels = validos[0].h.fechas.slice(-L);
    const datasets = validos.map(d => {
      const serie = d.h.precios.slice(-L);
      const base = serie[0] || 1;
      const col = PAL[state.tickers.indexOf(d.t)] || MP_COLOR.sello;
      return { label: d.t, data: serie.map(v => v / base * 100), borderColor: col, borderWidth: 1.5, pointRadius: 0, tension: 0.1, fill: false };
    });
    if (cv && typeof Chart !== 'undefined') {
      if (state.chart) state.chart.destroy();
      state.chart = new Chart(cv.getContext('2d'), {
        type: 'line',
        data: { labels, datasets },
        options: MP_GRAFICA.base({
          plugins: { legend: MP_GRAFICA.leyenda(true), tooltip: MP_GRAFICA.tooltip() },
          scales: {
            x: MP_GRAFICA.ejeTiempo(),
            y: MP_GRAFICA.ejeValor({ title: { display: true, text: 'Base 100', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } } }),
          },
        }),
      });
    }
    if (tabla) {
      const pct = v => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(1)}%`;
      const num = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(2);
      const rows = validos.map(d => {
        const col = PAL[state.tickers.indexOf(d.t)] || MP_COLOR.sello;
        const serie = d.h.precios.slice(-L);
        const ret = serie[serie.length - 1] / serie[0] - 1;
        const sc = (d.s && d.s.ok) ? d.s : {};
        return `<tr class="border-t border-surface-border">
          <td class="py-2 pr-2"><span class="inline-block w-2 h-2 rounded-full align-middle mr-2" style="background:${col}"></span><span class="font-semibold tabular text-zinc-100">${escapeHtml(d.t)}</span></td>
          <td class="text-right tabular ${ret >= 0 ? 'text-accent-green' : 'text-accent-red'}">${(ret * 100).toFixed(1)}%</td>
          <td class="text-right tabular text-zinc-300">${pct(sc.volatilidad_anual)}</td>
          <td class="text-right tabular text-zinc-300">${num(sc.sharpe)}</td>
          <td class="text-right tabular text-zinc-300">${num(sc.beta)}</td>
          <td class="text-right tabular font-semibold text-zinc-100">${sc.score != null ? Math.round(sc.score) : '—'}</td>
        </tr>`;
      }).join('');
      const faltan = state.tickers.filter(t => !validos.some(v => v.t === t));
      tabla.innerHTML = `
        <div class="bg-surface-card border border-surface-border rounded-xl p-4 overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-zinc-500 text-left">
              <th class="py-1">Ticker</th><th class="text-right">Retorno ${state.rango}</th><th class="text-right">Volatilidad</th><th class="text-right">Sharpe</th><th class="text-right">Beta</th><th class="text-right">Score</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${faltan.length ? `<p class="text-[11px] text-zinc-500 mt-2">No pude obtener datos (ni del universo ni de Yahoo Finance): <span class="text-zinc-300">${faltan.map(escapeHtml).join(', ')}</span>. Revisa el ticker.</p>` : ''}`;
    }
  }

  return function () {
    if (inited) { comparar(); return; }
    inited = true;
    _cargarUniverso();
    const add = $('cmp-add'), inp = $('cmp-input');
    if (add) add.addEventListener('click', () => { agregar(inp.value); inp.value = ''; _renderSug(''); });
    if (inp) {
      inp.addEventListener('input', () => _renderSug(inp.value));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { agregar(inp.value); inp.value = ''; _renderSug(''); } });
      inp.addEventListener('blur', () => setTimeout(() => _renderSug(''), 150));
    }
    document.querySelectorAll('.cmp-rango').forEach(b => b.addEventListener('click', () => {
      state.rango = b.dataset.cmpRango;
      document.querySelectorAll('.cmp-rango').forEach(x => { x.classList.remove('text-zinc-200', 'bg-zinc-900'); x.classList.add('text-zinc-500'); });
      b.classList.add('text-zinc-200', 'bg-zinc-900'); b.classList.remove('text-zinc-500');
      comparar();
    }));
    try { (leerPortafolioGuardado() || []).slice(0, 2).forEach(t => agregar(t)); } catch {}
    chips();
    if (state.tickers.length < 2) comparar();
  };
})();

// ============================================================================
//  MP_CATEGORIAS — código de color del Periódico
// ============================================================================
//  El color de cada tarjeta NO es decorativo: codifica de qué habla. Paleta
//  fija de cinco categorías, la misma en los cinco mazos, con leyenda visible
//  en la UI. Las claves coinciden EXACTAMENTE con las que asigna el backend
//  (periodico.py → CAT_MX, CAT_GLOBAL, CAT_CRIPTO, CAT_POSICION, CAT_MACRO);
//  si añades una categoría, tiene que existir en los dos lados.
//
//  Cada entrada trae fondo CROMÁTICO —no un pastel lavado— y tinta del MISMO
//  family de color (nunca negro puro ni gris genérico encima del color), más un
//  borde un punto más oscuro que sirve de canto a la tarjeta. Contraste
//  tinta/fondo medido:
//    mx 7.2:1 · global 7.8:1 · cripto 7.7:1 · posicion 7.5:1 · macro 7.2:1
//  El verde y el rojo de mercado (--alza/--baja) también pasan AA sobre las
//  cinco superficies: 4.7:1 en el peor caso.
//
//  `suave` es el texto secundario de la tarjeta (rótulo de categoría, fuente,
//  hora). Es un color REAL y no `tinta` con opacity: la opacidad compone contra
//  el fondo y hundía esos rótulos a 2.9:1 —el contraste medido arriba es de la
//  tinta pura, que es justo lo que hizo que el fallo pasara desapercibido—.
//  Cada `suave` está medido ≥5:1 contra su propio `sup`:
//    mx 5.1:1 · global 5.0:1 · cripto 5.1:1 · posicion 5.1:1 · macro 5.1:1
const MP_CATEGORIAS = {
  mx:       { etq: 'BMV · IPC',      leyenda: 'Mercado mexicano',  sup: '#A8DCB8', tinta: '#0E4526', suave: '#255C3C', borde: '#8BCB9F' },
  global:   { etq: 'Global',         leyenda: 'Mercados globales', sup: '#AECDF2', tinta: '#123457', suave: '#305174', borde: '#8FB8E8' },
  cripto:   { etq: 'Cripto',         leyenda: 'Criptomonedas',     sup: '#F6D28C', tinta: '#573305', suave: '#724E1C', borde: '#E8BE6B' },
  posicion: { etq: 'Tus posiciones', leyenda: 'Tus posiciones',    sup: '#CFBBEE', tinta: '#382461', suave: '#533F7A', borde: '#BBA2E4' },
  macro:    { etq: 'Macro y tasas',  leyenda: 'Macro y tasas',     sup: '#F5C7A3', tinta: '#5A3212', suave: '#714828', borde: '#EAB183' },
};
window.MP_CATEGORIAS = MP_CATEGORIAS;

/* Categoría a partir del ticker, para los mazos que no traen una del servidor. */
function _catDeTicker(t) {
  const u = (t || '').toUpperCase();
  if (u.endsWith('-USD') || u.endsWith('-USDT')) return 'cripto';
  if (u.endsWith('.MX')) return 'mx';
  if (u.startsWith('^TNX') || u.startsWith('^IRX') || u.startsWith('^VIX') ||
      u.endsWith('=X') || u === 'TLT') return 'macro';
  return 'global';
}

const Periodico = (() => {
  // Tope de tarjetas por mazo. Una pila de 10 mide 9×68 + 132 ≈ 744 px, que es
  // lo más alto que se puede recorrer con el pulgar sin perder el hilo. Lo que
  // se recorta se dice en la UI, nunca se trunca en silencio.
  const MAX_TARJETAS = 10;

  // El orden del swipe lo fija esta lista y nada más: el indicador, los paneles
  // y la carga se generan a partir de ella.
  /* Ventana de tiempo de los mazos de datos. El backend ya la aceptaba en
     /api/periodico/top-movers y /api/periodico/sectores; lo que faltaba era
     poder cambiarla. "Lo que más subió hoy" y "lo que más subió en el año" son
     preguntas distintas, y con solo el día un lunes tranquilo deja la sección
     entera diciendo ±0.2%. */
  const PERIODOS = [
    { clave: 'dia',    etq: 'Hoy',    frase: 'hoy' },
    { clave: 'semana', etq: 'Semana', frase: 'esta semana' },
    { clave: 'mes',    etq: 'Mes',    frase: 'este mes' },
    { clave: 'anio',   etq: 'Año',    frase: 'este año' },
  ];
  const _frasePeriodo = (c) => (PERIODOS.find(p => p.clave === c) || PERIODOS[0]).frase;
  /* Los únicos dos mazos cuyo contenido cambia con la ventana. Noticias es la
     edición del día y la watchlist es una lista fija: ahí el control no tendría
     nada que hacer. */
  const MAZOS_CON_PERIODO = ['accion', 'sector'];

  const MAZOS = [
    { clave: 'noticias',  titulo: 'Noticias' },
    { clave: 'accion',    titulo: 'Acción del día' },
    { clave: 'indices',   titulo: 'Índices y divisas' },
    { clave: 'sector',    titulo: 'Sector del día' },
    { clave: 'watchlist', titulo: 'Tu watchlist' },
  ];

  const LS_PERIODO = 'miPortafolio.periodicoPeriodo.v1';
  const state = {
    cargadoUnaVez: false,
    activo: 0,
    abierta: {},    // clave de mazo -> índice de tarjeta abierta (o null)
    charts: {},     // id de tarjeta -> instancia de Chart
    datos: {},      // clave de mazo -> array de tarjetas
    // La ventana elegida sobrevive a la sesión: quien mira el año rara vez
    // quiere volver al día en cada visita.
    periodo: (() => {
      try {
        const v = localStorage.getItem(LS_PERIODO);
        return ['dia', 'semana', 'mes', 'anio'].includes(v) ? v : 'dia';
      } catch (_) { return 'dia'; }
    })(),
  };

  // ─────────────────────────────────────────────────────────
  //  Utilidades
  // ─────────────────────────────────────────────────────────
  function fmtHora(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const diffMin = (new Date() - d) / 60000;
      if (diffMin < 1) return 'hace un momento';
      if (diffMin < 60) return `hace ${Math.round(diffMin)} min`;
      const diffH = diffMin / 60;
      if (diffH < 24) return `hace ${Math.round(diffH)} h`;
      const diffD = diffH / 24;
      if (diffD < 7) return `hace ${Math.round(diffD)} d`;
      return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    } catch { return ''; }
  }

  /* "2026-08-12" → "miércoles 12 de agosto". La fecha ISO es un dato de
     máquina; en pantalla va la fecha como la diría una persona. */
  function _fechaLarga(iso) {
    try {
      const [a, m, d] = String(iso).split('-').map(Number);
      const t = new Date(a, m - 1, d).toLocaleDateString('es-MX',
        { weekday: 'long', day: 'numeric', month: 'long' });
      // toLocaleDateString devuelve "miércoles, 12 de agosto": fuera la coma
      // y mayúscula inicial, que es como se escribe una fecha en un titular.
      const limpio = t.replace(',', '');
      return limpio.charAt(0).toUpperCase() + limpio.slice(1);
    } catch { return iso; }
  }

  const fmtPct = (v) => (v == null || isNaN(v)) ? null : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
  const fmtNum = (v, d = 2) => (v == null || isNaN(v)) ? null : Number(v).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d });

  /* Petición con TOPE de tiempo. Sin él, una sola petición colgada dejaba el
     Periódico en el esqueleto para siempre: `cargar()` espera a los cinco
     mazos con Promise.all y `fetch` no caduca por su cuenta. Pasado el tope se
     aborta y ese mazo degrada con su mensaje y su botón de reintento, que es
     justo lo que debe pasar. */
  const TOPE_MS = 12000;

  async function safeJson(entrada) {
    // Acepta una promesa ya empezada (fetch(...)) o una función que la crea.
    // Con función se puede abortar de verdad; con promesa solo se deja de
    // esperar, que para el caso —degradar la sección— es suficiente.
    const conTope = (prom) => Promise.race([
      prom,
      new Promise((_, rechaza) => setTimeout(() => rechaza(new Error('tope de tiempo')), TOPE_MS)),
    ]);
    try {
      let r;
      if (typeof entrada === 'function') {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TOPE_MS);
        try { r = await entrada(ctrl.signal); } finally { clearTimeout(t); }
      } else {
        r = await conTope(entrada);
      }
      if (!r) return null;
      try { return await conTope(r.json()); } catch { return null; }
    } catch { return null; }
  }

  /* Abre el artículo en la fuente original. En la app nativa usa el plugin
     Browser de Capacitor (hoja in-app: el usuario NO sale de la app y vuelve
     con un toque); en web, pestaña nueva. Mismo patrón que paywall.js. */
  async function abrirEnlace(url) {
    if (!url) return;
    try {
      const Caps = window.Capacitor;
      const B = Caps && Caps.Plugins && Caps.Plugins.Browser;
      if (B && B.open) { await B.open({ url }); return; }
    } catch (_) { /* cae al window.open de abajo */ }
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
  }

  /* Lleva a la vista Analizar con el ticker cargado. Se expone en window
     porque el screener (herramientas_avanzadas.js) necesita el mismo salto:
     encontrar un ticker en una tabla y tener que teclearlo a mano en otra
     pantalla deja el hallazgo en nada. */
  function irAAnalizar(ticker) {
    if (!ticker) return;
    const tab = document.querySelector('.nav-tab[data-vista="analizar"]');
    if (tab) tab.click();
    setTimeout(() => {
      const inp = $('an-input'); if (inp) inp.value = ticker;
      const btn = $('an-btn-analizar'); if (btn) btn.click();
    }, 120);
  }
  window.analizarTicker = irAAnalizar;

  // ─────────────────────────────────────────────────────────
  //  Construcción de los mazos a partir de los endpoints QUE YA EXISTEN
  // ─────────────────────────────────────────────────────────
  /* Forma común de una tarjeta:
     { cat, etq, titular|nombre, variacion, meta, resumen, url, tickers[],
       metricas:[{k,v,dir}], grafica: <ticker|null> }                        */

  function _tarjetaDeCotizacion(it, catForzada) {
    const cat = catForzada || _catDeTicker(it.ticker);
    const pct = it.cambio_pct;
    const esPct = it.moneda === '%';
    const sym = it.moneda === 'MXN' ? '$' : (esPct ? '' : 'US$');
    return {
      cat,
      etq: it.etiqueta || MP_CATEGORIAS[cat].etq,
      nombre: it.nombre || it.ticker,
      variacion: fmtPct(pct),
      dir: pct == null ? 0 : (pct > 0 ? 1 : (pct < 0 ? -1 : 0)),
      meta: `${it.ticker}${it.fecha ? ' · cierre ' + it.fecha : ''}`,
      tickers: [it.ticker],
      grafica: it.ticker,
      metricas: [
        { k: esPct ? 'Nivel' : 'Precio', v: `${sym}${fmtNum(it.precio) ?? '—'}` },
        { k: 'Cambio', v: fmtPct(pct) ?? '—', dir: pct },
        { k: 'Abs.', v: fmtNum(it.cambio_abs) ?? '—', dir: it.cambio_abs },
      ].filter(m => m.v !== '—'),
    };
  }

  async function mazoNoticias() {
    const misTickers = (leerPortafolioGuardado() || []).slice(0, 12);
    // La edición del día + lo que toca TU portafolio. Las tuyas van primero:
    // son las que explican por qué se movió lo que tienes. Sin ellas, la
    // categoría "Tus posiciones" de la leyenda nunca aparecería.
    const [d, mias] = await Promise.all([
      safeJson(s => fetch('/api/periodico/edicion?limite=' + MAX_TARJETAS, { signal: s })),
      misTickers.length
        ? safeJson(s => fetch('/api/periodico/noticias-portafolio', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers: misTickers }), signal: s,
          }))
        : Promise.resolve([]),
    ]);
    // Una tarjeta POR EMISORA tuya que tenga noticia, no tres de la misma. Si
    // cinco de tus posiciones traen noticia se ven cinco tarjetas moradas
    // distintas; si solo una tiene, se ve una. Se reparte por rondas
    // (la más reciente de cada emisora primero) y se topa en la mitad del mazo
    // para que la edición del día no desaparezca detrás de tu portafolio.
    const porEmisora = new Map();
    for (const n of (Array.isArray(mias) ? mias : [])) {
      if (!n || !n.url) continue;
      const t = (n.tickers && n.tickers[0]) || n.ticker_relacionado || '·';
      // La lista viene ordenada por fecha desc: la primera de cada emisora es
      // la más reciente y es la única que se queda.
      if (!porEmisora.has(t)) porEmisora.set(t, n);
    }
    // UNA tarjeta por emisora tuya con noticia. El tope es la mitad del mazo
    // para que la edición del día no acabe sepultada bajo tu portafolio.
    const propias = [...porEmisora.values()].slice(0, Math.floor(MAX_TARJETAS / 2));
    const base = (d && Array.isArray(d.noticias)) ? d.noticias : [];
    if (!propias.length && !base.length) {
      return { error: (d && d.error) || 'No pude traer la edición de hoy.', tarjetas: [] };
    }
    const vistas = new Set();
    const fusion = [...propias, ...base].filter(n => {
      if (!n || !n.url || vistas.has(n.url)) return false;
      vistas.add(n.url);
      return true;
    });
    const tarjetas = fusion.slice(0, MAX_TARJETAS).map(n => {
      const cat = MP_CATEGORIAS[n.categoria] ? n.categoria : 'global';
      return {
        cat,
        // La fuente va en la ETIQUETA, no en la meta: la franja visible de la
        // pila tiene que llevar titular Y nombre de la fuente, y la meta cae
        // por debajo del corte. En las de tu portafolio manda el TICKER: es lo
        // que te dice de golpe cuál de tus posiciones se movió.
        etq: (cat === 'posicion'
                ? [(n.tickers && n.tickers[0]) || n.ticker_relacionado, n.proveedor]
                : [MP_CATEGORIAS[cat].leyenda, n.proveedor]
             ).filter(Boolean).join(' · '),
        titular: n.titulo,
        meta: fmtHora(n.fecha),
        resumen: n.resumen,
        url: n.url,
        tickers: (n.tickers || []).filter(t => !t.startsWith('^')),
      };
    });
    return { tarjetas, edicion: d && d.edicion, degradado: d && d.degradado,
             error: (d && d.degradado) ? d.error : null };
  }

  async function mazoWatchlist() {
    const tickers = leerWatchlist();
    if (!tickers.length) {
      // El texto mandaba al ☆ del resultado de un análisis, que obliga a analizar
      // algo ANTES de poder seguirlo. Desde que existe el buscador de
      // "Tus listas" hay una vía directa, y es la que hay que enseñar.
      return { tarjetas: [], vacio: 'Aún no sigues ninguna acción. Búscalas en <b>Analizar → Tus listas</b> y aparecerán aquí con su precio y su gráfica.' };
    }
    const d = await safeJson(s => fetch('/api/watchlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }), signal: s,
    }));
    const items = (d && d.ok && d.items) || [];
    const faltantes = (d && d.faltantes) || [];
    if (!items.length && !faltantes.length) {
      return { error: 'No pude cargar tu lista en este momento.', tarjetas: [] };
    }
    /* Las emisoras sin datos llevan SU PROPIA tarjeta en vez de desaparecer.
       La lupa consulta Yahoo, así que se pueden seguir emisoras que no están en
       el universo local; antes esas se caían del mazo sin explicación y parecía
       que la app había perdido la lista. */
    const sinDatos = faltantes.slice(0, 4).map(t => ({
      cat: _catDeTicker(t),
      etq: MP_CATEGORIAS[_catDeTicker(t)].leyenda,
      nombre: t,
      meta: 'Sin precios en nuestro universo',
      tickers: [t],
      detalle: 'Sigues esta emisora, pero todavía no tenemos su serie de precios, '
             + 'así que no podemos dibujar su tarjeta. Su análisis individual sí funciona.',
    }));
    return {
      tarjetas: items.slice(0, MAX_TARJETAS).map(it => {
        const cat = _catDeTicker(it.ticker);
        const sym = it.moneda === 'MXN' ? '$' : 'US$';
        return {
          cat,
          etq: MP_CATEGORIAS[cat].leyenda,
          nombre: it.ticker,
          variacion: fmtPct(it.cambio_pct),
          dir: (it.cambio_pct || 0) >= 0 ? 1 : -1,
          meta: it.nombre || '',
          tickers: [it.ticker],
          grafica: it.ticker,
          metricas: [
            { k: 'Precio', v: `${sym}${fmtNum(it.precio) ?? '—'}` },
            { k: 'Cambio', v: fmtPct(it.cambio_pct) ?? '—', dir: it.cambio_pct },
          ].filter(m => m.v !== '—'),
        };
      }).concat(sinDatos).slice(0, MAX_TARJETAS),
    };
  }

  async function mazoAccion() {
    const per = state.periodo || 'dia';
    const [ad, mov] = await Promise.all([
      safeJson(s => fetch('/api/periodico/accion-del-dia', { signal: s })),
      safeJson(s => fetch('/api/periodico/top-movers?periodo=' + per + '&n=3', { signal: s })),
    ]);
    const tarjetas = [];

    if (ad && ad.ok && ad.accion) {
      const a = ad.accion;
      const cat = a.es_mx ? 'mx' : 'global';
      const sym = a.moneda === 'MXN' ? '$' : 'US$';
      tarjetas.push({
        cat,
        etq: 'Acción del día · score ' + (ad.score != null ? ad.score : '—'),
        nombre: a.ticker,
        variacion: a.momentum_3m != null ? fmtPct(a.momentum_3m * 100) : null,
        dir: (a.momentum_3m || 0) >= 0 ? 1 : -1,
        meta: a.nombre || '',
        resumen: ad.metodologia || '',
        tickers: [a.ticker],
        grafica: a.ticker,
        metricas: [
          { k: 'Precio', v: a.precio ? `${sym}${fmtNum(a.precio)}` : '—' },
          { k: 'Alpha SML', v: a.alpha_anualizado != null ? fmtPct(a.alpha_anualizado * 100) : '—', dir: a.alpha_anualizado },
          { k: 'Beta', v: fmtNum(a.beta) ?? '—' },
          { k: 'Momentum 3m', v: a.momentum_3m != null ? fmtPct(a.momentum_3m * 100) : '—', dir: a.momentum_3m },
          { k: 'P/E', v: fmtNum(a.pe, 1) ?? '—' },
          { k: 'ROE', v: a.roe != null ? fmtPct(a.roe * 100) : '—' },
        ].filter(m => m.v !== '—'),
        razones: a.razones || [],
      });
    }

    const grupo = (lista, etq) => (lista || []).slice(0, 3).map(m => {
      const cat = _catDeTicker(m.ticker);
      // El backend llama a este campo `retorno_pct` (top_movers.py, _enriquecer);
      // aquí se leía `cambio_pct`, que no existe en ese payload. Efecto: en el
      // mazo "Acción del día" TODAS las tarjetas de mayores subidas y bajadas
      // salían sin su porcentaje —una lista de "lo que más subió" sin el
      // número—, y como esas tarjetas tampoco traen nombre, quedaban con un
      // rótulo y un ticker flotando en un rectángulo vacío. Se acepta el otro
      // nombre por si algún endpoint viejo lo usa.
      const pct = m.retorno_pct != null ? m.retorno_pct : m.cambio_pct;
      const sym = m.moneda === 'MXN' ? '$' : 'US$';
      return {
        cat,
        etq,
        nombre: m.ticker,
        variacion: fmtPct(pct),
        dir: (pct || 0) >= 0 ? 1 : -1,
        // Sin nombre (el universo no lo trae para los small caps) la tarjeta se
        // quedaba en blanco: el precio es el dato que sí existe siempre.
        meta: m.nombre || (m.precio != null ? `${sym}${fmtNum(m.precio)}` : ''),
        tickers: [m.ticker],
        grafica: m.ticker,
        metricas: [
          { k: 'Precio', v: m.precio != null ? `${sym}${fmtNum(m.precio)}` : '—' },
          { k: 'Cambio', v: fmtPct(pct) ?? '—', dir: pct },
        ].filter(x => x.v !== '—'),
      };
    });
    if (mov && mov.ok) {
      const cuando = _frasePeriodo(per);
      tarjetas.push(...grupo(mov.ganadores, 'Más subió ' + cuando));
      tarjetas.push(...grupo(mov.perdedores, 'Más cayó ' + cuando));
    }

    if (!tarjetas.length) return { error: 'La selección del día no está disponible ahora mismo.', tarjetas: [] };
    return { tarjetas: tarjetas.slice(0, MAX_TARJETAS) };
  }

  async function mazoSector(mercados) {
    const per = state.periodo || 'dia';
    // El atajo por `mercados` solo sirve para el día: ese payload trae los
    // sectores de la jornada. Para cualquier otra ventana hay que pedirlos.
    let sectores = (per === 'dia' && mercados && mercados.sectores) || [];
    if (!sectores.length) {
      const d = await safeJson(s => fetch('/api/periodico/sectores?periodo=' + per, { signal: s }));
      sectores = (d && d.ok && d.sectores) || [];
    }
    if (!sectores.length) return { error: 'Los sectores no están disponibles ahora mismo.', tarjetas: [] };
    // El "sector del día" es el de mayor movimiento absoluto: sale primero y el
    // resto queda debajo, ordenado por variación descendente.
    const orden = sectores.slice().sort((a, b) =>
      Math.abs(b.cambio_pct || 0) - Math.abs(a.cambio_pct || 0));
    const dia = orden[0];
    const resto = sectores.slice()
      .filter(s => s.ticker !== dia.ticker)
      .sort((a, b) => (b.cambio_pct || 0) - (a.cambio_pct || 0));
    return {
      tarjetas: [dia, ...resto].slice(0, MAX_TARJETAS).map((s, i) => {
        const t = _tarjetaDeCotizacion(s, 'global');
        // El rótulo sigue la ventana elegida: decir "sector del día" mientras
        // el número es el del año es contradecirse en la misma tarjeta.
        t.etq = i === 0 ? 'Sector destacado ' + _frasePeriodo(per) : 'Sector · ' + s.ticker;
        return t;
      }),
      recorte: sectores.length > MAX_TARJETAS ? sectores.length - MAX_TARJETAS : 0,
    };
  }

  async function mazoIndices(mercados) {
    if (!mercados) return { error: 'Los índices no están disponibles ahora mismo.', tarjetas: [] };
    const us = mercados.indices_us || [];
    const mundo = mercados.indices_mundo || [];
    const div = mercados.divisas || [];
    const tasas = mercados.tasas_vol || [];
    const cripto = mercados.crypto || [];
    const tarjetas = [
      ...us.map(x => _tarjetaDeCotizacion(x, (x.ticker || '').endsWith('.MX') ? 'mx' : 'global')),
      ...div.slice(0, 2).map(x => _tarjetaDeCotizacion(x, 'macro')),
      ...tasas.slice(0, 2).map(x => _tarjetaDeCotizacion(x, 'macro')),
      ...cripto.slice(0, 1).map(x => _tarjetaDeCotizacion(x, 'cripto')),
      ...mundo.slice(0, 2).map(x => _tarjetaDeCotizacion(x, 'global')),
    ];
    if (!tarjetas.length) return { error: 'Los índices no están disponibles ahora mismo.', tarjetas: [] };
    return { tarjetas: tarjetas.slice(0, MAX_TARJETAS) };
  }

  // ─────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────
  function _leyendaHTML() {
    return Object.entries(MP_CATEGORIAS).map(([, c]) =>
      `<span><i style="background:${c.sup};border-color:${c.borde}"></i>${escapeHtml(c.leyenda)}</span>`
    ).join('');
  }

  function _indicadorHTML() {
    return MAZOS.map((m, i) => `
      <button role="tab" id="mazo-tab-${m.clave}" data-ir="${i}"
              aria-controls="mazo-pane-${m.clave}"
              aria-selected="${i === state.activo}">${escapeHtml(m.titulo)}</button>`).join('');
  }

  function _tarjetaHTML(t, clave, i) {
    const c = MP_CATEGORIAS[t.cat] || MP_CATEGORIAS.global;
    const idDet = `tj-${clave}-${i}`;
    const idBtn = `tjb-${clave}-${i}`;
    // Dirección de mercado: triángulo ▲/▼ MÁS el verde/rojo semántico. Los dos
    // a la vez porque sobre los fondos de categoría el color solo ya no basta
    // (y porque la dirección no debe depender de distinguir verde de rojo).
    // Ambos tonos pasan AA sobre las cinco superficies de MP_CATEGORIAS.
    const dirCls = t.dir > 0 ? 'mp-dir mp-alza' : (t.dir < 0 ? 'mp-dir mp-baja' : '');
    const cara = t.titular
      ? `<span class="mp-tarjeta-etq">${escapeHtml(t.etq || '')}</span>
         <span class="mp-tarjeta-titular">${escapeHtml(t.titular)}</span>
         ${t.meta ? `<span class="mp-tarjeta-meta">${escapeHtml(t.meta)}</span>` : ''}`
      : `<span class="mp-tarjeta-etq">${escapeHtml(t.etq || '')}</span>
         <span class="mp-tarjeta-fila">
           <span class="mp-tarjeta-nom">${escapeHtml(t.nombre || '')}</span>
           ${t.variacion ? `<span class="mp-tarjeta-var ${dirCls}">${escapeHtml(t.variacion)}</span>` : ''}
         </span>
         ${t.meta ? `<span class="mp-tarjeta-meta">${escapeHtml(t.meta)}</span>` : ''}`;

    const metricas = (t.metricas || []).length ? `
      <dl class="mp-tarjeta-metricas">
        ${t.metricas.map(m => `<div><dt>${escapeHtml(m.k)}</dt><dd>${escapeHtml(String(m.v))}</dd></div>`).join('')}
      </dl>` : '';

    const chips = (t.tickers || []).length ? `
      <div class="mp-tarjeta-chips">
        ${t.tickers.slice(0, 6).map(tk =>
          `<button class="mp-chip-ticker" data-ticker="${escapeHtml(tk)}">${escapeHtml(tk)} →</button>`).join('')}
      </div>` : '';

    const razones = (t.razones || []).length ? `
      <div class="mp-tarjeta-chips">
        ${t.razones.slice(0, 4).map(r =>
          `<span class="mp-chip-ticker" style="cursor:default">${escapeHtml(r)}</span>`).join('')}
      </div>` : '';

    return `
      <article class="mp-tarjeta" data-i="${i}"
               style="--cat-sup:${c.sup};--cat-tinta:${c.tinta};--cat-suave:${c.suave};--cat-borde:${c.borde}">
        <button class="mp-tarjeta-cara" id="${idBtn}" type="button"
                aria-expanded="false" aria-controls="${idDet}">${cara}</button>
        <div class="mp-tarjeta-detalle" id="${idDet}" role="region"
             aria-labelledby="${idBtn}" inert>
          <div class="mp-tarjeta-asa" aria-hidden="true"></div>
          <hr>
          ${t.resumen ? `<p class="mp-tarjeta-resumen">${escapeHtml(t.resumen)}</p>` : ''}
          ${t.grafica ? `<div class="mp-tarjeta-grafica"><canvas></canvas></div>` : ''}
          ${metricas}
          ${razones}
          ${chips}
          ${t.url
            ? `<button class="mp-tarjeta-accion" type="button" data-url="${escapeHtml(t.url)}">
                 <span>Leer nota completa →</span></button>`
            : (t.tickers && t.tickers.length
               ? `<button class="mp-tarjeta-accion" type="button" data-ticker="${escapeHtml(t.tickers[0])}">
                    <span>Analizar ${escapeHtml(t.tickers[0])} →</span></button>` : '')}
        </div>
        <button class="mp-tarjeta-cerrar" type="button" aria-label="Cerrar tarjeta">✕</button>
      </article>`;
  }

  function _paneHTML(m, res) {
    const tarjetas = (res && res.tarjetas) || [];
    let cuerpo;
    if (tarjetas.length) {
      cuerpo = `<div class="mp-mazo" data-mazo="${m.clave}">
                  ${tarjetas.map((t, i) => _tarjetaHTML(t, m.clave, i)).join('')}
                </div>`;
    } else {
      // Degradación explícita y accionable: nunca "Cargando…" eterno ni blanco.
      // `vacio` es copy nuestro y puede traer marcado; `error` puede venir del
      // servidor, así que ese sí se escapa.
      const msg = (res && res.vacio)
        || (res && res.error ? escapeHtml(res.error) : '')
        || 'No hay nada que mostrar aquí ahora mismo.';
      cuerpo = `<div class="mp-vacio" style="text-align:left">
                  <p style="margin:0 0 10px">${msg}</p>
                  <button class="mp-btn mp-btn-secundario mazo-reintentar" type="button">Reintentar</button>
                </div>`;
    }
    const nota = (res && res.recorte)
      ? `<p class="mp-firma" style="margin-top:10px">Se muestran ${MAX_TARJETAS} de ${MAX_TARJETAS + res.recorte}.</p>` : '';
    const aviso = (res && res.degradado && res.error)
      ? `<p class="mp-firma" style="margin-top:var(--paso-3);color:var(--baja)">${escapeHtml(res.error)} Estás viendo la edición anterior.</p>` : '';
    // El selector de ventana vive DENTRO de los mazos que dependen de él, no en
    // la cabecera. En la cabecera salía siempre, también sobre Noticias y
    // Watchlist, que no tienen periodo: un control que no hace nada en tres de
    // los cinco mazos. Aquí aparece exactamente donde aplica —al deslizar hasta
    // Acción del día o Sector en móvil, y junto a su título en escritorio—.
    const selector = MAZOS_CON_PERIODO.includes(m.clave)
      ? `<div class="mp-periodos" role="group" data-periodos
              aria-label="Periodo de ${escapeHtml(m.titulo)}">${_periodoHTML()}</div>`
      : '';
    return `
      <section class="mp-mazo-pane" id="mazo-pane-${m.clave}" role="tabpanel"
               aria-labelledby="mazo-tab-${m.clave}" tabindex="0">
        <h3 class="mp-mazo-titulo">${escapeHtml(m.titulo)}</h3>
        ${selector}${cuerpo}${nota}${aviso}
      </section>`;
  }

  // ─────────────────────────────────────────────────────────
  //  Geometría de la pila (todo con transform)
  // ─────────────────────────────────────────────────────────
  function _medidas(mazo) {
    const cs = getComputedStyle(mazo.closest('.mp-mazos') || document.documentElement);
    const num = (n, def) => {
      const v = parseFloat(cs.getPropertyValue(n));
      return isNaN(v) ? def : v;
    };
    return { paso: num('--tj-paso', 68), cara: num('--tj-cara', 132), mini: num('--tj-mini', 26) };
  }

  /* Coloca cada tarjeta y devuelve el alto total de la pila. Puro translateY. */
  /* En pantalla ancha las tarjetas NO se apilan.
     El mazo de Wallet resuelve un problema del móvil: enseñar diez cosas en una
     columna de 390px sin obligar a recorrer. En un monitor hay tres columnas a
     la vista y espacio vertical de sobra, así que apilar solo produce tres
     torres de franjas encimadas que se leen como una lista rota. Arriba de
     1024px cada mazo pasa a ser una lista normal de tarjetas separadas: el CSS
     las devuelve al flujo y esta función se aparta, borrando los estilos en
     línea que había puesto el modo apilado. */
  const _modoLista = () => window.matchMedia('(min-width: 1024px)').matches;

  function _posicionar(mazo, animar) {
    const tarjetas = [...mazo.querySelectorAll('.mp-tarjeta')];
    if (!tarjetas.length) return 0;

    if (_modoLista()) {
      tarjetas.forEach((el, i) => {
        el.style.transform = '';
        el.style.zIndex = String(10 + i);   // el orden sigue importando al abrir
      });
      mazo.style.height = '';               // manda el flujo, no una altura fija
      return mazo.getBoundingClientRect().height;
    }

    const { paso, cara, mini } = _medidas(mazo);
    const k = state.abierta[mazo.dataset.mazo];
    let y = 0, alto = 0;
    if (!animar) mazo.classList.add('sin-animacion');

    tarjetas.forEach((el, i) => {
      el.style.transform = `translateY(${y}px)`;
      // z creciente: cada tarjeta tapa a la anterior. De eso depende que el
      // crecimiento de la que se abre quede oculto tras la de abajo.
      el.style.zIndex = String(10 + i);
      const abierta = (k === i);
      // Alto real de la abierta: se mide del DOM porque el contenido varía.
      const suyo = abierta ? el.scrollHeight : cara;
      alto = y + suyo;                    // borde inferior de ESTA tarjeta
      if (k == null)      y += paso;      // pila en reposo
      else if (i < k)     y += mini;      // las de arriba se compactan
      else if (i === k)   y += el.scrollHeight;
      else                y += paso;      // las de abajo bajan en bloque
    });

    // Al salir del bucle `alto` es el borde inferior de la ÚLTIMA tarjeta, que
    // es la única que se ve entera: con eso la pila nunca corta contenido.
    mazo.style.height = Math.ceil(alto) + 'px';
    if (!animar) {
      // Reflow forzado ANTES de devolver la transición: si se quitara la clase
      // en el mismo frame, el navegador vería un solo cambio de estilo y
      // animaría igual desde la posición vieja.
      void mazo.offsetHeight;
      mazo.classList.remove('sin-animacion');
    }
    return alto;
  }

  /* Cruzar el umbral de 1024px cambia el modelo entero (apilado <-> lista), y
     eso no puede esperar a la siguiente carga: al girar un iPad o redimensionar
     la ventana hay que recolocar.
     Se escucha el CAMBIO DE LA MEDIA QUERY, no 'resize'. Con resize el
     manejador puede correr antes de que la consulta haya cambiado de estado,
     así que _modoLista() devuelve el valor viejo, la comparación no detecta
     nada y las tarjetas se quedan sin transform: las diez apiladas en el mismo
     punto. matchMedia dispara justo cuando el umbral ya cambió. */
  (function _vigilarAncho() {
    const mq = window.matchMedia('(min-width: 1024px)');
    const recolocar = () => {
      document.querySelectorAll('.mp-mazo').forEach(m => _posicionar(m, false));
      _reajustarPista();
    };
    if (mq.addEventListener) mq.addEventListener('change', recolocar);
    else if (mq.addListener) mq.addListener(recolocar);   // Safari viejo
  })();

  function _reajustarPista() {
    const pista = $('mazos-pista');
    if (!pista) return;
    // En modo lista la pista no recorta nada: el alto lo pone el contenido y
    // fijarlo a mano dejaría los mazos de abajo cortados.
    if (_modoLista()) { pista.style.height = ''; return; }
    let max = 0;
    pista.querySelectorAll('.mp-mazo-pane').forEach(pane => {
      // Se SUMAN los hijos en vez de leer pane.scrollHeight: los panes son
      // items flex y su scrollHeight nunca baja del alto ya impuesto a la
      // pista, así que al cerrar una tarjeta la sección se quedaba estirada
      // para siempre. Sumar el contenido real sube y baja igual de bien.
      // El padding del propio pane NO viene en offsetHeight de los hijos, y el
      // de arriba es el aire que necesita la sombra de apoyo de la primera
      // tarjeta: sin sumarlo, la pista queda 10px corta y recorta la última.
      const csp = getComputedStyle(pane);
      let h = parseFloat(csp.paddingTop || 0) + parseFloat(csp.paddingBottom || 0);
      [...pane.children].forEach(hijo => {
        const cs = getComputedStyle(hijo);
        h += hijo.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
      });
      max = Math.max(max, h);
    });
    // overflow-y:hidden en la pista obliga a darle alto explícito; se toma el
    // del mazo MÁS ALTO para que ninguno quede cortado al deslizar de lado.
    pista.style.height = Math.ceil(max) + 'px';
  }

  /* La pila anima su alto (transition en .mp-mazo), así que medir justo
     después de cambiarlo devuelve el valor A MEDIO camino y la pista se queda
     corta —cortando las tarjetas de abajo—. Se vuelve a medir al terminar la
     transición, que es cuando el número ya es el definitivo. */
  function _reajustarAlAsentar(mazo) {
    if (!mazo || mazo.dataset.ligado === '1') return;
    mazo.dataset.ligado = '1';
    mazo.addEventListener('transitionend', (ev) => {
      if (ev.target === mazo && ev.propertyName === 'height') _reajustarPista();
    });
  }

  // ─────────────────────────────────────────────────────────
  //  Abrir / cerrar
  // ─────────────────────────────────────────────────────────
  function _cerrarTodas(mazo) { _abrir(mazo, null); }

  function _abrir(mazo, idx) {
    const clave = mazo.dataset.mazo;
    const tarjetas = [...mazo.querySelectorAll('.mp-tarjeta')];
    state.abierta[clave] = idx;

    tarjetas.forEach((el, i) => {
      const abierta = (i === idx);
      el.classList.toggle('abierta', abierta);
      const cara = el.querySelector('.mp-tarjeta-cara');
      const det = el.querySelector('.mp-tarjeta-detalle');
      if (cara) cara.setAttribute('aria-expanded', String(abierta));
      if (det) {
        // `inert` saca el detalle del foco Y del árbol de accesibilidad, que es
        // lo correcto cuando está tapado por la tarjeta de arriba.
        if (abierta) det.removeAttribute('inert'); else det.setAttribute('inert', '');
      }
    });

    _posicionar(mazo, true);
    _reajustarPista();

    if (idx != null) {
      const el = tarjetas[idx];
      const t = (state.datos[clave] || [])[idx];
      if (t && t.grafica) _pintarGrafica(el, t.grafica, `${clave}-${idx}`);
      // Reposicionar cuando la gráfica/el contenido cambien de alto.
      setTimeout(() => { _posicionar(mazo, true); _reajustarPista(); }, 260);
    }
  }

  // ─────────────────────────────────────────────────────────
  //  Gráfica dentro de la tarjeta — reusa MP_GRAFICA (tema único)
  // ─────────────────────────────────────────────────────────
  async function _pintarGrafica(card, ticker, id) {
    const host = card.querySelector('.mp-tarjeta-grafica');
    const cv = host && host.querySelector('canvas');
    if (!cv || state.charts[id]) return;
    if (typeof Chart === 'undefined') { host.remove(); return; }
    state.charts[id] = 'cargando';
    const d = await safeJson(s => fetch(`/api/historico/${encodeURIComponent(ticker)}?rango=6M`, { signal: s }));
    if (!d || !d.ok || !Array.isArray(d.precios) || d.precios.length < 2) {
      // Sin serie no se deja un hueco ni un canvas vacío: se quita el bloque.
      delete state.charts[id];
      if (host) host.remove();
      const mazo = card.closest('.mp-mazo');
      if (mazo) { _posicionar(mazo, true); _reajustarPista(); }
      return;
    }
    const tinta = getComputedStyle(card).getPropertyValue('--cat-tinta').trim() || MP_GRAFICA.tinta1;
    state.charts[id] = new Chart(cv.getContext('2d'), {
      type: 'line',
      data: {
        labels: d.fechas,
        // Dentro de la tarjeta el trazo va en la tinta de la categoría: el
        // verde/rojo de mercado no se lee sobre un fondo de color.
        datasets: [{ data: d.precios, ...MP_GRAFICA.serie(tinta, { borderWidth: 1.75 }) }],
      },
      options: MP_GRAFICA.base({
        plugins: { legend: MP_GRAFICA.leyenda(false), tooltip: MP_GRAFICA.tooltip() },
        scales: {
          x: MP_GRAFICA.ejeTiempo({ ticks: { display: false }, border: { display: false } }),
          y: MP_GRAFICA.ejeValor({
            grid: { color: MP_COLOR.rgba(tinta, 0.14), drawTicks: false, lineWidth: 1 },
            ticks: { color: tinta, font: { family: MP_GRAFICA.mono, size: 11 }, maxTicksLimit: 4, padding: 6 },
          }),
        },
      }),
    });
    // El contenedor ya tiene alto definido en CSS (.mp-tarjeta-grafica), así
    // que Chart.js dibuja en el primer frame: NO hace falta scroll ni resize.
    // (Este era el bug de las gráficas en blanco; no reintroducirlo quitando
    // el alto del contenedor.)
    const mazo = card.closest('.mp-mazo');
    if (mazo) { _posicionar(mazo, true); _reajustarPista(); }
  }

  // ─────────────────────────────────────────────────────────
  //  Interacción: toque, teclado, arrastre y swipe entre mazos
  // ─────────────────────────────────────────────────────────
  function _bindMazo(mazo) {
    const clave = mazo.dataset.mazo;

    mazo.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.mp-chip-ticker');
      if (chip && chip.dataset.ticker) { ev.stopPropagation(); irAAnalizar(chip.dataset.ticker); return; }

      const accion = ev.target.closest('.mp-tarjeta-accion');
      if (accion) {
        ev.stopPropagation();
        if (accion.dataset.url) abrirEnlace(accion.dataset.url);
        else if (accion.dataset.ticker) irAAnalizar(accion.dataset.ticker);
        return;
      }

      if (ev.target.closest('.mp-tarjeta-cerrar')) { _cerrarTodas(mazo); return; }

      const cara = ev.target.closest('.mp-tarjeta-cara');
      if (!cara) return;
      if (cara.dataset.arrastre === '1') { delete cara.dataset.arrastre; return; }
      const card = cara.closest('.mp-tarjeta');
      const i = +card.dataset.i;
      _abrir(mazo, state.abierta[clave] === i ? null : i);
    });

    // Teclado: Enter/Espacio los da el <button>; Escape cierra.
    mazo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.abierta[clave] != null) {
        ev.stopPropagation();
        const abierta = mazo.querySelector('.mp-tarjeta.abierta .mp-tarjeta-cara');
        _cerrarTodas(mazo);
        if (abierta) abierta.focus();
      }
    });

    // Arrastrar hacia abajo para cerrar. Solo transform mientras dura.
    let y0 = null, card = null;
    mazo.addEventListener('pointerdown', (ev) => {
      const c = ev.target.closest('.mp-tarjeta.abierta');
      if (!c || ev.target.closest('.mp-tarjeta-accion, .mp-chip-ticker')) return;
      y0 = ev.clientY; card = c;
    });
    mazo.addEventListener('pointermove', (ev) => {
      if (y0 == null || !card) return;
      const dy = ev.clientY - y0;
      if (dy <= 0) return;                      // solo hacia abajo
      card.classList.add('arrastrando');
      const base = state.abierta[clave] * _medidas(mazo).mini;
      card.style.transform = `translateY(${base + dy}px)`;
      if (dy > 6) {
        const cara = card.querySelector('.mp-tarjeta-cara');
        if (cara) cara.dataset.arrastre = '1';  // no lo tomes como toque
      }
    });
    const soltar = (ev) => {
      if (y0 == null || !card) return;
      const dy = (ev.clientY || 0) - y0;
      card.classList.remove('arrastrando');
      // La marca `arrastre` existe para que el `click` que el navegador dispara
      // DESPUÉS de un arrastre no se tome como un toque. Pero si tras el
      // arrastre no llega ningún click (arrastre cancelado, gesto que se fue a
      // scroll), la marca se quedaba pegada y se comía el SIGUIENTE toque de
      // verdad: había que tocar dos veces para reabrir la tarjeta. Se limpia
      // por tiempo, pasada la ventana en la que podría llegar ese click.
      const cara = card.querySelector('.mp-tarjeta-cara');
      if (cara) setTimeout(() => { delete cara.dataset.arrastre; }, 350);
      if (dy > 60) _cerrarTodas(mazo); else _posicionar(mazo, true);
      y0 = null; card = null;
    };
    mazo.addEventListener('pointerup', soltar);
    mazo.addEventListener('pointercancel', soltar);
  }

  /* Marca en qué punto del recorrido va un carrusel horizontal para que el CSS
     desvanezca el borde por el que aún queda contenido. Sin esto la fila de
     mazos y la cintilla de mercados se ven CORTADAS a media palabra en iPhone
     —parece un error de maquetación, no un carrusel— y nadie descubre que se
     pueden deslizar. */
  function _bordesDeScroll(el) {
    if (!el) return;
    const marcar = () => {
      const sobra = el.scrollWidth - el.clientWidth;
      if (sobra <= 4) { el.dataset.borde = 'no'; return; }
      const x = el.scrollLeft;
      el.dataset.borde = x <= 2 ? 'ini' : x >= sobra - 2 ? 'fin' : 'medio';
    };
    let raf = null;
    el.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; marcar(); });
    }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(marcar).observe(el);
    marcar();
  }
  window.MP_bordesDeScroll = _bordesDeScroll;

  /* Selector de ventana. Va en la cabecera, no dentro de cada mazo: es UNA
     pregunta ("¿de qué periodo hablamos?") y repetir el control en tres sitios
     invita a que digan cosas distintas a la vez. */
  function _periodoHTML() {
    return PERIODOS.map(p => `
      <button type="button" class="mp-periodo${state.periodo === p.clave ? ' activa' : ''}"
              data-periodo="${p.clave}" aria-pressed="${state.periodo === p.clave}">${p.etq}</button>`).join('');
  }

  /* Un solo manejador delegado en la pista: los selectores se destruyen y se
     vuelven a crear con cada recarga de mazo, así que enganchar cada botón
     dejaría oyentes muertos y botones sin oyente. */
  function _bindPeriodo() {
    const pista = $('mazos-pista');
    if (!pista || pista.dataset.periodoListo === '1') return;
    pista.dataset.periodoListo = '1';
    pista.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-periodo]');
      if (!b || b.dataset.periodo === state.periodo) return;
      state.periodo = b.dataset.periodo;
      try { localStorage.setItem(LS_PERIODO, state.periodo); } catch (_) {}
      // Los dos selectores tienen que decir lo mismo: es un solo estado.
      pista.querySelectorAll('[data-periodos]').forEach(c => { c.innerHTML = _periodoHTML(); });
      await Promise.all(MAZOS_CON_PERIODO.map(recargarMazo));
    });
  }

  function _bindPista() {
    const pista = $('mazos-pista');
    const ind = $('mazos-ind');
    if (!pista || !ind) return;
    _bordesDeScroll(ind);

    const sincronizar = () => {
      const panes = [...pista.querySelectorAll('.mp-mazo-pane')];
      if (!panes.length) return;
      // El mazo activo es aquel cuyo borde izquierdo está más cerca del
      // borde izquierdo de la pista (funciona igual con uno o con tres panes
      // visibles a la vez en iPad).
      let mejor = 0, mejorD = Infinity;
      const x0 = pista.getBoundingClientRect().left;
      panes.forEach((p, i) => {
        const d = Math.abs(p.getBoundingClientRect().left - x0);
        if (d < mejorD) { mejorD = d; mejor = i; }
      });
      if (mejor === state.activo) return;
      state.activo = mejor;
      const botones = [...ind.querySelectorAll('button')];
      botones.forEach((b, i) => b.setAttribute('aria-selected', String(i === mejor)));
      // Si el mazo activo queda fuera de la fila de píldoras, el usuario pierde
      // la referencia de dónde está. La píldora sigue al mazo.
      const act = botones[mejor];
      if (act && act.scrollIntoView) {
        act.scrollIntoView({ inline: 'nearest', block: 'nearest',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    };
    let raf = null;
    pista.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; sincronizar(); });
    }, { passive: true });

    ind.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-ir]');
      if (!b) return;
      irAMazo(+b.dataset.ir);
    });
    ind.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const n = MAZOS.length;
      const destino = (state.activo + (ev.key === 'ArrowRight' ? 1 : -1) + n) % n;
      irAMazo(destino);
      const btn = ind.querySelector(`button[data-ir="${destino}"]`);
      if (btn) btn.focus();
    });
  }

  function irAMazo(i) {
    const pista = $('mazos-pista');
    const pane = pista && pista.querySelectorAll('.mp-mazo-pane')[i];
    if (!pane) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Delta medido, no offsetLeft: pane y pista pueden tener offsetParent
    // distinto y la resta daría un salto al mazo equivocado.
    const dx = pane.getBoundingClientRect().left - pista.getBoundingClientRect().left;
    pista.scrollTo({ left: pista.scrollLeft + dx, behavior: reduce ? 'auto' : 'smooth' });
  }

  // Cerrar al tocar fuera de cualquier tarjeta abierta.
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('.mp-tarjeta')) return;
    document.querySelectorAll('.mp-mazo').forEach(mazo => {
      if (state.abierta[mazo.dataset.mazo] != null) _cerrarTodas(mazo);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Carga
  // ─────────────────────────────────────────────────────────
  function _esqueleto() {
    const pista = $('mazos-pista');
    if (!pista || pista.children.length) return;
    pista.innerHTML = MAZOS.map(m => `
      <section class="mp-mazo-pane" id="mazo-pane-${m.clave}" role="tabpanel"
               aria-labelledby="mazo-tab-${m.clave}" tabindex="0">
        <h3 class="mp-mazo-titulo">${escapeHtml(m.titulo)}</h3>
        <div class="mp-mazo" style="height:400px">
          ${[0, 1, 2, 3].map(i => `<div class="skeleton" style="position:absolute;left:0;right:0;height:120px;border-radius:14px;transform:translateY(${i * 68}px)"></div>`).join('')}
        </div>
      </section>`).join('');
    pista.style.height = '470px';
  }

  async function cargar(forzar = false) {
    const pista = $('mazos-pista');
    const ind = $('mazos-ind');
    if (!pista) return;
    if (state.cargadoUnaVez && !forzar) { _reajustarPista(); return; }

    if (ind && !ind.children.length) ind.innerHTML = _indicadorHTML();
    const ley = $('mazos-leyenda');
    if (ley && !ley.children.length) ley.innerHTML = _leyendaHTML();
    _esqueleto();
    _bindPista();
    _bindPeriodo();

    if (forzar) {
      // Refresco manual: pide al servidor rearmar la edición del día.
      const r = await safeJson(s => fetch('/api/periodico/refrescar', { method: 'POST', signal: s }));
      if (r && r.throttled && r.error && window.toast) window.toast(r.error, 'info');
    }

    const mercados = await safeJson(s => fetch('/api/periodico/mercados', { signal: s }));
    // MISMO ORDEN que MAZOS: los resultados se asignan por índice más abajo.
    const resultados = await Promise.all([
      mazoNoticias().catch(e => ({ error: String(e && e.message || e), tarjetas: [] })),
      mazoAccion().catch(e => ({ error: String(e && e.message || e), tarjetas: [] })),
      mazoIndices(mercados).catch(e => ({ error: String(e && e.message || e), tarjetas: [] })),
      mazoSector(mercados).catch(e => ({ error: String(e && e.message || e), tarjetas: [] })),
      mazoWatchlist().catch(e => ({ error: String(e && e.message || e), tarjetas: [] })),
    ]);

    // Soltar las gráficas del render anterior antes de tirar el DOM.
    Object.values(state.charts).forEach(c => { try { c && c.destroy && c.destroy(); } catch (_) {} });
    state.charts = {};
    state.abierta = {};
    MAZOS.forEach((m, i) => { state.datos[m.clave] = resultados[i].tarjetas || []; });

    pista.innerHTML = MAZOS.map((m, i) => _paneHTML(m, resultados[i])).join('');
    pista.querySelectorAll('.mp-mazo').forEach(mazo => {
      _posicionar(mazo, false);
      _bindMazo(mazo);
      _reajustarAlAsentar(mazo);
    });
    pista.querySelectorAll('.mazo-reintentar').forEach(b =>
      b.addEventListener('click', () => cargar(true)));
    _reajustarPista();

    // Aviso global solo si TODOS los mazos fallaron: un mazo caído no debe
    // gritar que la sección entera está rota.
    const aviso = $('mazos-aviso');
    if (aviso) {
      const vivos = resultados.filter(r => (r.tarjetas || []).length).length;
      if (!vivos) {
        aviso.textContent = 'No pude cargar el Periódico. Revisa tu conexión y toca Actualizar.';
        aviso.classList.remove('hidden');
      } else {
        aviso.classList.add('hidden');
      }
    }

    const hora = $('periodico-hora');
    if (hora) {
      const ed = resultados[0].edicion;
      // Una línea, en lenguaje normal. Antes eran dos renglones de
      // versalitas explicando el mecanismo de caché: eso es documentación,
      // no interfaz.
      hora.textContent = ed
        ? _fechaLarga(ed)
        : `Actualizado a las ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
    }
    state.cargadoUnaVez = true;
    iniciarPollingLive();
  }

  /* Vuelve a armar UN mazo sin recargar el Periódico entero.
     Hace falta porque cargar() sale temprano cuando ya cargó una vez: al
     agregar una emisora desde "Tus listas" el toast prometía tarjeta en el
     Periódico y la tarjeta no aparecía hasta recargar la página. Rehacer los
     cinco mazos por esto sería tirar diez peticiones —y una de refresco de
     edición— para repintar una sola columna. */
  async function recargarMazo(clave) {
    if (!state.cargadoUnaVez) return;          // la carga inicial ya lo traerá
    const i = MAZOS.findIndex(m => m.clave === clave);
    const pista = $('mazos-pista');
    if (i < 0 || !pista) return;
    const viejo = pista.children[i];
    if (!viejo) return;

    const constructores = {
      watchlist: mazoWatchlist,
      accion:    mazoAccion,
      // El sector necesita el payload de mercados; al recargar se pide de nuevo
      // porque el de la carga inicial puede tener minutos encima.
      sector:    async () => mazoSector(await safeJson(s => fetch('/api/periodico/mercados', { signal: s }))),
    };
    const constructor = constructores[clave];
    if (!constructor) return;
    // Mientras llega, el mazo se marca como ocupado: cambiar de ventana y ver
    // los números viejos sin ninguna señal parece que el botón no hizo nada.
    viejo.classList.add('cargando');
    const res = await constructor().catch(e => ({ error: String(e && e.message || e), tarjetas: [] }));

    // Las gráficas del pane viejo se sueltan ANTES de tirar su DOM: si no,
    // quedan instancias de Chart.js apuntando a canvas que ya no existen.
    viejo.querySelectorAll('canvas[id]').forEach(c => {
      const ch = state.charts[c.id];
      try { ch && ch.destroy && ch.destroy(); } catch (_) {}
      delete state.charts[c.id];
    });
    delete state.abierta[clave];
    state.datos[clave] = res.tarjetas || [];

    viejo.outerHTML = _paneHTML(MAZOS[i], res);
    const nuevo = pista.children[i];
    nuevo.querySelectorAll('.mp-mazo').forEach(mazo => {
      _posicionar(mazo, false);
      _bindMazo(mazo);
      _reajustarAlAsentar(mazo);
    });
    nuevo.querySelectorAll('.mazo-reintentar').forEach(b =>
      b.addEventListener('click', () => cargar(true)));
    _reajustarPista();
  }

  /* La watchlist se edita desde Analizar, en otra pantalla. Cuando cambia, su
     mazo se rehace para que al volver al Periódico ya esté. */
  document.addEventListener('mp:watchlist', () => { recargarMazo('watchlist'); });

  /* Publica el alto real de la barra superior para que el indicador de mazos
     pueda quedarse pegado justo debajo. Se recalcula ante cualquier cosa que
     cambie ese alto: rotación, banner de demo, o el modo nativo que esconde la
     sub-nav. */
  function _medirTopbar() {
    const tb = $('mp-topbar');
    if (!tb) return;
    const h = Math.round(tb.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--mp-topbar-h', h + 'px');
  }

  function bind() {
    const btn = $('periodico-refrescar');
    if (btn) btn.addEventListener('click', async () => {
      btn.classList.add('girando');
      btn.disabled = true;
      try { await cargar(true); } finally {
        btn.disabled = false;
        setTimeout(() => btn.classList.remove('girando'), 700);
      }
    });
    _medirTopbar();
    window.addEventListener('resize', _medirTopbar);
    window.addEventListener('orientationchange', () => setTimeout(_medirTopbar, 260));
    // La barra nativa esconde la sub-nav después de arrancar: hay que remedir.
    setTimeout(_medirTopbar, 600);
    setTimeout(_medirTopbar, 2000);
    window.addEventListener('resize', () => {
      document.querySelectorAll('.mp-mazo').forEach(m => _posicionar(m, false));
      _reajustarPista();
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        document.querySelectorAll('.mp-mazo').forEach(m => _posicionar(m, false));
        _reajustarPista();
      }, 260);
    });
  }

  // ─────────────────────────────────────────────────────────
  //  Polling de precios en vivo (se conserva del diseño anterior)
  // ─────────────────────────────────────────────────────────
  let _pollingActive = false;
  let _pollingInterval = null;

  function _tickersVisibles() {
    const set = new Set();
    Object.values(state.datos).forEach(lista => (lista || []).forEach(t => {
      (t.tickers || []).forEach(x => { if (x && !x.startsWith('^')) set.add(x.toUpperCase()); });
    }));
    return Array.from(set).slice(0, 25);
  }

  async function _pollPrecios() {
    if (document.hidden) return;
    const vista = $('vista-periodico');
    if (!vista || vista.classList.contains('hidden')) return;
    const tickers = _tickersVisibles();
    if (!tickers.length) return;
    const d = await safeJson(s => fetch(`/api/precios-live?tickers=${tickers.join(',')}`, { signal: s }));
    if (!d || !d.ok || !d.precios) return;
    const hora = $('periodico-hora');
    if (hora) {
      const base = hora.textContent.split(' · ')[0];
      hora.textContent = `${base} · ${d.mercados_abiertos ? 'mercados abiertos' : 'mercados cerrados'}`;
    }
  }

  function iniciarPollingLive(inmediato = false) {
    if (_pollingActive) { if (inmediato) _pollPrecios(); return; }
    _pollingActive = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _pollPrecios(); });
    const tick = () => {
      _pollPrecios();
      const h = new Date();
      const habil = h.getDay() >= 1 && h.getDay() <= 5 && h.getHours() >= 8 && h.getHours() <= 16;
      _pollingInterval = setTimeout(tick, habil ? 60_000 : 180_000);
    };
    if (inmediato) tick(); else _pollingInterval = setTimeout(tick, 60_000);
  }

  return { cargar, bind, irAMazo, recargarMazo };
})();


// --- REBALANCEO -------------------------------------------------------------
const Rebalanceo = (() => {
  const state = {
    precios: {},           // {ticker: precio}
    posiciones: {},        // {ticker: shares} — editable por el usuario
    cargando: false,
    cargadoUnaVez: false,
    umbralPp: 2.0,
    monto_extra: 0,
    solo_comprar: false,
  };

  function tickersYPesosGuardados() {
    const tickers = leerPortafolioGuardado() || [];
    const pesosDict = leerPesosGuardados() || {};
    // Fallback: si no hay pesos guardados, repartir parejo
    if (!Object.keys(pesosDict).length && tickers.length) {
      const parejo = 1 / tickers.length;
      tickers.forEach(t => pesosDict[t] = parejo);
    }
    return { tickers, pesos: pesosDict };
  }

  function renderSinPortafolio() {
    const sin = $('reb-sin-portafolio');
    const cont = $('reb-contenido');
    if (sin) sin.classList.remove('hidden');
    if (cont) cont.classList.add('hidden');
  }

  function renderConPortafolio() {
    const sin = $('reb-sin-portafolio');
    const cont = $('reb-contenido');
    if (sin) sin.classList.add('hidden');
    if (cont) cont.classList.remove('hidden');
  }

  function renderTablaPosiciones() {
    const tbody = $('reb-posiciones-tabla');
    if (!tbody) return;
    const { tickers, pesos } = tickersYPesosGuardados();

    if (!tickers.length) {
      tbody.innerHTML = `
        <tr><td colspan="5" class="text-xs text-zinc-500 text-center py-6">
          No hay tickers guardados.
        </td></tr>`;
      return;
    }

    tbody.innerHTML = tickers.map(t => {
      const precio = state.precios[t];
      const shares = state.posiciones[t] ?? 0;
      const valor = precio != null ? shares * precio : null;
      const peso = pesos[t] != null ? (pesos[t] * 100) : 0;
      const precioStr = precio != null
        ? `$${precio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '<span class="text-zinc-600">—</span>';
      const valorStr = valor != null
        ? `$${valor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '<span class="text-zinc-600">—</span>';
      return `
        <tr class="border-b border-surface-border last:border-0">
          <td class="py-2 pr-3">
            <span class="text-sm font-medium text-zinc-100">${escapeHtml(t)}</span>
          </td>
          <td class="py-2 pr-3 text-xs text-zinc-400 tabular">${peso.toFixed(1)}%</td>
          <td class="py-2 pr-3 text-xs tabular text-zinc-300">${precioStr}</td>
          <td class="py-2 pr-3">
            <input type="number" min="0" step="1"
                   data-ticker="${escapeHtml(t)}"
                   value="${shares}"
                   class="reb-shares-input w-24 px-2 py-1 text-xs bg-zinc-900 border border-surface-border rounded text-zinc-100 tabular focus:outline-none focus:border-accent-amber">
          </td>
          <td class="py-2 text-xs tabular text-zinc-400">${valorStr}</td>
        </tr>`;
    }).join('');

    // bindings para editar shares
    tbody.querySelectorAll('.reb-shares-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const t = e.target.dataset.ticker;
        const v = parseFloat(e.target.value);
        state.posiciones[t] = isNaN(v) ? 0 : Math.max(0, v);
        actualizarValorTotal();
      });
    });

    actualizarValorTotal();
  }

  function actualizarValorTotal() {
    const el = $('reb-valor-total');
    if (!el) return;
    const { tickers } = tickersYPesosGuardados();
    let total = 0;
    let completos = 0;
    tickers.forEach(t => {
      const p = state.precios[t];
      const s = state.posiciones[t] || 0;
      if (p != null) {
        total += p * s;
        completos++;
      }
    });
    if (!tickers.length) {
      el.textContent = '—';
      return;
    }
    const str = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    el.innerHTML = `
      <span class="tabular">${str}</span>
      <span class="text-[10px] text-zinc-500 ml-1">(${completos}/${tickers.length} precios)</span>
    `;
  }

  async function refrescarPrecios() {
    const { tickers } = tickersYPesosGuardados();
    if (!tickers.length) return;

    const btn = $('reb-refrescar-precios');
    if (btn) { btn.disabled = true; btn.textContent = 'Actualizando…'; }

    try {
      const res = await fetch('/api/precios-actuales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const data = await res.json();
      if (data && data.precios) {
        Object.entries(data.precios).forEach(([t, obj]) => {
          if (obj && obj.precio != null) state.precios[t] = obj.precio;
        });
      }
    } catch (e) {
      console.warn('reb precios error', e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar precios'; }
      renderTablaPosiciones();
    }
  }

  function renderResultado(data) {
    const cont = $('reb-resultado');
    const err  = $('reb-error');
    const cards = $('reb-resumen-cards');
    const tbody = $('reb-tabla-body');
    const notas = $('reb-notas');
    if (!cont) return;

    if (data && data.error) {
      if (err) {
        err.textContent = data.error;
        err.classList.remove('hidden');
      }
      cont.classList.add('hidden');
      return;
    }
    if (err) { err.textContent = ''; err.classList.add('hidden'); }
    cont.classList.remove('hidden');

    const r = data.resumen || {};
    const plan = data.plan || [];

    // Tarjetas de resumen
    if (cards) {
      const cardsHTML = [
        {
          etq: 'Valor actual',
          val: `$${(r.valor_actual || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          sub: r.monto_extra > 0 ? `+ $${r.monto_extra.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} extra` : '',
        },
        {
          etq: 'Comprar',
          val: `$${(r.total_a_comprar || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          sub: '',
          color: 'text-accent-green',
        },
        {
          etq: 'Vender',
          val: `$${(r.total_a_vender || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          sub: r.modo === 'solo_comprar' ? 'modo solo-comprar' : '',
          color: 'text-accent-red',
        },
        {
          etq: 'Operaciones',
          val: `${r.num_trades || 0}`,
          sub: `drift prom. ${(r.drift_promedio_pp || 0).toFixed(2)} pp`,
        },
      ];
      cards.innerHTML = cardsHTML.map(c => `
        <div class="bg-surface-card border border-surface-border rounded-lg p-3">
          <p class="text-[10px] uppercase tracking-wider text-zinc-500">${c.etq}</p>
          <p class="text-lg font-semibold tabular mt-1 ${c.color || 'text-zinc-100'}">${c.val}</p>
          ${c.sub ? `<p class="text-[10px] text-zinc-500 mt-0.5">${escapeHtml(c.sub)}</p>` : ''}
        </div>
      `).join('');
    }

    // Tabla de plan
    if (tbody) {
      if (!plan.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-xs text-zinc-500 text-center py-4">Sin plan.</td></tr>`;
      } else {
        tbody.innerHTML = plan.map(p => {
          const accColor = p.accion === 'comprar' ? 'text-accent-green'
                         : p.accion === 'vender'  ? 'text-accent-red'
                         : 'text-zinc-400';
          const accBg    = p.accion === 'comprar' ? 'bg-accent-green/10 border-accent-green/20'
                         : p.accion === 'vender'  ? 'bg-accent-red/10 border-accent-red/20'
                         : 'bg-zinc-800 border-zinc-700';
          const driftColor = p.drift_pp > 0 ? 'text-accent-amber' : p.drift_pp < 0 ? 'text-accent-blue' : 'text-zinc-400';
          const signoDrift = p.drift_pp > 0 ? '+' : '';
          const cambioStr = p.shares_cambio === 0 ? '—' :
            (p.shares_cambio > 0 ? `+${p.shares_cambio}` : `${p.shares_cambio}`);
          const montoStr = p.monto_cambio === 0 ? '—' :
            `$${Math.abs(p.monto_cambio).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const precioStr = `$${p.precio_actual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const razonTooltip = p.razon ? ` title="${escapeHtml(p.razon)}"` : '';
          return `
            <tr class="border-b border-surface-border last:border-0"${razonTooltip}>
              <td class="py-2 px-2">
                <span class="text-sm font-medium text-zinc-100">${escapeHtml(p.ticker)}</span>
              </td>
              <td class="py-2 px-2 text-right tabular text-zinc-300">${p.peso_target_pct.toFixed(1)}%</td>
              <td class="py-2 px-2 text-right tabular text-zinc-400">${p.peso_actual_pct.toFixed(1)}%</td>
              <td class="py-2 px-2 text-right tabular ${driftColor}">${signoDrift}${p.drift_pp.toFixed(2)} pp</td>
              <td class="py-2 px-2 text-right tabular text-zinc-300">${precioStr}</td>
              <td class="py-2 px-2 text-right">
                <span class="inline-block text-[10px] font-semibold px-2 py-0.5 rounded border ${accBg} ${accColor} uppercase tracking-wide">
                  ${p.accion}
                </span>
                <span class="text-xs tabular text-zinc-300 ml-2">${cambioStr}</span>
              </td>
              <td class="py-2 px-2 text-right tabular text-zinc-300">${montoStr}</td>
            </tr>`;
        }).join('');
      }
    }

    // Notas finales (frecuencia + impuestos + cash remanente)
    if (notas) {
      const items = [];
      if (r.sugerencia_frecuencia) {
        items.push(`
          <div class="flex items-start gap-2 bg-surface-card border border-surface-border rounded-lg p-3">
            <span class="text-accent-blue mt-0.5">◆</span>
            <div class="text-xs text-zinc-300 leading-relaxed">${escapeHtml(r.sugerencia_frecuencia)}</div>
          </div>
        `);
      }
      if (r.cash_remanente > 0) {
        items.push(`
          <div class="flex items-start gap-2 bg-surface-card border border-surface-border rounded-lg p-3">
            <span class="text-accent-green mt-0.5">◆</span>
            <div class="text-xs text-zinc-300 leading-relaxed">
              Sobrarían <span class="tabular text-zinc-100">$${r.cash_remanente.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> sin asignar
              (no alcanza para una acción entera adicional al target).
            </div>
          </div>
        `);
      }
      if (r.aviso_impuestos) {
        items.push(`
          <div class="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
            <span class="text-accent-amber mt-0.5">⚠</span>
            <div class="text-xs text-zinc-300 leading-relaxed">${escapeHtml(r.aviso_impuestos)}</div>
          </div>
        `);
      }
      notas.innerHTML = items.join('');
    }
  }

  async function calcular() {
    const { tickers, pesos } = tickersYPesosGuardados();
    if (!tickers.length) return;

    const btn = $('reb-calcular');
    const err = $('reb-error');
    if (err) { err.textContent = ''; err.classList.add('hidden'); }
    if (btn) { btn.disabled = true; btn.textContent = 'Calculando…'; }

    const monto = parseFloat($('reb-monto-extra')?.value || '0') || 0;
    const umbral = parseFloat($('reb-umbral')?.value || '2') || 2;
    const modo = document.querySelector('input[name="reb-modo"]:checked')?.value || 'comprar_y_vender';
    const solo_comprar = modo === 'solo_comprar';

    try {
      const res = await fetch('/api/rebalanceo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posiciones: state.posiciones,
          target_pesos: pesos,
          monto_extra: monto,
          solo_comprar,
          umbral_pp: umbral,
        }),
      });
      const data = await res.json();
      renderResultado(data);
    } catch (e) {
      if (err) {
        err.textContent = `Error: ${e.message || e}`;
        err.classList.remove('hidden');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Calcular rebalanceo'; }
    }
  }

  async function cargar(force = false) {
    if (state.cargando) return;
    state.cargando = true;

    const { tickers, pesos } = tickersYPesosGuardados();

    if (!tickers.length || tickers.length < 2) {
      renderSinPortafolio();
      state.cargando = false;
      return;
    }

    renderConPortafolio();

    // Inicializar posiciones en 0 para tickers nuevos (conservar las que ya editó)
    tickers.forEach(t => {
      if (state.posiciones[t] === undefined) state.posiciones[t] = 0;
    });

    // Render inicial (aunque sin precios)
    renderTablaPosiciones();

    // Primera carga o force: bajar precios
    if (!state.cargadoUnaVez || force) {
      await refrescarPrecios();
      state.cargadoUnaVez = true;
    }

    state.cargando = false;
  }

  function bind() {
    // Refrescar precios
    const btnRef = $('reb-refrescar-precios');
    if (btnRef) btnRef.addEventListener('click', () => refrescarPrecios());

    // Sync range ↔ number de umbral
    const range = $('reb-umbral-range');
    const num   = $('reb-umbral');
    if (range && num) {
      range.addEventListener('input', () => { num.value = range.value; });
      num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!isNaN(v)) range.value = Math.max(0, Math.min(10, v));
      });
    }

    // Calcular
    const btnCalc = $('reb-calcular');
    if (btnCalc) btnCalc.addEventListener('click', () => calcular());

    // CTA sin portafolio → ir a Mi portafolio
    const cta = $('reb-ir-portafolio');
    if (cta) {
      cta.addEventListener('click', () => {
        const tabPort = document.querySelector('.nav-tab[data-vista="portafolio"]');
        if (tabPort) tabPort.click();
      });
    }
  }

  return { cargar, bind };
})();


// --- TRANSACCIONES (tracking real) -----------------------------------------
const LS_KEY_TX = 'miPortafolio.transacciones.v1';

const Transacciones = (() => {
  const state = {
    lista: [],        // [{id, ticker, tipo, fecha, shares, precio_unitario, moneda, comisiones, notas}]
    snapshot: null,   // resultado del backend
    cargando: false,
  };

  // ---------- persistencia ----------
  function leer() {
    try {
      const raw = localStorage.getItem(LS_KEY_TX);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function guardar() {
    try { localStorage.setItem(LS_KEY_TX, JSON.stringify(state.lista)); } catch {}
  }
  function nuevoId() {
    return 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- validación y form ----------
  function leerForm() {
    return {
      id:              nuevoId(),
      tipo:            $('tx-form-tipo').value,
      ticker:          ($('tx-form-ticker').value || '').trim().toUpperCase(),
      fecha:           $('tx-form-fecha').value,
      shares:          parseFloat($('tx-form-shares').value),
      precio_unitario: parseFloat($('tx-form-precio').value),
      moneda:          $('tx-form-moneda').value,
      comisiones:      parseFloat($('tx-form-comis').value) || 0,
      notas:           ($('tx-form-notas').value || '').trim(),
    };
  }
  function limpiarForm() {
    $('tx-form-ticker').value = '';
    $('tx-form-shares').value = '';
    $('tx-form-precio').value = '';
    $('tx-form-comis').value = '';
    $('tx-form-notas').value = '';
    // Mantener fecha, tipo y moneda para agilizar captura en lote
  }
  function mostrarError(msg) {
    const el = $('tx-form-error');
    if (!el) return;
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else     { el.textContent = ''; el.classList.add('hidden'); }
  }
  function validar(tx) {
    if (!tx.ticker) return 'Falta el ticker';
    if (!['compra', 'venta'].includes(tx.tipo)) return 'Tipo inválido';
    if (!tx.fecha) return 'Falta la fecha';
    if (!(tx.shares > 0)) return 'Shares debe ser mayor a 0';
    if (!(tx.precio_unitario > 0)) return 'Precio debe ser mayor a 0';
    if (tx.comisiones < 0) return 'Comisiones no puede ser negativo';
    return null;
  }

  // ---------- render ----------
  function fmtMoney(v, conSigno = false) {
    if (v === null || v === undefined) return '—';
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const signo = conSigno ? (v > 0 ? '+' : v < 0 ? '−' : '') : (v < 0 ? '−' : '');
    return `${signo}$${abs}`;
  }
  function colorPnl(v) {
    if (v === null || v === undefined || v === 0) return 'text-zinc-300';
    return v > 0 ? 'text-accent-green' : 'text-accent-red';
  }

  function renderKPIs(t) {
    if (!t) {
      $('tx-kpi-invertido').textContent = '—';
      $('tx-kpi-valor').textContent = '—';
      $('tx-kpi-pnl').textContent = '—';
      $('tx-kpi-pnl').className = 'text-2xl font-semibold tabular mt-1 text-zinc-300';
      $('tx-kpi-roi').textContent = '—';
      $('tx-kpi-roi').className = 'text-2xl font-semibold tabular mt-1 text-zinc-300';
      $('tx-kpi-realizada').textContent = '—';
      $('tx-kpi-no-realizada').textContent = '—';
      return;
    }
    $('tx-kpi-invertido').textContent = fmtMoney(t.invertido);
    $('tx-kpi-valor').textContent = fmtMoney(t.valor_actual);

    $('tx-kpi-pnl').textContent = fmtMoney(t.pnl_total, true);
    $('tx-kpi-pnl').className = `text-2xl font-semibold tabular mt-1 ${colorPnl(t.pnl_total)}`;

    const roi = t.roi_pct || 0;
    const roiSigno = roi > 0 ? '+' : '';
    $('tx-kpi-roi').textContent = `${roiSigno}${roi.toFixed(2)}%`;
    $('tx-kpi-roi').className = `text-2xl font-semibold tabular mt-1 ${colorPnl(roi)}`;

    $('tx-kpi-realizada').textContent = fmtMoney(t.pnl_realizado, true);
    $('tx-kpi-realizada').className = `tabular ${colorPnl(t.pnl_realizado)}`;
    $('tx-kpi-no-realizada').textContent = fmtMoney(t.pnl_no_realizado, true);
    $('tx-kpi-no-realizada').className = `tabular ${colorPnl(t.pnl_no_realizado)}`;
  }

  function renderLista() {
    const tbody = $('tx-lista');
    const count = $('tx-lista-count');
    if (!tbody) return;

    if (!state.lista.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-zinc-500 text-xs">
        Aún no has capturado transacciones. Usa el formulario de arriba.
      </td></tr>`;
      if (count) count.textContent = '0';
      return;
    }

    // Copia ordenada por fecha desc (más recientes arriba)
    const ordenada = [...state.lista].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    tbody.innerHTML = ordenada.map(tx => {
      const tipoBadge = tx.tipo === 'compra'
        ? `<span class="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border border-accent-green/30 bg-accent-green/10 text-accent-green uppercase">Compra</span>`
        : `<span class="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border border-accent-red/30 bg-accent-red/10 text-accent-red uppercase">Venta</span>`;
      const total = tx.shares * tx.precio_unitario;
      const prefijo = tx.moneda === 'MXN' ? '$' : '$';
      const sufijo  = tx.moneda === 'MXN' ? ' MXN' : '';
      return `
        <tr class="hover:bg-zinc-900/30 transition">
          <td class="px-4 py-2 tabular text-zinc-400">${escapeHtml(tx.fecha)}</td>
          <td class="px-4 py-2"><span class="font-medium text-zinc-100">${escapeHtml(tx.ticker)}</span></td>
          <td class="px-4 py-2">${tipoBadge}</td>
          <td class="px-4 py-2 text-right tabular text-zinc-300">${tx.shares}</td>
          <td class="px-4 py-2 text-right tabular text-zinc-300">${prefijo}${tx.precio_unitario.toFixed(2)}${sufijo}</td>
          <td class="px-4 py-2 text-right tabular text-zinc-100">${prefijo}${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sufijo}</td>
          <td class="px-4 py-2 text-center">
            <button class="tx-del text-zinc-500 hover:text-accent-red transition text-sm" data-id="${escapeHtml(tx.id)}" title="Eliminar">×</button>
          </td>
        </tr>`;
    }).join('');

    if (count) count.textContent = String(state.lista.length);

    // Bind eliminar
    tbody.querySelectorAll('.tx-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.id;
        eliminar(id);
      });
    });
  }

  function renderPosiciones(snap) {
    const cont = $('tx-posiciones');
    if (!cont) return;

    const por = (snap && snap.por_ticker) || [];
    const activas = por.filter(p => p.activo);

    if (!activas.length) {
      cont.innerHTML = `<div class="text-xs text-zinc-500 py-4 text-center">
        Sin posiciones activas. Captura al menos una compra.
      </div>`;
      return;
    }

    cont.innerHTML = activas.map(p => {
      const pnl = p.pnl_no_realizado;
      const pnlPct = p.pnl_no_realizado_pct;
      const clsPnl = colorPnl(pnl);
      const pnlPctStr = pnlPct !== null && pnlPct !== undefined
        ? `${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—';
      return `
        <div class="border border-surface-border rounded-lg p-3 hover:border-zinc-600 transition">
          <div class="flex items-center justify-between mb-1">
            <span class="font-semibold text-sm text-zinc-100">${escapeHtml(p.ticker)}</span>
            <span class="text-[10px] text-zinc-500 tabular">${p.shares_actuales} sh</span>
          </div>
          <div class="flex items-end justify-between">
            <div>
              <p class="text-[10px] text-zinc-500">Costo avg → Precio</p>
              <p class="text-xs tabular text-zinc-300">
                $${p.costo_promedio.toFixed(2)} → $${(p.precio_actual ?? 0).toFixed(2)}
              </p>
            </div>
            <div class="text-right">
              <p class="text-sm font-semibold tabular ${clsPnl}">${fmtMoney(pnl, true)}</p>
              <p class="text-[10px] tabular ${clsPnl}">${pnlPctStr}</p>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderErrores(errs) {
    const box = $('tx-errores-box');
    const ul  = $('tx-errores');
    if (!box || !ul) return;
    if (!errs || !errs.length) {
      box.classList.add('hidden');
      ul.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    ul.innerHTML = errs.map(e => `<li>${escapeHtml(e.msg || '')}</li>`).join('');
  }

  // ---------- mutaciones ----------
  async function agregar() {
    mostrarError(null);
    const tx = leerForm();
    const err = validar(tx);
    if (err) { mostrarError(err); return; }

    state.lista.push(tx);
    guardar();
    limpiarForm();
    await recalcular();
  }

  async function eliminar(id) {
    state.lista = state.lista.filter(t => t.id !== id);
    guardar();
    await recalcular();
  }

  async function recalcular() {
    if (state.cargando) return;
    state.cargando = true;

    renderLista();

    if (!state.lista.length) {
      state.snapshot = null;
      renderKPIs(null);
      renderPosiciones(null);
      renderErrores([]);
      state.cargando = false;
      return;
    }

    try {
      const res = await fetch('/api/transacciones/calcular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transacciones: state.lista }),
      });
      const data = await res.json();
      if (data.error) {
        mostrarError(data.error);
        state.snapshot = null;
      } else {
        state.snapshot = data;
        renderKPIs(data.totales);
        renderPosiciones(data);
        renderErrores(data.errores);
      }
    } catch (e) {
      mostrarError(`Error al calcular: ${e.message || e}`);
    } finally {
      state.cargando = false;
    }
  }

  // ---------- entry ----------
  async function cargar() {
    state.lista = leer();
    // Fecha default = hoy
    const hoy = new Date().toISOString().slice(0, 10);
    const fechaInp = $('tx-form-fecha');
    if (fechaInp && !fechaInp.value) fechaInp.value = hoy;
    await recalcular();
  }

  function bind() {
    const btnAgregar = $('tx-form-agregar');
    if (btnAgregar) btnAgregar.addEventListener('click', () => agregar());

    const btnRef = $('tx-refrescar');
    if (btnRef) btnRef.addEventListener('click', () => recalcular());

    // Enter en inputs del form dispara agregar
    ['tx-form-ticker','tx-form-shares','tx-form-precio','tx-form-comis','tx-form-notas'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); agregar(); }
      });
    });
  }

  return { cargar, bind };
})();


// ============================================================
//  IMPUESTOS · ISR MX + tax-loss harvesting
// ============================================================
const Impuestos = (() => {
  const state = {
    data: null,      // respuesta del backend
    cargando: false,
  };

  // ---- Helpers formato ---------------------------------------
  function fmtMoney(v, opts = {}) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const { moneda = 'USD', decimales = 2, signo = false } = opts;
    const abs = Math.abs(v);
    const formateado = abs.toLocaleString('en-US', {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    });
    const prefix = signo && v > 0 ? '+' : (v < 0 ? '-' : '');
    const simbolo = moneda === 'MXN' ? 'MX$' : '$';
    return `${prefix}${simbolo}${formateado}`;
  }

  function colorPnl(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return 'text-zinc-400';
    if (v > 0.005)  return 'text-accent-green';
    if (v < -0.005) return 'text-accent-red';
    return 'text-zinc-300';
  }

  function leerTxsGuardadas() {
    try {
      const raw = localStorage.getItem(LS_KEY_TX);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  // ---- Render -----------------------------------------------
  function renderSinDatos() {
    const sin = $('imp-sin-datos');
    const cont = $('imp-contenido');
    if (sin)  sin.classList.remove('hidden');
    if (cont) cont.classList.add('hidden');
  }

  function renderConDatos() {
    const sin = $('imp-sin-datos');
    const cont = $('imp-contenido');
    if (sin)  sin.classList.add('hidden');
    if (cont) cont.classList.remove('hidden');
  }

  function renderKPIs(data) {
    const totales = data.totales || {};
    const harvest = data.harvest || {};

    const anoActual = totales.ano_actual || new Date().getFullYear();
    const ganancia  = totales.ganancia_neta_ano_actual || 0;
    const isr       = totales.isr_estimado_ano_actual || 0;
    const perdidas  = data.perdidas_arrastrables || 0;

    // El backend valora cada oportunidad contra la ganancia COMPLETA del año,
    // sin descontarla conforme avanza: cada cifra responde "si vendes solo
    // esta". Sumarlas cuenta la misma ganancia varias veces y anuncia un
    // ahorro mayor al ISR que se debe, que es imposible. El techo es el propio
    // ISR: no puedes bajar el impuesto por debajo de cero. El excedente de
    // pérdida no se pierde —se arrastra 10 años— pero ese es un beneficio de
    // ejercicios futuros, no del que este KPI reporta.
    const ahorroBruto = (harvest.oportunidades || []).reduce(
      (s, o) => s + (o.ahorro_isr || 0), 0
    );
    const ahorroTotal = Math.min(ahorroBruto, isr);

    const elAno = $('imp-ano-actual');
    if (elAno) elAno.textContent = String(anoActual);

    const elGan = $('imp-kpi-ganancia');
    if (elGan) {
      elGan.textContent = fmtMoney(ganancia, { signo: true });
      elGan.className = `text-2xl font-bold mt-2 tabular ${colorPnl(ganancia)}`;
    }

    const elIsr = $('imp-kpi-isr');
    if (elIsr) {
      elIsr.textContent = fmtMoney(isr);
      elIsr.className = `text-2xl font-bold mt-2 tabular ${isr > 0 ? 'text-accent-amber' : 'text-zinc-400'}`;
    }

    const elPer = $('imp-kpi-perdidas');
    if (elPer) {
      elPer.textContent = perdidas > 0 ? fmtMoney(perdidas) : '—';
      elPer.className = `text-2xl font-bold mt-2 tabular ${perdidas > 0 ? 'text-accent-indigo' : 'text-zinc-400'}`;
    }

    const elAh = $('imp-kpi-ahorro');
    if (elAh) {
      elAh.textContent = ahorroTotal > 0 ? fmtMoney(ahorroTotal) : '—';
      elAh.className = `text-2xl font-bold mt-2 tabular ${ahorroTotal > 0 ? 'text-accent-green' : 'text-zinc-400'}`;
    }
  }

  function renderHarvest(data) {
    const cont = $('imp-harvest-lista');
    if (!cont) return;

    const harvest = data.harvest || {};
    const ops = harvest.oportunidades || [];

    if (!harvest.disponible) {
      cont.innerHTML = `
        <div class="bg-surface-card border border-surface-border rounded-xl p-5 text-center">
          <p class="text-sm text-zinc-400">
            No tienes ganancias realizadas este año, así que todavía no hay nada que "compensar".
          </p>
          <p class="text-[11px] text-zinc-600 mt-2">Cuando vendas con ganancia, las oportunidades aparecerán aquí.</p>
        </div>`;
      return;
    }

    if (!ops.length) {
      cont.innerHTML = `
        <div class="bg-surface-card border border-surface-border rounded-xl p-5 text-center">
          <p class="text-sm text-zinc-400">
            Ninguna de tus posiciones activas está en pérdida. <span class="text-accent-green">Buenas noticias.</span>
          </p>
        </div>`;
      return;
    }

    cont.innerHTML = ops.map((o, i) => `
      <div class="bg-surface-card border border-accent-green/20 rounded-xl p-5 fade-up" style="animation-delay: ${0.05 + i * 0.04}s">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex-1 min-w-[180px]">
            <div class="flex items-center gap-2">
              <span class="font-mono text-base font-bold text-zinc-100">${escapeHtml(o.ticker)}</span>
              <span class="text-[10px] uppercase tracking-wider bg-accent-red/10 text-accent-red border border-accent-red/20 rounded-full px-2 py-0.5 font-semibold">
                Pérdida latente
              </span>
            </div>
            <p class="text-xs text-zinc-400 mt-2 leading-relaxed">${escapeHtml(o.accion_sugerida || '')}</p>
          </div>

          <div class="grid grid-cols-3 gap-4 text-right">
            <div>
              <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Pérdida</p>
              <p class="text-sm font-semibold tabular text-accent-red mt-1">-${fmtMoney(o.perdida_latente_abs).replace('-', '')}</p>
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Compensa</p>
              <p class="text-sm font-semibold tabular text-zinc-100 mt-1">${fmtMoney(o.compensa)}</p>
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Ahorro ISR</p>
              <p class="text-sm font-bold tabular text-accent-green mt-1">${fmtMoney(o.ahorro_isr)}</p>
            </div>
          </div>
        </div>

        <div class="mt-4 pt-4 border-t border-surface-border grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] text-zinc-500">
          <div>Shares: <span class="text-zinc-300 tabular">${(o.shares || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span></div>
          <div>Costo promedio: <span class="text-zinc-300 tabular">${fmtMoney(o.costo_promedio)}</span></div>
          <div>Precio actual: <span class="text-zinc-300 tabular">${fmtMoney(o.precio_actual)}</span></div>
          <div>Caída: <span class="text-accent-red tabular">${o.caida_pct != null ? o.caida_pct.toFixed(2) + '%' : '—'}</span></div>
        </div>
      </div>
    `).join('');
  }

  function renderPorAno(data) {
    const cont = $('imp-anos');
    if (!cont) return;

    const anos = (data.por_ano || []).slice().sort((a, b) => b.ano - a.ano);

    if (!anos.length) {
      cont.innerHTML = `
        <div class="bg-surface-card border border-surface-border rounded-xl p-5 text-center">
          <p class="text-sm text-zinc-400">Aún no has vendido nada, así que no hay historia fiscal.</p>
        </div>`;
      return;
    }

    cont.innerHTML = anos.map((a, i) => {
      const bruto      = a.ganancia_bruta || 0;
      const usada      = a.perdida_arrastre_usada || 0;
      const neto       = a.ganancia_neta_final || 0;
      const isr        = a.isr_estimado || 0;
      const numVentas  = a.num_ventas || 0;
      const colorNeto  = colorPnl(neto);

      return `
        <details class="group bg-surface-card border border-surface-border rounded-xl overflow-hidden fade-up" style="animation-delay: ${0.05 + i * 0.04}s" ${i === 0 ? 'open' : ''}>
          <summary class="cursor-pointer select-none px-5 py-4 flex items-center justify-between hover:bg-surface-hover transition">
            <div class="flex items-center gap-4">
              <span class="text-lg font-bold text-zinc-100">${a.ano}</span>
              <span class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                ${numVentas} venta${numVentas === 1 ? '' : 's'}
              </span>
              ${usada > 0 ? `<span class="text-[10px] uppercase tracking-wider bg-accent-indigo/10 text-accent-indigo border border-accent-indigo/20 rounded-full px-2 py-0.5 font-semibold">Usó arrastre</span>` : ''}
            </div>
            <div class="flex items-center gap-6 text-right">
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Neto</p>
                <p class="text-sm font-semibold tabular ${colorNeto}">${fmtMoney(neto, { signo: true })}</p>
              </div>
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">ISR</p>
                <p class="text-sm font-semibold tabular ${isr > 0 ? 'text-accent-amber' : 'text-zinc-500'}">${fmtMoney(isr)}</p>
              </div>
              <span class="text-zinc-500 group-open:rotate-180 transition">▾</span>
            </div>
          </summary>

          <div class="px-5 pb-5 border-t border-surface-border">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3 py-4 text-xs">
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Ganancia bruta</p>
                <p class="text-sm font-semibold tabular mt-1 ${colorPnl(bruto)}">${fmtMoney(bruto, { signo: true })}</p>
              </div>
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Pérdida arrastre usada</p>
                <p class="text-sm font-semibold tabular mt-1 ${usada > 0 ? 'text-accent-indigo' : 'text-zinc-400'}">${usada > 0 ? '-' + fmtMoney(usada).replace(/^[+\-]?/, '') : '—'}</p>
              </div>
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Base gravable</p>
                <p class="text-sm font-semibold tabular mt-1 ${colorPnl(neto)}">${fmtMoney(neto)}</p>
              </div>
              <div>
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">ISR (10%)</p>
                <p class="text-sm font-semibold tabular mt-1 ${isr > 0 ? 'text-accent-amber' : 'text-zinc-400'}">${fmtMoney(isr)}</p>
              </div>
            </div>

            ${(a.eventos && a.eventos.length) ? `
              <div class="mt-2">
                <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Ventas del año</p>
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead>
                      <tr class="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-surface-border">
                        <th class="text-left py-2 font-semibold">Fecha</th>
                        <th class="text-left py-2 font-semibold">Ticker</th>
                        <th class="text-right py-2 font-semibold">Shares</th>
                        <th class="text-right py-2 font-semibold">Precio venta</th>
                        <th class="text-right py-2 font-semibold">Costo prom.</th>
                        <th class="text-right py-2 font-semibold">P/L realizada</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${a.eventos.map(ev => `
                        <tr class="border-b border-surface-border/50 last:border-0">
                          <td class="py-2 text-zinc-400 tabular">${escapeHtml(ev.fecha)}</td>
                          <td class="py-2 font-mono text-zinc-200">${escapeHtml(ev.ticker)}</td>
                          <td class="py-2 text-right tabular text-zinc-300">${(ev.shares || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                          <td class="py-2 text-right tabular text-zinc-300">${fmtMoney(ev.precio_venta)}</td>
                          <td class="py-2 text-right tabular text-zinc-400">${fmtMoney(ev.costo_promedio)}</td>
                          <td class="py-2 text-right tabular font-semibold ${colorPnl(ev.pnl_realizado)}">${fmtMoney(ev.pnl_realizado, { signo: true })}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            ` : ''}
          </div>
        </details>
      `;
    }).join('');
  }

  function renderAvisos(data) {
    const cont = $('imp-avisos');
    if (!cont) return;
    const avisos = data.avisos || [];
    if (!avisos.length) {
      cont.innerHTML = '<li>Sin avisos fiscales relevantes para este ejercicio.</li>';
      return;
    }
    cont.innerHTML = avisos.map(a => `<li>${escapeHtml(a)}</li>`).join('');
  }

  function render(data) {
    state.data = data;
    renderConDatos();
    renderKPIs(data);
    renderHarvest(data);
    renderPorAno(data);
    renderAvisos(data);
  }

  // ---- Carga ------------------------------------------------
  async function calcular() {
    const txs = leerTxsGuardadas();
    if (!txs.length) {
      renderSinDatos();
      return;
    }

    if (state.cargando) return;
    state.cargando = true;

    try {
      const res = await fetch('/api/impuestos/calcular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transacciones: txs, incluir_harvest: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al calcular impuestos');
      render(data);
    } catch (e) {
      console.error('Impuestos.calcular:', e);
      const cont = $('imp-contenido');
      if (cont) {
        cont.innerHTML = `
          <div class="bg-accent-red/5 border border-accent-red/20 rounded-xl p-5">
            <p class="text-sm text-accent-red font-semibold">No pudimos calcular tus impuestos</p>
            <p class="text-xs text-zinc-400 mt-2">${escapeHtml(e.message || String(e))}</p>
          </div>`;
      }
    } finally {
      state.cargando = false;
    }
  }

  function cargar() {
    calcular();
  }

  function bind() {
    const btn = $('imp-recalcular');
    if (btn) btn.addEventListener('click', calcular);
  }

  return { cargar, bind };
})();


// ============================================================
//  METAS · Simulador Monte Carlo
// ============================================================
const Metas = (() => {
  const state = {
    perfiles: [],
    perfilActivo: 'moderado',
    perfilReal: null,         // {retorno_anual, volatilidad_anual, tickers, fuente}
    valorActualReal: null,    // valor de mercado del portafolio real (si hay transacciones)
    metaTipo: 'monto',        // 'monto' | 'ingreso'
    chartTipo: 'nominal',     // 'nominal' | 'real'
    data: null,
    cargando: false,
    cargandoReal: false,
    chart: null,
  };

  // ---- Helpers ----------------------------------------------
  function fmtMoney(v, opts = {}) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const { decimales = 0 } = opts;
    const abs = Math.abs(v);
    let formateado;
    if (abs >= 1e9) formateado = (v / 1e9).toFixed(2) + 'B';
    else if (abs >= 1e6) formateado = (v / 1e6).toFixed(2) + 'M';
    else if (abs >= 1e3) formateado = (v / 1e3).toFixed(1) + 'K';
    else formateado = v.toLocaleString('en-US', {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    });
    return `$${formateado}`;
  }

  function fmtMoneyFull(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  function fmtPct(v, decimales = 0) {
    if (v === null || v === undefined) return '—';
    return (v * 100).toFixed(decimales) + '%';
  }

  // ---- Carga de perfiles -----------------------------------
  async function cargarPerfiles() {
    if (state.perfiles.length) return;
    try {
      const res = await fetch('/api/metas/perfiles');
      const data = await res.json();
      state.perfiles = data.perfiles || [];
    } catch (e) {
      console.error('Metas.cargarPerfiles:', e);
      state.perfiles = [];
    }
    renderPerfiles();
  }

  function renderPerfiles() {
    const cont = $('met-perfiles');
    if (!cont) return;

    if (!state.perfiles.length && !state.perfilReal && !state.cargandoReal) {
      cont.innerHTML = '<p class="text-xs text-zinc-500">Cargando perfiles...</p>';
      return;
    }

    let html = '';

    // Card "Mi portafolio real" si aplica
    if (state.cargandoReal) {
      html += `
        <div class="w-full p-3 rounded-lg border border-accent-rose/30 bg-accent-rose/5">
          <div class="flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-accent-rose border-t-transparent rounded-full animate-spin"></div>
            <p class="text-xs text-zinc-300">Analizando tu portafolio real...</p>
          </div>
        </div>
      `;
    } else if (state.perfilReal) {
      const activo = state.perfilActivo === 'mi_portafolio';
      const retPct = (state.perfilReal.retorno_anual * 100).toFixed(1);
      const volPct = (state.perfilReal.volatilidad_anual * 100).toFixed(1);
      const tks = (state.perfilReal.tickers || []).slice(0, 4).join(' · ');
      const masTk = (state.perfilReal.tickers || []).length > 4 ? ` · +${state.perfilReal.tickers.length - 4}` : '';
      html += `
        <button data-perfil="mi_portafolio"
          class="met-perfil w-full text-left p-3 rounded-lg border-2 transition ${activo ? 'border-accent-rose bg-accent-rose/10 shadow-glow-rose' : 'border-accent-rose/40 hover:border-accent-rose/70 bg-accent-rose/5'}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-1">
                <p class="text-sm font-semibold text-zinc-100">Mi portafolio real</p>
                <span class="text-[9px] uppercase tracking-wider bg-accent-rose/20 text-accent-rose border border-accent-rose/30 rounded-full px-1.5 py-0.5 font-bold">Recomendado</span>
              </div>
              <p class="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">Basado en el comportamiento histórico real de tus acciones.</p>
              <p class="text-[10px] text-zinc-500 mt-1 font-mono truncate">${escapeHtml(tks)}${escapeHtml(masTk)}</p>
            </div>
            <div class="flex-shrink-0 text-right">
              <p class="text-[10px] text-zinc-500">Retorno</p>
              <p class="text-sm font-bold text-accent-green tabular">${retPct}%</p>
              <p class="text-[10px] text-zinc-500 mt-1">Vol</p>
              <p class="text-xs font-semibold text-zinc-400 tabular">±${volPct}%</p>
            </div>
          </div>
        </button>
      `;

      // Divisor si hay más perfiles
      if (state.perfiles.length) {
        html += `
          <div class="flex items-center gap-3 py-1">
            <div class="flex-1 h-px bg-surface-border"></div>
            <span class="text-[10px] uppercase tracking-wider text-zinc-600">o usa un preset</span>
            <div class="flex-1 h-px bg-surface-border"></div>
          </div>
        `;
      }
    }

    // Perfiles preset
    html += state.perfiles.map(p => {
      const activo = p.id === state.perfilActivo;
      const retPct = (p.retorno_anual * 100).toFixed(0);
      const volPct = (p.volatilidad_anual * 100).toFixed(0);
      return `
        <button data-perfil="${escapeHtml(p.id)}"
          class="met-perfil w-full text-left p-3 rounded-lg border transition ${activo ? 'border-accent-rose/50 bg-accent-rose/5' : 'border-surface-border hover:border-zinc-700'}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-zinc-100">${escapeHtml(p.nombre)}</p>
              <p class="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">${escapeHtml(p.descripcion || '')}</p>
            </div>
            <div class="flex-shrink-0 text-right">
              <p class="text-[10px] text-zinc-500">Retorno</p>
              <p class="text-sm font-bold text-accent-green tabular">${retPct}%</p>
              <p class="text-[10px] text-zinc-500 mt-1">Vol</p>
              <p class="text-xs font-semibold text-zinc-400 tabular">±${volPct}%</p>
            </div>
          </div>
        </button>
      `;
    }).join('');

    cont.innerHTML = html;

    cont.querySelectorAll('.met-perfil').forEach(btn => {
      btn.addEventListener('click', () => {
        state.perfilActivo = btn.dataset.perfil;
        renderPerfiles();
        cargarDividendos();
      });
    });
  }

  // ---- Detectar y analizar portafolio real -----------------
  async function cargarPerfilReal() {
    const tickers = (typeof leerPortafolioGuardado === 'function') ? leerPortafolioGuardado() : null;
    const pesos   = (typeof leerPesosGuardados === 'function') ? leerPesosGuardados() : null;

    if (!Array.isArray(tickers) || !tickers.length) return;

    // Cache: si ya lo analizamos y los tickers no cambiaron, no repetir
    if (state.perfilReal) {
      const iguales = state.perfilReal.tickers.length === tickers.length &&
                      state.perfilReal.tickers.every(t => tickers.includes(t));
      if (iguales) return;
    }

    state.cargandoReal = true;
    renderPerfiles();

    try {
      const body = { tickers };
      if (pesos && Object.keys(pesos).length) body.pesos = pesos;

      const res = await fetch('/api/analizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error analizando portafolio');

      const port = data.portafolio || {};
      const retAnual = (port.rendimiento_anualizado_pct || 0) / 100.0;
      const volAnual = (port.volatilidad_anual_pct || 0) / 100.0;

      if (volAnual > 0) {
        state.perfilReal = {
          retorno_anual:     retAnual,
          volatilidad_anual: volAnual,
          tickers:           tickers,
          sharpe:            port.sharpe_ratio,
          fuente:            'historico',
        };
        // Auto-activar como default
        state.perfilActivo = 'mi_portafolio';
      }
    } catch (e) {
      console.error('Metas.cargarPerfilReal:', e);
      // Silencioso: si falla, el usuario sigue viendo los presets
    } finally {
      state.cargandoReal = false;
      renderPerfiles();
      // Si quedó activo 'mi_portafolio', precargar dividendos
      if (state.perfilActivo === 'mi_portafolio' && state.perfilReal) {
        cargarDividendos();
      }
    }
  }

  // ---- Cargar valor actual de mercado desde transacciones ---
  async function cargarValorActualReal() {
    try {
      const raw = localStorage.getItem('miPortafolio.transacciones.v1');
      if (!raw) return;
      const txs = JSON.parse(raw);
      if (!Array.isArray(txs) || !txs.length) return;

      const res = await fetch('/api/transacciones/calcular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transacciones: txs }),
      });
      const data = await res.json();
      if (!res.ok) return;
      const valor = data?.totales?.valor_actual;
      if (valor && valor > 0) {
        state.valorActualReal = valor;
        const cap = $('met-capital');
        // Solo sobreescribir si el usuario no ha cambiado manualmente el valor default
        if (cap && (parseFloat(cap.value) === 100000 || parseFloat(cap.value) === 0)) {
          cap.value = Math.round(valor);
        }
      }
    } catch (e) {
      console.error('Metas.cargarValorActualReal:', e);
    }
  }

  // ---- Form / tabs ------------------------------------------
  function setMetaTab(tab) {
    state.metaTipo = tab;
    const montoTab   = $('met-meta-tab-monto');
    const ingTab     = $('met-meta-tab-ingreso');
    const montoBox   = $('met-meta-monto-box');
    const ingBox     = $('met-meta-ingreso-box');

    if (tab === 'monto') {
      montoTab?.classList.add('bg-accent-rose/20', 'text-accent-rose');
      montoTab?.classList.remove('text-zinc-500', 'hover:text-zinc-300');
      ingTab?.classList.remove('bg-accent-rose/20', 'text-accent-rose');
      ingTab?.classList.add('text-zinc-500', 'hover:text-zinc-300');
      montoBox?.classList.remove('hidden');
      ingBox?.classList.add('hidden');
    } else {
      ingTab?.classList.add('bg-accent-rose/20', 'text-accent-rose');
      ingTab?.classList.remove('text-zinc-500', 'hover:text-zinc-300');
      montoTab?.classList.remove('bg-accent-rose/20', 'text-accent-rose');
      montoTab?.classList.add('text-zinc-500', 'hover:text-zinc-300');
      ingBox?.classList.remove('hidden');
      montoBox?.classList.add('hidden');
    }
    actualizarEquivalenteIngreso();
  }

  function actualizarEquivalenteIngreso() {
    const ingreso = parseFloat(($('met-meta-ingreso')?.value || '0')) || 0;
    const tasa = (parseFloat(($('met-retiro')?.value || '4')) || 4) / 100.0;
    const el = $('met-meta-ingreso-equivale');
    if (!el) return;
    if (ingreso > 0 && tasa > 0) {
      const capital = ingreso * 12 / tasa;
      el.textContent = fmtMoneyFull(capital);
    } else {
      el.textContent = '—';
    }
  }

  function setChartTipo(tipo) {
    state.chartTipo = tipo;
    $('met-chart-tab-nom')?.classList.toggle('bg-accent-rose/20', tipo === 'nominal');
    $('met-chart-tab-nom')?.classList.toggle('text-accent-rose', tipo === 'nominal');
    $('met-chart-tab-nom')?.classList.toggle('text-zinc-500', tipo !== 'nominal');
    $('met-chart-tab-real')?.classList.toggle('bg-accent-rose/20', tipo === 'real');
    $('met-chart-tab-real')?.classList.toggle('text-accent-rose', tipo === 'real');
    $('met-chart-tab-real')?.classList.toggle('text-zinc-500', tipo !== 'real');
    if (state.data) renderChart(state.data);
  }

  // ---- Horizonte slider -------------------------------------
  function bindHorizonte() {
    const slider = $('met-horizonte');
    const val    = $('met-horizonte-val');
    if (!slider || !val) return;
    slider.addEventListener('input', () => {
      val.textContent = slider.value;
    });
  }

  // ---- DIVIDENDOS (integrado) -------------------------------
  async function cargarDividendos() {
    // Solo aplica cuando se usa el portafolio real
    if (state.perfilActivo !== 'mi_portafolio' || !state.perfilReal) {
      $('met-dividendos-section')?.classList.add('hidden');
      return;
    }

    // Detectar fuente de posiciones
    const body = {};
    let posiciones = null;

    try {
      const raw = localStorage.getItem('miPortafolio.transacciones.v1');
      if (raw) {
        const txs = JSON.parse(raw);
        if (Array.isArray(txs) && txs.length) {
          // Si hay transacciones, sacar shares reales del cálculo
          const res = await fetch('/api/transacciones/calcular', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transacciones: txs }),
          });
          const d = await res.json();
          if (res.ok && d.por_ticker) {
            posiciones = {};
            for (const p of d.por_ticker) {
              if (p.shares_actuales > 0) {
                posiciones[p.ticker] = {
                  shares: p.shares_actuales,
                  costo_promedio: p.costo_promedio,
                };
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Metas.cargarDividendos[txs]:', e);
    }

    if (posiciones && Object.keys(posiciones).length) {
      body.posiciones = posiciones;
    } else {
      // Fallback: usar tickers + pesos + capital del form
      const tickers = state.perfilReal.tickers || [];
      const pesos = (typeof leerPesosGuardados === 'function') ? leerPesosGuardados() : null;
      const capital = parseFloat($('met-capital')?.value || '0') || 100000;
      body.tickers = tickers;
      if (pesos) body.pesos = pesos;
      body.capital_supuesto = capital;
    }

    // Meta de ingreso mensual (si está en ese modo)
    if (state.metaTipo === 'ingreso') {
      const ing = parseFloat($('met-meta-ingreso')?.value || '0') || 0;
      if (ing > 0) body.meta_ingreso_mensual = ing;
    }

    try {
      const res = await fetch('/api/dividendos/portafolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      renderDividendos(data);
    } catch (e) {
      console.error('Metas.cargarDividendos:', e);
      $('met-dividendos-section')?.classList.add('hidden');
    }
  }

  function renderDividendos(data) {
    const section = $('met-dividendos-section');
    if (!section) return;

    const totales = data.totales || {};
    const porTicker = data.por_ticker || [];

    // Si ninguna acción paga dividendos, mostrar aviso compacto
    if (!totales.num_tickers_pagan) {
      section.classList.remove('hidden');
      section.innerHTML = `
        <div class="pt-2">
          <h3 class="text-lg font-semibold text-zinc-100 mb-1">Ingreso pasivo de tu portafolio</h3>
        </div>
        <div class="bg-surface-card border border-surface-border rounded-xl p-5">
          <div class="flex items-start gap-3">
            <div class="text-2xl" style="color:var(--sello)"><span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 3.6 10.8V16h-7.2v-2.2A6 6 0 0 1 12 3z"/></svg></span></div>
            <div>
              <p class="text-sm text-zinc-200 font-medium mb-1">Ninguna de tus acciones paga dividendos actualmente</p>
              <p class="text-xs text-zinc-500 leading-relaxed">
                Tus tickers actuales (${porTicker.map(r => `<span class="font-mono text-zinc-400">${escapeHtml(r.ticker)}</span>`).join(', ')})
                son de crecimiento: el retorno viene de apreciación del precio, no de pagos periódicos.
              </p>
              <p class="text-xs text-zinc-500 mt-2 leading-relaxed">
                Si buscas ingreso pasivo mensual, considera agregar ETFs como
                <span class="font-mono text-accent-green">VOO</span>,
                <span class="font-mono text-accent-green">SCHD</span>,
                <span class="font-mono text-accent-green">JEPI</span> o FIBRAS mexicanas como
                <span class="font-mono text-accent-green">FUNO11.MX</span>.
              </p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    section.classList.remove('hidden');

    // Si el render fue reemplazado por el caso "ninguna paga", reconstruir desde HTML base
    // (solo sucede si venimos de un estado previo); asumimos el HTML base está íntegro.
    if (!$('met-div-anual')) {
      // Estructura base se perdió — recargamos la app sería lo correcto; fallback silencioso
      return;
    }

    // Progreso hacia meta (si aplica)
    const progreso = data.progreso_meta;
    const boxProg = $('met-div-progreso');
    if (progreso && boxProg) {
      boxProg.classList.remove('hidden');
      $('met-div-meta-monto').textContent = fmtMoneyFull(progreso.meta_ingreso_mensual);
      const pct = Math.min(100, (progreso.pct_cubierto || 0) * 100);
      $('met-div-cubierto-pct').textContent = pct.toFixed(0) + '%';
      $('met-div-barra').style.width = pct + '%';

      let texto = '';
      if (pct >= 100) {
        texto = `Tus dividendos actuales ya cubren tu meta. Podrías vivir de este portafolio si quisieras.`;
      } else {
        const extra = progreso.capital_extra_necesario;
        texto = `Te faltan ${fmtMoneyFull(progreso.faltante_mensual)} al mes para llegar a tu meta. `
              + (extra ? `Necesitarías invertir <span class="text-zinc-300">${fmtMoneyFull(extra)}</span> más al yield actual para cubrir la diferencia con dividendos.` : '');
      }
      $('met-div-progreso-texto').innerHTML = texto;
    } else if (boxProg) {
      boxProg.classList.add('hidden');
    }

    // KPIs
    $('met-div-anual').textContent   = fmtMoneyFull(totales.ingreso_anual_estimado);
    $('met-div-mensual').textContent = fmtMoneyFull(totales.ingreso_mensual_promedio);
    $('met-div-yield').textContent   = (totales.yield_portafolio_pct || 0).toFixed(2) + '%';
    const yoc = totales.yield_on_cost_pct;
    $('met-div-yoc').textContent = yoc !== null && yoc !== undefined ? yoc.toFixed(2) + '%' : '—';

    // Calendario
    renderCalendario(data.calendario || []);

    // Tickers
    renderTickersDividendos(porTicker);

    // Avisos
    const avisosEl = $('met-div-avisos');
    const avisos = data.avisos || [];
    if (avisosEl) {
      avisosEl.innerHTML = avisos.map(a => `<li>${escapeHtml(a)}</li>`).join('');
    }
  }

  function renderCalendario(calendario) {
    const cont = $('met-div-calendario');
    const num  = $('met-div-num-pagos');
    if (!cont) return;

    if (!calendario.length) {
      cont.innerHTML = `<p class="text-xs text-zinc-500 text-center py-4">Sin pagos próximos proyectados.</p>`;
      if (num) num.textContent = '';
      return;
    }

    if (num) num.textContent = `${calendario.length} pagos en 12 meses`;

    // Agrupar por mes
    const porMes = {};
    for (const p of calendario) {
      const d = new Date(p.fecha);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!porMes[key]) porMes[key] = { label: d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }), pagos: [], total: 0 };
      porMes[key].pagos.push(p);
      porMes[key].total += (p.monto_total || 0);
    }

    const meses = Object.entries(porMes).sort(([a], [b]) => a.localeCompare(b));
    cont.innerHTML = meses.map(([k, m]) => `
      <div class="border border-surface-border rounded-lg overflow-hidden">
        <div class="bg-surface px-3 py-2 flex items-center justify-between">
          <span class="text-xs font-semibold text-zinc-300 capitalize">${escapeHtml(m.label)}</span>
          <span class="text-xs font-bold text-accent-green tabular">${fmtMoneyFull(m.total)}</span>
        </div>
        <div class="divide-y divide-surface-border">
          ${m.pagos.map(p => {
            const d = new Date(p.fecha);
            const dia = d.getDate();
            return `
              <div class="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                <div class="flex items-center gap-3 min-w-0">
                  <span class="font-mono text-[10px] text-zinc-500 w-6 text-center">${dia}</span>
                  <span class="font-mono font-semibold text-zinc-100">${escapeHtml(p.ticker)}</span>
                  <span class="text-[10px] text-zinc-500 truncate">${escapeHtml(p.frecuencia || '')}</span>
                </div>
                <div class="text-right flex-shrink-0">
                  <div class="tabular text-zinc-200">${fmtMoneyFull(p.monto_total)}</div>
                  <div class="text-[10px] text-zinc-600 tabular">$${(p.monto_por_share || 0).toFixed(3)}/share</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
  }

  function renderTickersDividendos(tickers) {
    const cont = $('met-div-tickers');
    if (!cont) return;

    cont.innerHTML = tickers.map(r => {
      const paga = r.paga_dividendos;
      const yieldTxt = r.yield_actual_pct !== null && r.yield_actual_pct !== undefined
        ? r.yield_actual_pct.toFixed(2) + '%'
        : '—';
      const divAnual = r.dividendo_anual_estimado
        ? '$' + (r.dividendo_anual_estimado).toFixed(2) + '/share'
        : '—';
      const ingreso = r.ingreso_anual_ticker > 0 ? fmtMoneyFull(r.ingreso_anual_ticker) : '—';

      return `
        <tr class="border-b border-surface-border/50 last:border-0 ${paga ? '' : 'opacity-60'}">
          <td class="py-2.5">
            <span class="font-mono font-semibold text-zinc-100">${escapeHtml(r.ticker)}</span>
            ${!paga ? `<div class="text-[10px] text-zinc-600 mt-0.5 italic">${escapeHtml(r.mensaje || 'No paga')}</div>` : ''}
          </td>
          <td class="py-2.5 text-zinc-400">${paga ? escapeHtml(r.frecuencia || '—') : '—'}</td>
          <td class="py-2.5 text-right tabular text-zinc-300">${divAnual}</td>
          <td class="py-2.5 text-right tabular ${paga ? 'text-accent-blue' : 'text-zinc-600'}">${yieldTxt}</td>
          <td class="py-2.5 text-right tabular font-semibold ${paga ? 'text-accent-green' : 'text-zinc-600'}">${ingreso}</td>
        </tr>
      `;
    }).join('');
  }

  // ---- Render resultados ------------------------------------
  function renderResultado(data) {
    state.data = data;
    $('met-vacio')?.classList.add('hidden');
    $('met-resultado')?.classList.remove('hidden');

    const meta = data.meta || {};
    const tot  = data.totales || {};

    // Probabilidad
    const prob = meta.probabilidad;
    const probEl = $('met-prob');
    const probMsgEl = $('met-prob-mensaje');
    if (probEl) {
      if (prob === null || prob === undefined) {
        probEl.textContent = '—';
        probEl.className = 'text-5xl font-bold tabular text-zinc-400';
      } else {
        const pct = prob * 100;
        probEl.textContent = pct.toFixed(0) + '%';
        let color = 'text-accent-red';
        if (pct >= 70) color = 'text-accent-green';
        else if (pct >= 45) color = 'text-accent-amber';
        probEl.className = `text-5xl font-bold tabular ${color}`;
      }
    }
    if (probMsgEl) {
      if (prob === null || prob === undefined) {
        probMsgEl.textContent = 'Sin meta definida.';
      } else {
        const pct = prob * 100;
        let msg;
        if (pct >= 80) msg = 'Muy alta probabilidad. Vas muy sólido con estos parámetros.';
        else if (pct >= 60) msg = 'Buena probabilidad. Considera aumentar un poco el aporte para más margen.';
        else if (pct >= 40) msg = 'Es posible, pero apretado. Sube el aporte o extiende el plazo.';
        else msg = 'Probabilidad baja. Revisa aporte, horizonte o perfil para mejorar.';
        probMsgEl.textContent = msg;
      }
    }

    // Años mediana
    const anosEl = $('met-anos-meta');
    if (anosEl) {
      anosEl.textContent = meta.anos_mediana !== null && meta.anos_mediana !== undefined
        ? meta.anos_mediana.toFixed(1)
        : '—';
    }

    // Escenarios
    renderEscenarios(data.escenarios || []);

    // Totales
    $('met-tot-aportado').textContent    = fmtMoneyFull(tot.total_aportado);
    const crec = tot.crecimiento_mediano || 0;
    const elCrec = $('met-tot-crecimiento');
    elCrec.textContent = (crec >= 0 ? '+' : '') + fmtMoneyFull(crec);
    elCrec.className = `text-xl font-bold mt-2 tabular ${crec >= 0 ? 'text-accent-green' : 'text-accent-red'}`;
    $('met-tot-real').textContent = fmtMoneyFull(tot.valor_mediano_real);

    // Chart
    renderChart(data);

    // Dividendos (solo se muestra si perfilActivo === 'mi_portafolio')
    cargarDividendos();
  }

  function renderEscenarios(escenarios) {
    const cont = $('met-escenarios');
    if (!cont) return;

    const colores = {
      'Pesimista': { borde: 'border-accent-red/30',   color: 'text-accent-red',   emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M7 15a4.5 4.5 0 0 1 .6-9A6 6 0 0 1 19 8.5a3.5 3.5 0 0 1-.5 6.5"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg></span>' },
      'Esperado':  { borde: 'border-zinc-600',        color: 'text-zinc-200',     emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M2.5 8H4M4.1 4.1l1 1M11.9 4.1l-1 1"/><path d="M9 19a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 20 12.5a3.2 3.2 0 0 1-.5 6.5z"/></svg></span>' },
      'Optimista': { borde: 'border-accent-green/30', color: 'text-accent-green', emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg></span>' },
    };

    cont.innerHTML = escenarios.map(esc => {
      const c = colores[esc.nombre] || colores.Esperado;
      return `
        <div class="bg-surface-card border ${c.borde} rounded-xl p-5 fade-up">
          <div class="flex items-start justify-between mb-2">
            <div>
              <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">${escapeHtml(esc.etiqueta)}</p>
              <p class="text-sm font-semibold ${c.color} mt-0.5">${escapeHtml(esc.nombre)}</p>
            </div>
            <span class="text-xl">${c.emoji}</span>
          </div>
          <p class="text-2xl font-bold tabular text-zinc-100 mt-3">${fmtMoneyFull(esc.valor_nominal)}</p>
          <p class="text-[11px] text-zinc-500 mt-1">
            En pesos de hoy: <span class="tabular text-zinc-300">${fmtMoneyFull(esc.valor_real)}</span>
          </p>
          <p class="text-[10px] text-zinc-600 mt-3 leading-relaxed">${escapeHtml(esc.descripcion)}</p>
        </div>
      `;
    }).join('');
  }

  function renderChart(data) {
    const canvas = $('met-chart');
    if (!canvas) return;

    const serie = data.serie || [];
    const labels = serie.map(p => p.anos + 'a');

    const suffix = state.chartTipo === 'real' ? '_real' : '';
    const p10 = serie.map(p => p['p10' + suffix]);
    const p50 = serie.map(p => p['p50' + suffix]);
    const p90 = serie.map(p => p['p90' + suffix]);

    const metaMonto = data.meta?.monto;
    const metaLine = metaMonto && state.chartTipo === 'nominal'
      ? serie.map(() => metaMonto)
      : null;

    // Destruir chart previo
    if (state.chart) {
      try { state.chart.destroy(); } catch {}
      state.chart = null;
    }

    const datasets = [
      {
        label: 'P90 (optimista)',
        data: p90,
        borderColor: 'rgba(156,93,18,0.4)',
        backgroundColor: 'rgba(156,93,18,0.08)',
        borderWidth: 1,
        fill: '+2',  // llena entre p90 y p10
        pointRadius: 0,
        tension: 0.2,
      },
      {
        label: 'P50 (mediana)',
        data: p50,
        borderColor: MP_COLOR.baja,
        backgroundColor: MP_COLOR.rgba(MP_COLOR.baja, 0.08),
        borderWidth: 2.5,
        fill: false,
        pointRadius: 0,
        tension: 0.2,
      },
      {
        label: 'P10 (pesimista)',
        data: p10,
        borderColor: 'rgba(174,50,35,0.4)',
        backgroundColor: 'rgba(174,50,35,0.08)',
        borderWidth: 1,
        fill: false,
        pointRadius: 0,
        tension: 0.2,
      },
    ];

    if (metaLine) {
      datasets.push({
        label: 'Meta',
        data: metaLine,
        borderColor: MP_COLOR.rgba(MP_COLOR.tinta3, 0.9),
        borderDash: [6, 4],
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        tension: 0,
      });
    }

    state.chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: MP_GRAFICA.base({
        plugins: {
          legend: { ...MP_GRAFICA.leyenda(true), position: 'bottom' },
          tooltip: MP_GRAFICA.tooltip({
            label: (ctx) => `${ctx.dataset.label}: ${fmtMoneyFull(ctx.parsed.y)}`,
          }),
        },
        scales: {
          x: MP_GRAFICA.ejeTiempo(),
          y: MP_GRAFICA.ejeValor({
            ticks: {
              color: MP_GRAFICA.tinta3,
              font: { family: MP_GRAFICA.mono, size: 9.5 },
              maxTicksLimit: 5, padding: 8,
              callback: (v) => fmtMoney(v),
            },
          }),
        },
      }),
    });
  }

  // ---- Simulación -------------------------------------------
  async function simular() {
    if (state.cargando) return;

    const capital     = parseFloat($('met-capital')?.value || '0') || 0;
    const aporte      = parseFloat($('met-aporte')?.value || '0') || 0;
    const horizonte   = parseFloat($('met-horizonte')?.value || '20') || 20;
    const inflacion   = (parseFloat($('met-inflacion')?.value || '4') || 4) / 100.0;
    const tasaRetiro  = (parseFloat($('met-retiro')?.value || '4') || 4) / 100.0;

    // Perfil activo: real o preset
    let retornoAnual, volatilidadAnual, fuentePerfil;
    if (state.perfilActivo === 'mi_portafolio' && state.perfilReal) {
      retornoAnual     = state.perfilReal.retorno_anual;
      volatilidadAnual = state.perfilReal.volatilidad_anual;
      fuentePerfil     = 'portafolio_real';
    } else {
      const perfil = state.perfiles.find(p => p.id === state.perfilActivo)
                  || { retorno_anual: 0.08, volatilidad_anual: 0.11 };
      retornoAnual     = perfil.retorno_anual;
      volatilidadAnual = perfil.volatilidad_anual;
      fuentePerfil     = 'preset';
    }

    const body = {
      capital_inicial:   capital,
      aporte_mensual:    aporte,
      horizonte_anos:    horizonte,
      retorno_anual:     retornoAnual,
      volatilidad_anual: volatilidadAnual,
      inflacion_anual:   inflacion,
      tasa_retiro_segura: tasaRetiro,
      num_simulaciones:  3000,
    };

    if (state.metaTipo === 'monto') {
      const monto = parseFloat($('met-meta-monto')?.value || '0') || 0;
      if (monto > 0) body.meta_monto = monto;
    } else {
      const ing = parseFloat($('met-meta-ingreso')?.value || '0') || 0;
      if (ing > 0) body.meta_ingreso_mensual = ing;
    }

    const btn = $('met-simular');
    state.cargando = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Simulando...';
      btn.classList.add('opacity-60');
    }

    try {
      const res = await fetch('/api/metas/simular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al simular');
      renderResultado(data);
    } catch (e) {
      console.error('Metas.simular:', e);
      alert('No se pudo correr la simulación: ' + (e.message || e));
    } finally {
      state.cargando = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Simular mi futuro →';
        btn.classList.remove('opacity-60');
      }
    }
  }

  function cargar() {
    cargarPerfiles();
    cargarPerfilReal();
    cargarValorActualReal();
  }

  function bind() {
    bindHorizonte();
    $('met-simular')?.addEventListener('click', simular);
    $('met-meta-tab-monto')?.addEventListener('click', () => setMetaTab('monto'));
    $('met-meta-tab-ingreso')?.addEventListener('click', () => setMetaTab('ingreso'));
    $('met-chart-tab-nom')?.addEventListener('click',  () => setChartTipo('nominal'));
    $('met-chart-tab-real')?.addEventListener('click', () => setChartTipo('real'));
    $('met-meta-ingreso')?.addEventListener('input', actualizarEquivalenteIngreso);
    $('met-retiro')?.addEventListener('input', actualizarEquivalenteIngreso);
  }

  return { cargar, bind };
})();


// ===========================================================================
// ALERTAS POR EMAIL (drift, precio, semanal)
// ===========================================================================
const Alertas = (() => {
  const state = { disponible: null, chequeado: false };

  async function chequear() {
    if (state.chequeado) return;
    state.chequeado = true;
    try {
      const res = await fetch('/api/alertas/estado');
      const data = await res.json();
      state.disponible = !!data.disponible;
    } catch (_) {
      state.disponible = false;
    }
    const estadoEl = $('al-estado');
    const noConf   = $('al-no-config');
    if (state.disponible) {
      if (estadoEl) { estadoEl.textContent = '● SMTP listo'; estadoEl.className = 'text-[10px] uppercase tracking-wider text-accent-green'; }
      noConf?.classList.add('hidden');
    } else {
      if (estadoEl) { estadoEl.textContent = '○ SMTP no configurado'; estadoEl.className = 'text-[10px] uppercase tracking-wider text-zinc-500'; }
      noConf?.classList.remove('hidden');
    }
  }

  function construirPayload(tipo) {
    const tickers = (typeof leerPortafolioGuardado === 'function') ? (leerPortafolioGuardado() || []) : [];
    const pesos   = (typeof leerPesosGuardados === 'function')     ? (leerPesosGuardados()     || {}) : {};

    if (tipo === 'drift') {
      // Inventamos pesos reales simulando drift (para preview). En producción vendrían de transacciones.
      const posiciones = tickers.map((t, i) => {
        const objetivo = (pesos[t] || (1 / tickers.length)) * 100;
        const drift = (i === 0 ? 8 : i === tickers.length - 1 ? -6 : 0);
        return { ticker: t, peso_pct: Math.max(0, objetivo + drift) };
      });
      return { pesos_objetivo: pesos, posiciones, umbral_pp: 5.0 };
    }
    if (tipo === 'precio' || tipo === 'movimientos') {
      const posiciones = tickers.map((t, i) => ({
        ticker: t,
        precio_actual: 100 + i * 5,
        cambio_pct_dia: i % 2 === 0 ? 6.2 : -7.4,
      }));
      return { posiciones, umbral_pct: 5.0 };
    }
    if (tipo === 'semanal') {
      return {
        metricas: { valor_actual: 125000, pnl_semana_pct: 2.34 },
        top:    tickers.slice(0, 3).map((t, i) => ({ ticker: t, retorno_pct: 3 + i })),
        bottom: tickers.slice(-3).map((t, i) => ({ ticker: t, retorno_pct: -2 - i })),
      };
    }
    return {};
  }

  async function preview() {
    const tipo = $('al-tipo')?.value || 'drift';
    const msgEl = $('al-msg');
    if (msgEl) msgEl.textContent = 'Generando preview…';

    try {
      const res = await fetch('/api/alertas/preview', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          tipo,
          nombre: 'Charlie',
          payload: construirPayload(tipo),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');

      if (data.mensaje) {
        if (msgEl) msgEl.textContent = data.mensaje;
        return;
      }

      $('al-preview-subject').textContent = data.subject || '';
      const iframe = $('al-preview-iframe');
      if (iframe) {
        iframe.srcdoc = data.html || '';
      }
      $('al-preview-wrap')?.classList.remove('hidden');
      if (msgEl) msgEl.textContent = '';
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Error: ' + (e.message || e);
    }
  }

  async function enviar() {
    const tipo = $('al-tipo')?.value || 'drift';
    const email = ($('al-email')?.value || '').trim();
    if (!email || !email.includes('@')) { alert('Escribe un email válido.'); return; }
    if (!state.disponible) { alert('SMTP no configurado en el backend.'); return; }

    const msgEl = $('al-msg');
    const btn = $('al-enviar');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

    try {
      const res = await fetch('/api/alertas/enviar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          tipo,
          destinatario: email,
          nombre: 'Charlie',
          payload: construirPayload(tipo),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      // No afirmar "Enviado a X" sin mirar el resultado: alertas.enviar_alerta()
      // responde ok:false cuando el envío falló, y antes se ignoraba.
      if (msgEl) {
        if (data && data.ok === false) {
          msgEl.textContent = 'No se pudo enviar' + (data.error ? ': ' + data.error : '.');
        } else {
          msgEl.textContent = data.mensaje || ('Enviado a ' + (data.enviado_a || email));
        }
      }
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Error: ' + (e.message || e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar ahora'; }
    }
  }

  // ---- Suscripciones automáticas ------------------------------------------
  function cargarCfg() {
    const cfg = leerCfgAlertas() || { destinatario: '', activas: {drift:false, precio:false, semanal:false} };
    if (cfg.destinatario && $('al-email') && !$('al-email').value) {
      $('al-email').value = cfg.destinatario;
    }
    if ($('al-auto-drift'))   $('al-auto-drift').checked   = !!cfg.activas?.drift;
    if ($('al-auto-precio'))  $('al-auto-precio').checked  = !!cfg.activas?.precio;
    if ($('al-auto-semanal')) $('al-auto-semanal').checked = !!cfg.activas?.semanal;
    actualizarMsgAuto(cfg);
  }

  // estado: 'guardando' | 'ok' | 'error'. Solo con 'ok' se afirma que las
  // alertas van a llegar: el registro vive en el servidor (el cron lee el
  // snapshot), así que hasta confirmarlo no podemos prometer nada. Antes se
  // afirmaba de inmediato leyendo solo localStorage.
  function actualizarMsgAuto(cfg, estado, error) {
    const el = $('al-auto-msg');
    if (!el) return;
    const activos = Object.entries(cfg.activas || {}).filter(([_,v]) => v).map(([k]) => k);
    el.classList.remove('text-zinc-600', 'text-amber-400', 'text-red-400');
    if (!cfg.destinatario || !activos.length) {
      el.classList.add('text-zinc-600');
      el.textContent = 'Sin alertas automáticas activadas. Pon tu email arriba y marca al menos una opción.';
      return;
    }
    if (estado === 'guardando') {
      el.classList.add('text-zinc-600');
      el.textContent = 'Guardando en el servidor…';
      return;
    }
    if (estado === 'error') {
      el.classList.add('text-red-400');
      el.textContent = 'No pudimos guardar tus alertas en el servidor'
        + (error ? ' (' + error + ')' : '') + ', así que NO se van a enviar. '
        + 'Revisa tu conexión y vuelve a marcar la opción.';
      return;
    }
    // Confirmado por el servidor.
    el.classList.add(state.disponible === false ? 'text-amber-400' : 'text-zinc-600');
    el.textContent = `${activos.length} alerta(s) activa(s) — se mandan a ${cfg.destinatario} automáticamente.`
      + (state.disponible === false
          ? ' Ojo: el envío de correo no está disponible en el servidor ahora mismo, así que podrían no llegar.'
          : '');
  }

  function persistirCfg() {
    const cfg = {
      destinatario: ($('al-email')?.value || '').trim(),
      activas: {
        drift:   $('al-auto-drift')?.checked   || false,
        precio:  $('al-auto-precio')?.checked  || false,
        semanal: $('al-auto-semanal')?.checked || false,
      },
    };
    const espera = guardarCfgAlertas(cfg);
    actualizarMsgAuto(cfg, 'guardando');
    if (espera && espera.then) {
      espera.then((r) => actualizarMsgAuto(cfg, r && r.ok ? 'ok' : 'error', r && r.error));
    } else {
      actualizarMsgAuto(cfg, 'ok');
    }
  }

  function bind() {
    $('al-preview')?.addEventListener('click', preview);
    $('al-enviar')?.addEventListener('click',  enviar);
    $('al-preview-close')?.addEventListener('click', () => $('al-preview-wrap')?.classList.add('hidden'));
    // Suscripciones automáticas
    ['al-auto-drift', 'al-auto-precio', 'al-auto-semanal'].forEach(id => {
      $(id)?.addEventListener('change', persistirCfg);
    });
    $('al-email')?.addEventListener('change', persistirCfg);
    $('al-email')?.addEventListener('blur', persistirCfg);
    cargarCfg();
    chequear();
  }

  return { bind };
})();


// ===========================================================================
// RENTA FIJA MX (FIBRAS + CETES)
// ===========================================================================
const RentaFija = (() => {
  const state = { data: null, cargando: false, cargado: false };
  let _curvaChart = null;

  async function renderCurvas() {
    const cv = $('rf-curva-canvas');
    if (!cv || typeof Chart === 'undefined') return;
    const fuenteEl = $('rf-curva-fuente');
    const notaEl = $('rf-curva-nota');
    let d;
    try {
      const res = await fetch('/api/curvas');
      d = await res.json();
    } catch (e) { return; }
    if (!d) return;
    const us = (d.us && d.us.ok) ? d.us.puntos : [];
    const mx = (d.mx && d.mx.ok) ? d.mx.puntos : [];
    const ds = [];
    if (mx.length) ds.push({
      label: 'CETES (MX)',
      data: mx.map(p => ({ x: p.anios, y: p.tasa, plazo: p.plazo })),
      borderColor: MP_COLOR.sello, backgroundColor: MP_COLOR.sello, tension: 0.3, pointRadius: 4,
    });
    if (us.length) ds.push({
      label: 'Tesoro (US)',
      data: us.map(p => ({ x: p.anios, y: p.tasa, plazo: p.plazo })),
      borderColor: MP_COLOR.sello, backgroundColor: MP_COLOR.sello, tension: 0.3, pointRadius: 3,
    });
    if (_curvaChart) { _curvaChart.destroy(); _curvaChart = null; }
    if (!ds.length) {
      if (notaEl) notaEl.textContent = (d.us && d.us.nota) || 'Sin datos de curvas por ahora.';
      return;
    }
    _curvaChart = new Chart(cv.getContext('2d'), {
      type: 'line',
      data: { datasets: ds },
      options: MP_GRAFICA.base({
        interaction: { intersect: false, mode: 'nearest' },
        scales: {
          x: MP_GRAFICA.ejeValor({ type: 'linear',
               title: { display: true, text: 'Plazo (años)', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } } }),
          y: MP_GRAFICA.ejeValor({
               title: { display: true, text: 'Tasa anual', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } },
               ticks: { color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 }, maxTicksLimit: 5, padding: 8, callback: v => v + '%' } }),
        },
        plugins: {
          legend: MP_GRAFICA.leyenda(true),
          tooltip: MP_GRAFICA.tooltip({ label: c => `${c.dataset.label} ${c.raw.plazo}: ${c.raw.y}%` }),
        },
      }),
    });
    if (fuenteEl) {
      const parts = [];
      if (us.length && d.us.fuente) parts.push(d.us.fuente + (d.us.fecha ? ' ' + d.us.fecha : ''));
      if (mx.length && d.mx.fuente) parts.push(d.mx.fuente + (d.mx.fecha ? ' ' + d.mx.fecha : ''));
      fuenteEl.textContent = parts.join(' · ');
    }
    if (notaEl) notaEl.textContent = (!us.length && d.us && d.us.nota) ? d.us.nota : '';
  }

  function fmtPctLocal(x, d = 2) {
    if (x === null || x === undefined) return '—';
    return (x * 100).toFixed(d) + '%';
  }
  function fmtMoneyMx(x) {
    if (x === null || x === undefined) return '—';
    return '$' + Number(x).toLocaleString('es-MX', { maximumFractionDigits: 2 });
  }
  function fmtMcapLocal(x) {
    if (x === null || x === undefined || x <= 0) return '—';
    if (x >= 1e9)  return '$' + (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6)  return '$' + (x / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(x).toLocaleString();
  }

  function renderCetes(cetes) {
    const grid = $('rf-cetes-grid');
    const fuente = $('rf-cetes-fuente');
    if (!grid) return;

    const tasas = (cetes && cetes.tasas) || {};
    const plazos = ['28', '91', '182', '364'];
    grid.innerHTML = plazos.map(p => {
      const d = tasas[p];
      const tasa = d?.tasa_pct;
      return `
        <div class="bg-surface-card border border-surface-border rounded-xl p-5 text-center hover:border-accent-teal/40 transition">
          <p class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">CETES ${p}d</p>
          <p class="text-3xl font-bold tabular text-accent-teal mt-3">${tasa != null ? tasa.toFixed(2) + '%' : '—'}</p>
          <p class="text-[10px] text-zinc-600 mt-2">${d?.fecha ? 'al ' + d.fecha : 'valor referencial'}</p>
        </div>
      `;
    }).join('');

    if (fuente) {
      if (cetes?.fuente === 'banxico_sie') {
        fuente.innerHTML = `Banxico SIE · ${cetes.actualizado || ''}`;
      } else {
        fuente.innerHTML = `<span class="text-accent-amber/80">Valores de respaldo</span> · configura BANXICO_SIE_TOKEN`;
      }
    }
  }

  function renderFibras(fibras) {
    const tbody = $('rf-fibras-tbody');
    if (!tbody) return;

    if (!fibras || !fibras.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-zinc-500 text-xs">Sin datos de FIBRAS</td></tr>';
      return;
    }

    tbody.innerHTML = fibras.map(f => {
      if (!f.ok) {
        return `
          <tr>
            <td class="px-4 py-3 font-semibold text-zinc-400">${escapeHtml(f.ticker)}</td>
            <td colspan="6" class="px-4 py-3 text-[11px] text-zinc-600">${escapeHtml(f.error || 'Sin datos')}</td>
          </tr>
        `;
      }
      const nivel = f.yield_nivel || 'sin_dato';
      const colorY =
        nivel === 'atractivo' ? 'text-accent-green' :
        nivel === 'muy_alto'  ? 'text-accent-amber' :
        nivel === 'extremo'   ? 'text-accent-red'   :
        'text-zinc-300';

      const pos = f.pos_52w;
      const barra = pos == null ? '—' : `
        <div class="flex items-center gap-2 min-w-[90px]">
          <div class="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div class="h-full bg-accent-teal" style="width: ${(pos*100).toFixed(0)}%"></div>
          </div>
          <span class="text-[10px] tabular text-zinc-500">${(pos*100).toFixed(0)}%</span>
        </div>
      `;

      return `
        <tr class="hover:bg-zinc-900/40">
          <td class="px-4 py-3">
            <p class="font-semibold text-zinc-100">${escapeHtml(f.ticker)}</p>
            <p class="text-[10px] text-zinc-500 mt-0.5">${escapeHtml(f.nombre || '')}</p>
          </td>
          <td class="px-4 py-3 hidden md:table-cell text-xs text-zinc-400">${escapeHtml(f.sector || '—')}</td>
          <td class="px-4 py-3 text-right tabular text-zinc-200">${fmtMoneyMx(f.precio)}</td>
          <td class="px-4 py-3 text-right font-semibold tabular ${colorY}">${fmtPctLocal(f.dividend_yield)}</td>
          <td class="px-4 py-3 text-right hidden sm:table-cell tabular text-zinc-300">${fmtMoneyMx(f.dividend_rate)}</td>
          <td class="px-4 py-3 text-right hidden lg:table-cell tabular text-zinc-400">${fmtMcapLocal(f.market_cap)}</td>
          <td class="px-4 py-3 hidden lg:table-cell">${barra}</td>
        </tr>
      `;
    }).join('');
  }

  function renderResumen(d) {
    const yp = d.yield_fibras_prom;
    const el = $('rf-yield-prom');
    if (el) el.textContent = yp != null ? (yp * 100).toFixed(2) + '%' : '—';

    // Spread vs CETES 28
    const box = $('rf-spread-box');
    const txt = $('rf-spread-texto');
    if (box && txt) {
      const spread = d.spread_vs_cetes_28;
      if (spread != null && yp != null) {
        const cete28 = d.cetes?.tasas?.['28']?.tasa_pct;
        const signo = spread >= 0 ? '+' : '';
        const color = spread > 2 ? 'text-accent-green' : spread > 0 ? 'text-accent-blue' : 'text-accent-red';
        txt.innerHTML =
          `FIBRAS promedio <span class="font-semibold text-zinc-100">${(yp*100).toFixed(2)}%</span> · ` +
          `CETES 28d <span class="font-semibold text-zinc-100">${cete28?.toFixed(2) || '—'}%</span> · ` +
          `Spread: <span class="font-semibold tabular ${color}">${signo}${spread.toFixed(2)} pp</span>`;
        box.classList.remove('hidden');
      } else {
        box.classList.add('hidden');
      }
    }
  }

  function renderAvisos(avisos) {
    const sec = $('rf-avisos-sec');
    const ul  = $('rf-avisos');
    if (!sec || !ul) return;
    if (!avisos || !avisos.length) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    ul.innerHTML = avisos.map(a => `<li>${escapeHtml(a)}</li>`).join('');
  }

  async function cargar(forzar = false) {
    renderCurvas();   // curvas US/MX (fetch propio + cache server 12h)
    if (state.cargando) return;
    if (state.cargado && !forzar && state.data) {
      renderCetes(state.data.cetes);
      renderFibras(state.data.fibras);
      renderResumen(state.data);
      renderAvisos(state.data.avisos);
      return;
    }
    state.cargando = true;

    try {
      const res = await fetch('/api/renta-fija/mx');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      state.data = data;
      state.cargado = true;
      renderCetes(data.cetes);
      renderFibras(data.fibras);
      renderResumen(data);
      renderAvisos(data.avisos);
    } catch (e) {
      console.error('RentaFija.cargar:', e);
      const tb = $('rf-fibras-tbody');
      if (tb) tb.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-accent-red text-xs">Error: ${escapeHtml(e.message || e)}</td></tr>`;
    } finally {
      state.cargando = false;
    }
  }

  function bind() {
    $('rf-refrescar')?.addEventListener('click', () => cargar(true));
  }

  return { cargar, bind };
})();


// ===========================================================================
// FUNDAMENTALES (P/E, yield, market cap, beta, etc.)
// ===========================================================================
const Fundamentales = (() => {
  const state = {
    data:      null,
    cargando:  false,
    tickersUltimos: null,
  };

  function fmtPct(x) {
    if (x === null || x === undefined) return '—';
    return (x * 100).toFixed(2) + '%';
  }
  function fmtNum(x, d = 2) {
    if (x === null || x === undefined) return '—';
    return Number(x).toFixed(d);
  }
  function fmtMcap(x) {
    if (x === null || x === undefined || x <= 0) return '—';
    if (x >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
    if (x >= 1e9)  return '$' + (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6)  return '$' + (x / 1e6).toFixed(2) + 'M';
    return '$' + Math.round(x).toLocaleString();
  }

  function colorTxt(eval_obj) {
    const c = eval_obj?.color || 'zinc';
    const map = {
      green: 'text-accent-green',
      red:   'text-accent-red',
      amber: 'text-accent-amber',
      blue:  'text-accent-blue',
      zinc:  'text-zinc-300',
    };
    return map[c] || 'text-zinc-300';
  }

  function pos52wBar(pos) {
    if (pos === null || pos === undefined) {
      return '<span class="text-zinc-600">—</span>';
    }
    const pct = (pos * 100).toFixed(0);
    const color = pos < 0.25 ? 'bg-accent-green' : pos > 0.75 ? 'bg-accent-red' : 'bg-accent-blue';
    return `
      <div class="flex items-center gap-2 min-w-[90px]">
        <div class="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full ${color}" style="width: ${pct}%"></div>
        </div>
        <span class="text-[10px] tabular text-zinc-500">${pct}%</span>
      </div>
    `;
  }

  function renderTabla(tickers) {
    const tbody = $('fund-tbody');
    if (!tbody) return;

    if (!tickers || !tickers.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-zinc-500 text-xs">Sin datos</td></tr>';
      return;
    }

    tbody.innerHTML = tickers.map(t => {
      if (!t.ok) {
        return `
          <tr>
            <td class="px-4 py-3 font-semibold text-zinc-400">${escapeHtml(t.ticker)}</td>
            <td colspan="7" class="px-4 py-3 text-[11px] text-zinc-600">${escapeHtml(t.error || 'Sin datos disponibles')}</td>
          </tr>
        `;
      }
      const peEval = t.pe_trailing_eval || {};
      const yEval  = t.dividend_yield_eval || {};
      const bEval  = t.beta_eval || {};
      const mcap   = t.market_cap_escala || {};

      return `
        <tr class="hover:bg-zinc-900/40">
          <td class="px-4 py-3">
            <p class="font-semibold text-zinc-100">${escapeHtml(t.ticker)}</p>
            <p class="text-[10px] text-zinc-500 mt-0.5 truncate max-w-[160px]">${escapeHtml(t.nombre || '')}</p>
          </td>
          <td class="px-4 py-3 hidden md:table-cell">
            <p class="text-xs text-zinc-300">${escapeHtml(mcap.etiqueta || '—')}</p>
            <p class="text-[10px] text-zinc-500 tabular">${fmtMcap(t.market_cap)}</p>
          </td>
          <td class="px-4 py-3 text-right">
            <p class="text-xs font-semibold tabular ${colorTxt(peEval)}">${fmtNum(t.pe_trailing, 1)}</p>
            <p class="text-[10px] text-zinc-600 mt-0.5">${escapeHtml(peEval.etiqueta || '')}</p>
          </td>
          <td class="px-4 py-3 text-right hidden sm:table-cell tabular text-zinc-300">${fmtNum(t.pb, 2)}</td>
          <td class="px-4 py-3 text-right">
            <p class="text-xs font-semibold tabular ${colorTxt(yEval)}">${fmtPct(t.dividend_yield)}</p>
            <p class="text-[10px] text-zinc-600 mt-0.5">${escapeHtml(yEval.etiqueta || '')}</p>
          </td>
          <td class="px-4 py-3 text-right hidden md:table-cell">
            <p class="text-xs font-semibold tabular ${colorTxt(bEval)}">${fmtNum(t.beta, 2)}</p>
            <p class="text-[10px] text-zinc-600 mt-0.5">${escapeHtml(bEval.etiqueta || '')}</p>
          </td>
          <td class="px-4 py-3 text-right hidden lg:table-cell tabular text-zinc-300">${fmtPct(t.roe)}</td>
          <td class="px-4 py-3 hidden lg:table-cell">${pos52wBar(t.pos_52w)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderResumen(resumen) {
    const box = $('fund-resumen');
    if (!box) return;
    if (!resumen || !resumen.num_ok) {
      box.classList.add('hidden');
      const compWrap = $('fund-comportamiento-wrapper');
      if (compWrap) compWrap.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    // Helpers de formato
    const _fmtNum   = (v, d=1) => v != null ? v.toFixed(d) : 'N/D';
    const _fmtPct   = (v, d=2) => v != null ? (v * 100).toFixed(d) + '%' : 'N/D';
    const _fmtRatio = v => v != null ? v.toFixed(2) : 'N/D';
    const _fmtPctSig = (v, d=2) => {
      if (v == null) return 'N/D';
      const p = (v * 100).toFixed(d);
      return v >= 0 ? '+' + p + '%' : p + '%';
    };
    // Llenar todas las cards de resumen
    $('fund-resumen-pe').textContent     = _fmtNum(resumen.pe_promedio, 1);
    if ($('fund-resumen-pb'))     $('fund-resumen-pb').textContent     = _fmtRatio(resumen.pb_promedio);
    if ($('fund-resumen-peg'))    $('fund-resumen-peg').textContent    = _fmtRatio(resumen.peg_promedio);
    $('fund-resumen-yield').textContent  = _fmtPct(resumen.yield_promedio, 2);
    $('fund-resumen-beta').textContent   = _fmtRatio(resumen.beta_promedio);
    if ($('fund-resumen-roe'))    $('fund-resumen-roe').textContent    = _fmtPct(resumen.roe_promedio, 1);
    if ($('fund-resumen-margen')) $('fund-resumen-margen').textContent = _fmtPct(resumen.margen_neto_promedio, 1);
    $('fund-resumen-count').textContent  = `${resumen.num_ok}/${resumen.num_tickers}`;

    // --- Métricas de comportamiento (siempre disponibles) ---
    const compWrap = $('fund-comportamiento-wrapper');
    if (compWrap && resumen.num_ok > 0) {
      compWrap.classList.remove('hidden');
      // Badge de composición
      const comp = resumen.composicion || {};
      const partes = [];
      if (comp.stocks) partes.push(`${comp.stocks} acción${comp.stocks > 1 ? 'es' : ''}`);
      if (comp.etfs)   partes.push(`${comp.etfs} ETF${comp.etfs > 1 ? 's' : ''}`);
      if (comp.crypto) partes.push(`${comp.crypto} crypto`);
      const badge = $('fund-composicion-badge');
      if (badge) badge.textContent = partes.join(' · ');

      // Colorear retornos según signo
      const colorRet = v => v == null ? 'text-zinc-100' : (v >= 0 ? 'text-accent-green' : 'text-accent-red');
      const setCard = (id, valor, formatter, colorFn) => {
        const el = $(id);
        if (!el) return;
        el.textContent = formatter(valor);
        if (colorFn) {
          el.classList.remove('text-accent-green', 'text-accent-red', 'text-zinc-100');
          el.classList.add(colorFn(valor));
        }
      };
      setCard('fund-resumen-vol',     resumen.volatilidad_promedio,        v => _fmtPct(v, 1));
      setCard('fund-resumen-sharpe',  resumen.sharpe_promedio,             _fmtRatio);
      setCard('fund-resumen-sortino', resumen.sortino_promedio,            _fmtRatio);
      setCard('fund-resumen-dd',      resumen.max_drawdown_promedio,       v => _fmtPctSig(v, 1), () => 'text-accent-red');
      setCard('fund-resumen-corr',    resumen.correlacion_sp500_promedio,  _fmtRatio);
      setCard('fund-resumen-r1m',     resumen.retorno_1m_promedio,         v => _fmtPctSig(v, 2), colorRet);
      setCard('fund-resumen-rytd',    resumen.retorno_ytd_promedio,        v => _fmtPctSig(v, 2), colorRet);
      setCard('fund-resumen-r1y',     resumen.retorno_1y_promedio,         v => _fmtPctSig(v, 2), colorRet);
    }
  }

  function renderAvisos(avisos) {
    const ul = $('fund-avisos');
    const box = $('fund-avisos-box');
    if (!ul || !box) return;
    if (!avisos || !avisos.length) {
      box.classList.add('hidden');
      ul.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    ul.innerHTML = avisos.map(a => `<li>${escapeHtml(a)}</li>`).join('');
  }

  async function cargar() {
    const tickers = (typeof leerPortafolioGuardado === 'function') ? (leerPortafolioGuardado() || []) : [];
    if (!tickers.length) {
      renderTabla([]);
      $('fund-resumen')?.classList.add('hidden');
      $('fund-avisos-box')?.classList.add('hidden');
      return;
    }

    // Cache: si los tickers no cambiaron, no refetch
    if (state.tickersUltimos &&
        state.tickersUltimos.length === tickers.length &&
        state.tickersUltimos.every(t => tickers.includes(t))) {
      if (state.data) {
        renderTabla(state.data.tickers);
        renderResumen(state.data.resumen);
        renderAvisos(state.data.avisos);
      }
      return;
    }

    if (state.cargando) return;
    state.cargando = true;

    const tbody = $('fund-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-zinc-500 text-xs">Cargando fundamentales…</td></tr>';

    try {
      const res = await fetch('/api/fundamentals/portafolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');

      state.data = data;
      state.tickersUltimos = tickers.slice();
      renderTabla(data.tickers);
      renderResumen(data.resumen);
      renderAvisos(data.avisos);
    } catch (e) {
      console.error('Fundamentales.cargar:', e);
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-8 text-center text-accent-red text-xs">Error: ${escapeHtml(e.message || e)}</td></tr>`;
    } finally {
      state.cargando = false;
    }
  }

  function refrescar() {
    state.tickersUltimos = null;
    state.data = null;
    cargar();
  }

  function bind() {
    $('fund-refrescar')?.addEventListener('click', refrescar);
  }

  return { cargar, bind, refrescar };
})();


// ============================================================
// MÓDULO: BACKTEST HISTÓRICO
// ============================================================
const Backtest = (() => {
  let chart = null;
  function bind() {
    $('bt-correr')?.addEventListener('click', correr);
  }
  function obtenerPortafolio() {
    const tickers = leerPortafolioGuardado() || [];
    const pesosFrac = leerPesosGuardados() || {};
    const pesos = {};
    Object.entries(pesosFrac).forEach(([t, v]) => { pesos[t] = v * 100; });
    return { tickers, pesos };
  }
  async function correr() {
    const { tickers, pesos } = obtenerPortafolio();
    if (!tickers.length) {
      $('bt-error').innerHTML = 'Aún no tienes portafolio guardado. <a href="#" onclick="document.querySelector(\'.nav-tab[data-vista=portafolio]\').click(); return false;" class="text-accent-blue underline">Arma uno en 30 segundos →</a>';
      $('bt-error').classList.remove('hidden');
      return;
    }
    $('bt-error').classList.add('hidden');
    $('bt-resultado').classList.add('hidden');
    const btn = $('bt-correr');
    btn.disabled = true;
    btn.textContent = 'Corriendo…';
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ tickers, pesos, periodo: $('bt-periodo').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      render(data);
    } catch (e) {
      $('bt-error').textContent = e.message || String(e);
      $('bt-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Correr backtest';
    }
  }
  function render(d) {
    const m = d.metricas || {};
    $('bt-ret').textContent    = (m.retorno_total_pct >= 0 ? '+' : '') + (m.retorno_total_pct ?? 0).toFixed(1) + '%';
    $('bt-ret').className      = 'text-sm font-semibold tabular ' + (m.retorno_total_pct >= 0 ? 'text-accent-green' : 'text-accent-red');
    $('bt-dd').textContent     = (m.max_drawdown_pct ?? 0).toFixed(1) + '%';
    $('bt-sharpe').textContent = (m.sharpe_ratio ?? 0).toFixed(2);
    // Comparación con benchmarks
    const cmp = d.metricas_benchmarks || {};
    const lines = Object.entries(cmp).map(([label, m2]) => {
      const diff = (m.retorno_total_pct || 0) - (m2.retorno_total_pct || 0);
      const cls = diff >= 0 ? 'text-accent-green' : 'text-accent-red';
      return `<div class="flex justify-between"><span>${escapeHtml(label)}</span>
        <span class="tabular">${(m2.retorno_total_pct||0).toFixed(1)}% <span class="${cls}">(${diff>=0?'+':''}${diff.toFixed(1)}pp)</span></span></div>`;
    }).join('');
    $('bt-bm-comparison').innerHTML = lines;
    // Drawdowns top
    const dds = (d.drawdowns_top || []).slice(0,3).map((dd, i) => `
      <div class="flex justify-between bg-zinc-900/30 rounded px-2 py-1 mt-1">
        <span>#${i+1} ${dd.fecha_pico} → ${dd.fecha_valle}</span>
        <span class="text-accent-red tabular">${dd.magnitud_pct}%</span>
      </div>`).join('');
    $('bt-drawdowns').innerHTML = dds ? `<p class="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Drawdowns mayores</p>${dds}` : '';
    $('bt-resultado').classList.remove('hidden');
    // Chart
    const ctx = $('bt-chart').getContext('2d');
    const labels = d.serie_valor.map(p => p.fecha);
    const datasets = [{
      label: 'Tu portafolio',
      data: d.serie_valor.map(p => p.valor),
      borderColor: MP_COLOR.sello, backgroundColor: 'rgba(156,93,18,0.1)',
      borderWidth: 2, tension: 0.2, pointRadius: 0, fill: true,
    }];
    Object.entries(d.serie_benchmarks || {}).forEach(([label, serie], i) => {
      const colors = [MP_COLOR.sello, MP_COLOR.sello];
      datasets.push({
        label, data: serie.map(p => p.valor),
        borderColor: colors[i % colors.length],
        borderWidth: 1.5, tension: 0.2, pointRadius: 0, borderDash: [4,4],
      });
    });
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: MP_GRAFICA.base({
        plugins: { legend: MP_GRAFICA.leyenda(true), tooltip: MP_GRAFICA.tooltip() },
        scales: { x: MP_GRAFICA.ejeTiempo(), y: MP_GRAFICA.ejeValor() },
      }),
    });
  }
  return { bind };
})();


// ============================================================
// MÓDULO: STRESS TEST
// ============================================================
const StressTest = (() => {
  function bind() {
    $('st-correr')?.addEventListener('click', correr);
  }
  async function correr() {
    const tickers = leerPortafolioGuardado() || [];
    const pesosFrac = leerPesosGuardados() || {};
    const pesos = {};
    Object.entries(pesosFrac).forEach(([t, v]) => { pesos[t] = v * 100; });
    if (!tickers.length) {
      $('st-error').innerHTML = 'Aún no tienes portafolio guardado. <a href="#" onclick="document.querySelector(\'.nav-tab[data-vista=portafolio]\').click(); return false;" class="text-accent-red underline">Arma uno en 30 segundos →</a>';
      $('st-error').classList.remove('hidden');
      return;
    }
    $('st-error').classList.add('hidden');
    $('st-resultado').classList.add('hidden');
    const btn = $('st-correr');
    btn.disabled = true;
    btn.textContent = 'Calculando…';
    try {
      const res = await fetch('/api/stress-test', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ tickers, pesos, escenario: $('st-escenario').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      render(data);
    } catch (e) {
      $('st-error').textContent = e.message || String(e);
      $('st-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Aplicar shock';
    }
  }
  function render(d) {
    $('st-impacto').textContent  = (d.impacto_total_pct >= 0 ? '+' : '') + d.impacto_total_pct.toFixed(2) + '%';
    $('st-duracion').textContent = `${d.escenario.nombre} · ${d.escenario.duracion}`;
    const filas = (d.impactos || []).map(i => {
      const cls = i.shock_pct >= 0 ? 'text-accent-green' : 'text-accent-red';
      return `<div class="flex items-center justify-between text-[11px] bg-zinc-900/30 rounded px-2 py-1">
        <div class="flex-1 min-w-0">
          <span class="font-mono text-zinc-200">${escapeHtml(i.ticker)}</span>
          <span class="text-zinc-600 ml-1">${escapeHtml(i.sector || '')}</span>
        </div>
        <div class="text-right">
          <span class="${cls} font-semibold tabular">${i.shock_pct>=0?'+':''}${i.shock_pct.toFixed(1)}%</span>
          <span class="text-zinc-600 ml-2 tabular">${i.peso_pct.toFixed(0)}% peso</span>
        </div>
      </div>`;
    }).join('');
    $('st-tabla').innerHTML = filas;
    $('st-resultado').classList.remove('hidden');
  }
  return { bind };
})();


// ============================================================
// MÓDULO: BROKERS (comparativa MX)
// ============================================================
const Brokers = (() => {
  let cache = null;
  async function cargar() {
    if (cache) return cache;
    try {
      const res = await fetch('/api/brokers-mx');
      const data = await res.json();
      cache = data.brokers || [];
    } catch { cache = []; }
    return cache;
  }
  // Mapping ID broker → color del avatar (en lugar de emoji)
  const _BROKER_COLORS = {
    gbm:      MP_COLOR.supPanel,
    kuspit:   MP_COLOR.supPanel,
    hapi:     MP_COLOR.supPanel,
    bursanet: MP_COLOR.supPanel,
    actinver: MP_COLOR.supPanel,
    vector:   MP_COLOR.supPanel,
    schwab:   MP_COLOR.supPanel,
    ibkr:     MP_COLOR.supPanel,
  };
  function _brokerAvatar(b, size = 28) {
    const grad = _BROKER_COLORS[b.id] || MP_COLOR.supPanel;
    const initial = (b.nombre || 'X').charAt(0).toUpperCase();
    return `<span class="inline-flex items-center justify-center rounded-md font-semibold text-zinc-100 text-xs shrink-0" style="width:${size}px;height:${size}px;background:${grad};">${initial}</span>`;
  }

  function renderTabla(brokers) {
    if (!brokers.length) return '<p class="text-xs text-zinc-500">Sin datos.</p>';
    const headers = ['Broker', 'Tipos', 'Mín. apertura', 'Comisión MX', 'Comisión US', 'Spread FX', 'Ideal para'];
    const rows = brokers.map(b => `
      <tr class="border-b border-surface-border/50">
        <td class="py-2 px-3 text-xs">
          <div class="flex items-center gap-2.5">
            ${_brokerAvatar(b, 26)}
            <span class="font-semibold text-zinc-100">${escapeHtml(b.nombre)}</span>
          </div>
        </td>
        <td class="py-2 px-3 text-[10px] text-zinc-400">${(b.tipo || []).join(', ')}</td>
        <td class="py-2 px-3 text-xs text-zinc-300 tabular">$${(b.minimo_apertura_mxn || 0).toLocaleString()}</td>
        <td class="py-2 px-3 text-xs text-zinc-300 tabular">${b.comision_mx_pct == null ? '—' : b.comision_mx_pct + '%'}</td>
        <td class="py-2 px-3 text-xs text-zinc-300 tabular">${b.comision_us_usd == null ? '—' : '$' + b.comision_us_usd + ' USD'}</td>
        <td class="py-2 px-3 text-xs text-zinc-300 tabular">${(b.tipo_cambio_spread_pct || 0)}%</td>
        <td class="py-2 px-3 text-[10px] text-zinc-400 leading-relaxed max-w-xs">${escapeHtml(b.ideal_para)}</td>
      </tr>`).join('');
    return `<table class="w-full text-left">
      <thead><tr class="border-b border-surface-border">
        ${headers.map(h => `<th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  async function comparar(ticker, monto) {
    try {
      const res = await fetch(`/api/brokers-mx/comparar/${encodeURIComponent(ticker)}?monto=${monto}`);
      const data = await res.json();
      const filas = (data.comparativa || []).map((c, i) => `
        <div class="flex items-center justify-between py-1.5 ${i===0 ? 'bg-accent-green/10 border-accent-green/20 px-2 rounded border' : ''}">
          <span>${_brokerAvatar({id: c.id, nombre: c.broker}, 22)} <span class="font-semibold ${i===0?'text-accent-green':'text-zinc-200'}">${escapeHtml(c.broker)}</span></span>
          <span class="text-zinc-400 tabular">Comisión: <span class="${i===0?'text-accent-green':'text-zinc-200'} font-semibold">$${c.comision_estimada_mxn.toFixed(2)}</span></span>
        </div>${c.nota ? `<p class="text-[10px] text-zinc-600 -mt-1 mb-1 ml-6">${escapeHtml(c.nota)}</p>` : ''}`).join('');
      $('brokers-comparativa-resultado').innerHTML = filas
        ? `<p class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Comprar $${monto.toLocaleString()} de ${escapeHtml(ticker)}:</p>${filas}`
        : '<p class="text-zinc-500">Ningún broker ofrece ese ticker.</p>';
    } catch (e) {
      $('brokers-comparativa-resultado').innerHTML = `<p class="text-accent-red">Error: ${e.message}</p>`;
    }
  }
  async function calcularReb() {
    const tickers = leerPortafolioGuardado() || [];
    if (!tickers.length) { $('reb-brokers-list').innerHTML = '<p class="text-zinc-500">Primero guarda un portafolio.</p>'; return; }
    const html = await Promise.all(tickers.slice(0, 8).map(async t => {
      try {
        const res = await fetch(`/api/brokers-mx/comparar/${encodeURIComponent(t)}?monto=10000`);
        const data = await res.json();
        const top = (data.comparativa || [])[0];
        return top
          ? `<div class="flex justify-between items-center bg-zinc-900/30 rounded px-3 py-2">
              <span class="font-mono text-zinc-200">${escapeHtml(t)}</span>
              <span class="text-zinc-400 inline-flex items-center gap-1.5">→ ${_brokerAvatar({id: top.id, nombre: top.broker}, 18)} <span class="${'text-accent-teal'} font-semibold">${escapeHtml(top.broker)}</span> <span class="text-[10px] text-zinc-500">($${top.comision_estimada_mxn.toFixed(2)} comisión en $10k)</span></span>
            </div>`
          : '';
      } catch { return ''; }
    }));
    $('reb-brokers-list').innerHTML = html.join('') || '<p class="text-zinc-500">Sin datos.</p>';
  }
  function bind() {
    $('brokers-toggle')?.addEventListener('click', async () => {
      const tabla = $('brokers-tabla');
      const cmp = $('brokers-comparador');
      const visible = !tabla.classList.contains('hidden');
      if (visible) {
        tabla.classList.add('hidden'); cmp.classList.add('hidden');
        $('brokers-toggle').textContent = 'Mostrar tabla';
      } else {
        const brokers = await cargar();
        tabla.innerHTML = renderTabla(brokers);
        tabla.classList.remove('hidden'); cmp.classList.remove('hidden');
        $('brokers-toggle').textContent = 'Ocultar tabla';
      }
    });
    $('brokers-comparar-btn')?.addEventListener('click', () => {
      const t = ($('brokers-ticker').value || '').trim().toUpperCase();
      const m = parseFloat($('brokers-monto').value || 10000);
      if (t) comparar(t, m);
    });
    $('reb-brokers-calc')?.addEventListener('click', calcularReb);
  }
  return { bind };
})();


// ============================================================
// MÓDULO: DECLARACIÓN SAT
// ============================================================
const DeclaracionSat = (() => {
  function bind() {
    $('sat-generar')?.addEventListener('click', generar);
  }
  async function generar() {
    let txs = [];
    try { txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]'); } catch {}
    const ejercicio = parseInt($('sat-ejercicio').value);
    $('sat-error').classList.add('hidden');
    $('sat-resultado').classList.add('hidden');
    if (!txs.length) {
      $('sat-error').textContent = 'No tienes transacciones registradas. Captura tus compras y ventas primero.';
      $('sat-error').classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch('/api/sat/declaracion-anual', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ transacciones: txs, ejercicio })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      render(data);
    } catch (e) {
      $('sat-error').textContent = e.message || String(e);
      $('sat-error').classList.remove('hidden');
    }
  }
  function render(d) {
    const t = d.totales;
    const fmt = v => '$' + (v || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    const guia = (d.guia_sat || []).map(g => `<li class="text-[11px] text-zinc-400 leading-relaxed mb-1.5">${escapeHtml(g)}</li>`).join('');
    $('sat-resultado').innerHTML = `
      <div class="grid sm:grid-cols-4 gap-3 mb-5">
        <div class="bg-zinc-900/40 rounded-lg p-3 text-center">
          <p class="text-[9px] uppercase tracking-wider text-zinc-500">Ganancias realizadas</p>
          <p class="text-lg font-bold tabular text-accent-green mt-1">${fmt(t.ganancias_realizadas_mxn)}</p>
        </div>
        <div class="bg-zinc-900/40 rounded-lg p-3 text-center">
          <p class="text-[9px] uppercase tracking-wider text-zinc-500">Pérdidas (deducibles)</p>
          <p class="text-lg font-bold tabular text-accent-red mt-1">${fmt(Math.abs(t.perdidas_realizadas_mxn))}</p>
        </div>
        <div class="bg-zinc-900/40 rounded-lg p-3 text-center">
          <p class="text-[9px] uppercase tracking-wider text-zinc-500">Utilidad neta</p>
          <p class="text-lg font-bold tabular text-zinc-100 mt-1">${fmt(t.utilidad_neta_mxn)}</p>
        </div>
        <div class="bg-accent-amber/10 border border-accent-amber/20 rounded-lg p-3 text-center">
          <p class="text-[9px] uppercase tracking-wider text-accent-amber">ISR a pagar (10%)</p>
          <p class="text-lg font-bold tabular text-accent-amber mt-1">${fmt(t.isr_a_pagar_mxn)}</p>
        </div>
      </div>
      <div class="bg-zinc-900/30 border border-surface-border rounded-lg p-4 mb-3">
        <p class="text-[10px] uppercase tracking-wider text-accent-amber font-semibold mb-3">Guía paso a paso para tu declaración SAT ${d.ejercicio}</p>
        <ol class="list-decimal list-inside space-y-0.5">${guia}</ol>
      </div>
      <p class="text-[10px] text-zinc-600 italic leading-relaxed">${escapeHtml(d.disclaimer)}</p>`;
    $('sat-resultado').classList.remove('hidden');
  }
  return { bind };
})();


// ============================================================
// MÓDULO: APORTACIONES RECURRENTES (DCA)
// ============================================================
const Aportaciones = (() => {
  let chart = null;
  function bind() {
    $('dca-simular')?.addEventListener('click', simular);
  }
  async function simular() {
    const body = {
      monto_periodico: parseFloat($('dca-monto').value || 0),
      frecuencia: $('dca-frecuencia').value,
      anios: parseFloat($('dca-anios').value || 0),
      retorno_anual_pct: parseFloat($('dca-retorno').value || 0),
      inflacion_anual_pct: parseFloat($('dca-inflacion').value || 0),
      aporte_inicial: parseFloat($('dca-inicial').value || 0),
    };
    try {
      const res = await fetch('/api/aportaciones/simular', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      render(data);
    } catch (e) {
      alert('Error: ' + (e.message || e));
    }
  }
  function render(d) {
    const fmt = v => '$' + Math.round(v).toLocaleString('en-US');
    $('dca-aportado').textContent = fmt(d.totales.aportado_total);
    $('dca-final').textContent    = fmt(d.totales.valor_final_nominal);
    $('dca-real').textContent     = fmt(d.totales.valor_final_real);
    $('dca-mult').textContent     = d.totales.multiplicador.toFixed(1) + 'x';
    $('dca-msg').innerHTML = `Aportando <span class="text-accent-green font-semibold">${fmt(d.parametros.monto_periodico)} ${d.parametros.frecuencia}</span> durante ${d.parametros.anios} años a ${d.parametros.retorno_anual_pct}% anual real, terminas con <span class="text-accent-green font-semibold">${fmt(d.totales.valor_final_nominal)}</span> nominales o <span class="text-accent-amber font-semibold">${fmt(d.totales.valor_final_real)}</span> ajustado por inflación.`;
    $('dca-resultado').classList.remove('hidden');

    // Chart
    const ctx = $('dca-chart').getContext('2d');
    const labels = d.serie.map(p => p.anio.toFixed(1));
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Valor nominal', data: d.serie.map(p => p.valor),
          ...MP_GRAFICA.serie(MP_GRAFICA.tinta1) },
        { label: 'Valor real (ajustado por inflación)', data: d.serie.map(p => p.valor_real),
          ...MP_GRAFICA.serie(MP_GRAFICA.sello, { borderWidth: 1.5, borderDash: [4, 4] }) },
        { label: 'Aportado', data: d.serie.map(p => p.aportado),
          ...MP_GRAFICA.referencia({ borderDash: [1, 3] }) },
      ]},
      options: MP_GRAFICA.base({
        plugins: { legend: MP_GRAFICA.leyenda(true), tooltip: MP_GRAFICA.tooltip() },
        scales: {
          x: MP_GRAFICA.ejeTiempo({ title: { display: true, text: 'Años', color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 } } }),
          y: MP_GRAFICA.ejeValor({ ticks: { color: MP_GRAFICA.tinta3, font: { family: MP_GRAFICA.mono, size: 9.5 }, maxTicksLimit: 5, padding: 8, callback: v => '$' + (v / 1000).toFixed(0) + 'k' } }),
        },
      }),
    });
  }
  return { bind };
})();


// ============================================================
// MÓDULO: PORTFOLIO MANAGER (multi-portafolio)
// ============================================================
const PortfolioManager = (() => {
  const META_KEY = 'miPortafolio.portfolios.v2';
  // Paleta de colores para avatares (en lugar de emojis)
  const COLORS = [
    { id: 'green',   gradient: MP_COLOR.supPanel, name: 'Verde' },
    { id: 'blue',    gradient: MP_COLOR.supPanel, name: 'Azul' },
    { id: 'purple',  gradient: MP_COLOR.supPanel, name: 'Púrpura' },
    { id: 'amber',   gradient: MP_COLOR.supPanel, name: 'Ámbar' },
    { id: 'rose',    gradient: MP_COLOR.supPanel, name: 'Rosa' },
    { id: 'teal',    gradient: MP_COLOR.supPanel, name: 'Teal' },
    { id: 'orange',  gradient: MP_COLOR.supPanel, name: 'Naranja' },
    { id: 'indigo',  gradient: MP_COLOR.supPanel, name: 'Índigo' },
    { id: 'slate',   gradient: MP_COLOR.supPanel, name: 'Gris' },
    { id: 'crimson', gradient: MP_COLOR.supPanel, name: 'Carmesí' },
  ];
  function _colorFromId(id) {
    return COLORS.find(c => c.id === id) || COLORS[0];
  }
  // ── Avatares de animalitos (estilo Netflix) ──
  // Cada portafolio guarda un `animal`. Reemplazan al viejo color+inicial.
  const ANIMALS = [
    { id: 'zorro', name: 'Zorro', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#FDEBDC"/><path d="M15 33 18 12 33 27Z" fill="#D9641F"/><path d="M49 33 46 12 31 27Z" fill="#D9641F"/><path d="M19 27 20 17 27 25Z" fill="#F6C9A8"/><path d="M45 27 44 17 37 25Z" fill="#F6C9A8"/><path d="M32 22c10 0 15 8 15 16 0 9-7 15-15 15s-15-6-15-15c0-8 5-16 15-16Z" fill="#E8792B"/><path d="M32 37c6 0 11 4 11 10 0 4-5 8-11 8s-11-4-11-8c0-6 5-10 11-10Z" fill="#FFF4EA"/><circle cx="25" cy="36" r="2.8" fill="#2B2118"/><circle cx="39" cy="36" r="2.8" fill="#2B2118"/><path d="M32 45l3.5 3-3.5 2.5-3.5-2.5Z" fill="#2B2118"/></svg>` },
    { id: 'panda', name: 'Panda', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#EEF0F3"/><circle cx="20" cy="20" r="8" fill="#23232A"/><circle cx="44" cy="20" r="8" fill="#23232A"/><circle cx="32" cy="36" r="18" fill="#FFFFFF"/><ellipse cx="24" cy="33" rx="5" ry="6.5" fill="#23232A" transform="rotate(-18 24 33)"/><ellipse cx="40" cy="33" rx="5" ry="6.5" fill="#23232A" transform="rotate(18 40 33)"/><circle cx="24" cy="34" r="2" fill="#FFFFFF"/><circle cx="40" cy="34" r="2" fill="#FFFFFF"/><ellipse cx="32" cy="42" rx="3" ry="2.2" fill="#23232A"/></svg>` },
    { id: 'leon', name: 'León', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#FDF0DA"/><g fill="#C07A22"><circle cx="32" cy="13" r="4.5"/><circle cx="13" cy="22" r="4.5"/><circle cx="51" cy="22" r="4.5"/><circle cx="13" cy="46" r="4.5"/><circle cx="51" cy="46" r="4.5"/><circle cx="32" cy="55" r="4.5"/></g><circle cx="32" cy="34" r="19" fill="#C9852B"/><circle cx="32" cy="34" r="13" fill="#F2B84B"/><circle cx="26" cy="32" r="2.4" fill="#3A2A12"/><circle cx="38" cy="32" r="2.4" fill="#3A2A12"/><path d="M32 36l3 3h-6Z" fill="#8A5A18"/><path d="M32 39c0 3 3 3 4 1M32 39c0 3-3 3-4 1" stroke="#8A5A18" stroke-width="1.3" fill="none"/></svg>` },
    { id: 'tigre', name: 'Tigre', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#FDE9D8"/><path d="M18 22 16 12 26 20Z" fill="#D9781F"/><path d="M46 22 48 12 38 20Z" fill="#D9781F"/><circle cx="32" cy="34" r="18" fill="#F09A3E"/><path d="M32 16v8M22 18l2 7M42 18l-2 7" stroke="#2B2118" stroke-width="2.2" stroke-linecap="round"/><path d="M15 32l6 2M49 32l-6 2" stroke="#2B2118" stroke-width="2.2" stroke-linecap="round"/><path d="M32 38c6 0 9 3 9 7 0 4-4 6-9 6s-9-2-9-6c0-4 3-7 9-7Z" fill="#FFF3E6"/><circle cx="26" cy="33" r="2.6" fill="#2B2118"/><circle cx="38" cy="33" r="2.6" fill="#2B2118"/><path d="M32 43l3 2.5-3 2-3-2Z" fill="#2B2118"/></svg>` },
    { id: 'koala', name: 'Koala', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#EDEFF2"/><circle cx="15" cy="24" r="9" fill="#9AA2AC"/><circle cx="49" cy="24" r="9" fill="#9AA2AC"/><circle cx="15" cy="24" r="4.5" fill="#C9A3BE"/><circle cx="49" cy="24" r="4.5" fill="#C9A3BE"/><circle cx="32" cy="36" r="16" fill="#B4BBC4"/><circle cx="25" cy="34" r="2.6" fill="#26262B"/><circle cx="39" cy="34" r="2.6" fill="#26262B"/><path d="M32 38c4 0 7 3 7 6 0 3-3 5-7 5s-7-2-7-5c0-3 3-6 7-6Z" fill="#3D3D42"/></svg>` },
    { id: 'buho', name: 'Búho', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#F3ECDF"/><path d="M16 20 20 10 26 20Z" fill="#8A5A2B"/><path d="M48 20 44 10 38 20Z" fill="#8A5A2B"/><path d="M32 16c12 0 18 9 18 19 0 11-8 18-18 18s-18-7-18-18c0-10 6-19 18-19Z" fill="#A9743C"/><circle cx="24" cy="32" r="8" fill="#F6EFE2"/><circle cx="40" cy="32" r="8" fill="#F6EFE2"/><circle cx="24" cy="32" r="3.6" fill="#2B2118"/><circle cx="40" cy="32" r="3.6" fill="#2B2118"/><path d="M32 38l4 5h-8Z" fill="#E8A33D"/></svg>` },
    { id: 'pinguino', name: 'Pingüino', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#E6EEF5"/><ellipse cx="32" cy="36" rx="17" ry="20" fill="#2B2B33"/><ellipse cx="32" cy="40" rx="11" ry="15" fill="#FFFFFF"/><circle cx="26" cy="27" r="3.6" fill="#FFFFFF"/><circle cx="38" cy="27" r="3.6" fill="#FFFFFF"/><circle cx="26" cy="27" r="1.8" fill="#2B2B33"/><circle cx="38" cy="27" r="1.8" fill="#2B2B33"/><path d="M32 31l5 3-5 3-5-3Z" fill="#F2A03C"/></svg>` },
    { id: 'conejo', name: 'Conejo', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#EBE2F2"/><rect x="22" y="6" width="8" height="26" rx="4" fill="#FFFFFF"/><rect x="34" y="6" width="8" height="26" rx="4" fill="#FFFFFF"/><rect x="24" y="9" width="4" height="20" rx="2" fill="#F3B9CC"/><rect x="36" y="9" width="4" height="20" rx="2" fill="#F3B9CC"/><circle cx="32" cy="40" r="15" fill="#FFFFFF"/><circle cx="26" cy="38" r="2.4" fill="#2B2B2E"/><circle cx="38" cy="38" r="2.4" fill="#2B2B2E"/><path d="M32 43l2.5 2-2.5 2-2.5-2Z" fill="#E5789F"/></svg>` },
    { id: 'rana', name: 'Rana', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#E6F2DC"/><path d="M32 24c12 0 18 7 18 15 0 9-8 14-18 14s-18-5-18-14c0-8 6-15 18-15Z" fill="#5FA845"/><circle cx="22" cy="20" r="9" fill="#6FBB50"/><circle cx="42" cy="20" r="9" fill="#6FBB50"/><circle cx="22" cy="19" r="4.2" fill="#FFFFFF"/><circle cx="42" cy="19" r="4.2" fill="#FFFFFF"/><circle cx="22" cy="20" r="2" fill="#1F2E17"/><circle cx="42" cy="20" r="2" fill="#1F2E17"/><path d="M22 41c4 5 16 5 20 0" stroke="#2E4A22" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>` },
    { id: 'gato', name: 'Gato', svg: `<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#F0ECF5"/><path d="M16 18 18 38 32 28Z" fill="#6B6470"/><path d="M48 18 46 38 32 28Z" fill="#6B6470"/><path d="M20 24 21 34 28 28Z" fill="#E3A6B6"/><path d="M44 24 43 34 36 28Z" fill="#E3A6B6"/><circle cx="32" cy="38" r="16" fill="#7A7383"/><path d="M25 35c1.5-2 4-2 5 0M34 35c1.5-2 4-2 5 0" stroke="#26232B" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M32 41l2.5 2-2.5 2-2.5-2Z" fill="#E5789F"/><path d="M28 42h-8M36 42h8" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round"/></svg>` },
  ];
  function _animalFromId(id) { return ANIMALS.find(a => a.id === id) || ANIMALS[0]; }
  function _animalParaPortafolio(p) {
    if (p && p.animal) return p.animal;
    // Migración desde el viejo `color` (ambas listas son de 10 → mapeo por índice)
    if (p && p.color) {
      const idx = COLORS.findIndex(c => c.id === p.color);
      if (idx >= 0) return ANIMALS[idx].id;
    }
    return ANIMALS[0].id;
  }
  function _avatarHTML(animalId, sizeClass = 'w-6 h-6') {
    return `<span class="inline-flex items-center justify-center ${sizeClass} rounded-lg overflow-hidden shrink-0">${_animalFromId(animalId).svg}</span>`;
  }

  function leerMeta() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { raw = null; }
    if (!raw) {
      raw = {
        activo: 'principal',
        portfolios: { principal: { nombre: 'Portafolio principal', color: 'green', creado: new Date().toISOString() } }
      };
      guardarMeta(raw);
    }
    // Migración: asegurar color (legacy) y un animal (avatar nuevo) por portafolio
    Object.values(raw.portfolios).forEach(p => {
      if (!p.color) p.color = 'green';
      if (!p.animal) p.animal = _animalParaPortafolio(p);
    });
    return raw;
  }
  function guardarMeta(d) { try { localStorage.setItem(META_KEY, JSON.stringify(d)); } catch {} }
  function activoId() { return leerMeta().activo; }
  function activoData() { const m = leerMeta(); return m.portfolios[m.activo] || { nombre: 'Principal', animal: 'zorro' }; }

  function _snapshotActual() {
    return {
      tickers: localStorage.getItem('miPortafolio.tickers.v1') || '[]',
      pesos:   localStorage.getItem('miPortafolio.pesos.v1')   || '{}',
      txs:     localStorage.getItem('miPortafolio.transacciones.v1') || '[]',
    };
  }
  function _aplicarSnapshot(s) {
    localStorage.setItem('miPortafolio.tickers.v1', s.tickers || '[]');
    localStorage.setItem('miPortafolio.pesos.v1',   s.pesos   || '{}');
    localStorage.setItem('miPortafolio.transacciones.v1', s.txs || '[]');
  }
  function _persistirHaciaId(id) {
    const s = _snapshotActual();
    localStorage.setItem(`miPortafolio.${id}.tickers.v1`, s.tickers);
    localStorage.setItem(`miPortafolio.${id}.pesos.v1`,   s.pesos);
    localStorage.setItem(`miPortafolio.${id}.transacciones.v1`, s.txs);
  }
  function _cargarDesdeId(id) {
    _aplicarSnapshot({
      tickers: localStorage.getItem(`miPortafolio.${id}.tickers.v1`) || '[]',
      pesos:   localStorage.getItem(`miPortafolio.${id}.pesos.v1`)   || '{}',
      txs:     localStorage.getItem(`miPortafolio.${id}.transacciones.v1`) || '[]',
    });
  }

  function cambiar(idDestino) {
    const m = leerMeta();
    if (!m.portfolios[idDestino] || idDestino === m.activo) return;
    _persistirHaciaId(m.activo);
    _cargarDesdeId(idDestino);
    m.activo = idDestino;
    guardarMeta(m);
    location.reload();
  }
  function crear(nombre, animalId) {
    nombre = (nombre || '').trim().slice(0, 30);
    if (!nombre) return null;
    const id = 'p_' + Date.now().toString(36);
    const m = leerMeta();
    _persistirHaciaId(m.activo);
    m.portfolios[id] = { nombre, animal: animalId || ANIMALS[0].id, creado: new Date().toISOString() };
    m.activo = id;
    guardarMeta(m);
    _aplicarSnapshot({ tickers: '[]', pesos: '{}', txs: '[]' });
    location.reload();
  }
  /* Renombrar y cambiar el avatar de uno que ya existe. Faltaba: se podía
     crear, cambiar y borrar, pero un nombre mal escrito solo se arreglaba
     borrando el portafolio entero —con sus tickers y transacciones dentro—. */
  function editar(id, nombre, animalId) {
    const m = leerMeta();
    const p = m.portfolios[id];
    if (!p) return false;
    const n = (nombre || '').trim().slice(0, 30);
    if (n) p.nombre = n;
    if (animalId) p.animal = animalId;
    guardarMeta(m);
    renderHeader();
    return true;
  }

  function eliminar(id) {
    const m = leerMeta();
    if (id === 'principal' || !m.portfolios[id]) return;
    if (id === m.activo) {
      _cargarDesdeId('principal');
      m.activo = 'principal';
    }
    delete m.portfolios[id];
    localStorage.removeItem(`miPortafolio.${id}.tickers.v1`);
    localStorage.removeItem(`miPortafolio.${id}.pesos.v1`);
    localStorage.removeItem(`miPortafolio.${id}.transacciones.v1`);
    guardarMeta(m);
    location.reload();
  }

  function renderHeader() {
    const a = activoData();
    const av = $('port-active-avatar');
    if (av) {
      av.style.background = 'none';
      av.classList.add('overflow-hidden');
      av.innerHTML = _animalFromId(_animalParaPortafolio(a)).svg;
    }
    if ($('port-active-nombre')) $('port-active-nombre').textContent = a.nombre || 'Principal';
  }
  /* Panel de portafolios. Antes esto era un desplegable de 256px pegado bajo el
     botón, con filas de 12px y la papelera escondida tras :hover —invisible en
     una pantalla táctil—. Ahora es un panel del sistema: se ve el avatar
     grande, se cambia de portafolio con un toque y cada uno se puede editar.
     La edición y la creación comparten formulario: son el mismo acto salvo por
     qué se hace al aceptar. */
  function _cerrarPanel() {
    const m = document.getElementById('port-panel');
    if (m) m.remove();
    document.removeEventListener('keydown', _escPanel);
  }
  function _escPanel(e) { if (e.key === 'Escape') _cerrarPanel(); }

  function _filaHTML(id, p, activo) {
    return `
      <div class="mp-perfil${activo ? ' activo' : ''}">
        <button type="button" class="mp-perfil-elegir" data-cambiar="${id}"
                ${activo ? 'aria-current="true"' : ''}>
          <span class="mp-perfil-avatar">${_animalFromId(_animalParaPortafolio(p)).svg}</span>
          <span class="mp-perfil-nom">${escapeHtml(p.nombre)}</span>
          ${activo ? '<span class="mp-perfil-marca">En uso</span>' : ''}
        </button>
        <button type="button" class="mp-perfil-accion" data-editar="${id}"
                aria-label="Editar ${escapeHtml(p.nombre)}" title="Editar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
        </button>
        ${id !== 'principal' ? `
        <button type="button" class="mp-perfil-accion borrar" data-borrar="${id}"
                aria-label="Eliminar ${escapeHtml(p.nombre)}" title="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>
          </svg>
        </button>` : ''}
      </div>`;
  }

  function abrirPanel() {
    _cerrarPanel();
    const m = leerMeta();
    const filas = Object.entries(m.portfolios)
      .map(([id, p]) => _filaHTML(id, p, id === m.activo)).join('');
    document.body.insertAdjacentHTML('beforeend', `
      <div id="port-panel" class="mp-modal" role="dialog" aria-modal="true" aria-label="Tus portafolios">
        <div class="mp-modal-caja">
          <div class="mp-modal-cuerpo">
            <div class="mp-modal-cabecera">
              <div>
                <p class="mp-modal-etq">Tus portafolios</p>
                <h2 class="mp-modal-titulo">Cambia o edita</h2>
              </div>
              <button type="button" class="mp-modal-cerrar" data-cerrar aria-label="Cerrar">&times;</button>
            </div>
            <p class="mp-modal-parrafo">Cada portafolio guarda sus propias emisoras,
            pesos y transacciones. Cambiar de uno a otro no mezcla nada.</p>
            <div id="port-panel-lista" class="mp-perfiles">${filas}</div>
            <div class="mp-modal-acciones">
              <button type="button" class="mp-btn mp-btn-primario" data-nuevo>Crear portafolio</button>
              <button type="button" class="mp-btn mp-btn-secundario" data-sandbox
                      title="Duplica el actual para experimentar sin tocarlo">Duplicar para probar</button>
            </div>
          </div>
        </div>
      </div>`);
    const panel = document.getElementById('port-panel');
    panel.addEventListener('click', (e) => { if (e.target === panel) _cerrarPanel(); });
    document.addEventListener('keydown', _escPanel);
    panel.querySelector('[data-cerrar]').addEventListener('click', _cerrarPanel);
    panel.querySelector('[data-nuevo]').addEventListener('click', () => abrirFormulario(null));
    panel.querySelector('[data-sandbox]').addEventListener('click', () => {
      _cerrarPanel();
      if (window.crearSandbox) window.crearSandbox();
    });
    panel.querySelectorAll('[data-cambiar]').forEach(b =>
      b.addEventListener('click', () => cambiar(b.dataset.cambiar)));
    panel.querySelectorAll('[data-editar]').forEach(b =>
      b.addEventListener('click', () => abrirFormulario(b.dataset.editar)));
    panel.querySelectorAll('[data-borrar]').forEach(b =>
      b.addEventListener('click', () => {
        const p = leerMeta().portfolios[b.dataset.borrar];
        if (confirm(`¿Eliminar "${p ? p.nombre : 'este portafolio'}"? Se borran sus emisoras, pesos y transacciones para siempre.`)) {
          eliminar(b.dataset.borrar);
        }
      }));
  }

  /* id null = crear; id con valor = editar ese. */
  function abrirFormulario(id) {
    const m = leerMeta();
    const p = id ? m.portfolios[id] : null;
    let animalSel = p ? _animalParaPortafolio(p) : ANIMALS[0].id;
    const viejo = document.getElementById('port-form');
    if (viejo) viejo.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div id="port-form" class="mp-modal" role="dialog" aria-modal="true"
           aria-label="${p ? 'Editar portafolio' : 'Nuevo portafolio'}">
        <div class="mp-modal-caja">
          <div class="mp-modal-cuerpo">
            <div class="mp-modal-cabecera">
              <div>
                <p class="mp-modal-etq">${p ? 'Editar' : 'Nuevo'}</p>
                <h2 class="mp-modal-titulo">${p ? escapeHtml(p.nombre) : 'Crear portafolio'}</h2>
              </div>
              <button type="button" class="mp-modal-cerrar" data-x aria-label="Cerrar">&times;</button>
            </div>
            <p class="mp-modal-parrafo">Sepáralos por objetivo: Retiro, Trading, Hijos.</p>
            <label class="mp-campo-etq" for="port-nombre-input">Nombre</label>
            <input id="port-nombre-input" type="text" maxlength="30" placeholder="Ej. Retiro"
                   value="${p ? escapeHtml(p.nombre) : ''}" class="mp-campo" />
            <p class="mp-campo-etq" id="port-avatar-etq">Avatar</p>
            <div class="mp-avatares" role="group" aria-labelledby="port-avatar-etq">
              ${ANIMALS.map(a => `
                <button type="button" data-animal="${a.id}" title="${a.name}"
                        aria-label="${a.name}" aria-pressed="${a.id === animalSel}"
                        class="mp-avatar${a.id === animalSel ? ' activo' : ''}">${a.svg}</button>`).join('')}
            </div>
            <div class="mp-modal-acciones">
              <button type="button" class="mp-btn mp-btn-primario" data-ok>${p ? 'Guardar' : 'Crear'}</button>
              <button type="button" class="mp-btn mp-btn-secundario" data-x>Cancelar</button>
            </div>
          </div>
        </div>
      </div>`);
    const f = document.getElementById('port-form');
    const cerrar = () => f.remove();
    f.addEventListener('click', (e) => { if (e.target === f) cerrar(); });
    f.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', cerrar));
    f.querySelectorAll('[data-animal]').forEach(b => b.addEventListener('click', () => {
      f.querySelectorAll('[data-animal]').forEach(x => {
        x.classList.remove('activo'); x.setAttribute('aria-pressed', 'false');
      });
      b.classList.add('activo'); b.setAttribute('aria-pressed', 'true');
      animalSel = b.dataset.animal;
    }));
    const aceptar = () => {
      const n = f.querySelector('#port-nombre-input').value;
      if (!n.trim()) { f.querySelector('#port-nombre-input').focus(); return; }
      if (id) {
        editar(id, n, animalSel);
        cerrar();
        // El panel se rehace para que el cambio se vea sin recargar.
        abrirPanel();
      } else {
        crear(n, animalSel);   // recarga la página
      }
    };
    f.querySelector('[data-ok]').addEventListener('click', aceptar);
    f.querySelector('#port-nombre-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') aceptar();
    });
    setTimeout(() => f.querySelector('#port-nombre-input').focus(), 60);
  }

  function renderMenu() {
    const m = leerMeta();
    const items = Object.entries(m.portfolios).map(([id, p]) => {
      const act = id === m.activo;
      return `
        <div class="flex items-center justify-between rounded-md hover:bg-zinc-900 group ${act ? 'bg-accent-green/10' : ''}">
          <button data-port-id="${id}" class="port-switch flex-1 text-left flex items-center gap-2 px-2 py-1.5 text-xs ${act ? 'text-accent-green font-semibold' : 'text-zinc-200'}">
            ${_avatarHTML(_animalParaPortafolio(p), 'w-5 h-5')}
            <span class="truncate">${escapeHtml(p.nombre)}</span>
            ${act ? '<span class="ml-auto text-[10px]">activo</span>' : ''}
          </button>
          ${id !== 'principal' ? `<button data-port-del="${id}" class="port-del text-zinc-600 hover:text-accent-red text-xs px-2 opacity-0 group-hover:opacity-100" title="Eliminar">✕</button>` : ''}
        </div>`;
    }).join('');
    $('port-list').innerHTML = items;
    $('port-list').querySelectorAll('.port-switch').forEach(b => {
      b.addEventListener('click', () => cambiar(b.dataset.portId));
    });
    $('port-list').querySelectorAll('.port-del').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('¿Eliminar este portafolio? Se borrarán sus tickers, pesos y transacciones permanentemente.')) {
          eliminar(b.dataset.portDel);
        }
      });
    });
  }
  function abrirCrear() {
    const html = `
      <div class="fixed inset-0 bg-[color:rgba(26,26,24,.40)] z-50 flex items-center justify-center p-4 backdrop-blur-sm" id="port-crear-modal">
        <div class="bg-surface-card border border-surface-border rounded-2xl max-w-sm w-full p-6">
          <h3 class="text-lg font-semibold text-zinc-100">Nuevo portafolio</h3>
          <p class="text-xs text-zinc-500 mt-1 mb-4">Sepáralo por objetivo: Retiro, Trading, Hijos, etc.</p>
          <label class="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Nombre</label>
          <input id="port-nombre-input" type="text" maxlength="30" placeholder="Ej. Retiro" class="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-accent-green mb-4" />
          <label class="text-[10px] uppercase tracking-wider text-zinc-500 block mb-2">Elige tu avatar</label>
          <div id="port-animal-grid" class="grid grid-cols-5 gap-2 mb-4">
            ${ANIMALS.map((a,i) => `<button type="button" data-animal="${a.id}" class="port-animal w-full aspect-square rounded-lg overflow-hidden transition ${i===0?'ring-2 ring-white/90 ring-offset-2 ring-offset-zinc-900':'opacity-70 hover:opacity-100'}" title="${a.name}">${a.svg}</button>`).join('')}
          </div>
          <div class="flex gap-2 justify-end">
            <button id="port-crear-cancelar" class="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200">Cancelar</button>
            <button id="port-crear-ok" class="text-xs px-4 py-1.5 rounded-md bg-accent-green text-zinc-950 font-semibold hover:brightness-110">Crear</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    let animalSel = ANIMALS[0].id;
    document.querySelectorAll('.port-animal').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.port-animal').forEach(x => { x.classList.remove('ring-2','ring-white/90','ring-offset-2','ring-offset-zinc-900'); x.classList.add('opacity-70'); });
        b.classList.add('ring-2','ring-white/90','ring-offset-2','ring-offset-zinc-900'); b.classList.remove('opacity-70');
        animalSel = b.dataset.animal;
      });
    });
    $('port-crear-cancelar').addEventListener('click', () => $('port-crear-modal').remove());
    $('port-crear-modal').addEventListener('click', (e) => { if (e.target.id==='port-crear-modal') $('port-crear-modal').remove(); });
    $('port-crear-ok').addEventListener('click', () => {
      const n = $('port-nombre-input').value;
      if (n.trim()) crear(n, animalSel);
    });
    setTimeout(() => $('port-nombre-input').focus(), 100);
  }
  function bind() {
    leerMeta();
    renderHeader();
    // El botón del masthead abre el PANEL, no el desplegable viejo.
    $('port-selector-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      abrirPanel();
    });
    $('port-crear-btn')?.addEventListener('click', () => abrirFormulario(null));
  }
  return { bind, activoData, activoId, abrirPanel, editar };
})();


// ============================================================
// MÓDULO: CETES BENCHMARK
// ============================================================
const CetesBench = (() => {
  let cetesCache = null;
  async function cargar() {
    try {
      const res = await fetch('/api/renta-fija/mx');
      const data = await res.json();
      const cetes = (data.cetes || data.cetes_panel || []).find(c => /28/.test(c.plazo || '')) || (data.cetes || data.cetes_panel || [])[0];
      cetesCache = cetes ? (cetes.tasa_pct || cetes.tasa || 9.5) : 9.5;
    } catch { cetesCache = 9.5; }
    actualizar();
  }
  function actualizar() {
    const box = $('cetes-benchmark');
    if (!box || cetesCache == null) return;
    // Leer rendimiento anualizado del KPI ya rendereado
    const txt = ($('kpi-retorno-anual')?.textContent || '').replace(/[^\d.\-]/g, '');
    const port = parseFloat(txt);
    if (!isFinite(port)) return;
    const spread = port - cetesCache;
    $('cetes-tasa').textContent = cetesCache.toFixed(2) + '%';
    const cls = spread >= 0 ? 'text-accent-green' : 'text-accent-red';
    $('cetes-spread').className = `text-2xl font-bold tabular mt-0.5 ${cls}`;
    $('cetes-spread').textContent = (spread >= 0 ? '+' : '') + spread.toFixed(2) + ' pp';
    let veredicto;
    if (spread >= 5) veredicto = '▲ Tu portafolio aplasta a CETES — el riesgo extra está pagando.';
    else if (spread >= 2) veredicto = '✓ Sí compensa el riesgo: ganas más que la tasa libre.';
    else if (spread >= 0) veredicto = '≈ Apenas igualas a CETES — revisa si vale la volatilidad.';
    else if (spread >= -3) veredicto = '⚠ CETES te gana sin riesgo. Considera rebalancear.';
    else veredicto = '× CETES te gana por mucho. Revisa tu estrategia.';
    $('cetes-veredicto').className = `text-[11px] mt-0.5 ${cls}`;
    $('cetes-veredicto').textContent = veredicto;
    box.classList.remove('hidden');
  }
  function bind() {
    setTimeout(cargar, 1500);  // pequeña espera para que el KPI se llene primero
  }
  return { bind, refrescar: cargar };
})();


// ============================================================
// MÓDULO: TU MES (Wrapped mensual estilo Spotify) — versión premium
// ============================================================
const TuMes = (() => {
  // CSS injection — animaciones cinematográficas
  function _injectCSS() {
    if (document.getElementById('mes-styles')) return;
    const style = document.createElement('style');
    style.id = 'mes-styles';
    style.textContent = `
      @keyframes mesSlideIn { from { opacity: 0; transform: scale(.93) translateY(24px); filter: blur(8px); } to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); } }
      @keyframes mesBlob {
        0%, 100% { transform: translate(0,0) scale(1) rotate(0); }
        33% { transform: translate(40px,-30px) scale(1.18) rotate(40deg); }
        66% { transform: translate(-30px,30px) scale(.88) rotate(-30deg); }
      }
      @keyframes mesPulseRing { 0% { transform: scale(.85); opacity: .6; } 100% { transform: scale(1.6); opacity: 0; } }
      @keyframes mesShimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
      @keyframes mesConfetti { 0% { transform: translateY(0) rotate(0); opacity: 1; } 100% { transform: translateY(900px) rotate(720deg); opacity: 0; } }
      @keyframes mesFadeUp { from { opacity: 0; transform: translateY(28px); filter: blur(4px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
      @keyframes mesFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes mesScaleIn { from { opacity: 0; transform: scale(.6) rotate(-8deg); } to { opacity: 1; transform: scale(1) rotate(0); } }
      @keyframes mesPopIn { 0% { opacity: 0; transform: scale(.3); } 60% { opacity: 1; transform: scale(1.18); } 100% { transform: scale(1); } }
      @keyframes mesSpin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      @keyframes mesSpinSlow { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      @keyframes mesMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      @keyframes mesSunburst { 0% { transform: scale(.4) rotate(0); opacity: 0; } 30% { opacity: .6; } 100% { transform: scale(1.4) rotate(60deg); opacity: 0; } }
      @keyframes mesHolo {
        0%   { background-position: 0% 50%; }
        100% { background-position: 300% 50%; }
      }
      @keyframes mesCardEntry {
        0% { opacity: 0; transform: scale(.6) rotateY(40deg) rotateZ(-8deg); }
        60% { opacity: 1; transform: scale(1.05) rotateY(0) rotateZ(0); }
        100% { opacity: 1; transform: scale(1) rotateY(0) rotateZ(0); }
      }
      @keyframes mesGlowPulse {
        0%, 100% { box-shadow: 0 0 60px 0 rgba(156,93,18,.5), 0 0 120px 20px rgba(156,93,18,.25); }
        50% { box-shadow: 0 0 80px 10px rgba(156,93,18,.7), 0 0 160px 30px rgba(156,93,18,.4); }
      }
      @keyframes mesFloatY { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      @keyframes mesParticle {
        0% { transform: translate(0,0) scale(0); opacity: 1; }
        50% { opacity: 1; }
        100% { transform: translate(var(--tx, 100px), var(--ty, -200px)) scale(1.2); opacity: 0; }
      }
      @keyframes mesLetterReveal { from { opacity: 0; transform: translateY(20px) scale(.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes mesUnderline { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      @keyframes mesRayRotate { from { transform: rotate(0); } to { transform: rotate(360deg); } }

      .mes-slide { animation: mesSlideIn .65s cubic-bezier(.18,.95,.32,1) both; will-change: transform, opacity, filter; }
      .mes-blob { position: absolute; border-radius: 50%; filter: blur(40px); animation: mesBlob 12s infinite ease-in-out; pointer-events: none; }
      .mes-bignum { font-family: 'Source Serif 4', Georgia, serif; font-weight: 800; letter-spacing: -0.04em; line-height: .88; }
      .mes-eyebrow { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; letter-spacing: .26em; text-transform: uppercase; font-size: 11px; }
      .mes-confetti-piece { position: absolute; width: 8px; height: 14px; animation: mesConfetti 3s ease-out forwards; border-radius:var(--radio); }
      .mes-tap-zone { position: absolute; top: 0; bottom: 0; width: 35%; cursor: pointer; z-index: 10; }
      .mes-modal-bg { background: radial-gradient(ellipse at top, rgba(156,93,18,.15), var(--sup-grad-b) 60%), var(--sup-grad-a); }

      /* Reveals secuenciales por slide */
      .mes-reveal-1 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .15s both; }
      .mes-reveal-2 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .35s both; }
      .mes-reveal-3 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .55s both; }
      .mes-reveal-4 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .75s both; }
      .mes-reveal-5 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .95s both; }

      /* Marquee de texto en background */
      .mes-marquee {
        position: absolute; left: 0; right: 0; top: 50%;
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 900; font-size: 130px;
        letter-spacing: -.04em; text-transform: uppercase;
        color: rgba(26,26,24,.05); white-space: nowrap;
        transform: translateY(-50%) rotate(-12deg); pointer-events: none;
        overflow: hidden;
      }
      .mes-marquee-track {
        display: inline-block; animation: mesMarquee 25s linear infinite;
        will-change: transform;
      }

      /* Pulse rings */
      .mes-ring-host { position: relative; display: inline-block; }
      .mes-ring {
        position: absolute; inset: 0; border-radius: 50%; border: 2px solid currentColor;
        animation: mesPulseRing 2.4s ease-out infinite;
        pointer-events: none;
      }
      .mes-ring:nth-child(2) { animation-delay: .8s; }
      .mes-ring:nth-child(3) { animation-delay: 1.6s; }

      /* Sunburst rays */
      .mes-sunburst { position: absolute; pointer-events: none; }
      .mes-sunburst svg { animation: mesRayRotate 30s linear infinite; }

      /* TARJETA DE PERSONALIDAD — diseño Pokémon-Spotify */
      .mes-card-stage {
        perspective: 1200px;
        animation: mesCardEntry 1.1s cubic-bezier(.18,.95,.32,1) both;
        animation-delay: .25s;
      }
      .mes-card {
        position: relative; width: 290px; aspect-ratio: 5/7;
        border-radius:var(--radio);
        animation: mesGlowPulse 3.5s ease-in-out infinite, mesFloatY 4s ease-in-out infinite;
        background: var(--sup);
        overflow: hidden;
      }
      .mes-card::before {
        content: ''; position: absolute; inset: -3px;
        border-radius:var(--radio);
        background: var(--sup-panel);
        background-size: 300% 100%;
        animation: mesHolo 6s linear infinite;
        z-index: -1;
      }
      .mes-card-inner {
        position: absolute; inset: 3px;
        border-radius:var(--radio);
        background:
          radial-gradient(ellipse at top, rgba(156,93,18,.3), transparent 60%),
          var(--sup-panel);
        display: flex; flex-direction: column; padding: 18px 16px;
        overflow: hidden;
      }
      .mes-card-shine {
        position: absolute; inset: 3px;
        border-radius:var(--radio-tarjeta);
        background: var(--sup-panel);
        background-size: 200% 100%;
        animation: mesShimmer 4s linear infinite;
        pointer-events: none;
      }
      .mes-card-rarity {
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 700;
        font-size: 9px; letter-spacing: .25em; text-transform: uppercase;
        color: var(--sello);
        text-shadow: 0 0 8px rgba(156,93,18,.4);
      }
      .mes-card-illustration {
        flex: 1;
        display: flex; align-items: center; justify-content: center;
        margin: 12px 0;
        background: radial-gradient(circle at center, rgba(156,93,18,.25), transparent 70%);
        border-radius:var(--radio);
        position: relative;
      }
      .mes-card-illustration::before {
        content: ''; position: absolute; inset: 0;
        background: repeating-conic-gradient(from 0deg, rgba(156,93,18,.08) 0 5deg, transparent 5deg 15deg);
        animation: mesRayRotate 30s linear infinite;
        opacity: .6;
        border-radius:var(--radio);
      }
      .mes-card-illustration svg { position: relative; z-index: 1; filter: drop-shadow(0 4px 16px rgba(156,93,18,.6)); }
      .mes-card-title {
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 800;
        font-size: 26px; letter-spacing: -.02em;
        color: white; line-height: 1;
        text-align: center;
        background: var(--sup-panel);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .mes-card-desc {
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 400;
        font-size: 11px; line-height: 1.4;
        color: var(--tinta-2);
        text-align: center; margin-top: 8px;
        padding: 0 4px;
      }
      .mes-card-stats {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
        margin-top: 12px; padding-top: 12px;
        border-top: 1px solid rgba(26,26,24,.10);
      }
      .mes-card-stat {
        background: rgba(26,26,24,.05);
        border: 1px solid rgba(26,26,24,.10);
        border-radius:999px; padding: 6px 8px;
        text-align: center;
      }
      .mes-card-stat-label {
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 600;
        font-size: 8px; letter-spacing: .15em; text-transform: uppercase;
        color: var(--tinta-3);
      }
      .mes-card-stat-value {
        font-family: 'Source Serif 4', Georgia, serif; font-weight: 700;
        font-size: 16px; color: white; line-height: 1;
        margin-top: 2px;
      }
      .mes-card-stars {
        display: flex; gap: 2px; justify-content: center;
        margin-top: 6px;
        animation: mesPopIn .6s cubic-bezier(.18,.95,.32,1) 1.5s both;
      }
      .mes-card-star { color: var(--sello); font-size: 11px; filter: drop-shadow(0 0 4px rgba(156,93,18,.6)); }

      /* Partículas decorativas */
      .mes-particle {
        position: absolute; width: 4px; height: 4px; border-radius: 50%;
        animation: mesParticle 2.4s ease-out infinite;
      }

      /* Letras grandes con reveal por carácter */
      .mes-letter { display: inline-block; animation: mesLetterReveal .55s cubic-bezier(.18,.95,.32,1) both; }

      /* Underline animado */
      .mes-underline {
        display: inline-block; position: relative;
      }
      .mes-underline::after {
        content: ''; position: absolute; left: 0; right: 0; bottom: -4px;
        height: 3px; background: currentColor; border-radius:var(--radio);
        transform-origin: left;
        animation: mesUnderline .8s cubic-bezier(.18,.95,.32,1) .6s both;
      }

      /* Trofeo / medalla SVG */
      .mes-medal {
        width: 200px; height: 200px;
        animation: mesPopIn .9s cubic-bezier(.18,.95,.32,1) .3s both;
        filter: drop-shadow(0 8px 24px rgba(26,26,24,.12));
      }
      .mes-medal-spin svg { animation: mesSpinSlow 18s linear infinite; }

      /* Trending arrow grande */
      .mes-trend-arrow {
        animation: mesPopIn .8s cubic-bezier(.18,.95,.32,1) .3s both;
        filter: drop-shadow(0 6px 20px rgba(156,93,18,.5));
      }
    `;
    document.head.appendChild(style);
  }

  function bind() {
    _injectCSS();
    // (botón manual removido — el wrap es ahora exclusivamente pop-up del día 1)

    const KEY_FIRST = 'miPortafolio.firstUse.v1';
    const KEY_LAST  = 'miPortafolio.wrapShown.v1';
    const hoy = new Date();
    const yyyymm = hoy.getFullYear() + '-' + String(hoy.getMonth()+1).padStart(2,'0');

    // 1) Marcar primer uso si todavía no está marcado
    let firstUse = null;
    try { firstUse = localStorage.getItem(KEY_FIRST); } catch {}
    if (!firstUse) {
      try { localStorage.setItem(KEY_FIRST, hoy.toISOString()); } catch {}
      firstUse = hoy.toISOString();
    }
    const diasEnApp = Math.floor((hoy - new Date(firstUse)) / (1000 * 60 * 60 * 24));

    // 2) Auto-popup SOLO si:
    //    - Es día 1 del mes
    //    - Lleva ≥30 días en la app
    //    - No se mostró este mes
    let ultimoMostrado = null;
    try { ultimoMostrado = localStorage.getItem(KEY_LAST); } catch {}

    if (hoy.getDate() === 1 && diasEnApp >= 30 && ultimoMostrado !== yyyymm) {
      setTimeout(() => {
        mostrar(true);
        try { localStorage.setItem(KEY_LAST, yyyymm); } catch {}
      }, 1500);
    }
  }

  function _percentil(metric, value) {
    if (metric === 'sharpe') {
      if (value >= 2.0) return 1;
      if (value >= 1.5) return 5;
      if (value >= 1.0) return 15;
      if (value >= 0.5) return 35;
      if (value >= 0)   return 55;
      return 80;
    }
    if (metric === 'retorno_anual') {
      if (value >= 25) return 2;
      if (value >= 18) return 8;
      if (value >= 12) return 22;
      if (value >= 8)  return 40;
      if (value >= 4)  return 60;
      if (value >= 0)  return 75;
      return 90;
    }
    if (metric === 'ops') {
      if (value >= 20) return 5;
      if (value >= 10) return 15;
      if (value >= 5)  return 30;
      if (value >= 2)  return 50;
      return 75;
    }
    return 50;
  }

  function _estadisticas() {
    const hoy = new Date();
    const mesAnt = new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
    const yyyymmAnt = mesAnt.getFullYear() + '-' + String(mesAnt.getMonth()+1).padStart(2,'0');
    const nombreMes = mesAnt.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });

    const tickers = leerPortafolioGuardado() || [];
    let txs = [];
    try { txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]'); } catch {}
    const txsMes = txs.filter(t => (t.fecha || '').startsWith(yyyymmAnt));
    const txsAno = txs.filter(t => (t.fecha || '').startsWith(String(mesAnt.getFullYear())));

    const compras = txsMes.filter(t => t.tipo === 'compra').length;
    const ventas  = txsMes.filter(t => t.tipo === 'venta').length;
    const totalOps = compras + ventas;

    const dividendosMes = txsMes.filter(t => t.tipo === 'dividendo')
      .reduce((s, t) => s + ((t.shares || 0) * (t.precio || 0)), 0);
    const dividendosAno = txsAno.filter(t => t.tipo === 'dividendo')
      .reduce((s, t) => s + ((t.shares || 0) * (t.precio || 0)), 0);
    const capitalMovido = txsMes.reduce((s, t) => {
      if (t.tipo === 'compra' || t.tipo === 'venta') {
        const m = (t.shares || 0) * (t.precio || 0) * (t.moneda === 'USD' ? 17 : 1);
        return s + m;
      }
      return s;
    }, 0);

    const retAnualTxt = ($('kpi-retorno-anual')?.textContent || '').replace(/[^\d.\-]/g, '');
    const retAnual    = parseFloat(retAnualTxt) || 0;
    const sharpeTxt   = ($('kpi-sharpe')?.textContent || '').replace(/[^\d.\-]/g, '');
    const sharpe      = parseFloat(sharpeTxt) || 0;

    const tickerMasOperado = (() => {
      const counts = {};
      txsMes.forEach(t => { counts[t.ticker] = (counts[t.ticker]||0)+1; });
      let max = 0, ticker = null;
      Object.entries(counts).forEach(([t, c]) => { if (c > max) { max = c; ticker = t; } });
      return ticker;
    })();

    const portData = (typeof PortfolioManager !== 'undefined') ? PortfolioManager.activoData() : { nombre: 'Mi portafolio', emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M4 19V11"/><path d="M10 19V6"/><path d="M16 19V14"/><path d="M22 19H2"/></svg></span>' };

    return {
      nombreMes, yyyymmAnt,
      portafolio:   portData,
      tickers:      tickers.length,
      totalOps, compras, ventas,
      dividendosMes, dividendosAno,
      capitalMovido,
      retAnual, sharpe,
      tickerMasOperado,
      tickersUnicosOperados: new Set(txsMes.map(t => t.ticker)).size,
      pctSharpe:   _percentil('sharpe', sharpe),
      pctRetorno:  _percentil('retorno_anual', retAnual),
      pctOps:      _percentil('ops', totalOps),
    };
  }

  // SVGs personalizados por arquetipo. 140×140 viewBox.
  const _SVG = {
    cazador: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bullseye" cx=".5" cy=".5"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="60%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></radialGradient>
        <linearGradient id="arrow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
      </defs>
      <circle cx="80" cy="80" r="62" fill="none" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="2"/>
      <circle cx="80" cy="80" r="48" fill="none" stroke="var(--sello)" stroke-width="3"/>
      <circle cx="80" cy="80" r="34" fill="none" stroke="var(--sello)" stroke-width="3"/>
      <circle cx="80" cy="80" r="20" fill="url(#bullseye)"/>
      <circle cx="80" cy="80" r="6" fill="var(--tinta-1)"/>
      <line x1="20" y1="20" x2="78" y2="78" stroke="url(#arrow)" stroke-width="3" stroke-linecap="round"/>
      <polygon points="80,80 70,68 78,72 76,64" fill="var(--sello)"/>
      <polygon points="22,18 14,14 18,22" fill="var(--tinta-1)"/>
    </svg>`,
    sabio: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="zenG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
      </defs>
      <circle cx="80" cy="80" r="60" fill="none" stroke="url(#zenG)" stroke-width="3"/>
      <circle cx="80" cy="80" r="48" fill="none" stroke="var(--tinta-1)" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="4 6"/>
      <path d="M 30 80 Q 30 50 80 50 Q 130 50 130 80" fill="var(--tinta-1)"/>
      <path d="M 30 80 Q 30 110 80 110 Q 130 110 130 80" fill="var(--sup)"/>
      <circle cx="80" cy="55" r="6" fill="var(--sup)"/>
      <circle cx="80" cy="105" r="6" fill="var(--tinta-1)"/>
      <circle cx="80" cy="80" r="2" fill="var(--tinta-1)" opacity=".8"><animate attributeName="r" values="2;4;2" dur="3s" repeatCount="indefinite"/></circle>
    </svg>`,
    trader: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="boltG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
        <radialGradient id="coreG" cx=".5" cy=".5"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="100%" stop-color="var(--sello)"/></radialGradient>
      </defs>
      <circle cx="80" cy="80" r="50" fill="url(#coreG)" opacity=".15"/>
      <polygon points="65,20 95,75 75,75 90,140 50,80 70,80" fill="url(#boltG)" stroke="var(--tinta-1)" stroke-width="2" stroke-linejoin="round"/>
      <polygon points="115,40 130,75 122,75 130,110 110,82 118,82" fill="var(--sello)" opacity=".7"/>
      <polygon points="35,55 45,80 38,80 44,110 28,85 34,85" fill="var(--sello)" opacity=".7"/>
    </svg>`,
    rentista: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="coinG" cx=".4" cy=".3"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="50%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></radialGradient>
      </defs>
      <ellipse cx="80" cy="125" rx="40" ry="9" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="120" rx="40" ry="9" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="105" rx="42" ry="10" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="100" rx="42" ry="10" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="83" rx="44" ry="11" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="78" rx="44" ry="11" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <text x="80" y="84" text-anchor="middle" font-family="Source Serif 4" font-weight="800" font-size="18" fill="var(--sello)">$</text>
      <ellipse cx="80" cy="58" rx="46" ry="12" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <ellipse cx="80" cy="52" rx="46" ry="12" fill="url(#coinG)" stroke="var(--sello)" stroke-width="2"/>
      <text x="80" y="58" text-anchor="middle" font-family="Source Serif 4" font-weight="800" font-size="20" fill="var(--sello)">$</text>
      <circle cx="50" cy="35" r="3" fill="var(--sello)"><animate attributeName="cy" values="35;25;35" dur="2.5s" repeatCount="indefinite"/></circle>
      <circle cx="115" cy="40" r="2" fill="var(--sello)"><animate attributeName="cy" values="40;30;40" dur="2s" repeatCount="indefinite" begin="0.3s"/></circle>
    </svg>`,
    diversificador: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="planetG" cx=".4" cy=".4"><stop offset="0%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></radialGradient>
      </defs>
      <line x1="35" y1="35" x2="80" y2="55" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <line x1="125" y1="40" x2="80" y2="55" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <line x1="80" y1="55" x2="50" y2="105" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <line x1="80" y1="55" x2="120" y2="100" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <line x1="50" y1="105" x2="80" y2="130" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <line x1="120" y1="100" x2="80" y2="130" stroke="var(--tinta-1)" stroke-opacity=".3" stroke-width="1"/>
      <circle cx="80" cy="80" r="50" fill="none" stroke="var(--tinta-1)" stroke-opacity=".15" stroke-dasharray="2 4"/>
      <circle cx="80" cy="55" r="22" fill="url(#planetG)" stroke="var(--tinta-1)" stroke-width="2"/>
      <ellipse cx="80" cy="55" rx="32" ry="6" fill="none" stroke="var(--sello)" stroke-width="1.5" opacity=".7" transform="rotate(-15 80 55)"/>
      <circle cx="35" cy="35" r="4" fill="var(--sello)"/>
      <circle cx="125" cy="40" r="3" fill="var(--sello)"/>
      <circle cx="50" cy="105" r="3" fill="var(--sello)"/>
      <circle cx="120" cy="100" r="4" fill="var(--sello)"/>
      <circle cx="80" cy="130" r="3" fill="var(--sello)"/>
    </svg>`,
    convencido: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="diamG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="50%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
      </defs>
      <polygon points="80,20 130,55 110,140 50,140 30,55" fill="url(#diamG)" stroke="var(--tinta-1)" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="30" y1="55" x2="130" y2="55" stroke="var(--tinta-1)" stroke-width="2"/>
      <line x1="80" y1="20" x2="80" y2="140" stroke="var(--tinta-1)" stroke-opacity=".5" stroke-width="1"/>
      <line x1="60" y1="55" x2="80" y2="140" stroke="var(--tinta-1)" stroke-opacity=".5" stroke-width="1"/>
      <line x1="100" y1="55" x2="80" y2="140" stroke="var(--tinta-1)" stroke-opacity=".5" stroke-width="1"/>
      <polygon points="80,20 100,55 60,55" fill="var(--tinta-1)" opacity=".5"/>
      <circle cx="50" cy="40" r="2" fill="var(--tinta-1)" opacity=".8"><animate attributeName="opacity" values=".3;1;.3" dur="2s" repeatCount="indefinite"/></circle>
      <circle cx="115" cy="80" r="2" fill="var(--tinta-1)" opacity=".8"><animate attributeName="opacity" values="1;.3;1" dur="1.8s" repeatCount="indefinite"/></circle>
    </svg>`,
    constructor: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="brickG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--alza)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
      </defs>
      <rect x="30" y="120" width="100" height="14" rx="2" fill="url(#brickG)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <line x1="80" y1="120" x2="80" y2="134" stroke="var(--sup)" stroke-width="1.5"/>
      <rect x="40" y="100" width="80" height="14" rx="2" fill="url(#brickG)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <line x1="80" y1="100" x2="80" y2="114" stroke="var(--sup)" stroke-width="1.5"/>
      <rect x="50" y="80" width="60" height="14" rx="2" fill="url(#brickG)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <line x1="80" y1="80" x2="80" y2="94" stroke="var(--sup)" stroke-width="1.5"/>
      <rect x="60" y="60" width="40" height="14" rx="2" fill="url(#brickG)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <line x1="80" y1="60" x2="80" y2="74" stroke="var(--sup)" stroke-width="1.5"/>
      <rect x="68" y="40" width="24" height="14" rx="2" fill="url(#brickG)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <polygon points="68,40 80,28 92,40" fill="var(--sello)" stroke="var(--tinta-1)" stroke-width="1.5"/>
      <circle cx="80" cy="22" r="3" fill="var(--tinta-1)" opacity=".9"><animate attributeName="opacity" values=".5;1;.5" dur="2s" repeatCount="indefinite"/></circle>
    </svg>`,
  };

  function _vibePersonalidad(s) {
    if (s.sharpe >= 1.5 && s.totalOps >= 5) return {
      tipo: 'El Cazador', svg: _SVG.cazador, rareza: 'LEGENDARIO',
      desc: 'Activo, calculador y con un ratio riesgo/recompensa de élite.',
      stat1: { label: 'Sharpe', value: s.sharpe.toFixed(2) },
      stat2: { label: 'Precision', value: s.totalOps + ' ops' },
      stars: 5,
    };
    if (s.sharpe >= 1.5) return {
      tipo: 'El Sabio', svg: _SVG.sabio, rareza: 'ÉPICO',
      desc: 'Pocas operaciones, gran visión. Tu Sharpe habla por ti.',
      stat1: { label: 'Sharpe', value: s.sharpe.toFixed(2) },
      stat2: { label: 'Zen', value: '∞' },
      stars: 5,
    };
    if (s.totalOps >= 15) return {
      tipo: 'El Trader', svg: _SVG.trader, rareza: 'RARO',
      desc: 'Mueves mucho. Cuida las comisiones — pueden comerse tu alfa.',
      stat1: { label: 'Speed', value: s.totalOps + ' ops' },
      stat2: { label: 'Tickers', value: s.tickersUnicosOperados },
      stars: 4,
    };
    if (s.dividendosMes > 100) return {
      tipo: 'El Rentista', svg: _SVG.rentista, rareza: 'RARO',
      desc: 'Buscas flujo, no glamour. Los dividendos siguen llegando.',
      stat1: { label: 'Cashflow', value: '$' + Math.round(s.dividendosMes) },
      stat2: { label: 'YTD', value: '$' + Math.round(s.dividendosAno) },
      stars: 4,
    };
    if (s.tickers >= 10) return {
      tipo: 'El Diversificador', svg: _SVG.diversificador, rareza: 'POCO COMÚN',
      desc: 'Universo expandido. No apuestas todo a una sola carta.',
      stat1: { label: 'Tickers', value: s.tickers },
      stat2: { label: 'Risk', value: 'Bajo' },
      stars: 3,
    };
    if (s.tickers <= 3 && s.tickers > 0) return {
      tipo: 'El Convencido', svg: _SVG.convencido, rareza: 'POCO COMÚN',
      desc: 'Pocos tickers, máxima convicción. Diamante en bruto.',
      stat1: { label: 'Tickers', value: s.tickers },
      stat2: { label: 'Conviction', value: 'Alta' },
      stars: 3,
    };
    return {
      tipo: 'El Constructor', svg: _SVG.constructor, rareza: 'COMÚN',
      desc: 'Estás armando tu portafolio con paciencia. La base.',
      stat1: { label: 'Tickers', value: s.tickers || 0 },
      stat2: { label: 'Stage', value: 'Build' },
      stars: 2,
    };
  }

  // Animar número de 0 a target con easing
  function _animateNumber(el, target, duration, formatter) {
    if (!el) return;
    const start = performance.now();
    const startVal = 0;
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const val = startVal + (target - startVal) * eased;
      el.textContent = formatter(val);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Genera confetti dentro de un contenedor
  function _confetti(host, n) {
    const colors = [MP_COLOR.sello,MP_COLOR.sello,MP_COLOR.baja,MP_COLOR.sello,MP_COLOR.sello,MP_COLOR.sello];
    for (let i = 0; i < n; i++) {
      const piece = document.createElement('div');
      piece.className = 'mes-confetti-piece';
      piece.style.left = Math.random()*100 + '%';
      piece.style.top = '-20px';
      piece.style.background = colors[Math.floor(Math.random()*colors.length)];
      piece.style.animationDelay = (Math.random()*1.5) + 's';
      piece.style.animationDuration = (2 + Math.random()*2) + 's';
      piece.style.transform = `rotate(${Math.random()*360}deg)`;
      host.appendChild(piece);
      setTimeout(() => piece.remove(), 5000);
    }
  }

  // 9 slides — cada uno una función que construye su HTML + lifecycle hooks
  function _buildSlides(s) {
    const fmt$ = v => '$' + Math.round(v).toLocaleString('en-US');
    const vibe = _vibePersonalidad(s);

    return [
      // ───────────── 1. APERTURA ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 280, top: '-50px', left: '-80px' },
          { color: MP_COLOR.sello, size: 220, bottom: '-60px', right: '-60px' },
        ],
        html: `
          <div class="mes-marquee"><div class="mes-marquee-track">${('TU MES · TU MES · TU MES · ').repeat(8)}</div></div>
          <p class="mes-eyebrow text-emerald-100 mes-reveal-1">Tu mes en Mi Portafolio</p>
          <h1 class="mes-bignum text-zinc-100 mt-3 mes-reveal-2" style="font-size:78px;"><span class="mes-underline">${escapeHtml(s.nombreMes.split(' ')[0])}</span></h1>
          <p class="mes-bignum text-emerald-200 mes-reveal-3" style="font-size:36px; opacity:.8;">${escapeHtml(s.nombreMes.split(' ').slice(1).join(' '))}</p>
          <div class="mt-10 inline-flex items-center gap-3 bg-zinc-800/50 backdrop-blur rounded-full px-5 py-2.5 border border-zinc-700 mes-reveal-4">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded-md font-bold text-zinc-100 text-sm" style="background:rgba(26,26,24,.10);">${escapeHtml((s.portafolio.nombre || 'P').charAt(0).toUpperCase())}</span>
            <span class="text-zinc-100 font-semibold">${escapeHtml(s.portafolio.nombre)}</span>
          </div>
          <p class="text-emerald-50 text-base mt-12 leading-relaxed mes-reveal-5">Esto es lo que pasó<br>en tu portafolio este mes.</p>
          <div class="absolute bottom-8 left-0 right-0 text-center mes-reveal-5">
            <p class="text-emerald-100 text-xs animate-pulse">Mantén presionado para pausar →</p>
          </div>
        `,
        confetti: 30,
      },

      // ───────────── 2. SHARPE TOP X% ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 200, top: '60px', right: '-40px' },
          { color: MP_COLOR.sello, size: 280, bottom: '-100px', left: '-80px' },
        ],
        html: `
          <!-- Sunburst rays detrás del número -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg width="500" height="500" viewBox="0 0 500 500" style="opacity:.18; animation: mesRayRotate 60s linear infinite;">
              ${Array.from({length: 16}, (_, i) => {
                const a = (i * 22.5) * Math.PI / 180;
                return `<polygon points="250,250 ${250 + Math.cos(a)*250},${250 + Math.sin(a)*250} ${250 + Math.cos(a + 0.06)*240},${250 + Math.sin(a + 0.06)*240}" fill="var(--sello)"/>`;
              }).join('')}
            </svg>
          </div>
          <p class="mes-eyebrow text-pink-100 mes-reveal-1">Tu Sharpe del mes</p>
          <div class="mes-ring-host mes-reveal-2 mt-3">
            <p class="mes-bignum text-zinc-100" style="font-size:130px;">
              <span data-counter="${s.pctSharpe}" data-format="topPct" class="mes-shimmer-text">Top 0%</span>
            </p>
          </div>
          <div class="mt-3 inline-flex items-center gap-2 bg-zinc-800/60 backdrop-blur rounded-full px-4 py-2 border border-zinc-700 mes-reveal-3">
            <span class="text-yellow-200">★</span>
            <p class="text-zinc-100 font-bold tabular text-lg">Sharpe ${s.sharpe.toFixed(2)}</p>
            <span class="text-yellow-200">★</span>
          </div>
          <p class="text-pink-50 text-base mt-10 leading-relaxed mes-reveal-4">
            Mejor que el <span class="font-bold text-zinc-100 text-xl">${100 - s.pctSharpe}%</span><br>
            de los portafolios diversificados.
          </p>
          ${s.pctSharpe <= 10 ? `<p class="mt-6 text-yellow-200 text-sm font-bold tracking-widest mes-reveal-5">★ ÉLITE ★</p>` : ''}
        `,
        confetti: s.pctSharpe <= 10 ? 50 : 0,
      },

      // ───────────── 3. RETORNO ANUALIZADO ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 240, top: '-40px', right: '-60px' },
          { color: MP_COLOR.sello, size: 280, bottom: '-80px', left: '-60px' },
        ],
        html: `
          <!-- Trending arrow gigante atrás -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none mes-trend-arrow">
            <svg width="380" height="380" viewBox="0 0 200 200" style="opacity:.18;">
              <defs>
                <linearGradient id="arrG3" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="var(--tinta-1)" stop-opacity="0"/><stop offset="100%" stop-color="var(--tinta-1)"/></linearGradient>
              </defs>
              <path d="M 20 160 L 80 100 L 110 130 L 175 50" fill="none" stroke="url(#arrG3)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
              <polygon points="175,50 145,55 165,75" fill="var(--tinta-1)" opacity=".8"/>
            </svg>
          </div>
          <p class="mes-eyebrow text-orange-100 mes-reveal-1">Retorno anualizado</p>
          <p class="mes-bignum text-zinc-100 mt-3 mes-reveal-2" style="font-size:130px;">
            <span data-counter="${Math.abs(s.retAnual)}" data-prefix="${s.retAnual >= 0 ? '+' : '-'}" data-suffix="%" data-decimals="1" class="mes-shimmer-text">${s.retAnual >= 0 ? '+' : '-'}0.0%</span>
          </p>
          <div class="mt-3 inline-flex items-center gap-2 bg-zinc-800/50 backdrop-blur rounded-full px-4 py-1.5 border border-zinc-700 mes-reveal-3">
            <span class="text-yellow-200">↑</span>
            <p class="text-zinc-100 font-bold tabular text-sm">vs S&P 500 +12.3% · IPC +6.1%</p>
          </div>
          <p class="text-orange-50 text-base mt-10 leading-relaxed mes-reveal-4">
            Estás en el <span class="font-bold text-zinc-100 text-xl">top ${s.pctRetorno}%</span><br>
            por rendimiento.
          </p>
          <p class="text-orange-200 text-xs mt-8 italic mes-reveal-5">Pasado ≠ futuro. Pero hoy te luce.</p>
        `,
        confetti: s.pctRetorno <= 10 ? 35 : 0,
      },

      // ───────────── 4. OPERACIONES ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 260, bottom: '-80px', right: '-80px' },
          { color: MP_COLOR.sello, size: 220, top: '-40px', left: '-50px' },
        ],
        html: `
          <p class="mes-eyebrow text-sky-100">${s.totalOps > 10 ? 'Hyperactivo' : (s.totalOps > 0 ? 'Operaciones del mes' : 'Mes zen')}</p>
          <p class="mes-bignum text-zinc-100 mt-3" style="font-size:160px;">
            <span data-counter="${s.totalOps}" data-decimals="0">0</span>
          </p>
          <p class="text-sky-100 text-lg mt-2 font-medium">${s.totalOps === 1 ? 'operación' : 'operaciones'}</p>
          <div class="grid grid-cols-2 gap-3 mt-8">
            <div class="bg-zinc-800/50 backdrop-blur rounded-xl px-4 py-3 border border-zinc-700">
              <p class="text-[10px] uppercase tracking-wider text-sky-100">Compras</p>
              <p class="text-2xl font-bold text-zinc-100 tabular">${s.compras}</p>
            </div>
            <div class="bg-zinc-800/50 backdrop-blur rounded-xl px-4 py-3 border border-zinc-700">
              <p class="text-[10px] uppercase tracking-wider text-sky-100">Ventas</p>
              <p class="text-2xl font-bold text-zinc-100 tabular">${s.ventas}</p>
            </div>
          </div>
          ${s.tickerMasOperado ? `<p class="text-sky-50 text-sm mt-8">Tu favorita: <span class="font-mono font-bold text-zinc-100 text-lg">${escapeHtml(s.tickerMasOperado)}</span></p>` : '<p class="text-sky-100 text-sm mt-8 italic">A veces no hacer nada es la mejor jugada.</p>'}
        `,
      },

      // ───────────── 5. DIVIDENDOS ─────────────
      ...(s.dividendosMes > 0 || s.dividendosAno > 0 ? [{
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.tinta1, size: 280, top: '-60px', right: '-80px' },
          { color: MP_COLOR.sello, size: 220, bottom: '-60px', left: '-60px' },
        ],
        html: `
          <p class="mes-eyebrow text-yellow-100">Dividendos cobrados</p>
          <p class="mes-bignum text-zinc-100 mt-3" style="font-size:90px;">
            <span data-counter="${s.dividendosMes}" data-prefix="$" data-decimals="2">$0.00</span>
          </p>
          <p class="text-yellow-100 text-base mt-4">este mes</p>
          ${s.dividendosAno > s.dividendosMes ? `
            <div class="mt-10 bg-zinc-800/50 backdrop-blur rounded-2xl px-5 py-4 border border-zinc-700">
              <p class="text-[10px] uppercase tracking-wider text-yellow-100">En lo que va del año</p>
              <p class="text-3xl font-bold text-zinc-100 tabular mt-1">${fmt$(s.dividendosAno)}</p>
            </div>
          ` : ''}
          <p class="text-yellow-50 text-sm mt-10 italic leading-relaxed">Cada peso que recibes es uno<br>que no necesitas vender.</p>
        `,
        confetti: s.dividendosMes > 500 ? 40 : 0,
      }] : []),

      // ───────────── 6. CAPITAL MOVIDO ─────────────
      ...(s.capitalMovido > 0 ? [{
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 240, top: '0', right: '-60px' },
          { color: MP_COLOR.sello, size: 280, bottom: '-100px', left: '-60px' },
        ],
        html: `
          <p class="mes-eyebrow text-pink-100">Capital en movimiento</p>
          <p class="mes-bignum text-zinc-100 mt-3" style="font-size:84px;">
            <span data-counter="${s.capitalMovido}" data-prefix="$" data-decimals="0">$0</span>
          </p>
          <p class="text-pink-100 text-base mt-4">moviste este mes</p>
          <p class="text-pink-50 text-sm mt-12 leading-relaxed">${s.capitalMovido > 50000
            ? 'Inversor activo. Vigila las comisiones — son el enemigo silencioso.'
            : 'Movimiento medido y consciente. La paciencia paga.'}</p>
        `,
      }] : []),

      // ───────────── 7. TICKERS ÚNICOS OPERADOS ─────────────
      ...(s.tickersUnicosOperados > 0 ? [{
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 280, top: '-50px', left: '-70px' },
          { color: MP_COLOR.sello, size: 240, bottom: '-60px', right: '-80px' },
        ],
        html: `
          <p class="mes-eyebrow text-teal-100">Tu paleta del mes</p>
          <p class="mes-bignum text-zinc-100 mt-3" style="font-size:160px;">
            <span data-counter="${s.tickersUnicosOperados}" data-decimals="0">0</span>
          </p>
          <p class="text-teal-100 text-lg mt-2 font-medium">${s.tickersUnicosOperados === 1 ? 'ticker' : 'tickers'} ${s.tickersUnicosOperados === 1 ? 'tocado' : 'tocados'}</p>
          <p class="text-teal-50 text-sm mt-12 leading-relaxed">${s.tickersUnicosOperados > 7
            ? 'Ojo de águila. Te mueves entre muchas oportunidades.'
            : (s.tickersUnicosOperados >= 3 ? 'Diversificación sana en tu actividad.' : 'Foco quirúrgico. Pocos disparos, alta convicción.')}</p>
        `,
      }] : []),

      // ───────────── 8. PERSONALIDAD — TARJETA DE COLECCIÓN ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.sello, size: 260, top: '-40px', right: '-60px' },
          { color: MP_COLOR.sello, size: 280, bottom: '-100px', left: '-80px' },
        ],
        html: `
          <!-- Particles flotando -->
          <div class="absolute inset-0 pointer-events-none">
            ${Array.from({length: 14}, () => {
              const tx = (Math.random()-0.5) * 200;
              const ty = -Math.random() * 300 - 100;
              const left = Math.random() * 100;
              const top = 50 + Math.random() * 50;
              const delay = Math.random() * 2.4;
              const colors = [MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.sello, MP_COLOR.tinta1];
              const color = colors[Math.floor(Math.random()*colors.length)];
              return `<span class="mes-particle" style="left:${left}%; top:${top}%; background:${color}; box-shadow:0 0 8px ${color}; --tx:${tx}px; --ty:${ty}px; animation-delay:${delay}s;"></span>`;
            }).join('')}
          </div>

          <p class="mes-eyebrow text-violet-200 mes-reveal-1">Tu personalidad inversora</p>

          <!-- LA CARTA -->
          <div class="mes-card-stage mt-5">
            <div class="mes-card">
              <div class="mes-card-inner">
                <!-- Top: rareza + estrellas -->
                <div class="flex items-center justify-between">
                  <span class="mes-card-rarity">${vibe.rareza}</span>
                  <div class="mes-card-stars">${Array.from({length: vibe.stars}, () => '<span class="mes-card-star">★</span>').join('')}${Array.from({length: 5 - vibe.stars}, () => '<span class="mes-card-star" style="color:var(--regla-fuerte);">★</span>').join('')}</div>
                </div>

                <!-- Ilustración SVG -->
                <div class="mes-card-illustration">${vibe.svg}</div>

                <!-- Título y descripción -->
                <div class="mes-card-title">${escapeHtml(vibe.tipo)}</div>
                <div class="mes-card-desc">${escapeHtml(vibe.desc)}</div>

                <!-- Stats -->
                <div class="mes-card-stats">
                  <div class="mes-card-stat">
                    <div class="mes-card-stat-label">${escapeHtml(vibe.stat1.label)}</div>
                    <div class="mes-card-stat-value">${escapeHtml(String(vibe.stat1.value))}</div>
                  </div>
                  <div class="mes-card-stat">
                    <div class="mes-card-stat-label">${escapeHtml(vibe.stat2.label)}</div>
                    <div class="mes-card-stat-value">${escapeHtml(String(vibe.stat2.value))}</div>
                  </div>
                </div>
              </div>
              <div class="mes-card-shine"></div>
            </div>
          </div>

          <p class="text-violet-200 text-[11px] tracking-widest mt-6 mes-reveal-5 italic">Coleccionable digital · Edición ${escapeHtml(s.nombreMes.split(' ')[0])}</p>
        `,
        confetti: 30,
      },

      // ───────────── 9. CIERRE ─────────────
      {
        bg: MP_COLOR.supPanel,
        blobs: [
          { color: MP_COLOR.alza, size: 280, top: '-50px', left: '-80px' },
          { color: MP_COLOR.sello, size: 220, bottom: '-60px', right: '-50px' },
          { color: MP_COLOR.sello, size: 200, top: '40%', right: '-40px' },
        ],
        html: `
          <!-- Rays detrás -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg width="500" height="500" viewBox="0 0 500 500" style="opacity:.22; animation: mesRayRotate 90s linear infinite;">
              ${Array.from({length: 24}, (_, i) => {
                const a = (i * 15) * Math.PI / 180;
                return `<polygon points="250,250 ${250 + Math.cos(a)*250},${250 + Math.sin(a)*250} ${250 + Math.cos(a + 0.04)*240},${250 + Math.sin(a + 0.04)*240}" fill="var(--tinta-1)"/>`;
              }).join('')}
            </svg>
          </div>
          <!-- Trofeo SVG -->
          <div class="mes-medal mes-reveal-1">
            <svg width="160" height="160" viewBox="0 0 160 160">
              <defs>
                <linearGradient id="trophyG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--tinta-1)"/><stop offset="50%" stop-color="var(--sello)"/><stop offset="100%" stop-color="var(--sello)"/></linearGradient>
                <radialGradient id="shineT" cx=".3" cy=".3"><stop offset="0%" stop-color="var(--tinta-1)" stop-opacity=".8"/><stop offset="100%" stop-color="var(--tinta-1)" stop-opacity="0"/></radialGradient>
              </defs>
              <path d="M50 40 Q50 100 80 100 Q110 100 110 40 Z" fill="url(#trophyG)" stroke="var(--sello)" stroke-width="2.5"/>
              <path d="M40 50 Q30 60 30 75 Q30 85 40 88" fill="none" stroke="url(#trophyG)" stroke-width="6" stroke-linecap="round"/>
              <path d="M120 50 Q130 60 130 75 Q130 85 120 88" fill="none" stroke="url(#trophyG)" stroke-width="6" stroke-linecap="round"/>
              <rect x="68" y="100" width="24" height="14" fill="url(#trophyG)" stroke="var(--sello)" stroke-width="2"/>
              <rect x="55" y="113" width="50" height="10" rx="2" fill="url(#trophyG)" stroke="var(--sello)" stroke-width="2"/>
              <text x="80" y="74" text-anchor="middle" font-family="Source Serif 4" font-weight="900" font-size="22" fill="var(--sello)">★</text>
              <ellipse cx="64" cy="55" rx="10" ry="14" fill="url(#shineT)"/>
            </svg>
          </div>
          <p class="mes-eyebrow text-emerald-100 mes-reveal-2 mt-2">Hasta el próximo mes</p>
          <p class="mes-bignum mt-3 mes-reveal-3" style="font-size:96px;">
            <span class="bg-gradient-to-r from-white via-yellow-100 to-emerald-200 bg-clip-text text-transparent">Top ${Math.min(s.pctSharpe, s.pctRetorno)}%</span>
          </p>
          <p class="text-emerald-50 text-lg mt-4 leading-relaxed font-medium mes-reveal-4">${s.pctSharpe <= 10 && s.pctRetorno <= 10
            ? 'Estuviste increíble.<br>Sigue así.'
            : (s.pctSharpe <= 25 ? 'Tu mes fue sólido.<br>La consistencia paga.' : 'Cada mes es un nuevo capítulo.<br>El siguiente es tuyo.')}</p>
          <div class="mt-10 inline-flex items-center gap-2 text-emerald-100 text-sm mes-reveal-5">
            <img src="/static/logo.png" alt="" class="w-5 h-5"/>
            <span class="font-semibold tracking-wide">Mi Portafolio</span>
          </div>
        `,
        confetti: 80,
      },
    ];
  }

  function mostrar(esAuto) {
    _injectCSS();
    const s = _estadisticas();
    const slides = _buildSlides(s);
    let pos = 0;
    let autoTimer = null;
    const DURACION_AUTO = 6000;

    const html = `
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4 mes-modal-bg" id="mes-modal">
        <div class="relative w-full max-w-[400px]" style="height: min(720px, calc(100vh - 80px));">
          <!-- Header con dots y cerrar -->
          <div class="absolute top-3 left-3 right-3 z-30 flex items-center gap-1">
            ${slides.map((_, i) => `<div class="flex-1 h-[3px] bg-zinc-800/70 rounded-full overflow-hidden"><div class="mes-bar h-full bg-zinc-100 rounded-full" data-i="${i}" style="width:${i < pos ? '100%' : '0%'}"></div></div>`).join('')}
            <button id="mes-cerrar" class="ml-2 text-zinc-400 hover:text-zinc-100 text-xl leading-none">×</button>
          </div>

          <!-- Slide host -->
          <div id="mes-slide-host" class="absolute inset-0 rounded-3xl overflow-hidden shadow-2xl"></div>

          <!-- Tap zones -->
          <div id="mes-tap-prev" class="mes-tap-zone left-0"></div>
          <div id="mes-tap-next" class="mes-tap-zone right-0"></div>

          <!-- Action footer -->
          <div class="absolute -bottom-14 left-0 right-0 flex items-center justify-center gap-3">
            <button id="mes-share" class="text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800/40 hover:bg-zinc-800/60 backdrop-blur rounded-full px-4 py-2 border border-zinc-700 transition flex items-center gap-1.5">
              <span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="6.5" y="2.5" width="11" height="19"/><path d="M10.5 18.5h3"/></svg></span> Compartir slide
            </button>
            ${esAuto ? '<span class="text-[10px] text-zinc-500 italic">Aparecerá cada día 1 del mes</span>' : ''}
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    function pintar() {
      const slide = slides[pos];
      const host = $('mes-slide-host');
      // Construir slide
      host.innerHTML = `
        <div class="mes-slide w-full h-full relative overflow-hidden flex flex-col items-center justify-center text-center px-8" style="background: ${slide.bg}; font-family: 'Source Serif 4', Georgia, serif;">
          ${(slide.blobs || []).map(b => `<div class="mes-blob" style="
            background:${b.color};
            width:${b.size}px; height:${b.size}px;
            ${b.top !== undefined ? `top:${b.top};` : ''}
            ${b.bottom !== undefined ? `bottom:${b.bottom};` : ''}
            ${b.left !== undefined ? `left:${b.left};` : ''}
            ${b.right !== undefined ? `right:${b.right};` : ''}
            opacity:0.5;
          "></div>`).join('')}
          <div class="relative z-10 w-full" id="mes-slide-content">${slide.html}</div>
          <div id="mes-confetti-host" class="absolute inset-0 pointer-events-none overflow-hidden"></div>
        </div>`;

      // Animar contadores
      host.querySelectorAll('[data-counter]').forEach(el => {
        const target = parseFloat(el.dataset.counter) || 0;
        const decimals = parseInt(el.dataset.decimals || '0', 10);
        const prefix = el.dataset.prefix || '';
        const suffix = el.dataset.suffix || '';
        const format = el.dataset.format;
        let formatter;
        if (format === 'topPct') formatter = v => `Top ${Math.round(v)}%`;
        else formatter = v => prefix + (decimals === 0
          ? Math.round(v).toLocaleString('en-US')
          : v.toFixed(decimals)) + suffix;
        _animateNumber(el, target, 1200, formatter);
      });

      // Confetti
      if (slide.confetti) {
        setTimeout(() => _confetti($('mes-confetti-host'), slide.confetti), 200);
      }

      // Barras de progreso
      document.querySelectorAll('.mes-bar').forEach(bar => {
        const i = parseInt(bar.dataset.i);
        if (i < pos)      bar.style.width = '100%';
        else if (i === pos) {
          bar.style.width = '0%';
          bar.style.transition = 'none';
          // Forzar reflow y aplicar
          bar.offsetWidth;
          bar.style.transition = `width ${DURACION_AUTO}ms linear`;
          bar.style.width = '100%';
        }
        else              bar.style.width = '0%';
      });

      // Auto-advance
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        if (pos < slides.length - 1) { pos++; pintar(); }
        else { /* fin: queda en última slide */ }
      }, DURACION_AUTO);
    }

    function siguiente() {
      if (pos < slides.length - 1) { pos++; pintar(); }
    }
    function anterior() {
      if (pos > 0) { pos--; pintar(); }
    }
    function cerrar() {
      clearTimeout(autoTimer);
      $('mes-modal')?.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') cerrar();
      else if (e.key === 'ArrowRight' || e.key === ' ') siguiente();
      else if (e.key === 'ArrowLeft') anterior();
    }
    document.addEventListener('keydown', onKey);

    $('mes-cerrar').addEventListener('click', cerrar);
    $('mes-tap-prev').addEventListener('click', anterior);
    $('mes-tap-next').addEventListener('click', siguiente);
    $('mes-modal').addEventListener('click', (e) => {
      if (e.target.id === 'mes-modal') cerrar();
    });

    // Compartir slide actual como PNG
    $('mes-share').addEventListener('click', async () => {
      const slideEl = $('mes-slide-host')?.firstElementChild;
      if (!slideEl) return;
      const btn = $('mes-share');
      const orig = btn.innerHTML;
      btn.innerHTML = '<span>⏳</span> Generando…';
      btn.disabled = true;
      try {
        if (typeof html2canvas === 'undefined') throw new Error('html2canvas no cargó');
        const canvas = await html2canvas(slideEl, {
          backgroundColor: null, scale: 2, useCORS: true, logging: false,
        });
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const archivo = new File([blob], `mi-portafolio-wrap-${pos+1}.png`, { type: 'image/png' });
        // Web Share API si disponible
        if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
          await navigator.share({
            files: [archivo],
            title: 'Mi mes en Mi Portafolio',
            text: `Mi mes en Mi Portafolio · ${s.nombreMes}`,
          });
        } else {
          // Fallback: descarga
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `mi-portafolio-wrap-${pos+1}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }
      } catch (err) {
        alert('No se pudo generar la imagen: ' + (err.message || err));
      } finally {
        btn.innerHTML = orig;
        btn.disabled = false;
      }
    });

    pintar();
  }

  return { bind, mostrar };
})();
// Compatibilidad
const TuMesAlias = TuMes;
const TuAno = TuMes;
/* OLD_TU_MES_DEAD_CODE_START
  const KEY_LAST = 'miPortafolio.wrapShown.v1';

  function bind() {
    $('ano-abrir')?.addEventListener('click', mostrar);
    // Auto-popup el día 1 del mes si no se ha mostrado este mes
    const hoy = new Date();
    const yyyymm = hoy.getFullYear() + '-' + String(hoy.getMonth()+1).padStart(2,'0');
    let ultimoMostrado = null;
    try { ultimoMostrado = localStorage.getItem(KEY_LAST); } catch {}
    if (hoy.getDate() === 1 && ultimoMostrado !== yyyymm) {
      // Mostrar 1 segundo después de cargar para que el dashboard tenga tiempo de pintarse
      setTimeout(() => {
        mostrar(true);
        try { localStorage.setItem(KEY_LAST, yyyymm); } catch {}
      }, 1500);
    }
  }

  function _percentil(metric, value) {
    // Heurísticas de "ranking" — ilustrativo, no real
    if (metric === 'sharpe') {
      if (value >= 2.0) return 1;
      if (value >= 1.5) return 5;
      if (value >= 1.0) return 15;
      if (value >= 0.5) return 35;
      if (value >= 0)   return 55;
      return 80;
    }
    if (metric === 'retorno_anual') {
      if (value >= 25) return 2;
      if (value >= 18) return 8;
      if (value >= 12) return 22;
      if (value >= 8)  return 40;
      if (value >= 4)  return 60;
      if (value >= 0)  return 75;
      return 90;
    }
    if (metric === 'ops') {
      if (value >= 20) return 5;
      if (value >= 10) return 15;
      if (value >= 5)  return 30;
      if (value >= 2)  return 50;
      return 75;
    }
    return 50;
  }

  function _estadisticas() {
    const hoy = new Date();
    const yyyymm = hoy.getFullYear() + '-' + String(hoy.getMonth()+1).padStart(2,'0');
    // Mes "en revisión": el mes anterior (porque el 1 del mes actual ya cerró el mes pasado)
    const mesAnt = new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
    const yyyymmAnt = mesAnt.getFullYear() + '-' + String(mesAnt.getMonth()+1).padStart(2,'0');
    const nombreMes = mesAnt.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });

    const tickers = leerPortafolioGuardado() || [];
    let txs = [];
    try { txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]'); } catch {}
    const txsMes = txs.filter(t => (t.fecha || '').startsWith(yyyymmAnt));
    const txsAno = txs.filter(t => (t.fecha || '').startsWith(String(mesAnt.getFullYear())));

    const compras = txsMes.filter(t => t.tipo === 'compra').length;
    const ventas  = txsMes.filter(t => t.tipo === 'venta').length;
    const totalOps = compras + ventas;

    const dividendosMes = txsMes.filter(t => t.tipo === 'dividendo')
      .reduce((s, t) => s + ((t.shares || 0) * (t.precio || 0)), 0);
    const dividendosAno = txsAno.filter(t => t.tipo === 'dividendo')
      .reduce((s, t) => s + ((t.shares || 0) * (t.precio || 0)), 0);

    // Capital movido el mes
    const capitalMovido = txsMes.reduce((s, t) => {
      if (t.tipo === 'compra' || t.tipo === 'venta') {
        const m = (t.shares || 0) * (t.precio || 0) * (t.moneda === 'USD' ? 17 : 1);
        return s + m;
      }
      return s;
    }, 0);

    // Métricas del KPI rendereado (heurísticas para percentiles)
    const retAnualTxt = ($('kpi-retorno-anual')?.textContent || '').replace(/[^\d.\-]/g, '');
    const retAnual    = parseFloat(retAnualTxt) || 0;
    const sharpeTxt   = ($('kpi-sharpe')?.textContent || '').replace(/[^\d.\-]/g, '');
    const sharpe      = parseFloat(sharpeTxt) || 0;

    const tickerMasOperado = (() => {
      const counts = {};
      txsMes.forEach(t => { counts[t.ticker] = (counts[t.ticker]||0)+1; });
      let max = 0, ticker = null;
      Object.entries(counts).forEach(([t, c]) => { if (c > max) { max = c; ticker = t; } });
      return ticker;
    })();

    const portData = PortfolioManager.activoData();

    return {
      nombreMes, yyyymmAnt,
      portafolio:   portData,
      tickers:      tickers.length,
      totalOps, compras, ventas,
      dividendosMes, dividendosAno,
      capitalMovido,
      retAnual, sharpe,
      tickerMasOperado,
      tickersUnicosOperados: new Set(txsMes.map(t => t.ticker)).size,
      pctSharpe:   _percentil('sharpe', sharpe),
      pctRetorno:  _percentil('retorno_anual', retAnual),
      pctOps:      _percentil('ops', totalOps),
    };
  }

  function _slide(emoji, eyebrow, big, sub, footer) {
    return `
      <div class="bg-gradient-to-br from-emerald-900/30 via-zinc-900 to-emerald-900/10 border border-accent-green/20 rounded-2xl p-7 text-center min-h-[260px] flex flex-col justify-center">
        <div class="text-5xl mb-3">${emoji}</div>
        <p class="text-[10px] uppercase tracking-[0.25em] text-accent-green font-bold">${eyebrow}</p>
        <p class="display text-4xl sm:text-5xl font-bold tabular text-zinc-100 mt-3 leading-tight">${big}</p>
        ${sub ? `<p class="text-sm text-zinc-300 mt-2 leading-relaxed">${sub}</p>` : ''}
        ${footer ? `<p class="text-[11px] text-zinc-500 mt-4 italic">${footer}</p>` : ''}
      </div>`;
  }

  function _vibePersonalidad(s) {
    if (s.sharpe >= 1.5 && s.totalOps >= 5) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></svg></span>', tipo: 'El Cazador', desc: 'Activo, calculador y con buen ratio riesgo/recompensa.' };
    if (s.sharpe >= 1.5) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="6" r="2.4"/><path d="M12 9v6"/><path d="M6.5 20c1-3 3-4.5 5.5-4.5S16.5 17 17.5 20"/><path d="M4 20h16"/></svg></span>', tipo: 'El Sabio', desc: 'Pocas operaciones, gran visión. Tu Sharpe habla por ti.' };
    if (s.totalOps >= 15) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg></span>', tipo: 'El Trader', desc: 'Mueves mucho. Cuidado con las comisiones — podrían comerse tu alfa.' };
    if (s.dividendosMes > 100) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10"/><path d="M14.5 9.5H10.7a1.8 1.8 0 0 0 0 3.6h2.6a1.8 1.8 0 0 1 0 3.6H9.5"/></svg></span>', tipo: 'El Rentista', desc: 'Buscas flujo, no glamour. Los dividendos siguen llegando.' };
    if (s.tickers >= 10) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg></span>', tipo: 'El Diversificador', desc: 'No pones todos los huevos en una canasta. Bien jugado.' };
    if (s.tickers <= 3) return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="4" y="4" width="16" height="16"/><circle cx="9" cy="9" r="1.1"/><circle cx="15" cy="15" r="1.1"/><circle cx="12" cy="12" r="1.1"/></svg></span>', tipo: 'El Convencido', desc: 'Pocos tickers, mucha convicción. Si funciona, funciona en grande.' };
    return { emoji: '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M4 19V11"/><path d="M10 19V6"/><path d="M16 19V14"/><path d="M22 19H2"/></svg></span>', tipo: 'El Constructor', desc: 'Estás armando tu portafolio con paciencia. Eso es lo que cuenta.' };
  }

  function mostrar(esAuto) {
    const s = _estadisticas();
    const vibe = _vibePersonalidad(s);
    const fmt$ = v => '$' + Math.round(v).toLocaleString('en-US');

    const slides = [];

    // 1. Apertura
    slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="3" y="9" width="18" height="12"/><path d="M2 9h20v3H2z"/><path d="M12 9v12"/><path d="M12 9C10 9 7.5 8 7.5 6A2.5 2.5 0 0 1 12 5a2.5 2.5 0 0 1 4.5 1c0 2-2.5 3-4.5 3z"/></svg></span>', 'Tu mes en Mi Portafolio',
      s.nombreMes,
      `Hola Charlie. Esto es lo que pasó en tu portafolio "<span class="text-accent-green">${escapeHtml(s.portafolio.nombre)}</span>".`,
      'Desliza para ver más →'));

    // 2. Top X% Sharpe
    slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/><path d="M10 14h4v3h-4z"/><path d="M7.5 20h9"/></svg></span>', 'Tu Sharpe del mes',
      `Top ${s.pctSharpe}%`,
      `Tu Sharpe ratio fue de <span class="text-accent-green font-semibold tabular">${s.sharpe.toFixed(2)}</span>. Mejor que el ${100 - s.pctSharpe}% de portafolios diversificados.`,
      s.pctSharpe <= 10 ? 'Estás entre la élite del retorno ajustado al riesgo.' : 'Hay margen de subir esto el próximo mes.'));

    // 3. Retorno anualizado
    slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/></svg></span>', 'Retorno anualizado',
      (s.retAnual >= 0 ? '+' : '') + s.retAnual.toFixed(1) + '%',
      `Estás en el top ${s.pctRetorno}% de inversionistas en términos de retorno.`,
      'Recuerda: rentabilidad pasada no garantiza la futura.'));

    // 4. Operaciones
    slides.push(_slide(s.totalOps > 10 ? '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg></span>' : (s.totalOps > 0 ? '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="2.5" y="7" width="19" height="13"/><path d="M9 7V4h6v3"/><path d="M2.5 12.5h19"/></svg></span>' : '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="6" r="2.4"/><path d="M12 9v6"/><path d="M6.5 20c1-3 3-4.5 5.5-4.5S16.5 17 17.5 20"/><path d="M4 20h16"/></svg></span>'),
      'Operaciones del mes',
      String(s.totalOps),
      `${s.compras} compras · ${s.ventas} ventas. ${s.totalOps > 10 ? 'Más activo que el ' + (100 - s.pctOps) + '% de inversionistas.' : (s.totalOps > 0 ? 'Movimiento moderado.' : 'No moviste el portafolio. A veces no hacer nada es lo mejor.')}`,
      s.tickerMasOperado ? `Tu ticker más operado: <span class="font-mono text-accent-green">${escapeHtml(s.tickerMasOperado)}</span>` : ''));

    // 5. Dividendos
    if (s.dividendosMes > 0 || s.dividendosAno > 0) {
      slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10"/><path d="M14.5 9.5H10.7a1.8 1.8 0 0 0 0 3.6h2.6a1.8 1.8 0 0 1 0 3.6H9.5"/></svg></span>', 'Dividendos cobrados',
        fmt$(s.dividendosMes),
        s.dividendosAno > s.dividendosMes ? `En lo que va del año: <span class="text-accent-green font-semibold">${fmt$(s.dividendosAno)}</span>` : 'Tu primer flujo pasivo del año.',
        'Cada peso de dividendo es un peso que no necesitas vender.'));
    }

    // 6. Capital movido
    if (s.capitalMovido > 0) {
      slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><rect x="2.5" y="6" width="19" height="12"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9v6M18 9v6"/></svg></span>', 'Capital movido',
        fmt$(s.capitalMovido),
        `Compraste y vendiste por un total de ${fmt$(s.capitalMovido)} este mes.`,
        s.capitalMovido > 50000 ? 'Inversor activo. Revisa que las comisiones no te estén comiendo.' : 'Movimiento sano y medido.'));
    }

    // 7. Tickers únicos
    if (s.tickersUnicosOperados > 0) {
      slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-.9 2-1.8 0-1.5-1-1.8-1-3 0-.9.7-1.6 1.7-1.6H17a4.5 4.5 0 0 0 4.5-4.5C21.5 6.2 17.3 3 12 3z"/><circle cx="8" cy="9" r="1"/><circle cx="12.5" cy="7" r="1"/><circle cx="7" cy="13.5" r="1"/></svg></span>', 'Tickers operados',
        String(s.tickersUnicosOperados),
        `Tocaste ${s.tickersUnicosOperados} ${s.tickersUnicosOperados === 1 ? 'ticker distinto' : 'tickers distintos'} este mes.`,
        s.tickersUnicosOperados > 7 ? 'Muy diversificado en tu actividad.' : ''));
    }

    // 8. Personalidad
    slides.push(_slide(vibe.emoji, 'Tu personalidad inversora',
      vibe.tipo,
      vibe.desc,
      'Algoritmo basado en tu Sharpe, frecuencia de trading y diversificación.'));

    // 9. Cierre
    const tagline = s.pctSharpe <= 10 && s.pctRetorno <= 10
      ? 'Estuviste increíble este mes. Sigue así.'
      : s.pctSharpe <= 25
      ? 'Tu mes fue sólido. La consistencia es la mejor estrategia.'
      : 'Cada mes es un nuevo capítulo. El siguiente es tuyo.';
    slides.push(_slide('<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg></span>', 'Hasta el próximo mes',
      `Top ${Math.min(s.pctSharpe, s.pctRetorno)}%`,
      tagline,
      'Mi Portafolio · Tu compañero financiero'));

    const html = `
      <div class="fixed inset-0 bg-[color:rgba(26,26,24,.40)] z-50 flex items-center justify-center p-4 backdrop-blur-md" id="mes-modal">
        <div class="max-w-md w-full">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="text-xs text-zinc-500">Slide <span id="mes-pos">1</span> de ${slides.length}</span>
              <div class="flex gap-1">
                ${slides.map((_, i) => `<span class="mes-dot w-1.5 h-1.5 rounded-full bg-zinc-700 ${i===0?'!bg-accent-green':''}" data-i="${i}"></span>`).join('')}
              </div>
            </div>
            <button id="mes-cerrar" class="text-zinc-500 hover:text-zinc-200 text-xl">✕</button>
          </div>
          <div id="mes-slide-host"></div>
          <div class="flex gap-2 mt-4">
            <button id="mes-prev" class="flex-1 text-xs py-2 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition">‹ Anterior</button>
            <button id="mes-next" class="flex-1 text-xs py-2 rounded-md bg-accent-green text-zinc-950 font-semibold hover:brightness-110 transition">Siguiente ›</button>
          </div>
          ${esAuto ? '<p class="text-center text-[10px] text-zinc-600 mt-3 italic">Aparecerá automáticamente cada día 1 del mes</p>' : ''}
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    let pos = 0;
    function pintar() {
      $('mes-slide-host').innerHTML = slides[pos];
      $('mes-pos').textContent = pos + 1;
      document.querySelectorAll('.mes-dot').forEach((d, i) => {
        d.className = `mes-dot w-1.5 h-1.5 rounded-full ${i===pos?'!bg-accent-green':'bg-zinc-700'}`;
      });
      $('mes-prev').disabled = pos === 0;
      $('mes-prev').classList.toggle('opacity-40', pos === 0);
      $('mes-next').textContent = pos === slides.length - 1 ? '✓ Cerrar' : 'Siguiente ›';
    }
    pintar();
    $('mes-prev').addEventListener('click', () => { if (pos > 0) { pos--; pintar(); } });
    $('mes-next').addEventListener('click', () => {
      if (pos === slides.length - 1) { $('mes-modal').remove(); return; }
      pos++; pintar();
    });
    $('mes-cerrar').addEventListener('click', () => $('mes-modal').remove());
    $('mes-modal').addEventListener('click', (e) => { if (e.target.id === 'mes-modal') $('mes-modal').remove(); });
  }

  return { bind, mostrar };
})();
OLD_TU_MES_DEAD_CODE_END */


// --- NAV entre vistas ------------------------------------------------------
// ============================================================
// MÓDULO: ANALIZADOR (pestaña Explorar — análisis individual)
// ============================================================
const Analizador = (() => {
  const SUGERENCIAS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'WALMEX.MX', 'GFNORTEO.MX', 'BTC-USD', 'ETH-USD'];
  const estado = {
    universo:   [],
    cargado:    false,
    filtro:     'todas',
    busqueda:   '',
    scoreMap:   null,
    ordenScore: false,
  };
  let inicializado = false;

  function esCriptoTk(t) {
    return /-USD$/.test(t.ticker) || /cripto/i.test(t.sector || '') || /crypto/i.test(t.sector || '');
  }

  function bind() {
    const btn = $('an-btn-analizar');
    const inp = $('an-input');
    if (!btn || !inp) return;
    btn.addEventListener('click', () => analizar(inp.value));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') analizar(inp.value);
    });

    // Filtros del universo
    document.querySelectorAll('.an-filtro').forEach(b => {
      b.addEventListener('click', () => {
        estado.filtro = b.dataset.anFiltro;
        document.querySelectorAll('.an-filtro').forEach(x => {
          const activo = x === b;
          x.classList.toggle('text-zinc-300', activo);
          x.classList.toggle('bg-zinc-900', activo);
          x.classList.toggle('text-zinc-500', !activo);
        });
        renderUniverso();
      });
    });

    // Orden por score (mayor a menor) — usa /api/ranking
    const ordenBtn = document.getElementById('an-orden-score');
    if (ordenBtn) ordenBtn.addEventListener('click', async () => {
      estado.ordenScore = !estado.ordenScore;
      ['text-zinc-100', 'bg-accent-amber/15', 'ring-1', 'ring-accent-amber/30'].forEach(c => ordenBtn.classList.toggle(c, estado.ordenScore));
      ordenBtn.classList.toggle('text-zinc-500', !estado.ordenScore);
      if (estado.ordenScore && !estado.scoreMap) {
        const prev = ordenBtn.textContent;
        ordenBtn.textContent = 'Cargando…';
        try {
          const r = await fetch('/api/ranking?n=300');
          const d = await r.json();
          estado.scoreMap = {};
          (d.items || []).forEach(it => { estado.scoreMap[it.ticker] = it.score; });
        } catch {}
        ordenBtn.textContent = prev;
      }
      renderUniverso();
    });

    // Buscador del universo
    const inpBusc = $('an-univ-buscar');
    if (inpBusc) {
      inpBusc.addEventListener('input', () => {
        estado.busqueda = inpBusc.value;
        renderUniverso();
      });
    }
  }

  async function cargar() {
    if (inicializado) return;
    inicializado = true;
    // Sugerencias rápidas
    const cont = $('an-sugerencias');
    if (cont) {
      cont.innerHTML = SUGERENCIAS.map(t => `
        <button data-sug="${t}" class="an-sug px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-400 hover:border-accent-orange hover:text-accent-orange transition tabular">${t}</button>
      `).join('');
      cont.querySelectorAll('.an-sug').forEach(b => {
        b.addEventListener('click', () => {
          $('an-input').value = b.dataset.sug;
          analizar(b.dataset.sug);
        });
      });
    }
    // Universo completo
    await cargarUniverso();
  }

  async function cargarUniverso(intento = 0) {
    if (estado.cargado) { renderUniverso(); return; }
    try {
      const res = await fetch('/api/universo');
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      if (!body || !Array.isArray(body.tickers)) throw new Error('respuesta vacía');
      estado.universo = body.tickers;
      estado.cargado = true;
      const recos = estado.universo.filter(x => x.recomendada).length;
      const meta = $('an-univ-meta');
      if (meta) meta.textContent = `· ${estado.universo.length} acciones`;
      renderUniverso();
    } catch (err) {
      // Reintentar hasta 2 veces (cold start de Render)
      if (intento < 2) {
        const cont = $('an-univ-lista');
        if (cont) cont.innerHTML = `
          <div class="col-span-full text-center text-xs text-zinc-500 py-6">
            Cargando universo… ${intento + 1}/3
          </div>`;
        setTimeout(() => cargarUniverso(intento + 1), 4000);
        return;
      }
      const cont = $('an-univ-lista');
      if (cont) cont.innerHTML = `
        <div class="col-span-full text-center text-xs text-zinc-500 py-6">
          Universo no disponible.
          <button onclick="location.reload()" class="ml-2 px-2 py-1 bg-zinc-700 rounded text-xs hover:bg-zinc-600">↻ Recargar</button>
        </div>`;
    }
  }

  function filtrarUniverso() {
    const s = (estado.busqueda || '').trim().toLowerCase();
    return estado.universo.filter(t => {
      if (estado.filtro === 'recomendadas' && !t.recomendada) return false;
      if (estado.filtro === 'mx' && t.moneda !== 'MXN') return false;
      if (estado.filtro === 'us' && (t.moneda !== 'USD' || esCriptoTk(t))) return false;
      if (estado.filtro === 'crypto' && !esCriptoTk(t)) return false;
      if (s) {
        return t.ticker.toLowerCase().includes(s)
          || (t.nombre || '').toLowerCase().includes(s)
          || (t.sector || '').toLowerCase().includes(s);
      }
      return true;
    });
  }

  function renderUniverso() {
    const cont = $('an-univ-lista');
    if (!cont) return;
    if (!estado.universo.length) return;
    const lista = filtrarUniverso();
    if (estado.ordenScore && estado.scoreMap) {
      lista.sort((a, b) => (estado.scoreMap[b.ticker] ?? -1) - (estado.scoreMap[a.ticker] ?? -1));
    }
    if (!lista.length) {
      cont.innerHTML = `<div class="col-span-full text-center text-xs text-zinc-500 py-6">Sin resultados.</div>`;
      return;
    }
    // Tope visual: 300 — el scroll vertical maneja el resto
    const TOPE = 300;
    const visible = lista.slice(0, TOPE);
    const html = visible.map(t => {
      const cripto = esCriptoTk(t);
      const flag = cripto ? '₿' : (t.moneda === 'MXN' ? 'MX' : (t.moneda === 'USD' ? 'US' : '·'));
      const flagCls = cripto
        ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
        : t.moneda === 'MXN'
          ? 'bg-accent-green/10 text-accent-green border-accent-green/20'
          : t.moneda === 'USD'
            ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'
            : 'bg-zinc-800 text-zinc-500 border-zinc-700';
      return `
        <button data-an-tk="${escapeHtml(t.ticker)}" class="an-tk text-left p-2.5 rounded-lg border border-surface-border bg-zinc-900/40 hover:border-accent-orange hover:bg-accent-orange/5 transition flex items-center gap-2.5">
          <span class="text-[9px] px-1.5 py-0.5 rounded border ${flagCls} font-mono shrink-0">${flag}</span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-mono text-zinc-100 truncate">${escapeHtml(t.ticker)}</p>
            <p class="text-[10px] text-zinc-500 truncate">${escapeHtml(t.nombre || '')}</p>
          </div>
          ${(estado.ordenScore && estado.scoreMap && estado.scoreMap[t.ticker] != null) ? `<span class="text-[11px] font-bold tabular px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber shrink-0">${estado.scoreMap[t.ticker]}</span>` : ''}
        </button>
      `;
    }).join('');
    const hint = lista.length > TOPE
      ? `<div class="col-span-full text-[10px] text-zinc-500 text-center py-3 bg-zinc-900/40 border border-surface-border rounded-lg mt-1">
           Mostrando <span class="text-accent-orange font-semibold">${TOPE}</span> de <span class="text-zinc-300 font-semibold">${lista.length.toLocaleString()}</span> resultados ·
           usa el buscador o filtros para acotar
         </div>`
      : `<div class="col-span-full text-[10px] text-zinc-600 text-center py-2">${lista.length.toLocaleString()} resultados</div>`;
    cont.innerHTML = html + hint;
    cont.querySelectorAll('.an-tk').forEach(b => {
      b.addEventListener('click', () => {
        const tk = b.dataset.anTk;
        $('an-input').value = tk;
        analizar(tk);
      });
    });
  }

  async function analizar(ticker) {
    ticker = (ticker || '').trim().toUpperCase();
    if (!ticker) return;

    $('an-resultado').classList.add('hidden');
    $('an-error').classList.add('hidden');
    $('an-loading').classList.remove('hidden');
    $('an-loading-ticker').textContent = ticker;
    $('an-btn-analizar').disabled = true;

    try {
      const res = await fetch(`/api/analizar/${encodeURIComponent(ticker)}`);
      const body = await res.json();
      if (!res.ok || !body.ok) {
        const msg = body.error || `No se encontró análisis para ${ticker}.`;
        throw new Error(msg);
      }
      render(body);
    } catch (e) {
      $('an-error-msg').textContent = e.message || String(e);
      $('an-error').classList.remove('hidden');
    } finally {
      $('an-loading').classList.add('hidden');
      $('an-btn-analizar').disabled = false;
    }
  }

  function fmtPct(v) { return (v == null) ? '—' : (v * 100).toFixed(1) + '%'; }
  function fmtNum(v, d=2) { return (v == null) ? '—' : Number(v).toFixed(d); }
  function fmtMoney(v, mon='USD') {
    if (v == null) return '—';
    const sym = mon === 'MXN' ? '$' : '$';
    if (Math.abs(v) >= 1e12) return `${sym}${(v/1e12).toFixed(2)}T`;
    if (Math.abs(v) >= 1e9)  return `${sym}${(v/1e9).toFixed(2)}B`;
    if (Math.abs(v) >= 1e6)  return `${sym}${(v/1e6).toFixed(2)}M`;
    return `${sym}${v.toFixed(2)}`;
  }

  function colorVeredicto(c) {
    return ({
      green: 'text-accent-green border-accent-green/40 bg-accent-green/10',
      blue:  'text-accent-blue border-accent-blue/40 bg-accent-blue/10',
      amber: 'text-accent-amber border-accent-amber/40 bg-accent-amber/10',
      red:   'text-accent-red border-accent-red/40 bg-accent-red/10',
    })[c] || 'text-zinc-400 border-zinc-700 bg-zinc-900';
  }

  let _chartPrecio = null;
  async function _renderPrecioChart(ticker, rango) {
    const cv = $('an-price-canvas');
    if (!cv || typeof Chart === 'undefined') return;
    let d = null;
    try {
      const r = await fetch(`/api/historico/${encodeURIComponent(ticker)}?rango=${rango}`);
      d = await r.json();
    } catch { d = null; }
    if (!d || !d.ok || !Array.isArray(d.precios) || !d.precios.length) return;
    if (_chartPrecio) { _chartPrecio.destroy(); _chartPrecio = null; }
    const sube = d.precios[d.precios.length - 1] >= d.precios[0];
    const col = sube ? MP_GRAFICA.alza : MP_GRAFICA.baja;
    _chartPrecio = new Chart(cv.getContext('2d'), {
      type: 'line',
      data: { labels: d.fechas, datasets: [{
        // `col` ya viene en verde/rojo de mercado según la dirección del precio.
        data: d.precios, ...MP_GRAFICA.serie(col, { borderWidth: 1.5 }),
      }] },
      options: MP_GRAFICA.base({
        plugins: { legend: MP_GRAFICA.leyenda(false), tooltip: MP_GRAFICA.tooltip() },
        scales: { x: MP_GRAFICA.ejeTiempo(), y: MP_GRAFICA.ejeValor() },
      }),
    });
  }

  // ============================================================
  //  PERFIL POR TIPO DE ACTIVO (ETF / criptomoneda)
  // ============================================================
  //  El análisis de acciones (FCF, P/E, márgenes, peers por P/S) no aplica a un
  //  ETF ni a una cripto y dejaba la pantalla medio vacía. Aquí se pinta lo que
  //  SÍ aplica a cada tipo.
  //
  //  REGLA DE ORO: si el backend no mandó un dato, la clave no existe y el
  //  bloque entero NO se dibuja. Cero guiones, cero "N/D", cero secciones
  //  vacías — eso es justo lo que hacía ver la app incompleta.
  function _pfPct(v, d = 1) { return (v == null) ? null : `${(v * 100).toFixed(d)}%`; }
  function _pfNum(v, d = 2) { return (v == null) ? null : Number(v).toFixed(d); }
  function _pfMoneda(v, mon = 'USD') {
    if (v == null) return null;
    const s = mon === 'MXN' ? '$' : 'US$';
    const a = Math.abs(v);
    if (a >= 1e12) return `${s}${(v / 1e12).toFixed(2)} B`;      // billones (es-MX)
    if (a >= 1e9) return `${s}${(v / 1e9).toFixed(2)} mil M`;
    if (a >= 1e6) return `${s}${(v / 1e6).toFixed(1)} M`;
    return `${s}${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  function _pfEntero(v) {
    return (v == null) ? null : Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }

  /* Celda de métrica. `ayuda` sale del glosario del backend y se cuelga del
     tooltip [data-tip] que ya usa el resto de la app. */
  function _pfKpi(etiqueta, valor, ayuda, cls) {
    if (valor == null || valor === '') return '';
    return `
      <div class="mp-celda">
        <p class="mp-etq ${ayuda ? '' : ''}" ${ayuda ? `data-tip="${escapeHtml(ayuda)}"` : ''}>${escapeHtml(etiqueta)}</p>
        <p class="text-[15px] font-semibold tabular mt-1 ${cls || 'text-zinc-100'}">${escapeHtml(String(valor))}</p>
      </div>`;
  }

  /* Bloque con encabezado de sección. Devuelve '' si no hay contenido: así el
     "omite el bloque completo" se cumple sin repetir condicionales. */
  function _pfBloque(titulo, cuerpo, nota) {
    const limpio = (cuerpo || '').trim();
    if (!limpio) return '';
    return `
      <section class="mt-6">
        <div class="mp-sec"><span class="mp-sec-etq">${escapeHtml(titulo)}</span></div>
        ${limpio}
        ${nota ? `<p class="mp-firma mt-2" style="text-transform:none;letter-spacing:0">${nota}</p>` : ''}
      </section>`;
  }

  function _pfRejilla(celdas) {
    const c = celdas.filter(Boolean).join('');
    return c ? `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">${c}</div>` : '';
  }

  /* Barra de peso (composición). Solo transform/anchura estática, sin animación. */
  function _pfBarra(nombre, peso, extra) {
    const p = Math.max(0, Math.min(1, peso || 0));
    return `
      <div class="flex items-center gap-3 py-1.5 border-b border-surface-border last:border-0">
        <span class="text-[12px] text-zinc-200 flex-1 min-w-0 truncate">${escapeHtml(nombre)}</span>
        ${extra ? `<span class="text-[10px] text-zinc-500 tabular shrink-0">${escapeHtml(extra)}</span>` : ''}
        <span class="h-1.5 w-16 sm:w-24 shrink-0 bg-zinc-800 overflow-hidden" aria-hidden="true">
          <span style="display:block;height:100%;width:${(p * 100).toFixed(1)}%;background:var(--sello)"></span>
        </span>
        <span class="text-[12px] tabular text-zinc-100 shrink-0 w-12 text-right">${(p * 100).toFixed(1)}%</span>
      </div>`;
  }

  function _perfilETF(d) {
    const P = d.perfil || {};
    const G = P.glosario || {};
    const nar = d.narrativa_tipo || {};
    const mon = d.moneda || 'USD';
    const id = P.identidad || {}, co = P.costo || {}, re = P.reparto || {};
    const cm = P.composicion || {}, ri = P.riesgo || {}, mx = P.mexico || {};
    let html = '';

    // Qué es y qué replica
    html += _pfBloque('Qué es y qué replica', [
      nar.que_es ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.que_es)}</p>` : '',
      _pfRejilla([
        _pfKpi('Índice que replica', id.indice),
        _pfKpi('Categoría', id.categoria),
        _pfKpi('Gestora', id.gestora),
        _pfKpi('Figura legal', id.figura_legal),
        _pfKpi('Moneda', id.moneda),
        _pfKpi('Años operando', id.anios_operando != null ? `${id.anios_operando}` : null,
          'Cuánto lleva funcionando. Un histórico largo permite ver cómo se comportó en crisis pasadas.'),
        _pfKpi('Bolsa', id.bolsa),
      ]),
    ].join(''));

    // Costo y tamaño
    html += _pfBloque('Costo, tamaño y reparto', [
      nar.costo ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.costo)}</p>` : '',
      _pfRejilla([
        _pfKpi('Costo anual (TER)', _pfPct(co.ter, 2), G.ter,
          co.ter != null && co.ter_promedio_categoria != null
            ? (co.ter <= co.ter_promedio_categoria ? 'text-accent-green' : 'text-accent-red') : ''),
        _pfKpi('Promedio de su categoría', _pfPct(co.ter_promedio_categoria, 2)),
        _pfKpi('Activos bajo gestión', _pfMoneda(co.aum, mon), G.aum),
        _pfKpi('Rotación de cartera', _pfPct(co.rotacion_cartera, 0),
          'Qué porcentaje de la cartera se recompone al año. Mucha rotación encarece el fondo por dentro.'),
        _pfKpi('Rendimiento por dividendos', _pfPct(re.dividend_yield, 2),
          'Cuánto reparte al año en efectivo, como porcentaje del precio.'),
        _pfKpi('Frecuencia de reparto', re.frecuencia),
      ]),
    ].join(''));

    // Composición
    const holdings = (cm.principales || []).map(h =>
      _pfBarra(h.nombre || h.ticker, h.peso, h.ticker)).join('');
    const sectores = (cm.sectores || []).map(s => _pfBarra(s.sector, s.peso)).join('');
    const clases = (cm.clases_activo || []).map(c => _pfBarra(
      ({ cash: 'Efectivo', stock: 'Acciones', bond: 'Bonos', preferred: 'Preferentes',
         convertible: 'Convertibles', other: 'Otros' })[c.clase] || c.clase, c.peso)).join('');
    html += _pfBloque('Qué trae dentro', [
      nar.diversificacion ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.diversificacion)}</p>` : '',
      cm.peso_top10 != null ? _pfRejilla([
        _pfKpi('Peso del top 10', _pfPct(cm.peso_top10, 0), G.peso_top10,
          cm.peso_top10 > 0.4 ? 'text-accent-red' : 'text-accent-green'),
        _pfKpi('Posiciones listadas', _pfEntero((cm.principales || []).length)),
        _pfKpi('Sectores', _pfEntero((cm.sectores || []).length)),
      ]) : '',
      holdings ? `<div class="mp-celda mt-3"><p class="mp-etq mb-2">Principales posiciones</p>${holdings}</div>` : '',
      sectores ? `<div class="mp-celda mt-3"><p class="mp-etq mb-2">Composición por sector</p>${sectores}</div>` : '',
      clases ? `<div class="mp-celda mt-3"><p class="mp-etq mb-2">Por clase de activo</p>${clases}</div>` : '',
    ].join(''));

    // Riesgo y réplica
    html += _pfBloque('Riesgo y fidelidad de la réplica', [
      nar.replica ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.replica)}</p>` : '',
      _pfRejilla([
        _pfKpi('Volatilidad anual', _pfPct(ri.volatilidad_anual, 1), G.volatilidad_anual),
        _pfKpi('Peor caída histórica', _pfPct(ri.max_drawdown, 1), G.max_drawdown, 'text-accent-red'),
        _pfKpi('Sharpe', _pfNum(ri.sharpe), G.sharpe),
        _pfKpi('Sortino', _pfNum(ri.sortino), G.sortino),
        _pfKpi(`Beta vs ${ri.benchmark || 'su índice'}`, _pfNum(ri.beta_vs_benchmark), G.beta_vs_benchmark),
        _pfKpi('Correlación con su índice', _pfNum(ri.correlacion_benchmark), G.correlacion_benchmark),
        _pfKpi('Volumen promedio diario', _pfEntero(ri.liquidez_volumen_prom),
          'Cuántos títulos cambian de manos al día. Más volumen, más fácil comprar y vender sin mover el precio.'),
      ]),
    ].join(''));

    // Comparables
    const comp = P.comparables || [];
    if (comp.length > 1) {
      const filas = comp.map((f, i) => `
        <tr class="${i === 0 ? 'font-semibold' : ''}">
          <td class="py-2 pr-2 tabular ${i === 0 ? 'text-accent-amber' : 'text-zinc-200'}">${escapeHtml(f.ticker)}${i === 0 ? ' ·' : ''}</td>
          <td class="py-2 pr-2 text-[11px] text-zinc-400 truncate max-w-[140px]">${escapeHtml(f.nombre || '')}</td>
          <td class="py-2 text-right tabular text-zinc-200">${_pfPct(f.ter, 2) || ''}</td>
          <td class="py-2 text-right tabular text-zinc-300">${_pfMoneda(f.aum, mon) || ''}</td>
          <td class="py-2 text-right tabular text-zinc-300">${_pfPct(f.volatilidad_anual, 1) || ''}</td>
          <td class="py-2 text-right tabular text-zinc-300">${_pfNum(f.sharpe) || ''}</td>
        </tr>`).join('');
      html += _pfBloque('Contra ETFs comparables', `
        <div class="mp-celda overflow-x-auto">
          <table class="w-full text-[12px]">
            <thead><tr><th>Ticker</th><th>Nombre</th><th class="text-right">Costo</th>
              <th class="text-right">Tamaño</th><th class="text-right">Volatilidad</th><th class="text-right">Sharpe</th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>`, 'La primera fila es el ETF que estás viendo.');
    }

    // Contexto mexicano
    html += _pfBloque('Para el inversionista mexicano', [
      mx.cotiza ? `<p class="text-[13px] text-zinc-200 mb-2"><span class="mp-etq">Dónde cotiza</span><br>${escapeHtml(mx.cotiza)}</p>` : '',
      mx.nota ? `<p class="text-[13px] text-zinc-300 leading-relaxed mb-2">${escapeHtml(mx.nota)}</p>` : '',
      mx.exposicion_cambiaria ? `<p class="text-[13px] text-zinc-300 leading-relaxed">${escapeHtml(mx.exposicion_cambiaria)}</p>` : '',
      mx.donde_ver_costo ? `<p class="text-[13px] text-zinc-300 leading-relaxed mt-2">${escapeHtml(mx.donde_ver_costo)}</p>` : '',
    ].join(''), 'Información general, no asesoría fiscal.');

    return html;
  }

  function _perfilCripto(d) {
    const P = d.perfil || {};
    const G = P.glosario || {};
    const nar = d.narrativa_tipo || {};
    const ta = P.tamano || {}, su = P.suministro || {}, vo = P.volatilidad || {};
    const ca = P.caidas || {}, rr = P.riesgo_rendimiento || {}, di = P.diversificacion || {};
    const li = P.liquidez || {}, dim = P.dimensionamiento || {};
    let html = '';

    html += _pfBloque('Qué es y cuánto pesa', [
      nar.que_es ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.que_es)}</p>` : '',
      _pfRejilla([
        _pfKpi('Capitalización de mercado', _pfMoneda(ta.market_cap), G.market_cap),
        _pfKpi('Lugar por tamaño', ta.posicion_aprox != null
          ? `#${ta.posicion_aprox} de ${ta.universo_comparado}` : null,
          'Posición aproximada entre las criptomonedas grandes que sigue la app.'),
      ]),
    ].join(''));

    html += _pfBloque('Suministro y escasez', [
      nar.suministro ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.suministro)}</p>` : '',
      _pfRejilla([
        _pfKpi('En circulación', _pfEntero(su.circulante)),
        _pfKpi('Tope de emisión', _pfEntero(su.maximo),
          'Cuántas unidades pueden existir como máximo. Sin tope, la oferta puede crecer siempre.'),
        _pfKpi('Ya emitido', _pfPct(su.emitido, 1), G.emitido),
        _pfKpi('Falta por emitir', _pfPct(su.por_emitir, 1),
          'Lo que todavía se va a crear. Cuanto más falte, más dilución futura.'),
      ]),
    ].join(''));

    html += _pfBloque('Volatilidad', [
      nar.volatilidad ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.volatilidad)}</p>` : '',
      _pfRejilla([
        _pfKpi('30 días', _pfPct(vo.vol_30d, 0), G.vol_365d),
        _pfKpi('90 días', _pfPct(vo.vol_90d, 0), G.vol_365d),
        _pfKpi('365 días', _pfPct(vo.vol_365d, 0), G.vol_365d),
        _pfKpi('Percentil histórico', vo.percentil_historico != null
          ? `${(vo.percentil_historico * 100).toFixed(0)}%` : null, G.percentil_historico),
      ]),
    ].join(''));

    html += _pfBloque('Caídas', [
      nar.caidas ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.caidas)}</p>` : '',
      _pfRejilla([
        _pfKpi('Peor caída histórica', _pfPct(ca.max_drawdown, 0), G.max_drawdown, 'text-accent-red'),
        _pfKpi('Distancia a su máximo', _pfPct(ca.distancia_ath, 0), G.distancia_ath,
          (ca.distancia_ath || 0) < -0.2 ? 'text-accent-red' : ''),
        _pfKpi('Máximo histórico', _pfMoneda(ca.maximo_historico)),
        _pfKpi('Fecha del máximo', ca.fecha_ath),
        _pfKpi('Sharpe', _pfNum(rr.sharpe), G.sortino),
        _pfKpi('Sortino', _pfNum(rr.sortino), G.sortino),
      ]),
    ].join(''));

    html += _pfBloque('¿Diversifica de verdad?', [
      nar.correlacion ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(nar.correlacion)}</p>` : '',
      _pfRejilla([
        _pfKpi('Correlación con Bitcoin', _pfNum(di.correlacion_btc), G.correlacion_btc),
        _pfKpi('Beta vs Bitcoin', _pfNum(di.beta_btc),
          'Cuánto amplifica los movimientos de Bitcoin. 1.5 significa que sube y baja 50% más.'),
        _pfKpi('Correlación con S&P 500', _pfNum(di.correlacion_sp500), G.correlacion_sp500),
        _pfKpi('Beta vs S&P 500', _pfNum(di.beta_sp500),
          'Cuánto se mueve frente a la bolsa estadounidense.'),
      ]),
    ].join(''));

    html += _pfBloque('Liquidez y rango reciente', [
      li.lectura ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(li.lectura)}</p>` : '',
      _pfRejilla([
        _pfKpi('Volumen diario', _pfMoneda(li.volumen_diario)),
        _pfKpi('Volumen sobre capitalización', _pfPct(li.volumen_sobre_mcap, 2), G.volumen_sobre_mcap),
        _pfKpi('Mínimo 90 días', _pfMoneda(li.rango_90d_min)),
        _pfKpi('Máximo 90 días', _pfMoneda(li.rango_90d_max)),
      ]),
    ].join(''));

    // Dimensionamiento — EDUCATIVO. Aritmética del golpe según el peso, nunca
    // una sugerencia de cuánto comprar ni de comprar en absoluto.
    const ejemplos = (dim.ejemplos || []).map(e => `
      <div class="flex items-center justify-between py-2 border-b border-surface-border last:border-0">
        <span class="text-[13px] text-zinc-300 tabular">${(e.peso * 100).toFixed(0)}% del portafolio</span>
        <span class="text-[13px] tabular text-accent-red">${(e.impacto * 100).toFixed(1)}% del total</span>
      </div>`).join('');
    html += _pfBloque(dim.encabezado || 'Cómo pesaría en tu portafolio', [
      dim.explicacion ? `<p class="text-[14px] text-zinc-300 leading-relaxed mb-3">${escapeHtml(dim.explicacion)}</p>` : '',
      ejemplos ? `<div class="mp-celda">${ejemplos}</div>` : '',
      dim.volatilidad_contexto ? `<p class="text-[13px] text-zinc-300 leading-relaxed mt-3">${escapeHtml(dim.volatilidad_contexto)}</p>` : '',
    ].join(''), dim.aviso ? escapeHtml(dim.aviso) : '');

    return html;
  }

  /* Qué mide el score, según el TIPO. Enumerar "fundamentales" bajo el score de
     una cripto era falso: esa rama del cálculo no usa P/E ni márgenes porque no
     existen. El número es el mismo de Acción del Día en los tres casos. */
  function _notaScore(d) {
    const t = d.tipo_activo || 'accion';
    if (t === 'crypto') {
      return 'Score de criptomoneda (momentum, retorno, Sharpe, volatilidad y liquidez). '
           + 'No usa fundamentales de empresa porque no existen para este activo. '
           + 'El mismo número que ves en el ranking.';
    }
    if (t === 'etf') {
      return 'Score de ETF (Sharpe, estabilidad, retorno y participación de mercado). '
           + 'No usa fundamentales de empresa: un fondo replica una canasta, no opera un negocio. '
           + 'El mismo número que ves en el ranking.';
    }
    return 'Score canónico (alpha CAPM, Sharpe, volatilidad, fundamentales, momentum). '
         + 'El mismo número que ves en Acción del Día y en el ranking.';
  }

  /* Rótulo de tipo bajo el nombre. "Sector · Industria" es de empresa; para un
     ETF se dice su categoría y para una cripto, que es cripto. */
  function _encabezadoTipo(d) {
    const t = d.tipo_activo || 'accion';
    if (t === 'crypto') return 'Criptomoneda';
    if (t === 'etf') {
      const cat = ((d.perfil || {}).identidad || {}).categoria;
      const ges = ((d.perfil || {}).identidad || {}).gestora;
      return ['ETF / fondo cotizado', cat, ges].filter(Boolean).join(' · ');
    }
    return [d.sector, d.industria].filter(Boolean).join(' · ') || 'Acción';
  }

  function render(d) {
    const cont = $('an-resultado');
    cont.classList.remove('hidden');
    const fund = d.fundamentales || {};
    const peer = d.peer_comparison || {};
    const dd = d.deep_dive || {};
    const sr = d.short_report || {};
    const sc = d.score_componentes || {};
    const ver = d.veredicto || {};
    const verCls = colorVeredicto(ver.color);
    const moneda = d.moneda || 'USD';

    // === HEADER + SCORE ===
    const headerHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-6">
        ${(d.avisos && d.avisos.length) ? `<div class="mb-4 rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[12px] text-accent-amber leading-relaxed">${d.avisos.map(a => escapeHtml(a)).join('<br>')}</div>` : ''}
        <div class="flex items-start justify-between flex-wrap gap-4">
          <div>
            <p class="text-xs uppercase tracking-wider text-zinc-500">${escapeHtml(_encabezadoTipo(d))}</p>
            <h3 class="text-2xl font-semibold text-zinc-100 mt-1">${escapeHtml(d.nombre || d.ticker)}</h3>
            <p class="text-sm text-zinc-500 font-mono mt-0.5">${escapeHtml(d.ticker)} · ${escapeHtml(moneda)}
              <button id="an-watch-btn" data-ticker="${escapeHtml(d.ticker)}" title="Seguir en tu lista" class="ml-2 text-2xl align-middle leading-none ${enWatchlist(d.ticker) ? 'text-accent-amber' : 'text-zinc-600'} hover:text-accent-amber">${enWatchlist(d.ticker) ? '★' : '☆'}</button>
            </p>
            ${d.precio_actual != null ? `<p class="text-base text-zinc-200 tabular mt-2">Último precio: <span class="font-semibold">${fmtMoney(d.precio_actual, moneda)} ${escapeHtml(moneda)}</span></p>` : ''}
          </div>
          <div class="text-center">
            <div class="inline-flex items-center justify-center w-28 h-28 rounded-full border-4 ${verCls} relative">
              <div class="text-center">
                <p class="text-3xl font-bold tabular leading-none">${d.score == null ? '—' : Math.round(d.score)}</p>
                <p class="text-[9px] uppercase tracking-wider mt-1">/ 100</p>
              </div>
            </div>
            <p class="text-xs uppercase tracking-wider mt-2 ${verCls.split(' ')[0]} font-semibold">${escapeHtml(ver.etiqueta || '')}</p>
          </div>
        </div>

        <!-- Razones del score canónico (mismo score que Acción del Día) -->
        ${(d.score_razones && d.score_razones.length) ? `
        <div class="mt-5 pt-5 border-t border-surface-border">
          <p class="text-xs uppercase tracking-wider text-zinc-500 mb-3">Por qué este score</p>
          <ul class="space-y-1.5">
            ${d.score_razones.map(r => `<li class="flex gap-2 items-start text-xs text-zinc-300"><span class="text-accent-green mt-0.5">+</span><span>${escapeHtml(r)}</span></li>`).join('')}
          </ul>
          <p class="text-[10px] text-zinc-600 mt-3">${escapeHtml(_notaScore(d))}</p>
        </div>` : `
        <!-- Fallback: desglose del score propio (tickers fuera del universo) -->
        <div class="mt-5 pt-5 border-t border-surface-border">
          <p class="text-xs uppercase tracking-wider text-zinc-500 mb-3">Desglose del score</p>
          <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            ${Object.entries(sc).map(([k, v]) => {
              const peso = (d.score_pesos || {})[k] || 0;
              const pct = peso > 0 ? Math.round((v / peso) * 100) : 0;
              const label = ({
                value_growth: 'Value/Growth',
                gross_margin: 'Margen bruto',
                rev_growth:   'Crecimiento ingresos',
                ev_ebitda:    'EV/EBITDA',
                roe:          'ROE',
                debt_equity:  'Deuda/Equity',
                pe:           'P/E',
                pos_52w:      'Posición 52w',
              })[k] || k;
              return `
                <div class="bg-zinc-900/40 border border-surface-border rounded-lg p-2.5">
                  <div class="flex items-center justify-between text-[10px] text-zinc-500 mb-1">
                    <span>${label}</span>
                    <span class="tabular">${v}/${peso}</span>
                  </div>
                  <div class="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div class="h-full bg-accent-orange" style="width:${pct}%"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>`}
      </div>
    `;

    // === PEER COMPARISON TABLE ===
    const peerRows = (peer.filas || []).map(f => {
      const esTarget = f.ticker === d.ticker;
      return `
        <tr class="${esTarget ? 'bg-accent-orange/5' : ''} border-b border-surface-border/50">
          <td class="py-2 px-3 text-xs ${esTarget ? 'text-accent-orange font-semibold' : 'text-zinc-300'} font-mono">${escapeHtml(f.ticker)}</td>
          <td class="py-2 px-3 text-xs text-zinc-400 tabular">${fmtNum(f.ps_ttm)}</td>
          <td class="py-2 px-3 text-xs text-zinc-400 tabular">${fmtNum(f.ps_forward)}</td>
          <td class="py-2 px-3 text-xs text-zinc-400 tabular">${fmtNum(f.ev_ebitda, 1)}</td>
          <td class="py-2 px-3 text-xs text-zinc-400 tabular">${fmtPct(f.gross_margin)}</td>
          <td class="py-2 px-3 text-xs text-zinc-400 tabular">${fmtPct(f.rev_growth_yoy)}</td>
          <td class="py-2 px-3 text-xs tabular ${f.value_growth_eval ? colorVeredicto(f.value_growth_eval.color).split(' ')[0] : 'text-zinc-400'}">
            ${f.value_growth_score == null ? '—' : f.value_growth_score}
          </td>
        </tr>
      `;
    }).join('');
    const peerHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-6">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-accent-green">●</span>
          <h4 class="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Peer Comparison Table</h4>
        </div>
        <p class="text-xs text-zinc-500 mb-4">Valuación relativa vs ${(peer.peers || []).length} competidores. Lower Value/Growth Score = más crecimiento por cada peso de valuación.</p>
        <div class="overflow-x-auto -mx-2">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-surface-border">
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">Ticker</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">P/S TTM</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">P/S Fwd</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">EV/EBITDA</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">Gross Margin</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">YoY Rev</th>
                <th class="py-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">V/G Score</th>
              </tr>
            </thead>
            <tbody>${peerRows || '<tr><td colspan="7" class="py-4 text-center text-xs text-zinc-500">Sin datos de peers.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;

    // === DEEP DIVE ===
    const ddHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-accent-blue">●</span>
          <h4 class="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Deep Dive — 4 partes</h4>
          ${d.narrativa_fuente === 'claude' ? '<span class="text-[9px] uppercase tracking-wider text-accent-purple/80">IA</span>' : '<span class="text-[9px] uppercase tracking-wider text-zinc-600">Datos</span>'}
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          ${[
            ['Business Model',      'business_model', 'green'],
            ['Moat & Competition',  'moat',           'blue'],
            ['Catalyst (12 meses)', 'catalyst',       'amber'],
            ['Asymmetry Check',     'asymmetry',      'purple'],
          ].map(([titulo, k, c]) => `
            <div class="bg-zinc-900/40 border-l-2 border-accent-${c} rounded-r-lg p-4">
              <p class="text-[10px] uppercase tracking-wider text-accent-${c} font-semibold mb-2">${titulo}</p>
              <p class="text-xs text-zinc-300 leading-relaxed">${escapeHtml(dd[k] || '—')}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // === SHORT REPORT ===
    const srHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-accent-red">●</span>
          <h4 class="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Short Report — 3 riesgos</h4>
        </div>
        <div class="space-y-3">
          ${[
            ['Irregularidades contables',  'accounting'],
            ['Concentración de clientes',  'customer_concentration'],
            ['Amenazas competitivas',      'competitive_threats'],
          ].map(([titulo, k]) => `
            <div class="bg-accent-red/5 border border-accent-red/15 rounded-lg p-3">
              <p class="text-[11px] uppercase tracking-wider text-accent-red font-semibold mb-1">${titulo}</p>
              <p class="text-xs text-zinc-300 leading-relaxed">${escapeHtml(sr[k] || '—')}</p>
            </div>
          `).join('')}
        </div>
        <p class="text-[10px] text-zinc-600 mt-4 italic">El score 1-100 es determinístico (basado en métricas cuantitativas).</p>
      </div>
    `;

    // Gráfica de precio interactiva con rangos
    const chartHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-5">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h4 class="text-sm font-semibold text-zinc-200">Precio histórico</h4>
          <div class="flex gap-1 text-[11px]">
            ${['1M', '6M', '1A', '5A', 'MAX'].map(r => `<button data-an-rango="${r}" class="an-rango px-2 py-0.5 rounded border border-surface-border ${r === '1A' ? 'text-zinc-200 bg-zinc-900' : 'text-zinc-500 hover:text-zinc-200'}">${r}</button>`).join('')}
          </div>
        </div>
        <div class="h-60"><canvas id="an-price-canvas"></canvas></div>
      </div>`;

    // Fundamentales clave (incluye FCF derivado de los estados financieros;
    // se llena aun para acciones .MX donde el resumen de Yahoo viene vacío)
    const _fundKpis = [
      ['P/E',           fund.pe_trailing != null ? fmtNum(fund.pe_trailing, 1) : '—'],
      ['P/B',           fund.pb != null ? fmtNum(fund.pb, 2) : '—'],
      ['ROE',           fund.roe != null ? fmtPct(fund.roe) : '—'],
      ['Margen neto',   (fund.margenes && fund.margenes.neto != null) ? fmtPct(fund.margenes.neto) : '—'],
      ['FCF',           fund.fcf != null ? fmtMoney(fund.fcf, moneda) : '—'],
      ['FCF yield',     fund.fcf_yield != null ? fmtPct(fund.fcf_yield) : '—'],
      ['Market cap',    fund.market_cap != null ? fmtMoney(fund.market_cap, moneda) : '—'],
      ['Deuda/Capital', fund.debt_to_equity != null ? (fmtNum(fund.debt_to_equity, 0) + '%') : '—'],
    ];
    const fuenteTxt = fund.fuente_respaldo === 'cache' ? 'caché de respaldo'
                    : fund.fuente_respaldo === 'alphavantage' ? 'Alpha Vantage (respaldo)'
                    : null;
    const fundHTML = `
      <div class="bg-surface border border-surface-border rounded-2xl p-5">
        <h4 class="text-sm font-semibold text-zinc-200 mb-3">Fundamentales clave</h4>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          ${_fundKpis.map(([l, v]) => `
            <div class="bg-zinc-900/40 border border-surface-border rounded-lg p-3">
              <p class="text-[10px] uppercase tracking-wider text-zinc-500">${l}</p>
              <p class="text-sm font-semibold text-zinc-100 tabular mt-1">${v}</p>
            </div>`).join('')}
        </div>
        ${fuenteTxt ? `<p class="text-[10px] text-zinc-600 mt-3">Fuente: ${fuenteTxt}.</p>` : ''}
        <p class="text-[10px] text-zinc-600 mt-2">FCF = flujo operativo − CapEx, calculado de los estados financieros.</p>
      </div>`;

    // ddHTML + srHTML removidos (requieren Claude API)
    const smlHTML = `<div class="bg-surface border border-surface-border rounded-2xl p-5"><h4 class="text-sm font-semibold text-zinc-200 mb-3">Valoración SML · CAPM</h4><div id="an-sml-host" style="display:flex;flex-direction:column;gap:10px;"></div></div>`;
    const estHostHTML = `<div class="bg-surface border border-surface-border rounded-2xl p-5"><h4 class="text-sm font-semibold text-zinc-200 mb-3">Consenso de analistas</h4><div id="an-estimados-host" class="text-xs text-zinc-500"><span class="inline-block w-3 h-3 border-2 border-violet-500/40 border-t-violet-500 rounded-full animate-spin mr-2 align-middle"></span>Cargando consenso…</div></div>`;
    const ddHostHTML = `<div class="bg-surface border border-surface-border rounded-2xl p-5"><h4 class="text-sm font-semibold text-zinc-200 mb-1">Análisis profundo · Deep Dive</h4><p class="text-[11px] text-zinc-500 mb-3">Comparativa contra peers + narrativa. Tarda unos segundos (descarga datos en vivo).</p><div id="an-deepdive-host"><button id="an-dd-load" class="text-[12px] font-semibold text-accent-blue border border-accent-blue/40 hover:bg-accent-blue/10 rounded-lg px-4 py-2 transition">Ver análisis profundo →</button></div></div>`;
    // ── Ensamblado según el TIPO de activo ────────────────────────────────
    // Para ETF y cripto se sustituyen los bloques de empresa (fundamentales,
    // peers por P/S, SML/CAPM, consenso de analistas, dashboard financiero,
    // deep dive) por el perfil propio del tipo. No se "ocultan" con datos
    // vacíos: no se piden y no se pintan.
    const _tipo = d.tipo_activo || 'accion';
    if (_tipo === 'etf' || _tipo === 'crypto') {
      cont.innerHTML = headerHTML + chartHTML
                     + (_tipo === 'etf' ? _perfilETF(d) : _perfilCripto(d));
    } else {
      cont.innerHTML = headerHTML + fundHTML + chartHTML + peerHTML
                     + `<div id="an-dashboard-host"><div class="bg-surface border border-surface-border rounded-2xl p-5 text-center text-xs text-zinc-500"><span class="inline-block w-3 h-3 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin mr-2 align-middle"></span>Cargando dashboard financiero…</div></div>`
                     + smlHTML + estHostHTML + ddHostHTML;
    }
    cont.scrollIntoView({ behavior: 'smooth', block: 'start' });

    _renderPrecioChart(d.ticker, '1A');
    cont.querySelectorAll('.an-rango').forEach(b => b.addEventListener('click', () => {
      cont.querySelectorAll('.an-rango').forEach(x => { x.classList.remove('text-zinc-200', 'bg-zinc-900'); x.classList.add('text-zinc-500'); });
      b.classList.add('text-zinc-200', 'bg-zinc-900'); b.classList.remove('text-zinc-500');
      _renderPrecioChart(d.ticker, b.dataset.anRango);
    }));

    const _wb = $('an-watch-btn');
    if (_wb) _wb.addEventListener('click', () => {
      const activo = toggleWatchlist(d.ticker);
      _wb.textContent = activo ? '★' : '☆';
      _wb.classList.toggle('text-accent-amber', activo);
      _wb.classList.toggle('text-zinc-600', !activo);
    });

    if (_tipo === 'accion') {
      if (window.renderSmlEn) window.renderSmlEn(d.ticker, 'an-sml-host');
      cargarEstimados(d.ticker);
      const _ddBtn = $('an-dd-load');
      if (_ddBtn) _ddBtn.addEventListener('click', () => {
        if (window.renderDeepDiveEn) window.renderDeepDiveEn(d.ticker, 'an-deepdive-host');
      });
      cargarDashboardFinanciero(d.ticker);
    }
  }

  // ============================================================
  //  CONSENSO DE ANALISTAS + EARNINGS (Finnhub)
  // ============================================================
  async function cargarEstimados(ticker) {
    const host = $('an-estimados-host');
    if (!host) return;
    let d;
    try {
      const res = await fetch('/api/estimados/' + encodeURIComponent(ticker));
      d = await res.json();
    } catch (e) {
      host.innerHTML = '<p class="text-[11px] text-zinc-600">No se pudo cargar el consenso.</p>';
      return;
    }
    if (!d || !d.disponible) {
      host.innerHTML = `<p class="text-[11px] text-zinc-600">${escapeHtml((d && d.nota) || 'Sin consenso de analistas para esta acción (Finnhub cubre EE.UU.).')}</p>`;
      return;
    }
    let html = '';
    const r = d.recomendaciones;
    if (r) {
      const color = /Compra/.test(r.veredicto) ? 'text-accent-green'
                  : (/Venta|Reducir/.test(r.veredicto) ? 'text-accent-red' : 'text-zinc-300');
      const seg = (n, c) => n > 0 ? `<div class="${c}" style="flex:${n}"></div>` : '';
      html += `
        <div class="mb-4">
          <div class="flex items-baseline justify-between mb-2">
            <span class="text-lg font-bold ${color}">${escapeHtml(r.veredicto)}</span>
            <span class="text-[11px] text-zinc-500">${r.total_analistas} analistas · ${escapeHtml(r.periodo || '')}</span>
          </div>
          <div class="flex h-2.5 rounded-full overflow-hidden bg-zinc-800 gap-px">
            ${seg(r.strong_buy, 'bg-green-600')}${seg(r.buy, 'bg-green-400')}${seg(r.hold, 'bg-zinc-500')}${seg(r.sell, 'bg-red-400')}${seg(r.strong_sell, 'bg-red-600')}
          </div>
          <div class="flex justify-between text-[10px] text-zinc-600 mt-1">
            <span>Compra ${r.strong_buy + r.buy}</span>
            <span>Mantener ${r.hold}</span>
            <span>Vender ${r.sell + r.strong_sell}</span>
          </div>
        </div>`;
    }
    const pt = d.price_target;
    if (pt && pt.objetivo_medio) {
      const f = x => (x == null ? '—' : '$' + Number(x).toFixed(2));
      html += `
        <div class="grid grid-cols-3 gap-2 mb-4">
          <div class="bg-zinc-900/40 border border-surface-border rounded-lg p-3 text-center"><p class="text-[10px] uppercase text-zinc-500">Obj. bajo</p><p class="text-sm font-semibold text-zinc-300 tabular mt-1">${f(pt.objetivo_bajo)}</p></div>
          <div class="bg-zinc-900/40 border border-accent-blue/30 rounded-lg p-3 text-center"><p class="text-[10px] uppercase text-zinc-500">Obj. medio</p><p class="text-sm font-bold text-accent-blue tabular mt-1">${f(pt.objetivo_medio)}</p></div>
          <div class="bg-zinc-900/40 border border-surface-border rounded-lg p-3 text-center"><p class="text-[10px] uppercase text-zinc-500">Obj. alto</p><p class="text-sm font-semibold text-zinc-300 tabular mt-1">${f(pt.objetivo_alto)}</p></div>
        </div>`;
    }
    const e = d.proximos_earnings;
    if (e && e.fecha) {
      const hora = e.hora === 'bmo' ? 'antes de abrir' : (e.hora === 'amc' ? 'después del cierre' : '');
      html += `<div class="text-[12px] text-zinc-400"><span class="text-zinc-500">Próximo reporte:</span> <span class="font-semibold text-zinc-200">${escapeHtml(e.fecha)}</span>${hora ? ` (${hora})` : ''}${e.eps_estimado != null ? ` · EPS est. <span class="tabular">${e.eps_estimado}</span>` : ''}</div>`;
    }
    html += `<p class="text-[10px] text-zinc-600 mt-3">Fuente: ${escapeHtml(d.fuente || 'Finnhub')}.</p>`;
    host.innerHTML = html || '<p class="text-[11px] text-zinc-600">Sin datos.</p>';
  }

  // ============================================================
  //  DASHBOARD FINANCIERO (5Y trends + KPIs · paleta warm-muted)
  // ============================================================
  async function cargarDashboardFinanciero(ticker) {
    const host = $('an-dashboard-host');
    if (!host) return;
    try {
      const res = await fetch(`/api/dashboard/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.tiene_datos) {
        host.innerHTML = `<div class="bg-surface border border-surface-border rounded-2xl p-5 text-xs text-zinc-500 text-center">
          Estados financieros no disponibles para ${escapeHtml(ticker)}. Yahoo Finance no publica estados completos para muchas emisoras de la BMV (.MX), ETFs, cripto ni varios ADRs internacionales.
        </div>`;
        return;
      }
      renderDashboardFinanciero(host, data);
    } catch (e) {
      host.innerHTML = `<div class="bg-surface border border-surface-border rounded-2xl p-5 text-xs text-accent-red">
        Error cargando dashboard: ${escapeHtml(e.message || String(e))}
      </div>`;
    }
  }

  // Paleta warm-muted (colores reales hex)
  // Paleta del dashboard financiero: apunta al tema central para que no exista
  // una segunda identidad cromática dentro de la app.
  const _palette = {
    gold:       MP_GRAFICA.sello,
    sage:       MP_GRAFICA.tinta3,
    terracotta: MP_GRAFICA.baja,
    slate:      MP_GRAFICA.reglaFuerte,
    mauve:      MP_GRAFICA.tinta2,
    posGreen:   MP_GRAFICA.alza,
    negRed:     MP_GRAFICA.baja,
  };

  function _fmtMoney(v, moneda) {
    if (v == null || isNaN(v)) return '—';
    const sym = moneda === 'MXN' ? '$' : '$';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${sym}${(v/1e12).toFixed(2)}T`;
    if (abs >= 1e9)  return `${sym}${(v/1e9).toFixed(2)}B`;
    if (abs >= 1e6)  return `${sym}${(v/1e6).toFixed(2)}M`;
    if (abs >= 1e3)  return `${sym}${(v/1e3).toFixed(2)}K`;
    return `${sym}${v.toFixed(2)}`;
  }

  function _kpiCard(kpi, moneda) {
    const v = kpi.valor;
    const yoy = kpi.yoy;
    const isPct = kpi.es_pct;
    let valTxt;
    if (v == null || isNaN(v)) valTxt = '—';
    else if (isPct)            valTxt = (v * 100).toFixed(1) + '%';
    else if (Math.abs(v) < 100) valTxt = v.toFixed(2);   // EPS
    else                        valTxt = _fmtMoney(v, moneda);
    let yoyHTML = '';
    if (yoy != null && !isNaN(yoy)) {
      const cls = yoy >= 0 ? 'text-[color:var(--sello)]' : 'text-[color:var(--baja)]';
      const arrow = yoy >= 0 ? '▲' : '▼';
      yoyHTML = `<span class="${cls} text-[11px] font-semibold tabular ml-1">${arrow} ${Math.abs(yoy*100).toFixed(1)}% YoY</span>`;
    }
    return `
      <div class="rounded-xl p-4" style="background:var(--sup-panel); border:1px solid #222;">
        <p class="text-[10px] uppercase tracking-[0.18em] font-semibold" style="color:var(--tinta-2);">${escapeHtml(kpi.label)}</p>
        <p class="text-2xl font-semibold tabular mt-1.5 text-zinc-100">${valTxt}</p>
        <div class="mt-1">${yoyHTML}</div>
      </div>
    `;
  }

  function renderDashboardFinanciero(host, d) {
    const moneda = d.moneda_reporte || 'USD';
    const kpisHTML = ['revenue', 'net_income', 'fcf', 'eps_diluted', 'roe']
      .map(k => _kpiCard(d.kpis[k], moneda)).join('');

    host.innerHTML = `
      <section class="rounded-2xl p-6 mt-6" style="background:var(--sup); border:1px solid #222; max-width:100%;">
        <div class="flex items-baseline justify-between flex-wrap gap-2 mb-1 pb-4" style="border-bottom:1px solid #222;">
          <div>
            <h3 style="font-family: 'Libre Baskerville', Georgia, serif; font-weight:700; color:var(--sello);" class="text-2xl">
              Dashboard financiero
            </h3>
            <p class="text-xs text-zinc-500 mt-1" style="font-family: 'IBM Plex Sans', sans-serif;">
              Fiscal Year ${escapeHtml(d.fy_actual || '—')} · datos en ${escapeHtml(moneda)} · ${escapeHtml(d.nombre || d.ticker)}
            </p>
          </div>
          <span class="text-[9px] uppercase tracking-[0.2em] font-semibold px-2.5 py-1 rounded" style="color:var(--sello); background:rgba(156,93,18,0.08); border:1px solid rgba(156,93,18,0.25);">10-K resumido</span>
        </div>

        <!-- KPI ROW -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-5">
          ${kpisHTML}
        </div>

        <!-- CHARTS GRID -->
        <div class="grid lg:grid-cols-2 gap-4 mt-6">
          <div class="rounded-xl p-5" style="background:var(--sup-panel); border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:var(--sello);" class="text-base font-bold">Revenue 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'IBM Plex Sans', sans-serif;">Crecimiento anual de ingresos.</p>
            <canvas id="dash-revenue" class="mt-3" style="max-height:220px;"></canvas>
          </div>
          <div class="rounded-xl p-5" style="background:var(--sup-panel); border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:var(--sello);" class="text-base font-bold">Free Cash Flow 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'IBM Plex Sans', sans-serif;">Cuánto efectivo libre genera tras capex.</p>
            <canvas id="dash-fcf" class="mt-3" style="max-height:220px;"></canvas>
          </div>
          <div class="rounded-xl p-5 lg:col-span-2" style="background:var(--sup-panel); border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:var(--sello);" class="text-base font-bold">Márgenes 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'IBM Plex Sans', sans-serif;">Bruto · Operativo · Neto. La eficiencia operativa en una sola gráfica.</p>
            <canvas id="dash-margenes" class="mt-3" style="max-height:240px;"></canvas>
          </div>
        </div>

        <p class="text-[10px] text-zinc-600 mt-5 italic" style="font-family: 'IBM Plex Sans', sans-serif;">
          Datos de Yahoo Finance · presentación tipo 10-K resumido
        </p>
      </section>
    `;

    // Inject font Libre Baskerville si no estaba
    if (!document.getElementById('dash-font-link')) {
      const link = document.createElement('link');
      link.id = 'dash-font-link';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap';
      document.head.appendChild(link);
    }

    // Construir charts
    setTimeout(() => _construirCharts(d), 50);
  }

  function _construirCharts(d) {
    const _common = {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 160 },
      plugins: {
        legend: MP_GRAFICA.leyenda(false),
        tooltip: {
          backgroundColor: MP_GRAFICA.panel,
          titleColor: MP_GRAFICA.tinta1,
          bodyColor: MP_GRAFICA.tinta2,
          borderColor: MP_GRAFICA.tinta1,
          borderWidth: 1,
          cornerRadius: 2,
          displayColors: false,
          padding: 9,
          titleFont: { family: MP_GRAFICA.mono, weight: '600', size: 10 },
          bodyFont: { family: MP_GRAFICA.mono, size: 11 },
        },
      },
      scales: {
        x: MP_GRAFICA.ejeTiempo(),
        y: MP_GRAFICA.ejeValor(),
      },
    };

    // ── Revenue 5Y ─────────────────────────────────────────
    const rev = d.series.revenue || {};
    const labRev = Object.keys(rev);
    const valRev = Object.values(rev);
    const ctxRev = $('dash-revenue');
    if (ctxRev && labRev.length) {
      // Color barras según YoY (positivo verde / negativo rojo, gold default si primer dato)
      const colors = valRev.map((v, i) => {
        if (i === 0) return _palette.gold;
        const prev = valRev[i-1];
        return v >= prev ? _palette.posGreen : _palette.negRed;
      });
      new Chart(ctxRev, {
        type: 'bar',
        data: { labels: labRev, datasets: [{
          data: valRev,
          backgroundColor: colors,
          borderRadius: 0, borderSkipped: false,
        }] },
        options: {
          ..._common,
          plugins: {
            ..._common.plugins,
            tooltip: {
              ..._common.plugins.tooltip,
              callbacks: {
                label: (c) => _fmtMoney(c.parsed.y, d.moneda_reporte),
                title: (c) => `FY ${c[0].label}`,
              },
            },
          },
          scales: {
            ..._common.scales,
            y: { ..._common.scales.y, ticks: { ..._common.scales.y.ticks, callback: v => _fmtMoney(v, d.moneda_reporte) } },
          },
        },
      });
    }

    // ── FCF 5Y ─────────────────────────────────────────────
    const fcf = d.series.fcf || {};
    const labFcf = Object.keys(fcf);
    const valFcf = Object.values(fcf);
    const ctxFcf = $('dash-fcf');
    if (ctxFcf && labFcf.length) {
      new Chart(ctxFcf, {
        type: 'line',
        data: { labels: labFcf, datasets: [{
          data: valFcf,
          ...MP_GRAFICA.serie(_palette.gold),
        }] },
        options: {
          ..._common,
          plugins: {
            ..._common.plugins,
            tooltip: {
              ..._common.plugins.tooltip,
              callbacks: {
                label: (c) => _fmtMoney(c.parsed.y, d.moneda_reporte),
                title: (c) => `FY ${c[0].label}`,
              },
            },
          },
          scales: {
            ..._common.scales,
            y: { ..._common.scales.y, ticks: { ..._common.scales.y.ticks, callback: v => _fmtMoney(v, d.moneda_reporte) } },
          },
        },
      });
    }

    // ── Márgenes 5Y (bar group) ────────────────────────────
    const mg = d.series.margen_gross || {};
    const mo = d.series.margen_operating || {};
    const mn = d.series.margen_net || {};
    const labM = Array.from(new Set([...Object.keys(mg), ...Object.keys(mo), ...Object.keys(mn)])).sort();
    const ctxM = $('dash-margenes');
    if (ctxM && labM.length) {
      new Chart(ctxM, {
        type: 'bar',
        data: {
          labels: labM,
          datasets: [
            { label: 'Bruto',     data: labM.map(a => mg[a] != null ? mg[a]*100 : null), backgroundColor: _palette.gold,       borderRadius: 0 },
            { label: 'Operativo', data: labM.map(a => mo[a] != null ? mo[a]*100 : null), backgroundColor: _palette.sage,       borderRadius: 0 },
            { label: 'Neto',      data: labM.map(a => mn[a] != null ? mn[a]*100 : null), backgroundColor: _palette.terracotta, borderRadius: 0 },
          ],
        },
        options: {
          ..._common,
          plugins: {
            ..._common.plugins,
            legend: MP_GRAFICA.leyenda(true),
            tooltip: {
              ..._common.plugins.tooltip,
              callbacks: {
                label: (c) => `${c.dataset.label}: ${c.parsed.y != null ? c.parsed.y.toFixed(1) : '—'}%`,
                title: (c) => `FY ${c[0].label}`,
              },
            },
          },
          scales: {
            ..._common.scales,
            y: { ..._common.scales.y, ticks: { ..._common.scales.y.ticks, callback: v => v.toFixed(0) + '%' } },
          },
        },
      });
    }
  }

  return { bind, cargar, analizar };
})();


// Redibuja los charts dentro de una vista recién mostrada. Chart.js con
// responsive:true + maintainAspectRatio:false que se creó mientras la vista
// estaba display:none se mide 0×0 y NO se redibuja solo (WKWebView no dispara
// el resize interno al pasar de oculto a visible). Forzamos el resize en el
// siguiente frame, cuando el layout ya tiene tamaño real.
function _redibujarChartsEn(vistaEl) {
  if (!vistaEl || typeof Chart === 'undefined') return;
  requestAnimationFrame(() => {
    vistaEl.querySelectorAll('canvas').forEach(cv => {
      try {
        const c = (typeof Chart.getChart === 'function') ? Chart.getChart(cv) : null;
        if (c) c.resize();
      } catch (_) {}
    });
  });
}

function bindNav() {
  const tabs = document.querySelectorAll('.nav-tab');
  const vistas = {
    portafolio:    document.getElementById('vista-portafolio'),
    analizar:      document.getElementById('vista-analizar'),
    explorador:    document.getElementById('vista-explorador'),
    periodico:     document.getElementById('vista-periodico'),
    rebalanceo:    document.getElementById('vista-rebalanceo'),
    transacciones: document.getElementById('vista-transacciones'),
    metas:         document.getElementById('vista-metas'),
    // "Mi cuenta": la pinta account.js (App Store 5.1.1v — borrado de cuenta).
    cuenta:        document.getElementById('vista-cuenta'),
  };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const vista = tab.dataset.vista;
      Object.entries(vistas).forEach(([k, el]) => {
        if (el) el.classList.toggle('hidden', k !== vista);
      });
      tabs.forEach(t => {
        const activo = t === tab;
        const isPrimary = t.classList.contains('nav-primary');
        const isSecondary = t.classList.contains('nav-secondary');
        // Sólo aplicar coloreo zinc a los tabs de la nav principal.
        // Los sub-nav pills y quick-links de cards mantienen su styling propio.
        if (isPrimary || isSecondary) {
          t.classList.remove('text-zinc-100', 'text-zinc-200', 'text-zinc-500', 'text-zinc-600');
          if (isPrimary) {
            t.classList.add(activo ? 'text-zinc-100' : 'text-zinc-500');
          } else {
            t.classList.add(activo ? 'text-zinc-200' : 'text-zinc-600');
          }
          // La pestaña activa se marca con la clase `activa`, que el CSS
          // convierte en píldora rellena. El .nav-indicator (el filete de 2px
          // de debajo) queda apagado por CSS: dos estilos de pestaña —éste y
          // el selector de mazos— era el choque visual más evidente.
          t.classList.toggle('activa', activo);
          const ind = t.querySelector('.nav-indicator');
          if (ind) ind.classList.toggle('hidden', !activo);
        }
      });
      if (vista === 'analizar')      Analizador.cargar();
      if (vista === 'explorador')    { Explorador.cargarUniverso(); RentaFija.cargar(); }
      if (vista === 'periodico')     Periodico.cargar();
      if (vista === 'rebalanceo')    Rebalanceo.cargar();
      if (vista === 'transacciones') { Transacciones.cargar(); Impuestos.cargar(); }
      if (vista === 'metas')         Metas.cargar();
      // Estado fresco cada vez que se entra (la sesión pudo cambiar desde el
      // paywall sin recargar la página).
      if (vista === 'cuenta')        { try { window.MPCuenta && window.MPCuenta.render(); } catch (_) {} }
      // Redibuja los charts que se hayan creado mientras la vista estaba oculta
      // (p.ej. los del dashboard de portafolio, creados en el arranque). Sin
      // esto quedan en blanco hasta que un resize nativo los dispare.
      _redibujarChartsEn(vistas[vista]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// --- botón Editar portafolio ------------------------------------------------
function bindEditar() {
  const btn = $('btn-editar-portafolio');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const actuales = leerPortafolioGuardado() || [];
    mostrarOnboarding();
    _onbModo('manual');
    Picker.resetYPrecargar(actuales);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// --- botón Perfiles (atajo directo a los perfiles sugeridos) ---------------
function bindPerfiles() {
  const btn = $('btn-perfiles-portafolio');
  if (!btn) return;
  btn.addEventListener('click', () => {
    mostrarOnboarding();
    _onbModo('auto');
    // Los perfiles viven al final del modo automático, debajo del optimizador:
    // sin este scroll el usuario aterriza arriba y no los ve.
    try { Picker.cargarPerfiles(); } catch (_) {}
    // Se cargan por fetch, así que hay que esperar a que la retícula tenga
    // tarjetas: con un solo requestAnimationFrame el grid mide 0 de alto y el
    // scroll no va a ningún lado.
    // Scroll INSTANTÁNEO, no 'smooth': la animación suave se cancelaba a media
    // corrida porque la retícula crece cuando llegan las tarjetas y el
    // documento cambia de alto. Se posiciona en cuanto la sección mide algo
    // (aunque sea el aviso de carga) y se reafirma cuando ya hay tarjetas.
    let intentos = 0, yaConTarjetas = false;
    (function irAPerfiles() {
      const grid = $('perfiles-grid');
      if (grid && grid.offsetHeight > 0) {
        grid.scrollIntoView({ block: 'start' });
        if (grid.querySelector('.perfil-card')) yaConTarjetas = true;
      }
      if (!yaConTarjetas && ++intentos < 60) setTimeout(irAPerfiles, 150);  // hasta ~9s
    })();
  });
}

// --- botón Exportar reporte PDF -------------------------------------------
function bindExportarPdf() {
  const btn = $('btn-exportar-pdf');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const tickers = leerPortafolioGuardado() || [];
    if (!tickers.length) {
      alert('Primero guarda un portafolio.');
      return;
    }
    const pesos = leerPesosGuardados() || {};
    let txs = [];
    try {
      const raw = localStorage.getItem('miPortafolio.transacciones.v1');
      if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) txs = j; }
    } catch (_) {}

    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Generando…';

    try {
      const now = new Date();
      const body = {
        tickers,
        pesos,
        transacciones:  txs,
        mes:            now.getMonth() + 1,
        anio:           now.getFullYear(),
        nombre_usuario: 'Charlie',
      };

      // Enriquecer body con datos extras (concentración, fundamentales,
      // comportamiento estadístico) en paralelo para que el PDF salga
      // completo. Si alguno falla, simplemente se omite esa sección.
      btn.innerHTML = 'Recolectando datos…';
      try {
        const [resultsRes, fundRes] = await Promise.all([
          fetch('/api/resultados').then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/api/fundamentals/portafolio', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({tickers}),
          }).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        // Concentración + benchmark + insights (vienen de /api/resultados)
        if (resultsRes) {
          if (resultsRes.concentracion) {
            body.concentracion = {
              por_sector: resultsRes.concentracion.por_sector,
              por_pais:   resultsRes.concentracion.por_pais,
              por_moneda: resultsRes.concentracion.por_moneda,
            };
          }
          if (resultsRes.insights && Array.isArray(resultsRes.insights)) {
            body.insights = resultsRes.insights
              .map(i => typeof i === 'string' ? i : (i.mensaje || i.titulo || ''))
              .filter(Boolean).slice(0, 10);
          }
          // Comportamiento estadístico desde portafolio.metricas
          const pm = resultsRes.portafolio || {};
          body.portafolio_metrics = {
            rendimiento_anualizado_pct: pm.rendimiento_anualizado_pct,
            volatilidad_anual_pct:      pm.volatilidad_anual_pct,
            sharpe_ratio:               pm.sharpe_ratio,
            max_drawdown_pct:           pm.max_drawdown_pct,
          };
          body.comportamiento = {
            volatilidad_anual:   pm.volatilidad_anual_pct ? pm.volatilidad_anual_pct / 100 : null,
            sharpe_ratio:        pm.sharpe_ratio,
            sortino_ratio:       pm.sortino_ratio,
            max_drawdown:        pm.max_drawdown_pct ? pm.max_drawdown_pct / 100 : null,
            correlacion_sp500:   pm.correlacion_sp500,
            retorno_1m:          pm.retorno_1m,
            retorno_3m:          pm.retorno_3m,
            retorno_1y:          pm.rendimiento_anualizado_pct ? pm.rendimiento_anualizado_pct / 100 : null,
            retorno_ytd:         pm.retorno_ytd,
          };
          // Benchmarks vs los principales
          if (resultsRes.benchmark) {
            body.benchmarks = [
              {
                nombre: pm.nombre_propio || 'Tu portafolio',
                retorno_pct: pm.rendimiento_anualizado_pct,
                volatilidad_pct: pm.volatilidad_anual_pct,
                sharpe: pm.sharpe_ratio,
                max_dd_pct: pm.max_drawdown_pct,
              },
              {
                nombre: resultsRes.benchmark.nombre || 'Benchmark',
                retorno_pct: resultsRes.benchmark.retorno_anualizado_pct,
                volatilidad_pct: resultsRes.benchmark.volatilidad_anual_pct,
                sharpe: resultsRes.benchmark.sharpe_ratio,
                max_dd_pct: resultsRes.benchmark.max_drawdown_pct,
              },
            ].filter(b => b.retorno_pct !== undefined);
          }
        }

        // Fundamentales
        if (fundRes && fundRes.resumen) {
          body.fundamentales = fundRes.resumen;
        }

        // Fiscal MX (calculado en cliente con transacciones)
        if (txs.length) {
          const ano = now.getFullYear();
          let ganancia_realizada = 0;
          const positions = {};
          txs.sort((a,b) => (a.fecha||'').localeCompare(b.fecha||''));
          for (const t of txs) {
            const ticker = (t.ticker||'').toUpperCase();
            const sh = parseFloat(t.shares)||0, pr = parseFloat(t.precio)||0;
            if (!ticker || sh<=0 || pr<=0) continue;
            const tipo = (t.tipo||'compra').toLowerCase();
            if (!positions[ticker]) positions[ticker] = {sh:0, costo:0};
            if (tipo.startsWith('c')) {
              positions[ticker].sh += sh;
              positions[ticker].costo += sh*pr;
            } else if (tipo.startsWith('v') && positions[ticker].sh > 0) {
              const costoPromedio = positions[ticker].costo / positions[ticker].sh;
              const shVender = Math.min(sh, positions[ticker].sh);
              const ganancia = shVender * (pr - costoPromedio);
              if ((t.fecha||'').startsWith(String(ano))) ganancia_realizada += ganancia;
              positions[ticker].sh -= shVender;
              positions[ticker].costo -= shVender * costoPromedio;
            }
          }
          body.fiscal = {
            ano,
            ganancia_realizada_ano: Math.round(ganancia_realizada * 100) / 100,
            isr_proyectado: Math.max(0, ganancia_realizada) * 0.10,
            perdidas_disponibles: 0,
          };
        }
      } catch (e) {
        console.warn('Algunos datos extras no se pudieron recolectar:', e);
      }

      btn.innerHTML = 'Generando PDF…';
      const res = await fetch('/api/reporte/pdf', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reporte_portafolio_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('No se pudo generar el PDF: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });
}

// --- go ---------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  PortfolioManager.bind();   // primero: fija el portafolio activo
  Picker.bind();       // bind antes de init — init puede llamar cargar()
  if (typeof PortafolioOptimo !== 'undefined') PortafolioOptimo.bind();
  CetesBench.bind();
  bindNav();
  bindEditar();
  bindPerfiles();
  bindExportarPdf();
  Explorador.bind();
  Periodico.bind();
  Rebalanceo.bind();
  Transacciones.bind();
  Impuestos.bind();
  Metas.bind();
  Fundamentales.bind();
  RentaFija.bind();
  Alertas.bind();
  Analizador.bind();
  Backtest.bind();
  StressTest.bind();
  TuAno.bind();
  if (typeof Brokers !== 'undefined') Brokers.bind();
  if (typeof DeclaracionSat !== 'undefined') DeclaracionSat.bind();
  if (typeof Aportaciones !== 'undefined') Aportaciones.bind();
  try { bindAutocompletes(); } catch (_) {}   // autocompletar por nombre en todas las lupas

  // Datos: esperar a que la sesión esté resuelta (token/cookie) antes de pedir,
  // para no disparar fetches sin Authorization en la carga en frío (nativo).
  window.__mpSesionLista.finally(() => {
    init();                                   // analiza el portafolio si existe
    try { Periodico.cargar(); } catch (_) {}  // vista default: Periódico
  });

  // ── Masthead: fecha de edición + cintilla de mercados ───────
  fecharEdicion();
  renderCintillaMercados();
  // El cuadernillo se pinta ya (CETES, FIBRAS, ISR) sin esperar al análisis;
  // renderResultados() lo vuelve a llamar con los datos del portafolio para
  // completar los spreads contra CETES y AFORE.
  renderCuadernilloMexico(null);

  // ── PWA: registrar service worker ───────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch(err => console.warn('SW falló registrar:', err));
    });
  }
});


// ============================================================================
//  PUENTE CON LA CAPA NATIVA (iOS)
// ============================================================================
// La barra de pestañas nativa llama aquí en vez de recargar la página, así que
// la navegación nativa y la web comparten un solo estado. Se expone en window
// porque quien la invoca es Swift, vía evaluateJavaScript.
// Avisa a Swift cuando hay una capa a pantalla completa abierta (tour, paywall,
// gate de cuenta) para que esconda la barra de pestañas nativa. Sin esto la
// barra flota ENCIMA del modal y tapa sus botones.
//
// Se detecta de forma genérica en vez de instrumentar cada overlay uno por uno:
// así los modales que se añadan después quedan cubiertos sin tocar nada.
(function vigilarCapas() {
  const puente = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mpUI;
  if (!puente) return;   // solo existe dentro de la app nativa

  let ultimoEstado = null;
  const hayCapaCompleta = () => {
    const alto = window.innerHeight || 0;
    for (const e of document.querySelectorAll('body > div, body > section')) {
      const cs = getComputedStyle(e);
      if (cs.position !== 'fixed') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      if ((+cs.zIndex || 0) < 9000) continue;
      // Una capa que cubre más de la mitad de la pantalla es un modal, no un
      // toast ni una barra pegada.
      if (e.getBoundingClientRect().height > alto * 0.5) return true;
    }
    return false;
  };

  const revisar = () => {
    const tapado = hayCapaCompleta();
    if (tapado === ultimoEstado) return;
    ultimoEstado = tapado;
    try { puente.postMessage({ accion: 'tabbar', visible: !tapado }); } catch (_) {}
  };

  new MutationObserver(revisar).observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  window.addEventListener('resize', revisar);
  revisar();
})();

window.mpIrA = function (vista) {
  try {
    const b = document.querySelector(`.nav-tab[data-vista="${vista}"]`)
           || document.querySelector(`[data-vista="${vista}"]`);
    if (b) { b.click(); window.scrollTo({ top: 0 }); return true; }
  } catch (_) {}
  return false;
};

// ============================================================================
//  CUADERNILLO MÉXICO — la retícula de diferenciación de la pantalla principal
// ============================================================================
// Rellena #mx-reticula con datos reales de los endpoints que ya existen. Cada
// celda se pinta en cuanto llega su fetch: ninguna espera a las demás.
function renderCuadernilloMexico(analisis) {
  const sec = document.getElementById('seccion-mexico');
  if (!sec) return;
  const set = (id, txt, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    if (cls) el.className = el.className.replace(/\bmp-(alza|baja|plano)\b/g, '') + ' ' + cls;
  };
  // Las variantes de fmtMoney del archivo viven dentro de módulos (IIFE), así
  // que aquí arriba hace falta una propia.
  const pesos = (v) => (v == null || isNaN(v)) ? '—'
    : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('es-MX', { maximumFractionDigits: 0 });

  // ── ISR del año y tax-loss harvesting ──────────────────────────
  let txs = [];
  try { txs = JSON.parse(localStorage.getItem(LS_KEY_TX) || '[]'); } catch {}
  set('mx-isr-ano', String(new Date().getFullYear()));
  if (!txs.length) {
    set('mx-isr-valor', 'Sin registrar');
    set('mx-isr-nota', 'Captura tus operaciones →');
    set('mx-tlh-valor', '—');
    set('mx-tlh-nota', 'Requiere transacciones');
  } else {
    fetch('/api/impuestos/calcular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transacciones: txs, incluir_harvest: true }),
    })
      .then(r => r.json())
      .then(d => {
        const t = (d && d.totales) || {};
        const isr = t.isr_estimado_ano_actual;
        set('mx-isr-valor', isr != null ? pesos(isr) : '—');
        set('mx-isr-nota', `Sobre ${pesos(t.ganancia_neta_ano_actual || 0)} de utilidad`);

        const h = (d && d.harvest) || {};
        const n = (h.oportunidades || []).length;
        set('mx-tlh-valor', n ? String(n) : 'Ninguna');
        set('mx-tlh-nota', n
          ? `${n === 1 ? 'oportunidad' : 'oportunidades'} · ${pesos(h.total_perdida_latente || 0)} latente`
          : 'Sin pérdidas que cosechar');
      })
      .catch(() => { set('mx-isr-valor', '—'); set('mx-tlh-valor', '—'); });
  }

  // ── CETES 28d y FIBRAS ─────────────────────────────────────────
  const retorno = analisis && analisis.portafolio
    ? (analisis.portafolio.rendimiento_prom_anual_5y_pct ?? analisis.portafolio.rendimiento_anualizado_pct)
    : null;

  fetch('/api/renta-fija/mx')
    .then(r => r.json())
    .then(d => {
      const t28 = d && d.cetes && d.cetes.tasas && d.cetes.tasas['28'];
      if (t28 && t28.tasa_pct != null) {
        set('mx-cetes-valor', t28.tasa_pct.toFixed(2) + '%');
        if (retorno != null) {
          const spread = retorno - t28.tasa_pct;
          set('mx-cetes-nota',
            `${spread >= 0 ? 'Le ganas por' : 'Te gana por'} ${Math.abs(spread).toFixed(1)} pts`);
        }
      }
      if (d && d.yield_fibras_prom != null) {
        // El backend devuelve el yield como fracción (0.0617 = 6.17%).
        set('mx-fibras-valor', (Number(d.yield_fibras_prom) * 100).toFixed(2) + '%');
        set('mx-fibras-nota', `${(d.fibras || []).length} FIBRAS en BMV`);
      }
    })
    .catch(() => {});

  // ── Comparativa contra la SIEFORE equivalente ──────────────────
  if (retorno != null && typeof window.compararAfore === 'function') {
    try {
      const sf = window.compararAfore(retorno);
      // La SIEFORE "de en medio" (SB75, 35-39 años) es la referencia por
      // defecto: es el perfil más común entre quienes usan la app.
      const ref = sf.find(s => s.siefore === 'SB75') || sf[0];
      if (ref) {
        const d = ref.diff;
        set('mx-afore-valor', (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts',
            d > 0 ? 'mp-alza' : d < 0 ? 'mp-baja' : 'mp-plano');
        set('mx-afore-nota', `${ref.siefore} (${ref.edad}) rinde ${ref.retorno}% real`);
      }
    } catch {}
  } else {
    set('mx-afore-nota', 'Analiza tu portafolio para comparar');
  }
}

// ============================================================================
//  MASTHEAD — fecha de edición y cintilla de mercados
// ============================================================================

// "lunes 4 de agosto de 2026", como el fechado de un diario.
function fecharEdicion() {
  const el = document.getElementById('mp-edicion-fecha');
  if (!el) return;
  try {
    const f = new Date().toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    el.textContent = f;
  } catch {
    el.textContent = new Date().toISOString().slice(0, 10);
  }
}

// Cintilla fija bajo el masthead: IPC, S&P 500, USD/MXN y CETES 28d con datos
// reales de los endpoints que ya existen. Cada dato entra en cuanto llega
// (render progresivo) para que la cintilla no espere al más lento.
function renderCintillaMercados() {
  const pista = document.getElementById('mp-cintilla-pista');
  if (!pista) return;
  const scroller = pista.closest('.mp-cintilla') || pista;
  if (!scroller.dataset.borde && window.MP_bordesDeScroll) window.MP_bordesDeScroll(scroller);

  // El backend cotiza los índices vía ETF (NAFTRAC para el IPC, SPY para el
  // S&P 500) porque yfinance los sirve más consistentes que ^MXX / ^GSPC. La
  // variación % es la del índice, pero el precio es el del ETF: por eso la
  // cintilla nombra el instrumento real y no promete un nivel de índice que
  // no está mostrando.
  const CLAVES = [
    { id: 'ipc',    nombre: 'IPC · NAFTRAC', dec: 2 },
    { id: 'spx',    nombre: 'S&P · SPY',     dec: 2 },
    { id: 'usdmxn', nombre: 'USD/MXN',       dec: 4 },
    { id: 'cetes',  nombre: 'CETES 28d',     dec: 2, sufijo: '%', sinVar: true },
  ];
  const estado = {};

  function pintar() {
    pista.innerHTML = CLAVES.map(c => {
      const d = estado[c.id];
      if (!d) {
        return `<div class="mp-cintilla-item"><span class="mp-cintilla-nom">${escapeHtml(c.nombre)}</span><span class="mp-cintilla-val">—</span></div>`;
      }
      const val = Number(d.valor).toLocaleString('en-US', {
        minimumFractionDigits: c.dec, maximumFractionDigits: c.dec,
      });
      let var_ = '';
      if (!c.sinVar && d.pct != null) {
        const cls = d.pct > 0 ? 'mp-alza' : d.pct < 0 ? 'mp-baja' : 'mp-plano';
        const signo = d.pct > 0 ? '+' : '';
        var_ = `<span class="mp-cintilla-var mp-dir ${cls}">${signo}${d.pct.toFixed(2)}%</span>`;
      }
      return `<div class="mp-cintilla-item">
        <span class="mp-cintilla-nom">${escapeHtml(c.nombre)}</span>
        <span class="mp-cintilla-val">${val}${c.sufijo || ''}</span>${var_}
      </div>`;
    }).join('');
  }

  // Índices y divisas — mismo endpoint que ya alimenta el Periódico.
  fetch('/api/periodico/mercados')
    .then(r => r.json())
    .then(m => {
      if (!m || m.error) return;
      const todos = [].concat(m.indices_us || [], m.indices_mundo || [], m.divisas || []);
      // Se busca por ticker Y por nombre: el backend usa ETFs líquidos en vez
      // de los símbolos de índice (SPY en lugar de ^GSPC, NAFTRAC.MX para el
      // IPC), así que anclarse solo al ticker deja huecos en la cintilla.
      const buscar = (tickers, nombres) => todos.find(i =>
        tickers.includes(i.ticker) || nombres.includes(i.nombre));
      const ipc = buscar(['NAFTRAC.MX', '^MXX'], ['IPC México']);
      const spx = buscar(['SPY', '^GSPC'], ['S&P 500']);
      const fx  = buscar(['MXN=X', 'USDMXN=X'], ['USD/MXN']);
      if (ipc) estado.ipc    = { valor: ipc.precio, pct: ipc.cambio_pct };
      if (spx) estado.spx    = { valor: spx.precio, pct: spx.cambio_pct };
      if (fx)  estado.usdmxn = { valor: fx.precio,  pct: fx.cambio_pct };
      pintar();
    })
    .catch(() => {});

  // CETES 28d — Banxico SIE vía el backend.
  fetch('/api/renta-fija/mx')
    .then(r => r.json())
    .then(d => {
      const t = d && d.cetes && d.cetes.tasas && d.cetes.tasas['28'];
      if (t && t.tasa_pct != null) { estado.cetes = { valor: t.tasa_pct }; pintar(); }
    })
    .catch(() => {});
}
