import { expect, it } from 'vitest';
import { retryAfterMs, dailyQuotaExceeded } from '../src/retry';
import { geminiFailure } from '../src/errors';
it('extracts standard retry metadata without exposing upstream data', () => {
  expect(retryAfterMs({ headers: new Headers({ 'retry-after': '45' }) })).toBe(45000);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' }) }, 0)).toBe(60000);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after-ms': '1234' }) })).toBe(1234);
  expect(retryAfterMs({ error: { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' }] } } })).toBe(42500);
  expect(retryAfterMs({ headers: new Headers({ 'retry-after': 'private-invalid-value' }) })).toBeNull();
});
it('identifies daily quota from structured details or the observed API message', () => {
  const error = { status: 429, error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { project: 'private-project' } }] }] } };
  expect(dailyQuotaExceeded(error)).toBe(true);
  expect(geminiFailure(error).category).toBe('daily_quota_exceeded');
  expect(JSON.stringify(geminiFailure(error))).not.toContain('private-project');
  expect(dailyQuotaExceeded({ status: 429, message: 'Rate limit exceeded (limit: 20 requests per day on Free Tier)' })).toBe(true);
  expect(dailyQuotaExceeded({ status: 429, message: 'Rate limit exceeded' })).toBe(false);
});
