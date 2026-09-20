export class RetryFailure extends Error {
  constructor(readonly lastError: unknown, readonly attempts: number) { super('Gemini request failed'); }
}
export function dailyQuotaExceeded(error: unknown): boolean {
  const e = error as { status?: number; error?: { details?: unknown[]; error?: { details?: unknown[] } } } | null;
  const details = e?.error?.details ?? e?.error?.error?.details;
  return e?.status === 429 && Array.isArray(details) && details.some(detail => {
    const d = detail as { '@type'?: string; violations?: { quotaId?: string }[] } | null;
    return d?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(d.violations) && d.violations.some(v => typeof v?.quotaId === 'string' && /PerDay/i.test(v.quotaId));
  });
}
// Read only standard retry metadata. Never expose the upstream body or headers.
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const e = error as { headers?: Headers; error?: { details?: unknown[]; error?: { details?: unknown[] } } } | null;
  const delays: number[] = [];
  const ms = e?.headers?.get?.('retry-after-ms');
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) delays.push(Number(ms));
  const after = e?.headers?.get?.('retry-after');
  if (after) {
    const delay = Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - now;
    if (Number.isFinite(delay) && delay >= 0) delays.push(delay);
  }
  const details = e?.error?.details ?? e?.error?.error?.details;
  if (Array.isArray(details)) for (const detail of details) {
    const d = detail as { '@type'?: string; retryDelay?: string } | null;
    if (d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof d.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(d.retryDelay)) {
      const delay = Number(d.retryDelay.slice(0, -1)) * 1000;
      if (Number.isFinite(delay)) delays.push(delay);
    }
  }
  return delays.length ? Math.max(...delays) : null;
}
export function retryable(error: unknown) {
  if (dailyQuotaExceeded(error)) return false;
  const e = error as { status?: number; name?: string } | null;
  if (typeof e?.status === 'number') return [408, 429, 500, 502, 503, 504].includes(e.status);
  return ['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError', 'AbortError'].includes(e?.name ?? '');
}
// One overall budget; SDK retries are disabled so attempts cannot multiply.
export async function withRetry<T>(operation: (timeout: number) => Promise<T>, options: {
  sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const deadline = now() + 110000;
  for (let attempt = 1; ; attempt++) {
    try { return { result: await operation(Math.max(1, Math.min(60000, deadline - now()))), attempts: attempt }; }
    catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const backoff = (status === 429 ? 15000 : 1000) * 2 ** (attempt - 1);
      const delay = Math.max(backoff, retryAfterMs(error, now()) ?? 0) + Math.floor(random() * 500);
      if (attempt >= 3 || !retryable(error) || deadline - now() < delay + 1000) throw new RetryFailure(error, attempt);
      await sleep(delay);
    }
  }
}
