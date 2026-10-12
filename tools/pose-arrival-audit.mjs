// Measures whether each authored segment actually reached its posture before
// the next one began. Reads saved specs and plans; no model or API is used.
//   node tools/pose-arrival-audit.mjs <release-folder> [case-id,...]
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { SKELETON } from '../src/vrmaBuilder.js';

const toQuaternion = r => new THREE.Quaternion().setFromEuler(
  new THREE.Euler(...r.map(THREE.MathUtils.degToRad), 'XYZ'));

function sample(keys, t, field, fallback) {
  if (!keys?.length) return fallback;
  if (t <= keys[0].t) return keys[0][field];
  if (t >= keys.at(-1).t) return keys.at(-1)[field];
  const i = keys.findIndex(k => k.t > t);
  const a = keys[i - 1], b = keys[i], f = (t - a.t) / (b.t - a.t);
  if (field === 'p') return a.p.map((v, j) => v + (b.p[j] - v) * f);
  return { a: a.r, b: b.r, f };
}

function rotation(spec, bone, t) {
  const value = sample(spec.tracks?.[bone], t, 'r', null);
  if (!value) return new THREE.Quaternion();
  if (Array.isArray(value)) return toQuaternion(value);
  return toQuaternion(value.a).slerp(toQuaternion(value.b), value.f);
}

// World positions of every skeleton joint at time t.
export function posePositions(spec, t) {
  const world = {};
  for (const [bone, [parent, offset]] of Object.entries(SKELETON)) {
    if (/Proximal|Intermediate|Distal/.test(bone)) continue;
    const local = rotation(spec, bone, t);
    if (!parent) {
      const p = sample(spec.hips, t, 'p', [0, 0, 0]);
      world[bone] = { q: local, p: new THREE.Vector3(...offset).add(new THREE.Vector3(...p)) };
    } else {
      const up = world[parent];
      world[bone] = { q: up.q.clone().multiply(local),
        p: new THREE.Vector3(...offset).applyQuaternion(up.q).add(up.p) };
    }
  }
  return world;
}

const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);
const degrees = (a, b) => THREE.MathUtils.radToDeg(a.angleTo(b));

// Arm elevation: 0 = hanging at the side, 90 = horizontal, 180 = overhead.
export function poseMetrics(spec, t) {
  const w = posePositions(spec, t);
  const arm = side => Math.round(degrees(w[`${side}LowerArm`].p.clone().sub(w[`${side}UpperArm`].p), DOWN));
  const trunk = w.neck.p.clone().sub(w.hips.p);
  return {
    t: Math.round(t * 100) / 100,
    leftArm: arm('left'), rightArm: arm('right'),
    trunkLean: Math.round(degrees(trunk, UP)),
    hipsHeight: Math.round(w.hips.p.y * 100) / 100,
  };
}

const [folder, filter] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!folder || !/^[a-zA-Z0-9-]+$/.test(folder)) throw Error('usage: node tools/pose-arrival-audit.mjs <release-folder> [case-id,...]');
  const base = new URL(`../release/${folder}/`, import.meta.url);
  const results = JSON.parse(await readFile(new URL('results.json', base), 'utf8'));
  for (const item of results.cases) {
    if (filter && !filter.split(',').includes(item.id)) continue;
    const spec = JSON.parse(await readFile(new URL(item.specFile ?? `${item.id}.spec.json`, base), 'utf8'));
    const segments = item.plans?.[0]?.value?.segments ?? [];
    console.log(`## ${item.id} (${spec.duration.toFixed(2)}s)`);
    let offset = 0;
    for (const segment of segments) {
      const end = Math.min(spec.duration, offset + segment.duration);
      const middle = poseMetrics(spec, offset + segment.duration / 2), last = poseMetrics(spec, end);
      console.log(`${offset.toFixed(1).padStart(5)}-${end.toFixed(1).padEnd(5)} ${JSON.stringify(segment.body)}\n`
        + `      ${segment.text}\n      mid ${JSON.stringify(middle)}\n      end ${JSON.stringify(last)}`);
      offset += segment.duration;
    }
  }
}
