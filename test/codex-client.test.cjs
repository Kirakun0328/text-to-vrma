const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  CodexClient,
  MOTION_OUTPUT_SCHEMA,
  compareVersions,
  friendlyError,
} = require('../electron/codex-client.cjs');

function createFakeCodex({ version = '0.144.4' } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  let turnCount = 0;
  let threadStartParams;

  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      if (!line) continue;
      const request = JSON.parse(line);
      if (request.id === undefined) continue;
      let result;
      if (request.method === 'initialize') {
        result = { userAgent: 'fake-codex' };
      } else if (request.method === 'account/read') {
        result = {
          account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' },
          requiresOpenaiAuth: true,
        };
      } else if (request.method === 'model/list') {
        result = {
          data: [{
            id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test',
            description: 'Test model', isDefault: true,
          }],
          nextCursor: null,
        };
      } else if (request.method === 'thread/start') {
        threadStartParams = request.params;
        result = { thread: { id: 'thread-1' } };
      } else if (request.method === 'turn/start') {
        turnCount += 1;
        result = { turn: { id: `turn-${turnCount}` } };
        const spec = {
          name: turnCount === 1 ? 'draft' : 'refined',
          duration: 2,
          loop: false,
          tracks: { head: [{ t: 0, r: [0, 0, 0] }] },
        };
        process.nextTick(() => {
          child.stdout.write(`${JSON.stringify({
            method: 'item/completed',
            params: {
              threadId: 'thread-1', turnId: `turn-${turnCount}`,
              item: { type: 'agentMessage', text: JSON.stringify(spec) },
            },
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: `turn-${turnCount}`, status: 'completed' },
            },
          })}\n`);
        });
      } else if (request.method === 'account/login/start') {
        result = { type: 'chatgpt', authUrl: 'https://example.com/login', loginId: 'login-1' };
      } else if (request.method === 'account/logout') {
        result = {};
      } else {
        throw new Error(`Unhandled fake method: ${request.method}`);
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });

  const client = new CodexClient({
    cwd: '/tmp',
    spawnProcess: () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    exec: (_command, _args, _options, callback) => {
      process.nextTick(() => callback(null, `codex-cli ${version}\n`, ''));
    },
  });

  return {
    client,
    child,
    getTurnCount: () => turnCount,
    getThreadStartParams: () => threadStartParams,
  };
}

test('バージョンを最低要件と比較する', () => {
  assert.equal(compareVersions('0.144.1'), 0);
  assert.ok(compareVersions('0.145.0') > 0);
  assert.ok(compareVersions('0.143.9') < 0);
});

test('Codex出力スキーマはルートの全プロパティを必須にする', () => {
  assert.deepEqual(
    [...MOTION_OUTPUT_SCHEMA.required].sort(),
    Object.keys(MOTION_OUTPUT_SCHEMA.properties).sort()
  );
});

test('Codex出力スキーマの全objectは固定キーをすべて必須にする', () => {
  function assertStrictObjects(schema, path = 'root') {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false, `${path} must reject unknown keys`);
      assert.deepEqual(
        [...schema.required].sort(),
        Object.keys(schema.properties).sort(),
        `${path} must require every property`
      );
      for (const [name, child] of Object.entries(schema.properties)) {
        assertStrictObjects(child, `${path}.${name}`);
      }
    }
    if (schema.type === 'array') assertStrictObjects(schema.items, `${path}[]`);
  }

  assertStrictObjects(MOTION_OUTPUT_SCHEMA);
});

test('Codexの認証状態とモデル一覧を取得する', async () => {
  const { client } = createFakeCodex();
  const status = await client.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.account.email, 'test@example.com');
  assert.equal(status.version, '0.144.4');

  const models = await client.listModels();
  assert.deepEqual(models, [{
    id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test',
    description: 'Test model', isDefault: true,
  }]);
  client.close();
});

test('同じ一時スレッドで生成と自己修正を実行する', async () => {
  const { client, getTurnCount, getThreadStartParams } = createFakeCodex();
  const result = await client.generateMotion({
    model: 'gpt-test',
    systemPrompt: 'モーションJSONを生成してください。',
    prompt: '手を振る',
    refinePrompt: '結果を自己修正してください。',
    refine: true,
  });
  assert.equal(result.name, 'refined');
  assert.equal(getTurnCount(), 2);
  assert.equal('dynamicTools' in getThreadStartParams(), false);
  client.close();
});

test('自己修正が無効なら1ターンだけ実行する', async () => {
  const { client, getTurnCount } = createFakeCodex();
  const result = await client.generateMotion({
    model: 'gpt-test',
    systemPrompt: 'モーションJSONを生成してください。',
    prompt: 'うなずく',
    refine: false,
  });
  assert.equal(result.name, 'draft');
  assert.equal(getTurnCount(), 1);
  client.close();
});

test('古いCLIは利用不可として返す', async () => {
  const { client } = createFakeCodex({ version: '0.143.0' });
  const status = await client.getStatus();
  assert.equal(status.available, false);
  assert.match(status.error, /0\.144\.1 以上/);
});

test('CLI未導入エラーを利用者向けに変換する', () => {
  const error = new Error('spawn codex ENOENT');
  error.code = 'ENOENT';
  assert.match(friendlyError(error).message, /Codex CLI が見つかりません/);
});
