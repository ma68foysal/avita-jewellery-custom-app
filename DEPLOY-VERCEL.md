# Deploy to Vercel (serverless — no always-on server)

The backend runs as Vercel serverless functions. Sessions + pricing live in Supabase,
so nothing needs a persistent disk. `shopify app dev` is only for local development —
once this is deployed, the store works 24/7 without it.

## One-time setup

### 1. Supabase tables
Run these in Supabase → SQL Editor (in order), if you haven't already:
- `supabase/schema.sql`
- `supabase/schema_v2.sql`
- `supabase/schema_v3.sql`
- `supabase/schema_v4.sql`   ← **required for Vercel** (creates `shopify_sessions`)

### 2. Push to GitHub
```bash
git init && git add -A && git commit -m "Avita diamond selector"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```
(`.env`, `.env.example`, `node_modules`, `build` are gitignored — no secrets pushed.)

### 3. Import into Vercel
- Vercel → **Add New → Project → import the GitHub repo**.
- Framework Preset: **React Router** (auto-detected). Leave build/output as default —
  the `react-router.config.js` Vercel preset handles it. No `vercel.json` needed.
- Add **Environment Variables** (Production) — values from `shopify app env show` and Supabase:
  ```
  SHOPIFY_API_KEY=2905ccf0d17b00edd420b1a21406b57a
  SHOPIFY_API_SECRET=<your app client secret>
  SCOPES=read_products,write_products,read_files,write_metaobjects,write_metaobject_definitions
  SHOPIFY_APP_URL=https://avita-jewellery-custom-app.vercel.app
  SUPABASE_URL=https://qujuzqoootzddsdmxxkd.supabase.co
  SUPABASE_SECRET_KEY=<your rotated Supabase secret key>
  ```
- **Deploy.**

### 4. Point the Shopify app at Vercel
`shopify.app.toml` is already set to `https://avita-jewellery-custom-app.vercel.app`
(application_url + app_proxy). Push it to Shopify:
```bash
shopify app deploy
```
This publishes the app config (app URL + `/apps/diamond` proxy → Vercel) **and** the theme
extension (the selector block).

### 5. Re-authorize on the store
Open the app once from the store admin and approve permissions (scopes changed).
If it doesn't prompt, uninstall + reopen the app to force a fresh grant.

## Verify it's fully live
- **Stop `shopify app dev`.**
- Open a ring product on the storefront and hard-refresh.
- The selector should load prices and add to cart — all served by Vercel now, no local
  process running. (Check the browser console `[avita-ds]` logs if anything is off.)

## Notes
- **Cold starts:** the first request after idle adds ~0.3–1s. Fine for one store.
- **Env changes:** update in Vercel → redeploy (or `vercel --prod`). Auto-deploys on every
  `git push` to `main`.
- **Custom domain:** if you later move off `*.vercel.app`, update `SHOPIFY_APP_URL`, the two
  URLs in `shopify.app.toml`, and re-run `shopify app deploy`.
