-- ============================================================================
--  Avita Diamond Selector — migration v4  (Shopify session storage)
--  Run in Supabase → SQL Editor. Needed when hosting on Vercel/serverless,
--  where the local SQLite session store does not persist.
-- ============================================================================

create table if not exists public.shopify_sessions (
  id          text        primary key,      -- Shopify session id
  shop        text        not null,
  session     jsonb       not null,          -- serialized Session (property array)
  updated_at  timestamptz not null default now()
);

create index if not exists shopify_sessions_shop_idx
  on public.shopify_sessions (shop);

alter table public.shopify_sessions enable row level security;
