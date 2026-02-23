import { Request, Response, NextFunction } from "express";

export type UserRole = "viewer" | "analyst" | "admin";

const ROLE_WEIGHT: Record<UserRole, number> = {
  viewer: 1,
  analyst: 2,
  admin: 3,
};

type KeyMap = Record<string, UserRole>;

function isRole(v: string): v is UserRole {
  return v === "viewer" || v === "analyst" || v === "admin";
}

function parseKeyMapFromEnv(): KeyMap {
  const raw = process.env.API_KEYS_JSON;
  const out: KeyMap = {};

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, role] of Object.entries(parsed || {})) {
        if (!k) continue;
        out[k] = isRole(role) ? role : "viewer";
      }
    } catch {
      // ignore malformed JSON and fall back to INTERNAL_API_KEY
    }
  }

  const internal = process.env.INTERNAL_API_KEY;
  if (internal && !out[internal]) out[internal] = "admin";
  return out;
}

function getApiKeyFromRequest(req: Request): string {
  return String(req.header("x-api-key") || "");
}

export function getRoleForApiKey(key: string): UserRole | null {
  const map = parseKeyMapFromEnv();
  return map[key] || null;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const map = parseKeyMapFromEnv();
  if (!Object.keys(map).length) {
    (req as any).auth = { role: "admin" as UserRole, key: "" };
    return next();
  }

  const key = getApiKeyFromRequest(req);
  const role = key ? map[key] : null;
  if (!role) return res.status(401).json({ ok: false, error: "Unauthorized" });

  (req as any).auth = { role, key };
  return next();
}

export function requireRole(minRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role: UserRole = (req as any)?.auth?.role || "viewer";
    if (ROLE_WEIGHT[role] < ROLE_WEIGHT[minRole]) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    return next();
  };
}

