-- =============================================================
-- Profesionales que cubren cada tratamiento
-- Ejecutar UNA vez en el SQL Editor de Supabase. Idempotente.
-- Une cada tratamiento con los profesionales que lo realizan, para que el bot
-- sepa a quién puede asignar cada tipo de cita (limpieza -> Irene/Mishelle, etc.).
-- =============================================================
create table if not exists public.df_treatment_professionals (
  treatment_id   uuid not null references public.df_treatments(id)   on delete cascade,
  professional_id uuid not null references public.df_professionals(id) on delete cascade,
  primary key (treatment_id, professional_id)
);
create index if not exists df_treatment_professionals_prof_idx
  on public.df_treatment_professionals (professional_id);

alter table public.df_treatment_professionals enable row level security;

notify pgrst, 'reload schema';

-- Comprobación
select to_regclass('public.df_treatment_professionals') as tabla;
