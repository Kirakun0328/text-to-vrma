const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

async function withServer(analyze, run) {
  const { jevMiddleware } = await import('../tools/jev-web.mjs');
  const middleware = jevMiddleware({ analyze });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('local Jev bridge passes analysis to the fixed service and returns typed errors', async () => {
  let calls = 0;
  await withServer(async (input, { signal }) => {
    calls++; assert.equal(input.apiKey, 'test-key'); assert.equal(signal.aborted, false);
    return { status: 401, code: 'jev_unauthorized', error: 'Jev APIキーが無効です' };
  }, async url => {
    const res = await fetch(url + '/__jev/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ apiKey: 'test-key', text: 'hello' }) });
    assert.equal(res.status, 401); assert.equal((await res.json()).code, 'jev_unauthorized');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
  assert.equal(calls, 1);
});

test('bridge rejects foreign origins, malformed JSON, and oversized inputs without contacting Jev', async () => {
  await withServer(() => assert.fail('must not forward'), async url => {
    for (const [headers, body, status] of [
      [{ Origin: 'https://evil.example' }, '{}', 403],
      [{ 'Sec-Fetch-Site': 'cross-site' }, '{}', 403],
      [{}, '{', 400], [{}, JSON.stringify({ text: 'x'.repeat(33000) }), 413],
    ]) {
      const res = await fetch(url + '/__jev/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
      assert.equal(res.status, status);
    }
    assert.equal((await fetch(url + '/__jev/analyze')).status, 405);
  });
});

test('Jev service preserves authorization errors without returning upstream content or key', async () => {
  const { handleJevAnalysis } = await import('../src/jevService.js');
  const result = await handleJevAnalysis({ text: 'hello', apiKey: 'private-test-key' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer private-test-key');
      return { ok: false, status: 401, json: async () => ({ error: 'private-test-key' }) };
    },
  });
  assert.equal(result.code, 'jev_unauthorized');
  assert.ok(!JSON.stringify(result).includes('private-test-key'));
});

test('low confidence remains a successful connection, not a transport failure', async () => {
  const { handleJevAnalysis } = await import('../src/jevService.js');
  const choice = value => ({ choice: value, confidence: 0.2 });
  const result = await handleJevAnalysis({ text: 'hello', apiKey: 'test' }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      emotion: choice('neutral'), reaction: choice('idle'), scale: choice('small'), tempo: choice('normal'), social: choice('neutral'),
      intensity: { score: 0 }, energy: { score: 1 }, loop: { noul: 0 },
    } }) }),
  });
  assert.equal(result.status, 200); assert.equal(result.context.confidence, 0.2);
});
