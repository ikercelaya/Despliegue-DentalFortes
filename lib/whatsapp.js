// Cliente de WhatsApp Cloud API (Meta) — verificación de webhook, parseo de
// mensajes entrantes y envío de texto. Usa el fetch global de Node 18+.

const crypto = require("crypto");

const GRAPH = "https://graph.facebook.com/v21.0";

function isConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// Handshake de verificación del webhook (GET). Devuelve el challenge si coincide.
function verifyChallenge(query = {}) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// Verifica la firma X-Hub-Signature-256 (solo si hay WHATSAPP_APP_SECRET).
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // sin secret configurado, no se verifica
  if (!signatureHeader || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch (_e) {
    return false;
  }
}

// Extrae los mensajes entrantes del payload del webhook.
// Devuelve [{ from, name, text, id, button, unsupported }]
// - text: mensajes de texto (o el título del botón pulsado, para reutilizar el flujo normal).
// - button: { payload, text } cuando el paciente pulsa un botón de una plantilla
//   (quick_reply -> type "button"; botón interactivo -> "interactive".button_reply).
function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const nameByWa = {};
      for (const c of value.contacts || []) nameByWa[c.wa_id] = c.profile?.name;
      for (const m of value.messages || []) {
        const base = { from: m.from, name: nameByWa[m.from] || null, id: m.id };
        if (m.type === "text") {
          out.push({ ...base, text: m.text?.body || "" });
        } else if (m.type === "button") {
          // Botón de RESPUESTA RÁPIDA de una plantilla (quick reply).
          const text = m.button?.text || null;
          out.push({ ...base, text, button: { payload: m.button?.payload || null, text } });
        } else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
          // Botón interactivo (mensajes interactivos, no plantilla).
          const br = m.interactive.button_reply || {};
          out.push({ ...base, text: br.title || null, button: { payload: br.id || null, text: br.title || null } });
        } else if (m.type === "image" && m.image?.id) {
          // Foto del paciente (p. ej. de su boca). Se descarga con fetchMedia(id).
          out.push({ ...base, text: m.image.caption || null, media: {
            id: m.image.id, kind: "image", mime: m.image.mime_type || "image/jpeg",
            caption: m.image.caption || null, filename: null,
          } });
        } else if (m.type === "document" && m.document?.id) {
          // Documento adjunto (PDF, informe, etc.).
          out.push({ ...base, text: m.document.caption || null, media: {
            id: m.document.id, kind: "document", mime: m.document.mime_type || "application/octet-stream",
            caption: m.document.caption || null, filename: m.document.filename || null,
          } });
        } else {
          out.push({ ...base, text: null, unsupported: m.type });
        }
      }
    }
  }
  return out;
}

// Envía un mensaje de texto por WhatsApp.
async function sendText(to, text) {
  if (!isConfigured()) throw new Error("WhatsApp no configurado (falta token o phone number id).");
  const url = `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.WHATSAPP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body: String(text).slice(0, 4000) },
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`WhatsApp send ${r.status}: ${detail}`);
  }
  return r.json().catch(() => ({}));
}

// Envía un mensaje de PLANTILLA (obligatorio para escribir fuera de la ventana de 24h,
// que es el caso de una campaña de marketing a una lista). languageCode debe coincidir con
// el de la plantilla aprobada en Meta (p. ej. "es_ES"). bodyParams son los valores de las
// variables {{1}}, {{2}}… del cuerpo (en orden); si la plantilla no tiene variables, vacío.
// urlButton: { index, param } para las plantillas con un botón de enlace DINÁMICO
// (p. ej. "Confirmar mi cita": Meta guarda la URL con {{1}} al final y aquí se manda
// el trozo que falta, distinto para cada cita).
async function sendTemplate(to, templateName, languageCode, bodyParams = [], urlButton = null) {
  if (!isConfigured()) throw new Error("WhatsApp no configurado (falta token o phone number id).");
  const url = `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })) }]
    : [];
  if (urlButton && urlButton.param != null && urlButton.index != null) {
    components.push({
      type: "button", sub_type: "url", index: String(urlButton.index),
      parameters: [{ type: "text", text: String(urlButton.param) }],
    });
  }
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data?.error?.error_user_msg || data?.error?.message || `WhatsApp ${r.status}`;
    throw new Error(detail);
  }
  return data;
}

// Envía un documento (PDF, etc.) por su URL pública. Se usa, p. ej., para mandar el PDF de
// consentimiento cuando el paciente pulsa "Leer más".
async function sendDocument(to, documentUrl, filename, caption) {
  if (!isConfigured()) throw new Error("WhatsApp no configurado (falta token o phone number id).");
  const url = `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const doc = { link: documentUrl };
  if (filename) doc.filename = filename;
  if (caption) doc.caption = String(caption).slice(0, 1000);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "document", document: doc }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`WhatsApp document ${r.status}: ${detail}`);
  }
  return r.json().catch(() => ({}));
}

// Descarga un adjunto recibido (imagen/documento) de la Cloud API: primero se pide
// la URL temporal del medio y luego el binario, ambos con el token de acceso.
async function fetchMedia(mediaId) {
  if (!isConfigured()) throw new Error("WhatsApp no configurado (falta token o phone number id).");
  const headers = { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN };
  const metaR = await fetch(`${GRAPH}/${mediaId}`, { headers });
  if (!metaR.ok) throw new Error(`WhatsApp media ${metaR.status}: ${await metaR.text().catch(() => "")}`);
  const meta = await metaR.json();
  if (!meta?.url) throw new Error("WhatsApp media: la API no devolvió la URL del archivo.");
  const fileR = await fetch(meta.url, { headers });
  if (!fileR.ok) throw new Error(`WhatsApp media download ${fileR.status}`);
  const buffer = Buffer.from(await fileR.arrayBuffer());
  return { buffer, mime: meta.mime_type || "application/octet-stream", fileSize: meta.file_size || buffer.length };
}

// Envía una imagen por su URL pública (para que recepción mande fotos al paciente).
async function sendImage(to, imageUrl, caption) {
  if (!isConfigured()) throw new Error("WhatsApp no configurado (falta token o phone number id).");
  const url = `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const image = { link: imageUrl };
  if (caption) image.caption = String(caption).slice(0, 1000);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`WhatsApp image ${r.status}: ${detail}`);
  }
  return r.json().catch(() => ({}));
}

module.exports = { isConfigured, verifyChallenge, verifySignature, parseIncoming, sendText, sendTemplate, sendDocument, fetchMedia, sendImage };
