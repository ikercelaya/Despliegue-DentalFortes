-- =============================================================
-- Cambios reunión con Juan (20 jul) — tablas nuevas
-- Ejecutar en Supabase (SQL Editor). Es idempotente: se puede correr varias veces.
-- =============================================================

-- 1) Etiquetas de tratamiento por paciente ---------------------------------
-- Conjunto de tratamientos que un paciente ha recibido / recibe, para segmentar
-- campañas y filtrar en Pacientes. Independiente de las citas (los pacientes
-- importados no traen historial de citas, pero sí se pueden etiquetar a mano).
create table if not exists public.df_patient_treatments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.df_patients(id) on delete cascade,
  treatment_id uuid not null references public.df_treatments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (patient_id, treatment_id)
);
create index if not exists df_patient_treatments_pid_idx on public.df_patient_treatments (patient_id);
create index if not exists df_patient_treatments_tid_idx on public.df_patient_treatments (treatment_id);

-- 2) Estado del presupuesto por paciente -----------------------------------
-- Presupuesto de primera visita: recepción lo mueve entre "pendiente" y
-- "aceptado". Una fila por paciente (el presupuesto vivo). Los pacientes con
-- primera visita que aún no tengan fila se consideran "pendiente" por defecto.
create table if not exists public.df_patient_budgets (
  patient_id uuid primary key references public.df_patients(id) on delete cascade,
  status text not null default 'pendiente' check (status in ('pendiente', 'aceptado')),
  updated_at timestamptz not null default now()
);

-- RLS: mismas políticas de servicio que el resto (acceso vía service_role del backend)
alter table public.df_patient_treatments enable row level security;
alter table public.df_patient_budgets enable row level security;

-- Comprobación
select
  to_regclass('public.df_patient_treatments') as df_patient_treatments,
  to_regclass('public.df_patient_budgets')    as df_patient_budgets;
