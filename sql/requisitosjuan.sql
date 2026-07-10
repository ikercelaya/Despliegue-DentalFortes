-- =============================================================
-- Requisitos de Juan — agenda por especialistas, gabinetes y recordatorios
-- Ejecutar UNA vez en el SQL Editor de Supabase (ANTES de desplegar el código).
-- Todo es aditivo e idempotente: no toca datos existentes.
-- =============================================================

-- 1) Generalista (reasignable) por profesional -----------------------------
--    Los generalistas (odontología general) se reparten entre sí; los
--    especialistas (cirugía, endodoncia, ortodoncia...) NO se reasignan.
alter table public.df_professionals
  add column if not exists is_generalist boolean not null default false;

-- Marca por defecto como generalista a quien tenga "general" en su especialidad.
update public.df_professionals
  set is_generalist = true
  where is_generalist = false and specialty ilike '%general%';

-- Juan indicó que Irene y Mishell son las generalistas (aunque la especialidad
-- registrada de Mishell no sea "general"). Ajusta aquí los nombres si hiciera falta.
update public.df_professionals
  set is_generalist = true
  where name ilike '%irene%' or name ilike '%mishel%';

-- 2) Gabinete y confirmación/recordatorios por cita ------------------------
alter table public.df_appointments
  add column if not exists cabinet smallint,                       -- 1..N (nº de gabinete)
  add column if not exists confirmed_at timestamptz,               -- cuándo confirmó el paciente
  add column if not exists reminder_3d_at timestamptz,             -- recordatorio a 3 días enviado
  add column if not exists reminder_1d_at timestamptz,             -- recordatorio a 1 día enviado
  add column if not exists reminder_6h_at timestamptz,             -- recordatorio a 6 horas enviado
  add column if not exists auto_cancelled boolean not null default false; -- cancelada por no confirmar

-- Índice para el cálculo de solapamientos/capacidad por gabinete.
create index if not exists df_appointments_active_when_idx
  on public.df_appointments (starts_at, ends_at)
  where status in ('pending', 'confirmed');

-- Refresca el cache de PostgREST.
notify pgrst, 'reload schema';

-- Comprobación
select
  (select count(*) from public.df_professionals where is_generalist) as generalistas,
  (select count(*) from information_schema.columns
     where table_name = 'df_appointments' and column_name = 'cabinet') as tiene_gabinete;
