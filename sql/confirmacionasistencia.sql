-- =============================================================
-- Dental Fortes · CONFIRMACIÓN DE ASISTENCIA del paciente
-- Ejecutar en el SQL Editor de Supabase. Aditivo e idempotente.
-- -------------------------------------------------------------
-- Hasta ahora sólo había una confirmación y servía para dos cosas distintas.
-- A partir de aquí son dos, independientes:
--
--   1) La CITA la confirma RECEPCIÓN  -> status = 'confirmed' (+ confirmed_at).
--      Las que agenda el bot nacen 'pending' (recepción las valida); las que se
--      crean a mano en el CRM nacen ya confirmadas.
--
--   2) La ASISTENCIA la confirma el PACIENTE, contestando a un recordatorio o
--      pulsando el botón de la plantilla -> patient_confirmed_at.
--      Los recordatorios se siguen enviando HASTA que esto tenga valor.
--
-- En la agenda: gris = sin confirmar por recepción · verde con un tick =
-- confirmada · verde con doble tick = además el paciente confirmó que viene.
-- =============================================================

alter table public.df_appointments
  add column if not exists patient_confirmed_at timestamptz;

comment on column public.df_appointments.patient_confirmed_at is
  'Cuándo confirmó el PACIENTE que va a acudir (recordatorios). Distinto de confirmed_at, que es la confirmación de la cita por recepción.';

-- Los recordatorios buscan citas futuras con la asistencia sin confirmar: este índice
-- deja esa consulta en un vistazo aunque la agenda crezca.
create index if not exists df_appointments_patient_confirmed_idx
  on public.df_appointments (patient_confirmed_at, starts_at);

-- -------------------------------------------------------------
-- Traspaso de lo que ya había:
-- las citas que el paciente confirmó por el enlace del recordatorio se quedaron
-- como status='confirmed' + confirmed_at. Esa confirmación era SUYA, así que se
-- copia a la columna nueva para no volver a molestarle con recordatorios de una
-- cita que ya dio por buena. Sólo se tocan las que aún no tienen asistencia.
-- Es idempotente: al repetirlo no cambia nada.
-- -------------------------------------------------------------
update public.df_appointments
   set patient_confirmed_at = confirmed_at
 where confirmed_at is not null
   and patient_confirmed_at is null
   and status = 'confirmed';

notify pgrst, 'reload schema';

-- Comprobación: cómo queda repartida la agenda futura.
select
  status,
  (patient_confirmed_at is not null) as asistencia_confirmada,
  count(*) as citas
from public.df_appointments
where starts_at >= now()
group by status, asistencia_confirmada
order by status, asistencia_confirmada;
