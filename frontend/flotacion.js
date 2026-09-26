/* flotacion.js — la figura de análisis de Mi portafolio.
 *
 * QUÉ ES
 * Cinco barras que salen de una línea horizontal. La línea no es cero: es
 * CETES a 28 días, el rendimiento que cualquiera puede tener sin arriesgar
 * nada. Lo que sube de ahí ganó de verdad; lo que baja se está hundiendo.
 *
 * Es la misma figura a tres tamaños —héroe, fila de lista y widget— porque no
 * son tres gráficas: son tres densidades del mismo vector de cinco números.
 * Esa es la parte que hace que el sistema se sienta coherente sin esfuerzo.
 *
 * POR QUÉ NO ES UN RADAR
 * Un pentágono de vértices unidos con relleno translúcido es el default de
 * Chart.js y de cualquier plantilla de dashboard: se lee como plantilla. Las
 * barras divergentes además sobreviven al tamaño de una fila de lista, cosa
 * que un radar de 30 px no hace.
 *
 * POR QUÉ NO ES VERDE
 * El verde ya significa "subió" y el rojo "bajó". Un tercer verde y el color
 * deja de decir nada. La rampa va sepia → gris cálido → petróleo en cinco
 * pasos, con la luminosidad CIE pareja (L* 43–45) para que ninguna figura pese
 * más que otra cuando están en lista: la única señal es el tono y el área, que
 * son las dos que llevan dato.
 */
(function () {
  'use strict';

  /* Los cinco ejes. El orden importa: se lee de izquierda a derecha y PODER va
   * primero porque es la pregunta que trae al usuario a la app. */
  var EJES = [
    { id: 'poder',      etq: 'PODER',      ayuda: 'Contra CETES, lo que rindió al año' },
    { id: 'eficiencia', etq: 'EFICIENCIA', ayuda: 'Cuánto rinde por unidad de riesgo' },
    { id: 'calma',      etq: 'CALMA',      ayuda: 'Qué tan poco se mueve' },
    { id: 'aguante',    etq: 'AGUANTE',    ayuda: 'Qué tan poco cayó en su peor racha' },
    { id: 'mercado',    etq: 'MERCADO',    ayuda: 'Contra el IPC' }
  ];

  /* Rampa de CINCO PASOS DISCRETOS, no interpolada.
   *
   * Interpolando el tono de arena (~50°) a petróleo (~192°) el camino corto
   * pasa por el verde: un activo de puntaje medio-alto salía rgb(78,107,82),
   * o sea verde apagado, compitiendo otra vez con el verde de "subió". Se vio
   * probando la función, no leyendo el código.
   *
   * Cinco pasos fijos que van sepia → gris cálido → petróleo nunca cruzan por
   * ahí. Medidos: L* entre 43.0 y 45.1 (dispersión 2.1) y todos a más de
   * ΔE 29 del verde y del rojo de mercado. No tocar sin volver a medir. */
  var RAMPA = ['#935B2B', '#8A6335', '#6E6A5E', '#3F6C78', '#1F7186'];

  function acotar(v, min, max) { return v < min ? min : (v > max ? max : v); }

  /* Elige el paso de la rampa según el total (−15..+15). Cinco cubos, sin
   * interpolar: ver la nota de RAMPA. */
  function colorDe(total) {
    var t = acotar((total + 15) / 30, 0, 0.9999);
    return RAMPA[Math.floor(t * RAMPA.length)];
  }

  /* Convierte las métricas que YA devuelve /api/analizar en cinco puntajes
   * de −3 a +3. Cada divisor es la distancia que vale un punto; están
   * elegidos para que un activo mexicano grande y normal caiga cerca de 0 y
   * los extremos sean de verdad extremos.
   *
   * Si una métrica no viene, ese eje queda en null y la figura dibuja un
   * hueco en vez de inventar un cero — un cero significa "normal", y eso
   * sería mentir sobre un dato que no tenemos. */
  function puntuar(m, opciones) {
    var o = opciones || {};
    var cetes = typeof o.cetes === 'number' ? o.cetes : 9.5;
    var bench = typeof o.benchmarkAnual === 'number' ? o.benchmarkAnual : null;
    function eje(valor, fn) {
      return (typeof valor === 'number' && isFinite(valor)) ? acotar(fn(valor), -3, 3) : null;
    }
    return {
      poder:      eje(m.rendimiento_anualizado_pct, function (v) { return (v - cetes) / 5; }),
      eficiencia: eje(m.sharpe_ratio,               function (v) { return v * 2; }),
      calma:      eje(m.volatilidad_anual_pct,      function (v) { return (22 - v) / 6; }),
      aguante:    eje(m.max_drawdown_pct,           function (v) { return (30 - Math.abs(v)) / 10; }),
      mercado:    bench === null ? null
                : eje(m.rendimiento_anualizado_pct, function (v) { return (v - bench) / 5; })
    };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Dibuja la figura. `tam` es 'heroe' | 'fila' | 'micro'.
   *
   * GEOMETRÍA: el rótulo de la línea NO va dentro del SVG y las etiquetas de
   * eje van todas a una Y fija abajo del marco. La primera versión ponía el
   * rótulo sobre la línea y las etiquetas pegadas al extremo de cada barra:
   * con barras cortas se encimaban unas con otras. Se vio renderizando, no
   * leyendo el código. Fijando la Y de las etiquetas, ninguna puede chocar
   * con nada por corta o larga que salga la barra.
   *
   * Devuelve una cadena de SVG lista para insertar. */
  function dibujar(puntajes, tam, etiqueta) {
    var P = {
      heroe: { w: 346, h: 168, barra: 44, hueco: 14, unidad: 20, etiquetas: true,  cifras: true,  regla: 2,  agua: 74 },
      fila:  { w: 64,  h: 28,  barra: 9,  hueco: 4,  unidad: 4,  etiquetas: false, cifras: false, regla: 1,  agua: 14 },
      micro: { w: 32,  h: 18,  barra: 5,  hueco: 1.5, unidad: 2.6, etiquetas: false, cifras: false, regla: 0.8, agua: 9 }
    }[tam] || null;
    if (!P) return '';

    var vivos = EJES.filter(function (e) { return puntajes[e.id] !== null && puntajes[e.id] !== undefined; });
    if (!vivos.length) return '';

    var total = vivos.reduce(function (a, e) { return a + puntajes[e.id]; }, 0);
    var color = colorDe(total * (5 / vivos.length));   // normaliza si falta algún eje
    var agua = P.agua;
    var ancho = vivos.length * P.barra + (vivos.length - 1) * P.hueco;
    var x0 = (P.w - ancho) / 2;
    var centro = function (i) { return x0 + i * (P.barra + P.hueco) + P.barra / 2; };

    var partes = [];
    partes.push('<svg viewBox="0 0 ' + P.w + ' ' + P.h + '" style="width:100%;height:' + P.h +
      'px;display:block" role="img" aria-label="' + esc(etiqueta || 'Flotación') + '">');

    /* Bandas de referencia, solo hasta donde una barra puede llegar. Se
     * transparentan a través del relleno, así se puede CONTAR el puntaje sin
     * tooltip. */
    if (P.etiquetas) {
      partes.push('<g stroke="var(--regla)" stroke-width="1">');
      for (var k = 1; k <= 3; k++) {
        partes.push('<line x1="' + x0 + '" y1="' + (agua - k * P.unidad) + '" x2="' + (x0 + ancho) + '" y2="' + (agua - k * P.unidad) + '"/>');
        partes.push('<line x1="' + x0 + '" y1="' + (agua + k * P.unidad) + '" x2="' + (x0 + ancho) + '" y2="' + (agua + k * P.unidad) + '"/>');
      }
      partes.push('</g>');
    }

    /* Las barras. Un puntaje de 0 deja un muñón visible en vez de desaparecer:
     * "normal" es información, y una barra ausente se confundiría con un dato
     * que falta. */
    partes.push('<g fill="' + color + '" fill-opacity="0.9">');
    vivos.forEach(function (e, i) {
      var v = puntajes[e.id];
      var x = x0 + i * (P.barra + P.hueco);
      var alto = Math.max(Math.abs(v) * P.unidad, P.regla * 1.5);
      var y = v >= 0 ? agua - alto : agua;
      partes.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + P.barra + '" height="' + alto.toFixed(1) + '"/>');
    });
    partes.push('</g>');

    /* La línea de flotación, de borde a borde */
    partes.push('<line x1="0" y1="' + agua + '" x2="' + P.w + '" y2="' + agua +
      '" stroke="var(--tinta-1)" stroke-width="' + P.regla + '"/>');

    /* Cifra al extremo de cada barra, siempre por fuera */
    if (P.cifras) {
      partes.push('<g font-family="var(--ff-sans)" font-size="11.5" font-weight="600" ' +
        'fill="var(--tinta-1)" text-anchor="middle">');
      vivos.forEach(function (e, i) {
        var v = puntajes[e.id];
        var alto = Math.abs(v) * P.unidad;
        var y = v >= 0 ? agua - alto - 6 : agua + alto + 13;
        var txt = (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(1);
        partes.push('<text x="' + centro(i).toFixed(1) + '" y="' + y.toFixed(1) + '">' + txt + '</text>');
      });
      partes.push('</g>');
    }

    /* Etiquetas de eje a Y FIJA, abajo del marco: así nunca chocan */
    if (P.etiquetas) {
      partes.push('<g font-family="var(--ff-sans)" font-size="9" font-weight="600" ' +
        'letter-spacing="0.06em" fill="var(--tinta-3)" text-anchor="middle">');
      vivos.forEach(function (e, i) {
        partes.push('<text x="' + centro(i).toFixed(1) + '" y="' + (P.h - 4) + '">' + e.etq + '</text>');
      });
      partes.push('</g>');
    }

    partes.push('</svg>');
    return partes.join('');
  }

  /* La misma verdad, dicha en prosa. Sin esto el usuario ve barras y no sabe
   * qué concluir; con esto cada figura tiene moraleja. */
  function veredicto(puntajes, metricas, opciones) {
    var o = opciones || {};
    var cetes = typeof o.cetes === 'number' ? o.cetes : 9.5;
    var r = metricas.rendimiento_anualizado_pct;
    var vivos = EJES.filter(function (e) { return puntajes[e.id] !== null && puntajes[e.id] !== undefined; });
    var total = vivos.reduce(function (a, e) { return a + puntajes[e.id]; }, 0);

    var peor = null, mejor = null;
    vivos.forEach(function (e) {
      if (peor === null || puntajes[e.id] < puntajes[peor.id]) peor = e;
      if (mejor === null || puntajes[e.id] > puntajes[mejor.id]) mejor = e;
    });

    var cabeza;
    if (typeof r === 'number' && r < cetes) {
      cabeza = 'Rindió ' + r.toFixed(1) + '% al año. CETES pagó ' + cetes.toFixed(1) +
               '% sin arriesgar nada.';
    } else if (total >= 6) {
      cabeza = 'Le gana a CETES y lo hace sin sustos.';
    } else if (total >= 0) {
      cabeza = 'Le gana a CETES, pero no por mucho.';
    } else {
      cabeza = 'No compensa el riesgo que te hace correr.';
    }
    var cola = (peor && mejor && peor.id !== mejor.id)
      ? ' Su fuerte es ' + mejor.etq.toLowerCase() + '; donde falla es ' + peor.etq.toLowerCase() + '.'
      : '';
    return cabeza + cola;
  }

  window.MP_FLOTACION = {
    ejes: EJES,
    puntuar: puntuar,
    dibujar: dibujar,
    veredicto: veredicto,
    colorDe: colorDe
  };
})();
