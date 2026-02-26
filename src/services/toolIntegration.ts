// src/services/toolIntegration.ts
import { callMcpTool } from "./mcpClient";
import {
  getMetaLeadsToday,
  getMetaLeadsLast30d,
  getMetaLeadsLast7d,
  getMetaAdsRunningToday,
  getMetaSpendMonth,
  getMetaSpendLast7d,
  getMetaSpendToday,
  getMetaBestCampaign,
  getInstagramReelsToday,
  getInstagramReelsMonth,
  getInstagramBestReel,
  getInstagramAccountOverview,
} from "./metaApi";

import {
  getGa4ActiveUsersToday,
  getGa4ActiveUsersYesterday,
  getGa4ActiveUsersLast7Days,
  getGa4ActiveUsersLast15Days,
  getGa4ActiveUsersLast30Days,
  getGa4SessionsToday,
  getGa4SessionsYesterday,
  getGa4SessionsLast7Days,
  getGa4SessionsLast15Days,
  getGa4SessionsLast30Days,
  getGa4SessionsMonth,
  getGa4TopPagesToday,
  getGa4PageViewsByPeriod,
  getGa4TopCityByPeriod,
  getGa4ReportSnapshot,
  getGa4ActiveUsersByCity,
  getGa4SessionsBySourceMedium,
  getGa4TopPagesScreens,
} from "./ga4Api";

type AnyJson = Record<string, any>;
type ToolHandler = (args: AnyJson) => Promise<any>;
export type ToolRunContext = {
  metaAccountId?: string;
  role?: "viewer" | "analyst" | "admin";
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: AnyJson; // JSON Schema
  handler: ToolHandler;
};

function isMetaEnabled(): boolean {
  return String(process.env.ENABLE_META_API || "").toLowerCase() === "true";
}

function shouldUseStrictLiveForTool(toolName: string): boolean {
  const allowMetaFallback = String(process.env.ALLOW_MCP_META_FALLBACK || "false").toLowerCase() === "true";
  const isMetaFamily = toolName.startsWith("get_meta_") || toolName.startsWith("get_instagram_");
  return isMetaFamily && !allowMetaFallback;
}

function allowAnyFallback(): boolean {
  return String(process.env.ALLOW_FAKE_DATA || "false").toLowerCase() === "true";
}

function istNowIso(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const istMs = utcMs + 5.5 * 60 * 60_000;
  return new Date(istMs).toISOString();
}

function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function stableNumber(seedStr: string, min: number, max: number): number {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return min + (seed % (max - min + 1));
}

function makeLocalMock(toolName: string, args: AnyJson = {}, reason = "Fallback mock"): any | null {
  const now = new Date();
  const asOf = istNowIso();
  const today = formatYmd(now);
  const monthStart = `${today.slice(0, 8)}01`;

  if (toolName === "get_meta_spend_today") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      spend: stableNumber(`${toolName}|${today}`, 1200, 5500),
      currency: process.env.META_CURRENCY || "INR",
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_meta_spend_month") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      spend: stableNumber(`${toolName}|${monthStart}`, 25000, 180000),
      currency: process.env.META_CURRENCY || "INR",
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_meta_spend_last_7d") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      spend: stableNumber(`${toolName}|${today}`, 6000, 45000),
      currency: process.env.META_CURRENCY || "INR",
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_meta_leads_today") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      leads: stableNumber(`${toolName}|${today}`, 8, 65),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_meta_leads_last_30d") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      leads: stableNumber(`${toolName}|${today}`, 30, 300),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_meta_leads_last_7d") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      leads: stableNumber(`${toolName}|${today}`, 8, 90),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_meta_ads_running_today") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      active_ads: stableNumber(`${toolName}|active|${today}`, 1, 8),
      ads_with_spend_today: stableNumber(`${toolName}|spend|${today}`, 1, 5),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_meta_best_campaign") {
    const periodRaw = String(args?.period || "today").toLowerCase();
    const period =
      periodRaw === "this_month" || periodRaw === "maximum" || periodRaw === "today"
        ? periodRaw
        : "today";
    const names = ["Lead Gen Alpha", "Retarget Pro", "Lookalike Scale", "Creative Test"];
    const top = names.map((name, idx) => {
      const leads = stableNumber(`${toolName}|${today}|${name}`, 2, 25);
      const spend = stableNumber(`${toolName}|spend|${today}|${name}`, 700, 6500);
      const cpc = Number((spend / Math.max(leads * 8, 10)).toFixed(2));
      return {
        campaign_id: `cmp_${idx + 1}`,
        campaign_name: name,
        leads,
        spend,
        cpc,
        cpl: Number((spend / Math.max(leads, 1)).toFixed(2)),
      };
    });
    top.sort((a, b) => (b.leads - a.leads) || (a.cpc - b.cpc) || (b.spend - a.spend));
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      window: period,
      best: top[0] || null,
      top: top.slice(0, 10),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_instagram_reels_today") {
    const rows = Array.from({ length: 5 }).map((_, idx) => ({
      media_id: `reel_${idx + 1}`,
      caption: `Sample Reel ${idx + 1}`,
      permalink: `https://instagram.com/reel/sample_${idx + 1}`,
      published_at: asOf,
      plays: stableNumber(`${toolName}|plays|${today}|${idx + 1}`, 500, 12000),
      reach: stableNumber(`${toolName}|reach|${today}|${idx + 1}`, 400, 9000),
      saved: stableNumber(`${toolName}|saved|${today}|${idx + 1}`, 10, 600),
      likes: stableNumber(`${toolName}|likes|${today}|${idx + 1}`, 20, 1200),
      comments: stableNumber(`${toolName}|comments|${today}|${idx + 1}`, 1, 180),
      shares: stableNumber(`${toolName}|shares|${today}|${idx + 1}`, 1, 220),
    }));
    rows.sort((a, b) => b.plays - a.plays);
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      reels_count: rows.length,
      total_plays: rows.reduce((s, r) => s + r.plays, 0),
      total_reach: rows.reduce((s, r) => s + r.reach, 0),
      total_saved: rows.reduce((s, r) => s + r.saved, 0),
      top: rows,
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_instagram_reels_month") {
    const rows = Array.from({ length: 10 }).map((_, idx) => ({
      media_id: `reel_m_${idx + 1}`,
      caption: `Monthly Reel ${idx + 1}`,
      permalink: `https://instagram.com/reel/month_${idx + 1}`,
      published_at: asOf,
      plays: stableNumber(`${toolName}|plays|${monthStart}|${idx + 1}`, 1000, 25000),
      reach: stableNumber(`${toolName}|reach|${monthStart}|${idx + 1}`, 800, 21000),
      saved: stableNumber(`${toolName}|saved|${monthStart}|${idx + 1}`, 20, 1200),
      likes: stableNumber(`${toolName}|likes|${monthStart}|${idx + 1}`, 60, 2400),
      comments: stableNumber(`${toolName}|comments|${monthStart}|${idx + 1}`, 2, 260),
      shares: stableNumber(`${toolName}|shares|${monthStart}|${idx + 1}`, 2, 300),
    }));
    rows.sort((a, b) => b.plays - a.plays);
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      reels_count: rows.length,
      total_plays: rows.reduce((s, r) => s + r.plays, 0),
      total_reach: rows.reduce((s, r) => s + r.reach, 0),
      total_saved: rows.reduce((s, r) => s + r.saved, 0),
      top: rows,
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_instagram_best_reel") {
    const periodRaw = String(args?.period || "today").toLowerCase();
    const period =
      periodRaw === "this_month" || periodRaw === "maximum" || periodRaw === "today"
        ? periodRaw
        : "today";
    const base = makeLocalMock(
      period === "today" ? "get_instagram_reels_today" : "get_instagram_reels_month",
      args,
      reason
    );
    const rows = Array.isArray(base?.top) ? base.top : [];
    rows.sort((a: any, b: any) => b.plays - a.plays || b.reach - a.reach);
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      window: period,
      best: rows[0] || null,
      top: rows.slice(0, 10),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_instagram_account_overview") {
    return {
      ok: true,
      tool: toolName,
      timezone: "Asia/Kolkata",
      as_of_ist: asOf,
      account: {
        ig_business_account_id: String(process.env.IG_BUSINESS_ACCOUNT_ID || "17840000000000000"),
        username: "sample_instagram",
        name: "Sample Instagram",
        followers_count: stableNumber(`${toolName}|followers|${today}`, 1000, 250000),
        follows_count: stableNumber(`${toolName}|follows|${today}`, 100, 5000),
        media_count: stableNumber(`${toolName}|media|${today}`, 20, 900),
      },
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_active_users_today") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|${today}`, 120, 1800),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_active_users_yesterday") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|${today}`, 110, 1700),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_active_users_last_7_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|${today}`, 500, 7000),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_active_users_last_15_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|${today}`, 900, 12000),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_active_users_last_30_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|${today}`, 1400, 22000),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_sessions_today") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${today}`, 180, 2600),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_sessions_yesterday") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${today}`, 160, 2400),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_sessions_month") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${monthStart}`, 6000, 72000),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_sessions_last_7_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${today}`, 150, 6500),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_sessions_last_15_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${today}`, 2800, 14000),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_sessions_last_30_days") {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      sessions: stableNumber(`${toolName}|${today}`, 5000, 28000),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_top_pages_today") {
    const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 25));
    const rows = Array.from({ length: limit }).map((_, idx) => ({
      pagePath: `/page-${idx + 1}`,
      pageTitle: `Top Page ${idx + 1}`,
      views: stableNumber(`${toolName}|${today}|${idx + 1}`, 20, 900),
    }));
    rows.sort((a, b) => b.views - a.views);
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      rows,
      _mock: { used: true, reason },
    };
  }

  if (toolName.startsWith("get_ga4_page_views_")) {
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      page_views: stableNumber(`${toolName}|${today}`, 400, 45000),
      _mock: { used: true, reason },
    };
  }

  if (toolName.startsWith("get_ga4_top_city_")) {
    const cities = ["Mumbai", "Delhi", "Bengaluru", "Chennai", "Pune", "Hyderabad"];
    const idx = stableNumber(`${toolName}|city|${today}`, 0, cities.length - 1);
    return {
      ok: true,
      tool: toolName,
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      city: cities[idx],
      sessions: stableNumber(`${toolName}|sessions|${today}`, 20, 2000),
      _mock: { used: true, reason },
    };
  }

  if (toolName === "get_ga4_report_snapshot") {
    return {
      ok: true,
      tool: toolName,
      period: String(args?.period || "last_30_days"),
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      active_users: stableNumber(`${toolName}|au|${today}`, 100, 5000),
      new_users: stableNumber(`${toolName}|nu|${today}`, 60, 4200),
      avg_engagement_time_seconds: stableNumber(`${toolName}|et|${today}`, 15, 120),
      event_count: stableNumber(`${toolName}|ec|${today}`, 500, 50000),
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_active_users_by_city") {
    const cities = ["Singapore", "Delhi", "Lanzhou", "Hyderabad", "Bengaluru", "Kolkata", "Mumbai"];
    const rows = cities.map((city, i) => ({
      city,
      active_users: stableNumber(`${toolName}|${today}|${i}`, 3, 30),
    }));
    rows.sort((a, b) => b.active_users - a.active_users);
    return {
      ok: true,
      tool: toolName,
      period: String(args?.period || "last_30_days"),
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      rows,
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_sessions_by_source_medium") {
    const sources = [
      "(direct) / (none)",
      "google / organic",
      "google / cpc",
      "fb / paid",
      "google_jobs_apply / referral",
      "m.facebook.com / referral",
      "bing / organic",
    ];
    const rows = sources.map((source_medium, i) => ({
      source_medium,
      sessions: stableNumber(`${toolName}|${today}|${i}`, 3, 120),
    }));
    rows.sort((a, b) => b.sessions - a.sessions);
    return {
      ok: true,
      tool: toolName,
      period: String(args?.period || "last_30_days"),
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      rows,
      _mock: { used: true, reason },
    };
  }
  if (toolName === "get_ga4_top_pages_screens") {
    const pages = [
      "Buy Polycarbonate Sheets | Coxwell",
      "About Coxwell - Coxwell.in",
      "Blogs & Case Studies - Coxwell.in",
      "Contact Us - Coxwell.in",
      "Polycarbonate Sheet - Coxwell.in",
      "Best Polycarbonate Sheet Colours",
      "Multicell - Coxwell.in",
    ];
    const rows = pages.map((page_title, i) => ({
      page_title,
      views: stableNumber(`${toolName}|v|${today}|${i}`, 10, 200),
      active_users: stableNumber(`${toolName}|u|${today}|${i}`, 4, 120),
      event_count: stableNumber(`${toolName}|e|${today}|${i}`, 20, 700),
      bounce_rate: stableNumber(`${toolName}|b|${today}|${i}`, 0, 70),
    }));
    rows.sort((a, b) => b.views - a.views);
    return {
      ok: true,
      tool: toolName,
      period: String(args?.period || "last_30_days"),
      timezone: process.env.GA4_TIMEZONE || "Asia/Kolkata",
      as_of_ist: asOf,
      rows,
      _mock: { used: true, reason },
    };
  }

  return null;
}

// We keep GA4 toggle inside ga4Api.ts (ENABLE_GA4_API). This function stays generic.
async function callToolWithFallback(toolName: string, args: AnyJson, primary: () => Promise<any>) {
  // Primary path (Meta enabled OR GA4 enabled inside primary)
  try {
    // Special: for Meta tools, respect ENABLE_META_API here
    if (toolName.startsWith("get_meta_") && !isMetaEnabled()) {
      throw new Error("ENABLE_META_API=false");
    }
    return await primary();
  } catch (err: any) {
    const primaryErr = err?.message ? String(err.message) : "Primary tool call failed";

    // Default behavior: never return fake/mock fallback data.
    // Set ALLOW_FAKE_DATA=true only when you explicitly want fallback mocks.
    if (!allowAnyFallback() || shouldUseStrictLiveForTool(toolName)) {
      return {
        ok: false,
        tool: toolName,
        error: "Live API failed",
        primary_error: primaryErr,
      };
    }

    // Fallback: MCP tool call (same name)
    try {
      const mcp = await callMcpTool(toolName, args);
      const mcpText = typeof mcp?.text === "string" ? mcp.text.toLowerCase() : "";
      if (mcpText.includes("not found")) {
        const local = makeLocalMock(
          toolName,
          args,
          `Primary failed: ${primaryErr}; MCP missing tool`
        );
        if (local) return local;
      }
      return {
        ...mcp,
        _fallback: { used: true, reason: primaryErr },
      };
    } catch (mcpErr: any) {
      const mcpMsg = mcpErr?.message ? String(mcpErr.message) : "MCP fallback failed";
      const local = makeLocalMock(
        toolName,
        args,
        `Primary failed: ${primaryErr}; MCP failed: ${mcpMsg}`
      );
      if (local) return local;
      return {
        ok: false,
        tool: toolName,
        error: "Both Primary API and MCP fallback failed",
        primary_error: primaryErr,
        mcp_error: mcpMsg,
      };
    }
  }
}

export const toolDefs: ToolDef[] = [
  // ---------------- META ----------------
  {
    name: "get_meta_spend_today",
    description: "Returns Meta ad account spend for today (Asia/Kolkata).",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_spend_today", args || {}, () => getMetaSpendToday(args?.account_id)),
  },
  {
    name: "get_meta_spend_month",
    description: "Returns Meta ad account spend for this month (Asia/Kolkata).",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_spend_month", args || {}, () => getMetaSpendMonth(args?.account_id)),
  },
  {
    name: "get_meta_spend_last_7d",
    description: "Returns Meta ad account spend for last 7 days.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_spend_last_7d", args || {}, () => getMetaSpendLast7d(args?.account_id)),
  },
  {
    name: "get_meta_leads_today",
    description: "Returns Meta leads for today (Asia/Kolkata).",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_leads_today", args || {}, () => getMetaLeadsToday(args?.account_id)),
  },
  {
    name: "get_meta_leads_last_30d",
    description: "Returns Meta leads for last 30 days.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_leads_last_30d", args || {}, () => getMetaLeadsLast30d(args?.account_id)),
  },
  {
    name: "get_meta_leads_last_7d",
    description: "Returns Meta leads for last 7 days.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_leads_last_7d", args || {}, () => getMetaLeadsLast7d(args?.account_id)),
  },
  {
    name: "get_meta_ads_running_today",
    description: "Returns count of active ads and ads with spend today.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_ads_running_today", args || {}, () =>
        getMetaAdsRunningToday(args?.account_id)
      ),
  },
  {
    name: "get_meta_best_campaign",
    description:
      "Returns best performing Meta campaign by period (today/this_month/maximum) by Leads (tie-breaker: lowest CPC). Also returns leaderboard.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "this_month", "maximum"] },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_meta_best_campaign", args || {}, () =>
        getMetaBestCampaign(args?.account_id, args?.period || "today")
      ),
  },
  {
    name: "get_instagram_account_overview",
    description: "Returns Instagram account overview (followers, following, media count).",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_instagram_account_overview", args || {}, () =>
        getInstagramAccountOverview(args?.account_id)
      ),
  },
  {
    name: "get_instagram_reels_today",
    description: "Returns Instagram Reels performance for today.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_instagram_reels_today", args || {}, () => getInstagramReelsToday(args?.account_id)),
  },
  {
    name: "get_instagram_reels_month",
    description: "Returns Instagram Reels performance for this month.",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_instagram_reels_month", args || {}, () => getInstagramReelsMonth(args?.account_id)),
  },
  {
    name: "get_instagram_best_reel",
    description: "Returns best Instagram Reel by period (today/this_month/maximum).",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "this_month", "maximum"] },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_instagram_best_reel", args || {}, () =>
        getInstagramBestReel(args?.account_id, args?.period || "today")
      ),
  },

  // ---------------- GA4 ----------------
  {
    name: "get_ga4_active_users_today",
    description: "Returns GA4 active users for today.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_today", args || {}, () => getGa4ActiveUsersToday(args?.account_id)),
  },
  {
    name: "get_ga4_active_users_yesterday",
    description: "Returns GA4 active users for yesterday.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_yesterday", args || {}, () =>
        getGa4ActiveUsersYesterday(args?.account_id)
      ),
  },
  {
    name: "get_ga4_active_users_last_7_days",
    description: "Returns GA4 active users for last 7 days (7daysAgo -> today).",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_last_7_days", args || {}, () =>
        getGa4ActiveUsersLast7Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_active_users_last_15_days",
    description: "Returns GA4 active users for last 15 days (15daysAgo -> today).",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_last_15_days", args || {}, () =>
        getGa4ActiveUsersLast15Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_active_users_last_30_days",
    description: "Returns GA4 active users for last 30 days (30daysAgo -> today).",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_last_30_days", args || {}, () =>
        getGa4ActiveUsersLast30Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_sessions_today",
    description: "Returns GA4 sessions for today.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_today", args || {}, () => getGa4SessionsToday(args?.account_id)),
  },
  {
    name: "get_ga4_sessions_yesterday",
    description: "Returns GA4 sessions for yesterday.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_yesterday", args || {}, () =>
        getGa4SessionsYesterday(args?.account_id)
      ),
  },
  {
    name: "get_ga4_sessions_month",
    description: "Returns GA4 sessions from firstDayOfMonth → today.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_month", args || {}, () => getGa4SessionsMonth(args?.account_id)),
  },
  {
    name: "get_ga4_sessions_last_7_days",
    description: "Returns GA4 sessions for last 7 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_last_7_days", args || {}, () =>
        getGa4SessionsLast7Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_sessions_last_15_days",
    description: "Returns GA4 sessions for last 15 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_last_15_days", args || {}, () =>
        getGa4SessionsLast15Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_sessions_last_30_days",
    description: "Returns GA4 sessions for last 30 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_last_30_days", args || {}, () =>
        getGa4SessionsLast30Days(args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_pages_today",
    description: "Returns top pages today by views (default 10).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, account_id: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_pages_today", args, () =>
        getGa4TopPagesToday(args?.limit ?? 10, args?.account_id)
      ),
  },
  {
    name: "get_ga4_page_views_today",
    description: "Returns GA4 total page views for today.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_page_views_today", args || {}, () =>
        getGa4PageViewsByPeriod("today", args?.account_id)
      ),
  },
  {
    name: "get_ga4_page_views_yesterday",
    description: "Returns GA4 total page views for yesterday.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_page_views_yesterday", args || {}, () =>
        getGa4PageViewsByPeriod("yesterday", args?.account_id)
      ),
  },
  {
    name: "get_ga4_page_views_last_7_days",
    description: "Returns GA4 total page views for last 7 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_page_views_last_7_days", args || {}, () =>
        getGa4PageViewsByPeriod("last_7_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_page_views_last_15_days",
    description: "Returns GA4 total page views for last 15 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_page_views_last_15_days", args || {}, () =>
        getGa4PageViewsByPeriod("last_15_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_page_views_last_30_days",
    description: "Returns GA4 total page views for last 30 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_page_views_last_30_days", args || {}, () =>
        getGa4PageViewsByPeriod("last_30_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_city_today",
    description: "Returns top city by sessions for today.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_city_today", args || {}, () =>
        getGa4TopCityByPeriod("today", args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_city_yesterday",
    description: "Returns top city by sessions for yesterday.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_city_yesterday", args || {}, () =>
        getGa4TopCityByPeriod("yesterday", args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_city_last_7_days",
    description: "Returns top city by sessions for last 7 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_city_last_7_days", args || {}, () =>
        getGa4TopCityByPeriod("last_7_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_city_last_15_days",
    description: "Returns top city by sessions for last 15 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_city_last_15_days", args || {}, () =>
        getGa4TopCityByPeriod("last_15_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_city_last_30_days",
    description: "Returns top city by sessions for last 30 days.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } }, additionalProperties: false },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_city_last_30_days", args || {}, () =>
        getGa4TopCityByPeriod("last_30_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_report_snapshot",
    description: "Returns GA4 report snapshot: active users, new users, average engagement time, and event count.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_15_days", "last_30_days"] },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_report_snapshot", args || {}, () =>
        getGa4ReportSnapshot(args?.period || "last_30_days", args?.account_id)
      ),
  },
  {
    name: "get_ga4_active_users_by_city",
    description: "Returns top cities by GA4 active users.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_15_days", "last_30_days"] },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_active_users_by_city", args || {}, () =>
        getGa4ActiveUsersByCity(args?.period || "last_30_days", args?.limit ?? 7, args?.account_id)
      ),
  },
  {
    name: "get_ga4_sessions_by_source_medium",
    description: "Returns top session source/medium rows by GA4 sessions.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_15_days", "last_30_days"] },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_sessions_by_source_medium", args || {}, () =>
        getGa4SessionsBySourceMedium(args?.period || "last_30_days", args?.limit ?? 7, args?.account_id)
      ),
  },
  {
    name: "get_ga4_top_pages_screens",
    description: "Returns top pages/screens with views, active users, event count, and bounce rate.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_15_days", "last_30_days"] },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_pages_screens", args || {}, () =>
        getGa4TopPagesScreens(args?.period || "last_30_days", args?.limit ?? 7, args?.account_id)
      ),
  },
];

export function getOpenAITools() {
  return toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export async function runToolByName(name: string, args: AnyJson, context?: ToolRunContext) {
  const tool = toolDefs.find((t) => t.name === name);
  if (!tool) return { ok: false, tool: name, error: "Unknown tool" };
  if (args && typeof args !== "object") return { ok: false, tool: name, error: "Invalid tool arguments" };
  const finalArgs = { ...(args || {}) } as AnyJson;
  if (
    context?.metaAccountId &&
    !finalArgs.account_id &&
    (name.startsWith("get_meta_") || name.startsWith("get_instagram_") || name.startsWith("get_ga4_"))
  ) {
    finalArgs.account_id = context.metaAccountId;
  }
  return tool.handler(finalArgs);
}
