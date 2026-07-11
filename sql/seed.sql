-- =============================================================
-- Datos iniciales de Dental Fortes (los 7 profesionales del PDF)
-- Ejecutar UNA SOLA VEZ después de schema.sql.
-- Idempotente: limpia los datos semilla antes de insertar, así que
-- es seguro re-ejecutarlo si un intento anterior quedó a medias.
-- weekday: 0=lunes 1=martes 2=miércoles 3=jueves 4=viernes 5=sábado 6=domingo
-- =============================================================

-- Limpieza previa (seguro en instalación inicial: aún no hay datos reales).
delete from public.df_professional_schedules;
delete from public.df_professionals;
delete from public.df_treatments;

-- Vanesa Fortes García — Cirujana — Lunes a Jueves 9:30-14:30
with vanesa as (
  insert into public.df_professionals (name, specialty, color)
  values ('Vanesa Fortes García', 'Cirujana', '#5b6cff')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, wd, '09:30'::time, '14:30'::time from vanesa, generate_series(0,3) as wd;

-- María González Muñoz — Ortodoncista — Jueves 10-14 y 15-19:30
with maria as (
  insert into public.df_professionals (name, specialty, color)
  values ('María González Muñoz', 'Ortodoncista', '#28a98c')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 3, '10:00'::time, '14:00'::time from maria
union all
select id, 3, '15:00'::time, '19:30'::time from maria;

-- Xavier Ribas Frau — Endodoncista — Miércoles 9:30-14:30 y 15-19
with xavier as (
  insert into public.df_professionals (name, specialty, color)
  values ('Xavier Ribas Frau', 'Endodoncista', '#e07a5f')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 2, '09:30'::time, '14:30'::time from xavier
union all
select id, 2, '15:00'::time, '19:00'::time from xavier;

-- Irene García García — General — Miércoles 10-14 y 15-20, Viernes 9:30-14
with irene as (
  insert into public.df_professionals (name, specialty, color)
  values ('Irene García García', 'Odontología general', '#9b5de5')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 2, '10:00'::time, '14:00'::time from irene
union all
select id, 2, '15:00'::time, '20:00'::time from irene
union all
select id, 4, '09:30'::time, '14:00'::time from irene;

-- José João Aparicio — Odontopediatría y ortodoncia infantil — Lunes 15-20
with jose as (
  insert into public.df_professionals (name, specialty, color)
  values ('José João Aparicio', 'Odontopediatría y ortodoncia infantil', '#f3a712')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 0, '15:00'::time, '20:00'::time from jose;

-- Mishelle Aramuni Tabares — Periodoncia — Martes y Jueves 10-14 y 15-19
with mishelle as (
  insert into public.df_professionals (name, specialty, color)
  values ('Mishelle Aramuni Tabares', 'Periodoncia', '#ef476f')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 1, '10:00'::time, '14:00'::time from mishelle
union all
select id, 1, '15:00'::time, '19:00'::time from mishelle
union all
select id, 3, '10:00'::time, '14:00'::time from mishelle
union all
select id, 3, '15:00'::time, '19:00'::time from mishelle;

-- Ana Nores Junquera — Prótesis — Lunes (jornada completa)
with ana as (
  insert into public.df_professionals (name, specialty, color)
  values ('Ana Nores Junquera', 'Prótesis', '#118ab2')
  returning id
)
insert into public.df_professional_schedules (professional_id, weekday, start_time, end_time)
select id, 0, '09:30'::time, '14:00'::time from ana
union all
select id, 0, '15:00'::time, '20:00'::time from ana;

-- Generalistas (odontología general): sus citas se pueden reasignar entre ellos
-- para rellenar huecos. Según Juan, las generalistas son Irene y Mishell.
update public.df_professionals set is_generalist = true
  where specialty ilike '%general%' or name ilike '%irene%' or name ilike '%mishel%';

-- Catálogo mínimo de tratamientos (placeholder, el cliente lo completará)
-- price_eur: precios de EJEMPLO; el cliente los ajusta en el apartado Tratamientos.
insert into public.df_treatments (name, duration_minutes, is_first_visit, price_eur) values
  ('Primera visita', 30, true, 0),
  ('Revisión', 20, false, 30),
  ('Limpieza / higiene', 45, false, 55),
  ('Empaste', 30, false, 60),
  ('Endodoncia', 60, false, 180),
  ('Ortodoncia (revisión)', 20, false, 45),
  ('Periodoncia', 45, false, 90),
  ('Prótesis (toma de medidas)', 45, false, 120),
  ('Odontopediatría', 30, false, 40);

select count(*) as profesionales from public.df_professionals;
select count(*) as tratamientos from public.df_treatments;