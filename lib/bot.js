// Orquestador del chatbot: une Supabase (CRM) + detección de idioma + Claude.
// Expone handleMessage(), usado tanto por el chat web como por WhatsApp.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { supabase } = require("./db");
const { detectLanguage } = require("./i18n");
const { buildSystemPrompt } = require("./prompt");
const { runAgent, isConfigured } = require("./claude");
const { resolveProfessional, assignCabinet, localWeekdayAndTime, addMinutes, matchesSpecialty, isGeneralist, MAX_CABINETS, CAPACITY_REASONS } = require("./scheduling");
const { ensurePaymentForAppointment } = require("./billing");

const KNOWLEDGE_BASE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "info", "Dental Fortes.txt"), "utf8");
  } catch (_e) {
    return "Clínica Dental Fortes, Sant Boi de Llobregat.";
  }
})();

// Reseñas: nota mínima para dirigir al paciente a Google; el resto se gestiona interno.
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || "https://dentalfortes.com/opiniones/";
const REVIEW_MIN_GOOGLE = 4.5;

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

async function loadHistory(conversationId, limit = 24) {
  const { data } = await supabase
    .from("df_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }) // los MÁS RECIENTES primero
    .limit(limit);
  // Vuelve a orden cronológico y descarta contenidos vacíos.
  const recent = (data || [])
    .filter((m) => m.content && String(m.content).trim())
    .reverse()
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content).trim() }));
  // La API de Claude exige que el primer mensaje sea del usuario y que los roles se
  // alternen. Descartamos assistant iniciales y fusionamos mensajes consecutivos del
  // mismo rol (evita el error 400 "invalid_request" en conversaciones largas).
  const msgs = [];
  for (const m of recent) {
    if (!msgs.length && m.role !== "user") continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

async function findOrCreatePatient({ phone, name, conversationId }) {
  // 1) Reutiliza el paciente YA vinculado a la conversación (fuente más fiable).
  //    Evita crear un paciente nuevo cada vez que se llama a crear_cita.
  if (conversationId) {
    const { data: conv } = await supabase
      .from("df_conversations").select("patient_id").eq("id", conversationId).maybeSingle();
    if (conv?.patient_id) return conv.patient_id;
  }
  // 2) Por teléfono, si lo hay.
  if (phone) {
    const { data: existing } = await supabase
      .from("df_patients").select("id").eq("phone", phone).limit(1).maybeSingle();
    if (existing) return existing.id;
  }
  // 3) Sin teléfono: reutiliza un paciente del mismo nombre que TAMPOCO tenga teléfono
  //    (mismo cliente nuevo), para no duplicarlo en cada mensaje/intento de cita.
  const cleanName = String(name || "").trim();
  if (cleanName) {
    const { data: byName } = await supabase
      .from("df_patients").select("id, phone").ilike("full_name", cleanName).limit(1).maybeSingle();
    if (byName && !byName.phone) return byName.id;
  }
  // 4) No existe: créalo.
  const { data, error } = await supabase
    .from("df_patients")
    .insert({ full_name: cleanName || "Paciente (bot)", phone: phone || null })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

function parseStart(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Normaliza texto (minúsculas, sin acentos) para comparar motivos/tratamientos.
function normTxt(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Elige el tratamiento del catálogo que mejor encaja con lo que pide el paciente
// (por su motivo/especialidad). Así la cita se CLASIFICA bien (limpieza, ortodoncia…)
// en vez de quedar siempre como "Primera visita". Si no encaja ninguno concreto,
// usa "Primera visita". De ese tratamiento salen la duración y si es individual
// (is_first_visit=true → individual; el resto usan la capacidad de gabinetes).
async function resolveTreatment({ especialidad, motivo }) {
  const { data: treatments } = await supabase
    .from("df_treatments")
    .select("id, name, duration_minutes, is_first_visit, df_treatment_professionals(professional_id)")
    .eq("active", true);
  // professional_ids: los profesionales que cubren ese tratamiento (vinculados en el CRM).
  const list = (treatments || []).map((t) => ({
    id: t.id, name: t.name, duration_minutes: t.duration_minutes, is_first_visit: t.is_first_visit,
    professional_ids: (t.df_treatment_professionals || []).map((x) => x.professional_id),
  }));
  if (!list.length) return { id: null, name: null, duration_minutes: 30, is_first_visit: true, professional_ids: [] };
  const hay = normTxt(`${especialidad || ""} ${motivo || ""}`);
  // palabra clave del paciente -> fragmento del NOMBRE del tratamiento en el catálogo
  const KW = [
    ["limpieza", "limpieza"], ["higiene", "higiene"],
    ["ortodonc", "ortodoncia"], ["bracket", "ortodoncia"], ["alinea", "ortodoncia"], ["invisalign", "ortodoncia"],
    ["endodonc", "endodoncia"], ["conducto", "endodoncia"],
    ["periodonc", "periodoncia"], ["encia", "periodoncia"],
    ["protesi", "protesis"], ["corona", "protesis"], ["puente", "protesis"],
    ["empaste", "empaste"], ["carie", "empaste"],
    ["nin", "odontopedia"], ["infantil", "odontopedia"], ["pediatr", "odontopedia"],
    ["revis", "revision"], ["chequeo", "revision"],
  ];
  for (const [kw, frag] of KW) {
    if (hay.includes(kw)) {
      const t = list.find((x) => normTxt(x.name).includes(frag));
      if (t) return t;
    }
  }
  // Por defecto: "Primera visita".
  return list.find((x) => x.is_first_visit) || list.find((x) => normTxt(x.name).includes("primera")) || list[0];
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
          // Guarda el nombre en la conversación aunque sea paciente nuevo,
          // para que aparezca ya en el panel de Conversaciones.
          await supabase.from("df_conversations").update({ customer_name: q }).eq("id", conversation.id);
          return `No consta ningún paciente con el nombre "${q}". Trátalo como PACIENTE NUEVO: pídele UNA sola vez los datos que falten (teléfono y motivo) y no vuelvas a preguntar por el teléfono una vez te lo haya dado. IMPORTANTE: el correo NO se lo pidas ahora; se lo pedirás DESPUÉS de agendar la cita.`;
        }
        const top = matches[0];
        // Enlaza la conversación con el paciente encontrado (contexto en el panel).
        await supabase.from("df_conversations").update({
          patient_id: top.id,
          customer_name: top.full_name,
          customer_phone: top.phone || conversation.customer_phone,
          customer_email: top.email || conversation.customer_email,
        }).eq("id", conversation.id);
        // Últimas citas del paciente para dar contexto.
        const { data: appts } = await supabase
          .from("df_appointments")
          .select("starts_at, status, df_treatments(name)")
          .eq("patient_id", top.id)
          .order("starts_at", { ascending: false })
          .limit(3);
        const lista = matches
          .map((m) => `- ${m.full_name} · tel: ${m.phone || "sin teléfono"} · correo: ${m.email || "sin correo"} · estado: ${m.patient_state || "-"}`)
          .join("\n");
        const hist = (appts || [])
          .map((a) => `  · ${new Date(a.starts_at).toLocaleDateString("es-ES")} (${a.status})${a.df_treatments?.name ? " — " + a.df_treatments.name : ""}`)
          .join("\n");
        const telefonoNota = top.phone
          ? `El teléfono que consta en su ficha es "${top.phone}": ÚSALO tal cual al crear la cita. NO se lo preguntes ni le pidas que lo confirme en ningún momento.`
          : `No consta su teléfono en la ficha: pídeselo UNA sola vez cuando vayas a agendar, sin insistir.`;
        return (
          `PACIENTE YA REGISTRADO en la clínica:\n${lista}\n` +
          (hist ? `Citas recientes de ${top.full_name}:\n${hist}\n` : "") +
          `Salúdale por su nombre con naturalidad y dale la bienvenida como paciente conocido. NO vuelvas a pedir ni a confirmar los datos que ya constan. ${telefonoNota} Pregunta solo lo que falte: el motivo y el día/hora que prefiera. ` +
          `El correo que consta es "${top.email || "ninguno"}": DESPUÉS de agendar la cita, y una sola vez, pregúntale si ese correo sigue siendo correcto.`
        );
      },
    },
    {
      definition: {
        name: "comprobar_disponibilidad",
        description:
          "Comprueba si un día y hora concretos están LIBRES para una primera visita ANTES de proponérselos o confirmárselos al paciente. Úsala SIEMPRE justo antes de ofrecer o confirmar una hora concreta; solo ofrece huecos que devuelva como LIBRE.",
        input_schema: {
          type: "object",
          properties: {
            fecha_hora_inicio: { type: "string", description: "Inicio propuesto en ISO local, p. ej. 2026-07-13T10:00 (hora de Madrid)" },
            especialidad: { type: "string", description: "Especialidad/cargo si el motivo lo requiere (opcional)" },
            duracion_min: { type: "integer", description: "Duración en minutos (opcional)" },
          },
          required: ["fecha_hora_inicio"],
        },
      },
      run: async (input) => {
        const start = parseStart(input.fecha_hora_inicio);
        const wt = localWeekdayAndTime(input.fecha_hora_inicio);
        if (!start || !wt) return "Fecha/hora no válida. Pide al paciente que indique un día y una hora concretos.";
        // Tratamiento pedido -> duración y si la cita es individual o comparte gabinete.
        const t = await resolveTreatment({ especialidad: input.especialidad });
        const dur = Number(input.duracion_min) || t.duration_minutes || 30;
        const isFV = !!t.is_first_visit;
        const end = new Date(start.getTime() + dur * 60000);
        // Continuidad: si la conversación ya tiene paciente, respétala.
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id").eq("id", conversation.id).maybeSingle();
        // Evita el AUTO-CHOQUE: si el paciente YA tiene una cita a esa misma hora (p. ej.
        // porque se acaba de crear con crear_cita), no la trates como "ocupada": es SU cita.
        if (conv?.patient_id) {
          const { data: own } = await supabase
            .from("df_appointments").select("id")
            .eq("patient_id", conv.patient_id)
            .eq("starts_at", start.toISOString())
            .in("status", ["pending", "confirmed"])
            .limit(1).maybeSingle();
          if (own) {
            return "Esa cita YA está registrada a nombre del paciente. NO la cuestiones, NO digas que no está libre y NO ofrezcas otra hora: continúa solo con el correo y despídete.";
          }
        }
        const r = await resolveProfessional({
          supabase, patientId: conv?.patient_id || null, weekday: wt.weekday, hhmm: wt.hhmm,
          endHhmm: addMinutes(wt.hhmm, dur), especialidad: input.especialidad,
          allowedProfessionalIds: t.professional_ids,
        });
        if (!r.professional) {
          if (r.reason === "especialista_no_disponible" && r.preferred) {
            return `NO disponible: para ese caso debe atender ${r.preferred.name} (${r.preferred.specialty}), que no tiene consulta ese día/hora. Propón otro momento dentro de su horario.`;
          }
          return "NO disponible: no hay profesional con consulta a esa hora. Propón otro día/hora dentro del horario de la clínica.";
        }
        const cap = await assignCabinet({
          supabase, startISO: start.toISOString(), endISO: end.toISOString(),
          isFirstVisit: isFV, professionalId: r.professional.id,
        });
        if (!cap.ok) {
          return `NO disponible: ${CAPACITY_REASONS[cap.reason] || "ese hueco no está libre"}. Propón otra hora en la que haya disponibilidad.`;
        }
        return "LIBRE: ese día y hora están disponibles. Ofréceselo y, si el paciente acepta, agéndalo directamente con crear_cita (no vuelvas a preguntar por el hueco).";
      },
    },
    {
      definition: {
        name: "proponer_hueco",
        description:
          "Busca los próximos HUECOS LIBRES para una primera visita (con el profesional adecuado según el tratamiento) y te los devuelve ORDENADOS del más temprano al más tardío, para OFRECÉRSELOS directamente al paciente nuevo (sin pedirle que elija día/hora ni su teléfono). Ofrece SIEMPRE el primero (el más pronto). Úsala en cuanto un paciente NUEVO quiera una primera visita.",
        input_schema: {
          type: "object",
          properties: {
            especialidad: { type: "string", description: "Especialidad/cargo si el motivo lo requiere (opcional)" },
          },
        },
      },
      run: async (input) => {
        // Tratamiento pedido -> duración y si la cita es individual (primera visita) o
        // comparte gabinete (resto, hasta MAX_CABINETS simultáneas).
        const t = await resolveTreatment({ especialidad: input.especialidad });
        const dur = Number(t.duration_minutes) || 30;
        const isFV = !!t.is_first_visit;
        const { data: pros } = await supabase
          .from("df_professionals")
          .select("id, name, specialty, is_generalist, active, df_professional_schedules(weekday, start_time, end_time)")
          .eq("active", true);
        const all = pros || [];

        // Profesionales que PUEDEN atender ese tratamiento:
        //  1) PRIORIDAD: los vinculados al tratamiento en el CRM (apartado Tratamientos).
        //  2) especialidad concreta (ortodoncia, endodoncia, cirugía...) -> quien la ofrece.
        //  3) general / limpieza / higiene / revisión / sin especialidad -> los GENERALISTAS.
        const esp = String(input.especialidad || "").toLowerCase().trim();
        const generalMarkers = ["general", "limpieza", "higiene", "revis", "primera", "chequeo", "dental"];
        const wantsGeneral = !esp || generalMarkers.some((g) => esp.includes(g));
        let cand;
        if (Array.isArray(t.professional_ids) && t.professional_ids.length) {
          const allowSet = new Set(t.professional_ids);
          cand = all.filter((p) => allowSet.has(p.id));
        } else if (!wantsGeneral) {
          cand = all.filter((p) => matchesSpecialty(p, esp));
          if (!cand.length) cand = all.filter((p) => isGeneralist(p));
        } else {
          cand = all.filter((p) => isGeneralist(p));
        }
        if (!cand.length) cand = all;

        // Citas ocupadas (con profesional y si son primera visita) para calcular la
        // capacidad de cada hueco igual que en la agenda.
        const now = new Date();
        const horizon = new Date(now.getTime() + 21 * 86400000);
        const { data: appts } = await supabase
          .from("df_appointments").select("starts_at, ends_at, professional_id, is_first_visit")
          .in("status", ["pending", "confirmed"])
          .gte("starts_at", now.toISOString()).lte("starts_at", horizon.toISOString());
        const rows = (appts || []).map((a) => ({ s: Date.parse(a.starts_at), e: Date.parse(a.ends_at), prof: a.professional_id, fv: !!a.is_first_visit }));
        // ¿Cabe una cita [start,end) con ese profesional? Reglas de Juan:
        //  - el profesional no puede solaparse consigo mismo,
        //  - primera visita: individual (ninguna otra cita a esa hora),
        //  - resto: no solapar una primera visita y hasta MAX_CABINETS (3) simultáneas.
        const fits = (s, e, profId) => {
          const over = rows.filter((r) => r.s < e && s < r.e);
          if (profId && over.some((r) => r.prof === profId)) return false;
          if (isFV) return over.length === 0;
          if (over.some((r) => r.fv)) return false;
          return over.length < MAX_CABINETS;
        };
        const toMin = (t) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m; };
        const pad = (n) => String(n).padStart(2, "0");
        const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
        const MO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

        // Recorre día a día (empezando HOY) y coge, para cada día, el hueco MÁS TEMPRANO
        // entre todos los candidatos. Así la lista queda ordenada del más pronto al más tarde.
        const slots = [];
        for (let d = 0; d <= 21 && slots.length < 3; d++) {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
          const weekday = (day.getDay() + 6) % 7; // 0=lunes
          let best = null;
          for (const p of cand) {
            for (const s of (p.df_professional_schedules || [])) {
              if (Number(s.weekday) !== weekday) continue;
              const st = toMin(s.start_time), en = toMin(s.end_time);
              for (let m = st; m + dur <= en; m += dur) {
                const hh = pad(Math.floor(m / 60)), mm = pad(m % 60);
                const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${hh}:${mm}`;
                const startMs = new Date(iso).getTime();
                if (startMs <= now.getTime()) continue;          // nunca en el pasado
                if (!fits(startMs, startMs + dur * 60000, p.id)) continue;
                if (!best || startMs < best.ms) {
                  best = { ms: startMs, iso, cuando: `${WD[day.getDay()]} ${day.getDate()} de ${MO[day.getMonth()]} a las ${hh}:${mm}`, prof: p.name };
                }
                break; // el hueco más temprano de este profesional en esta franja
              }
            }
          }
          if (best) slots.push(best);
        }
        if (!slots.length) {
          return "No he encontrado huecos libres en los próximos 21 días para ese tipo de visita. Pídele su preferencia de día/hora y compruébala con comprobar_disponibilidad.";
        }
        return "HUECOS LIBRES para la cita, ORDENADOS del MÁS TEMPRANO al más tardío. Ofrécele SIEMPRE el PRIMERO (el más pronto) y, como alternativa, el segundo. Cuando acepte, agéndalo con crear_cita usando exactamente ese fecha_hora_inicio:\n" +
          slots.map((s) => `- ${s.cuando} → fecha_hora_inicio="${s.iso}"`).join("\n");
      },
    },
    {
      definition: {
        name: "crear_cita",
        description:
          "Registra una primera visita PENDIENTE de confirmar por recepción. Úsala solo cuando el paciente haya confirmado día y hora concretos y tengas su nombre y teléfono. Antes de confirmar el hueco usa comprobar_disponibilidad. Llama a crear_cita UNA sola vez por cita: si ya la has creado, NO vuelvas a llamarla.",
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
            duracion_min: { type: "integer", description: "Duración en minutos (opcional; por defecto la del tratamiento)" },
            especialidad: {
              type: "string",
              description: "Especialidad/cargo del profesional más adecuado según el motivo, si procede (p. ej. 'ortodoncia', 'odontología general', 'higiene'). Opcional.",
            },
            notas: { type: "string", description: "Notas adicionales (opcional)" },
          },
          required: ["nombre", "motivo", "fecha_hora_inicio"],
        },
      },
      run: async (input) => {
        const start = parseStart(input.fecha_hora_inicio);
        if (!start) return "Fecha/hora no válida. Pide al paciente que confirme el día y la hora.";
        const patientId = await findOrCreatePatient({ phone: input.telefono, name: input.nombre, conversationId: conversation.id });

        // Anti-duplicados: si ya existe una cita de este paciente a esa misma hora,
        // no crees otra (el modelo a veces llama a crear_cita más de una vez).
        const { data: dup } = await supabase
          .from("df_appointments")
          .select("id")
          .eq("patient_id", patientId)
          .eq("starts_at", start.toISOString())
          .limit(1)
          .maybeSingle();
        if (dup) {
          return "La cita YA estaba registrada; NO crees otra ni vuelvas a llamar a crear_cita. " +
            "Confírmaselo al paciente y gestiona el correo como se indicó.";
        }

        // Clasifica la cita con el TRATAMIENTO que pide el paciente (limpieza, ortodoncia…)
        // en vez de dejarla siempre como "Primera visita". De ese tratamiento salen la
        // duración y si la cita es INDIVIDUAL (primera visita) o comparte gabinete (resto).
        const t = await resolveTreatment({ especialidad: input.especialidad, motivo: input.motivo });
        const treatmentId = t.id || null;
        const isFV = !!t.is_first_visit;
        const dur = Number(input.duracion_min) || t.duration_minutes || 30;
        const end = new Date(start.getTime() + dur * 60000);

        // Profesional según continuidad + reglas de especialista/generalista + horario.
        let professionalId = null;
        let profNombre = null;
        const wt = localWeekdayAndTime(input.fecha_hora_inicio);
        if (wt) {
          const r = await resolveProfessional({
            supabase, patientId, weekday: wt.weekday, hhmm: wt.hhmm,
            endHhmm: addMinutes(wt.hhmm, dur), especialidad: input.especialidad,
            allowedProfessionalIds: t.professional_ids,
          });
          if (r.professional) { professionalId = r.professional.id; profNombre = r.professional.name; }
          else if (r.reason === "especialista_no_disponible" && r.preferred) {
            // El especialista adecuado no trabaja a esa hora y no se reasigna: pedir otra hora.
            return `Para ese caso debe atender ${r.preferred.name} (${r.preferred.specialty}), pero no tiene consulta ` +
              `ese día/hora. Propón al paciente otro momento dentro del horario de ${r.preferred.name}; no lo asignes a otro profesional.`;
          }
        }

        // Nunca agendes sin un profesional que atienda ese tratamiento: si a esa hora no
        // hay generalista/especialista adecuado, propón otra hora (usa proponer_hueco).
        if (!professionalId) {
          return "A esa hora no hay ningún profesional que atienda ese tipo de visita. " +
            "Propón al paciente otro día/hora en que sí haya disponibilidad (usa proponer_hueco para ofrecerle el hueco más temprano).";
        }

        // Capacidad y gabinete: las primeras visitas son individuales; el resto de
        // tratamientos admiten hasta MAX_CABINETS simultáneos con distinto profesional.
        const cap = await assignCabinet({
          supabase,
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          isFirstVisit: isFV,
          professionalId,
        });
        if (!cap.ok) {
          return `Ese hueco no está libre (${CAPACITY_REASONS[cap.reason] || "no disponible"}). ` +
            `Propón al paciente otra hora en la que haya disponibilidad.`;
        }

        await supabase.from("df_conversations").update({
          patient_id: patientId,
          customer_name: input.nombre || conversation.customer_name,
          customer_phone: input.telefono || conversation.customer_phone,
        }).eq("id", conversation.id);

        const { data: appt, error } = await supabase.from("df_appointments").insert({
          patient_id: patientId,
          professional_id: professionalId,
          treatment_id: treatmentId,
          cabinet: cap.cabinet,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          status: "pending",
          is_first_visit: isFV,
          source,
          notes: [input.motivo, input.notas].filter(Boolean).join(" · ") || null,
        }).select("id").single();
        if (error) return "No se ha podido registrar la cita: " + error.message;

        // Cobro automático si el tratamiento (primera visita) tiene precio.
        await ensurePaymentForAppointment(supabase, {
          appointmentId: appt.id, patientId, treatmentId, startsAt: start.toISOString(),
        }).catch(() => {});
        return (
          "Cita registrada como PENDIENTE de confirmación" +
          (profNombre ? ` (asignada internamente a ${profNombre})` : "") +
          ". Recepción la confirmará. Comunícaselo al paciente de forma natural (no hace falta que menciones qué profesional se le ha asignado salvo que lo pregunte). " +
          "AHORA gestiona el CORREO: si es paciente NUEVO, pídeselo para registrarlo; si YA era paciente, " +
          "pregúntale UNA sola vez si el correo que consta en su ficha sigue siendo correcto."
        );
      },
    },
    {
      definition: {
        name: "guardar_correo",
        description:
          "Guarda o actualiza el correo electrónico del paciente vinculado a la conversación. Úsala cuando el paciente te dé un correo nuevo (paciente nuevo) o corrija el que tenía.",
        input_schema: {
          type: "object",
          properties: { email: { type: "string", description: "Correo electrónico del paciente" } },
          required: ["email"],
        },
      },
      run: async (input) => {
        const email = String(input.email || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return "Ese correo no parece válido. Pídeselo de nuevo con amabilidad.";
        }
        // Localiza el paciente vinculado a la conversación (puede haberse creado en crear_cita).
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id, customer_phone").eq("id", conversation.id).maybeSingle();
        let patientId = conv?.patient_id;
        if (!patientId && conv?.customer_phone) {
          const { data: p } = await supabase
            .from("df_patients").select("id").eq("phone", conv.customer_phone).limit(1).maybeSingle();
          patientId = p?.id;
        }
        if (patientId) await supabase.from("df_patients").update({ email }).eq("id", patientId);
        await supabase.from("df_conversations").update({ customer_email: email }).eq("id", conversation.id);
        return "Correo guardado correctamente. Agradéceselo y despídete si no necesita nada más.";
      },
    },
    {
      definition: {
        name: "marcar_urgencia",
        description:
          "Registra una URGENCIA para que recepción la gestione con prioridad. NO agendes cita. Úsala SOLO cuando ya hayas recogido: el nombre, una descripción del problema, el nivel de dolor del 1 al 10, desde cuándo lo tiene y un teléfono de contacto (el de la ficha si ya está registrado, o pedido una vez si no consta).",
        input_schema: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre del paciente" },
            telefono: { type: "string", description: "Teléfono de contacto para que recepción pueda llamarle. Usa el de la ficha si ya está registrado; si no consta, pídeselo una vez." },
            resumen: { type: "string", description: "Descripción del problema/síntoma que ha contado el paciente" },
            nivel_dolor: { type: "integer", description: "Nivel de dolor del 1 al 10 (si aplica)" },
            inicio_dolor: { type: "string", description: "Desde cuándo tiene el dolor/síntoma (p. ej. 'esta mañana', 'hace 2 días')" },
          },
          required: ["resumen"],
        },
      },
      run: async (input) => {
        const nombre = input.nombre || conversation.customer_name || null;
        // Localiza el paciente vinculado a la conversación (si ya lo hay).
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id, customer_phone").eq("id", conversation.id).maybeSingle();
        const phone = input.telefono || conv?.customer_phone || conversation.customer_phone || null;
        let patientId = conv?.patient_id || null;

        await supabase.from("df_conversations").update({
          is_urgent: true,
          customer_name: nombre || conversation.customer_name,
          customer_phone: phone || conversation.customer_phone,
        }).eq("id", conversation.id);

        let nivel = Number(input.nivel_dolor);
        nivel = Number.isFinite(nivel) ? Math.max(1, Math.min(10, Math.round(nivel))) : null;

        // Evita duplicar la urgencia de esta misma conversación si aún está pendiente.
        const { data: prev } = await supabase
          .from("df_urgencies").select("id").eq("conversation_id", conversation.id).eq("status", "pending").limit(1).maybeSingle();
        if (prev) {
          await supabase.from("df_urgencies").update({
            customer_name: nombre, customer_phone: phone, patient_id: patientId,
            summary: input.resumen || null, pain_level: nivel, onset: input.inicio_dolor || null,
            updated_at: new Date().toISOString(),
          }).eq("id", prev.id);
        } else {
          await supabase.from("df_urgencies").insert({
            conversation_id: conversation.id, patient_id: patientId,
            customer_name: nombre, customer_phone: phone,
            summary: input.resumen || null, pain_level: nivel, onset: input.inicio_dolor || null,
            status: "pending",
          });
        }
        return "Urgencia registrada para recepción (NO agendes cita). Dile al paciente, con calma y empatía, que el equipo revisará su caso y le contactará lo antes posible para atenderle con prioridad.";
      },
    },
    {
      definition: {
        name: "guardar_resena",
        description:
          "Registra la valoración del 1 al 5 que el paciente da sobre el servicio de la clínica (admite decimales como 4.5). Úsala cuando el paciente exprese su opinión/nota sobre su experiencia o cuando le pidas que valore el servicio. Después, sigue EXACTAMENTE las instrucciones que devuelve.",
        input_schema: {
          type: "object",
          properties: {
            nota: { type: "number", description: "Valoración del 1 al 5 (admite 4.5)" },
            comentario: { type: "string", description: "Comentario u opinión del paciente (opcional)" },
          },
          required: ["nota"],
        },
      },
      run: async (input) => {
        let nota = Number(input.nota);
        if (isNaN(nota)) return "No he entendido la valoración. Pídele con amabilidad una nota del 1 al 5.";
        nota = Math.max(1, Math.min(5, Math.round(nota * 2) / 2)); // acota a 1..5 en pasos de 0,5
        const routed_to = nota >= REVIEW_MIN_GOOGLE ? "google" : "internal";

        // Localiza el paciente vinculado a la conversación (si lo hay).
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id, customer_phone").eq("id", conversation.id).maybeSingle();
        let patientId = conv?.patient_id;
        if (!patientId && conv?.customer_phone) {
          const { data: p } = await supabase
            .from("df_patients").select("id").eq("phone", conv.customer_phone).limit(1).maybeSingle();
          patientId = p?.id;
        }

        const { error } = await supabase.from("df_reviews").insert({
          patient_id: patientId || null,
          rating: nota,
          comment: String(input.comentario || "").trim() || null,
          routed_to,
          status: routed_to === "google" ? "sent_to_google" : "pending",
        });
        if (error) return "No se ha podido registrar la valoración: " + error.message;

        if (routed_to === "google") {
          return (
            `Valoración registrada (${nota}/5). El paciente está satisfecho: agradécele su opinión ` +
            `e invítale AMABLEMENTE (sin insistir) a dejar su reseña en Google con este enlace: ${GOOGLE_REVIEW_URL}`
          );
        }
        return (
          `Valoración registrada (${nota}/5) para gestión INTERNA. Agradécele su sinceridad, discúlpate si algo ` +
          `no estuvo a la altura y dile que el equipo de la clínica revisará su caso y se pondrá en contacto para ayudarle. ` +
          `NO le pidas que la publique en Google.`
        );
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
