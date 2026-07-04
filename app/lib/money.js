// Pure helpers — NO server imports. Safe to import into client components.
// (Server-only logic that touches Supabase/Admin lives in diamonds.server.js.)

// ---------------------------------------------------------------------------
//  Money — everything internal is integer pence. Never use floats for money.
// ---------------------------------------------------------------------------
export function poundsToPence(pounds) {
  const n =
    typeof pounds === "number"
      ? pounds
      : parseFloat(String(pounds).replace(/[£,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function penceToPoundsString(pence) {
  return (pence / 100).toFixed(2); // "1200.00" — safe for Shopify variant price
}

export function formatGBP(pence) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(pence / 100);
}

// ---------------------------------------------------------------------------
//  Ring sizes — UK H..Q with half sizes, ending at Q (no Q.5). No price impact.
// ---------------------------------------------------------------------------
export function ringSizes() {
  const letters = "HIJKLMNOPQ".split("");
  const out = [];
  letters.forEach((l, i) => {
    out.push(l);
    if (i < letters.length - 1) out.push(l + ".5");
  });
  return out; // H, H.5, I, I.5 … P, P.5, Q
}

// ---------------------------------------------------------------------------
//  Normalisers — keep CSV / storefront input consistent with stored rows.
// ---------------------------------------------------------------------------
export function normOrigin(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["natural", "nat", "n"].includes(s)) return "natural";
  if (["lab", "lab grown", "lab-grown", "labgrown", "l"].includes(s)) return "lab";
  return null;
}
export function normCarat(v) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : null; // "1.00"
}
export function normColour(v) {
  const s = String(v || "").trim().toUpperCase();
  return /^[A-Z]$/.test(s) ? s : null;
}
export function normClarity(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "") || null;
}

// ---------------------------------------------------------------------------
//  Combo key — identifies a dynamic variant. Includes total price so a monthly
//  price change mints a fresh variant and never mutates an existing one.
// ---------------------------------------------------------------------------
export function comboKey({ shape, origin, carat, colour, clarity, totalPence }) {
  return [shape, origin, carat, colour, clarity, totalPence].join(":");
}

// ---------------------------------------------------------------------------
//  Which spec fields can be written to the order line items (Selector settings).
// ---------------------------------------------------------------------------
export const LINE_ITEM_FIELDS = [
  { key: "diamond", label: "Diamond (Natural/Lab)" },
  { key: "carat", label: "Carat" },
  { key: "colour", label: "Colour" },
  { key: "clarity", label: "Clarity" },
  { key: "size", label: "Ring size" },
  { key: "stone_price", label: "Diamond price" },
];
export const DEFAULT_LINE_ITEM_FIELDS = ["diamond", "carat", "colour", "clarity", "size", "stone_price"];
