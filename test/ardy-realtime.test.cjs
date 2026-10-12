const test = require('node:test');
const assert = require('node:assert/strict');
const key = t => ({ t, r: [0, t * 5, 0] });
const chunk = (start, end) => ({ type: 'chunk', tracks: { head: [key(start), key(end)] }, hips: [] });
const final = () => ({ type: 'final', spec: { name: 'fresh', duration: 3.95, tracks: { head: [key(0), key(1.95), key(2), key(3.95)] }, hips: [] } });
const context = { reaction: 'nod', emotion: 'joy' };
const response = events => new Response(events.map(e => JSON.stringify(e)).join('\n'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Codex and ARDY do not wait for Jev; late start-emotion cannot overwrite the performance', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  let received, reaction;
  const analysis = deferred();
  const runtime = createArdyRealtime({
    analyze: () => analysis.promise,
    plan: async (_text, options) => { received = options.motionContext; return { segments: [{text:'A person waves.',duration:6}] }; },
    fetchImpl: async () => response([final()]), play: async () => {},
    onReaction: value => { if (value) reaction = value; },
  });
  await runtime.react('hello', 'http://ardy');
  assert.equal(received, undefined);
  assert.equal(reaction, undefined);
  analysis.resolve(context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reaction, undefined);
  runtime.stop();
});

test('generated body plays before the face is ready; completion keeps the entire authored face', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const fullPlan = deferred(), firstPlay = deferred();
  const segments = [{ text: 'A person walks in place, alternating steps with natural arm swing.', duration: 4 }];
  const played = [];
  const face = [0, 1].map(at => ({ at, happy: 0, sad: 0.6, angry: 0, surprised: 0, relaxed: 0 }));
  const runtime = createArdyRealtime({
    analyze: async () => null,
    plan: async (_text, { onBodyPlan }) => { onBodyPlan({ segments }); return fullPlan.promise; },
    fetchImpl: async () => response([chunk(0, 1.95), final()]),
    play: async (spec, _active, options) => { played.push({ spec, options }); firstPlay.resolve(); },
  });
  const running = runtime.react('walk', 'http://ardy', { duration: 4 });
  await firstPlay.promise;
  assert.equal(played.length, 1, 'body must be visible while the full face plan is unresolved');
  assert.equal(played[0].spec.loop, false);
  assert.equal(played[0].spec.realtime.faceReady, false);
  assert.equal(played[0].spec.realtime.planMs, null);
  assert.deepEqual(played[0].spec.expressions, {}, 'do not substitute a different authored emotion');
  fullPlan.resolve({ segments, expression: 'neutral', face });
  await running;
  assert.equal(played.length, 2);
  assert.equal(played[1].options.append, true, 'final face must not restart the body');
  assert.equal(played[1].spec.expressions.sad.at(-1).w, 0.6);
  assert.equal(played[1].spec.expressions.sad.at(-1).t, played[1].spec.duration);
  assert.equal(played[1].spec.expressions.neutral, undefined);
  assert.equal(played[1].spec.realtime.faceReady, true);
  assert.ok(played[1].spec.realtime.firstChunkMs <= played[1].spec.realtime.firstFrameMs);
});

test('loop preference is honored only on completion; semantic auto respects finite actions', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  for (const [loop, continuous, expected] of [
    ['on', false, true], ['on', true, true], ['off', true, false], ['off', false, false],
    ['auto', true, true], ['auto', false, false], ['auto', undefined, false],
  ]) {
    const played = [];
    const runtime = createArdyRealtime({ analyze: async () => null,
      plan: async () => ({ continuous, segments: [{ text: 'A person performs the requested motion.', duration: 4 }] }),
      fetchImpl: async () => response([chunk(0, 1.95), final()]), play: async spec => played.push(spec),
    });
    const result = await runtime.react('手を2回動かして止める', 'http://ardy', { duration: 4, loop });
    assert.equal(played[0].loop, false, 'a partial generated prefix must never repeat');
    assert.equal(result.loop, expected, `${loop}/${continuous}`);
    assert.equal(played[1].loop, expected);
    assert.equal(result.realtime.loopPreference, loop);
  }
});

test('planner failure after early body playback cancels the stream and never completes a partial clip', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const firstPlay = deferred();
  let rejectPlan, cancelled = false;
  const fullPlan = new Promise((_resolve, reject) => { rejectPlan = reject; });
  const played = [], progress = [];
  const runtime = createArdyRealtime({ analyze: async () => null,
    plan: async (_text, { onBodyPlan }) => { onBodyPlan({ continuous: true, segments: [{ text: 'A person moves.', duration: 4 }] }); return fullPlan; },
    fetchImpl: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(chunk(0, 1.95)) + '\n')); },
      cancel() { cancelled = true; },
    })),
    play: async spec => { played.push(spec); firstPlay.resolve(); }, onProgress: value => progress.push(value),
  });
  const running = runtime.react('move', 'http://ardy', { loop: 'on' });
  await firstPlay.promise;
  rejectPlan(new Error('invalid face plan'));
  await assert.rejects(running, /invalid face plan/);
  assert.equal(cancelled, true);
  assert.equal(played.length, 1);
  assert.equal(played[0].realtime.complete, false);
  assert.equal(played[0].loop, false);
  assert.ok(!progress.some(value => value.percent === 100));
});

test('cancelling a partial plan releases runtime even if planner does not resolve', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const started = deferred();
  const runtime = createArdyRealtime({ analyze: async () => null,
    plan: (_text, { onBodyPlan }) => {
      onBodyPlan({ segments: [{ text: 'A person walks.', duration: 4 }] });
      return new Promise(() => {});
    },
    fetchImpl: async () => { started.resolve(); return response([final()]); },
    play: () => assert.fail('cancelled plan'),
  });
  const running = runtime.react('walk', 'http://ardy');
  await started.promise;
  runtime.stop();
  await running;
});

test('Jev failure reason remains visible while Codex generation continues', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const statuses=[];
  const runtime=createArdyRealtime({analyze:async()=>{throw new Error('Jev APIキーが無効です');},
    plan:async()=>({segments:[{text:'A person waves.',duration:6}]}),
    fetchImpl:async()=>response([final()]),play:async()=>{},onStatus:s=>statuses.push(s)});
  await runtime.react('hello','http://ardy');
  assert.match(statuses.at(-1), /Jev APIキーが無効です/);
  assert.match(statuses.at(-1), /生成完了/);
});

test('explicit edits receive structured current state and their plan controls ARDY', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  let planned = 0;
  const runtime = createArdyRealtime({ analyze: async () => context, getState: () => ({ current_action: 'standing' }),
    plan: async (text, options) => {
      assert.equal(text, 'hello'); assert.equal(options.state.current_action, 'standing'); planned++;
      return { segments: [{ text: 'A person waves.', duration: 2 }, { text: 'A person bows.', duration: 2 }], expression: 'happy' };
    }, fetchImpl: async (_url, options) => {
      assert.equal(planned, 1);
      const body = JSON.parse(options.body);
      assert.equal(body.motionContext.emotion, 'joy');
      assert.equal(body.motionContext.reaction, undefined);
      assert.deepEqual(body.segments.map(s => s.duration), [3, 3]);
      assert.equal(body.segments[0].text, 'A person waves.');
      return response([final()]);
    }, play: async () => {},
  });
  await runtime.react('hello', 'http://ardy', { continuation: true });
});

test('fresh instructions do not inherit the last performance in either planner or Jev', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const requested = [], analyzed = [], planned = [];
  const runtime = createArdyRealtime({
    getState: () => assert.fail('new generation must not read previous action, posture or expression'),
    analyze: async (text, options) => { analyzed.push(text); assert.equal(options.state, undefined); return null; },
    plan: async (text, options) => {
      planned.push(text); assert.equal(options.state, undefined);
      return { segments: [{ text, duration: 4 }] };
    },
    fetchImpl: async (_url, options) => { requested.push(JSON.parse(options.body)); return response([final()]); },
    play: async () => {},
  });
  await runtime.react('first independent instruction', 'http://ardy');
  await runtime.react('different independent instruction', 'http://ardy');
  assert.deepEqual(analyzed, planned);
  assert.deepEqual(requested.map(body => body.segments[0].text), planned);
  assert.equal(new Set(planned).size, 2);
  assert.ok(requested.every(body => body.seed === undefined));
  runtime.stop();
});

test('stopped Codex plan cannot start ARDY, and planner errors are not silently bypassed', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const started = deferred(), result = deferred();
  const runtime = createArdyRealtime({ analyze: async () => null,
    plan: () => { started.resolve(); return result.promise; }, fetchImpl: () => assert.fail('stale generation'), play: async () => {},
  });
  const running = runtime.react('hello', 'http://ardy');
  await started.promise; runtime.stop(); result.resolve({ segments: [{text:'wave', duration:6}] }); await running;
  const failed = createArdyRealtime({ analyze: async () => null, plan: async () => { throw new Error('Codex unavailable'); }, fetchImpl: () => assert.fail('no bypass') });
  await assert.rejects(failed.react('hello', 'http://ardy'), /Codex unavailable/);
});

test('each identical input starts new ARDY generation and preserves the actual situation', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  let requests = 0; const played = [];
  const runtime = createArdyRealtime({ plan: async () => ({ segments: [{text: "Codex planned motion", duration: 6}], expression: "happy" }),
    analyze: async (_text, options) => { assert.equal(options.useCache, false); return context; },
    fetchImpl: async (url, options) => {
      requests++; assert.match(url, /generate-stream$/);
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes('嬉しくて右手を振る'));
      assert.equal(body.lowLatency, true); assert.equal(body.steps, 8);
      assert.equal(body.seed, undefined);
      return response([chunk(0, 1.95), chunk(2, 3.95), final()]);
    },
    play: async (spec, active, options) => { assert.ok(active()); played.push({ spec, options }); },
  });
  await runtime.react('嬉しくて右手を振る', 'http://ardy');
  await runtime.react('嬉しくて右手を振る', 'http://ardy');
  assert.equal(requests, 2); assert.equal(played.length, 6);
  assert.deepEqual(played.slice(0, 3).map(x => x.options.append), [false, true, true]);
  assert.equal(played[0].spec.tracks.head.length, 2);
  assert.equal(played[1].spec.tracks.head.length, 4);
  assert.equal(played[0].spec.realtime.complete, false);
  assert.equal(played[2].spec.realtime.complete, true);
  for (const { spec } of played) for (const keys of Object.values(spec.expressions)) {
    assert.ok(keys.every(key => key.t <= spec.duration), 'expressions must not extend a partial clip');
  }
});

test('plays the first chunk before completion and cancels a pending reader on stop', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const firstPlayed = deferred(); let cancelled = false, plays = 0;
  const runtime = createArdyRealtime({ plan: async () => ({ segments: [{text: "Codex planned motion", duration: 6}], expression: "happy" }), analyze: async () => context,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(chunk(0, 1.95)) + '\n')); },
      cancel() { cancelled = true; },
    })),
    play: async () => { plays++; firstPlayed.resolve(); },
  });
  const running = runtime.react('hello', 'http://ardy');
  await firstPlayed.promise; runtime.stop(); await running;
  assert.equal(plays, 1); assert.equal(cancelled, true);
});

test('replaced Jev result cannot initiate old generation', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const old = deferred(); let requests = 0;
  const runtime = createArdyRealtime({ plan: async () => ({ segments: [{text: "Codex planned motion", duration: 6}], expression: "happy" }), analyze: text => text === 'old' ? old.promise : context,
    fetchImpl: async () => { requests++; return response([final()]); }, play: async () => {},
  });
  const first = runtime.react('old', 'http://ardy');
  await runtime.react('new', 'http://ardy'); old.resolve(context); await first;
  assert.equal(requests, 1);
});

test('NDJSON parser handles fragmented UTF-8, CRLF and a final line without newline', async () => {
  const { readArdyStream } = await import('../src/ardyRealtime.js');
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'meta', text: '日本語' }) + '\r\n' + JSON.stringify(final()));
  const seen = [];
  await readArdyStream(new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close();
  } })), event => { seen.push(event); });
  assert.equal(seen[0].text, '日本語'); assert.equal(seen[1].type, 'final');
});

test('truncation and server errors never report completion', async () => {
  const { readArdyStream, createArdyRealtime } = await import('../src/ardyRealtime.js');
  await assert.rejects(readArdyStream(response([chunk(0, 1.95)]), () => {}), /切断/);
  await assert.rejects(readArdyStream(response([{ type: 'error', error: 'GPU failure' }]), () => {}), /GPU failure/);
  await assert.rejects(readArdyStream(new Response('', { status: 503 }), () => {}), /503/);
  const runtime = createArdyRealtime({ plan: async () => ({ segments: [{text: "Codex planned motion", duration: 6}], expression: "happy" }), analyze: async () => null, fetchImpl: async () => new Response('', { status: 503 }), play: async () => assert.fail('must not play') });
  await assert.rejects(runtime.react('hello', 'http://ardy'), /503/);
});

test('missing, failed, and stalled Jev never block fresh motion generation', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  for (const analyze of [async () => null, async () => { throw new Error('401'); }, () => new Promise(() => {})]) {
    let requests = 0, plays = 0;
    const runtime = createArdyRealtime({ plan: async () => ({ segments: [{text: "Codex planned motion", duration: 6}], expression: "happy" }), analyze, analysisBudgetMs: 10,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.text, 'hello'); assert.equal(body.motionContext, undefined); assert.equal(body.segments[0].text, "Codex planned motion");
        requests++; return response([final()]);
      }, play: async () => { plays++; },
    });
    await runtime.react('hello', 'http://ardy');
    assert.equal(requests, 1); assert.equal(plays, 1);
  }
});

test('confidence softening preserves reliable fields and never mutates analysis', async () => {
  const { softenUncertainContext } = await import('../src/jevAnalyzer.js');
  const input = { emotion: 'joy', reaction: 'celebrate', tempo: 'fast', confidence: 0.1,
    confidences: { emotion: 0.9, reaction: 0.1, tempo: 0.8 } };
  const result = softenUncertainContext(input);
  assert.equal(result.emotion, 'joy'); assert.equal(result.tempo, 'fast');
  assert.equal(result.reaction, 'celebrate'); assert.ok(result.uncertain_fields.includes('reaction'));
  assert.equal(input.uncertain_fields, undefined);
  assert.equal(softenUncertainContext(input, 0).reaction, 'celebrate');
});

test('progress uses received frames and reaches 100 only after final playback succeeds', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const progress = [];
  const runtime = createArdyRealtime({ analyze: async () => null,
    plan: async () => ({ segments: [{ text: 'A person waves.', duration: 4 }] }),
    fetchImpl: async () => response([{ type: 'meta', duration: 4, fps: 20 }, chunk(0, 1.95), chunk(2, 3.95), final()]),
    play: async (_spec, _active, { final }) => { if (final) assert.equal(progress.at(-1).percent, 99); },
    onProgress: value => progress.push(value),
  });
  await runtime.react('hello', 'http://ardy', { duration: 4 });
  assert.deepEqual(progress.map(p => p.percent), [null, 0, 50, 99, 100]);
});

test('face-only update keeps the active body; uncertain scope requests planning', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  let confidence = 0.9, applied;
  const runtime = createArdyRealtime({ getState: () => ({ current_action: 'walking' }),
    analyze: async () => ({ update_scope: 'face_only', confidences: { update_scope: confidence } }),
    onReaction: value => { applied = value; },
    plan: () => assert.fail('face changes must not start Codex'),
    fetchImpl: () => assert.fail('face changes must not start ARDY'),
  });
  assert.equal((await runtime.update('keep walking, only smile', 'http://ardy')).faceOnly, true);
  assert.equal(applied.update_scope, 'face_only');
  confidence = 0.1;
  assert.equal((await runtime.update('change the motion', 'http://ardy')).replan, true);
});

test('late Jev cannot overwrite a newer facial instruction or a stopped performance', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const old = deferred(), reactions = [];
  const runtime = createArdyRealtime({ getState: () => ({ current_action: 'walking' }),
    analyze: text => text === 'old' ? old.promise : { update_scope: 'face_only', confidences: { update_scope: 1 } },
    plan: async () => ({ segments: [{ text: 'A person walks.', duration: 4 }] }),
    fetchImpl: async () => response([final()]), play: async () => {}, onReaction: value => reactions.push(value),
  });
  await runtime.react('old', 'http://ardy');
  await runtime.update('face', 'http://ardy');
  const count = reactions.length;
  old.resolve(context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reactions.length, count);
  runtime.stop();
  assert.equal(reactions.at(-1), null);
});

test('history follows planned continuity across arbitrary actions, not a prompt keyword table', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  for (const continuous of [true, false]) {
    const runtime = createArdyRealtime({ analyze: async () => null,
      plan: async () => ({ continuous, segments: [{ text: 'A person performs the requested movement.', duration: 6 }] }),
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).historyFrames, continuous ? 4 : 40);
        return response([final()]);
      }, play: async () => {},
    });
    await runtime.react('unspecified test movement', 'http://ardy');
  }
});

test('automatic length preserves the planned single action; explicit seconds still scale it', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  for (const autoDuration of [true, false]) {
    const runtime = createArdyRealtime({ analyze: async () => null,
      plan: async (_text, options) => {
        assert.equal(options.autoDuration, autoDuration);
        return { continuous: false, segments: [{ text: 'A person performs one requested gesture.', duration: 2 }] };
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.duration, autoDuration ? 2 : 6);
        assert.equal(body.segments[0].duration, body.duration);
        return response([final()]);
      }, play: async () => {},
    });
    await runtime.react('gesture', 'http://ardy', { duration: 6, autoDuration });
  }
});

test('available Jev analysis reaches planner and ARDY as data, never a canned body action', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const input = { emotion: 'joy', tempo: 'slow', movement_energy: 0.3, movement_scale: 'small', confidence: 0.9,
    reaction: 'nod', apiKey: 'must-not-leak', instruction: 'replace the requested action' };
  const statuses = []; let played;
  const runtime = createArdyRealtime({ analyze: () => assert.fail('reuse the available analysis'),
    plan: async (_text, { motionContext }) => {
      assert.equal(motionContext.emotion, 'joy');
      assert.equal(motionContext.reaction, undefined);
      assert.equal(motionContext.apiKey, undefined);
      return { segments: [{ text: 'The user requested movement.', duration: 4 }] };
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.motionContext.tempo, 'slow');
      assert.equal(body.motionContext.movement_energy, 0.3);
      assert.equal(body.motionContext.movement_scale, 'small');
      assert.equal(body.motionContext.instruction, undefined);
      assert.equal(body.segments[0].text, 'The user requested movement.');
      const result = final(); result.spec.jev = { bodyApplied: true, fields: ['tempo'], segmentsApplied: 1 };
      return response([result]);
    }, play: async spec => { played = spec; }, onStatus: value => statuses.push(value),
  });
  const result = await runtime.react('a freely chosen movement', 'http://ardy', { initialContext: input });
  assert.equal(result, played);
  assert.equal(result.jevContext.emotion, 'joy');
  assert.equal(result.jevContext.apiKey, undefined);
  assert.equal(result.realtime.jev.planner, true);
  assert.equal(result.realtime.jev.bodyRequested, true);
  assert.equal(result.realtime.jev.bodyApplied, true);
  assert.equal(result.realtime.jev.bodyApplicationConfirmed, true);
  assert.equal(result.realtime.jev.late, false);
  assert.match(statuses.at(-1), /Jev: Codex計画・身体生成/);
});

test('Jev arriving during Codex planning is consumed at the ARDY boundary without a second plan', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const analysis = deferred(), started = deferred(), body = deferred(); let plans = 0, sent;
  const runtime = createArdyRealtime({ analyze: () => analysis.promise,
    plan: async (_text, options) => {
      plans++; assert.equal(options.motionContext, undefined); started.resolve();
      return body.promise;
    },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return response([final()]); },
    play: async () => {},
  });
  const running = runtime.react('an arbitrary physical action', 'http://ardy');
  await started.promise;
  analysis.resolve({ emotion: 'embarrassment', tempo: 'slow', confidence: 0.8 });
  await new Promise(resolve => setImmediate(resolve));
  body.resolve({ segments: [{ text: 'The requested physical action.', duration: 4 }] });
  const result = await running;
  assert.equal(plans, 1);
  assert.equal(sent.motionContext.emotion, 'embarrassment');
  assert.equal(result.realtime.jev.planner, false);
  assert.equal(result.realtime.jev.bodyRequested, true);
  assert.equal(result.realtime.jev.bodyApplicationConfirmed, false, 'old servers must not imply body use');
  assert.equal(result.realtime.jev.bodyApplied, false);
});

test('late Jev is recorded without modifying the authored face or regenerating the body', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  const analysis = deferred(), started = deferred(), inferred = deferred();
  const face = [0, 1].map(at => ({ at, happy: 0, sad: 0.6, angry: 0, surprised: 0, relaxed: 0 }));
  let requests = 0;
  const runtime = createArdyRealtime({ analyze: () => analysis.promise,
    plan: async () => ({ segments: [{ text: 'The requested movement.', duration: 4 }], face }),
    fetchImpl: async (_url, options) => {
      requests++; assert.equal(JSON.parse(options.body).motionContext, undefined); started.resolve();
      return inferred.promise;
    }, play: async spec => assert.equal(spec.expressions.sad.at(-1).w, 0.6),
  });
  const running = runtime.react('a new movement', 'http://ardy');
  await started.promise;
  analysis.resolve({ emotion: 'joy', confidence: 0.9, affect: { happy: { value: 1, confidence: 1 } } });
  await new Promise(resolve => setImmediate(resolve));
  const result = final(); result.spec.jev = { bodyApplied: false, fields: [], segmentsApplied: 0 };
  inferred.resolve(response([result]));
  const completed = await running;
  assert.equal(requests, 1);
  assert.equal(completed.jevContext.emotion, 'joy');
  assert.equal(completed.realtime.jev.late, true);
  assert.equal(completed.realtime.jev.bodyRequested, false);
  assert.equal(completed.realtime.jev.bodyApplied, false);
  assert.equal(completed.realtime.jev.preview, true);
});

test('completion releases pending Jev and reports that no analysis was consumed', async () => {
  const { createArdyRealtime } = await import('../src/ardyRealtime.js');
  let analysisSignal; const statuses = [];
  const runtime = createArdyRealtime({ analyze: async (_text, options) => {
    analysisSignal = options.signal; return new Promise(() => {});
  }, plan: async () => ({ segments: [{ text: 'The requested movement.', duration: 4 }] }),
  fetchImpl: async () => response([final()]), play: async () => {}, onStatus: value => statuses.push(value) });
  const completed = await runtime.react('a new movement', 'http://ardy');
  assert.equal(analysisSignal.aborted, true);
  assert.equal(completed.jevContext, undefined);
  assert.equal(completed.realtime.jev.analysisStatus, 'not_ready');
  assert.equal(completed.realtime.jev.bodyApplied, false);
  assert.match(statuses.at(-1), /Jev解析は生成完了に間に合わず/);
});
