-- =============================================================
-- Dental Fortes · Segmentos de marketing con filtros + datos del paciente
-- Ejecutar en el SQL Editor de Supabase. Idempotente (se puede repetir).
-- =============================================================

-- -----------------------------------------------------------------
-- 1) Datos del paciente que usan los segmentos y las plantillas
--    - sex     : para segmentar por sexo (masculino / femenino)
--    - address : dirección, para usarla como variable en las plantillas
-- -----------------------------------------------------------------
alter table public.df_patients add column if not exists sex text;
alter table public.df_patients add column if not exists address text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'df_patients_sex_check'
  ) then
    alter table public.df_patients
      add constraint df_patients_sex_check check (sex is null or sex in ('M', 'F'));
  end if;
end $$;

-- Los pacientes importados del Excel guardaron su dirección en "notes"
-- ("Calle … · CP … · Población"): la copiamos a address si aún está vacía.
update public.df_patients
   set address = notes
 where source = 'import_excel'
   and address is null
   and notes is not null
   and trim(notes) <> '';

-- -----------------------------------------------------------------
-- 2) Segmentos guardados (con sus filtros) para las campañas
--    filters = {
--      "treatment_ids":   ["uuid", ...],   -- tratamiento(s)
--      "professional_ids":["uuid", ...],   -- profesional(es) que le han atendido
--      "sex":             "M" | "F" | null,
--      "age_min":         30 | null,
--      "age_max":         45 | null
--    }
--    Los filtros de un segmento se combinan con Y (el paciente debe cumplirlos todos).
-- -----------------------------------------------------------------
create table if not exists public.df_segments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  filters    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.df_segments enable row level security;

notify pgrst, 'reload schema';

-- Comprobación
select
  to_regclass('public.df_segments') as df_segments,
  (select count(*) from public.df_patients where birth_date is not null) as con_fecha_nacimiento,
  (select count(*) from public.df_patients where sex is not null)        as con_sexo,
  (select count(*) from public.df_patients where address is not null)    as con_direccion,
  (select count(*) from public.df_patients)                              as pacientes_total;
