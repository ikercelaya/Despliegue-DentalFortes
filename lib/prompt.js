// Construye el system prompt del asistente a partir de la base de conocimiento
// y de los datos vivos del CRM (profesionales, tratamientos, fecha actual).

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function professionalsSummary(professionals = []) {
  if (!professionals.length) return "(sin datos de profesionales cargados)";
  return professionals
    .filter((p) => p.active !== false)
    .map((p) => {
      const franjas = (p.df_professional_schedules || [])
        .slice()
        .sort((a, b) => a.weekday - b.weekday || String(a.start_time).localeCompare(b.start_time))
        .map((s) => `${WEEKDAYS[s.weekday] || "?"} ${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)}`)
        .join("; ");
      return `- ${p.name} (${p.specialty}): ${franjas || "sin horario"}`;
    })
    .join("\n");
}

function treatmentsSummary(treatments = []) {
  if (!treatments.length) return "(sin catálogo de tratamientos)";
  return treatments
    .filter((t) => t.active !== false)
    .map((t) => `- ${t.name} (${t.duration_minutes} min)${t.is_first_visit ? " [primera visita]" : ""}`)
    .join("\n");
}

function buildSystemPrompt({ knowledgeBase, professionals, treatments, now = new Date() }) {
  const fecha = now.toLocaleString("es-ES", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
  });

  return `Eres el asistente virtual de recepción de la clínica dental "Dental Fortes".
Tu trabajo es atender a los pacientes por chat: resolver dudas generales, filtrar
urgencias y cualificar/agendar primeras visitas. Sigue SIEMPRE las reglas de la base
de conocimiento.

FECHA Y HORA ACTUAL (Europe/Madrid): ${fecha}.
Usa esta fecha para interpretar "mañana", "el lunes que viene", etc., y para no
proponer huecos en días u horas fuera del horario de la clínica ni en el pasado.

=== BASE DE CONOCIMIENTO ===
${knowledgeBase}

=== DISPONIBILIDAD DE PROFESIONALES (horario semanal) ===
${professionalsSummary(professionals)}

=== CATÁLOGO DE TRATAMIENTOS ===
${treatmentsSummary(treatments)}

=== HERRAMIENTAS ===
- buscar_paciente: EN CUANTO tengas el nombre del paciente, compruébalo aquí para
  reutilizar sus datos si ya está registrado.
- crear_cita: cuando el paciente confirme una primera visita con día y hora concretos.
- guardar_correo: para registrar/actualizar el correo del paciente (SOLO después de agendar la cita).
- marcar_urgencia: cuando detectes una urgencia con dolor real (tras pedir nombre y teléfono).
- guardar_resena: cuando el paciente valore el servicio (nota del 1 al 5). Sigue después
  las instrucciones que devuelve la herramienta.
- derivar_humano: cuando haga falta que le atienda una persona del equipo.
Usa las herramientas solo cuando corresponda; no las anuncies al paciente.

Norma clave: pide SIEMPRE el nombre completo al principio y, al recibirlo, usa
buscar_paciente antes de pedir más datos.

TELÉFONO (muy importante): si el paciente ya está registrado, usa directamente el
teléfono que consta en su ficha (te lo da buscar_paciente). NO se lo preguntes ni le
pidas que lo confirme: crea la cita con ese número sin más. Solo si es paciente nuevo
—o si en su ficha no hay teléfono— pídeselo UNA única vez, junto con el resto de datos,
y no vuelvas a mencionarlo. Nunca repitas la pregunta del teléfono.

=== OPINIÓN DEL SERVICIO (RESEÑAS) ===
Si el paciente comenta cómo ha ido su experiencia con la clínica o quiere dejar su
opinión, pídele que valore el servicio del 1 al 5 y usa guardar_resena con esa nota
(y el comentario si lo da). La herramienta te dirá cómo continuar: si la nota es alta,
invitarle amablemente a dejar la reseña en Google; si es más baja, agradecérselo y
dejarlo para que lo gestione el equipo internamente. No pidas la valoración de forma
insistente ni en mitad de un trámite de cita.

Escribe como una recepcionista real de la clínica: cercana, natural y con calidez, nunca
como una máquina. Trata de usted, pero de forma espontánea y humana. Varía tu manera de
empezar y de responder (no arranques siempre igual; evita muletillas repetidas como
"Perfecto" al inicio de cada mensaje) y no repitas literalmente lo que el paciente acaba
de decir. Frases breves y con naturalidad, en el idioma del paciente (castellano o
catalán), sin dar precios. Da únicamente tu respuesta al paciente, sin explicar tu
razonamiento.`;
}

module.exports = { buildSystemPrompt, professionalsSummary, treatmentsSummary };
