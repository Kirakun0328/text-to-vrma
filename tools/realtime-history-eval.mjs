// Fixed-seed diagnostics compare autoregressive context, never reuse generated motion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { readArdyStream } from '../src/ardyRealtime.js';

const source = JSON.parse(await readFile(new URL('../release/realtime-short-prompts/results.json', import.meta.url), 'utf8'));
const repeated = process.argv.includes('--repeated');
const output = new URL(repeated ? '../release/realtime-history-repeated.json' : '../release/realtime-history-eval.json', import.meta.url);
const seeds = repeated ? [17, 41] : [7];
const histories = repeated ? [4, 40] : [4, 8, 20, 40];
const report = { recordedAt: new Date().toISOString(), seeds, steps: 8, duration: 6, lowLatency: true, postprocess: false,
  limitations: 'Joint activity, travel and seam speed are numerical diagnostics; do not prove visual fidelity. Plans are fixed but every motion is newly generated.', cases: [] };
const round = x => Math.round(x * 1000) / 1000;
const names = ['hips', 'spine', 'chest', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const average = values => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
function metrics(spec) {
  const joints = Object.fromEntries(names.map(name => {
    const keys = spec.tracks[name];
    const q = keys.map(key => new THREE.Quaternion().setFromEuler(new THREE.Euler(...key.r.map(THREE.MathUtils.degToRad), 'XYZ')));
    const speed = q.slice(1).map((value, i) => ({ t: keys[i + 1].t,
      value: THREE.MathUtils.radToDeg(q[i].angleTo(value)) / (keys[i + 1].t - keys[i].t) }));
    const first = average(speed.filter(key => key.t < 2).map(key => key.value));
    const last = average(speed.filter(key => key.t >= 4.05).map(key => key.value));
    const seam = speed.filter(key => key.t === 2 || key.t === 4).map(key => round(key.value));
    return [name, { first2sMeanSpeedDegPerS: round(first), final2sMeanSpeedDegPerS: round(last),
      finalToFirstSpeedRatio: round(last / Math.max(first, 0.001)), seamSpeedDegPerS: seam,
      maxSeamSpeedDegPerS: Math.max(...seam), maxSeamDeltaDeg: round(Math.max(...seam) / 20), ordinaryP95SpeedDegPerS: round(percentile(speed.filter(key => key.t !== 2 && key.t !== 4).map(key => key.value), 0.95)) }];
  }));
  function group(selected) {
    const first = average(selected.map(name => joints[name].first2sMeanSpeedDegPerS));
    const final = average(selected.map(name => joints[name].final2sMeanSpeedDegPerS));
    return { first2sMeanSpeedDegPerS: round(first), final2sMeanSpeedDegPerS: round(final), finalToFirstSpeedRatio: round(final / Math.max(first, 0.001)),
      maxSeamSpeedDegPerS: Math.max(...selected.map(name => joints[name].maxSeamSpeedDegPerS)),
      maxSeamDeltaDeg: round(Math.max(...selected.map(name => joints[name].maxSeamSpeedDegPerS)) / 20) };
  }
  return { joints, arms: group(names.filter(name => /Arm|Hand/.test(name))), legs: group(names.filter(name => /Leg|Foot/.test(name))),
    torso: group(['hips', 'spine', 'chest', 'head']),
    rootRangeM: [0, 1, 2].map(axis => round(Math.max(...spec.hips.map(key => key.p[axis])) - Math.min(...spec.hips.map(key => key.p[axis])))) };
}

for (const captured of repeated ? source.cases.slice(0, 3) : source.cases) {
  for (const seed of seeds) {
  let firstHash;
  for (const historyFrames of histories) {
    const started = performance.now();
    const result = { text: captured.text, segments: captured.plan.segments, seed, historyFrames };
    report.cases.push(result);
    try {
      const response = await fetch('http://127.0.0.1:2337/generate-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: captured.text, segments: captured.plan.segments, seed, steps: 8, duration: 6, lowLatency: true, postprocess: false, historyFrames }),
        signal: AbortSignal.timeout(45000) });
      let final, firstChunk;
      await readArdyStream(response, event => {
        if (event.type === 'chunk' && !firstChunk) { firstChunk = event; result.firstChunkMs = round(performance.now() - started); }
        if (event.type === 'final') final = event.spec;
      });
      assert.ok(final, 'Expected completed spec');
      const hash = createHash('sha256').update(JSON.stringify(firstChunk)).digest('hex');
      firstHash ??= hash;
      assert.equal(hash, firstHash, 'History setting must preserve identical first chunk with fixed seed');
      result.firstChunkIdentical = true;
      result.totalMs = round(performance.now() - started);
      result.metrics = metrics(final);
      result.status = 'completed';
    } catch (error) { result.status = 'failed'; result.error = error.message; }
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ text: result.text, seed, historyFrames, status: result.status, error: result.error, firstChunkMs: result.firstChunkMs,
      totalMs: result.totalMs, arms: result.metrics?.arms, legs: result.metrics?.legs, torso: result.metrics?.torso, rootRangeM: result.metrics?.rootRangeM }));
  }
  }
}
