// src/server.ts
import dotenv from "dotenv";
dotenv.config({ override: true });

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

import chatRouter from "./routes/chat";
import toolsRouter from "./routes/tools";
import { requireApiKey, requireRole } from "./services/auth";
import { getMetricsSnapshot, recordRequestMetric, resetMetrics } from "./services/metrics";
import { getAllowedMetaAccountIds } from "./services/metaTenant";
import { verifyMetaToken } from "./services/metaApi";
import { debugGa4Tag, verifyGa4Setup } from "./services/ga4Api";

const app = express();

const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.disable("x-powered-by");

// basic security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// request id (useful for logs)
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).rid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  next();
});

// lightweight in-memory rate limiter by api-key/ip
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const rateState = new Map<string, { count: number; resetAt: number }>();

app.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.header("x-api-key") || "";
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const key = `${apiKey || "anon"}|${ip}`;
  const now = Date.now();
  const curr = rateState.get(key);

  if (!curr || now >= curr.resetAt) {
    rateState.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  curr.count += 1;
  if (curr.count > RATE_MAX) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }

  return next();
});

// request telemetry
app.use((req: Request, res: Response, next: NextFunction) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ended = process.hrtime.bigint();
    const durationMs = Number(ended - started) / 1_000_000;
    recordRequestMetric({
      method: req.method,
      routePath: req.path,
      statusCode: res.statusCode,
      durationMs,
    });
  });
  next();
});

// health is public
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "marketing-ai-backend" });
});

app.get("/ui", (_req, res) => {
  res.sendFile(require("path").join(process.cwd(), "public", "index.html"));
});

// protect everything below
app.use(requireApiKey);

// Tool runner (direct tool execution)
app.use("/api/tools", toolsRouter);

// Chat endpoint
app.use("/api/chat", chatRouter);

// tenant metadata
app.get("/api/meta/accounts", (_req, res) => {
  const accounts = getAllowedMetaAccountIds();
  res.json({ ok: true, accounts, default_account: accounts[0] || null });
});
app.get("/api/meta/verify-token", async (req, res) => {
  const accountId = req.header("x-meta-account-id") || undefined;
  const result = await verifyMetaToken(accountId);
  return res.status(result.ok ? 200 : 400).json(result);
});
app.get("/api/ga4/verify", async (_req, res) => {
  const result = await verifyGa4Setup();
  return res.status(result.ok ? 200 : 400).json(result);
});
app.get("/api/ga4/debug-tag", async (_req, res) => {
  const result = await debugGa4Tag();
  return res.status(result.ok ? 200 : 400).json(result);
});

// admin monitoring endpoints (RBAC protected)
app.get("/api/admin/metrics", requireRole("admin"), (_req, res) => {
  res.json(getMetricsSnapshot());
});

app.post("/api/admin/metrics/reset", requireRole("admin"), (_req, res) => {
  resetMetrics();
  res.json({ ok: true });
});

// basic error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err?.message || err);
  res.status(500).json({ ok: false, error: "Internal Server Error" });
});

const port = Number(process.env.PORT || 8080);

export function startServer() {
  return app.listen(port, () => {
    console.log("Auth keys mode:", process.env.API_KEYS_JSON ? "API_KEYS_JSON" : "INTERNAL_API_KEY");
    console.log(`Backend running on port ${port}`);
  });
}

if (require.main === module) {
  startServer();
}

export default app;
