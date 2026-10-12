const test = require('node:test');
const assert = require('node:assert/strict');

async function capture(model, onDelta) {
  const { callClaude } = await import('../src/llm.js');
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    body.headers = init.headers;
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }));
  };
  try {
    await callClaude([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 'key', model, onDelta);
  } catch { /* streaming mock body is not SSE; only the request matters */ }
  finally { globalThis.fetch = original; }
  return body;
}

test('Claude defaults to Opus 5.5 with adaptive thinking, high effort and server-side fallback', async () => {
  const { DEFAULT_CLAUDE_MODEL } = await import('../src/llm.js');
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5-5');
  const body = await capture(DEFAULT_CLAUDE_MODEL);
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.system, 's');
});

test('streaming requests get a larger output budget; Fable and Sonnet keep their own default effort', async () => {
  for (const model of ['claude-fable-5-1', 'claude-sonnet-5-5']) {
    const body = await capture(model, () => {});
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.output_config, undefined, model);
    assert.equal(body.fallbacks, 'default', model);
  }
});

test('Haiku 5.5 thinks at its default effort without fallback', async () => {
  const haiku55 = await capture('claude-haiku-5-5');
  assert.deepEqual(haiku55.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(haiku55.output_config, undefined);
  assert.equal(haiku55.fallbacks, undefined);
  assert.equal(haiku55.headers['anthropic-beta'], undefined);
});

test('previous-generation Claude models are never called', async () => {
  const { callClaude } = await import('../src/llm.js');
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  try {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      await assert.rejects(callClaude([{ role: 'user', content: 'u' }], 'key', model), /利用できません/);
    }
  } finally { globalThis.fetch = original; }
  assert.equal(called, false);
});
