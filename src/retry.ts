export function dailyQuotaExceeded(error: unknown): boolean {
  const e = error as { status?: number; message?: string; error?: { details?: unknown[]; error?: { details?: unknown[] } } } | null;
  if (e?.status === 429 && typeof e.message === 'string' && /(?:requests? per day|daily (?:quota|limit))/i.test(e.message)) return true;
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
