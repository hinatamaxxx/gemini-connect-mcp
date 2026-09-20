import { afterAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { webcrypto } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const pair = await generateKeyPair('RS256');
const wrongPair = await generateKeyPair('RS256');
let badSignature = false;
const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
let googleNonce = '';
let googleClaims: Record<string, unknown> = {};
let googleIssuer = 'https://accounts.google.com';
let googleAudience = 'test-client';
let googleExpiry = '5m';
const origin = 'https://mcp.example.com';
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const secret = 'test-only-owner-secret-'.repeat(3);
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  modules: [{ type: 'ESModule', path: 'dist/index.js' }],
  compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'], bindings: { PUBLIC_ORIGIN: origin, SESSION_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'mock-client-secret', OWNER_GOOGLE_EMAIL: 'owner@gmail.com', GEMINI_API_KEY: 'mock-key', GEMINI_MODEL: 'gemini-flash-latest', AUTH_VERSION: '1' },
  ratelimits: { AUTH_LIMIT: { namespace_id: '1001', simple: { limit: 100, period: 60 } }, GEMINI_LIMIT: { namespace_id: '1002', simple: { limit: 100, period: 60 } } },
  outboundService: async (request: Request) => {
    if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
    if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: await new SignJWT({ email: 'owner@gmail.com', email_verified: true, nonce: googleNonce, ...googleClaims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('google-owner-123').setIssuer(googleIssuer).setAudience(googleAudience).setIssuedAt().setExpirationTime(googleExpiry).sign(badSignature ? wrongPair.privateKey : pair.privateKey) });
    if (request.url === clientId) return Response.json({ client_id: clientId, client_name: 'ChatGPT fixture', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    if (request.url.includes('generativelanguage.googleapis.com')) return Response.json({ id: 'mock', object: 'interaction', model: 'gemini-3.8-flash', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '疎通成功' }] }], usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 } });
    return new Response('Unexpected outbound request', { status: 500 });
  },
}] }));
afterAll(() => mf.dispose());
it('real Worker: OAuth discovery, CIMD, consent, PKCE token exchange, and MCP tool call', async () => {
  const unauthorized = await mf.dispatchFetch(origin + '/mcp');
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata');
  expect((await mf.dispatchFetch(origin + '/mcp', { headers: { Authorization: 'Bearer invalid' } })).status).toBe(401);
  const metadata = await (await mf.dispatchFetch(origin + '/.well-known/oauth-authorization-server')).json() as any;
  expect(metadata.code_challenge_methods_supported).toContain('S256');
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  const verifier = 'v'.repeat(64);
  const challenge = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'gemini:ask', state: 'test-state', resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256' });
  const authUrl = origin + '/authorize?' + params;
  const screen = await mf.dispatchFetch(authUrl);
  expect(screen.status).toBe(200);
  expect(screen.headers.get('content-security-policy')).toContain("form-action 'self' https://accounts.google.com;");
  expect(screen.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  const html = await screen.text();
  expect(html).toContain('Gemini Connect for ChatGPT 接続許可');
  expect(html).not.toMatch(/TypeSafe|Jev/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const cookie = screen.headers.get('set-cookie')!.split(';')[0];
  for (const [target, requestHeaders, body] of [
    [authUrl, { Origin: 'https://evil.example', Cookie: cookie }, {csrf}],
    [authUrl, { Origin: origin }, {csrf}],
    [authUrl + '&extra=changed', { Origin: origin, Cookie: cookie }, {csrf}],
    [authUrl, { Origin: origin, Cookie: cookie }, {csrf:'wrong'}],
  ] as const) {
    expect((await mf.dispatchFetch(target, { method: 'POST', headers: requestHeaders, body: new URLSearchParams(body).toString(), redirect:'manual' })).status).toBe(403);
  }
  const consent = await mf.dispatchFetch(authUrl, { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ csrf }).toString(), redirect: 'manual' });
  expect(consent.status).toBe(302);
  const googleLocation = new URL(consent.headers.get('location')!);
  expect(googleLocation.origin).toBe('https://accounts.google.com');
  expect(googleLocation.searchParams.get('scope')).toBe('openid email');
  googleNonce = googleLocation.searchParams.get('nonce')!;
  const googleCookie = consent.headers.get('set-cookie')!.split(';')[0];
  const callback = origin + '/google/callback?code=mock-code&state=' + googleLocation.searchParams.get('state');
  const call = (cookie = googleCookie, suffix = '') => mf.dispatchFetch(callback + suffix, { headers: { Cookie: cookie }, redirect: 'manual' });
  expect((await call('')).status).toBe(403);
  expect((await call(googleCookie, 'tampered')).status).toBe(403);
  for (const claims of [{email:'attacker@gmail.com'}, {email_verified:false}, {nonce:'wrong'}, {azp:'wrong'}]) {
    googleClaims = claims;
    expect((await call()).status).toBe(403);
  }
  googleClaims = {};
  googleIssuer = 'https://evil.example';
  expect((await call()).status).toBe(403);
  googleIssuer = 'https://accounts.google.com';
  googleAudience = 'another-client';
  expect((await call()).status).toBe(403);
  googleAudience = 'test-client';
  googleExpiry = '-1m';
  expect((await call()).status).toBe(403);
  googleExpiry = '5m';
  badSignature = true;
  expect((await call()).status).toBe(403);
  badSignature = false;
  const approved = await call();
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('test-state');
  const tokenParams = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code: location.searchParams.get('code')!, code_verifier: verifier, resource: origin + '/mcp' };
  const wrongVerifier = await mf.dispatchFetch(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...tokenParams, code_verifier: 'x'.repeat(64) }).toString() });
  expect(wrongVerifier.status).toBe(400);
  const exchange = await mf.dispatchFetch(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(tokenParams).toString() });
  expect(exchange.status).toBe(200);
  const token = await exchange.json() as any;
  expect(token.access_token).toBeTruthy();
  const rpc = async (method: string, params: unknown) => {
    const response = await mf.dispatchFetch(origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    expect(response.status).toBe(200);
    const body = await response.text();
    return JSON.parse(!body.trimStart().startsWith('{') ? body.split('\n').find(line => line.startsWith('data:'))!.slice(5) : body);
  };
  expect((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.serverInfo.name).toBe('gemini-connect-for-chatgpt');
  expect((await rpc('tools/list', {})).result.tools.map((t: any) => t.name)).toEqual(['ask_gemini']);
  const cliPlan = await rpc('tools/call', { name: 'ask_gemini', arguments: { prompt: 'Save', cli_models: ['gemini-3.8-flash-high'] } });
  expect(cliPlan.result.structuredContent.cli_context.model).toBe('gemini-3.8-flash-high');
  expect(JSON.stringify(cliPlan)).not.toContain('system_instruction');
  const context = cliPlan.result.structuredContent.cli_context;
  const contextResponse = await mf.dispatchFetch(context.url, { headers: { Authorization: 'Bearer ' + context.token } });
  expect(contextResponse.status).toBe(200);
  expect((await contextResponse.json() as any).model).toBe('gemini-3.8-flash-high');
  expect((await mf.dispatchFetch(origin + '/cli-context')).status).toBe(401);

  const answer = await rpc('tools/call', { name: 'ask_gemini', arguments: { prompt: '疎通テスト' } });
  expect(answer.result.structuredContent.text).toBe('疎通成功');
  expect(answer.result.structuredContent.usage.total_tokens).toBe(15);
  expect(JSON.stringify(answer)).not.toContain('mock-key');
  const refresh = await mf.dispatchFetch(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refresh_token, resource: origin + '/mcp' }).toString() });
  expect(refresh.status).toBe(200);
  const refreshed = await refresh.json() as any;
  expect(refreshed.access_token).toBeTruthy();
  expect(refreshed.refresh_token).not.toBe(token.refresh_token);
});
