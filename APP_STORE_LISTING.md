# Ficha de App Store — Mi Portafolio

> Copia cada campo en App Store Connect → tu app → **App Information** y **(versión) → App Store**.
> Respeta los límites de caracteres de Apple (indicados en cada campo).

> **Reescrita tras el rechazo por Guideline 4.3(a) — Design: Spam.** El eje de
> toda la ficha ya no es "app de portafolios" (categoría saturada) sino
> **análisis fiscal y de mercado para México**: ISR del art. 129 LISR,
> tax-loss harvesting, AFOREs/SIEFOREs, CETES, FIBRAS, brokers mexicanos y
> stress tests con eventos de México. Ese es el argumento de que la app no
> duplica a ninguna otra: nadie más hace estos cálculos con reglas mexicanas.

## Posicionamiento: dos canales, un solo producto

La ficha de App Store y el sitio web **no dicen lo mismo primero**, y es a
propósito. No hay contradicción: ambos describen funciones que la app tiene de
verdad; lo que cambia es qué se pone al frente en cada canal.

| Canal | Encabeza con | Por qué |
|---|---|---|
| **App Store** | ISR y reglas mexicanas | Es lo que separa la app de la categoría saturada ante el revisor, y "ISR acciones" / "declaración SAT inversiones" son búsquedas de alta intención con poca competencia. Peleando por "app de inversiones" compites contra GBM, Nu y Bitso. |
| **Landing web y experiencia in-app** | Análisis de portafolio | Es el pitch amplio, el que da mercado suficiente para vender. |

**Requisito para que esto funcione:** la metadata debe corresponder con lo que
el revisor ve al abrir (Guideline 2.3.1). Se cumple porque el ISR es visible de
inmediato: pestaña propia **ISR** en la barra nativa y **Sección A · Cuadernillo
México** arriba de todo en la pantalla principal. Si alguna vez se degrada esa
prominencia, hay que bajar el énfasis fiscal de la ficha en el mismo movimiento.

---

## ⚠️ ANTES DE ENVIAR — cuenta de demostración obligatoria

La app **exige registro** para usarse (decisión de producto: no hay modo libre).
Con eso, **App Review rechaza de inmediato si no puede entrar**. En
*App Review Information* hay que llenar, sin excepción:

- **Sign-in required:** ✅ marcado
- **Usuario y contraseña** de la cuenta demo (`carbarser05@gmail.com`). Va en
  **periodo de prueba**, no en premium, a propósito: así el revisor también
  alcanza el paywall y puede evaluar el flujo de suscripción.
- **Ojo con el reloj del trial:** caduca a los 14 días. Si expira a media
  revisión, el revisor queda fuera y eso es un rechazo por 2.1. Cómo
  reiniciarlo: `docs/rediseno/ENVIO-BUILD-8.md`.
- **Decirle cómo llegar a los datos.** Las carteras viven en el dispositivo, no
  en la cuenta, así que entrar no trae datos: la app arranca vacía y el ISR sale
  en cero. En las notas hay que mandarlo a *Portafolio → "Ver un portafolio de
  ejemplo"*, que carga diez operaciones reales de la BMV.
- Verificar que la cuenta funciona **el mismo día del envío**.

---

## Nombre de la app  (máx. 30 caracteres)
```
Mi Portafolio: ISR y Bolsa MX
```
*(29 car. Lidera con ISR — es la función que ninguna app comparable tiene y
la que separa la ficha del montón de "portfolio trackers".)*

Alternativas:
- `Mi Portafolio · ISR y AFORE` (27)
- `Mi Portafolio: Inversión MX` (27)

---

## Subtítulo  (máx. 30 caracteres)
```
ISR, AFOREs, CETES y brokers
```
*(28 car. Cuatro sustantivos que solo aplican en México: el subtítulo hace el
trabajo de diferenciación antes de que abran la descripción.)*

Alternativas:
- `Tu cartera con reglas del SAT` (29)
- `Impuestos y análisis mexicano` (29)

---

## Texto promocional  (máx. 170 caracteres · se puede cambiar sin re-enviar)
```
La única app que lee tu portafolio con reglas mexicanas: ISR del art. 129, tax-loss harvesting, tu AFORE, CETES y FIBRAS. 14 días gratis, sin tarjeta.
```
*(149 car.)*

---

## Keywords  (máx. 100 caracteres · separadas por coma, SIN espacios)
```
ISR,SAT,AFORE,SIEFORE,CETES,FIBRAS,BMV,broker,markowitz,dividendos,retiro,sharpe,acciones,declaracion
```
*(No repitas palabras que ya están en el nombre/subtítulo — Apple las indexa aparte.)*

---

## Descripción  (máx. 4000 caracteres)
```
Mi Portafolio es análisis de inversión escrito con las reglas de México. No es un rastreador de portafolios más: es la herramienta que calcula tu ISR, te compara contra tu AFORE y mide tu cartera contra CETES, con los datos y la ley que aplican aquí.

LO QUE SOLO ENCUENTRAS AQUÍ

• ISR mexicano automático. Calculamos el 10% sobre tus utilidades por enajenación de acciones en bolsa (art. 129 de la LISR), con costo promedio por emisora, ganancia realizada del ejercicio y pérdidas arrastrables a años futuros. Tu constancia fiscal deja de ser una caja negra.

• Tax-loss harvesting con reglas locales. Detectamos qué posiciones en pérdida puedes vender para compensar ganancias del mismo ejercicio, cuánto ISR te ahorras y cuánta pérdida queda para los diez años siguientes.

• Tu cartera contra tu AFORE. Comparamos tu rendimiento real contra las nueve SIEFOREs según tu edad, con los rendimientos que publica la CONSAR. Sabrás si vale la pena administrar tu dinero o dejarlo en el retiro.

• CETES como piso de riesgo. Tu Sharpe y tu spread se calculan contra la tasa de CETES 28 días de Banxico, no contra los Treasuries de Estados Unidos. Si tu portafolio no le gana a CETES, te lo decimos sin rodeos.

• FIBRAS de la BMV. Las diez principales ordenadas por yield, con precio, capitalización y posición en el rango de 52 semanas.

• Brokers mexicanos comparados. GBM, Kuspit, Actinver, Hapi y más: por cada ticker que necesitas comprar te decimos cuál te cobra menos comisión y cuál pide menos apertura.

• Stress tests con la historia de México. Crisis del peso, elección de 2018 y la cancelación del NAIM, COVID en México, súper mayoría de 2024 y aranceles a México. Además de COVID global, 2008 y punto-com.

• Calendario fiscal del SAT y curvas de rendimiento de CETES junto a las de Treasuries.

TU PERIÓDICO FINANCIERO, CADA DÍA
Cintilla de mercados con IPC, S&P 500, USD/MXN y CETES 28 días. Brief diario con los cierres, noticias de las emisoras que sí tienes, top movers del mercado y una acción del día por selección algorítmica.

EL ANÁLISIS COMPLETO
• Optimización Markowitz: qué porcentaje poner en cada emisora, frontera eficiente, máximo Sharpe y un slider de volatilidad objetivo.
• Riesgo profesional: VaR, CVaR, Sortino, Calmar, beta y máximo drawdown.
• Simulador de retiro con Monte Carlo (3,000 escenarios), ajustado por inflación y aportaciones recurrentes.
• Calificación 0-100 por acción, con dashboard de cinco años y valoración SML/CAPM.
• Más de 11,000 acciones (BMV, NYSE, NASDAQ, ETFs) y 190 criptomonedas.

TU INFORMACIÓN
Tu portafolio se guarda en tu dispositivo. Nunca te pedimos la contraseña de tu banco ni de tu casa de bolsa, y la app no mueve dinero: tú ejecutas en tu broker.

PRUEBA GRATIS
14 días gratis, sin tarjeta. Después, $65 MXN al mes. Cancela cuando quieras.

La suscripción se renueva automáticamente a menos que la canceles al menos 24 horas antes del fin del período. El pago se carga a tu cuenta de Apple. Puedes administrarla o cancelarla en Ajustes de tu cuenta.

Términos de uso: https://miportafolio.uk/terminos
Política de privacidad: https://miportafolio.uk/privacidad

Mi Portafolio es una herramienta educativa y de análisis. No somos asesor financiero registrado ante la CNBV y nada de lo que ves constituye una recomendación de inversión. Las decisiones y sus resultados son responsabilidad del usuario. Los cálculos de ISR son una estimación con reglas generales: tu constancia fiscal es la fuente oficial.
```
*(~3,180 caracteres.)*

---

## Screenshots — qué capturar y en qué orden

Apple muestra las **tres primeras** en los resultados de búsqueda. Por eso las
tres primeras tienen que gritar "México", no "otro dashboard de acciones".
Cada captura lleva un **caption quemado en la imagen** (texto grande arriba),
porque la mayoría de la gente no lee la descripción.

Tamaños obligatorios: **6.7"** (1290×2796, iPhone 15/16 Pro Max) y **6.5"**
(1242×2688). Si subes iPad: **12.9"** (2048×2732).

| # | Pantalla | Cómo llegar | Caption sugerido | Por qué va aquí |
|---|----------|-------------|------------------|-----------------|
| 1 | **ISR y tax-loss harvesting** | Pestaña *Transacciones e ISR* → baja a "ISR y tax-loss harvesting" | **“Tu ISR del art. 129, calculado solo”** | Es la función que ninguna app comparable tiene. Debe ser lo PRIMERO que ve el revisor y el usuario. |
| 2 | **Cuadernillo México** (pantalla principal) | *Mi portafolio*, arriba del todo: ISR, tax-loss, CETES, AFORE, FIBRAS y stress test en una retícula | **“Seis análisis que solo aplican en México”** | Demuestra de un vistazo que la propuesta es local, no genérica. |
| 3 | **Tu cartera vs tu AFORE** | *Mi portafolio* → celda "Tu cartera vs AFORE" (o la sección de Metas) | **“¿Le ganas a tu SIEFORE?”** | Comparación que ningún tracker internacional puede hacer. |
| 4 | **Portada con titular** | *Mi portafolio*, hero: titular en serif + cifra grande | **“Tu portafolio, contado como una nota”** | Muestra la identidad editorial nueva — es el antídoto visual al 4.3(a). |
| 5 | **Periódico / mercados** | Pestaña *Periódico* | **“IPC, S&P y peso, cada mañana”** | Cintilla + brief: la app tiene contenido propio diario. |
| 6 | **CETES y FIBRAS** | *Analizar* → subsección "FIBRAS y CETES" | **“CETES y FIBRAS, con datos de Banxico y BMV”** | Instrumentos mexicanos que no existen en apps de EE. UU. |
| 7 | **Stress test México** | *Analizar* → Stress test → escoge "Crisis del peso" o "Aranceles Trump a MX" | **“¿Y si vuelve una crisis del peso?”** | Escenarios locales, no los cuatro globales de siempre. |
| 8 | **Brokers mexicanos** | *Rebalanceo* → "Calcular costos por broker" | **“Qué broker mexicano te cobra menos”** | Utilidad concreta y verificable. |
| 9 | **Optimizador Markowitz** | *Analizar* → Optimizador | **“Frontera eficiente y máximo Sharpe”** | El rigor técnico, ya como respaldo. |
| 10 | **Mi cuenta** | Botón *Mi cuenta* del header | **“Tu cuenta, tu plan, y borrarla en dos toques”** | Refuerza 5.1.1(v) ante el revisor. |

**Captura EXTRA, y de las más importantes:**

| # | Pantalla | Cómo llegar | Caption sugerido | Por qué va aquí |
|---|----------|-------------|------------------|-----------------|
| 0 | **Widget en la pantalla de inicio** | Mantén pulsada la pantalla de inicio → **+** → busca "Mi Portafolio" → añade "Mercados MX" (tamaño mediano) | **“El peso y CETES sin abrir la app”** | Un widget es imposible en un envoltorio de sitio web. Es la prueba visual de que hay app nativa, que es justo lo que el 4.3(a) pone en duda. Ponla entre las tres primeras. |

**Antes de capturar — LEE ESTO:**
1. **Captura de la app NATIVA, no del sitio web.** Las capturas tienen que
   mostrar la **barra de pestañas nativa abajo** (Periódico · Portafolio ·
   Analizar · ISR · Cuenta). Si mandas capturas sin ella, el revisor ve
   exactamente la app que ya rechazó. Es el error más fácil de cometer aquí.
2. Entra y carga los datos con *Portafolio → "Ver un portafolio de ejemplo"*
   antes de disparar. Sin eso el ISR y el tax-loss salen en cero y la captura
   de la pantalla fiscal pierde toda la fuerza.
3. Usa un iPhone 16/17 Pro Max (o su simulador) para el 6.7"/6.9".
4. Modo oscuro es el único modo de la app: no hay que configurar nada.
5. Espera a que la cintilla de mercados cargue (IPC, S&P, USD/MXN, CETES) antes
   de disparar; con guiones se ve rota.

**Notas para App Review (campo *Notes*) — cópialas tal cual:**

Este campo es donde se responde al 4.3(a). El revisor no conoce la estructura
del mercado mexicano y no va a deducirla: hay que decírsela.

**Van en INGLÉS a propósito.** El equipo de App Review trabaja en inglés; unas
notas en español se leen por encima o pasan por un traductor automático, y ahí
se pierde justo el argumento que hay que defender. Cada término mexicano lleva
su explicación entre paréntesis —el revisor no tiene por qué saber qué es una
SIEFORE— y los textos de la interfaz van traducidos para que pueda encontrarlos
en una app que está en español.

```
This app was previously rejected under Guideline 4.3(a). Below is what
distinguishes it from other apps in this category.

Note: the app's interface is in Spanish, as it is built for the Mexican market.
Spanish UI labels are translated in parentheses throughout these notes.

FEATURES NO COMPARABLE APP OFFERS
Each item below is specific to Mexico and is absent from the portfolio trackers
this app may have been compared against.

· Mexican capital gains tax (ISR). Calculates the 10% tax on gains from selling
  listed shares under Article 129 of Mexico's Income Tax Law (LISR), including
  average cost basis per issuer, realized gain for the current fiscal year, and
  losses carried forward for up to 10 years.
· Tax-loss harvesting under Mexican rules, where losses may only offset gains
  within the same fiscal year.
· Benchmarking against SIEFOREs, the investment funds of Mexico's AFORE system
  (a mandatory national pension scheme that exists only in Mexico), using the
  official returns published by CONSAR, the federal pension regulator.
· CETES (short-term Mexican government treasury bills issued by Banxico, the
  central bank) used as the risk-free rate in Sharpe ratio calculations,
  instead of U.S. Treasuries.
· FIBRAS, the Mexican real estate investment trusts listed on the Mexican Stock
  Exchange (BMV).
· Commission comparison across Mexican brokerages: GBM, Kuspit, Actinver and
  others, per ticker.
· Stress tests built on Mexican events: the peso crisis, the 2018 election and
  the cancellation of the Mexico City airport (NAIM), COVID-19 in Mexico, the
  2024 legislative supermajority, and U.S. tariffs on Mexico.

NATIVE LAYER (this is not a web wrapper)
· A WidgetKit home screen widget showing the IPC index, USD/MXN, the S&P 500
  and the 28-day CETES rate. The tickers are configurable from inside the app.
· A native UIKit tab bar. Navigation does not reload pages.
· Optional Face ID / Touch ID lock built on LocalAuthentication.
· Push notifications, haptics, and the system share sheet.

SIGNING IN, AND HOW TO REACH THE TAX SCREENS
The app requires an account. Test credentials are provided in this same form.
That account is in its trial period with full access, so the paywall and the
subscription flow can be reviewed as well.

Portfolios are stored on the device rather than on the account, so signing in on
a new device starts with an empty app. To see the tax features populated with
data, open the "Portafolio" (Portfolio) tab and tap "Ver un portafolio de
ejemplo" (View a sample portfolio). It loads a Mexican Stock Exchange portfolio
containing ten real transactions. The "ISR" tab then shows the estimated tax for
the fiscal year and the tax-loss harvesting opportunities, already calculated.

OTHER
The app does not execute trades and does not move money. It never asks for bank
or brokerage credentials. It is an educational and analytical tool, not
investment advice, and states so inside the app. "Suscribirse" (Subscribe)
appears in the header of every tab, and "Mi cuenta" (My account) lets the user
delete their account in two taps.
```

---

## URLs
- **Support URL:** `https://miportafolio.uk`
- **Marketing URL** (opcional): `https://miportafolio.uk/landing`
- **Privacy Policy URL:** `https://miportafolio.uk/privacidad`

## Categoría
- **Primaria:** Finanzas (Finance)
- **Secundaria:** (opcional) Ninguna o Negocios

## Otros (se llenan en el cuestionario de ASC)
- **Age Rating:** responde el cuestionario → normalmente **4+** (no hay contenido restringido).
- **App Privacy (nutrition labels):** recopilas **correo electrónico** (para cuenta/alertas) y **datos de uso** — consistente con tu PrivacyInfo.
- **Cuenta demo para revisores** (en App Review Information): crea un usuario de prueba y pon sus credenciales, o apunta al modo demo `?demo=1`. Nota para el revisor: "App de análisis, no ejecuta operaciones reales; no constituye asesoría."
