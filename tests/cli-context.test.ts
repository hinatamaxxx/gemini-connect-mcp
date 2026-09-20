import { expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { cliContext, issueCliContext } from '../src/cli-context';
import { latestCliFlash } from '../src/cli-context';
import type { Env } from '../src/env';
const env = { PUBLIC_ORIGIN: 'https://mcp.example.com', SESSION_SECRET: 'fixture-secret-only-'.repeat(3), AUTH_VERSION: '2', OAUTH_KV: { get: vi.fn(), put: vi.fn() } } as unknown as Env;
const selection = { writing_rules: false, research: false, model: 'gemini-3.8-flash-high' };
it('serves rules only for a signed scoped ticket without returning API keys', async () => {
  const ticket = await issueCliContext(selection, env);
  const request = new Request(ticket.url, { headers: { Authorization: `Bearer ${ticket.token}` } });
  const response = await cliContext(request, env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = await response.json() as any;
  expect(data).toMatchObject({ model: selection.model, effort: 'high' });
  expect(data.system_instruction).not.toContain('ひなたMAX');
  expect(JSON.stringify(data)).not.toContain(env.SESSION_SECRET);
  expect(env.OAUTH_KV.get).not.toHaveBeenCalled();
  expect((await cliContext(request, { ...env, AUTH_VERSION: '3' })).status).toBe(401);
});
it('rejects missing, modified, expired and wrong-audience tickets', async () => {
  expect((await cliContext(new Request(env.PUBLIC_ORIGIN + '/cli-context'), env)).status).toBe(401);
  for (const [audience, expiry] of [['gemini-cli-context', '-1m'], ['another-endpoint', '5m']]) {
    const token = await new SignJWT({ selection, version: '2' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(env.PUBLIC_ORIGIN).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(new TextEncoder().encode(env.SESSION_SECRET));
    expect((await cliContext(new Request(env.PUBLIC_ORIGIN + '/cli-context', { headers: { Authorization: `Bearer ${token}` } }), env)).status).toBe(401);
  }
  const ticket = await issueCliContext(selection, env);
  expect((await cliContext(new Request(ticket.url, { headers: { Authorization: `Bearer x${ticket.token}` } }), env)).status).toBe(401);
});
it('selects the numeric latest Flash High and rejects weaker options', () => {
  expect(latestCliFlash(['gemini-3.9-flash-high', 'gemini-3.10-flash-high', 'gemini-4.0-pro-high'])).toBe('gemini-3.10-flash-high');
  expect(() => latestCliFlash(['gemini-3.10-flash-low'])).toThrow();
});
