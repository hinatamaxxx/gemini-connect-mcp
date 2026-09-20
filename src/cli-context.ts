import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Env } from './env';
import { getRules, systemPrompt } from './rules';


const selectionSchema = z.object({ writing_rules: z.boolean(), research: z.boolean(), model: z.string().regex(/^gemini-\d+(?:\.\d+)+-flash-high$/) });
export function latestCliFlash(models: string[]) {
  const candidates = models.filter(m => /^gemini-\d+(?:\.\d+)+-flash-high$/.test(m));
  candidates.sort((a, b) => {
    const x = a.split('-')[1].split('.').map(Number), y = b.split('-')[1].split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? 0) - (x[i] ?? 0); if (d) return d; }
    return 0;
  });
  if (!candidates[0]) throw new Error('No Flash High model');
  return candidates[0];
}
type Selection = z.infer<typeof selectionSchema>;
const secret = (env: Env) => new TextEncoder().encode(env.SESSION_SECRET);

// This ticket can only retrieve writing instructions; it cannot invoke a model.
export async function issueCliContext(selection: Selection, env: Env) {
  selectionSchema.parse(selection);
  const token = await new SignJWT({ selection, version: env.AUTH_VERSION })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.PUBLIC_ORIGIN).setAudience('gemini-cli-context')
    .setIssuedAt().setExpirationTime('5m').sign(secret(env));
  return { url: `${env.PUBLIC_ORIGIN}/cli-context`, token, model: selection.model, effort: 'high' as const };
}

export async function cliContext(request: Request, env: Env) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
  try {
    const auth = request.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || auth.length > 4096) throw new Error('invalid ticket');
    const { payload } = await jwtVerify(auth.slice(7), secret(env), { algorithms: ['HS256'], issuer: env.PUBLIC_ORIGIN, audience: 'gemini-cli-context', requiredClaims: ['exp', 'iat'] });
    if (payload.version !== env.AUTH_VERSION) throw new Error('revoked');
    const selection = selectionSchema.parse(payload.selection);
    const effort = 'high' as const;
    const rules = selection.writing_rules ? await getRules(env) : undefined;
    return Response.json({ model: selection.model, effort,
      system_instruction: systemPrompt(selection.writing_rules, rules?.text),
      research: selection.research,
      writing_rules: rules ? { status: rules.status, updated_at: rules.updatedAt ?? null } : { status: 'disabled' },
      warnings: rules && ['stale', 'fallback'].includes(rules.status) ? ['Gistの更新を確認できず前回値または代替ルールを使用しました。'] : [],
    }, { headers });
  } catch { return new Response('Invalid or expired CLI context ticket', { status: 401, headers }); }
}
