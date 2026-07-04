import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getCaratsForShape, getCaratImages, saveCaratImage } from "../lib/diamonds.server";
import riStyles from "../styles/ring-images.css?url";

export const links = () => [{ rel: "stylesheet", href: riStyles }];

const SHAPES = ["emerald", "round", "oval", "princess", "cushion", "pear"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shape = new URL(request.url).searchParams.get("shape") || "emerald";
  const [carats, images] = await Promise.all([
    getCaratsForShape(session.shop, shape),
    getCaratImages(session.shop, shape),
  ]);
  return { shape, carats, images };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "resolve") {
    let ids;
    try { ids = JSON.parse(fd.get("ids") || "[]"); } catch { ids = []; }
    if (!ids.length) return { ok: false, message: "No file selected." };
    try {
      const resp = await admin.graphql(
        `#graphql
        query ResolveFiles($ids: [ID!]!) { nodes(ids: $ids) { id ... on MediaImage { image { url } } } }`,
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
  const { shape, carats, images } = useLoaderData();
  const [, setParams] = useSearchParams();
  const shopify = useAppBridge();
  const saver = useFetcher();
  const resolver = useFetcher();

  const [map, setMap] = useState(images);
  const [baseline, setBaseline] = useState(images);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(8);

  useEffect(() => { setMap(images); setBaseline(images); setDirty(false); setPage(1); /* eslint-disable-next-line */ }, [shape]);
  useEffect(() => { if (saver.data?.ok && saver.data?.saved) { setBaseline(map); setDirty(false); } /* eslint-disable-next-line */ }, [saver.data]);
  useEffect(() => {
    if (resolver.data?.resolved && resolver.data.url) { setMap((m) => ({ ...m, [resolver.data.carat]: resolver.data.url })); setDirty(true); }
    else if (resolver.data && !resolver.data.ok) shopify?.toast?.show?.(resolver.data.message || "Could not use that file.", { isError: true });
    /* eslint-disable-next-line */
  }, [resolver.data]);

  const filled = useMemo(() => carats.filter((c) => map[c]).length, [carats, map]);
  const total = carats.length;
  const effPer = perPage >= total ? total || 1 : perPage;
  const totalPages = Math.max(1, Math.ceil(total / effPer));
  const curPage = Math.min(page, totalPages);
  const start = (curPage - 1) * effPer;
  const pageCarats = carats.slice(start, start + effPer);

  function setUrl(c, url) { setMap((m) => ({ ...m, [c]: url })); setDirty(true); }
  function clearUrl(c) { setMap((m) => ({ ...m, [c]: "" })); setDirty(true); }
  function saveAll() { saver.submit({ intent: "save", shape, payload: JSON.stringify(map) }, { method: "post" }); }
  function discard() { setMap(baseline); setDirty(false); }
  function clearAll() { const next = {}; carats.forEach((c) => (next[c] = "")); setMap(next); setDirty(true); }
  function applyFirst() {
    const first = map[carats[0]];
    if (!first) { shopify?.toast?.show?.(`Set the ${carats[0]}ct image first.`, { isError: true }); return; }
    const next = {}; carats.forEach((c) => (next[c] = first)); setMap(next); setDirty(true);
  }

  async function pickImage(c) {
    try {
      if (!shopify?.intents?.invoke) throw new Error("File picker unavailable — restart shopify app dev and hard-refresh.");
      const activity = await shopify.intents.invoke("pick:shopify/File");
      const response = await activity.complete;
      if (response?.code === "ok") {
        const ids = response.data?.ids || [];
        if (ids.length) resolver.submit({ intent: "resolve", ids: JSON.stringify(ids.slice(0, 1)), carat: c }, { method: "post" });
      }
    } catch (err) {
      console.error("[intents pick]", err);
      shopify?.toast?.show?.(err.message || "Could not open the file picker.", { isError: true });
    }
  }

  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

  return (
    <div className="ri">
      <div className="ri-head">
        <h2>Ring images</h2>
        <p>Assign a photo per carat. The selector swaps the ring image when a customer changes carat. Optional — any carat left blank falls back to the product photo.</p>
      </div>

      {/* shape + summary */}
      <div className="ri-card">
        <div className="ri-card-body">
          <div className="ri-shape-row">
            <div>
              <span className="ri-label">Shape</span>
              <select className="ri-select" value={shape} onChange={(e) => setParams({ shape: e.target.value })}>
                {SHAPES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </select>
            </div>
            <div className="ri-shape-meta">
              <div className="ri-stat"><div className="n">{filled}</div><div className="l">images set</div></div>
              <div className="ri-stat"><div className="n">{total}</div><div className="l">carats</div></div>
            </div>
          </div>
          <div className="ri-prog"><i style={{ width: (total ? Math.round((filled / total) * 100) : 0) + "%" }} /></div>
        </div>
      </div>

      {/* grid */}
      <div className="ri-card">
        <div className="ri-card-head">
          <div>
            <div className="t">Image per carat — {cap(shape)}</div>
            <div className="sub">Recommended 1200×1200px, square. JPG or PNG.</div>
          </div>
          <div className="ri-tools">
            <button className="ri-btn ri-plain" onClick={clearAll}>Clear all</button>
            <button className="ri-btn" onClick={applyFirst}>Apply {carats[0] || "1.00"}ct to all</button>
          </div>
        </div>
        <div className="ri-card-body">
          {total === 0 ? (
            <p style={{ color: "var(--p-subdued)", fontSize: 13 }}>No carats loaded for this shape. Add prices first.</p>
          ) : (
            <>
              <div className="ri-grid">
                {pageCarats.map((c) => {
                  const has = !!map[c];
                  return (
                    <div className={"ri-imgcard " + (has ? "filled" : "empty")} key={c}>
                      <div className="ri-thumb">
                        <span className="ri-carat-tag">{c}ct</span>
                        <span className="ri-set-badge">✓</span>
                        {has ? <img src={map[c]} alt={`${c}ct`} /> : (
                          <div className="ph">
                            <svg viewBox="0 0 24 24" fill="none" stroke="#c2c2c2" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                            No image
                          </div>
                        )}
                      </div>
                      <div className="ri-card-actions">
                        <button onClick={() => pickImage(c)}>{has ? "Replace" : "Choose image"}</button>
                        <button className="clear" disabled={!has} onClick={() => clearUrl(c)}>Clear</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="ri-pager">
                <span className="ri-pager-info">Showing {total ? start + 1 : 0}–{Math.min(start + effPer, total)} of {total}</span>
                <div className="ri-pager-mid">
                  <span className="ri-per-label">Per page</span>
                  <select className="ri-select ri-small" value={perPage >= total ? total : perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}>
                    <option value={8}>8</option>
                    <option value={12}>12</option>
                    <option value={total || 999}>All</option>
                  </select>
                </div>
                <div className="ri-pager-right">
                  <button className="ri-pg-btn" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>‹ Prev</button>
                  <span className="ri-pg-pages">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                      <button key={p} className={"ri-pg-dot" + (p === curPage ? " on" : "")} onClick={() => setPage(p)}>{p}</button>
                    ))}
                  </span>
                  <button className="ri-pg-btn" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next ›</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* save bar */}
      <div className="ri-savebar">
        <span className="msg">Changes apply to the <b>{cap(shape)}</b> selector on save.</span>
        <div className="right">
          {saver.data?.saved && <span className="ri-saved">✓ Saved</span>}
          <button className="ri-btn" onClick={discard} disabled={!dirty}>Discard</button>
          <button className="ri-btn ri-primary" onClick={saveAll} disabled={!dirty || saver.state !== "idle"}>{saver.state !== "idle" ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
