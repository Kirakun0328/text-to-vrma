// Compare saved plans with physical captions. Uses real local ARDY; no planner/API key.
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const folder = process.argv[2] || 'long-motion-captions';
if (!/^[a-zA-Z0-9-]+$/.test(folder)) throw Error('Invalid output folder');
const directory = new URL(`../release/${folder}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const source = JSON.parse(await readFile(new URL('../release/long-motion-before/results.json', import.meta.url), 'utf8'));
const original = source.cases.find(c => c.id === 'astra-long-celebration').plans[0].value;
const wave = process.argv.includes('--wave');
const segmentIndex = wave ? original.segments.length - 2 : original.segments.length - 1;
const captions = wave ? [
  ['original', original.segments[segmentIndex].text],
  ['greeting', 'A person enthusiastically waves hello with both hands raised.'],
  ['elbows', 'A person waves hello with both hands above shoulder height, elbows bent and palms facing forward.'],
] : [
  ['original', original.segments.at(-1).text],
  ['physical', 'A person bends their upper body deeply forward at the waist to bow.'],
  ['physical-ending', 'A person bends their upper body deeply forward at the waist, ending with the torso bent forward and the arms hanging down.'],
];
const request = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:2337${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(JSON.stringify(result));
  return result;
};
const report = { limits: 'Fresh unseeded samples. Same saved plan; only final caption changes. Measurements require visual review; protocol completion is not semantic success.', cases: [] };
for (const [name, caption] of captions) {
  for (let repeat = 0; repeat < 2; repeat++) {
    const plan = structuredClone(original);
    plan.segments[segmentIndex].text = caption;
    const id = `${name}-${repeat}`, spec = { name: id, duration: 0, loop: false, tracks: {}, hips: [] };
    const meta = await request('/sessions', { ...plan, plannerOwned: true, planComplete: true, steps: 8 });
    try {
      while (true) {
        const event = await request(`/sessions/${meta.sessionId}/next`, {});
        for (const [bone, keys] of Object.entries(event.tracks)) (spec.tracks[bone] ??= []).push(...keys);
        spec.hips.push(...event.hips); spec.duration = event.duration;
        if (event.complete) break;
      }
      const entry = { id, status: 'passed', specFile: `${id}.spec.json`, plans: [{ value: plan }] };
      await writeFile(new URL(entry.specFile, directory), JSON.stringify(spec));
      report.cases.push(entry);
      await writeFile(new URL('results.json', directory), JSON.stringify(report, null, 2));
      console.log(id);
    } finally { await request(`/sessions/${meta.sessionId}/close`, {}); }
  }
}
