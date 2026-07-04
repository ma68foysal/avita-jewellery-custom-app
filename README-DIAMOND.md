# Avita Diamond Selector

Custom Shopify app: a cascading emerald-cut diamond selector (Natural/Lab → carat → colour →
clarity → ring size) with a live total of **ring base + selected stone**, driven by a CSV you
control. Built to scale to all six shapes with no rebuild.

## Architecture (the "why")

- **Shopify Remix (React Router) app** — embedded admin + theme app extension + Admin API.
- **Dynamic-variant checkout** — the storefront never sends a price. On add-to-cart the app
  re-prices server-side from Supabase, mints (or reuses) a hidden variant on the ring product
  at `base + stone`, and adds it with the specs as line-item properties. Result: one clean line
  item, native checkout, £100k+ totals handled safely.
- **Supabase** — holds the pricing tables (`diamond_prices`, `ring_pages`, `dynamic_variants`).
  Shopify OAuth sessions stay on the template's local SQLite (internal only).
- **App proxy** — the storefront calls `/apps/diamond/*`, which Shopify signs and forwards to the
  app. No CORS, and the shop is verified on every call.

## Data flow

```
Storefront block ──/apps/diamond/options─▶ valid combos + ring sizes
                 ──/apps/diamond/price───▶ authoritative base+stone+total (from Supabase)
                 ──/apps/diamond/cart────▶ mint variant, return {variantId, properties}
                 ──/cart/add.js──────────▶ native cart with specs as properties
```

## First-time setup

1. **Supabase schema** — open Supabase → SQL Editor, paste `supabase/schema.sql`, run it.
2. **Env** — in `.env`, set `SUPABASE_URL` (done) and `SUPABASE_SECRET_KEY`.
   ⚠️ Rotate the secret key that was shared in chat and use the fresh one.
3. **Install & run**
   ```bash
   npm install
   shopify app dev      # links the app, starts the tunnel, updates proxy URL for the session
   ```
4. **Load prices** — in the app admin → **Pricing**, upload a CSV with columns
   `shape, origin, carat, colour, clarity, price` (see `supabase/emerald_prices_template.csv`).
   `origin` = `natural`|`lab`; `price` in pounds. The whole file is validated before anything saves.
5. **Base prices** — set each ring product's Shopify price to its base (e.g. 18k Ring A = £1,200).
   Only use admin → **Ring base prices** if a base must differ from the product price.
6. **Add the block** — theme editor → open a ring product template → add the **Diamond Selector**
   app block → Save. (Remove/hide the theme's native "Add to cart" on these templates so the only
   buy path is the selector.)

## Ring products

- One product per metal page (18k, platinum, …), as the client specified.
- Keep ring products **single-variant** (one "Title" option). The app adds configuration variants
  under that option.

## Notes / follow-ups

- **Variant cleanup**: dynamic variants are keyed by price combo and reused, so growth is bounded
  (≈one variant per unique carat/colour/clarity/price per product). The `orders/create` webhook was
  removed because it needs Shopify's *protected customer data* approval — not worth it for launch.
  If variants ever need pruning, either request protected-data access and re-add the webhook, or add
  a scheduled job that deletes rows in `dynamic_variants` older than N days (accepting the small risk
  of an abandoned cart that referenced an old variant). The `ordered` column is retained for that.
- **Six shapes**: same engine — just add each shape's rows to the CSV (`shape` column) and set the
  block's *shape* setting on that shape's product template.
- Ring size H–Q with half sizes (ends at Q, no Q.5) is server-defined in `app/lib/diamonds.server.js`.
