import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, validateTicket, downloadContext } from '../scripts/ask-antigravity.mjs';

test('CLI trusts only the configured self-hosted origin and never follows redirects', async () => {
  const previous = process.env.GEMINI_MCP_ORIGIN;
  process.env.GEMINI_MCP_ORIGIN = 'https://my-mcp.example.com';
  try {
    assert.equal(normalizeOrigin('https://my-mcp.example.com/'), 'https://my-mcp.example.com');
    for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/mcp', 'https://example.com/?token=x']) assert.throws(() => normalizeOrigin(origin));
    const ticket = {url:'https://my-mcp.example.com/cli-context',token:'fixture'};
    assert.equal(validateTicket(ticket), ticket.url);
    assert.throws(() => validateTicket({...ticket,url:'https://attacker.example/cli-context'}));
    let called = false;
    await assert.rejects(downloadContext({...ticket,url:'https://attacker.example/cli-context'}, async () => { called = true; }));
    assert.equal(called, false);
    await assert.rejects(downloadContext(ticket, async (_url, init) => { assert.equal(init.redirect, 'manual'); return new Response(null,{status:302}); }));
  } finally {
    if(previous === undefined) delete process.env.GEMINI_MCP_ORIGIN;
    else process.env.GEMINI_MCP_ORIGIN = previous;
  }
});
