// src/server.ts
import "dotenv/config";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

import chatRouter from "./routes/chat";
import toolsRouter from "./routes/tools";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// request id (useful for logs)
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).rid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  next();
});

// health is public
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "marketing-ai-backend" });
});
app.get("/ui", (_req, res) => {
  res.sendFile(require("path").join(process.cwd(), "public", "index.html"));
});

// 🔐 API Key Middleware
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const expectedKey = process.env.INTERNAL_API_KEY;

  // allow if not set
  if (!expectedKey) return next();

  const key = req.header("x-api-key");
  if (!key || key !== expectedKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

// protect everything below
app.use(requireApiKey);

// ✅ Tool runner (direct tool execution)
app.use("/api/tools", toolsRouter);

// ✅ Chat endpoint (OpenAI tool calling)
app.use("/api/chat", chatRouter);

// basic error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err?.message || err);
  res.status(500).json({ ok: false, error: "Internal Server Error" });
});

const port = Number(process.env.PORT || 8080);

app.listen(port, () => {
  console.log("INTERNAL_API_KEY loaded as:", process.env.INTERNAL_API_KEY);
  console.log(`✅ Backend running on port ${port}`);
});
