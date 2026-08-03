-- =============================================================
-- Dental Fortes · LIMPIEZA de datos de prueba (dejar el CRM listo para producción)
-- =============================================================
-- QUÉ BORRA:  citas, conversaciones y mensajes, urgencias, reseñas, solicitudes de
--             cancelación, pagos/cobros, presupuestos, historial y pendientes, campañas
--             y sus destinatarios, y los pacientes de PRUEBA (los creados por el bot o
--             a mano durante los tests).
-- QUÉ CONSERVA: los pacientes REALES importados del Excel (source = 'import_excel'),
--             profesionales, tratamientos, horarios, bloqueos, vacaciones de la clínica,
--             segmentos de marketing y usuarios del CRM.
--
-- CÓMO USARLO (SQL Editor de Supabase):
--   PASO 1 — ejecuta solo el bloque "VISTA PREVIA" y revisa los números.
--   PASO 2 — si estás de acuerdo, ejecuta el bloque "BORRADO".
--   PASO 3 — ejecuta el bloque "COMPROBACIÓN FINAL".
-- =============================================================


-- =============================================================
-- PASO 1 · VISTA PREVIA (no borra nada)
-- =============================================================
select 'pacientes REALES (se conservan)' as concepto, count(*) as registros
  from public.df_patients where source = 'import_excel'
union all select 'pacientes de PRUEBA (se borran)', count(*)
  from public.df_patients where source is distinct from 'import_excel'
union all select 'citas (se borran)',                count(*) from public.df_appointments
union all select 'conversaciones (se borran)',       count(*) from public.df_conversations
union all select 'mensajes (se borran)',             count(*) from public.df_messages
union all select 'urgencias (se borran)',            count(*) from public.df_urgencies
union all select 'reseñas (se borran)',              count(*) from public.df_reviews
union all select 'cobros/pagos (se borran)',         count(*) from public.df_patient_payments
union all select 'presupuestos (se borran)',         count(*) from public.df_patient_budgets
union all select 'campañas (se borran)',             count(*) from public.df_campaigns
union all select 'profesionales (se conservan)',     count(*) from public.df_professionals
union all select 'tratamientos (se conservan)',      count(*) from public.df_treatments
order by 1;

-- Los pacientes de prueba, uno a uno (para revisarlos antes de borrar):
select id, full_name, phone, source, created_at
  from public.df_patients
 where source is distinct from 'import_excel'
 order by created_at desc;


-- =============================================================
-- PASO 2 · BORRADO  (ejecuta este bloque cuando hayas revisado la vista previa)
-- =============================================================
begin;

-- 1) Actividad: citas, conversaciones, mensajes y avisos
delete from public.df_messages;
delete from public.df_conversations;
delete from public.df_cancellation_requests;
delete from public.df_urgencies;
delete from public.df_reviews;
delete from public.df_appointments;

-- 2) Dinero y fichas clínicas de prueba
delete from public.df_patient_payments;
delete from public.df_patient_budgets;
delete from public.df_patient_history;
delete from public.df_patient_pending;
delete from public.df_patient_treatments;

-- 3) Campañas de prueba (los segmentos y las plantillas de Meta se conservan)
delete from public.df_campaign_recipients;
delete from public.df_campaigns;

-- 4) Pacientes de PRUEBA (todo lo suyo ya se ha borrado arriba).
--    Los importados del Excel (source = 'import_excel') NO se tocan.
delete from public.df_patients where source is distinct from 'import_excel';

-- 5) Consentimiento de marketing a cero: la ronda de consentimiento empieza limpia
--    y solo quedará marcado quien pulse "Aceptar" en la plantilla.
update public.df_patients set marketing_consent = false;

-- 6) Ajustes de caja de días de prueba (la cadencia de recordatorios se conserva)
delete from public.df_settings where key like 'cash_initial:%';

commit;


-- =============================================================
-- PASO 3 · COMPROBACIÓN FINAL
-- =============================================================
select 'pacientes reales'      as concepto, count(*) as registros from public.df_patients
union all select 'con consentimiento', count(*) from public.df_patients where marketing_consent
union all select 'citas',              count(*) from public.df_appointments
union all select 'conversaciones',     count(*) from public.df_conversations
union all select 'mensajes',           count(*) from public.df_messages
union all select 'campañas',           count(*) from public.df_campaigns
union all select 'profesionales',      count(*) from public.df_professionals
union all select 'tratamientos',       count(*) from public.df_treatments
union all select 'segmentos',          count(*) from public.df_segments
union all select 'usuarios del CRM',   count(*) from public.df_users
order by 1;

-- Nota: si además quieres borrar los adjuntos del chat (fotos que enviaron los
-- pacientes), vacía el bucket "df-chat-media" desde Supabase → Storage.
