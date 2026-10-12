const test = require('node:test');
const assert = require('node:assert/strict');

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Japanese is sent to Jev in English when the ARDY translator answers', async () => {
  const { englishForJev } = await import('../src/jevTranslate.js');
  let request;
  const result = await englishForJev('照れながらお礼を言う', { ardyUrl: 'http://ardy/', fetchImpl: async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return reply(200, { english: 'Say thank you shyly.', translated: true })();
  } });
  assert.deepEqual(result, { text: 'Say thank you shyly.', translated: true });
  assert.equal(request.url, 'http://ardy/translate');
  assert.equal(request.body.text, '照れながらお礼を言う');
});

test('English, disabled translation, failures and untranslated output keep the original text', async () => {
  const { englishForJev } = await import('../src/jevTranslate.js');
  const never = async () => { throw new Error('must not be called'); };
  const original = { text: '手を振る', translated: false };
  assert.deepEqual(await englishForJev('wave', { ardyUrl: 'http://ardy', fetchImpl: never }), { text: 'wave', translated: false });
  assert.deepEqual(await englishForJev('手を振る', { ardyUrl: 'http://ardy', enabled: false, fetchImpl: never }), original);
  assert.deepEqual(await englishForJev('手を振る', { ardyUrl: '', fetchImpl: never }), original);
  for (const fetchImpl of [
    async () => { throw new TypeError('Failed to fetch'); },
    reply(503, { code: 'translator_unavailable' }),
    reply(200, { english: '' }),
    reply(200, { english: '手を振る' }),
  ]) assert.deepEqual(await englishForJev('手を振る', { ardyUrl: 'http://ardy', fetchImpl }), original);
});

test('a slow translator is abandoned so Jev is not delayed', async () => {
  const { englishForJev } = await import('../src/jevTranslate.js');
  const started = Date.now();
  const result = await englishForJev('手を振る', { ardyUrl: 'http://ardy', timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  assert.deepEqual(result, { text: '手を振る', translated: false });
  assert.ok(Date.now() - started < 1000);
});
