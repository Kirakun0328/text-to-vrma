const test = require('node:test');
const assert = require('node:assert/strict');

test('restart waits for a new server instance before reloading', async () => {
  const { restartApp } = await import('../src/appRestart.js');
  const responses = [{ restarting: true, instance: 'old' }, { ready: true, instance: 'old' }, { ready: true, instance: 'new' }];
  let reloads = 0;
  await restartApp({ bridge: null, wait: async () => {}, reload: () => { reloads++; }, fetchImpl: async () => Response.json(responses.shift()) });
  assert.equal(reloads, 1); assert.equal(responses.length, 0);
});

test('legacy server gives initial restart instructions without a reload loop', async () => {
  const { restartApp } = await import('../src/appRestart.js');
  await assert.rejects(restartApp({ bridge: null, fetchImpl: async () => new Response('', { status: 404 }), reload: () => assert.fail('unexpected reload') }), /npm.cmd run dev/);
});

test('desktop restart uses the main process', async () => {
  const { restartApp } = await import('../src/appRestart.js');
  let calls = 0;
  await restartApp({ bridge: { restart: async () => { calls++; } } });
  assert.equal(calls, 1);
});
