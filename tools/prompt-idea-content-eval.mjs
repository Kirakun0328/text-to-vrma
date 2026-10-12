// Real local Codex prompt samples; no API key or motion generation.
import { mkdir, writeFile } from 'node:fs/promises';
import { generatePromptIdea } from '../src/promptIdea.js';
import { readCodexJsonStream } from '../src/codexWebBridge.js';
const recent = [], results = [];
for (let i = 0; i < 4; i++) {
  const complexity = i % 2 ? 'expressive' : 'simple';
  const prompt = await generatePromptIdea({ codexAvailable: true, codexModel: 'gpt-6-astra', language: 'ja', recent,
    random: () => i % 2 ? .9 : .1, signal: AbortSignal.timeout(60000),
    requestCodex: async (input, { signal }) => {
      const response = await fetch('http://127.0.0.1:5173/__codex/review-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
      });
      if (!response.ok) throw Error(`Codex HTTP ${response.status}`);
      return readCodexJsonStream(response, { signal });
    } });
  recent.push(prompt);
  results.push({ complexity, prompt, characters: prompt.length });
  console.log(JSON.stringify(results.at(-1)));
}
await mkdir('release/prompt-idea-content', { recursive: true });
await writeFile('release/prompt-idea-content/samples.json', JSON.stringify(results, null, 2));
