// Envío de correo con Resend (https://resend.com). Se usa para mandar campañas por
// email además de por WhatsApp. Con la clave basta para empezar:
//   RESEND_API_KEY   -> la clave de la cuenta (empieza por "re_"). Es lo único obligatorio.
//   RESEND_FROM      -> (opcional) remitente propio, p. ej. "Dental Fortes <hola@tudominio.com>".
//                       El buzón NO tiene que existir: basta con que el DOMINIO esté
//                       verificado en Resend. Si no se indica, se usa el remitente de
//                       pruebas de Resend, que SOLO entrega al correo de tu cuenta.
//   RESEND_REPLY_TO  -> (opcional) dónde llegan las respuestas de los pacientes.

const RESEND_API = "https://api.resend.com/emails";
// Remitente de pruebas de Resend: no requiere dominio verificado, pero Resend solo lo
// entrega a la dirección con la que te registraste. Sirve para comprobar el envío.
const TEST_FROM = "Dental Fortes <onboarding@resend.dev>";

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function resendFrom() {
  return process.env.RESEND_FROM || process.env.EMAIL_FROM || TEST_FROM;
}

// true cuando se está usando el remitente de pruebas (sin dominio propio): los correos
// solo llegarán a tu propia dirección, no a los pacientes.
function isTestSender() {
  return resendFrom() === TEST_FROM;
}

function resendReplyTo() {
  return process.env.RESEND_REPLY_TO || process.env.EMAIL_REPLY_TO || "";
}

// Convierte el texto plano de la campaña en un HTML sencillo y legible, con la
// cabecera de la clínica. Los saltos de línea se respetan.
function buildHtml({ text, headerText, footerText, title }) {
  const esc = (s) => String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parrafos = esc(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f6fb;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2733">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 6px 24px -12px rgba(30,50,90,.25)">
    <div style="font-size:18px;font-weight:700;margin-bottom:18px;color:#2f3c52">${esc(headerText || title || "Dental Fortes")}</div>
    <div style="font-size:15px;color:#374151">${parrafos}</div>
    ${footerText ? `<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e8ecf3;font-size:12.5px;color:#7a8699">${esc(footerText)}</div>` : ""}
    <div style="margin-top:18px;font-size:11.5px;color:#9aa4b2">
      Dental Fortes · Sant Boi de Llobregat<br>
      Si no desea recibir más comunicaciones comerciales, responda a este correo indicando "BAJA MARKETING".
    </div>
  </div>
</body></html>`;
}

// Envía un correo. Devuelve el id del mensaje de Resend.
async function sendEmail({ to, subject, text, headerText, footerText, replyTo }) {
  if (!isConfigured()) throw new Error("Resend no está configurado (falta RESEND_API_KEY).");
  if (!to) throw new Error("Falta el destinatario.");
  const payload = {
    from: resendFrom(),
    to: [to],
    subject: String(subject || "Dental Fortes").slice(0, 200),
    text: String(text || ""),
    html: buildHtml({ text, headerText, footerText, title: subject }),
  };
  const responder = replyTo || resendReplyTo();
  if (responder) payload.reply_to = responder;

  const r = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data?.message || data?.error?.message || `Resend ${r.status}`;
    throw new Error(detail);
  }
  return data?.id || null;
}

module.exports = { isConfigured, sendEmail, resendFrom, resendReplyTo, isTestSender, buildHtml };
