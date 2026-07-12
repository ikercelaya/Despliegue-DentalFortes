-- =============================================================
-- Dental Fortes CRM - Gestion interna de resenas
-- Ejecutar una vez en el SQL Editor de Supabase.
-- Es idempotente: se puede volver a ejecutar sin duplicar columnas.
-- =============================================================

alter table public.df_reviews
  add column if not exists reviewed boolean not null default false;

comment on column public.df_reviews.internal_resolution is
  'Notas internas de gestion de la resena.';

comment on column public.df_reviews.reviewed is
  'Marca si recepcion ya reviso o gestiono la resena.';

notify pgrst, 'reload schema';
