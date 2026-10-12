const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/promptIdea.js');
test('prompt ideas prefer configured OpenAI credentials and request the chosen language without a duration', async () => {
  const { generatePromptIdea } = await modulePromise;
  let calls = 0;
  const prompt = await generatePromptIdea({ apiKey: ' test-key ', apiModel: 'chosen-model', codexAvailable: true, language: 'ko', duration: 20, random: () => 0,
    requestCodex: () => assert.fail('API key must win'),
    requestOpenAI: async (messages, key, model) => {
      calls++; assert.equal(key, 'test-key'); assert.equal(model, 'chosen-model');
      const input = JSON.parse(messages[1].content); assert.equal(input.duration, undefined); assert.equal(input.language, 'Korean');
      assert.equal(input.complexity, 'simple');
      return JSON.stringify({ prompt: '  천천히 인사한다.  ' });
    } });
  assert.equal(prompt, '천천히 인사한다.'); assert.equal(calls, 1);
});
test('prompt ideas use Codex without an API key and do not silently fall back after API failure', async () => {
  const { generatePromptIdea } = await modulePromise;
  assert.equal(await generatePromptIdea({ apiKey: ' ', codexAvailable: true, random: () => 0.9, codexModel: 'chosen-codex', requestCodex: async input => {
    assert.equal(JSON.parse(input.messages[1].content).complexity, 'expressive');
    assert.equal(input.outputType, 'prompt_idea'); assert.equal(input.model, 'chosen-codex'); return '{"prompt":"お辞儀する。"}';
  } }), 'お辞儀する。');
  await assert.rejects(generatePromptIdea({ apiKey: 'test-key', codexAvailable: true,
    requestOpenAI: async () => { throw Error('API failed'); }, requestCodex: () => assert.fail('Unexpected fallback') }), /API failed/);
  await assert.rejects(generatePromptIdea({}), /API/);
  for (const raw of ['oops', '{}', '{"prompt":""}', '{"prompt":5}']) {
    await assert.rejects(generatePromptIdea({ apiKey: 'test-key', requestOpenAI: async () => raw }));
  }
});
class Element extends EventTarget { value = ''; textContent = ''; disabled = false; }
const settle = () => new Promise(resolve => setImmediate(resolve));
test('prompt button writes only the prompt, prevents duplicate clicks, and protects edits from late responses', async () => {
  const { bindPromptIdeaButton } = await modulePromise;
  const button = new Element(), input = new Element(), status = new Element(); let resolve, calls = 0;
  input.value = 'original';
  bindPromptIdeaButton({ button, input, status, options: () => ({}), generate: () => { calls++; return new Promise(done => resolve = done); } });
  button.dispatchEvent(new Event('click')); button.dispatchEvent(new Event('click'));
  assert.equal(calls, 1); assert.equal(button.disabled, true);
  input.value = 'my edit'; input.dispatchEvent(new Event('input')); resolve('late reply'); await settle();
  assert.equal(input.value, 'my edit'); assert.equal(button.disabled, false);
  button.dispatchEvent(new Event('click')); resolve('new motion idea'); await settle();
  assert.equal(input.value, 'new motion idea'); assert.equal(button.disabled, false);
});
test('prompt button preserves original text on failure', async () => {
  const { bindPromptIdeaButton } = await modulePromise;
  const button = new Element(), input = new Element(), status = new Element(); input.value = 'original';
  bindPromptIdeaButton({ button, input, status, options: () => ({}), generate: async () => { throw Error('failure'); } });
  button.dispatchEvent(new Event('click')); await settle();
  assert.equal(input.value, 'original'); assert.equal(status.textContent, 'failure'); assert.equal(button.disabled, false);
});
