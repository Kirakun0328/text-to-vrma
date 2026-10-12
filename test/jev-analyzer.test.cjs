const test = require('node:test');
const assert = require('node:assert/strict');

async function loadJevAnalyzer() {
  return import('../src/jevAnalyzer.js');
}

function fullAnswers(overrides = {}) {
  return {
    emotion: { choice: 'joy', confidence: 0.9, probabilities: { joy: 0.9 } },
    reaction: { choice: 'celebrate', confidence: 0.85, probabilities: {} },
    intensity: { score: 3, confidence: 0.8, legend: {} },
    energy: { score: 3, confidence: 0.8, legend: {} },
    scale: { choice: 'large', confidence: 0.88, probabilities: {} },
    tempo: { choice: 'fast', confidence: 0.8, probabilities: {} },
    social: { choice: 'positive', confidence: 0.9, probabilities: {} },
    loop: { noul: 0.1 },
    ...overrides,
  };
}

function okFetch(answers) {
  return async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-latest', answers }) });
}

function httpErrorFetch(status) {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

test('APIキー未設定なら通信せずnullを返す', async () => {
  const { analyzeMotionContext } = await loadJevAnalyzer();
  let called = false;
  const context = await analyzeMotionContext('やったー！', {
    apiKey: '', fetchImpl: async () => { called = true; },
  });
  assert.equal(context, null);
  assert.equal(called, false);
});

test('空文字なら通信せずnullを返す', async () => {
  const { analyzeMotionContext } = await loadJevAnalyzer();
  let called = false;
  const context = await analyzeMotionContext('   ', {
    apiKey: 'test-key', fetchImpl: async () => { called = true; },
  });
  assert.equal(context, null);
  assert.equal(called, false);
});

test('正常な応答をMotionContextへ正規化する (0-1)', async () => {
  const { analyzeMotionContext } = await loadJevAnalyzer();
  const context = await analyzeMotionContext('やったーー！！ついに完成した！', {
    apiKey: 'test-key', useCache: false, fetchImpl: okFetch(fullAnswers()),
  });
  assert.equal(context.emotion, 'joy');
  assert.equal(context.reaction, 'celebrate');
  assert.equal(context.emotion_intensity, 1); // score 3 / (levels-1=3)
  assert.equal(context.movement_energy, 1);
  assert.equal(context.movement_scale, 'large');
  assert.equal(context.tempo, 'fast');
  assert.equal(context.social_intent, 'positive');
  assert.equal(context.loop_preference, false);
  // confidence は各Choice質問の最小値 (min(0.9,0.85,0.88,0.8,0.9) = 0.8)
  assert.equal(context.confidence, 0.8);
});

test('isConfidentは閾値未満をfalseにする', async () => {
  const { isConfident } = await loadJevAnalyzer();
  assert.equal(isConfident({ confidence: 0.3 }, 0.55), false);
  assert.equal(isConfident({ confidence: 0.6 }, 0.55), true);
  assert.equal(isConfident(null, 0.55), false);
});

test('HTTPエラーはanalyzeMotionContextStrictで型付きエラーになる', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  for (const [status, code] of [[401, 'jev_unauthorized'], [422, 'jev_invalid_request'], [429, 'jev_rate_limited'], [529, 'jev_overloaded'], [500, 'jev_error']]) {
    await assert.rejects(
      analyzeMotionContextStrict('test', { apiKey: 'k', useCache: false, fetchImpl: httpErrorFetch(status) }),
      (err) => { assert.equal(err.code, code); return true; }
    );
  }
});

test('HTTPエラーはanalyzeMotionContextではnullにフォールバックする', async () => {
  const { analyzeMotionContext } = await loadJevAnalyzer();
  const context = await analyzeMotionContext('test', { apiKey: 'k', useCache: false, fetchImpl: httpErrorFetch(500) });
  assert.equal(context, null);
});

test('不正な応答形式はエラーになりstrictでは投げ、非strictではnull', async () => {
  const { analyzeMotionContext, analyzeMotionContextStrict } = await loadJevAnalyzer();
  const badFetch = okFetch({ emotion: { choice: 'not-a-real-emotion' } });
  await assert.rejects(
    analyzeMotionContextStrict('test', { apiKey: 'k', useCache: false, fetchImpl: badFetch }),
    (err) => { assert.equal(err.code, 'jev_invalid_response'); return true; }
  );
  const context = await analyzeMotionContext('test', { apiKey: 'k', useCache: false, fetchImpl: badFetch });
  assert.equal(context, null);
});

test('タイムアウトするとjev_timeoutになりnullへフォールバックする', async () => {
  const { analyzeMotionContext, analyzeMotionContextStrict } = await loadJevAnalyzer();
  // signalがabortされて初めてrejectする、実fetchのタイムアウト挙動を模す
  const neverResolvingFetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  await assert.rejects(
    analyzeMotionContextStrict('test', { apiKey: 'k', useCache: false, timeoutMs: 20, fetchImpl: neverResolvingFetch }),
    (err) => { assert.equal(err.code, 'jev_timeout'); return true; }
  );
  const context = await analyzeMotionContext('test', { apiKey: 'k', useCache: false, timeoutMs: 20, fetchImpl: neverResolvingFetch });
  assert.equal(context, null);
});

test('長すぎるテキストはJev送信時に切り詰められる', async () => {
  const { analyzeMotionContext, JEV_MAX_INPUT_CHARS } = await loadJevAnalyzer();
  let sentState = null;
  const fetchImpl = async (_url, options) => {
    sentState = JSON.parse(options.body).state;
    return { ok: true, status: 200, json: async () => ({ answers: fullAnswers() }) };
  };
  const longText = 'あ'.repeat(JEV_MAX_INPUT_CHARS + 500);
  await analyzeMotionContext(longText, { apiKey: 'k', useCache: false, fetchImpl });
  assert.equal(sentState.input.length, JEV_MAX_INPUT_CHARS);
});

test('同一テキストはキャッシュされ2回目は通信しない', async () => {
  const { analyzeMotionContext } = await loadJevAnalyzer();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => ({ answers: fullAnswers() }) }; };
  const opts = { apiKey: 'k', model: 'jev-cache-test-model', fetchImpl };
  await analyzeMotionContext('同じテキストです', opts);
  await analyzeMotionContext('同じテキストです', opts);
  assert.equal(calls, 1);
});

test('Jev receives actor state and independent atomic questions; evidence survives normalization', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  const context = await analyzeMotionContextStrict('Smile while still sad', {
    apiKey: 'test-key', useCache: false, state: { current_action: 'walking', apiKey: 'must-not-copy' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.state.current_action, 'walking');
      assert.equal(body.state.apiKey, undefined);
      assert.equal(body.questions.affect_happy.type, 'score');
      assert.equal(body.questions.affect_sad.type, 'score');
      for (const name of ['emotion', 'intensity', 'energy', 'scale', 'tempo', 'social', 'loop']) {
        assert.match(body.questions[name].instructions, /AVATAR/);
      }
      return { ok: true, json: async () => ({ answers: fullAnswers({
        affect_happy: { score: 2, confidence: 0.7 }, affect_sad: { score: 1, confidence: 0.8 },
        update_scope: { choice: 'face_only', confidence: 0.92 },
      }) }) };
    },
  });
  assert.equal(context.affect.happy.value, 2 / 3);
  assert.equal(context.affect.sad.value, 1 / 3);
  assert.equal(context.probabilities.emotion.joy, 0.9);
  assert.equal(context.confidences.intensity, 0.8);
  assert.equal(context.confidences.update_scope, 0.92);
});

test('web and desktop shared Jev service forwards bounded runtime state', async () => {
  const { handleJevAnalysis } = await import('../src/jevService.js');
  const result = await handleJevAnalysis({ text: 'Smile', apiKey: 'test-key', state: { current_action: 'standing' } }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).state.current_action, 'standing');
      return { ok: true, json: async () => ({ answers: fullAnswers() }) };
    },
  });
  assert.equal(result.status, 200);
});

test('an invalid score is omitted without discarding other independent answers', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  const run = answers => analyzeMotionContextStrict('direction', { apiKey: 'test-key', useCache: false, fetchImpl: okFetch(answers) });
  for (const name of ['intensity', 'energy']) {
    const partial = await run(fullAnswers({ [name]: { score: NaN } }));
    assert.equal(partial[name === 'intensity' ? 'emotion_intensity' : 'movement_energy'], undefined);
    assert.equal(partial.emotion, 'joy');
    assert.ok(partial.invalid_fields.includes(name));
  }
  const context = await run(fullAnswers({ affect_happy: { score: 2, confidence: Infinity } }));
  assert.equal(context.affect.happy.confidence, 0);
});

test('one call asks independent moving-part, gaze, face and temporal judgments without a gesture catalog', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  let calls = 0;
  const context = await analyzeMotionContextStrict('Keep both hands still, glance away then look back with a small smile.', {
    apiKey: 'test-key', useCache: false,
    fetchImpl: async (_url, options) => {
      calls++;
      const { questions } = JSON.parse(options.body);
      assert.equal(questions.reaction, undefined);
      for (const name of ['root', 'torso', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']) {
        assert.equal(questions['body_' + name].type, 'noul');
        assert.match(questions['body_' + name].instructions, /AVATAR/);
        assert.match(questions['body_' + name].instructions, /physically necessary/);
        assert.match(questions['body_' + name].instructions, /solely from emotion/);
      }
      assert.match(questions.body_leftArm.instructions, /left arm/);
      assert.match(questions.body_rightArm.instructions, /right arm/);
      assert.match(questions.body_head.instructions, /Eye motion alone/);
      assert.equal(questions.channel_face.type, 'noul');
      assert.equal(questions.channel_gaze.type, 'noul');
      for (const name of ['body_changes', 'affect_changes', 'gaze_changes', 'ordered_actions']) {
        assert.equal(questions['temporal_' + name].type, 'noul');
      }
      assert.match(questions.affect_happy.instructions, /START/);
      assert.match(questions.affect_end_happy.instructions, /END/);
      return { ok: true, json: async () => ({ answers: {
        body_root: { type: 'noul', noul: 0 }, body_head: { type: 'noul', noul: .2 },
        body_leftArm: { type: 'noul', noul: .01 }, body_rightArm: { type: 'noul', noul: .5 },
        channel_face: { type: 'noul', noul: 1 }, channel_gaze: { type: 'noul', noul: 1 },
        temporal_gaze_changes: { type: 'noul', noul: .99 }, temporal_ordered_actions: { type: 'noul', noul: .98 },
        affect_happy: { type: 'score', score: 0, confidence: .9 }, affect_end_happy: { type: 'score', score: 1, confidence: .8 },
        gaze: { type: 'choice', choice: 'unspecified', confidence: .9 }, gaze_end: { type: 'choice', choice: 'forward', confidence: .8 },
      } }) };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(context.body_intent, { root: 0, head: .2, leftArm: .01, rightArm: .5 });
  assert.deepEqual(context.channel_intent, { face: 1, gaze: 1 });
  assert.deepEqual(context.temporal, { gaze_changes: .99, ordered_actions: .98 });
  assert.equal(context.affect.happy.value, 0);
  assert.equal(context.affect_end.happy.value, 1 / 3);
  assert.equal(context.gaze_end, 'forward');
  assert.equal(context.confidences.body_rightArm, undefined, 'Noul has no separate confidence');
  assert.equal(context.reaction, undefined);
});

test('Noul-only responses remain usable; missing and invalid channels are not invented', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  const context = await analyzeMotionContextStrict('A novel physical action', {
    apiKey: 'test-key', useCache: false, fetchImpl: okFetch({
      body_leftArm: { noul: .51, confidence: 1 }, body_rightArm: { noul: .49 },
      body_root: { noul: -1 }, channel_face: { type: 'choice', noul: .7 }, loop: { noul: .5 },
    }),
  });
  assert.deepEqual(context.body_intent, { leftArm: .51, rightArm: .49 });
  assert.equal(context.channel_intent, undefined);
  assert.equal(context.emotion, undefined);
  assert.equal(context.movement_energy, undefined);
  assert.equal(context.loop_probability, .5);
  assert.deepEqual(context.confidences, {});
  assert.deepEqual(context.invalid_fields, ['body_root', 'channel_face']);
});

test('transient 503 retries once while preserving the original request', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  const requests = [];
  const context = await analyzeMotionContextStrict('direction', { apiKey: 'test-key', useCache: false,
    fetchImpl: async (_url, options) => {
      requests.push(options.body);
      return requests.length === 1 ? new Response('', { status: 503 })
        : { ok: true, json: async () => ({ answers: fullAnswers() }) };
    } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(context.emotion, 'joy');
});

test('persistent 503 and long Retry-After do not retry indefinitely', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  for (const retryAfter of [null, '60']) {
    let calls = 0;
    await assert.rejects(analyzeMotionContextStrict('direction', { apiKey: 'test-key', useCache: false,
      fetchImpl: async () => { calls++; return new Response('', { status: 503,
        headers: retryAfter ? { 'Retry-After': retryAfter } : {} }); } }), { code: 'jev_unavailable' });
    assert.equal(calls, retryAfter ? 1 : 2);
  }
});

test('probabilities preserve typed alternatives and remove injected or unrelated keys', async () => {
  const { analyzeMotionContextStrict } = await loadJevAnalyzer();
  const context = await analyzeMotionContextStrict('A mixed expression', {
    apiKey: 'test-key', useCache: false, fetchImpl: okFetch({
      emotion: { choice: 'joy', confidence: .1, probabilities: { joy: .45, sadness: .4, 'execute action': .15 } },
      affect_happy: { score: 1.5, confidence: .4, probabilities: { 1: .5, 2: .5, 4: 1 } },
      reaction: { choice: 'celebrate', probabilities: { celebrate: 1 } },
    }),
  });
  assert.deepEqual(context.probabilities, { emotion: { joy: .45, sadness: .4 }, affect_happy: { 1: .5, 2: .5 } });
  assert.equal(context.affect.happy.value, .5);
  assert.equal(context.confidence, .1, 'low confidence still returns usable independent evidence');
});
