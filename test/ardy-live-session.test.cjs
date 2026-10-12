const test = require('node:test');
const assert = require('node:assert/strict');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const face = (happy = 0, sad = 0) => [0, 1].map(at => ({ at, happy, sad, angry: 0, surprised: 0, relaxed: 0 }));
const segment = (text, duration = 2, happy = 0, sad = 0) => ({ text, duration, continuous: false, face: face(happy, sad) });
const fullPlan = segments => ({ continuous: false, duration: segments.reduce((sum, s) => sum + s.duration, 0), segments });
const emit = (options, plan, index) => options.onSegment({ index, segment: plan.segments[index], duration: plan.duration, continuous: plan.continuous });

// A strict in-memory implementation of the public session protocol. It emits
// distinct frames per authored interval so timestamp/prefix corruption is visible.
function server({ onNext, afterNext, onUpdate, onWaiting } = {}) {
  let number = 0;
  const sessions = new Map(), calls = [];
  const metadata = s => ({ sessionId: s.id, revision: s.revision, fps: 20, horizonFrames: 40,
    bodyScopeSupported: true, rootAxesSupported: true,
    instructionStartTime: s.origin, replaceFrom: s.cursor / 20, targetDuration: s.target,
    plannedDuration: s.planned, planComplete: s.complete });
  const install = (s, body) => {
    s.segments = body.segments;
    s.complete = body.planComplete ?? true;
    s.target = s.origin + body.duration;
    s.planned = body.segments ? s.origin + body.segments.reduce((sum, x) => sum + x.duration, 0) : s.target;
  };
  return { calls, fetch: async (url, options) => {
    const body = JSON.parse(options.body), route = new URL(url).pathname;
    calls.push({ route, body });
    let result;
    if (route === '/sessions') {
      const s = { id: `s${++number}`, revision: body.revision, cursor: 0, origin: 0 };
      install(s, body); sessions.set(s.id, s); result = metadata(s);
    } else {
      const id = route.split('/')[2], s = sessions.get(id);
      if (!s) return new Response(JSON.stringify({ code: 'session_not_found', error: 'expired' }), { status: 404 });
      if (route.endsWith('/update')) {
        onUpdate?.(body);
        const knownFrame = body.knownUntil == null ? s.cursor : Math.floor(body.knownUntil * 5 + 1e-6) * 4;
        const from = Math.min(s.cursor, knownFrame, Math.ceil(((body.playbackTime ?? 0) + .8) * 5) * 4);
        s.cursor = from;
        if (body.text || body.segments) { s.origin = body.instructionStartTime ?? from / 20; install(s, body); }
        s.revision = body.revision;
        result = metadata(s);
      } else if (route.endsWith('/append')) {
        assert.equal(body.revision, s.revision);
        assert.deepEqual(body.segments.slice(0, s.segments.length), s.segments);
        s.segments = body.segments; s.complete = body.planComplete;
        s.planned = s.origin + s.segments.reduce((sum, x) => sum + x.duration, 0);
        if (s.complete) assert.ok(Math.abs(s.planned - s.target) < 1e-6);
        result = metadata(s);
      } else if (route.endsWith('/next')) {
        const revision = s.revision, start = s.cursor;
        await onNext?.(body, calls);
        if (revision !== s.revision) result = { type: 'stale', ...metadata(s) };
        else if (s.cursor >= Math.round(s.planned * 20)) {
          result = { type: s.complete ? 'complete' : 'waiting', complete: s.complete, ...metadata(s) };
          if (!s.complete) onWaiting?.();
        } else {
          const end = Math.min(s.cursor + 40, Math.round(s.planned * 20));
          const keys = Array.from({ length: end - start }, (_, i) => ({ t: (start + i) / 20, r: [0, start + i, 0] }));
          s.cursor = end;
          result = { type: 'chunk', ...metadata(s), duration: (end - 1) / 20,
            endTime: (end - 1) / 20, tracks: { head: keys }, hips: [], complete: s.complete && end >= s.target * 20,
            jev: { bodyApplied: true, fields: ['tempo'] } };
        }
        await afterNext?.(result);
      } else if (route.endsWith('/close')) { sessions.delete(id); result = { closed: true }; }
      else throw Error(route);
    }
    return new Response(JSON.stringify(result));
  } };
}

test('Codex authors the first body and face before inference; subsequent segments append while playing', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), started = deferred(), first = deferred(), finish = deferred(), played = [], progress = [];
  const plan = fullPlan([segment('Shift weight onto the left foot.', 2, .6), segment('Lift the right knee, then lower it.', 2, 0, .7)]);
  let options;
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, analyze: async () => null,
    plan: async (_text, opts) => { options = opts; started.resolve(); await finish.promise; return plan; },
    onProgress: p => progress.push(p), play: async (spec, active, opts) => { assert.ok(active()); played.push({ spec, opts }); first.resolve(); } });
  const task = runtime.react('balance and raise a knee', 'http://ardy', { duration: 4, loop: 'on' });
  await started.promise; await tick();
  assert.equal(backend.calls.length, 0, 'raw prompt cannot bypass the planner');
  emit(options, plan, 0); await first.promise;
  assert.equal(played[0].spec.duration, 1.95);
  assert.equal(played[0].spec.realtime.faceReady, true);
  assert.equal(played[0].spec.expressions.happy[0].w, .6);
  assert.equal(played[0].spec.loop, false);
  assert.equal(backend.calls[0].body.text, undefined);
  assert.deepEqual(backend.calls[0].body.segments, [plan.segments[0]]);
  assert.equal(backend.calls[0].body.planComplete, false);
  emit(options, plan, 1); finish.resolve();
  const output = await task;
  assert.equal(output.loop, true);
  assert.equal(output.realtime.planState, 'applied');
  assert.equal(output.realtime.authoredFromStart, true);
  assert.equal(output.realtime.plannedSegments, 2);
  assert.equal(output.realtime.revision, 1);
  assert.deepEqual(output.tracks.head.slice(0, 40), played[0].spec.tracks.head);
  assert.ok(output.expressions.happy.filter(k => k.t <= 2).every(k => k.w === .6));
  assert.equal(output.expressions.sad.at(-1).w, .7);
  assert.ok(backend.calls.some(c => c.route.endsWith('/append') && c.body.planComplete));
  assert.equal(played.filter(x => x.opts.final).length, 1);
  const numeric = progress.filter(p => typeof p.percent === 'number');
  assert.ok(numeric.every((p, i) => i === 0 || p.percent >= numeric[i - 1].percent));
  assert.equal(numeric.at(-1).percent, 100);
  runtime.stop();
});

test('an incomplete authored prefix waits without inventing motion or recording a final result', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const waiting = deferred(), finish = deferred(), played = [], backend = server({ onWaiting: waiting.resolve });
  const plan = fullPlan([segment('Bend both knees.'), segment('Rise to standing.')]);
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, wait: async (_ms, signal) => { signal.throwIfAborted(); await tick(); },
    plan: async (_text, opts) => { emit(opts, plan, 0); await finish.promise; return plan; },
    play: async (spec, _active, opts) => played.push({ spec, opts }) });
  const task = runtime.react('bend then rise', 'http://ardy', { duration: 4 });
  await waiting.promise;
  assert.equal(played.length, 1); assert.equal(played[0].spec.duration, 1.95); assert.equal(played[0].opts.final, false);
  finish.resolve(); const output = await task;
  assert.equal(output.duration, 3.95); assert.equal(output.loop, false);
  runtime.stop();
});

test('planner authentication failure cannot silently generate a raw ARDY substitute', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), played = [], progress = [];
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, plan: async () => { throw Error('not authenticated'); },
    play: async spec => played.push(spec), onProgress: p => progress.push(p) });
  await assert.rejects(runtime.react('turn', 'http://ardy'), /not authenticated/);
  assert.equal(backend.calls.length, 0); assert.equal(played.length, 0); assert.equal(progress.at(-1).stage, 'error');
});

for (const failure of ['rejected', 'changed prefix', 'changed duration']) test(`a ${failure} late plan cancels partial playback without a completed recording`, async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), first = deferred(), finish = deferred(), played = [];
  const plan = fullPlan([segment('Reach upward.'), segment('Lower the arms.')]);
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, plan: async (_text, opts) => {
    emit(opts, plan, 0); await finish.promise;
    if (failure === 'rejected') throw Error('connection lost');
    if (failure === 'changed prefix') plan.segments[0].text = 'Unrelated motion';
    if (failure === 'changed duration') plan.duration = 6;
    return plan;
  }, play: async (spec, _active, opts) => { played.push({ spec, opts }); first.resolve(); } });
  const task = runtime.react('reach then lower', 'http://ardy', { duration: 4 });
  await first.promise; const rejected = assert.rejects(task); finish.resolve(); await rejected; await tick();
  assert.ok(played.every(x => !x.opts.final));
  assert.ok(backend.calls.some(c => c.route.endsWith('/close')));
  assert.ok(backend.calls.every(c => c.body.text === undefined));
});

test('ARDY-only never calls or mentions Codex and still applies Jev independently', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), statuses = [], played = [];
  const context = { tempo: 'slow', confidence: .8, affect: { happy: { value: .6, confidence: .9 } } };
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, analyze: async () => context,
    plan: () => assert.fail('Codex is disabled'), onStatus: s => statuses.push(s), play: async spec => played.push(spec) });
  const output = await runtime.react('move freely', 'http://ardy', { planner: 'none', duration: 4, loop: 'off' });
  assert.ok(statuses.every(s => !/Codex/.test(s))); assert.equal(output.loop, false);
  assert.equal(output.realtime.planner, 'none'); assert.equal(output.realtime.jev.bodyApplied, true);
  assert.ok(backend.calls.some(c => c.body.motionContext?.tempo === 'slow'));
  assert.ok(played.some(spec => spec.expressions.happy?.some(k => k.w > 0)));
  runtime.stop();
});

test('ordinary generations start independent sessions and never inherit semantic or physical history', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), states = [];
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, getState: () => assert.fail('fresh request has no old state'),
    analyze: async (_text, opts) => { states.push(opts.state); return null; }, play: async () => {} });
  await runtime.react('stretch', 'http://ardy', { planner: 'none', duration: 2 });
  const next = await runtime.react('fold arms', 'http://ardy', { planner: 'none', duration: 2 });
  assert.equal(backend.calls.filter(c => c.route === '/sessions').length, 2);
  assert.equal(backend.calls.filter(c => c.route.endsWith('/update')).length, 0);
  assert.equal(next.realtime.instructionStartTime, 0); assert.deepEqual(states, [undefined, undefined]);
  runtime.stop();
});

test('active direction changes keep physical history, but the new first action starts at a future safe boundary', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), first = deferred(), played = [], requested = [], release = deferred();
  const plan = fullPlan([segment('Lift the right hand.', 2, .5), segment('Turn the palm upward.', 2, 0, .5)]);
  let playback = 0, advance = false;
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, getPlaybackTime: () => playback,
    analyze: async (_text, opts) => { requested.push(opts.state); return null; },
    getState: () => ({ current_action: 'old semantic direction', posture: 'standing', playback: { time: playback } }),
    plan: async (_text, opts) => { await release.promise; emit(opts, plan, 0); return plan; },
    wait: async (_ms, signal) => { signal.throwIfAborted(); if (advance) playback += .5; await tick(); },
    play: async (spec, _active, opts) => { played.push({ spec, opts }); first.resolve(); } });
  const old = runtime.react('old movement', 'http://ardy', { planner: 'none', duration: 6 });
  await first.promise; playback = .4;
  const latest = runtime.react('new movement', 'http://ardy', { replaceActive: true, duration: 4, loop: 'off' });
  await tick(); playback = 1; release.resolve(); advance = true;
  const output = await latest; assert.equal(await old, undefined);
  const change = backend.calls.find(c => c.route.endsWith('/update'));
  assert.equal(backend.calls.filter(c => c.route === '/sessions').length, 1);
  assert.equal(change.body.instructionStartTime, undefined);
  assert.deepEqual(change.body.segments[0], plan.segments[0]);
  assert.ok(output.realtime.instructionStartTime > 1);
  assert.deepEqual(output.tracks.head.filter(k => k.t <= .4), played[0].spec.tracks.head.filter(k => k.t <= .4));
  assert.equal(requested[1].current_action, undefined); assert.equal(requested[1].posture, 'standing');
  assert.equal(played.filter(p => p.opts.final).length, 1); runtime.stop();
});

test('planning and playback start without Jev; parallel evidence supplements delegated future segments', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const first = deferred(), analysis = deferred(), finish = deferred(), backend = server(), played = [];
  const plan = fullPlan([{ ...segment('Open the left hand.', 2, .6), jev: 1 },
    { ...segment('Lower the left arm.', 2, 0, .7), body: ['leftArm'], jev: 5 }]);
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, analyze: () => analysis.promise,
    plan: async (_text, opts) => {
      assert.equal(opts.motionContext, undefined);
      emit(opts, plan, 0);
      await finish.promise; return plan;
    },
    play: async spec => { played.push(spec); first.resolve(); } });
  const task = runtime.react('gesture softly', 'http://ardy', { duration: 4 });
  await first.promise;
  assert.ok(backend.calls.length > 0, 'Inference starts while analysis is unresolved');
  analysis.resolve({ tempo: 'slow', confidence: .9, affect_end: { sad: { value: .2, confidence: .9 } } });
  await tick();
  finish.resolve(); const output = await task;
  assert.equal(backend.calls.some(c => c.route.endsWith('/update')), false);
  assert.equal(backend.calls[0].body.plannerOwned, true);
  assert.equal(output.realtime.jev.bodyApplied, true);
  assert.equal(output.realtime.jev.planner, false);
  assert.deepEqual(output.realtime.jev.enrichedSegments, [1]);
  assert.ok(output.expressions.sad.at(-1).w < .7);
  assert.equal(backend.calls.find(c => c.route.endsWith('/append')).body.segments[1].jevContext.tempo, 'slow');
  assert.deepEqual(output.tracks.head.slice(0, 40), played[0].tracks.head);
  assert.ok(output.expressions.happy.filter(k => k.t <= 2).every(k => k.w === .6));
  assert.ok(output.expressions.angry.every(k => k.w === 0)); runtime.stop();
});

test('timed-out Jev cannot block generation or inject late body instructions', { timeout: 2000 }, async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const analysis = deferred(), backend = server(); let asked = false;
  const runtime = createArdyLiveSession({ analysisBudgetMs: 20, fetchImpl: backend.fetch,
    analyze: () => analysis.promise, plan: async (_, opts) => {
      asked = true; assert.equal(opts.motionContext, undefined);
      await new Promise(resolve => setTimeout(resolve, 40));
      return fullPlan([segment('Move as requested.', 2)]);
    }, play: async () => {} });
  // An external live request keeps the timer alive, like the actual app server.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const output = await runtime.react('move', 'http://ardy', { duration: 2 });
    assert.equal(asked, true); assert.equal(output.realtime.jev.analysisStatus, 'failed');
    analysis.resolve({ emotion: 'anger', confidence: .9 }); await tick();
    assert.equal(backend.calls.some(c => c.route.endsWith('/update')), false);
  } finally { clearInterval(keepAlive); runtime.stop(); }
});

test('authored scopes require backend support and reach playback with independent gaze and head', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const s = { ...segment('Maintain the physical posture.', 2, .4), body: [],
    head: [[0, 0, 0, 0], [1, 5, 0, 0]], gaze: [[0, 0, 0], [.5, 0, 20], [1, 0, 0]] };
  const backend = server();
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch,
    plan: async () => fullPlan([s]), play: async () => {} });
  const output = await runtime.react('gaze and head', 'http://ardy', { duration: 2 });
  assert.deepEqual(backend.calls[0].body.segments[0].body, []);
  assert.equal(output.realtime.bodyScopeEnforced, true);
  assert.ok(output.lookAt.some(k => k.r[1] > 15));
  assert.ok(output.tracks.head.at(-1).r[0] > 4);
  assert.ok(Math.abs(output.tracks.head.at(-1).r[1]) < .01);
  runtime.stop();
  const old = createArdyLiveSession({ fetchImpl: async (url, opts) => {
    const response = await backend.fetch(url, opts), value = await response.json();
    delete value.bodyScopeSupported; return new Response(JSON.stringify(value));
  }, plan: async () => fullPlan([s]), play: async () => assert.fail('unsupported scopes cannot play') });
  await assert.rejects(old.react('gaze', 'http://ardy', { duration: 2 }), /動かす部位.*再起動/);
  old.stop();
});

test('root translation controls reach ARDY and cannot silently run on an unsupported backend', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const s = { ...segment('Move in place.'), body: ['root', 'leftLeg', 'rightLeg'], rootAxes: [false, true, false] };
  const backend = server();
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, plan: async () => fullPlan([s]), play: async () => {} });
  await runtime.react('move', 'http://ardy', { duration: 2 });
  assert.deepEqual(backend.calls[0].body.segments[0].rootAxes, s.rootAxes);
  runtime.stop();
  const old = createArdyLiveSession({ fetchImpl: async (url, opts) => {
    const response = await backend.fetch(url, opts), value = await response.json();
    delete value.rootAxesSupported; return new Response(JSON.stringify(value));
  }, plan: async () => fullPlan([s]), play: async () => assert.fail('unsupported translation constraints cannot play') });
  await assert.rejects(old.react('move', 'http://ardy', { duration: 2 }), /移動方向.*再起動/);
  old.stop();
});

test('stop releases an unresponsive first planner and ignores its later events', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), started = deferred(), finish = deferred(); let options;
  const plan = fullPlan([segment('Tilt forward.', 2)]);
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, plan: async (_text, opts) => {
    options = opts; started.resolve(); await finish.promise; return plan;
  }, play: async () => assert.fail('stopped plan must not play') });
  const task = runtime.react('tilt forward', 'http://ardy', { duration: 2 });
  await started.promise; runtime.stop(); assert.equal(await task, undefined);
  emit(options, plan, 0); finish.resolve(); await tick();
  assert.equal(backend.calls.length, 0);
});

test('an aborted old GPU response cannot overwrite a newer generation', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const blocked = deferred(), inference = deferred(), played = []; let pending = true;
  const backend = server({ onNext: async () => { if (pending) { pending = false; inference.resolve(); await blocked.promise; } } });
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, play: async spec => played.push(spec) });
  const old = runtime.react('old', 'http://ardy', { planner: 'none', duration: 2 });
  await inference.promise;
  const newest = await runtime.react('new', 'http://ardy', { planner: 'none', duration: 2 });
  blocked.resolve(); assert.equal(await old, undefined);
  assert.equal(newest.name, 'new'); assert.ok(played.every(s => s.name === 'new')); runtime.stop();
});

test('active replacement bounds its timeline to received frames when an old GPU response is lost', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const committed = deferred(), held = deferred(); let count = 0, playback = 1.9;
  const backend = server({ afterNext: async () => { if (++count === 2) { committed.resolve(); await held.promise; } } });
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, getPlaybackTime: () => playback,
    wait: async (_ms, signal) => { signal.throwIfAborted(); playback += .5; await tick(); }, play: async () => {} });
  const old = runtime.react('old', 'http://ardy', { planner: 'none', duration: 6 });
  await committed.promise;
  const output = await runtime.react('new', 'http://ardy', { planner: 'none', duration: 4, replaceActive: true });
  held.resolve(); await old;
  const update = backend.calls.find(c => c.route.endsWith('/update'));
  assert.equal(update.body.knownUntil, 2);
  assert.equal(output.realtime.instructionStartTime, 2);
  assert.ok(output.tracks.head.every((key, i, keys) => i === 0 || Math.abs(key.t - keys[i - 1].t - .05) < 1e-6));
  runtime.stop();
});

test('a newer explicit face edit survives older delayed Jev analysis and the first body', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const blocked = deferred(), analysis = deferred(), inference = deferred(); let reaction;
  const backend = server({ onNext: async () => { inference.resolve(); await blocked.promise; } });
  const explicit = { update_scope: 'face_only', confidences: { update_scope: .9 }, emotion: 'sadness' };
  const runtime = createArdyLiveSession({ fetchImpl: backend.fetch, getState: () => ({ current_action: 'move' }),
    analyze: async text => text === 'face edit' ? explicit : analysis.promise,
    onReaction: context => { reaction = context; }, play: async () => {} });
  const task = runtime.react('move', 'http://ardy', { planner: 'none', duration: 2 });
  await inference.promise; assert.equal((await runtime.update('face edit', 'http://ardy')).faceOnly, true);
  analysis.resolve({ emotion: 'joy', confidence: .8 }); await tick(); blocked.resolve(); await task;
  assert.equal(reaction, explicit); runtime.stop();
});

test('expired retained sessions are recreated for explicit continuation', async () => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(); let expire = false;
  const runtime = createArdyLiveSession({ fetchImpl: (url, options) => url.endsWith('/update') && expire
    ? (expire = false, Promise.resolve(new Response(JSON.stringify({ code: 'session_not_found', error: 'expired' }), { status: 404 })))
    : backend.fetch(url, options), play: async () => {} });
  await runtime.react('move', 'http://ardy', { planner: 'none', duration: 2 }); expire = true;
  const output = await runtime.react('turn', 'http://ardy', { planner: 'none', duration: 2, continuation: true });
  assert.equal(output.realtime.complete, true);
  assert.equal(backend.calls.filter(c => c.route === '/sessions').length, 2); runtime.stop();
});

test('canceling a blocked initial create frees the next generation and closes only the late orphan', { timeout: 2000 }, async t => {
  const { createArdyLiveSession } = await import('../src/ardyLiveSession.js');
  const backend = server(), started = deferred(), release = deferred(), played = [], statuses = [], progress = [];
  let first = true, firstSignal;
  const runtime = createArdyLiveSession({ analyze: async () => null,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/sessions' && first) {
        first = false; firstSignal = options.signal;
        // The server allocated an ID, but this transport deliberately ignores
        // cancellation and withholds its response until a new clip has finished.
        const response = await backend.fetch(url, options);
        started.resolve(); await release.promise;
        return response;
      }
      return backend.fetch(url, options);
    },
    play: async (spec, active, options) => { assert.ok(active()); played.push({ spec, options }); },
    onStatus: message => statuses.push(message), onProgress: value => progress.push(value),
  });
  t.after(() => { release.resolve(); runtime.stop(); });
  const old = runtime.react('old request', 'http://ardy', { planner: 'none', duration: 2 });
  await started.promise;
  runtime.stop();
  const next = runtime.react('new request', 'http://ardy', { planner: 'none', duration: 2 });
  assert.equal(firstSignal.aborted, true, 'stop must reach the setup request signal');
  assert.equal(await old, undefined, 'a canceled create must settle without its HTTP response');
  const output = await next;
  assert.equal(output.realtime.sessionId, 's2'); assert.equal(output.realtime.complete, true);
  assert.equal(backend.calls.filter(call => call.route === '/sessions').length, 2);
  assert.ok(played.every(item => item.spec.originalText === 'new request'));
  const beforeLate = { played: played.length, statuses: statuses.length, progress: progress.length };

  release.resolve(); await tick(); await tick();
  assert.deepEqual({ played: played.length, statuses: statuses.length, progress: progress.length }, beforeLate,
    'a late old create cannot publish playback, status or progress');
  assert.deepEqual(backend.calls.filter(call => call.route.endsWith('/close')).map(call => call.route), ['/sessions/s1/close']);
  assert.equal(backend.calls.filter(call => call.route === '/sessions/s1/next').length, 0);

  const continued = await runtime.react('edit the new request', 'http://ardy', { planner: 'none', duration: 2, continuation: true });
  assert.equal(continued.realtime.sessionId, 's2', 'late cleanup must leave the new retained session usable');
  assert.equal(backend.calls.filter(call => call.route === '/sessions').length, 2);
  assert.ok(backend.calls.some(call => call.route === '/sessions/s2/update'));
});
