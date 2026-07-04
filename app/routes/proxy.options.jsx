import { authenticate } from "../shopify.server";
import { getOptions } from "../lib/diamonds.server";

// GET /apps/diamond/options?shape=emerald
// Returns every valid combination + the ring-size list so the storefront
// selector can show ONLY valid carat/colour/clarity choices per origin.
export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const shape = url.searchParams.get("shape") || "emerald";
  const productId = url.searchParams.get("productId");

  try {
    const options = await getOptions(session.shop, shape, productId);
    console.log("[proxy.options]", session.shop, "shape=", shape,
      "natural=", options.combos.natural.length,
      "lab=", options.combos.lab.length,
      "enabled=", options.enabled);
    return Response.json(options, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    console.error("[proxy.options]", err);
    return Response.json({ error: "options_failed" }, { status: 500 });
  }
};
