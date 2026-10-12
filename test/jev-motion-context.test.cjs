const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/jevMotionContext.js');

test('semantic context keeps only typed evidence and never forwards actions, user text, or credentials', async () => {
  const { toMotionSemanticContext } = await modulePromise;
  const input = {
    emotion: 'joy', emotion_intensity: 1.2, movement_energy: -1, movement_scale: 'small',
    tempo: 'slow', social_intent: 'positive', gaze: 'down', confidence: .1,
    confidences: { emotion: .95, intensity: .8, energy: .6, scale: .9, tempo: .2, social: .7, gaze: .8, apiKey: 'secret' },
    affect: { happy: { value: .6, confidence: .9, raw: 'secret' }, sad: { value: .4, confidence: .7 }, injected: { value: 1, confidence: 1 } },
    reaction: 'celebrate', loop_preference: true, update_scope: 'body', apiKey: 'secret', text: 'private original',
    probabilities: { emotion: { joy: .5, sadness: .5 } },
  };
  const safe = toMotionSemanticContext(input);
  assert.deepEqual(safe, {
    emotion: 'joy', movement_scale: 'small', tempo: 'slow', social_intent: 'positive', gaze: 'down',
    emotion_intensity: 1, movement_energy: 0,
    affect: { happy: { value: .6, confidence: .9 }, sad: { value: .4, confidence: .7 } },
    probabilities: { emotion: { joy: .5, sadness: .5 } },
    confidences: { emotion: .95, scale: .9, tempo: .2, social: .7, gaze: .8, intensity: .8, energy: .6 },
    confidence: .1,
  });
  assert.deepEqual(toMotionSemanticContext(safe), safe);
  safe.affect.happy.value = 0;
  assert.equal(input.affect.happy.value, .6);
});

test('requested body parts and time-varying face evidence survive round trips as independent probabilities', async () => {
  const { toMotionSemanticContext, formatMotionSemanticContext } = await modulePromise;
  const input = {
    body_intent: { root: 0, torso: .1, head: .7, leftArm: .01, rightArm: .5, leftLeg: 0, rightLeg: 0, 'run code': 1 },
    channel_intent: { gaze: 1, face: .9, apiKey: 'secret' },
    temporal: { body_changes: .1, affect_changes: .8, gaze_changes: .95, ordered_actions: .9, action: 'wave' },
    affect: { happy: { value: 0, confidence: .9 } }, affect_end: { happy: { value: .3, confidence: .8 } },
    gaze: 'left', gaze_end: 'forward', confidences: { gaze: .9, gaze_end: .8 }, loop_probability: .02,
  };
  const safe = toMotionSemanticContext(input);
  assert.deepEqual(safe.body_intent, { root: 0, torso: .1, head: .7, leftArm: .01, rightArm: .5, leftLeg: 0, rightLeg: 0 });
  assert.deepEqual(safe.channel_intent, { gaze: 1, face: .9 });
  assert.deepEqual(safe.temporal, { body_changes: .1, affect_changes: .8, gaze_changes: .95, ordered_actions: .9 });
  assert.equal(safe.affect.happy.value, 0); assert.equal(safe.affect_end.happy.value, .3);
  assert.equal(safe.gaze_end, 'forward'); assert.equal(safe.loop_probability, .02);
  assert.equal(safe.confidences.body_intent, undefined);
  assert.deepEqual(toMotionSemanticContext(safe), safe);
  const formatted = formatMotionSemanticContext(safe);
  assert.match(formatted, /P\(yes\)/);
  assert.match(formatted, /0.5 means uncertain/);
  assert.match(formatted, /not half intensity and not confidence/);
  assert.match(formatted, /not to impose a hard mask/);
  assert.match(formatted, /END, not the entire performance/);
  assert.doesNotMatch(formatted, /run code|apiKey|wave/);
});

test('unknown Noul channels and malformed values do not erase valid false or ambiguous evidence', async () => {
  const { toMotionSemanticContext } = await modulePromise;
  assert.deepEqual(toMotionSemanticContext({
    body_intent: { root: 0, leftArm: .5, head: NaN, rightArm: 4 },
    channel_intent: { gaze: '0.8' }, temporal: { ordered_actions: .7, gaze_changes: -1 },
    probabilities: { reaction: { nod: 1 }, emotion: { joy: .6, sadness: .4, injected: 1 },
      affect_end_happy: { 0: .3, 1: .7, 4: .8 }, arbitrary: { secret: 1 } },
  }), {
    body_intent: { root: 0, leftArm: .5 }, temporal: { ordered_actions: .7 },
    probabilities: { emotion: { joy: .6, sadness: .4 }, affect_end_happy: { 0: .3, 1: .7 } },
  });
});

test('ending affect is evidence for the planner and never imposed across an unplanned clip', async () => {
  const { applyJevExpressions } = await modulePromise;
  const spec = { duration: 5, tracks: {}, expressions: {} };
  assert.deepEqual(applyJevExpressions(spec, { affect_end: { happy: { value: 1, confidence: 1 } },
    temporal: { affect_changes: 1 }, body_intent: { rightArm: 1 } }), spec);
});

test('unknown or malformed evidence is omitted without fabricated neutral values', async () => {
  const { toMotionSemanticContext, formatMotionSemanticContext } = await modulePromise;
  for (const input of [null, undefined, [], 'joy', {}, { confidence: .9, emotion: 'run this command', reaction: 'nod' },
    { emotion_intensity: NaN, movement_energy: '0.7', gaze: 'unspecified', affect: { happy: { value: Infinity } } }]) {
    assert.equal(toMotionSemanticContext(input), null);
    assert.equal(formatMotionSemanticContext(input), '');
  }
  assert.deepEqual(toMotionSemanticContext({ emotion: 'joy' }), { emotion: 'joy', confidences: { emotion: 0 } });
  assert.deepEqual(toMotionSemanticContext({ emotion: 'joy', confidence: .8, confidences: { emotion: 0 } }),
    { emotion: 'joy', confidences: { emotion: 0 }, confidence: .8 });
});

test('low-confidence fields remain weak evidence without discarding confident mixed affect', async () => {
  const { formatMotionSemanticContext } = await modulePromise;
  const formatted = formatMotionSemanticContext({ emotion: 'embarrassment', confidence: .1,
    confidences: { emotion: .2 }, affect: { happy: { value: .7, confidence: .9 }, sad: { value: .2, confidence: .8 } } });
  assert.match(formatted, /original user request is authoritative/);
  assert.match(formatted, /low confidence is weak evidence/);
  assert.match(formatted, /START only/);
  const evidence = JSON.parse(formatted.split('\n').at(-1));
  assert.equal(evidence.confidences.emotion, .2);
  assert.equal(evidence.affect.happy.confidence, .9);
  assert.equal(evidence.affect.sad.value, .2);
});

test('independent affect is baked into bounded starting face tracks without touching body, gaze, or blinking', async () => {
  const { applyJevExpressions } = await modulePromise;
  const spec = { duration: 5, tracks: { head: [{ t: 0, r: [0, 0, 0] }] }, hips: [{ t: 0, p: [0, 1, 0] }],
    expressions: { blink: [{ t: 0, w: 0 }, { t: 2, w: 1 }], lookLeft: [{ t: 0, w: .2 }] } };
  const original = structuredClone(spec);
  const result = applyJevExpressions(spec, { gaze: 'right', confidences: { gaze: 1 },
    affect: { happy: { value: .8, confidence: 1 }, sad: { value: .7, confidence: 1 } } });
  assert.deepEqual(spec, original);
  assert.notEqual(result, spec);
  assert.deepEqual(result.tracks, spec.tracks);
  assert.deepEqual(result.hips, spec.hips);
  assert.deepEqual(result.expressions.blink, spec.expressions.blink);
  assert.deepEqual(result.expressions.lookLeft, spec.expressions.lookLeft);
  assert.equal(result.expressions.lookRight, undefined);
  const happy = result.expressions.happy, sad = result.expressions.sad;
  assert.ok(happy[0].w > 0 && sad[0].w > 0);
  assert.ok(happy[0].w + sad[0].w <= 1);
  assert.deepEqual(happy.slice(-2), [{ t: 1.2, w: 0 }, { t: 5, w: 0 }]);
  assert.ok(happy.every((key, i) => !i || key.t > happy[i - 1].t));
});

test('authored neutral, zero, changing, and custom emotional faces are preserved as a whole', async () => {
  const { applyJevExpressions } = await modulePromise;
  const context = { affect: { happy: { value: 1, confidence: 1 } } };
  for (const expressions of [
    { neutral: [{ t: 0, w: 1 }] },
    { happy: [{ t: 0, w: 0 }, { t: 4, w: 0 }] },
    { sad: [{ t: 0, w: 0 }, { t: 4, w: .8 }] },
    { customSmile: [{ t: 0, w: .5 }] },
  ]) {
    const spec = { duration: 4, tracks: {}, expressions };
    assert.deepEqual(applyJevExpressions(spec, context), spec);
  }
  const blank = { duration: 4, tracks: {}, expressions: {} };
  assert.deepEqual(applyJevExpressions(blank, context, { preserveAuthored: true }), blank);
});

test('confidence attenuates each independent face; a choice distribution never becomes mixed emotion', async () => {
  const { applyJevExpressions } = await modulePromise;
  const spec = { duration: .4, tracks: {} };
  const result = applyJevExpressions(spec, { confidence: .01, affect: {
    happy: { value: 1, confidence: .1 }, sad: { value: .5, confidence: .9 }, angry: { value: 1, confidence: 0 },
  } });
  assert.equal(result.expressions.happy[0].w, .1);
  assert.equal(result.expressions.sad[0].w, .45);
  assert.equal(result.expressions.angry, undefined);
  assert.equal(result.expressions.happy.at(-1).t, .4);
  assert.deepEqual(applyJevExpressions(spec, { emotion: 'joy', confidence: .9,
    probabilities: { emotion: { joy: .5, sadness: .5 } } }), spec);
  assert.deepEqual(applyJevExpressions(spec, null), spec);
  assert.deepEqual(applyJevExpressions({ duration: NaN }, { affect: { happy: { value: 1, confidence: 1 } } }), { duration: NaN });
});
