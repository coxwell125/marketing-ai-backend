// src/server.ts
import dotenv from "dotenv";
dotenv.config({ override: true });

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import net from "net";

import chatRouter from "./routes/chat";
import toolsRouter from "./routes/tools";
import { requireApiKey, requireRole, type UserRole } from "./services/auth";
import { getMetricsSnapshot, recordRequestMetric, resetMetrics } from "./services/metrics";
import { getAllowedMetaAccountIds } from "./services/metaTenant";
import { getInstagramAccountOverview, verifyMetaToken } from "./services/metaApi";
import { debugGa4Tag, verifyGa4Setup } from "./services/ga4Api";
import { getFollowerHistory } from "./services/followerHistory";

const app = express();

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeIp(ip: string): string {
  const v = String(ip || "").trim();
  if (!v) return "";
  if (v === "::1") return "127.0.0.1";
  return v.replace(/^::ffff:/, "");
}

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0)) >>> 0;
}

function isIpv4CidrMatch(candidateIp: string, cidr: string): boolean {
  const [baseRaw, prefixRaw] = cidr.split("/");
  const base = parseIpv4ToInt(baseRaw || "");
  const candidate = parseIpv4ToInt(candidateIp);
  const prefix = Number(prefixRaw);
  if (base === null || candidate === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (base & mask) === (candidate & mask);
}

function isIpAllowed(ip: string, allowlist: string[], xForwardedFor?: string): boolean {
  if (!allowlist.length) return true;
  const primary = normalizeIp(ip);
  const fromHeader = String(xForwardedFor || "")
    .split(",")
    .map((x) => normalizeIp(x))
    .filter(Boolean);
  const candidates = Array.from(new Set([primary, ...fromHeader].filter(Boolean)));

  return candidates.some((candidate) =>
    allowlist.some((allowedRaw) => {
      const allowed = normalizeIp(allowedRaw);
      if (!allowed) return false;
      if (allowed.includes("/")) return isIpv4CidrMatch(candidate, allowed);
      if (allowed === "localhost") return candidate === "127.0.0.1";
      if (net.isIP(allowed) === 0) return false;
      return allowed === candidate;
    })
  );
}

const corsOrigin = process.env.CORS_ORIGIN?.trim();
const requireOriginMatch = String(process.env.REQUIRE_ORIGIN_MATCH || "false").toLowerCase() === "true";
const allowedIps = parseCsvEnv(process.env.ALLOWED_IPS);
const disablePublicUi = String(process.env.DISABLE_PUBLIC_UI || "false").toLowerCase() === "true";
const protectUiWithAuth = String(process.env.PROTECT_UI_WITH_AUTH || "false").toLowerCase() === "true";

function getUiMinRole(): UserRole {
  const raw = String(process.env.UI_MIN_ROLE || "admin").trim().toLowerCase();
  if (raw === "viewer" || raw === "analyst" || raw === "admin") return raw;
  return "admin";
}
const uiMinRole = getUiMinRole();

if (String(process.env.TRUST_PROXY || "true").toLowerCase() !== "false") {
  app.set("trust proxy", true);
}

app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
app.use(express.json({ limit: "1mb" }));
if (!disablePublicUi && !protectUiWithAuth) {
  app.use(express.static("public"));
}
app.disable("x-powered-by");

// basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:;"
  );
  const forwardedProto = String(req.header("x-forwarded-proto") || "").toLowerCase();
  if (req.secure || forwardedProto === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Optional network hardening for production deployments.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (allowedIps.length) {
    const ip = req.ip || req.socket.remoteAddress || "";
    const xff = req.header("x-forwarded-for") || "";
    if (!isIpAllowed(ip, allowedIps, xff)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
  }

  if (requireOriginMatch && corsOrigin) {
    const origin = String(req.header("origin") || "").trim();
    // Enforce only for browser requests that send Origin.
    if (origin && origin !== corsOrigin) {
      return res.status(403).json({ ok: false, error: "Origin not allowed" });
    }
  }

  return next();
});

// request id (useful for logs)
app.use((req: Request, _res: Response, next: NextFunction) => {
  const rid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  (req as any).rid = rid;
  _res.setHeader("X-Request-Id", rid);
  next();
});

// lightweight in-memory rate limiter by api-key/ip with per-route buckets
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const RATE_MAX_CHAT = Number(process.env.RATE_LIMIT_MAX_CHAT || 120);
const RATE_MAX_TOOLS = Number(process.env.RATE_LIMIT_MAX_TOOLS || 400);
const rateState = new Map<string, { count: number; resetAt: number }>();

function getRateBucket(req: Request): "chat" | "tools" | "other" {
  const p = String(req.originalUrl || req.baseUrl || req.path || "");
  if (p.startsWith("/api/chat")) return "chat";
  if (p.startsWith("/api/tools")) return "tools";
  return "other";
}

const RATE_CLEANUP_MS = Math.max(15_000, Math.min(RATE_WINDOW_MS, 60_000));
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateState.entries()) {
    if (now >= v.resetAt) rateState.delete(k);
  }
}, RATE_CLEANUP_MS);

app.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.header("x-api-key") || "";
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = getRateBucket(req);
  const key = `${apiKey || "anon"}|${ip}|${bucket}`;
  const bucketMax = bucket === "tools" ? RATE_MAX_TOOLS : bucket === "chat" ? RATE_MAX_CHAT : RATE_MAX;
  const now = Date.now();
  const curr = rateState.get(key);

  if (!curr || now >= curr.resetAt) {
    rateState.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  curr.count += 1;
  if (curr.count > bucketMax) {
    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded",
      bucket,
      retry_after_seconds: Math.max(1, Math.ceil((curr.resetAt - now) / 1000)),
    });
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

// Public root landing: avoid confusing Unauthorized at bare domain when auth is enabled.
app.get("/", (_req, res) => {
  if (disablePublicUi) {
    return res.status(200).json({
      ok: true,
      service: "marketing-ai-backend",
      message: "API is running. Use /health for status and /api/* with x-api-key for protected routes.",
    });
  }

  if (protectUiWithAuth) {
    return res.status(200).json({
      ok: true,
      service: "marketing-ai-backend",
      message: "UI/API is protected. Provide x-api-key to access /ui and /api/* routes.",
      ui: "/ui",
      health: "/health",
    });
  }

  return res.redirect(302, "/ui");
});

app.get(
  "/ui",
  ...(protectUiWithAuth ? [requireApiKey, requireRole(uiMinRole)] : []),
  (_req, res) => {
    if (disablePublicUi) return res.status(404).json({ ok: false, error: "Not Found" });
    res.sendFile(require("path").join(process.cwd(), "public", "index.html"));
  }
);

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

app.get("/api/instagram/followers/history", async (req, res) => {
  const accountId = String(req.query.account_id || req.header("x-meta-account-id") || "").trim();
  const daysRaw = Number(req.query.days || 30);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 30;
  if (!accountId) {
    return res.status(400).json({ ok: false, error: "account_id is required" });
  }
  const rows = await getFollowerHistory(accountId, days);
  return res.json({ ok: true, account_id: accountId, days, count: rows.length, rows });
});

app.post("/api/instagram/followers/snapshot", async (_req, res) => {
  const accounts = getAllowedMetaAccountIds();
  const out: any[] = [];
  for (const accountId of accounts) {
    try {
      const snap = await getInstagramAccountOverview(accountId);
      out.push({
        ok: true,
        account_id: accountId,
        username: snap?.account?.username || "",
        followers_count: snap?.account?.followers_count ?? null,
        captured_at: snap?.as_of_ist || null,
      });
    } catch (err: any) {
      out.push({ ok: false, account_id: accountId, error: String(err?.message || err) });
    }
  }
  return res.json({ ok: true, snapshots: out });
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
  const rid = (_req as any)?.rid || "unknown";
  console.error(`[${rid}] Unhandled error:`, err?.message || err);
  res.status(500).json({ ok: false, error: "Internal Server Error" });
});

const port = Number(process.env.PORT || 8080);

export function startServer() {
  return app.listen(port, () => {
    if (process.env.NODE_ENV === "production") {
      const k = String(process.env.INTERNAL_API_KEY || "");
      if (k && k.length < 24) {
        console.warn("Security warning: INTERNAL_API_KEY is too short; use a longer random secret.");
      }
      if (!process.env.CORS_ORIGIN) {
        console.warn("Security warning: CORS_ORIGIN is not set in production.");
      }
      if (!allowedIps.length) {
        console.warn("Security warning: ALLOWED_IPS is not set; service is publicly reachable.");
      }
    }
    console.log("Auth keys mode:", process.env.API_KEYS_JSON ? "API_KEYS_JSON" : "INTERNAL_API_KEY");
    console.log(`Backend running on port ${port}`);
  });
}

if (require.main === module) {
  const server = startServer();
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, starting graceful shutdown...`);
    clearInterval(rateCleanupTimer);
    server.close((err?: Error) => {
      if (err) {
        console.error("Graceful shutdown failed:", err.message);
        process.exit(1);
      }
      console.log("HTTP server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced shutdown timeout reached.");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export default app;
