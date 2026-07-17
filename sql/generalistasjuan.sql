-- =============================================================
-- Generalistas de Dental Fortes (Irene y Mishelle)
-- Ejecutar UNA vez en el SQL Editor de Supabase. Idempotente.
-- El bot usa esta marca para saber quién puede atender primeras visitas /
-- limpiezas / revisiones generales. Mishelle es Periodoncia pero, según Juan,
-- también es generalista (se reparte con Irene), por eso hay que marcarla.
-- =============================================================
alter table public.df_professionals
  add column if not exists is_generalist boolean not null default false;

update public.df_professionals
  set is_generalist = true
  where name ilike '%irene%' or name ilike '%mishel%' or specialty ilike '%general%';

notify pgrst, 'reload schema';

-- Comprobación: Irene y Mishelle deben salir con is_generalist = true.
select name, specialty, is_generalist
from public.df_professionals
order by is_generalist desc, name;
