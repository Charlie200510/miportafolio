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
    { id: 'poder',      etq: 'Poder',      art: 'el poder',      ayuda: 'Contra CETES, lo que rindió al año' },
    { id: 'eficiencia', etq: 'Eficiencia', art: 'la eficiencia', ayuda: 'Cuánto rinde por unidad de riesgo' },
    { id: 'calma',      etq: 'Calma',      art: 'la calma',      ayuda: 'Qué tan poco se mueve' },
    { id: 'aguante',    etq: 'Aguante',    art: 'el aguante',    ayuda: 'Qué tan poco cayó en su peor racha' },
    /* La ayuda de MERCADO es un MARCADOR, no el texto final: el benchmark lo
       elige el backend según la moneda dominante (^MXX si la cartera es
       mayoritariamente MXN, ^GSPC si no). Decía fijo "Contra el IPC", así que
       una cartera de acciones estadounidenses leía "Contra el IPC" junto a un
       número calculado contra el S&P 500. Usa ayudaEje(), no este campo. */
    { id: 'mercado',    etq: 'Mercado',    art: 'el mercado',    ayuda: 'Contra el índice de tu mercado' }
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
  /* ══════════════════════════════════════════════════════════════════════
     LA FLOTACIÓN: qué tan por encima de la línea está algo.
     ══════════════════════════════════════════════════════════════════════
     NO es la suma de los cinco ejes, y esa era una mentira de bulto.

     Lo que se vio midiendo instrumentos mexicanos de verdad: un fondo de
     deuda que apenas empata con CETES (rinde 9.5%, vol 1.1%, sin caídas)
     sacaba +5.6 de suma y ENCABEZABA la regata, por encima de VOO (+4.8) y
     de WALMEX (+4.4). O sea: la figura ponía al instrumento que DEFINE la
     línea cinco puntos y medio por encima de la línea.

     La causa es que CALMA y AGUANTE son absolutos, no relativos a la línea.
     Premian no moverse — y CETES tampoco se mueve. Al sumarlos, la quietud
     paga como si fuera rendimiento.

     Flotar significa UNA cosa: le ganaste a la referencia. Eso lo dicen
     PODER (contra CETES), MERCADO (contra el índice) y EFICIENCIA (el
     Sharpe, que ya es exceso sobre la tasa libre de riesgo por unidad de
     riesgo). CALMA y AGUANTE describen el CAMINO, no el resultado: siguen
     dibujándose como barras y siguen contando en el veredicto, pero no
     levantan a nadie por encima de la línea.

     PODER y MERCADO se PROMEDIAN, no se suman. Medido: la diferencia entre
     los dos es constante —(benchmark − cetes)/5, 0.48 en la última corrida—
     porque los dos salen del MISMO rendimiento anualizado contra dos
     referencias distintas. Sumarlos contaba el rendimiento dos veces y lo
     dejaba pesando el doble que el Sharpe.

     Rango: ±6. Devuelve null si no hay con qué calcularlo. */
  function flota(p) {
    if (!p) return null;
    var vivo = function (v) { return typeof v === 'number' && isFinite(v); };
    var refs = [];
    if (vivo(p.poder))   refs.push(p.poder);
    if (vivo(p.mercado)) refs.push(p.mercado);
    var partes = [];
    if (refs.length) partes.push(refs.reduce(function (a, b) { return a + b; }, 0) / refs.length);
    if (vivo(p.eficiencia)) partes.push(p.eficiencia);
    if (!partes.length) return null;
    // Cada parte va de −3 a +3. El factor deja el total en ±6 falte o no una.
    return partes.reduce(function (a, b) { return a + b; }, 0) * (2 / partes.length);
  }

  /* El color se elige sobre la escala de ±15 de la suma vieja; para que la
     rampa siga repartiéndose igual, la flotación (±6) se estira ×2.5. */
  var COLOR_POR_FLOTA = 15 / 6;

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
    var cetes = typeof o.cetes === 'number' ? o.cetes : cetesRespaldo();
    var bench = typeof o.benchmarkAnual === 'number' ? o.benchmarkAnual : null;
    function eje(valor, fn) {
      return (typeof valor === 'number' && isFinite(valor)) ? acotar(fn(valor), -3, 3) : null;
    }
    /* RENDIMIENTO COMPUESTO, no aritmético. Contra CETES —que no fluctúa— la
       única comparación honesta es lo que de verdad se ganó por año. Usar la
       media aritmética de los rendimientos diarios por 252 sobrestima eso por
       el arrastre de la volatilidad, y el error NO es pequeño: medido, WALMEX
       salía +6.99% aritmético contra −5.68% compuesto, y ORBIA +0.2% contra
       −16.69%. La flotación decía "le gana a CETES" de carteras que en realidad
       componían por debajo, y el Cuadernillo, dos pantallas más abajo, decía
       lo contrario. Si no viene el compuesto se cae al aritmético, pero el
       backend ya lo manda para cartera, posiciones e índice. */
    var rend = (typeof m.rendimiento_cagr_pct === 'number' && isFinite(m.rendimiento_cagr_pct))
      ? m.rendimiento_cagr_pct : m.rendimiento_anualizado_pct;
    return {
      poder:      eje(rend, function (v) { return (v - cetes) / 5; }),
      eficiencia: eje(m.sharpe_ratio,               function (v) { return v * 2; }),
      calma:      eje(m.volatilidad_anual_pct,      function (v) { return (22 - v) / 6; }),
      aguante:    eje(m.max_drawdown_pct,           function (v) { return (30 - Math.abs(v)) / 10; }),
      mercado:    bench === null ? null
                : eje(rend, function (v) { return (v - bench) / 5; })
    };
  }

  /* Número con signo a un decimal. Se redondea ANTES de decidir el signo: con
     el signo sacado del valor crudo, −0.04 salía como "−0.0" y +0.03 como
     "+0.0", un cero con signo que parece error de captura. */
  /* Sin tasa explícita, la CETES vigente que ya leyó la app (window.MP_CETES_HOY,
     la misma del chip). El último respaldo es la de octubre de 2026; antes
     era un 9.5 fijo que para entonces ya no existía. */
  function cetesRespaldo() {
    if (typeof window !== 'undefined') {
      if (typeof window.MP_CETES_PERIODO === 'number') return window.MP_CETES_PERIODO;
      if (typeof window.MP_CETES_HOY === 'number') return window.MP_CETES_HOY;
    }
    return 6.01;
  }

  function firmado(v) {
    var r = Math.round(v * 10) / 10;
    return (r > 0 ? '+' : r < 0 ? '\u2212' : '') + Math.abs(r).toFixed(1);
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

    /* El color sale de flota(), no de la suma de los cinco: si no, un fondo
       de deuda que solo empata con CETES se pintaba de petróleo (ver la nota
       larga de flota()). Si no hay con qué calcularla, queda neutro. */
    var f = flota(puntajes);
    var color = f === null ? RAMPA[2] : colorDe(f * COLOR_POR_FLOTA);
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
        var txt = firmado(v);
        partes.push('<text x="' + centro(i).toFixed(1) + '" y="' + y.toFixed(1) + '">' + txt + '</text>');
      });
      partes.push('</g>');
    }

    /* Etiquetas de eje a Y FIJA, abajo del marco: así nunca chocan */
    if (P.etiquetas) {
      partes.push('<g font-family="var(--ff-sans)" font-size="9" font-weight="600" ' +
        'fill="var(--tinta-3)" text-anchor="middle">');
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
    var cetes = typeof o.cetes === 'number' ? o.cetes : cetesRespaldo();
    // El mismo rendimiento que puntuar(): si la frase dijera el aritmético y
    // la figura el compuesto, se contradirían dentro del mismo bloque.
    var r = (typeof metricas.rendimiento_cagr_pct === 'number' && isFinite(metricas.rendimiento_cagr_pct))
      ? metricas.rendimiento_cagr_pct : metricas.rendimiento_anualizado_pct;
    var vivos = EJES.filter(function (e) { return puntajes[e.id] !== null && puntajes[e.id] !== undefined; });

    var peor = null, mejor = null;
    vivos.forEach(function (e) {
      if (peor === null || puntajes[e.id] < puntajes[peor.id]) peor = e;
      if (mejor === null || puntajes[e.id] > puntajes[mejor.id]) mejor = e;
    });

    /* SI GANA O NO lo dice la flotación (±6). QUÉ TAN MOVIDO fue el camino lo
       dicen CALMA y AGUANTE, que es justo para lo que sirven ahora que no
       levantan a nadie por encima de la línea. Los umbrales estaban sobre la
       suma de los cinco (±15) y "sin sustos" se lo llevaba cualquier cosa
       quieta, incluida una que no ganara nada. */
    var f = flota(puntajes);
    var camino = ['calma', 'aguante'].reduce(function (a, k) {
      return a + (typeof puntajes[k] === 'number' && isFinite(puntajes[k]) ? puntajes[k] : 0);
    }, 0);

    var cabeza;
    if (typeof r === 'number' && r < cetes) {
      // La tasa es lo que CETES PAGÓ en la misma ventana (compuesta), no la de
      // hoy: comparar cinco años contra la tasa de esta semana engañaba.
      cabeza = 'Rindió ' + r.toFixed(1) + '% al año. CETES pagó ' + cetes.toFixed(1) +
               '% en el mismo periodo, sin arriesgar nada.';
    } else if (f === null) {
      cabeza = 'No hay datos suficientes para compararlo contra CETES.';
    } else if (f >= 2.0) {
      cabeza = camino >= 0
        ? 'Le gana a CETES y lo hace sin sustos.'
        : 'Le gana a CETES, pero el camino es movido.';
    } else if (f >= 0.5) {
      cabeza = 'Le gana a CETES, pero no por mucho.';
    } else if (f >= -0.5) {
      /* Banda neutra. Sin ella, un fondo de deuda a −0.18 —que no le hace
         correr riesgo a nadie— recibía "No compensa el riesgo que te hace
         correr", que además de falso suena a regaño. */
      cabeza = 'Va prácticamente igual que CETES, que no te cuesta nada tener.';
    } else {
      cabeza = 'No compensa el riesgo que te hace correr.';
    }

    /* El fuerte solo se nombra si DE VERDAD es un fuerte, y lo mismo el
       fallo. Antes se tomaba el máximo y el mínimo a secas, así que a un
       activo con los cinco ejes en negativo se le decía "su fuerte es
       eficiencia" señalando el menos malo. */
    var fuerte = (mejor && puntajes[mejor.id] > 0.3) ? mejor : null;
    var flojo = (peor && peor.id !== (mejor && mejor.id) && puntajes[peor.id] < -0.3) ? peor : null;
    if (fuerte && flojo) {
      return cabeza + ' Su fuerte es ' + fuerte.art + '; donde falla es ' + flojo.art + '.';
    }
    if (fuerte) return cabeza + ' Su fuerte es ' + fuerte.art + '.';
    /* Suelto, "donde falla es el mercado" no funciona como oración. */
    if (flojo)  return cabeza + ' Su punto más débil es ' + flojo.art + '.';
    return cabeza;
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
    /* Entra quien tenga con qué calcular la flotación. Antes bastaba con UN
       eje cualquiera, así que un activo del que solo se supiera la
       volatilidad salía flotando por ser tranquilo. */
    var vivos = (barcos || []).filter(function (b) {
      return b && b.puntajes && flota(b.puntajes) !== null;
    });
    if (vivos.length < 2) return '';

    vivos.forEach(function (b) {
      b._total = flota(b.puntajes);          // ±6, ya normalizada
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

    var unidad = TOPE / 6;                   // la flotación va de −6 a +6
    var p = [];
    p.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" ' +
      'role="img" aria-label="Cada posición de la cartera medida contra CETES">');

    /* Rejilla cada 2 puntos de flotación. */
    p.push('<g stroke="var(--regla)" stroke-width="1">');
    [2, 4, 6].forEach(function (k) {
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
        '" height="' + alto.toFixed(1) + '" fill="' + colorDe(b._total * COLOR_POR_FLOTA) + '">' +
        '<title>' + esc(b.etq) + ' · ' +
        (b._peso && sumaCartera > 0 ? Math.round(b._peso / sumaCartera * 100) + '% de la cartera · ' : '') +
        firmado(b._total) +
        ' de 6 contra CETES</title></rect>');
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
        firmado(v) + '</text>');
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
          color: colorDe(b._total * COLOR_POR_FLOTA),
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
    var AGUA = TOPE + 22, HUECO = W < 460 ? 3 : 8;
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

    /* ROTAR SI NO CABE, NUNCA RECORTAR NI ABREVIAR A UN CÓDIGO.
       Aquí se imprimía el TICKER del ETF —XLK, XLI, XLRE— porque cabe en
       cualquier ancho. Pero eso no es el nombre de un sector: es el símbolo
       de un fondo de State Street, y nadie fuera del gremio sabe que XLRE son
       bienes raíces. Ahora se escribe el nombre, y si no entra de lado se
       gira. Con once sectores en un teléfono cada columna mide 27px, así que
       en móvil siempre girará; en escritorio, casi nunca.
       El 0.60 es el avance de IBM Plex Sans respecto al cuerpo. */
    var etqs = vivas.map(function (r) { return String(r.f.etq || ''); });
    var anchoMax = Math.max.apply(null, etqs.map(function (t) { return t.length; })) * CUERPO_ETQ * 0.60;
    var girar = anchoMax > an - 3;
    /* El pie deja sitio al rótulo: 26px tumbado, o lo que mida el más largo
       de pie, más aire. */
    var pie = girar ? Math.round(anchoMax) + 14 : 26;
    var H = AGUA + TOPE + pie;

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
      x += an + HUECO;
    });

    p.push('<line x1="0" y1="' + AGUA + '" x2="' + W + '" y2="' + AGUA +
      '" stroke="var(--tinta-1)" stroke-width="2"/>');

    p.push('<g font-family="var(--ff-sans)" font-size="' + CUERPO_ETQ + '" fill="var(--tinta-3)">');
    etqs.forEach(function (t, i) {
      var cx = i * (an + HUECO) + an / 2;
      if (girar) {
        p.push('<text transform="translate(' + cx.toFixed(1) + ',' + (H - 6) +
          ') rotate(-90)" text-anchor="start" dominant-baseline="central">' + esc(t) + '</text>');
      } else {
        p.push('<text x="' + cx.toFixed(1) + '" y="' + (H - 8) +
          '" text-anchor="middle">' + esc(t) + '</text>');
      }
    });
    p.push('</g>');
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

  /* ══════════════════════════════════════════════════════════════════════
     EL COPO — la marca, no la gráfica.
     ══════════════════════════════════════════════════════════════════════
     Las otras tres proyecciones EXPLICAN (barras que se leen eje por eje).
     Esta IDENTIFICA: un pentágono irregular cuya silueta cambia con el
     activo, para reconocerlo de un vistazo en una lista sin leer una cifra.
     Es el trabajo que hace el copo de Simply Wall St y que unas barras a 30px
     no hacen: a ese tamaño todas las barras se parecen, las siluetas no.

     LO QUE NO ES UN RADAR DE CHART.JS: el círculo punteado del centro es
     CETES. Un radar normal dibuja los ejes contra la nada y no dice dónde
     está el aprobado; aquí la punta que ROMPE el círculo le ganó a la tasa
     libre de riesgo y la que se queda dentro, no. Esa lectura —sin leyenda,
     sin números, sin tooltip— es la que justifica la forma.

     Vértices rectos y no curva suave: a 28px una curva se convierte en una
     mancha redonda y todas se parecen. Las esquinas son lo que distingue una
     silueta de otra cuando es pequeña. */
  function copo(puntajes, tam, etiqueta) {
    var S = acotar(Math.round(tam || 120), 20, 400);
    var cx = S / 2, cy = S / 2;
    /* ESCALA ASIMÉTRICA, y con motivo doble.
       Con un radio lineal (R0 + puntaje·K) el −3 caía en negativo y se
       aplastaba contra el mínimo: a 30px, AMXB y CEMEX salían como dos motas
       idénticas de 1.6px que se leían como "falta el dato", no como "va mal".
       Y en el otro extremo la lineal exagera, porque el ojo lee ÁREA y el
       área crece con el cuadrado del radio.
       Así que el +3 sube hasta 0.40·S (llena la caja) y el −3 baja solo hasta
       0.085·S: pequeño pero todavía una forma con sus cinco esquinas. A
       0.055 seguía siendo una mota de 3px de ancho a tamaño de fila. */
    var R0    = S * 0.15;          // radio de CETES: el puntaje 0 cae aquí
    var K_MAS = (S * 0.40 - R0) / 3;
    var K_MEN = (R0 - S * 0.085) / 3;

    var vivos = EJES.filter(function (e) {
      return puntajes[e.id] !== null && puntajes[e.id] !== undefined;
    });
    if (vivos.length < 3) return '';   // con menos de tres no hay polígono

    /* Los ángulos se reparten entre los ejes QUE HAY, no entre los cinco: con
       un hueco fijo, a un activo sin benchmark le salía una muesca que se leía
       como "va muy mal en mercado" en vez de "no hay dato". */
    var paso = 2 * Math.PI / vivos.length;
    var pts = vivos.map(function (e, i) {
      var a = -Math.PI / 2 + i * paso;
      var v = puntajes[e.id];
      var r = R0 + v * (v >= 0 ? K_MAS : K_MEN);
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });

    var f = flota(puntajes);
    var color = f === null ? RAMPA[2] : colorDe(f * COLOR_POR_FLOTA);
    var p = [];
    p.push('<svg viewBox="0 0 ' + S + ' ' + S + '" style="width:100%;height:auto;display:block;overflow:visible" ' +
      'role="img" aria-label="' + esc(etiqueta || 'Perfil del activo contra CETES') + '">');
    /* CETES primero: queda debajo del polígono, así que solo se ve asomar por
       donde el activo NO llega. Ese hueco es el dato. */
    /* A tamaño de fila el punteado se vuelve una sucesión de medios píxeles y
       desaparece: por debajo de 44px el círculo va continuo. Sigue diciendo lo
       mismo y se ve. */
    var guion = S >= 44
      ? ' stroke-dasharray="' + (S * 0.030).toFixed(2) + ' ' + (S * 0.025).toFixed(2) + '"'
      : '';
    p.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + R0.toFixed(1) +
      '" fill="none" stroke="var(--tinta-1)" stroke-width="' +
      Math.max(S * 0.013, 0.9).toFixed(2) + '" stroke-opacity="' + (S >= 44 ? 1 : 0.65) + '"' +
      guion + '/>');
    p.push('<polygon points="' + pts.map(function (q) {
      return q[0].toFixed(1) + ',' + q[1].toFixed(1);
    }).join(' ') + '" fill="' + color + '" fill-opacity="0.88" stroke="' + color +
      '" stroke-width="' + (S * 0.016).toFixed(2) + '" stroke-linejoin="round"/>');
    p.push('</svg>');
    return p.join('');
  }

  window.MP_FLOTACION = {
    ejes: EJES,
    puntuar: puntuar,
    dibujar: dibujar,
    veredicto: veredicto,
    flota: flota,
    ayudaEje: ayudaEje,
    colorDe: colorDe,
    copo: copo,
    regata: regata,
    marea: marea
  };
})();
