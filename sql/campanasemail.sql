-- =============================================================
-- Dental Fortes · Campañas por CORREO (Resend) + canal de envío
-- Ejecutar en el SQL Editor de Supabase. Idempotente.
-- =============================================================

-- Canal por el que se envió cada destinatario de una campaña:
--   'whatsapp' (por defecto, lo de siempre) o 'email' (Resend).
-- Sirve para llevar cuentas separadas: el tope semanal de 200 mensajes es SOLO
-- de WhatsApp; los correos no consumen ese cupo.
alter table public.df_campaign_recipients
  add column if not exists channel text not null default 'whatsapp';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'df_campaign_recipients_channel_check') then
    alter table public.df_campaign_recipients
      add constraint df_campaign_recipients_channel_check check (channel in ('whatsapp', 'email'));
  end if;
end $$;

create index if not exists df_campaign_recipients_channel_idx
  on public.df_campaign_recipients (channel, status, sent_at desc);

notify pgrst, 'reload schema';

-- Comprobación
select channel, status, count(*) as envios
  from public.df_campaign_recipients
 group by channel, status
 order by channel, status;
