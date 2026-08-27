-- Mejoras pedidas por la clínica (documento MEJORAS_IA, puntos 1 y 5).
-- Idempotente: se puede ejecutar más de una vez sin romper nada.

-- 1) COLORES DE CADA DOCTOR EN LA AGENDA -------------------------------------
-- Cada cita se pinta del color de su profesional (bloque entero). Estos son los
-- colores que usan hoy en Cliniwin. Se pueden cambiar luego desde el panel, en
-- Profesionales → Color en agenda (si se vuelve a ejecutar este script, se
-- restauran estos).
update df_professionals set color = '#F06BA8' where name ilike 'vanesa%';                    -- rosa
update df_professionals set color = '#F2914A' where name ilike 'mishelle%';                  -- naranja
update df_professionals set color = '#8B5E3C' where name ilike 'jos_ %' or name ilike 'jose%'; -- marrón
update df_professionals set color = '#E8B48F' where name ilike 'ana n%' or name ilike 'ana';  -- color carne
update df_professionals set color = '#C5B3E6' where name ilike 'irene%';                     -- lila flojo
update df_professionals set color = '#3B82F6' where name ilike 'xavi%';                      -- azul
update df_professionals set color = '#F2C230' where name ilike 'mar_a gonz%';                -- amarillo
update df_professionals set color = '#7C4DD6' where name ilike 'eva%';                       -- lila fuerte
update df_professionals set color = '#B5CC2E' where name ilike '%ngeles%';                   -- amarillo verdoso

-- Cualquier profesional sin color se queda con un gris neutro (nunca en blanco).
update df_professionals set color = '#9CA3AF' where color is null or btrim(color) = '';

-- 2) ESTADO "AVISA QUE NO VIENE" ---------------------------------------------
-- El paciente avisa (por WhatsApp o por teléfono) de que no va a acudir, pero la
-- cita todavía no se anula: recepción decide si la reprograma o la cancela.
-- La cita se ve en ROJO en la agenda y deja de recibir recordatorios.
alter table df_appointments drop constraint if exists df_appointments_status_check;
alter table df_appointments add constraint df_appointments_status_check
  check (status in ('pending','confirmed','avisa_no_viene','cancelled','done','no_show'));

-- Comprobación rápida:
--   select name, color from df_professionals order by name;
--   select status, count(*) from df_appointments group by status;
