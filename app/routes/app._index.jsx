import { useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { parse } from "csv-parse/sync";
import { authenticate } from "../shopify.server";
import { getSupabase } from "../supabase.server";
import {
  poundsToPence, formatGBP,
  normOrigin, normCarat, normColour, normClarity,
} from "../lib/money";

const EXPECTED = ["shape", "origin", "carat", "colour", "clarity", "price"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();

  const { data } = await supabase
    .from("diamond_prices")
    .select("shape, origin, carat, colour, clarity, price_pence")
    .eq("shop", session.shop)
    .order("origin", { ascending: true })
    .order("carat", { ascending: true });

  const rows = data || [];
  const preview = rows.slice(0, 10).map((r) => ({
    shape: r.shape, origin: r.origin, carat: r.carat,
    colour: r.colour, clarity: r.clarity, price: formatGBP(Number(r.price_pence)),
  }));

  return { total: rows.length, preview };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const supabase = getSupabase();

  const formData = await request.formData();
  const file = formData.get("csv");
  if (!file || typeof file.text !== "function") {
    return { ok: false, message: "No CSV file received." };
  }

  let records;
  try {
    records = parse(await file.text(), {
      columns: (h) => h.map((x) => x.trim().toLowerCase()),
      skip_empty_lines: true, trim: true,
      relax_column_count: true, // tolerate rows that omit the optional image_url
    });
  } catch (err) {
    return { ok: false, message: `Could not parse CSV: ${err.message}` };
  }
  if (!records.length) return { ok: false, message: "CSV had no data rows." };

  const header = Object.keys(records[0]);
  const missing = EXPECTED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, columnsOk: false, message: `Missing column(s): ${missing.join(", ")}. Expected: ${EXPECTED.join(", ")}.` };
  }

  const rows = [];
  const errors = [];
  const seen = new Set();
  const origins = new Set();
  let min = Infinity, max = -Infinity;

  records.forEach((rec, i) => {
    const line = i + 2;
    const shape = String(rec.shape || "").trim().toLowerCase();
    const origin = normOrigin(rec.origin);
    const carat = normCarat(rec.carat);
    const colour = normColour(rec.colour);
    const clarity = normClarity(rec.clarity);
    const pence = poundsToPence(rec.price);

    const e = [];
    if (!shape) e.push("shape empty");
    if (!origin) e.push(`origin '${rec.origin}' not natural/lab`);
    if (!carat) e.push(`carat '${rec.carat}' invalid`);
    if (!colour) e.push(`colour '${rec.colour}' invalid`);
    if (!clarity) e.push(`clarity '${rec.clarity}' invalid`);
    if (pence == null || pence < 0) e.push(`price '${rec.price}' invalid`);

    const key = `${shape}:${origin}:${carat}:${colour}:${clarity}`;
    if (!e.length && seen.has(key)) e.push("duplicate combination in file");
    seen.add(key);

    if (e.length) { errors.push(`Line ${line}: ${e.join("; ")}`); return; }
    origins.add(origin);
    min = Math.min(min, pence); max = Math.max(max, pence);
    // image_url is OPTIONAL — included only if the column exists and has a value.
    const imageUrl = String(rec.image_url || "").trim() || null;
    rows.push({ shop: session.shop, shape, origin, carat, colour, clarity, price_pence: pence, image_url: imageUrl, updated_at: new Date().toISOString() });
  });

  if (errors.length) {
    return { ok: false, columnsOk: true, message: `${errors.length} row(s) rejected — nothing was saved. Fix and re-upload.`, errors: errors.slice(0, 25) };
  }

  try {
    // Replace only the (shape, origin) combos present in THIS file, so uploading
    // a natural sheet never wipes the lab prices for the same shape (and vice versa).
    const pairs = [...new Set(rows.map((r) => `${r.shape}|${r.origin}`))];
    for (const pair of pairs) {
      const [shp, org] = pair.split("|");
      const { error } = await supabase.from("diamond_prices")
        .delete().eq("shop", session.shop).eq("shape", shp).eq("origin", org);
      if (error) throw new Error(error.message);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("diamond_prices")
        .upsert(rows.slice(i, i + 500), { onConflict: "shop,shape,origin,carat,colour,clarity" });
      if (error) throw new Error(error.message);
    }
  } catch (err) {
    return { ok: false, columnsOk: true, message: `Save failed: ${err.message}` };
  }

  return {
    ok: true,
    summary: {
      rows: rows.length,
      range: `${formatGBP(min)} – ${formatGBP(max)}`,
      origins: [...origins],
      hasNatural: origins.has("natural"),
      hasLab: origins.has("lab"),
    },
  };
};

export default function PriceData() {
  const { total, preview } = useLoaderData();
  const fetcher = useFetcher();
  const fileRef = useRef(null);
  const busy = fetcher.state === "submitting";
  const res = fetcher.data;
  const s = res?.ok ? res.summary : null;

  function upload(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("csv", file);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  const dropClass = "drop" + (busy ? "" : res ? (res.ok ? " done" : " err") : "");

  return (
    <div>
      <div className="page-head">
        <h2>Price data</h2>
        <p>Upload your monthly diamond price sheet. One file covers every shape and both origins.</p>
      </div>

      <div className="card">
        <h3>Upload price sheet</h3>
        <p className="desc">CSV columns: shape, origin, carat, colour, clarity, price. The whole file is validated first — if any row is wrong, nothing is saved. A successful upload replaces existing prices for the shapes in the file.</p>

        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
          onChange={(e) => upload(e.target.files?.[0])} />

        <div className={dropClass}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]); }}>
          <div className="ic">{busy ? "…" : res?.ok ? "✓" : res ? "!" : "⤒"}</div>
          <b>{busy ? "Validating…" : res?.ok ? "Price sheet loaded" : res ? "Upload rejected" : "Drop your CSV here, or click to browse"}</b>
          <small>{res && !busy ? res.message : "diamond_prices.csv · up to 5 MB"}</small>
        </div>

        {s && (
          <div className="valid">
            <div className="row"><span className="tick g">✓</span><span className="k">Columns match required format</span><span className="v">6/6</span></div>
            <div className="row"><span className="tick g">✓</span><span className="k">Rows loaded</span><span className="v">{s.rows}</span></div>
            <div className="row"><span className="tick g">✓</span><span className="k">Price range</span><span className="v">{s.range}</span></div>
            <div className="row"><span className="tick g">✓</span><span className="k">Origins found</span><span className="v">{s.origins.join(", ")}</span></div>
            <div className="row">
              <span className={"tick " + (s.hasNatural && s.hasLab ? "g" : "r")}>{s.hasNatural && s.hasLab ? "✓" : "!"}</span>
              <span className="k">{s.hasNatural && s.hasLab ? "Both natural and lab present" : "Only one origin in this file"}</span>
              <span className="v">{s.hasNatural && s.hasLab ? "complete" : "check"}</span>
            </div>
          </div>
        )}

        {res && !res.ok && res.errors?.length ? (
          <div className="flash err"><b>{res.message}</b><pre>{res.errors.join("\n")}</pre></div>
        ) : null}
      </div>

      <div className="card">
        <h3>Currently loaded</h3>
        <p className="desc">{total > 0 ? `${total} price combinations in the store.` : "No prices loaded yet — upload a sheet above."}</p>
        {preview.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Shape</th><th>Origin</th><th>Carat</th><th>Colour</th><th>Clarity</th><th>Price</th></tr></thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i}>
                    <td>{r.shape}</td>
                    <td><span className={"pill " + r.origin}>{r.origin}</span></td>
                    <td>{parseFloat(r.carat).toFixed(2)}ct</td>
                    <td>{r.colour}</td>
                    <td>{r.clarity}</td>
                    <td>{r.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tblfoot"><span>Showing {preview.length} of {total} rows</span><span>Preview</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
