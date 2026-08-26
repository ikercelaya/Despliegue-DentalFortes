// =============================================================
// Estado de una cita: las DOS confirmaciones
// -------------------------------------------------------------
// Son cosas distintas y hasta ahora se mezclaban en una sola:
//
//   1) La CITA la confirma RECEPCIÓN -> status='confirmed' (+ confirmed_at).
//      Las que agenda el bot nacen 'pending' para que recepción las valide;
//      las que se crean a mano en el CRM nacen ya confirmadas.
//
//   2) La ASISTENCIA la confirma el PACIENTE, contestando a un recordatorio
//      o pulsando el botón de la plantilla -> patient_confirmed_at.
//      Los recordatorios se envían HASTA que esto tiene valor.
//
// En la agenda: gris = pendiente de recepción · verde con un tick = confirmada ·
// verde con doble tick = confirmada y con la asistencia confirmada.
//
// La columna patient_confirmed_at la añade sql/confirmacion-asistencia.sql. Si esa
// migración todavía no se ha ejecutado, todo esto sigue funcionando: se detecta el
// error de columna inexistente y se reintenta sin ella (se pierde el doble tick,
// nada más).
// =============================================================

// ¿El error de Supabase es "esa columna no existe"? (migración sin ejecutar)
function faltaColumna(error, columna) {
  if (!error) return false;
  const msg = String(error.message || "") + " " + String(error.details || "");
  return new RegExp(columna, "i").test(msg);
}

// Actualiza una cita tolerando que patient_confirmed_at aún no exista en la tabla.
async function updateAppointment(supabase, id, patch) {
  const { data, error } = await supabase
    .from("df_appointments").update(patch).eq("id", id).select().single();
  if (error && "patient_confirmed_at" in patch && faltaColumna(error, "patient_confirmed_at")) {
    const { patient_confirmed_at: _sinUsar, ...resto } = patch;
    if (!Object.keys(resto).length) return { data: null, error: null };
    return supabase.from("df_appointments").update(resto).eq("id", id).select().single();
  }
  return { data, error };
}

// El PACIENTE confirma que va a acudir. No toca el status: que recepción haya validado
// la cita o no es otra decisión, y quien confirma aquí es él.
// Devuelve { ok, yaEstaba } para poder responderle sin repetirse.
async function marcarAsistencia(supabase, appt) {
  if (appt && appt.patient_confirmed_at) return { ok: true, yaEstaba: true };
  const { error } = await updateAppointment(supabase, appt.id, {
    patient_confirmed_at: new Date().toISOString(),
  });
  if (error) return { ok: false, yaEstaba: false, error };
  return { ok: true, yaEstaba: false };
}

// Al mover una cita de día/hora, la asistencia que el paciente había confirmado deja de
// valer: confirmó OTRO momento. Se limpia junto con los recordatorios ya enviados para
// que la cadencia vuelva a empezar sobre el hueco nuevo.
const RESET_AL_MOVER = {
  patient_confirmed_at: null,
  reminder_3d_at: null,
  reminder_1d_at: null,
  reminder_6h_at: null,
};

// ¿Está confirmada la asistencia? (tolera que la columna no exista todavía)
function asistenciaConfirmada(appt) {
  return !!(appt && appt.patient_confirmed_at);
}

module.exports = { updateAppointment, marcarAsistencia, asistenciaConfirmada, RESET_AL_MOVER, faltaColumna };
