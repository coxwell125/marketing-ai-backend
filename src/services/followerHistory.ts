type FollowerSnapshot = {
  account_id: string;
  ig_business_account_id: string;
  username: string;
  followers_count: number;
  captured_at: string;
  day_ist: string;
};

const MAX_SNAPSHOTS_PER_ACCOUNT = 180;
const kvCache = new Map<string, FollowerSnapshot[]>();

function toIstDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60_000;
  const istMs = utcMs + 5.5 * 60 * 60_000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isKvEnabled(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function kvKey(accountId: string): string {
  return `mai:follower_history:${accountId}`;
}

async function kvGetJson<T>(key: string): Promise<T | null> {
  const url = String(process.env.KV_REST_API_URL || "").trim();
  const token = String(process.env.KV_REST_API_TOKEN || "").trim();
  if (!url || !token) return null;

  const endpoint = `${url.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const raw = json?.result;
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function kvSetJson(key: string, value: unknown): Promise<void> {
  const url = String(process.env.KV_REST_API_URL || "").trim();
  const token = String(process.env.KV_REST_API_TOKEN || "").trim();
  if (!url || !token) return;
  const serialized = JSON.stringify(value);
  const endpoint = `${url.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(serialized)}`;
  await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
}

async function loadHistory(accountId: string): Promise<FollowerSnapshot[]> {
  const key = kvKey(accountId);

  if (isKvEnabled()) {
    const list = await kvGetJson<FollowerSnapshot[]>(key);
    return Array.isArray(list) ? list : [];
  }

  if (kvCache.has(key)) return kvCache.get(key) || [];
  return [];
}

async function saveHistory(accountId: string, rows: FollowerSnapshot[]): Promise<void> {
  const key = kvKey(accountId);
  if (isKvEnabled()) {
    await kvSetJson(key, rows);
    return;
  }
  kvCache.set(key, rows);
}

export async function recordFollowerSnapshot(input: {
  account_id: string;
  ig_business_account_id: string;
  username: string;
  followers_count: number;
  captured_at?: string;
}): Promise<void> {
  const accountId = String(input.account_id || "").trim();
  if (!accountId) return;

  const capturedAt = String(input.captured_at || new Date().toISOString());
  const dayIst = toIstDay(capturedAt);
  if (!dayIst) return;

  const rows = await loadHistory(accountId);
  const next: FollowerSnapshot = {
    account_id: accountId,
    ig_business_account_id: String(input.ig_business_account_id || ""),
    username: String(input.username || ""),
    followers_count: Number(input.followers_count || 0),
    captured_at: capturedAt,
    day_ist: dayIst,
  };

  // Keep one snapshot per day in IST; overwrite same-day with latest capture.
  const idx = rows.findIndex((r) => r.day_ist === dayIst);
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);

  rows.sort((a, b) => a.day_ist.localeCompare(b.day_ist));
  const trimmed = rows.slice(-MAX_SNAPSHOTS_PER_ACCOUNT);
  await saveHistory(accountId, trimmed);
}

export async function getFollowerHistory(accountId: string, days = 30): Promise<FollowerSnapshot[]> {
  const rows = await loadHistory(accountId);
  if (!rows.length) return [];
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  return rows.slice(-n);
}

