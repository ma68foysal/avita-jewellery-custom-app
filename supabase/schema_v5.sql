-- v5: product-per-order model
-- Every Add-to-cart mints a fresh, hidden-but-buyable product. We log each one
-- here so a scheduled cleanup job can prune abandoned-cart orphans (products
-- that never became an order). Run this in the Supabase SQL editor.

create table if not exists minted_products (
  id          bigint generated always as identity primary key,
  shop        text        not null,
  product_id  text        not null,
  variant_id  text        not null,
  combo_key   text,
  total_pence integer,
  created_at  timestamptz not null default now()
);

create index if not exists minted_products_shop_created_idx
  on minted_products (shop, created_at);
