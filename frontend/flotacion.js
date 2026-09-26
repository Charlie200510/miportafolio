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
    /* La ayuda de MERCADO es un MARCADOR, no el texto final: el benchmark lo
       elige el backend según la moneda dominante (^MXX si la cartera es
       mayoritariamente MXN, ^GSPC si no). Decía fijo "Contra el IPC", así que
       una cartera de acciones estadounidenses leía "Contra el IPC" junto a un
       número calculado contra el S&P 500. Usa ayudaEje(), no este campo. */
    { id: 'mercado',    etq: 'MERCADO',    ayuda: 'Contra el índice de tu mercado' }
  ];

  /* Los dos benchmarks que devuelve el backend, en cristiano. Si algún día
     manda otro, se imprime el ticker tal cual antes que inventarle nombre. */
  var NOMBRES_BENCH = {
    '^MXX':  'el IPC de la BMV',
    '^GSPC': 'el S&P 500'
  };

  function ayudaEje(eje, opciones) {
    var o = opciones || {};
    if (eje.id !== 'mercado') return eje.ayuda;
    var t = o.benchmarkTicker;
    if (!t) return eje.ayuda;
    return 'Contra ' + (NOMBRES_BENCH[t] || t);
  }

  /* Rampa de CINCO PASOS DISCRETOS, no interpolada.
   *
   * Interpolando el tono de arena (~50°) a petróleo (~192°) el camino corto
   * pasa por el verde: un activo de puntaje medio-alto salía rgb(78,107,82),
   * o sea verde apagado, compitiendo otra vez con el verde de "subió". Se vio
   * probando la función, no leyendo el código.
   *
   * Cinco pasos fijos que van sepia → gris cálido → petróleo nunca cruzan por
   * ahí.
   *
   * MEDIDO (ΔE2000, no a ojo), y estos son los números de verdad:
   *   L*        43.0 a 45.1  (dispersión 2.1) — parejo, que era el objetivo
   *   vs --alza #0F5C33   mínimo ΔE 22.9
   *   vs --baja #962418   mínimo ΔE 17.9   ← el más apretado (el sepia)
   *   vs --sello #1B4D3E  mínimo ΔE 17.9
   *
   * Una versión anterior de esta nota decía "todos a más de ΔE 29" y era
   * falso: el peor caso es 17.9, no 29. Pasa igual —el umbral del proyecto es
   * ΔE 15, el mismo con el que se separó --sello de --alza— pero el margen es
   * la mitad de lo que decía el comentario, y quien tocara el sepia creyendo
   * que tenía 14 puntos de holgura se comería el rojo de mercado.
   * NO TOCAR SIN VOLVER A MEDIR, y el que aprieta es el primer paso. */
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

    /* Bandas de referencia, solo hasta donde una barra puede llegar. Van
     * DETRÁS de las barras: antes el relleno era translúcido para poder contar
     * a través de él, pero eso costaba contraste (ver la nota de opacidad más
     * abajo) y la cifra impresa al extremo ya dice el puntaje exacto. */
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
    /* OPACIDAD 1, NO 0.9.
       Las barras se pintaban al 90% para poder contar las bandas de referencia
       a través del relleno. Medido, eso reprobaba AA: el rótulo del peso que
       la regata imprime en blanco DENTRO de la barra daba 4.33:1 sobre el paso
       arena y 4.36:1 sobre el gris, contra el 4.5 que pide un texto de 11px.
       Compuesto sobre papel el color se aclara y el blanco deja de leerse.
       A opacidad plena el peor caso sube a 5.36:1.
       No se pierde nada: la cifra va impresa al extremo de cada barra, así que
       contar bandas a través del relleno era redundante. */
    partes.push('<g fill="' + color + '">');
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

  /* ══════════════════════════════════════════════════════════════════════
     LA REGATA — la misma línea, con la cartera entera encima.
     ══════════════════════════════════════════════════════════════════════
     La figura de arriba dice si TU CARTERA flota. Esta dice QUIÉN la está
     sosteniendo y quién la está hundiendo, que es la pregunta siguiente y
     hoy no la contesta nada en la app.

     Una barra por posición sobre la misma línea de CETES:
       ALTO  = qué tan arriba o abajo de CETES está esa posición
       ANCHO = cuánto pesa en la cartera
       ÁREA  = lo que de verdad aporta o resta

     El ancho es la mitad del dato. Una posición hundidísima que pesa 2% es
     una anécdota; una apenas bajo la línea que pesa 40% es el problema. Con
     barras de ancho igual —que es lo que hace cualquier gráfica de barras—
     las dos se ven igual de graves y eso es desinformar.

     La escala vertical es FIJA (−15..+15, los mismos cinco ejes sumados),
     no se ajusta al contenido: así la silueta de una cartera se puede
     comparar con la de otra. En la marea es al revés y ahí se explica por
     qué. */
  function regata(barcos, opciones) {
    var o = opciones || {};
    /* El ANCHO se dibuja, no se escala.
       Un viewBox de 680 metido en una columna de 327px queda a escala 0.48 y
       un rótulo de 9.5 se imprime a 4.6 px: ilegible. Dejarlo desbordar con
       scroll lateral es peor todavía, porque la figura va ordenada de la que
       más flota a la que más se hunde y lo que queda fuera de pantalla es
       justo la parte que el usuario necesita ver. Así que el marco se dibuja
       del ancho que de verdad hay y la tipografía conserva su tamaño real. */
    var W = acotar(Math.round(o.ancho || 680), 300, 1400);
    var estrecho = W < 460;
    /* La altura crece con el ancho; la TIPOGRAFÍA no. Con el marco fijo en
       680 y el SVG estirado a 1232 px, el viewBox escalaba todo 1.37× y los
       rótulos salían a 13 px mientras el resto de la página seguía en su
       escala: la figura se veía de otra app. Dibujando 1:1, una barra de
       tope mide lo mismo en el teléfono que en el monitor y las dos figuras
       se pueden comparar de memoria. */
    var TOPE = W >= 700 ? 100 : 80;
    var AGUA = TOPE + 16, H = AGUA + TOPE + 24;
    var HUECO = estrecho ? 3 : 4, MIN_ANCHO = estrecho ? 7 : 10;
    var vivos = (barcos || []).filter(function (b) {
      return b && b.puntajes && EJES.some(function (e) {
        return b.puntajes[e.id] !== null && b.puntajes[e.id] !== undefined;
      });
    });
    if (vivos.length < 2) return '';

    /* Suma normalizada: si a un activo le falta un eje, no puede quedar
       automáticamente más cerca de cero que uno con los cinco. */
    vivos.forEach(function (b) {
      var con = EJES.filter(function (e) {
        return b.puntajes[e.id] !== null && b.puntajes[e.id] !== undefined;
      });
      var s = con.reduce(function (a, e) { return a + b.puntajes[e.id]; }, 0);
      b._total = con.length ? s * (5 / con.length) : 0;
      b._peso = (typeof b.peso === 'number' && b.peso > 0) ? b.peso : 0;
    });
    /* De la que más flota a la que más se hunde: la silueta baja de
       izquierda a derecha y la lectura es inmediata. */
    vivos.sort(function (a, b) { return b._total - a._total; });

    /* DOS sumas, no una, y la diferencia importa.
       `sumaMostrados` reparte el ancho entre las barras que sí se dibujan, y
       así la figura llena el marco. `sumaCartera` es el 100% de verdad, e
       incluye lo que se quedó fuera por no tener historial. Con una sola
       suma, una cartera con un activo recién listado reportaba "pesan 37% de
       la cartera" sobre algo que pesa 30%: la figura mentía sobre el dato que
       más pesa en la conclusión. */
    var sumaMostrados = vivos.reduce(function (a, b) { return a + b._peso; }, 0);
    var sumaCartera = (barcos || []).reduce(function (a, b) {
      return a + ((b && typeof b.peso === 'number' && b.peso > 0) ? b.peso : 0);
    }, 0) || sumaMostrados;
    var excluidos = (barcos || []).length - vivos.length;
    var n = vivos.length;
    var disp = W - (n - 1) * HUECO;
    /* Todas las barras con un mínimo legible y el resto repartido por peso.
       Sumado da `disp` exacto, así que la figura siempre llena el ancho. */
    var holgura = disp - n * MIN_ANCHO;
    var anchos = vivos.map(function (b) {
      if (holgura <= 0 || sumaMostrados <= 0) return disp / n;
      return MIN_ANCHO + holgura * (b._peso / sumaMostrados);
    });

    var unidad = TOPE / 15;
    var p = [];
    p.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" ' +
      'role="img" aria-label="Cada posición de la cartera medida contra CETES">');

    /* Rejilla cada 5 puntos: se cuenta a través del relleno translúcido. */
    p.push('<g stroke="var(--regla)" stroke-width="1">');
    [5, 10, 15].forEach(function (k) {
      p.push('<line x1="0" y1="' + (AGUA - k * unidad) + '" x2="' + W + '" y2="' + (AGUA - k * unidad) + '"/>');
      p.push('<line x1="0" y1="' + (AGUA + k * unidad) + '" x2="' + W + '" y2="' + (AGUA + k * unidad) + '"/>');
    });
    p.push('</g>');

    var x = 0;
    var barras = [];
    vivos.forEach(function (b, i) {
      var an = anchos[i];
      var alto = Math.max(Math.abs(b._total) * unidad, 2);
      var y = b._total >= 0 ? AGUA - alto : AGUA;
      barras.push({ b: b, x: x, an: an, alto: alto, y: y });
      p.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + an.toFixed(1) +
        '" height="' + alto.toFixed(1) + '" fill="' + colorDe(b._total) + '">' +
        '<title>' + esc(b.etq) + ' · ' +
        (b._peso && sumaCartera > 0 ? Math.round(b._peso / sumaCartera * 100) + '% de la cartera · ' : '') +
        (b._total > 0 ? '+' : b._total < 0 ? '−' : '') + Math.abs(b._total).toFixed(1) +
        ' contra CETES</title></rect>');
      x += an + HUECO;
    });

    p.push('<line x1="0" y1="' + AGUA + '" x2="' + W + '" y2="' + AGUA +
      '" stroke="var(--tinta-1)" stroke-width="2"/>');

    /* Rótulos a Y FIJA abajo del marco (misma regla que la figura héroe: si
       se pegan al extremo de la barra, con barras cortas se encabalgan).
       NUNCA se recortan: "CEMEXC" y "BTC-" no son tickers, son basura, y un
       rótulo que miente es peor que ninguno. La barra que no da el ancho se
       queda sin rótulo aquí y se identifica en la leyenda de abajo, que
       lleva las mismas en el mismo orden. */
    /* 11 px = --txt-etq. La figura venía con 9.5 y 10, dos tamaños que no
       existen en la escala del sistema; media app en 11 y la figura en 9.5 es
       exactamente lo que hace que una pantalla parezca ensamblada por varias
       manos. El factor 6.6 es el avance real de IBM Plex Mono a 11 px (0.6em),
       y de ahí sale si el ticker cabe. */
    p.push('<g font-family="var(--ff-mono)" font-size="11" fill="var(--tinta-3)" text-anchor="middle">');
    barras.forEach(function (r) {
      var etq = String(r.b.etq || '').split('.')[0];
      r.rotulada = etq.length * 6.6 <= r.an;
      if (!r.rotulada) return;
      p.push('<text x="' + (r.x + r.an / 2).toFixed(1) + '" y="' + (H - 6) + '">' + esc(etq) + '</text>');
    });
    p.push('</g>');

    /* El peso DENTRO de la barra, en papel sobre el color. Es lo que hace
       evidente que el ancho no es decorativo: sin esta cifra hay que leer el
       pie para entender la mitad de la figura. Solo donde cabe holgado. */
    p.push('<g font-family="var(--ff-sans)" font-size="11" font-weight="600" ' +
      'fill="var(--sup-panel)" text-anchor="middle">');
    barras.forEach(function (r) {
      if (r.an < 44 || r.alto < 16 || !r.b._peso || sumaCartera <= 0) return;
      var y = r.b._total >= 0 ? r.y + 13 : r.y + r.alto - 5;
      p.push('<text x="' + (r.x + r.an / 2).toFixed(1) + '" y="' + y.toFixed(1) + '">' +
        Math.round(r.b._peso / sumaCartera * 100) + '%</text>');
    });
    p.push('</g>');

    /* La cifra solo donde cabe sin apretarse contra la vecina. El umbral es
       el ancho que ocupa "+4.8" a 11px (unos 26), no un número redondo: con
       34 la barra que iba EN CABEZA se quedaba sin cifra en el teléfono, que
       es justo la que hay que poder leer. */
    p.push('<g font-family="var(--ff-sans)" font-size="11" font-weight="600" fill="var(--tinta-2)" text-anchor="middle">');
    barras.forEach(function (r) {
      if (r.an < 28) return;
      var v = r.b._total;
      var y = v >= 0 ? r.y - 5 : r.y + r.alto + 11;
      p.push('<text x="' + (r.x + r.an / 2).toFixed(1) + '" y="' + y.toFixed(1) + '">' +
        (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '</text>');
    });
    p.push('</g>');
    p.push('</svg>');

    /* El veredicto se calcula aquí porque aquí están los números ya
       normalizados; devolverlo aparte evita que la vista los recalcule y se
       desincronice con la figura. */
    var hundidos = vivos.filter(function (b) { return b._total < 0; });
    var pesoHundido = hundidos.reduce(function (a, b) { return a + b._peso; }, 0);
    var h = hundidos.length;
    var texto;
    if (!h) {
      texto = n === 1 ? 'La única posición le gana a CETES.'
                      : 'Las ' + n + ' posiciones le ganan a CETES.';
    } else if (h === n) {
      texto = 'Ninguna de las ' + n + ' posiciones le gana a CETES.';
    } else {
      /* Concordancia: con una sola es "1 va", no "1 van". Sale en cuanto una
         cartera tiene un solo activo por debajo, que es el caso más común. */
      texto = h + ' de ' + n + ' posiciones ' + (h === 1 ? 'va' : 'van') + ' abajo de CETES';
      if (sumaCartera > 0) {
        texto += ' y ' + (h === 1 ? 'pesa ' : 'pesan ') +
                 Math.round(pesoHundido / sumaCartera * 100) + '% de la cartera';
      }
      texto += '. La que más arrastra es ' + String(vivos[n - 1].etq || '') + '.';
    }
    /* Lo que se quedó fuera se dice, no se omite: si no, el 100% de la figura
       no es el 100% de la cartera y nadie se entera. */
    if (excluidos > 0) {
      texto += ' ' + excluidos + (excluidos === 1
        ? ' posición queda fuera por no tener historial suficiente.'
        : ' posiciones quedan fuera por no tener historial suficiente.');
    }
    /* `orden` sale en el MISMO orden que las barras: es lo que permite que la
       leyenda de la vista se lea de corrido contra la figura en vez de ser
       otra lista con otro criterio. */
    return {
      svg: p.join(''),
      veredicto: texto,
      orden: vivos.map(function (b, i) {
        return {
          etq: b.etq,
          total: b._total,
          peso: sumaCartera > 0 ? b._peso / sumaCartera : 0,
          color: colorDe(b._total),
          rotulada: !!barras[i].rotulada
        };
      })
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
     LA MAREA — la misma línea, pero la línea es el mercado.
     ══════════════════════════════════════════════════════════════════════
     Un sector que subió 0.4% sale en verde en su tarjeta y parece un buen
     día. Si el mercado subió 1.1%, ese sector PERDIÓ terreno. Eso es lo que
     no se ve en ninguna parte y es exactamente lo que esta figura dice: la
     línea es el mercado y cada barra es la distancia a él.

     POR QUÉ NO ES VERDE NI ROJA.
     Aquí el color no puede significar "subió/bajó": la tarjeta de al lado ya
     usa verde para eso, y un sector verde que quedó bajo la marea saldría
     pintado de rojo justo al lado de su propio verde. Se contradirían en la
     misma pantalla. Va con la rampa de la figura, que significa otra cosa
     —le ganó o no le ganó al mercado— y por eso no compite.

     POR QUÉ ESTA SÍ SE AUTOESCALA.
     La regata compara carteras entre sí, así que su escala tiene que ser
     fija. Esta compara sectores de UN mismo día entre ellos, y las
     distancias de una jornada son décimas de punto: con escala fija se vería
     una línea recta todos los días. Se autoescala y el valor del tope se
     imprime, que es la manera honesta de hacerlo. */
  function marea(filas, opciones) {
    var o = opciones || {};
    /* Mismo criterio que la regata: se dibuja al ancho real. Once columnas en
       340 px caben —27 px cada una, y el ticker más largo (XLRE) ocupa 22—
       siempre que el hueco se cierre. Por eso la marea no necesita scroll
       lateral en el teléfono y la regata sí lo habría necesitado. */
    var W = acotar(Math.round(o.ancho || 680), 300, 1400);
    var TOPE = W >= 700 ? 68 : 52;          // ver la nota de altura en regata()
    var AGUA = TOPE + 22, H = AGUA + TOPE + 26, HUECO = W < 460 ? 3 : 8;
    /* Único sitio donde la figura NO usa los 11 px del sistema: con once
       columnas en un teléfono cada una mide 27 px y "XLRE" a 11 px ocupa 26.4,
       o sea que roza a la vecina. A 9.5 ocupa 23 y respira. Es una excepción
       medida, no un descuido: en cuanto hay ancho vuelve a 11. */
    var CUERPO_ETQ = W < 460 ? 9.5 : 11;
    var vivas = (filas || []).filter(function (f) {
      return f && typeof f.valor === 'number' && isFinite(f.valor);
    });
    if (vivas.length < 3) return '';

    /* La línea: el mercado si viene, y si no la mediana de los propios
       sectores. La diferencia se dice en el pie, no se esconde. */
    var linea, fuente;
    if (typeof o.linea === 'number' && isFinite(o.linea)) {
      linea = o.linea;
      fuente = o.fuenteLinea || 'el mercado';
    } else {
      var ord = vivas.map(function (f) { return f.valor; }).sort(function (a, b) { return a - b; });
      var m = Math.floor(ord.length / 2);
      linea = ord.length % 2 ? ord[m] : (ord[m - 1] + ord[m]) / 2;
      fuente = 'la mediana de los ' + vivas.length + ' sectores';
    }

    var distancias = vivas.map(function (f) { return f.valor - linea; });
    var maxDist = Math.max.apply(null, distancias.map(Math.abs));
    if (!(maxDist > 0)) maxDist = 0.1;
    var unidad = TOPE / maxDist;

    vivas = vivas.map(function (f, i) { return { f: f, d: distancias[i] }; })
                 .sort(function (a, b) { return b.d - a.d; });

    var n = vivas.length;
    var an = (W - (n - 1) * HUECO) / n;
    var p = [];
    p.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" ' +
      'role="img" aria-label="Cada sector medido contra ' + esc(fuente) + '">');

    /* Guía arriba y abajo para que la autoescala tenga tope visible. El VALOR
       del tope va en el pie en HTML, no aquí dentro: puesto en el SVG se
       apelmazaba contra los tickers de las columnas de las orillas. */
    p.push('<g stroke="var(--regla)" stroke-width="1" stroke-dasharray="2 3">');
    p.push('<line x1="0" y1="' + (AGUA - TOPE) + '" x2="' + W + '" y2="' + (AGUA - TOPE) + '"/>');
    p.push('<line x1="0" y1="' + (AGUA + TOPE) + '" x2="' + W + '" y2="' + (AGUA + TOPE) + '"/>');
    p.push('</g>');

    var x = 0;
    vivas.forEach(function (r) {
      var alto = Math.max(Math.abs(r.d) * unidad, 1.5);
      var y = r.d >= 0 ? AGUA - alto : AGUA;
      /* colorDe espera la escala de los cinco ejes (−15..+15); aquí se le
         entrega la distancia normalizada a ese mismo rango para que la rampa
         sea literalmente la misma y no una paleta paralela. */
      p.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + an.toFixed(1) +
        '" height="' + alto.toFixed(1) + '" fill="' + colorDe(r.d / maxDist * 15) + '">' +
        '<title>' + esc(r.f.nombre || r.f.etq) + ' · ' +
        (r.f.valor > 0 ? '+' : r.f.valor < 0 ? '−' : '') + Math.abs(r.f.valor).toFixed(2) + '% en el periodo · ' +
        (r.d >= 0 ? 'le gana al mercado por ' : 'se queda atrás por ') + Math.abs(r.d).toFixed(2) +
        ' puntos</title></rect>');
      p.push('<text x="' + (x + an / 2).toFixed(1) + '" y="' + (H - 5) +
        '" font-family="var(--ff-mono)" font-size="' + CUERPO_ETQ + '" fill="var(--tinta-3)" text-anchor="middle">' +
        esc(String(r.f.etq || '')) + '</text>');
      x += an + HUECO;
    });

    p.push('<line x1="0" y1="' + AGUA + '" x2="' + W + '" y2="' + AGUA +
      '" stroke="var(--tinta-1)" stroke-width="2"/>');
    p.push('</svg>');

    /* Tres cubetas, no dos. Contando `n - arriba` como "se quedaron atrás",
       un sector que empató con el mercado salía reportado como rezagado: en
       un día plano la figura decía "0 de 3 le ganaron, 3 se quedaron atrás"
       cuando los tres iban exactamente al nivel del mercado. */
    var arriba = vivas.filter(function (r) { return r.d > 0; }).length;
    var abajo  = vivas.filter(function (r) { return r.d < 0; }).length;
    var parejo = n - arriba - abajo;
    var signo = linea >= 0 ? '+' : '−';
    /* El dato que de verdad no se ve en ningún otro lado: los que cerraron en
       verde pero por debajo del mercado. Es el motivo de que exista la figura,
       así que se dice con nombre y apellido en vez de dejarlo a la vista. */
    var espejismo = vivas.filter(function (r) { return r.f.valor > 0 && r.d < 0; });
    return {
      svg: p.join(''),
      linea: linea,
      fuenteLinea: fuente,
      maxDist: maxDist,
      espejismo: espejismo.map(function (r) { return r.f.etq; }),
      veredicto: 'La línea es ' + fuente + ': ' + signo + Math.abs(linea).toFixed(2) + '%. ' +
                 arriba + ' de ' + n + ' sectores le ' + (arriba === 1 ? 'ganó' : 'ganaron') + '; ' +
                 abajo + (abajo === 1 ? ' se quedó atrás' : ' se quedaron atrás') +
                 (parejo ? '; ' + parejo + (parejo === 1 ? ' empató' : ' empataron') : '') + '.' +
                 (espejismo.length
                   ? ' ' + espejismo.length + (espejismo.length === 1
                       ? ' cerró en verde y aun así perdió terreno.'
                       : ' cerraron en verde y aun así perdieron terreno.')
                   : '')
    };
  }

  window.MP_FLOTACION = {
    ejes: EJES,
    puntuar: puntuar,
    dibujar: dibujar,
    veredicto: veredicto,
    ayudaEje: ayudaEje,
    colorDe: colorDe,
    regata: regata,
    marea: marea
  };
})();
