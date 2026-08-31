// デスクトップ版のローカルAPI起動管理 (electron/api-server-client.cjs) のテスト。
// electron に依存しない純粋なNodeコードなのでそのまま検証できる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalApiServer } = require('../electron/api-server-client.cjs');

function tempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ttv-local-api-'));
}

test('トークンはインストールごとに固定され、再生成で変わる', () => {
  const dir = tempUserDataDir();
  const server = new LocalApiServer({ userDataDir: dir });

  const first = server.getToken();
  assert.match(first, /^[0-9a-f]{48}$/); // 24バイトのhex
  assert.equal(server.getToken(), first, '呼ぶたびに変わってはいけない');

  // 別インスタンス (アプリ再起動に相当) でも同じ値が復元される
  assert.equal(new LocalApiServer({ userDataDir: dir }).getToken(), first);

  const regenerated = server.regenerateToken();
  assert.notEqual(regenerated, first);
  assert.equal(server.getToken(), regenerated);
});

test('起動するとトークン必須で待ち受け、停止できる', async (t) => {
  const server = new LocalApiServer({ userDataDir: tempUserDataDir() });
  t.after(() => server.stop());

  const started = await server.start({ port: 0 });
  assert.equal(started.running, true);
  assert.equal(started.host, '127.0.0.1', 'アプリからは常にループバックのみ');
  assert.ok(started.token);

  const base = started.url;
  const unauthorized = await fetch(`${base}/health`);
  assert.equal(unauthorized.status, 401, 'トークン無しは弾く');

  const authorized = await fetch(`${base}/health`, {
    headers: { Authorization: `Bearer ${started.token}` },
  });
  assert.equal(authorized.status, 200);

  const stopped = await server.stop();
  assert.equal(stopped.running, false);
});

test('ポートが埋まっていれば分かるエラーを返す', async (t) => {
  const first = new LocalApiServer({ userDataDir: tempUserDataDir() });
  t.after(() => first.stop());
  const port = (await first.start({ port: 0 })).port;

  const second = new LocalApiServer({ userDataDir: tempUserDataDir() });
  t.after(() => second.stop());
  const status = await second.start({ port });
  assert.equal(status.running, false);
  assert.match(status.lastError, /既に使われています/);
});

test('不正なポート番号を弾く', async () => {
  const server = new LocalApiServer({ userDataDir: tempUserDataDir() });
  const status = await server.start({ port: 99999 });
  assert.equal(status.running, false);
  assert.match(status.lastError, /0〜65535/);
});
