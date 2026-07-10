// Integración con la API de Claude (Anthropic) — bucle de tool use manual.
// Modelo configurable con ANTHROPIC_MODEL (por defecto claude-opus-4-8).

const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const MAX_TOKENS = (() => {
  // Protege contra ANTHROPIC_MAX_TOKENS mal configurado (vacío, 0, NaN),
  // que provocaría un 400 de la API. Si no es válido, usa 1024.
  const n = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1024;
})();
const MAX_TURNS = 6; // límite de iteraciones de herramientas por respuesta

// La API de Anthropic exige que el historial cumpla ciertas reglas o devuelve 400:
//  - el PRIMER mensaje debe ser del usuario ("user")
//  - ningún mensaje puede tener contenido vacío
// El historial del CRM puede empezar por un mensaje del equipo (rol "admin",
// que mapeamos a "assistant") o del propio bot, así que lo saneamos aquí.
function sanitizeConversation(messages = []) {
  const cleaned = [];
  for (const m of messages || []) {
    if (!m) continue;
    const role = m.role === "user" ? "user" : "assistant";
    if (typeof m.content === "string") {
      const text = m.content.trim();
      if (!text) continue; // descarta contenido vacío (400)
      cleaned.push({ role, content: text });
    } else if (Array.isArray(m.content) && m.content.length) {
      cleaned.push({ role, content: m.content });
    }
  }
  // Descarta los mensajes iniciales que no sean del usuario.
  while (cleaned.length && cleaned[0].role !== "user") cleaned.shift();
  return cleaned;
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// tools: [{ definition: {name, description, input_schema}, run: async (input) => string }]
// messages: [{ role, content }]  (content string o array de bloques)
async function runAgent({ system, messages, tools = [] }) {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY no configurada.");

  const toolDefs = tools.map((t) => t.definition);
  const toolMap = Object.fromEntries(tools.map((t) => [t.definition.name, t.run]));
  const convo = sanitizeConversation(messages);

  // Sin ningún mensaje válido del usuario no hay nada que enviar (evita un 400).
  if (!convo.length) {
    return { text: "", stop_reason: "empty", messages: [] };
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await c.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: convo,
        ...(toolDefs.length ? { tools: toolDefs } : {}),
      });
    } catch (err) {
      // Aflora el detalle real de la API en los logs (Vercel) para diagnóstico.
      const detail =
        err?.error?.error?.message || err?.error?.message || err?.message || String(err);
      const reqId = err?.request_id || err?.headers?.["request-id"] || "";
      console.error(`[claude] messages.create ${err?.status || ""}: ${detail}${reqId ? " | request-id: " + reqId : ""}`);
      throw err;
    }

    convo.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const text = (resp.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text, stop_reason: resp.stop_reason, messages: convo };
    }

    // Ejecutar todas las herramientas solicitadas y devolver los resultados juntos.
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        const fn = toolMap[block.name];
        result = fn ? await fn(block.input || {}) : `Herramienta desconocida: ${block.name}`;
      } catch (err) {
        result = "Error al ejecutar la herramienta: " + err.message;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return {
    text: "Disculpe, ha habido una incidencia. Un momento, le atenderá una persona del equipo.",
    stop_reason: "max_turns",
    messages: convo,
  };
}

module.exports = { runAgent, isConfigured, MODEL };
