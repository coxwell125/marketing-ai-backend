// src/services/toolIntegration.ts
import { callMcpTool } from "./mcpClient";
import {
  getMetaLeadsToday,
  getMetaSpendMonth,
  getMetaSpendToday,
  getMetaBestCampaign,
} from "./metaApi";

import {
  getGa4ActiveUsersToday,
  getGa4SessionsToday,
  getGa4SessionsMonth,
  getGa4TopPagesToday,
} from "./ga4Api";

type AnyJson = Record<string, any>;
type ToolHandler = (args: AnyJson) => Promise<any>;

type ToolDef = {
  name: string;
  description: string;
  inputSchema: AnyJson; // JSON Schema
  handler: ToolHandler;
};

function isMetaEnabled(): boolean {
  return String(process.env.ENABLE_META_API || "").toLowerCase() === "true";
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

  if (toolName === "get_meta_best_campaign") {
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
      window: "today",
      best: top[0] || null,
      top: top.slice(0, 10),
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
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_meta_spend_today", {}, () => getMetaSpendToday()),
  },
  {
    name: "get_meta_spend_month",
    description: "Returns Meta ad account spend for this month (Asia/Kolkata).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_meta_spend_month", {}, () => getMetaSpendMonth()),
  },
  {
    name: "get_meta_leads_today",
    description: "Returns Meta leads for today (Asia/Kolkata).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_meta_leads_today", {}, () => getMetaLeadsToday()),
  },
  {
    name: "get_meta_best_campaign",
    description:
      "Returns best performing Meta campaign for today by Leads (tie-breaker: lowest CPC). Also returns top campaigns leaderboard.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_meta_best_campaign", {}, () => getMetaBestCampaign()),
  },

  // ---------------- GA4 ----------------
  {
    name: "get_ga4_active_users_today",
    description: "Returns GA4 active users for today.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      callToolWithFallback("get_ga4_active_users_today", {}, () => getGa4ActiveUsersToday()),
  },
  {
    name: "get_ga4_sessions_today",
    description: "Returns GA4 sessions for today.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_ga4_sessions_today", {}, () => getGa4SessionsToday()),
  },
  {
    name: "get_ga4_sessions_month",
    description: "Returns GA4 sessions from firstDayOfMonth → today.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callToolWithFallback("get_ga4_sessions_month", {}, () => getGa4SessionsMonth()),
  },
  {
    name: "get_ga4_top_pages_today",
    description: "Returns top pages today by views (default 10).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      callToolWithFallback("get_ga4_top_pages_today", args, () => getGa4TopPagesToday(args?.limit ?? 10)),
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

export async function runToolByName(name: string, args: AnyJson) {
  const tool = toolDefs.find((t) => t.name === name);
  if (!tool) return { ok: false, tool: name, error: "Unknown tool" };
  if (args && typeof args !== "object") return { ok: false, tool: name, error: "Invalid tool arguments" };
  return tool.handler(args || {});
}
