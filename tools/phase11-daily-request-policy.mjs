// Bound large daily uploads without relaxing authentication or verification.
export function dailyRequestPolicy(method, body) {
  const policy = { attempts: 8, baseDelayMs: 1000, timeoutMs: 120_000 };
  if (method !== 'PUT') return policy;
  if (typeof body !== 'string') throw new TypeError('Daily PUT requires a serialized JSON body');
  const bytes = Buffer.byteLength(body, 'utf8');
  // Observed upload throughput fell below 1 Mbps. Budget at 0.75 Mbps,
  // including 30 seconds for connection/response, capped at ten minutes.
  return { ...policy, attempts: 3, timeoutMs: Math.min(600_000, Math.max(120_000, Math.ceil(bytes * 8 / 750_000 * 1000) + 30_000)) };
}
