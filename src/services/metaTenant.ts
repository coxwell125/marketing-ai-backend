export type UserRole = "viewer" | "analyst" | "admin";

function normalizeAccountId(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  return v.startsWith("act_") ? v : `act_${v}`;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((x) => normalizeAccountId(x))
    .filter(Boolean);
}

export function getAllowedMetaAccountIds(): string[] {
  const primary = normalizeAccountId(process.env.META_AD_ACCOUNT_ID || "");
  const listed = splitCsv(process.env.META_AD_ACCOUNT_IDS);
  const merged = [...listed];
  if (primary) merged.push(primary);
  return Array.from(new Set(merged));
}

export function resolveMetaAccountId(requested?: string): string {
  const allowed = getAllowedMetaAccountIds();
  if (!allowed.length) throw new Error("No Meta ad account configured");
  if (!requested) return allowed[0];

  const normalized = normalizeAccountId(requested);
  if (!allowed.includes(normalized)) {
    throw new Error(`Meta account not allowed: ${normalized}`);
  }
  return normalized;
}

