import { Session } from "@shopify/shopify-api";
import { getSupabase } from "./supabase.server";

// Serverless-safe Shopify session storage backed by Supabase (HTTP/PostgREST).
// Works on Vercel where the template's SQLite store cannot persist between
// invocations. Sessions are serialized as a property array in a jsonb column.
const TABLE = "shopify_sessions";

export class SupabaseSessionStorage {
  async storeSession(session) {
    const supabase = getSupabase();
    const { error } = await supabase.from(TABLE).upsert(
      {
        id: session.id,
        shop: session.shop,
        session: session.toPropertyArray(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      console.error("[session] store:", error.message);
      return false;
    }
    return true;
  }

  async loadSession(id) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select("session")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      console.error("[session] load:", error.message);
      return undefined;
    }
    return data ? Session.fromPropertyArray(data.session) : undefined;
  }

  async deleteSession(id) {
    const supabase = getSupabase();
    await supabase.from(TABLE).delete().eq("id", id);
    return true;
  }

  async deleteSessions(ids) {
    if (!ids?.length) return true;
    const supabase = getSupabase();
    await supabase.from(TABLE).delete().in("id", ids);
    return true;
  }

  async findSessionsByShop(shop) {
    const supabase = getSupabase();
    const { data } = await supabase.from(TABLE).select("session").eq("shop", shop);
    return (data || []).map((r) => Session.fromPropertyArray(r.session));
  }
}
