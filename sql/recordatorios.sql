-- =============================================================
-- Recordatorios · ajustes del CRM (cadencia configurable)
-- Ejecutar UNA vez en el SQL Editor de Supabase. Aditivo e idempotente.
-- Las columnas de recordatorio (reminder_3d_at, reminder_1d_at, reminder_6h_at,
-- confirmed_at) ya existen desde requisitos-juan.sql.
-- =============================================================

-- Tabla de ajustes clave/valor (para la cadencia y futuros ajustes del CRM).
create table if not exists public.df_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.df_settings enable row level security;

-- Cadencia por defecto (horas antes de la cita): 72 = 3 días, 24 = 1 día, 6 = 6 horas.
insert into public.df_settings (key, value)
values ('reminder_cadence', '{"offsets":[72,24,6]}'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- Comprobación
select key, value from public.df_settings where key = 'reminder_cadence';
