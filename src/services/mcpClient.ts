import { randomUUID } from "crypto";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

export async function callMcpTool(toolName: string, args: Record<string, any>) {
  const mcpUrl = process.env.MCP_URL;
  if (!mcpUrl) throw new Error("MCP_URL is missing");

  const payload: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args, // if your MCP expects string, change to JSON.stringify(args)
    },
  };

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as JsonRpcResponse;

  if (json.error) {
    throw new Error(`MCP JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
}
