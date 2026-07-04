import { useRef } from "react";
import { Form, useActionData, useFetcher, useLoaderData, useSearchParams } from "react-router";
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
const SHAPES = ["emerald", "round", "oval", "princess", "cushion", "pear"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, count } = await supabase
    .from("diamond_prices")
    .select("id, shape, origin, carat, colour, clarity, price_pence", { count: "exact" })
    .eq("shop", session.shop)
    .order("shape", { ascending: true })
    .order("origin", { ascending: true })
    .order("carat", { ascending: true })
    .order("colour", { ascending: true })
    .order("clarity", { ascending: true })
    .range(from, to);

  const rows = (data || []).map((r) => ({
    id: r.id,
    shape: r.shape,
    origin: r.origin,
    carat: r.carat,
    colour: r.colour,
    clarity: r.clarity,
    pounds: (Number(r.price_pence) / 100).toString(),
    priceFormatted: formatGBP(Number(r.price_pence)),
  }));

  return { rows, total: count || 0, page };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();
  const fd = await request.formData();
  const intent = fd.get("intent");

  // ---- delete one row ----
  if (intent === "delete") {
    await supabase.from("diamond_prices").delete().eq("shop", session.shop).eq("id", fd.get("id"));
    return { result: { ok: true, message: "Row deleted." } };
  }

  // ---- edit one row's price ----
  if (intent === "update") {
    const pence = poundsToPence(fd.get("price"));
    if (pence == null || pence < 0) return { result: { ok: false, message: "Invalid price." } };
    await supabase.from("diamond_prices")
      .update({ price_pence: pence, updated_at: new Date().toISOString() })
      .eq("shop", session.shop).eq("id", fd.get("id"));
    return { result: { ok: true, message: "Price updated." } };
  }

  // ---- add / upsert a single combination ----
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

  // ---- CSV upload (default) ----
  const file = fd.get("csv");
  if (!file || typeof file.text !== "function") return { ok: false, message: "No CSV file received." };

  let records;
  try {
    records = parse(await file.text(), {
      columns: (h) => h.map((x) => x.trim().toLowerCase()),
      skip_empty_lines: true, trim: true, relax_column_count: true,
    });
  } catch (err) {
    return { ok: false, message: `Could not parse CSV: ${err.message}` };
  }
  if (!records.length) return { ok: false, message: "CSV had no data rows." };

  const missing = EXPECTED.filter((c) => !Object.keys(records[0]).includes(c));
  if (missing.length) return { ok: false, message: `Missing column(s): ${missing.join(", ")}. Expected: ${EXPECTED.join(", ")}.` };

  const rows = [], errors = [], seen = new Set(), origins = new Set();
  let min = Infinity, max = -Infinity;
  records.forEach((rec, i) => {
    const line = i + 2;
    const shape = String(rec.shape || "").trim().toLowerCase();
    const origin = normOrigin(rec.origin), carat = normCarat(rec.carat);
    const colour = normColour(rec.colour), clarity = normClarity(rec.clarity);
    const pence = poundsToPence(rec.price);
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
    const imageUrl = String(rec.image_url || "").trim() || null;
    rows.push({ shop: session.shop, shape, origin, carat, colour, clarity, price_pence: pence, image_url: imageUrl, updated_at: new Date().toISOString() });
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
  } catch (err) {
    return { ok: false, message: `Save failed: ${err.message}` };
  }

  return { ok: true, summary: { rows: rows.length, range: `${formatGBP(min)} – ${formatGBP(max)}`, origins: [...origins] } };
};

export default function PriceData() {
  const { rows, total, page } = useLoaderData();
  const actionData = useActionData();
  const uploader = useFetcher();
  const fileRef = useRef(null);
  const busy = uploader.state === "submitting";
  const up = uploader.data;
  const s = up?.ok ? up.summary : null;
  const r = actionData?.result;
  const [, setParams] = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function upload(f) {
    if (!f) return;
    const fd = new FormData();
    fd.append("csv", f);
    uploader.submit(fd, { method: "post", encType: "multipart/form-data" });
  }
  function goto(p) { setParams((prev) => { prev.set("page", String(p)); return prev; }); }

  const inp = { width: "100%", padding: "8px 10px", border: "1px solid #d9d9d9", borderRadius: "6px", fontSize: 13, background: "#fff" };

  return (
    <div>
      <div className="page-head">
        <h2>Price data</h2>
        <p>Upload a full sheet, or add and edit individual prices by hand below.</p>
      </div>

      {/* ---- CSV upload ---- */}
      <div className="card">
        <h3>Upload price sheet (CSV)</h3>
        <p className="desc">Columns: shape, origin, carat, colour, clarity, price (image_url optional). Validated first — one bad row and nothing saves. A successful upload replaces existing prices for the shapes+origins in the file.</p>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <div className={"drop" + (busy ? "" : up ? (up.ok ? " done" : " err") : "")}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]); }}>
          <div className="ic">{busy ? "…" : up?.ok ? "✓" : up ? "!" : "⤒"}</div>
          <b>{busy ? "Validating…" : up?.ok ? "Loaded" : up ? "Rejected" : "Drop your CSV here, or click to browse"}</b>
          <small>{up && !busy ? up.message : "diamond_prices.csv"}</small>
        </div>
        {s && <div className="flash ok">Loaded {s.rows} prices · {s.range} · {s.origins.join(", ")}</div>}
        {up && !up.ok && up.errors?.length ? <div className="flash err"><b>{up.message}</b><pre>{up.errors.join("\n")}</pre></div> : null}
      </div>

      {/* ---- Add a single price ---- */}
      <div className="card">
        <h3>Add / update a single price</h3>
        <p className="desc">Adds one combination. If it already exists, its price is updated.</p>
        <Form method="post">
          <input type="hidden" name="intent" value="add" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, alignItems: "end" }}>
            <label><span className="muted">Shape</span>
              <select name="shape" style={inp} defaultValue="emerald">{SHAPES.map((sh) => <option key={sh} value={sh}>{sh}</option>)}</select></label>
            <label><span className="muted">Origin</span>
              <select name="origin" style={inp} defaultValue="lab"><option value="natural">natural</option><option value="lab">lab</option></select></label>
            <label><span className="muted">Carat</span><input name="carat" style={inp} placeholder="1.00" /></label>
            <label><span className="muted">Colour</span><input name="colour" style={inp} placeholder="D" /></label>
            <label><span className="muted">Clarity</span><input name="clarity" style={inp} placeholder="VVS1" /></label>
            <label><span className="muted">Price (£)</span><input name="price" style={inp} placeholder="720" inputMode="decimal" /></label>
          </div>
          <div className="savebar" style={{ marginTop: 14 }}>
            <button className="btn" type="submit">Add price</button>
            {r && <span className={"flash " + (r.ok ? "ok" : "err")} style={{ marginTop: 0 }}>{r.message}</span>}
          </div>
        </Form>
      </div>

      {/* ---- Editable table ---- */}
      <div className="card">
        <h3>Currently loaded — {total} prices</h3>
        {rows.length === 0 ? (
          <p className="muted">No prices yet. Upload a sheet or add one above.</p>
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
                    <td>
                      <Form method="post" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="hidden" name="intent" value="update" />
                        <input type="hidden" name="id" value={row.id} />
                        <input name="price" defaultValue={row.pounds} style={{ ...inp, width: 90, padding: "5px 8px" }} inputMode="decimal" />
                        <button className="btn ghost" style={{ padding: "5px 10px", letterSpacing: 0, textTransform: "none" }} type="submit">Save</button>
                      </Form>
                    </td>
                    <td>
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={row.id} />
                        <button className="btn ghost" style={{ padding: "5px 10px", letterSpacing: 0, textTransform: "none" }} type="submit">Delete</button>
                      </Form>
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
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
