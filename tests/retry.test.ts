import { expect, it, vi } from 'vitest';
import { withRetry } from '../src/retry';
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
