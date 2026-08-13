// ============================================================
//  extras.js — features extras de Mi Portafolio
//  #13 Import CSV de transacciones
//  #15 Modo "qué pasaría si" (sandbox)
// ============================================================
(function() {
  'use strict';

  // ============================================================
  // 15. MODO "QUÉ PASARÍA SI" (sandbox)
  // ============================================================
  // Duplica el portafolio activo a uno nuevo con prefijo "Sandbox:"
  // El usuario puede experimentar (agregar/quitar tickers, cambiar pesos)
  // sin afectar su portafolio real.
  window.crearSandbox = function() {
    if (typeof PortfolioManager === 'undefined') {
      window.toast && window.toast('Sistema de multi-portafolio no disponible.', 'error');
      return;
    }
    try {
      const actual = PortfolioManager.activoData();
      const tickers = JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]');
      const pesos = JSON.parse(localStorage.getItem('miPortafolio.pesos.v1') || '{}');
      const txs = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]');
      const nombre = `Sandbox: ${actual.nombre || 'Mi portafolio'}`.slice(0, 30);

      // PortfolioManager.crear() crea uno vacío; lo extiendo manualmente
      const META_KEY = 'miPortafolio.portfolios.v2';
      const m = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      // Respaldar el actual
      localStorage.setItem(`miPortafolio.${m.activo}.tickers.v1`,       JSON.stringify(tickers));
      localStorage.setItem(`miPortafolio.${m.activo}.pesos.v1`,         JSON.stringify(pesos));
      localStorage.setItem(`miPortafolio.${m.activo}.transacciones.v1`, JSON.stringify(txs));
      // Crear el nuevo con los mismos datos
      const newId = 'sandbox_' + Date.now().toString(36);
      m.portfolios[newId] = { nombre, color: 'amber', creado: new Date().toISOString(), sandbox: true };
      m.activo = newId;
      localStorage.setItem(META_KEY, JSON.stringify(m));
      // Aplicar al snapshot activo
      localStorage.setItem('miPortafolio.tickers.v1',       JSON.stringify(tickers));
      localStorage.setItem('miPortafolio.pesos.v1',         JSON.stringify(pesos));
      localStorage.setItem('miPortafolio.transacciones.v1', JSON.stringify(txs));
      window.toast && window.toast(`Sandbox creado: ${nombre}. Experimenta sin afectar tu portafolio original.`, 'success', 5000);
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      window.toast && window.toast('Error al crear sandbox: ' + err.message, 'error');
    }
  };

  // ============================================================
  // 13. IMPORT CSV DE TRANSACCIONES
  // ============================================================
  // Acepta CSV genérico con columnas: ticker, fecha (YYYY-MM-DD),
  // shares, precio, [moneda=USD], [tipo=compra], [comision=0], [notas]
  // El parser es flexible — reconoce variantes de nombre de columna.
  const _COLUMN_ALIASES = {
    ticker:   ['ticker', 'symbol', 'simbolo', 'instrumento', 'emisora', 'clave', 'security', 'activo'],
    fecha:    ['fecha', 'date', 'fec', 'fecha_op', 'fechaoperacion', 'trade_date', 'settledate', 'settlementdate'],
    shares:   ['shares', 'titulos', 'titulos_titulares', 'cantidad', 'qty', 'quantity', 'volumen', 'acciones', 'units'],
    precio:   ['precio', 'price', 'precio_unitario', 'precio_compra', 'precio_op', 'unit_price', 'execprice'],
    moneda:   ['moneda', 'currency', 'divisa', 'cur', 'curr'],
    tipo:     ['tipo', 'type', 'operacion', 'movimiento', 'side', 'action', 'transaction_type', 'tipo_op'],
    comision: ['comision', 'comisión', 'fee', 'fees', 'commission', 'comisiones'],
    notas:    ['notas', 'notes', 'descripcion', 'detalle', 'description', 'comment'],
  };

  // Presets de detección automática por broker
  const _BROKER_PRESETS = {
    'GBM Plus': {
      detect: (h) => h.some(x => /tipo.*op|fecha.*op|emisora/i.test(x)),
      hints: 'GBM Plus exporta CSV con columnas: Emisora, Fecha Op., Tipo Op., Cantidad, Precio Op.',
    },
    'Kuspit': {
      detect: (h) => h.some(x => /clave_pizarra|fecha_liquidacion/i.test(x)),
      hints: 'Kuspit usa: Clave Pizarra, Tipo Movimiento, Fecha Liquidación, Cantidad, Precio',
    },
    'Bursanet (Banorte)': {
      detect: (h) => h.some(x => /num_contrato|emisora.*clave/i.test(x)),
      hints: 'Bursanet exporta con: Emisora, Movimiento, Fecha, Títulos, Precio Promedio',
    },
    'Hapi': {
      detect: (h) => h.some(x => /asset_id|trade_type.*hapi/i.test(x)),
      hints: 'Hapi: Asset, Trade Type, Trade Date, Quantity, Price',
    },
    'Schwab (US)': {
      detect: (h) => h.some(x => /symbol/i.test(x)) && h.some(x => /action/i.test(x)),
      hints: 'Schwab USA: Date, Action, Symbol, Description, Quantity, Price, Fees & Comm',
    },
    'Interactive Brokers': {
      detect: (h) => h.some(x => /^ibkr|tradedate.*ibkr/i.test(x)) || h.some(x => /conid/i.test(x)),
      hints: 'IBKR Flex Query: Symbol, DateTime, Quantity, TradePrice, IBCommission',
    },
    'Genérico': {
      detect: () => true,  // siempre matchea como fallback
      hints: 'Columnas mínimas: ticker, fecha (YYYY-MM-DD), shares, precio',
    },
  };

  function _detectarBroker(headers) {
    for (const [nombre, preset] of Object.entries(_BROKER_PRESETS)) {
      if (nombre === 'Genérico') continue;
      try {
        if (preset.detect(headers)) return nombre;
      } catch {}
    }
    return 'Genérico';
  }
  function _matchColumn(header, alias) {
    const h = (header || '').toLowerCase().trim().replace(/\s+/g, '').replace(/[^a-z]/g, '');
    return alias.some(a => h === a.replace(/[^a-z]/g, ''));
  }
  function _detectColumns(headers) {
    const map = {};
    headers.forEach((h, i) => {
      Object.entries(_COLUMN_ALIASES).forEach(([col, alias]) => {
        if (!map[col] && _matchColumn(h, alias)) map[col] = i;
      });
    });
    return map;
  }
  function _normalizarTipo(v) {
    const t = (v || '').toString().toLowerCase().trim();
    if (t.startsWith('c') || t === 'buy' || t === 'compra') return 'compra';
    if (t.startsWith('v') || t === 'sell' || t === 'venta')  return 'venta';
    if (t.startsWith('d')) return 'dividendo';
    return 'compra'; // default
  }
  function _parseCSV(text) {
    // Parser CSV simple — maneja comas dentro de comillas
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV vacío o sin filas de datos.');
    const parseLine = (line) => {
      const fields = []; let cur = ''; let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQuote = !inQuote; continue; }
        if (c === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
        cur += c;
      }
      fields.push(cur);
      return fields;
    };
    const headers = parseLine(lines[0]);
    const map = _detectColumns(headers);
    const brokerDetectado = _detectarBroker(headers);
    const requiredCols = ['ticker', 'fecha', 'shares', 'precio'];
    const faltantes = requiredCols.filter(c => map[c] === undefined);
    if (faltantes.length) {
      throw new Error(`Faltan columnas: ${faltantes.join(', ')}.\n\nBroker detectado: ${brokerDetectado}\nHeaders: ${headers.join(' | ')}\n\nFormato esperado: ${_BROKER_PRESETS[brokerDetectado].hints}`);
    }
    const txs = [];
    // Anotar el broker detectado en la primera tx
    let brokerLogged = false;
    for (let i = 1; i < lines.length; i++) {
      const f = parseLine(lines[i]);
      const ticker = (f[map.ticker] || '').trim().toUpperCase();
      const fecha  = (f[map.fecha]  || '').trim();
      const shares = parseFloat((f[map.shares] || '').replace(/[^\d.\-]/g, ''));
      const precio = parseFloat((f[map.precio] || '').replace(/[^\d.\-]/g, ''));
      if (!ticker || !fecha || !isFinite(shares) || !isFinite(precio)) continue;
      const notasOriginal = map.notas !== undefined ? (f[map.notas] || '').trim() : '';
      // Anotar el broker detectado en cada tx para reporting futuro
      const notas = brokerLogged ? notasOriginal : (notasOriginal ? `[${brokerDetectado}] ${notasOriginal}` : `Importado de ${brokerDetectado}`);
      brokerLogged = true;
      txs.push({
        ticker, fecha, shares, precio,
        tipo:     map.tipo !== undefined ? _normalizarTipo(f[map.tipo]) : 'compra',
        moneda:   map.moneda !== undefined ? (f[map.moneda] || 'USD').trim().toUpperCase() : 'USD',
        comision: map.comision !== undefined ? parseFloat((f[map.comision] || '0').replace(/[^\d.\-]/g, '')) || 0 : 0,
        notas,
        broker:   brokerDetectado,
      });
    }
    txs._brokerDetectado = brokerDetectado;
    return txs;
  }
  window.importarCSVTransacciones = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = ev.target.result;
          const txs = _parseCSV(text);
          if (!txs.length) {
            window.toast && window.toast('No se pudieron leer transacciones del CSV.', 'error');
            return;
          }
          // Merge con las existentes
          const existentes = JSON.parse(localStorage.getItem('miPortafolio.transacciones.v1') || '[]');
          const merged = [...existentes, ...txs];
          localStorage.setItem('miPortafolio.transacciones.v1', JSON.stringify(merged));
          const brokerInfo = txs._brokerDetectado && txs._brokerDetectado !== 'Genérico'
            ? ` (broker detectado: ${txs._brokerDetectado})` : '';
          window.toast && window.toast(`Importadas ${txs.length} transacciones${brokerInfo}. Refrescando...`, 'success', 5000);
          setTimeout(() => location.reload(), 1500);
        } catch (err) {
          alert('Error procesando CSV:\n\n' + err.message + '\n\nFormato esperado: ticker, fecha (YYYY-MM-DD), shares, precio, [tipo=compra], [moneda=USD]');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // Helper: abrir un modal con instrucciones del CSV antes de importar
  window.abrirImportadorCSV = function() {
    if (document.getElementById('mp-import-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="mp-import-modal" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);max-width:520px;width:100%;padding:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <h2 style="margin:0;font-size:18px;font-weight:600;color:var(--tinta-1);">Importar transacciones desde CSV</h2>
            <button onclick="document.getElementById('mp-import-modal').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;">×</button>
          </div>
          <p style="font-size:13px;color:var(--tinta-3);line-height:1.6;margin:0 0 16px;">
            Exporta tus operaciones desde tu broker (GBM, Kuspit, Bursanet, Hapi, Schwab, IBKR, etc.) como CSV y súbelo aquí. El parser <strong style="color:var(--sello);">detecta automáticamente el broker</strong> y mapea las columnas.
          </p>
          <div style="background:rgba(156,93,18,0.06);border:1px solid rgba(156,93,18,0.25);border-radius:var(--radio-tarjeta);padding:10px 12px;margin-bottom:12px;">
            <p style="font-size:11px;color:var(--sello);margin:0;font-weight:600;">✓ Brokers reconocidos automáticamente:</p>
            <p style="font-size:11px;color:var(--tinta-3);margin:4px 0 0;line-height:1.5;">GBM Plus · Kuspit · Bursanet (Banorte) · Hapi · Schwab · Interactive Brokers · y cualquier CSV genérico con columnas estándar.</p>
          </div>
          <div style="background:var(--sup-panel);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);padding:12px;margin-bottom:16px;">
            <p style="font-size:11px;color:var(--tinta-4);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin:0 0 8px;">Columnas requeridas</p>
            <p style="font-family:monospace;font-size:12px;color:var(--sello);margin:0;line-height:1.7;">
              ticker, fecha, shares, precio
            </p>
            <p style="font-size:11px;color:var(--tinta-4);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin:12px 0 8px;">Columnas opcionales</p>
            <p style="font-family:monospace;font-size:12px;color:var(--tinta-3);margin:0;line-height:1.7;">
              tipo (compra/venta/dividendo), moneda, comision, notas
            </p>
          </div>
          <p style="font-size:11px;color:var(--tinta-4);margin:0 0 16px;line-height:1.5;">
            Acepta variantes de nombres: <code>symbol</code> = <code>ticker</code>, <code>quantity</code> = <code>shares</code>, etc.
          </p>
          <button onclick="document.getElementById('mp-import-modal').remove(); window.importarCSVTransacciones()" style="display:block;width:100%;background:var(--sello);color:var(--sup);border:none;padding:10px;border-radius:var(--radio);font-weight:600;font-size:13px;cursor:pointer;">
            Seleccionar archivo CSV →
          </button>
        </div>
      </div>`);
    document.getElementById('mp-import-modal').addEventListener('click', (e) => {
      if (e.target.id === 'mp-import-modal') e.target.remove();
    });
  };

  // ============================================================
  // BROKER PICKER — "Cómo comprar [TICKER]"
  // ============================================================
  // Mi Portafolio NO ejecuta trades (no es casa de bolsa CNBV).
  // Este modal muestra brokers MX/US compatibles con el ticker,
  // sus comisiones y un botón "Abrir broker" con la URL.
  // Wire-up del card "Comprar acciones" en vista Transacciones
  function _wireUpCompraSection() {
    const inp = document.getElementById('comprar-ticker-input');
    const inpMonto = document.getElementById('comprar-monto-input');
    const btn = document.getElementById('comprar-ticker-btn');
    if (!inp || !btn) return;
    if (btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';

    const ejecutar = () => {
      const ticker = (inp.value || '').trim().toUpperCase();
      const monto = parseFloat(inpMonto.value) || 10000;
      if (!ticker) {
        inp.focus();
        return;
      }
      window.abrirModalCompra(ticker, monto);
    };
    btn.addEventListener('click', ejecutar);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ejecutar(); }
    });
    inpMonto.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ejecutar(); }
    });

    // Renderizar shortcuts con los tickers actuales del portafolio
    try {
      const tickers = JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]');
      const wrap = document.getElementById('comprar-shortcuts-wrap');
      const cont = document.getElementById('comprar-shortcuts');
      if (Array.isArray(tickers) && tickers.length && wrap && cont) {
        wrap.classList.remove('hidden');
        cont.innerHTML = tickers.slice(0, 15).map(t => `
          <button data-tk="${t}" class="comprar-chip px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 hover:border-accent-green hover:text-accent-green transition tabular">
            ${t} →
          </button>`).join('');
        cont.querySelectorAll('.comprar-chip').forEach(b => {
          b.addEventListener('click', () => {
            const monto = parseFloat(inpMonto.value) || 10000;
            window.abrirModalCompra(b.dataset.tk, monto);
          });
        });
      }
    } catch (_) {}
  }
  // Observer para inicializar cuando la vista de Transacciones se muestre
  const _compraObserver = new MutationObserver(() => {
    const v = document.getElementById('vista-transacciones');
    if (v && !v.classList.contains('hidden')) _wireUpCompraSection();
  });
  window.addEventListener('load', () => {
    const v = document.getElementById('vista-transacciones');
    if (v) {
      _compraObserver.observe(v, { attributes: true, attributeFilter: ['class'] });
      if (!v.classList.contains('hidden')) _wireUpCompraSection();
    }
  });

  window.abrirModalCompra = async function(ticker, monto = 10000) {
    if (!ticker) return;
    if (document.getElementById('mp-compra-modal')) return;

    // Loading placeholder
    document.body.insertAdjacentHTML('beforeend', `
      <div id="mp-compra-modal" style="position:fixed;inset:0;background:rgba(26,26,24,.40);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px);">
        <div style="background:var(--sup);border:1px solid var(--regla);border-radius:var(--radio-tarjeta);max-width:540px;width:100%;max-height:90vh;overflow-y:auto;">
          <div id="mp-compra-content" style="padding:24px;">
            <p style="color:var(--tinta-4);font-size:13px;text-align:center;">Buscando brokers compatibles con ${ticker}…</p>
          </div>
        </div>
      </div>`);
    document.getElementById('mp-compra-modal').addEventListener('click', (e) => {
      if (e.target.id === 'mp-compra-modal') e.target.remove();
    });

    let brokers = [];
    try {
      const res = await fetch(`/api/brokers-mx/comparar/${encodeURIComponent(ticker)}?monto=${monto}`);
      const body = await res.json();
      // El backend devuelve {ticker, monto_mxn, comparativa: [...]}
      brokers = Array.isArray(body) ? body : (body.comparativa || body.brokers || []);
    } catch (e) {
      const cont = document.getElementById('mp-compra-content');
      if (cont) cont.innerHTML = `<p style="color:var(--baja);font-size:13px;">Error: ${e.message}</p>`;
      return;
    }

    if (!brokers.length) {
      const cont = document.getElementById('mp-compra-content');
      if (cont) cont.innerHTML = `
        <p style="color:var(--tinta-3);font-size:13px;text-align:center;">
          No tenemos brokers MX con datos para <strong style="color:var(--tinta-1);">${ticker}</strong>.
          Verifica el ticker o búscalo manualmente en tu broker.
        </p>
        <button onclick="document.getElementById('mp-compra-modal').remove()" style="margin-top:16px;display:block;width:100%;background:var(--sello);color:var(--sup);border:none;padding:10px;border-radius:var(--radio);font-weight:600;cursor:pointer;">Cerrar</button>`;
      return;
    }

    // Render lista
    const items = brokers.map((b, i) => {
      const esTop = i === 0;
      const minAp = b.minimo_apertura_mxn || 0;
      const minApStr = minAp >= 1000000 ? `$${(minAp/1000000).toFixed(1)}M MXN` :
                       minAp >= 1000    ? `$${(minAp/1000).toFixed(0)}k MXN` :
                       minAp > 0        ? `$${minAp} MXN` : 'Sin mínimo';
      return `
        <div style="display:flex;gap:12px;align-items:center;padding:14px;background:${esTop ? 'rgba(156,93,18,0.06)' : MP_COLOR.supPanel};border:1px solid ${esTop ? 'rgba(156,93,18,0.3)' : MP_COLOR.regla};border-radius:var(--radio-tarjeta);margin-bottom:8px;">
          <span style="font-size:22px;flex-shrink:0;">${b.emoji || '<span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M3 9.5 12 4l9 5.5"/><path d="M5 9.5V19M9.5 9.5V19M14.5 9.5V19M19 9.5V19"/><path d="M2.5 19h19"/></svg></span>'}</span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <p style="margin:0;font-weight:600;color:var(--tinta-1);font-size:14px;">${b.broker}</p>
              ${esTop ? '<span style="font-size:9px;background:var(--sello);color:var(--sup);padding:2px 6px;border-radius:999px;font-weight:700;text-transform:uppercase;">Más barato</span>' : ''}
            </div>
            <p style="margin:3px 0 0;font-size:11px;color:var(--tinta-3);">
              Comisión: <strong style="color:var(--tinta-1);">$${b.comision_estimada_mxn.toFixed(2)}</strong>
              ${b.nota ? `<span style="color:var(--tinta-4);"> · ${b.nota}</span>` : ''}
            </p>
            <p style="margin:2px 0 0;font-size:10px;color:var(--tinta-4);">Mínimo apertura: ${minApStr}</p>
          </div>
          <a href="${b.url_compra}" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;background:${esTop ? MP_COLOR.sello : MP_COLOR.regla};color:${esTop ? MP_COLOR.sup : MP_COLOR.tinta1};border:none;padding:10px 14px;border-radius:var(--radio);font-weight:600;font-size:12px;text-decoration:none;white-space:nowrap;">
            Abrir →
          </a>
        </div>`;
    }).join('');

    const content = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
        <div>
          <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--sello);">Cómo comprar</p>
          <h2 style="margin:4px 0 0;font-size:22px;color:var(--tinta-1);font-weight:700;letter-spacing:-0.01em;">${ticker}</h2>
        </div>
        <button onclick="document.getElementById('mp-compra-modal').remove()" style="background:transparent;border:none;color:var(--tinta-4);font-size:24px;cursor:pointer;line-height:1;padding:4px 8px;">×</button>
      </div>
      <p style="margin:0 0 16px;font-size:12px;color:var(--tinta-3);line-height:1.5;">
        Comisiones estimadas comprando <strong style="color:var(--tinta-1);">$${monto.toLocaleString()} MXN</strong>. Ordenados de más barato a más caro.
      </p>
      <div style="margin-bottom:16px;">
        ${items}
      </div>
      <div style="padding:12px;background:rgba(156,93,18,0.08);border:1px solid rgba(156,93,18,0.25);border-radius:var(--radio-tarjeta);">
        <p style="margin:0;font-size:11px;color:var(--sello);line-height:1.55;">
          <span class="mp-marca" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M8 21h8"/><path d="M5 7 2 14h6z"/><path d="M19 7l-3 7h6z"/></svg></span> <strong>Mi Portafolio no ejecuta trades</strong> ni custodia tu dinero. Al picar "Abrir" vas al sitio/app de tu broker — ahí inicias sesión y ejecutas la compra tú mismo. No somos casa de bolsa registrada ante CNBV.
        </p>
      </div>
      <details style="margin-top:12px;">
        <summary style="cursor:pointer;font-size:11px;color:var(--tinta-4);">¿Y si quiero comparar más opciones?</summary>
        <p style="margin:8px 0 0;font-size:11px;color:var(--tinta-3);line-height:1.55;">
          La sección <strong>"Brokers MX"</strong> en la app principal tiene comparativa completa con fortalezas, debilidades, comisiones anuales y fees por inactividad de los 8 brokers documentados.
        </p>
      </details>`;
    const cont = document.getElementById('mp-compra-content');
    if (cont) cont.innerHTML = content;
  };

})();
