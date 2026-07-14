// generateSampleVRM.mjs — 再配布可能なサンプル VRM (VRM 1.0) をプログラムで生成する
//
//   node scripts/generateSampleVRM.mjs
//   → public/models/SampleBot.vrm
//
// 箱ポリゴンのロボット型ヒューマノイド。スキンメッシュ + VRMC_vrm 1.0 拡張付き。
// 完全に本リポジトリ発のモデルなので自由に再配布できます。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKELETON, BONE_NAMES } from '../src/vrmaBuilder.js';

// --- 骨格ワールド座標 (Tポーズ・回転なしなので平行移動の累積) ---
const world = {};
for (const name of BONE_NAMES) {
  const [parent, t] = SKELETON[name];
  const p = parent ? world[parent] : [0, 0, 0];
  world[name] = [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
}

// --- ジオメトリ構築 (楕円体ベースのローポリ人間) ---
const PRIM_NAMES = ['skin', 'hair', 'shirt', 'pants', 'dark'];
const positions = [];
const normals = [];
const joints = [];
const weights = [];
const primIndices = Object.fromEntries(PRIM_NAMES.map((p) => [p, []]));
let vertCount = 0;

const boneIndex = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

/** 中心 c・半径 r=[rx,ry,rz] の楕円体を bone にバインドして追加 */
function ellipsoid(prim, c, r, bone, latSeg = 10, lonSeg = 14) {
  const bi = boneIndex[bone];
  const base = vertCount;
  for (let i = 0; i <= latSeg; i++) {
    const theta = (i / latSeg) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let j = 0; j <= lonSeg; j++) {
      const phi = (j / lonSeg) * Math.PI * 2;
      const dir = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      positions.push(c[0] + r[0] * dir[0], c[1] + r[1] * dir[1], c[2] + r[2] * dir[2]);
      // 楕円体の正確な法線: 成分を半径の2乗で割って正規化
      const nx = dir[0] / r[0], ny = dir[1] / r[1], nz = dir[2] / r[2];
      const len = Math.hypot(nx, ny, nz);
      normals.push(nx / len, ny / len, nz / len);
      joints.push(bi, 0, 0, 0);
      weights.push(1, 0, 0, 0);
      vertCount++;
    }
  }
  for (let i = 0; i < latSeg; i++) {
    for (let j = 0; j < lonSeg; j++) {
      const a = base + i * (lonSeg + 1) + j;
      const b = a + lonSeg + 1;
      primIndices[prim].push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

const W = world;
// 胴体 (シャツ) と腰 (ズボン) — 重なりを大きくして継ぎ目を目立たなくする
ellipsoid('pants', [0, W.hips[1] + 0.005, 0],       [0.135, 0.12, 0.095], 'hips');
ellipsoid('shirt', [0, W.spine[1] + 0.05, 0],       [0.122, 0.115, 0.09], 'spine');
ellipsoid('shirt', [0, W.chest[1] + 0.055, 0],      [0.13, 0.12, 0.094], 'chest');
ellipsoid('shirt', [0, W.upperChest[1] + 0.05, 0],  [0.138, 0.115, 0.096], 'upperChest');
// 首・頭 (肌)
ellipsoid('skin', [0, W.neck[1] + 0.035, 0],        [0.042, 0.055, 0.042], 'neck');
ellipsoid('skin', [0, W.head[1] + 0.12, 0],         [0.105, 0.118, 0.105], 'head');
// 髪 (頭頂〜後頭部。下端が目の高さ (+0.125) より下に来ないようにする)
ellipsoid('hair', [0, W.head[1] + 0.20, -0.02],     [0.112, 0.075, 0.105], 'head');
ellipsoid('hair', [0, W.head[1] + 0.215, 0.045],    [0.095, 0.045, 0.075], 'head'); // 前髪
// 顔パーツ
ellipsoid('dark', [-0.042, W.head[1] + 0.125, 0.094], [0.013, 0.021, 0.009], 'head', 6, 8); // 右目
ellipsoid('dark', [0.042, W.head[1] + 0.125, 0.094],  [0.013, 0.021, 0.009], 'head', 6, 8); // 左目
ellipsoid('dark', [0, W.head[1] + 0.06, 0.097],       [0.014, 0.006, 0.005], 'head', 6, 8);  // 口

// 腕 (左 +X / 右 -X): 上腕は袖 (シャツ)、前腕と手は肌
for (const side of [1, -1]) {
  const L = side === 1 ? 'left' : 'right';
  const ua = W[`${L}UpperArm`], la = W[`${L}LowerArm`], hd = W[`${L}Hand`];
  ellipsoid('shirt', [ua[0] - side * 0.005, ua[1] + 0.02, 0], [0.065, 0.06, 0.06], `${L}Shoulder`); // 肩口
  ellipsoid('shirt', [(ua[0] + la[0]) / 2, ua[1], 0], [0.135, 0.048, 0.048], `${L}UpperArm`);
  ellipsoid('skin',  [(la[0] + hd[0]) / 2, la[1], 0], [0.125, 0.04, 0.04], `${L}LowerArm`);
  ellipsoid('skin',  [hd[0] + side * 0.045, hd[1], 0], [0.055, 0.036, 0.026], `${L}Hand`);
}

// 脚 (ズボン) と靴
for (const side of [1, -1]) {
  const L = side === 1 ? 'left' : 'right';
  const ul = W[`${L}UpperLeg`], ll = W[`${L}LowerLeg`], ft = W[`${L}Foot`];
  ellipsoid('pants', [ul[0], (ul[1] + ll[1]) / 2, 0], [0.068, 0.22, 0.068], `${L}UpperLeg`);
  ellipsoid('pants', [ll[0], (ll[1] + ft[1]) / 2 + 0.02, 0], [0.058, 0.23, 0.058], `${L}LowerLeg`);
  ellipsoid('dark',  [ft[0], ft[1] - 0.025, 0.05],   [0.058, 0.05, 0.125], `${L}Foot`);
}

// --- glTF 構築 ---
const binParts = [];
const bufferViews = [];
const accessors = [];
let binOffset = 0;

function addBufferView(typedArray, target) {
  const pad = (4 - (binOffset % 4)) % 4;
  if (pad) {
    binParts.push(new Uint8Array(pad));
    binOffset += pad;
  }
  bufferViews.push({
    buffer: 0,
    byteOffset: binOffset,
    byteLength: typedArray.byteLength,
    ...(target ? { target } : {}),
  });
  binParts.push(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength));
  binOffset += typedArray.byteLength;
  return bufferViews.length - 1;
}

function addAccessor(typedArray, componentType, type, target, withMinMax = false) {
  const numComp = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  const acc = {
    bufferView: addBufferView(typedArray, target),
    componentType,
    count: typedArray.length / numComp,
    type,
  };
  if (withMinMax) {
    const min = new Array(numComp).fill(Infinity);
    const max = new Array(numComp).fill(-Infinity);
    for (let i = 0; i < typedArray.length; i += numComp) {
      for (let j = 0; j < numComp; j++) {
        min[j] = Math.min(min[j], typedArray[i + j]);
        max[j] = Math.max(max[j], typedArray[i + j]);
      }
    }
    acc.min = min;
    acc.max = max;
  }
  accessors.push(acc);
  return accessors.length - 1;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const posAcc = addAccessor(new Float32Array(positions), 5126, 'VEC3', ARRAY_BUFFER, true);
const nrmAcc = addAccessor(new Float32Array(normals), 5126, 'VEC3', ARRAY_BUFFER);
const jntAcc = addAccessor(new Uint8Array(joints), 5121, 'VEC4', ARRAY_BUFFER);
const wgtAcc = addAccessor(new Float32Array(weights), 5126, 'VEC4', ARRAY_BUFFER);

const materials = [
  { name: 'skin',  pbrMetallicRoughness: { baseColorFactor: [0.96, 0.80, 0.69, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'hair',  pbrMetallicRoughness: { baseColorFactor: [0.32, 0.22, 0.16, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
  { name: 'shirt', pbrMetallicRoughness: { baseColorFactor: [0.32, 0.66, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'pants', pbrMetallicRoughness: { baseColorFactor: [0.24, 0.28, 0.40, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'dark',  pbrMetallicRoughness: { baseColorFactor: [0.15, 0.12, 0.11, 1], metallicFactor: 0, roughnessFactor: 0.7 } },
];

const primitives = PRIM_NAMES.map((prim, mi) => ({
  attributes: { POSITION: posAcc, NORMAL: nrmAcc, JOINTS_0: jntAcc, WEIGHTS_0: wgtAcc },
  indices: addAccessor(new Uint16Array(primIndices[prim]), 5123, 'SCALAR', ELEMENT_ARRAY_BUFFER),
  material: mi,
  mode: 4,
}));

// ノード: 骨格 + メッシュ
const nodes = [];
const nodeIndex = {};
for (const name of BONE_NAMES) {
  nodeIndex[name] = nodes.length;
  nodes.push({ name: `J_${name}`, translation: [...SKELETON[name][1]] });
}
for (const name of BONE_NAMES) {
  const parent = SKELETON[name][0];
  if (parent !== null) (nodes[nodeIndex[parent]].children ??= []).push(nodeIndex[name]);
}

// inverseBindMatrices (回転なし → 平行移動の逆行列のみ)
const ibm = new Float32Array(BONE_NAMES.length * 16);
BONE_NAMES.forEach((name, i) => {
  const [x, y, z] = world[name];
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], i * 16);
});
const ibmAcc = addAccessor(ibm, 5126, 'MAT4');

const meshNode = nodes.length;
nodes.push({ name: 'SampleBotMesh', mesh: 0, skin: 0 });

const humanBones = {};
for (const name of BONE_NAMES) humanBones[name] = { node: nodeIndex[name] };

const json = {
  asset: { version: '2.0', generator: 'text-to-vrma sample generator' },
  extensionsUsed: ['VRMC_vrm'],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'SampleBot',
        version: '1.0',
        authors: ['text-to-vrma project'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        avatarPermission: 'everyone',
        allowExcessivelyViolentUsage: true,
        allowExcessivelySexualUsage: true,
        commercialUsage: 'corporation',
        allowPoliticalOrReligiousUsage: true,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'unnecessary',
        allowRedistribution: true,
        modification: 'allowModificationRedistribution',
      },
      humanoid: { humanBones },
    },
  },
  scene: 0,
  scenes: [{ nodes: [nodeIndex.hips, meshNode] }],
  nodes,
  meshes: [{ name: 'SampleBot', primitives }],
  skins: [{ joints: BONE_NAMES.map((n) => nodeIndex[n]), inverseBindMatrices: ibmAcc, skeleton: nodeIndex.hips }],
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: binOffset }],
};

// --- GLB パック ---
const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const binPad = (4 - (binOffset % 4)) % 4;
const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binOffset + binPad;
const out = Buffer.alloc(total);
let o = 0;
out.writeUInt32LE(0x46546c67, o); o += 4;
out.writeUInt32LE(2, o); o += 4;
out.writeUInt32LE(total, o); o += 4;
out.writeUInt32LE(jsonBytes.length + jsonPad, o); o += 4;
out.writeUInt32LE(0x4e4f534a, o); o += 4;
Buffer.from(jsonBytes).copy(out, o); o += jsonBytes.length;
for (let i = 0; i < jsonPad; i++) out.writeUInt8(0x20, o++);
out.writeUInt32LE(binOffset + binPad, o); o += 4;
out.writeUInt32LE(0x004e4942, o); o += 4;
for (const part of binParts) {
  Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(out, o);
  o += part.byteLength;
}

const dest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'public', 'models', 'SampleBot.vrm'
);
fs.writeFileSync(dest, out);
console.log(`written: ${dest} (${(total / 1024).toFixed(1)} KB, ${vertCount} verts)`);
