import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getCaratsForShape, getCaratImages, saveCaratImage } from "../lib/diamonds.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shape = url.searchParams.get("shape") || "emerald";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const PAGE = 20;
  const [allCarats, images] = await Promise.all([
    getCaratsForShape(session.shop, shape),
    getCaratImages(session.shop, shape),
  ]);
  const carats = allCarats.slice((page - 1) * PAGE, page * PAGE);
  return { shape, carats, images, page, totalCarats: allCarats.length, pageSize: PAGE };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent");

  // Resolve file GIDs (from the native picker) to public image URLs.
  if (intent === "resolve") {
    let ids;
    try { ids = JSON.parse(fd.get("ids") || "[]"); } catch { ids = []; }
    if (!ids.length) return { ok: false, message: "No file selected." };
    try {
      const resp = await admin.graphql(
        `#graphql
        query ResolveFiles($ids: [ID!]!) {
          nodes(ids: $ids) { id ... on MediaImage { image { url } } }
        }`,
        { variables: { ids } },
      );
      const j = await resp.json();
      const url = (j?.data?.nodes || []).map((n) => n?.image?.url).find(Boolean) || null;
      if (!url) return { ok: false, message: "That file has no usable image URL." };
      return { ok: true, resolved: true, carat: fd.get("carat"), url };
    } catch (err) {
      return { ok: false, message: `Could not resolve image: ${err.message}` };
    }
  }

  // Save the per-carat map.
  const shape = fd.get("shape") || "emerald";
  let map;
  try { map = JSON.parse(fd.get("payload") || "{}"); } catch { return { ok: false, message: "Bad payload." }; }
  try {
    for (const [carat, u] of Object.entries(map)) {
      await saveCaratImage(session.shop, shape, carat, (u || "").trim() || null);
    }
  } catch (err) {
    return { ok: false, message: `Save failed: ${err.message}` };
  }
  return { ok: true, saved: true, message: "Ring images saved." };
};

export default function Images() {
  const { shape, carats, images, page, totalCarats, pageSize } = useLoaderData();
  const [, setParams] = useSearchParams();
  const totalPages = Math.max(1, Math.ceil((totalCarats || 0) / (pageSize || 20)));
  const gotoPage = (p) => setParams((prev) => { prev.set("page", String(p)); return prev; });
  const shopify = useAppBridge();
  const saver = useFetcher();
  const resolver = useFetcher();

  const [map, setMap] = useState(images);
  const [baseline, setBaseline] = useState(images);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setMap(images); setBaseline(images); setDirty(false); /* eslint-disable-next-line */ }, [shape]);
  useEffect(() => {
    if (saver.data?.ok && saver.data?.saved) { setBaseline(map); setDirty(false); }
    /* eslint-disable-next-line */
  }, [saver.data]);
  useEffect(() => {
    if (resolver.data?.resolved && resolver.data.url) {
      setMap((m) => ({ ...m, [resolver.data.carat]: resolver.data.url }));
      setDirty(true);
    } else if (resolver.data && !resolver.data.ok) {
      shopify?.toast?.show?.(resolver.data.message || "Could not use that file.", { isError: true });
    }
    /* eslint-disable-next-line */
  }, [resolver.data]);

  const inp = { display: "block", width: "100%", padding: "9px 11px", border: "1px solid #d9d9d9", borderRadius: "6px", background: "#fff", fontSize: 13 };
  const thumb = { width: 54, height: 54, objectFit: "cover", borderRadius: 6, border: "1px solid #e6e2d9" };

  function setUrl(carat, url) { setMap((m) => ({ ...m, [carat]: url })); setDirty(true); }
  function saveAll() { saver.submit({ intent: "save", shape, payload: JSON.stringify(map) }, { method: "post" }); }
  function discard() { setMap(baseline); setDirty(false); }

  // Native Shopify file picker (includes upload) — returns file GIDs.
  async function pickImage(carat) {
    try {
      if (!shopify?.intents?.invoke) throw new Error("File picker unavailable — restart shopify app dev and hard-refresh.");
      const activity = await shopify.intents.invoke("pick:shopify/File");
      const response = await activity.complete;
      if (response?.code === "ok") {
        const ids = response.data?.ids || [];
        if (!ids.length) return;
        resolver.submit({ intent: "resolve", ids: JSON.stringify(ids.slice(0, 1)), carat }, { method: "post" });
      }
    } catch (err) {
      console.error("[intents pick]", err);
      shopify?.toast?.show?.(err.message || "Could not open the file picker.", { isError: true });
    }
  }

  return (
    <div>
      <SaveBar id="ring-images-save" open={dirty}>
        <button variant="primary" onClick={saveAll} {...(saver.state !== "idle" ? { loading: "" } : {})}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>

      <div className="page-head">
        <h2>Ring images</h2>
        <p>Assign a photo per carat. The selector swaps the ring image when a customer changes carat. Optional — without a mapping it falls back to the CSV image, the image alt-text, or the product photo.</p>
      </div>

      <div className="card">
        <h3>Shape</h3>
        <select style={{ ...inp, maxWidth: 240 }} value={shape} onChange={(e) => setParams({ shape: e.target.value })}>
          {["emerald", "round", "oval", "princess", "cushion", "pear"].map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </div>

      <div className="card">
        <h3>Image per carat — {shape} ({totalCarats || 0})</h3>
        {carats.length === 0 ? (
          <p className="muted">No carats loaded for this shape. Upload prices first.</p>
        ) : (
          <>
            {carats.map((c) => (
              <div key={c} className="metal-row" style={{ gridTemplateColumns: "70px 1fr auto" }}>
                <div className="name"><b>{parseFloat(c).toFixed(2)}ct</b></div>
                <input type="text" value={map[c] || ""} placeholder="Image URL (or choose from Shopify)" style={inp} onChange={(e) => setUrl(c, e.target.value)} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {map[c] ? <img src={map[c]} alt="" style={thumb} /> : <span className="muted">—</span>}
                  <button type="button" className="btn ghost" style={{ padding: "8px 12px", letterSpacing: 0, textTransform: "none" }}
                    {...(resolver.state !== "idle" ? { disabled: true } : {})}
                    onClick={() => pickImage(c)}>Choose image</button>
                  {map[c] && (
                    <button type="button" className="btn ghost" style={{ padding: "8px 12px", letterSpacing: 0, textTransform: "none" }}
                      onClick={() => setUrl(c, "")}>Clear</button>
                  )}
                </div>
              </div>
            ))}
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 13, color: "var(--ds-mist)" }}>
                <span>Page {page} of {totalPages}</span>
                <span style={{ display: "flex", gap: 8 }}>
                  <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }} disabled={page <= 1} onClick={() => gotoPage(page - 1)}>← Prev</button>
                  <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }} disabled={page >= totalPages} onClick={() => gotoPage(page + 1)}>Next →</button>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {saver.data && !saver.data.saved && (
        <div className={"flash " + (saver.data.ok ? "ok" : "err")}>{saver.data.message}</div>
      )}
    </div>
  );
}
