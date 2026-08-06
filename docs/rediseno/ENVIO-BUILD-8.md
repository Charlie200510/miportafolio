# Envío del build 8 — checklist

Estado al preparar: todo el código está en `main` (`8b7d287`), en GitHub y en la
VM. Build number en **8** en los dos targets. Producción verificada.

Lo que sigue **solo lo puedes hacer tú**, porque requiere tu firma y tus
credenciales.

---

## 1. Archivar y subir

```bash
cd ~/Desktop/portafolio-app/ios-app && npx cap open ios
```

En Xcode:

1. Selecciona el esquema **App** y el destino **Any iOS Device (arm64)**.
2. **Product → Archive**.
3. En el Organizer: **Distribute App → App Store Connect → Upload**.

**Lo que puede fallar y no pude probar por ti:** el widget es un target nuevo con
bundle ID propio, `app.miportafolio.WidgetMercados`. La primera vez que archives,
Xcode tiene que registrarlo en el portal de Apple. Con **Automatic signing** lo
hace solo; si tienes firma manual, créalo antes en
*Certificates, Identifiers & Profiles → Identifiers*.

Verifiqué que compila en Release para dispositivo (`-sdk iphoneos`) sin errores,
así que si algo truena será de firma, no de código.

---

## 2. Cuenta de demostración — **bloqueante**

La app exige registro. Sin credenciales que funcionen, App Review rechaza sin
llegar a evaluar nada.

La cuenta es `carbarser05@gmail.com`. La contraseña **no se escribe aquí**: este
archivo está en git y se sube a GitHub. Cópiala directo al formulario.

En *App Review Information*:

- [ ] **Sign-in required** marcado
- [ ] Correo y contraseña de la cuenta demo
- [ ] Probar la cuenta **el mismo día del envío**

### El trial y su reloj

La cuenta va en **trial**, no en premium: así el revisor ve el estado de prueba
y puede llegar al paywall, que es lo que necesita evaluar para el 3.1.2.

El riesgo de eso es que el trial **caduca a los 14 días**. Si expira a media
revisión, el revisor queda fuera con un paywall bloqueante y eso es un rechazo
por 2.1. Se reinició el reloj el 2026-08-06, así que corre hasta el
**2026-08-20**.

Si el envío se retrasa, o si hay rechazo y reenvío, **reinícialo otra vez**:

```bash
ssh -i ~/Downloads/oci-portafolio-2026.key ubuntu@140.84.165.219 'cd ~/portafolio-app/backend/_datos && cp sesiones.json sesiones.json.bak.$(date +%Y%m%d-%H%M%S) && python3 -c "import json,time; p=\"sesiones.json\"; d=json.load(open(p)); d[\"usuarios\"][\"carbarser05@gmail.com\"][\"creado_en\"]=time.time(); json.dump(d,open(p,\"w\"),ensure_ascii=False,indent=2); print(\"trial reiniciado: 14 dias\")"'
```

Para comprobar cuántos días quedan:

```bash
curl -s -X POST https://miportafolio.uk/api/auth/ingresar -H 'Content-Type: application/json' -d '{"email":"carbarser05@gmail.com","password":"LA_CONTRASENA"}' | python3 -m json.tool | grep dias_restantes
```

### Los datos que verá el revisor

Las transacciones **no viven en la cuenta**, viven en el `localStorage` del
dispositivo. Darle credenciales al revisor no le da datos: al instalar de cero
la app le sale vacía y el ISR, el tax-loss y el P&L salen en cero — justo las
pantallas que sostienen el argumento contra el 4.3(a).

Por eso el onboarding ahora ofrece **"Ver un portafolio de ejemplo"**, que carga
una cartera de la BMV con diez operaciones reales. Con eso el revisor llega a
cifras pobladas en dos toques y sin capturar nada.

Dilo explícitamente en las notas de revisión, o puede no encontrarlo.

---

## 3. Capturas — el error más fácil de cometer

Tienen que salir de la **app nativa**, no del sitio web. La prueba de que están
bien: **se ve la barra de pestañas abajo** (Periódico · Portafolio · Analizar ·
ISR · Cuenta). Si mandas capturas sin ella, el revisor ve exactamente la app que
ya rechazó.

Orden sugerido (las tres primeras son las que salen en resultados de búsqueda):

1. **Widget en la pantalla de inicio** — mantén pulsada la pantalla → **+** →
   busca "Mi Portafolio" → añade **Mercados MX**. Es la prueba visual de que hay
   app nativa, que es justo lo que el 4.3(a) pone en duda.
2. **ISR y tax-loss harvesting** — pestaña ISR.
3. **Cuadernillo México** — pantalla principal, arriba del todo.
4. Portada con titular · 5. Periódico · 6. CETES y FIBRAS · 7. Stress test
   México · 8. Brokers mexicanos · 9. Optimizador · 10. Mi cuenta.

El guion completo con captions está en `APP_STORE_LISTING.md`.

---

## 4. Metadata

Todo listo para copiar desde `APP_STORE_LISTING.md`:

- Nombre, subtítulo, texto promocional, keywords y descripción — **encabezan con
  ISR**, que es la diferenciación ante el revisor.
- **Notas para App Review**: hay un bloque listo para pegar que responde al
  4.3(a) de frente, enumerando lo que no existe en apps comparables y la capa
  nativa. El revisor no conoce el mercado mexicano y no va a deducirlo.

---

## Qué cambió respecto al build 7

**Capa nativa** (ataca la vía del binario, que es la más probable del rechazo):

| | |
|---|---|
| Widget de WidgetKit | IPC, USD/MXN, S&P y CETES 28d en la pantalla de inicio |
| Barra de pestañas nativa | UIKit, con el router JS existente; no recarga páginas |
| Face ID / Touch ID | Opt-in, con velo antes del snapshot del app switcher |
| Swift propio | 49 líneas → 672 · 1 target → 2 |

**Identidad visual**: rediseño editorial completo (Source Serif 4 + IBM Plex
Sans/Mono empaquetadas, paleta de tinta y papel, cero sombras y gradientes).

**Correcciones encontradas en el camino**:

- `Infinity` en top-movers rompía el JSON y dejaba el panel en "Respuesta vacía";
  más una red de seguridad para que ningún endpoint pueda volver a emitir JSON
  inválido.
- Diversificación del optimizador salía negativa por una fórmula invertida
  (−62% → 53.7%).
- 27 botones sólidos se veían deshabilitados por una regla CSS mía.
- 311–371px de scroll horizontal en iPhone (bug previo al rediseño).
- Los perfiles sugeridos llevaban tiempo ocultos; vuelven con acceso directo.
- El deploy revertía los precios semanas y servía cachés del código anterior.

---

## Cómo revertir

Todo está en `main`. El estado anterior al rediseño es `6c9efb0`:

```bash
cd ~/Desktop/portafolio-app && git checkout 6c9efb0
```

Para volver producción a ese punto habría que resetear `main` y correr
`deploy/pull.sh` en la VM. El bundle de iOS no viaja con git: hay que
resincronizar con `npm run cap:sync:ios` después de cambiar de commit.
