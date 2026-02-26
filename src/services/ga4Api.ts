// src/services/ga4Api.ts
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import path from "path";

function isGa4Enabled(): boolean {
  return String(process.env.ENABLE_GA4_API || "").toLowerCase() === "true";
}

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

function getProperty(accountId?: string): string {
  const propertyMap = parseStringMapEnv("GA4_PROPERTY_ID_MAP");
  const mapped = accountMapLookup(propertyMap, accountId);
  const pid = String(mapped || process.env.GA4_PROPERTY_ID || "").trim();
  if (!pid) throw new Error("GA4_PROPERTY_ID not set");
  return `properties/${pid}`;
}

function getTimezone(): string {
  return process.env.GA4_TIMEZONE || "Asia/Kolkata";
}

function getCredentialsPath(): string {
  const keyPath = process.env.GA4_CREDENTIALS_PATH;
  if (!keyPath) throw new Error("GA4_CREDENTIALS_PATH not set");
  return path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
}

function getClient(): BetaAnalyticsDataClient {
  const credentialsJson = String(process.env.GA4_CREDENTIALS_JSON || "").trim();
  if (credentialsJson) {
    let credentials: any;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch {
      throw new Error("GA4_CREDENTIALS_JSON is not valid JSON");
    }
    return new BetaAnalyticsDataClient({ credentials });
  }

  return new BetaAnalyticsDataClient({
    keyFilename: getCredentialsPath(),
  });
}

function nowIso() {
  return new Date().toISOString();
}

function firstDayOfCurrentMonthYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

export type Ga4Base = {
  ok: true;
  timezone: string;
  as_of_ist: string;
};

export async function verifyGa4Setup(): Promise<{
  ok: boolean;
  property: string;
  timezone: string;
  as_of_ist: string;
  realtime_active_users?: number;
  today_sessions?: number;
  last_7_days_sessions?: number;
  error?: string;
}> {
  try {
    if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");
    const client = getClient();
    const property = getProperty();

    let realtimeActiveUsers = 0;
    try {
      const [rt] = await client.runRealtimeReport({
        property,
        metrics: [{ name: "activeUsers" }],
      });
      realtimeActiveUsers = Number(rt.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;
    } catch {
      // keep 0 if realtime endpoint unavailable
    }

    const [today] = await client.runReport({
      property,
      dateRanges: [{ startDate: "today", endDate: "today" }],
      metrics: [{ name: "sessions" }],
    });
    const [last7] = await client.runReport({
      property,
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [{ name: "sessions" }],
    });

    return {
      ok: true,
      property,
      timezone: getTimezone(),
      as_of_ist: nowIso(),
      realtime_active_users: realtimeActiveUsers,
      today_sessions: Number(today?.rows?.[0]?.metricValues?.[0]?.value || 0) || 0,
      last_7_days_sessions: Number(last7?.rows?.[0]?.metricValues?.[0]?.value || 0) || 0,
    };
  } catch (err: any) {
    return {
      ok: false,
      property: getProperty(),
      timezone: getTimezone(),
      as_of_ist: nowIso(),
      error: err?.message ? String(err.message) : "GA4 verify failed",
    };
  }
}

export async function debugGa4Tag(): Promise<{
  ok: boolean;
  property: string;
  timezone: string;
  as_of_ist: string;
  config: {
    enabled: boolean;
    credentials_path: string | null;
  };
  metrics?: {
    realtime_active_users: number;
    today_sessions: number;
    last_7_days_sessions: number;
    last_30_days_sessions: number;
  };
  diagnosis: string;
  next_actions: string[];
  error?: string;
}> {
  const timezone = getTimezone();
  const asOf = nowIso();
  const enabled = isGa4Enabled();
  const propertyId = process.env.GA4_PROPERTY_ID || "";
  const property = propertyId ? `properties/${propertyId}` : "properties/<missing>";
  const credentialsJsonRaw = String(process.env.GA4_CREDENTIALS_JSON || "").trim();
  const hasCredentialsJson = Boolean(credentialsJsonRaw);
  const credentialsPath = process.env.GA4_CREDENTIALS_PATH
    ? getCredentialsPath()
    : null;

  if (!enabled) {
    return {
      ok: false,
      property,
      timezone,
      as_of_ist: asOf,
      config: { enabled, credentials_path: credentialsPath },
      diagnosis: "GA4 API is disabled in environment configuration.",
      next_actions: ["Set ENABLE_GA4_API=true in .env and restart backend."],
      error: "ENABLE_GA4_API=false",
    };
  }

  if (!propertyId) {
    return {
      ok: false,
      property,
      timezone,
      as_of_ist: asOf,
      config: { enabled, credentials_path: credentialsPath },
      diagnosis: "GA4 property id is missing.",
      next_actions: ["Set GA4_PROPERTY_ID in .env and restart backend."],
      error: "GA4_PROPERTY_ID not set",
    };
  }

  if (!hasCredentialsJson && !credentialsPath) {
    return {
      ok: false,
      property,
      timezone,
      as_of_ist: asOf,
      config: { enabled, credentials_path: credentialsPath },
      diagnosis: "GA4 credentials are missing.",
      next_actions: [
        "Set GA4_CREDENTIALS_JSON with full service account JSON (recommended for Vercel), or",
        "Set GA4_CREDENTIALS_PATH to a valid key file path and restart backend.",
      ],
      error: "GA4_CREDENTIALS_JSON/GA4_CREDENTIALS_PATH not set",
    };
  }

  try {
    const client = getClient();

    let realtimeActiveUsers = 0;
    try {
      const [rt] = await client.runRealtimeReport({
        property,
        metrics: [{ name: "activeUsers" }],
      });
      realtimeActiveUsers = Number(rt.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;
    } catch {
      // Realtime can fail for some properties; keep 0 and continue with standard report checks.
    }

    const [today] = await client.runReport({
      property,
      dateRanges: [{ startDate: "today", endDate: "today" }],
      metrics: [{ name: "sessions" }],
    });
    const [last7] = await client.runReport({
      property,
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [{ name: "sessions" }],
    });
    const [last30] = await client.runReport({
      property,
      dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
      metrics: [{ name: "sessions" }],
    });

    const todaySessions = Number(today.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;
    const last7Sessions = Number(last7.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;
    const last30Sessions = Number(last30.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;

    if (todaySessions === 0 && last7Sessions === 0 && last30Sessions === 0 && realtimeActiveUsers === 0) {
      return {
        ok: true,
        property,
        timezone,
        as_of_ist: asOf,
        config: { enabled, credentials_path: credentialsPath },
        metrics: {
          realtime_active_users: realtimeActiveUsers,
          today_sessions: todaySessions,
          last_7_days_sessions: last7Sessions,
          last_30_days_sessions: last30Sessions,
        },
        diagnosis:
          "Credentials and property access are valid, but this GA4 property has no tracked traffic in recent ranges.",
        next_actions: [
          "Open GA4 Realtime for this exact property and visit your site in incognito.",
          "Verify your site uses the Measurement ID of this property (not another property).",
          "If using GTM, confirm GA4 Configuration tag fires on all pages.",
        ],
      };
    }

    return {
      ok: true,
      property,
      timezone,
      as_of_ist: asOf,
      config: { enabled, credentials_path: credentialsPath },
      metrics: {
        realtime_active_users: realtimeActiveUsers,
        today_sessions: todaySessions,
        last_7_days_sessions: last7Sessions,
        last_30_days_sessions: last30Sessions,
      },
      diagnosis: "GA4 tracking is live and returning data.",
      next_actions: ["No configuration change needed."],
    };
  } catch (err: any) {
    const msg = err?.message ? String(err.message) : "GA4 debug failed";
    const commonActions = [
      "Confirm service account has Viewer/Analyst access to this GA4 property.",
      "Check GA4_PROPERTY_ID is correct and belongs to the same property.",
      "Validate GA4_CREDENTIALS_PATH points to the correct JSON key file.",
    ];
    return {
      ok: false,
      property,
      timezone,
      as_of_ist: asOf,
      config: { enabled, credentials_path: credentialsPath },
      diagnosis: "GA4 API call failed due to configuration or permissions.",
      next_actions: commonActions,
      error: msg,
    };
  }
}

export async function getGa4ActiveUsersToday(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_active_users_today"; active_users: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  // Prefer realtime active users for "today/now" behavior; fall back to report if unavailable.
  let v = "0";
  try {
    const [rt] = await client.runRealtimeReport({
      property: getProperty(accountId),
      metrics: [{ name: "activeUsers" }],
    });
    v = rt.rows?.[0]?.metricValues?.[0]?.value ?? "0";
  } catch {
    const [resp] = await client.runReport({
      property: getProperty(accountId),
      dateRanges: [{ startDate: "today", endDate: "today" }],
      metrics: [{ name: "activeUsers" }],
    });
    v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";
  }

  return {
    ok: true,
    tool: "get_ga4_active_users_today",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    active_users: Number(v) || 0,
  };
}

export async function getGa4ActiveUsersYesterday(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_active_users_yesterday"; active_users: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
    metrics: [{ name: "activeUsers" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_active_users_yesterday",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    active_users: Number(v) || 0,
  };
}

export async function getGa4ActiveUsersLast7Days(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_active_users_last_7_days"; active_users: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
    metrics: [{ name: "activeUsers" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_active_users_last_7_days",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    active_users: Number(v) || 0,
  };
}

export async function getGa4SessionsToday(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_sessions_today"; sessions: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate: "today", endDate: "today" }],
    metrics: [{ name: "sessions" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_sessions_today",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    sessions: Number(v) || 0,
  };
}

export async function getGa4SessionsMonth(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_sessions_month"; sessions: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const startDate = firstDayOfCurrentMonthYmd();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate, endDate: "today" }],
    metrics: [{ name: "sessions" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_sessions_month",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    sessions: Number(v) || 0,
  };
}

export async function getGa4SessionsLast7Days(accountId?: string): Promise<
  Ga4Base & { tool: "get_ga4_sessions_last_7_days"; sessions: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
    metrics: [{ name: "sessions" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_sessions_last_7_days",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    sessions: Number(v) || 0,
  };
}

export async function getGa4TopPagesToday(limit = 10, accountId?: string): Promise<
  Ga4Base & {
    tool: "get_ga4_top_pages_today";
    rows: Array<{ pagePath: string; pageTitle: string; views: number }>;
  }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(accountId),
    dateRanges: [{ startDate: "today", endDate: "today" }],
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: [{ name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit,
  });

  const rows =
    resp.rows?.map((r) => ({
      pagePath: r.dimensionValues?.[0]?.value || "",
      pageTitle: r.dimensionValues?.[1]?.value || "",
      views: Number(r.metricValues?.[0]?.value || 0) || 0,
    })) ?? [];

  return {
    ok: true,
    tool: "get_ga4_top_pages_today",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    rows,
  };
}
