// Diagnostic only: fixed seeds compare descriptors, not a motion cache.
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { SKELETON } from '../src/vrmaBuilder.js';

const endpoint = 'http://127.0.0.1:2337';
const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
if (health.status !== 'ok') throw Error(`ARDY unavailable: ${JSON.stringify(health)}`);
const round = n => Math.round(n * 1000) / 1000;
const range = values => round(Math.max(...values) - Math.min(...values));
const radians = THREE.MathUtils.degToRad;

function metrics(spec) {
  const bones = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
  const excursion = Object.fromEntries(bones.map(name => {
    const keys = spec.tracks[name];
    const q = keys.map(k => new THREE.Quaternion().setFromEuler(new THREE.Euler(...k.r.map(radians), 'XYZ')));
    let max = 0;
    for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) max = Math.max(max, q[i].angleTo(q[j]));
    return [name, { angularExcursionDeg: round(THREE.MathUtils.radToDeg(max)),
      eulerXRangeDeg: range(keys.map(k => k.r[0])), firstTwoSecondsXRangeDeg: range(keys.filter(k => k.t < 2).map(k => k.r[0])),
      finalTwoSecondsXRangeDeg: range(keys.filter(k => k.t >= 4).map(k => k.r[0])) }];
  }));
  const feet = { leftFoot: [], rightFoot: [] };
  for (let i = 0; i < spec.hips.length; i++) {
    const world = {};
    for (const [name, [parent, rest]] of Object.entries(SKELETON)) {
      if (!spec.tracks[name]) continue;
      const translation = new THREE.Vector3(...rest);
      if (name === 'hips') translation.add(new THREE.Vector3(...spec.hips[i].p));
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...spec.tracks[name][i].r.map(radians), 'XYZ'));
      const local = new THREE.Matrix4().compose(translation, rotation, new THREE.Vector3(1, 1, 1));
      world[name] = parent ? world[parent].clone().multiply(local) : local;
    }
    for (const name of Object.keys(feet)) feet[name].push(new THREE.Vector3().setFromMatrixPosition(world[name]));
  }
  return { duration: spec.duration, frames: spec.hips.length, legs: excursion,
    rootRangeM: ['x','y','z'].map((_, axis) => range(spec.hips.map(k => k.p[axis]))),
    footHeightRangeM: Object.fromEntries(Object.entries(feet).map(([name, values]) => [name, range(values.map(v => v.y))])),
    note: 'Foot positions use app canonical skeleton; angular excursion measures activity, not perceived walking quality.' };
}

const actualPlan = process.argv.includes('--plan');
const prompts = actualPlan ? [JSON.parse(await readFile(new URL('../release/realtime-walk-plan.json', import.meta.url), 'utf8')).plan.segments[0].text] : [
  'A person walks in place, alternating steps with natural arm swing.',
  'A person walks in place.',
];
const postprocess = process.argv.includes('--postprocess');
const outputPath = new URL('../release/runtime-walk-diagnostics.json', import.meta.url);
const results = actualPlan || postprocess ? JSON.parse(await readFile(outputPath, 'utf8')).results.filter(result => actualPlan ? result.candidate !== 'actual-codex-plan' : !result.postprocess) : [];
for (const seed of postprocess ? [7] : [7, 17, 41]) {
  for (const text of prompts) {
    const start = performance.now();
    const response = await fetch(`${endpoint}/generate-stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, duration: 6, steps: 8, seed, lowLatency: true, postprocess }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw Error(`ARDY ${response.status}: ${await response.text()}`);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', final, firstChunkMs;
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'chunk') firstChunkMs ??= round(performance.now() - start);
        if (event.type === 'final') final = event.spec;
      }
      if (done) break;
    }
    if (!final) throw Error('No final spec');
    const result = { text, candidate: actualPlan ? 'actual-codex-plan' : 'direct-descriptor', seed, steps: 8, postprocess, firstChunkMs, totalMs: round(performance.now() - start), ...metrics(final) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
await writeFile(outputPath, JSON.stringify({ recordedAt: new Date().toISOString(), health,
  parameters: { duration: 6, lowLatency: true, note: 'Codex and Jev timing excluded; independently fresh ARDY inference each request. --postprocess appends seed7 correction comparison; --plan appends captured Codex descriptor at all three seeds.' }, results }, null, 2));
