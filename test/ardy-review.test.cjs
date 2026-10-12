const test = require('node:test');
const assert = require('node:assert/strict');
for (const visual of [false, true]) test(`ARDY correction regenerates once with images=${visual}`, async () => {
  const { refineArdyMotion } = await import('../src/ardyReview.js');
  const draft = { duration: 3, name: 'draft' }, candidate = { duration: 3, name: 'revised' };
  const metrics = { plannedContactSlideMps: null, maxFootDropBelowRestM: 0, meanTargetErrorM: null };
  let regenerations = 0, requests = 0;
  const result = await refineArdyMotion('walk', draft, {
    visual, model: 'mock', inspect: async () => ({ images: ['data:image/jpeg;base64,YQ=='], keyPositions: [], metrics }),
    request: async (messages,_key,_model,_delta,config) => {
      requests++;
      assert.equal(Array.isArray(messages.at(-1).content), visual);
      if (visual) assert.equal(messages.at(-1).content[1].type, 'image_url');
      if (config.outputType === 'assessment') return JSON.stringify({needed:true,reason:'修正が必要',issues:['足の滑り']});
      return JSON.stringify({ segments: [{ text: 'walk naturally', duration: 3 }], expression: null });
    },
    regenerate: async plan => { regenerations++; assert.equal(plan.segments[0].text, 'walk naturally'); return candidate; },
  });
  assert.equal(requests, 2); assert.equal(regenerations, 1); assert.equal(result.spec, candidate);
});
test('ARDY correction preserves draft on failure or metric regression', async () => {
  const { refineArdyMotion } = await import('../src/ardyReview.js');
  const draft = { duration: 3 }, candidate = { duration: 3 };
  const inspect = async spec => ({ images: [], keyPositions: [], metrics: { plannedContactSlideMps: null, meanTargetErrorM: null, maxFootDropBelowRestM: spec === draft ? 0 : 0.4 } });
  const request = async (_m,_k,_mo,_d,c) => JSON.stringify(c.outputType === 'assessment' ? {needed:true,reason:'修正',issues:[]} : { segments: [{ text: 'walk', duration: 3 }] });
  const rejected = await refineArdyMotion('walk', draft, { inspect, request, regenerate: async () => candidate });
  assert.equal(rejected.spec, draft); assert.equal(rejected.accepted, false);
  const failed = await refineArdyMotion('walk', draft, { inspect, request: async () => { throw new Error('quota'); } });
  assert.equal(failed.spec, draft); assert.equal(failed.error, 'quota');
});
test('Claude image adapter converts data URLs to native image blocks', async () => {
  const { claudeReviewMessages } = await import('../src/ardyReview.js');
  const output = claudeReviewMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } }] }]);
  assert.deepEqual(output[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YQ==' } });
});

test('ARDY review keeps Jev evidence in assessment, revised plan, regeneration, and result without raw payloads', async () => {
  const { refineArdyMotion } = await import('../src/ardyReview.js');
  const { toMotionSemanticContext } = await import('../src/jevMotionContext.js');
  const context = { emotion: 'affection', emotion_intensity: .7, movement_energy: .2,
    movement_scale: 'small', tempo: 'slow', social_intent: 'positive', confidence: .2,
    confidences: { emotion: .9, energy: .2 }, affect: { relaxed: { value: .6, confidence: .8 } },
    reaction: 'nod', apiKey: 'secret-do-not-forward' };
  const safe = toMotionSemanticContext(context);
  const draft = { duration: 3, name: 'draft', jevContext: context };
  const snapshot = structuredClone(draft);
  let calls = 0, regenerationContext;
  const result = await refineArdyMotion('自由に演じる', draft, {
    inspect: async () => ({ images: [], keyPositions: [], metrics: {} }),
    request: async (messages, _key, _model, _delta, config) => {
      calls++;
      const serialized = JSON.stringify(messages);
      assert.match(serialized, /affection/);
      assert.match(serialized, /original user request is authoritative/);
      assert.match(serialized, /relaxed/);
      assert.match(serialized, /confidences/);
      assert.doesNotMatch(serialized, /secret-do-not-forward/);
      return JSON.stringify(config.outputType === 'assessment'
        ? { needed: true, reason: '修正', issues: [] }
        : { segments: [{ text: 'A person moves freely.', duration: 3 }] });
    },
    regenerate: async (_correction, { motionContext }) => {
      regenerationContext = motionContext;
      return { duration: 3, name: 'candidate', jevContext: { apiKey: 'unsafe-generated-metadata' } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.accepted, true);
  assert.deepEqual(regenerationContext, safe);
  assert.deepEqual(result.spec.jevContext, safe);
  assert.deepEqual(result.draft.jevContext, safe);
  assert.deepEqual(draft, snapshot);
});
