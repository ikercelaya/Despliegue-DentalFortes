-- =============================================================
-- Dental Fortes · Perfiles de acceso + Vacaciones de la clínica
-- Ejecutar en el SQL Editor de Supabase. Idempotente.
-- =============================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------
-- 1) Usuarios del CRM (perfiles: recepción = completo, trabajador = limitado)
-- -----------------------------------------------------------------
create table if not exists public.df_users (
  username      text primary key,
  password_hash text not null,           -- bcrypt (compatible con bcryptjs del backend)
  role          text not null check (role in ('reception', 'worker')),
  created_at    timestamptz not null default now()
);
alter table public.df_users enable row level security;

-- Usuario TRABAJADOR — contraseña: DentalFortes@
insert into public.df_users (username, password_hash, role)
values ('trabajador', crypt('DentalFortes@', gen_salt('bf')), 'worker')
on conflict (username) do update
  set password_hash = excluded.password_hash, role = excluded.role;

-- Usuario RECEPCIÓN:
--   Por defecto NO hace falta crearlo: "recepcion" entra con la CONTRASEÑA ACTUAL
--   del CRM (la de la variable de entorno ADMIN_PASSWORD_HASH de Vercel).
--   Si prefieres guardarla también en Supabase, descomenta y pon la contraseña:
-- insert into public.df_users (username, password_hash, role)
-- values ('recepcion', crypt('TU_CONTRASENA_ACTUAL', gen_salt('bf')), 'reception')
-- on conflict (username) do update
--   set password_hash = excluded.password_hash, role = excluded.role;

-- -----------------------------------------------------------------
-- 2) Vacaciones / cierres de la clínica (periodos en los que NO hay actividad)
--    El bot no ofrece ni agenda citas en esas fechas y el panel las bloquea.
-- -----------------------------------------------------------------
create table if not exists public.df_clinic_closures (
  id         uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date   date not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists df_clinic_closures_when_idx on public.df_clinic_closures (start_date, end_date);
alter table public.df_clinic_closures enable row level security;

notify pgrst, 'reload schema';

-- Comprobación
select
  to_regclass('public.df_users')            as df_users,
  to_regclass('public.df_clinic_closures')   as df_clinic_closures,
  (select count(*) from public.df_users)     as usuarios;
