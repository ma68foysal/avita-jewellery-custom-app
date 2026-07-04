-- ============================================================================
--  Avita Diamond Selector — migration v3  (per-carat images)
--  Run in Supabase → SQL Editor AFTER schema.sql and schema_v2.sql.
--  Idempotent and additive — does not touch existing data.
-- ============================================================================

-- Optional image URL carried on price rows (the CSV "image_url" column).
alter table public.diamond_prices
  add column if not exists image_url text;

-- Explicit per-carat image assignments made in the app admin (highest priority).
create table if not exists public.carat_images (
  id          bigint generated always as identity primary key,
  shop        text        not null,
  shape       text        not null default 'emerald',
  carat       numeric(4,2) not null,
  image_url   text        not null,
  updated_at  timestamptz not null default now(),
  unique (shop, shape, carat)
);

create index if not exists carat_images_lookup_idx
  on public.carat_images (shop, shape);

alter table public.carat_images enable row level security;
