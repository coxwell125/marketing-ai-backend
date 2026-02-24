// src/routes/chat.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { getOpenAITools, runToolByName } from "../services/toolIntegration";

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
    temperature: 0.4,
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
    .replace(/\badd\b/g, "ad")
    .replace(/\badds\b/g, "ads")
    .replace(/\bspen\b/g, "spend")
    .replace(/\bspnd\b/g, "spend")
    .replace(/\bmontly\b/g, "monthly")
    .replace(/\bmonhth?\b/g, "month")
    .replace(/\bmnth\b/g, "month")
    .replace(/\btdy\b/g, "today")
    .replace(/\bystr?day\b/g, "yesterday")
    .replace(/\byday\b/g, "yesterday")
    .replace(/\byest\b/g, "yesterday")
    .replace(/\bga ?4\b/g, "ga4")
    .replace(/\binstgram\b/g, "instagram")
    .replace(/\binsta gram\b/g, "instagram")
    .replace(/\s+/g, " ")
    .trim();
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
    const responseCacheKey = normalizedMessage;
    const wantsComparison = isComparisonIntent(normalizedMessage);
    const toolContext = {
      metaAccountId: req.header("x-meta-account-id") || undefined,
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

    // Priority provider router:
    // If any AI key works (OpenAI/Gemini/Claude), use that first.
    // If all fail, continue with local tool/prompt fallback.
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
