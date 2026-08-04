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

// Al ELIMINAR o CANCELAR una cita, su cobro pendiente deja de tener sentido: esa visita
// ya no se va a hacer, así que no puede seguir sumando en "Facturación pendiente" del
// dashboard ni en la ficha del paciente. Se borra solo el cobro NO pagado; los cobros ya
// cobrados (o parciales) se conservan porque son dinero que sí entró en caja.
//   detachPaid: al borrar la cita, el cobro pagado se queda sin cita a la que apuntar;
//   se le quita la referencia para que no arrastre un id que ya no existe.
async function clearPendingPaymentForAppointment(supabase, appointmentId, { detachPaid = false } = {}) {
  if (!appointmentId) return 0;
  const { data } = await supabase
    .from("df_patient_payments").select("id, paid").eq("appointment_id", appointmentId);
  const cobros = data || [];
  const pendientes = cobros.filter((p) => p.paid !== true).map((p) => p.id);
  const pagados = cobros.filter((p) => p.paid === true).map((p) => p.id);
  if (pendientes.length) {
    await supabase.from("df_patient_payments").delete().in("id", pendientes);
  }
  if (detachPaid && pagados.length) {
    await supabase.from("df_patient_payments").update({ appointment_id: null }).in("id", pagados);
  }
  return pendientes.length;
}

module.exports = { ensurePaymentForAppointment, clearPendingPaymentForAppointment };
