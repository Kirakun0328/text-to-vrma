const test = require('node:test');
const assert = require('node:assert/strict');
const plan = { duration: 2, phases: [{ start: 0, end: 2, support: 'both', targets: [{ bone: 'leftHand', position: [0, 1, 0] }] }] };
const spec = { name: 'test', duration: 2, loop: false, tracks: { head: [{ t: 0, r: [0, 0, 0] }, { t: 2, r: [10, 0, 0] }] } };

test('planned foot contact measures slide, flight does not count as slide', async () => {
  const { measureMotion } = await import('../src/motionReview.js');
  const frames = [0, 1, 2].map(t => ({ t, positions: { leftFoot: [t, 0.1, 0], rightFoot: [0, 0.1, 0], leftHand: [0, 1, 0] } }));
  const rest = { leftFoot: [0, 0.1, 0], rightFoot: [0, 0.1, 0] };
  assert.equal(measureMotion(frames, plan, rest).plannedContactSlideMps, 0.5);
  assert.equal(measureMotion(frames, plan, rest).meanTargetErrorM, 0);
  assert.equal(measureMotion(frames, { ...plan, phases: [{ ...plan.phases[0], support: 'none' }] }, rest).plannedContactSlideMps, null);
});

test('invalid phase timing and nonfinite targets fail before generation', async () => {
  const { validatePlan } = await import('../src/motionReview.js');
  assert.throws(() => validatePlan({ ...plan, phases: [{ ...plan.phases[0], start: 1 }] }));
  assert.throws(() => validatePlan({ ...plan, phases: [{ ...plan.phases[0], targets: [{ bone: 'leftHand', position: [NaN, 0, 0] }] }] }));
});

for (const regression of [false, true]) test(`pipeline sends actual images and ${regression ? 'rejects worse' : 'accepts'} revision`, async () => {
  const { generateReviewedMotion } = await import('../src/motionReview.js');
  const calls = []; let measured = 0;
  const request = async messages => {
    calls.push(messages);
    return JSON.stringify(calls.length === 1 ? plan : { ...spec, name: calls.length === 2 ? 'draft' : 'candidate' });
  };
  const result = await generateReviewedMotion('nod', '', 'gpt-6-astra', {
    request, skeleton: { height: 1.6 }, inspect: async () => ({
      images: ['data:image/jpeg;base64,AA==', 'data:image/jpeg;base64,AQ=='], keyPositions: [],
      metrics: { plannedContactSlideMps: measured++ && regression ? 1 : 0, maxFootDropBelowRestM: 0, meanTargetErrorM: 0 },
    }),
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].at(-1).content.filter(p => p.type === 'image_url').length, 2);
  assert.equal(result.spec.name, regression ? 'draft' : 'candidate');
  assert.equal(result.accepted, !regression);
});

test('review failure preserves inspectable draft', async () => {
  const { generateReviewedMotion } = await import('../src/motionReview.js');
  let n = 0;
  const result = await generateReviewedMotion('nod', '', 'gpt-6-astra', {
    skeleton: {}, request: async () => { if (++n === 3) throw new Error('quota'); return JSON.stringify(n === 1 ? plan : spec); },
    inspect: async () => ({ images: [], metrics: {}, keyPositions: [] }),
  });
  assert.equal(result.spec.name, 'test'); assert.equal(result.error, 'quota');
});

test('fast review forwards low effort and publishes draft before image correction', async () => {
  const {generateReviewedMotion}=await import('../src/motionReview.js');
  let n=0,draftSeen=false;
  const result=await generateReviewedMotion('nod','','gpt-6-astra',{
    speed:'fast',skeleton:{},onDraft:async()=>{draftSeen=true;},
    request:async(messages,key,model,delta,options)=>{assert.equal(options.effort,'low');if(++n===3)assert.equal(draftSeen,true);return JSON.stringify(n===1?plan:spec);},
    inspect:async()=>({images:[],keyPositions:[],metrics:{}}),
  });
  assert.equal(result.speed,'fast');assert.ok(result.timing.totalSeconds>=result.timing.draftSeconds);
});

test('image review retains sanitized Jev evidence through planning, draft, correction, and rejected fallback', async () => {
  const { generateReviewedMotion } = await import('../src/motionReview.js');
  const { toMotionSemanticContext } = await import('../src/jevMotionContext.js');
  const motionContext = { emotion: 'affection', confidence: .15, confidences: { emotion: .9 },
    affect: { happy: { value: .7, confidence: .85 }, relaxed: { value: .3, confidence: .8 } },
    reaction: 'nod', apiKey: 'secret-do-not-forward' };
  const safe = toMotionSemanticContext(motionContext);
  const calls = []; let measured = 0, published;
  const result = await generateReviewedMotion('自由な演技', '', 'mock', {
    motionContext, skeleton: {}, onDraft: draft => { published = draft; },
    request: async messages => {
      calls.push(messages);
      const serialized = JSON.stringify(messages);
      assert.match(serialized, /original user request is authoritative/);
      assert.match(serialized, /affection/);
      assert.match(serialized, /happy/);
      assert.doesNotMatch(serialized, /secret-do-not-forward|"reaction"/);
      return JSON.stringify(calls.length === 1 ? plan : { ...spec, jevContext: { apiKey: 'injected' } });
    },
    inspect: async () => ({ images: [], keyPositions: [], metrics: { plannedContactSlideMps: measured++ ? 1 : 0 } }),
  });
  assert.equal(calls.length, 3);
  assert.equal(result.accepted, false);
  for (const output of [published, result.draft, result.candidate, result.spec]) assert.deepEqual(output.jevContext, safe);
  assert.equal(motionContext.apiKey, 'secret-do-not-forward');
});

test('image review does not let the model invent Jev analysis when no context was supplied', async () => {
  const { generateReviewedMotion } = await import('../src/motionReview.js');
  let calls = 0;
  const result = await generateReviewedMotion('nod', '', 'mock', {
    skeleton: {}, request: async messages => {
      assert.doesNotMatch(JSON.stringify(messages), /Optional Jev semantic evidence/);
      return JSON.stringify(++calls === 1 ? plan : { ...spec, jevContext: { emotion: 'joy', confidence: 1 } });
    }, inspect: async () => ({ images: [], keyPositions: [], metrics: {} }),
  });
  assert.equal(result.spec.jevContext, undefined);
  assert.equal(result.draft.jevContext, undefined);
});
