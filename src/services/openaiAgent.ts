import OpenAI from "openai";
import { callMcpTool } from "./mcpClient";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools: any[] = [
  {
    type: "function",
    name: "marketing_test",
    description: "Sanity test tool. Calls MCP tool marketing_test.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Any short test message" }
      },
      required: ["message"],
      additionalProperties: false
    }
  }
];

export async function runMarketingAgent(userMessage: string) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1";

  const input: any[] = [
    { role: "user", content: userMessage }
  ];

  let response: any;
  try {
    response = await client.responses.create({
      model,
      tools,
      input
    });
  } catch (e: any) {
    throw new Error(e?.error?.message || e?.message || "OpenAI request failed");
  }

  while (true) {
    const output: any[] = response.output || [];
    const toolCalls = output.filter((it: any) => it.type === "function_call");

    if (toolCalls.length === 0) break;

    // Keep model outputs in context
    for (const item of output) input.push(item);

    // Execute tool calls
    for (const call of toolCalls) {
      const toolName = call.name as string;

      let args: any = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }

      const result = await callMcpTool(toolName, args);

      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }

    try {
      response = await client.responses.create({
        model,
        tools,
        input
      });
    } catch (e: any) {
      throw new Error(e?.error?.message || e?.message || "OpenAI request failed");
    }
  }

  return { text: response.output_text ?? "" };
}
