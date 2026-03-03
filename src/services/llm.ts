import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: any[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export const DEFAULT_SYSTEM_PROMPT = `
You are a helpful, practical marketing + ops assistant for Coxwell/Altis.
Rules:
- Be conversational and clear.
- If tools return data, summarize it in plain English and add insights.
- If user asks "give me 30 ads" but only 2 exist, explain the mismatch and propose next steps.
- Never just dump raw JSON unless user explicitly asks.
- If data is missing, say what’s missing and how to fix it.
`.trim();

export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "meta_ads_list",
      description:
        "Fetch Meta insights rows for an account. Supports optional limit and date filters.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Meta Ad Account ID" },
          limit: { type: "number", description: "How many rows to return" },
          since: { type: "string", description: "YYYY-MM-DD" },
          until: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meta_geo_breakdown",
      description:
        "Fetch Meta geo breakdown for clicks/spend/leads by country, region, or city for a given account and date range.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Meta Ad Account ID" },
          limit: { type: "number", description: "How many geo rows to return" },
          since: { type: "string", description: "YYYY-MM-DD" },
          until: { type: "string", description: "YYYY-MM-DD" },
          breakdown: { type: "string", enum: ["country", "region", "city"] },
        },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meta_verify_token",
      description: "Verify Meta token for a given account_id (or default).",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ga4_verify",
      description: "Verify GA4 setup and connectivity.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "instagram_overview",
      description: "Get Instagram account overview (followers_count etc).",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    },
  },
];
