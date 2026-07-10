-- =============================================================
-- Reseñas · Parte A — permitir notas con medias (4.5)
-- Ejecutar UNA vez en el SQL Editor de Supabase.
-- (El esquema nuevo ya lo trae; esto es para la base de datos que ya existe.)
-- =============================================================

alter table public.df_reviews
  alter column rating type numeric(2,1) using rating::numeric(2,1);

-- Comprobación
select column_name, data_type, numeric_precision, numeric_scale
from information_schema.columns
where table_schema = 'public' and table_name = 'df_reviews' and column_name = 'rating';
