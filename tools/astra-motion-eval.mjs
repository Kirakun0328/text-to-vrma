import { planRealtimeMotion } from '../src/realtimePlan.js';
import { writeFile } from 'node:fs/promises';

const cases = [
  '左腕は下ろしたまま、右手を顔の横まで上げて3回振る。嬉しいけれど少し照れている。最後は右手も下ろす。歩かない。',
  'その場に立ち、最初は怒りを静かにこらえているが、徐々に悲しくなって肩を落とし、最後はうつむいたまま止まる。足踏みやパンチはしない。',
];
const results = [];
const effort = process.argv[2] || 'medium';
for (const text of cases) {
  const start = performance.now();
  const plan = await planRealtimeMotion(text, { model: 'gpt-6-astra', duration: 6, effort,
    availableExpressions: ['happy','sad','angry','surprised','relaxed','blink'],
    request: async input => {
      const response = await fetch('http://127.0.0.1:5175/__codex/review', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(input),
        signal: AbortSignal.timeout(180000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    },
  });
  const result = { text, model:'gpt-6-astra', effort, elapsedMs: Math.round(performance.now()-start), plan };
  results.push(result);
  await writeFile(effort === 'medium' ? 'release/astra-motion-eval.json' : 'release/astra-motion-eval-low.json', JSON.stringify(results,null,2));
  console.log(JSON.stringify(result));
}
await writeFile(effort === 'medium' ? 'release/astra-motion-eval.json' : 'release/astra-motion-eval-low.json', JSON.stringify(results,null,2));
