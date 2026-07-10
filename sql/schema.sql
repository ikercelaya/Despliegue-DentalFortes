-- =============================================================
-- Dental Fortes CRM · Esquema completo
-- Ejecutar entero en el SQL Editor de Supabase.
-- Tablas prefijadas con df_ para no chocar con otros proyectos.
-- =============================================================

create extension if not exists "pgcrypto";

-- -----------------------------
-- 1) Profesionales y horarios
-- -----------------------------
create table if not exists public.df_professionals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  specialty text not null,
  color text default '#9ca3af',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.df_professional_schedules (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.df_professionals(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = lunes ... 6 = domingo
  start_time time not null,
  end_time time not null
);

create index if not exists df_professional_schedules_pid_idx on public.df_professional_schedules (professional_id, weekday);

create table if not exists public.df_professional_blocks (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.df_professionals(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists df_professional_blocks_when_idx on public.df_professional_blocks (professional_id, start_at, end_at);

-- -----------------------------
-- 2) Catálogo de tratamientos
-- -----------------------------
create table if not exists public.df_treatments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_minutes int not null default 30,
  description text,
  active boolean not null default true,
  is_first_visit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------
-- 3) Pacientes
-- -----------------------------
create table if not exists public.df_patients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  email text,
  dni text,
  source text, -- null = alta manual/bot · 'import_excel' = migración inicial
  birth_date date,
  language text not null default 'es' check (language in ('es', 'ca')),
  patient_state text not null default 'higiene' check (patient_state in ('higiene', 'reposicion', 'control')),
  tags text[] not null default '{}',
  notes text,
  marketing_consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_patients_phone_idx on public.df_patients (phone);
create index if not exists df_patients_email_idx on public.df_patients (email);
create index if not exists df_patients_state_idx on public.df_patients (patient_state);
create index if not exists df_patients_created_idx on public.df_patients (created_at desc);

-- Tareas pendientes por paciente (lo que tiene pendiente de hacerse)
create table if not exists public.df_patient_pending (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.df_patients(id) on delete cascade,
  description text not null,
  treatment_id uuid references public.df_treatments(id) on delete set null,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists df_patient_pending_pid_idx on public.df_patient_pending (patient_id, done);

-- Historial / notas clínicas
create table if not exists public.df_patient_history (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.df_patients(id) on delete cascade,
  appointment_id uuid,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists df_patient_history_pid_idx on public.df_patient_history (patient_id, created_at desc);

-- Cobros
create table if not exists public.df_patient_payments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.df_patients(id) on delete cascade,
  appointment_id uuid,
  amount_eur numeric(10,2) not null,
  paid boolean not null default false,
  paid_at timestamptz,
  concept text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists df_patient_payments_pid_idx on public.df_patient_payments (patient_id, created_at desc);

-- -----------------------------
-- 4) Citas
-- -----------------------------
create table if not exists public.df_appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.df_patients(id) on delete set null,
  professional_id uuid references public.df_professionals(id) on delete set null,
  treatment_id uuid references public.df_treatments(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','done','no_show')),
  is_first_visit boolean not null default false,
  is_urgent boolean not null default false,
  source text not null default 'manual' check (source in ('manual','bot_web','bot_whatsapp','form')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_appointments_when_idx on public.df_appointments (starts_at);
create index if not exists df_appointments_pro_idx on public.df_appointments (professional_id, starts_at);
create index if not exists df_appointments_patient_idx on public.df_appointments (patient_id, starts_at desc);
create index if not exists df_appointments_status_idx on public.df_appointments (status);

-- -----------------------------
-- 5) Conversaciones (placeholder para el chatbot que se integra después)
-- -----------------------------
create table if not exists public.df_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.df_patients(id) on delete set null,
  customer_name text,
  customer_phone text,
  customer_email text,
  language text default 'es' check (language in ('es','ca')),
  channel text not null default 'web' check (channel in ('web','whatsapp')),
  status text not null default 'active' check (status in ('active','closed')),
  is_urgent boolean not null default false,
  bot_enabled boolean not null default true,
  access_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_conv_updated_idx on public.df_conversations (updated_at desc);
create index if not exists df_conv_token_idx on public.df_conversations (access_token);
create index if not exists df_conv_phone_channel_idx on public.df_conversations (customer_phone, channel);

create table if not exists public.df_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.df_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','admin')),
  content text not null,
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists df_messages_conv_idx on public.df_messages (conversation_id, created_at);

-- -----------------------------
-- 6) Reseñas (flujo 4.5/5)
-- -----------------------------
create table if not exists public.df_reviews (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references public.df_patients(id) on delete set null,
  appointment_id uuid references public.df_appointments(id) on delete set null,
  rating numeric(2,1) check (rating between 1 and 5), -- admite medias notas (p. ej. 4.5)
  comment text,
  routed_to text check (routed_to in ('google','internal')),
  status text not null default 'pending' check (status in ('pending','sent_to_google','handled_internal','closed')),
  internal_resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_reviews_status_idx on public.df_reviews (status, created_at desc);

-- -----------------------------
-- 7) Marketing (campañas y segmentos)
-- -----------------------------
create table if not exists public.df_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  segment text not null check (segment in ('por_edad','por_tratamiento','presupuestos_no_aceptados','inactivos','manual')),
  segment_config jsonb default '{}'::jsonb,
  message_template text not null,
  status text not null default 'draft' check (status in ('draft','scheduled','sent','cancelled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists df_campaigns_status_idx on public.df_campaigns (status, created_at desc);

create table if not exists public.df_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.df_campaigns(id) on delete cascade,
  patient_id uuid not null references public.df_patients(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sent','responded','opted_out','failed')),
  sent_at timestamptz,
  responded_at timestamptz
);

create index if not exists df_campaign_recipients_cid_idx on public.df_campaign_recipients (campaign_id, status);

-- -----------------------------
-- 8) Triggers de updated_at
-- -----------------------------
create or replace function public.df_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in select unnest(array[
    'df_professionals','df_treatments','df_patients','df_appointments',
    'df_conversations','df_reviews','df_campaigns'
  ]) loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.df_set_updated_at()',
      t
    );
  end loop;
end $$;

-- Refrescar updated_at de la conversación al insertar mensaje
create or replace function public.df_bump_conversation()
returns trigger as $$
begin
  update public.df_conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bump_conv on public.df_messages;
create trigger bump_conv after insert on public.df_messages
  for each row execute function public.df_bump_conversation();

-- -----------------------------
-- 9) RLS (solo activamos, las políticas se gestionan desde el backend con service_role)
-- -----------------------------
alter table public.df_professionals enable row level security;
alter table public.df_professional_schedules enable row level security;
alter table public.df_professional_blocks enable row level security;
alter table public.df_treatments enable row level security;
alter table public.df_patients enable row level security;
alter table public.df_patient_pending enable row level security;
alter table public.df_patient_history enable row level security;
alter table public.df_patient_payments enable row level security;
alter table public.df_appointments enable row level security;
alter table public.df_conversations enable row level security;
alter table public.df_messages enable row level security;
alter table public.df_reviews enable row level security;
alter table public.df_campaigns enable row level security;
alter table public.df_campaign_recipients enable row level security;

-- Recarga el cache de PostgREST
notify pgrst, 'reload schema';

-- Comprobación final
select
  to_regclass('public.df_professionals') as df_professionals,
  to_regclass('public.df_treatments') as df_treatments,
  to_regclass('public.df_patients') as df_patients,
  to_regclass('public.df_appointments') as df_appointments,
  to_regclass('public.df_conversations') as df_conversations,
  to_regclass('public.df_messages') as df_messages,
  to_regclass('public.df_reviews') as df_reviews,
  to_regclass('public.df_campaigns') as df_campaigns;
