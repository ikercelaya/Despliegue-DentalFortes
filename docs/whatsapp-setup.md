# 📱 Conectar WhatsApp (Meta Cloud API) — número de PRUEBAS

Endpoints ya implementados en el CRM:
- `GET /api/whatsapp/webhook` → verificación (handshake de Meta).
- `POST /api/whatsapp/webhook` → recepción de mensajes (usa el mismo motor del bot).

## Variables de entorno (Vercel)
| Variable | De dónde sale |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Cadena que inventas tú (la misma en Vercel y en Meta). |
| `WHATSAPP_TOKEN` | Token de acceso con permisos de WhatsApp (temporal 24h en pruebas; permanente en producción). |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA ID / WhatsApp Business Account ID. Necesario para crear plantillas desde el CRM. |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número (Meta → WhatsApp → Configuración de la API). |
| `WHATSAPP_APP_SECRET` | App → Configuración → Básica → *Clave secreta de la app* (opcional, recomendado). |

## Crear plantillas de WhatsApp desde el CRM

El botón **Marketing → Crear plantilla** llama a Meta con:

`POST https://graph.facebook.com/<versión>/<WHATSAPP_BUSINESS_ACCOUNT_ID>/message_templates`

Requisitos previos en Meta:

1. Entra en [business.facebook.com](https://business.facebook.com) con el Business Manager propietario de Dental Fortes.
2. Comprueba que el negocio tiene una **Cuenta de WhatsApp Business (WABA)** conectada y un número activo.
3. En **Meta for Developers → tu app → WhatsApp → Configuración de la API**, copia:
   - **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`.
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
4. Crea o usa un token permanente de sistema:
   - Business Settings → **Usuarios → Usuarios del sistema**.
   - Crea/asigna un usuario del sistema a la app.
   - Dale acceso al activo de WhatsApp.
   - Genera token para la app con permisos de WhatsApp, incluyendo `whatsapp_business_management` y `whatsapp_business_messaging`.
   - Ese token va en `WHATSAPP_TOKEN`.
5. En Vercel, añade/actualiza `WHATSAPP_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID` y `WHATSAPP_PHONE_NUMBER_ID`, y redeploya.

Notas de uso:

- Meta revisa las plantillas. Al crearlas desde el CRM pueden quedar en estado `PENDING` hasta que Meta las apruebe.
- En el texto de plantilla usa variables de Meta como `{{1}}`, `{{2}}`; no uses variables tipo `{{nombre}}`.
- Si usas variables, rellena ejemplos en el modal para que Meta pueda revisar la plantilla.
- El nombre de plantilla debe ir en minúsculas, sin espacios ni acentos; el CRM lo normaliza con guiones bajos.

## Orden de pasos
1. **Despliega** el CRM con estos endpoints (este zip).
2. En **Meta → WhatsApp → Configuración de la API**: apunta el **Phone Number ID**, el
   **WABA ID**, copia el **token temporal** y añade tu móvil como **destinatario de prueba**.
3. En **Vercel**: pon las variables de arriba → **Redeploy**.
4. En **Meta → WhatsApp → Configuración → Webhook**: Callback URL
   `https://TU-DOMINIO.vercel.app/api/whatsapp/webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`
   → **Verificar y guardar** → suscríbete al campo **messages**.
5. **Prueba:** desde tu móvil registrado, envía un WhatsApp al número de pruebas de Meta.

## Notas
- Recomendado `ANTHROPIC_MODEL=claude-haiku-4-5` en WhatsApp: respuesta rápida para no
  agotar el tiempo de la función serverless.
- El número de pruebas se cambia por el real (de Juan) en Fase 7: solo cambian
  `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`; el código no se toca.
