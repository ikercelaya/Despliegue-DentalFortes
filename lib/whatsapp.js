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
// Devuelve [{ from, name, text, id, unsupported }]
function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const nameByWa = {};
      for (const c of value.contacts || []) nameByWa[c.wa_id] = c.profile?.name;
      for (const m of value.messages || []) {
        const base = { from: m.from, name: nameByWa[m.from] || null, id: m.id };
        if (m.type === "text") out.push({ ...base, text: m.text?.body || "" });
        else out.push({ ...base, text: null, unsupported: m.type });
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

module.exports = { isConfigured, verifyChallenge, verifySignature, parseIncoming, sendText };
