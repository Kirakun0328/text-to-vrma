const test = require('node:test');
const assert = require('node:assert/strict');

test('slow inference starts early enough to protect playback, without unbounded lookahead', async () => {
  const { motionLookaheadSeconds, updateMotionLatency } = await import('../src/motionLookahead.js');
  let latency = updateMotionLatency(0, 1700);
  const ahead = motionLookaheadSeconds(2, latency);
  assert.ok(ahead > 1.7, 'request before the remaining buffer is shorter than inference');
  assert.ok(ahead <= 3);
  assert.equal(motionLookaheadSeconds(2, 30000), 3);
  for (let i = 0; i < 20; i++) latency = updateMotionLatency(latency, 100);
  assert.equal(motionLookaheadSeconds(2, latency), 1.5, 'return to interactive baseline after recovery');
  assert.equal(updateMotionLatency(latency, NaN), latency);
});
