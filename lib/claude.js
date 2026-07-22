// Integración con la API de Claude (Anthropic) — bucle de tool use manual.
// Modelo configurable con ANTHROPIC_MODEL (por defecto claude-sonnet-5).

const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 2048);
const MAX_TURNS = 6; // límite de iteraciones de herramientas por respuesta

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// La API rechaza (400 invalid_request_error) los bloques de texto VACÍOS. Claude, al ir
// directo a una herramienta (p. ej. buscar_paciente o solicitar_cancelacion), a veces emite
// un bloque {type:"text", text:""} antes del tool_use; si reenviamos ese contenido tal cual,
// la siguiente llamada falla y el bot deja de responder. Estas funciones limpian el contenido
// dejando intactos los tool_use / tool_result y eliminando SOLO los bloques de texto vacíos.
function cleanContent(content) {
  if (typeof content === "string") return content.trim() ? content : "...";
  if (!Array.isArray(content)) return content;
  const cleaned = content.filter((b) => {
    if (b && b.type === "text") return typeof b.text === "string" && b.text.trim().length > 0;
    return true; // conserva tool_use, tool_result y cualquier otro bloque
  });
  return cleaned.length ? cleaned : [{ type: "text", text: "..." }];
}

// Sanea TODA la conversación justo antes de enviarla a la API (defensa en profundidad:
// garantiza que ningún bloque de texto vacío llegue nunca a Anthropic, venga de donde venga).
function sanitizeMessages(msgs) {
  return (msgs || []).map((m) => ({ role: m.role, content: cleanContent(m.content) }));
}

// tools: [{ definition: {name, description, input_schema}, run: async (input) => string }]
// messages: [{ role, content }]  (content string o array de bloques)
async function runAgent({ system, messages, tools = [] }) {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY no configurada.");

  const toolDefs = tools.map((t) => t.definition);
  const toolMap = Object.fromEntries(tools.map((t) => [t.definition.name, t.run]));
  const convo = messages.slice();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await c.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: sanitizeMessages(convo), // se envía siempre saneado
        ...(toolDefs.length ? { tools: toolDefs } : {}),
      });
    } catch (err) {
      // Log detallado para diagnosticar (incluye el cuerpo del error de la API).
      console.error("[runAgent] messages.create error", err && err.status, err && err.message);
      throw err;
    }

    convo.push({ role: "assistant", content: cleanContent(resp.content) });

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
      let contentStr = typeof result === "string" ? result : JSON.stringify(result);
      if (!contentStr || !contentStr.trim()) contentStr = "(sin datos)"; // la API rechaza contenido vacío
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: contentStr,
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
