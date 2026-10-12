const test = require('node:test');
const assert = require('node:assert/strict');

test('only network-level fetch failures are treated as connection problems', async () => {
  const { isNetworkFailure } = await import('../src/connectionHelp.js');
  for (const message of ['Failed to fetch', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'fetch failed', 'net::ERR_CONNECTION_REFUSED']) {
    assert.equal(isNetworkFailure(message), true, message);
  }
  for (const message of ['', undefined, 'Claude API エラー: invalid x-api-key', 'ARDY生成に失敗しました (HTTP 500)']) {
    assert.equal(isNetworkFailure(message), false, String(message));
  }
});

test('an unreachable ARDY engine offers start, or setup when it is not installed', async () => {
  const { diagnoseConnection } = await import('../src/connectionHelp.js');
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const base = { usesArdy: true, usesBridge: true, checkArdy: down, checkBridge: async () => true, canStartArdy: true };
  assert.equal((await diagnoseConnection({ ...base, ardyConfigured: async () => true })).action, 'ardy-start');
  assert.equal((await diagnoseConnection({ ...base, ardyConfigured: async () => false })).action, 'ardy-setup');
  // The browser version cannot start a local process; it can only ask the user to.
  assert.equal((await diagnoseConnection({ ...base, canStartArdy: false })).action, 'retry');
});

test('a reachable ARDY engine points to the connection server, then to the network', async () => {
  const { diagnoseConnection } = await import('../src/connectionHelp.js');
  const up = async () => true;
  assert.equal((await diagnoseConnection({ usesArdy: true, checkArdy: up, usesBridge: true, checkBridge: async () => false })).action, 'restart');
  const network = await diagnoseConnection({ usesArdy: true, checkArdy: up, usesBridge: true, checkBridge: up });
  assert.equal(network.action, 'retry');
  assert.match(network.message, /インターネット/);
  assert.equal((await diagnoseConnection({ usesArdy: false, usesBridge: false })).action, 'retry');
});
