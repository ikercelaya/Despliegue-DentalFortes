// Integración con la API de Claude (Anthropic) — bucle de tool use manual.
// Modelo configurable con ANTHROPIC_MODEL (por defecto claude-sonnet-5).

const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024);
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

// tools: [{ definition: {name, description, input_schema}, run: async (input) => string }]
// messages: [{ role, content }]  (content string o array de bloques)
async function runAgent({ system, messages, tools = [] }) {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY no configurada.");

  const toolDefs = tools.map((t) => t.definition);
  const toolMap = Object.fromEntries(tools.map((t) => [t.definition.name, t.run]));
  const convo = messages.slice();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: convo,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
    });

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
