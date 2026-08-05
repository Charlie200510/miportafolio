# Rediseño editorial — respuesta al rechazo 4.3(a)

Rama: **`rediseno-editorial`**. Nada de esto toca `main`, ni producción, ni el
build number (sigue en **7**).

Dirección: **terminal financiera × prensa económica mexicana**. La app deja de
parecerse a una plantilla de dashboard y pasa a leerse como la primera plana de
un diario financiero: masthead con regla doble, cintilla de mercados, secciones
con etiqueta monoespaciada y regla, cifras en monoespaciada tabular, colofón con
fuentes de datos.

---

## 1. Dirección tipográfica

Tres roles, sin excepción. Las tres familias están **empaquetadas en
`frontend/fonts/`** como `.woff2` con subsets `latin` + `latin-ext`
(`unicode-range`), `font-display: swap`. Cero Google Fonts, cero CDN de
tipografía: la app nativa arranca sin red y se ve igual.

| Rol | Familia | Por qué |
|---|---|---|
| Titulares y cifras protagonistas | **Source Serif 4** (variable, OFL 1.1) | Serif transicional de Adobe con eje de *optical size*: aguanta 44 px de titular y 17 px de texto corrido sin engordar. Su contraste alto y sus mayúsculas ligeramente estrechas leen a cabecera de diario, no a "startup con serif". Es lo que da la voz editorial. |
| Números, tickers, %, etiquetas técnicas | **IBM Plex Mono** (OFL 1.1) | Cifras tabulares reales por diseño y cero con barra: es una mono de datos, no de código decorativo. Le da el registro de terminal financiera. |
| Texto corrido de UI | **IBM Plex Sans** (variable 400–700, OFL 1.1) | **Comparte esqueleto con Plex Mono**: eso es lo que hace que UI y datos se sientan un solo sistema en vez de dos fuentes pegadas. El contraste fuerte queda reservado al serif. |

Peso en disco: **573 KB** los 12 archivos; en una página en español solo bajan
los subsets `latin` (~190 KB típico). El `<head>` hace `preload` de los tres
subsets latin que sí se usan.

**Los números nunca bailan.** `.tabular` (313 usos que ya existían en el markup)
se convirtió en el gancho del sistema: aplica `font-variant-numeric: tabular-nums
lining-nums`. Toda celda de tabla lo hereda aunque no lleve la clase.

Licencias OFL incluidas en `frontend/fonts/OFL-*.txt` (obligatorio al
redistribuir).

## 2. Dirección de color — tinta y papel

Base cálida, con sesgo amarillo, no el negro azulado genérico anterior.

| Token | Valor | Contraste sobre fondo | Uso |
|---|---|---|---|
| `--tinta` | `#0B0B0A` | — | fondo de página |
| `--tinta-panel` | `#131210` | — | celda / panel |
| `--regla` | `#2A2721` | — | hairline |
| `--regla-fuerte` | `#4A443A` | — | regla de sección |
| `--papel` | `#F2EEE4` | **17.0:1** | titulares, cifras |
| `--papel-2` | `#CFC8B8` | **11.8:1** | texto corrido |
| `--papel-3` | `#9A9284` | **6.4:1** | meta, etiquetas |
| `--papel-4` | `#847D70` | **4.8:1** | texto tenue (mínimo AA) |
| `--sello` | `#D79A3C` | **8.0:1** | **acento único** |
| `--alza` | `#6FAE7E` | **7.5:1** | dirección de mercado ▲ |
| `--baja` | `#DB7B68` | **6.6:1** | dirección de mercado ▼ |

**Todo pasa AA para texto normal** (≥ 4.5:1), medido sobre `--tinta` y también
sobre `--tinta-panel`. Tinta sobre el sello sólido: 6.4:1.

### Por qué el acento es ámbar y no verde nopal

Las dos opciones que planteaste eran válidas, pero **verde y ámbar no eran
equivalentes aquí**: el verde ya tiene un trabajo asignado — dirección de
mercado — y el brief exige que verde/rojo no sean nunca decorativos. Un acento
verde habría hecho que el mismo color signifique "toca aquí" en un botón y "esto
subió" en una cifra, a dos centímetros de distancia.

El **ámbar de tinta de sello (`#D79A3C`)** resuelve la colisión y además encaja
en la metáfora: es el color de un sello de goma sobre papel, y contra la tinta
cálida se lee a periódico, no a plantilla. Verde y rojo quedan reservados: solo
aparecen en variaciones, direcciones y el heatmap de sectores.

### Geometría

Radios **0–2 px**, **cero sombras**, **cero gradientes**, **cero
glassmorphism**. Se aplica desde el propio tema de Tailwind (`borderRadius`,
`boxShadow`) para no pelear con `!important` en las utilidades ya repartidas, y
con un neutralizado en CSS solo donde hay estilos inline. Hairlines de 0.5 px
(1 px en pantallas no-retina). Transiciones de 120–160 ms, sin rebotes ni
escalados.

---

## 3. Cómo está construido (y por qué no rompió nada)

Es un **reskin**, no una reestructuración. La navegación, el orden de las
pestañas, los IDs, las clases-hook y la lógica de negocio están intactos.

1. **`frontend/css/mp-tokens.css`** — `@font-face` + variables + neutralizado.
2. **`frontend/css/mp-editorial.css`** — componentes: masthead, regla doble,
   cintilla, `.mp-sec` (etiqueta + regla), colofón, celdas hairline, tablas,
   toasts, modales, tooltips, estados vacíos/error, marcas de línea.
3. **Remapeo del tema de Tailwind** en `index.html`, `landing.html`,
   `signup.html`, legales y blog: las mismas utilidades pasan a pintar tinta y
   papel. `zinc` se redefinió porque concentraba **1,606 usos** — era el
   verdadero motor cromático de la app.
4. **`MP_GRAFICA` en `app.js`** — un solo objeto de configuración reutilizado
   por las **13** gráficas: líneas de 1.5–2 px, benchmark punteado, sin
   gridlines verticales en tiempo, sin relleno de gradiente, etiquetas mono,
   ejes recesivos.

Las rutas de fuentes dentro del CSS son **relativas** (`../fonts/`) a propósito:
`sync-www` reescribe `/static/` → `/` en html/js/webmanifest pero **no en
`.css`**, así que una ruta absoluta se habría roto dentro del bundle de
Capacitor. Verificado en `ios/App/App/public/`.

---

## 4. Tabla de verificación por viewport

Medido con un harness sobre CDP (`Page.captureScreenshot` +
`elementFromPoint` para hit-testing real), recorriendo las 8 vistas en cada
combinación. Datos crudos en `verificacion-antes.json` y
`verificacion-despues.json`.

| Dispositivo | Viewport | Orientación | Overflow ANTES | Overflow DESPUÉS | Elementos desbordados ANTES | DESPUÉS | Hit-test header |
|---|---|---|---|---|---|---|---|
| iPhone SE / mini | 375×667 | vertical | **358 px** | **0 px** | portafolio:6 · transacciones:34 | — | ok |
| iPhone SE / mini | 667×375 | horizontal | **371 px** | **0 px** | — | — | ok |
| iPhone 14/15 | 390×844 | vertical | **351 px** | **0 px** | portafolio:6 · transacciones:34 | — | ok |
| iPhone 14/15 | 844×390 | horizontal | 0 px | 0 px | — | — | ok |
| iPhone Pro Max | 430×932 | vertical | **311 px** | **0 px** | portafolio:6 · transacciones:34 | — | ok |
| iPhone Pro Max | 932×430 | horizontal | 0 px | 0 px | — | — | ok |
| iPad mini/air | 820×1180 | vertical | 0 px | 0 px | — | — | ok |
| iPad mini/air | 1180×820 | horizontal | 0 px | 0 px | — | — | ok |
| iPad Pro 12.9 | 1180×1024 | vertical | 0 px | 0 px | — | — | ok |
| iPad Pro 12.9 | 1024×1180 | horizontal | 0 px | 0 px | — | — | ok |

También comprobado a **320 px** (iPhone SE 1.ª gen): 0 px de overflow, ambos
botones del header dentro de pantalla y tocables.

### Dos bugs de layout que ya existían y quedaron arreglados

El harness los encontró midiendo el estado **anterior**, no son regresiones del
rediseño:

1. **`.nav-tab` filtraba `white-space: nowrap`.** En `ux_helpers.js` la regla
   móvil de las pestañas aplicaba `nowrap`, `padding` y `min-height: 44px` a
   *todo* `.nav-tab` — y `.nav-tab` no es solo la pestaña, es el **hook de
   ruteo de `bindNav()`**, así que también lo llevan tarjetas de contenido
   dentro de `<main>`. Sus párrafos no podían romper línea: los botones medían
   713 px en un viewport de 390. Ahora las reglas están ancladas a
   `#mp-topbar`.
   *De paso:* esos selectores apuntaban a `nav.sticky`, y desde que header y
   sub-nav se pegaron como un bloque el sticky vive en `#mp-topbar` — llevaban
   tiempo sin aplicar a nada.
2. **Hijos de grid sin `min-width: 0`** en la vista de transacciones: el
   `min-content` de la tabla interna empujaba la retícula fuera del viewport.

Como red de seguridad estructural, `main { overflow-x: clip }`: la página no
puede hacer scroll horizontal pase lo que pase con lo que inyecte el JS
(`clip` no crea contexto de scroll, así que no rompe el `sticky` de
`#mp-topbar`, que vive fuera de `main`).

---

## 5. Lo que ya estaba arreglado para App Review — sigue en pie

Verificado por script en las 8 vistas (`scratchpad/apple.mjs`):

| Requisito | Estado |
|---|---|
| 2.1(b) · "Suscribirse" visible y tocable en todas las pestañas | ✓ las 8 |
| 5.1.1(v) · "Mi cuenta" visible y tocable en todas las pestañas | ✓ las 8 |
| Sub-nav nunca detrás del header | ✓ ninguna vista |
| 2.2 · El Periódico carga contenido sin interacción | ✓ 9,951 car., 0 "Cargando", 0 elementos invisibles |
| 3.1.2 · Paywall abre al instante | ✓ 1.3 s |
| Paywall nativo: 3 planes | ✓ Mensual $65 · Anual $650 · Ilimitado $6,500 |
| Paywall nativo: "Restaurar compra" | ✓ |
| Paywall: Términos y Privacidad | ✓ |
| Cero mención de MercadoPago en nativo | ✓ (solo en la rama web) |
| Cero etiquetas de versión "beta" | ✓ |
| Cero asistente IA (2.3.1) | ✓ |

Área táctil de los botones del header: **77×44** y **92×44** en iPhone,
117×32 / 108×32 en iPad. Texto completo, nunca truncado.

---

## 6. Capturas

`antes/` y `despues/`, mismas 6 pantallas, mismo viewport (430×932 @2x) y mismo
portafolio de ejemplo, para que la comparación sea pareja.

| Archivo | Pantalla |
|---|---|
| `01-principal.png` | Mi portafolio (portada + Cuadernillo México) |
| `02-analisis.png` | Analizar |
| `03-paywall.png` | Paywall (rama web) |
| `03b-paywall-nativo.png` | Paywall nativo: 3 planes + Restaurar *(solo "después")* |
| `04-mi-cuenta.png` | Mi cuenta |
| `05-periodico.png` | Periódico / mercados |
| `06-isr.png` | Transacciones e ISR |

Abre `comparar.html` en el navegador para verlas lado a lado.

---

## 7. Cómo revertir

Todo está **commiteado en la rama** `rediseno-editorial` (commit `ad7e681`), y
`main` quedó intacto. Un solo comando devuelve el estado anterior:

```bash
cd ~/Desktop/portafolio-app && git checkout main
```

`frontend/css/`, `frontend/fonts/` y `docs/rediseno/` están versionados en la
rama, así que ese checkout los quita solo — no hay que borrar nada a mano.

**El bundle de iOS es la única pieza que no viaja con git** (`ios-app/www/` y
`ios-app/ios/App/App/public/` no están rastreados, son artefactos de build).
Cambiar de rama no los toca, así que hay que resincronizar estando en `main`:

```bash
cd ~/Desktop/portafolio-app/ios-app && LANG=en_US.UTF-8 npm run cap:sync:ios
```

Para volver al rediseño, lo mismo al revés:

```bash
cd ~/Desktop/portafolio-app && git checkout rediseno-editorial
cd ios-app && LANG=en_US.UTF-8 npm run cap:sync:ios
```

Si además quieres que los navegadores que ya cargaron la versión nueva vuelvan
a la vieja, hay que bajar `VERSION` en `frontend/sw.js` (de `mp-v1.12.0` a
`mp-v1.11.8`) — el checkout de `main` ya lo hace.
