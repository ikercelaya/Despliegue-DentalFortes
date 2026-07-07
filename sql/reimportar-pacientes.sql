-- =============================================================
-- Dental Fortes · Reimportar pacientes desde staging_pacientes
-- -------------------------------------------------------------
-- Requisitos previos:
--   1) Tener la tabla public.staging_pacientes con TODOS los
--      pacientes (importa tus CSV *_limpio.csv a esa misma tabla).
--   2) Ejecutar este script ENTERO en el SQL Editor de Supabase.
--
-- Qué hace:
--   · Añade la columna dni a df_patients (si no existe).
--   · Borra la importación anterior (deja intactos los pacientes
--     creados por el bot / a mano).
--   · Vuelve a insertar cada paciente con:
--       - Fecha de alta original  -> created_at
--       - DNI en su propia columna
--       - Dirección + CP + Población -> notes
--       - Primera visita (F.1.V.) y Última visita (F.U.V.)
--         como notas en el historial clínico.
--   · Es idempotente: puedes ejecutarlo varias veces sin duplicar.
--
-- Al terminar, si todo está bien:  drop table public.staging_pacientes;
-- =============================================================

alter table public.df_patients add column if not exists dni text;
alter table public.df_patients add column if not exists source text;

-- Borra SOLO la importación anterior; los pacientes creados por el bot
-- o a mano (source NULL y notas que no empiezan por 'DNI:') se conservan.
--   · source = 'import_excel'  -> importaciones de este mismo script
--   · notes like 'DNI:%'       -> importación vieja (formato anterior)
delete from public.df_patients
where source = 'import_excel' or notes like 'DNI:%';

do $$
declare
  r record; pid uuid;
  v_full text; v_digits text; v_phone text; v_email text;
  v_birth date; v_alta date; v_f1v date; v_fuv date; v_dir text;
begin
  for r in
    select
      "Nombre" as nombre, "Apellido 1" as ap1, "Apellido 2" as ap2, "Dni" as dni,
      "Teléfono" as telefono, "Móvil" as movil, "Email" as email,
      "Dirección" as direccion, "CP" as cp, "Población" as poblacion,
      "Fecha nacimiento" as nacimiento, "Fecha alta" as alta,
      "F.1.V." as f1v, "F.U.V." as fuv
    from public.staging_pacientes
  loop
    -- Nombre completo (sin espacios dobles); si queda vacío, se salta la fila
    v_full := trim(regexp_replace(
      concat_ws(' ',
        nullif(trim(r.nombre), ''),
        nullif(trim(r.ap1), ''),
        nullif(trim(r.ap2), '')
      ), '\s+', ' ', 'g'));
    if v_full = '' then continue; end if;

    -- Teléfono: preferimos Móvil; normalizamos a 34XXXXXXXXX
    v_digits := regexp_replace(coalesce(nullif(trim(r.movil), ''), trim(r.telefono), ''), '\D', '', 'g');
    v_phone := case
      when v_digits ~ '^34[0-9]{9}$' then v_digits
      when v_digits ~ '^[0-9]{9}$'   then '34' || v_digits
      else nullif(v_digits, '')
    end;

    v_email := nullif(lower(trim(r.email)), '');

    v_birth := case when trim(r.nacimiento) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
                    then to_date(trim(r.nacimiento), 'DD/MM/YYYY') else null end;
    v_alta  := case when trim(r.alta) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
                    then to_date(trim(r.alta), 'DD/MM/YYYY') else null end;
    v_f1v   := case when trim(r.f1v) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
                    then to_date(trim(r.f1v), 'DD/MM/YYYY') else null end;
    v_fuv   := case when trim(r.fuv) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
                    then to_date(trim(r.fuv), 'DD/MM/YYYY') else null end;

    -- Dirección · CP · Población (los vacíos se omiten)
    v_dir := nullif(concat_ws(' · ',
      nullif(trim(r.direccion), ''),
      case when trim(r.cp) <> '' then 'CP ' || trim(r.cp) end,
      nullif(trim(r.poblacion), '')
    ), '');

    insert into public.df_patients
      (full_name, phone, email, birth_date, patient_state, dni, source, notes, created_at)
    values
      (v_full, v_phone, v_email, v_birth, 'higiene',
       nullif(trim(r.dni), ''), 'import_excel', v_dir,
       coalesce(v_alta::timestamptz, now()))
    returning id into pid;

    if v_f1v is not null then
      insert into public.df_patient_history (patient_id, note, created_at)
      values (pid, 'Primera visita (histórica)', v_f1v::timestamptz);
    end if;
    if v_fuv is not null then
      insert into public.df_patient_history (patient_id, note, created_at)
      values (pid, 'Última visita (histórica)', v_fuv::timestamptz);
    end if;
  end loop;
end $$;

-- Comprobación
select count(*) as pacientes from public.df_patients;
select count(*) as visitas_historial from public.df_patient_history;
