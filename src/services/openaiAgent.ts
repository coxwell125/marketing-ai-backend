import OpenAI from "openai";
import { McpClient } from "./mcpClient";

type RunAgentArgs = {
  message: string;
  rid?: string;
};

type ToolCallLog = {
  tool: string;
  args: any;
  ok: boolean;
  error?: string;
};

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "marketing_test",
      description: "Test MCP tool call; returns a hello response",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
];

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing in environment variables");
  return new OpenAI({ apiKey });
}

function safeJsonParse(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

/**
 * MCP-only fallback router for Phase 1.
 * If OpenAI fails (429), we detect tool name in message and call MCP directly.
 */
async function mcpFallbackRouter(message: string): Promise<{ answer: string; toolCalls: ToolCallLog[] }> {
  const toolCalls: ToolCallLog[] = [];

  const msg = message.toLowerCase();

  // ✅ Phase 1 supported tools (add more later)
  const toolMap: Record<string, { tool: string; args: any }> = {
    "marketing_test": { tool: "marketing_test", args: { message: "hello" } },
    // Later examples:
    // "get_meta_spend_today": { tool: "get_meta_spend_today", args: {} },
    // "get_meta_leads_today": { tool: "get_meta_leads_today", args: {} },
  };

  // Detect tool keyword
  const detected = Object.keys(toolMap).find((k) => msg.includes(k));

  if (!detected) {
    return {
      answer:
        "OpenAI is rate-limited (429). Fallback mode is ON, but I couldn’t detect a tool name in your message.\nTry: 'Call marketing_test and say hello'",
      toolCalls,
    };
  }

  const { tool, args } = toolMap[detected];

  try {
    const mcp = new McpClient(process.env.MCP_BASE_URL || "https://claude-marketing-mcp.onrender.com");
    const res = await mcp.callTool(tool, args);
    toolCalls.push({ tool, args, ok: true });

    return {
      answer: `MCP fallback success ✅\nTool: ${tool}\nResult: ${JSON.stringify(res)}`,
      toolCalls,
    };
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    toolCalls.push({ tool, args, ok: false, error: errMsg });

    return {
      answer: `MCP fallback failed ❌\nTool: ${tool}\nError: ${errMsg}`,
      toolCalls,
    };
  }
}

export async function runAgent({ message, rid }: RunAgentArgs): Promise<{ answer: string; toolCalls: ToolCallLog[] }> {
  const toolCalls: ToolCallLog[] = [];

  try {
    const client = getClient();

    const first = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a marketing assistant. Use tools when needed." },
        { role: "user", content: message },
      ],
      tools,
      tool_choice: "auto",
    });

    const assistantMsg = first.choices[0]?.message;

    if (!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) {
      return { answer: assistantMsg?.content || "No response.", toolCalls };
    }

    const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const tc of assistantMsg.tool_calls) {
      if (tc.type !== "function") continue;

      const toolName = tc.function.name;
      const args = safeJsonParse(tc.function.arguments);

      try {
        const mcp = new McpClient(process.env.MCP_BASE_URL || "https://claude-marketing-mcp.onrender.com");
        const mcpRes = await mcp.callTool(toolName, args);
        toolCalls.push({ tool: toolName, args, ok: true });

        toolResultMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(mcpRes),
        });
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        toolCalls.push({ tool: toolName, args, ok: false, error: errMsg });

        toolResultMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: errMsg }),
        });
      }
    }

    const second = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a marketing assistant. Summarize tool results clearly." },
        { role: "user", content: message },
        assistantMsg,
        ...toolResultMessages,
      ],
    });

    return {
      answer: second.choices[0]?.message?.content || "No response.",
      toolCalls,
    };
  } catch (err: any) {
    const status = err?.status || err?.response?.status;

    // ✅ If OpenAI fails (429), use MCP-only fallback
    if (status === 429) {
      return await mcpFallbackRouter(message);
    }

    throw err;
  }
}
