// Cobros automáticos por cita: al reservar una cita cuyo tratamiento tiene precio,
// se crea un cobro PENDIENTE en la ficha del paciente por ese importe.

// Crea (si no existe) el cobro pendiente asociado a una cita.
// Idempotente: si ya hay un cobro para esa cita, no crea otro.
async function ensurePaymentForAppointment(supabase, { appointmentId, patientId, treatmentId, startsAt }) {
  if (!appointmentId || !patientId || !treatmentId) return null;

  const { data: t } = await supabase
    .from("df_treatments").select("name, price_eur").eq("id", treatmentId).maybeSingle();
  const price = t && t.price_eur != null ? Number(t.price_eur) : null;
  if (price == null || !(price > 0)) return null; // tratamiento sin precio → no se cobra

  // ¿Ya existe un cobro para esta cita? (no duplicar)
  const { data: existing } = await supabase
    .from("df_patient_payments").select("id").eq("appointment_id", appointmentId).limit(1).maybeSingle();
  if (existing) return existing.id;

  let fecha = "";
  if (startsAt) { const d = new Date(startsAt); if (!isNaN(d.getTime())) fecha = d.toLocaleDateString("es-ES"); }
  const concept = `${t.name}${fecha ? " · cita " + fecha : ""}`;

  const { data } = await supabase.from("df_patient_payments").insert({
    patient_id: patientId,
    appointment_id: appointmentId,
    amount_eur: price,
    paid: false,
    concept,
  }).select("id").single();
  return data ? data.id : null;
}

module.exports = { ensurePaymentForAppointment };
