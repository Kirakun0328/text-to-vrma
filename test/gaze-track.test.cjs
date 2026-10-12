const test = require('node:test');
const assert = require('node:assert/strict');

async function modules() {
  const [THREE, { GLTFLoader }, animation, vrm, builder, loop] = await Promise.all([
    import('three'), import('three/addons/loaders/GLTFLoader.js'),
    import('@pixiv/three-vrm-animation'), import('@pixiv/three-vrm'),
    import('../src/vrmaBuilder.js'), import('../src/loopPlayback.js'),
  ]);
  return { THREE, GLTFLoader, ...animation, ...vrm, ...builder, ...loop };
}

function decode(buffer) {
  const view = new DataView(buffer), length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  const binaryOffset = 28 + length;
  return { json, values(index) {
    const accessor = json.accessors[index], part = json.bufferViews[accessor.bufferView];
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
    return Array.from(new Float32Array(buffer, binaryOffset + part.byteOffset + (accessor.byteOffset || 0), accessor.count * size));
  } };
}

async function load(buffer, api) {
  const loader = new api.GLTFLoader();
  loader.register(parser => new api.VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer, '');
  return gltf.userData.vrmAnimations[0];
}

function avatar(api) {
  const scene = new api.THREE.Group(), head = new api.THREE.Object3D();
  head.name = 'avatarHead';
  const eyes = { leftEye: new api.THREE.Object3D(), rightEye: new api.THREE.Object3D() };
  head.add(...Object.values(eyes));
  scene.add(head);
  scene.updateMatrixWorld(true);
  const applied = [];
  const humanoid = { getRawBoneNode: name => name === 'head' ? head : eyes[name], getNormalizedBoneNode: name => name === 'head' ? head : eyes[name],
    normalizedRestPose: { hips: { position: [0, .9, 0] } } };
  const lookAt = new api.VRMLookAt(humanoid, { applyYawPitch: (yaw, pitch) => applied.push({ yaw, pitch }) });
  const proxy = new api.VRMLookAtQuaternionProxy(lookAt);
  proxy.name = 'avatarGaze';
  scene.add(proxy);
  return { scene, humanoid, lookAt, meta: { metaVersion: '1' }, applied, head, eyes };
}

const pose = (t, pitch, yaw) => ({ t, r: [pitch, yaw, 0] });
const spec = lookAt => ({ duration: 4, loop: false,
  tracks: { head: [{ t: 0, r: [0, 0, 0] }, { t: 4, r: [0, 0, 0] }] }, lookAt });
const near = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('native gaze is a scene-root quaternion channel independent of head and expressions', async () => {
  const api = await modules();
  const source = spec([pose(4, -8, -17), pose(0, 12, 21)]);
  const before = structuredClone(source);
  const { json, values } = decode(api.buildVRMA(source));
  const extension = json.extensions.VRMC_vrm_animation;
  const index = extension.lookAt.node;
  assert.ok(json.scenes[0].nodes.includes(index));
  assert.equal(json.nodes[index].name, 'L_lookAt');
  assert.ok(!Object.values(extension.humanoid.humanBones).some(bone => bone.node === index));
  assert.equal(extension.expressions, undefined);
  const channel = json.animations[0].channels.find(channel => channel.target.node === index);
  assert.equal(channel.target.path, 'rotation');
  const sampler = json.animations[0].samplers[channel.sampler];
  assert.deepEqual(values(sampler.input), [0, 4]);
  const q = new api.THREE.Quaternion().fromArray(values(sampler.output));
  const euler = new api.THREE.Euler().setFromQuaternion(q, 'YXZ');
  near(euler.x * 180 / Math.PI, 12);
  near(euler.y * 180 / Math.PI, 21);
  near(euler.z, 0);
  // +Z is the VRM1 face direction: +yaw looks character-left; +pitch looks down.
  const direction = new api.THREE.Vector3(0, 0, 1).applyQuaternion(q);
  assert.ok(direction.x > 0 && direction.y < 0 && direction.z > 0);
  assert.deepEqual(source, before);
});

test('the installed VRMA loader and animation mixer drive real VRMLookAt yaw and pitch', async () => {
  const api = await modules(), model = avatar(api);
  const animation = await load(api.buildVRMA(spec([pose(0, 12, 21), pose(1, -8, -17), pose(4, 0, 0)])), api);
  assert.ok(animation.lookAtTrack);
  const clip = api.createVRMAnimationClip(animation, model);
  const mixer = new api.THREE.AnimationMixer(model.scene);
  const action = mixer.clipAction(clip).setLoop(api.THREE.LoopOnce, 1).play();
  action.clampWhenFinished = true;
  mixer.update(0);
  model.lookAt.update(0);
  near(model.lookAt.pitch, 12);
  near(model.lookAt.yaw, 21);
  assert.ok(model.applied.length);
  mixer.update(1);
  model.lookAt.update(0);
  near(model.lookAt.pitch, -8);
  near(model.lookAt.yaw, -17);
  near(model.head.quaternion.angleTo(new api.THREE.Quaternion()), 0);
  mixer.update(3);
  model.lookAt.update(0);
  near(model.lookAt.pitch, 0);
  near(model.lookAt.yaw, 0);
});

test('saved loop gaze matches the preview seam and reloading does not bake the seam twice', async () => {
  const api = await modules(), model = avatar(api);
  const source = { ...spec([pose(0, 0, 0), pose(.8, 15, 24), pose(2.5, -7, -16), pose(4, 3, 5)]), loop: true };
  const ordinary = api.createVRMAnimationClip(await load(api.buildVRMA(source), api), model);
  const preview = api.prepareContinuousLoop(ordinary, 'absentHips').clip;
  const buffer = api.buildVRMA(source, { seamlessLoop: true });
  const { json } = decode(buffer);
  assert.equal(json.animations[0].extras.textToMotionLoop.prepared, true);
  const imported = api.createVRMAnimationClip(await load(buffer, api), model);
  const reloaded = api.prepareContinuousLoop(imported, 'absentHips', { prepared: true }).clip;
  const gazeTrack = clip => clip.tracks.find(track => track.name === 'avatarGaze.quaternion');
  const expected = gazeTrack(preview).createInterpolant();
  const actual = gazeTrack(reloaded).createInterpolant();
  for (const time of [0, .4, 1.5, 3.7, 4]) {
    const a = new api.THREE.Quaternion().fromArray(actual.evaluate(time));
    const b = new api.THREE.Quaternion().fromArray(expected.evaluate(time));
    near(a.angleTo(b), 0, .001);
  }
  const start = new api.THREE.Quaternion().fromArray(actual.evaluate(0));
  const end = new api.THREE.Quaternion().fromArray(actual.evaluate(4));
  near(start.angleTo(end), 0, .001);
  assert.ok(start.angleTo(new api.THREE.Quaternion()) > .1, 'loop time zero must use the same shifted source time as body tracks');
});

test('native gaze works with both installed bone and expression look-at appliers', async () => {
  const api = await modules();
  for (const kind of ['bone', 'expression']) {
    const model = avatar(api);
    const maps = Array.from({ length: 4 }, () => new api.VRMLookAtRangeMap(90, kind === 'bone' ? 90 : 1));
    let expressions;
    if (kind === 'bone') model.lookAt.applier = new api.VRMLookAtBoneApplier(model.humanoid, ...maps);
    else {
      expressions = new api.VRMExpressionManager();
      for (const name of ['lookLeft', 'lookRight', 'lookDown', 'lookUp']) expressions.registerExpression(new api.VRMExpression(name));
      model.lookAt.applier = new api.VRMLookAtExpressionApplier(expressions, ...maps);
    }
    const animation = await load(api.buildVRMA(spec([pose(0, 12, 21), pose(4, 12, 21)])), api);
    const mixer = new api.THREE.AnimationMixer(model.scene);
    mixer.clipAction(api.createVRMAnimationClip(animation, model)).play();
    mixer.update(.1);
    model.lookAt.update(0);
    if (kind === 'bone') for (const eye of Object.values(model.eyes)) {
      const direction = new api.THREE.Vector3(0, 0, 1).applyQuaternion(eye.quaternion);
      assert.ok(direction.x > 0 && direction.y < 0, 'eye bones must look character-left and down');
    } else {
      assert.ok(expressions.getValue('lookLeft') > 0);
      assert.ok(expressions.getValue('lookDown') > 0);
      assert.equal(expressions.getValue('lookRight'), 0);
      assert.equal(expressions.getValue('lookUp'), 0);
    }
  }
});

test('omitted and empty gaze keep existing VRMA behavior, and stopping gaze restores forward', async () => {
  const api = await modules(), model = avatar(api);
  for (const lookAt of [undefined, []]) {
    const buffer = api.buildVRMA(spec(lookAt));
    assert.equal(decode(buffer).json.extensions.VRMC_vrm_animation.lookAt, undefined);
    assert.equal((await load(buffer, api)).lookAtTrack, null);
  }
  const animation = await load(api.buildVRMA(spec([pose(0, 9, 18), pose(4, 9, 18)])), api);
  const mixer = new api.THREE.AnimationMixer(model.scene);
  mixer.clipAction(api.createVRMAnimationClip(animation, model)).play();
  mixer.update(.1);
  near(model.lookAt.yaw, 18);
  mixer.stopAllAction();
  model.lookAt.update(0);
  near(model.lookAt.yaw, 0);
  near(model.lookAt.pitch, 0);
});

test('invalid gaze cannot silently produce corrupt rotations or ambiguous times', async () => {
  const { buildVRMA } = await modules();
  for (const invalid of [{}, [null], [pose(0, NaN, 1)], [pose(-1, 0, 0)],
    [pose(0, 0, 0), pose(0, 2, 4)], [{ t: 0, r: [0, 0, 3] }], [{ t: 0, r: [0, 0] }]]) {
    assert.throws(() => buildVRMA(spec(invalid)), /視線トラック/);
  }
});
