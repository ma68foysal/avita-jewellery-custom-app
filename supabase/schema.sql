-- ============================================================================
--  Avita Diamond Selector — Supabase schema
--  Run this in Supabase → SQL Editor once, against your project.
--  All money is stored as INTEGER PENCE (e.g. £1,200.00 -> 120000) to avoid
--  floating-point rounding on high-value orders (natural stones reach £101,500).
-- ============================================================================

-- ----------------------------------------------------------------------------
--  diamond_prices — one row per valid stone combination, per shop.
--  Populated by the monthly CSV upload in the app admin.
-- ----------------------------------------------------------------------------
create table if not exists public.diamond_prices (
  id           bigint generated always as identity primary key,
  shop         text        not null,               -- myshop.myshopify.com
  shape        text        not null default 'emerald',
  origin       text        not null,               -- 'natural' | 'lab'
  carat        numeric(4,2) not null,              -- 1.00 .. 4.00
  colour       text        not null,               -- 'D' | 'E' | 'F'
  clarity      text        not null,               -- 'VS1' | 'VVS2' | 'VVS1'
  price_pence  bigint      not null check (price_pence >= 0),
  updated_at   timestamptz not null default now(),
  -- one price per exact combination
  unique (shop, shape, origin, carat, colour, clarity)
);

create index if not exists diamond_prices_lookup_idx
  on public.diamond_prices (shop, shape, origin);

-- ----------------------------------------------------------------------------
--  ring_pages — optional per-product base-price override.
--  If a ring product has NO row here, the app falls back to the product's own
--  Shopify price as the base (recommended: just set the product price = base).
-- ----------------------------------------------------------------------------
create table if not exists public.ring_pages (
  id               bigint generated always as identity primary key,
  shop             text        not null,
  product_id       text        not null,           -- numeric Shopify product id
  title            text,                            -- e.g. "18k Ring A"
  metal            text,                            -- e.g. "18k Yellow Gold"
  shape            text        not null default 'emerald',
  base_price_pence bigint      check (base_price_pence >= 0),
  updated_at       timestamptz not null default now(),
  unique (shop, product_id)
);

-- ----------------------------------------------------------------------------
--  dynamic_variants — cache of variants minted for a price combo, so we reuse
--  a variant instead of creating a new one on every add-to-cart. Because the
--  combo key includes the total price, a monthly price change naturally mints
--  fresh variants and leaves old ones intact for any in-flight carts.
-- ----------------------------------------------------------------------------
create table if not exists public.dynamic_variants (
  id           bigint generated always as identity primary key,
  shop         text        not null,
  product_id   text        not null,
  variant_id   text        not null,               -- numeric Shopify variant id
  combo_key    text        not null,               -- shape:origin:carat:colour:clarity:totalPence
  total_pence  bigint      not null,
  ordered      boolean     not null default false, -- set true on orders/create
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (shop, product_id, combo_key)
);

create index if not exists dynamic_variants_prune_idx
  on public.dynamic_variants (shop, ordered, last_used_at);

-- ----------------------------------------------------------------------------
--  RLS: these tables are only ever touched by the app server using the SECRET
--  key (which bypasses RLS). We still enable RLS with no public policies so
--  nothing is reachable with the publishable/anon key. Defence in depth.
-- ----------------------------------------------------------------------------
alter table public.diamond_prices   enable row level security;
alter table public.ring_pages       enable row level security;
alter table public.dynamic_variants enable row level security;
