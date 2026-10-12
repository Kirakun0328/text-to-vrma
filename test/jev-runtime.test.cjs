const test = require('node:test');
const assert = require('node:assert/strict');

test('independent emotional scores retain mixed feelings without treating choice uncertainty as a mixture', async () => {
  const { reactionTargets } = await import('../src/jevRuntime.js');
  const result = reactionTargets({ affect: { happy: { value: 0.8, confidence: 0.9 }, sad: { value: 0.6, confidence: 0.8 } } });
  assert.ok(result.happy > 0 && result.sad > 0);
  assert.ok(Object.values(result).reduce((a, b) => a + b) <= 1);
  const uncertain = reactionTargets({ emotion: 'joy', emotion_intensity: 1, confidences: { emotion: 0.1 }, probabilities: { emotion: { joy: 0.5, anger: 0.5 } } });
  assert.ok(uncertain.happy > 0 && uncertain.happy < 0.4);
  assert.equal(uncertain.angry, undefined);
});

test('face-only routing is conservative; smoothing is independent of render rate', async () => {
  const { isFaceOnlyUpdate, smoothWeight } = await import('../src/jevRuntime.js');
  assert.equal(isFaceOnlyUpdate({ update_scope: 'face_only', confidences: { update_scope: 0.9 } }), true);
  assert.equal(isFaceOnlyUpdate({ update_scope: 'face_only', confidences: { update_scope: 0.3 } }), false);
  assert.equal(isFaceOnlyUpdate(null), false);
  let weight = 0;
  for (let i = 0; i < 60; i++) weight = smoothWeight(weight, 1, 1 / 60);
  assert.ok(Math.abs(weight - smoothWeight(0, 1, 1)) < 1e-10);
});

test('structured state is bounded and does not copy unrelated fields', async () => {
  const { boundedState } = await import('../src/jevRuntime.js');
  const state = boundedState({ apiKey: 'do-not-send', current_action: 'a'.repeat(5000),
    posture: { head: [0, 0, 0, 1], bad: [NaN], another: 'secret' }, expressions: { happy: 0.5 } });
  assert.equal(state.apiKey, undefined);
  assert.equal(state.current_action.length, 1200);
  assert.deepEqual(state.posture, { head: [0, 0, 0, 1] });
});

test('gaze uses supported expression names and does not invent an uncertain target', async () => {
  const { reactionTargets } = await import('../src/jevRuntime.js');
  assert.equal(reactionTargets({ gaze: 'left', confidences: { gaze: 0.8 } }).lookLeft, 0.5);
  assert.equal(reactionTargets({ gaze: 'left', confidences: { gaze: 0.1 } }).lookLeft, undefined);
});
