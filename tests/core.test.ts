import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getRules, systemPrompt } from '../src/rules';
import { askGemini, inputSchema, researchTools } from '../src/gemini';
import { authorize } from '../src/auth';
import type { Env } from '../src/env';
const { create, get } = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { interactions = { create, get }; models = { list: async () => [{ name: 'models/gemini-3.8-flash' }] }; } }));
function cache(initial: unknown = null) {
  let value = initial;
  return { get: vi.fn(async () => value), put: vi.fn(async (_: string, s: string) => { value = JSON.parse(s); }) } as unknown as KVNamespace;
}
const input = () => z.object(inputSchema).parse({ prompt: '第二意見をください' });
describe('rules and Gemini boundary', () => {
  it('defaults do not enable style or web tools', () => {
    expect(researchTools(input())).toEqual([]);
    expect(systemPrompt(false)).not.toContain('ひなた');
    expect(researchTools({ ...input(), prompt: 'https://example.com', research: true })).toEqual([{ type: 'url_context' }, { type: 'google_search' }]);
    expect(() => z.object(inputSchema).parse({ prompt: ' ' })).toThrow();
  });
  it('fetches, caches, and revalidates with ETag', async () => {
    const env = { OAUTH_KV: cache() };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ files: { 'SKILL.md': { content: '最新ルール' } } }, { headers: { etag: 'v1' } })).mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await getRules(env, fetcher, 1000)).status).toBe('fresh');
    expect((await getRules(env, fetcher, 2000)).status).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(env.OAUTH_KV.put).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[1][1].headers['If-None-Match']).toBe('v1');
  });
  it('survives upstream and cache failures, and warns on stale rules', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network'));
    expect((await getRules({ OAUTH_KV: cache() }, failing)).status).toBe('fallback');
    const stale = await getRules({ OAUTH_KV: cache({ text: '前回', checkedAt: 0 }) }, failing);
    expect(stale).toMatchObject({ text: '前回', status: 'stale' });
    const broken = { get: failing, put: failing } as unknown as KVNamespace;
    expect((await getRules({ OAUTH_KV: broken }, failing)).status).toBe('fallback');
  });
  it('uses latest/high in background without returning thoughts', async () => {
    create.mockResolvedValue({ id: 'fixture-id', model: 'gemini-3.8-flash', status: 'completed', usage: { total_input_tokens: 10, total_output_tokens: 20, total_tokens: 40 }, steps: [
      { type: 'thought', summary: [{ text: 'private thinking' }] },
      { type: 'model_output', content: [{ type: 'text', text: '回答', annotations: [{ type: 'url_citation', url: 'https://example.com' }] }] },
    ] });
    const kv = cache();
    const result = await askGemini(input(), { ...jobEnv, OAUTH_KV: kv } as Env);
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'gemini-3.8-flash', store: true, background: true, generation_config: { thinking_level: 'high', max_output_tokens: 65536 } });
    expect(kv.get).not.toHaveBeenCalled();
    expect(result.usage?.total_tokens).toBe(40);
    expect(JSON.stringify(result)).not.toContain('private thinking');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.citations).toHaveLength(1);
  });
  it('writing correction is opt-in and preserves meaning', () => {
    expect(systemPrompt(false, '参照資料')).not.toContain('参照資料');
    expect(systemPrompt(true, '参照資料')).toContain('参照資料');
    expect(systemPrompt(true)).toContain('意味や事実関係を変えず');
  });
  it('checks again on every use even after a failed fetch', async () => {
    const env = { OAUTH_KV: cache() };
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await getRules(env, fetcher, 1000000)).status).toBe('fallback');
    expect((await getRules(env, fetcher, 1001000)).status).toBe('fallback');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await getRules(env, fetcher, 1301000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not replace good cached rules with a truncated Gist', async () => {
    const env = { OAUTH_KV: cache({ text: '完全な前回ルール', checkedAt: 0 }) };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ files: { 'SKILL.md': { content: 'partial', truncated: true } } }));
    expect(await getRules(env, fetcher)).toMatchObject({ text: '完全な前回ルール', status: 'stale' });
  });
});
const jobEnv = { GEMINI_API_KEY: 'secret', GEMINI_MODEL: 'gemini-flash-latest', SESSION_SECRET: 'fixture-signing-key'.repeat(4), PUBLIC_ORIGIN: 'https://mcp.example.com', AUTH_VERSION: '1' } as Env;
it('polls the same signed job without generating again', async () => {
  create.mockReset(); get.mockReset();
  create.mockResolvedValue({ id: 'fixture-job', status: 'in_progress' });
  get.mockResolvedValueOnce({ id: 'fixture-job', status: 'in_progress' }).mockResolvedValue({ id: 'fixture-job', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '完了' }] }] });
  const start = await askGemini(input(), jobEnv);
  expect(start.status).toBe('in_progress');
  const poll = z.object(inputSchema).parse({ job_id: start.job_id });
  expect((await askGemini(poll, jobEnv)).status).toBe('in_progress');
  expect((await askGemini(poll, jobEnv)).text).toBe('完了');
  expect(create).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('fixture-job', {}, { timeout: 15000, maxRetries: 0 });
  expect((await askGemini({ ...poll, job_id: 'x' + poll.job_id }, jobEnv)).status).toBe('invalid_job');
  expect((await askGemini(poll, { ...jobEnv, AUTH_VERSION: '2' })).status).toBe('invalid_job');
  expect(get).toHaveBeenCalledTimes(2);
});
it('returns the same ticket after a read timeout without restarting', async () => {
  create.mockReset(); get.mockReset();
  create.mockResolvedValue({ id: 'fixture-job', status: 'in_progress' });
  const start = await askGemini(input(), jobEnv);
  get.mockRejectedValue({ name: 'APIConnectionTimeoutError', message: 'private' });
  const result = await askGemini(z.object(inputSchema).parse({ job_id: start.job_id }), jobEnv);
  expect(result).toMatchObject({ status: 'poll_error', job_id: start.job_id });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(create).toHaveBeenCalledTimes(1);
});
it('never repeats an ambiguous create timeout', async () => {
  create.mockReset();
  expect((await askGemini(z.object(inputSchema).parse({}), jobEnv)).status).toBe('invalid_input');
  expect(create).not.toHaveBeenCalled();
  create.mockRejectedValue({ name: 'APIConnectionTimeoutError' });
  await expect(askGemini(input(), jobEnv)).rejects.toMatchObject({ name: 'APIConnectionTimeoutError' });
  expect(create).toHaveBeenCalledTimes(1);
});
describe('Google login fail closed', () => {
  it('rejects incomplete Google configuration', async () => {
    expect((await authorize(new Request('https://mcp.example.com/authorize'), {} as Env)).status).toBe(503);
  });
});
