/* mp_resena.js — decide CUÁNDO pedir la calificación en la App Store.
 *
 * El diálogo lo controla Apple: aunque se pida diez veces, iOS lo muestra como
 * mucho tres veces al año y a veces no lo muestra nunca. Como no hay forma de
 * saber si apareció, cada petición que se gasta en mal momento es una que no
 * se recupera. Por eso el "cuándo" se decide aquí y con criterios estrictos.
 *
 * LAS REGLAS Y POR QUÉ
 * --------------------
 *  · Solo en la app nativa. En web el canal no existe.
 *  · Nunca antes del cuarto arranque ni de los tres días desde la instalación.
 *    Quien acaba de entrar no tiene opinión todavía, y una reseña pedida a
 *    destiempo suele ser de una estrella.
 *  · Solo con cartera de verdad: al menos dos posiciones guardadas. Sin datos
 *    propios la app no ha hecho nada por esa persona.
 *  · Nunca junto a un error ni a un muro de pago. Se pide en un momento bueno
 *    —terminar de ver el análisis de la cartera— y con unos segundos de margen
 *    para que el usuario vea el resultado antes de que salte el diálogo.
 *  · Como mucho una vez cada 120 días, y como mucho tres veces en total. Aunque
 *    iOS ya limita, contar aquí evita gastar los tres intentos del año en la
 *    misma semana.
 *
 * Guía 1.1 de App Store: no puede haber un botón "califícanos" que dispare
 * esto. El usuario pulsaría y no pasaría nada, porque lo decide el sistema.
 */
(function () {
  'use strict';

  var K = 'mp.resena.v1';
  var MIN_ARRANQUES   = 4;
  var MIN_DIAS        = 3;
  var MIN_POSICIONES  = 2;
  var DIAS_ENTRE      = 120;
  var MAX_PETICIONES  = 3;
  var ESPERA_MS       = 2500;   // que vea el resultado antes del diálogo

  function leer() {
    try { return JSON.parse(localStorage.getItem(K) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function guardar(d) {
    try { localStorage.setItem(K, JSON.stringify(d)); } catch (_) {}
  }

  function canal() {
    try {
      var h = window.webkit && window.webkit.messageHandlers
              && window.webkit.messageHandlers.mpResena;
      return (h && h.postMessage) ? h : null;
    } catch (_) { return null; }
  }

  function posiciones() {
    try {
      var t = JSON.parse(localStorage.getItem('miPortafolio.tickers.v1') || '[]');
      return Array.isArray(t) ? t.length : 0;
    } catch (_) { return 0; }
  }

  /* Se cuenta en cada carga de la app, haya o no reseña de por medio. */
  function contarArranque() {
    var d = leer();
    d.arranques = (d.arranques || 0) + 1;
    if (!d.primerUso) d.primerUso = Date.now();
    guardar(d);
  }

  function toca() {
    if (!canal()) return false;
    var d = leer();
    if ((d.peticiones || 0) >= MAX_PETICIONES) return false;
    if ((d.arranques || 0) < MIN_ARRANQUES) return false;
    if (!d.primerUso) return false;
    var dias = (Date.now() - d.primerUso) / 86400000;
    if (dias < MIN_DIAS) return false;
    if (d.ultima && (Date.now() - d.ultima) / 86400000 < DIAS_ENTRE) return false;
    if (posiciones() < MIN_POSICIONES) return false;
    return true;
  }

  /* Lo llama la app cuando acaba de pasar algo bueno. No hace nada si no toca,
   * así que quien lo invoca no necesita conocer ninguna de las reglas. */
  function quizaPedir() {
    if (!toca()) return;
    var h = canal();
    if (!h) return;
    var d = leer();
    d.peticiones = (d.peticiones || 0) + 1;
    d.ultima = Date.now();
    guardar(d);                       // se apunta ANTES: si el diálogo tarda o
                                      // la app se cierra, no se vuelve a pedir
    setTimeout(function () {
      try { h.postMessage({ accion: 'pedir' }); } catch (_) {}
    }, ESPERA_MS);
  }

  contarArranque();
  window.mpQuizaPedirResena = quizaPedir;
})();
