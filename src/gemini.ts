import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Env } from './env';
import { getRules, systemPrompt } from './rules';
import { SignJWT, jwtVerify } from 'jose';
import { geminiFailure } from './errors';
export const inputSchema = {
  job_id: z.string().min(1).max(8000).optional().describe('受付番号。結果取得時はこれだけ指定し、新しい生成を開始しない。'),
  prompt: z.string().trim().min(1).max(100000).optional().describe('Geminiへの依頼、必要な背景、対象文章。URLもここに記載する。会話履歴は自動転送されない。'),
  writing_rules: z.boolean().default(false).describe('自然で正確な日本語への文章補正を使う場合だけtrue。'),
  cli_models: z.array(z.string().regex(/^gemini-\d+(?:\.\d+)+-(?:flash|pro)-(?:low|medium|high)$/)).min(1).max(30).optional().describe('Codex専用。CLIの--checkで得た一覧。指定時はAPI実行せずCLI用チケットを返す。'),
  research: z.boolean().default(false).describe('最新情報の調査・Web検索が必要なときtrue。追加課金の可能性あり。本文URLの参照だけならfalseでもURL Contextが有効。'),
};
export type Input = z.infer<z.ZodObject<typeof inputSchema>>;
export function researchTools(input: Input) {
  const tools: ({ type: 'url_context' } | { type: 'google_search' })[] = [];
  if (/https?:\/\//i.test(input.prompt ?? '')) tools.push({ type: 'url_context' });
  if (input.research) tools.push({ type: 'google_search' });
  return tools;
}
const ticketSchema = z.object({
  id: z.string().min(1).max(2048), model: z.string().min(1).max(200), version: z.string(),
  rules: z.object({ status: z.string(), updated_at: z.string().nullable() }),
});
export async function resolveFlash(ai: GoogleGenAI, configured: string) {
  if (configured !== 'gemini-flash-latest') return configured;
  const pager = await ai.models.list({ config: { pageSize: 1000, httpOptions: { timeout: 5000 }, abortSignal: AbortSignal.timeout(5000) } });
  const names: string[] = [];
  for await (const item of pager) {
    const name = item.name?.replace(/^models\//, '') ?? '';
    if (/^gemini-\d+(?:\.\d+)*-flash$/.test(name)) names.push(name);
  }
  names.sort((a, b) => {
    const x = a.split('-')[1].split('.').map(Number), y = b.split('-')[1].split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? 0) - (x[i] ?? 0); if (d) return d; }
    return 0;
  });
  if (!names[0]) throw new Error('Flash model unavailable');
  return names[0];
}
export async function askGemini(input: Input, env: Env) {
  if (!env.GEMINI_API_KEY) throw new Error('not configured');
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const key = new TextEncoder().encode(env.SESSION_SECRET);
  let model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const effort = 'high' as const;
  let rulesInfo = { status: 'disabled', updated_at: null as string | null };
  let result;
  let job_id = input.job_id;
  if (job_id) {
    let ticket;
    try {
      const { payload } = await jwtVerify(job_id, key, { algorithms: ['HS256'], issuer: env.PUBLIC_ORIGIN, audience: 'gemini-job', requiredClaims: ['iat', 'exp'] });
      ticket = ticketSchema.parse(payload);
      if (ticket.version !== env.AUTH_VERSION) throw new Error('revoked');
    } catch { return { text: '', status: 'invalid_job', message: '受付番号が無効または期限切れです。新しい生成は行っていません。' }; }
    model = ticket.model; rulesInfo = ticket.rules;
    try { result = await ai.interactions.get(ticket.id, {}, { timeout: 15000, maxRetries: 0 }); }
    catch (error) {
      return { text: '', status: 'poll_error', job_id, ...geminiFailure(error), next_action: '元の生成は再実行していません。利用枠や通信が回復したら同じjob_idで結果を再確認できます。promptを再送しないでください。' };
    }
  } else {
    if (!input.prompt?.trim()) return { text: '', status: 'invalid_input', message: '新しい依頼にはpromptが必要です。結果取得にはjob_idを指定してください。' };
    model = await resolveFlash(ai, model);
    const rules = input.writing_rules ? await getRules(env) : undefined;
    if (rules) rulesInfo = { status: rules.status, updated_at: rules.updatedAt ?? null };
    // Never replay an ambiguous creation timeout: the background job may exist.
    result = await ai.interactions.create({
      model, input: input.prompt, store: true, background: true,
      system_instruction: systemPrompt(input.writing_rules, rules?.text),
      tools: researchTools(input), generation_config: { max_output_tokens: 65536, thinking_level: effort },
    }, { timeout: 15000, maxRetries: 0 });
    if (!result.id) throw new Error('missing interaction id');
    job_id = await new SignJWT({ id: result.id, model, version: env.AUTH_VERSION, rules: rulesInfo })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.PUBLIC_ORIGIN).setAudience('gemini-job')
      .setIssuedAt().setExpirationTime('23h').sign(key);
  }
  if (['in_progress', 'queued'].includes(result.status ?? '')) return {
    text: '', status: 'in_progress', job_id, model, thinking_level: effort,
    poll_after_seconds: 15, message: '処理中です。15秒以上空けてask_geminiにjob_idだけを渡し結果を取得してください。promptを再送して生成を開始し直さないでください。',
    usage: result.usage ?? null, attempts: 1, retries: 0, citations: [], writing_rules: rulesInfo,
  };
  const attempts = 1;
  const textBlocks = (result.steps ?? []).flatMap(step => step.type === 'model_output' ? (step.content ?? []).filter(c => c.type === 'text') : []);
  const text = textBlocks.map(c => c.text).join('\n\n');
  return {
    text,
    job_id,
    attempts,
    retries: attempts - 1,
    model: result.model ?? model,
    requested_model: model,
    thinking_level: effort,
    status: result.status,
    usage: result.usage ?? null,
    citations: textBlocks.map(c => ({ text: c.text, annotations: c.annotations ?? [] })).filter(c => c.annotations.length),
    research_metadata: (result.steps ?? []).filter(s => s.type === 'url_context_result' || s.type === 'google_search_result'),
    writing_rules: rulesInfo,
    warnings: [
      ...(!text ? ['本文を取得できませんでした。statusを確認してください。'] : []),
      ...(result.status !== 'completed' ? ['生成が正常完了していません。本文は途中の可能性があります。'] : []),
      ...(['stale', 'fallback'].includes(rulesInfo.status) ? ['Gistを更新できず、前回のルールまたは代替ルールを使用しました。'] : []),
    ],
  };
}
