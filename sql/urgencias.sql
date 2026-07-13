-- =============================================================
-- Urgencias pendientes
-- Ejecutar UNA vez en el SQL Editor de Supabase. Aditivo e idempotente.
-- El bot registra aquí las urgencias (con nivel de dolor e inicio) para que
-- recepción las gestione. Al agendarles cita, pasan a 'scheduled' y desaparecen
-- del listado de pendientes.
-- =============================================================

create table if not exists public.df_urgencies (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.df_conversations(id) on delete set null,
  patient_id uuid references public.df_patients(id) on delete set null,
  customer_name text,
  customer_phone text,
  summary text,                 -- síntoma / motivo que ha descrito el paciente
  pain_level smallint,          -- dolor del 1 al 10 (si aplica)
  onset text,                   -- desde cuándo (p. ej. "esta mañana", "hace 2 días")
  status text not null default 'pending' check (status in ('pending','scheduled','closed')),
  appointment_id uuid references public.df_appointments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_urgencies_status_idx on public.df_urgencies (status, created_at desc);
alter table public.df_urgencies enable row level security;

notify pgrst, 'reload schema';

-- Comprobación
select to_regclass('public.df_urgencies') as df_urgencies;
