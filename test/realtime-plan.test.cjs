const test = require('node:test');
const assert = require('node:assert/strict');
test('live planner requests only compact Codex acting output and passes user context', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  const result = await planRealtimeMotion('wave twice', { model: 'selected', duration: 6, motionContext: { emotion: 'joy' }, request: async input => {
    assert.equal(input.outputType, 'realtime'); assert.equal(input.effort, 'low');
    assert.equal(input.model, 'selected');
    assert.deepEqual(JSON.parse(input.messages[1].content), { text: 'wave twice', duration: 6, jev: { emotion: 'joy', confidences: { emotion: 0 } } });
    return JSON.stringify({ segments: [{ text: 'A person waves twice.', duration: 6 }], expression: 'happy' });
  } });
  assert.equal(result.segments.length, 1);
});
test('live planner rejects invalid output and canceled results', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  await assert.rejects(planRealtimeMotion('wave', { request: async () => '{"segments":[]}' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(planRealtimeMotion('wave', { signal: controller.signal, request: () => assert.fail('aborted') }));
});

test('Astra face design preserves emotional changes and normalizes mixtures', async () => {
  const { planRealtimeMotion, plannedFaceTracks } = await import('../src/realtimePlan.js');
  const key = (at, happy, sad) => ({at,happy,sad,angry:0,surprised:0,relaxed:0});
  const result = await planRealtimeMotion('happy then sad', { duration:6, request:async()=>JSON.stringify({
    segments:[{text:'A person becomes sad.',duration:6}], expression:'happy', face:[key(0,0,0),key(.5,1,1),key(1,0,.8)],
  }) });
  assert.equal(result.face[1].happy,.5); assert.equal(result.face[1].sad,.5);
  const tracks=plannedFaceTracks(result.face,5.95);
  assert.equal(tracks.sad.at(-1).t,5.95); assert.equal(tracks.sad.at(-1).w,.8);
  assert.equal(tracks.happy.at(-1).w,0);
  await assert.rejects(planRealtimeMotion('bad', {request:async()=>JSON.stringify({segments:[{text:'wave',duration:6}],face:[key(.5,0,0),key(.5,0,0)]})}),/表情/);
});

test('unsupported avatar expressions do not become visible animation channels', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  const face=[0,1].map(at=>({at,happy:.5,sad:.5,angry:0,surprised:0,relaxed:0}));
  const result=await planRealtimeMotion('smile', {availableExpressions:['sad'],request:async()=>JSON.stringify({segments:[{text:'A person smiles.',duration:6}],face})});
  assert.equal(result.face[0].happy,0); assert.equal(result.face[0].sad,.5);
});

test('Jev body-reaction categories cannot replace the free-form instruction', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  const motionContext = { reaction: 'greeting', emotion: 'joy', movement_energy: 0.7,
    confidences: { reaction: 0.9, emotion: 0.8 }, probabilities: { reaction: { greeting: 0.9 } }, uncertain_fields: ['reaction'] };
  const text = 'a new movement chosen by the user';
  await planRealtimeMotion(text, { motionContext, request: async input => {
    const supplied = JSON.parse(input.messages[1].content);
    assert.equal(supplied.text, text);
    assert.equal(supplied.jev.reaction, undefined);
    assert.equal(supplied.jev.emotion, 'joy');
    assert.equal(supplied.jev.movement_energy, 0.7);
    assert.equal(supplied.jev.confidences.reaction, undefined);
    assert.equal(supplied.jev.confidences.emotion, 0.8);
    assert.equal(supplied.jev.probabilities, undefined);
    assert.equal(supplied.jev.uncertain_fields, undefined);
    return JSON.stringify({ segments: [{ text, duration: 4 }] });
  } });
  assert.equal(motionContext.reaction, 'greeting', 'input context must not be mutated');
  assert.equal(motionContext.confidences.reaction, 0.9);
});

test('body plan becomes usable before face output; escaped braces cannot trick the parser', async () => {
  const { planRealtimeMotion, completedPlanFields } = await import('../src/realtimePlan.js');
  const segments = [{ text: 'A person describes "{a,b}" while stepping.', duration: 6 }];
  const body = JSON.stringify({ continuous: true, segments }).slice(0, -1);
  let early;
  const result = await planRealtimeMotion('walk', {
    onBodyPlan: value => { early = value; },
    request: async (_input, { onDelta }) => {
      for (const letter of body) onDelta(letter);
      assert.equal(early, undefined, 'incomplete field delimiter');
      onDelta(',');
      assert.deepEqual(early.segments, segments);
      onDelta('"expression":"neutral"}');
      return body + ',"expression":"neutral"}';
    },
  });
  assert.deepEqual(result.segments, segments);
  assert.deepEqual(completedPlanFields('{"nested":{"segments":[]},"segments":[').nested, { segments: [] });
  assert.throws(() => completedPlanFields('{"segments":[],"segments":[],'), /重複/);
});

test('a body plan changed in final output fails rather than silently mismatching generated motion', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  await assert.rejects(planRealtimeMotion('walk', { onBodyPlan() {}, request: async (_input, { onDelta }) => {
    onDelta('{"continuous":true,"segments":[{"text":"A person walks.","duration":6}],');
    return '{"segments":[{"text":"A person sits.","duration":6}]}';
  } }), /一致/);
});

test('compact face rows preserve exactly the same authored timing and weights', async () => {
  const { planRealtimeMotion } = await import('../src/realtimePlan.js');
  const base = { segments: [{ text: 'A person bows.', duration: 6 }], expression: 'neutral' };
  const rows = [[0, 0, 0.6, 0, 0, 0], [0.5, 0.4, 0.2, 0, 0, 0], [1, 0.8, 0, 0, 0, 0]];
  const objects = rows.map(row => Object.fromEntries(['at','happy','sad','angry','surprised','relaxed'].map((name, i) => [name, row[i]])));
  const run = face => planRealtimeMotion('bow', { request: async () => JSON.stringify({ ...base, face }) });
  assert.deepEqual((await run(rows)).face, (await run(objects)).face);
  await assert.rejects(run([[0, 0], [1, 0]]), /表情/);
  await assert.rejects(run([null, null]), /表情/);
});

const streamSegment = (text, duration, continuous = false, face = [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]]) =>
  ({ text, duration, continuous, face });
const streamPlan = (segments, duration = 6, continuous = false) => ({ continuous, duration, segments });

test('progressive planner emits a complete first segment before the next action or its face, exactly once', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const first = streamSegment('A person describes "{a,b}" and \\ while stepping.', 2);
  const last = streamSegment('A person stops with the requested final posture.', 4);
  const expected = streamPlan([first, last]);
  const emitted = [];
  const result = await planRealtimeMotionStream('move then stop', {
    model: 'selected-model', duration: 6, state: { posture: 'specified' },
    motionContext: { emotion: 'joy', confidence: 0.2, confidences: { emotion: 0.9 }, reaction: 'greeting' },
    onSegment: value => emitted.push(value),
    request: async (input, { onDelta }) => {
      assert.equal(input.outputType, 'realtime_stream'); assert.equal(input.effort, 'low');
      assert.equal(input.model, 'selected-model');
      const user = JSON.parse(input.messages[1].content);
      assert.equal(user.text, 'move then stop'); assert.deepEqual(user.state, { posture: 'specified' });
      assert.equal(user.jev.confidences.emotion, 0.9); assert.equal(user.jev.reaction, undefined);
      const prefix = `{"continuous":false,"duration":6,"segments":[${JSON.stringify(first)}`;
      for (const char of prefix.slice(0, -1)) onDelta(char);
      assert.equal(emitted.length, 0, 'a partial segment cannot be executed');
      onDelta('}');
      assert.equal(emitted.length, 1, 'the next segment and enclosing array are not needed');
      assert.equal(emitted[0].index, 0); assert.equal(emitted[0].duration, 6); assert.equal(emitted[0].continuous, false);
      assert.equal(emitted[0].segment.text, first.text);
      const tail = JSON.stringify(last);
      const split = tail.indexOf('"face"') + 8;
      onDelta(`,${tail.slice(0, split)}`);
      assert.equal(emitted.length, 1, 'a later partial face does not delay or repeat the first segment');
      onDelta(`${tail.slice(split)}]}`);
      assert.equal(emitted.length, 2);
      return JSON.stringify(expected);
    },
  });
  assert.deepEqual(result.segments, emitted.map(event => event.segment));
  assert.equal(result.duration, 6);
});

test('progressive face normalization is stable from emission to final and protects against callback mutation', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const original = streamPlan([streamSegment('A person moves.', 6, true, [[0, 0.8, 0.8, 0.2, 0, 0], [1, 0.4, 0.4, 0.2, 0, 0]])], 6, true);
  let delivered;
  const result = await planRealtimeMotionStream('move', { availableExpressions: ['happy', 'sad'], onSegment: event => {
    delivered = structuredClone(event.segment);
    event.segment.duration = 30; event.segment.face[0].happy = 99;
  }, request: async (_, { onDelta }) => {
    const text = JSON.stringify(original);
    onDelta(text.slice(0, -2)); onDelta(']'); onDelta('}');
    return text;
  } });
  assert.equal(delivered.face[0].happy, 0.5); assert.equal(delivered.face[0].sad, 0.5);
  assert.equal(delivered.face[0].angry, 0);
  assert.deepEqual(result.segments[0], delivered);
  assert.equal(original.segments[0].face[0][1], 0.8);
});

test('progressive planner never rescales committed durations, and permits naturally chosen auto durations', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const value = streamPlan([streamSegment('A person performs the requested action.', 0.4), streamSegment('A person holds the requested ending.', 1.8)], 2.2);
  const emitted = [];
  const result = await planRealtimeMotionStream('short action', { duration: 6, autoDuration: true, onSegment: event => emitted.push(event),
    request: async (_, { onDelta }) => { const text = JSON.stringify(value); onDelta(text); return text; } });
  assert.equal(result.duration, 2.2);
  assert.deepEqual(result.segments.map(segment => segment.duration), [0.4, 1.8]);
  assert.deepEqual(emitted.map(event => event.segment.duration), [0.4, 1.8]);
  await assert.rejects(planRealtimeMotionStream('manual action', { duration: 6, request: async () => JSON.stringify(value) }), /合計時間/);
});

test('progressive planner rejects changed headers, removed segments and every changed committed field', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const first = streamSegment('A person moves as requested.', 2);
  const second = streamSegment('A person maintains the requested pose.', 4);
  const base = streamPlan([first, second]);
  const modifications = [
    value => { value.continuous = true; },
    value => { value.duration = 8; value.segments[1].duration = 6; },
    value => { value.segments[0].text = 'A different motion.'; },
    value => { value.segments[0].continuous = true; },
    value => { value.segments[0].duration = 4; value.segments[1].duration = 2; },
    value => { value.segments[0].face[0][2] = 0.8; },
    value => { value.segments = []; },
  ];
  for (const change of modifications) {
    const altered = structuredClone(base); change(altered);
    await assert.rejects(planRealtimeMotionStream('move', { autoDuration: true, availableExpressions: ['happy'], onSegment() {},
      request: async (_, { onDelta }) => {
        onDelta(`{"continuous":false,"duration":6,"segments":[${JSON.stringify(first)}`);
        return JSON.stringify(altered);
      } }), /一致|不正/, 'completed output cannot change any committed field, even unsupported face weights');
  }
});

test('progressive planner rejects invalid durations, face bounds, count and schema before emission', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const good = streamPlan([streamSegment('A person moves.', 6)]);
  const invalid = [];
  for (const duration of [0, 1.8, 30.2, 6.1]) invalid.push({ ...good, duration });
  for (const duration of [0.2, 1.1, 5.8, 6.2, '6']) invalid.push(streamPlan([streamSegment('A person moves.', duration)]));
  invalid.push(streamPlan([]));
  invalid.push(streamPlan(Array.from({ length: 12 }, () => streamSegment('A person moves.', 0.4))));
  invalid.push(streamPlan(Array.from({ length: 13 }, () => streamSegment('A person moves.', 0.4)), 5.2));
  invalid.push({ ...good, continuous: 'true' });
  invalid.push(streamPlan([{ ...good.segments[0], unexpected: true }]));
  invalid.push(streamPlan([{ ...good.segments[0], text: '   ' }]));
  invalid.push(streamPlan([{ ...good.segments[0], continuous: null }]));
  for (const face of [null, [], [[0, 0], [1, 0]], [[0.1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]],
    [[0, -0.1, 0, 0, 0, 0], [1, 1.1, 0, 0, 0, 0]],
    [{ at: 0, happy: 0 }, { at: 1, happy: 0 }]]) invalid.push(streamPlan([streamSegment('A person moves.', 6, false, face)]));
  for (const value of invalid) {
    let emitted = 0;
    await assert.rejects(planRealtimeMotionStream('move', { autoDuration: true, onSegment: () => emitted++,
      request: async (_, { onDelta }) => { const text = JSON.stringify(value); onDelta(text); return text; } }));
    assert.equal(emitted, 0);
  }
});

test('malformed, duplicated or nested streaming JSON cannot inject a usable segment', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const segment = JSON.stringify(streamSegment('A person moves.', 6));
  const prefix = '{"continuous":false,"duration":6,"segments":[';
  for (const text of [
    `${prefix}${segment.slice(0, -1)}`,
    `${prefix}${segment.replace('"duration":6', '"duration":6,"duration":6')}]}`,
    `${prefix}${segment.replace('"text":', '"text"=')}]}`,
    `{"continuous":false,"continuous":true,"duration":6,"segments":[${segment}]}`,
    `{"segments":[${segment}],"continuous":false,"duration":6}`,
    `{"wrapper":{"continuous":false,"duration":6,"segments":[${segment}]}}`,
    `${prefix}${segment}]},`,
    `${prefix}${segment},]}`,
  ]) {
    let emitted = 0;
    await assert.rejects(planRealtimeMotionStream('move', { onSegment: () => emitted++, request: async (_, { onDelta }) => {
      onDelta(text); return text;
    } }));
    assert.equal(emitted, 0, text);
  }
});

test('progressive planner cancellation settles a stalled request and ignores its late deltas', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const controller = new AbortController();
  let emit, finish, callbacks = 0;
  const pending = planRealtimeMotionStream('move', { signal: controller.signal, onSegment: () => callbacks++,
    request: (_, { onDelta }) => { emit = onDelta; return new Promise(resolve => { finish = resolve; }); } });
  emit('{"continuous":false,"duration":6,"segments":[');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  emit(`${JSON.stringify(streamSegment('A person moves.', 6))}]}`);
  finish(JSON.stringify(streamPlan([streamSegment('A person moves.', 6)])));
  assert.equal(callbacks, 0);
  await assert.rejects(planRealtimeMotionStream('move', { signal: controller.signal, request: () => assert.fail('pre-aborted') }), { name: 'AbortError' });
});

test('cancellation during final-only segment delivery cannot resolve a successful plan', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const controller = new AbortController();
  await assert.rejects(planRealtimeMotionStream('move', { signal: controller.signal, onSegment: () => controller.abort(),
    request: async () => JSON.stringify(streamPlan([streamSegment('A person moves.', 6)])) }), { name: 'AbortError' });
});

test('authored body ownership and independent head/gaze survive streaming without callback mutation', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const s = { text: 'A person maintains their physical posture.', duration: 2, continuous: false,
    body: [], head: [], gaze: [[0, 0, 0], [.4, 0, 24], [1, 0, 0]], face: [[0, 0, 0, 0, 0, 0], [1, .4, 0, 0, 0, 0]] };
  const json = JSON.stringify(streamPlan([s], 2));
  const result = await planRealtimeMotionStream('brief gaze', { duration: 2, onSegment: ({ segment }) => {
    segment.body.push('leftArm'); segment.gaze[1][2] = 99;
  }, request: async (_, { onDelta }) => { onDelta(json.slice(0, -2)); return json; } });
  assert.deepEqual(result.segments[0].body, []);
  assert.deepEqual(result.segments[0].gaze, s.gaze);
});

test('invalid ownership, duplicate groups, conflicting head channels and invalid orientation curves fail closed', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const s = { text: 'A person moves.', duration: 2, continuous: false, body: [], head: [], gaze: [],
    face: [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]] };
  const changes = [
    { body: ['smile'] }, { body: ['root', 'root'] }, { body: null },
    { body: ['head'], head: [[0, 0, 0, 0], [1, 10, 0, 0]] },
    { head: [[0, 0, 0, 0], [1, 61, 0, 0]] }, { gaze: [[0, 0, 0]] },
    { gaze: [[0, 0, 0], [1, 0, 46]] }, { gaze: [[0, 0, 0], [.5, 0, 0]] },
    { head: [[0, 0, 0, 0], [0, 0, 0, 0]] },
  ];
  for (const change of changes) await assert.rejects(planRealtimeMotionStream('move', { duration: 2,
    request: async () => JSON.stringify(streamPlan([{ ...s, ...change }], 2)) }));
});

test('root translation permissions survive streaming and reject malformed controls', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const s = { text: 'A person moves in place.', duration: 2, continuous: true,
    body: ['root', 'leftLeg', 'rightLeg'], rootAxes: [false, true, false], head: [], gaze: [], face: [] };
  const json = JSON.stringify(streamPlan([s], 2));
  const result = await planRealtimeMotionStream('move', { duration: 2, onSegment: ({ segment }) => { segment.rootAxes[0] = true; },
    request: async (_, { onDelta }) => { onDelta(json); return json; } });
  assert.deepEqual(result.segments[0].rootAxes, [false, true, false]);
  for (const rootAxes of [null, [], [false, true], [false, 1, false], [false, true, false, true]]) {
    await assert.rejects(planRealtimeMotionStream('move', { duration: 2,
      request: async () => JSON.stringify(streamPlan([{ ...s, rootAxes }], 2)) }));
  }
});

test('compact ownership preserves every group and axis combination without changing legacy plans', async () => {
  const { planRealtimeMotionStream, BODY_GROUPS } = await import('../src/realtimePlan.js');
  const read = (body, rootAxes) => planRealtimeMotionStream('move', { duration: 2,
    request: async () => JSON.stringify(streamPlan([{ text: 'A person moves.', duration: 2, continuous: false,
      body, rootAxes, head: [], gaze: [], face: [] }], 2)) });
  for (let mask = 0; mask < 128; mask++) {
    const groups = BODY_GROUPS.filter((_, index) => mask & (1 << index));
    assert.deepEqual((await read(mask, 7)).segments, (await read(groups, [true, true, true])).segments);
  }
  for (let mask = 0; mask < 8; mask++) {
    const axes = [1, 2, 4].map(bit => !!(mask & bit));
    assert.deepEqual((await read(127, mask)).segments, (await read(BODY_GROUPS, axes)).segments);
  }
  for (const bad of [-1, 128, 1.2, null, '127']) await assert.rejects(read(bad, 7));
  for (const bad of [-1, 8, 1.2, null, '7']) await assert.rejects(read(127, bad));
});

test('zero-elided facial curves reproduce full weights exactly, including neutral and mixed emotion transitions', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const base = { text: 'A person remains still.', duration: 2, continuous: false, body: [], head: [], gaze: [] };
  const read = face => planRealtimeMotionStream('expression', { duration: 2,
    request: async () => JSON.stringify(streamPlan([{ ...base, face }], 2)) });
  for (const compact of [[], [[0, .2], [.5, .5, .3], [1, 0, .6]], [[0], [.3, 0, 0, .5], [1, 0, 0, 0, .2, .1]]]) {
    const full = (compact.length ? compact : [[0], [1]]).map(row => [...row, ...Array(6 - row.length).fill(0)]);
    assert.deepEqual((await read(compact)).segments[0].face, (await read(full)).segments[0].face);
  }
  for (const bad of [[[]], [[0], []], [[0]], [[.2], [1]], [[0], [0]], [[0, null], [1]], [[0, 0, 0, 0, 0, 0, 0], [1]]]) {
    await assert.rejects(read(bad));
  }
});

test('explicit turns preserve numeric intent and reject incompatible pivot permissions', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const read = (turn, body = 127, rootAxes = 7) => planRealtimeMotionStream('half turn on the left foot', { duration: 4,
    request: async () => JSON.stringify(streamPlan([{ text:'A person pivots.',duration:4,continuous:false,
      body,rootAxes,jev:0,turn,head:[],gaze:[],face:[] }],4)) });
  assert.deepEqual((await read([180,1])).segments[0].turn,[180,1]);
  assert.deepEqual((await read([-360,2])).segments[0].turn,[-360,2]);
  assert.deepEqual((await read([])).segments[0].turn,[]);
  for (const turn of [null,[180],[180,3],[180,1.5],[721,0],['180',1],[180,1,0]]) await assert.rejects(read(turn));
  await assert.rejects(read([180,1],126));
  await assert.rejects(read([180,1],127,2));
});

test('captions that require lowered arms mark only the frozen arms; raised poses and holds are unmarked', async () => {
  const { markLoweredArmTargets } = await import('../src/realtimePlan.js');
  const run = (text, body) => markLoweredArmTargets({ text, body: [...body] });
  const legs = ['root', 'torso', 'leftLeg', 'rightLeg'];
  const rise = run('A person rises from a deep squat to an upright standing posture with both arms down at their sides.', legs);
  assert.deepEqual(rise, { text: rise.text, body: legs, lowerArms: ['leftArm', 'rightArm'] });
  assert.deepEqual(run('A person lowers the right arm while stepping back.', legs).lowerArms, ['rightArm']);
  assert.deepEqual(run('A person stands with the left arm at their side.', ['root']).lowerArms, ['leftArm']);
  assert.deepEqual(run('A person lowers both arms to their sides.', ['leftArm', 'rightArm']).lowerArms, undefined);
  assert.equal(run('A person jumps three times, keeping both arms raised overhead.', legs).lowerArms, undefined);
  assert.equal(run('A person holds a deep squat with both arms down.', []).lowerArms, undefined);
  assert.equal(run('A person bows deeply.', legs).lowerArms, undefined);
});

test('a streamed segment requiring arms down carries lowerArms without changing ownership', async () => {
  const { planRealtimeMotionStream } = await import('../src/realtimePlan.js');
  const s = { text: 'A person stands up with both arms down at their sides.', duration: 2, continuous: false,
    body: 1 + 2 + 32 + 64, rootAxes: 2, jev: 0, turn: [], head: [], gaze: [], face: [] };
  const result = await planRealtimeMotionStream('stand', { duration: 2,
    request: async () => JSON.stringify(streamPlan([s], 2)) });
  assert.deepEqual(result.segments[0].body, ['root', 'torso', 'leftLeg', 'rightLeg']);
  assert.deepEqual(result.segments[0].lowerArms, ['leftArm', 'rightArm']);
});
