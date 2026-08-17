-- =============================================================
-- Dental Fortes · CONSULTAS para recepción (avisos que no son urgencias)
-- Ejecutar en el SQL Editor de Supabase. Aditivo e idempotente.
-- -------------------------------------------------------------
-- El bot deja aquí las dudas clínicas que no puede resolver (una férula rota,
-- "¿puedo seguir usando esto?", una foto de un problema…) para que recepción
-- llame al paciente. Se guardan en la misma tabla que las urgencias, con
-- kind='consulta' para poder distinguirlas.
-- =============================================================

alter table public.df_urgencies
  add column if not exists kind text not null default 'urgencia';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'df_urgencies_kind_check') then
    alter table public.df_urgencies
      add constraint df_urgencies_kind_check check (kind in ('urgencia', 'consulta'));
  end if;
end $$;

create index if not exists df_urgencies_kind_idx on public.df_urgencies (kind, status, created_at desc);

notify pgrst, 'reload schema';

-- Comprobación
select kind, status, count(*) as total
  from public.df_urgencies
 group by kind, status
 order by kind, status;
