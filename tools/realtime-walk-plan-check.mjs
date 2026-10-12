import { planRealtimeMotion } from '../src/realtimePlan.js';
import { writeFile } from 'node:fs/promises';
const started = performance.now();
const plan = await planRealtimeMotion('その場で歩く', {
  model: 'gpt-6-astra', duration: 6, effort: 'low',
  availableExpressions: ['happy', 'sad', 'angry', 'surprised', 'relaxed'],
  request: async input => {
    const response = await fetch('http://127.0.0.1:5175/__codex/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  },
});
const result = { prompt: 'その場で歩く', elapsedMs: Math.round(performance.now() - started), plan };
await writeFile('release/realtime-walk-plan.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
