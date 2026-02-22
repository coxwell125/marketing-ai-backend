// src/services/metaApi.ts
import { z } from "zod";

const MetaEnvSchema = z.object({
  META_ACCESS_TOKEN: z.string().min(1),
  META_AD_ACCOUNT_ID: z.string().min(1), // format: act_123...
  META_API_VERSION: z.string().min(1).default("v20.0"),
});

type MetaEnv = z.infer<typeof MetaEnvSchema>;

function getMetaEnv(): MetaEnv {
  const parsed = MetaEnvSchema.safeParse({
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_API_VERSION: process.env.META_API_VERSION ?? "v20.0",
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Meta env invalid: ${issues}`);
  }
  return parsed.data;
}

function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(t) };
}

async function metaFetchJson(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<any> {
  const { controller, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();

    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep data null
    }

    if (!res.ok) {
      const errMsg =
        data?.error?.message ||
        `Meta API request failed (${res.status}) ${res.statusText}: ${text?.slice(0, 300)}`;
      const e = new Error(errMsg);
      (e as any).status = res.status;
      (e as any).meta = data;
      throw e;
    }

    return data;
  } finally {
    clear();
  }
}

function encodeParams(params: Record<string, string | number | boolean | undefined>) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

/**
 * Meta Insights sometimes returns different lead action types depending on objective/setup.
 * We treat any of these as a "lead":
 */
const LEAD_ACTION_TYPES = new Set<string>([
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "offsite_conversion.lead",
  "offsite_conversion.custom.lead",
  "omni_lead", // sometimes appears
]);

function parseNumberLoose(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractLeadsFromActions(actions: any): number {
  if (!Array.isArray(actions)) return 0;
  let leads = 0;

  for (const a of actions) {
    const type = typeof a?.action_type === "string" ? a.action_type : "";
    const value = parseNumberLoose(a?.value);

    if (LEAD_ACTION_TYPES.has(type)) {
      leads += value;
    }
  }

  return leads;
}

function extractCplFromCostPerActionType(costPerActionType: any): number | null {
  if (!Array.isArray(costPerActionType)) return null;

  // prefer explicit "lead" CPL if present
  let best: number | null = null;

  for (const c of costPerActionType) {
    const type = typeof c?.action_type === "string" ? c.action_type : "";
    const value = parseNumberLoose(c?.value);
    if (value <= 0) continue;

    if (LEAD_ACTION_TYPES.has(type)) {
      // first match is fine; if multiple, take lowest
      best = best === null ? value : Math.min(best, value);
    }
  }

  return best;
}

function istNowIso(): string {
  // Asia/Kolkata is UTC+05:30 fixed (no DST)
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const istMs = utcMs + 5.5 * 60 * 60_000;
  return new Date(istMs).toISOString();
}

function formatYMDInIST(d: Date): string {
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60_000;
  const istMs = utcMs + 5.5 * 60 * 60_000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayDatePresetForIST(): { since: string; until: string } {
  // Meta time_range is inclusive; we pass {since: YYYY-MM-DD, until: YYYY-MM-DD} for "today"
  const now = new Date();
  const ymd = formatYMDInIST(now);
  return { since: ymd, until: ymd };
}

/** -----------------------------
 * Existing exports (assumed used)
 * ---------------------------- */

export type MetaSpendResult = {
  ok: true;
  tool: "get_meta_spend_today" | "get_meta_spend_month";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  spend: number;
  currency: string | null;
};

export type MetaLeadsResult = {
  ok: true;
  tool: "get_meta_leads_today";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  leads: number;
};

export async function getMetaSpendToday(): Promise<MetaSpendResult> {
  const env = getMetaEnv();
  const { since, until } = todayDatePresetForIST();

  const fields = ["spend", "account_currency"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    time_increment: 1,
    fields,
    time_range: JSON.stringify({ since, until }),
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const spend = parseNumberLoose(row?.spend);
  const currency = typeof row?.account_currency === "string" ? row.account_currency : null;

  return {
    ok: true,
    tool: "get_meta_spend_today",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    spend,
    currency,
  };
}

export async function getMetaSpendMonth(): Promise<MetaSpendResult> {
  const env = getMetaEnv();

  const fields = ["spend", "account_currency"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    fields,
    date_preset: "this_month",
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const spend = parseNumberLoose(row?.spend);
  const currency = typeof row?.account_currency === "string" ? row.account_currency : null;

  return {
    ok: true,
    tool: "get_meta_spend_month",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    spend,
    currency,
  };
}

export async function getMetaLeadsToday(): Promise<MetaLeadsResult> {
  const env = getMetaEnv();
  const { since, until } = todayDatePresetForIST();

  const fields = ["actions"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    time_increment: 1,
    fields,
    time_range: JSON.stringify({ since, until }),
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const leads = extractLeadsFromActions(row?.actions);

  return {
    ok: true,
    tool: "get_meta_leads_today",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    leads,
  };
}

/** -----------------------------
 * Tool 3: get_meta_best_campaign
 * ---------------------------- */

export type MetaBestCampaignRow = {
  campaign_id: string;
  campaign_name: string;
  leads: number;
  spend: number;
  cpc: number | null; // link click CPC (Meta "cpc") when available
  cpl: number | null; // lead CPL when available
};

export type MetaBestCampaignResult = {
  ok: true;
  tool: "get_meta_best_campaign";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  window: "today";
  best: MetaBestCampaignRow | null;
  top: MetaBestCampaignRow[]; // sorted leaderboard
  note?: string;
};

export async function getMetaBestCampaign(): Promise<MetaBestCampaignResult> {
  const env = getMetaEnv();
  const { since, until } = todayDatePresetForIST();

  // Campaign-level insights
  const fields = [
    "campaign_id",
    "campaign_name",
    "spend",
    "cpc",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "campaign",
    fields,
    time_range: JSON.stringify({ since, until }),
    // limit for safety; you can raise if needed
    limit: 500,
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const rows = Array.isArray(data?.data) ? data.data : [];

  const parsed: MetaBestCampaignRow[] = rows
    .map((r: any) => {
      const campaign_id = typeof r?.campaign_id === "string" ? r.campaign_id : "";
      const campaign_name = typeof r?.campaign_name === "string" ? r.campaign_name : "";

      if (!campaign_id || !campaign_name) return null;

      const spend = parseNumberLoose(r?.spend);
      const cpc = r?.cpc === undefined ? null : parseNumberLoose(r?.cpc);
      const leads = extractLeadsFromActions(r?.actions);
      const cpl = extractCplFromCostPerActionType(r?.cost_per_action_type);

      return {
        campaign_id,
        campaign_name,
        leads,
        spend,
        cpc: cpc !== null && cpc > 0 ? cpc : null,
        cpl: cpl !== null && cpl > 0 ? cpl : null,
      } satisfies MetaBestCampaignRow;
    })
    .filter(Boolean) as MetaBestCampaignRow[];

  // Sort by: leads desc, then lowest CPC asc (nulls go last), then spend desc (for stable tie-break)
  parsed.sort((a, b) => {
    if (b.leads !== a.leads) return b.leads - a.leads;

    const aCpc = a.cpc ?? Number.POSITIVE_INFINITY;
    const bCpc = b.cpc ?? Number.POSITIVE_INFINITY;
    if (aCpc !== bCpc) return aCpc - bCpc;

    return b.spend - a.spend;
  });

  const best = parsed.length > 0 ? parsed[0] : null;

  return {
    ok: true,
    tool: "get_meta_best_campaign",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    window: "today",
    best,
    top: parsed.slice(0, 10),
    note: best
      ? undefined
      : "No campaign insights returned for today (check account activity, permissions, or reporting delays).",
  };
}
