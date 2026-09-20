import { expect, it, vi } from 'vitest';
import { withRetry, retryAfterMs } from '../src/retry';
import { geminiFailure } from '../src/errors';
it('retries transient failures with backoff and reports attempts', async () => {
  const operation = vi.fn().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ name: 'APIConnectionTimeoutError' }).mockResolvedValue('ok');
  const sleep = vi.fn(async () => {});
  expect(await withRetry(operation, { sleep, random: () => 0 })).toEqual({ result: 'ok', attempts: 3 });
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
});
it('does not retry permanent errors or exceed three attempts', async () => {
  for (const [status, attempts] of [[400, 1], [401, 1], [403, 1], [404, 1], [429, 3], [500, 3], [503, 3]]) {
    const operation = vi.fn().mockRejectedValue({ status, message: 'private-secret' });
    try { await withRetry(operation, { sleep: async () => {} }); throw new Error('expected failure'); }
    catch (e) {
      expect(operation).toHaveBeenCalledTimes(attempts);
      expect(geminiFailure(e)).toMatchObject({ attempts, upstream_status: status });
      expect(JSON.stringify(geminiFailure(e))).not.toContain('private-secret');
    }
  }
});
it('limits retries to the overall timeout budget', async () => {
  let elapsed = 0;
  const operation = vi.fn(async () => { elapsed += 109000; throw { name: 'APIConnectionTimeoutError' }; });
  await expect(withRetry(operation, { now: () => elapsed, random: () => 0, sleep: async () => {} })).rejects.toMatchObject({ attempts: 1 });
  expect(operation).toHaveBeenCalledTimes(1);
});
it('honors server retry metadata and uses longer backoff for 429', async () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const operation = vi.fn().mockRejectedValueOnce({ status: 429, headers: new Headers({ 'retry-after': '45' }) }).mockRejectedValueOnce({ status: 429 }).mockResolvedValue('ok');
  expect(await withRetry(operation, { sleep, random: () => 0 })).toMatchObject({ attempts: 3 });
  expect(sleep.mock.calls).toEqual([[45000], [30000]]);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' }) }, 0)).toBe(60000);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after-ms': '1234' }) })).toBe(1234);
  expect(retryAfterMs({ error: { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' }] } } })).toBe(42500);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after': 'private-invalid-value' }) })).toBeNull();
});
it('does not retry early when the server wait exceeds the budget', async () => {
  const sleep = vi.fn(async () => {});
  const error = { status: 429, headers: new Headers({ 'retry-after': '120' }) };
  await expect(withRetry(async () => { throw error; }, { sleep })).rejects.toMatchObject({ attempts: 1 });
  expect(sleep).not.toHaveBeenCalled();
  expect(geminiFailure(error).retry_after_seconds).toBe(120);
});
it('stops on an explicitly identified daily quota without exposing quota identifiers', async () => {
  const error = { status: 429, error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { project: 'private-project' } }] }] } };
  await expect(withRetry(async () => { throw error; })).rejects.toMatchObject({ attempts: 1 });
  expect(geminiFailure(error).category).toBe('daily_quota_exceeded');
  expect(JSON.stringify(geminiFailure(error))).not.toContain('private-project');
});
