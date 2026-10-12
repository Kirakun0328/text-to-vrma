const test = require('node:test');
const assert = require('node:assert/strict');

const faces = { happy: 0, sad: 0, angry: 0, surprised: 0, relaxed: 0 };

test('uncertain absent emotions leave authored animation intact', async () => {
  const { createReaction, advanceReaction } = await import('../src/jevRuntime.js');
  const reaction = createReaction({ affect: Object.fromEntries(Object.keys(faces).map(name =>
    [name, { value: 0, confidence: 0 }])) }, { preview: true });
  const base = { ...faces, happy: 0.8 };
  const result = advanceReaction(reaction, base, 3);
  assert.equal(result.values.happy, 0.8);
  assert.equal(result.active, false);
});

test('preview influence is bounded even when Jev confidently disagrees with the current face', async () => {
  const { createReaction, advanceReaction } = await import('../src/jevRuntime.js');
  const reaction = createReaction({ affect: { happy: { value: 0, confidence: 1 } } }, { preview: true });
  const result = advanceReaction(reaction, { ...faces, happy: 1 }, 5);
  assert.ok(result.values.happy >= 0.4, 'the preview cannot completely erase authored expression');
  assert.ok(result.values.happy < 0.41, 'a confident hint remains visible');
});

test('removing a gaze channel from the next hint releases it smoothly to the moving animation', async () => {
  const { createReaction, advanceReaction } = await import('../src/jevRuntime.js');
  const base = { ...faces, lookLeft: 0, lookRight: 0, lookUp: 0, lookDown: 0 };
  const left = createReaction({ gaze: 'left', confidences: { gaze: 1 } }, { persistent: true });
  const before = advanceReaction(left, base, 5).values.lookLeft;
  assert.ok(before > 0.49);
  const happy = createReaction({ affect: { happy: { value: 1, confidence: 1 } } }, { persistent: true }, left);
  assert.equal(advanceReaction(happy, base, 0).values.lookLeft, before, 'no jump when the hint is replaced');
  const after = advanceReaction(happy, base, 1 / 60).values.lookLeft;
  assert.ok(after > 0 && after < before);
  const movingBase = { ...base, lookLeft: 0.15 };
  const released = advanceReaction(happy, movingBase, 3).values.lookLeft;
  assert.ok(Math.abs(released - 0.15) < 0.001);
});

test('face mixing respects supported channels and the combined animation weight budget', async () => {
  const { createReaction, advanceReaction } = await import('../src/jevRuntime.js');
  const reaction = createReaction({ affect: { happy: { value: 1, confidence: 1 }, angry: { value: 1, confidence: 1 } } }, { persistent: true });
  const result = advanceReaction(reaction, { happy: 0, sad: 1 }, 5);
  assert.equal(result.values.angry, undefined, 'unsupported expressions must not be written');
  assert.ok(result.values.happy > 0);
  assert.ok(result.values.sad > 0, 'the current authored emotion is retained in the blend');
  assert.ok(result.values.happy + result.values.sad <= 1.00000001);
});

test('clearing a live hint releases the face instead of latching the previous target', async () => {
  const { createReaction, advanceReaction } = await import('../src/jevRuntime.js');
  const reaction = createReaction({ affect: { happy: { value: 1, confidence: 1 } } }, { persistent: true });
  const before = advanceReaction(reaction, faces, 5).values.happy;
  reaction.remaining = 0;
  const fading = advanceReaction(reaction, faces, 1 / 60);
  assert.ok(fading.values.happy > 0 && fading.values.happy < before);
  assert.equal(fading.active, true);
  const released = advanceReaction(reaction, faces, 3);
  assert.ok(released.values.happy < 0.001);
  assert.equal(released.active, false);
});
