-- ============================================================================
--  Avita Diamond Selector — migration v2
--  Run this in Supabase → SQL Editor AFTER schema.sql.
--  Adds: per-ring "enabled" toggle, and a shop-level settings store.
-- ============================================================================

-- Live/Hidden toggle for the selector on a given ring page.
alter table public.ring_pages
  add column if not exists enabled boolean not null default true;

-- One settings row per shop (which line-item specs to record, etc.).
create table if not exists public.shop_settings (
  shop        text        primary key,
  settings    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.shop_settings enable row level security;
