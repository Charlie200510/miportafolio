// ============================================================
//  herramientas_avanzadas.js — UI para las 4 features Sprint 1
//  - Deep Dive BMV
//  - Optimizador Fiscal MX
//  - Screener Avanzado
//  - Alertas Multi-Condición
// ============================================================
(function() {
  'use strict';

  // ============================================================
  //  HELPERS GLOBALES
  // ============================================================
  const _fmt = {
    num:   (v, d=2) => v == null ? '—' : v.toFixed(d),
    pct:   (v, d=2) => v == null ? '—' : (v * 100).toFixed(d) + '%',
    money: (v, m='MXN') => v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')} ${m}`,
    sign:  (v, d=2) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d),
  };

  function _abrirModal(htmlContent, id = 'mp-herramienta-modal') {
    const existente = document.getElementById(id);
    if (existente) existente.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div id="${id}" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;backdrop-filter:blur(6px);overflow-y:auto;-webkit-overflow-scrolling:touch;">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:720px;width:100%;margin:20px 0;">
          ${htmlContent}
        </div>
      </div>`);
    const m = document.getElementById(id);
    m.addEventListener('click', (e) => { if (e.target.id === id) m.remove(); });
    return m;
  }

  // ============================================================
  //  1) DEEP DIVE BMV
  // ============================================================
  window.abrirDeepDive = async function(tickerInicial = '') {
    const formHTML = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#3b82f6;">Análisis profundo</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">Deep Dive de empresa</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Métricas + comparativa vs peers + narrativa automática. Especialmente útil para BMV (WALMEX, GFNORTEO, AMX, etc).</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <input id="mp-dd-ticker" type="text" value="${tickerInicial}" placeholder="WALMEX.MX, AAPL, BIMBOA.MX..." style="flex:1;background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:10px 12px;font-size:14px;color:#f4f4f5;text-transform:uppercase;font-family:monospace;">
          <button id="mp-dd-analizar" style="background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;">Analizar →</button>
        </div>
        <div id="mp-dd-resultado"></div>
      </div>`;
    _abrirModal(formHTML);
    const ejecutar = async () => {
      const t = document.getElementById('mp-dd-ticker').value.trim().toUpperCase();
      if (!t) return;
      const cont = document.getElementById('mp-dd-resultado');
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:20px;">Analizando ${t}… (15-30 seg)</p>`;
      try {
        const res = await fetch(`/api/deep-dive/${encodeURIComponent(t)}`);
        const d = await res.json();
        if (!d.ok) {
          cont.innerHTML = `<p style="color:#ef4444;font-size:13px;">${d.error || 'Error'}</p>`;
          return;
        }
        cont.innerHTML = _renderDeepDive(d);
      } catch (e) {
        cont.innerHTML = `<p style="color:#ef4444;font-size:13px;">Error: ${e.message}</p>`;
      }
    };
    document.getElementById('mp-dd-analizar').addEventListener('click', ejecutar);
    document.getElementById('mp-dd-ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') ejecutar(); });
    if (tickerInicial) ejecutar();
  };

  function _renderDeepDive(d) {
    const emp = d.empresa || {};
    const met = d.metricas || {};
    const comp = d.comparativa_peers || {};
    const fila = (label, val, fmtFn, compInfo) => {
      const v = fmtFn(val);
      let cmp = '';
      if (compInfo && compInfo.diferencia_pct != null) {
        const pct = compInfo.diferencia_pct;
        const color = pct > 0 ? '#fb923c' : pct < 0 ? '#22c55e' : '#71717a';
        const signo = pct > 0 ? '+' : '';
        cmp = `<span style="color:${color};font-size:11px;margin-left:6px;">(${signo}${pct.toFixed(0)}% vs sector)</span>`;
      }
      return `<tr><td style="padding:6px 12px;color:#a1a1aa;font-size:13px;">${label}</td><td style="padding:6px 12px;color:#f4f4f5;font-weight:600;text-align:right;font-family:monospace;font-size:13px;">${v}${cmp}</td></tr>`;
    };
    const narr = (d.narrativa || []).map(n => `<li style="padding:6px 0;color:#d4d4d8;font-size:13px;line-height:1.6;list-style:none;">${n}</li>`).join('');
    const peers = (d.peers || []).map(p => `<span style="display:inline-block;padding:3px 8px;background:#161616;border:1px solid #2a2a2f;border-radius:6px;font-size:11px;color:#a1a1aa;font-family:monospace;margin:2px;">${p.ticker}</span>`).join('');
    return `
      <div style="background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(59,130,246,0.02));border:1px solid rgba(59,130,246,0.25);border-radius:12px;padding:16px;margin-bottom:16px;">
        <h3 style="margin:0;font-size:18px;color:#f4f4f5;font-weight:700;">${emp.nombre || d.ticker}</h3>
        <p style="margin:4px 0 0;font-size:11px;color:#a1a1aa;">${emp.sector || ''} · ${emp.industria || ''} · ${emp.pais || ''}</p>
        ${emp.precio ? `<p style="margin:8px 0 0;font-size:24px;color:#3b82f6;font-weight:700;font-family:monospace;">$${emp.precio.toFixed(2)} ${emp.moneda || ''}</p>` : ''}
        ${emp.descripcion ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:11px;color:#71717a;">Descripción de la empresa</summary><p style="margin:8px 0 0;font-size:12px;color:#a1a1aa;line-height:1.5;">${emp.descripcion.substring(0, 600)}${emp.descripcion.length > 600 ? '...' : ''}</p></details>` : ''}
      </div>

      <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:16px 0 8px;">Métricas vs ${peers ? 'peers del sector' : 'mercado'}</h4>
      <table style="width:100%;border-collapse:collapse;background:#0a0a0b;border:1px solid #1a1a1a;border-radius:8px;overflow:hidden;">
        ${fila('P/E (trailing)',    met.pe,           v => _fmt.num(v, 2), comp.pe)}
        ${fila('P/B',               met.pb,           v => _fmt.num(v, 2), comp.pb)}
        ${fila('PEG',               met.peg,          v => _fmt.num(v, 2), null)}
        ${fila('ROE',               met.roe,          v => _fmt.pct(v, 1), comp.roe)}
        ${fila('Dividend yield',    met.div_yield,    v => _fmt.pct(v, 2), comp.div_yield)}
        ${fila('Margen neto',       met.margen_neto,  v => _fmt.pct(v, 1), comp.margen_neto)}
        ${fila('Margen operativo',  met.margen_op,    v => _fmt.pct(v, 1), comp.margen_op)}
        ${fila('Debt/Equity',       met.debt_equity,  v => _fmt.num(v, 2), comp.debt_equity)}
        ${fila('Beta',              met.beta,         v => _fmt.num(v, 2), comp.beta)}
      </table>

      ${narr ? `
        <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:16px 0 8px;">Observaciones automáticas</h4>
        <ul style="margin:0;padding:0;background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:8px 16px;">${narr}</ul>
      ` : ''}

      ${peers ? `
        <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:16px 0 8px;">Peers comparados</h4>
        <div>${peers}</div>
      ` : ''}

      <p style="margin:16px 0 0;font-size:10px;color:#71717a;text-align:center;font-style:italic;">${d.advertencia || ''}</p>
    `;
  }

  // ============================================================
  //  2) OPTIMIZADOR FISCAL MX
  // ============================================================
  window.abrirOptimizadorFiscal = async function() {
    const formHTML = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#a855f7;">Optimizador fiscal</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">¿Qué vender para pagar menos ISR?</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Algoritmo que decide qué posiciones vender (y en qué orden) para minimizar tu ISR mexicano del 10%.</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>
        <div style="background:#161616;border:1px solid #2a2a2f;border-radius:10px;padding:14px;margin-bottom:16px;">
          <label style="display:block;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Monto a liquidar (MXN)</label>
          <input id="mp-of-monto" type="number" min="100" step="1000" value="50000" style="width:100%;background:#0a0a0b;border:1px solid #2a2a2f;border-radius:6px;padding:10px;font-size:16px;color:#f4f4f5;font-family:monospace;">
          <label style="display:block;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:10px 0 6px;">Año fiscal</label>
          <input id="mp-of-ano" type="number" min="2020" max="2030" value="${new Date().getFullYear()}" style="width:100%;background:#0a0a0b;border:1px solid #2a2a2f;border-radius:6px;padding:10px;font-size:16px;color:#f4f4f5;font-family:monospace;">
          <label style="display:block;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:10px 0 6px;">Pérdidas de años anteriores (opcional, MXN)</label>
          <input id="mp-of-perdidas" type="number" min="0" step="1000" value="0" style="width:100%;background:#0a0a0b;border:1px solid #2a2a2f;border-radius:6px;padding:10px;font-size:16px;color:#f4f4f5;font-family:monospace;">
        </div>
        <button id="mp-of-calcular" style="display:block;width:100%;background:#a855f7;color:#fff;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:14px;cursor:pointer;">Calcular plan óptimo →</button>
        <div id="mp-of-resultado" style="margin-top:16px;"></div>
      </div>`;
    _abrirModal(formHTML);
    document.getElementById('mp-of-calcular').addEventListener('click', async () => {
      const cont = document.getElementById('mp-of-resultado');
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:14px;">Calculando…</p>`;
      try {
        // Recolectar transacciones y precios actuales del localStorage / state
        const txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]');
        if (!txs.length) {
          cont.innerHTML = `<p style="color:#fb923c;font-size:13px;padding:14px;background:rgba(251,146,60,0.08);border-radius:8px;">Primero registra tus transacciones en la pestaña <strong>Transacciones</strong> para que el optimizador sepa qué tienes.</p>`;
          return;
        }
        // Precios actuales — pedimos al backend de info_activos del universo
        const precios = {};
        try {
          const respUniv = await fetch('/api/universo');
          const univData = await respUniv.json();
          (univData.tickers || []).forEach(t => {
            if (t.ticker && t.precio) precios[t.ticker] = t.precio;
          });
        } catch {}

        const body = {
          transacciones:       txs,
          precios_actuales:    precios,
          monto_a_vender_mxn:  parseFloat(document.getElementById('mp-of-monto').value),
          ano_fiscal:          parseInt(document.getElementById('mp-of-ano').value),
          perdidas_anteriores: parseFloat(document.getElementById('mp-of-perdidas').value) || 0,
        };
        const res = await fetch('/api/optimizador-fiscal', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (!d.ok) {
          cont.innerHTML = `<p style="color:#ef4444;font-size:13px;padding:14px;">${d.error || 'Error'}</p>`;
          return;
        }
        cont.innerHTML = _renderOptimizador(d);
      } catch (e) {
        cont.innerHTML = `<p style="color:#ef4444;font-size:13px;padding:14px;">Error: ${e.message}</p>`;
      }
    });
  };

  function _renderOptimizador(d) {
    const plan = (d.plan || []).map((p, i) => {
      const color = p.categoria === 'pérdida' ? '#22c55e' :
                    p.categoria === 'ganancia' ? '#ef4444' : '#71717a';
      const signo = p.ganancia_realizada >= 0 ? '+' : '';
      return `
        <tr>
          <td style="padding:8px 12px;color:#a1a1aa;font-size:12px;text-align:center;">${i+1}</td>
          <td style="padding:8px 12px;color:#f4f4f5;font-weight:600;font-family:monospace;font-size:13px;">${p.ticker}</td>
          <td style="padding:8px 12px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:12px;">${p.shares_vender.toFixed(2)}</td>
          <td style="padding:8px 12px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:12px;">$${p.monto_mxn.toLocaleString()}</td>
          <td style="padding:8px 12px;text-align:right;font-family:monospace;color:${color};font-size:12px;">${signo}$${p.ganancia_realizada.toLocaleString()}</td>
          <td style="padding:8px 12px;text-align:center;font-size:10px;color:${color};text-transform:uppercase;font-weight:600;">${p.categoria}</td>
        </tr>`;
    }).join('');

    const ahorro = d.ahorro_isr_mxn;
    const isrAhorroColor = ahorro > 0 ? '#22c55e' : ahorro < 0 ? '#fb923c' : '#71717a';
    return `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px;">
        <div style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.25);border-radius:10px;padding:14px;text-align:center;">
          <p style="margin:0;font-size:10px;color:#a855f7;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">ISR proyectado</p>
          <p style="margin:6px 0 0;font-size:24px;font-weight:700;color:#fff;font-family:monospace;">$${d.isr_proyectado.toLocaleString()}</p>
          <p style="margin:2px 0 0;font-size:11px;color:#a1a1aa;">con plan óptimo</p>
        </div>
        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;padding:14px;text-align:center;">
          <p style="margin:0;font-size:10px;color:#22c55e;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Ahorro vs vender al azar</p>
          <p style="margin:6px 0 0;font-size:24px;font-weight:700;color:${isrAhorroColor};font-family:monospace;">$${ahorro.toLocaleString()}</p>
          <p style="margin:2px 0 0;font-size:11px;color:#a1a1aa;">menos ISR pagado</p>
        </div>
      </div>

      <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:16px 0 8px;">Plan ordenado de ventas (de menos a más impacto fiscal)</h4>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table style="width:100%;border-collapse:collapse;background:#0a0a0b;border:1px solid #1a1a1a;border-radius:8px;">
          <thead>
            <tr style="background:#161616;">
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;">#</th>
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:left;">Ticker</th>
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">Shares</th>
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">$ MXN</th>
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">Ganancia</th>
              <th style="padding:8px 12px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:center;">Cat.</th>
            </tr>
          </thead>
          <tbody>${plan || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#71717a;">Sin plan generado</td></tr>'}</tbody>
        </table>
      </div>

      <div style="margin-top:14px;padding:12px;background:rgba(0,0,0,0.3);border:1px solid #1a1a1a;border-radius:8px;font-size:11px;color:#a1a1aa;line-height:1.6;">
        <p style="margin:0 0 4px;"><strong style="color:#f4f4f5;">Ganancia realizada del año:</strong> $${d.ganancia_realizada_ano.toLocaleString()}</p>
        <p style="margin:0 0 4px;"><strong style="color:#f4f4f5;">Impacto del plan:</strong> ${d.impacto_plan_mxn >= 0 ? '+' : ''}$${d.impacto_plan_mxn.toLocaleString()}</p>
        <p style="margin:0 0 4px;"><strong style="color:#f4f4f5;">Base gravable proyectada:</strong> $${d.base_gravable_proyectada.toLocaleString()}</p>
        ${d.perdida_arrastrable > 0 ? `<p style="margin:0;color:#22c55e;"><strong>Pérdida arrastrable a años futuros:</strong> $${d.perdida_arrastrable.toLocaleString()}</p>` : ''}
      </div>
      <p style="margin:12px 0 0;font-size:10px;color:#71717a;text-align:center;font-style:italic;">${d.advertencia}</p>
    `;
  }

  // ============================================================
  //  3) SCREENER AVANZADO
  // ============================================================
  window.abrirScreener = function() {
    const formHTML = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#fb923c;">Screener</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">Filtra el universo de tickers</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Encuentra acciones que cumplan tus criterios: P/E, yield, beta, market cap, sector...</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px;">
          <label style="font-size:11px;color:#71717a;">Tipo<select id="mp-sc-tipo" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;"><option value="">Todos</option><option value="acciones">Acciones</option><option value="etfs">ETFs</option><option value="crypto">Crypto</option></select></label>
          <label style="font-size:11px;color:#71717a;">Mercado<select id="mp-sc-mercado" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;"><option value="">Todos</option><option value="MX">México (BMV)</option><option value="US">USA</option><option value="INTL">Internacional</option><option value="Crypto">Crypto</option></select></label>
          <label style="font-size:11px;color:#71717a;">Sector<input id="mp-sc-sector" type="text" placeholder="Technology, Financial..." style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;"></label>
          <label style="font-size:11px;color:#71717a;">Market cap mín. USD<input id="mp-sc-mc" type="number" placeholder="10000000000" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;font-family:monospace;"></label>
          <label style="font-size:11px;color:#71717a;">P/E máx.<input id="mp-sc-pemax" type="number" placeholder="25" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;font-family:monospace;"></label>
          <label style="font-size:11px;color:#71717a;">Yield mín. (%)<input id="mp-sc-ymin" type="number" step="0.5" placeholder="2" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;font-family:monospace;"></label>
          <label style="font-size:11px;color:#71717a;">Beta máx.<input id="mp-sc-bmax" type="number" step="0.1" placeholder="1.2" style="display:block;width:100%;background:#161616;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-top:4px;font-family:monospace;"></label>
          <label style="font-size:11px;color:#71717a;display:flex;align-items:flex-end;gap:6px;padding-top:18px;"><input id="mp-sc-reco" type="checkbox" style="accent-color:#22c55e;">Solo recomendadas ⭐</label>
        </div>
        <button id="mp-sc-buscar" style="display:block;width:100%;background:#fb923c;color:#0a0a0b;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:14px;cursor:pointer;">Buscar →</button>
        <div id="mp-sc-resultado" style="margin-top:16px;"></div>
      </div>`;
    _abrirModal(formHTML);
    document.getElementById('mp-sc-buscar').addEventListener('click', async () => {
      const cont = document.getElementById('mp-sc-resultado');
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:14px;">Filtrando…</p>`;
      const get = id => document.getElementById(id).value.trim();
      const num = id => { const v = parseFloat(get(id)); return isFinite(v) ? v : null; };
      const criterios = {
        tipo:               get('mp-sc-tipo') || undefined,
        mercado:            get('mp-sc-mercado') || undefined,
        sector:             get('mp-sc-sector') || undefined,
        market_cap_min:     num('mp-sc-mc'),
        pe_max:             num('mp-sc-pemax'),
        yield_min:          num('mp-sc-ymin') ? num('mp-sc-ymin') / 100 : undefined,
        beta_max:           num('mp-sc-bmax'),
        solo_recomendadas:  document.getElementById('mp-sc-reco').checked,
        limit:              50,
      };
      // Limpiar undefined
      Object.keys(criterios).forEach(k => criterios[k] == null && delete criterios[k]);
      try {
        const res = await fetch('/api/screener', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(criterios),
        });
        const d = await res.json();
        if (!d.ok) { cont.innerHTML = `<p style="color:#ef4444;">${d.error || 'Error'}</p>`; return; }
        cont.innerHTML = _renderScreener(d);
      } catch (e) { cont.innerHTML = `<p style="color:#ef4444;">Error: ${e.message}</p>`; }
    });
  };

  function _renderScreener(d) {
    const filas = (d.resultados || []).map(r => {
      const mc = r.market_cap ? (r.market_cap >= 1e9 ? `$${(r.market_cap/1e9).toFixed(1)}B` : r.market_cap >= 1e6 ? `$${(r.market_cap/1e6).toFixed(1)}M` : `$${(r.market_cap/1000).toFixed(0)}K`) : '—';
      return `<tr>
        <td style="padding:6px 10px;font-family:monospace;color:#f4f4f5;font-weight:600;font-size:12px;">${r.ticker} ${r.recomendada ? '⭐' : ''}</td>
        <td style="padding:6px 10px;color:#a1a1aa;font-size:11px;">${r.sector || '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:11px;">${r.pe ? r.pe.toFixed(1) : '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:11px;">${r.yield ? (r.yield * 100).toFixed(2) + '%' : '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:11px;">${r.beta ? r.beta.toFixed(2) : '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#d4d4d8;font-size:11px;">${mc}</td>
      </tr>`;
    }).join('');
    return `
      <p style="font-size:12px;color:#a1a1aa;margin:0 0 8px;">${d.total} resultados (mostrando primeros 50, ordenados por market cap)</p>
      <div style="overflow-x:auto;max-height:400px;overflow-y:auto;-webkit-overflow-scrolling:touch;">
        <table style="width:100%;border-collapse:collapse;background:#0a0a0b;border:1px solid #1a1a1a;border-radius:8px;">
          <thead style="position:sticky;top:0;background:#161616;">
            <tr>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:left;">Ticker</th>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:left;">Sector</th>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">P/E</th>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">Yield</th>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">Beta</th>
              <th style="padding:8px 10px;font-size:10px;color:#71717a;text-transform:uppercase;text-align:right;">Market Cap</th>
            </tr>
          </thead>
          <tbody>${filas || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#71717a;">Sin resultados con esos criterios</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  // ============================================================
  //  4) ALERTAS MULTI-CONDICIÓN
  // ============================================================
  // Por simplicidad: las reglas se guardan en localStorage.
  // El backend ya tiene el endpoint /api/alertas/evaluar-reglas para validar.
  window.abrirAlertasAvanzadas = function() {
    const reglas = JSON.parse(localStorage.getItem('miPortafolio.alertasAvanzadas.v1') || '[]');
    const reglasHTML = reglas.length === 0
      ? `<p style="text-align:center;color:#71717a;font-size:13px;padding:24px;">Aún no tienes reglas custom. Crea una abajo.</p>`
      : reglas.map((r, i) => {
        const condStr = (r.condiciones || []).map(c => `${c.campo} ${c.operador} ${c.valor}`).join(` ${r.operador_logico || 'AND'} `);
        return `<div style="background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="flex:1;min-width:0;"><p style="margin:0;font-size:13px;color:#f4f4f5;font-weight:600;">${r.nombre || `Regla ${i+1}`}</p><p style="margin:2px 0 0;font-size:11px;color:#a1a1aa;font-family:monospace;">${condStr}</p></div>
          <button data-idx="${i}" class="mp-aa-del" style="background:transparent;border:1px solid #2a2a2f;color:#ef4444;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Eliminar</button>
        </div>`;
      }).join('');
    const html = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#22c55e;">Alertas avanzadas</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">Reglas multi-condición</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Crea reglas tipo "avísame si NVDA cae &lt;100 Y el VIX &gt; 25".</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>

        <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Tus reglas (${reglas.length})</h4>
        <div id="mp-aa-lista">${reglasHTML}</div>

        <h4 style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;margin:18px 0 8px;">Nueva regla</h4>
        <div style="background:#161616;border:1px solid #2a2a2f;border-radius:10px;padding:12px;">
          <input id="mp-aa-nombre" type="text" placeholder="Nombre (ej. NVDA crítico)" style="display:block;width:100%;background:#0a0a0b;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-bottom:8px;">
          <select id="mp-aa-logico" style="display:block;width:100%;background:#0a0a0b;border:1px solid #2a2a2f;border-radius:6px;padding:8px;color:#f4f4f5;margin-bottom:8px;">
            <option value="AND">Todas las condiciones (AND)</option>
            <option value="OR">Cualquier condición (OR)</option>
          </select>
          <p style="margin:8px 0 6px;font-size:11px;color:#71717a;">Condiciones:</p>
          <div id="mp-aa-conds"></div>
          <button id="mp-aa-addcond" style="background:transparent;border:1px dashed #2a2a2f;color:#71717a;padding:8px;width:100%;border-radius:6px;cursor:pointer;font-size:12px;margin-bottom:8px;">+ Agregar condición</button>
          <button id="mp-aa-guardar" style="display:block;width:100%;background:#22c55e;color:#0a0a0b;border:none;border-radius:8px;padding:10px;font-weight:700;font-size:13px;cursor:pointer;">Guardar regla</button>
        </div>
        <p style="margin:14px 0 0;font-size:10px;color:#71717a;line-height:1.5;">
          Campos disponibles en el contexto: <code>precio_AAPL</code>, <code>precio_NVDA</code>, <code>cambio_AAPL</code>, <code>peso_AAPL</code>, <code>drift_pp</code>, <code>cetes_28d</code>, <code>vix</code>.
          Operadores: <code>mayor</code>, <code>menor</code>, <code>mayor_igual</code>, <code>menor_igual</code>, <code>igual</code>.
        </p>
      </div>`;
    _abrirModal(html);
    // Renderizar condiciones (al inicio 1 vacía)
    let conds = [{campo:'', operador:'mayor', valor:0}];
    function renderConds() {
      const cont = document.getElementById('mp-aa-conds');
      cont.innerHTML = conds.map((c, i) => `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:4px;margin-bottom:4px;">
          <input data-i="${i}" data-k="campo" type="text" value="${c.campo}" placeholder="precio_NVDA" style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:4px;padding:6px;color:#f4f4f5;font-size:11px;font-family:monospace;">
          <select data-i="${i}" data-k="operador" style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:4px;padding:6px;color:#f4f4f5;font-size:11px;">
            ${['mayor','mayor_igual','menor','menor_igual','igual'].map(o => `<option value="${o}" ${c.operador===o?'selected':''}>${o}</option>`).join('')}
          </select>
          <input data-i="${i}" data-k="valor" type="number" step="any" value="${c.valor}" style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:4px;padding:6px;color:#f4f4f5;font-size:11px;font-family:monospace;">
          <button data-i="${i}" class="mp-aa-rmcond" style="background:transparent;border:1px solid #2a2a2f;color:#ef4444;padding:0 8px;border-radius:4px;cursor:pointer;font-size:14px;">×</button>
        </div>`).join('');
      cont.querySelectorAll('input,select').forEach(el => {
        el.addEventListener('change', (e) => {
          const i = +e.target.dataset.i, k = e.target.dataset.k;
          conds[i][k] = k === 'valor' ? parseFloat(e.target.value) || 0 : e.target.value;
        });
      });
      cont.querySelectorAll('.mp-aa-rmcond').forEach(b => b.addEventListener('click', e => {
        conds.splice(+e.target.dataset.i, 1);
        if (!conds.length) conds = [{campo:'', operador:'mayor', valor:0}];
        renderConds();
      }));
    }
    renderConds();
    document.getElementById('mp-aa-addcond').addEventListener('click', () => {
      conds.push({campo:'', operador:'mayor', valor:0});
      renderConds();
    });
    document.getElementById('mp-aa-guardar').addEventListener('click', () => {
      const nombre = document.getElementById('mp-aa-nombre').value.trim() || `Regla ${reglas.length + 1}`;
      const logico = document.getElementById('mp-aa-logico').value;
      const condsValidas = conds.filter(c => c.campo);
      if (!condsValidas.length) {
        window.toast && window.toast('Agrega al menos una condición con campo', 'error');
        return;
      }
      reglas.push({
        nombre,
        operador_logico: logico,
        condiciones: condsValidas,
        activa: true,
        creada: new Date().toISOString(),
      });
      localStorage.setItem('miPortafolio.alertasAvanzadas.v1', JSON.stringify(reglas));
      window.toast && window.toast(`Regla "${nombre}" guardada`, 'success');
      document.getElementById('mp-herramienta-modal').remove();
      window.abrirAlertasAvanzadas();
    });
    document.querySelectorAll('.mp-aa-del').forEach(b => b.addEventListener('click', e => {
      const i = +e.target.dataset.idx;
      reglas.splice(i, 1);
      localStorage.setItem('miPortafolio.alertasAvanzadas.v1', JSON.stringify(reglas));
      document.getElementById('mp-herramienta-modal').remove();
      window.abrirAlertasAvanzadas();
    }));
  };

  // ============================================================
  //  5) BACKUPS EN LA NUBE
  // ============================================================
  window.abrirBackupsNube = async function() {
    const email = (localStorage.getItem('miPortafolio.userEmail') || prompt('Tu email (para identificar tus backups):') || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      window.toast && window.toast('Email inválido', 'error');
      return;
    }
    localStorage.setItem('miPortafolio.userEmail', email);

    const html = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#0ea5e9;">Backups</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">Backups en la nube</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Guarda snapshots de tu portafolio para restaurar si pierdes el navegador o quieres revertir cambios.</p>
            <p style="margin:6px 0 0;font-size:11px;color:#0ea5e9;font-family:monospace;">📧 ${email}</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <input id="mp-bk-nombre" type="text" placeholder="Nombre del backup (opcional, ej. Antes del rebalanceo)" style="flex:1;background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:10px;font-size:13px;color:#f4f4f5;">
          <button id="mp-bk-crear" style="background:#0ea5e9;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;">+ Crear backup</button>
        </div>
        <div id="mp-bk-lista" style="margin-top:12px;"></div>
      </div>`;
    _abrirModal(html);

    async function recargar() {
      const cont = document.getElementById('mp-bk-lista');
      cont.innerHTML = `<p style="color:#71717a;font-size:12px;text-align:center;padding:14px;">Cargando…</p>`;
      try {
        const res = await fetch(`/api/backups?email=${encodeURIComponent(email)}`);
        const d = await res.json();
        if (!d.ok) { cont.innerHTML = `<p style="color:#ef4444;">${d.error}</p>`; return; }
        if (!d.backups || !d.backups.length) {
          cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:24px;">Aún no tienes backups. Crea uno arriba.</p>`;
          return;
        }
        cont.innerHTML = d.backups.map(b => {
          const fecha = new Date(b.created_at).toLocaleString('es-MX', {dateStyle:'short', timeStyle:'short'});
          const tipo = b.es_automatico ? '🤖 Auto' : '👤 Manual';
          const tamano = b.tamano_bytes ? `${(b.tamano_bytes/1024).toFixed(1)} KB` : '';
          return `<div style="background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div style="flex:1;min-width:0;">
              <p style="margin:0;font-size:13px;color:#f4f4f5;font-weight:600;">${b.nombre || 'Backup sin nombre'}</p>
              <p style="margin:2px 0 0;font-size:11px;color:#71717a;">${tipo} · ${fecha} · ${tamano}</p>
            </div>
            <button data-id="${b.id}" class="mp-bk-restaurar" style="background:#22c55e;color:#0a0a0b;border:none;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">Restaurar</button>
            <button data-id="${b.id}" class="mp-bk-del" style="background:transparent;border:1px solid #2a2a2f;color:#ef4444;padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;">✕</button>
          </div>`;
        }).join('');
        cont.querySelectorAll('.mp-bk-restaurar').forEach(b => b.addEventListener('click', () => restaurar(b.dataset.id)));
        cont.querySelectorAll('.mp-bk-del').forEach(b => b.addEventListener('click', () => eliminar(b.dataset.id)));
      } catch (e) {
        cont.innerHTML = `<p style="color:#ef4444;">Error: ${e.message}</p>`;
      }
    }

    async function crear() {
      const nombre = document.getElementById('mp-bk-nombre').value.trim();
      // Construir snapshot del estado actual completo
      const snapshot = {
        tickers:       JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]'),
        pesos:         JSON.parse(localStorage.getItem('miPortafolio.pesos.v1') || '{}'),
        transacciones: JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]'),
        alertasCfg:    JSON.parse(localStorage.getItem('miPortafolio.alertasCfg.v1') || 'null'),
        portfolios:    JSON.parse(localStorage.getItem('miPortafolio.portfolios.v2') || 'null'),
        alertasAvanzadas: JSON.parse(localStorage.getItem('miPortafolio.alertasAvanzadas.v1') || '[]'),
        fecha:         new Date().toISOString(),
      };
      try {
        const res = await fetch('/api/backups', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({email, snapshot, nombre, automatico: false}),
        });
        const d = await res.json();
        if (d.ok) {
          window.toast && window.toast(`Backup creado (${(d.tamano_bytes/1024).toFixed(1)} KB)`, 'success');
          document.getElementById('mp-bk-nombre').value = '';
          recargar();
        } else {
          window.toast && window.toast(`Error: ${d.error}`, 'error');
        }
      } catch (e) {
        window.toast && window.toast(`Error: ${e.message}`, 'error');
      }
    }

    async function restaurar(id) {
      if (!confirm('Esto sobreescribirá tu portafolio actual. ¿Continuar?')) return;
      try {
        const res = await fetch(`/api/backups/${id}?email=${encodeURIComponent(email)}`);
        const d = await res.json();
        if (!d.ok) { window.toast && window.toast(`Error: ${d.error}`, 'error'); return; }
        const s = d.snapshot || {};
        if (s.tickers)        localStorage.setItem('miPortafolio.tickers.v1', JSON.stringify(s.tickers));
        if (s.pesos)          localStorage.setItem('miPortafolio.pesos.v1', JSON.stringify(s.pesos));
        if (s.transacciones)  localStorage.setItem('miPortafolio.transacciones.v1', JSON.stringify(s.transacciones));
        if (s.alertasCfg)     localStorage.setItem('miPortafolio.alertasCfg.v1', JSON.stringify(s.alertasCfg));
        if (s.portfolios)     localStorage.setItem('miPortafolio.portfolios.v2', JSON.stringify(s.portfolios));
        if (s.alertasAvanzadas) localStorage.setItem('miPortafolio.alertasAvanzadas.v1', JSON.stringify(s.alertasAvanzadas));
        window.toast && window.toast('Backup restaurado. Recargando…', 'success', 3000);
        setTimeout(() => location.reload(), 1500);
      } catch (e) {
        window.toast && window.toast(`Error: ${e.message}`, 'error');
      }
    }

    async function eliminar(id) {
      if (!confirm('¿Eliminar este backup permanentemente?')) return;
      try {
        const res = await fetch(`/api/backups/${id}?email=${encodeURIComponent(email)}`, {method:'DELETE'});
        const d = await res.json();
        if (d.ok) { window.toast && window.toast('Backup eliminado', 'success'); recargar(); }
        else window.toast && window.toast(`Error: ${d.error}`, 'error');
      } catch (e) {
        window.toast && window.toast(`Error: ${e.message}`, 'error');
      }
    }

    document.getElementById('mp-bk-crear').addEventListener('click', crear);
    recargar();
  };

  // ============================================================
  //  6) PUSH NOTIFICATIONS
  // ============================================================
  // Helper: convertir base64url a Uint8Array (requerido por PushManager)
  function _b64ToUint8Array(b64) {
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  window.activarPushNotifications = async function() {
    const email = (localStorage.getItem('miPortafolio.userEmail') || prompt('Tu email (para asociar las notificaciones):') || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      window.toast && window.toast('Email inválido', 'error');
      return;
    }
    localStorage.setItem('miPortafolio.userEmail', email);

    // Verificar soporte
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      window.toast && window.toast('Tu navegador no soporta push. iOS 16.4+ requerido.', 'error', 6000);
      return;
    }

    try {
      // 1) Pedir VAPID public key del backend
      const resKey = await fetch('/api/push/public-key');
      const dKey = await resKey.json();
      if (!dKey.disponible || !dKey.public_key) {
        window.toast && window.toast('Push no configurado en el servidor. Pide a soporte.', 'error', 5000);
        return;
      }

      // 2) Pedir permiso al usuario
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        window.toast && window.toast('Permiso denegado. Las notificaciones quedaron desactivadas.', 'warn', 5000);
        return;
      }

      // 3) Suscribir
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _b64ToUint8Array(dKey.public_key),
      });

      // 4) Enviar al backend
      const resSub = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({email, subscription: subscription.toJSON()}),
      });
      const dSub = await resSub.json();
      if (!dSub.ok) {
        window.toast && window.toast(`Error: ${dSub.error}`, 'error');
        return;
      }
      localStorage.setItem('miPortafolio.pushActivo', '1');
      window.toast && window.toast('✅ Notificaciones activadas. Te llegará una de prueba en 5 seg.', 'success', 5000);

      // 5) Mandar push de prueba
      setTimeout(async () => {
        try {
          await fetch('/api/push/test', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({email, titulo: '🚀 Mi Portafolio', body: 'Push notifications funcionando correctamente.'}),
          });
        } catch {}
      }, 5000);
    } catch (e) {
      window.toast && window.toast(`Error: ${e.message}`, 'error', 6000);
    }
  };

  window.desactivarPushNotifications = async function() {
    const email = (localStorage.getItem('miPortafolio.userEmail') || '').trim().toLowerCase();
    if (!email) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({email, endpoint: sub.endpoint}),
        });
        await sub.unsubscribe();
      }
      localStorage.removeItem('miPortafolio.pushActivo');
      window.toast && window.toast('Notificaciones desactivadas', 'success');
    } catch (e) {
      window.toast && window.toast(`Error: ${e.message}`, 'error');
    }
  };

  // Modal-toggle de Push
  window.abrirConfigPush = function() {
    const activo = localStorage.getItem('miPortafolio.pushActivo') === '1';
    const email = localStorage.getItem('miPortafolio.userEmail') || '';
    const html = `
      <div style="padding:24px;">
        <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#22c55e;">Notificaciones</p>
            <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;">Push notifications</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Recibe alertas instantáneas en tu teléfono/desktop (sin email) cuando se disparen tus reglas.</p>
          </div>
          <button onclick="document.getElementById('mp-herramienta-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;padding:4px 8px;">×</button>
        </div>
        <div style="background:#161616;border:1px solid #2a2a2f;border-radius:10px;padding:16px;margin-bottom:14px;">
          <p style="margin:0;font-size:13px;color:${activo ? '#22c55e' : '#a1a1aa'};font-weight:600;">${activo ? '✅ Notificaciones activas' : '⚪ Notificaciones desactivadas'}</p>
          ${email ? `<p style="margin:6px 0 0;font-size:11px;color:#71717a;font-family:monospace;">Asociadas a: ${email}</p>` : ''}
        </div>
        <p style="margin:0 0 14px;font-size:12px;color:#a1a1aa;line-height:1.55;">
          <strong style="color:#fff;">Requisitos:</strong><br>
          · iOS: Safari 16.4+ y la app instalada como PWA ("Agregar a pantalla de inicio")<br>
          · Android: Chrome o Firefox<br>
          · Desktop: cualquier navegador moderno
        </p>
        ${activo
          ? `<button id="mp-push-toggle" style="display:block;width:100%;background:#ef4444;color:#fff;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:14px;cursor:pointer;">Desactivar notificaciones</button>`
          : `<button id="mp-push-toggle" style="display:block;width:100%;background:#22c55e;color:#0a0a0b;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:14px;cursor:pointer;">Activar notificaciones →</button>`
        }
      </div>`;
    _abrirModal(html);
    document.getElementById('mp-push-toggle').addEventListener('click', () => {
      document.getElementById('mp-herramienta-modal').remove();
      if (activo) window.desactivarPushNotifications();
      else window.activarPushNotifications();
    });
  };

  // ============================================================
  //  VERSIONES INLINE (renderean en un container existente,
  //  sin abrir modal). Usan las mismas funciones de render.
  // ============================================================

  // Deep Dive inline en la vista Analizar
  window.iniciarDeepDiveInline = function() {
    const inp = document.getElementById('dd-input');
    const btn = document.getElementById('dd-btn');
    const cont = document.getElementById('dd-resultado');
    if (!inp || !btn || !cont || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    const ejecutar = async () => {
      const t = inp.value.trim().toUpperCase();
      if (!t) return;
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:24px;background:#161616;border:1px solid #2a2a2f;border-radius:12px;">Analizando ${t}… (15-30 seg)</p>`;
      try {
        const res = await fetch(`/api/deep-dive/${encodeURIComponent(t)}`);
        const d = await res.json();
        if (!d.ok) {
          cont.innerHTML = `<p style="color:#ef4444;font-size:13px;padding:14px;">${d.error || 'Error'}</p>`;
          return;
        }
        // Usa la misma función _renderDeepDive del modal pero envuelta en card
        cont.innerHTML = `<div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;padding:20px;">${_renderDeepDive(d)}</div>`;
      } catch (e) {
        cont.innerHTML = `<p style="color:#ef4444;font-size:13px;padding:14px;">Error: ${e.message}</p>`;
      }
    };
    btn.addEventListener('click', ejecutar);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ejecutar(); } });
  };

  // Screener inline en la vista Analizar
  window.iniciarScreenerInline = function() {
    const btn = document.getElementById('sc-buscar');
    const cont = document.getElementById('sc-resultado');
    if (!btn || !cont || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:20px;">Filtrando…</p>`;
      const get = id => document.getElementById(id).value.trim();
      const num = id => { const v = parseFloat(get(id)); return isFinite(v) ? v : null; };
      const criterios = {
        tipo:              get('sc-tipo') || undefined,
        mercado:           get('sc-mercado') || undefined,
        sector:            get('sc-sector') || undefined,
        market_cap_min:    num('sc-mc'),
        pe_max:            num('sc-pemax'),
        yield_min:         num('sc-ymin') ? num('sc-ymin') / 100 : undefined,
        beta_max:          num('sc-bmax'),
        solo_recomendadas: document.getElementById('sc-reco').checked,
        limit:             50,
      };
      Object.keys(criterios).forEach(k => criterios[k] == null && delete criterios[k]);
      try {
        const res = await fetch('/api/screener', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(criterios),
        });
        const d = await res.json();
        if (!d.ok) { cont.innerHTML = `<p style="color:#ef4444;">${d.error || 'Error'}</p>`; return; }
        cont.innerHTML = _renderScreener(d);
      } catch (e) { cont.innerHTML = `<p style="color:#ef4444;">Error: ${e.message}</p>`; }
    });
  };

  // Optimizador fiscal inline en la vista Transacciones
  window.iniciarOptimizadorInline = function() {
    const btn = document.getElementById('of-inline-btn');
    const cont = document.getElementById('of-inline-resultado');
    if (!btn || !cont || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      cont.innerHTML = `<p style="text-align:center;color:#71717a;font-size:13px;padding:14px;">Calculando…</p>`;
      try {
        const txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]');
        if (!txs.length) {
          cont.innerHTML = `<p style="color:#fb923c;font-size:13px;padding:14px;background:rgba(251,146,60,0.08);border-radius:8px;">Primero registra tus transacciones arriba.</p>`;
          return;
        }
        const precios = {};
        try {
          const respUniv = await fetch('/api/universo');
          const univData = await respUniv.json();
          (univData.tickers || []).forEach(t => {
            if (t.ticker && t.precio) precios[t.ticker] = t.precio;
          });
        } catch {}
        const body = {
          transacciones:       txs,
          precios_actuales:    precios,
          monto_a_vender_mxn:  parseFloat(document.getElementById('of-monto').value) || 50000,
          ano_fiscal:          parseInt(document.getElementById('of-ano').value) || new Date().getFullYear(),
          perdidas_anteriores: parseFloat(document.getElementById('of-perdidas').value) || 0,
        };
        const res = await fetch('/api/optimizador-fiscal', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (!d.ok) { cont.innerHTML = `<p style="color:#ef4444;">${d.error}</p>`; return; }
        cont.innerHTML = _renderOptimizador(d);
      } catch (e) { cont.innerHTML = `<p style="color:#ef4444;">Error: ${e.message}</p>`; }
    });
  };

  // Backups inline en la vista de alertas
  window.iniciarBackupsInline = function() {
    const cont = document.getElementById('bk-inline-cont');
    const btnCrear = document.getElementById('bk-inline-crear');
    if (!cont || !btnCrear || btnCrear.dataset.wired === '1') return;
    btnCrear.dataset.wired = '1';

    async function recargar() {
      const email = (localStorage.getItem('miPortafolio.userEmail') || '').trim().toLowerCase();
      if (!email) {
        cont.innerHTML = `<p class="text-xs text-zinc-500 py-3">Configura tu email en alertas arriba primero.</p>`;
        return;
      }
      cont.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">Cargando…</p>`;
      try {
        const res = await fetch(`/api/backups?email=${encodeURIComponent(email)}`);
        const d = await res.json();
        if (!d.ok) { cont.innerHTML = `<p class="text-xs text-accent-red">${d.error}</p>`; return; }
        if (!d.backups || !d.backups.length) {
          cont.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">Sin backups aún. Crea uno arriba.</p>`;
          return;
        }
        cont.innerHTML = d.backups.map(b => {
          const fecha = new Date(b.created_at).toLocaleString('es-MX', {dateStyle:'short', timeStyle:'short'});
          const tipo = b.es_automatico ? 'Auto' : 'Manual';
          const tamano = b.tamano_bytes ? `${(b.tamano_bytes/1024).toFixed(1)} KB` : '';
          return `<div class="flex items-center justify-between gap-2 p-2.5 bg-zinc-900/40 border border-surface-border rounded-lg mb-1.5">
            <div class="flex-1 min-w-0">
              <p class="text-xs font-semibold text-zinc-100 truncate">${b.nombre || 'Sin nombre'}</p>
              <p class="text-[10px] text-zinc-500">${tipo} · ${fecha} · ${tamano}</p>
            </div>
            <button data-id="${b.id}" class="bk-rest text-[10px] px-2 py-1 bg-accent-green text-zinc-950 rounded font-semibold">Restaurar</button>
            <button data-id="${b.id}" class="bk-del text-[10px] px-2 py-1 border border-surface-border text-accent-red rounded">✕</button>
          </div>`;
        }).join('');
        cont.querySelectorAll('.bk-rest').forEach(b => b.addEventListener('click', () => restaurar(b.dataset.id, email)));
        cont.querySelectorAll('.bk-del').forEach(b => b.addEventListener('click', () => eliminar(b.dataset.id, email)));
      } catch (e) { cont.innerHTML = `<p class="text-xs text-accent-red">Error: ${e.message}</p>`; }
    }
    async function crear() {
      const email = (localStorage.getItem('miPortafolio.userEmail') || prompt('Tu email:') || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return;
      localStorage.setItem('miPortafolio.userEmail', email);
      const nombre = (document.getElementById('bk-inline-nombre').value || '').trim();
      const snapshot = {
        tickers:       JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]'),
        pesos:         JSON.parse(localStorage.getItem('miPortafolio.pesos.v1') || '{}'),
        transacciones: JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]'),
        alertasCfg:    JSON.parse(localStorage.getItem('miPortafolio.alertasCfg.v1') || 'null'),
        portfolios:    JSON.parse(localStorage.getItem('miPortafolio.portfolios.v2') || 'null'),
        alertasAvanzadas: JSON.parse(localStorage.getItem('miPortafolio.alertasAvanzadas.v1') || '[]'),
        fecha:         new Date().toISOString(),
      };
      try {
        const res = await fetch('/api/backups', {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({email, snapshot, nombre, automatico:false})});
        const d = await res.json();
        if (d.ok) {
          window.toast && window.toast(`Backup creado`, 'success');
          document.getElementById('bk-inline-nombre').value = '';
          recargar();
        }
      } catch (e) { window.toast && window.toast(`Error: ${e.message}`, 'error'); }
    }
    async function restaurar(id, email) {
      if (!confirm('Esto sobreescribirá tu portafolio actual. ¿Continuar?')) return;
      try {
        const res = await fetch(`/api/backups/${id}?email=${encodeURIComponent(email)}`);
        const d = await res.json();
        if (!d.ok) return;
        const s = d.snapshot || {};
        if (s.tickers)        localStorage.setItem('miPortafolio.tickers.v1', JSON.stringify(s.tickers));
        if (s.pesos)          localStorage.setItem('miPortafolio.pesos.v1', JSON.stringify(s.pesos));
        if (s.transacciones)  localStorage.setItem('miPortafolio.transacciones.v1', JSON.stringify(s.transacciones));
        if (s.alertasCfg)     localStorage.setItem('miPortafolio.alertasCfg.v1', JSON.stringify(s.alertasCfg));
        if (s.portfolios)     localStorage.setItem('miPortafolio.portfolios.v2', JSON.stringify(s.portfolios));
        if (s.alertasAvanzadas) localStorage.setItem('miPortafolio.alertasAvanzadas.v1', JSON.stringify(s.alertasAvanzadas));
        window.toast && window.toast('Backup restaurado. Recargando…', 'success', 3000);
        setTimeout(() => location.reload(), 1500);
      } catch (e) { window.toast && window.toast(`Error: ${e.message}`, 'error'); }
    }
    async function eliminar(id, email) {
      if (!confirm('¿Eliminar este backup?')) return;
      try {
        const res = await fetch(`/api/backups/${id}?email=${encodeURIComponent(email)}`, {method:'DELETE'});
        if ((await res.json()).ok) recargar();
      } catch (e) {}
    }
    btnCrear.addEventListener('click', crear);
    recargar();
  };

  // Alertas avanzadas inline en la vista de alertas
  window.iniciarAlertasAvanzadasInline = function() {
    const cont = document.getElementById('aa-inline-cont');
    const btnCrear = document.getElementById('aa-inline-crear');
    if (!cont || !btnCrear || btnCrear.dataset.wired === '1') return;
    btnCrear.dataset.wired = '1';

    function render() {
      const reglas = JSON.parse(localStorage.getItem('miPortafolio.alertasAvanzadas.v1') || '[]');
      if (!reglas.length) {
        cont.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">Sin reglas custom. Crea una arriba.</p>`;
        return;
      }
      cont.innerHTML = reglas.map((r, i) => {
        const condStr = (r.condiciones || []).map(c => `${c.campo} ${c.operador} ${c.valor}`).join(` ${r.operador_logico || 'AND'} `);
        return `<div class="flex items-center justify-between gap-2 p-2.5 bg-zinc-900/40 border border-surface-border rounded-lg mb-1.5">
          <div class="flex-1 min-w-0">
            <p class="text-xs font-semibold text-zinc-100 truncate">${r.nombre || `Regla ${i+1}`}</p>
            <p class="text-[10px] text-zinc-500 font-mono truncate">${condStr}</p>
          </div>
          <button data-idx="${i}" class="aa-del text-[10px] px-2 py-1 border border-surface-border text-accent-red rounded">✕</button>
        </div>`;
      }).join('');
      cont.querySelectorAll('.aa-del').forEach(b => b.addEventListener('click', e => {
        const i = +e.target.dataset.idx;
        const r2 = JSON.parse(localStorage.getItem('miPortafolio.alertasAvanzadas.v1') || '[]');
        r2.splice(i, 1);
        localStorage.setItem('miPortafolio.alertasAvanzadas.v1', JSON.stringify(r2));
        render();
      }));
    }

    btnCrear.addEventListener('click', () => {
      window.abrirAlertasAvanzadas();
      // Después de que cierre el modal, refrescar la lista
      const checkInterval = setInterval(() => {
        if (!document.getElementById('mp-herramienta-modal')) {
          clearInterval(checkInterval);
          render();
        }
      }, 500);
    });
    render();
  };

  // Lógica de sub-tabs en vista Analizar
  window.bindSubAnalizar = function() {
    const tabs = document.querySelectorAll('.sub-analizar-btn');
    const secAccion = document.getElementById('sub-una-accion');
    const secDeep = document.getElementById('sub-deep-dive');
    const secScreen = document.getElementById('sub-screener');
    if (!tabs.length) return;
    function activar(sub) {
      tabs.forEach(b => {
        const activo = b.dataset.subAnalizar === sub;
        b.classList.toggle('text-zinc-100', activo);
        b.classList.toggle('bg-accent-orange/15', activo);
        b.classList.toggle('ring-1', activo);
        b.classList.toggle('ring-accent-orange/40', activo);
        b.classList.toggle('text-zinc-500', !activo);
      });
      if (secAccion) secAccion.classList.toggle('hidden', sub !== 'una-accion');
      if (secDeep)   secDeep.classList.toggle('hidden', sub !== 'deep-dive');
      if (secScreen) secScreen.classList.toggle('hidden', sub !== 'screener');
      if (sub === 'deep-dive') window.iniciarDeepDiveInline();
      if (sub === 'screener')  window.iniciarScreenerInline();
    }
    tabs.forEach(b => b.addEventListener('click', () => activar(b.dataset.subAnalizar)));
  };

  // Auto-bind al cargar
  window.addEventListener('load', () => {
    if (typeof window.bindSubAnalizar === 'function') window.bindSubAnalizar();
    // Observer para detectar cuando se muestran las vistas
    const observer = new MutationObserver(() => {
      const transacciones = document.getElementById('vista-transacciones');
      const portafolio = document.getElementById('vista-portafolio');
      if (transacciones && !transacciones.classList.contains('hidden')) {
        window.iniciarOptimizadorInline && window.iniciarOptimizadorInline();
      }
      if (portafolio && !portafolio.classList.contains('hidden')) {
        window.iniciarBackupsInline && window.iniciarBackupsInline();
        window.iniciarAlertasAvanzadasInline && window.iniciarAlertasAvanzadasInline();
      }
    });
    ['vista-transacciones', 'vista-portafolio'].forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  });

})();
