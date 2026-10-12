const test = require('node:test');
const assert = require('node:assert/strict');

async function modules() {
  return { ...(await import('../src/authoredMotion.js')), ...(await import('three')) };
}
function body(duration = 4) {
  const times = Array.from({ length: Math.floor(duration * 20) + 1 }, (_, i) => i / 20);
  return { duration, loop: false, hips: times.map(t => ({ t, p: [.1 * t, 0, 0] })),
    tracks: { head: times.map(t => ({ t, r: [2 + t, -3 + t / 2, 1] })),
      neck: times.map(t => ({ t, r: [1, t, 0] })),
      leftUpperArm: times.map(t => ({ t, r: [0, 0, -70 + t] })) },
    expressions: { happy: [{ t: 0, w: 0 }, { t: duration, w: .3 }] } };
}
const segment = (head = [], gaze = [], duration = 2) => ({ duration, head, gaze });
const key = (spec, name, time) => (name === 'lookAt' ? spec.lookAt : spec.tracks[name]).find(key => Math.abs(key.t - time) < 1e-8);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const nearRotation = (api, a, b, order = 'XYZ') => {
  const quat = r => new api.Quaternion().setFromEuler(new api.Euler(...r.map(api.MathUtils.degToRad), order));
  near(quat(a).angleTo(quat(b)), 0, 1e-6);
};

test('authored head and gaze replace only their channels without mutating generated motion', async () => {
  const api = await modules(), source = body(), before = structuredClone(source);
  const plan = [segment([[0, 10, 20, 4], [1, 10, 20, 4]], [[0, 8, 16], [1, 8, 16]], 4)];
  const state = api.syncAuthoredMotion(null, plan, 0), stateBefore = structuredClone(state);
  const output = api.applyAuthoredMotion(source, state);
  assert.deepEqual(source, before);
  assert.deepEqual(state, stateBefore);
  assert.deepEqual(output.hips, source.hips);
  assert.deepEqual(output.tracks.neck, source.tracks.neck);
  assert.deepEqual(output.tracks.leftUpperArm, source.tracks.leftUpperArm);
  assert.deepEqual(output.expressions, source.expressions);
  assert.deepEqual(key(output, 'head', 0).r, key(source, 'head', 0).r);
  assert.deepEqual(key(output, 'head', .2).r, [10, 20, 4]);
  assert.deepEqual(key(output, 'lookAt', .2).r, [8, 16, 0]);
  assert.deepEqual(key(output, 'head', 4).r, [10, 20, 4], 'no invented final reset');
});

test('a head-free body interval blends back to generated head motion while empty gaze releases forward', async () => {
  const api = await modules(), source = body();
  const first = segment([[0, 4, 18, 0], [1, 4, 18, 0]], [[0, 9, 24], [1, 9, 24]]);
  const state = api.syncAuthoredMotion(null, [first, { ...segment(), body: ['head'] }], 0);
  const output = api.applyAuthoredMotion(source, state);
  for (const keyframe of source.tracks.head.filter(key => key.t > 2.15)) {
    assert.deepEqual(key(output, 'head', keyframe.t).r, keyframe.r);
  }
  assert.deepEqual(key(output, 'head', 2).r, [4, 18, 0]);
  assert.ok(key(output, 'head', 2.05).r[1] > 10, 'handoff must start from the visible authored head');
  assert.ok(key(output, 'head', 2.1).r[1] < key(output, 'head', 2.05).r[1]);
  near(key(output, 'lookAt', 2).r[1], 24);
  assert.ok(key(output, 'lookAt', 2.05).r[1] > 0);
  assert.deepEqual(key(output, 'lookAt', 2.2).r, [0, 0, 0]);
  assert.deepEqual(key(output, 'lookAt', 4).r, [0, 0, 0]);
  const unowned = api.applyAuthoredMotion(source, api.syncAuthoredMotion(null, [segment([], [], 4)]));
  assert.deepEqual(unowned.tracks, source.tracks);
  assert.ok(unowned.lookAt.every(key => key.r.every(angle => angle === 0)));
});

test('appending a generated-head handoff leaves the already displayed prefix intact', async () => {
  const api = await modules();
  const first = segment([[0, 3, 20, 1], [1, 8, 24, 3]], []);
  const previous = api.syncAuthoredMotion(null, [first]);
  const before = api.applyAuthoredMotion(body(2), previous);
  const next = api.syncAuthoredMotion(previous, [first, { ...segment(), body: ['head'] }]);
  const after = api.applyAuthoredMotion(body(4), next);
  for (const old of before.tracks.head) nearRotation(api, key(after, 'head', old.t).r, old.r);
  assert.deepEqual(key(after, 'head', 2).r, key(before, 'head', 2).r);
  assert.ok(key(after, 'head', 2.05).r[1] > 15);
  assert.deepEqual(key(after, 'head', 2.2).r, key(body(4), 'head', 2.2).r);
  const isolated = api.applyAuthoredMotion(body(4), api.syncAuthoredMotion(null, [{ ...segment([], [], 4), body: ['head'] }]));
  assert.deepEqual(isolated.tracks, body(4).tracks, 'unowned head without a prior authored pose must remain untouched');
});

test('prefix append preserves displayed samples and blends the next interval from the previous pose', async () => {
  const api = await modules();
  const first = segment([[0, 3, 5, 0], [.5, 6, 12, 2], [1, 8, 20, 4]], [[0, 0, 0], [1, 8, 20]]);
  const second = segment([[0, -10, -22, -3], [1, -6, -12, -1]], [[0, -8, -24], [1, 0, 0]]);
  const beforeState = api.syncAuthoredMotion(null, [first]);
  const before = api.applyAuthoredMotion(body(1.95), beforeState);
  const afterState = api.syncAuthoredMotion(beforeState, [first, second]);
  const after = api.applyAuthoredMotion(body(), afterState);
  for (const channel of ['head', 'lookAt']) {
    const keys = channel === 'head' ? before.tracks.head : before.lookAt;
    for (const old of keys) nearRotation(api, key(after, channel, old.t).r, old.r, channel === 'head' ? 'XYZ' : 'YXZ');
  }
  assert.deepEqual(key(after, 'head', 2).r, [8, 20, 4]);
  near(key(after, 'lookAt', 2).r[1], 20);
  assert.ok(key(after, 'head', 2.05).r[1] < 20 && key(after, 'head', 2.05).r[1] > -22);
});

test('instruction replacement truncates future curves while preserving the played prefix even within a blend', async () => {
  const api = await modules(), source = body();
  const original = segment([[0, 12, 24, 5], [1, -4, -15, -2]], [[0, 10, 23], [1, -9, -24]], 4);
  const previous = api.syncAuthoredMotion(null, [original]);
  for (const origin of [.07, 1.5]) {
    const replacement = api.syncAuthoredMotion(previous, [segment([], [], 2)], origin);
    const before = api.applyAuthoredMotion(source, previous), after = api.applyAuthoredMotion(source, replacement);
    for (const channel of ['head', 'lookAt']) {
      const keys = channel === 'head' ? before.tracks.head : before.lookAt;
      for (const old of keys.filter(key => key.t < origin)) nearRotation(api,
        key(after, channel, old.t).r, old.r, channel === 'head' ? 'XYZ' : 'YXZ');
    }
    assert.equal(replacement.intervals[0].end, origin);
    assert.equal(previous.intervals[0].end, 4);
    assert.deepEqual(after.lookAt.at(-1).r, [0, 0, 0]);
  }
});

test('lookAt is clipped to the visible prefix with its interpolated endpoint retained', async () => {
  const api = await modules(), state = api.syncAuthoredMotion(null,
    [segment([], [[0, 0, 0], [.5, 12, 24], [1, 0, 0]], 4)]);
  const output = api.applyAuthoredMotion(body(1.95), state);
  assert.ok(output.lookAt.every(key => key.t <= 1.95));
  assert.equal(output.lookAt.at(-1).t, 1.95);
  assert.ok(output.lookAt.at(-1).r[1] > 23);
  const noState = body();
  assert.deepEqual(api.applyAuthoredMotion(noState, null), noState);
});

test('fractional segment boundaries produce unique float32 key times for streamed VRMA', async () => {
  const api = await modules();
  const first = segment([[0, 2, 12, 0], [1, 4, 18, 1]], [[0, 2, 7], [1, 4, 12]], 1.2);
  const second = { ...segment([], [], 1.2), body: ['head'] };
  const output = api.applyAuthoredMotion(body(2.4), api.syncAuthoredMotion(null, [first, second]));
  for (const keys of [output.tracks.head, output.lookAt]) {
    const wireTimes = new Float32Array(keys.map(key => key.t));
    for (let i = 1; i < wireTimes.length; i++) assert.ok(wireTimes[i] > wireTimes[i - 1]);
  }
  assert.deepEqual(key(output, 'head', 1.35).r, key(body(2.4), 'head', 1.35).r);
});

test('authored display head and gaze survive standard VRMA export and installed loader', async () => {
  const api = await modules();
  const { buildVRMA } = await import('../src/vrmaBuilder.js');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
  const output = api.applyAuthoredMotion(body(), api.syncAuthoredMotion(null,
    [segment([[0, 5, 14, 2], [1, 11, -12, -4]], [[0, 4, 10], [1, -8, -20]], 4)]));
  const loader = new GLTFLoader().register(parser => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buildVRMA(output), '');
  const animation = gltf.userData.vrmAnimations[0];
  for (const [name, track, order] of [['head', animation.humanoidTracks.rotation.get('head'), 'XYZ'],
    ['lookAt', animation.lookAtTrack, 'YXZ']]) {
    const interpolant = track.createInterpolant();
    for (const time of [.2, 1.5, 3.5, 4]) {
      const actual = new api.Quaternion().fromArray(interpolant.evaluate(time));
      const expected = new api.Quaternion().setFromEuler(new api.Euler(...key(output, name, time).r.map(api.MathUtils.degToRad), order));
      near(actual.angleTo(expected), 0, .001);
    }
  }
});

test('malformed authored curves fail before modifying a prior plan', async () => {
  const api = await modules();
  for (const bad of [{}, [[0, 0, 0, 0]], [[0, 0, 0, NaN], [1, 0, 0, 0]], [[1, 0, 0, 0], [0, 0, 0, 0]]]) {
    assert.throws(() => api.syncAuthoredMotion(null, [segment(bad)]), /頭部・視線/);
  }
});
