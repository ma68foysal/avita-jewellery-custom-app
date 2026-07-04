import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabase } from "../supabase.server";
import { poundsToPence } from "../lib/money";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const { data } = await supabase
    .from("ring_pages")
    .select("product_id, title, metal, shape, base_price_pence, enabled")
    .eq("shop", session.shop)
    .order("title", { ascending: true });
  const rings = (data || []).map((r) => ({
    product_id: r.product_id,
    title: r.title || "",
    metal: r.metal || "",
    shape: r.shape || "emerald",
    base: r.base_price_pence != null ? (Number(r.base_price_pence) / 100).toString() : "",
    enabled: r.enabled !== false,
  }));
  return { rings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "delete") {
    const pid = String(fd.get("product_id") || "").split("/").pop();
    await supabase.from("ring_pages").delete().eq("shop", session.shop).eq("product_id", pid);
    return { ok: true, message: "Ring page removed." };
  }

  let items;
  try { items = JSON.parse(fd.get("payload") || "[]"); } catch { return { ok: false, message: "Bad payload." }; }
  if (!items.length) return { ok: true, saved: true, message: "Nothing to save." };

  const rows = [];
  for (const it of items) {
    const pid = String(it.product_id || "").split("/").pop();
    const basePence = poundsToPence(it.base);
    if (!pid) return { ok: false, message: "A ring is missing its product." };
    if (basePence == null || basePence < 0) return { ok: false, message: `Base price for "${it.title || pid}" is invalid.` };
    rows.push({
      shop: session.shop, product_id: pid,
      title: (it.title || "").trim() || null,
      metal: (it.metal || "").trim() || null,
      shape: (it.shape || "emerald").trim().toLowerCase(),
      base_price_pence: basePence,
      enabled: it.enabled !== false,
      updated_at: new Date().toISOString(),
    });
  }
  const { error } = await supabase.from("ring_pages").upsert(rows, { onConflict: "shop,product_id" });
  if (error) return { ok: false, message: `Save failed: ${error.message}` };
  return { ok: true, saved: true, message: `Saved ${rows.length} ring page${rows.length > 1 ? "s" : ""}.` };
};

export default function Rings() {
  const { rings: initial } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [rings, setRings] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const res = fetcher.data;

  useEffect(() => { if (res?.saved) { setBaseline(rings); setDirty(false); } /* eslint-disable-next-line */ }, [res]);

  function update(i, patch) { setRings((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); setDirty(true); }

  async function browse() {
    try {
      if (typeof shopify?.resourcePicker !== "function") throw new Error("App Bridge not ready — restart dev & hard-refresh.");
      const sel = await shopify.resourcePicker({ type: "product", action: "select" });
      if (sel && sel.length) {
        const p = sel[0];
        const pid = String(p.id).split("/").pop();
        if (rings.some((r) => r.product_id === pid)) { shopify.toast.show("That product is already listed."); return; }
        const price = p.variants?.[0]?.price;
        setRings((rs) => [...rs, {
          product_id: pid, title: p.title || "", metal: "", shape: "emerald",
          base: price != null ? String(price).replace(/\.00$/, "") : "", enabled: true, isNew: true,
        }]);
        setDirty(true);
      }
    } catch (err) {
      console.error("[resourcePicker]", err);
      shopify?.toast?.show?.(err.message || "Could not open the product picker.", { isError: true });
    }
  }

  function saveAll() { fetcher.submit({ intent: "save_all", payload: JSON.stringify(rings) }, { method: "post" }); }
  function discard() { setRings(baseline); setDirty(false); }
  function remove(i) {
    const r = rings[i];
    setRings((rs) => rs.filter((_, idx) => idx !== i));
    if (r.isNew) { setDirty(true); }
    else { fetcher.submit({ intent: "delete", product_id: r.product_id }, { method: "post" }); setBaseline((b) => b.filter((x) => x.product_id !== r.product_id)); }
  }

  return (
    <div>
      <SaveBar id="ring-prices-save" open={dirty}>
        <button variant="primary" onClick={saveAll} {...(fetcher.state !== "idle" ? { loading: "" } : {})}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>

      <div className="page-head">
        <h2>Ring base prices</h2>
        <p>Each ring/metal page has its own base price. The selected diamond adds on top of this figure.</p>
      </div>

      <div className="card">
        <h3>Ring pages</h3>
        <p className="desc">By default a ring uses its own Shopify price as the base — add it here only to override, rename, or hide the selector on that page. Prices are in pounds.</p>

        {rings.length === 0 && <p className="muted">No ring pages yet. Add one below.</p>}

        {rings.map((r, i) => (
          <div className="metal-row" key={r.product_id}>
            <div className="name">
              <input type="text" value={r.title} placeholder="Ring name" style={{ padding: "6px 10px", fontWeight: 600 }} onChange={(e) => update(i, { title: e.target.value })} />
              <input type="text" value={r.metal} placeholder="Metal (e.g. 18k Yellow Gold)" style={{ padding: "5px 10px", marginTop: 4, fontSize: 12 }} onChange={(e) => update(i, { metal: e.target.value })} />
              <small style={{ display: "block", marginTop: 4 }}>Product {r.product_id}</small>
            </div>
            <div className="money"><span>£</span>
              <input type="number" value={r.base} placeholder="1200" onChange={(e) => update(i, { base: e.target.value })} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className={"toggle" + (r.enabled ? " on" : "")} title={r.enabled ? "Selector live" : "Selector hidden"} onClick={() => update(i, { enabled: !r.enabled })} />
              <span className={"status" + (r.enabled ? "" : " off")}>{r.enabled ? "Live" : "Hidden"}</span>
              <button type="button" className="btn ghost" style={{ padding: "6px 12px", letterSpacing: 0, textTransform: "none" }} onClick={() => remove(i)}>Remove</button>
            </div>
          </div>
        ))}

        <button className="addbtn" onClick={browse}>+ Add ring page (browse products)</button>
      </div>

      {res && !res.saved && <div className={"flash " + (res.ok ? "ok" : "err")}>{res.message}</div>}
    </div>
  );
}
