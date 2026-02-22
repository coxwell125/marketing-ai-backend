// src/services/ga4Api.ts
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import path from "path";

function isGa4Enabled(): boolean {
  return String(process.env.ENABLE_GA4_API || "").toLowerCase() === "true";
}

function getProperty(): string {
  const pid = process.env.GA4_PROPERTY_ID;
  if (!pid) throw new Error("GA4_PROPERTY_ID not set");
  return `properties/${pid}`;
}

function getTimezone(): string {
  return process.env.GA4_TIMEZONE || "Asia/Kolkata";
}

function getClient(): BetaAnalyticsDataClient {
  const keyPath = process.env.GA4_CREDENTIALS_PATH;
  if (!keyPath) throw new Error("GA4_CREDENTIALS_PATH not set");

  const resolved = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);

  return new BetaAnalyticsDataClient({
    keyFilename: resolved,
  });
}

function nowIso() {
  return new Date().toISOString();
}

export type Ga4Base = {
  ok: true;
  timezone: string;
  as_of_ist: string;
};

export async function getGa4ActiveUsersToday(): Promise<
  Ga4Base & { tool: "get_ga4_active_users_today"; active_users: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(),
    dateRanges: [{ startDate: "today", endDate: "today" }],
    metrics: [{ name: "activeUsers" }],
  });

  const v = resp.rows?.[0]?.metricValues?.[0]?.value ?? "0";

  return {
    ok: true,
    tool: "get_ga4_active_users_today",
    timezone: getTimezone(),
    as_of_ist: nowIso(),
    active_users: Number(v) || 0,
  };
}

export async function getGa4SessionsToday(): Promise<
  Ga4Base & { tool: "get_ga4_sessions_today"; sessions: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(),
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

export async function getGa4SessionsMonth(): Promise<
  Ga4Base & { tool: "get_ga4_sessions_month"; sessions: number }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(),
    dateRanges: [{ startDate: "firstDayOfMonth", endDate: "today" }],
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

export async function getGa4TopPagesToday(limit = 10): Promise<
  Ga4Base & {
    tool: "get_ga4_top_pages_today";
    rows: Array<{ pagePath: string; pageTitle: string; views: number }>;
  }
> {
  if (!isGa4Enabled()) throw new Error("ENABLE_GA4_API=false");

  const client = getClient();
  const [resp] = await client.runReport({
    property: getProperty(),
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
