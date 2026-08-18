-- =============================================================
-- Dental Fortes · Importar citas de Cliniwin
-- Ejecutar en el SQL Editor de Supabase ANTES de importar. Idempotente.
-- -------------------------------------------------------------
-- df_appointments.source solo admitía 'manual', 'bot_web', 'bot_whatsapp' y 'form'.
-- Se añade 'import_cliniwin' para poder distinguir (y deshacer) lo importado.
-- =============================================================

alter table public.df_appointments drop constraint if exists df_appointments_source_check;
alter table public.df_appointments
  add constraint df_appointments_source_check
  check (source in ('manual', 'bot_web', 'bot_whatsapp', 'form', 'import_cliniwin'));

-- Las fichas creadas al importar también quedan marcadas.
alter table public.df_patients add column if not exists source text;

notify pgrst, 'reload schema';

-- =============================================================
-- COMPROBACIÓN (tras importar): cuántas citas hay por origen
-- =============================================================
select source, count(*) as citas, min(starts_at) as primera, max(starts_at) as ultima
  from public.df_appointments
 group by source
 order by source;

-- =============================================================
-- DESHACER la importación (solo si algo salió mal).
-- Lo mismo que hace el botón "Deshacer importación" del CRM.
-- =============================================================
-- delete from public.df_appointments
--  where source = 'import_cliniwin' or notes ilike '%Importada de Cliniwin%';
--
-- Y, si también quieres borrar las fichas creadas por esa importación
-- (ojo: solo las que NO tengan ninguna cita ni cobro):
-- delete from public.df_patients p
--  where p.source = 'import_cliniwin'
--    and not exists (select 1 from public.df_appointments a where a.patient_id = p.id)
--    and not exists (select 1 from public.df_patient_payments c where c.patient_id = p.id);
