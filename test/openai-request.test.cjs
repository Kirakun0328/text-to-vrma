const test = require('node:test');
const assert = require('node:assert/strict');

async function capture(model, effort) {
  const { callOpenAI } = await import('../src/llm.js');
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  };
  try { await callOpenAI([{ role: 'user', content: 'u' }], 'key', model, undefined, { effort }); }
  catch { /* only the request matters */ }
  finally { globalThis.fetch = original; }
  return body;
}

test('OpenAI defaults to GPT-6.1 Sol', async () => {
  const { DEFAULT_OPENAI_MODEL } = await import('../src/llm.js');
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6.1-sol');
});

test('GPT-6 family models receive reasoning effort; unknown models do not', async () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
    assert.equal((await capture(model, 'high')).reasoning_effort, 'high', model);
  }
  assert.equal((await capture('deepseek-chat', 'high')).reasoning_effort, undefined);
});
