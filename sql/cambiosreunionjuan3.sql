-- =============================================================
-- Cambios reunión con Juan (parte 3) — solicitudes de cancelación
-- Ejecutar en Supabase (SQL Editor). Idempotente.
-- =============================================================

-- Cuando un paciente pide CANCELAR una cita por el bot, se registra aquí para que
-- recepción le contacte y lo gestione a mano (el bot NO cancela la cita).
create table if not exists public.df_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.df_patients(id) on delete set null,
  appointment_id uuid references public.df_appointments(id) on delete set null,
  conversation_id uuid,
  customer_name text,
  customer_phone text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'handled')),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index if not exists df_cancellation_requests_status_idx on public.df_cancellation_requests (status, created_at desc);

alter table public.df_cancellation_requests enable row level security;

select to_regclass('public.df_cancellation_requests') as df_cancellation_requests;
