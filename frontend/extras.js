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

})();
