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

// Defaults de Chart.js para tema oscuro
Chart.defaults.color = '#a1a1aa';
Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
Chart.defaults.font.family = "Inter, ui-sans-serif, system-ui, sans-serif";
Chart.defaults.font.size = 11;

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

function guardarCfgAlertas(cfg) {
  try { localStorage.setItem(LS_KEY_ALERTAS_CFG, JSON.stringify(cfg)); } catch {}
  enviarSnapshotBackend();
}

let _snapshotPending = null;
async function enviarSnapshotBackend() {
  // Debounce 1.5s para no spamear cada cambio
  if (_snapshotPending) clearTimeout(_snapshotPending);
  _snapshotPending = setTimeout(async () => {
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
        nombre:          'Charlie',
        pesos_objetivo,
        posiciones,
        transacciones:   txs,
        alertas_activas: cfg.activas || {drift:false, precio:false, semanal:false},
        metricas:        {},
      };
      await fetch('/api/portafolio/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // silent fail — no es crítico
    }
  }, 1500);
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
function mostrarOnboarding() {
  $('portafolio-onboarding').classList.remove('hidden');
  $('portafolio-dashboard').classList.add('hidden');
  $('btn-editar-portafolio').classList.add('hidden');
  $('btn-exportar-pdf')?.classList.add('hidden');
}

function mostrarDashboard() {
  $('portafolio-onboarding').classList.add('hidden');
  $('portafolio-dashboard').classList.remove('hidden');
  $('btn-editar-portafolio').classList.remove('hidden');
  $('btn-exportar-pdf')?.classList.remove('hidden');
}

// --- carga principal --------------------------------------------------------

async function init() {
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
    const res = await fetch('/api/analizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    data = json;
  } catch (err) {
    console.error(err);
    $('hero-titulo').textContent = 'No pude analizar tu portafolio';
    $('hero-subtitulo').textContent = err.message + ' · Toca Editar para ajustar la selección.';
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
  renderInsights(data);
  renderBenchmark(data);
  renderPortafolioOptimo(data);
  renderChartAcumulado(data);
  renderChartDrawdown(data);
  renderChartRollingVol(data);
  renderTablaActivos(data, info);
  renderCorrelaciones(data);
  renderConcentracion(data, info);

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

// --- HERO ------------------------------------------------------------------

function renderHero(data) {
  const p = data.portafolio || {};
  const m = data.metadata || {};
  const activos = m.activos || [];

  $('hero-titulo').textContent = activos.length
    ? `${activos.length} ${activos.length === 1 ? 'posición' : 'posiciones'} analizadas`
    : 'Tu portafolio';
  $('hero-subtitulo').textContent = activos.join(' · ');

  // Retorno total (hero)
  const rt = p.rendimiento_total_pct;
  const heroEl = $('hero-retorno');
  heroEl.textContent = fmtPct(rt);
  heroEl.className = `text-4xl sm:text-5xl font-bold tabular mt-1 ${claseColor(rt)}`;

  // Período (años aproximados)
  if (m.dias_observados) {
    const anios = (m.dias_observados / 252).toFixed(1);
    $('hero-periodo').textContent = `Últimos ~${anios} años`;
  }

  // KPIs
  const ra = p.rendimiento_anualizado_pct;
  $('kpi-retorno-anual').textContent = fmtPct(ra);
  $('kpi-retorno-anual').className = `text-2xl font-semibold tabular mt-1 ${claseColor(ra)}`;
  $('kpi-retorno-anual-ctx').textContent = ra >= 0
    ? 'Crece por año, en promedio'
    : 'Pierde por año, en promedio';

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

  const datasets = [
    {
      label: 'Portafolio',
      data: port,
      borderColor: '#10b981',
      backgroundColor: (ctx) => {
        const chart = ctx.chart;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return 'rgba(16,185,129,0.1)';
        const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, 'rgba(16,185,129,0.25)');
        gradient.addColorStop(1, 'rgba(16,185,129,0)');
        return gradient;
      },
      fill: true,
      tension: 0.25,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
    },
  ];

  if (bench.length) {
    datasets.push({
      label: 'Benchmark',
      data: bench,
      borderColor: '#38bdf8',
      borderDash: [4, 4],
      fill: false,
      tension: 0.25,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
    });
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
        borderColor: '#f43f5e',
        backgroundColor: (ctx) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(244,63,94,0.12)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(244,63,94,0)');
          gradient.addColorStop(1, 'rgba(244,63,94,0.3)');
          return gradient;
        },
        fill: true,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 0,
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
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        fill: true,
        tension: 0.3,
        borderWidth: 1.5,
        pointRadius: 0,
      }],
    },
    options: chartOptionsPct(),
  });
}

// --- opciones comunes chart.js --------------------------------------------

function chartOptionsPct(opts = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#111114',
        borderColor: '#1f1f24',
        borderWidth: 1,
        padding: 10,
        titleColor: '#e5e7eb',
        bodyColor: '#a1a1aa',
        callbacks: {
          label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(2) + '%'}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxTicksLimit: 6,
          autoSkip: true,
          callback: function (val, idx) {
            const label = this.getLabelForValue(val);
            if (!label) return '';
            // formato "MMM YY"
            const [y, m] = label.split('-');
            const mes = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][parseInt(m, 10) - 1] || m;
            return `${mes} ${y.slice(2)}`;
          },
        },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { callback: (v) => `${v.toFixed(0)}%` },
        ...(opts.y_max !== undefined ? { max: opts.y_max } : {}),
      },
    },
  };
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
    if (v === null || v === undefined) return '#18181b';
    if (v >= 1 - 0.001) return 'rgba(244, 63, 94, 0.5)';  // diagonal
    if (v >= 0) {
      // 0 → zinc-900, 1 → rojo intenso
      const a = Math.min(1, v);
      return `rgba(244, 63, 94, ${0.08 + a * 0.45})`;
    }
    const a = Math.min(1, -v);
    return `rgba(56, 189, 248, ${0.08 + a * 0.45})`;
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
      html += `<div class="corr-cell aspect-square rounded-md flex items-center justify-center text-[10px] tabular font-medium text-zinc-100 border border-white/5"
                    style="background:${bg};"
                    title="${r} vs ${c}: ${txt}">${txt}</div>`;
    });
  });
  html += `</div>`;

  // Leyenda
  html += `
    <div class="flex items-center justify-between mt-4 text-[10px] text-zinc-500">
      <div class="flex items-center gap-1.5">
        <span class="w-3 h-3 rounded" style="background: rgba(56,189,248,0.5)"></span>
        <span>Negativa</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="w-3 h-3 rounded bg-zinc-900"></span>
        <span>Neutral</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span>Alta</span>
        <span class="w-3 h-3 rounded" style="background: rgba(244,63,94,0.5)"></span>
      </div>
    </div>
  `;

  grid.innerHTML = html;
}

// --- CONCENTRACIÓN --------------------------------------------------------

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
      const s = meta.sector || 'Desconocido';
      const p = meta.pais || 'Desconocido';
      const mo = meta.moneda || 'Desconocido';
      sectores[s] = (sectores[s] || 0) + w * 100;
      paises[p]   = (paises[p]   || 0) + w * 100;
      monedas[mo] = (monedas[mo] || 0) + w * 100;
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
  const palette = ['#38bdf8', '#10b981', '#f59e0b', '#f43f5e', '#a78bfa', '#ec4899', '#14b8a6'];

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
  async function cargarUniverso() {
    if (state.cargado) return;
    try {
      const res = await fetch('/api/universo');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'error al cargar universo');
      state.universo = body.tickers || [];
      state.periodo = body.periodo;
      state.cargado = true;
      renderMeta();
      renderLista();
    } catch (err) {
      $('universo-lista').innerHTML = `
        <div class="col-span-2 text-xs text-accent-red py-8 text-center">
          ${err.message}. Corre <code>python descargar_universo.py</code> primero.
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
        <div class="col-span-2 text-xs text-zinc-500 py-6 text-center">
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
      sharpe:           ['Sharpe del óptimo',  '🎯'],
      correlacion:      ['Diversificación',    '🌐'],
      mejora_markowitz: ['Mejora vs equal-weight', '⚙️'],
      geografia:        ['Regiones',           '🌎'],
      sectores:         ['Sectores',           '📊'],
      monedas:          ['Monedas',            '💱'],
      'tamaño':         ['Tamaño',             '📐'],
      volatilidad:      ['Volatilidad',        '📉'],
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
// PICKER: onboarding de "Mi portafolio" (paso 1 tickers + paso 2 pesos)
//  - Lista del universo completo (S&P 500 + IPC) con precio y ⭐ recomendadas
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
  async function cargar() {
    if (state.cargado) return;
    try {
      const res = await fetch('/api/universo');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'error');
      state.universo = body.tickers || [];
      state.cargado = true;
      const n = state.universo.length;
      const recos = state.universo.filter(x => x.recomendada).length;
      $('pick-curado-meta').textContent = `· ${n} acciones · ⭐ ${recos} destacadas`;
      renderCurado('');
      // Auto-refresh de precios en background (no bloqueante)
      // Solo refrescamos los recomendados para no saturar.
      const recosTickers = state.universo.filter(x => x.recomendada).map(x => x.ticker).slice(0, 50);
      if (recosTickers.length) refrescarPrecios(recosTickers);
    } catch (err) {
      $('pick-curado-lista').innerHTML = `
        <div class="col-span-2 text-xs text-zinc-500 py-4 text-center">
          Universo no disponible (${err.message}). Corre
          <code class="text-zinc-300">python descargar_universo.py</code> en el backend.
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
      cont.innerHTML = `<div class="col-span-2 text-xs text-zinc-500 py-4 text-center">
        Sin resultados para este filtro. Prueba buscar en Yahoo arriba.
      </div>`;
      return;
    }
    const TOPE_PICKER = 300;
    const visible = lista.slice(0, TOPE_PICKER);
    const html = visible.map(t => itemHTML(t, 'curado')).join('');
    const hint = lista.length > TOPE_PICKER
      ? `<div class="col-span-2 text-[10px] text-zinc-600 text-center py-2">Mostrando ${TOPE_PICKER} de ${lista.length} resultados — usa el buscador para acotar.</div>`
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
            ${reco ? '<span class="text-accent-amber text-[11px] leading-none">⭐</span>' : ''}
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
      const res = await fetch('/api/buscar-ticker?q=' + encodeURIComponent(q));
      const body = await res.json();
      if (seq !== state.yahooSeq) return;
      if (!res.ok) throw new Error(body.error || 'fallo Yahoo');
      const curadoSet = new Set(state.universo.map(x => x.ticker));
      yahooCache = (body || []).filter(x => !curadoSet.has(x.ticker)).slice(0, 8);
      $('pick-buscar-status').textContent = yahooCache.length ? '' : 'sin coincidencias extra';
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
              ${meta.recomendada ? '<span class="text-accent-amber text-[11px]">⭐</span>' : ''}
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

  async function cargarPerfiles() {
    const grid = $('perfiles-grid');
    if (!grid) return;
    try {
      const res = await fetch('/api/perfiles');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'error');
      perfilesCache.splice(0, perfilesCache.length, ...(body || []));
      renderPerfiles();
    } catch (err) {
      grid.innerHTML = `
        <div class="col-span-full text-xs text-zinc-500 py-4 text-center">
          Perfiles no disponibles (${escapeHtml(err.message)}).
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
    const riesgoCls = {
      'bajo':        'text-accent-green',
      'bajo-medio':  'text-accent-green',
      'medio':       'text-accent-amber',
      'medio-alto':  'text-accent-amber',
      'alto':        'text-accent-red',
      'muy alto':    'text-accent-rose',
    };
    const objetivoLabel = {
      'min_vol':     'Mín. varianza',
      'max_sharpe':  'Máx. Sharpe',
      'max_ret':     'Máx. retorno',
      'risk_parity': 'Risk parity',
    };
    grid.innerHTML = perfilesCache.map(p => {
      const cls = riesgoCls[p.nivel_riesgo] || 'text-zinc-400';
      const tickersPreview = (p.tickers || []).slice(0, 4).join(' · ');
      const extras = (p.tickers || []).length > 4 ? ` +${p.tickers.length - 4}` : '';
      const obj = objetivoLabel[p.objetivo] || '';
      const m = p.metricas;
      const sc = p.score_promedio;
      const div = m && m.diversificacion != null ? m.diversificacion : null;
      const metricasHTML = m ? `
        <div class="grid grid-cols-3 gap-1 text-center pt-1.5 border-t border-surface-border/40">
          <div>
            <p class="text-[8px] uppercase tracking-wider text-zinc-500">Ret</p>
            <p class="text-[10px] font-semibold text-accent-green">${m.retorno_anual_pct.toFixed(1)}%</p>
          </div>
          <div>
            <p class="text-[8px] uppercase tracking-wider text-zinc-500">Vol</p>
            <p class="text-[10px] font-semibold text-accent-amber">${m.volatilidad_anual_pct.toFixed(1)}%</p>
          </div>
          <div>
            <p class="text-[8px] uppercase tracking-wider text-zinc-500">Sharpe</p>
            <p class="text-[10px] font-semibold text-accent-purple">${m.sharpe_ratio.toFixed(2)}</p>
          </div>
        </div>
        ${(sc != null || div != null) ? `
        <div class="grid grid-cols-2 gap-1 text-center pt-1">
          ${sc != null ? `
          <div class="bg-zinc-900/40 rounded px-1 py-0.5">
            <p class="text-[8px] uppercase tracking-wider text-zinc-500">Calidad</p>
            <p class="text-[10px] font-semibold text-accent-orange">${Math.round(sc)}/100</p>
          </div>` : ''}
          ${div != null ? `
          <div class="bg-zinc-900/40 rounded px-1 py-0.5">
            <p class="text-[8px] uppercase tracking-wider text-zinc-500">Diversif.</p>
            <p class="text-[10px] font-semibold text-accent-blue">${(div * 100).toFixed(0)}%</p>
          </div>` : ''}
        </div>` : ''}` : '';
      return `
        <button data-perfil="${p.id}"
          class="perfil-card text-left p-4 rounded-xl border border-surface-border
                 bg-gradient-to-br from-zinc-900/60 to-zinc-900/20
                 hover:border-accent-purple/60 hover:bg-accent-purple/5
                 transition flex flex-col gap-2 min-h-[230px]">
          <div class="flex items-start justify-between">
            <span class="text-xl">${p.emoji || '•'}</span>
            <div class="flex flex-col items-end gap-0.5">
              <span class="text-[9px] uppercase tracking-wider ${cls}">${escapeHtml(p.nivel_riesgo)}</span>
              ${obj ? `<span class="text-[8px] text-zinc-500">${escapeHtml(obj)}</span>` : ''}
            </div>
          </div>
          <h4 class="text-sm font-semibold text-zinc-100 leading-tight">${escapeHtml(p.nombre)}</h4>
          <p class="text-[11px] text-zinc-400 leading-snug line-clamp-2">${escapeHtml(p.thesis)}</p>
          ${metricasHTML}
          <div class="mt-auto pt-2 border-t border-surface-border/60">
            <p class="text-[10px] text-zinc-500 truncate">${p.num_activos || (p.tickers || []).length} activos · ${escapeHtml(tickersPreview)}${extras}</p>
            <p class="text-[10px] text-accent-purple mt-0.5">Usar esta mezcla →</p>
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

  return { cargar, bind, resetYPrecargar, refrescarPrecios, cargarPerfiles };
})();

// ============================================================
// PERIÓDICO (cierres + noticias)
// ============================================================
const Periodico = (() => {
  const state = {
    cargadoUnaVez: false,
    cargando: false,
  };

  function fmtHora(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const ahora = new Date();
      const diffMin = (ahora - d) / 60000;
      if (diffMin < 1) return 'hace un momento';
      if (diffMin < 60) return `hace ${Math.round(diffMin)} min`;
      const diffH = diffMin / 60;
      if (diffH < 24) return `hace ${Math.round(diffH)} h`;
      const diffD = diffH / 24;
      if (diffD < 7) return `hace ${Math.round(diffD)} d`;
      return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    } catch { return ''; }
  }

  function sparklineSVG(valores, positivo) {
    if (!valores || valores.length < 2) return '';
    const w = 80, h = 24, pad = 2;
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    const rng = max - min || 1;
    const pts = valores.map((v, i) => {
      const x = pad + (i / (valores.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((v - min) / rng) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const stroke = positivo ? '#10b981' : '#f43f5e';
    return `
      <svg viewBox="0 0 ${w} ${h}" class="w-20 h-6" aria-hidden="true">
        <polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${pts}"></polyline>
      </svg>
    `;
  }

  function renderResumen(data) {
    const texto = $('periodico-resumen-texto');
    const titulares = $('periodico-resumen-titulares');
    const badge = $('periodico-resumen-badge');
    const aviso = $('periodico-resumen-aviso');
    if (!texto) return;

    if (!data || data.error) {
      texto.textContent = data && data.error ? data.error : 'No pude cargar el resumen.';
      if (titulares) titulares.innerHTML = '';
      if (badge) badge.classList.add('hidden');
      return;
    }

    // Badge con el tipo de día
    if (badge) {
      const cls = data.clasificacion || {};
      const map = {
        alcista: 'text-accent-green border-accent-green/30 bg-accent-green/10',
        bajista: 'text-accent-red border-accent-red/30 bg-accent-red/10',
        mixto:   'text-accent-amber border-accent-amber/30 bg-accent-amber/10',
        info:    'text-zinc-400 border-surface-border bg-zinc-900',
      };
      const color = map[cls.tipo] || map.info;
      badge.className = `text-[10px] px-2 py-0.5 rounded-full border ${color}`;
      badge.textContent = cls.etiqueta || '';
      badge.classList.remove('hidden');
    }

    texto.textContent = data.resumen_mercado || '';

    // Titulares como bullets con link al original
    const lista = data.titulares || [];
    if (titulares) {
      titulares.innerHTML = lista.map(t => `
        <a href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer"
           class="flex items-start gap-2 text-[13px] text-zinc-300 hover:text-white group">
          <span class="text-accent-purple mt-0.5 text-[10px]">◆</span>
          <span class="flex-1">
            <span class="group-hover:underline">${escapeHtml(t.titulo)}</span>
            ${t.proveedor ? `<span class="text-[10px] text-zinc-500 ml-1">— ${escapeHtml(t.proveedor)}</span>` : ''}
          </span>
        </a>
      `).join('');
    }

    if (aviso) aviso.textContent = data.aviso || '';
  }

  function renderIndices(data) {
    const cont = $('periodico-indices');
    const indices = (data && data.indices) || [];
    if (!indices.length) {
      cont.innerHTML = `<div class="col-span-full text-xs text-zinc-500 py-4 text-center">
        Sin datos de cierres por ahora. Intenta de nuevo en un momento.
      </div>`;
      return;
    }
    cont.innerHTML = indices.map(i => {
      const pos = (i.cambio_pct || 0) >= 0;
      const color = pos ? 'text-accent-green' : 'text-accent-red';
      const bg = pos ? 'bg-accent-green/5 border-accent-green/20' : 'bg-accent-red/5 border-accent-red/20';
      const signo = pos ? '+' : '';
      const simbolo = i.moneda === 'MXN' ? '$' : '$';
      const suf = i.moneda === 'MXN' ? ' MXN' : '';
      return `
        <div class="rounded-xl border ${bg} p-4 flex flex-col gap-2">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-[10px] uppercase tracking-wider text-zinc-500">${escapeHtml(i.etiqueta || '')}</p>
              <h4 class="text-sm font-semibold text-zinc-100 mt-0.5">${escapeHtml(i.nombre)}</h4>
            </div>
            <span class="text-[9px] text-zinc-600">${escapeHtml(i.ticker)}</span>
          </div>
          <div class="flex items-end justify-between gap-2">
            <div>
              <p class="text-xl font-bold tabular ${color}">${signo}${(i.cambio_pct || 0).toFixed(2)}%</p>
              <p class="text-[11px] text-zinc-400 tabular">${simbolo}${(i.precio || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suf}</p>
            </div>
            ${sparklineSVG(i.sparkline, pos)}
          </div>
        </div>
      `;
    }).join('');
  }

  function noticiaHTML(n, conTicker) {
    const fecha = fmtHora(n.fecha);
    const tickerBadge = conTicker && n.ticker_relacionado
      ? `<span class="text-[9px] font-semibold px-1.5 py-0.5 rounded border border-accent-amber/30 bg-accent-amber/10 text-accent-amber shrink-0">${escapeHtml(n.ticker_relacionado)}</span>`
      : '';
    const thumb = n.thumbnail
      ? `<img src="${escapeHtml(n.thumbnail)}" alt="" loading="lazy" class="w-16 h-16 object-cover rounded-md shrink-0 hidden sm:block bg-zinc-800" onerror="this.style.display='none'">`
      : '';
    // Importante: rel=noopener para seguridad y target=_blank para no perder el contexto de la app
    return `
      <a href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer"
         class="block group bg-surface-card border border-surface-border hover:border-zinc-600 transition rounded-lg p-3 flex gap-3">
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2 mb-1 flex-wrap">
            ${tickerBadge}
            <span class="text-[10px] text-zinc-500">${escapeHtml(n.proveedor || '')}${fecha ? ' · ' + fecha : ''}</span>
          </div>
          <h4 class="text-sm font-medium text-zinc-100 leading-snug line-clamp-2 group-hover:text-white">${escapeHtml(n.titulo)}</h4>
          ${n.resumen ? `<p class="text-[11px] text-zinc-500 mt-1 leading-snug line-clamp-2">${escapeHtml(n.resumen)}</p>` : ''}
        </div>
      </a>
    `;
  }

  function renderNoticiasTop(lista) {
    const cont = $('periodico-top-lista');
    const count = $('periodico-top-count');
    if (!lista || !lista.length) {
      cont.innerHTML = `<div class="text-xs text-zinc-500 py-4">
        No hay noticias disponibles ahora mismo.
      </div>`;
      if (count) count.textContent = '';
      return;
    }
    cont.innerHTML = lista.map(n => noticiaHTML(n, false)).join('');
    if (count) count.textContent = `${lista.length} titulares`;
  }

  function renderNoticiasMis(lista) {
    const cont = $('periodico-mis-lista');
    const count = $('periodico-mis-count');
    if (!lista || !lista.length) {
      const tickers = leerPortafolioGuardado() || [];
      cont.innerHTML = tickers.length
        ? `<div class="text-xs text-zinc-500 py-6 text-center bg-surface-card border border-surface-border rounded-lg px-3">
             Sin noticias recientes para ${tickers.slice(0, 3).join(', ')}${tickers.length > 3 ? '…' : ''}.
           </div>`
        : `<div class="text-xs text-zinc-500 py-6 text-center bg-surface-card border border-surface-border rounded-lg px-3">
             Define tu portafolio en <span class="text-zinc-300">Mi portafolio</span> para ver noticias específicas.
           </div>`;
      if (count) count.textContent = '';
      return;
    }
    cont.innerHTML = lista.map(n => noticiaHTML(n, true)).join('');
    if (count) count.textContent = `${lista.length} titulares`;
  }

  async function cargar(force = false) {
    if (state.cargando) return;
    if (state.cargadoUnaVez && !force) return;  // cache de sesión
    state.cargando = true;

    const hora = $('periodico-hora');
    if (hora) hora.textContent = 'Actualizando…';

    // Lanzamos en paralelo
    const tickers = leerPortafolioGuardado() || [];
    const tareas = [
      fetch('/api/periodico/resumen').then(r => r.json()).catch(e => ({ error: e.message })),
      fetch('/api/periodico/cierres').then(r => r.json()).catch(e => ({ error: e.message })),
      fetch('/api/periodico/noticias?limite=12').then(r => r.json()).catch(e => ({ error: e.message })),
    ];
    if (tickers.length) {
      tareas.push(
        fetch('/api/periodico/noticias-portafolio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers }),
        }).then(r => r.json()).catch(e => ({ error: e.message }))
      );
    }

    const [resumen, cierres, top, mis] = await Promise.all(tareas);

    renderResumen(resumen);

    if (!cierres || cierres.error) {
      $('periodico-indices').innerHTML = `<div class="col-span-full text-xs text-accent-red py-4 text-center">
        ${escapeHtml((cierres && cierres.error) || 'error al cargar cierres')}
      </div>`;
    } else {
      renderIndices(cierres);
    }

    if (Array.isArray(top)) renderNoticiasTop(top);
    else renderNoticiasTop([]);

    if (tickers.length && Array.isArray(mis)) renderNoticiasMis(mis);
    else renderNoticiasMis([]);

    if (hora) {
      hora.textContent = `Actualizado a las ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} · noticias vía Yahoo Finance`;
    }
    state.cargadoUnaVez = true;
    state.cargando = false;
  }

  function bind() {
    const btn = $('periodico-refrescar');
    if (btn) btn.addEventListener('click', () => cargar(true));
  }

  return { cargar, bind };
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

    const ahorroTotal = (harvest.oportunidades || []).reduce(
      (s, o) => s + (o.ahorro_isr || 0), 0
    );

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
      cont.innerHTML = '<li>Esta es una estimación educativa, no asesoría fiscal.</li>';
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
            <div class="text-2xl">💡</div>
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
      'Pesimista': { borde: 'border-accent-red/30',   color: 'text-accent-red',   emoji: '🌧️' },
      'Esperado':  { borde: 'border-zinc-600',        color: 'text-zinc-200',     emoji: '⛅' },
      'Optimista': { borde: 'border-accent-green/30', color: 'text-accent-green', emoji: '☀️' },
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
        borderColor: 'rgba(16, 185, 129, 0.4)',
        backgroundColor: 'rgba(16, 185, 129, 0.08)',
        borderWidth: 1,
        fill: '+2',  // llena entre p90 y p10
        pointRadius: 0,
        tension: 0.2,
      },
      {
        label: 'P50 (mediana)',
        data: p50,
        borderColor: '#fb7185',
        backgroundColor: 'rgba(251, 113, 133, 0.1)',
        borderWidth: 2.5,
        fill: false,
        pointRadius: 0,
        tension: 0.2,
      },
      {
        label: 'P10 (pesimista)',
        data: p10,
        borderColor: 'rgba(244, 63, 94, 0.4)',
        backgroundColor: 'rgba(244, 63, 94, 0.08)',
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
        borderColor: 'rgba(251, 113, 133, 0.6)',
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
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#a1a1aa', font: { size: 11 }, usePointStyle: true, boxWidth: 8 },
          },
          tooltip: {
            backgroundColor: 'rgba(17, 17, 20, 0.95)',
            borderColor: '#27272a',
            borderWidth: 1,
            titleColor: '#f4f4f5',
            bodyColor: '#d4d4d8',
            padding: 10,
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${fmtMoneyFull(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.03)' },
            ticks: { color: '#71717a', font: { size: 10 } },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: {
              color: '#71717a',
              font: { size: 10 },
              callback: (v) => fmtMoney(v),
            },
          },
        },
      },
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
      if (msgEl) msgEl.textContent = data.mensaje || ('Enviado a ' + email);
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

  function actualizarMsgAuto(cfg) {
    const el = $('al-auto-msg');
    if (!el) return;
    const activos = Object.entries(cfg.activas || {}).filter(([_,v]) => v).map(([k]) => k);
    if (!cfg.destinatario || !activos.length) {
      el.textContent = 'Sin alertas automáticas activadas. Pon tu email arriba y marca al menos una opción.';
    } else {
      el.textContent = `${activos.length} alerta(s) activa(s) — se mandan a ${cfg.destinatario} automáticamente.`;
    }
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
    guardarCfgAlertas(cfg);
    actualizarMsgAuto(cfg);
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
      return;
    }
    box.classList.remove('hidden');
    $('fund-resumen-pe').textContent    = resumen.pe_promedio != null ? resumen.pe_promedio.toFixed(1) : '—';
    $('fund-resumen-yield').textContent = resumen.yield_promedio != null ? (resumen.yield_promedio * 100).toFixed(2) + '%' : '—';
    $('fund-resumen-beta').textContent  = resumen.beta_promedio != null ? resumen.beta_promedio.toFixed(2) : '—';
    $('fund-resumen-count').textContent = `${resumen.num_ok}/${resumen.num_tickers}`;
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


// ===========================================================================
// ASISTENTE IA (chat con Claude sobre el portafolio del usuario)
// ===========================================================================
const Asistente = (() => {
  const state = {
    disponible:     null,   // null = no sabemos, false/true = ya chequeado
    modelo:         null,
    historial:      [],     // [{role:'user'|'assistant', content:''}]
    cargando:       false,
    ctxChequeado:   false,
  };

  function escapeHtmlLocal(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Markdown MUY ligero para mensajes del assistant: bold, inline code, bullets, saltos de línea.
  function renderMarkdownLigero(txt) {
    let t = escapeHtmlLocal(txt);
    // Code block ``` ... ```
    t = t.replace(/```([\s\S]*?)```/g, (_, c) =>
      `<pre class="bg-zinc-950 border border-surface-border rounded-lg p-2 mt-2 mb-2 text-[11px] overflow-x-auto text-zinc-200">${c.trim()}</pre>`);
    // Inline code `...`
    t = t.replace(/`([^`]+)`/g, '<code class="bg-zinc-800/60 text-zinc-200 px-1 py-0.5 rounded text-[11px]">$1</code>');
    // Bold **...**
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-zinc-100">$1</strong>');
    // Bullets: líneas que empiezan con "- " o "• "
    const lineas = t.split('\n');
    let out = [];
    let enLista = false;
    for (const l of lineas) {
      if (/^\s*[-•]\s+/.test(l)) {
        if (!enLista) { out.push('<ul class="list-disc list-inside space-y-1 my-1.5 text-zinc-300">'); enLista = true; }
        out.push('<li>' + l.replace(/^\s*[-•]\s+/, '') + '</li>');
      } else {
        if (enLista) { out.push('</ul>'); enLista = false; }
        if (l.trim() === '') out.push('<div class="h-1"></div>');
        else out.push(l);
      }
    }
    if (enLista) out.push('</ul>');
    return out.join('<br>').replace(/<br><ul/g, '<ul').replace(/<\/ul><br>/g, '</ul>');
  }

  function renderMensajes() {
    const cont = $('asi-mensajes');
    if (!cont) return;

    if (!state.historial.length && !state.cargando) {
      cont.innerHTML = `
        <div class="text-center text-xs text-zinc-600 py-8">
          Empieza preguntando algo o usa una de las sugerencias de arriba.
        </div>
      `;
      return;
    }

    const html = state.historial.map(msg => {
      if (msg.role === 'user') {
        return `
          <div class="flex justify-end">
            <div class="max-w-[85%] bg-accent-purple/15 border border-accent-purple/30 rounded-2xl rounded-tr-sm px-4 py-2.5">
              <p class="text-sm text-zinc-100 whitespace-pre-wrap">${escapeHtmlLocal(msg.content)}</p>
            </div>
          </div>
        `;
      }
      return `
        <div class="flex justify-start">
          <div class="max-w-[90%] bg-zinc-900/70 border border-surface-border rounded-2xl rounded-tl-sm px-4 py-2.5">
            <div class="flex items-center gap-1.5 mb-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-accent-purple"></span>
              <span class="text-[10px] uppercase tracking-wider text-zinc-500">Asistente</span>
            </div>
            <div class="text-sm text-zinc-200 leading-relaxed">${renderMarkdownLigero(msg.content)}</div>
          </div>
        </div>
      `;
    }).join('');

    const loader = state.cargando ? `
      <div class="flex justify-start">
        <div class="bg-zinc-900/70 border border-surface-border rounded-2xl rounded-tl-sm px-4 py-3">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-accent-purple animate-pulse"></span>
            <span class="w-2 h-2 rounded-full bg-accent-purple animate-pulse" style="animation-delay: .15s"></span>
            <span class="w-2 h-2 rounded-full bg-accent-purple animate-pulse" style="animation-delay: .3s"></span>
          </div>
        </div>
      </div>
    ` : '';

    cont.innerHTML = html + loader;
    // Autoscroll
    cont.scrollTop = cont.scrollHeight;
  }

  function renderContexto() {
    const el = $('asi-ctx-tickers');
    if (!el) return;
    const tickers = (typeof leerPortafolioGuardado === 'function') ? (leerPortafolioGuardado() || []) : [];
    if (!tickers.length) {
      el.innerHTML = '<span class="text-zinc-600">Ningún portafolio guardado</span>';
      return;
    }
    el.innerHTML = tickers.map(t =>
      `<span class="px-1.5 py-0.5 rounded bg-zinc-900 border border-surface-border text-zinc-400">${escapeHtmlLocal(t)}</span>`
    ).join(' ');
  }

  async function chequearEstado() {
    if (state.ctxChequeado) return;
    state.ctxChequeado = true;
    try {
      const res = await fetch('/api/asistente/estado');
      const data = await res.json();
      state.disponible = !!data.disponible;
      state.modelo = data.modelo || null;
    } catch (e) {
      state.disponible = false;
    }
    // Toggle banner "no configurado"
    const banner = $('asi-no-config');
    const sugs = $('asi-sugerencias');
    const chatWrap = $('asi-chat-wrap');
    if (state.disponible === false) {
      banner?.classList.remove('hidden');
      sugs?.classList.add('hidden');
      chatWrap?.classList.add('opacity-50', 'pointer-events-none');
    } else {
      banner?.classList.add('hidden');
      sugs?.classList.remove('hidden');
      chatWrap?.classList.remove('opacity-50', 'pointer-events-none');
    }
  }

  function construirContextoBody(mensaje) {
    const body = { mensaje, historial: state.historial.slice(-24) };
    const tickers = (typeof leerPortafolioGuardado === 'function') ? leerPortafolioGuardado() : null;
    const pesos   = (typeof leerPesosGuardados === 'function')     ? leerPesosGuardados()     : null;
    if (Array.isArray(tickers) && tickers.length) body.tickers = tickers;
    if (pesos && Object.keys(pesos).length) body.pesos = pesos;

    try {
      const raw = localStorage.getItem('miPortafolio.transacciones.v1');
      if (raw) {
        const txs = JSON.parse(raw);
        if (Array.isArray(txs) && txs.length) body.transacciones = txs;
      }
    } catch (_) {}

    return body;
  }

  async function enviar(mensajeDirecto) {
    if (state.cargando) return;
    if (state.disponible === false) {
      alert('El asistente no está configurado. Revisa el banner de arriba.');
      return;
    }

    const input = $('asi-input');
    const mensaje = (mensajeDirecto ?? (input?.value || '')).trim();
    if (!mensaje) return;

    // Ocultar sugerencias después del primer mensaje
    $('asi-sugerencias')?.classList.add('hidden');

    // Agregar al historial
    state.historial.push({ role: 'user', content: mensaje });
    if (input && !mensajeDirecto) { input.value = ''; input.style.height = 'auto'; }
    state.cargando = true;
    const btn = $('asi-enviar');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    renderMensajes();

    try {
      const body = construirContextoBody(mensaje);
      const res = await fetch('/api/asistente/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      const respuesta = data.respuesta || '(sin respuesta)';
      state.historial.push({ role: 'assistant', content: respuesta });
    } catch (e) {
      state.historial.push({
        role: 'assistant',
        content: '⚠ Error: ' + (e.message || e) + '\n\nRevisa que `ANTHROPIC_API_KEY` esté configurada y reintenta.',
      });
    } finally {
      state.cargando = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
      renderMensajes();
    }
  }

  function limpiar() {
    state.historial = [];
    $('asi-sugerencias')?.classList.remove('hidden');
    renderMensajes();
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function cargar() {
    chequearEstado();
    renderContexto();
    renderMensajes();
  }

  function bind() {
    const input = $('asi-input');
    const btn   = $('asi-enviar');

    btn?.addEventListener('click', () => enviar());
    input?.addEventListener('input', () => autoResize(input));
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviar();
      }
    });

    $('asi-limpiar')?.addEventListener('click', limpiar);

    document.querySelectorAll('.asi-sugerencia').forEach(el => {
      el.addEventListener('click', () => {
        const msg = el.dataset.msg;
        if (msg) enviar(msg);
      });
    });
  }

  return { cargar, bind };
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
      $('bt-error').textContent = 'Primero guarda tu portafolio.';
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
      borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)',
      borderWidth: 2, tension: 0.2, pointRadius: 0, fill: true,
    }];
    Object.entries(d.serie_benchmarks || {}).forEach(([label, serie], i) => {
      const colors = ['#38bdf8', '#a78bfa'];
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
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a1a1aa', font: {size: 10} } } },
        scales: {
          x: { ticks: { color: '#52525b', font: {size: 9}, maxTicksLimit: 6 }, grid: { color: 'rgba(255,255,255,0.03)' } },
          y: { ticks: { color: '#52525b', font: {size: 9} }, grid: { color: 'rgba(255,255,255,0.03)' } },
        },
      },
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
      $('st-error').textContent = 'Primero guarda tu portafolio.';
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
    gbm:      'linear-gradient(135deg, #16a34a, #22c55e)',
    kuspit:   'linear-gradient(135deg, #1d4ed8, #38bdf8)',
    hapi:     'linear-gradient(135deg, #d97706, #fbbf24)',
    bursanet: 'linear-gradient(135deg, #be123c, #fb7185)',
    actinver: 'linear-gradient(135deg, #c2410c, #fb923c)',
    vector:   'linear-gradient(135deg, #7c3aed, #a78bfa)',
    schwab:   'linear-gradient(135deg, #0d9488, #2dd4bf)',
    ibkr:     'linear-gradient(135deg, #4338ca, #818cf8)',
  };
  function _brokerAvatar(b, size = 28) {
    const grad = _BROKER_COLORS[b.id] || 'linear-gradient(135deg, #475569, #94a3b8)';
    const initial = (b.nombre || 'X').charAt(0).toUpperCase();
    return `<span class="inline-flex items-center justify-center rounded-md font-semibold text-white text-xs shrink-0" style="width:${size}px;height:${size}px;background:${grad};">${initial}</span>`;
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
          borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)',
          borderWidth: 2, tension: 0.2, pointRadius: 0, fill: true },
        { label: 'Valor real (ajustado por inflación)', data: d.serie.map(p => p.valor_real),
          borderColor: '#f59e0b', borderWidth: 1.5, tension: 0.2, pointRadius: 0, borderDash: [4,4] },
        { label: 'Aportado', data: d.serie.map(p => p.aportado),
          borderColor: '#71717a', borderWidth: 1.5, tension: 0, pointRadius: 0 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a1a1aa', font: {size: 10} } } },
        scales: {
          x: { ticks: { color: '#52525b', font: {size: 9}, maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.03)' }, title: { display: true, text: 'Años', color: '#52525b', font: {size: 9} } },
          y: { ticks: { color: '#52525b', font: {size: 9}, callback: v => '$' + (v/1000).toFixed(0) + 'k' }, grid: { color: 'rgba(255,255,255,0.03)' } },
        },
      },
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
    { id: 'green',   gradient: 'linear-gradient(135deg, #16a34a, #22c55e)', name: 'Verde' },
    { id: 'blue',    gradient: 'linear-gradient(135deg, #1d4ed8, #38bdf8)', name: 'Azul' },
    { id: 'purple',  gradient: 'linear-gradient(135deg, #7c3aed, #a78bfa)', name: 'Púrpura' },
    { id: 'amber',   gradient: 'linear-gradient(135deg, #d97706, #fbbf24)', name: 'Ámbar' },
    { id: 'rose',    gradient: 'linear-gradient(135deg, #be123c, #fb7185)', name: 'Rosa' },
    { id: 'teal',    gradient: 'linear-gradient(135deg, #0d9488, #2dd4bf)', name: 'Teal' },
    { id: 'orange',  gradient: 'linear-gradient(135deg, #c2410c, #fb923c)', name: 'Naranja' },
    { id: 'indigo',  gradient: 'linear-gradient(135deg, #4338ca, #818cf8)', name: 'Índigo' },
    { id: 'slate',   gradient: 'linear-gradient(135deg, #475569, #94a3b8)', name: 'Gris' },
    { id: 'crimson', gradient: 'linear-gradient(135deg, #991b1b, #ef4444)', name: 'Carmesí' },
  ];
  function _colorFromId(id) {
    return COLORS.find(c => c.id === id) || COLORS[0];
  }
  function _avatarHTML(nombre, colorId, sizeClass = 'w-6 h-6 text-[11px]') {
    const c = _colorFromId(colorId);
    const initial = (nombre || 'P').trim().charAt(0).toUpperCase();
    return `<span class="inline-flex items-center justify-center ${sizeClass} rounded-md font-semibold text-white shrink-0" style="background:${c.gradient};">${initial}</span>`;
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
    // Migración: si existe `emoji` en algún portfolio, convertir a `color` por default
    Object.values(raw.portfolios).forEach(p => {
      if (!p.color) p.color = 'green';
    });
    return raw;
  }
  function guardarMeta(d) { try { localStorage.setItem(META_KEY, JSON.stringify(d)); } catch {} }
  function activoId() { return leerMeta().activo; }
  function activoData() { const m = leerMeta(); return m.portfolios[m.activo] || { nombre: 'Principal', emoji: '📊' }; }

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
  function crear(nombre, colorId) {
    nombre = (nombre || '').trim().slice(0, 30);
    if (!nombre) return null;
    const id = 'p_' + Date.now().toString(36);
    const m = leerMeta();
    _persistirHaciaId(m.activo);
    m.portfolios[id] = { nombre, color: colorId || 'green', creado: new Date().toISOString() };
    m.activo = id;
    guardarMeta(m);
    _aplicarSnapshot({ tickers: '[]', pesos: '{}', txs: '[]' });
    location.reload();
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
      const c = _colorFromId(a.color);
      av.style.background = c.gradient;
      av.textContent = (a.nombre || 'P').trim().charAt(0).toUpperCase();
    }
    if ($('port-active-nombre')) $('port-active-nombre').textContent = a.nombre || 'Principal';
  }
  function renderMenu() {
    const m = leerMeta();
    const items = Object.entries(m.portfolios).map(([id, p]) => {
      const act = id === m.activo;
      return `
        <div class="flex items-center justify-between rounded-md hover:bg-zinc-900 group ${act ? 'bg-accent-green/10' : ''}">
          <button data-port-id="${id}" class="port-switch flex-1 text-left flex items-center gap-2 px-2 py-1.5 text-xs ${act ? 'text-accent-green font-semibold' : 'text-zinc-200'}">
            ${_avatarHTML(p.nombre, p.color, 'w-5 h-5 text-[10px]')}
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
      <div class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" id="port-crear-modal">
        <div class="bg-surface-card border border-surface-border rounded-2xl max-w-sm w-full p-6">
          <h3 class="text-lg font-semibold text-zinc-100">Nuevo portafolio</h3>
          <p class="text-xs text-zinc-500 mt-1 mb-4">Sepáralo por objetivo: Retiro, Trading, Hijos, etc.</p>
          <label class="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Nombre</label>
          <input id="port-nombre-input" type="text" maxlength="30" placeholder="Ej. Retiro" class="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-accent-green mb-4" />
          <label class="text-[10px] uppercase tracking-wider text-zinc-500 block mb-2">Color del avatar</label>
          <div id="port-color-grid" class="grid grid-cols-5 gap-2 mb-4">
            ${COLORS.map((c,i) => `<button type="button" data-color="${c.id}" class="port-color w-10 h-10 rounded-md transition relative ${i===0?'ring-2 ring-white/80 ring-offset-2 ring-offset-zinc-900':''}" style="background:${c.gradient};" title="${c.name}"></button>`).join('')}
          </div>
          <div class="flex gap-2 justify-end">
            <button id="port-crear-cancelar" class="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200">Cancelar</button>
            <button id="port-crear-ok" class="text-xs px-4 py-1.5 rounded-md bg-accent-green text-zinc-950 font-semibold hover:brightness-110">Crear</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    let colorSel = COLORS[0].id;
    document.querySelectorAll('.port-color').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.port-color').forEach(x => x.classList.remove('ring-2','ring-white/80','ring-offset-2','ring-offset-zinc-900'));
        b.classList.add('ring-2','ring-white/80','ring-offset-2','ring-offset-zinc-900');
        colorSel = b.dataset.color;
      });
    });
    $('port-crear-cancelar').addEventListener('click', () => $('port-crear-modal').remove());
    $('port-crear-modal').addEventListener('click', (e) => { if (e.target.id==='port-crear-modal') $('port-crear-modal').remove(); });
    $('port-crear-ok').addEventListener('click', () => {
      const n = $('port-nombre-input').value;
      if (n.trim()) crear(n, colorSel);
    });
    setTimeout(() => $('port-nombre-input').focus(), 100);
  }
  function bind() {
    leerMeta();
    renderHeader();
    $('port-selector-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = $('port-selector-menu');
      if (m.classList.contains('hidden')) {
        renderMenu();
        m.classList.remove('hidden');
      } else {
        m.classList.add('hidden');
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#port-selector-menu') && !e.target.closest('#port-selector-btn')) {
        $('port-selector-menu')?.classList.add('hidden');
      }
    });
    $('port-crear-btn')?.addEventListener('click', abrirCrear);
  }
  return { bind, activoData, activoId };
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
    if (spread >= 5) veredicto = '🚀 Tu portafolio aplasta a CETES — el riesgo extra está pagando.';
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
        0%, 100% { box-shadow: 0 0 60px 0 rgba(192,132,252,.5), 0 0 120px 20px rgba(168,85,247,.25); }
        50% { box-shadow: 0 0 80px 10px rgba(192,132,252,.7), 0 0 160px 30px rgba(168,85,247,.4); }
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
      .mes-bignum { font-family: 'Outfit', system-ui, sans-serif; font-weight: 800; letter-spacing: -0.04em; line-height: .88; }
      .mes-eyebrow { font-family: 'Outfit', system-ui, sans-serif; font-weight: 600; letter-spacing: .26em; text-transform: uppercase; font-size: 11px; }
      .mes-confetti-piece { position: absolute; width: 8px; height: 14px; animation: mesConfetti 3s ease-out forwards; border-radius: 1px; }
      .mes-tap-zone { position: absolute; top: 0; bottom: 0; width: 35%; cursor: pointer; z-index: 10; }
      .mes-modal-bg { background: radial-gradient(ellipse at top, rgba(34,197,94,.15), rgba(0,0,0,.96) 60%), rgba(0,0,0,.96); }

      /* Reveals secuenciales por slide */
      .mes-reveal-1 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .15s both; }
      .mes-reveal-2 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .35s both; }
      .mes-reveal-3 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .55s both; }
      .mes-reveal-4 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .75s both; }
      .mes-reveal-5 { animation: mesFadeUp .55s cubic-bezier(.18,.95,.32,1) .95s both; }

      /* Marquee de texto en background */
      .mes-marquee {
        position: absolute; left: 0; right: 0; top: 50%;
        font-family: 'Outfit', sans-serif; font-weight: 900; font-size: 130px;
        letter-spacing: -.04em; text-transform: uppercase;
        color: rgba(255,255,255,.07); white-space: nowrap;
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
        border-radius: 24px;
        animation: mesGlowPulse 3.5s ease-in-out infinite, mesFloatY 4s ease-in-out infinite;
        background: #0a0a0b;
        overflow: hidden;
      }
      .mes-card::before {
        content: ''; position: absolute; inset: -3px;
        border-radius: 26px;
        background: linear-gradient(120deg,
          #f0abfc 0%, #c084fc 12%, #818cf8 24%, #38bdf8 36%,
          #34d399 48%, #fde047 60%, #fb923c 72%, #f87171 84%, #f0abfc 96%);
        background-size: 300% 100%;
        animation: mesHolo 6s linear infinite;
        z-index: -1;
      }
      .mes-card-inner {
        position: absolute; inset: 3px;
        border-radius: 21px;
        background:
          radial-gradient(ellipse at top, rgba(168,85,247,.3), transparent 60%),
          linear-gradient(160deg, #1a0840 0%, #0a0114 60%, #2e1065 100%);
        display: flex; flex-direction: column; padding: 18px 16px;
        overflow: hidden;
      }
      .mes-card-shine {
        position: absolute; inset: 3px;
        border-radius: 21px;
        background: linear-gradient(115deg,
          transparent 35%,
          rgba(255,255,255,.18) 48%,
          rgba(255,255,255,.04) 52%,
          transparent 65%);
        background-size: 200% 100%;
        animation: mesShimmer 4s linear infinite;
        pointer-events: none;
      }
      .mes-card-rarity {
        font-family: 'Outfit', sans-serif; font-weight: 700;
        font-size: 9px; letter-spacing: .25em; text-transform: uppercase;
        color: #fde047;
        text-shadow: 0 0 8px rgba(253,224,71,.4);
      }
      .mes-card-illustration {
        flex: 1;
        display: flex; align-items: center; justify-content: center;
        margin: 12px 0;
        background: radial-gradient(circle at center, rgba(168,85,247,.25), transparent 70%);
        border-radius: 14px;
        position: relative;
      }
      .mes-card-illustration::before {
        content: ''; position: absolute; inset: 0;
        background: repeating-conic-gradient(from 0deg, rgba(168,85,247,.08) 0 5deg, transparent 5deg 15deg);
        animation: mesRayRotate 30s linear infinite;
        opacity: .6;
        border-radius: 14px;
      }
      .mes-card-illustration svg { position: relative; z-index: 1; filter: drop-shadow(0 4px 16px rgba(192,132,252,.6)); }
      .mes-card-title {
        font-family: 'Outfit', sans-serif; font-weight: 800;
        font-size: 26px; letter-spacing: -.02em;
        color: white; line-height: 1;
        text-align: center;
        background: linear-gradient(135deg, #fff 0%, #fde047 50%, #f0abfc 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .mes-card-desc {
        font-family: 'Outfit', sans-serif; font-weight: 400;
        font-size: 11px; line-height: 1.4;
        color: rgba(255,255,255,.75);
        text-align: center; margin-top: 8px;
        padding: 0 4px;
      }
      .mes-card-stats {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
        margin-top: 12px; padding-top: 12px;
        border-top: 1px solid rgba(255,255,255,.1);
      }
      .mes-card-stat {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 8px; padding: 6px 8px;
        text-align: center;
      }
      .mes-card-stat-label {
        font-family: 'Outfit', sans-serif; font-weight: 600;
        font-size: 8px; letter-spacing: .15em; text-transform: uppercase;
        color: rgba(255,255,255,.5);
      }
      .mes-card-stat-value {
        font-family: 'Outfit', sans-serif; font-weight: 700;
        font-size: 16px; color: white; line-height: 1;
        margin-top: 2px;
      }
      .mes-card-stars {
        display: flex; gap: 2px; justify-content: center;
        margin-top: 6px;
        animation: mesPopIn .6s cubic-bezier(.18,.95,.32,1) 1.5s both;
      }
      .mes-card-star { color: #fde047; font-size: 11px; filter: drop-shadow(0 0 4px rgba(253,224,71,.6)); }

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
        height: 3px; background: currentColor; border-radius: 2px;
        transform-origin: left;
        animation: mesUnderline .8s cubic-bezier(.18,.95,.32,1) .6s both;
      }

      /* Trofeo / medalla SVG */
      .mes-medal {
        width: 200px; height: 200px;
        animation: mesPopIn .9s cubic-bezier(.18,.95,.32,1) .3s both;
        filter: drop-shadow(0 8px 24px rgba(0,0,0,.4));
      }
      .mes-medal-spin svg { animation: mesSpinSlow 18s linear infinite; }

      /* Trending arrow grande */
      .mes-trend-arrow {
        animation: mesPopIn .8s cubic-bezier(.18,.95,.32,1) .3s both;
        filter: drop-shadow(0 6px 20px rgba(251,146,60,.5));
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

    const portData = (typeof PortfolioManager !== 'undefined') ? PortfolioManager.activoData() : { nombre: 'Mi portafolio', emoji: '📊' };

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
        <radialGradient id="bullseye" cx=".5" cy=".5"><stop offset="0%" stop-color="#fff"/><stop offset="60%" stop-color="#fde047"/><stop offset="100%" stop-color="#f97316"/></radialGradient>
        <linearGradient id="arrow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#fde047"/></linearGradient>
      </defs>
      <circle cx="80" cy="80" r="62" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="2"/>
      <circle cx="80" cy="80" r="48" fill="none" stroke="#f0abfc" stroke-width="3"/>
      <circle cx="80" cy="80" r="34" fill="none" stroke="#c084fc" stroke-width="3"/>
      <circle cx="80" cy="80" r="20" fill="url(#bullseye)"/>
      <circle cx="80" cy="80" r="6" fill="#fff"/>
      <line x1="20" y1="20" x2="78" y2="78" stroke="url(#arrow)" stroke-width="3" stroke-linecap="round"/>
      <polygon points="80,80 70,68 78,72 76,64" fill="#fde047"/>
      <polygon points="22,18 14,14 18,22" fill="#fff"/>
    </svg>`,
    sabio: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="zenG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
      </defs>
      <circle cx="80" cy="80" r="60" fill="none" stroke="url(#zenG)" stroke-width="3"/>
      <circle cx="80" cy="80" r="48" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="4 6"/>
      <path d="M 30 80 Q 30 50 80 50 Q 130 50 130 80" fill="#fff"/>
      <path d="M 30 80 Q 30 110 80 110 Q 130 110 130 80" fill="#1a0840"/>
      <circle cx="80" cy="55" r="6" fill="#1a0840"/>
      <circle cx="80" cy="105" r="6" fill="#fff"/>
      <circle cx="80" cy="80" r="2" fill="#fff" opacity=".8"><animate attributeName="r" values="2;4;2" dur="3s" repeatCount="indefinite"/></circle>
    </svg>`,
    trader: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="boltG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fde047"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
        <radialGradient id="coreG" cx=".5" cy=".5"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#fde047"/></radialGradient>
      </defs>
      <circle cx="80" cy="80" r="50" fill="url(#coreG)" opacity=".15"/>
      <polygon points="65,20 95,75 75,75 90,140 50,80 70,80" fill="url(#boltG)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <polygon points="115,40 130,75 122,75 130,110 110,82 118,82" fill="#fb923c" opacity=".7"/>
      <polygon points="35,55 45,80 38,80 44,110 28,85 34,85" fill="#fb923c" opacity=".7"/>
    </svg>`,
    rentista: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="coinG" cx=".4" cy=".3"><stop offset="0%" stop-color="#fef3c7"/><stop offset="50%" stop-color="#fde047"/><stop offset="100%" stop-color="#a16207"/></radialGradient>
      </defs>
      <ellipse cx="80" cy="125" rx="40" ry="9" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="120" rx="40" ry="9" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="105" rx="42" ry="10" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="100" rx="42" ry="10" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="83" rx="44" ry="11" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="78" rx="44" ry="11" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <text x="80" y="84" text-anchor="middle" font-family="Outfit" font-weight="800" font-size="18" fill="#854d0e">$</text>
      <ellipse cx="80" cy="58" rx="46" ry="12" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <ellipse cx="80" cy="52" rx="46" ry="12" fill="url(#coinG)" stroke="#854d0e" stroke-width="2"/>
      <text x="80" y="58" text-anchor="middle" font-family="Outfit" font-weight="800" font-size="20" fill="#854d0e">$</text>
      <circle cx="50" cy="35" r="3" fill="#fde047"><animate attributeName="cy" values="35;25;35" dur="2.5s" repeatCount="indefinite"/></circle>
      <circle cx="115" cy="40" r="2" fill="#fde047"><animate attributeName="cy" values="40;30;40" dur="2s" repeatCount="indefinite" begin="0.3s"/></circle>
    </svg>`,
    diversificador: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="planetG" cx=".4" cy=".4"><stop offset="0%" stop-color="#5eead4"/><stop offset="100%" stop-color="#0d9488"/></radialGradient>
      </defs>
      <line x1="35" y1="35" x2="80" y2="55" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <line x1="125" y1="40" x2="80" y2="55" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <line x1="80" y1="55" x2="50" y2="105" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <line x1="80" y1="55" x2="120" y2="100" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <line x1="50" y1="105" x2="80" y2="130" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <line x1="120" y1="100" x2="80" y2="130" stroke="#fff" stroke-opacity=".3" stroke-width="1"/>
      <circle cx="80" cy="80" r="50" fill="none" stroke="#fff" stroke-opacity=".15" stroke-dasharray="2 4"/>
      <circle cx="80" cy="55" r="22" fill="url(#planetG)" stroke="#fff" stroke-width="2"/>
      <ellipse cx="80" cy="55" rx="32" ry="6" fill="none" stroke="#fde047" stroke-width="1.5" opacity=".7" transform="rotate(-15 80 55)"/>
      <circle cx="35" cy="35" r="4" fill="#fde047"/>
      <circle cx="125" cy="40" r="3" fill="#f0abfc"/>
      <circle cx="50" cy="105" r="3" fill="#38bdf8"/>
      <circle cx="120" cy="100" r="4" fill="#fb923c"/>
      <circle cx="80" cy="130" r="3" fill="#34d399"/>
    </svg>`,
    convencido: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="diamG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff"/><stop offset="50%" stop-color="#a5f3fc"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient>
      </defs>
      <polygon points="80,20 130,55 110,140 50,140 30,55" fill="url(#diamG)" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="30" y1="55" x2="130" y2="55" stroke="#fff" stroke-width="2"/>
      <line x1="80" y1="20" x2="80" y2="140" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
      <line x1="60" y1="55" x2="80" y2="140" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
      <line x1="100" y1="55" x2="80" y2="140" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
      <polygon points="80,20 100,55 60,55" fill="#fff" opacity=".5"/>
      <circle cx="50" cy="40" r="2" fill="#fff" opacity=".8"><animate attributeName="opacity" values=".3;1;.3" dur="2s" repeatCount="indefinite"/></circle>
      <circle cx="115" cy="80" r="2" fill="#fff" opacity=".8"><animate attributeName="opacity" values="1;.3;1" dur="1.8s" repeatCount="indefinite"/></circle>
    </svg>`,
    constructor: `<svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="brickG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#86efac"/><stop offset="100%" stop-color="#16a34a"/></linearGradient>
      </defs>
      <rect x="30" y="120" width="100" height="14" rx="2" fill="url(#brickG)" stroke="#fff" stroke-width="1.5"/>
      <line x1="80" y1="120" x2="80" y2="134" stroke="#0a0a0b" stroke-width="1.5"/>
      <rect x="40" y="100" width="80" height="14" rx="2" fill="url(#brickG)" stroke="#fff" stroke-width="1.5"/>
      <line x1="80" y1="100" x2="80" y2="114" stroke="#0a0a0b" stroke-width="1.5"/>
      <rect x="50" y="80" width="60" height="14" rx="2" fill="url(#brickG)" stroke="#fff" stroke-width="1.5"/>
      <line x1="80" y1="80" x2="80" y2="94" stroke="#0a0a0b" stroke-width="1.5"/>
      <rect x="60" y="60" width="40" height="14" rx="2" fill="url(#brickG)" stroke="#fff" stroke-width="1.5"/>
      <line x1="80" y1="60" x2="80" y2="74" stroke="#0a0a0b" stroke-width="1.5"/>
      <rect x="68" y="40" width="24" height="14" rx="2" fill="url(#brickG)" stroke="#fff" stroke-width="1.5"/>
      <polygon points="68,40 80,28 92,40" fill="#fde047" stroke="#fff" stroke-width="1.5"/>
      <circle cx="80" cy="22" r="3" fill="#fff" opacity=".9"><animate attributeName="opacity" values=".5;1;.5" dur="2s" repeatCount="indefinite"/></circle>
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
    const colors = ['#fde047','#22c55e','#fb7185','#a78bfa','#38bdf8','#fb923c'];
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
        bg: 'linear-gradient(135deg, #064e3b 0%, #16a34a 50%, #fde047 100%)',
        blobs: [
          { color: '#fde047', size: 280, top: '-50px', left: '-80px' },
          { color: '#22c55e', size: 220, bottom: '-60px', right: '-60px' },
        ],
        html: `
          <div class="mes-marquee"><div class="mes-marquee-track">${('TU MES · TU MES · TU MES · ').repeat(8)}</div></div>
          <p class="mes-eyebrow text-emerald-100 mes-reveal-1">Tu mes en Mi Portafolio</p>
          <h1 class="mes-bignum text-white mt-3 mes-reveal-2" style="font-size:78px;"><span class="mes-underline">${escapeHtml(s.nombreMes.split(' ')[0])}</span></h1>
          <p class="mes-bignum text-emerald-200 mes-reveal-3" style="font-size:36px; opacity:.8;">${escapeHtml(s.nombreMes.split(' ').slice(1).join(' '))}</p>
          <div class="mt-10 inline-flex items-center gap-3 bg-white/15 backdrop-blur rounded-full px-5 py-2.5 border border-white/20 mes-reveal-4">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded-md font-bold text-white text-sm" style="background:rgba(255,255,255,0.18);">${escapeHtml((s.portafolio.nombre || 'P').charAt(0).toUpperCase())}</span>
            <span class="text-white font-semibold">${escapeHtml(s.portafolio.nombre)}</span>
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
        bg: 'linear-gradient(135deg, #831843 0%, #a21caf 50%, #d946ef 100%)',
        blobs: [
          { color: '#fbcfe8', size: 200, top: '60px', right: '-40px' },
          { color: '#d946ef', size: 280, bottom: '-100px', left: '-80px' },
        ],
        html: `
          <!-- Sunburst rays detrás del número -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg width="500" height="500" viewBox="0 0 500 500" style="opacity:.18; animation: mesRayRotate 60s linear infinite;">
              ${Array.from({length: 16}, (_, i) => {
                const a = (i * 22.5) * Math.PI / 180;
                return `<polygon points="250,250 ${250 + Math.cos(a)*250},${250 + Math.sin(a)*250} ${250 + Math.cos(a + 0.06)*240},${250 + Math.sin(a + 0.06)*240}" fill="#fde047"/>`;
              }).join('')}
            </svg>
          </div>
          <p class="mes-eyebrow text-pink-100 mes-reveal-1">Tu Sharpe del mes</p>
          <div class="mes-ring-host mes-reveal-2 mt-3">
            <p class="mes-bignum text-white" style="font-size:130px;">
              <span data-counter="${s.pctSharpe}" data-format="topPct" class="mes-shimmer-text">Top 0%</span>
            </p>
          </div>
          <div class="mt-3 inline-flex items-center gap-2 bg-white/20 backdrop-blur rounded-full px-4 py-2 border border-white/25 mes-reveal-3">
            <span class="text-yellow-200">★</span>
            <p class="text-white font-bold tabular text-lg">Sharpe ${s.sharpe.toFixed(2)}</p>
            <span class="text-yellow-200">★</span>
          </div>
          <p class="text-pink-50 text-base mt-10 leading-relaxed mes-reveal-4">
            Mejor que el <span class="font-bold text-white text-xl">${100 - s.pctSharpe}%</span><br>
            de los portafolios diversificados.
          </p>
          ${s.pctSharpe <= 10 ? `<p class="mt-6 text-yellow-200 text-sm font-bold tracking-widest mes-reveal-5">★ ÉLITE ★</p>` : ''}
        `,
        confetti: s.pctSharpe <= 10 ? 50 : 0,
      },

      // ───────────── 3. RETORNO ANUALIZADO ─────────────
      {
        bg: 'linear-gradient(135deg, #7c2d12 0%, #ea580c 50%, #fbbf24 100%)',
        blobs: [
          { color: '#fde68a', size: 240, top: '-40px', right: '-60px' },
          { color: '#fb923c', size: 280, bottom: '-80px', left: '-60px' },
        ],
        html: `
          <!-- Trending arrow gigante atrás -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none mes-trend-arrow">
            <svg width="380" height="380" viewBox="0 0 200 200" style="opacity:.18;">
              <defs>
                <linearGradient id="arrG3" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="100%" stop-color="#fff"/></linearGradient>
              </defs>
              <path d="M 20 160 L 80 100 L 110 130 L 175 50" fill="none" stroke="url(#arrG3)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
              <polygon points="175,50 145,55 165,75" fill="#fff" opacity=".8"/>
            </svg>
          </div>
          <p class="mes-eyebrow text-orange-100 mes-reveal-1">Retorno anualizado</p>
          <p class="mes-bignum text-white mt-3 mes-reveal-2" style="font-size:130px;">
            <span data-counter="${Math.abs(s.retAnual)}" data-prefix="${s.retAnual >= 0 ? '+' : '-'}" data-suffix="%" data-decimals="1" class="mes-shimmer-text">${s.retAnual >= 0 ? '+' : '-'}0.0%</span>
          </p>
          <div class="mt-3 inline-flex items-center gap-2 bg-white/15 backdrop-blur rounded-full px-4 py-1.5 border border-white/20 mes-reveal-3">
            <span class="text-yellow-200">↑</span>
            <p class="text-white font-bold tabular text-sm">vs S&P 500 +12.3% · IPC +6.1%</p>
          </div>
          <p class="text-orange-50 text-base mt-10 leading-relaxed mes-reveal-4">
            Estás en el <span class="font-bold text-white text-xl">top ${s.pctRetorno}%</span><br>
            por rendimiento.
          </p>
          <p class="text-orange-200 text-xs mt-8 italic mes-reveal-5">Pasado ≠ futuro. Pero hoy te luce.</p>
        `,
        confetti: s.pctRetorno <= 10 ? 35 : 0,
      },

      // ───────────── 4. OPERACIONES ─────────────
      {
        bg: 'linear-gradient(135deg, #1e3a8a 0%, #2563eb 50%, #06b6d4 100%)',
        blobs: [
          { color: '#22d3ee', size: 260, bottom: '-80px', right: '-80px' },
          { color: '#3b82f6', size: 220, top: '-40px', left: '-50px' },
        ],
        html: `
          <p class="mes-eyebrow text-sky-100">${s.totalOps > 10 ? 'Hyperactivo' : (s.totalOps > 0 ? 'Operaciones del mes' : 'Mes zen')}</p>
          <p class="mes-bignum text-white mt-3" style="font-size:160px;">
            <span data-counter="${s.totalOps}" data-decimals="0">0</span>
          </p>
          <p class="text-sky-100 text-lg mt-2 font-medium">${s.totalOps === 1 ? 'operación' : 'operaciones'}</p>
          <div class="grid grid-cols-2 gap-3 mt-8">
            <div class="bg-white/15 backdrop-blur rounded-xl px-4 py-3 border border-white/20">
              <p class="text-[10px] uppercase tracking-wider text-sky-100">Compras</p>
              <p class="text-2xl font-bold text-white tabular">${s.compras}</p>
            </div>
            <div class="bg-white/15 backdrop-blur rounded-xl px-4 py-3 border border-white/20">
              <p class="text-[10px] uppercase tracking-wider text-sky-100">Ventas</p>
              <p class="text-2xl font-bold text-white tabular">${s.ventas}</p>
            </div>
          </div>
          ${s.tickerMasOperado ? `<p class="text-sky-50 text-sm mt-8">Tu favorita: <span class="font-mono font-bold text-white text-lg">${escapeHtml(s.tickerMasOperado)}</span></p>` : '<p class="text-sky-100 text-sm mt-8 italic">A veces no hacer nada es la mejor jugada.</p>'}
        `,
      },

      // ───────────── 5. DIVIDENDOS ─────────────
      ...(s.dividendosMes > 0 || s.dividendosAno > 0 ? [{
        bg: 'linear-gradient(135deg, #422006 0%, #ca8a04 50%, #fde047 100%)',
        blobs: [
          { color: '#fef08a', size: 280, top: '-60px', right: '-80px' },
          { color: '#facc15', size: 220, bottom: '-60px', left: '-60px' },
        ],
        html: `
          <p class="mes-eyebrow text-yellow-100">Dividendos cobrados</p>
          <p class="mes-bignum text-white mt-3" style="font-size:90px;">
            <span data-counter="${s.dividendosMes}" data-prefix="$" data-decimals="2">$0.00</span>
          </p>
          <p class="text-yellow-100 text-base mt-4">este mes</p>
          ${s.dividendosAno > s.dividendosMes ? `
            <div class="mt-10 bg-white/15 backdrop-blur rounded-2xl px-5 py-4 border border-white/20">
              <p class="text-[10px] uppercase tracking-wider text-yellow-100">En lo que va del año</p>
              <p class="text-3xl font-bold text-white tabular mt-1">${fmt$(s.dividendosAno)}</p>
            </div>
          ` : ''}
          <p class="text-yellow-50 text-sm mt-10 italic leading-relaxed">Cada peso que recibes es uno<br>que no necesitas vender.</p>
        `,
        confetti: s.dividendosMes > 500 ? 40 : 0,
      }] : []),

      // ───────────── 6. CAPITAL MOVIDO ─────────────
      ...(s.capitalMovido > 0 ? [{
        bg: 'linear-gradient(135deg, #4c0519 0%, #db2777 50%, #f472b6 100%)',
        blobs: [
          { color: '#fbcfe8', size: 240, top: '0', right: '-60px' },
          { color: '#ec4899', size: 280, bottom: '-100px', left: '-60px' },
        ],
        html: `
          <p class="mes-eyebrow text-pink-100">Capital en movimiento</p>
          <p class="mes-bignum text-white mt-3" style="font-size:84px;">
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
        bg: 'linear-gradient(135deg, #134e4a 0%, #0d9488 50%, #5eead4 100%)',
        blobs: [
          { color: '#5eead4', size: 280, top: '-50px', left: '-70px' },
          { color: '#14b8a6', size: 240, bottom: '-60px', right: '-80px' },
        ],
        html: `
          <p class="mes-eyebrow text-teal-100">Tu paleta del mes</p>
          <p class="mes-bignum text-white mt-3" style="font-size:160px;">
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
        bg: 'linear-gradient(160deg, #1a0840 0%, #0a0114 35%, #2e1065 100%)',
        blobs: [
          { color: '#c084fc', size: 260, top: '-40px', right: '-60px' },
          { color: '#a78bfa', size: 280, bottom: '-100px', left: '-80px' },
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
              const colors = ['#fde047', '#c084fc', '#f0abfc', '#fff'];
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
                  <div class="mes-card-stars">${Array.from({length: vibe.stars}, () => '<span class="mes-card-star">★</span>').join('')}${Array.from({length: 5 - vibe.stars}, () => '<span class="mes-card-star" style="color:rgba(255,255,255,.15);">★</span>').join('')}</div>
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
        bg: 'linear-gradient(135deg, #064e3b 0%, #059669 50%, #6ee7b7 100%)',
        blobs: [
          { color: '#86efac', size: 280, top: '-50px', left: '-80px' },
          { color: '#fde047', size: 220, bottom: '-60px', right: '-50px' },
          { color: '#22c55e', size: 200, top: '40%', right: '-40px' },
        ],
        html: `
          <!-- Rays detrás -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg width="500" height="500" viewBox="0 0 500 500" style="opacity:.22; animation: mesRayRotate 90s linear infinite;">
              ${Array.from({length: 24}, (_, i) => {
                const a = (i * 15) * Math.PI / 180;
                return `<polygon points="250,250 ${250 + Math.cos(a)*250},${250 + Math.sin(a)*250} ${250 + Math.cos(a + 0.04)*240},${250 + Math.sin(a + 0.04)*240}" fill="#fff"/>`;
              }).join('')}
            </svg>
          </div>
          <!-- Trofeo SVG -->
          <div class="mes-medal mes-reveal-1">
            <svg width="160" height="160" viewBox="0 0 160 160">
              <defs>
                <linearGradient id="trophyG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fef3c7"/><stop offset="50%" stop-color="#fde047"/><stop offset="100%" stop-color="#a16207"/></linearGradient>
                <radialGradient id="shineT" cx=".3" cy=".3"><stop offset="0%" stop-color="#fff" stop-opacity=".8"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient>
              </defs>
              <path d="M50 40 Q50 100 80 100 Q110 100 110 40 Z" fill="url(#trophyG)" stroke="#854d0e" stroke-width="2.5"/>
              <path d="M40 50 Q30 60 30 75 Q30 85 40 88" fill="none" stroke="url(#trophyG)" stroke-width="6" stroke-linecap="round"/>
              <path d="M120 50 Q130 60 130 75 Q130 85 120 88" fill="none" stroke="url(#trophyG)" stroke-width="6" stroke-linecap="round"/>
              <rect x="68" y="100" width="24" height="14" fill="url(#trophyG)" stroke="#854d0e" stroke-width="2"/>
              <rect x="55" y="113" width="50" height="10" rx="2" fill="url(#trophyG)" stroke="#854d0e" stroke-width="2"/>
              <text x="80" y="74" text-anchor="middle" font-family="Outfit" font-weight="900" font-size="22" fill="#854d0e">★</text>
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
            ${slides.map((_, i) => `<div class="flex-1 h-[3px] bg-white/25 rounded-full overflow-hidden"><div class="mes-bar h-full bg-white rounded-full" data-i="${i}" style="width:${i < pos ? '100%' : '0%'}"></div></div>`).join('')}
            <button id="mes-cerrar" class="ml-2 text-white/80 hover:text-white text-xl leading-none">×</button>
          </div>

          <!-- Slide host -->
          <div id="mes-slide-host" class="absolute inset-0 rounded-3xl overflow-hidden shadow-2xl"></div>

          <!-- Tap zones -->
          <div id="mes-tap-prev" class="mes-tap-zone left-0"></div>
          <div id="mes-tap-next" class="mes-tap-zone right-0"></div>

          <!-- Action footer -->
          <div class="absolute -bottom-14 left-0 right-0 flex items-center justify-center gap-3">
            <button id="mes-share" class="text-xs text-white/80 hover:text-white bg-white/10 hover:bg-white/20 backdrop-blur rounded-full px-4 py-2 border border-white/20 transition flex items-center gap-1.5">
              <span>📲</span> Compartir slide
            </button>
            ${esAuto ? '<span class="text-[10px] text-white/40 italic">Aparecerá cada día 1 del mes</span>' : ''}
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    function pintar() {
      const slide = slides[pos];
      const host = $('mes-slide-host');
      // Construir slide
      host.innerHTML = `
        <div class="mes-slide w-full h-full relative overflow-hidden flex flex-col items-center justify-center text-center px-8" style="background: ${slide.bg}; font-family: 'Outfit', system-ui, sans-serif;">
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
    if (s.sharpe >= 1.5 && s.totalOps >= 5) return { emoji: '🎯', tipo: 'El Cazador', desc: 'Activo, calculador y con buen ratio riesgo/recompensa.' };
    if (s.sharpe >= 1.5) return { emoji: '🧘', tipo: 'El Sabio', desc: 'Pocas operaciones, gran visión. Tu Sharpe habla por ti.' };
    if (s.totalOps >= 15) return { emoji: '⚡', tipo: 'El Trader', desc: 'Mueves mucho. Cuidado con las comisiones — podrían comerse tu alfa.' };
    if (s.dividendosMes > 100) return { emoji: '💰', tipo: 'El Rentista', desc: 'Buscas flujo, no glamour. Los dividendos siguen llegando.' };
    if (s.tickers >= 10) return { emoji: '🌍', tipo: 'El Diversificador', desc: 'No pones todos los huevos en una canasta. Bien jugado.' };
    if (s.tickers <= 3) return { emoji: '🎲', tipo: 'El Convencido', desc: 'Pocos tickers, mucha convicción. Si funciona, funciona en grande.' };
    return { emoji: '📊', tipo: 'El Constructor', desc: 'Estás armando tu portafolio con paciencia. Eso es lo que cuenta.' };
  }

  function mostrar(esAuto) {
    const s = _estadisticas();
    const vibe = _vibePersonalidad(s);
    const fmt$ = v => '$' + Math.round(v).toLocaleString('en-US');

    const slides = [];

    // 1. Apertura
    slides.push(_slide('🎁', 'Tu mes en Mi Portafolio',
      s.nombreMes,
      `Hola Charlie. Esto es lo que pasó en tu portafolio "<span class="text-accent-green">${escapeHtml(s.portafolio.nombre)}</span>".`,
      'Desliza para ver más →'));

    // 2. Top X% Sharpe
    slides.push(_slide('🏆', 'Tu Sharpe del mes',
      `Top ${s.pctSharpe}%`,
      `Tu Sharpe ratio fue de <span class="text-accent-green font-semibold tabular">${s.sharpe.toFixed(2)}</span>. Mejor que el ${100 - s.pctSharpe}% de portafolios diversificados.`,
      s.pctSharpe <= 10 ? 'Estás entre la élite del retorno ajustado al riesgo.' : 'Hay margen de subir esto el próximo mes.'));

    // 3. Retorno anualizado
    slides.push(_slide('📈', 'Retorno anualizado',
      (s.retAnual >= 0 ? '+' : '') + s.retAnual.toFixed(1) + '%',
      `Estás en el top ${s.pctRetorno}% de inversionistas en términos de retorno.`,
      'Recuerda: rentabilidad pasada no garantiza la futura.'));

    // 4. Operaciones
    slides.push(_slide(s.totalOps > 10 ? '⚡' : (s.totalOps > 0 ? '💼' : '🧘'),
      'Operaciones del mes',
      String(s.totalOps),
      `${s.compras} compras · ${s.ventas} ventas. ${s.totalOps > 10 ? 'Más activo que el ' + (100 - s.pctOps) + '% de inversionistas.' : (s.totalOps > 0 ? 'Movimiento moderado.' : 'No moviste el portafolio. A veces no hacer nada es lo mejor.')}`,
      s.tickerMasOperado ? `Tu ticker más operado: <span class="font-mono text-accent-green">${escapeHtml(s.tickerMasOperado)}</span>` : ''));

    // 5. Dividendos
    if (s.dividendosMes > 0 || s.dividendosAno > 0) {
      slides.push(_slide('💰', 'Dividendos cobrados',
        fmt$(s.dividendosMes),
        s.dividendosAno > s.dividendosMes ? `En lo que va del año: <span class="text-accent-green font-semibold">${fmt$(s.dividendosAno)}</span>` : 'Tu primer flujo pasivo del año.',
        'Cada peso de dividendo es un peso que no necesitas vender.'));
    }

    // 6. Capital movido
    if (s.capitalMovido > 0) {
      slides.push(_slide('💸', 'Capital movido',
        fmt$(s.capitalMovido),
        `Compraste y vendiste por un total de ${fmt$(s.capitalMovido)} este mes.`,
        s.capitalMovido > 50000 ? 'Inversor activo. Revisa que las comisiones no te estén comiendo.' : 'Movimiento sano y medido.'));
    }

    // 7. Tickers únicos
    if (s.tickersUnicosOperados > 0) {
      slides.push(_slide('🎨', 'Tickers operados',
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
    slides.push(_slide('✨', 'Hasta el próximo mes',
      `Top ${Math.min(s.pctSharpe, s.pctRetorno)}%`,
      tagline,
      'Mi Portafolio · Tu compañero financiero'));

    const html = `
      <div class="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-md" id="mes-modal">
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

  async function cargarUniverso() {
    if (estado.cargado) { renderUniverso(); return; }
    try {
      const res = await fetch('/api/universo');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'error');
      estado.universo = body.tickers || [];
      estado.cargado = true;
      const recos = estado.universo.filter(x => x.recomendada).length;
      const meta = $('an-univ-meta');
      if (meta) meta.textContent = `· ${estado.universo.length} acciones · ⭐ ${recos} destacadas`;
      renderUniverso();
    } catch (err) {
      const cont = $('an-univ-lista');
      if (cont) cont.innerHTML = `
        <div class="col-span-full text-center text-xs text-zinc-500 py-6">
          Universo no disponible (${escapeHtml(err.message)}).
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
            <p class="text-xs font-mono text-zinc-100 truncate">${escapeHtml(t.ticker)}${t.recomendada ? ' <span class="text-amber-400">★</span>' : ''}</p>
            <p class="text-[10px] text-zinc-500 truncate">${escapeHtml(t.nombre || '')}</p>
          </div>
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
        <div class="flex items-start justify-between flex-wrap gap-4">
          <div>
            <p class="text-xs uppercase tracking-wider text-zinc-500">${escapeHtml(d.sector || '—')} · ${escapeHtml(d.industria || '—')}</p>
            <h3 class="text-2xl font-semibold text-zinc-100 mt-1">${escapeHtml(d.nombre || d.ticker)}</h3>
            <p class="text-sm text-zinc-500 font-mono mt-0.5">${escapeHtml(d.ticker)} · ${escapeHtml(moneda)}</p>
            ${d.precio_actual != null ? `<p class="text-base text-zinc-200 tabular mt-2">Último precio: <span class="font-semibold">${fmtMoney(d.precio_actual, moneda)} ${escapeHtml(moneda)}</span></p>` : ''}
          </div>
          <div class="text-center">
            <div class="inline-flex items-center justify-center w-28 h-28 rounded-full border-4 ${verCls} relative">
              <div class="text-center">
                <p class="text-3xl font-bold tabular leading-none">${Math.round(d.score)}</p>
                <p class="text-[9px] uppercase tracking-wider mt-1">/ 100</p>
              </div>
            </div>
            <p class="text-xs uppercase tracking-wider mt-2 ${verCls.split(' ')[0]} font-semibold">${escapeHtml(ver.etiqueta || '')}</p>
          </div>
        </div>

        <!-- Componentes del score -->
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
        </div>
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
        <p class="text-[10px] text-zinc-600 mt-4 italic">El score 1-100 es determinístico (basado en métricas cuantitativas). Las narrativas son orientativas — no constituyen asesoría de inversión.</p>
      </div>
    `;

    cont.innerHTML = headerHTML + peerHTML + ddHTML + srHTML
                   + `<div id="an-dashboard-host"><div class="bg-surface border border-surface-border rounded-2xl p-5 text-center text-xs text-zinc-500"><span class="inline-block w-3 h-3 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin mr-2 align-middle"></span>Cargando dashboard financiero…</div></div>`;
    cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
    cargarDashboardFinanciero(d.ticker);
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
          Estados financieros no disponibles para ${escapeHtml(ticker)}. (Típico para ETFs, cripto y ADRs internacionales.)
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
  const _palette = {
    gold:       '#c9a96e',
    sage:       '#8a9a7b',
    terracotta: '#c2746e',
    slate:      '#7a8a99',
    mauve:      '#a08aa3',
    posGreen:   '#4ade80',
    negRed:     '#f87171',
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
      const cls = yoy >= 0 ? 'text-[#4ade80]' : 'text-[#f87171]';
      const arrow = yoy >= 0 ? '▲' : '▼';
      yoyHTML = `<span class="${cls} text-[11px] font-semibold tabular ml-1">${arrow} ${Math.abs(yoy*100).toFixed(1)}% YoY</span>`;
    }
    return `
      <div class="rounded-xl p-4" style="background:#161616; border:1px solid #222;">
        <p class="text-[10px] uppercase tracking-[0.18em] font-semibold" style="color:#a08aa3;">${escapeHtml(kpi.label)}</p>
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
      <section class="rounded-2xl p-6 mt-6" style="background:#0a0a0a; border:1px solid #222; max-width:100%;">
        <div class="flex items-baseline justify-between flex-wrap gap-2 mb-1 pb-4" style="border-bottom:1px solid #222;">
          <div>
            <h3 style="font-family: 'Libre Baskerville', Georgia, serif; font-weight:700; color:#c9a96e;" class="text-2xl">
              Dashboard financiero
            </h3>
            <p class="text-xs text-zinc-500 mt-1" style="font-family: 'Inter', sans-serif;">
              Fiscal Year ${escapeHtml(d.fy_actual || '—')} · datos en ${escapeHtml(moneda)} · ${escapeHtml(d.nombre || d.ticker)}
            </p>
          </div>
          <span class="text-[9px] uppercase tracking-[0.2em] font-semibold px-2.5 py-1 rounded" style="color:#c9a96e; background:rgba(201,169,110,0.08); border:1px solid rgba(201,169,110,0.25);">10-K resumido</span>
        </div>

        <!-- KPI ROW -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-5">
          ${kpisHTML}
        </div>

        <!-- CHARTS GRID -->
        <div class="grid lg:grid-cols-2 gap-4 mt-6">
          <div class="rounded-xl p-5" style="background:#161616; border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:#c9a96e;" class="text-base font-bold">Revenue 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'Inter', sans-serif;">Crecimiento anual de ingresos.</p>
            <canvas id="dash-revenue" class="mt-3" style="max-height:220px;"></canvas>
          </div>
          <div class="rounded-xl p-5" style="background:#161616; border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:#c9a96e;" class="text-base font-bold">Free Cash Flow 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'Inter', sans-serif;">Cuánto efectivo libre genera tras capex.</p>
            <canvas id="dash-fcf" class="mt-3" style="max-height:220px;"></canvas>
          </div>
          <div class="rounded-xl p-5 lg:col-span-2" style="background:#161616; border:1px solid #222;">
            <h4 style="font-family: 'Libre Baskerville', Georgia, serif; color:#c9a96e;" class="text-base font-bold">Márgenes 5Y</h4>
            <p class="text-[10px] text-zinc-500 mt-0.5" style="font-family: 'Inter', sans-serif;">Bruto · Operativo · Neto. La eficiencia operativa en una sola gráfica.</p>
            <canvas id="dash-margenes" class="mt-3" style="max-height:240px;"></canvas>
          </div>
        </div>

        <p class="text-[10px] text-zinc-600 mt-5 italic" style="font-family: 'Inter', sans-serif;">
          Datos de Yahoo Finance · presentación tipo 10-K resumido · no constituye asesoría
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
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161616',
          titleColor: '#c9a96e',
          bodyColor: '#e5e5e5',
          borderColor: '#222',
          borderWidth: 1,
          padding: 10,
          titleFont: { family: 'Libre Baskerville, serif', weight: '700', size: 12 },
          bodyFont: { family: 'Inter, sans-serif', size: 12 },
        },
      },
      scales: {
        x: { ticks: { color: '#71717a', font: { family: 'Inter', size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#71717a', font: { family: 'Inter', size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
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
          borderRadius: 4, borderSkipped: false,
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
          borderColor: _palette.gold, backgroundColor: 'rgba(201,169,110,0.12)',
          borderWidth: 2.5, tension: 0.3, fill: true,
          pointRadius: 4, pointHoverRadius: 7,
          pointBackgroundColor: '#0a0a0a', pointBorderColor: _palette.gold, pointBorderWidth: 2,
          pointHoverBackgroundColor: _palette.gold, pointHoverBorderColor: '#fff',
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
            { label: 'Bruto',     data: labM.map(a => mg[a] != null ? mg[a]*100 : null), backgroundColor: _palette.gold,       borderRadius: 4 },
            { label: 'Operativo', data: labM.map(a => mo[a] != null ? mo[a]*100 : null), backgroundColor: _palette.sage,       borderRadius: 4 },
            { label: 'Neto',      data: labM.map(a => mn[a] != null ? mn[a]*100 : null), backgroundColor: _palette.terracotta, borderRadius: 4 },
          ],
        },
        options: {
          ..._common,
          plugins: {
            ..._common.plugins,
            legend: { display: true, labels: { color: '#a1a1aa', font: { family: 'Inter', size: 11 }, boxWidth: 10, boxHeight: 10 } },
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
    asistente:     document.getElementById('vista-asistente'),
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
      if (vista === 'asistente')     Asistente.cargar();
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
    Picker.resetYPrecargar(actuales);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  init();
  CetesBench.bind();
  bindNav();
  bindEditar();
  bindExportarPdf();
  Explorador.bind();
  Periodico.bind();
  Rebalanceo.bind();
  Transacciones.bind();
  Impuestos.bind();
  Metas.bind();
  Asistente.bind();
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

  // ── PWA: registrar service worker ───────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch(err => console.warn('SW falló registrar:', err));
    });
  }
});
