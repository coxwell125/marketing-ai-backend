type EndpointAgg = {
  count: number;
  errorCount: number;
  totalMs: number;
  maxMs: number;
};

const byEndpoint = new Map<string, EndpointAgg>();
let totalRequests = 0;
let totalErrors = 0;
let startedAt = new Date().toISOString();

function key(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

export function recordRequestMetric(input: {
  method: string;
  routePath: string;
  statusCode: number;
  durationMs: number;
}) {
  totalRequests += 1;
  if (input.statusCode >= 400) totalErrors += 1;

  const k = key(input.method, input.routePath);
  const curr = byEndpoint.get(k) || { count: 0, errorCount: 0, totalMs: 0, maxMs: 0 };
  curr.count += 1;
  if (input.statusCode >= 400) curr.errorCount += 1;
  curr.totalMs += input.durationMs;
  curr.maxMs = Math.max(curr.maxMs, input.durationMs);
  byEndpoint.set(k, curr);
}

export function getMetricsSnapshot() {
  const endpoints = Array.from(byEndpoint.entries()).map(([k, v]) => ({
    endpoint: k,
    count: v.count,
    error_count: v.errorCount,
    avg_ms: Number((v.totalMs / Math.max(1, v.count)).toFixed(2)),
    max_ms: Number(v.maxMs.toFixed(2)),
  }));

  endpoints.sort((a, b) => b.count - a.count);

  return {
    ok: true,
    service: "marketing-ai-backend",
    started_at: startedAt,
    generated_at: new Date().toISOString(),
    totals: {
      requests: totalRequests,
      errors: totalErrors,
      error_rate_pct: totalRequests ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
    },
    endpoints,
  };
}

export function resetMetrics() {
  byEndpoint.clear();
  totalRequests = 0;
  totalErrors = 0;
  startedAt = new Date().toISOString();
}

