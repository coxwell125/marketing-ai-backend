// src/services/metaApi.ts
import { z } from "zod";
import { resolveMetaAccountId } from "./metaTenant";

const MetaEnvSchema = z.object({
  META_ACCESS_TOKEN: z.string().min(1),
  META_AD_ACCOUNT_ID: z.string().min(1), // format: act_123...
  META_API_VERSION: z.string().min(1).default("v20.0"),
});

type MetaEnv = z.infer<typeof MetaEnvSchema>;

const InstagramEnvSchema = z.object({
  IG_ACCESS_TOKEN: z.string().min(1),
  META_API_VERSION: z.string().min(1).default("v20.0"),
});

type InstagramEnv = z.infer<typeof InstagramEnvSchema>;

function parseStringMapEnv(name: string): Record<string, string> {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      const key = String(k || "").trim();
      const value = String(v || "").trim();
      if (key && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeMetaAccountIdForLookup(raw: string): string {
  const v = String(raw || "").trim();
  if (!v) return "";
  return v.startsWith("act_") ? v : `act_${v}`;
}

function accountMapLookup(map: Record<string, string>, accountId?: string): string {
  if (!accountId) return "";
  const raw = String(accountId || "").trim();
  if (!raw) return "";
  const normalized = normalizeMetaAccountIdForLookup(raw);
  const stripped = normalized.startsWith("act_") ? normalized.slice(4) : normalized;
  return map[raw] || map[normalized] || map[stripped] || "";
}

function getMetaEnv(accountId?: string): MetaEnv {
  const resolvedAccount = resolveMetaAccountId(accountId);
  const parsed = MetaEnvSchema.safeParse({
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: resolvedAccount,
    META_API_VERSION: process.env.META_API_VERSION ?? "v20.0",
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Meta env invalid: ${issues}`);
  }
  return parsed.data;
}

function getInstagramEnv(accountId?: string): InstagramEnv {
  const tokenMap = parseStringMapEnv("IG_ACCESS_TOKEN_MAP");
  const mappedToken = accountMapLookup(tokenMap, accountId);
  const parsed = InstagramEnvSchema.safeParse({
    // Prefer dedicated IG token; fallback to META token for backward compatibility.
    IG_ACCESS_TOKEN: mappedToken || process.env.IG_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN,
    META_API_VERSION: process.env.META_API_VERSION ?? "v20.0",
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Instagram env invalid: ${issues}`);
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
  const byType = new Map<string, number>();

  for (const a of actions) {
    const type = typeof a?.action_type === "string" ? a.action_type : "";
    if (!LEAD_ACTION_TYPES.has(type)) continue;
    const value = parseNumberLoose(a?.value);
    byType.set(type, value);
  }

  // Avoid double counting: Meta can return the same conversion in multiple lead action types.
  // Use strict priority to align with Ads Manager "Results".
  const preferred = [
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
    "offsite_conversion.lead",
    "offsite_conversion.custom.lead",
    "omni_lead",
  ];
  for (const t of preferred) {
    const v = byType.get(t);
    if (Number.isFinite(v as number)) return Number(v);
  }

  return 0;
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

function getInstagramBusinessAccountId(accountId?: string): string {
  const idMap = parseStringMapEnv("IG_BUSINESS_ACCOUNT_ID_MAP");
  const mappedId = accountMapLookup(idMap, accountId);
  const id = String(mappedId || process.env.IG_BUSINESS_ACCOUNT_ID || "").trim();
  if (!id) throw new Error("IG_BUSINESS_ACCOUNT_ID not set");
  return id;
}

function firstDayOfMonthInIST(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const istMs = utcMs + 5.5 * 60 * 60_000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function parseIsoDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatYMDInIST(d);
}

type IgReelRow = {
  media_id: string;
  caption: string;
  permalink: string;
  published_at: string;
  plays: number;
  reach: number;
  saved: number;
  likes: number;
  comments: number;
  shares: number;
};

async function fetchIgMediaBaseRows(env: InstagramEnv, accountId?: string): Promise<
  Array<{
    id: string;
    caption: string;
    permalink: string;
    media_type: string;
    media_product_type: string;
    timestamp: string;
  }>
> {
  const igId = getInstagramBusinessAccountId(accountId);
  const fields = ["id", "caption", "permalink", "media_type", "media_product_type", "timestamp"].join(",");
  const params = encodeParams({
    access_token: env.IG_ACCESS_TOKEN,
    fields,
    limit: 100,
  });
  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${igId}/media?${params}`;
  const data = await metaFetchJson(url);
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows
    .map((r: any) => ({
      id: String(r?.id || ""),
      caption: String(r?.caption || ""),
      permalink: String(r?.permalink || ""),
      media_type: String(r?.media_type || ""),
      media_product_type: String(r?.media_product_type || ""),
      timestamp: String(r?.timestamp || ""),
    }))
    .filter((r: any) => {
      if (!r.id) return false;
      const mediaType = String(r.media_type || "").toUpperCase();
      const productType = String(r.media_product_type || "").toUpperCase();
      // Reels can be represented as REEL or as VIDEO with media_product_type=REELS.
      return mediaType === "REEL" || productType === "REELS";
    });
}

async function fetchIgReelInsights(env: InstagramEnv, mediaId: string): Promise<{
  plays: number;
  reach: number;
  saved: number;
  likes: number;
  comments: number;
  shares: number;
}> {
  // Metric availability varies by API version/account.
  // v22+ may reject `plays` for reels; fallback to `views`.
  const rows = await (async () => {
    const tryFetch = async (metrics: string) => {
      const params = encodeParams({
        access_token: env.IG_ACCESS_TOKEN,
        metric: metrics,
      });
      const url = `https://graph.facebook.com/${env.META_API_VERSION}/${mediaId}/insights?${params}`;
      const data = await metaFetchJson(url);
      return Array.isArray(data?.data) ? data.data : [];
    };

    try {
      return await tryFetch("plays,reach,saved,likes,comments,shares,total_interactions");
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (!/plays metric is no longer supported|no longer supported/i.test(msg)) throw err;
      return tryFetch("views,reach,saved,likes,comments,shares,total_interactions");
    }
  })();

  const out = {
    plays: 0,
    reach: 0,
    saved: 0,
    likes: 0,
    comments: 0,
    shares: 0,
  };

  for (const r of rows) {
    const name = String(r?.name || "");
    const value = parseNumberLoose(r?.values?.[0]?.value ?? r?.value);
    if (name === "plays") out.plays = value;
    else if (name === "views") out.plays = value;
    else if (name === "reach") out.reach = value;
    else if (name === "saved") out.saved = value;
    else if (name === "likes") out.likes = value;
    else if (name === "comments") out.comments = value;
    else if (name === "shares") out.shares = value;
  }

  return out;
}

async function fetchIgReelsForRange(
  accountId: string | undefined,
  sinceYmd: string,
  untilYmd: string
): Promise<IgReelRow[]> {
  const env = getInstagramEnv(accountId);
  const baseRows = await fetchIgMediaBaseRows(env, accountId);

  const filtered = baseRows.filter((r) => {
    const ymd = parseIsoDateOnly(r.timestamp);
    return !!ymd && ymd >= sinceYmd && ymd <= untilYmd;
  });

  const out: IgReelRow[] = [];
  for (const row of filtered) {
    let metrics = {
      plays: 0,
      reach: 0,
      saved: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    };
    try {
      metrics = await fetchIgReelInsights(env, row.id);
    } catch {
      // keep zeros when insights metric is unavailable for a reel
    }
    out.push({
      media_id: row.id,
      caption: row.caption,
      permalink: row.permalink,
      published_at: row.timestamp,
      ...metrics,
    });
  }
  return out;
}

/** -----------------------------
 * Existing exports (assumed used)
 * ---------------------------- */

export type MetaSpendResult = {
  ok: true;
  tool: "get_meta_spend_today" | "get_meta_spend_month" | "get_meta_spend_last_7d";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  spend: number;
  currency: string | null;
};

export type MetaLeadsResult = {
  ok: true;
  tool: "get_meta_leads_today" | "get_meta_leads_last_30d" | "get_meta_leads_last_7d";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  leads: number;
};

export type MetaAdsRunningTodayResult = {
  ok: true;
  tool: "get_meta_ads_running_today";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  active_ads: number;
  ads_with_spend_today: number;
};

export async function getMetaSpendToday(accountId?: string): Promise<MetaSpendResult> {
  const env = getMetaEnv(accountId);
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

export async function getMetaSpendMonth(accountId?: string): Promise<MetaSpendResult> {
  const env = getMetaEnv(accountId);

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

export async function getMetaLeadsToday(accountId?: string): Promise<MetaLeadsResult> {
  const env = getMetaEnv(accountId);
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

export async function getMetaSpendLast7d(accountId?: string): Promise<MetaSpendResult> {
  const env = getMetaEnv(accountId);

  const fields = ["spend", "account_currency"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    fields,
    date_preset: "last_7d",
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const spend = parseNumberLoose(row?.spend);
  const currency = typeof row?.account_currency === "string" ? row.account_currency : null;

  return {
    ok: true,
    tool: "get_meta_spend_last_7d",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    spend,
    currency,
  };
}

export async function getMetaLeadsLast30d(accountId?: string): Promise<MetaLeadsResult> {
  const env = getMetaEnv(accountId);

  const fields = ["actions"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    fields,
    date_preset: "last_30d",
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const leads = extractLeadsFromActions(row?.actions);

  return {
    ok: true,
    tool: "get_meta_leads_last_30d",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    leads,
  };
}

export async function getMetaLeadsLast7d(accountId?: string): Promise<MetaLeadsResult> {
  const env = getMetaEnv(accountId);

  const fields = ["actions"].join(",");
  const params = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "account",
    fields,
    date_preset: "last_7d",
  });

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const data = await metaFetchJson(url);

  const row = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  const leads = extractLeadsFromActions(row?.actions);

  return {
    ok: true,
    tool: "get_meta_leads_last_7d",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    leads,
  };
}

export async function getMetaAdsRunningToday(accountId?: string): Promise<MetaAdsRunningTodayResult> {
  const env = getMetaEnv(accountId);

  // Active ads currently in account
  const adsParams = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    fields: "id,effective_status",
    limit: 500,
  });
  const adsUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/ads?${adsParams}`;
  const adsData = await metaFetchJson(adsUrl);
  const adRows = Array.isArray(adsData?.data) ? adsData.data : [];
  const activeAds = adRows.filter((r: any) => String(r?.effective_status || "") === "ACTIVE").length;

  // Ads that delivered/spent today
  const spendParams = encodeParams({
    access_token: env.META_ACCESS_TOKEN,
    level: "ad",
    fields: "ad_id,spend",
    date_preset: "today",
    limit: 500,
  });
  const spendUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${spendParams}`;
  const spendData = await metaFetchJson(spendUrl);
  const spendRows = Array.isArray(spendData?.data) ? spendData.data : [];
  const adsWithSpendToday = spendRows.filter((r: any) => parseNumberLoose(r?.spend) > 0).length;

  return {
    ok: true,
    tool: "get_meta_ads_running_today",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    active_ads: activeAds,
    ads_with_spend_today: adsWithSpendToday,
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
  window: "today" | "this_month" | "maximum";
  best: MetaBestCampaignRow | null;
  top: MetaBestCampaignRow[]; // sorted leaderboard
  note?: string;
};

export async function getMetaBestCampaign(
  accountId?: string,
  period: "today" | "this_month" | "maximum" = "today"
): Promise<MetaBestCampaignResult> {
  const env = getMetaEnv(accountId);
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
    ...(period === "today"
      ? { time_range: JSON.stringify({ since, until }) }
      : { date_preset: period }),
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
    window: period,
    best,
    top: parsed.slice(0, 10),
    note: best
      ? undefined
      : `No campaign insights returned for ${period} (check account activity, permissions, or reporting delays).`,
  };
}

export type InstagramReelsTodayResult = {
  ok: true;
  tool: "get_instagram_reels_today";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  reels_count: number;
  total_plays: number;
  total_reach: number;
  total_saved: number;
  top: IgReelRow[];
};

export type InstagramReelsMonthResult = {
  ok: true;
  tool: "get_instagram_reels_month";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  reels_count: number;
  total_plays: number;
  total_reach: number;
  total_saved: number;
  top: IgReelRow[];
};

export type InstagramBestReelResult = {
  ok: true;
  tool: "get_instagram_best_reel";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  window: "today" | "this_month" | "maximum";
  best: IgReelRow | null;
  top: IgReelRow[];
};

export type InstagramAccountOverviewResult = {
  ok: true;
  tool: "get_instagram_account_overview";
  timezone: "Asia/Kolkata";
  as_of_ist: string;
  account: {
    ig_business_account_id: string;
    username: string;
    name: string;
    followers_count: number;
    follows_count: number;
    media_count: number;
  };
};

export async function getInstagramReelsToday(accountId?: string): Promise<InstagramReelsTodayResult> {
  const { since, until } = todayDatePresetForIST();
  const reels = await fetchIgReelsForRange(accountId, since, until);
  reels.sort((a, b) => b.plays - a.plays || b.reach - a.reach);
  return {
    ok: true,
    tool: "get_instagram_reels_today",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    reels_count: reels.length,
    total_plays: reels.reduce((s, r) => s + r.plays, 0),
    total_reach: reels.reduce((s, r) => s + r.reach, 0),
    total_saved: reels.reduce((s, r) => s + r.saved, 0),
    top: reels.slice(0, 10),
  };
}

export async function getInstagramReelsMonth(accountId?: string): Promise<InstagramReelsMonthResult> {
  const since = firstDayOfMonthInIST();
  const until = formatYMDInIST(new Date());
  const reels = await fetchIgReelsForRange(accountId, since, until);
  reels.sort((a, b) => b.plays - a.plays || b.reach - a.reach);
  return {
    ok: true,
    tool: "get_instagram_reels_month",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    reels_count: reels.length,
    total_plays: reels.reduce((s, r) => s + r.plays, 0),
    total_reach: reels.reduce((s, r) => s + r.reach, 0),
    total_saved: reels.reduce((s, r) => s + r.saved, 0),
    top: reels.slice(0, 10),
  };
}

export async function getInstagramAccountOverview(accountId?: string): Promise<InstagramAccountOverviewResult> {
  const env = getInstagramEnv(accountId);
  const igId = getInstagramBusinessAccountId(accountId);
  const fields = ["id", "username", "name", "followers_count", "follows_count", "media_count"].join(",");
  const params = encodeParams({
    access_token: env.IG_ACCESS_TOKEN,
    fields,
  });
  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${igId}?${params}`;
  const data = await metaFetchJson(url);

  return {
    ok: true,
    tool: "get_instagram_account_overview",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    account: {
      ig_business_account_id: String(data?.id || igId),
      username: String(data?.username || ""),
      name: String(data?.name || ""),
      followers_count: parseNumberLoose(data?.followers_count),
      follows_count: parseNumberLoose(data?.follows_count),
      media_count: parseNumberLoose(data?.media_count),
    },
  };
}

export async function getInstagramBestReel(
  accountId?: string,
  period: "today" | "this_month" | "maximum" = "today"
): Promise<InstagramBestReelResult> {
  let since = firstDayOfMonthInIST();
  let until = formatYMDInIST(new Date());
  if (period === "today") {
    const r = todayDatePresetForIST();
    since = r.since;
    until = r.until;
  } else if (period === "maximum") {
    since = "2010-01-01";
    until = formatYMDInIST(new Date());
  }

  const reels = await fetchIgReelsForRange(accountId, since, until);
  reels.sort((a, b) => b.plays - a.plays || b.reach - a.reach || b.saved - a.saved);
  return {
    ok: true,
    tool: "get_instagram_best_reel",
    timezone: "Asia/Kolkata",
    as_of_ist: istNowIso(),
    window: period,
    best: reels[0] || null,
    top: reels.slice(0, 10),
  };
}

export async function verifyMetaToken(accountId?: string): Promise<{
  ok: boolean;
  token_valid: boolean;
  account_access: boolean;
  account_id: string;
  app_scoped_user?: { id: string; name: string };
  sample_spend_today?: number;
  currency?: string | null;
  error?: string;
}> {
  try {
    const env = getMetaEnv(accountId);
    const meParams = encodeParams({
      access_token: env.META_ACCESS_TOKEN,
      fields: "id,name",
    });
    const meUrl = `https://graph.facebook.com/${env.META_API_VERSION}/me?${meParams}`;
    const me = await metaFetchJson(meUrl);

    const { since, until } = todayDatePresetForIST();
    const insightsParams = encodeParams({
      access_token: env.META_ACCESS_TOKEN,
      level: "account",
      fields: "spend,account_currency",
      time_range: JSON.stringify({ since, until }),
      limit: 1,
    });
    const insightsUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_AD_ACCOUNT_ID}/insights?${insightsParams}`;
    const insights = await metaFetchJson(insightsUrl);
    const row = Array.isArray(insights?.data) && insights.data.length ? insights.data[0] : null;

    return {
      ok: true,
      token_valid: true,
      account_access: true,
      account_id: env.META_AD_ACCOUNT_ID,
      app_scoped_user: {
        id: String(me?.id || ""),
        name: String(me?.name || ""),
      },
      sample_spend_today: parseNumberLoose(row?.spend),
      currency: typeof row?.account_currency === "string" ? row.account_currency : null,
    };
  } catch (err: any) {
    const msg = err?.message ? String(err.message) : "Unknown Meta API error";
    let accountId = String(process.env.META_AD_ACCOUNT_ID || "");
    try {
      accountId = getMetaEnv(accountId || undefined).META_AD_ACCOUNT_ID;
    } catch {}
    return {
      ok: false,
      token_valid: !/access token/i.test(msg),
      account_access: !/ad account|permission|unsupported|not found|invalid/i.test(msg),
      account_id: accountId,
      error: msg,
    };
  }
}
