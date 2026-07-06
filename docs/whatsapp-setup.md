# 📱 Conectar WhatsApp (Meta Cloud API) — número de PRUEBAS

Endpoints ya implementados en el CRM:
- `GET /api/whatsapp/webhook` → verificación (handshake de Meta).
- `POST /api/whatsapp/webhook` → recepción de mensajes (usa el mismo motor del bot).

## Variables de entorno (Vercel)
| Variable | De dónde sale |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Cadena que inventas tú (la misma en Vercel y en Meta). |
| `WHATSAPP_TOKEN` | Token de acceso (temporal 24h en pruebas; permanente en Fase 7). |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número (Meta → WhatsApp → Configuración de la API). |
| `WHATSAPP_APP_SECRET` | App → Configuración → Básica → *Clave secreta de la app* (opcional, recomendado). |

## Orden de pasos
1. **Despliega** el CRM con estos endpoints (este zip).
2. En **Meta → WhatsApp → Configuración de la API**: apunta el **Phone Number ID**, el
   **WABA ID**, copia el **token temporal** y añade tu móvil como **destinatario de prueba**.
3. En **Vercel**: pon las 4 variables de arriba → **Redeploy**.
4. En **Meta → WhatsApp → Configuración → Webhook**: Callback URL
   `https://TU-DOMINIO.vercel.app/api/whatsapp/webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`
   → **Verificar y guardar** → suscríbete al campo **messages**.
5. **Prueba:** desde tu móvil registrado, envía un WhatsApp al número de pruebas de Meta.

## Notas
- Recomendado `ANTHROPIC_MODEL=claude-haiku-4-5` en WhatsApp: respuesta rápida para no
  agotar el tiempo de la función serverless.
- El número de pruebas se cambia por el real (de Juan) en Fase 7: solo cambian
  `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`; el código no se toca.
