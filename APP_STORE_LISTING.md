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
- **Usuario y contraseña** de una cuenta real, ya con **acceso premium activo**
  (el backend tiene `acceso_permanente` por cuenta justo para esto) y con
  **transacciones cargadas** — si la cuenta va vacía, el ISR y el tax-loss
  salen en cero y la pantalla que sostiene todo el argumento se ve hueca.
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
2. Entra con una cuenta que tenga **premium activo y transacciones cargadas**,
   o el ISR y el tax-loss salen en cero y la captura #1 pierde toda la fuerza.
3. Usa un iPhone 16/17 Pro Max (o su simulador) para el 6.7"/6.9".
4. Modo oscuro es el único modo de la app: no hay que configurar nada.
5. Espera a que la cintilla de mercados cargue (IPC, S&P, USD/MXN, CETES) antes
   de disparar; con guiones se ve rota.

**Notas para App Review (campo *Notes*) — cópialas tal cual:**

Este campo es donde se responde al 4.3(a). El revisor no conoce la estructura
del mercado mexicano y no va a deducirla: hay que decírsela.

```
Esta app fue rechazada antes bajo 4.3(a). A continuación, en qué se diferencia
de otras apps de la categoría.

FUNCIONES QUE NO EXISTEN EN NINGUNA APP COMPARABLE
· ISR mexicano: cálculo del impuesto sobre enajenación de acciones en bolsa
  según el art. 129 de la LISR, con costo promedio por emisora, ganancia
  realizada del ejercicio y pérdidas arrastrables a 10 años.
· Tax-loss harvesting con reglas mexicanas (compensación dentro del mismo
  ejercicio fiscal).
· Comparativa contra las SIEFOREs del sistema de AFOREs, con los rendimientos
  que publica la CONSAR. Es un sistema de pensiones obligatorio exclusivo de
  México.
· CETES de Banxico como tasa libre de riesgo en el cálculo de Sharpe, en lugar
  de los Treasuries de EE. UU.
· FIBRAS de la Bolsa Mexicana de Valores.
· Comparativa de comisiones entre casas de bolsa mexicanas (GBM, Kuspit,
  Actinver y otras).
· Stress tests con eventos de México: crisis del peso, elección de 2018 y
  cancelación del NAIM, aranceles a México.

CAPA NATIVA (no es un envoltorio de sitio web)
· Widget de WidgetKit en la pantalla de inicio con IPC, USD/MXN y CETES 28 días.
· Barra de pestañas nativa de UIKit; la navegación no recarga páginas.
· Bloqueo con Face ID / Touch ID mediante LocalAuthentication, opcional.
· Notificaciones push, haptics y hoja de compartir del sistema.

ACCESO
La app requiere cuenta y suscripción. Las credenciales de prueba están en este
mismo formulario y ya tienen acceso completo y transacciones cargadas para que
las pantallas de ISR muestren datos reales.

OTROS
No ejecuta operaciones ni mueve dinero, y nunca solicita credenciales bancarias
ni de casa de bolsa. Es una herramienta educativa y de análisis; no es asesoría
de inversión y así se declara dentro de la app. "Suscribirse" está en el
encabezado de todas las pestañas y "Mi cuenta" permite eliminar la cuenta en
dos toques.
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
