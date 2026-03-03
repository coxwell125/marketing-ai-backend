import { verifyMetaToken, getInstagramAccountOverview, getMetaAdsList } from "./metaApi";
import { verifyGa4Setup } from "./ga4Api";

type ToolCall = {
  name: string;
  arguments: any;
};

function clampLimit(v: any, fallback = 30): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function isIsoDateOnly(v: any): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export async function runTool(call: ToolCall, headers: Record<string, string>) {
  const name = String(call?.name || "");
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const headerAccount = String(headers["x-meta-account-id"] || "").trim();
  const accountId = String(args?.account_id || headerAccount || "").trim() || undefined;

  if (name === "instagram_overview") {
    if (!accountId) return { ok: false, tool: name, error: "account_id is required" };
    return getInstagramAccountOverview(accountId);
  }

  if (name === "meta_verify_token") {
    return verifyMetaToken(accountId);
  }

  if (name === "ga4_verify") {
    return verifyGa4Setup();
  }

  if (name === "meta_ads_list") {
    if (!accountId) return { ok: false, tool: name, error: "account_id is required" };

    const since = isIsoDateOnly(args?.since) ? String(args.since) : null;
    const until = isIsoDateOnly(args?.until) ? String(args.until) : null;
    const limit = clampLimit(args?.limit, 30);

    const raw = await getMetaAdsList(accountId, { since: since || undefined, until: until || undefined, limit });
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];

    return {
      ok: true,
      tool: name,
      source_tool: "get_meta_ads_list",
      account_id: accountId,
      timezone: raw.timezone,
      currency: raw.currency,
      requested: { since, until, limit },
      count: rows.length,
      rows,
    };
  }

  return { ok: false, tool: name, error: `Unknown tool: ${name}` };
}
