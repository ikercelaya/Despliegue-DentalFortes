-- =============================================================
-- Cambios reunión con Juan (parte 4) — pagos parciales
-- Ejecutar en Supabase (SQL Editor). Idempotente.
-- =============================================================

-- Un cobro puede ser PARCIAL: amount_eur = lo cobrado ahora, total_eur = precio total
-- del tratamiento. Si is_partial = true, queda pendiente (total_eur - amount_eur).
alter table public.df_patient_payments
  add column if not exists total_eur numeric(10,2),
  add column if not exists is_partial boolean not null default false;

-- Para los cobros ya existentes, el total coincide con lo cobrado (no eran parciales).
update public.df_patient_payments set total_eur = amount_eur where total_eur is null;

select
  count(*) filter (where is_partial) as cobros_parciales,
  count(*) as cobros_totales
from public.df_patient_payments;
