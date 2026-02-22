import { Router, Request, Response, NextFunction } from "express";
import { McpClient } from "../services/mcpClient";

const router = Router();
const mcp = new McpClient(process.env.MCP_BASE_URL || "https://claude-marketing-mcp.onrender.com");

// This endpoint calls MCP "tools/list" to show available tools + input schema
router.get("/mcp/tools", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await mcp.listTools();
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

export default router;
