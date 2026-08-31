// Orquestador del chatbot: une Supabase (CRM) + detección de idioma + Claude.
// Expone handleMessage(), usado tanto por el chat web como por WhatsApp.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { supabase } = require("./db");
const { detectLanguage } = require("./i18n");
const { buildSystemPrompt } = require("./prompt");
const { runAgent, isConfigured } = require("./claude");
const { resolveProfessional, assignCabinet, localWeekdayAndTime, addMinutes, matchesSpecialty, isGeneralist, isOnVacation, isClinicClosed, continuityProfessional, availableAt, withinBookingWindow, MAX_CABINETS, CAPACITY_REASONS } = require("./scheduling");
const { ensurePaymentForAppointment } = require("./billing");
const { botActivo } = require("./switches");

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
// Variantes de un mismo teléfono según cómo llegue escrito: WhatsApp manda
// "34633391602", la ficha del CRM puede tener "633391602" o "+34633391602".
// Sin esto, la búsqueda de la conversación falla y se crea una nueva por
// mensaje (el bot "olvida" todo y saluda de cero cada vez).
function phoneVariants(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const variants = new Set([raw, digits]);
  if (digits.length === 11 && digits.startsWith("34")) {
    variants.add(digits.slice(2));      // 34633391602 -> 633391602
    variants.add("+" + digits);         // -> +34633391602
    variants.add("0034" + digits.slice(2));
  } else if (digits.length === 9) {
    variants.add("34" + digits);        // 633391602 -> 34633391602
    variants.add("+34" + digits);       // -> +34633391602
    variants.add("0034" + digits);
  } else if (digits.length === 13 && digits.startsWith("0034")) {
    variants.add(digits.slice(4));      // 0034633391602 -> 633391602
    variants.add(digits.slice(2));      // -> 34633391602
    variants.add("+" + digits.slice(2));
  }
  return [...variants].filter(Boolean);
}

// Clave para comparar teléfonos SIN depender del formato: solo los dígitos y, si lleva
// prefijo, los 9 últimos. Así "34633391602", "+34 633 391 602", "0034633391602" y
// "633391602" (como está en la ficha) son el mismo número.
function phoneKey(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length > 9 ? d.slice(-9) : d;
}

async function getOrCreateConversation({ channel, phone, token, name, email, language }) {
  // Web: continuidad por access_token (el widget lo guarda entre mensajes).
  if (channel === "web" && token) {
    const { data } = await supabase
      .from("df_conversations").select("*").eq("access_token", token).maybeSingle();
    if (data) return data;
  }
  // WhatsApp: continuidad por teléfono + canal. Se busca con TODAS las variantes
  // del número (con/sin prefijo 34) para no perder el hilo de la conversación.
  if (channel !== "web" && phone) {
    const { data: existing } = await supabase
      .from("df_conversations")
      .select("*")
      .in("customer_phone", phoneVariants(phone))
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

async function saveMessage(conversationId, role, content, imageUrl = null) {
  if (!content && !imageUrl) return;
  await supabase.from("df_messages").insert({
    conversation_id: conversationId,
    role,
    content: content || "📷 Imagen",   // content es NOT NULL en la tabla
    image_url: imageUrl || null,       // adjunto (foto/archivo) si lo hay
  });
  // Refleja la actividad en la conversación: así "Última actividad" del panel es
  // real y la búsqueda de conversación reutiliza siempre el hilo más reciente.
  await supabase.from("df_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

// Marcas que se escriben en la conversación cuando se le manda al paciente una CAMPAÑA
// o la plantilla de CONSENTIMIENTO. Cortan el contexto: el bot no retoma lo que se
// hablara antes de ese aviso (p. ej. seguir ofreciendo una hora de hace semanas), pero
// SÍ sigue atendiendo con normalidad lo que el paciente pida a partir de ahí.
const CAMPAIGN_CONTEXT_MARK = "📣 Campaña enviada";
const CONSENT_SENT_MARK = "📨 Enviada la plantilla de consentimiento de marketing";
const CONTEXT_CUT_MARKS = [CAMPAIGN_CONTEXT_MARK, CONSENT_SENT_MARK];

// ¿Lo último que se le envió al paciente fue una campaña o el consentimiento? Sirve para
// avisar al modelo de que una respuesta suelta ("vale", "ok", "no me interesa") contesta
// a ESE mensaje y no a la conversación anterior.
async function lastOutboundMark(conversationId) {
  const { data } = await supabase
    .from("df_messages").select("role, content")
    .eq("conversation_id", conversationId)
    .neq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  const txt = String(data?.content || "");
  if (txt.startsWith(CONSENT_SENT_MARK)) return "consentimiento";
  if (txt.startsWith(CAMPAIGN_CONTEXT_MARK)) return "campana";
  return null;
}

async function loadHistory(conversationId, limit = 24) {
  const { data } = await supabase
    .from("df_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }) // los MÁS RECIENTES primero
    .limit(limit);
  // Vuelve a orden cronológico y descarta contenidos vacíos.
  const rows = (data || [])
    .filter((m) => m.content && String(m.content).trim())
    .reverse();
  // Si hay una marca de campaña o de consentimiento, el historial empieza DESPUÉS de ella.
  let cut = -1;
  rows.forEach((m, i) => {
    if (CONTEXT_CUT_MARKS.some((mark) => String(m.content).startsWith(mark))) cut = i;
  });
  const recent = (cut >= 0 ? rows.slice(cut + 1) : rows)
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

// Identifica al paciente por el NÚMERO desde el que escribe. Es la forma fiable de saber
// con quién hablamos sin preguntarle nada: primero por las variantes del número (rápido,
// por índice) y, si la ficha lo tiene guardado con otro formato (espacios, +34, 0034…),
// comparando solo los dígitos. Las fichas de MENORES se descartan: comparten el teléfono
// de su tutor y el titular del número es el adulto.
async function patientByPhone(phone) {
  const clave = phoneKey(phone);
  if (!clave) return null;
  const esTitular = (p) => !(p.tags || []).includes("menor");
  const { data } = await supabase
    .from("df_patients").select(PATIENT_COLS)
    .in("phone", phoneVariants(phone))
    .order("created_at", { ascending: true }).limit(10);
  const directo = (data || []).find(esTitular);
  if (directo) return directo;
  // Respaldo: el teléfono está guardado con un formato distinto en la ficha.
  const todos = await allPatientsLite();
  return todos.find((p) => phoneKey(p.phone) === clave && esTitular(p)) || null;
}

async function findOrCreatePatient({ phone, name, conversationId }) {
  const cleanPhone = String(phone || "").trim() || null;
  // 1) Reutiliza el paciente YA vinculado a la conversación (fuente más fiable).
  //    Evita crear un paciente nuevo cada vez que se llama a crear_cita.
  if (conversationId) {
    const { data: conv } = await supabase
      .from("df_conversations").select("patient_id").eq("id", conversationId).maybeSingle();
    if (conv?.patient_id) {
      // Si tenemos el teléfono del canal (p. ej. el número de WhatsApp) y su ficha aún
      // no lo tiene, complétalo para que el paciente quede registrado con su teléfono.
      if (cleanPhone) {
        const { data: pt } = await supabase
          .from("df_patients").select("id, phone").eq("id", conv.patient_id).maybeSingle();
        if (pt && !pt.phone) await supabase.from("df_patients").update({ phone: cleanPhone }).eq("id", pt.id);
      }
      return conv.patient_id;
    }
  }
  // 2) Por teléfono, si lo hay — probando todas las variantes del número
  //    (la ficha puede tener "633391602" y WhatsApp mandar "34633391602"),
  //    para no crear un paciente duplicado. Las fichas de MENORES comparten el
  //    teléfono de su tutor, así que se descartan aquí: el titular del número es
  //    el adulto (el menor solo se usa al agendar su propia cita).
  if (cleanPhone) {
    const { data: byPhone } = await supabase
      .from("df_patients").select("id, tags")
      .in("phone", phoneVariants(cleanPhone))
      .order("created_at", { ascending: true }).limit(10);
    const titular = (byPhone || []).find((p) => !(p.tags || []).includes("menor"));
    if (titular) return titular.id;
  }
  // 3) Sin teléfono: reutiliza un paciente del mismo nombre que TAMPOCO tenga teléfono
  //    (mismo cliente nuevo), para no duplicarlo en cada mensaje/intento de cita. Si ahora
  //    sí tenemos el teléfono del canal, se lo completamos.
  const cleanName = String(name || "").trim();
  if (cleanName) {
    // La comparación ignora tildes y mayúsculas: "ARIADNA CONTRERAS MACIAS" y
    // "Ariadna Contreras Macías" son la misma persona.
    const candidatos = await searchPatientsByName(cleanName, 5);
    const byName = candidatos.find((p) => !p.phone && !(p.tags || []).includes("menor"));
    if (byName) {
      if (cleanPhone) await supabase.from("df_patients").update({ phone: cleanPhone }).eq("id", byName.id);
      return byName.id;
    }
  }
  // 4) No existe: créalo (con teléfono si lo tenemos del canal).
  const { data, error } = await supabase
    .from("df_patients")
    .insert({ full_name: cleanName || "Paciente (bot)", phone: cleanPhone })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

// Ficha del MENOR (citas infantiles). La cita debe quedar a nombre del niño, no del
// adulto que escribe: se busca/crea una ficha propia con el teléfono del tutor como
// contacto (para recordatorios) y la etiqueta "menor" para no confundirla con la suya.
async function findOrCreateMinorPatient({ name, guardianPhone, guardianName }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return null;
  const existing = await searchPatientsByName(cleanName, 5);
  // Reutiliza su ficha si ya existe (misma etiqueta o mismo teléfono de contacto).
  const match = (existing || []).find(
    (p) => (p.tags || []).includes("menor") ||
      (guardianPhone && phoneVariants(guardianPhone).includes(String(p.phone || "")))
  );
  if (match) return match.id;
  const notes = guardianName ? `Menor · contacto: ${guardianName}` : "Menor";
  const { data, error } = await supabase
    .from("df_patients")
    .insert({ full_name: cleanName, phone: guardianPhone || null, tags: ["menor"], notes })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

// ¿El tratamiento es infantil? (ortodoncia infantil, odontopediatría…)
function isPediatricTreatment(t) {
  return /(infantil|odontoped|pediatr)/.test(normTxt(t?.name || ""));
}

// Pacientes que "cuelgan" de esta conversación: el titular (el adulto que escribe)
// y los MENORES a su cargo (mismo teléfono de contacto). Así el bot ve también las
// citas de los hijos al consultar, cancelar o reagendar.
async function relatedPatientIds(conversationId) {
  const { data: conv } = await supabase
    .from("df_conversations").select("patient_id, customer_phone").eq("id", conversationId).maybeSingle();
  const ids = [];
  if (conv?.patient_id) ids.push(conv.patient_id);
  if (conv?.customer_phone) {
    const { data: samePhone } = await supabase
      .from("df_patients").select("id").in("phone", phoneVariants(conv.customer_phone)).limit(20);
    for (const p of samePhone || []) if (!ids.includes(p.id)) ids.push(p.id);
  }
  return { ids, conv };
}

// ¿Toca pedirle el consentimiento de marketing? Sí cuando el paciente de esta
// conversación ya tiene cita reservada y todavía no ha dicho ni que sí ni que no.
// (Quien aceptó tiene marketing_consent=true; quien rechazó lleva "sin_marketing".)
async function consentPending(conversationId) {
  try {
    const { data: conv } = await supabase
      .from("df_conversations").select("patient_id").eq("id", conversationId).maybeSingle();
    if (!conv?.patient_id) return false;
    const { data: pt } = await supabase
      .from("df_patients").select("marketing_consent, tags").eq("id", conv.patient_id).maybeSingle();
    if (!pt) return false;
    if (pt.marketing_consent === true) return false;
    if ((pt.tags || []).includes("sin_marketing")) return false;
    // Solo tiene sentido pedirlo si ha llegado a reservar (suya o de un hijo).
    const { ids } = await relatedPatientIds(conversationId);
    const appts = await upcomingAppointments(ids);
    return appts.length > 0;
  } catch (_e) { return false; }
}

// Citas futuras activas de esos pacientes, de la más próxima a la más lejana.
async function upcomingAppointments(patientIds, extraSelect = "") {
  if (!patientIds.length) return [];
  const { data } = await supabase
    .from("df_appointments")
    .select("id, starts_at, patient_id, status" + (extraSelect ? ", " + extraSelect : ""))
    .in("patient_id", patientIds)
    .in("status", ["pending", "confirmed"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(20);
  return data || [];
}

// Localiza LA cita a la que se refiere el paciente ("la del 15 de septiembre a las 10").
// Devuelve { appt } si no hay duda, o { ambiguous: [...] } si hay que preguntarle cuál.
function pickAppointment(appts, fechaHora) {
  if (!appts.length) return { appt: null };
  const ref = String(fechaHora || "").trim();
  if (ref) {
    const day = ref.slice(0, 10);
    const hhmm = (ref.match(/T(\d{2}:\d{2})/) || [])[1] || null;
    const localOf = (a) => {
      const d = new Date(a.starts_at);
      const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      return { day: p.slice(0, 10), hhmm: p.slice(11, 16) };   // "YYYY-MM-DD", "HH:MM"
    };
    let cand = appts.filter((a) => localOf(a).day === day);
    if (hhmm) {
      const exact = cand.filter((a) => localOf(a).hhmm === hhmm);
      if (exact.length) cand = exact;
    }
    if (cand.length === 1) return { appt: cand[0] };
    if (cand.length > 1) return { ambiguous: cand };
    return { appt: null, notFound: true };
  }
  if (appts.length === 1) return { appt: appts[0] };
  return { ambiguous: appts };
}

// Descripción corta de una cita para pedirle al paciente que aclare cuál es.
function describeAppt(a) {
  const cuando = new Date(a.starts_at).toLocaleString("es-ES", {
    weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
  });
  const trat = a.df_treatments?.name ? ` · ${a.df_treatments.name}` : "";
  const quien = a.df_patients?.full_name ? ` (${a.df_patients.full_name})` : "";
  return `${cuando}${trat}${quien}`;
}

function parseStart(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// La cita, en ISO local de Madrid ("2026-09-01T13:00"), tal y como hay que
// pasarla en fecha_hora_cita_actual. Se añade a las listas que ve el modelo
// para que identifique SIEMPRE la cita correcta (antes la deducía del texto).
function isoLocalDeCita(a) {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(a.starts_at));
  return `${p.slice(0, 10)}T${p.slice(11, 16)}`;
}

const WD_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ── CAMBIAR UNA CITA DE DÍA/HORA: UN SOLO CRITERIO ──────────────────────────
// El bucle "le ofrezco un hueco → cuando lo acepta resulta que no vale" venía de
// que las dos herramientas usaban criterios DISTINTOS: proponer_hueco buscaba por
// el motivo que menciona el paciente y por SU doctor habitual, mientras que
// reagendar_cita exigía el profesional que lleva ESA cita (que puede ser de otra
// persona de la casa: la cita de Juan Antonio, no la de Lucas). Desde aquí, las
// dos parten de la propia cita y comparten la MISMA comprobación: todo hueco que
// se ofrece se puede reservar.

// Contexto de la cita que se quiere mover: duración, profesionales que pueden
// atenderla, cierres de la clínica y las otras citas del paciente.
async function contextoReagenda(appt) {
  const dur = appt.df_treatments?.duration_minutes
    || Math.round((Date.parse(appt.ends_at) - Date.parse(appt.starts_at)) / 60000) || 30;
  const { data: pros } = await supabase
    .from("df_professionals")
    .select("*, df_professional_schedules(weekday, start_time, end_time), df_professional_time_off(start_date, end_date)")
    .eq("active", true);
  const all = pros || [];
  const titular = all.find((p) => p.id === appt.professional_id) || null;

  // Profesionales que cubren ESE tratamiento en el CRM (apartado Tratamientos).
  let asignados = [];
  if (appt.treatment_id) {
    const { data: tp } = await supabase
      .from("df_treatment_professionals").select("professional_id").eq("treatment_id", appt.treatment_id);
    const set = new Set((tp || []).map((x) => x.professional_id));
    asignados = all.filter((p) => set.has(p.id));
  }

  // Un ESPECIALISTA no se sustituye: su cita solo se mueve a un hueco suyo. Si la
  // lleva un generalista (o no consta profesional), vale cualquiera de los que
  // cubren el tratamiento y, en su defecto, cualquier generalista.
  let cand;
  if (titular && !isGeneralist(titular)) cand = [titular];
  else if (asignados.length) cand = asignados;
  else cand = all.filter((p) => isGeneralist(p));
  if (titular && !cand.some((p) => p.id === titular.id)) cand = [titular, ...cand];
  if (!cand.length) cand = all;

  // Cierres de la clínica de los próximos dos meses, en UNA consulta.
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + 75 * 86400000).toISOString().slice(0, 10);
  const { data: cierres } = await supabase
    .from("df_clinic_closures").select("start_date, end_date")
    .lte("start_date", hasta).gte("end_date", hoy);
  const cerrado = (d) => (cierres || []).some(
    (c) => String(c.start_date).slice(0, 10) <= d && d <= String(c.end_date).slice(0, 10));

  // Las OTRAS citas del mismo paciente: no puede acabar con dos a la vez.
  let otras = [];
  if (appt.patient_id) {
    const { data } = await supabase
      .from("df_appointments").select("id, starts_at, ends_at")
      .eq("patient_id", appt.patient_id)
      .in("status", ["pending", "confirmed"])
      .gte("starts_at", new Date(Date.now() - 86400000).toISOString());
    otras = (data || []).filter((a) => a.id !== appt.id)
      .map((a) => ({ s: Date.parse(a.starts_at), e: Date.parse(a.ends_at) }));
  }
  return { dur, isFV: !!appt.is_first_visit, titular, cand, cerrado, otras };
}

// ¿Cabe ESTA cita a esa hora? Devuelve con qué profesional y gabinete quedaría.
// Es la comprobación que usan TANTO la búsqueda de huecos COMO el reagendado.
async function encajaReagenda(appt, ctx, isoLocal) {
  const start = parseStart(isoLocal);
  const wt = localWeekdayAndTime(isoLocal);
  if (!start || !wt) return { ok: false, reason: "fecha" };
  if (!withinBookingWindow(wt.weekday, wt.hhmm)) return { ok: false, reason: "fuera_de_horario" };
  if (start.getTime() <= Date.now()) return { ok: false, reason: "pasado" };
  const dateStr = String(isoLocal).slice(0, 10);
  if (ctx.cerrado ? ctx.cerrado(dateStr) : await isClinicClosed(supabase, dateStr)) {
    return { ok: false, reason: "clinica_cerrada" };
  }
  const end = new Date(start.getTime() + ctx.dur * 60000);
  if (ctx.otras.some((o) => o.s < end.getTime() && start.getTime() < o.e)) {
    return { ok: false, reason: "otra_cita_suya" };
  }
  const endHhmm = addMinutes(wt.hhmm, ctx.dur);
  // Primero SU profesional; si ese día no tiene consulta, otro que pueda atenderla.
  const orden = ctx.titular
    ? [ctx.titular, ...ctx.cand.filter((p) => p.id !== ctx.titular.id)]
    : ctx.cand;
  let sinConsulta = false, ocupado = false;
  for (const p of orden) {
    if (p.active === false) continue;
    if (!availableAt(p, wt.weekday, wt.hhmm, endHhmm) || isOnVacation(p, dateStr)) { sinConsulta = true; continue; }
    const cap = await assignCabinet({
      supabase, startISO: start.toISOString(), endISO: end.toISOString(),
      isFirstVisit: ctx.isFV, professionalId: p.id, excludeId: appt.id,
    });
    if (cap.ok) return { ok: true, start, end, professional: p, cabinet: cap.cabinet };
    ocupado = true;   // sí tenía consulta, pero el hueco ya está cogido
  }
  return { ok: false, reason: ocupado || !sinConsulta ? "ocupado" : "sin_consulta" };
}

// Huecos REALES a los que se puede mover esta cita, validados uno a uno con
// encajaReagenda (o sea: reservables seguro).
async function huecosParaReagendar(appt, ctx, desdeFecha, max = 5) {
  const now = new Date();
  let from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const df = String(desdeFecha || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(df)) {
    const d = new Date(df + "T00:00:00");
    if (!isNaN(d.getTime()) && d.getTime() > from.getTime()) from = d;
  }
  const HORIZON_DAYS = 60, STEP = 15, MAX_PER_DAY = 2, MAX_PRUEBAS_DIA = 10;
  const horizon = new Date(from.getTime() + (HORIZON_DAYS + 1) * 86400000);

  // Ocupación del periodo en UNA consulta, para descartar horas sin ir a la BD.
  const { data: ocupadas } = await supabase
    .from("df_appointments").select("id, starts_at, ends_at, professional_id")
    .in("status", ["pending", "confirmed"])
    .gte("starts_at", new Date(from.getTime() - 86400000).toISOString())
    .lte("starts_at", horizon.toISOString());
  const rows = (ocupadas || []).filter((a) => a.id !== appt.id)
    .map((a) => ({ s: Date.parse(a.starts_at), e: Date.parse(a.ends_at), prof: a.professional_id }));
  const cabe = (s, e, profId) => {
    const over = rows.filter((r) => r.s < e && s < r.e);
    if (profId && over.some((r) => r.prof === profId)) return false;
    return over.length < MAX_CABINETS;
  };

  const pad = (n) => String(n).padStart(2, "0");
  const toMin = (t) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m; };
  const slots = [];
  for (let d = 0; d <= HORIZON_DAYS && slots.length < max; d++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
    const weekday = (day.getDay() + 6) % 7;   // 0 = lunes
    const dayStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    if (ctx.cerrado(dayStr)) continue;        // clínica cerrada: ni ofrecer
    const vistas = new Set();
    const delDia = [];
    for (const p of ctx.cand) {
      if (p.active === false || isOnVacation(p, dayStr)) continue;
      for (const s of (p.df_professional_schedules || [])) {
        if (Number(s.weekday) !== weekday) continue;
        const st = toMin(s.start_time), en = toMin(s.end_time);
        for (let m = Math.ceil(st / STEP) * STEP; m + ctx.dur <= en; m += STEP) {
          const hh = pad(Math.floor(m / 60)), mm = pad(m % 60);
          if (!withinBookingWindow(weekday, `${hh}:${mm}`)) continue;
          const iso = `${dayStr}T${hh}:${mm}`;
          if (vistas.has(iso)) continue;
          const ms = new Date(iso).getTime();
          if (ms <= now.getTime()) continue;
          if (!cabe(ms, ms + ctx.dur * 60000, p.id)) continue;
          vistas.add(iso);
          delDia.push({ ms, iso });
        }
      }
    }
    delDia.sort((a, b) => a.ms - b.ms);
    let hoyCuentan = 0, pruebas = 0;
    for (const c of delDia) {
      if (hoyCuentan >= MAX_PER_DAY || slots.length >= max || pruebas >= MAX_PRUEBAS_DIA) break;
      pruebas++;
      const r = await encajaReagenda(appt, ctx, c.iso);   // la MISMA validación que al mover
      if (!r.ok) continue;
      const dd = new Date(c.ms);
      slots.push({
        iso: c.iso, prof: r.professional.name,
        cuando: `${WD_ES[dd.getDay()]} ${dd.getDate()} de ${MES_ES[dd.getMonth()]} a las ${c.iso.slice(11, 16)}`,
      });
      hoyCuentan++;
    }
  }
  return slots;
}

// Texto con el que se le ofrecen al modelo los huecos de un cambio de cita.
function textoHuecosReagenda(slots, refActual) {
  if (!slots.length) {
    return "No hay ningún hueco libre en los próximos 2 MESES para mover esa cita (contando horarios, vacaciones, bloqueos y cierres). " +
      "Díselo con naturalidad y dile que recepción le llamará para buscarle un hueco; no le ofrezcas horas por tu cuenta.";
  }
  return "HUECOS REALES a los que SÍ se puede mover esa cita (ya comprobados uno a uno con las mismas reglas que la reserva: " +
    "si el paciente acepta cualquiera de ellos, el cambio se hará sin problema). Ofrécele el primero y una alternativa, no la lista entera. " +
    `Cuando elija, llama a reagendar_cita con ese fecha_hora_inicio y fecha_hora_cita_actual="${refActual}":\n` +
    slots.map((s) => `- ${s.cuando} (con ${s.prof}) → fecha_hora_inicio="${s.iso}"`).join("\n");
}

// Normaliza texto (minúsculas, sin acentos) para comparar motivos/tratamientos.
function normTxt(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Normaliza un NOMBRE para compararlo: sin mayúsculas, sin tildes, sin signos y con
// los espacios colapsados. Las fichas importadas están en mayúsculas y SIN tildes
// ("ARIADNA CONTRERAS MACIAS") mientras que el paciente escribe "Ariadna Contreras
// Macías": sin esto no se reconocía como paciente de la clínica.
function normName(s) {
  return normTxt(s).replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Escapa los comodines de ILIKE para que un nombre con % o _ no busque de más.
function likeSafe(s) {
  return String(s || "").replace(/[%_]/g, (c) => "\\" + c);
}

const PATIENT_COLS = "id, full_name, phone, email, patient_state, tags, marketing_consent";

// Listado ligero de TODOS los pacientes, paginado. Solo se usa como último recurso al
// buscar por nombre (cuando la comparación literal no encuentra nada), así que se
// cachea unos minutos para no repetir la lectura en la misma conversación.
let patientsCache = { at: 0, rows: [] };
async function allPatientsLite() {
  if (patientsCache.rows.length && Date.now() - patientsCache.at < 120000) return patientsCache.rows;
  const rows = [];
  try {
    for (let desde = 0; desde < 50000; desde += 1000) {
      const { data, error } = await supabase
        .from("df_patients").select(PATIENT_COLS).range(desde, desde + 999);
      if (error || !data || !data.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
  } catch (e) {
    // Es solo el último recurso de la búsqueda por nombre: si falla, se sigue sin él.
    console.error("[bot/pacientes]", e.message);
    return [];
  }
  if (rows.length) patientsCache = { at: Date.now(), rows };
  return rows;
}

// Busca pacientes por nombre IGNORANDO tildes y mayúsculas, en los dos sentidos:
// da igual que las tildes estén en la ficha, en lo que escribe el paciente o en ninguno.
async function searchPatientsByName(q, limit = 5) {
  const raw = String(q || "").trim();
  if (!raw) return [];
  const objetivo = normName(raw);
  const vistos = new Map();
  const add = (rows) => { for (const r of rows || []) if (r && !vistos.has(r.id)) vistos.set(r.id, r); };

  // 1) Tal cual lo ha escrito (ILIKE ya ignora mayúsculas).
  const { data: literal } = await supabase
    .from("df_patients").select(PATIENT_COLS).ilike("full_name", `%${likeSafe(raw)}%`).limit(limit);
  add(literal);
  // 2) Sin tildes: cubre el caso habitual de fichas importadas sin acentos.
  if (objetivo && objetivo !== raw.toLowerCase().trim()) {
    const { data: sinTildes } = await supabase
      .from("df_patients").select(PATIENT_COLS).ilike("full_name", `%${likeSafe(objetivo)}%`).limit(limit);
    add(sinTildes);
  }
  if (vistos.size) return [...vistos.values()].slice(0, limit);

  // 3) Último recurso: comparar ya normalizado (por si las tildes están en la FICHA).
  const palabras = objetivo.split(" ").filter((w) => w.length >= 3);
  const todos = await allPatientsLite();
  const conNombre = todos.map((p) => ({ p, n: normName(p.full_name) }));
  add(conNombre.filter((x) => x.n === objetivo).map((x) => x.p));                       // igual
  add(conNombre.filter((x) => x.n.includes(objetivo) || (x.n && objetivo.includes(x.n))).map((x) => x.p)); // contenido
  if (palabras.length >= 2) {                                                            // mismas palabras
    add(conNombre.filter((x) => {
      const tokens = x.n.split(" ");
      return palabras.every((w) => tokens.includes(w));
    }).map((x) => x.p));
  }
  return [...vistos.values()].slice(0, limit);
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
  // ORTODONCIA: distinguir la INFANTIL (niños) de la de adultos — cada una tiene su
  // propio tratamiento en el CRM con su profesional asignado. "ortodoncia" a secas
  // NUNCA debe caer en la infantil (ni al revés).
  if (/(ortodonc|bracket|alinea|invisalign)/.test(hay)) {
    const esInfantil = /(nin|infantil|pediatr|hij[oa]|peque|bebe|menor)/.test(hay);
    const nombreInfantil = (x) => /(infantil|odontoped|pediatr|nin)/.test(normTxt(x.name));
    const nombreOrto = (x) => normTxt(x.name).includes("ortodonc");
    const t = esInfantil
      ? (list.find((x) => nombreOrto(x) && nombreInfantil(x)) || list.find(nombreInfantil) || list.find(nombreOrto))
      : (list.find((x) => nombreOrto(x) && !nombreInfantil(x)) || list.find(nombreOrto));
    if (t) return t;
  }
  // palabra clave del paciente -> fragmento del NOMBRE del tratamiento en el catálogo
  const KW = [
    ["limpieza", "limpieza"], ["higiene", "higiene"],
    ["ortodonc", "ortodoncia"], ["bracket", "ortodoncia"], ["alinea", "ortodoncia"], ["invisalign", "ortodoncia"],
    ["endodonc", "endodoncia"], ["conducto", "endodoncia"],
    ["periodonc", "periodoncia"], ["encia", "periodoncia"],
    ["protesi", "protesis"], ["corona", "protesis"], ["puente", "protesis"],
    ["empaste", "empaste"], ["carie", "empaste"],
    ["implant", "implant"],
    ["cirug", "cirug"], ["extracc", "extracc"], ["muela del juicio", "cirug"],
    ["blanque", "blanque"],
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

// Registra un aviso para recepción (urgencia o consulta) sin duplicar el de esta
// conversación. `kind` puede no existir todavía en la tabla: se reintenta sin él.
async function registrarAvisoRecepcion({ conversationId, patientId, nombre, phone, resumen, nivelDolor, inicio, kind }) {
  const fila = {
    conversation_id: conversationId, patient_id: patientId || null,
    customer_name: nombre || null, customer_phone: phone || null,
    summary: resumen || null, pain_level: nivelDolor ?? null, onset: inicio || null,
    status: "pending", kind,
  };
  const { data: prev } = await supabase
    .from("df_urgencies").select("id").eq("conversation_id", conversationId).eq("status", "pending").limit(1).maybeSingle();
  const guardar = async (payload) => {
    if (prev) {
      const { error } = await supabase.from("df_urgencies")
        .update({ ...payload, updated_at: new Date().toISOString() }).eq("id", prev.id);
      return error;
    }
    const { error } = await supabase.from("df_urgencies").insert(payload);
    return error;
  };
  let error = await guardar(fila);
  if (error && /kind/i.test(error.message || "")) {
    const { kind: _k, ...sinKind } = fila;      // la migración aún no se ha ejecutado
    error = await guardar(sinKind);
  }
  return !error;
}

// ---------------- Herramientas ----------------
function buildTools(conversation) {
  const source = conversation.channel === "whatsapp" ? "bot_whatsapp" : "bot_web";
  // Si en ESTE mismo turno se ha dejado un aviso para recepción (urgencia o consulta),
  // el bot NO debe además agendar una cita: lo gestiona recepción llamando al paciente.
  let avisoEnEsteTurno = null;
  // Intentos fallidos de cambiar una cita en este turno: si se encadenan, se deja
  // de marear al paciente con horas y lo coge recepción.
  let fallosReagenda = 0;

  return [
    {
      definition: {
        name: "buscar_paciente",
        description:
          "Comprueba si el paciente ya existe en el CRM, para reutilizar sus datos y no volver a pedírselos. Identifica primero por el número de WhatsApp desde el que escribe y, si no consta, por el nombre completo (ignora tildes y mayúsculas). Úsala SIEMPRE en cuanto tengas el nombre, antes de pedir más datos.",
        input_schema: {
          type: "object",
          properties: {
            nombre_completo: { type: "string", description: "Nombre completo del paciente (opcional si escribe por WhatsApp: se intenta primero por su número)" },
          },
        },
      },
      run: async (input) => {
        const q = String(input.nombre_completo || "").trim();
        // 1) Por el NÚMERO desde el que escribe: si ese teléfono ya está en una ficha,
        //    es ese paciente, escriba su nombre como lo escriba. Se descartan las fichas
        //    de menores (comparten el teléfono del tutor).
        let matches = [];
        if (conversation.customer_phone) {
          const { data: byPhone } = await supabase
            .from("df_patients").select(PATIENT_COLS)
            .in("phone", phoneVariants(conversation.customer_phone))
            .order("created_at", { ascending: true }).limit(5);
          matches = (byPhone || []).filter((p) => !(p.tags || []).includes("menor"));
        }
        // 2) Por nombre, ignorando tildes y mayúsculas.
        if (!matches.length) {
          if (!q) return "Indica el nombre completo para poder buscar (o espera a tenerlo).";
          matches = await searchPatientsByName(q);
        }
        if (!matches || !matches.length) {
          // Guarda el nombre en la conversación aunque sea paciente nuevo,
          // para que aparezca ya en el panel de Conversaciones.
          await supabase.from("df_conversations").update({ customer_name: q }).eq("id", conversation.id);
          return `No consta ningún paciente con el nombre "${q}". Trátalo como PACIENTE NUEVO. ` +
            `Su TELÉFONO ya lo tiene el sistema (es el número de WhatsApp desde el que escribe): NO se lo pidas NUNCA. ` +
            `Para darle de alta solo falta su CORREO ELECTRÓNICO: pídeselo UNA vez con naturalidad y guárdalo con guardar_correo ` +
            `(con nombre + teléfono + correo queda creada su ficha). Después continúa con lo que necesitaba.`;
        }
        const top = matches[0];
        // Enlaza la conversación con el paciente encontrado (contexto en el panel).
        // OJO: customer_phone NO se toca si ya existe — en WhatsApp es la dirección
        // del canal; si se sobrescribe con el teléfono de la ficha, el siguiente
        // mensaje no encuentra la conversación y el bot pierde todo el contexto.
        await supabase.from("df_conversations").update({
          patient_id: top.id,
          customer_name: top.full_name,
          customer_phone: conversation.customer_phone || top.phone || null,
          customer_email: top.email || conversation.customer_email,
        }).eq("id", conversation.id);
        // Últimas citas del paciente para dar contexto (las canceladas no cuentan).
        const { data: appts } = await supabase
          .from("df_appointments")
          .select("starts_at, status, df_treatments(name)")
          .eq("patient_id", top.id)
          .neq("status", "cancelled")
          .order("starts_at", { ascending: false })
          .limit(3);
        const lista = matches
          .map((m) => `- ${m.full_name} · tel: ${m.phone || "sin teléfono"} · correo: ${m.email || "sin correo"} · estado: ${m.patient_state || "-"}`)
          .join("\n");
        const hist = (appts || [])
          .map((a) => `  · ${new Date(a.starts_at).toLocaleDateString("es-ES")} (${a.status})${a.df_treatments?.name ? " — " + a.df_treatments.name : ""}`)
          .join("\n");
        // Si su ficha no tenía teléfono y escribe por WhatsApp, se completa sola con el
        // número del canal: el teléfono NUNCA se le pregunta al paciente.
        if (!top.phone && conversation.customer_phone) {
          await supabase.from("df_patients").update({ phone: conversation.customer_phone }).eq("id", top.id);
          top.phone = conversation.customer_phone;
        }
        const telefonoNota = `El teléfono que consta en su ficha es "${top.phone || "el del propio WhatsApp"}": lo usa el sistema automáticamente. NO se lo preguntes ni le pidas que lo confirme en ningún momento.`;
        // ¿Ya hizo su primera visita (gratuita)? Si es así, la próxima cita ya tiene coste.
        const { data: fvAppts } = await supabase
          .from("df_appointments").select("starts_at, status, is_first_visit")
          .eq("patient_id", top.id).eq("is_first_visit", true).neq("status", "cancelled");
        const nowMs = Date.now();
        const hadFirstVisit = (fvAppts || []).some((a) => a.status === "done" || Date.parse(a.starts_at) < nowMs);
        const segundaNota = hadFirstVisit
          ? `\nAVISO DE COSTE: este paciente YA hizo su primera visita (que es gratuita). Si ahora pide otra cita, avísale con tacto de que esta nueva visita/consulta ya NO es gratuita y tendrá un coste; si acepta, agéndala con normalidad.`
          : "";
        return (
          `PACIENTE YA REGISTRADO en la clínica:\n${lista}\n` +
          (hist ? `Citas recientes de ${top.full_name}:\n${hist}\n` : "") +
          `Salúdale por su nombre con naturalidad y dale la bienvenida como paciente conocido. NO vuelvas a pedir ni a confirmar los datos que ya constan. ${telefonoNota} Pregunta solo lo que falte: el motivo y el día/hora que prefiera. ` +
          (top.email
            ? `El correo que consta es "${top.email}": DESPUÉS de agendar la cita, y una sola vez, pregúntale si ese correo sigue siendo correcto.`
            : `NO consta su correo: pídeselo UNA vez (es el único dato que falta en su ficha) y guárdalo con guardar_correo.`) +
          segundaNota
        );
      },
    },
    {
      definition: {
        name: "consultar_citas",
        description:
          "Devuelve las citas PROGRAMADAS que el paciente de esta conversación tiene AHORA MISMO en la agenda real de la clínica. Recepción puede crear, cambiar o ELIMINAR citas desde el panel en cualquier momento, así que lo hablado antes en el chat puede estar desactualizado. Úsala SIEMPRE antes de afirmar que el paciente ya tiene (o no tiene) una cita: cuando pregunte por sus citas, cuando pida reservar algo que creas que ya estaba reservado, o cuando quiera cambiar/cancelar una cita.",
        input_schema: { type: "object", properties: {} },
      },
      run: async () => {
        // Incluye también las citas de los MENORES a su cargo (mismo teléfono).
        const { ids } = await relatedPatientIds(conversation.id);
        if (!ids.length) {
          return "Esta conversación aún no está vinculada a ningún paciente registrado (usa buscar_paciente con su nombre). Ahora mismo NO consta ninguna cita suya.";
        }
        const appts = await upcomingAppointments(ids, "df_treatments(name), df_patients(full_name)");
        if (!appts.length) {
          return "El paciente NO tiene NINGUNA cita programada ahora mismo en la agenda. Si en el chat se habló de alguna cita, ya NO existe (recepción la ha eliminado o cancelado): no se la 'recuerdes' ni digas que sigue en pie. Si quiere una cita, gestiónala con normalidad (proponer_hueco / crear_cita).";
        }
        const fmt = (a) => `- ${describeAppt(a)} (${a.status === "confirmed" ? "confirmada" : "pendiente de confirmar"})` +
          ` → si hay que cambiarla o cancelarla, usa fecha_hora_cita_actual="${isoLocalDeCita(a)}"`;
        return "Citas PROGRAMADAS AHORA MISMO (estado REAL de la agenda; esto manda sobre cualquier cosa dicha antes en el chat). Entre paréntesis, a nombre de quién está cada cita (puede ser un hijo/a):\n" +
          appts.map(fmt).join("\n");
      },
    },
    {
      definition: {
        name: "comprobar_disponibilidad",
        description:
          "Comprueba si un día y hora concretos están LIBRES para una cita (del tipo que sea) ANTES de proponérselos o confirmárselos al paciente. Úsala SIEMPRE justo antes de ofrecer o confirmar una hora concreta; solo ofrece huecos que devuelva como LIBRE. Pásale SIEMPRE el motivo del paciente para que compruebe con el profesional correcto.",
        input_schema: {
          type: "object",
          properties: {
            fecha_hora_inicio: { type: "string", description: "Inicio propuesto en ISO local, p. ej. 2026-07-13T10:00 (hora de Madrid)" },
            motivo: { type: "string", description: "Motivo/tratamiento que pide el paciente (p. ej. 'limpieza', 'apretar las coronas', 'ortodoncia infantil'). Pásalo SIEMPRE que lo sepas." },
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
        if (!withinBookingWindow(wt.weekday, wt.hhmm)) {
          return "NO disponible: esa hora está fuera del horario de reserva. La última cita se coge a las 19:00 de lunes a jueves y a las 13:45 el viernes (no se agenda sábados ni domingos). Propón otra hora dentro de ese margen.";
        }
        // Tratamiento pedido (con el MISMO criterio que crear_cita: especialidad + motivo)
        // -> duración, profesionales asignados y si comparte gabinete.
        const t = await resolveTreatment({ especialidad: input.especialidad, motivo: input.motivo });
        const dur = Number(input.duracion_min) || t.duration_minutes || 30;
        const isFV = !!t.is_first_visit;
        const end = new Date(start.getTime() + dur * 60000);
        // Continuidad: si la conversación ya tiene paciente, respétala.
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id").eq("id", conversation.id).maybeSingle();
        // Evita el AUTO-CHOQUE: si el PROPIO paciente (solo él: sus hijos son personas
        // distintas y SÍ pueden tener cita a la vez con otro profesional) ya tiene una
        // cita que pisa esa franja, no es un "hueco ocupado" cualquiera: o es la misma
        // cita que acaba de reservar, o es la cita que quiere MOVER a esa hora.
        const ownIds = conv?.patient_id ? [conv.patient_id] : [];
        if (ownIds.length) {
          const own = (await upcomingAppointments(ownIds, "ends_at, df_treatments(name), df_patients(full_name)"))
            .filter((a) => Date.parse(a.starts_at) < end.getTime() && start.getTime() < Date.parse(a.ends_at));
          const exact = own.find((a) => Date.parse(a.starts_at) === start.getTime());
          if (exact) {
            return "Esa cita YA está registrada a nombre del paciente. NO la cuestiones, NO digas que no está libre y NO ofrezcas otra hora: continúa solo con el correo y despídete.";
          }
          if (own.length) {
            return `OJO: a esa hora el paciente ya tiene SU cita del ${describeAppt(own[0])}, que se solaparía. ` +
              `Si lo que quiere es MOVER esa cita a la nueva hora, llama directamente a reagendar_cita con fecha_hora_cita_actual="${isoLocalDeCita(own[0])}" (libera su hueco automáticamente); NO le digas que no hay disponibilidad. ` +
              `Si lo que quiere es una cita ADICIONAL, explícale que no puede solaparse con la que ya tiene y ofrécele otra hora con proponer_hueco.`;
          }
        }
        const r = await resolveProfessional({
          supabase, patientId: conv?.patient_id || null, weekday: wt.weekday, hhmm: wt.hhmm,
          endHhmm: addMinutes(wt.hhmm, dur), especialidad: input.especialidad,
          allowedProfessionalIds: t.professional_ids, dateStr: String(input.fecha_hora_inicio).slice(0, 10),
        });
        if (!r.professional) {
          if (r.reason === "clinic_closed") {
            return "NO disponible: la clínica está CERRADA (vacaciones) ese día. Explícaselo y usa proponer_hueco con desde_fecha posterior a la reapertura para ofrecerle huecos reales. NO propongas fechas por tu cuenta.";
          }
          if (r.reason === "especialista_no_disponible" && r.preferred) {
            return `NO disponible: para ese caso debe atender ${r.preferred.name} (${r.preferred.specialty}), que no tiene consulta (o está ausente) ese día/hora. Usa proponer_hueco con el MISMO motivo para ofrecer huecos reales; NO propongas días u horas por tu cuenta.`;
          }
          return "NO disponible: no hay profesional que pueda atender esa visita a esa hora. Usa proponer_hueco con el MISMO motivo para ofrecer huecos reales; NO propongas días u horas por tu cuenta.";
        }
        const cap = await assignCabinet({
          supabase, startISO: start.toISOString(), endISO: end.toISOString(),
          isFirstVisit: isFV, professionalId: r.professional.id,
        });
        if (!cap.ok) {
          return `NO disponible: ${CAPACITY_REASONS[cap.reason] || "ese hueco no está libre"}. Usa proponer_hueco con el MISMO motivo para ofrecer huecos reales; NO propongas días u horas por tu cuenta.`;
        }
        return "LIBRE: ese día y hora están disponibles. Ofréceselo y, si el paciente acepta, agéndalo directamente con crear_cita (no vuelvas a preguntar por el hueco).";
      },
    },
    {
      definition: {
        name: "proponer_hueco",
        description:
          "Busca los próximos HUECOS LIBRES REALES para una cita de CUALQUIER tipo (primera visita, limpieza, prótesis, ortodoncia…, paciente nuevo o ya registrado) con el profesional adecuado según el tratamiento/motivo, y los devuelve ORDENADOS del más temprano al más tardío. Ya tiene en cuenta los horarios de cada profesional, sus vacaciones y bloqueos, los cierres por vacaciones de la clínica y las citas ocupadas. Úsala SIEMPRE que necesites ofrecer un día/hora al paciente (también si dice 'esta semana' o 'cuanto antes'); NUNCA ofrezcas fechas por tu cuenta. Si el paciente quiere CAMBIAR una cita que ya tiene, pasa esa cita en cita_a_cambiar: así los huecos salen del profesional y el tratamiento de ESA cita y el cambio no falla luego.",
        input_schema: {
          type: "object",
          properties: {
            motivo: { type: "string", description: "Motivo/tratamiento que pide el paciente (p. ej. 'limpieza', 'apretar las coronas', 'ortodoncia infantil'). Pásalo SIEMPRE que lo sepas." },
            especialidad: { type: "string", description: "Especialidad/cargo si el motivo lo requiere (opcional)" },
            desde_fecha: { type: "string", description: "Buscar huecos A PARTIR de esta fecha, formato YYYY-MM-DD (opcional; por defecto desde hoy). Úsala si el paciente pide una fecha o semana concreta." },
            cita_a_cambiar: { type: "string", description: "OBLIGATORIO si el paciente quiere MOVER una cita que ya tiene: esa cita en ISO local (2026-09-01T13:00). Los huecos se buscan entonces para ella." },
          },
        },
      },
      run: async (input) => {
        // CAMBIO DE CITA: los huecos se buscan para LA CITA que se va a mover (su
        // tratamiento, su profesional, su duración) y con la misma comprobación que
        // hará reagendar_cita. Si no, se ofrecían huecos que luego se rechazaban.
        if (input.cita_a_cambiar) {
          const { ids } = await relatedPatientIds(conversation.id);
          const appts = ids.length ? await upcomingAppointments(ids, "df_treatments(name), df_patients(full_name)") : [];
          if (!appts.length) {
            return "El paciente no tiene ninguna cita futura que cambiar. Si lo que quiere es una cita nueva, vuelve a llamar a proponer_hueco SIN cita_a_cambiar.";
          }
          const sel = pickAppointment(appts, input.cita_a_cambiar);
          if (sel.ambiguous || !sel.appt) {
            const lista = (sel.ambiguous || appts).map((a) => `- ${describeAppt(a)} → cita_a_cambiar="${isoLocalDeCita(a)}"`).join("\n");
            return "No queda claro qué cita quiere cambiar. Pregúntaselo y vuelve a llamar indicando cita_a_cambiar:\n" + lista;
          }
          const { data: appt } = await supabase
            .from("df_appointments").select("*, df_treatments(duration_minutes, is_first_visit)")
            .eq("id", sel.appt.id).maybeSingle();
          if (!appt) return "No he podido recuperar esa cita. Pídele que confirme el día y la hora de la cita que quiere cambiar.";
          const ctx = await contextoReagenda(appt);
          const slots = await huecosParaReagendar(appt, ctx, input.desde_fecha);
          return textoHuecosReagenda(slots, isoLocalDeCita(sel.appt));
        }
        // Tratamiento pedido (MISMO criterio que crear_cita: especialidad + motivo)
        // -> duración, profesionales asignados y si comparte gabinete.
        const t = await resolveTreatment({ especialidad: input.especialidad, motivo: input.motivo });
        const dur = Number(t.duration_minutes) || 30;
        const isFV = !!t.is_first_visit;
        const { data: pros } = await supabase
          .from("df_professionals")
          .select("id, name, specialty, is_generalist, active, df_professional_schedules(weekday, start_time, end_time), df_professional_time_off(start_date, end_date)")
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

        // CONTINUIDAD paciente-doctor: si la conversación ya tiene paciente y este tiene
        // un doctor habitual, restringimos los candidatos igual que hará crear_cita
        // (especialista: solo él/ella; generalista: cualquier generalista asignado).
        // Así NUNCA ofrecemos un hueco que la reserva luego rechazaría.
        const { data: convRow } = await supabase
          .from("df_conversations").select("patient_id").eq("id", conversation.id).maybeSingle();
        const patientId = convRow?.patient_id || null;
        if (patientId) {
          const cont = await continuityProfessional(supabase, patientId, Object.fromEntries(cand.map((p) => [p.id, p])));
          if (cont) {
            if (!isGeneralist(cont)) cand = [cont];
            else {
              const gens = cand.filter((p) => isGeneralist(p));
              if (gens.length) cand = gens;
            }
          }
        }

        // Fecha de inicio de la búsqueda: hoy, o desde_fecha si el paciente pide
        // a partir de un día concreto ("la semana que viene", "el 1 de septiembre"...).
        const now = new Date();
        let from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const df = String(input.desde_fecha || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(df)) {
          const d = new Date(df + "T00:00:00");
          if (!isNaN(d.getTime()) && d.getTime() > from.getTime()) from = d;
        }

        // Horizonte de búsqueda: hasta 60 días, para que en plenas vacaciones el bot
        // ofrezca el primer hueco TRAS el regreso del profesional en vez de "no hay".
        const HORIZON_DAYS = 60;
        const horizon = new Date(from.getTime() + (HORIZON_DAYS + 1) * 86400000);

        // Cierres de la clínica del periodo, en UNA sola consulta (no una por día).
        const { data: closuresRows } = await supabase
          .from("df_clinic_closures").select("start_date, end_date")
          .lte("start_date", horizon.toISOString().slice(0, 10))
          .gte("end_date", new Date(from.getTime() - 86400000).toISOString().slice(0, 10));
        const closures = (closuresRows || []).map((c) => ({ s: String(c.start_date).slice(0, 10), e: String(c.end_date).slice(0, 10) }));
        const clinicClosedOn = (dayStr) => closures.some((c) => c.s <= dayStr && dayStr <= c.e);

        // Citas ocupadas (con profesional y si son primera visita) para calcular la
        // capacidad de cada hueco igual que en la agenda.
        const { data: appts } = await supabase
          .from("df_appointments").select("starts_at, ends_at, professional_id, is_first_visit")
          .in("status", ["pending", "confirmed"])
          .gte("starts_at", new Date(from.getTime() - 86400000).toISOString()).lte("starts_at", horizon.toISOString());
        const rows = (appts || []).map((a) => ({ s: Date.parse(a.starts_at), e: Date.parse(a.ends_at), prof: a.professional_id, fv: !!a.is_first_visit }));
        // ¿Cabe una cita [start,end) con ese profesional? Reglas de Juan:
        //  - el profesional no puede solaparse consigo mismo,
        //  - hasta MAX_CABINETS (3) citas simultáneas con profesionales distintos.
        //    (No se trata la primera visita como individual: puede coexistir con otras.)
        const fits = (s, e, profId) => {
          const over = rows.filter((r) => r.s < e && s < r.e);
          if (profId && over.some((r) => r.prof === profId)) return false;
          return over.length < MAX_CABINETS;
        };
        const toMin = (t) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m; };
        const pad = (n) => String(n).padStart(2, "0");
        const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
        const MO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

        // Recorre día a día (desde la fecha de inicio) y coge, para cada día, el hueco
        // MÁS TEMPRANO entre todos los candidatos. Cada hueco se VALIDA después con las
        // MISMAS reglas que usa crear_cita (resolveProfessional + assignCabinet): lo que
        // se ofrece aquí se puede reservar seguro, sin el bucle "te ofrezco → ya no está".
        // Los inicios se prueban en una rejilla de 15 min (10:00, 10:15…) para poder
        // ofrecer horas naturales y varias opciones del MISMO día, en vez de una sola
        // hora por día en múltiplos de la duración.
        const STEP = 15;
        const MAX_SLOTS = 5;          // cuántos huecos se le ofrecen al final
        const MAX_PER_DAY = 2;        // como mucho 2 horas del mismo día (así hay
                                      // alternativas del mismo día Y de días distintos)
        const slots = [];
        for (let d = 0; d <= HORIZON_DAYS && slots.length < MAX_SLOTS; d++) {
          const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
          const weekday = (day.getDay() + 6) % 7; // 0=lunes
          const dayStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
          if (clinicClosedOn(dayStr)) continue;   // clínica CERRADA (vacaciones): ni ofrecer
          // Candidatos del día (los más tempranos primero), sin repetir hora.
          const seen = new Set();
          const dayCands = [];
          for (const p of cand) {
            if (isOnVacation(p, dayStr)) continue;   // vacaciones o día bloqueado del profesional
            for (const s of (p.df_professional_schedules || [])) {
              if (Number(s.weekday) !== weekday) continue;
              const st = toMin(s.start_time), en = toMin(s.end_time);
              const first = Math.ceil(st / STEP) * STEP;
              for (let m = first; m + dur <= en; m += STEP) {
                const hh = pad(Math.floor(m / 60)), mm = pad(m % 60);
                if (!withinBookingWindow(weekday, `${hh}:${mm}`)) continue;   // tope de reserva (19:00 L-J, 13:45 V)
                const iso = `${dayStr}T${hh}:${mm}`;
                if (seen.has(iso)) continue;
                const startMs = new Date(iso).getTime();
                if (startMs <= now.getTime()) continue;          // nunca en el pasado
                if (!fits(startMs, startMs + dur * 60000, p.id)) continue;
                seen.add(iso);
                dayCands.push({ ms: startMs, iso, cuando: `${WD[day.getDay()]} ${day.getDate()} de ${MO[day.getMonth()]} a las ${hh}:${mm}`, prof: p.name });
              }
            }
          }
          dayCands.sort((a, b) => a.ms - b.ms);
          let takenToday = 0;
          for (const c of dayCands) {
            if (takenToday >= MAX_PER_DAY || slots.length >= MAX_SLOTS) break;
            // Validación final: exactamente lo que hará crear_cita con este hueco.
            const wtb = localWeekdayAndTime(c.iso);
            const rb = await resolveProfessional({
              supabase, patientId, weekday: wtb.weekday, hhmm: wtb.hhmm,
              endHhmm: addMinutes(wtb.hhmm, dur), especialidad: input.especialidad,
              allowedProfessionalIds: t.professional_ids, dateStr: c.iso.slice(0, 10),
            });
            if (!rb.professional) continue;
            const capb = await assignCabinet({
              supabase, startISO: new Date(c.ms).toISOString(),
              endISO: new Date(c.ms + dur * 60000).toISOString(),
              isFirstVisit: isFV, professionalId: rb.professional.id,
            });
            if (!capb.ok) continue;
            c.prof = rb.professional.name;   // el profesional que asignará la reserva
            slots.push(c);
            takenToday++;
          }
        }
        if (!slots.length) {
          return "No hay huecos libres en los próximos 2 MESES desde esa fecha para ese tipo de visita (contando horarios, vacaciones, bloqueos y cierres de la clínica). Díselo con naturalidad y, si el paciente quiere, vuelve a llamar a proponer_hueco con un desde_fecha posterior. NO ofrezcas fechas por tu cuenta.";
        }
        return "HUECOS LIBRES REALES para una cita NUEVA (ya descontadas vacaciones, bloqueos y cierres), ORDENADOS del MÁS TEMPRANO al más tardío. Ofrécele el PRIMERO (el más pronto) y una o dos alternativas, sin listarlos todos de golpe. Cuando acepte, agéndalo con crear_cita usando exactamente ese fecha_hora_inicio y el mismo motivo. (Si en realidad lo que quiere es CAMBIAR una cita que ya tiene, no uses estas horas: vuelve a llamar a proponer_hueco con cita_a_cambiar.)\n" +
          slots.map((s) => `- ${s.cuando} (con ${s.prof}) → fecha_hora_inicio="${s.iso}"`).join("\n");
      },
    },
    {
      definition: {
        name: "crear_cita",
        description:
          "Registra una primera visita PENDIENTE de confirmar por recepción. Úsala solo cuando el paciente haya confirmado día y hora concretos y tengas su nombre. El teléfono NO se pide: lo toma el sistema del propio WhatsApp. Antes de confirmar el hueco usa comprobar_disponibilidad. Llama a crear_cita UNA sola vez por cita: si ya la has creado, NO vuelvas a llamarla.",
        input_schema: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre completo del paciente adulto con el que hablas" },
            nombre_menor: { type: "string", description: "OBLIGATORIO en citas infantiles (ortodoncia infantil, odontopediatría): nombre completo del NIÑO/A que acude. La cita se registra a su nombre, no al del adulto." },
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
        // Si acabas de dejar un aviso para recepción (urgencia o consulta), NO se agenda:
        // el equipo llama al paciente y decide. Evita el caso de "le avisamos" + cita fantasma.
        if (avisoEnEsteTurno) {
          return `No se agenda ninguna cita: acabas de registrar una ${avisoEnEsteTurno} y la gestiona recepción, ` +
            "que llamará al paciente. Limítate a decírselo con calma y no le ofrezcas horas.";
        }
        const start = parseStart(input.fecha_hora_inicio);
        if (!start) return "Fecha/hora no válida. Pide al paciente que confirme el día y la hora.";
        const wtLimit = localWeekdayAndTime(input.fecha_hora_inicio);
        if (wtLimit && !withinBookingWindow(wtLimit.weekday, wtLimit.hhmm)) {
          return "No se puede agendar a esa hora: la última cita se coge a las 19:00 (lunes a jueves) y a las 13:45 (viernes), y no se agenda sábados ni domingos. Ofrece otra hora dentro de ese margen.";
        }
        // Para clientes nuevos que escriben por WhatsApp, el teléfono es el número desde el
        // que hablan (conversation.customer_phone): así la ficha queda con su teléfono sin
        // tener que pedírselo. En web no hay número y se queda vacío (no se pregunta).
        const channelPhone = conversation.customer_phone || null;

        // Clasifica la cita con el TRATAMIENTO que pide el paciente (limpieza, ortodoncia…)
        // en vez de dejarla siempre como "Primera visita". De ese tratamiento salen la
        // duración y si la cita es INDIVIDUAL (primera visita) o comparte gabinete (resto).
        const t = await resolveTreatment({ especialidad: input.especialidad, motivo: input.motivo });

        // CITAS INFANTILES: la cita va a nombre del NIÑO, no del adulto que escribe.
        // Si aún no sabemos su nombre, no se agenda: primero hay que preguntarlo.
        const esInfantil = isPediatricTreatment(t);
        const nombreMenor = String(input.nombre_menor || "").trim();
        if (esInfantil && !nombreMenor) {
          return "ANTES de agendar esta cita infantil necesitas el NOMBRE COMPLETO DEL NIÑO/A que va a acudir " +
            "(la cita debe quedar a su nombre en la agenda, no al del adulto). Pídeselo con naturalidad " +
            "(p. ej. \"¿cómo se llama su hijo/a?\") y vuelve a llamar a crear_cita con ese nombre en nombre_menor. " +
            "NO agendes ni confirmes nada todavía.";
        }
        const patientId = esInfantil
          ? await findOrCreateMinorPatient({
              name: nombreMenor,
              guardianPhone: channelPhone,
              guardianName: input.nombre || conversation.customer_name,
            })
          : await findOrCreatePatient({ phone: channelPhone, name: input.nombre, conversationId: conversation.id });

        // Una cita SIEMPRE va a nombre de alguien: si no hemos podido identificar ni crear
        // la ficha, no se agenda (en la agenda saldría como "Sin paciente").
        if (!patientId) {
          return "No se ha podido registrar la cita porque falta identificar al paciente. " +
            "Pídele su nombre completo, búscalo con buscar_paciente y vuelve a intentarlo. NO le pidas el teléfono.";
        }

        // Anti-duplicados: si ya existe una cita ACTIVA de este paciente a esa misma
        // hora, no crees otra (el modelo a veces llama a crear_cita más de una vez).
        // Solo cuentan pending/confirmed: una cita cancelada o eliminada desde el
        // panel NO bloquea volver a reservar ese hueco.
        const { data: dup } = await supabase
          .from("df_appointments")
          .select("id")
          .eq("patient_id", patientId)
          .eq("starts_at", start.toISOString())
          .in("status", ["pending", "confirmed"])
          .limit(1)
          .maybeSingle();
        if (dup) {
          return "Esa cita YA estaba registrada (no se ha duplicado). NO vuelvas a llamar a crear_cita " +
            "y NO se lo expliques al paciente: no le digas que 'ya estaba registrada' ni que 'no hace falta " +
            "duplicarla'. Simplemente sigue la conversación por donde iba, con naturalidad.";
        }

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
            allowedProfessionalIds: t.professional_ids, dateStr: String(input.fecha_hora_inicio).slice(0, 10),
          });
          if (r.professional) { professionalId = r.professional.id; profNombre = r.professional.name; }
          else if (r.reason === "clinic_closed") {
            return "La clínica está CERRADA (vacaciones) ese día, no se pueden agendar citas. Propón al paciente una fecha posterior a la reapertura.";
          }
          else if (r.reason === "especialista_no_disponible" && r.preferred) {
            // El especialista adecuado no trabaja a esa hora y no se reasigna: pedir otra hora.
            return `Para ese caso debe atender ${r.preferred.name} (${r.preferred.specialty}), pero no tiene consulta ` +
              `ese día/hora. Usa proponer_hueco con el MISMO motivo para ofrecer al paciente huecos reales; NO propongas días u horas por tu cuenta ni lo asignes a otro profesional.`;
          }
        }

        // Nunca agendes sin un profesional que atienda ese tratamiento: si a esa hora no
        // hay generalista/especialista adecuado, propón otra hora (usa proponer_hueco).
        if (!professionalId) {
          return "A esa hora no hay ningún profesional que atienda ese tipo de visita. " +
            "Usa proponer_hueco con el MISMO motivo para ofrecer al paciente los huecos reales más tempranos; NO propongas días u horas por tu cuenta.";
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
            `Usa proponer_hueco con el MISMO motivo para ofrecer al paciente huecos reales; NO propongas días u horas por tu cuenta.`;
        }

        // La conversación sigue siendo del ADULTO: en una cita infantil no se
        // sustituye por la ficha del niño (si no, el bot perdería al titular).
        // customer_phone: se conserva el del canal (ver nota en buscar_paciente).
        const convPatch = {
          customer_name: input.nombre || conversation.customer_name,
          customer_phone: conversation.customer_phone || null,
        };
        if (!esInfantil) convPatch.patient_id = patientId;
        await supabase.from("df_conversations").update(convPatch).eq("id", conversation.id);

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

        // Consentimiento de marketing: TODO paciente que reserva cita (sea nuevo o ya
        // registrado) recibe la plantilla con los botones si aún no ha dado su
        // consentimiento, para que su respuesta quede en la ficha. La manda el webhook
        // al terminar el turno (una sola vez por conversación).
        // (El envío de la plantilla de consentimiento lo decide handleMessage al
        //  cerrar el turno: solo cuando el bot no deja ninguna pregunta en el aire.)
        // El correo solo se pide si aún no lo tenemos: si ya se recogió al darle de alta
        // (nombre + teléfono del WhatsApp + correo), no hay que volver a molestarle.
        // En una cita infantil el correo es el del ADULTO que escribe, no el del niño.
        let correoActual = String(conversation.customer_email || "").trim();
        if (!correoActual) {
          const titularId = esInfantil ? (await relatedPatientIds(conversation.id)).conv?.patient_id : patientId;
          if (titularId) {
            const { data: ficha } = await supabase
              .from("df_patients").select("email").eq("id", titularId).maybeSingle();
            correoActual = String(ficha?.email || "").trim();
          }
        }
        const notaCorreo = correoActual
          ? `Su correo ya consta ("${correoActual}"): NO se lo vuelvas a pedir. Despídete si no necesita nada más.`
          : "Le falta el CORREO en la ficha: pídeselo UNA vez y guárdalo con guardar_correo. El teléfono NO se pide nunca.";
        return (
          "Cita registrada como PENDIENTE de confirmación" +
          (esInfantil ? ` a nombre de ${nombreMenor}` : "") +
          (profNombre ? ` (asignada internamente a ${profNombre})` : "") +
          ". Recepción la confirmará. Comunícaselo al paciente de forma natural (no hace falta que menciones qué profesional se le ha asignado salvo que lo pregunte). " +
          notaCorreo
        );
      },
    },
    {
      definition: {
        name: "guardar_correo",
        description:
          "Guarda el correo electrónico del paciente y, si es paciente nuevo, CREA su ficha con nombre + teléfono (el del WhatsApp, automático) + correo. Úsala en cuanto el paciente te dé su correo.",
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
          .from("df_conversations").select("patient_id, customer_name, customer_phone").eq("id", conversation.id).maybeSingle();
        let patientId = conv?.patient_id;
        if (!patientId && conv?.customer_phone) {
          const { data: p } = await supabase
            .from("df_patients").select("id").in("phone", phoneVariants(conv.customer_phone)).limit(1).maybeSingle();
          patientId = p?.id;
        }
        // Cliente nuevo por WhatsApp que aún no tiene ficha: créala ahora con su nombre y el
        // teléfono desde el que escribe. Junto con el correo, la ficha queda completa sin
        // haberle pedido el teléfono. En web (sin número) no se crea nada aquí.
        if (!patientId && conv?.customer_phone) {
          patientId = await findOrCreatePatient({
            phone: conv.customer_phone,
            name: conv.customer_name || conversation.customer_name,
            conversationId: conversation.id,
          });
          if (patientId) await supabase.from("df_conversations").update({ patient_id: patientId }).eq("id", conversation.id);
        }
        if (patientId) await supabase.from("df_patients").update({ email }).eq("id", patientId);
        await supabase.from("df_conversations").update({ customer_email: email }).eq("id", conversation.id);
        // (La plantilla de consentimiento la decide handleMessage al cerrar el turno.)
        return "Correo guardado y ficha del paciente completa (nombre, teléfono y correo). " +
          "Dale las gracias en una línea y CONTINÚA con lo que estuviera pendiente (p. ej. ofrecerle hueco con proponer_hueco " +
          "o confirmar su cita). Si ya no queda nada, despídete.";
      },
    },
    {
      definition: {
        name: "marcar_urgencia",
        description:
          "Registra una URGENCIA para que recepción la gestione con prioridad. NO agendes cita. Úsala SOLO cuando ya hayas recogido: el nombre, una descripción del problema, el nivel de dolor del 1 al 10 y desde cuándo lo tiene. El teléfono NO se pide: el sistema usa el del WhatsApp o el de su ficha.",
        input_schema: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Nombre del paciente" },
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
        let patientId = conv?.patient_id || null;
        // El teléfono NUNCA se le pide: se usa el del canal (WhatsApp) o el de su ficha.
        let phone = conv?.customer_phone || conversation.customer_phone || null;
        if (!phone && patientId) {
          const { data: ficha } = await supabase
            .from("df_patients").select("phone").eq("id", patientId).maybeSingle();
          phone = ficha?.phone || null;
        }

        // customer_phone: se conserva el del canal (ver nota en buscar_paciente).
        await supabase.from("df_conversations").update({
          is_urgent: true,
          customer_name: nombre || conversation.customer_name,
          customer_phone: conversation.customer_phone || phone || null,
        }).eq("id", conversation.id);

        let nivel = Number(input.nivel_dolor);
        nivel = Number.isFinite(nivel) ? Math.max(1, Math.min(10, Math.round(nivel))) : null;

        await registrarAvisoRecepcion({
          conversationId: conversation.id, patientId, nombre, phone,
          resumen: input.resumen, nivelDolor: nivel, inicio: input.inicio_dolor, kind: "urgencia",
        });
        avisoEnEsteTurno = "urgencia";
        return "Urgencia registrada para recepción. NO agendes ninguna cita (ni ahora ni en este mismo mensaje): la gestiona recepción llamando al paciente. Dile, con calma y empatía, que el equipo revisará su caso y le contactará lo antes posible para atenderle con prioridad.";
      },
    },
    {
      definition: {
        name: "consulta_recepcion",
        description:
          "Deja un AVISO en el CRM para que recepción llame al paciente. Úsala SIEMPRE que el paciente plantee una duda clínica que tú no puedes resolver: si algo se le ha roto, movido, caído o descementado (férula, corona, bracket, provisional, implante…), si pregunta si puede seguir usando algo, si algo es normal, si manda una FOTO de un problema, o cualquier consejo sobre su tratamiento. NO le hagas más preguntas de las necesarias, NO le interrogues sobre el dolor si él no lo ha mencionado y NO le agendes cita: lo resuelve recepción.",
        input_schema: {
          type: "object",
          properties: {
            resumen: { type: "string", description: "Qué necesita saber o qué le ha pasado, en una o dos frases, con lo que haya contado (incluye si ha mandado fotos)." },
            nombre: { type: "string", description: "Nombre del paciente (opcional: si no, se usa el de su ficha)" },
          },
          required: ["resumen"],
        },
      },
      run: async (input) => {
        const { data: conv } = await supabase
          .from("df_conversations").select("patient_id, customer_phone, customer_name").eq("id", conversation.id).maybeSingle();
        const patientId = conv?.patient_id || null;
        let phone = conv?.customer_phone || conversation.customer_phone || null;
        if (!phone && patientId) {
          const { data: ficha } = await supabase.from("df_patients").select("phone").eq("id", patientId).maybeSingle();
          phone = ficha?.phone || null;
        }
        const nombre = input.nombre || conv?.customer_name || conversation.customer_name || null;
        await registrarAvisoRecepcion({
          conversationId: conversation.id, patientId, nombre, phone,
          resumen: input.resumen, nivelDolor: null, inicio: null, kind: "consulta",
        });
        await supabase.from("df_conversations")
          .update({ customer_name: nombre || conversation.customer_name }).eq("id", conversation.id);
        avisoEnEsteTurno = "consulta";
        return "Consulta registrada en el CRM para que recepción le llame. Respóndele en UN mensaje corto: " +
          "que lo van a revisar en recepción y le darán respuesta lo antes posible. NO le hagas más preguntas, " +
          "NO le ofrezcas ni le agendes cita y NO le des indicaciones clínicas por tu cuenta.";
      },
    },
    {
      definition: {
        name: "cambiar_titular_conversacion",
        description:
          "Úsala cuando quien escribe te diga que ÉL/ELLA no es el paciente que consta con ese número (p. ej. \"soy su madre\", \"la cita es para mí, no para Sergio\", \"este número es mío\"). Deja la conversación, el teléfono y las citas a nombre de la persona correcta. NO la uses cuando la cita sea para un hijo/a MENOR: para eso está nombre_menor en crear_cita.",
        input_schema: {
          type: "object",
          properties: {
            nombre_completo: { type: "string", description: "Nombre completo de la persona con la que estás hablando de verdad" },
            email: { type: "string", description: "Su correo electrónico, si ya te lo ha dado (si no, pídeselo después)" },
          },
          required: ["nombre_completo"],
        },
      },
      run: async (input) => {
        const nombre = String(input.nombre_completo || "").trim();
        if (!nombre) return "Necesito su nombre completo para poner la conversación a su nombre. Pídeselo.";
        const telefono = conversation.customer_phone || null;
        const email = String(input.email || "").trim();
        const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;

        // 1) ¿Ya tiene ficha? (comparando sin tildes ni mayúsculas)
        const candidatos = await searchPatientsByName(nombre, 5);
        let nuevo = candidatos.find((p) => !(p.tags || []).includes("menor")) || null;

        // 2) El teléfono deja de pertenecer a quien lo tuviera asignado (no era suyo).
        const anteriores = [];
        if (telefono) {
          const { data: conEseTel } = await supabase
            .from("df_patients").select("id, full_name, tags").in("phone", phoneVariants(telefono)).limit(10);
          for (const p of conEseTel || []) {
            if (nuevo && p.id === nuevo.id) continue;
            if ((p.tags || []).includes("menor")) continue;   // los menores usan el tel. del tutor
            await supabase.from("df_patients").update({ phone: null }).eq("id", p.id);
            await supabase.from("df_patient_history").insert({
              patient_id: p.id,
              note: `Se retiró el teléfono ${telefono}: lo usa ${nombre}, que escribió por WhatsApp indicando que la ficha no era suya.`,
            }).then(() => {}, () => {});
            anteriores.push(p);
          }
        }

        // 3) Ficha de la persona correcta: se crea si no existe, con teléfono y correo.
        if (!nuevo) {
          const { data, error } = await supabase.from("df_patients")
            .insert({ full_name: nombre, phone: telefono, email: emailValido })
            .select(PATIENT_COLS).single();
          if (error) return "No se ha podido crear su ficha: " + error.message;
          nuevo = data;
        } else {
          const patch = {};
          if (telefono && nuevo.phone !== telefono) patch.phone = telefono;
          if (emailValido && !nuevo.email) patch.email = emailValido;
          if (Object.keys(patch).length) await supabase.from("df_patients").update(patch).eq("id", nuevo.id);
          Object.assign(nuevo, patch);
        }

        // 4) La conversación pasa a ser suya.
        await supabase.from("df_conversations").update({
          patient_id: nuevo.id,
          customer_name: nuevo.full_name || nombre,
          customer_email: emailValido || nuevo.email || conversation.customer_email || null,
        }).eq("id", conversation.id);
        conversation.patient_id = nuevo.id;
        conversation.customer_name = nuevo.full_name || nombre;

        // 5) Las citas que el bot acaba de crear por error pasan a su nombre.
        let movidas = 0;
        const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        for (const p of anteriores) {
          const { data: suyas } = await supabase
            .from("df_appointments").select("id")
            .eq("patient_id", p.id).eq("status", "pending")
            .gte("created_at", desde).gte("starts_at", new Date().toISOString());
          const ids = (suyas || []).map((a) => a.id);
          if (ids.length) {
            await supabase.from("df_appointments").update({ patient_id: nuevo.id }).in("id", ids);
            movidas += ids.length;
          }
        }

        const nombresAnteriores = anteriores.map((p) => p.full_name).filter(Boolean).join(", ");
        return `Hecho: la conversación y este número quedan a nombre de ${nuevo.full_name || nombre}` +
          (nombresAnteriores ? ` (se ha retirado el número de la ficha de ${nombresAnteriores})` : "") +
          (movidas ? `, y ${movidas} cita(s) que estaban a nombre equivocado pasan a la suya` : "") + ". " +
          (nuevo.email ? "Su correo ya consta." : "Pídele UNA vez su correo electrónico y guárdalo con guardar_correo.") +
          " Discúlpate en una línea por la confusión, confírmale que queda a su nombre y sigue con lo que necesitaba. " +
          "Si hay citas duplicadas o que ya no quiere, compruébalas con consultar_citas.";
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
            .from("df_patients").select("id").in("phone", phoneVariants(conv.customer_phone)).limit(1).maybeSingle();
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
        name: "solicitar_cancelacion",
        description:
          "Úsala cuando el paciente quiera CANCELAR (anular) una cita que ya tiene, NO cuando quiera cambiarla de día/hora. Indica SIEMPRE en fecha_hora_cita cuál es la cita que quiere anular (la que él te diga). Avisa a recepción para que le contacten; tú NO canceles la cita.",
        input_schema: {
          type: "object",
          properties: {
            fecha_hora_cita: { type: "string", description: "La cita que quiere cancelar, en ISO local: 2026-09-15T10:00 (o solo el día: 2026-09-15). Es el dato que da el paciente." },
            motivo: { type: "string", description: "Motivo de la cancelación, si lo indica (opcional)" },
          },
        },
      },
      run: async (input) => {
        const { ids, conv } = await relatedPatientIds(conversation.id);
        const appts = await upcomingAppointments(ids, "df_treatments(name), df_patients(full_name)");
        if (!appts.length) {
          return "El paciente NO tiene ninguna cita programada ahora mismo en la agenda, así que no hay nada que cancelar. Coméntaselo con amabilidad (quizá recepción ya la anuló) y no registres ninguna solicitud.";
        }
        const sel = pickAppointment(appts, input.fecha_hora_cita);
        if (sel.ambiguous) {
          return "Tiene VARIAS citas y no queda claro cuál quiere cancelar. Pregúntale cuál de estas es, y vuelve a llamar a solicitar_cancelacion con su fecha_hora_cita:\n" +
            sel.ambiguous.map((a) => `- ${describeAppt(a)}`).join("\n");
        }
        if (!sel.appt) {
          return "No hay ninguna cita en la fecha que ha indicado. Estas son sus citas reales; pregúntale a cuál se refiere y vuelve a llamar a solicitar_cancelacion con la fecha correcta:\n" +
            appts.map((a) => `- ${describeAppt(a)}`).join("\n");
        }
        const appt = sel.appt;
        const cuando = describeAppt(appt);
        // El aviso de recepción apunta a la cita CONCRETA (appointment_id): el panel
        // ya muestra su día, hora, tratamiento y profesional, así que en el motivo
        // solo va lo que ha dicho el paciente (sin repetir la cita).
        const reason = String(input.motivo || "").trim() || null;
        const { error } = await supabase.from("df_cancellation_requests").insert({
          patient_id: appt.patient_id || conv?.patient_id || null,
          appointment_id: appt.id,
          conversation_id: conversation.id,
          customer_name: appt.df_patients?.full_name || conv?.customer_name || conversation.customer_name || null,
          customer_phone: conv?.customer_phone || conversation.customer_phone || null,
          reason,
          status: "pending",
        });
        if (error) return "No se ha podido registrar la solicitud de cancelación: " + error.message;
        // La cita queda marcada como "Avisa que no viene": recepción la ve en rojo en
        // la agenda y decide si la anula o la reprograma. Deja de recibir recordatorios.
        // (Si la migración del estado aún no se ha ejecutado, se ignora el fallo: la
        // solicitud ya está registrada y el aviso le llega igual a recepción.)
        try {
          const { error: eEstado } = await supabase.from("df_appointments")
            .update({ status: "avisa_no_viene" }).eq("id", appt.id);
          if (eEstado) console.error("[solicitar_cancelacion/estado]", eEstado.message);
        } catch (e) { console.error("[solicitar_cancelacion/estado]", e.message); }
        return `Solicitud de cancelación registrada para recepción y la cita del ${cuando} queda marcada como "avisa que no viene". ` +
          "Dile al paciente con empatía que has trasladado esa solicitud concreta y que recepción se pondrá en contacto con él en breve. " +
          "NO le confirmes que la cita ya está cancelada. Si aún no se lo has preguntado, ofrécele en la misma línea cambiarla a otro día " +
          "(con proponer_hueco y cita_a_cambiar) por si prefiere reprogramarla en vez de perderla.";
      },
    },
    {
      definition: {
        name: "confirmar_cita",
        description:
          "Úsala cuando el paciente CONFIRME que va a acudir a su cita (responde \"sí\", \"confirmo\", \"allí estaré\", \"ok\" a un recordatorio…). Deja la cita CONFIRMADA en la agenda y así dejan de enviársele recordatorios. Si tiene varias citas y no queda claro cuál, pregúntale primero.",
        input_schema: {
          type: "object",
          properties: {
            fecha_hora_cita: { type: "string", description: "La cita que confirma, en ISO local: 2026-09-15T10:00 (o solo el día). Si solo tiene una cita, no hace falta." },
          },
        },
      },
      run: async (input) => {
        const { ids } = await relatedPatientIds(conversation.id);
        const appts = await upcomingAppointments(ids, "df_treatments(name), df_patients(full_name)");
        if (!appts.length) {
          return "El paciente NO tiene ninguna cita programada ahora mismo, así que no hay nada que confirmar. Díselo con amabilidad y ofrécele darle una si la quiere.";
        }
        const sel = pickAppointment(appts, input.fecha_hora_cita);
        if (sel.ambiguous) {
          return "Tiene VARIAS citas y no queda claro cuál confirma. Pregúntale cuál es y vuelve a llamar a confirmar_cita con su fecha_hora_cita:\n" +
            sel.ambiguous.map((a) => `- ${describeAppt(a)}`).join("\n");
        }
        const appt = sel.appt || (appts.length === 1 ? appts[0] : null);
        if (!appt) {
          return "No hay ninguna cita en la fecha que ha indicado. Estas son sus citas reales; pregúntale a cuál se refiere:\n" +
            appts.map((a) => `- ${describeAppt(a)}`).join("\n");
        }
        if (appt.status === "confirmed") {
          return `Esa cita (${describeAppt(appt)}) ya constaba CONFIRMADA. Díselo con naturalidad para que se quede tranquilo; no hace falta nada más.`;
        }
        const { error } = await supabase.from("df_appointments")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
          .eq("id", appt.id);
        if (error) return "No se ha podido confirmar la cita: " + error.message;
        return `Cita CONFIRMADA en la agenda (${describeAppt(appt)}). Agradéceselo en una línea y dile que ya no recibirá más recordatorios de esa cita. No le pidas que la confirme otra vez.`;
      },
    },
    {
      definition: {
        name: "reagendar_cita",
        description:
          "Úsala cuando el paciente quiera CAMBIAR (reagendar) a otro día/hora la cita que ya tiene, y haya aceptado un hueco nuevo. Mueve su cita existente al nuevo hueco (con el mismo profesional, o uno equivalente si es un tratamiento generalista). Antes, ofrécele huecos con proponer_hueco.",
        input_schema: {
          type: "object",
          properties: {
            fecha_hora_inicio: { type: "string", description: "Nuevo inicio en ISO local (Madrid), p. ej. 2026-07-13T10:00" },
            fecha_hora_cita_actual: { type: "string", description: "La cita que quiere cambiar, en ISO local (2026-09-15T10:00 o solo el día). Indícala si el paciente tiene más de una cita." },
          },
          required: ["fecha_hora_inicio"],
        },
      },
      run: async (input) => {
        const { ids } = await relatedPatientIds(conversation.id);
        if (!ids.length) return "No localizo al paciente para reagendar. Pídele su nombre completo y búscalo con buscar_paciente.";
        const appts = await upcomingAppointments(ids, "df_treatments(name), df_patients(full_name)");
        if (!appts.length) return "El paciente no tiene ninguna cita futura que reagendar. Si quiere una cita nueva, agéndala con crear_cita.";
        const sel = pickAppointment(appts, input.fecha_hora_cita_actual);
        if (sel.ambiguous) {
          return "Tiene VARIAS citas y no queda claro cuál quiere cambiar. Pregúntale cuál es y vuelve a llamar a reagendar_cita indicando su fecha_hora_cita_actual:\n" +
            sel.ambiguous.map((a) => `- ${describeAppt(a)} → fecha_hora_cita_actual="${isoLocalDeCita(a)}"`).join("\n");
        }
        if (!sel.appt) {
          return "No hay ninguna cita en la fecha que ha indicado. Estas son sus citas reales; pregúntale a cuál se refiere:\n" +
            appts.map((a) => `- ${describeAppt(a)} → fecha_hora_cita_actual="${isoLocalDeCita(a)}"`).join("\n");
        }
        // Datos completos de la cita elegida (duración, profesional, gabinete…).
        const { data: appt } = await supabase
          .from("df_appointments").select("*, df_treatments(duration_minutes, is_first_visit)")
          .eq("id", sel.appt.id).maybeSingle();
        if (!appt) return "No he podido recuperar esa cita. Pídele que confirme el día y la hora de la cita que quiere cambiar.";
        const ref = isoLocalDeCita(sel.appt);
        const ctx = await contextoReagenda(appt);
        const r = await encajaReagenda(appt, ctx, input.fecha_hora_inicio);

        // Si esa hora no vale, NO se manda al modelo a buscar por su cuenta: aquí
        // mismo se le dan los huecos válidos PARA ESTA CITA (misma comprobación),
        // que es lo que rompía el bucle "le ofrezco → cuando acepta ya no vale".
        if (!r.ok) {
          fallosReagenda++;
          const motivo = {
            fecha: "La fecha/hora no es válida.",
            fuera_de_horario: "Esa hora queda fuera del horario de reserva (última cita 19:00 de lunes a jueves y 13:45 el viernes; no se agenda sábados ni domingos).",
            pasado: "Esa fecha ya ha pasado.",
            clinica_cerrada: "La clínica está CERRADA (vacaciones) ese día.",
            otra_cita_suya: "A esa hora el paciente ya tiene OTRA cita suya, se solaparían.",
            sin_consulta: `A esa hora no tiene consulta ${ctx.titular ? ctx.titular.name : "ningún profesional que pueda atender esa visita"}.`,
            ocupado: "Ese hueco ya está ocupado.",
          }[r.reason] || "Ese hueco no está libre.";
          const desde = /^\d{4}-\d{2}-\d{2}/.test(String(input.fecha_hora_inicio || ""))
            ? String(input.fecha_hora_inicio).slice(0, 10) : null;
          const slots = await huecosParaReagendar(appt, ctx, desde);
          const rendirse = fallosReagenda >= 3
            ? "\nYa has intentado el cambio varias veces sin éxito: no le des más vueltas. Dile que recepción le llamará " +
              "para dejarle la cita cambiada y deja el aviso con consulta_recepcion."
            : "";
          return `${motivo} NO se ha cambiado nada (la cita sigue como estaba). Discúlpate en una línea, sin dar detalles técnicos, ` +
            `y ofrécele estas horas —son las únicas válidas, no inventes otras—:\n${textoHuecosReagenda(slots, ref)}${rendirse}`;
        }

        const { error } = await supabase.from("df_appointments").update({
          starts_at: r.start.toISOString(), ends_at: r.end.toISOString(),
          professional_id: r.professional.id, cabinet: r.cabinet,
          status: "pending", confirmed_at: null,
          reminder_3d_at: null, reminder_1d_at: null, reminder_6h_at: null,
        }).eq("id", appt.id);
        if (error) return "No se ha podido reagendar la cita: " + error.message;
        fallosReagenda = 0;
        const nueva = r.start.toLocaleString("es-ES", {
          weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
        });
        return `HECHO: la cita del ${describeAppt(sel.appt)} queda cambiada al ${nueva} (con ${r.professional.name}, pendiente de confirmar por recepción). ` +
          "Confírmaselo al paciente con naturalidad, en una línea, SIN volver a ofrecerle horas ni llamar otra vez a reagendar_cita o crear_cita.";
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

// Identifica al paciente de una conversación por su número y deja la conversación
// enlazada a su ficha (así el CRM muestra su nombre y el bot no tiene que preguntar).
// Devuelve los datos que necesita el prompt, o null si el número no consta.
async function identifyConversationPatient(conversation) {
  let ficha = null;
  if (conversation.patient_id) {
    const { data } = await supabase
      .from("df_patients").select(PATIENT_COLS).eq("id", conversation.patient_id).maybeSingle();
    ficha = data || null;
  }
  if (!ficha && conversation.customer_phone) ficha = await patientByPhone(conversation.customer_phone);
  if (!ficha) return null;

  // Completa la ficha y la conversación con lo que falte, sin preguntar nada.
  const patch = {};
  if (conversation.patient_id !== ficha.id) patch.patient_id = ficha.id;
  if (ficha.full_name && conversation.customer_name !== ficha.full_name) patch.customer_name = ficha.full_name;
  if (ficha.email && !conversation.customer_email) patch.customer_email = ficha.email;
  if (Object.keys(patch).length) {
    await supabase.from("df_conversations").update(patch).eq("id", conversation.id);
    Object.assign(conversation, patch);
  }
  if (!ficha.phone && conversation.customer_phone) {
    await supabase.from("df_patients").update({ phone: conversation.customer_phone }).eq("id", ficha.id);
    ficha.phone = conversation.customer_phone;
  }

  // ¿Ya hizo la primera visita (que es gratuita)? La siguiente ya tiene coste.
  let hizoPrimeraVisita = false;
  try {
    const { data: fv } = await supabase
      .from("df_appointments").select("starts_at, status")
      .eq("patient_id", ficha.id).eq("is_first_visit", true).neq("status", "cancelled");
    const ahora = Date.now();
    hizoPrimeraVisita = (fv || []).some((a) => a.status === "done" || Date.parse(a.starts_at) < ahora);
  } catch (_e) { /* informativo */ }

  return {
    id: ficha.id,
    nombre: ficha.full_name || "",
    nombreCorto: String(ficha.full_name || "").trim().split(/\s+/)[0] || "",
    telefono: ficha.phone || conversation.customer_phone || "",
    email: ficha.email || "",
    estado: ficha.patient_state || "",
    hizoPrimeraVisita,
  };
}

// ---------------- Entrada principal ----------------
async function handleMessage({ channel, phone, token, name, email, text, imageUrl }) {
  const language = detectLanguage(text);
  const conversation = await getOrCreateConversation({ channel, phone, token, name, email, language });

  // Si el mensaje trae un adjunto (foto/archivo del paciente), se guarda junto al
  // texto para que se vea en la conversación del CRM.
  await saveMessage(conversation.id, "user", text, imageUrl || null);

  // Bot pausado (un humano ha tomado el control): no respondemos automáticamente.
  if (conversation.bot_enabled === false) {
    return { reply: null, conversation, botDisabled: true, language: conversation.language };
  }

  // Asistente APAGADO en general (interruptor del panel o BOT_ENABLED=false): el
  // mensaje queda guardado en Conversaciones para que recepción lo conteste a mano,
  // pero no se envía nada automático.
  if (!(await botActivo().catch(() => true))) {
    return { reply: null, conversation, botDisabled: true, pausaGeneral: true, language: conversation.language };
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
    // Con los profesionales asignados a cada tratamiento, para que el prompt
    // pueda decirle al bot quién realiza qué.
    supabase.from("df_treatments").select("*, df_treatment_professionals(professional_id)").order("name"),
  ]);

  // Si lo último que recibió fue una campaña o el consentimiento, el contexto es ESE
  // mensaje: el bot no retoma la conversación anterior, pero atiende con normalidad
  // cualquier otra cosa que pida (una cita, una duda…).
  const ultimoEnvio = await lastOutboundMark(conversation.id).catch(() => null);

  // QUIÉN ESCRIBE: se identifica por su NÚMERO, sin preguntarle nada. Si consta en el
  // CRM, el bot ya sabe su nombre, si es paciente de la clínica y si tiene correo.
  const ficha = await identifyConversationPatient(conversation).catch(() => null);

  const system = buildSystemPrompt({
    knowledgeBase: KNOWLEDGE_BASE,
    professionals: professionals || [],
    treatments: treatments || [],
    lastOutbound: ultimoEnvio,
    patient: ficha,
  });

  const history = await loadHistory(conversation.id);
  const tools = buildTools(conversation);

  const { text: reply } = await runAgent({ system, messages: history, tools });
  const finalReply = reply || (language === "ca"
    ? "Disculpi, ho pot repetir?"
    : "Disculpe, ¿me lo puede repetir?");

  await saveMessage(conversation.id, "assistant", finalReply);

  // Plantilla de consentimiento: se manda cuando el paciente ya tiene su cita y el
  // asistente NO ha dejado ninguna pregunta pendiente (si acaba de preguntar algo,
  // como el correo, la plantilla llegaría encima y el paciente no sabría a qué
  // responde). Si queda pendiente, se enviará en cuanto termine ese intercambio.
  const dejaPregunta = /[?¿]/.test(finalReply);
  const sendConsentTemplate = channel !== "web" && !dejaPregunta && (await consentPending(conversation.id));

  return { reply: finalReply, conversation, language, sendConsentTemplate };
}

module.exports = {
  handleMessage, getOrCreateConversation, saveMessage, phoneVariants,
  CAMPAIGN_CONTEXT_MARK, CONSENT_SENT_MARK,
};
