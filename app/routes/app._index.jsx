import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { parse } from "csv-parse/sync";
import { authenticate } from "../shopify.server";
import { getSupabase } from "../supabase.server";
import {
  poundsToPence, formatGBP,
  normOrigin, normCarat, normColour, normClarity,
} from "../lib/money";

const EXPECTED = ["shape", "origin", "carat", "colour", "clarity", "price"];
const PAGE_SIZE = 20;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const shapeFilter = url.searchParams.get("shape") || "";
  const from = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("diamond_prices")
    .select("id, shape, origin, carat, colour, clarity, price_pence", { count: "exact" })
    .eq("shop", session.shop);
  if (shapeFilter) query = query.eq("shape", shapeFilter);
  const { data, count } = await query
    .order("shape").order("origin").order("carat").order("colour").order("clarity")
    .range(from, from + PAGE_SIZE - 1);

  const rows = (data || []).map((r) => ({
    id: r.id, shape: r.shape, origin: r.origin, carat: r.carat, colour: r.colour, clarity: r.clarity,
    pounds: (Number(r.price_pence) / 100).toString(),
  }));

  // Distinct values for the combobox suggestions ("show current, allow new").
  const { data: vals } = await supabase
    .from("diamond_prices").select("shape, colour, clarity").eq("shop", session.shop).limit(5000);
  const uniq = (k) => [...new Set((vals || []).map((v) => v[k]))].filter(Boolean).sort();

  return {
    rows, total: count || 0, page, shapeFilter,
    suggest: { shapes: uniq("shape"), colours: uniq("colour"), clarities: uniq("clarity") },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "delete") {
    await supabase.from("diamond_prices").delete().eq("shop", session.shop).eq("id", fd.get("id"));
    return { result: { ok: true, message: "Row deleted." } };
  }

  if (intent === "update") {
    const pence = poundsToPence(fd.get("price"));
    if (pence == null || pence < 0) return { result: { ok: false, message: "Invalid price." } };
    await supabase.from("diamond_prices")
      .update({ price_pence: pence, updated_at: new Date().toISOString() })
      .eq("shop", session.shop).eq("id", fd.get("id"));
    return { result: { ok: true, message: "Price updated." } };
  }

  if (intent === "add") {
    const shape = String(fd.get("shape") || "").trim().toLowerCase();
    const origin = normOrigin(fd.get("origin"));
    const carat = normCarat(fd.get("carat"));
    const colour = normColour(fd.get("colour"));
    const clarity = normClarity(fd.get("clarity"));
    const pence = poundsToPence(fd.get("price"));
    if (!shape || !origin || !carat || !colour || !clarity || pence == null || pence < 0) {
      return { result: { ok: false, message: "Fill every field with a valid value (origin natural/lab, price in £)." } };
    }
    const { error } = await supabase.from("diamond_prices").upsert(
      { shop: session.shop, shape, origin, carat, colour, clarity, price_pence: pence, updated_at: new Date().toISOString() },
      { onConflict: "shop,shape,origin,carat,colour,clarity" },
    );
    if (error) return { result: { ok: false, message: error.message } };
    return { result: { ok: true, message: `Saved ${shape} · ${origin} · ${carat}ct · ${colour} · ${clarity}.` } };
  }

  if (intent === "edit") {
    const id = fd.get("id");
    const shape = String(fd.get("shape") || "").trim().toLowerCase();
    const origin = normOrigin(fd.get("origin"));
    const carat = normCarat(fd.get("carat"));
    const colour = normColour(fd.get("colour"));
    const clarity = normClarity(fd.get("clarity"));
    const pence = poundsToPence(fd.get("price"));
    if (!id || !shape || !origin || !carat || !colour || !clarity || pence == null || pence < 0) {
      return { result: { ok: false, message: "Fill every field with a valid value (origin natural/lab, price in £)." } };
    }
    // Replace the row: remove the old id, upsert the (possibly changed) combination.
    await supabase.from("diamond_prices").delete().eq("shop", session.shop).eq("id", id);
    const { error } = await supabase.from("diamond_prices").upsert(
      { shop: session.shop, shape, origin, carat, colour, clarity, price_pence: pence, updated_at: new Date().toISOString() },
      { onConflict: "shop,shape,origin,carat,colour,clarity" },
    );
    if (error) return { result: { ok: false, message: error.message } };
    return { result: { ok: true, message: "Row updated." } };
  }

  // ---- CSV upload ----
  const file = fd.get("csv");
  if (!file || typeof file.text !== "function") return { ok: false, message: "No CSV file received." };
  let records;
  try {
    records = parse(await file.text(), { columns: (h) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) { return { ok: false, message: `Could not parse CSV: ${err.message}` }; }
  if (!records.length) return { ok: false, message: "CSV had no data rows." };
  const missing = EXPECTED.filter((c) => !Object.keys(records[0]).includes(c));
  if (missing.length) return { ok: false, message: `Missing column(s): ${missing.join(", ")}.` };

  const rows = [], errors = [], seen = new Set(), origins = new Set();
  let min = Infinity, max = -Infinity;
  records.forEach((rec, i) => {
    const line = i + 2;
    const shape = String(rec.shape || "").trim().toLowerCase();
    const origin = normOrigin(rec.origin), carat = normCarat(rec.carat);
    const colour = normColour(rec.colour), clarity = normClarity(rec.clarity), pence = poundsToPence(rec.price);
    const e = [];
    if (!shape) e.push("shape empty");
    if (!origin) e.push(`origin '${rec.origin}' not natural/lab`);
    if (!carat) e.push(`carat '${rec.carat}' invalid`);
    if (!colour) e.push(`colour '${rec.colour}' invalid`);
    if (!clarity) e.push(`clarity '${rec.clarity}' invalid`);
    if (pence == null || pence < 0) e.push(`price '${rec.price}' invalid`);
    const key = `${shape}:${origin}:${carat}:${colour}:${clarity}`;
    if (!e.length && seen.has(key)) e.push("duplicate in file");
    seen.add(key);
    if (e.length) { errors.push(`Line ${line}: ${e.join("; ")}`); return; }
    origins.add(origin); min = Math.min(min, pence); max = Math.max(max, pence);
    rows.push({ shop: session.shop, shape, origin, carat, colour, clarity, price_pence: pence, image_url: String(rec.image_url || "").trim() || null, updated_at: new Date().toISOString() });
  });
  if (errors.length) return { ok: false, message: `${errors.length} row(s) rejected — nothing saved.`, errors: errors.slice(0, 25) };
  try {
    const pairs = [...new Set(rows.map((r) => `${r.shape}|${r.origin}`))];
    for (const pair of pairs) {
      const [shp, org] = pair.split("|");
      const { error } = await supabase.from("diamond_prices").delete().eq("shop", session.shop).eq("shape", shp).eq("origin", org);
      if (error) throw new Error(error.message);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("diamond_prices").upsert(rows.slice(i, i + 500), { onConflict: "shop,shape,origin,carat,colour,clarity" });
      if (error) throw new Error(error.message);
    }
  } catch (err) { return { ok: false, message: `Save failed: ${err.message}` }; }
  return { ok: true, summary: { rows: rows.length, range: `${formatGBP(min)} – ${formatGBP(max)}`, origins: [...origins] } };
};

export default function PriceData() {
  const { rows, total, page, shapeFilter, suggest } = useLoaderData();
  const uploader = useFetcher();
  const adder = useFetcher();
  const fileRef = useRef(null);
  const [, setParams] = useSearchParams();
  const [tab, setTab] = useState("upload");
  const [modal, setModal] = useState(false);
  const [editRow, setEditRow] = useState(null); // null = add, row = edit

  const busy = uploader.state === "submitting";
  const up = uploader.data;
  const s = up?.ok ? up.summary : null;
  const addRes = adder.data?.result;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => { if (addRes?.ok) setModal(false); }, [adder.data]); // eslint-disable-line

  function upload(f) { if (!f) return; const fd = new FormData(); fd.append("csv", f); uploader.submit(fd, { method: "post", encType: "multipart/form-data" }); }
  function goto(p) { setParams((prev) => { prev.set("page", String(p)); return prev; }); }
  function filterShape(v) { setParams((prev) => { if (v) prev.set("shape", v); else prev.delete("shape"); prev.delete("page"); return prev; }); }

  return (
    <div>
      <div className="page-head">
        <h2>Price data</h2>
        <p>Bulk-upload a monthly CSV, or add and edit individual stone prices by hand.</p>
      </div>

      <div className="card">
        <div className="ds-tabs">
          <button className={"ds-tab" + (tab === "upload" ? " is-active" : "")} onClick={() => setTab("upload")}>Upload CSV</button>
          <button className={"ds-tab" + (tab === "manual" ? " is-active" : "")} onClick={() => setTab("manual")}>Add / edit manually</button>
        </div>

        {tab === "upload" && (
          <div>
            <h3>Upload price sheet</h3>
            <p className="desc">Columns: shape, origin, carat, colour, clarity, price (image_url optional). Replaces existing prices for the shapes+origins in the file.</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
            <div className={"drop" + (busy ? "" : up ? (up.ok ? " done" : " err") : "")}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]); }}>
              <div className="ic">{busy ? "…" : up?.ok ? "✓" : up ? "!" : "⤒"}</div>
              <b>{busy ? "Validating…" : up?.ok ? "Loaded" : up ? "Rejected" : "Drop your CSV here, or click to browse"}</b>
              <small>{up && !busy ? up.message : "diamond_prices.csv · up to 5 MB"}</small>
            </div>
            {s && <div className="flash ok">Loaded {s.rows} prices · {s.range} · {s.origins.join(", ")}</div>}
            {up && !up.ok && up.errors?.length ? <div className="flash err"><b>{up.message}</b><pre>{up.errors.join("\n")}</pre></div> : null}
          </div>
        )}

        {tab === "manual" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>Prices — {total} loaded</h3>
                <p className="desc" style={{ margin: "4px 0 0" }}>Edit a price inline, delete a row, or add a new one.</p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select className="ds-field" style={{ width: 160, marginTop: 0 }} value={shapeFilter} onChange={(e) => filterShape(e.target.value)}>
                  <option value="">All shapes</option>
                  {suggest.shapes.map((sh) => <option key={sh} value={sh}>{sh}</option>)}
                </select>
                <button className="btn" onClick={() => { setEditRow(null); setModal(true); }}>+ Add price</button>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="muted">No prices yet. Add one, or upload a CSV.</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Shape</th><th>Origin</th><th>Carat</th><th>Colour</th><th>Clarity</th><th>Price (£)</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.shape}</td>
                        <td><span className={"pill " + row.origin}>{row.origin}</span></td>
                        <td>{parseFloat(row.carat).toFixed(2)}ct</td>
                        <td>{row.colour}</td>
                        <td>{row.clarity}</td>
                        <td>£{Number(row.pounds).toLocaleString("en-GB")}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }}
                              onClick={() => { setEditRow(row); setModal(true); }}>Edit</button>
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="id" value={row.id} />
                              <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }} type="submit">Delete</button>
                            </Form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="tblfoot">
                  <span>Page {page} of {totalPages}</span>
                  <span style={{ display: "flex", gap: 8 }}>
                    <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }} disabled={page <= 1} onClick={() => goto(page - 1)}>← Prev</button>
                    <button className="btn ghost" style={{ padding: "5px 12px", letterSpacing: 0, textTransform: "none" }} disabled={page >= totalPages} onClick={() => goto(page + 1)}>Next →</button>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- Add price popup ---- */}
      {modal && (
        <div className="ds-modal-backdrop" onClick={() => setModal(false)}>
          <div className="ds-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ds-modal-head">
              <h4>{editRow ? "Edit price" : "Add a price"}</h4>
              <button className="ds-modal-x" onClick={() => setModal(false)} aria-label="Close">×</button>
            </div>
            <adder.Form method="post" className="ds-modal-body">
              <input type="hidden" name="intent" value={editRow ? "edit" : "add"} />
              {editRow && <input type="hidden" name="id" value={editRow.id} />}
              <p className="muted" style={{ marginBottom: 14 }}>Type to pick an existing value or enter a brand-new one (e.g. a new shape). If the combination exists, its price updates.</p>
              <div className="ds-form-grid">
                <label><span className="muted">Shape</span>
                  <input name="shape" list="dl-shapes" className="ds-field" placeholder="emerald" defaultValue={editRow?.shape || "emerald"} required />
                  <datalist id="dl-shapes">{suggest.shapes.map((x) => <option key={x} value={x} />)}</datalist>
                </label>
                <label><span className="muted">Origin</span>
                  <select name="origin" className="ds-field" defaultValue={editRow?.origin || "lab"}><option value="natural">natural</option><option value="lab">lab</option></select>
                </label>
                <label><span className="muted">Carat</span>
                  <input name="carat" className="ds-field" placeholder="1.00" defaultValue={editRow?.carat || ""} inputMode="decimal" required /></label>
                <label><span className="muted">Colour</span>
                  <input name="colour" list="dl-colours" className="ds-field" placeholder="D" defaultValue={editRow?.colour || ""} required />
                  <datalist id="dl-colours">{suggest.colours.map((x) => <option key={x} value={x} />)}</datalist>
                </label>
                <label><span className="muted">Clarity</span>
                  <input name="clarity" list="dl-clarities" className="ds-field" placeholder="VVS1" defaultValue={editRow?.clarity || ""} required />
                  <datalist id="dl-clarities">{suggest.clarities.map((x) => <option key={x} value={x} />)}</datalist>
                </label>
                <label><span className="muted">Price (£)</span>
                  <input name="price" className="ds-field" placeholder="720" defaultValue={editRow?.pounds || ""} inputMode="decimal" required /></label>
              </div>
              {addRes && !addRes.ok && <div className="flash err" style={{ marginTop: 12 }}>{addRes.message}</div>}
            </adder.Form>
            <div className="ds-modal-tools" style={{ borderTop: "1px solid var(--line)", borderBottom: "none", justifyContent: "flex-end" }}>
              <button className="btn ghost" style={{ letterSpacing: 0, textTransform: "none" }} onClick={() => setModal(false)}>Cancel</button>
              <button className="btn" style={{ letterSpacing: 0, textTransform: "none" }} onClick={(e) => e.currentTarget.closest(".ds-modal").querySelector("form").requestSubmit()}>
                {adder.state !== "idle" ? "Saving…" : "Save price"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
