import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify } from 'jose';
import type { Env } from './env';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const cookieName = '__Host-gemini-login';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'" };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const random = () => crypto.randomUUID() + crypto.randomUUID();
const key = async (env: Env) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SESSION_SECRET)));
const cookie = (value: string, age = 600) => `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
type Login = { query: string; state: string; nonce: string; phase: string };
async function seal(login: Login, env: Env) {
  return new EncryptJWT(login).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuer(env.PUBLIC_ORIGIN).setAudience('google-login').setIssuedAt().setExpirationTime('10m').encrypt(await key(env));
}
async function unseal(request: Request, env: Env): Promise<Login> {
  const value = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!value) throw new Error('Missing login');
  const { payload } = await jwtDecrypt(value, await key(env), { issuer: env.PUBLIC_ORIGIN, audience: 'google-login', keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
  if (!['query','state','nonce','phase'].every(k => typeof payload[k] === 'string')) throw new Error('Invalid login');
  return payload as unknown as Login;
}
export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!['/authorize', '/google/callback'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OWNER_GOOGLE_EMAIL || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return new Response('Google login is not configured', { status: 503, headers });
  if (!['GET', 'POST'].includes(request.method) || (url.pathname === '/google/callback' && request.method !== 'GET')) return new Response('Method not allowed', { status: 405, headers });
  if (!(await env.AUTH_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) return new Response('Try again later', { status: 429, headers });
  try {
    if (url.pathname === '/google/callback') {
      const login = await unseal(request, env);
      if (login.phase !== 'google' || url.searchParams.get('state') !== login.state || !url.searchParams.get('code') || url.searchParams.has('error')) throw new Error('Invalid callback');
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code')!, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.PUBLIC_ORIGIN + '/google/callback', grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Token exchange failed');
      const token = await response.json() as { id_token?: string };
      if (!token.id_token) throw new Error('Missing ID token');
      const { payload } = await jwtVerify(token.id_token, jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'] });
      if (payload.nonce !== login.nonce || payload.email_verified !== true || payload.email !== env.OWNER_GOOGLE_EMAIL || !payload.sub || (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID)) throw new Error('Not owner');
      // Bootstrap the stable ID only from an email Google is authoritative for.
      if (!env.OWNER_GOOGLE_EMAIL.endsWith('@gmail.com') && typeof payload.hd !== 'string') throw new Error('Google-authoritative email required');
      const ownerKey = 'google-owner:' + env.OWNER_GOOGLE_EMAIL;
      const pinned = await env.OAUTH_KV.get(ownerKey);
      if (pinned && pinned !== payload.sub) throw new Error('Account ID changed');
      if (!pinned) await env.OAUTH_KV.put(ownerKey, payload.sub);
      const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(env.PUBLIC_ORIGIN + '/authorize' + login.query));
      const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: oauth, userId: payload.sub, metadata: {}, scope: ['gemini:ask'], props: { userId: payload.sub, email: env.OWNER_GOOGLE_EMAIL, scopes: ['gemini:ask'], version: env.AUTH_VERSION } });
      return new Response(null, { status: 302, headers: { ...headers, Location: result.redirectTo, 'Set-Cookie': cookie('', 0) } });
    }
    const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (oauth.codeChallengeMethod !== 'S256' || !oauth.codeChallenge || !oauth.scope.includes('gemini:ask') || oauth.scope.some(s => s !== 'gemini:ask') || url.search.length > 1800) throw new Error('Invalid OAuth request');
    if (request.method === 'GET') {
      const login = { query: url.search, state: random(), nonce: random(), phase: 'consent' };
      const body = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Gemini Connect 接続許可</title><h1>Gemini Connect 接続許可</h1><p>このクライアントにGemini APIとJevによる振り分けの利用を許可します。実作業の依頼はGoogleへ、Jevの判断用の依頼はTypeSafeへ送信され、それぞれ所有者のAPI利用枠・料金が使われます。</p><p>クライアント: ${escape(oauth.clientId)}</p><p>戻り先: ${escape(oauth.redirectUri)}</p><p>設定された所有者のGoogleアカウントだけ接続できます。</p><form method="post"><input type="hidden" name="csrf" value="${login.state}"><button type="submit">Googleでログインして接続を許可</button></form></html>`;
      return new Response(body, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie(await seal(login, env)) } });
    }
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) throw new Error('Invalid origin');
    const raw = await request.text();
    if (raw.length > 4096) throw new Error('Request too large');
    const login = await unseal(request, env);
    if (login.phase !== 'consent' || login.query !== url.search || new URLSearchParams(raw).get('csrf') !== login.state) throw new Error('Invalid consent');
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.PUBLIC_ORIGIN + '/google/callback', response_type: 'code', scope: 'openid email', state: login.state, nonce: login.nonce, prompt: 'select_account' }).toString();
    return new Response(null, { status: 302, headers: { ...headers, Location: googleUrl.href, 'Set-Cookie': cookie(await seal({ ...login, phase: 'google' }, env)) } });
  } catch {
    return new Response('接続を許可できませんでした。所有者のGoogleアカウントを使用し、ChatGPTから接続をやり直してください。', { status: 403, headers: { ...headers, 'Set-Cookie': cookie('', 0) } });
  }
}
