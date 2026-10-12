const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, utimes, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const { createReloadingCodexClient } = await import('../tools/codex-web.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-bridge-reload-'));
  const clientFile = path.join(directory, 'client.cjs');
  const key = `codex-bridge-reload-${randomUUID()}`;
  const state = { constructed: [], calls: [], closed: [], gate: deferred(), entered: deferred() };
  globalThis[key] = state;
  let timestamp = Date.now();
  const writeVersion = async version => {
    await writeFile(clientFile, `
const state = globalThis[${JSON.stringify(key)}];
const version = ${version};
module.exports.CodexClient = class {
  constructor({ cwd }) { state.constructed.push({ version, cwd }); }
  async getStatus() {
    state.calls.push({ method: 'getStatus', version });
    return { available: true, version };
  }
  async generateJson(input, { onDelta, signal } = {}) {
    signal?.throwIfAborted();
    state.calls.push({ method: 'generateJson', version });
    if (version === 1 && input.outputType === 'realtime_stream') throw new Error('出力形式が不正です');
    onDelta?.('{"continuous":false,"duration":2,"segments":');
    if (input.hold) {
      state.entered.resolve();
      await state.gate.promise;
    }
    signal?.throwIfAborted();
    onDelta?.('[]}');
    return '{"continuous":false,"duration":2,"segments":[]}';
  }
  close() {
    state.closed.push(version);
    state.gate.reject(new Error('Fixture client closed'));
  }
};
// Source revision ${'x'.repeat(version)}
`, 'utf8');
    // Explicitly distinct timestamps also exercise filesystems with coarse clocks.
    timestamp += 2000;
    await utimes(clientFile, new Date(timestamp), new Date(timestamp));
  };
  await writeVersion(1);
  const client = createReloadingCodexClient({ clientFile, cwd: directory });
  t.after(async () => {
    client.close();
    delete globalThis[key];
    const target = path.resolve(directory);
    assert.equal(path.dirname(target).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('codex-bridge-reload-'));
    await rm(target, { recursive: true, force: true });
  });
  return { client, state, writeVersion, directory };
}

test('Codex bridge reloads a changed client and accepts progressive output without restarting the app', async t => {
  const { client, state, writeVersion, directory } = await fixture(t);
  await assert.rejects(client.generateJson({ outputType: 'realtime_stream' }), /出力形式が不正です/);
  await writeVersion(2);
  const deltas = [];
  const output = await client.generateJson({ outputType: 'realtime_stream' }, { onDelta: delta => deltas.push(delta) });
  assert.equal(output, deltas.join(''));
  assert.deepEqual(JSON.parse(output), { continuous: false, duration: 2, segments: [] });
  assert.deepEqual(state.constructed, [{ version: 1, cwd: directory }, { version: 2, cwd: directory }]);
  assert.deepEqual(state.closed, [1]);
  assert.equal((await client.getStatus()).version, 2);
  assert.equal(state.constructed.length, 2, 'unchanged code must retain its running client');
});

test('changed Codex client waits for the active stream before routing new requests to the new revision', async t => {
  const { client, state, writeVersion } = await fixture(t);
  const deltas = [];
  const stream = client.generateJson({ outputType: 'realtime', hold: true }, { onDelta: delta => deltas.push(delta) });
  stream.catch(() => {});
  await state.entered.promise;
  await writeVersion(2);
  let completedStatus = false;
  const status = client.getStatus().then(result => { completedStatus = true; return result; });
  const next = client.generateJson({ outputType: 'realtime_stream' });
  next.catch(() => {});
  await tick(); await tick();
  assert.equal(completedStatus, false);
  assert.deepEqual(state.closed, [], 'an in-flight stream must not be closed during code refresh');
  assert.deepEqual(state.calls, [{ method: 'generateJson', version: 1 }], 'new requests must not lease the old revision');
  state.gate.resolve();
  assert.equal(await stream, deltas.join(''));
  assert.equal((await status).version, 2);
  assert.deepEqual(JSON.parse(await next), { continuous: false, duration: 2, segments: [] });
  assert.deepEqual(state.closed, [1]);
  assert.deepEqual(state.constructed.map(item => item.version), [1, 2]);
});

test('cancelling a request waiting for Codex refresh does not load a new client or interrupt the active stream', async t => {
  const { client, state, writeVersion } = await fixture(t);
  const stream = client.generateJson({ outputType: 'realtime', hold: true });
  stream.catch(() => {});
  await state.entered.promise;
  await writeVersion(2);
  const controller = new AbortController();
  const waiting = client.generateJson({ outputType: 'realtime_stream' }, { signal: controller.signal });
  const cancelled = assert.rejects(waiting, { name: 'AbortError' });
  await tick();
  controller.abort();
  await cancelled;
  assert.deepEqual(state.constructed.map(item => item.version), [1]);
  assert.deepEqual(state.closed, []);
  state.gate.resolve();
  await stream;
  await tick();
  assert.deepEqual(state.constructed.map(item => item.version), [1], 'a cancelled waiter cannot revive itself after draining');
  assert.equal((await client.getStatus()).version, 2);
});

test('closing a Codex bridge rejects refresh waiters and cannot resurrect a client', async t => {
  const { client, state, writeVersion } = await fixture(t);
  const stream = client.generateJson({ outputType: 'realtime', hold: true });
  const closedStream = assert.rejects(stream, /closed/i);
  await state.entered.promise;
  await writeVersion(2);
  const waiting = client.getStatus();
  const closedWaiter = assert.rejects(waiting);
  await tick();
  client.close();
  await Promise.all([closedStream, closedWaiter]);
  await assert.rejects(client.getStatus());
  await tick();
  assert.deepEqual(state.constructed.map(item => item.version), [1]);
  assert.deepEqual(state.closed, [1]);
});
