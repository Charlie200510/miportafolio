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
    ticker:   ['ticker', 'symbol', 'simbolo', 'instrumento', 'emisora', 'clave'],
    fecha:    ['fecha', 'date', 'fec', 'fecha_op', 'fechaoperacion'],
    shares:   ['shares', 'titulos', 'titulos_titulares', 'cantidad', 'qty', 'volumen', 'acciones'],
    precio:   ['precio', 'price', 'precio_unitario', 'precio_compra', 'precio_op'],
    moneda:   ['moneda', 'currency', 'divisa', 'cur'],
    tipo:     ['tipo', 'type', 'operacion', 'movimiento'],
    comision: ['comision', 'comisión', 'fee', 'fees', 'commission'],
    notas:    ['notas', 'notes', 'descripcion', 'detalle'],
  };
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
    const requiredCols = ['ticker', 'fecha', 'shares', 'precio'];
    const faltantes = requiredCols.filter(c => map[c] === undefined);
    if (faltantes.length) {
      throw new Error(`Faltan columnas: ${faltantes.join(', ')}. Headers detectados: ${headers.join(' | ')}`);
    }
    const txs = [];
    for (let i = 1; i < lines.length; i++) {
      const f = parseLine(lines[i]);
      const ticker = (f[map.ticker] || '').trim().toUpperCase();
      const fecha  = (f[map.fecha]  || '').trim();
      const shares = parseFloat((f[map.shares] || '').replace(/[^\d.\-]/g, ''));
      const precio = parseFloat((f[map.precio] || '').replace(/[^\d.\-]/g, ''));
      if (!ticker || !fecha || !isFinite(shares) || !isFinite(precio)) continue;
      txs.push({
        ticker, fecha, shares, precio,
        tipo:     map.tipo !== undefined ? _normalizarTipo(f[map.tipo]) : 'compra',
        moneda:   map.moneda !== undefined ? (f[map.moneda] || 'USD').trim().toUpperCase() : 'USD',
        comision: map.comision !== undefined ? parseFloat((f[map.comision] || '0').replace(/[^\d.\-]/g, '')) || 0 : 0,
        notas:    map.notas !== undefined ? (f[map.notas] || '').trim() : '',
      });
    }
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
          window.toast && window.toast(`Importadas ${txs.length} transacciones. Refrescando...`, 'success', 4000);
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
      <div id="mp-import-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:520px;width:100%;padding:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <h2 style="margin:0;font-size:18px;font-weight:600;color:#f4f4f5;">Importar transacciones desde CSV</h2>
            <button onclick="document.getElementById('mp-import-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;">×</button>
          </div>
          <p style="font-size:13px;color:#a1a1aa;line-height:1.6;margin:0 0 16px;">
            Exporta tus operaciones desde tu broker (GBM, Kuspit, Bursanet, etc.) como CSV y súbelo aquí. El parser detecta automáticamente las columnas comunes.
          </p>
          <div style="background:#161616;border:1px solid #2a2a2f;border-radius:8px;padding:12px;margin-bottom:16px;">
            <p style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin:0 0 8px;">Columnas requeridas</p>
            <p style="font-family:monospace;font-size:12px;color:#22c55e;margin:0;line-height:1.7;">
              ticker, fecha, shares, precio
            </p>
            <p style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin:12px 0 8px;">Columnas opcionales</p>
            <p style="font-family:monospace;font-size:12px;color:#a1a1aa;margin:0;line-height:1.7;">
              tipo (compra/venta/dividendo), moneda, comision, notas
            </p>
          </div>
          <p style="font-size:11px;color:#71717a;margin:0 0 16px;line-height:1.5;">
            Acepta variantes de nombres: <code>symbol</code> = <code>ticker</code>, <code>quantity</code> = <code>shares</code>, etc.
          </p>
          <button onclick="document.getElementById('mp-import-modal').remove(); window.importarCSVTransacciones()" style="display:block;width:100%;background:#22c55e;color:#0a0a0b;border:none;padding:10px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;">
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
  window.abrirModalCompra = async function(ticker, monto = 10000) {
    if (!ticker) return;
    if (document.getElementById('mp-compra-modal')) return;

    // Loading placeholder
    document.body.insertAdjacentHTML('beforeend', `
      <div id="mp-compra-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px);">
        <div style="background:#0a0a0b;border:1px solid #2a2a2f;border-radius:16px;max-width:540px;width:100%;max-height:90vh;overflow-y:auto;">
          <div id="mp-compra-content" style="padding:24px;">
            <p style="color:#71717a;font-size:13px;text-align:center;">Buscando brokers compatibles con ${ticker}…</p>
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
      brokers = Array.isArray(body) ? body : (body.brokers || []);
    } catch (e) {
      const cont = document.getElementById('mp-compra-content');
      if (cont) cont.innerHTML = `<p style="color:#ef4444;font-size:13px;">Error: ${e.message}</p>`;
      return;
    }

    if (!brokers.length) {
      const cont = document.getElementById('mp-compra-content');
      if (cont) cont.innerHTML = `
        <p style="color:#a1a1aa;font-size:13px;text-align:center;">
          No tenemos brokers MX con datos para <strong style="color:#fff;">${ticker}</strong>.
          Verifica el ticker o búscalo manualmente en tu broker.
        </p>
        <button onclick="document.getElementById('mp-compra-modal').remove()" style="margin-top:16px;display:block;width:100%;background:#22c55e;color:#0a0a0b;border:none;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;">Cerrar</button>`;
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
        <div style="display:flex;gap:12px;align-items:center;padding:14px;background:${esTop ? 'rgba(34,197,94,0.06)' : '#161616'};border:1px solid ${esTop ? 'rgba(34,197,94,0.3)' : '#2a2a2f'};border-radius:12px;margin-bottom:8px;">
          <span style="font-size:22px;flex-shrink:0;">${b.emoji || '🏦'}</span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <p style="margin:0;font-weight:600;color:#f4f4f5;font-size:14px;">${b.broker}</p>
              ${esTop ? '<span style="font-size:9px;background:#22c55e;color:#0a0a0b;padding:2px 6px;border-radius:4px;font-weight:700;text-transform:uppercase;">Más barato</span>' : ''}
            </div>
            <p style="margin:3px 0 0;font-size:11px;color:#a1a1aa;">
              Comisión: <strong style="color:#fff;">$${b.comision_estimada_mxn.toFixed(2)}</strong>
              ${b.nota ? `<span style="color:#71717a;"> · ${b.nota}</span>` : ''}
            </p>
            <p style="margin:2px 0 0;font-size:10px;color:#71717a;">Mínimo apertura: ${minApStr}</p>
          </div>
          <a href="${b.url_compra}" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;background:${esTop ? '#22c55e' : '#27272a'};color:${esTop ? '#0a0a0b' : '#f4f4f5'};border:none;padding:10px 14px;border-radius:8px;font-weight:600;font-size:12px;text-decoration:none;white-space:nowrap;">
            Abrir →
          </a>
        </div>`;
    }).join('');

    const content = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
        <div>
          <p style="margin:0;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#22c55e;">Cómo comprar</p>
          <h2 style="margin:4px 0 0;font-size:22px;color:#f4f4f5;font-weight:700;letter-spacing:-0.01em;">${ticker}</h2>
        </div>
        <button onclick="document.getElementById('mp-compra-modal').remove()" style="background:transparent;border:none;color:#71717a;font-size:24px;cursor:pointer;line-height:1;padding:4px 8px;">×</button>
      </div>
      <p style="margin:0 0 16px;font-size:12px;color:#a1a1aa;line-height:1.5;">
        Comisiones estimadas comprando <strong style="color:#fff;">$${monto.toLocaleString()} MXN</strong>. Ordenados de más barato a más caro.
      </p>
      <div style="margin-bottom:16px;">
        ${items}
      </div>
      <div style="padding:12px;background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.25);border-radius:8px;">
        <p style="margin:0;font-size:11px;color:#c4b5fd;line-height:1.55;">
          ⚖️ <strong>Mi Portafolio no ejecuta trades</strong> ni custodia tu dinero. Al picar "Abrir" vas al sitio/app de tu broker — ahí inicias sesión y ejecutas la compra tú mismo. No somos casa de bolsa registrada ante CNBV.
        </p>
      </div>
      <details style="margin-top:12px;">
        <summary style="cursor:pointer;font-size:11px;color:#71717a;">¿Y si quiero comparar más opciones?</summary>
        <p style="margin:8px 0 0;font-size:11px;color:#a1a1aa;line-height:1.55;">
          La sección <strong>"Brokers MX"</strong> en la app principal tiene comparativa completa con fortalezas, debilidades, comisiones anuales y fees por inactividad de los 8 brokers documentados.
        </p>
      </details>`;
    const cont = document.getElementById('mp-compra-content');
    if (cont) cont.innerHTML = content;
  };

})();
