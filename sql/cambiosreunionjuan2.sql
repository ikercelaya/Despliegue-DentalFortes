-- =============================================================
-- Cambios reunión con Juan (parte 2) — vacaciones del personal
-- Ejecutar en Supabase (SQL Editor). Idempotente.
-- =============================================================

-- Días de vacaciones / ausencia por profesional. El bot no agenda citas con un
-- profesional en un rango [start_date, end_date] (fechas incluidas).
create table if not exists public.df_professional_time_off (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.df_professionals(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists df_professional_time_off_pid_idx on public.df_professional_time_off (professional_id);

alter table public.df_professional_time_off enable row level security;

select to_regclass('public.df_professional_time_off') as df_professional_time_off;
