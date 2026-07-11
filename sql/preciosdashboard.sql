-- =============================================================
-- Precios de tratamientos + facturación
-- Ejecutar UNA vez en el SQL Editor de Supabase (ANTES de desplegar el código).
-- Aditivo e idempotente.
-- =============================================================

-- Precio de referencia por tratamiento. Al reservar una cita con ese tratamiento,
-- se genera un cobro PENDIENTE en la ficha del paciente por este importe.
alter table public.df_treatments
  add column if not exists price_eur numeric(10,2);

-- (df_patient_payments ya existe; se reutiliza para los cobros por cita.)
-- Índice para localizar el cobro de una cita concreta (evitar duplicados).
create index if not exists df_patient_payments_appt_idx
  on public.df_patient_payments (appointment_id);

notify pgrst, 'reload schema';

-- Comprobación
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='df_treatments' and column_name='price_eur';
