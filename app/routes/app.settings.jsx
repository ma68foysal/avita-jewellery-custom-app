import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabase } from "../supabase.server";
import { getShopSettings, saveShopSettings } from "../lib/diamonds.server";
import { LINE_ITEM_FIELDS, ringSizes } from "../lib/money";

const ALL_SHAPES = ["emerald", "round", "oval", "princess", "cushion", "pear"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();

  const settings = await getShopSettings(session.shop);
  const { data } = await supabase
    .from("diamond_prices")
    .select("shape")
    .eq("shop", session.shop);
  const liveShapes = [...new Set((data || []).map((r) => r.shape))];

  return { settings, liveShapes, sizes: ringSizes() };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  let fields;
  try {
    fields = JSON.parse(fd.get("lineItemFields") || "[]");
  } catch {
    return { ok: false, message: "Bad settings payload." };
  }
  try {
    await saveShopSettings(session.shop, { lineItemFields: fields });
  } catch (err) {
    return { ok: false, message: `Save failed: ${err.message}` };
  }
  return { ok: true, message: "Settings saved." };
};

export default function Settings() {
  const { settings, liveShapes, sizes } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const res = fetcher.data;

  const [fields, setFields] = useState(new Set(settings.lineItemFields));
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (res?.ok) setDirty(false); }, [res]);

  function toggle(key) {
    setFields((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    setDirty(true);
  }

  function save() { fetcher.submit({ lineItemFields: JSON.stringify([...fields]) }, { method: "post" }); }
  function discard() { setFields(new Set(settings.lineItemFields)); setDirty(false); }

  return (
    <div>
      <SaveBar id="settings-save" open={dirty}>
        <button variant="primary" onClick={save} {...(busy ? { loading: "" } : {})}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>

      <div className="page-head">
        <h2>Selector settings</h2>
        <p>Control what carries into the order and see how the selector is set up. No code required.</p>
      </div>

      <div className="card">
        <h3>Order line items</h3>
        <p className="desc">Which specs are written to cart, checkout, order confirmation and packing slip. Shape is always included.</p>
        <div className="chips">
          {LINE_ITEM_FIELDS.map((f) => (
            <span key={f.key}
              className={"mini" + (fields.has(f.key) ? " on" : "")}
              onClick={() => toggle(f.key)}>
              {f.label}
            </span>
          ))}
        </div>
        {res && <div className={"flash " + (res.ok ? "ok" : "err")} style={{ marginTop: 14 }}>{res.message}</div>}
      </div>

      <div className="card">
        <h3>Selection flow</h3>
        <p className="desc">The order is fixed: origin → carat → colour → clarity → ring size. Only valid combinations are ever shown, and the live total is ring base + selected stone.</p>
        <div className="cfg-row">
          <div className="txt"><b>Diamond origin</b><p>Natural / Lab is the first choice, loading the correct price set.</p></div>
          <div className="toggle on" style={{ pointerEvents: "none" }} />
        </div>
        <div className="cfg-row">
          <div className="txt"><b>Ring size</b><p>UK sizes with half sizes, no price impact.</p>
            <div className="chips">
              {sizes.map((s) => <span key={s} className="mini readonly on">{s}</span>)}
            </div>
          </div>
          <div className="toggle on" style={{ pointerEvents: "none" }} />
        </div>
        <div className="cfg-row">
          <div className="txt"><b>Live price total</b><p>Updates as each choice is made.</p></div>
          <div className="toggle on" style={{ pointerEvents: "none" }} />
        </div>
        <p className="muted" style={{ marginTop: 12 }}>Heading, labels and the ring visual are controlled per page in the theme editor block settings.</p>
      </div>

      <div className="card">
        <h3>Launch shapes</h3>
        <p className="desc">A shape goes live as soon as its rows appear in your price sheet — no rebuild. Highlighted shapes have prices loaded.</p>
        <div className="chips">
          {ALL_SHAPES.map((s) => (
            <span key={s} className={"mini readonly" + (liveShapes.includes(s) ? " on" : "")}>
              {s.charAt(0).toUpperCase() + s.slice(1)}{liveShapes.includes(s) ? " ✓" : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
