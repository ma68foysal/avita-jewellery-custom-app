import { authenticate } from "../shopify.server";
import { quote, mintProduct, ringSizes, formatGBP, getShopSettings } from "../lib/diamonds.server";

// POST /apps/diamond/cart
// Body (JSON): { productId, shape, origin, carat, colour, clarity, size }
// Re-prices server-side, mints/reuses a dynamic variant at base+stone, and
// returns { variantId, properties } for the storefront to POST to /cart/add.js.
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, reason: "method_not_allowed" }, { status: 405 });
  }

  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return new Response("Unauthorized", { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const productGid = body.productId;
  if (!productGid) {
    return Response.json({ ok: false, reason: "missing productId" }, { status: 400 });
  }

  // Validate size against the server-side list (client can't invent one).
  const size = String(body.size || "");
  if (!ringSizes().includes(size)) {
    return Response.json({ ok: false, reason: "invalid_size" }, { status: 400 });
  }

  try {
    // Re-quote from scratch — authoritative price, ignores anything client-side.
    const q = await quote(session.shop, admin, {
      productGid,
      shape: body.shape || "emerald",
      origin: body.origin,
      carat: body.carat,
      colour: body.colour,
      clarity: body.clarity,
    });
    if (!q.ok) return Response.json(q, { status: 400 });

    // Product-per-order: mint a fresh hidden-but-buyable product at base+stone.
    const variantId = await mintProduct(session.shop, admin, productGid, q);

    // Line-item properties travel to cart, checkout, order & packing slip.
    // Which fields are recorded is controlled on the Selector settings page.
    const { lineItemFields } = await getShopSettings(session.shop);
    const all = {
      diamond: ["Diamond", q.origin === "natural" ? "Natural" : "Lab grown"],
      carat: ["Carat", `${q.carat} ct`],
      colour: ["Colour", q.colour],
      clarity: ["Clarity", q.clarity],
      size: ["Ring size", size],
      stone_price: ["Diamond price", formatGBP(q.stonePence)],
    };
    const properties = {
      Shape: q.shape.charAt(0).toUpperCase() + q.shape.slice(1) + " cut",
    };
    for (const key of lineItemFields) {
      if (all[key]) properties[all[key][0]] = all[key][1];
    }

    return Response.json({
      ok: true,
      variantId,
      properties,
      totalFormatted: formatGBP(q.totalPence),
    });
  } catch (err) {
    console.error("[proxy.cart]", err);
    return Response.json({ ok: false, reason: "cart_failed" }, { status: 500 });
  }
};
