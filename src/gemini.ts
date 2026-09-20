import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Env } from './env';
import { getRules, systemPrompt } from './rules';
import { withRetry } from './retry';
export const inputSchema = {
  prompt: z.string().trim().min(1).max(100000).describe('Geminiへの依頼、必要な背景、対象文章。URLもここに記載する。会話履歴は自動転送されない。'),
  writing_rules: z.boolean().default(false).describe('自然で正確な日本語への文章補正を使う場合だけtrue。'),
  cli_models: z.array(z.string().regex(/^gemini-\d+(?:\.\d+)+-(?:flash|pro)-(?:low|medium|high)$/)).min(1).max(30).optional().describe('Codex専用。CLIの--checkで得た一覧。指定時はAPI実行せずCLI用チケットを返す。'),
  research: z.boolean().default(false).describe('最新情報の調査・Web検索が必要なときtrue。追加課金の可能性あり。本文URLの参照だけならfalseでもURL Contextが有効。'),
};
export type Input = z.infer<z.ZodObject<typeof inputSchema>>;
export function researchTools(input: Input) {
  const tools: ({ type: 'url_context' } | { type: 'google_search' })[] = [];
  if (/https?:\/\//i.test(input.prompt)) tools.push({ type: 'url_context' });
  if (input.research) tools.push({ type: 'google_search' });
  return tools;
}
export async function askGemini(input: Input, env: Env) {
  if (!env.GEMINI_API_KEY) throw new Error('not configured');
  const rules = input.writing_rules ? await getRules(env) : undefined;
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const effort = 'high' as const;
  const { result, attempts } = await withRetry(timeout => ai.interactions.create({
    model: model, input: input.prompt, store: false,
    system_instruction: systemPrompt(input.writing_rules, rules?.text),
    tools: researchTools(input), generation_config: { max_output_tokens: 65536, thinking_level: effort },
  }, { timeout, maxRetries: 0 }));
  const textBlocks = (result.steps ?? []).flatMap(step => step.type === 'model_output' ? (step.content ?? []).filter(c => c.type === 'text') : []);
  const text = textBlocks.map(c => c.text).join('\n\n');
  return {
    text,
    attempts,
    retries: attempts - 1,
    model: result.model ?? model,
    requested_model: model,
    thinking_level: effort,
    status: result.status,
    usage: result.usage ?? null,
    citations: textBlocks.map(c => ({ text: c.text, annotations: c.annotations ?? [] })).filter(c => c.annotations.length),
    research_metadata: (result.steps ?? []).filter(s => s.type === 'url_context_result' || s.type === 'google_search_result'),
    writing_rules: rules ? { status: rules.status, updated_at: rules.updatedAt ?? null } : { status: 'disabled' },
    warnings: [
      ...(!text ? ['本文を取得できませんでした。statusを確認してください。'] : []),
      ...(result.status !== 'completed' ? ['生成が正常完了していません。本文は途中の可能性があります。'] : []),
      ...(rules && ['stale', 'fallback'].includes(rules.status) ? ['Gistを更新できず、前回のルールまたは代替ルールを使用しました。'] : []),
    ],
  };
}
