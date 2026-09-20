export class RetryFailure extends Error {
  constructor(readonly lastError: unknown, readonly attempts: number) { super('Gemini request failed'); }
}
export function retryable(error: unknown) {
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
      const delay = 1000 * 2 ** (attempt - 1) + Math.floor(random() * 500);
      if (attempt >= 3 || !retryable(error) || deadline - now() < delay + 1000) throw new RetryFailure(error, attempt);
      await sleep(delay);
    }
  }
}
