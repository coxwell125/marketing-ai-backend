// src/routes/chat.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { getOpenAITools, runToolByName } from "../services/toolIntegration";
import { getAllowedMetaAccountIds } from "../services/metaTenant";
import { getFollowerHistory } from "../services/followerHistory";

const router = Router();

const ChatBodySchema = z.object({
  message: z.string().min(1, "message is required"),
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let preferredProvider: "openai" | "gemini" | "claude" | null = null;

type PromptDoc = { text: string; tokens: string[] };
type PromptIndex = { docs: PromptDoc[]; tokenToDocIds: Map<string, number[]> };
type RelatedResult = { matchedPrompts: string[]; tools: string[] };
type ResponsePayload = { ok: true; answer: string; tools?: Array<{ name: string; result: any }>; meta?: any };

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "to",
  "for",
  "of",
  "in",
  "on",
  "my",
  "me",
  "you",
  "your",
  "this",
  "that",
  "it",
  "and",
  "or",
  "with",
  "please",
  "can",
  "could",
  "would",
  "should",
  "how",
  "what",
  "show",
  "give",
]);

const PROMPT_RETRIEVAL_TTL_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_TTL_MS = 25 * 1000;
const MAX_PROMPT_RETRIEVAL_CACHE = 5000;
const MAX_RESPONSE_CACHE = 1000;
const promptRetrievalCache = new Map<string, { ts: number; value: RelatedResult }>();
const responseCache = new Map<string, { ts: number; value: ResponsePayload }>();

function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function getOpenAIMaxTokens(): number {
  const raw = Number(process.env.OPENAI_MAX_TOKENS || 220);
  if (!Number.isFinite(raw)) return 220;
  return Math.max(80, Math.min(800, Math.floor(raw)));
}

function getOpenAITemperature(): number {
  const raw = Number(process.env.OPENAI_TEMPERATURE || 0.2);
  if (!Number.isFinite(raw)) return 0.2;
  return Math.max(0, Math.min(1, raw));
}

function getOpenAIMinToolCalls(): number {
  const raw = Number(process.env.OPENAI_MIN_TOOL_CALLS || 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(6, Math.floor(raw)));
}

function isForceOpenAIForAll(): boolean {
  return String(process.env.FORCE_OPENAI_FOR_ALL || "false").toLowerCase() === "true";
}

function isStrictBrandScopeOnly(): boolean {
  return String(process.env.STRICT_BRAND_SCOPE_ONLY || "false").toLowerCase() === "true";
}

function getGeminiModel(): string {
  const raw = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  return raw.replace(/^models\//, "");
}

function getClaudeModel(): string {
  return process.env.CLAUDE_MODEL || "claude-3-5-haiku-latest";
}

async function askGeminiOnce(message: string, model: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You are a helpful, concise assistant. Give direct, practical answers with clear steps when useful.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: message }],
          },
        ],
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error(json?.error?.message || `Gemini request failed (${res.status})`);
      (err as any).status = res.status;
      throw err;
    }

    const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
    const parts = candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const combined = parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim();
      if (combined) return combined;
    }

    throw new Error("Gemini returned empty response");
  } finally {
    clearTimeout(t);
  }
}

async function askGemini(message: string): Promise<string> {
  const primary = getGeminiModel();
  try {
    return await askGeminiOnce(message, primary);
  } catch (err: any) {
    const status = Number(err?.status || 0);
    if (status === 404 && primary !== "gemini-2.0-flash") {
      return askGeminiOnce(message, "gemini-2.0-flash");
    }
    throw err;
  }
}

async function askClaude(message: string): Promise<string> {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("CLAUDE_API_KEY not set");

  const model = getClaudeModel();
  const url = "https://api.anthropic.com/v1/messages";

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: "You are a helpful, concise assistant. Give direct, practical answers.",
        messages: [{ role: "user", content: message }],
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error(json?.error?.message || `Claude request failed (${res.status})`);
      (err as any).status = res.status;
      throw err;
    }

    const content = Array.isArray(json?.content) ? json.content : [];
    const combined = content
      .map((c: any) => (c?.type === "text" && typeof c?.text === "string" ? c.text : ""))
      .join("")
      .trim();

    if (!combined) throw new Error("Claude returned empty response");
    return combined;
  } finally {
    clearTimeout(t);
  }
}

async function askOpenAIDirect(message: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const resp = await openai.chat.completions.create({
    model: getModel(),
    temperature: getOpenAITemperature(),
    max_tokens: getOpenAIMaxTokens(),
    messages: [
      {
        role: "system",
        content:
          "You are a helpful, concise assistant. Give clear, practical answers. If unsure, state assumptions briefly.",
      },
      { role: "user", content: message },
    ],
  });
  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("OpenAI returned empty response");
  return text;
}

function safeParseJsonObject(input: string): Record<string, any> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function answerFromOpenAIWithTools(
  message: string,
  runTool: (name: string, args?: Record<string, any>) => Promise<any>,
  brandAccounts?: { coxwell?: string; altis?: string },
  minToolCalls = 1
): Promise<{ answer: string; tools: Array<{ name: string; result: any }>; mode: string } | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const systemParts = [
    "You are a marketing analytics assistant.",
    "For marketing/Meta/GA4/Instagram questions, call relevant tools first, then answer using tool results only.",
    "If user asks for both Altis and Coxwell, fetch both brands and present a clear table.",
    "Keep response concise, numeric, and directly actionable.",
  ];
  if (brandAccounts?.coxwell || brandAccounts?.altis) {
    systemParts.push(
      `Brand account mapping: Coxwell=${brandAccounts?.coxwell || "-"}, Altis=${brandAccounts?.altis || "-"}`
    );
  }

  const tools = getOpenAITools();
  const messages: any[] = [
    { role: "system", content: systemParts.join(" ") },
    { role: "user", content: message },
  ];
  const toolResults: Array<{ name: string; result: any }> = [];

  for (let round = 0; round < 4; round++) {
    const resp = await openai.chat.completions.create({
      model: getModel(),
      temperature: getOpenAITemperature(),
      max_tokens: getOpenAIMaxTokens(),
      messages,
      tools,
      tool_choice: "auto",
    });

    const assistant = resp.choices?.[0]?.message;
    if (!assistant) break;

    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!calls.length) {
      const answer = String(assistant.content || "").trim();
      if (!answer) return null;
      if (toolResults.length < minToolCalls) return null;
      return { answer, tools: toolResults, mode: "openai-tool-calling" };
    }

    messages.push(assistant);

    for (const tc of calls) {
      if (tc.type !== "function") continue;
      const name = String(tc.function?.name || "");
      const args = safeParseJsonObject(String(tc.function?.arguments || "{}"));
      const result = await runTool(name, args);
      toolResults.push({ name, result });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return null;
}

function getAvailableProviders(): Array<"openai" | "gemini" | "claude"> {
  const providers: Array<"openai" | "gemini" | "claude"> = [];
  if (process.env.OPENAI_API_KEY) providers.push("openai");
  if (process.env.GEMINI_API_KEY) providers.push("gemini");
  if (process.env.CLAUDE_API_KEY) providers.push("claude");
  return providers;
}

async function tryProvider(provider: "openai" | "gemini" | "claude", message: string): Promise<string> {
  if (provider === "openai") return askOpenAIDirect(message);
  if (provider === "gemini") return askGemini(message);
  return askClaude(message);
}

async function answerFromAnyProvider(message: string): Promise<{ answer: string; mode: string } | null> {
  const providers = getAvailableProviders();
  if (!providers.length) return null;

  const ordered = preferredProvider && providers.includes(preferredProvider)
    ? [preferredProvider, ...providers.filter((p) => p !== preferredProvider)]
    : providers;

  for (const p of ordered) {
    try {
      const answer = await tryProvider(p, message);
      preferredProvider = p;
      return { answer, mode: `${p}-priority` };
    } catch (err: any) {
      console.error(`${p} provider failed:`, err?.message || err);
    }
  }

  return null;
}

function formatCurrency(value: number, currency = "INR") {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

function formatDelta(value: number, asCurrency = false): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return asCurrency ? `${sign}${formatCurrency(value, "INR")}` : `${sign}${formatNumber(value)}`;
}

function isComparisonIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /\b(compare|comparison|vs|versus|difference|diff|trend|against)\b/.test(m);
}

function getMonthProgress(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth);
  return { dayOfMonth, daysInMonth, remainingDays };
}

function comparisonToolsForMessage(message: string): string[] {
  const m = normalizeMessage(message);
  const tools = new Set<string>();

  const mentionsMeta = /\b(meta|facebook|ad|ads|campaign|cpl|spend|lead)\b/.test(m);
  const mentionsGa4 = /\bga4|active users?|sessions?|traffic|website\b/.test(m);

  if (mentionsMeta || !mentionsGa4) {
    tools.add("get_meta_spend_today");
    tools.add("get_meta_spend_month");
    if (/\bleads?\b|campaign|cpl/.test(m)) tools.add("get_meta_leads_today");
    if (/campaign|cpl|best|worst|poor|performance/.test(m)) tools.add("get_meta_best_campaign");
  }

  if (mentionsGa4 || /\busers?|sessions?|yesterday|traffic\b/.test(m)) {
    if (/yesterday|users?|active/.test(m)) {
      tools.add("get_ga4_active_users_today");
      tools.add("get_ga4_active_users_yesterday");
    }
    if (/last 7 days|7 days|last week|weekly|week/.test(m) && /users?|active/.test(m)) {
      tools.add("get_ga4_active_users_last_7_days");
    }
    if (/sessions?|month|monthly|traffic/.test(m)) {
      tools.add("get_ga4_sessions_today");
      tools.add("get_ga4_sessions_month");
    }
  }

  if (!tools.size) {
    tools.add("get_meta_spend_today");
    tools.add("get_meta_spend_month");
    tools.add("get_meta_leads_today");
  }

  return Array.from(tools).slice(0, 6);
}

function buildComparisonTableAnswer(message: string, toolResults: Array<{ name: string; result: any }>): string {
  const byTool = new Map<string, any>();
  for (const tr of toolResults) byTool.set(tr.name, tr.result);

  const rows: string[] = [];
  rows.push("| Metric | Current | Baseline | Delta | Insight |");
  rows.push("|---|---:|---:|---:|---|");

  const spendToday = Number(byTool.get("get_meta_spend_today")?.spend ?? NaN);
  const spendMonth = Number(byTool.get("get_meta_spend_month")?.spend ?? NaN);
  if (Number.isFinite(spendToday) && Number.isFinite(spendMonth)) {
    const { dayOfMonth, daysInMonth, remainingDays } = getMonthProgress();
    const avgDailyMonth = spendMonth / Math.max(1, dayOfMonth);
    const delta = spendToday - avgDailyMonth;
    const projectedEom = spendMonth + spendToday * remainingDays;
    const paceInsight = delta >= 0 ? "Above month pace (overspend risk)" : "Below month pace (underspend pace)";
    rows.push(
      `| Meta spend (today vs month avg/day) | ${formatCurrency(spendToday, "INR")} | ${formatCurrency(avgDailyMonth, "INR")} | ${formatDelta(delta, true)} | ${paceInsight} |`
    );
    rows.push(
      `| Meta month projection (if today's pace continues) | ${formatCurrency(projectedEom, "INR")} | ${formatCurrency(
        spendMonth,
        "INR"
      )} (spent till now) | ${formatDelta(projectedEom - spendMonth, true)} | Day ${dayOfMonth}/${daysInMonth} |`
    );
  }

  const leadsToday = Number(byTool.get("get_meta_leads_today")?.leads ?? NaN);
  if (Number.isFinite(leadsToday) && Number.isFinite(spendToday) && leadsToday > 0) {
    const cplToday = spendToday / leadsToday;
    rows.push(
      `| Meta CPL (today) | ${formatCurrency(cplToday, "INR")} | ${formatCurrency(spendToday, "INR")} / ${formatNumber(
        leadsToday
      )} leads | - | Efficiency snapshot |`
    );
  }

  const best = byTool.get("get_meta_best_campaign")?.best;
  if (best) {
    const name = String(best.campaign_name || "Unknown");
    const cpl = Number(best.cpl ?? NaN);
    const leads = Number(best.leads ?? NaN);
    const spend = Number(best.spend ?? NaN);
    rows.push(
      `| Best campaign today | ${name} | CPL ${formatCurrency(cpl, "INR")} | Leads ${formatNumber(
        leads
      )} | Spend ${formatCurrency(spend, "INR")} |`
    );
  }

  const ga4Today = Number(byTool.get("get_ga4_active_users_today")?.active_users ?? NaN);
  const ga4Yesterday = Number(byTool.get("get_ga4_active_users_yesterday")?.active_users ?? NaN);
  const ga4Last7Users = Number(byTool.get("get_ga4_active_users_last_7_days")?.active_users ?? NaN);
  if (Number.isFinite(ga4Today) && Number.isFinite(ga4Yesterday)) {
    const delta = ga4Today - ga4Yesterday;
    const insight = delta >= 0 ? "Traffic up vs yesterday" : "Traffic down vs yesterday";
    rows.push(
      `| GA4 active users (today vs yesterday) | ${formatNumber(ga4Today)} | ${formatNumber(
        ga4Yesterday
      )} | ${formatDelta(delta, false)} | ${insight} |`
    );
  }
  if (Number.isFinite(ga4Last7Users)) {
    rows.push(
      `| GA4 active users (last 7 days) | ${formatNumber(ga4Last7Users)} | - | - | Weekly audience volume |`
    );
  }

  const sessionsToday = Number(byTool.get("get_ga4_sessions_today")?.sessions ?? NaN);
  const sessionsMonth = Number(byTool.get("get_ga4_sessions_month")?.sessions ?? NaN);
  if (Number.isFinite(sessionsToday) && Number.isFinite(sessionsMonth)) {
    const { dayOfMonth } = getMonthProgress();
    const avgDaily = sessionsMonth / Math.max(1, dayOfMonth);
    const delta = sessionsToday - avgDaily;
    rows.push(
      `| GA4 sessions (today vs month avg/day) | ${formatNumber(sessionsToday)} | ${formatNumber(avgDaily)} | ${formatDelta(
        delta
      )} | ${delta >= 0 ? "Above average day" : "Below average day"} |`
    );
  }

  const asOf =
    byTool.get("get_meta_spend_today")?.as_of_ist ||
    byTool.get("get_meta_spend_month")?.as_of_ist ||
    byTool.get("get_meta_leads_today")?.as_of_ist ||
    byTool.get("get_ga4_active_users_today")?.as_of_ist ||
    byTool.get("get_ga4_sessions_today")?.as_of_ist ||
    new Date().toISOString();

  return [
    `Comparison for: "${message.trim()}"`,
    "",
    rows.join("\n"),
    "",
    `As of: ${asOf}`,
  ].join("\n");
}

function formatToolAnswer(tool: string, result: any): string {
  if (!result || typeof result !== "object") return "I got a response, but could not parse it.";

  if (tool === "get_meta_leads_today") {
    const leads = Number(result.leads ?? 0);
    return `You have ${leads} Meta leads today.`;
  }
  if (tool === "get_meta_leads_last_30d") {
    const leads = Number(result.leads ?? 0);
    return `You have ${leads} Meta leads in the last 30 days.`;
  }
  if (tool === "get_meta_ads_running_today") {
    const activeAds = Number(result.active_ads ?? 0);
    const adsWithSpendToday = Number(result.ads_with_spend_today ?? 0);
    return `You have ${activeAds} active ads, and ${adsWithSpendToday} ads delivered spend today.`;
  }

  if (tool === "get_meta_spend_today") {
    const spend = Number(result.spend ?? 0);
    const currency = String(result.currency || "INR");
    return `Your Meta spend today is ${formatCurrency(spend, currency)}.`;
  }

  if (tool === "get_meta_spend_month") {
    const spend = Number(result.spend ?? 0);
    const currency = String(result.currency || "INR");
    return `Your Meta spend this month is ${formatCurrency(spend, currency)}.`;
  }

  if (tool === "get_meta_best_campaign") {
    const best = result.best;
    const window = String(result?.window || "today");
    const windowLabel =
      window === "maximum" ? "all time" : window === "this_month" ? "this month" : "today";
    if (!best) return `No campaign performance data is available for ${windowLabel}.`;
    const name = String(best.campaign_name || "Unknown campaign");
    const leads = Number(best.leads ?? 0);
    const spend = Number(best.spend ?? 0);
    const cpl = Number(best.cpl ?? 0);
    return `Your best campaign for ${windowLabel} is ${name}. It generated ${leads} leads with ${formatCurrency(
      spend,
      "INR"
    )} spend at ${formatCurrency(cpl, "INR")} CPL.`;
  }

  if (tool === "get_ga4_active_users_today") {
    const users = Number(result.active_users ?? 0);
    return `You have ${users} GA4 active users today.`;
  }

  if (tool === "get_ga4_active_users_yesterday") {
    const users = Number(result.active_users ?? 0);
    return `You had ${users} GA4 active users yesterday.`;
  }
  if (tool === "get_ga4_active_users_last_7_days") {
    const users = Number(result.active_users ?? 0);
    return `You had ${users} GA4 active users in the last 7 days.`;
  }

  if (tool === "get_ga4_sessions_today") {
    const sessions = Number(result.sessions ?? 0);
    return `You have ${sessions} GA4 sessions today.`;
  }

  if (tool === "get_ga4_sessions_month") {
    const sessions = Number(result.sessions ?? 0);
    return `You have ${sessions} GA4 sessions this month.`;
  }

  if (tool === "get_ga4_top_pages_today") {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!rows.length) return "No top page data is available for today.";
    const top = rows.slice(0, 3).map((r: any, i: number) => {
      const title = String(r.pageTitle || r.pagePath || `Page ${i + 1}`);
      const views = Number(r.views ?? 0);
      return `${i + 1}. ${title} (${views} views)`;
    });
    return `Top pages today:\n${top.join("\n")}`;
  }

  if (tool === "get_instagram_reels_today" || tool === "get_instagram_reels_month") {
    const window = tool === "get_instagram_reels_month" ? "this month" : "today";
    const count = Number(result?.reels_count ?? 0);
    const plays = Number(result?.total_plays ?? 0);
    const reach = Number(result?.total_reach ?? 0);
    const saved = Number(result?.total_saved ?? 0);
    return `Instagram Reels ${window}: ${count} reels, ${formatNumber(plays)} plays, ${formatNumber(
      reach
    )} reach, ${formatNumber(saved)} saves.`;
  }

  if (tool === "get_instagram_best_reel") {
    const best = result?.best;
    const window = String(result?.window || "today");
    const windowLabel =
      window === "maximum" ? "all time" : window === "this_month" ? "this month" : "today";
    if (!best) return `No Instagram Reel data available for ${windowLabel}.`;
    return `Best Instagram Reel for ${windowLabel}: "${String(best.caption || "Untitled Reel").slice(
      0,
      80
    )}" with ${formatNumber(Number(best.plays ?? 0))} plays, ${formatNumber(Number(best.reach ?? 0))} reach, and ${formatNumber(
      Number(best.saved ?? 0)
    )} saves.`;
  }

  if (tool === "get_instagram_account_overview") {
    const account = result?.account || {};
    return `Instagram account ${String(account.username || "").trim() || "(unknown)"} has ${formatNumber(
      Number(account.followers_count ?? 0)
    )} followers, follows ${formatNumber(Number(account.follows_count ?? 0))} accounts, and has ${formatNumber(
      Number(account.media_count ?? 0)
    )} media posts.`;
  }

  if (result.ok === false && result.error) {
    const detail = result.primary_error ? ` (${String(result.primary_error)})` : "";
    return `I couldn't complete that request: ${String(result.error)}${detail}`;
  }

  return "I completed the request successfully.";
}

function isPoorPerformanceIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const negative = /(poor|worst|bad|weak|underperform|low)/.test(m);
  const perf = /(perform|performance|campaign|ad|ads)/.test(m);
  return negative && perf;
}

function isLeadQualityActionsIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /top\s*3.*(action|actions).*(lead quality)|improve.*lead quality/.test(m);
}

function isReduceCplIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /(reduce|lower|improve).*(cpl)|(cpl).*(reduce|lower|improve)/.test(m);
}

function isBudgetWasteIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /(where|which).*(budget).*(wast|leak)|(budget).*(wast|leak).*(today)/.test(m);
}

function buildLeadQualityActionsAnswer(toolResults: Array<{ name: string; result: any }>): string {
  const byTool = new Map<string, any>();
  for (const tr of toolResults) byTool.set(tr.name, tr.result);

  const leads = Number(byTool.get("get_meta_leads_today")?.leads ?? 0);
  const spend = Number(byTool.get("get_meta_spend_today")?.spend ?? 0);
  const cpl = leads > 0 ? spend / leads : 0;
  const best = byTool.get("get_meta_best_campaign")?.best;
  const bestName = String(best?.campaign_name || "best-performing campaign");
  const bestCpl = Number(best?.cpl ?? 0);

  return [
    "Top 3 actions to improve lead quality today:",
    `1. Shift 15-25% budget toward ${bestName}${bestCpl > 0 ? ` (CPL ${formatCurrency(bestCpl, "INR")})` : ""} and reduce weak ad sets.`,
    "2. Tighten lead form quality filters: add one qualifying question (budget/timeline) and remove low-intent options.",
    "3. Align ad promise with landing page proof: same hook, stronger trust signals (case studies, testimonials, guarantee).",
    "",
    `Current snapshot: ${leads} leads, ${formatCurrency(spend, "INR")} spend${leads > 0 ? `, CPL ${formatCurrency(cpl, "INR")}` : ""}.`,
  ].join("\n");
}

function buildReduceCplAnswer(toolResults: Array<{ name: string; result: any }>): string {
  const byTool = new Map<string, any>();
  for (const tr of toolResults) byTool.set(tr.name, tr.result);

  const leads = Number(byTool.get("get_meta_leads_today")?.leads ?? 0);
  const spend = Number(byTool.get("get_meta_spend_today")?.spend ?? 0);
  const cpl = leads > 0 ? spend / leads : NaN;
  const best = byTool.get("get_meta_best_campaign")?.best;
  const top = Array.isArray(byTool.get("get_meta_best_campaign")?.top)
    ? byTool.get("get_meta_best_campaign").top
    : [];
  const worst = top.length ? top[top.length - 1] : null;

  const bestName = String(best?.campaign_name || "Best campaign");
  const bestCpl = Number(best?.cpl ?? NaN);
  const worstName = String(worst?.campaign_name || "Weak campaign");
  const worstCpl = Number(worst?.cpl ?? NaN);

  const actions: string[] = [];
  actions.push(`1. Reallocate 20-30% budget from ${worstName} to ${bestName}.`);
  actions.push("2. Pause ad sets with high spend and zero/low leads for 24h, then restart only winners.");
  actions.push("3. Launch 2 fresh creatives and 1 tighter audience segment to reduce fatigue-driven CPL.");

  return [
    `Current CPL today: ${Number.isFinite(cpl) ? formatCurrency(cpl, "INR") : "N/A (no leads yet)"}`,
    `${bestName} CPL: ${Number.isFinite(bestCpl) ? formatCurrency(bestCpl, "INR") : "N/A"}`,
    `${worstName} CPL: ${Number.isFinite(worstCpl) ? formatCurrency(worstCpl, "INR") : "N/A"}`,
    "",
    "Best actions to reduce CPL from today's data:",
    ...actions,
  ].join("\n");
}

function buildBudgetWasteAnswer(toolResults: Array<{ name: string; result: any }>): string {
  const byTool = new Map<string, any>();
  for (const tr of toolResults) byTool.set(tr.name, tr.result);

  const totalSpend = Number(byTool.get("get_meta_spend_today")?.spend ?? 0);
  const rows = Array.isArray(byTool.get("get_meta_best_campaign")?.top)
    ? [...byTool.get("get_meta_best_campaign").top]
    : [];

  if (!rows.length || totalSpend <= 0) {
    return [
      "I couldn't find enough campaign rows to locate budget waste today.",
      `Current total spend: ${formatCurrency(totalSpend, "INR")}.`,
    ].join("\n");
  }

  // Sort by likely waste: high spend + low leads, then high CPL.
  rows.sort((a: any, b: any) => {
    const wasteA = Number(a?.spend ?? 0) / Math.max(1, Number(a?.leads ?? 0));
    const wasteB = Number(b?.spend ?? 0) / Math.max(1, Number(b?.leads ?? 0));
    if (wasteB !== wasteA) return wasteB - wasteA;
    return Number(b?.spend ?? 0) - Number(a?.spend ?? 0);
  });

  const worst = rows[0];
  const best = rows[rows.length - 1];
  const worstName = String(worst?.campaign_name || "Unknown campaign");
  const worstSpend = Number(worst?.spend ?? 0);
  const worstLeads = Number(worst?.leads ?? 0);
  const worstCpl = Number(worst?.cpl ?? NaN);
  const wasteShare = totalSpend > 0 ? (worstSpend / totalSpend) * 100 : 0;

  const bestName = String(best?.campaign_name || "Best campaign");

  return [
    "Budget waste check (today):",
    `- Likely waste is in: ${worstName}`,
    `- Spend: ${formatCurrency(worstSpend, "INR")} (${formatNumber(wasteShare)}% of today's spend)`,
    `- Leads: ${formatNumber(worstLeads)}`,
    `- CPL: ${Number.isFinite(worstCpl) ? formatCurrency(worstCpl, "INR") : "N/A"}`,
    "",
    "Action now:",
    `1. Move 20-30% budget from ${worstName} to ${bestName}.`,
    "2. Pause low-intent placements/audiences in the weak campaign for 24h.",
    "3. Replace weak creatives with one new hook + one social-proof variant.",
  ].join("\n");
}

function formatWorstCampaignAnswer(result: any): string {
  const rows = Array.isArray(result?.top) ? result.top : [];
  if (!rows.length) return "I couldn't find campaign rows to identify poor performance today.";

  const sorted = [...rows].sort((a: any, b: any) => {
    const aLeads = Number(a?.leads ?? 0);
    const bLeads = Number(b?.leads ?? 0);
    if (aLeads !== bLeads) return aLeads - bLeads;

    const aCpl = Number(a?.cpl ?? 0);
    const bCpl = Number(b?.cpl ?? 0);
    if (aCpl !== bCpl) return bCpl - aCpl;

    const aSpend = Number(a?.spend ?? 0);
    const bSpend = Number(b?.spend ?? 0);
    return bSpend - aSpend;
  });

  const worst = sorted[0];
  const name = String(worst?.campaign_name || "Unknown campaign");
  const leads = Number(worst?.leads ?? 0);
  const spend = Number(worst?.spend ?? 0);
  const cpl = Number(worst?.cpl ?? 0);

  let reason = "low lead volume";
  if (leads <= 1 && spend > 0) reason = "very low leads despite spend";
  else if (cpl > 0 && cpl > 500) reason = "high CPL";
  else if (spend > 3000 && leads < 5) reason = "high spend with weak conversion";

  return `Your poorest performer today looks like ${name}. It has ${leads} leads, ${formatCurrency(
    spend,
    "INR"
  )} spend, and ${formatCurrency(cpl, "INR")} CPL. Main reason: ${reason}.`;
}

function parseRequestedDays(message: string): number | null {
  const m = message.toLowerCase();
  // Supports: "5 day", "5 days", "5-day", "5days"
  const dayPattern = /(\d+)\s*(?:-\s*)?day(s)?/;
  const match = m.match(dayPattern);
  if (!match) return null;
  const days = Number(match[1]);
  if (!Number.isFinite(days) || days <= 0 || days > 31) return null;
  return days;
}

function parseRequestedHours(message: string): number | null {
  const m = message.toLowerCase();
  const hourPattern = /(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs)/;
  const match = m.match(hourPattern);
  if (!match) return null;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 48) return null;
  return hours;
}

function parseBudgetInr(message: string): number | null {
  const m = normalizeMessage(message);
  const budgetPattern = /(?:rs|inr|₹)?\s*([0-9][0-9,]{3,})\s*(?:per\s*month|monthly|month|\/month)?/i;
  const match = m.match(budgetPattern);
  if (!match) return null;
  const value = Number(String(match[1] || "").replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function isQualifiedLeadCampaignIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasCampaignSignal = /\b(?:campaign|plan|strategy|conversion|conversions|leads?)\b/.test(m);
  const hasQualitySignal = /\b(?:quality|qualified|higher quality|better quality)\b/.test(m);
  const hasStructureSignal =
    /\b(?:how many campaign|budget|allocated|allocation|persona|targeting|ad sets?|campaign structure)\b/.test(m);
  return hasCampaignSignal && (hasQualitySignal || hasStructureSignal) && !isWeeklyOptimizationReviewIntent(m);
}

function isWeeklyOptimizationReviewIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasBrand = /\b(?:altis|coxwell)\b/.test(m);
  const hasTimeSignal = /\b(?:weekly|week|last 7 days|7 days)\b/.test(m);
  const hasReviewSignal = /\b(?:review|audit|performance|optimi[sz]ation|optimize|actions?)\b/.test(m);
  return hasBrand && hasTimeSignal && hasReviewSignal;
}

function hasSpendIntent(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(spend|spen|spent)\b/.test(m);
}

function hasMetaAdsIntent(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(meta|facebook|ad|ads|add)\b/.test(m);
}

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"']/g, " ")
    .replace(/\badd\b/g, "ad")
    .replace(/\badds\b/g, "ads")
    .replace(/\bspen\b/g, "spend")
    .replace(/\bspnd\b/g, "spend")
    .replace(/\bandn\b/g, "and")
    .replace(/\bwhic\b/g, "which")
    .replace(/\bperfrom\b/g, "perform")
    .replace(/\bperfom\b/g, "perform")
    .replace(/\bperformnce\b/g, "performance")
    .replace(/\brell\b/g, "reel")
    .replace(/\btabular\b/g, "table")
    .replace(/\bmontly\b/g, "monthly")
    .replace(/\bmonhth?\b/g, "month")
    .replace(/\bmnth\b/g, "month")
    .replace(/\btdy\b/g, "today")
    .replace(/\bystr?day\b/g, "yesterday")
    .replace(/\byday\b/g, "yesterday")
    .replace(/\byest\b/g, "yesterday")
    .replace(/\bga ?4\b/g, "ga4")
    .replace(/\baltish\b/g, "altis")
    .replace(/\balthis\b/g, "altis")
    .replace(/\baltiz\b/g, "altis")
    .replace(/\bcoxwel\b/g, "coxwell")
    .replace(/\bcoxweel\b/g, "coxwell")
    .replace(/\bcoxvell\b/g, "coxwell")
    .replace(/\bcoxwelll\b/g, "coxwell")
    .replace(/\binstgram\b/g, "instagram")
    .replace(/\binstagarm\b/g, "instagram")
    .replace(/\binstagrm\b/g, "instagram")
    .replace(/\binstaagrm\b/g, "instagram")
    .replace(/\binsta gram\b/g, "instagram")
    .replace(/\s+/g, " ")
    .trim();
}

function detectBrandFromMessage(message: string): "coxwell" | "altis" | null {
  const m = normalizeMessage(message);
  if (/\b(?:altis|altish|althis|altiz)\b/.test(m)) return "altis";
  if (/\b(?:coxwell|coxwel|coxweel|coxvell)\b/.test(m)) return "coxwell";
  return null;
}

function isDualBrandMetaIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasBothBrands = /\baltis\b/.test(m) && /\bcoxwell\b/.test(m);
  const hasMeta = /\b(?:meta|facebook|ads?|campaign|spend|leads?)\b/.test(m);
  return hasBothBrands && hasMeta;
}

function isDualBrandInstagramIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasBothBrands = /\baltis\b/.test(m) && /\bcoxwell\b/.test(m);
  const hasInstagramSignal =
    /\b(?:instagram|insta|reels?|posts?|top|best|reach|views?|plays?|saves?)\b/.test(m);
  return hasBothBrands && hasInstagramSignal;
}

function isInstagramInsightsIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasInstagramSignal = /\b(?:instagram|insta|reels?|posts?)\b/.test(m);
  const hasInsightsSignal =
    /\b(?:insights?|perform|performance|best|top|reach|views?|plays?|saves?|good|currently|current)\b/.test(
      m
    );
  return hasInstagramSignal && hasInsightsSignal;
}

function isInstagramAuditListIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasInstagramSignal = /\b(?:instagram|insta|reels?|posts?)\b/.test(m);
  const hasListSignal = /\b(?:all|list|every|full|audit|review|analysis)\b/.test(m);
  const hasImproveSignal = /\b(?:not good|worst|weak|improve|better|before posting)\b/.test(m);
  return hasInstagramSignal && (hasListSignal || hasImproveSignal);
}

function isInstagramDrilldownIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasReelSignal = /\b(?:instagram|insta|reels?)\b/.test(m);
  const hasBothBrands = /\baltis\b/.test(m) && /\bcoxwell\b/.test(m);
  if (hasBothBrands) return false;
  if (isComparisonIntent(m)) return false;
  const hasExplicitDrillSignal =
    /\b(?:after|followers?|gain|drop|lost|loss|growth|awning)\b/.test(m) ||
    /\bother\s+reels?\b/.test(m);
  return hasReelSignal && hasExplicitDrillSignal;
}

function isInstagramAwningComparisonIntent(message: string): boolean {
  const m = normalizeMessage(message);
  const hasInstagramSignal = /\b(?:instagram|insta|reels?)\b/.test(m);
  const hasAwningSignal = /\b(?:awning|non awning|non-awning)\b/.test(m);
  const hasCompareSignal = /\b(?:compare|comparison|vs|versus|whether|drives?)\b/.test(m);
  return hasInstagramSignal && hasAwningSignal && hasCompareSignal;
}

function resolveBrandAwareAccountId(message: string, requestedAccountId?: string): string | undefined {
  const requested = String(requestedAccountId || "").trim();
  const allowed = getAllowedMetaAccountIds();
  const fallback = requested || allowed[0] || "";
  const brand = detectBrandFromMessage(message);

  if (!brand) return fallback || undefined;
  if (brand === "coxwell") return allowed[0] || fallback || undefined;
  return allowed[1] || fallback || allowed[0] || undefined;
}

function fallbackConversationalAnswer(rawMessage: string): string {
  const q = rawMessage.trim();
  return `I understood your question: "${q}". I can answer Meta/GA4 data queries directly right now (today, yesterday, month, campaign performance). If you want a wider ChatGPT-style general assistant for any topic, we need a working OpenAI key (your current key is hitting quota).`;
}

function fallbackUniversalAnswer(rawMessage: string): string {
  const q = rawMessage.trim();
  const m = normalizeMessage(q);

  if (/seo|organic|keyword|blog|content/.test(m)) {
    return [
      `I understood your question: "${q}".`,
      "",
      "Quick SEO plan:",
      "1. Pick 1 primary keyword + 3 supporting long-tail keywords per page.",
      "2. Improve title/H1/meta description and match search intent.",
      "3. Publish 2 authority articles/week and interlink to conversion pages.",
      "4. Track rankings + CTR + conversions, not only traffic.",
    ].join("\n");
  }

  if (/sales|closing|lead quality|funnel|crm/.test(m)) {
    return [
      `I understood your question: "${q}".`,
      "",
      "Quick sales/funnel plan:",
      "1. Define MQL and SQL criteria clearly.",
      "2. Add lead scoring based on source, intent, and fit.",
      "3. Create a 3-step follow-up sequence (15 min, 24 hr, 72 hr).",
      "4. Review stage-wise drop-offs weekly and fix the largest leak first.",
    ].join("\n");
  }

  if (/copy|ad copy|headline|hook|creative/.test(m)) {
    return [
      `I understood your question: "${q}".`,
      "",
      "Quick creative/copy framework:",
      "1. Hook: pain, dream outcome, or bold claim.",
      "2. Proof: data, testimonial, or case result.",
      "3. Offer: clear benefit + urgency.",
      "4. CTA: one specific next step.",
    ].join("\n");
  }

  if (/budget|pricing|profit|roi|roas|finance/.test(m)) {
    return [
      `I understood your question: "${q}".`,
      "",
      "Quick budget control plan:",
      "1. Split spend into scale (70%), test (20%), reserve (10%).",
      "2. Pause assets above target CPL/CPA threshold.",
      "3. Reallocate daily to best efficiency segments.",
      "4. Track blended CAC, payback period, and gross margin impact.",
    ].join("\n");
  }

  return [
    `I understood your question: "${q}".`,
    "",
    "Here is a practical way to proceed:",
    "1. Define the exact goal (revenue, leads, CAC, conversion, retention).",
    "2. Identify the single biggest constraint right now.",
    "3. Run 3 focused experiments with clear success criteria.",
    "4. Keep winners, stop losers, and iterate weekly.",
    "",
    "If you want, ask again with your objective and timeframe, and I’ll give a precise action plan.",
  ].join("\n");
}

function isMarketingIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /meta|ga4|instagram|insta|reel|reels|campaign|ad|ads|audience|creative|copy|spend|cpl|cpc|cpa|roas|ctr|landing|conversion|funnel|lead|budget|remarketing|retarget/.test(
    m
  );
}

function isInstagramIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /\b(?:instagram|insta|reels?|posts?|reach|views?|plays?|saves?)\b/.test(m);
}

function isMetaIntent(message: string): boolean {
  const m = normalizeMessage(message);
  return /\b(?:meta|facebook|ads?|campaign|spend|leads?|cpl|cpc|cpa)\b/.test(m);
}

function isGa4Intent(message: string): boolean {
  const m = normalizeMessage(message);
  return /\b(?:ga4|analytics|sessions?|active users|traffic|page views|top city)\b/.test(m);
}

function defaultToolBundleForMessage(message: string): string[] {
  const m = normalizeMessage(message);
  const tools = new Set<string>();

  if (/yesterday/.test(m) && /ga4.*active users|active users.*ga4/.test(m)) {
    tools.add("get_ga4_active_users_yesterday");
  }
  if (/(last 7 days|7 days|last week|this week|week)/.test(m) && /ga4.*active users|active users.*ga4/.test(m)) {
    tools.add("get_ga4_active_users_last_7_days");
  }
  if (/meta|ad|campaign|spend|lead/.test(m)) {
    tools.add("get_meta_spend_today");
    tools.add("get_meta_leads_today");
    if (/running|active/.test(m)) tools.add("get_meta_ads_running_today");
  }
  if (/month|monthly/.test(m)) {
    tools.add("get_meta_spend_month");
    tools.add("get_ga4_sessions_month");
  }
  if (/ga4|traffic|sessions|users|website/.test(m)) {
    tools.add("get_ga4_active_users_today");
    tools.add("get_ga4_sessions_today");
  }
  if (/instagram|insta|reel|reels/.test(m)) {
    if (/follower|followers|follow|follows|follw/.test(m)) tools.add("get_instagram_account_overview");
    if (/best|top|better|perform/.test(m)) tools.add("get_instagram_best_reel");
    else tools.add("get_instagram_reels_today");
  }
  if (/campaign|performance|best|worst|poor|underperform/.test(m)) {
    tools.add("get_meta_best_campaign");
  }

  if (!tools.size) {
    tools.add("get_meta_spend_today");
    tools.add("get_meta_leads_today");
    tools.add("get_ga4_active_users_today");
  }

  return Array.from(tools).slice(0, 3);
}

function buildAdvisorAnswer(message: string, toolResults: Array<{ name: string; result: any }>): string {
  const m = normalizeMessage(message);
  const lines: string[] = [];

  if (toolResults.length) {
    lines.push("Here is your current snapshot:");
    for (const tr of toolResults) {
      lines.push(`- ${formatToolAnswer(tr.name, tr.result)}`);
    }
  }

  lines.push("");
  lines.push("Recommended next actions:");

  if (/conversion|landing|cvr|lead/.test(m)) {
    lines.push("1. Improve landing page headline + CTA match with ad promise.");
    lines.push("2. Reduce form friction (fewer fields, stronger trust proof).");
    lines.push("3. Shift budget to audiences/campaigns with lowest CPL.");
  } else if (/creative|copy|hook|ad/.test(m)) {
    lines.push("1. Launch 3 fresh creatives with distinct hooks (problem, proof, offer).");
    lines.push("2. Pause ads with high spend but weak lead volume.");
    lines.push("3. Reallocate spend to winners every 24 hours.");
  } else if (/budget|spend|roas|cpa|cpl/.test(m)) {
    lines.push("1. Cap spend on high-CPL segments and scale efficient segments.");
    lines.push("2. Track CPL/CPC trend daily and stop fatigue creatives early.");
    lines.push("3. Keep 10-20% budget for testing to avoid performance decay.");
  } else if (/ga4|sessions|users|traffic/.test(m)) {
    lines.push("1. Identify top traffic pages and strengthen conversion CTA there.");
    lines.push("2. Compare source/medium quality, not just traffic volume.");
    lines.push("3. Fix drop-off points in funnel pages with high exits.");
  } else {
    lines.push("1. Start from yesterday vs today trend in spend, leads, and users.");
    lines.push("2. Double down on segments with best efficiency, cut weak ones.");
    lines.push("3. Run controlled experiments and review results every day.");
  }

  return lines.join("\n");
}

function tokenize(text: string): string[] {
  return normalizeMessage(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function loadPromptCorpus(): PromptDoc[] {
  const filesToRead: string[] = [];
  const promptsDir = path.join(process.cwd(), "prompts");
  const rootPromptFiles = [
    "PROMPTS_1000.txt",
    "PROMPTS_3000.txt",
    "PROMPTS_5000.txt",
    "PROMPTS_30000.txt",
    "PROMPTS_100000.txt",
  ];

  for (const f of rootPromptFiles) {
    const p = path.join(process.cwd(), f);
    if (existsSync(p)) filesToRead.push(p);
  }

  if (existsSync(promptsDir)) {
    for (const f of readdirSync(promptsDir)) {
      if (!f.toLowerCase().endsWith(".txt")) continue;
      filesToRead.push(path.join(promptsDir, f));
    }
  }

  const uniq = new Set<string>();
  const corpus: PromptDoc[] = [];

  for (const file of filesToRead) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.length < 6) continue;
      const k = text.toLowerCase();
      if (uniq.has(k)) continue;
      uniq.add(k);
      const tokens = Array.from(new Set(tokenize(text)));
      if (!tokens.length) continue;
      corpus.push({ text, tokens });
    }
  }

  return corpus;
}

function buildPromptIndex(docs: PromptDoc[]): PromptIndex {
  const tokenToDocIds = new Map<string, number[]>();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    for (const token of doc.tokens) {
      const existing = tokenToDocIds.get(token);
      if (existing) existing.push(i);
      else tokenToDocIds.set(token, [i]);
    }
  }

  return { docs, tokenToDocIds };
}

const PROMPT_INDEX = buildPromptIndex(loadPromptCorpus());

function overlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const q = new Set(queryTokens);
  let overlap = 0;
  for (const t of candidateTokens) {
    if (q.has(t)) overlap++;
  }
  return overlap / Math.max(3, Math.min(candidateTokens.length, queryTokens.length));
}

function inferToolFromText(text: string): string | null {
  const m = normalizeMessage(text);

  if (m.includes("best campaign") || (m.includes("campaign") && m.includes("best")))
    return "get_meta_best_campaign";
  if (isPoorPerformanceIntent(m)) return "get_meta_best_campaign";

  if (m.includes("meta") && m.includes("leads") && m.includes("today")) return "get_meta_leads_today";
  if (
    m.includes("meta") &&
    m.includes("leads") &&
    (m.includes("last 30 days") || m.includes("30 days") || m.includes("last month"))
  ) return "get_meta_leads_last_30d";
  if ((m.includes("ad") || m.includes("ads")) && (m.includes("running") || m.includes("active")) && m.includes("today"))
    return "get_meta_ads_running_today";
  if (m.includes("spend") && (m.includes("month") || m.includes("monthly"))) return "get_meta_spend_month";
  if (m.includes("spend") && m.includes("today")) return "get_meta_spend_today";
  if (m.includes("ga4") && m.includes("active") && m.includes("users") && m.includes("yesterday"))
    return "get_ga4_active_users_yesterday";
  if (
    m.includes("ga4") &&
    m.includes("active") &&
    m.includes("users") &&
    (m.includes("last 7 days") || m.includes("7 days") || m.includes("last week") || m.includes("this week"))
  )
    return "get_ga4_active_users_last_7_days";
  if (m.includes("ga4") && m.includes("active") && m.includes("users")) return "get_ga4_active_users_today";
  if (m.includes("ga4") && m.includes("sessions") && (m.includes("month") || m.includes("monthly")))
    return "get_ga4_sessions_month";
  if (m.includes("ga4") && m.includes("sessions")) return "get_ga4_sessions_today";
  if (m.includes("ga4") && (m.includes("top pages") || m.includes("top page"))) return "get_ga4_top_pages_today";
  if (m.includes("instagram") || m.includes("insta") || m.includes("reel") || m.includes("reels")) {
    if (/(follower|followers|follow|follows|follw)/.test(m)) return "get_instagram_account_overview";
    if (/(best|top|better|perform)/.test(m)) return "get_instagram_best_reel";
    if (m.includes("best")) return "get_instagram_best_reel";
    if (m.includes("month") || m.includes("monthly")) return "get_instagram_reels_month";
    return "get_instagram_reels_today";
  }
  return null;
}

function detectBestCampaignPeriod(message: string): "today" | "this_month" | "maximum" {
  const m = normalizeMessage(message);
  if (/\b(ever|all time|lifetime|maximum|overall)\b/.test(m)) return "maximum";
  if (/\b(last 30 days|30 days|last month)\b/.test(m)) return "this_month";
  if (/\b(month|monthly|this month)\b/.test(m)) return "this_month";
  return "today";
}

function retrieveRelatedPromptsAndTools(message: string): {
  matchedPrompts: string[];
  tools: string[];
} {
  const normalized = normalizeMessage(message);
  const cached = promptRetrievalCache.get(normalized);
  if (cached && Date.now() - cached.ts < PROMPT_RETRIEVAL_TTL_MS) {
    return cached.value;
  }

  const qTokens = Array.from(new Set(tokenize(normalized)));
  if (!qTokens.length) return { matchedPrompts: [], tools: [] };

  const candidateScores = new Map<number, number>();
  for (const token of qTokens) {
    const docIds = PROMPT_INDEX.tokenToDocIds.get(token);
    if (!docIds?.length) continue;
    // Rare tokens contribute more than very common tokens.
    const tokenWeight = 1 / Math.sqrt(docIds.length);
    for (const docId of docIds) {
      candidateScores.set(docId, (candidateScores.get(docId) || 0) + tokenWeight);
    }
  }

  const candidateDocIds = Array.from(candidateScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 320)
    .map(([docId]) => docId);

  const ranked = candidateDocIds
    .map((docId) => {
      const doc = PROMPT_INDEX.docs[docId];
      return {
        text: doc.text,
        score: overlapScore(qTokens, doc.tokens),
      };
    })
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const matchedPrompts = ranked.map((r) => r.text);

  const tools = new Set<string>();
  const m = normalizeMessage(message);
  const fromQuestion = inferToolFromText(m);
  if (fromQuestion) tools.add(fromQuestion);

  // Broad, non-exact intent: combine key metrics if user asks an overall snapshot.
  if (!fromQuestion && /overview|overall|snapshot|summary|performance/.test(m)) {
    if (/\bmeta\b/.test(m)) tools.add("get_meta_spend_today");
    if (/\bga4\b/.test(m)) tools.add("get_ga4_active_users_today");
  }

  for (const p of matchedPrompts) {
    const t = inferToolFromText(p);
    if (t) tools.add(t);
    if (tools.size >= 3) break;
  }

  if (!tools.size && isMarketingIntent(m)) {
    for (const t of defaultToolBundleForMessage(m)) tools.add(t);
  }

  const value = { matchedPrompts, tools: Array.from(tools).slice(0, 3) };
  promptRetrievalCache.set(normalized, { ts: Date.now(), value });
  if (promptRetrievalCache.size > MAX_PROMPT_RETRIEVAL_CACHE) {
    const oldestKey = promptRetrievalCache.keys().next().value;
    if (oldestKey) promptRetrievalCache.delete(oldestKey);
  }

  return value;
}

function getCachedResponse(key: string): ResponsePayload | null {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts >= RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedResponse(key: string, payload: ResponsePayload): void {
  responseCache.set(key, { ts: Date.now(), value: payload });
  if (responseCache.size > MAX_RESPONSE_CACHE) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
}

// ✅ deterministic mapping so UI works even without OpenAI
function mapMessageToTool(message: string): string | null {
  const m = normalizeMessage(message);

  // Meta
  if (m.includes("best campaign") || (m.includes("campaign") && m.includes("best")))
    return "get_meta_best_campaign";
  if (isPoorPerformanceIntent(m)) return "get_meta_best_campaign";

  if (m.includes("leads") && m.includes("today")) return "get_meta_leads_today";
  if (m.includes("leads") && (m.includes("last 30 days") || m.includes("30 days") || m.includes("last month")))
    return "get_meta_leads_last_30d";
  if ((m.includes("ad") || m.includes("ads")) && (m.includes("running") || m.includes("active")) && m.includes("today"))
    return "get_meta_ads_running_today";
  if (hasSpendIntent(m) && (m.includes("month") || m.includes("monthly") || m.includes("this month")))
    return "get_meta_spend_month";
  if (hasSpendIntent(m) && m.includes("today")) return "get_meta_spend_today";
  if (hasSpendIntent(m) && hasMetaAdsIntent(m)) return "get_meta_spend_today";

  // GA4
  if ((m.includes("active users") || m.includes("active user")) && m.includes("yesterday"))
    return "get_ga4_active_users_yesterday";
  if (
    (m.includes("active users") || m.includes("active user")) &&
    (m.includes("last 7 days") || m.includes("7 days") || m.includes("last week") || m.includes("this week"))
  )
    return "get_ga4_active_users_last_7_days";
  if ((m.includes("active users") || m.includes("active user")) && (m.includes("today") || m.includes("now")))
    return "get_ga4_active_users_today";

  // Instagram Reels
  if (m.includes("instagram") || m.includes("insta") || m.includes("reel") || m.includes("reels")) {
    if (/(follower|followers|follow|follows|follw)/.test(m)) return "get_instagram_account_overview";
    if (/(best|top|better|perform)/.test(m)) return "get_instagram_best_reel";
    if (m.includes("best")) return "get_instagram_best_reel";
    if (m.includes("month") || m.includes("monthly") || m.includes("this month")) return "get_instagram_reels_month";
    return "get_instagram_reels_today";
  }

  return null;
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  const rid = (req as any).rid;

  try {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const userMessage = parsed.data.message.trim();
    const normalizedMessage = normalizeMessage(userMessage);
    const requestedMetaAccountId = req.header("x-meta-account-id") || "";
    const effectiveMetaAccountId = resolveBrandAwareAccountId(normalizedMessage, requestedMetaAccountId);
    const responseCacheKey = `${normalizedMessage}::${effectiveMetaAccountId || "-"}`;
    const wantsComparison = isComparisonIntent(normalizedMessage);
    const toolContext = {
      metaAccountId: effectiveMetaAccountId,
      role: (req as any)?.auth?.role,
    } as const;
    const runTool = (name: string, args: Record<string, any> = {}) =>
      runToolByName(name, args, toolContext);

    if (!/^run\s+/i.test(userMessage) && !wantsComparison) {
      const cachedPayload = getCachedResponse(responseCacheKey);
      if (cachedPayload) {
        return res.json({
          ...cachedPayload,
          meta: { ...(cachedPayload.meta || {}), rid, mode: `${cachedPayload.meta?.mode || "cached"}-cache-hit` },
        });
      }
    }

    // If user explicitly says "Run <tool>"
    const runMatch = userMessage.match(/^run\s+([a-zA-Z0-9_]+)\s*$/i);
    if (runMatch) {
      const tool = runMatch[1];
      const result = await runTool(tool, {});
      return res.json({
        ok: true,
        answer: formatToolAnswer(tool, result),
        tools: [{ name: tool, result }],
        meta: { rid, mode: "direct-tool" },
      });
    }

    // Instagram audit intent: always fetch full monthly reel list for brand and analyze weak performers.
    if (isInstagramAuditListIntent(normalizedMessage)) {
      const requestedBrand = detectBrandFromMessage(normalizedMessage);
      const accountId =
        requestedBrand === "altis"
          ? getAllowedMetaAccountIds()[1] || getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
          : requestedBrand === "coxwell"
            ? getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
            : effectiveMetaAccountId;

      const [overview, reelsLast30] = await Promise.all([
        runTool("get_instagram_account_overview", { account_id: accountId }),
        runTool("get_instagram_reels_last_30_days", { account_id: accountId }),
      ]);

      const rows = Array.isArray(reelsLast30?.top) ? [...reelsLast30.top] : [];
      if (!rows.length) {
        const fallbackBest = await runTool("get_instagram_best_reel", {
          account_id: accountId,
          period: "maximum",
        });
        const best = fallbackBest?.best || null;
        const payload: ResponsePayload = {
          ok: true,
          answer: best
            ? `No reels found in the last 30 days for ${String(overview?.account?.username || "this account")}. Latest best all-time reel: "${String(
                best?.caption || "N/A"
              ).slice(0, 80)}" with ${formatNumber(Number(best?.plays ?? 0))} plays and ${formatNumber(
                Number(best?.reach ?? 0)
              )} reach.`
            : `No reels found for ${String(overview?.account?.username || "this account")} in the last 30 days.`,
          tools: [
            { name: "get_instagram_account_overview", result: overview },
            { name: "get_instagram_reels_last_30_days", result: reelsLast30 },
            { name: "get_instagram_best_reel", result: fallbackBest },
          ],
          meta: { rid, mode: "instagram-audit-no-reels-30d" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }

      const weak = [...rows]
        .sort((a: any, b: any) => {
          const ap = Number(a?.plays ?? 0);
          const bp = Number(b?.plays ?? 0);
          if (ap !== bp) return ap - bp;
          const ar = Number(a?.reach ?? 0);
          const br = Number(b?.reach ?? 0);
          return ar - br;
        })
        .slice(0, Math.min(10, rows.length));

      const weakTable = [
        "| # | Plays | Reach | Saves | Likes | Comments | Shares | Caption |",
        "|---:|---:|---:|---:|---:|---:|---:|---|",
        ...weak.map((r: any, idx: number) => {
          const caption = String(r?.caption || "N/A").replace(/\s+/g, " ").trim().slice(0, 70);
          return `| ${idx + 1} | ${formatNumber(Number(r?.plays ?? 0))} | ${formatNumber(
            Number(r?.reach ?? 0)
          )} | ${formatNumber(Number(r?.saved ?? 0))} | ${formatNumber(Number(r?.likes ?? 0))} | ${formatNumber(
            Number(r?.comments ?? 0)
          )} | ${formatNumber(Number(r?.shares ?? 0))} | ${caption} |`;
        }),
      ].join("\n");

      const avg = (arr: any[], key: string) =>
        arr.length ? arr.reduce((s, r) => s + Number(r?.[key] ?? 0), 0) / arr.length : 0;
      const avgPlays = avg(rows, "plays");
      const avgReach = avg(rows, "reach");
      const avgShares = avg(rows, "shares");

      const answer = [
        `Instagram audit for ${String(overview?.account?.username || "account")} (last 30 days)`,
        `Total reels reviewed: ${formatNumber(rows.length)}`,
        `Averages: plays ${formatNumber(avgPlays)}, reach ${formatNumber(avgReach)}, shares ${formatNumber(avgShares)}`,
        "",
        "Lowest-performing reels:",
        weakTable,
        "",
        "What to improve before posting next reel:",
        "1. Use stronger hook in first 2 seconds (problem + outcome).",
        "2. Reuse themes from your top-sharing reels, avoid low-share caption styles.",
        "3. Keep caption CTA explicit: ask for save/share with one clear benefit.",
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_instagram_account_overview", result: overview },
          { name: "get_instagram_reels_last_30_days", result: reelsLast30 },
        ],
        meta: { rid, mode: "instagram-audit-list-30d" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Instagram topic comparison intent: "awning vs non-awning", "whether awning drives performance".
    if (isInstagramAwningComparisonIntent(normalizedMessage)) {
      const requestedBrand = detectBrandFromMessage(normalizedMessage);
      const accountId =
        requestedBrand === "altis"
          ? getAllowedMetaAccountIds()[1] || getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
          : requestedBrand === "coxwell"
            ? getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
            : effectiveMetaAccountId;

      const [overview, reels30] = await Promise.all([
        runTool("get_instagram_account_overview", { account_id: accountId }),
        runTool("get_instagram_reels_last_30_days", { account_id: accountId }),
      ]);

      const rows = Array.isArray(reels30?.top) ? [...reels30.top] : [];
      const awningRows = rows.filter((r: any) => /awning/i.test(String(r?.caption || "")));
      const nonAwningRows = rows.filter((r: any) => !/awning/i.test(String(r?.caption || "")));

      const avg = (arr: any[], k: string) =>
        arr.length ? arr.reduce((s, r) => s + Number(r?.[k] ?? 0), 0) / arr.length : 0;
      const median = (arr: any[], k: string) => {
        if (!arr.length) return 0;
        const values = arr.map((r: any) => Number(r?.[k] ?? 0)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
        if (!values.length) return 0;
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
      };
      const sum = (arr: any[], k: string) => arr.reduce((s, r) => s + Number(r?.[k] ?? 0), 0);

      const awningPlaysMed = median(awningRows, "plays");
      const nonAwningPlaysMed = median(nonAwningRows, "plays");
      const awningReachMed = median(awningRows, "reach");
      const nonAwningReachMed = median(nonAwningRows, "reach");
      const awningSavesMed = median(awningRows, "saved");
      const nonAwningSavesMed = median(nonAwningRows, "saved");
      const awningSharesMed = median(awningRows, "shares");
      const nonAwningSharesMed = median(nonAwningRows, "shares");

      const awningWinSignals = [
        awningPlaysMed > nonAwningPlaysMed,
        awningReachMed > nonAwningReachMed,
        awningSavesMed > nonAwningSavesMed,
        awningSharesMed > nonAwningSharesMed,
      ].filter(Boolean).length;
      const verdict =
        awningWinSignals >= 3
          ? "Awning content appears stronger in this 30-day sample."
          : awningWinSignals === 2
            ? "Awning vs non-awning is mixed in this 30-day sample."
            : "Awning content does not appear stronger in this 30-day sample.";

      const confidence =
        awningRows.length >= 3 && nonAwningRows.length >= 3
          ? "Medium confidence (both groups have at least 3 reels)."
          : "Low confidence (small sample size in one or both groups).";

      const answer = [
        `Instagram awning vs non-awning analysis for ${String(overview?.account?.username || "account")} (last 30 days)`,
        `Current followers: ${formatNumber(Number(overview?.account?.followers_count ?? 0))}`,
        "",
        "| Segment | Reels | Median Plays | Median Reach | Median Saves | Median Shares | Avg Plays | Avg Reach | Total Saves | Total Shares |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        `| Awning | ${formatNumber(awningRows.length)} | ${formatNumber(awningPlaysMed)} | ${formatNumber(
          awningReachMed
        )} | ${formatNumber(awningSavesMed)} | ${formatNumber(awningSharesMed)} | ${formatNumber(
          avg(awningRows, "plays")
        )} | ${formatNumber(avg(awningRows, "reach"))} | ${formatNumber(sum(awningRows, "saved"))} | ${formatNumber(
          sum(awningRows, "shares")
        )} |`,
        `| Non-awning | ${formatNumber(nonAwningRows.length)} | ${formatNumber(nonAwningPlaysMed)} | ${formatNumber(
          nonAwningReachMed
        )} | ${formatNumber(nonAwningSavesMed)} | ${formatNumber(nonAwningSharesMed)} | ${formatNumber(
          avg(nonAwningRows, "plays")
        )} | ${formatNumber(avg(nonAwningRows, "reach"))} | ${formatNumber(sum(nonAwningRows, "saved"))} | ${formatNumber(
          sum(nonAwningRows, "shares")
        )} |`,
        "",
        `Verdict: ${verdict}`,
        `Confidence: ${confidence}`,
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_instagram_account_overview", result: overview },
          { name: "get_instagram_reels_last_30_days", result: reels30 },
        ],
        meta: { rid, mode: "instagram-awning-vs-nonawning-30d" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Instagram drill-down intent: "after awning", "other reels performing", "followers gain/drop"
    // Deterministic analysis path to avoid shallow OpenAI summaries.
    if (isInstagramDrilldownIntent(normalizedMessage)) {
      const requestedBrand = detectBrandFromMessage(normalizedMessage);
      const accountId =
        requestedBrand === "altis"
          ? getAllowedMetaAccountIds()[1] || getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
          : requestedBrand === "coxwell"
            ? getAllowedMetaAccountIds()[0] || effectiveMetaAccountId
            : effectiveMetaAccountId;

      const [overview, reels30] = await Promise.all([
        runTool("get_instagram_account_overview", { account_id: accountId }),
        runTool("get_instagram_reels_last_30_days", { account_id: accountId }),
      ]);
      const history = await getFollowerHistory(String(accountId || ""), 60);

      const rows = Array.isArray(reels30?.top) ? [...reels30.top] : [];
      rows.sort((a: any, b: any) => {
        const ta = new Date(String(a?.published_at || "")).getTime() || 0;
        const tb = new Date(String(b?.published_at || "")).getTime() || 0;
        return tb - ta;
      });

      const awning = rows.find((r: any) => /awning/i.test(String(r?.caption || ""))) || null;
      const awningTs = awning ? new Date(String(awning?.published_at || "")).getTime() : NaN;
      const afterAwning = Number.isFinite(awningTs)
        ? rows.filter((r: any) => {
            const t = new Date(String(r?.published_at || "")).getTime();
            return Number.isFinite(t) && t > awningTs;
          })
        : rows.slice(0, 10);

      const tableRows = afterAwning.length ? afterAwning : rows;
      const table = tableRows.length
        ? [
            "| # | Date | Plays | Reach | Saves | Likes | Comments | Shares | Caption |",
            "|---:|---|---:|---:|---:|---:|---:|---:|---|",
            ...tableRows.slice(0, 20).map((r: any, idx: number) => {
              const date = String(r?.published_at || "").slice(0, 10) || "-";
              const caption = String(r?.caption || "N/A").replace(/\s+/g, " ").trim().slice(0, 72);
              return `| ${idx + 1} | ${date} | ${formatNumber(Number(r?.plays ?? 0))} | ${formatNumber(
                Number(r?.reach ?? 0)
              )} | ${formatNumber(Number(r?.saved ?? 0))} | ${formatNumber(Number(r?.likes ?? 0))} | ${formatNumber(
                Number(r?.comments ?? 0)
              )} | ${formatNumber(Number(r?.shares ?? 0))} | ${caption} |`;
            }),
          ].join("\n")
        : "No reels found in the last 30 days.";

      const avg = (arr: any[], k: string) =>
        arr.length ? arr.reduce((s, r) => s + Number(r?.[k] ?? 0), 0) / arr.length : 0;
      const avgPlays = avg(tableRows, "plays");
      const avgReach = avg(tableRows, "reach");
      const avgShares = avg(tableRows, "shares");

      const answer = [
        `Instagram deep analysis for ${String(overview?.account?.username || "account")} (last 30 days)`,
        `Current followers: ${formatNumber(Number(overview?.account?.followers_count ?? 0))}`,
        awning
          ? `Reference reel ("awning") found on ${String(awning?.published_at || "").slice(0, 10)} with ${formatNumber(
              Number(awning?.plays ?? 0)
            )} plays and ${formatNumber(Number(awning?.reach ?? 0))} reach.`
          : "No 'awning' caption match found; showing top recent reels from last 30 days.",
        "",
        `Set summary: average plays ${formatNumber(avgPlays)}, average reach ${formatNumber(
          avgReach
        )}, average shares ${formatNumber(avgShares)}.`,
        "",
        "Reels performance set:",
        table,
        "",
        "Followers gain/drop analysis:",
        ...(() => {
          if (!history.length) {
            return [
              "No stored follower history yet. Tracking has now started; gain/loss will appear after daily snapshots accumulate.",
            ];
          }
          const first = history[0];
          const last = history[history.length - 1];
          const delta = Number(last?.followers_count ?? 0) - Number(first?.followers_count ?? 0);
          const lines = [
            `Stored history window: ${first?.day_ist || "-"} to ${last?.day_ist || "-"} (${history.length} day snapshot(s)).`,
            `Net follower change in stored window: ${delta >= 0 ? "+" : ""}${formatNumber(delta)}.`,
          ];

          if (awning && Number.isFinite(awningTs)) {
            const awningDay = String(awning?.published_at || "").slice(0, 10);
            const before = [...history].reverse().find((h: any) => String(h?.day_ist || "") <= awningDay) || null;
            if (before) {
              const sinceAwning = Number(last?.followers_count ?? 0) - Number(before?.followers_count ?? 0);
              lines.push(
                `Follower change since awning reel date (${awningDay}): ${sinceAwning >= 0 ? "+" : ""}${formatNumber(
                  sinceAwning
                )}.`
              );
            } else {
              lines.push("Awning-date follower baseline not yet available in stored history.");
            }
          }
          return lines;
        })(),
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_instagram_account_overview", result: overview },
          { name: "get_instagram_reels_last_30_days", result: reels30 },
        ],
        meta: { rid, mode: "instagram-drilldown-30d" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Qualified lead campaign strategy intent (brand-specific, data-backed, structured output).
    if (isQualifiedLeadCampaignIntent(normalizedMessage)) {
      const requestedBrand = detectBrandFromMessage(normalizedMessage);
      const allowed = getAllowedMetaAccountIds();
      const accountId =
        requestedBrand === "altis"
          ? allowed[1] || allowed[0] || effectiveMetaAccountId
          : requestedBrand === "coxwell"
            ? allowed[0] || effectiveMetaAccountId
            : effectiveMetaAccountId || allowed[0];
      const brandLabel = requestedBrand === "altis" ? "Altis" : requestedBrand === "coxwell" ? "Coxwell" : "Brand";
      const monthlyBudget = parseBudgetInr(normalizedMessage) || 20000;
      const weeklyBudget = monthlyBudget / 4;
      const topBudget = Number((monthlyBudget * 0.65).toFixed(0));
      const testBudget = Number((monthlyBudget * 0.25).toFixed(0));
      const retargetBudget = Number((monthlyBudget * 0.1).toFixed(0));

      const [bestCampaign, leads7, spend7, reels30] = await Promise.all([
        runTool("get_meta_best_campaign", { account_id: accountId, period: "this_month" }),
        runTool("get_meta_leads_last_7d", { account_id: accountId }),
        runTool("get_meta_spend_last_7d", { account_id: accountId }),
        runTool("get_instagram_reels_last_30_days", { account_id: accountId }),
      ]);

      const best = bestCampaign?.best || {};
      const leadsLast7 = Number(leads7?.leads ?? NaN);
      const spendLast7 = Number(spend7?.spend ?? NaN);
      const currentCpl7 =
        Number.isFinite(spendLast7) && Number.isFinite(leadsLast7) && leadsLast7 > 0
          ? Number((spendLast7 / leadsLast7).toFixed(2))
          : NaN;
      const targetCpl = Number.isFinite(currentCpl7)
        ? Number((currentCpl7 * 0.9).toFixed(2))
        : Number((monthlyBudget / 80).toFixed(2));
      const targetQualifiedLeads = targetCpl > 0 ? Math.max(1, Math.floor(monthlyBudget / targetCpl)) : 0;

      const rows = Array.isArray(reels30?.top) ? reels30.top : [];
      const topReel = rows.length
        ? [...rows].sort((a: any, b: any) => Number(b?.shares ?? 0) - Number(a?.shares ?? 0))[0]
        : null;
      const topReelCaption = String(topReel?.caption || best?.campaign_name || "Top-performing proof-led creative");

      const geoHint = /delhi\s*ncr/.test(normalizedMessage) ? "Delhi NCR" : "Target geography from prompt";
      const audienceHint = /architect|interior|designer|builder|resort|homeowner|pergola|outdoor furniture/.test(
        normalizedMessage
      )
        ? "Architects, interior designers, builders, resort owners/managers, homeowners (interest: pergolas/outdoor furniture)"
        : "Qualified in-market audience clusters from your CRM + website signals";

      const answer = [
        `${brandLabel} 30-day campaign plan for higher-quality leads`,
        "",
        "Input lock:",
        `- Budget: ${formatCurrency(monthlyBudget, "INR")} (monthly)`,
        `- Geography: ${geoHint}`,
        `- Audience: ${audienceHint}`,
        `- Pricing: Keep website price unchanged`,
        "",
        "Current baseline from live data:",
        `- Last 7 days spend: ${Number.isFinite(spendLast7) ? formatCurrency(spendLast7, "INR") : "-"}`,
        `- Last 7 days leads: ${Number.isFinite(leadsLast7) ? formatNumber(leadsLast7) : "-"}`,
        `- Last 7 days CPL: ${Number.isFinite(currentCpl7) ? formatCurrency(currentCpl7, "INR") : "-"}`,
        `- Best campaign this month: ${String(best?.campaign_name || "N/A")} | Leads: ${formatNumber(
          Number(best?.leads ?? NaN)
        )} | CPC: ${Number.isFinite(Number(best?.cpc)) ? formatCurrency(Number(best?.cpc), "INR") : "-"}`,
        "",
        "Budget split (quality-first):",
        "| Bucket | % | Budget | Objective |",
        "|---|---:|---:|---|",
        `| Proven lead set | 65% | ${formatCurrency(topBudget, "INR")} | Scale qualified form fills with strict filters |`,
        `| Creative test set | 25% | ${formatCurrency(testBudget, "INR")} | Test 3 hooks + 2 offer angles for lead quality |`,
        `| Retargeting | 10% | ${formatCurrency(retargetBudget, "INR")} | Re-engage high-intent visitors/video engagers |`,
        "",
        "Campaign structure:",
        `1. Campaign A (Leads): 2 ad sets -> (a) Professionals: architects/interior/designers/builders, (b) Owners: resort/homeowners.`,
        "2. Campaign B (Retargeting): 30-day website visitors, IG engagers, lead-form opens-not-submitted.",
        `3. Creatives: Use proof-style messaging from top reel theme: "${topReelCaption.slice(0, 110)}".`,
        "",
        "Lead quality gate (form questions):",
        "1. Project location (Delhi NCR micro-location).",
        "2. Project type (residential/commercial/resort).",
        "3. Installation timeline (0-1 month / 1-3 months / later).",
        "4. Approx budget range (aligned to website pricing bands).",
        "",
        "KPI targets (30 days):",
        `- Target qualified leads: ${formatNumber(targetQualifiedLeads)}`,
        `- Target CPL (qualified): <= ${formatCurrency(targetCpl, "INR")}`,
        "- CTR target: >= 1.5%",
        "- Landing page conversion target: >= 8%",
        "",
        "Scale/Pause rules (daily):",
        `1. Scale +20% budget if ad set CPL is below ${formatCurrency(targetCpl * 0.9, "INR")} for 2 consecutive days.`,
        `2. Pause creative if CPL is above ${formatCurrency(targetCpl * 1.25, "INR")} after 1,500 impressions.`,
        "3. Move budget from low-quality leads (missing budget/timeline answers) to high-intent ad set each evening.",
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_meta_best_campaign", result: bestCampaign },
          { name: "get_meta_leads_last_7d", result: leads7 },
          { name: "get_meta_spend_last_7d", result: spend7 },
          { name: "get_instagram_reels_last_30_days", result: reels30 },
        ],
        meta: { rid, mode: "qualified-lead-campaign-plan-v1" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Weekly optimization review intent (brand-specific, exact actions).
    if (isWeeklyOptimizationReviewIntent(normalizedMessage)) {
      const requestedBrand = detectBrandFromMessage(normalizedMessage);
      const allowed = getAllowedMetaAccountIds();
      const accountId =
        requestedBrand === "altis"
          ? allowed[1] || allowed[0] || effectiveMetaAccountId
          : requestedBrand === "coxwell"
            ? allowed[0] || effectiveMetaAccountId
            : effectiveMetaAccountId || allowed[0];
      const brandLabel = requestedBrand === "altis" ? "Altis" : requestedBrand === "coxwell" ? "Coxwell" : "Brand";

      const [spend7, leads7, bestCampaign, reels30, ga4Snapshot] = await Promise.all([
        runTool("get_meta_spend_last_7d", { account_id: accountId }),
        runTool("get_meta_leads_last_7d", { account_id: accountId }),
        runTool("get_meta_best_campaign", { account_id: accountId, period: "this_month" }),
        runTool("get_instagram_reels_last_30_days", { account_id: accountId }),
        runTool("get_ga4_report_snapshot", { account_id: accountId, period: "last_7_days" }),
      ]);

      const spend = Number(spend7?.spend ?? NaN);
      const leads = Number(leads7?.leads ?? NaN);
      const cpl = Number.isFinite(spend) && Number.isFinite(leads) && leads > 0 ? Number((spend / leads).toFixed(2)) : NaN;
      const best = bestCampaign?.best || {};
      const bestCampaignCpl =
        Number.isFinite(Number(best?.cpl)) ? Number(best?.cpl) : Number.NaN;

      const rows = Array.isArray(reels30?.top) ? reels30.top : [];
      const lowShareRows = [...rows]
        .filter((r: any) => Number(r?.plays ?? 0) > 0)
        .map((r: any) => ({
          ...r,
          shareRate: (Number(r?.shares ?? 0) / Math.max(1, Number(r?.plays ?? 0))) * 100,
        }))
        .sort((a: any, b: any) => a.shareRate - b.shareRate)
        .slice(0, 3);

      const weakCreativeTable = lowShareRows.length
        ? [
            "| # | Date | Plays | Shares | Share Rate | Caption |",
            "|---:|---|---:|---:|---:|---|",
            ...lowShareRows.map((r: any, i: number) => {
              const date = String(r?.published_at || "").slice(0, 10) || "-";
              const caption = String(r?.caption || "N/A").replace(/\s+/g, " ").trim().slice(0, 72);
              return `| ${i + 1} | ${date} | ${formatNumber(Number(r?.plays ?? 0))} | ${formatNumber(
                Number(r?.shares ?? 0)
              )} | ${formatNumber(Number(r?.shareRate ?? 0))}% | ${caption} |`;
            }),
          ].join("\n")
        : "No weak-creative rows available.";

      const targetCpl = Number.isFinite(bestCampaignCpl)
        ? Number((bestCampaignCpl * 1.05).toFixed(2))
        : Number.isFinite(cpl)
          ? Number((cpl * 0.95).toFixed(2))
          : NaN;

      const answer = [
        `${brandLabel} weekly performance review (last 7 days)`,
        "",
        "KPI snapshot:",
        "| KPI | Value |",
        "|---|---:|",
        `| Spend (7d) | ${Number.isFinite(spend) ? formatCurrency(spend, "INR") : "-"} |`,
        `| Leads (7d) | ${Number.isFinite(leads) ? formatNumber(leads) : "-"} |`,
        `| CPL (7d) | ${Number.isFinite(cpl) ? formatCurrency(cpl, "INR") : "-"} |`,
        `| GA4 Active Users (7d) | ${formatNumber(Number(ga4Snapshot?.active_users ?? NaN))} |`,
        `| GA4 New Users (7d) | ${formatNumber(Number(ga4Snapshot?.new_users ?? NaN))} |`,
        `| GA4 Events (7d) | ${formatNumber(Number(ga4Snapshot?.event_count ?? NaN))} |`,
        "",
        "Risk flags:",
        `1. Current CPL ${Number.isFinite(cpl) ? formatCurrency(cpl, "INR") : "-"} vs best-campaign CPL ${
          Number.isFinite(bestCampaignCpl) ? formatCurrency(bestCampaignCpl, "INR") : "-"
        }.`,
        `2. Best campaign this month: ${String(best?.campaign_name || "N/A")} (leads ${formatNumber(
          Number(best?.leads ?? NaN)
        )}, CPC ${Number.isFinite(Number(best?.cpc)) ? formatCurrency(Number(best?.cpc), "INR") : "-"})`,
        "3. Low-share creatives detected below.",
        "",
        "Weak creatives to optimize first:",
        weakCreativeTable,
        "",
        "Exact optimization actions (next 7 days):",
        `1. Budget move: shift 20% spend from ad sets with CPL > ${
          Number.isFinite(targetCpl) ? formatCurrency(targetCpl * 1.2, "INR") : "target threshold"
        } to the best-campaign audience cluster.`,
        "2. Creative refresh: launch 2 new hooks for each weak reel theme; keep same offer, change first 2-sec problem statement.",
        "3. Form quality filter: make budget range + project timeline mandatory; deprioritize leads without both fields.",
        "4. Retargeting: create 7-day engaged-video audience and run proof/testimonial creative with explicit CTA.",
        "5. Daily control rule: pause any ad after 1,500 impressions if CPL stays above threshold for 2 days.",
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_meta_spend_last_7d", result: spend7 },
          { name: "get_meta_leads_last_7d", result: leads7 },
          { name: "get_meta_best_campaign", result: bestCampaign },
          { name: "get_instagram_reels_last_30_days", result: reels30 },
          { name: "get_ga4_report_snapshot", result: ga4Snapshot },
        ],
        meta: { rid, mode: "weekly-optimization-review-v1" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Strict mode: only Coxwell + Altis real data answers, no generic assistant output.
    if (isStrictBrandScopeOnly()) {
      const allowed = getAllowedMetaAccountIds();
      const coxwellAccountId = String(allowed[0] || "");
      const altisAccountId = String(allowed[1] || allowed[0] || "");

      if (!coxwellAccountId) {
        const payload: ResponsePayload = {
          ok: true,
          answer: "Strict brand mode is enabled, but Coxwell account id is missing in server configuration.",
          meta: { rid, mode: "strict-brand-config-missing" },
        };
        return res.json(payload);
      }

      if (isInstagramIntent(normalizedMessage)) {
        const period = detectBestCampaignPeriod(normalizedMessage);
        const askedBrand = detectBrandFromMessage(normalizedMessage);
        const isComparison = /\b(compare|comparison|vs|versus|difference|better|winning)\b/.test(normalizedMessage);
        const wantsDetailedTable =
          /\b(table|tabular|all data|every data|full data|detailed|30 days|last 30 days|1 to 30)\b/.test(
            normalizedMessage
          );

        const runForBrand = async (brand: "Coxwell" | "Altis", accountId: string) => {
          const [overview, best] = await Promise.all([
            runTool("get_instagram_account_overview", { account_id: accountId }),
            runTool("get_instagram_best_reel", { account_id: accountId, period }),
          ]);
          const b = best?.best || {};
          const plays = Number(b?.plays ?? NaN);
          const likes = Number(b?.likes ?? NaN);
          const comments = Number(b?.comments ?? NaN);
          const shares = Number(b?.shares ?? NaN);
          const saves = Number(b?.saved ?? NaN);
          const interactions = [likes, comments, shares, saves].reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
          const engagementRate = Number.isFinite(plays) && plays > 0
            ? Number(((interactions / plays) * 100).toFixed(2))
            : NaN;
          return {
            brand,
            accountId,
            username: String(overview?.account?.username || "-"),
            followers: Number(overview?.account?.followers_count ?? NaN),
            plays,
            reach: Number(b?.reach ?? NaN),
            saves,
            likes,
            comments,
            shares,
            engagementRate,
            caption: String(b?.caption || "N/A").slice(0, 60),
            tools: [
              { name: "get_instagram_account_overview", result: overview },
              { name: "get_instagram_best_reel", result: best },
            ],
          };
        };

        const rows = askedBrand && !isComparison
          ? [await runForBrand(askedBrand === "coxwell" ? "Coxwell" : "Altis", askedBrand === "coxwell" ? coxwellAccountId : altisAccountId)]
          : await Promise.all([
              runForBrand("Coxwell", coxwellAccountId),
              runForBrand("Altis", altisAccountId),
            ]);

        // If user asks single-brand "tabular/every data/30 days", return detailed reel table.
        if (rows.length === 1 && wantsDetailedTable) {
          const targetAccountId = rows[0].accountId;
          const reelsResult = await runTool("get_instagram_reels_last_30_days", { account_id: targetAccountId });
          const reelRows = Array.isArray(reelsResult?.top) ? reelsResult.top.slice(0, 30) : [];
          const detailedTable = reelRows.length
            ? [
                "| # | Published | Plays | Reach | Saves | Likes | Comments | Shares | Caption | Permalink |",
                "|---:|---|---:|---:|---:|---:|---:|---:|---|---|",
                ...reelRows.map((r: any, idx: number) => {
                  const published = String(r?.published_at || r?.timestamp || "-").slice(0, 10);
                  const plays = formatNumber(Number(r?.plays ?? 0));
                  const reach = formatNumber(Number(r?.reach ?? 0));
                  const saves = formatNumber(Number(r?.saved ?? 0));
                  const likes = formatNumber(Number(r?.likes ?? 0));
                  const comments = formatNumber(Number(r?.comments ?? 0));
                  const shares = formatNumber(Number(r?.shares ?? 0));
                  const caption = String(r?.caption || "N/A").replace(/\s+/g, " ").trim().slice(0, 70);
                  const permalink = String(r?.permalink || "-");
                  return `| ${idx + 1} | ${published} | ${plays} | ${reach} | ${saves} | ${likes} | ${comments} | ${shares} | ${caption} | ${permalink} |`;
                }),
              ].join("\n")
            : "No reels found in the selected 1-30 day window.";

          const detailedAnswer = [
            `Strict brand data (Instagram, 1-30 days):`,
            `Brand: ${rows[0].brand} | Account: ${rows[0].accountId} | Username: ${rows[0].username}`,
            "",
            `Reels found: ${formatNumber(Number(reelsResult?.reels_count ?? 0))}`,
            `Totals: Plays ${formatNumber(Number(reelsResult?.total_plays ?? 0))}, Reach ${formatNumber(
              Number(reelsResult?.total_reach ?? 0)
            )}, Saves ${formatNumber(Number(reelsResult?.total_saved ?? 0))}`,
            "",
            detailedTable,
          ].join("\n");

          const payload: ResponsePayload = {
            ok: true,
            answer: detailedAnswer,
            tools: [...rows[0].tools, { name: "get_instagram_reels_last_30_days", result: reelsResult }],
            meta: { rid, mode: "strict-brand-instagram-single-detailed" },
          };
          setCachedResponse(responseCacheKey, payload);
          return res.json(payload);
        }

        let answer = [
          `Strict brand data (Instagram, ${period}):`,
          "",
          "| Brand | Account | Username | Followers | Best Reel Plays | Best Reel Reach | Best Reel Saves | Eng. Rate | Best Reel Caption |",
          "|---|---|---|---:|---:|---:|---:|---:|---|",
          ...rows.map((r) =>
            `| ${r.brand} | ${r.accountId} | ${r.username} | ${Number.isFinite(r.followers) ? formatNumber(r.followers) : "-"} | ${Number.isFinite(r.plays) ? formatNumber(r.plays) : "-"} | ${Number.isFinite(r.reach) ? formatNumber(r.reach) : "-"} | ${Number.isFinite(r.saves) ? formatNumber(r.saves) : "-"} | ${Number.isFinite(r.engagementRate) ? `${formatNumber(r.engagementRate)}%` : "-"} | ${r.caption} |`
          ),
        ].join("\n");

        if (rows.length === 2) {
          const [a, b] = rows;
          const winner = (Number(a.plays || 0) + Number(a.reach || 0)) >= (Number(b.plays || 0) + Number(b.reach || 0)) ? a : b;
          const runner = winner.brand === a.brand ? b : a;
          answer += [
            "",
            "Insights:",
            `1. Winner right now: ${winner.brand} (higher combined plays+reach than ${runner.brand}).`,
            `2. ${winner.brand} engagement rate on best reel: ${Number.isFinite(winner.engagementRate) ? `${formatNumber(winner.engagementRate)}%` : "N/A"}.`,
            `3. ${runner.brand} can improve by testing variants of "${winner.caption.slice(0, 30)}..." style hooks.`,
          ].join("\n");
        } else {
          const r = rows[0];
          answer += [
            "",
            "Insights:",
            `1. Best reel engagement rate: ${Number.isFinite(r.engagementRate) ? `${formatNumber(r.engagementRate)}%` : "N/A"}.`,
            `2. Interaction mix: likes ${Number.isFinite(r.likes) ? formatNumber(r.likes) : "-"}, comments ${Number.isFinite(r.comments) ? formatNumber(r.comments) : "-"}, shares ${Number.isFinite(r.shares) ? formatNumber(r.shares) : "-"}, saves ${Number.isFinite(r.saves) ? formatNumber(r.saves) : "-"}.`,
            `3. Caption/hook reference: "${r.caption}".`,
          ].join("\n");
        }

        const payload: ResponsePayload = {
          ok: true,
          answer,
          tools: rows.flatMap((r) => r.tools),
          meta: { rid, mode: rows.length === 2 ? "strict-brand-instagram-dual" : "strict-brand-instagram-single" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }

      if (isMetaIntent(normalizedMessage)) {
        const runForBrand = async (brand: "Coxwell" | "Altis", accountId: string) => {
          const [spendToday, leadsToday, spend7d, leads7d] = await Promise.all([
            runTool("get_meta_spend_today", { account_id: accountId }),
            runTool("get_meta_leads_today", { account_id: accountId }),
            runTool("get_meta_spend_last_7d", { account_id: accountId }),
            runTool("get_meta_leads_last_7d", { account_id: accountId }),
          ]);
          return {
            brand,
            accountId,
            spendToday: Number(spendToday?.spend ?? NaN),
            leadsToday: Number(leadsToday?.leads ?? NaN),
            spend7d: Number(spend7d?.spend ?? NaN),
            leads7d: Number(leads7d?.leads ?? NaN),
            tools: [
              { name: "get_meta_spend_today", result: spendToday },
              { name: "get_meta_leads_today", result: leadsToday },
              { name: "get_meta_spend_last_7d", result: spend7d },
              { name: "get_meta_leads_last_7d", result: leads7d },
            ],
          };
        };

        const [cw, al] = await Promise.all([
          runForBrand("Coxwell", coxwellAccountId),
          runForBrand("Altis", altisAccountId),
        ]);
        const answer = [
          "Strict brand data (Meta):",
          "",
          "| Brand | Account | Spend Today | Leads Today | Spend Last 7D | Leads Last 7D |",
          "|---|---|---:|---:|---:|---:|",
          `| Coxwell | ${cw.accountId} | ${Number.isFinite(cw.spendToday) ? formatCurrency(cw.spendToday, "INR") : "-"} | ${Number.isFinite(cw.leadsToday) ? formatNumber(cw.leadsToday) : "-"} | ${Number.isFinite(cw.spend7d) ? formatCurrency(cw.spend7d, "INR") : "-"} | ${Number.isFinite(cw.leads7d) ? formatNumber(cw.leads7d) : "-"} |`,
          `| Altis | ${al.accountId} | ${Number.isFinite(al.spendToday) ? formatCurrency(al.spendToday, "INR") : "-"} | ${Number.isFinite(al.leadsToday) ? formatNumber(al.leadsToday) : "-"} | ${Number.isFinite(al.spend7d) ? formatCurrency(al.spend7d, "INR") : "-"} | ${Number.isFinite(al.leads7d) ? formatNumber(al.leads7d) : "-"} |`,
        ].join("\n");

        const payload: ResponsePayload = {
          ok: true,
          answer,
          tools: [...cw.tools, ...al.tools],
          meta: { rid, mode: "strict-brand-meta-dual" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }

      if (isGa4Intent(normalizedMessage)) {
        const runForBrand = async (brand: "Coxwell" | "Altis", accountId: string) => {
          const [activeUsers, sessions] = await Promise.all([
            runTool("get_ga4_active_users_today", { account_id: accountId }),
            runTool("get_ga4_sessions_today", { account_id: accountId }),
          ]);
          return {
            brand,
            accountId,
            activeUsers: Number(activeUsers?.active_users ?? NaN),
            sessions: Number(sessions?.sessions ?? NaN),
            tools: [
              { name: "get_ga4_active_users_today", result: activeUsers },
              { name: "get_ga4_sessions_today", result: sessions },
            ],
          };
        };

        const [cw, al] = await Promise.all([
          runForBrand("Coxwell", coxwellAccountId),
          runForBrand("Altis", altisAccountId),
        ]);
        const answer = [
          "Strict brand data (GA4):",
          "",
          "| Brand | Account | Active Users (Today) | Sessions (Today) |",
          "|---|---|---:|---:|",
          `| Coxwell | ${cw.accountId} | ${Number.isFinite(cw.activeUsers) ? formatNumber(cw.activeUsers) : "-"} | ${Number.isFinite(cw.sessions) ? formatNumber(cw.sessions) : "-"} |`,
          `| Altis | ${al.accountId} | ${Number.isFinite(al.activeUsers) ? formatNumber(al.activeUsers) : "-"} | ${Number.isFinite(al.sessions) ? formatNumber(al.sessions) : "-"} |`,
        ].join("\n");

        const payload: ResponsePayload = {
          ok: true,
          answer,
          tools: [...cw.tools, ...al.tools],
          meta: { rid, mode: "strict-brand-ga4-dual" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }

      const payload: ResponsePayload = {
        ok: true,
        answer:
          "Strict brand mode is enabled. Ask only Coxwell/Altis data questions for Instagram, Meta, or GA4.",
        meta: { rid, mode: "strict-brand-non-data-blocked" },
      };
      return res.json(payload);
    }

    // Optional global mode: force OpenAI response for all normal chat queries.
    // Useful when user wants pure ChatGPT-like behavior instead of deterministic tool routing.
    if (isForceOpenAIForAll() && process.env.OPENAI_API_KEY) {
      try {
        const allowed = getAllowedMetaAccountIds();
        const openaiToolAnswer = await answerFromOpenAIWithTools(
          userMessage,
          (name, args = {}) => runTool(name, args),
          { coxwell: allowed[0], altis: allowed[1] || allowed[0] },
          1
        );
        if (openaiToolAnswer && openaiToolAnswer.tools.length > 0) {
          const payload: ResponsePayload = {
            ok: true,
            answer: `[mode: openai-forced-all+tools | model: ${getModel()}]\n${openaiToolAnswer.answer}`,
            tools: openaiToolAnswer.tools,
            meta: { rid, mode: "openai-forced-all-tools" },
          };
          setCachedResponse(responseCacheKey, payload);
          return res.json(payload);
        }

        const fallbackTools = defaultToolBundleForMessage(normalizedMessage);
        const toolResults: Array<{ name: string; result: any }> = [];
        for (const t of fallbackTools) {
          const result = await runTool(t, {});
          toolResults.push({ name: t, result });
        }
        const answer = buildAdvisorAnswer(normalizedMessage, toolResults);
        const payload: ResponsePayload = {
          ok: true,
          answer: `[mode: openai-forced-all-tools-fallback | model: ${getModel()}]\n${answer}`,
          tools: toolResults,
          meta: { rid, mode: "openai-forced-all-tools-fallback" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      } catch (err: any) {
        console.error("Forced OpenAI mode failed:", err?.message || err);
      }
    }

    // Comparison-first path: always return exact tabular comparison for compare/vs/trend requests.
    if (isComparisonIntent(normalizedMessage)) {
      const toolsToRun = comparisonToolsForMessage(normalizedMessage);
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of toolsToRun) {
        try {
          const result = await runTool(t, {});
          toolResults.push({ name: t, result });
        } catch (err: any) {
          toolResults.push({ name: t, result: { ok: false, error: err?.message || String(err) } });
        }
      }

      const payload: ResponsePayload = {
        ok: true,
        answer: buildComparisonTableAnswer(userMessage, toolResults),
        tools: toolResults,
        meta: { rid, mode: "comparison-table" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Best-campaign time-window intent (today/month/ever)
    if (/(best)\s+(campaign|ad)/.test(normalizedMessage) || /(campaign|ad).*(best)/.test(normalizedMessage)) {
      const period = detectBestCampaignPeriod(normalizedMessage);
      const result = await runTool("get_meta_best_campaign", { period });
      const payload: ResponsePayload = {
        ok: true,
        answer: formatToolAnswer("get_meta_best_campaign", result),
        tools: [{ name: "get_meta_best_campaign", result }],
        meta: { rid, mode: `tool-mapping-best-campaign-${period}` },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Instagram Reel best intent with time-window
    if (
      /(best)\s+(instagram|insta|reel|reels)/.test(normalizedMessage) ||
      /(instagram|insta|reel|reels).*(best)/.test(normalizedMessage)
    ) {
      const period = detectBestCampaignPeriod(normalizedMessage);
      const result = await runTool("get_instagram_best_reel", { period });
      const payload: ResponsePayload = {
        ok: true,
        answer: formatToolAnswer("get_instagram_best_reel", result),
        tools: [{ name: "get_instagram_best_reel", result }],
        meta: { rid, mode: `tool-mapping-best-instagram-reel-${period}` },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // GA4 weekly active users intent should always go direct to tool (avoid generic LLM responses).
    if (
      /(ga4).*(active user|active users).*(last 7 days|7 days|last week|this week)/.test(normalizedMessage) ||
      /(last 7 days|7 days|last week|this week).*(ga4).*(active user|active users)/.test(normalizedMessage)
    ) {
      const result = await runTool("get_ga4_active_users_last_7_days", {});
      const payload: ResponsePayload = {
        ok: true,
        answer: formatToolAnswer("get_ga4_active_users_last_7_days", result),
        tools: [{ name: "get_ga4_active_users_last_7_days", result }],
        meta: { rid, mode: "tool-mapping-ga4-weekly-priority" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Dedicated answer style for "top 3 actions to improve lead quality"
    if (isLeadQualityActionsIntent(normalizedMessage)) {
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of ["get_meta_leads_today", "get_meta_spend_today", "get_meta_best_campaign"]) {
        const result = await runTool(t, {});
        toolResults.push({ name: t, result });
      }
      const payload: ResponsePayload = {
        ok: true,
        answer: buildLeadQualityActionsAnswer(toolResults),
        tools: toolResults,
        meta: { rid, mode: "lead-quality-action-plan" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Dedicated answer style for "how can I reduce CPL from today's data"
    if (isReduceCplIntent(normalizedMessage)) {
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of ["get_meta_leads_today", "get_meta_spend_today", "get_meta_best_campaign"]) {
        const result = await runTool(t, {});
        toolResults.push({ name: t, result });
      }
      const payload: ResponsePayload = {
        ok: true,
        answer: buildReduceCplAnswer(toolResults),
        tools: toolResults,
        meta: { rid, mode: "reduce-cpl-action-plan" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Dedicated answer style for "where budget is getting wasted today"
    if (isBudgetWasteIntent(normalizedMessage)) {
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of ["get_meta_spend_today", "get_meta_best_campaign"]) {
        const result = await runTool(t, {});
        toolResults.push({ name: t, result });
      }
      const payload: ResponsePayload = {
        ok: true,
        answer: buildBudgetWasteAnswer(toolResults),
        tools: toolResults,
        meta: { rid, mode: "budget-waste-action-plan" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Dual-brand Meta query (Altis + Coxwell), including N-day request.
    if (isDualBrandMetaIntent(normalizedMessage)) {
      const days = parseRequestedDays(normalizedMessage) || 5;
      const allowed = getAllowedMetaAccountIds();
      const coxwellAccountId = String(allowed[0] || "");
      const altisAccountId = String(allowed[1] || allowed[0] || "");

      const runForBrand = async (brand: "Coxwell" | "Altis", accountId: string) => {
        if (!accountId) {
          return {
            brand,
            accountId: "-",
            spendToday: NaN,
            leadsToday: NaN,
            spendLast7d: NaN,
            leadsLast7d: NaN,
            spendNdayEstimate: NaN,
            leadsNdayEstimate: NaN,
          };
        }
        const [spendToday, leadsToday, spendLast7d, leadsLast7d] = await Promise.all([
          runTool("get_meta_spend_today", { account_id: accountId }),
          runTool("get_meta_leads_today", { account_id: accountId }),
          runTool("get_meta_spend_last_7d", { account_id: accountId }),
          runTool("get_meta_leads_last_7d", { account_id: accountId }),
        ]);
        const spendTodayValue = Number(spendToday?.spend ?? NaN);
        const leadsTodayValue = Number(leadsToday?.leads ?? NaN);
        const spendLast7dValue = Number(spendLast7d?.spend ?? NaN);
        const leadsLast7dValue = Number(leadsLast7d?.leads ?? NaN);
        const spendNdayEstimate = Number.isFinite(spendLast7dValue)
          ? Number(((spendLast7dValue / 7) * days).toFixed(2))
          : NaN;
        const leadsNdayEstimate = Number.isFinite(leadsLast7dValue)
          ? Number(((leadsLast7dValue / 7) * days).toFixed(0))
          : NaN;
        return {
          brand,
          accountId,
          spendToday: spendTodayValue,
          leadsToday: leadsTodayValue,
          spendLast7d: spendLast7dValue,
          leadsLast7d: leadsLast7dValue,
          spendNdayEstimate,
          leadsNdayEstimate,
        };
      };

      const [coxwell, altis] = await Promise.all([
        runForBrand("Coxwell", coxwellAccountId),
        runForBrand("Altis", altisAccountId),
      ]);

      const answer = [
        `Meta performance snapshot for Altis and Coxwell (${days}-day view):`,
        "",
        "| Brand | Account | Spend Today | Leads Today | Spend Last 7D | Leads Last 7D | Est. Spend (" + days + "D) | Est. Leads (" + days + "D) |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
        `| Coxwell | ${coxwell.accountId} | ${Number.isFinite(coxwell.spendToday) ? formatCurrency(coxwell.spendToday, "INR") : "-"} | ${Number.isFinite(coxwell.leadsToday) ? formatNumber(coxwell.leadsToday) : "-"} | ${Number.isFinite(coxwell.spendLast7d) ? formatCurrency(coxwell.spendLast7d, "INR") : "-"} | ${Number.isFinite(coxwell.leadsLast7d) ? formatNumber(coxwell.leadsLast7d) : "-"} | ${Number.isFinite(coxwell.spendNdayEstimate) ? formatCurrency(coxwell.spendNdayEstimate, "INR") : "-"} | ${Number.isFinite(coxwell.leadsNdayEstimate) ? formatNumber(coxwell.leadsNdayEstimate) : "-"} |`,
        `| Altis | ${altis.accountId} | ${Number.isFinite(altis.spendToday) ? formatCurrency(altis.spendToday, "INR") : "-"} | ${Number.isFinite(altis.leadsToday) ? formatNumber(altis.leadsToday) : "-"} | ${Number.isFinite(altis.spendLast7d) ? formatCurrency(altis.spendLast7d, "INR") : "-"} | ${Number.isFinite(altis.leadsLast7d) ? formatNumber(altis.leadsLast7d) : "-"} | ${Number.isFinite(altis.spendNdayEstimate) ? formatCurrency(altis.spendNdayEstimate, "INR") : "-"} | ${Number.isFinite(altis.leadsNdayEstimate) ? formatNumber(altis.leadsNdayEstimate) : "-"} |`,
        "",
        `Note: ${days}-day values are estimated from each brand's last 7 days run-rate.`,
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        meta: { rid, mode: "dual-brand-meta-days" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Dual-brand Instagram query (Altis + Coxwell): always return direct data table.
    if (isDualBrandInstagramIntent(normalizedMessage)) {
      const period = detectBestCampaignPeriod(normalizedMessage);
      const allowed = getAllowedMetaAccountIds();
      const coxwellAccountId = String(allowed[0] || "");
      const altisAccountId = String(allowed[1] || allowed[0] || "");

      const runForBrand = async (brand: "Coxwell" | "Altis", accountId: string) => {
        if (!accountId) {
          return {
            brand,
            accountId: "-",
            username: "-",
            followers: NaN,
            mediaCount: NaN,
            bestCaption: "-",
            bestPlays: NaN,
            bestReach: NaN,
            bestSaves: NaN,
            tools: [] as Array<{ name: string; result: any }>,
          };
        }

        const [overview, bestReel] = await Promise.all([
          runTool("get_instagram_account_overview", { account_id: accountId }),
          runTool("get_instagram_best_reel", { account_id: accountId, period }),
        ]);

        const best = bestReel?.best || {};
        const caption = String(best?.caption || "Untitled Reel").trim();
        return {
          brand,
          accountId,
          username: String(overview?.account?.username || "").trim() || "-",
          followers: Number(overview?.account?.followers_count ?? NaN),
          mediaCount: Number(overview?.account?.media_count ?? NaN),
          bestCaption: caption ? caption.slice(0, 50) : "-",
          bestPlays: Number(best?.plays ?? NaN),
          bestReach: Number(best?.reach ?? NaN),
          bestSaves: Number(best?.saved ?? NaN),
          tools: [
            { name: "get_instagram_account_overview", result: overview },
            { name: "get_instagram_best_reel", result: bestReel },
          ],
        };
      };

      const [coxwell, altis] = await Promise.all([
        runForBrand("Coxwell", coxwellAccountId),
        runForBrand("Altis", altisAccountId),
      ]);

      const windowLabel =
        period === "maximum" ? "all time" : period === "this_month" ? "this month" : "today";
      const answer = [
        `Instagram top-post snapshot for Coxwell and Altis (${windowLabel}):`,
        "",
        "| Brand | Account | Username | Followers | Media | Top Reel Plays | Top Reel Reach | Top Reel Saves | Top Reel Caption |",
        "|---|---|---|---:|---:|---:|---:|---:|---|",
        `| Coxwell | ${coxwell.accountId} | ${coxwell.username} | ${Number.isFinite(coxwell.followers) ? formatNumber(coxwell.followers) : "-"} | ${Number.isFinite(coxwell.mediaCount) ? formatNumber(coxwell.mediaCount) : "-"} | ${Number.isFinite(coxwell.bestPlays) ? formatNumber(coxwell.bestPlays) : "-"} | ${Number.isFinite(coxwell.bestReach) ? formatNumber(coxwell.bestReach) : "-"} | ${Number.isFinite(coxwell.bestSaves) ? formatNumber(coxwell.bestSaves) : "-"} | ${coxwell.bestCaption} |`,
        `| Altis | ${altis.accountId} | ${altis.username} | ${Number.isFinite(altis.followers) ? formatNumber(altis.followers) : "-"} | ${Number.isFinite(altis.mediaCount) ? formatNumber(altis.mediaCount) : "-"} | ${Number.isFinite(altis.bestPlays) ? formatNumber(altis.bestPlays) : "-"} | ${Number.isFinite(altis.bestReach) ? formatNumber(altis.bestReach) : "-"} | ${Number.isFinite(altis.bestSaves) ? formatNumber(altis.bestSaves) : "-"} | ${altis.bestCaption} |`,
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [...coxwell.tools, ...altis.tools],
        meta: { rid, mode: `dual-brand-instagram-${period}` },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // Single-brand Instagram insights query: always return direct tool data (no OpenAI dependency).
    if (isInstagramInsightsIntent(normalizedMessage)) {
      const period = detectBestCampaignPeriod(normalizedMessage);
      const periodTool = period === "this_month" || period === "maximum"
        ? "get_instagram_reels_month"
        : "get_instagram_reels_today";

      const [overview, bestReel, reels] = await Promise.all([
        runTool("get_instagram_account_overview", { account_id: effectiveMetaAccountId }),
        runTool("get_instagram_best_reel", { account_id: effectiveMetaAccountId, period }),
        runTool(periodTool, { account_id: effectiveMetaAccountId }),
      ]);

      const windowLabel =
        period === "maximum" ? "all time" : period === "this_month" ? "this month" : "today";
      const account = overview?.account || {};
      const best = bestReel?.best || {};
      const rows = Array.isArray(reels?.top) ? reels.top.slice(0, 5) : [];
      const topRows = rows.length
        ? rows
            .map((r: any, idx: number) => {
              const caption = String(r?.caption || "Untitled Reel").replace(/\s+/g, " ").trim().slice(0, 44);
              const plays = formatNumber(Number(r?.plays ?? 0));
              const reach = formatNumber(Number(r?.reach ?? 0));
              const saved = formatNumber(Number(r?.saved ?? 0));
              return `${idx + 1}. ${caption} | plays ${plays}, reach ${reach}, saves ${saved}`;
            })
            .join("\n")
        : "No reel rows returned for this window.";

      const answer = [
        `Instagram insights snapshot (${windowLabel})`,
        `Account: ${String(account?.username || "(unknown)")}`,
        `Followers: ${formatNumber(Number(account?.followers_count ?? 0))}, Following: ${formatNumber(Number(account?.follows_count ?? 0))}, Media: ${formatNumber(Number(account?.media_count ?? 0))}`,
        `Best reel: ${String(best?.caption || "N/A").slice(0, 70)}`,
        `Best reel metrics: plays ${formatNumber(Number(best?.plays ?? 0))}, reach ${formatNumber(Number(best?.reach ?? 0))}, saves ${formatNumber(Number(best?.saved ?? 0))}, likes ${formatNumber(Number(best?.likes ?? 0))}, comments ${formatNumber(Number(best?.comments ?? 0))}, shares ${formatNumber(Number(best?.shares ?? 0))}`,
        "",
        "Top reels:",
        topRows,
      ].join("\n");

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [
          { name: "get_instagram_account_overview", result: overview },
          { name: "get_instagram_best_reel", result: bestReel },
          { name: periodTool, result: reels },
        ],
        meta: { rid, mode: `direct-instagram-insights-${period}` },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // OpenAI tool-calling path for marketing questions:
    // OpenAI fetches real data via tools first, then writes answer.
    if (isMarketingIntent(normalizedMessage) && process.env.OPENAI_API_KEY) {
      const allowed = getAllowedMetaAccountIds();
      const openaiToolAnswer = await answerFromOpenAIWithTools(
        userMessage,
        (name, args = {}) => runTool(name, args),
        { coxwell: allowed[0], altis: allowed[1] || allowed[0] },
        getOpenAIMinToolCalls()
      );
      if (openaiToolAnswer && openaiToolAnswer.tools.length > 0) {
        const payload: ResponsePayload = {
          ok: true,
          answer: openaiToolAnswer.answer,
          tools: openaiToolAnswer.tools,
          meta: { rid, mode: openaiToolAnswer.mode },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }
    }

    // Priority provider router:
    // If any AI key works (OpenAI/Gemini/Claude), use that first.
    // If all fail, continue with local tool/prompt fallback.
    if (!isMarketingIntent(normalizedMessage)) {
      const providerAnswer = await answerFromAnyProvider(userMessage);
      if (providerAnswer) {
        const payload: ResponsePayload = {
          ok: true,
          answer: providerAnswer.answer,
          meta: { rid, mode: providerAnswer.mode },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }
    }

    // ✅ Fallback: mapping → tools
    // Force monthly spend intent before generic ad-spend mapping.
    if (hasSpendIntent(normalizedMessage) && /(month|monthly)/.test(normalizedMessage)) {
      const result = await runTool("get_meta_spend_month", {});
      const payload: ResponsePayload = {
        ok: true,
        answer: formatToolAnswer("get_meta_spend_month", result),
        tools: [{ name: "get_meta_spend_month", result }],
        meta: { rid, mode: "tool-mapping-month-priority" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    const days = parseRequestedDays(normalizedMessage);
    if (days && hasSpendIntent(normalizedMessage)) {
      const todayResult = await runTool("get_meta_spend_today", {});
      const todaySpend = Number(todayResult?.spend ?? 0);
      const currency = String(todayResult?.currency || "INR");
      const estimate = Number((todaySpend * days).toFixed(2));
      const payload: ResponsePayload = {
        ok: true,
        answer: `Estimated Meta ad spend for ${days} days is ${formatCurrency(
          estimate,
          currency
        )} (based on today's spend run-rate).`,
        tools: [{ name: "get_meta_spend_today", result: todayResult }],
        meta: { rid, mode: "tool-mapping-days-estimate" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    const hours = parseRequestedHours(normalizedMessage);
    if (hours && hasSpendIntent(normalizedMessage)) {
      const todayResult = await runTool("get_meta_spend_today", {});
      const todaySpend = Number(todayResult?.spend ?? 0);
      const currency = String(todayResult?.currency || "INR");
      const estimate = Number(((todaySpend / 24) * hours).toFixed(2));

      const maybeCpl =
        /\bcpl\b/.test(normalizedMessage) ||
        /\b(19[0-9]\.\d+|[1-9]\d?\.\d+)\b/.test(normalizedMessage);

      const note = maybeCpl
        ? " Also, the number you mentioned may be CPL (cost per lead), which is different from spend."
        : "";

      const payload: ResponsePayload = {
        ok: true,
        answer: `Estimated Meta spend for ${hours} hour(s) is ${formatCurrency(
          estimate,
          currency
        )} based on today's run-rate.${note}`,
        tools: [{ name: "get_meta_spend_today", result: todayResult }],
        meta: { rid, mode: "tool-mapping-hours-estimate" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    const tool = mapMessageToTool(normalizedMessage);
    if (tool) {
      const result = await runTool(tool, {});
      const answer =
        tool === "get_meta_best_campaign" && isPoorPerformanceIntent(normalizedMessage)
          ? formatWorstCampaignAnswer(result)
          : formatToolAnswer(tool, result);
      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: [{ name: tool, result }],
        meta: { rid, mode: "tool-mapping" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // For non-marketing/general questions, prefer Gemini directly.
    if (!isMarketingIntent(normalizedMessage)) {
      if (process.env.GEMINI_API_KEY) {
        try {
          const geminiAnswer = await askGemini(userMessage);
          const payload: ResponsePayload = {
            ok: true,
            answer: geminiAnswer,
            meta: { rid, mode: "gemini-fallback" },
          };
          setCachedResponse(responseCacheKey, payload);
          return res.json(payload);
        } catch (gemErr: any) {
          console.error("Gemini fallback failed:", gemErr?.message || gemErr);
        }
      }

      if (process.env.CLAUDE_API_KEY) {
        try {
          const claudeAnswer = await askClaude(userMessage);
          const payload: ResponsePayload = {
            ok: true,
            answer: claudeAnswer,
            meta: { rid, mode: "claude-fallback" },
          };
          setCachedResponse(responseCacheKey, payload);
          return res.json(payload);
        } catch (claudeErr: any) {
          console.error("Claude fallback failed:", claudeErr?.message || claudeErr);
        }
      }

      if (process.env.GEMINI_API_KEY || process.env.CLAUDE_API_KEY) {
        const payload: ResponsePayload = {
          ok: true,
          answer:
            "General AI fallback is temporarily unavailable due to provider quota/rate limit or key configuration. " +
            "Please retry shortly, or ask a marketing/Meta/GA4 question for tool-based answers right now.",
          meta: { rid, mode: "general-ai-unavailable" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      }
    }

    // Prompt retrieval fallback: if question overlaps with multiple stored prompts,
    // collect up to 3 related tools and answer with combined data.
    const related = retrieveRelatedPromptsAndTools(normalizedMessage);
    if (related.tools.length) {
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of related.tools) {
        const result = await runTool(t, {});
        toolResults.push({ name: t, result });
      }

      const lines = toolResults.map((tr, idx) => {
        const line =
          tr.name === "get_meta_best_campaign" && isPoorPerformanceIntent(normalizedMessage)
            ? formatWorstCampaignAnswer(tr.result)
            : formatToolAnswer(tr.name, tr.result);
        return `${idx + 1}. ${line}`;
      });
      const answer = buildAdvisorAnswer(normalizedMessage, toolResults);

      const payload: ResponsePayload = {
        ok: true,
        answer,
        tools: toolResults,
        meta: { rid, mode: "prompt-retrieval-multi-tool", matched_prompts: related.matchedPrompts.slice(0, 3) },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // If tools did not match, try Gemini (free-tier friendly) as general fallback.
    if (process.env.GEMINI_API_KEY) {
      try {
        const geminiAnswer = await askGemini(userMessage);
        const payload: ResponsePayload = {
          ok: true,
          answer: geminiAnswer,
          meta: { rid, mode: "gemini-fallback" },
        };
        setCachedResponse(responseCacheKey, payload);
        return res.json(payload);
      } catch (gemErr: any) {
        console.error("Gemini fallback failed:", gemErr?.message || gemErr);
      }
    }

    if (isMarketingIntent(normalizedMessage)) {
      const fallbackTools = defaultToolBundleForMessage(normalizedMessage);
      const toolResults: Array<{ name: string; result: any }> = [];
      for (const t of fallbackTools) {
        const result = await runTool(t, {});
        toolResults.push({ name: t, result });
      }

      const payload: ResponsePayload = {
        ok: true,
        answer: buildAdvisorAnswer(normalizedMessage, toolResults),
        tools: toolResults,
        meta: { rid, mode: "marketing-default-bundle" },
      };
      setCachedResponse(responseCacheKey, payload);
      return res.json(payload);
    }

    // If no mapping found
    const payload: ResponsePayload = {
      ok: true,
      answer: fallbackUniversalAnswer(userMessage),
      meta: { rid, mode: "no-match" },
    };
    setCachedResponse(responseCacheKey, payload);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

export default router;
