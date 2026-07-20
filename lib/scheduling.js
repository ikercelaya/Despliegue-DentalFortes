// =============================================================
// Reglas de agenda de Dental Fortes (requisitos de Juan)
// -------------------------------------------------------------
// Un único sitio con la lógica de:
//  - Clasificación generalista / especialista.
//  - Continuidad paciente-doctor (sigue con el doctor de su visita inicial).
//  - Reasignación: los generalistas (Irene, Mishell) se reparten entre sí;
//    los especialistas (cirugía, endodoncia, ortodoncia) NO se reasignan.
//  - Capacidad por gabinete: hasta N citas simultáneas en gabinetes distintos
//    (por defecto 3); las primeras visitas SIEMPRE son individuales.
// Se usa tanto desde el bot (lib/bot.js) como desde el panel (server.js).
// =============================================================

// Nº de gabinetes (citas simultáneas máximas para citas que no son primera visita).
const MAX_CABINETS = Math.max(1, Number(process.env.CLINIC_CABINETS || 3));

// ¿Es un generalista (reasignable)? Preferimos la marca explícita del CRM
// (df_professionals.is_generalist). Si la columna aún no existe, caemos a la
// heurística por especialidad ("general" en el texto).
function isGeneralist(p) {
  if (p && typeof p.is_generalist === "boolean") return p.is_generalist;
  return String(p?.specialty || "").toLowerCase().includes("general");
}

// Suma minutos a una hora "HH:MM" (aritmética de reloj, mismo día).
function addMinutes(hhmm, min) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const t = (h * 60 + m + Number(min || 0));
  const hh = Math.floor(t / 60) % 24;
  const mm = ((t % 60) + 60) % 60;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

// ¿El profesional trabaja ese día (0=lunes..6=domingo) en la franja [hhmm, endHhmm)?
// Si endHhmm se indica, la cita debe caber ENTERA antes del cierre de esa franja.
function availableAt(p, weekday, hhmm, endHhmm) {
  return (p.df_professional_schedules || []).some((s) => {
    if (Number(s.weekday) !== weekday) return false;
    const st = String(s.start_time).slice(0, 5);
    const en = String(s.end_time).slice(0, 5);
    if (!(st <= hhmm && hhmm < en)) return false;
    // La cita no puede terminar después del cierre (ignoramos casos que crucen medianoche).
    if (endHhmm && endHhmm > hhmm && endHhmm > en) return false;
    return true;
  });
}

// Coincidencia laxa entre la especialidad pedida (texto libre del bot) y la del
// profesional. Contempla sinónimos frecuentes (orto, cirugía, endo, perio, niños).
function matchesSpecialty(p, especialidad) {
  if (!especialidad) return false;
  const n = String(especialidad).toLowerCase().trim();
  const sp = String(p.specialty || "").toLowerCase();
  if (!n || !sp) return false;
  // Especialidades "compuestas" con matiz infantil/pediátrico (p. ej. "Odontopediatría y
  // ortodoncia infantil") NO deben capturar una petición genérica de otra área (p. ej.
  // "ortodoncia" a secas, que es de adultos) solo porque el texto contenga esa palabra.
  // Solo coinciden si el paciente TAMBIÉN menciona un matiz infantil/pediátrico (o pide
  // directamente odontopediatría), evitando así confundir al ortodoncista de adultos
  // con quien lleva ortodoncia infantil.
  const CHILD_MARKERS = ["infantil", "pediatr", "niñ", "hijo", "hija", "odontopedia"];
  const spIsChildish = CHILD_MARKERS.some((m) => sp.includes(m));
  const reqIsChildish = CHILD_MARKERS.some((m) => n.includes(m));
  if (spIsChildish && !reqIsChildish) return false;
  if (sp.includes(n) || n.includes(sp)) return true;
  const pairs = [
    ["orto", "orto"],
    ["cirug", "ciruj"], ["ciruj", "cirug"],
    ["endo", "endo"],
    ["perio", "perio"],
    ["niñ", "odontopedia"], ["infantil", "odontopedia"], ["pediatr", "odontopedia"],
    ["general", "general"], ["revision", "general"], ["revisión", "general"],
    ["limpieza", "general"], ["higiene", "general"],
  ];
  return pairs.some(([a, b]) => n.includes(a) && sp.includes(b));
}

// Día de la semana (0=lunes..6=domingo, convención de df_professional_schedules)
// y hora "HH:MM" a partir de una cadena ISO local "YYYY-MM-DDTHH:MM" (Madrid).
function localWeekdayAndTime(isoLocal) {
  const m = String(isoLocal || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const dow = new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay(); // 0=domingo..6=sábado
  return { weekday: (dow + 6) % 7, hhmm: `${hh}:${mm}` };
}

// Localiza al doctor de la VISITA INICIAL del paciente (continuidad).
async function continuityProfessional(supabase, patientId, byId) {
  if (!patientId) return null;
  const { data } = await supabase
    .from("df_appointments")
    .select("professional_id, is_first_visit, starts_at")
    .eq("patient_id", patientId)
    .not("professional_id", "is", null)
    .neq("status", "cancelled")                    // las citas canceladas no marcan continuidad
    .order("is_first_visit", { ascending: false }) // primero las primeras visitas
    .order("starts_at", { ascending: true })       // luego la más antigua
    .limit(1);
  const proId = data && data[0] && data[0].professional_id;
  return proId ? byId[proId] || null : null;
}

// Decide QUÉ profesional atiende, aplicando continuidad + reglas de especialista.
// Devuelve { professional, reason, preferred }. professional puede ser null si
// no hay a quién asignar respetando las reglas (p. ej. especialista no disponible).
async function resolveProfessional({ supabase, patientId, weekday, hhmm, endHhmm, especialidad, allowedProfessionalIds }) {
  // Seleccionamos "*" (en vez de columnas fijas) para no romper si aún no se ha
  // aplicado la migración con is_generalist: en ese caso el campo llega undefined
  // e isGeneralist() cae a la heurística por especialidad.
  const { data: pros } = await supabase
    .from("df_professionals")
    .select("*, df_professional_schedules(weekday, start_time, end_time)")
    .eq("active", true);
  let all = pros || [];
  // Si el tratamiento tiene profesionales asignados en el CRM, SOLO ellos pueden atenderlo.
  if (Array.isArray(allowedProfessionalIds) && allowedProfessionalIds.length) {
    const allowSet = new Set(allowedProfessionalIds);
    all = all.filter((p) => allowSet.has(p.id));
  }
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const avail = all.filter((p) => availableAt(p, weekday, hhmm, endHhmm));

  // 1) Continuidad paciente-doctor.
  const cont = await continuityProfessional(supabase, patientId, byId);
  if (cont) {
    if (availableAt(cont, weekday, hhmm, endHhmm)) return { professional: cont, reason: "continuidad" };
    if (!isGeneralist(cont)) {
      // Especialista: NO se reasigna. Hay que proponer otra hora con él/ella.
      return { professional: null, reason: "especialista_no_disponible", preferred: cont };
    }
    // Generalista: se puede repartir con otro generalista disponible.
    const g = avail.find((p) => isGeneralist(p));
    if (g) return { professional: g, reason: "reasignado_generalista", preferred: cont };
    return { professional: null, reason: "sin_generalista_disponible", preferred: cont };
  }

  // 2) Paciente nuevo / sin historial: enrutar por especialidad si se indica.
  if (especialidad) {
    const spec = avail.find((p) => matchesSpecialty(p, especialidad));
    if (spec) return { professional: spec, reason: "especialidad" };
    const specAny = all.find((p) => matchesSpecialty(p, especialidad));
    if (specAny && !isGeneralist(specAny)) {
      // Especialista de esa área existe pero no trabaja a esa hora.
      return { professional: null, reason: "especialista_no_disponible", preferred: specAny };
    }
  }

  // 3) Por defecto (revisión / limpieza / primera visita general): un GENERALISTA
  //    disponible (Irene o Mishelle). Se reparten entre ellas.
  const g = avail.find((p) => isGeneralist(p));
  if (g) return { professional: g, reason: "generalista" };

  // 4) No hay generalista con consulta a esa hora: NO asignamos a un especialista al
  //    azar (una limpieza/revisión la atiende un generalista). Se propondrá otra hora.
  return { professional: null, reason: "sin_generalista_disponible" };
}

// Comprueba capacidad y asigna gabinete. startISO/endISO en ISO (UTC o con zona).
// Reglas:
//  - Un mismo profesional no puede solaparse consigo mismo.
//  - Primera visita: individual (no puede coincidir con ninguna otra cita).
//  - No primera visita: no puede coincidir con una primera visita y como mucho
//    MAX_CABINETS simultáneas, cada una en un gabinete distinto.
async function assignCabinet({ supabase, startISO, endISO, isFirstVisit, professionalId, excludeId, desiredCabinet, maxCabinets = MAX_CABINETS }) {
  const { data: overlap, error } = await supabase
    .from("df_appointments")
    .select("*")   // "*" para no romper si aún no existe la columna cabinet (pre-migración)
    .in("status", ["pending", "confirmed"])
    .lt("starts_at", endISO)   // empieza antes de que acabe la nueva
    .gt("ends_at", startISO);  // acaba después de que empiece la nueva
  if (error) return { ok: false, reason: "error_capacidad", detail: error.message };
  const rows = (overlap || []).filter((r) => r.id !== excludeId);

  // Mismo profesional ya ocupado en ese tramo: no puede tener dos citas a la vez.
  if (professionalId && rows.some((r) => r.professional_id === professionalId)) {
    return { ok: false, reason: "profesional_ocupado" };
  }

  // Regla de Juan (aclarada): hasta MAX_CABINETS (3) citas simultáneas, cada una con un
  // profesional distinto y en un gabinete distinto. NO se trata la primera visita como
  // individual: una valoración con la cirujana puede coexistir con otras 2 citas a esa
  // hora siempre que la cirujana esté libre.
  if (rows.length >= maxCabinets) return { ok: false, reason: "sin_gabinete_libre" };
  const used = new Set(rows.map((r) => r.cabinet).filter((c) => c != null));

  // Gabinete solicitado explícitamente (panel): respétalo solo si está libre.
  if (desiredCabinet != null) {
    const d = Number(desiredCabinet);
    if (used.has(d)) return { ok: false, reason: "gabinete_ocupado" };
    if (d >= 1 && d <= maxCabinets) return { ok: true, cabinet: d };
  }
  for (let c = 1; c <= maxCabinets; c++) {
    if (!used.has(c)) return { ok: true, cabinet: c };
  }
  return { ok: false, reason: "sin_gabinete_libre" };
}

// Mensaje legible para el motivo de un rechazo de capacidad (para el panel/bot).
const CAPACITY_REASONS = {
  profesional_ocupado: "El profesional ya tiene una cita a esa hora.",
  primera_visita_no_individual: "Una primera visita debe ser individual y ese tramo ya tiene otra cita.",
  solapa_primera_visita: "A esa hora hay una primera visita (que debe ser individual).",
  sin_gabinete_libre: "No quedan gabinetes libres a esa hora (máximo alcanzado).",
  gabinete_ocupado: "Ese gabinete ya está ocupado a esa hora.",
  error_capacidad: "No se ha podido comprobar la disponibilidad.",
};

module.exports = {
  MAX_CABINETS,
  isGeneralist,
  availableAt,
  addMinutes,
  matchesSpecialty,
  localWeekdayAndTime,
  continuityProfessional,
  resolveProfessional,
  assignCabinet,
  CAPACITY_REASONS,
};
