# Conectar los cobros de MercadoPago

El código ya está completo y desplegado. Lo único que falta son **dos secretos**
que solo tú puedes poner, porque son credenciales de tu cuenta.

Hoy la web corre en **modo simulado**: el botón de suscribirse devuelve un
checkout ficticio y nadie puede pagar de verdad.

```bash
curl -s https://miportafolio.uk/api/payments/estado
```

Mientras diga `"mock_mode": true`, no hay cobros reales.

---

## Lo que hace falta

| Variable | De dónde sale |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Panel de MercadoPago → *Tus integraciones* → tu aplicación → **Credenciales de producción** → *Access token* |
| `MERCADOPAGO_WEBHOOK_SECRET` | La misma aplicación → *Webhooks* → **Clave secreta** |

Las dos están definidas en la VM pero **vacías**. Con el token vacío no hay
cobros; con el secreto vacío y `STRICT_WEBHOOKS=1`, el servidor rechaza todas
las notificaciones, así que un pago real nunca activaría el plan.

---

## 1. Registrar el webhook en MercadoPago

En *Tus integraciones → tu aplicación → Webhooks*, en **modo productivo**:

- **URL:** `https://miportafolio.uk/api/payments/webhook`
- **Evento:** marca únicamente **Planes y suscripciones** (`preapproval`).

Al guardar, MercadoPago genera la **clave secreta**. Cópiala: es el segundo
valor que necesitas.

## 2. Poner los dos valores en la VM

Córrelo tú, para que los secretos no pasen por ningún otro lado. Sustituye lo
que va entre comillas:

```bash
ssh -i ~/Downloads/oci-portafolio-2026.key ubuntu@140.84.165.219
```

Ya dentro de la VM:

```bash
cd ~/portafolio-app/deploy && cp .env .env.bak.$(date +%Y%m%d-%H%M%S) && nano .env
```

Completa las dos líneas que ya existen y guarda con `Ctrl+O`, `Enter`, `Ctrl+X`:

```
MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
MERCADOPAGO_WEBHOOK_SECRET=...
```

No pongas comillas alrededor de los valores: el arranque del servicio lee este
archivo línea por línea y las comillas quedarían dentro del valor.

## 3. Reiniciar y comprobar

```bash
sudo systemctl restart miportafolio && sleep 8 && curl -s https://miportafolio.uk/api/payments/estado
```

Tiene que responder `"mock_mode": false` y `"disponible": true`.

---

## 4. Probar un cobro de verdad

Necesitas una **cuenta de MercadoPago distinta a la tuya**: la plataforma no te
deja suscribirte a ti mismo. Usa una cuenta de prueba del panel de MercadoPago,
o pide a alguien más que lo intente.

1. Entra a la app con una cuenta cuyo trial haya vencido, o pulsa *Suscríbete*.
2. Completa el pago en el checkout de MercadoPago.
3. Vuelves a `https://miportafolio.uk/?paid=1`.
4. En un minuto el plan debe pasar a premium.

Si no cambia, mira el registro del webhook:

```bash
ssh -i ~/Downloads/oci-portafolio-2026.key ubuntu@140.84.165.219 'journalctl -u miportafolio -n 60 --no-pager | grep -i webhook'
```

Y la bitácora que guarda la app:

```bash
ssh -i ~/Downloads/oci-portafolio-2026.key ubuntu@140.84.165.219 'python3 -m json.tool ~/portafolio-app/backend/_datos/pagos.json | tail -40'
```

Un `"error": "firma_invalida"` ahí significa que el secreto del `.env` no es el
mismo que el del panel.

---

## Lo que conviene saber

**Un solo plan en web.** MercadoPago cobra **$65 MXN al mes** y nada más. En iOS
hay tres (mensual, anual e ilimitado) porque los cobra Apple vía RevenueCat. Si
quieres el anual también en web, hay que crear un segundo preapproval; hoy no
existe.

**Los dos canales conviven.** El plan del usuario lo puede activar MercadoPago
(web) o RevenueCat (iOS), y ambos escriben sobre el mismo campo. Una persona que
pagó en iOS y entra en la web aparece premium, y al revés.

**El precio vive en la VM,** en `MERCADOPAGO_PRECIO_MXN`. Cambiarlo solo afecta
a las suscripciones nuevas: las que ya existen conservan su monto.

**No actives `AUTH_MOCK_MODE` en producción.** Habilita el endpoint que simula
una aprobación, y con eso cualquiera se regala premium. Hoy no está definido,
que es lo correcto.
