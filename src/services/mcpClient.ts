// src/services/mcpClient.ts
import "dotenv/config";

type JsonRpcResponse = {
  result?: any;
  error?: { code: number; message: string; data?: any };
};

function buildMcpUrl(baseUrl: string) {
  return baseUrl.replace(/\/mcp\/?$/, "") + "/mcp";
}

// Extract JSON from either:
// 1) pure JSON body
// 2) SSE body: lines like "event: message\n" + "data: {...}\n"
function parseMaybeSseJson(text: string): JsonRpcResponse {
  const trimmed = text.trim();

  // Case 1: pure JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }

  // Case 2: SSE - collect all `data:` lines
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.replace(/^data:\s?/, "").trim())
    .filter(Boolean);

  // Some servers may send multiple data events; last one usually contains final payload
  const last = dataLines[dataLines.length - 1];
  if (!last) throw new Error(`MCP Invalid SSE response (no data lines): ${text}`);

  return JSON.parse(last) as JsonRpcResponse;
}

export class McpClient {
  constructor(private baseUrl: string) {}

  private async postJsonRpc(body: any) {
    const url = buildMcpUrl(this.baseUrl);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // required by your MCP server
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${text}`);
    }

    let json: JsonRpcResponse;
    try {
      json = parseMaybeSseJson(text);
    } catch (e: any) {
      throw new Error(`MCP Invalid JSON response: ${text}`);
    }

    if (json.error) {
      throw new Error(`MCP Error ${json.error.code}: ${json.error.message}`);
    }

    return json.result;
  }

  async callTool(name: string, args: Record<string, any>) {
    return this.postJsonRpc({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args ?? {} },
    });
  }

  async listTools() {
    return this.postJsonRpc({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
      params: {},
    });
  }
}

export function parseMcpToolOutput(raw: any) {
  const out = { answer: "", json: [] as any[], data: null as any };

  const content = raw?.content ?? raw?.result?.content ?? [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      const t = item.text.trim();
      out.answer += (out.answer ? "\n" : "") + t;

      try {
        const parsed = JSON.parse(t);
        out.json.push(parsed);
        if (out.data === null) out.data = parsed;
      } catch {
        // not JSON, ignore
      }
    }
  }

  return out;
}

const MCP_BASE_URL =
  process.env.MCP_BASE_URL ||
  (process.env.MCP_SERVER_URL ? process.env.MCP_SERVER_URL.replace(/\/mcp\/?$/, "") : "");

export async function callMcpTool(toolName: string, args: Record<string, any> = {}) {
  if (!MCP_BASE_URL) throw new Error("MCP_BASE_URL (or MCP_SERVER_URL) is not set");

  const client = new McpClient(MCP_BASE_URL);
  const raw = await client.callTool(toolName, args);

  const parsed = parseMcpToolOutput(raw);

  if (parsed.data !== null) return parsed.data;
  if (parsed.json.length) return { ok: true, tool: toolName, data: parsed.json };
  if (parsed.answer) return { ok: true, tool: toolName, text: parsed.answer };

  return { ok: true, tool: toolName, _mcp_raw: raw };
}

export async function mcpToolsList() {
  if (!MCP_BASE_URL) throw new Error("MCP_BASE_URL (or MCP_SERVER_URL) is not set");
  const client = new McpClient(MCP_BASE_URL);
  return client.listTools();
}
