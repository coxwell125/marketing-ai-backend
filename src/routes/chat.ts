// src/routes/chat.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { getOpenAITools, runToolByName } from "../services/toolIntegration";

const router = Router();

const ChatBodySchema = z.object({
  message: z.string().min(1, "message is required"),
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

// ✅ deterministic mapping so UI works even without OpenAI
function mapMessageToTool(message: string): string | null {
  const m = message.toLowerCase();

  // Meta
  if (m.includes("best campaign") || (m.includes("campaign") && m.includes("best")))
    return "get_meta_best_campaign";

  if (m.includes("leads") && m.includes("today")) return "get_meta_leads_today";
  if (m.includes("spend") && m.includes("today")) return "get_meta_spend_today";
  if (m.includes("spend") && (m.includes("month") || m.includes("this month")))
    return "get_meta_spend_month";

  // GA4
  if ((m.includes("active users") || m.includes("active user")) && m.includes("today"))
    return "get_ga4_active_users_today";

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

    // If user explicitly says "Run <tool>"
    const runMatch = userMessage.match(/^run\s+([a-zA-Z0-9_]+)\s*$/i);
    if (runMatch) {
      const tool = runMatch[1];
      const result = await runToolByName(tool, {});
      return res.json({
        ok: true,
        answer: JSON.stringify(result, null, 2),
        tools: [{ name: tool, result }],
        meta: { rid, mode: "direct-tool" },
      });
    }

    // ✅ Try OpenAI ONLY if you want, but DO NOT crash if it fails
    if (process.env.OPENAI_API_KEY) {
      try {
        const tools = getOpenAITools();

        const first = await openai.chat.completions.create({
          model: getModel(),
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You are an internal Marketing AI Assistant. Always use tools for Meta/GA4 questions. Do not hallucinate.",
            },
            { role: "user", content: userMessage },
          ],
          tools,
          tool_choice: "auto",
        });

        const msg = first.choices?.[0]?.message;
        const toolCalls = msg?.tool_calls || [];

        // No tool call → return model text
        if (!toolCalls.length) {
          return res.json({ ok: true, answer: msg?.content || "", meta: { rid, used_tools: [] } });
        }

        // Execute tool calls
        const toolResults: Array<{ name: string; result: any }> = [];
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          const name = tc.function.name;

          let args: any = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }

          const result = await runToolByName(name, args);
          toolResults.push({ name, result });
        }

        // Final phrasing
        const second = await openai.chat.completions.create({
          model: getModel(),
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Use tool outputs only. Be short, factual, include key numbers.",
            },
            { role: "user", content: userMessage },
            ...(toolCalls.map((tc) => ({ role: "assistant" as const, tool_calls: [tc], content: "" })) as any),
            ...toolResults.map((tr, idx) => ({
              role: "tool" as const,
              tool_call_id: toolCalls[idx]?.id,
              content: JSON.stringify(tr.result),
            })),
          ],
        });

        const finalText = second.choices?.[0]?.message?.content || "";
        return res.json({ ok: true, answer: finalText, tools: toolResults, meta: { rid, mode: "openai" } });
      } catch (err: any) {
        console.error("⚠️ OpenAI failed, using tool-mapping fallback:", err?.message || err);
      }
    }

    // ✅ Fallback: mapping → tools
    const tool = mapMessageToTool(userMessage);
    if (tool) {
      const result = await runToolByName(tool, {});
      return res.json({
        ok: true,
        answer: JSON.stringify(result, null, 2),
        tools: [{ name: tool, result }],
        meta: { rid, mode: "tool-mapping" },
      });
    }

    // If no mapping found
    return res.json({
      ok: true,
      answer:
        "Try: 'Meta leads today', 'Meta spend today', 'Meta spend this month', 'Best campaign today', or 'Run get_meta_best_campaign'.",
      meta: { rid, mode: "no-match" },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;