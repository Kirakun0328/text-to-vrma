const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// fetch は Host を上書きしてしまうので、Hostヘッダーの検証には生のHTTPを使う
function rawRequest(baseUrl, path, headers = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function startServer(options = {}) {
  const { createApiServer } = await import('../src/apiServer.js');
  const server = createApiServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const sampleSpec = {
  name: 'wave', duration: 1, loop: false,
  tracks: { head: [{ t: 0, r: [0, 0, 0] }, { t: 1, r: [0, 0, 0] }] },
  hips: [], expressions: {},
};

test('healthはAPI設定状態を返す', async (t) => {
  const api = await startServer({ apiKey: '' });
  t.after(api.close);
  const response = await fetch(`${api.url}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'text-to-vrma');
  assert.equal(body.generationConfigured, false);
  assert.deepEqual(body.engines, ['openai', 'claude', 'ardy']);
  assert.deepEqual(body.configured, { openai: false, claude: false });
});

test('ルートURLは利用可能なAPI一覧を返す', async (t) => {
  const api = await startServer({ apiKey: '' });
  t.after(api.close);
  const response = await fetch(api.url);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.endpoints.generate, 'POST /v1/motions');
});

test('テキストからmotion specを生成する', async (t) => {
  let received;
  const api = await startServer({
    apiKey: 'test-key',
    defaultModel: 'test-model',
    generateMotion: async (...args) => {
      received = args;
      return sampleSpec;
    },
  });
  t.after(api.close);

  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '手を振る', refine: false }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.object, 'motion');
  assert.deepEqual(body.spec, sampleSpec);
  assert.equal(received[0], '手を振る');
  assert.equal(received[2], 'test-model');
  assert.equal(received[3].refine, false);
});

test('生成結果をVRMAバイナリで返す', async (t) => {
  const api = await startServer({
    apiKey: 'test-key',
    generateMotion: async () => sampleSpec,
  });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'wave', format: 'vrma' }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'glTF');
});

test('BearerトークンでAPIを保護できる', async (t) => {
  const api = await startServer({ apiKey: 'test-key', apiToken: 'secret' });
  t.after(api.close);
  assert.equal((await fetch(`${api.url}/health`)).status, 401);
  const response = await fetch(`${api.url}/health`, {
    headers: { Authorization: 'Bearer secret' },
  });
  assert.equal(response.status, 200);
});

test('不正な入力を400で返す', async (t) => {
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_prompt');
});

test('APIキーの値はレスポンスに一切含まれない', async (t) => {
  // 呼び出し側はキーを「使える」が「見える」ことはあってはならない
  const secret = 'sk-SECRET-must-not-leak-123';
  const api = await startServer({
    apiKey: secret,
    claudeApiKey: `${secret}-claude`,
    generateMotion: async () => { throw new Error(`Incorrect API key provided: ${secret}`); },
  });
  t.after(api.close);

  const health = await (await fetch(`${api.url}/health`)).text();
  const root = await (await fetch(api.url)).text();
  const openapi = await (await fetch(`${api.url}/openapi.json`)).text();
  const failed = await (await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '手を振る' }),
  })).text();

  for (const [name, body] of Object.entries({ health, root, openapi, failed })) {
    assert.ok(!body.includes(secret), `${name} にAPIキーが含まれている: ${body}`);
  }
  // プロバイダのエラー文面ごと返さず、汎用メッセージに置き換わること
  assert.match(failed, /モーションの処理に失敗しました/);
});

test('外部Originからのリクエストを403で弾く', async (t) => {
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);

  const crossOrigin = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ prompt: '手を振る' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'forbidden_origin');

  const crossSite = await fetch(`${api.url}/health`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('非ブラウザのクライアント (Origin無し) は素通りする', async (t) => {
  // curl / Unity / Python などは Origin も Sec-Fetch-Site も送らない
  const api = await startServer({ apiKey: 'test-key', generateMotion: async () => sampleSpec });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '手を振る' }),
  });
  assert.equal(response.status, 200);
});

test('対応外のHTTPメソッドを405で弾く', async (t) => {
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, { method: 'DELETE' });
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, 'method_not_allowed');
});

test('単純リクエスト (text/plain) のPOSTを415で弾く', async (t) => {
  // ブラウザからのCSRFはプリフライトが飛ばない単純リクエストで成立するため、
  // application/json を必須にして塞ぐ
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ prompt: '手を振る' }),
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'unsupported_media_type');
});

test('ループバック以外のHostヘッダーを403で弾く', async (t) => {
  // DNSリバインディング対策。攻撃者のドメインを127.0.0.1へ向けても
  // ブラウザは Host: evil.example を送るのでここで止まる
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);
  const denied = await rawRequest(api.url, '/health', { Host: 'evil.example' });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error.code, 'invalid_host');

  const allowed = await rawRequest(api.url, '/health', { Host: '127.0.0.1' });
  assert.equal(allowed.status, 200);
});

test('トークン運用ではHostチェックをスキップする', async (t) => {
  // 外部公開時は認証が役目を負うので、任意のHostで到達できる必要がある
  const api = await startServer({ apiKey: 'test-key', apiToken: 'secret' });
  t.after(api.close);
  const response = await rawRequest(api.url, '/health', {
    Host: 'text-to-vrma.example', Authorization: 'Bearer secret',
  });
  assert.equal(response.status, 200);
});

test('ClaudeエンジンでANTHROPIC_API_KEYを使って生成する', async (t) => {
  let received;
  const api = await startServer({
    apiKey: '', // OpenAIキーが無くてもClaudeは使える
    claudeApiKey: 'claude-key',
    defaultClaudeModel: 'claude-test-model',
    generateClaude: async (...args) => {
      received = args;
      return sampleSpec;
    },
  });
  t.after(api.close);

  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '手を振る', engine: 'claude' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.engine, 'claude');
  assert.equal(body.model, 'claude-test-model');
  assert.equal(received[0], '手を振る');
  assert.equal(received[1], 'claude-key');
  assert.equal(received[2], 'claude-test-model');
  assert.equal(received[3].refine, true);
});

test('Claudeキーが無ければ503を返す', async (t) => {
  const api = await startServer({ apiKey: 'openai-key', claudeApiKey: '' });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '手を振る', engine: 'claude' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'provider_not_configured');
});

test('ARDYエンジンはAPIキー無しでも生成できる', async (t) => {
  let received;
  const api = await startServer({
    apiKey: '',
    generateArdy: async (...args) => {
      received = args;
      return sampleSpec;
    },
  });
  t.after(api.close);

  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '前に歩く', engine: 'ardy', duration: 3, waypoints: [{ x: 1, z: 2 }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.engine, 'ardy');
  assert.equal(body.model, null); // キーが無ければ動作分割 (GPTが頭) は使わない
  assert.equal(received[0], '前に歩く');
  assert.equal(received[1].duration, 3);
  assert.deepEqual(received[1].waypoints, [{ x: 1, z: 2 }]);
});

test('未知のengineを400で返す', async (t) => {
  const api = await startServer({ apiKey: 'test-key' });
  t.after(api.close);
  const response = await fetch(`${api.url}/v1/motions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '歩く', engine: 'unknown' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_engine');
});

test('ARDYエンジンへ送るリクエストと後処理', async () => {
  const { generateMotionWithArdy } = await import('../src/apiServer.js');
  let sent;
  const spec = await generateMotionWithArdy('前に歩く', {
    ardyUrl: 'http://127.0.0.1:9999/',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({
          name: 'walk', duration: 2,
          tracks: { head: [{ t: 0, r: [0, 0, 0] }, { t: 2, r: [0, 0, 0] }] },
          hips: [{ t: 0, p: [0, 0, 0] }, { t: 2, p: [0, 0, 3] }], // 大きく前進する
        }),
      };
    },
  });

  assert.equal(sent.url, 'http://127.0.0.1:9999/generate'); // 末尾スラッシュを正規化する
  assert.deepEqual(sent.body, { text: '前に歩く' }); // キーが無いので分割せず原文を渡す
  assert.equal(spec.loop, false); // 移動が大きいのでループ向きではない
  assert.ok(spec.duration > 2); // 非ループは直立姿勢へ戻す分だけ伸びる
  assert.ok(spec.expressions); // ARDYは表情を作らないので補われる
});

test('ARDYエンジンに接続できない場合は503を返す', async () => {
  const { generateMotionWithArdy } = await import('../src/apiServer.js');
  await assert.rejects(
    () => generateMotionWithArdy('歩く', {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (error) => error.status === 503 && error.code === 'ardy_unavailable'
  );
});
