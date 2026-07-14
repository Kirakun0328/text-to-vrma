// vrmaBuilder.js — モーション仕様 JSON から VRMA (VRMC_vrm_animation 拡張付き GLB) を生成する
import * as THREE from 'three';

// VRMA ファイル内に埋め込むレストポーズ骨格 (VRM1 規約: +Z 正面 / +X が左手側 / T ポーズ)
// [親ボーン名, ローカル平行移動]
export const SKELETON = {
  hips:          [null,           [0,     0.9,  0]],
  spine:         ['hips',         [0,     0.08, 0]],
  chest:         ['spine',        [0,     0.12, 0]],
  upperChest:    ['chest',        [0,     0.12, 0]],
  neck:          ['upperChest',   [0,     0.13, 0]],
  head:          ['neck',         [0,     0.08, 0]],
  leftShoulder:  ['upperChest',   [0.03,  0.10, 0]],
  leftUpperArm:  ['leftShoulder', [0.06,  0,    0]],
  leftLowerArm:  ['leftUpperArm', [0.24,  0,    0]],
  leftHand:      ['leftLowerArm', [0.22,  0,    0]],
  rightShoulder: ['upperChest',   [-0.03, 0.10, 0]],
  rightUpperArm: ['rightShoulder',[-0.06, 0,    0]],
  rightLowerArm: ['rightUpperArm',[-0.24, 0,    0]],
  rightHand:     ['rightLowerArm',[-0.22, 0,    0]],
  leftUpperLeg:  ['hips',         [0.09,  -0.02, 0]],
  leftLowerLeg:  ['leftUpperLeg', [0,     -0.38, 0]],
  leftFoot:      ['leftLowerLeg', [0,     -0.42, 0]],
  rightUpperLeg: ['hips',         [-0.09, -0.02, 0]],
  rightLowerLeg: ['rightUpperLeg',[0,     -0.38, 0]],
  rightFoot:     ['rightLowerLeg',[0,     -0.42, 0]],
};

export const HIPS_HEIGHT = 0.9;
export const BONE_NAMES = Object.keys(SKELETON);

const eulerQuat = (() => {
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  return (deg) => {
    e.set(
      THREE.MathUtils.degToRad(deg[0]),
      THREE.MathUtils.degToRad(deg[1]),
      THREE.MathUtils.degToRad(deg[2]),
      'XYZ'
    );
    q.setFromEuler(e);
    return [q.x, q.y, q.z, q.w];
  };
})();

/**
 * spec = {
 *   name: string,
 *   duration: number,          // 秒
 *   loop: boolean,
 *   tracks: { boneName: [{ t, r: [degX, degY, degZ] }, ...] },
 *   hips:   [{ t, p: [dx, dy, dz] }, ...]   // レスト位置からのオフセット(省略可)
 * }
 * @returns {ArrayBuffer} GLB 形式の .vrma バイナリ
 */
export function buildVRMA(spec) {
  const nodes = [];
  const nodeIndex = {};
  for (const name of BONE_NAMES) {
    nodeIndex[name] = nodes.length;
    nodes.push({ name: `J_${name}`, translation: [...SKELETON[name][1]] });
  }
  for (const name of BONE_NAMES) {
    const parent = SKELETON[name][0];
    if (parent !== null) {
      (nodes[nodeIndex[parent]].children ??= []).push(nodeIndex[name]);
    }
  }

  const binParts = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;

  function addAccessor(floatArray, type, isInput) {
    const byteLength = floatArray.byteLength;
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength });
    binParts.push(floatArray);
    binOffset += byteLength;
    const acc = {
      bufferView: bufferViews.length - 1,
      componentType: 5126, // FLOAT
      count: type === 'SCALAR' ? floatArray.length : floatArray.length / (type === 'VEC3' ? 3 : 4),
      type,
    };
    if (isInput) {
      // glTF 仕様: アニメーション入力アクセサは min/max 必須
      acc.min = [Math.min(...floatArray)];
      acc.max = [Math.max(...floatArray)];
    }
    accessors.push(acc);
    return accessors.length - 1;
  }

  const samplers = [];
  const channels = [];

  const trackEntries = Object.entries(spec.tracks ?? {}).filter(
    ([bone]) => bone in SKELETON
  );
  for (const [bone, keys] of trackEntries) {
    if (!keys?.length) continue;
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    const times = new Float32Array(sorted.map((k) => k.t));
    const values = new Float32Array(sorted.length * 4);
    sorted.forEach((k, i) => values.set(eulerQuat(k.r), i * 4));
    const input = addAccessor(times, 'SCALAR', true);
    const output = addAccessor(values, 'VEC4', false);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: nodeIndex[bone], path: 'rotation' },
    });
  }

  if (spec.hips?.length) {
    const sorted = [...spec.hips].sort((a, b) => a.t - b.t);
    const times = new Float32Array(sorted.map((k) => k.t));
    const values = new Float32Array(sorted.length * 3);
    sorted.forEach((k, i) =>
      values.set([k.p[0], HIPS_HEIGHT + k.p[1], k.p[2]], i * 3)
    );
    const input = addAccessor(times, 'SCALAR', true);
    const output = addAccessor(values, 'VEC3', false);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: nodeIndex.hips, path: 'translation' },
    });
  }

  if (channels.length === 0) {
    throw new Error('モーションにトラックがありません');
  }

  const humanBones = {};
  for (const name of BONE_NAMES) humanBones[name] = { node: nodeIndex[name] };

  const json = {
    asset: { version: '2.0', generator: 'text-to-motion' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
    scene: 0,
    scenes: [{ nodes: [nodeIndex.hips] }],
    nodes,
    animations: [{ name: spec.name ?? 'motion', channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binOffset }],
  };

  return packGLB(json, binParts, binOffset);
}

function packGLB(json, binParts, binLength) {
  const encoder = new TextEncoder();
  let jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binLength % 4)) % 4;

  const jsonChunkLen = jsonBytes.length + jsonPad;
  const binChunkLen = binLength + binPad;
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const buffer = new ArrayBuffer(total);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // 'glTF'
  dv.setUint32(o, 2, true); o += 4;
  dv.setUint32(o, total, true); o += 4;

  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  u8.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) u8[o++] = 0x20;

  dv.setUint32(o, binChunkLen, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN'
  for (const part of binParts) {
    u8.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), o);
    o += part.byteLength;
  }
  return buffer;
}
