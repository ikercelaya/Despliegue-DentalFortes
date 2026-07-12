-- =============================================================
-- Dental Fortes CRM - Sincronizacion Google Calendar por profesional
-- Ejecutar una vez en el SQL Editor de Supabase.
-- Es idempotente: se puede volver a ejecutar sin duplicar columnas.
-- =============================================================

alter table public.df_professionals
  add column if not exists google_calendar_id text default 'primary',
  add column if not exists google_calendar_email text,
  add column if not exists google_calendar_refresh_token text,
  add column if not exists google_calendar_sync_enabled boolean not null default false,
  add column if not exists google_calendar_connected_at timestamptz,
  add column if not exists google_calendar_last_sync_at timestamptz,
  add column if not exists google_calendar_sync_error text;

alter table public.df_appointments
  add column if not exists google_event_id text,
  add column if not exists google_synced_at timestamptz,
  add column if not exists google_sync_error text;

create index if not exists df_appointments_google_event_idx
  on public.df_appointments (google_event_id);

notify pgrst, 'reload schema';
