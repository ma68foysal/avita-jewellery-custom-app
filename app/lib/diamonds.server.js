import { getSupabase } from "../supabase.server";
import {
  poundsToPence,
  penceToPoundsString,
  formatGBP,
  ringSizes,
  normOrigin,
  normCarat,
  normColour,
  normClarity,
  comboKey,
  LINE_ITEM_FIELDS,
  DEFAULT_LINE_ITEM_FIELDS,
} from "./money";

// Re-export the pure helpers so existing server-side imports keep working.
export {
  poundsToPence,
  penceToPoundsString,
  formatGBP,
  ringSizes,
  normOrigin,
  normCarat,
  normColour,
  normClarity,
  comboKey,
  LINE_ITEM_FIELDS,
  DEFAULT_LINE_ITEM_FIELDS,
};

// ---------------------------------------------------------------------------
//  Options for the selector — every valid combination for a shape, both origins.
//  The storefront uses this to show ONLY valid carat/colour/clarity choices.
// ---------------------------------------------------------------------------
export async function getOptions(shop, shape = "emerald", productGid = null) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("diamond_prices")
    .select("origin, carat, colour, clarity, image_url")
    .eq("shop", shop)
    .eq("shape", shape);
  if (error) throw new Error(`Supabase options error: ${error.message}`);

  // Shape into { natural: [{carat,colour,clarity}], lab: [...] }
  // and collect any per-carat image supplied via the CSV image_url column.
  const byOrigin = { natural: [], lab: [] };
  const images = {}; // carat -> url
  for (const r of data || []) {
    const o = normOrigin(r.origin);
    if (!o) continue;
    const carat = normCarat(r.carat);
    byOrigin[o].push({ carat, colour: normColour(r.colour), clarity: normClarity(r.clarity) });
    if (r.image_url && carat && !images[carat]) images[carat] = r.image_url;
  }

  // Explicit in-app assignments win over the CSV image_url.
  const { data: ci } = await supabase
    .from("carat_images")
    .select("carat, image_url")
    .eq("shop", shop)
    .eq("shape", shape);
  for (const row of ci || []) {
    const carat = normCarat(row.carat);
    if (carat && row.image_url) images[carat] = row.image_url;
  }

  // Is the selector enabled on this product's page? (default yes unless toggled off)
  let enabled = true;
  if (productGid) {
    const pid = String(productGid).split("/").pop();
    const { data: rp } = await supabase
      .from("ring_pages")
      .select("enabled")
      .eq("shop", shop)
      .eq("product_id", pid)
      .maybeSingle();
    if (rp && rp.enabled === false) enabled = false;
  }

  return { shape, enabled, sizes: ringSizes(), combos: byOrigin, images };
}

// ---------------------------------------------------------------------------
//  Per-carat image assignments (admin "Ring images" page).
// ---------------------------------------------------------------------------
export async function getCaratImages(shop, shape) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("carat_images")
    .select("carat, image_url")
    .eq("shop", shop)
    .eq("shape", shape);
  const map = {};
  for (const r of data || []) {
    const c = normCarat(r.carat);
    if (c) map[c] = r.image_url;
  }
  return map;
}

export async function saveCaratImage(shop, shape, carat, imageUrl) {
  const supabase = getSupabase();
  const c = normCarat(carat);
  if (!c) throw new Error("invalid carat");
  if (!imageUrl) {
    const { error } = await supabase
      .from("carat_images")
      .delete()
      .eq("shop", shop).eq("shape", shape).eq("carat", c);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from("carat_images").upsert(
    { shop, shape, carat: c, image_url: imageUrl, updated_at: new Date().toISOString() },
    { onConflict: "shop,shape,carat" },
  );
  if (error) throw new Error(error.message);
}

// Distinct carats loaded for a shape (used to build the image-mapping UI).
export async function getCaratsForShape(shop, shape) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("diamond_prices")
    .select("carat")
    .eq("shop", shop)
    .eq("shape", shape);
  const set = new Set();
  for (const r of data || []) {
    const c = normCarat(r.carat);
    if (c) set.add(c);
  }
  return [...set].sort((a, b) => parseFloat(a) - parseFloat(b));
}

// ---------------------------------------------------------------------------
//  Shop settings — which spec fields get written to the order line items.
// ---------------------------------------------------------------------------
export async function getShopSettings(shop) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("shop_settings")
    .select("settings")
    .eq("shop", shop)
    .maybeSingle();
  const s = data?.settings || {};
  return {
    lineItemFields: Array.isArray(s.lineItemFields) ? s.lineItemFields : DEFAULT_LINE_ITEM_FIELDS,
  };
}

export async function saveShopSettings(shop, settings) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("shop_settings")
    .upsert({ shop, settings, updated_at: new Date().toISOString() }, { onConflict: "shop" });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
//  Stone price lookup — the authoritative price. Returns pence or null.
// ---------------------------------------------------------------------------
export async function getStonePricePence(shop, { shape, origin, carat, colour, clarity }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("diamond_prices")
    .select("price_pence")
    .eq("shop", shop)
    .eq("shape", shape)
    .eq("origin", origin)
    .eq("carat", carat)
    .eq("colour", colour)
    .eq("clarity", clarity)
    .maybeSingle();
  if (error) throw new Error(`Supabase price error: ${error.message}`);
  return data ? Number(data.price_pence) : null;
}

// ---------------------------------------------------------------------------
//  Base ring price — the RingPage override if set, else the product's own
//  Shopify price (so merchants can just set the product price = base).
//  `admin` is the authenticated Admin GraphQL client from appProxy/admin auth.
// ---------------------------------------------------------------------------
export async function getBasePricePence(shop, productGid, admin) {
  const supabase = getSupabase();
  const numericId = String(productGid).split("/").pop();

  const { data } = await supabase
    .from("ring_pages")
    .select("base_price_pence")
    .eq("shop", shop)
    .eq("product_id", numericId)
    .maybeSingle();
  if (data && data.base_price_pence != null) return Number(data.base_price_pence);

  // Fallback: the product's first variant price from Shopify.
  const resp = await admin.graphql(
    `#graphql
    query BasePrice($id: ID!) {
      product(id: $id) {
        variants(first: 1) { nodes { price } }
      }
    }`,
    { variables: { id: productGid } },
  );
  const j = await resp.json();
  const price = j?.data?.product?.variants?.nodes?.[0]?.price;
  return price != null ? poundsToPence(price) : null;
}

// ---------------------------------------------------------------------------
//  Quote — the full authoritative price for a selection. Never trust the client.
// ---------------------------------------------------------------------------
export async function quote(shop, admin, sel) {
  const shape = sel.shape || "emerald";
  const origin = normOrigin(sel.origin);
  const carat = normCarat(sel.carat);
  const colour = normColour(sel.colour);
  const clarity = normClarity(sel.clarity);

  if (!origin || !carat || !colour || !clarity) {
    return { ok: false, reason: "incomplete selection" };
  }

  const [stonePence, basePence] = await Promise.all([
    getStonePricePence(shop, { shape, origin, carat, colour, clarity }),
    getBasePricePence(shop, sel.productGid, admin),
  ]);

  if (stonePence == null) return { ok: false, reason: "no price for combination" };
  if (basePence == null) return { ok: false, reason: "base price not set for this product" };

  const totalPence = basePence + stonePence;
  return {
    ok: true,
    shape,
    origin,
    carat,
    colour,
    clarity,
    basePence,
    stonePence,
    totalPence,
    key: comboKey({ shape, origin, carat, colour, clarity, totalPence }),
  };
}

// ---------------------------------------------------------------------------
//  Mint (or reuse) a dynamic variant priced at base + stone on the ring product.
//  Made-to-order: inventory not tracked, oversell allowed, so it never blocks.
//  Returns the numeric variant id for /cart/add.js.
// ---------------------------------------------------------------------------
// Make a variant's inventory item untracked so it's always available for sale
// (made-to-order — there is no stock to count). Belt-and-suspenders because
// productVariantsBulkCreate does not reliably apply inventoryItem.tracked.
async function untrackVariantInventory(admin, variantGid, inventoryItemGid) {
  try {
    let invId = inventoryItemGid;
    if (!invId) {
      const r = await admin.graphql(
        `#graphql
        query VariantInventory($id: ID!) {
          productVariant(id: $id) { inventoryItem { id } }
        }`,
        { variables: { id: variantGid } },
      );
      const j = await r.json();
      invId = j?.data?.productVariant?.inventoryItem?.id;
    }
    if (!invId) return;
    await admin.graphql(
      `#graphql
      mutation UntrackInventory($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          userErrors { field message }
        }
      }`,
      { variables: { id: invId, input: { tracked: false } } },
    );
  } catch (err) {
    console.error("[untrackVariantInventory]", err);
  }
}

export async function mintVariant(shop, admin, productGid, q) {
  const supabase = getSupabase();
  const numericProductId = String(productGid).split("/").pop();

  // 1) Reuse a cached variant for this exact combo (same shop/product/key)?
  const { data: cached } = await supabase
    .from("dynamic_variants")
    .select("variant_id")
    .eq("shop", shop)
    .eq("product_id", numericProductId)
    .eq("combo_key", q.key)
    .maybeSingle();

  if (cached?.variant_id) {
    // Self-heal: make sure a previously-minted variant is still purchasable
    // (older ones may have been created while inventory tracking was on).
    await untrackVariantInventory(admin, `gid://shopify/ProductVariant/${cached.variant_id}`);
    await supabase
      .from("dynamic_variants")
      .update({ last_used_at: new Date().toISOString() })
      .eq("shop", shop)
      .eq("product_id", numericProductId)
      .eq("combo_key", q.key);
    return cached.variant_id;
  }

  // 2) Discover the product's first option name (values must be unique per variant).
  const optResp = await admin.graphql(
    `#graphql
    query ProductOptions($id: ID!) {
      product(id: $id) { options(first: 1) { name } }
    }`,
    { variables: { id: productGid } },
  );
  const optJson = await optResp.json();
  const optionName =
    optJson?.data?.product?.options?.[0]?.name || "Title";

  // Unique, human-readable option value for this configuration.
  const optionValue = `${q.origin}/${q.carat}/${q.colour}/${q.clarity}`;

  // 3) Create the variant priced at the full total.
  const createResp = await admin.graphql(
    `#graphql
    mutation MintVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id inventoryItem { id } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        productId: productGid,
        variants: [
          {
            price: penceToPoundsString(q.totalPence),
            optionValues: [{ optionName, name: optionValue }],
            inventoryPolicy: "CONTINUE", // made-to-order: allow purchase always
            inventoryItem: { tracked: false },
          },
        ],
      },
    },
  );
  const createJson = await createResp.json();
  const errs = createJson?.data?.productVariantsBulkCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`Variant create failed: ${errs.map((e) => e.message).join("; ")}`);
  }
  const created = createJson?.data?.productVariantsBulkCreate?.productVariants?.[0];
  const variantGid = created?.id;
  if (!variantGid) throw new Error("Variant create returned no id");
  const variantId = String(variantGid).split("/").pop();

  // Force the variant to be always purchasable (made-to-order, no stock).
  await untrackVariantInventory(admin, variantGid, created?.inventoryItem?.id);

  // 4) Cache it for reuse.
  await supabase.from("dynamic_variants").upsert(
    {
      shop,
      product_id: numericProductId,
      variant_id: variantId,
      combo_key: q.key,
      total_pence: q.totalPence,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "shop,product_id,combo_key" },
  );

  return variantId;
}
