// Render saved evaluation artifacts on the isolated browser's VRM. No model calls.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const folder = process.argv[2] || 'ardy-authored-session-eval';
if (!/^[a-zA-Z0-9-]+$/.test(folder)) throw Error('Invalid output folder');
const directory = new URL(`../release/${folder}/`, import.meta.url);
const report = JSON.parse(await readFile(new URL('results.json', directory), 'utf8'));
const tabs = await fetch('http://127.0.0.1:9224/json').then(response => response.json());
const tab = tabs.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:5173'));
assert.ok(tab, 'Open a dedicated debug browser on the local app');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next = 0;
const pending = new Map();
socket.onmessage = event => {
  const data = JSON.parse(event.data), item = pending.get(data.id);
  if (!item) return;
  pending.delete(data.id);
  data.error ? item.reject(Error(data.error.message)) : item.resolve(data.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
async function render(spec, plan) {
  for (let i = 0; i < 100 && !window.__viewer?.vrm; i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!window.__viewer?.vrm) throw Error('VRM did not load');
  const { inspectMotion } = await import('/src/reviewCapture.js');
  const result = await inspectMotion(window.__viewer, spec, plan);
  const pathLength = (frames, bone) => frames.slice(1).reduce((sum, frame, i) => {
    const a = frames[i].positions[bone], b = frame.positions[bone];
    return a && b ? sum + Math.hypot(...b.map((value, axis) => value - a[axis])) : sum;
  }, 0);
  result.phaseMeasurements = plan.phases.map(phase => {
    const frames = result.trajectory.filter(frame => frame.t >= phase.start && frame.t <= phase.end);
    const hips = frames.map(frame => frame.positions.hips?.[1]).filter(Number.isFinite);
    const hands = Object.fromEntries(['leftHand', 'rightHand'].map(bone => {
      const heights = frames.map(frame => frame.positions[bone]?.[1] - frame.positions.hips?.[1]).filter(Number.isFinite);
      return [bone, { pathLengthM: pathLength(frames, bone), minHeightAboveHipsM: Math.min(...heights), maxHeightAboveHipsM: Math.max(...heights) }];
    }));
    return { start: phase.start, end: phase.end, authoredText: phase.text,
      hipHeightRangeM: Math.max(...hips) - Math.min(...hips), hipChangeM: hips.at(-1) - hips[0], hands };
  });
  return result;
}
const inspection = { recordedAt: new Date().toISOString(), source: folder,
  limitations: 'Saved generated motions rendered on the app VRM. Sampled poses and measurements support review but do not establish exact repetitions or semantic correctness.', cases: [] };
try {
  for (const entry of report.cases.filter(item => item.status === 'passed')) {
    const spec = JSON.parse(await readFile(new URL(entry.specFile, directory), 'utf8'));
    let offset = 0;
    const segments = entry.plans[0]?.value?.segments ?? [{ text: entry.text, duration: spec.duration }];
    const plan = { duration: spec.duration, phases: segments.map(segment => {
      const phase = { start: offset, end: Math.min(spec.duration, offset + segment.duration), text: segment.text, targets: [] };
      offset += segment.duration; return phase;
    }) };
    const response = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
      expression: `(${render.toString()})(${JSON.stringify(spec)},${JSON.stringify(plan)})` });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    const { images, ...details } = response.result.value;
    const imageFiles = [];
    for (const [index, image] of images.entries()) {
      const file = `${entry.id}-${index === 0 ? 'front' : 'side'}.jpg`;
      await writeFile(new URL(file, directory), Buffer.from(image.split(',')[1], 'base64'));
      imageFiles.push(file);
    }
    inspection.cases.push({ id: entry.id, text: entry.text, imageFiles, ...details });
    console.log(JSON.stringify({ id: entry.id, imageFiles, phaseMeasurements: details.phaseMeasurements }));
  }
  await writeFile(new URL('visual-inspection.json', directory), JSON.stringify(inspection, null, 2));
} finally { await call('Browser.close').catch(() => {}); socket.close(); }
