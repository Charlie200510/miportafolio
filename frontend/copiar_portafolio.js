// ============================================================
//  copiar_portafolio.js — "¿Con cuánto dinero puedo copiar este portafolio?"
//
//  Un portafolio se define en PORCENTAJES, pero se compra en ACCIONES ENTERAS.
//  Con 4 posiciones y un precio de $300 USD la posición más cara, replicar los
//  porcentajes al pie de la letra puede exigir cientos de miles de pesos. Este
//  módulo responde la pregunta que de verdad importa: cuál es el monto MÁS
//  BAJO con el que los porcentajes salen razonablemente parecidos.
//
//  La respuesta no es una fórmula cerrada: al redondear a acciones enteras los
//  pesos reales saltan, y bajar el presupuesto no siempre empeora el ajuste
//  (a veces un redondeo cae mejor). Por eso se BARRE el presupuesto y se
//  evalúa cada punto, en vez de despejar.
// ============================================================
(function () {
  'use strict';

  const TOPE_OBJETIVO = 10000;   // MXN: la meta que puso el producto
  const PASOS         = 600;     // puntos del barrido; sobra para ser exacto
  const FIEL          = 3;       // pp de desvío máximo que llamamos "fiel"
  const ACEPTABLE     = 7;       // pp por encima de esto, lo decimos claro

  const money = (n, dec = 0) => '$' + n.toLocaleString('es-MX',
    { minimumFractionDigits: dec, maximumFractionDigits: dec });

  /* Las cripto se compran en fracciones: exigirles "una unidad entera" haría
     que un portafolio con BTC costara millones y la respuesta sería inútil. */
  function esFraccionable(t) {
    const u = (t || '').toUpperCase();
    return u.endsWith('-USD') || u.endsWith('-USDT');
  }

  function leerObjetivo() {
    let tickers = [], pesos = {};
    try { tickers = JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]'); } catch (_) {}
    try { pesos   = JSON.parse(localStorage.getItem('miPortafolio.pesos.v1')   || '{}'); } catch (_) {}
    if (!Array.isArray(tickers) || !tickers.length) return null;

    // Los pesos guardados solo valen si cubren TODAS las emisoras de la lista.
    // Las dos claves se guardan por separado y se desincronizan (cambias de
    // portafolio y los pesos se quedan con los del anterior): usarlos a medias
    // dejaría fuera del cálculo justo las emisoras sin peso, y el plan saldría
    // de un portafolio que no es el tuyo. Si no cubren, equiponderado.
    const completo = tickers.every(t => Number(pesos[t]) > 0);
    const suma = tickers.reduce((a, t) => a + (Number(pesos[t]) || 0), 0);
    const w = {};
    tickers.forEach(t => {
      w[t] = completo ? Number(pesos[t]) / suma : 1 / tickers.length;
    });
    return { tickers, pesos: w, equiponderado: !completo };
  }

  async function preciosEnPesos(tickers) {
    const res = await fetch('/api/precios-actuales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tickers: tickers.concat(['USDMXN=X']) }),
    });
    if (!res.ok) throw new Error('No pudimos traer los precios (' + res.status + ')');
    const body = await res.json();
    const p = body.precios || {};

    const fx = p['USDMXN=X'] && p['USDMXN=X'].precio;
    if (!fx) throw new Error('No pudimos traer el tipo de cambio USD/MXN');

    const out = {}, faltan = [];
    for (const t of tickers) {
      const d = p[t];
      if (!d || !d.precio) { faltan.push(t); continue; }
      // Sin moneda declarada se deduce del sufijo: .MX cotiza en pesos y el
      // resto en dólares. Mezclar las dos sin convertir es el error que hace
      // que "cuánto cuesta" salga 17× mal.
      const mon = d.moneda || (t.toUpperCase().endsWith('.MX') ? 'MXN' : 'USD');
      out[t] = {
        mxn: mon === 'MXN' ? d.precio : d.precio * fx,
        original: d.precio,
        moneda: mon,
      };
    }
    return { precios: out, fx, faltan, hora: body.hora_actualizacion };
  }

  /* Un presupuesto concreto → cuántas acciones de cada cosa y qué tan lejos
     quedan los porcentajes reales de los buscados. */
  function evaluar(B, tickers, w, q) {
    const linea = [];
    let costo = 0;
    for (const t of tickers) {
      const objetivo = B * w[t];
      let unidades;
      if (esFraccionable(t)) {
        unidades = objetivo / q[t].mxn;                  // fracción libre
      } else {
        unidades = Math.max(1, Math.round(objetivo / q[t].mxn));  // nunca 0
      }
      const importe = unidades * q[t].mxn;
      costo += importe;
      linea.push({ ticker: t, unidades, importe });
    }
    let desvio = 0;
    for (const l of linea) {
      l.pesoReal = costo > 0 ? l.importe / costo : 0;
      l.delta = (l.pesoReal - w[l.ticker]) * 100;
      desvio = Math.max(desvio, Math.abs(l.delta));
    }
    return { presupuesto: B, costo, desvio, linea };
  }

  /* El barrido. La pregunta del usuario es "cuál es el MÍNIMO", así que la
     respuesta que encabeza es la más barata; pero la más barata suele deformar
     los porcentajes (con una sola acción de la emisora más cara, esa posición
     se come media cartera), y callarlo sería vender un portafolio que no es el
     suyo. Por eso se devuelven las dos y el usuario elige:

       minimo — lo más barato con lo que se tienen TODAS las emisoras.
       fiel   — lo más barato con lo que además los porcentajes se sostienen.

     Cuando coinciden, solo se enseña una. */
  /* Una unidad de cada emisora: por menos que esto no se puede TENER el
     portafolio completo, pase lo que pase con los porcentajes. */
  function planPiso(tickers, w, q) {
    const enteros = tickers.filter(t => !esFraccionable(t));
    // Si TODO se compra en fracciones (un portafolio solo de cripto), no existe
    // un suelo: cualquier monto reproduce los porcentajes exactos, incluido uno
    // de $50. Devolver un plan aquí daba "LO MÍNIMO $0" con ±100 pts, porque la
    // parte fraccionable se dimensiona contra lo que cuesta la parte entera y
    // esa base valía cero. Sin suelo, manda el barrido.
    if (!enteros.length) return null;
    const base = enteros.reduce((a, t) => a + q[t].mxn, 0);
    const pesoEnteros = enteros.reduce((a, t) => a + w[t], 0) || 1;
    const linea = [];
    let costo = 0;
    for (const t of tickers) {
      // La parte fraccionable se dimensiona contra lo que ya cuesta la parte
      // entera, para que su porcentaje salga donde debe.
      const unidades = esFraccionable(t)
        ? (base * (w[t] / pesoEnteros)) / q[t].mxn
        : 1;
      const importe = unidades * q[t].mxn;
      costo += importe;
      linea.push({ ticker: t, unidades, importe });
    }
    let desvio = 0;
    for (const l of linea) {
      l.pesoReal = costo > 0 ? l.importe / costo : 0;
      l.delta = (l.pesoReal - w[l.ticker]) * 100;
      desvio = Math.max(desvio, Math.abs(l.delta));
    }
    return { presupuesto: costo, costo, desvio, linea, esPiso: true };
  }

  function planear(tickers, w, q) {
    const suelo = planPiso(tickers, w, q);
    const todoFraccionable = suelo === null;
    const piso = suelo ? suelo.costo
                       : tickers.reduce((a, t) => a + q[t].mxn * 0.0002, 0);
    // El techo del barrido: el presupuesto al que la posición más apretada (la
    // más cara en relación a su peso) alcanza su porcentaje exacto. Más allá
    // de ahí el ajuste ya no mejora, solo cuesta más.
    const techo = Math.max(piso * 1.05, ...tickers.map(t => q[t].mxn / Math.max(w[t], 1e-6)));

    const cands = [];
    for (let i = 0; i <= PASOS; i++) {
      cands.push(evaluar(piso + (techo - piso) * (i / PASOS), tickers, w, q));
    }
    // El suelo REAL —una unidad de cada emisora— hay que meterlo a mano. El
    // barrido no lo produce: en el presupuesto más bajo que recorre, las
    // emisoras baratas ya reciben decenas de acciones (con $17,478 repartidos
    // a partes iguales, WALMEX se lleva 93), así que el costo del barrido
    // arranca por encima del suelo. Y ese suelo es literalmente la respuesta a
    // "cuál es el mínimo para tener este portafolio".
    if (suelo) cands.push(suelo);

    const minimo = cands.reduce((a, c) => (c.costo < a.costo - 0.5 ? c
                                         : c.costo < a.costo + 0.5 && c.desvio < a.desvio ? c : a), cands[0]);
    // El más barato que baja de un umbral de desvío dado. Si ninguno lo logra,
    // el de menor desvío —y a igualdad, el más barato—.
    const masBarato = (umbral) => {
      const ok = cands.filter(c => c.desvio <= umbral);
      if (ok.length) return ok.reduce((a, c) => (c.costo < a.costo ? c : a), ok[0]);
      return cands.reduce((a, c) => (c.desvio < a.desvio - 0.01 ? c
                                   : Math.abs(c.desvio - a.desvio) <= 0.01 && c.costo < a.costo ? c : a), cands[0]);
    };
    const fiel  = masBarato(FIEL);
    // El punto intermedio. "Lo mínimo" compra una unidad de cada cosa y deja
    // los porcentajes donde caigan; "bien balanceado" paga lo que haga falta
    // para clavarlos. Entre los dos hay un plan que SÍ reparte —ya no es una
    // acción de cada una— pero se detiene en cuanto los pesos son razonables
    // en vez de seguir gastando para afinarlos al milímetro.
    const medio = masBarato(ACEPTABLE);

    // Cada opción se enseña solo si aporta algo frente a la anterior: si dos
    // caen casi en el mismo costo o en el mismo desvío, la segunda es ruido.
    const aporta = (mas, menos) => mas.costo > menos.costo * 1.08 && menos.desvio > mas.desvio + 1;
    const opciones = [{ clave: 'minimo', titulo: 'Lo mínimo', plan: minimo }];
    if (aporta(medio, minimo)) opciones.push({ clave: 'medio', titulo: 'Equilibrado', plan: medio });
    if (aporta(fiel, opciones[opciones.length - 1].plan)) {
      opciones.push({ clave: 'fiel', titulo: 'Balanceado', plan: fiel });
    }
    // Cuál es la posición que empuja el piso hacia arriba: es el dato accionable
    // ("si sacas VOO, cabe") y sin él el aviso solo dice que no se puede.
    const cara = suelo
      ? suelo.linea.filter(l => !esFraccionable(l.ticker))
                   .reduce((a, l) => (!a || l.importe > a.importe ? l : a), null)
      : null;
    return {
      minimo, medio, fiel, opciones, piso, todoFraccionable,
      cabe: minimo.costo <= TOPE_OBJETIVO,
      caro: cara ? cara.ticker : null, caroMonto: cara ? cara.importe : 0,
    };
  }

  // ── UI ────────────────────────────────────────────────────────────────
  function cerrar() {
    const m = document.getElementById('mp-copiar-modal');
    if (m) m.remove();
    document.removeEventListener('keydown', _esc);
  }
  function _esc(e) { if (e.key === 'Escape') cerrar(); }

  function shell(html) {
    let m = document.getElementById('mp-copiar-modal');
    if (!m) {
      document.body.insertAdjacentHTML('beforeend',
        `<div id="mp-copiar-modal" class="mp-modal" role="dialog" aria-modal="true"
              aria-label="Copiar mi portafolio">
           <div class="mp-modal-caja"><div id="mp-copiar-cuerpo" class="mp-modal-cuerpo"></div></div>
         </div>`);
      m = document.getElementById('mp-copiar-modal');
      m.addEventListener('click', (e) => { if (e.target === m) cerrar(); });
      document.addEventListener('keydown', _esc);
    }
    m.querySelector('#mp-copiar-cuerpo').innerHTML = html;
    return m;
  }

  const cabecera = (sub) => `
    <div class="mp-modal-cabecera">
      <div>
        <p class="mp-modal-etq">Copiar mi portafolio</p>
        <h2 class="mp-modal-titulo">${sub}</h2>
      </div>
      <button type="button" class="mp-modal-cerrar" data-cerrar aria-label="Cerrar">&times;</button>
    </div>`;

  function pintarError(msg, ayuda) {
    shell(cabecera('No se pudo calcular') + `
      <p class="mp-modal-parrafo">${msg}</p>
      ${ayuda ? `<p class="mp-modal-nota">${ayuda}</p>` : ''}
      <button type="button" class="mp-btn mp-btn-secundario mp-modal-ancho" data-cerrar>Cerrar</button>`);
  }

  function pintarPlan(d) {
    const { minimo, opciones, cabe, todoFraccionable } = d.plan;
    let elegido = 'minimo';               // la pregunta era "cuál es el mínimo"

    const tabla = (plan) => plan.linea
      .slice().sort((a, b) => b.importe - a.importe)
      .map(l => {
        const frac = esFraccionable(l.ticker);
        const uds  = frac ? l.unidades.toFixed(l.unidades < 1 ? 6 : 4)
                          : l.unidades.toLocaleString('es-MX');
        const signo = l.delta > 0 ? '+' : '';
        const lejos = Math.abs(l.delta) > ACEPTABLE;
        const peso = `${(l.pesoReal * 100).toFixed(1)}%<span class="mp-tabla-delta${
          lejos ? ' lejos' : ''}">${signo}${l.delta.toFixed(1)}</span>`;
        // El peso real va DOS veces: como columna en pantallas anchas y como
        // subtítulo bajo la emisora en iPhone, donde la cuarta columna no cabe
        // y quedaba fuera del scroll —justo el dato que explica el monto—.
        return `
          <tr>
            <td class="mp-tabla-clave">${l.ticker}
              <span class="mp-tabla-sub mp-num">${peso}</span></td>
            <td class="mp-num">${uds}${frac ? '' : (l.unidades === 1 ? ' acción' : ' acciones')}</td>
            <td class="mp-num">${money(l.importe)}</td>
            <td class="mp-num mp-tabla-peso">${peso}</td>
          </tr>`;
      }).join('');

    const juicio = (plan) => plan.desvio <= FIEL
      ? `Los porcentajes quedan a menos de ${Math.max(plan.desvio, 0.1).toFixed(1)} puntos de tu portafolio: en la práctica es el mismo.`
      : plan.desvio <= ACEPTABLE
        ? `Los porcentajes se desvían hasta ${plan.desvio.toFixed(1)} puntos. Se parece, pero no es idéntico.`
        : `Con este monto la posición más desajustada se va ${plan.desvio.toFixed(1)} puntos de su porcentaje. Sigue siendo tu misma lista de emisoras, pero repartida distinto.`;

    const selector = () => opciones.length < 2 ? '' : `
      <div class="mp-opciones" role="group" aria-label="Qué tanto quieres apegarte a los porcentajes">
        ${opciones.map(o => `
          <button type="button" class="mp-opcion${elegido === o.clave ? ' activa' : ''}" data-opcion="${o.clave}"
                  aria-pressed="${elegido === o.clave}">
            <span class="mp-opcion-etq">${o.titulo}</span>
            <span class="mp-opcion-cifra">${money(o.plan.costo)}</span>
            <span class="mp-opcion-nota">±${o.plan.desvio.toFixed(1)} pts</span>
          </button>`).join('')}
      </div>`;

    // Con todo fraccionable no hay suelo que anunciar: cualquier monto reproduce
    // los porcentajes exactos, y decir "no se puede bajar de X" seria falso.
    const aviso = todoFraccionable ? `
      <p class="mp-modal-nota">Todas tus posiciones se compran en fracciones, así que
      puedes replicar estos porcentajes con el monto que quieras: el de abajo es solo
      un ejemplo.</p>` : cabe ? '' : `
      <p class="mp-modal-aviso">
        No se puede bajar de ${money(TOPE_OBJETIVO)}: lo mínimo para tener las
        ${minimo.linea.length} posiciones ya cuesta ${money(d.plan.piso)}${
          d.plan.caro ? `, y ${d.plan.caro} sola se lleva ${money(d.plan.caroMonto)}` : ''}.
        Para invertir menos necesitas que tu broker te venda
        <strong>fracciones de acción</strong>, o dejar fuera las posiciones más caras.
      </p>`;

    const faltan = d.faltan.length
      ? `<p class="mp-modal-nota">Sin precio para ${d.faltan.join(', ')} — quedaron fuera del cálculo.</p>` : '';
    const equi = d.equiponderado
      ? `<p class="mp-modal-nota">Tu portafolio no tiene porcentajes guardados, así que el plan
         reparte el dinero por igual entre las ${minimo.linea.length} emisoras.</p>` : '';

    function render() {
      const sel = opciones.find(o => o.clave === elegido);
      const plan = sel ? sel.plan : minimo;
      shell(cabecera(money(plan.costo) + ' MXN') + `
        ${selector()}
        <p class="mp-modal-parrafo">${juicio(plan)}</p>
        ${aviso}
        <div class="mp-tabla-envoltura">
          <table class="mp-tabla-plan">
            <thead><tr><th>Emisora</th><th>Compras</th><th>Importe</th><th class="mp-tabla-peso">Peso real</th></tr></thead>
            <tbody>${tabla(plan)}</tbody>
            <tfoot><tr><td>Total</td><td></td><td class="mp-num">${money(plan.costo)}</td><td class="mp-num mp-tabla-peso">100%</td></tr></tfoot>
          </table>
        </div>
        ${faltan}${equi}
        <p class="mp-modal-nota">
          Precios de ${d.hora ? new Date(d.hora).toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit' }) : 'hoy'},
          con retraso de ~15 min. Dólares convertidos a ${money(d.fx, 2)} por USD.
          No incluye las comisiones de tu broker.
        </p>
        <div class="mp-modal-acciones">
          <button type="button" class="mp-btn mp-btn-primario" data-copiar>Copiar la lista</button>
          <button type="button" class="mp-btn mp-btn-secundario" data-cerrar>Cerrar</button>
        </div>`);

      const modal = document.getElementById('mp-copiar-modal');
      modal.querySelectorAll('[data-opcion]').forEach(b =>
        b.addEventListener('click', () => { elegido = b.dataset.opcion; render(); }));
      modal.querySelector('[data-copiar]').addEventListener('click', (ev) => {
        const txt = plan.linea.map(l => `${l.ticker}: ${esFraccionable(l.ticker)
          ? l.unidades.toFixed(6) : l.unidades} · ${money(l.importe)}`).join('\n')
          + `\nTotal: ${money(plan.costo)} MXN`;
        navigator.clipboard && navigator.clipboard.writeText(txt);
        ev.target.textContent = 'Copiada';
        window.toast && window.toast('Lista de compra copiada.', 'success');
      });
      modal.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrar));
    }
    render();
  }

  window.abrirCopiarPortafolio = async function () {
    const obj = leerObjetivo();
    if (!obj) {
      shell(cabecera('Todavía no hay portafolio'));
      pintarError('Primero arma un portafolio en <strong>Mi portafolio</strong>; ' +
                  'de ahí salen las emisoras y los porcentajes que hay que copiar.');
      return;
    }
    shell(cabecera('Calculando…') +
      '<p class="mp-modal-parrafo">Buscando el monto más bajo con el que los porcentajes se sostienen…</p>');
    document.querySelectorAll('#mp-copiar-modal [data-cerrar]').forEach(b => b.addEventListener('click', cerrar));

    try {
      const { precios, fx, faltan, hora } = await preciosEnPesos(obj.tickers);
      const vivos = obj.tickers.filter(t => precios[t]);
      if (!vivos.length) { pintarError('Ningún ticker de tu portafolio tiene precio ahora mismo.'); return; }

      // Renormalizar los pesos si algún ticker se quedó sin precio: si no, los
      // porcentajes ya no suman 100 y todo el cálculo sale corrido.
      const suma = vivos.reduce((a, t) => a + obj.pesos[t], 0);
      const w = {}; vivos.forEach(t => { w[t] = obj.pesos[t] / suma; });

      pintarPlan({ plan: planear(vivos, w, precios), pesos: w, fx, faltan, hora,
                   equiponderado: obj.equiponderado });
    } catch (e) {
      pintarError('No pudimos traer los precios para calcularlo.', e.message);
    }
  };

  document.addEventListener('click', (ev) => {
    if (ev.target.closest('#btn-copiar-portafolio')) window.abrirCopiarPortafolio();
  });
})();
