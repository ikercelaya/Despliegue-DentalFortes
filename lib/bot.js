// Orquestador del chatbot: une Supabase (CRM) + detección de idioma + Claude.
// Expone handleMessage(), usado tanto por el chat web como por WhatsApp.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { supabase } = require("./db");
const { detectLanguage } = require("./i18n");
const { buildSystemPrompt } = require("./prompt");
const { runAgent, isConfigured } = require("./claude");

const KNOWLEDGE_BASE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "info", "Dental Fortes.txt"), "utf8");
  } catch (_e) {
    return "Clínica Dental Fortes, Sant Boi de Llobregat.";
  }
})();

// ---------------- Persistencia ----------------
async function getOrCreateConversation({ channel, phone, token, name, email, language }) {
  // Web: continuidad por access_token (el widget lo guarda entre mensajes).
  if (channel === "web" && token) {
    const { data } = await supabase
      .from("df_conversations").select("*").eq("access_token", token).maybeSingle();
    if (data) return data;
  }
  // WhatsApp: continuidad por teléfono + canal.
  if (channel !== "web" && phone) {
    const { data: existing } = await supabase
      .from("df_conversations")
      .select("*")
      .eq("customer_phone", phone)
      .eq("channel", channel)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
  }
  const { data, error } = await supabase
    .from("df_conversations")
    .insert({
      channel,
      customer_phone: phone || null,
      customer_name: name || null,
      customer_email: email || null,
      language: language || "es",
      status: "active",
      bot_enabled: true,
      access_token: channel === "web" ? token || crypto.randomUUID() : null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function saveMessage(conversationId, role, content) {
  if (!content) return;
  await supabase.from("df_messages").insert({ conversation_id: conversationId, role, content });
}

async function loadHistory(conversationId, limit = 20) {
  const { data } = await supabase
    .from("df_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  return (data || [])
    .filter((m) => m.content)
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
}

async function findOrCreatePatient({ phone, name }) {
  if (phone) {
    const { data: existing } = await supabase
      .from("df_patients").select("id").eq("phone", phone).limit(1).maybeSingle();
    if (existing) return existing.id;
  }
  const { data, error } = await supabase
    .from("df_patients")
    .insert({ full_name: name || "Paciente (bot)", phone: phone || null })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

function parseStart(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------- Herramientas ----------------
function buildTools(conversation) {
  const source = conversation.channel === "whatsapp" ? "bot_whatsapp" : "bot_web";

  return [
    {
      definition: {
        name: "buscar_paciente",
        description:
          "Comprueba si el paciente ya existe en el CRM buscándolo por su nombre completo, para reutilizar sus datos y no volver a pedírselos. Úsala SIEMPRE en cuanto tengas el nombre, antes de pedir más datos.",
        input_schema: {
          type: "object",
          properties: {
            nombre_completo: { type: "string", description: "Nombre completo del paciente" },
          },
          required: ["nombre_completo"],
        },
      },
      run: async (input) => {
        const q = String(input.nombre_completo || "").trim();
        if (!q) return "Indica el nombre completo para poder buscar.";
        const { data: matches } = await supabase
          .from("df_patients")
          .select("id, full_name, phone, email, patient_state, tags")
          .ilike("full_name", `%${q}%`)
          .limit(5);
        if (!matches || !matches.length) {
          return `No consta ningún paciente con el nombre "${q}". Trátalo como PACIENTE NUEVO: pídele los datos que falten (teléfono y motivo).`;
        }
        const top = matches[0];
        // Enlaza la conversación con el paciente encontrado (contexto en el panel).
        await supabase.from("df_conversations").update({
          patient_id: top.id,
          customer_name: top.full_name,
          customer_phone: top.phone || conversation.customer_phone,
        }).eq("id", conversation.id);
        // Últimas citas del paciente para dar contexto.
        const { data: appts } = await supabase
          .from("df_appointments")
          .select("starts_at, status, df_treatments(name)")
          .eq("patient_id", top.id)
          .order("starts_at", { ascending: false })
          .limit(3);
        const lista = matches
          .map((m) => `- ${m.full_name} · tel: ${m.phone || "sin teléfono"} · estado: ${m.patient_state || "-"}`)
          .join("\n");
        const hist = (appts || [])
          .map((a) => `  · ${new Date(a.starts_at).toLocaleDateString("es-ES")} (${a.status})${a.df_treatments?.name ? " — " + a.df_treatments.name : ""}`)
          .join("\n");
        return (
          `PACIENTE YA REGISTRADO en la clínica:\n${lista}\n` +
          (hist ? `Citas recientes de ${top.full_name}:\n${hist}\n` : "") +
          `Salúdale por su nombre, dale la bienvenida como paciente conocido y NO vuelvas a pedir los datos que ya constan (el teléfono confírmalo, no lo pidas de cero). Pregunta solo lo que falte (motivo y día/hora preferidos).`
        );
      },
    },
    {
      definition: {
        name: "crear_cita",
        description:
          "Registra una primera visita PENDIENTE de confirmar por recepción. Úsala solo cuando el paciente haya confirmado día y hora concretos y tengas su nombre y teléfono.",
        input_schema: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre completo del paciente" },
            telefono: { type: "string", description: "Teléfono de contacto" },
            motivo: { type: "string", description: "Motivo de la visita" },
            es_paciente_nuevo: { type: "boolean", description: "true si es paciente nuevo" },
            fecha_hora_inicio: {
              type: "string",
              description: "Inicio de la cita en formato ISO local, p. ej. 2026-07-06T10:00 (hora de Madrid)",
            },
            duracion_min: { type: "integer", description: "Duración en minutos (por defecto 30)" },
            notas: { type: "string", description: "Notas adicionales (opcional)" },
          },
          required: ["nombre", "telefono", "motivo", "fecha_hora_inicio"],
        },
      },
      run: async (input) => {
        const start = parseStart(input.fecha_hora_inicio);
        if (!start) return "Fecha/hora no válida. Pide al paciente que confirme el día y la hora.";
        const dur = Number(input.duracion_min) || 30;
        const end = new Date(start.getTime() + dur * 60000);
        const patientId = await findOrCreatePatient({ phone: input.telefono, name: input.nombre });

        await supabase.from("df_conversations").update({
          patient_id: patientId,
          customer_name: input.nombre || conversation.customer_name,
          customer_phone: input.telefono || conversation.customer_phone,
        }).eq("id", conversation.id);

        const { error } = await supabase.from("df_appointments").insert({
          patient_id: patientId,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          status: "pending",
          is_first_visit: true,
          source,
          notes: [input.motivo, input.notas].filter(Boolean).join(" · ") || null,
        });
        if (error) return "No se ha podido registrar la cita: " + error.message;
        return "Cita registrada como PENDIENTE de confirmación. Recepción la confirmará. Comunícaselo al paciente.";
      },
    },
    {
      definition: {
        name: "marcar_urgencia",
        description:
          "Avisa a recepción de una urgencia con dolor real para que llame al paciente con prioridad. Úsala tras pedir nombre y teléfono.",
        input_schema: {
          type: "object",
          properties: {
            nombre: { type: "string" },
            telefono: { type: "string" },
            resumen: { type: "string", description: "Breve resumen de la urgencia" },
          },
          required: ["telefono", "resumen"],
        },
      },
      run: async (input) => {
        await supabase.from("df_conversations").update({
          is_urgent: true,
          customer_name: input.nombre || conversation.customer_name,
          customer_phone: input.telefono || conversation.customer_phone,
        }).eq("id", conversation.id);
        return "Urgencia marcada y recepción avisada. Dile al paciente que le llamarán lo antes posible en horario de clínica.";
      },
    },
    {
      definition: {
        name: "derivar_humano",
        description: "Pasa la conversación a una persona del equipo cuando no puedas resolverlo tú.",
        input_schema: {
          type: "object",
          properties: { motivo: { type: "string" } },
          required: ["motivo"],
        },
      },
      run: async () => {
        await supabase.from("df_conversations").update({ bot_enabled: false }).eq("id", conversation.id);
        return "Conversación derivada a una persona del equipo. Despídete indicando que alguien continuará la conversación.";
      },
    },
  ];
}

// ---------------- Entrada principal ----------------
async function handleMessage({ channel, phone, token, name, email, text }) {
  const language = detectLanguage(text);
  const conversation = await getOrCreateConversation({ channel, phone, token, name, email, language });

  await saveMessage(conversation.id, "user", text);

  // Bot pausado (un humano ha tomado el control): no respondemos automáticamente.
  if (conversation.bot_enabled === false) {
    return { reply: null, conversation, botDisabled: true, language: conversation.language };
  }

  if (!isConfigured()) {
    const fallback =
      language === "ca"
        ? "Gràcies pel seu missatge. De seguida l'atendrà una persona del nostre equip."
        : "Gracias por su mensaje. En breve le atenderá una persona de nuestro equipo.";
    await saveMessage(conversation.id, "assistant", fallback);
    return { reply: fallback, conversation, language, notConfigured: true };
  }

  const [{ data: professionals }, { data: treatments }] = await Promise.all([
    supabase.from("df_professionals").select("*, df_professional_schedules(*)").order("name"),
    supabase.from("df_treatments").select("*").order("name"),
  ]);

  const system = buildSystemPrompt({
    knowledgeBase: KNOWLEDGE_BASE,
    professionals: professionals || [],
    treatments: treatments || [],
  });

  const history = await loadHistory(conversation.id);
  const tools = buildTools(conversation);

  const { text: reply } = await runAgent({ system, messages: history, tools });
  const finalReply = reply || (language === "ca"
    ? "Disculpi, ho pot repetir?"
    : "Disculpe, ¿me lo puede repetir?");

  await saveMessage(conversation.id, "assistant", finalReply);
  return { reply: finalReply, conversation, language };
}

module.exports = { handleMessage, getOrCreateConversation, saveMessage };
