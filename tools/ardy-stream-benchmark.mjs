// Runs real ARDY inference. Jev is replaced by a fixed context for reproducible timing.
import assert from 'node:assert/strict';
import { createArdyRealtime } from '../src/ardyRealtime.js';
import { buildVRMA } from '../src/vrmaBuilder.js';

const url = process.env.ARDY_URL || 'http://127.0.0.1:2337';
const prompt = process.argv[2] || 'Wave hello warmly with the right hand.';
const health = await fetch(`${url}/health`).then(r => r.json());
assert.equal(health.status, 'ok', 'Wait for ARDY to finish loading');
console.log(JSON.stringify({ prompt, duration: 6, steps: Number(process.argv[3]) || 4, codex: 'fixed plan; latency excluded', jev: 'fixed context; API latency excluded' }));
let latestPartial;
const runtime = createArdyRealtime({
  plan: async () => ({ segments: [{ text: prompt, duration: 6 }], expression: 'happy' }),
  analyze: async () => ({ reaction: 'greeting', emotion: 'joy', movement_scale: 'medium', tempo: 'normal' }),
  play: async (spec, _active, { final }) => {
    assert.ok(buildVRMA(spec).byteLength > 0);
    if (final && latestPartial) {
      assert.deepEqual(spec.hips, latestPartial.hips, 'stream and final root positions must match');
      assert.deepEqual(spec.tracks, latestPartial.tracks, 'stream and final bone rotations must match');
    } else latestPartial = spec;
  },
  onStatus: console.log,
});
for (let i = 0; i < 2; i++) {
  latestPartial = null;
  console.log(`Fresh inference ${i + 1}`);
  await runtime.react(prompt, url, { duration: 6, steps: Number(process.argv[3]) || 4 });
}
