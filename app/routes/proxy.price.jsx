import { authenticate } from "../shopify.server";
import { quote, formatGBP } from "../lib/diamonds.server";

// GET /apps/diamond/price?productId=gid&shape=emerald&origin=lab&carat=1.00&colour=D&clarity=VVS1
// Returns the AUTHORITATIVE live total (ring base + stone). The storefront
// never sends a price; it only sends the selection.
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const p = (k) => url.searchParams.get(k);

  const productGid = p("productId");
  if (!productGid) {
    return Response.json({ ok: false, reason: "missing productId" }, { status: 400 });
  }

  try {
    const q = await quote(session.shop, admin, {
      productGid,
      shape: p("shape") || "emerald",
      origin: p("origin"),
      carat: p("carat"),
      colour: p("colour"),
      clarity: p("clarity"),
    });

    if (!q.ok) return Response.json(q);

    return Response.json({
      ok: true,
      basePence: q.basePence,
      stonePence: q.stonePence,
      totalPence: q.totalPence,
      baseFormatted: formatGBP(q.basePence),
      stoneFormatted: formatGBP(q.stonePence),
      totalFormatted: formatGBP(q.totalPence),
    });
  } catch (err) {
    console.error("[proxy.price]", err);
    return Response.json({ ok: false, reason: "price_failed" }, { status: 500 });
  }
};
