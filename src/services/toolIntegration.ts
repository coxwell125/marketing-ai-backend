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
      return {
        ...mcp,
        _fallback: { used: true, reason: primaryErr },
      };
    } catch (mcpErr: any) {
      const mcpMsg = mcpErr?.message ? String(mcpErr.message) : "MCP fallback failed";
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
