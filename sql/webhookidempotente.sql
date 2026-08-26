-- =============================================================
-- Dental Fortes · WEBHOOK DE WHATSAPP IDEMPOTENTE
-- Ejecutar en el SQL Editor de Supabase. Aditivo e idempotente.
-- -------------------------------------------------------------
-- Meta espera muy poco por el 200 del webhook. Un turno del asistente (llamar al
-- modelo, ejecutar herramientas, consultar la agenda) tarda bastante más, así que
-- Meta da la entrega por fallida y la REINTENTA. El resultado era el mismo mensaje
-- del paciente guardado dos veces en Conversaciones y contestado dos veces.
--
-- Cada mensaje de WhatsApp trae un identificador único (el "wamid"). Aquí se apunta
-- cuál se ha procesado ya: la primera entrega lo reclama y las repeticiones se
-- descartan sin tocar nada.
--
-- El estado permite distinguir dos casos que NO son lo mismo:
--   'processing' -> se está atendiendo ahora (una entrega repetida se descarta)
--   'done'       -> ya se contestó (la repetición se descarta para siempre)
-- Si una pasada se queda a medias (la función se corta por tiempo), su fila se
-- queda en 'processing' y el reintento la retoma pasados unos minutos, para que el
-- paciente no se quede sin respuesta.
-- =============================================================

create table if not exists public.df_wa_processed (
  message_id  text primary key,          -- el wamid que manda Meta
  status      text not null default 'processing' check (status in ('processing', 'done')),
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);

comment on table public.df_wa_processed is
  'Mensajes de WhatsApp ya procesados (por wamid). Evita que un reintento de Meta duplique el mensaje y la respuesta del bot.';

-- Para la limpieza diaria de filas viejas.
create index if not exists df_wa_processed_created_idx
  on public.df_wa_processed (created_at);

alter table public.df_wa_processed enable row level security;

notify pgrst, 'reload schema';

-- Comprobación
select to_regclass('public.df_wa_processed') as df_wa_processed;
