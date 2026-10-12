// Real ARDY sessions and the real local Astra bridge. No Jev API call.
// The playback cursor is simulated; this does NOT measure browser-rendered frames.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createArdyLiveSession } from '../src/ardyLiveSession.js';
import { planRealtimeMotionStream } from '../src/realtimePlan.js';
import { readCodexJsonStream } from '../src/codexWebBridge.js';
import { buildVRMA } from '../src/vrmaBuilder.js';

if (process.argv.includes('--help')) {
  console.log('node tools/ardy-live-session-eval.mjs [output-folder] [--only=case-id,...]');
  console.log('Long-motion cases: astra-long-order, astra-long-celebration, astra-long-30 (opt in with --only).');
  console.log('Requires the updated ARDY server on :2337 and local Codex bridge at http://127.0.0.1:5173. Coordinate GPU use first.');
  process.exit(0);
}
const arguments_ = process.argv.slice(2);
const syntheticJev = arguments_.includes('--synthetic-jev');
const replayFolder = arguments_.find(value => value.startsWith('--replay='))?.slice(9);
if (replayFolder && !/^[a-zA-Z0-9-]+$/.test(replayFolder)) throw Error('Invalid replay folder');
const replay = replayFolder ? JSON.parse(await readFile(new URL(`../release/${replayFolder}/results.json`, import.meta.url), 'utf8')) : null;
const folder = arguments_.find(value => !value.startsWith('--')) || 'ardy-live-session-eval';
if (!/^[a-zA-Z0-9-]+$/.test(folder)) throw Error('Invalid output folder');
const only = arguments_.find(value => value.startsWith('--only='))?.slice(7).split(',');
const directory = new URL(`../release/${folder}/`, import.meta.url);
const endpoint = arguments_.includes('--mini') ? 'http://127.0.0.1:2338' : 'http://127.0.0.1:2337';
const bridge = 'http://127.0.0.1:5173';
const cases = [
  { id: 'astra-pivot-step', text: '陽気に両腕を左右へ広げ、片足を軸にもう片方の足で床を蹴って体を半回転させる。回した足を後ろへ一歩引いて踏ん張り、両腕をゆっくり下ろしながら上体をまっすぐに戻す。', planner: 'codex', duration: 8 },
  { id: 'astra-natural-wave', text: '再会を喜びながら右手を振る。', planner: 'codex', duration: 6 },
  { id: 'astra-isolated-wave', text: '体と左腕は動かさず、右腕だけで手を振る。', planner: 'codex', duration: 6 },
  { id: 'astra-long-30', text: '30秒。その場で最初の8秒は右手を大きく振り、次の8秒は左手を大きく振る。次の4秒で両腕を下ろして深くしゃがむ。次の4秒で立ち上がる。最後の6秒は両腕を下ろした立ち姿を保つ。', planner: 'codex', duration: 30 },
  { id: 'astra-long-order', text: '20秒。最初の6秒は前に歩く。次の4秒はその場で右手を大きく振る。次の4秒で両腕を下ろして深くしゃがむ。最後の6秒はしゃがんだ姿勢を保つ。', planner: 'codex', duration: 20 },
  { id: 'astra-long-celebration', text: '20秒。試合の結果を待ちながら、その場で落ち着かず左右に体重を移す。優勝が決まると、両腕を頭上に上げて大喜びし、何度か飛び跳ねる。その後、正面の観客に向かって大きく両手を振り、最後に深くお辞儀する。', planner: 'codex', duration: 20 },
  { id: 'astra-walk-jump', text: '歩いてジャンプ', planner: 'codex', duration: 6 },
  { id: 'astra-jump-turn', text: 'ジャンプしてから右を向く', planner: 'codex', duration: 6 },
  { id: 'none-walk', text: 'その場で歩く', planner: 'none', duration: 6 },
  { id: 'none-crouch', text: 'ゆっくりしゃがむ', planner: 'none', duration: 6 },
  { id: 'astra-walk', text: 'その場で歩く', planner: 'codex', duration: 6 },
  { id: 'astra-order', text: '左手を一度振ってから、右を向き、ゆっくりしゃがむ', planner: 'codex', duration: 8 },
  { id: 'astra-free', text: '足元の小さな落とし物に気づき、慎重に拾って相手に差し出す', planner: 'codex', duration: 8 },
  { id: 'astra-acting', text: '相手に褒められて照れながら、嬉しそうにお礼を伝える', planner: 'codex', duration: 12 },
  { id: 'astra-gaze', text: '好きな相手に褒められ、嬉しいけれど照れくさくて、一度視線をそらす。小さく微笑んでから相手を見て、お礼を伝える。', planner: 'codex', duration: 6 },
  { id: 'session-update', text: 'その場で歩く', planner: 'none', duration: 10,
    update: { text: '右手を振る', duration: 6, afterPlaybackSeconds: 0.65 } },
].filter(item => only ? only.includes(item.id) : !item.id.startsWith('astra-long-') && !['astra-natural-wave','astra-isolated-wave','astra-pivot-step'].includes(item.id));
if (!cases.length || only?.some(id => !cases.some(item => item.id === id))) throw Error('Unknown evaluation case');
const round = value => Math.round(value * 1000) / 1000;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { recordedAt: new Date().toISOString(), endpoint, bridge, model: 'gpt-6-astra', effort: arguments_.includes('--medium') ? 'medium' : 'low', steps: 8,
  jev: syntheticJev ? 'Synthetic delayed Jev evidence; real Astra and ARDY. No Jev API/key is used.'
    : 'Disabled for this evaluation: analyze returns null; no real Jev key or API is used.',
  inference: 'Fresh inference for every case, no fixed seed, motion library or mocked provider.',
  limitations: 'Playback is a wall-clock cursor clamped to available frames. First-play timings measure Node VRMA construction, not browser loading, display, or motion quality. Passing means protocol, prefix and artifact checks passed; it does not prove semantic fidelity.',
  timingNotes: 'Times are milliseconds since each case started. Initial startup waiting is separate from buffer stalls after the first VRMA. Codex cases wait for an authored segment, then generate while later segments are planned. Runtime factor includes intentional lookahead pacing and planning.', cases: [] };
await mkdir(directory, { recursive: true });
if (replay) report.inference = `Replay saved Astra plans from ${replayFolder}; real ARDY inference with comparison seed 42. No fresh Astra call.`;
report.health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
if (report.health.status !== 'ok') throw Error('ARDY must be ready before running the evaluation');
const save = () => writeFile(new URL('results.json', directory), JSON.stringify(report, null, 2));

function weightAt(keys = [], time) {
  const left = keys.findLast(key => key.t <= time), right = keys.find(key => key.t > time);
  if (!left) return right?.w ?? 0;
  return right ? left.w + (right.w - left.w) * (time - left.t) / (right.t - left.t) : left.w;
}

function checkPlayedPrefix(previous, next, playedUntil, record) {
  if (!previous || previous.realtime?.sessionId !== next.realtime?.sessionId) return;
  const before = { tracks: {} }, after = { tracks: {} };
  for (const name of new Set([...Object.keys(previous.tracks), ...Object.keys(next.tracks)])) {
    before.tracks[name] = (previous.tracks[name] ?? []).filter(key => key.t < playedUntil - 1e-6);
    after.tracks[name] = (next.tracks[name] ?? []).filter(key => key.t < playedUntil - 1e-6);
  }
  before.hips = previous.hips.filter(key => key.t < playedUntil - 1e-6);
  after.hips = next.hips.filter(key => key.t < playedUntil - 1e-6);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const beforeHash = digest(before), afterHash = digest(after);
  assert.equal(afterHash, beforeHash, 'Already played body keys changed or disappeared');
  // Check interpolated weights too: inserting a future key must not alter the
  // expression between old keys in the already played part of the performance.
  for (const name of new Set([...Object.keys(previous.expressions ?? {}), ...Object.keys(next.expressions ?? {})])) {
    for (let time = 0; time < playedUntil - 1e-4; time += 0.05) {
      assert.ok(Math.abs(weightAt(previous.expressions?.[name], time) - weightAt(next.expressions?.[name], time)) < 1e-5,
        `Already played expression ${name} changed at ${time.toFixed(2)} seconds`);
    }
  }
  record.prefixChecks.push({ atPlaybackTime: round(playedUntil), fromRevision: previous.realtime.revision,
    toRevision: next.realtime.revision, beforeHash, afterHash, unchanged: true });
}

function motionMetrics(spec) {
  const metrics = {};
  for (const [name, keys] of Object.entries(spec.tracks)) {
    if (!/Leg|Arm|Hand|hips|head/.test(name) || keys.length < 2) continue;
    const rotations = keys.map(key => new THREE.Quaternion().setFromEuler(new THREE.Euler(...key.r.map(THREE.MathUtils.degToRad), 'XYZ')));
    const speeds = rotations.slice(1).map((rotation, index) => THREE.MathUtils.radToDeg(rotation.angleTo(rotations[index])) / (keys[index + 1].t - keys[index].t));
    metrics[name] = { meanAngularSpeedDegS: round(average(speeds)), maxStepDeg: round(Math.max(...speeds) / 20) };
  }
  return { duration: spec.duration, frames: spec.hips.length,
    rootRangeM: [0, 1, 2].map(axis => round(Math.max(...spec.hips.map(key => key.p[axis])) - Math.min(...spec.hips.map(key => key.p[axis])))),
    bones: metrics, note: 'Joint activity and root travel do not establish semantic correctness or naturalness.' };
}

for (const definition of cases) {
  const result = { ...definition, status: 'running', timings: {}, requests: [], progress: [], playbacks: [], prefixChecks: [], plans: [] };
  report.cases.push(result); await save();
  const began = performance.now(), elapsed = () => round(performance.now() - began);
  const controller = new AbortController(), createdIds = new Set(), submittedPrefixes = new Map();
  let runtime, latest, finalSpec, finalBuffer, phase = 'initial', playbackStarted = false;
  let cursor = 0, availableEnd = 0, lastClock = performance.now(), exhaustedIsFinal = false, stalledMs = 0;
  let currentStall = null;
  const stalls = [];
  const advance = () => {
    const now = performance.now(), delta = Math.max(0, (now - lastClock) / 1000); lastClock = now;
    if (!playbackStarted) return cursor;
    const movement = Math.min(delta, Math.max(0, availableEnd - cursor)); cursor += movement;
    const blocked = exhaustedIsFinal ? 0 : Math.max(0, delta - movement) * 1000;
    if (blocked > 0.05) {
      stalledMs += blocked;
      if (!currentStall) { currentStall = { startedAtMs: round(now - began - blocked), durationMs: 0 }; stalls.push(currentStall); }
      currentStall.durationMs = round(currentStall.durationMs + blocked);
    } else if (movement > 0) currentStall = null;
    return cursor;
  };
  const heartbeat = setInterval(advance, 20);
  const timeout = setTimeout(() => { result.timedOut = true; controller.abort(Error('Evaluation case exceeded 120 seconds')); runtime?.stop(); }, 120000);
  const waitFor = async predicate => {
    while (!predicate()) { controller.signal.throwIfAborted(); await pause(20); }
  };
  try {
    runtime = createArdyLiveSession({
      analyze: async () => {
        if (!syntheticJev) return null;
        await pause(500);
        result.syntheticJevArrivedAtMs = elapsed();
        return { confidence:.1, affect:{happy:{value:.45,confidence:.8}},
          affect_end:{happy:{value:.65,confidence:.8}}, gaze:'down', gaze_end:'forward',
          confidences:{gaze:.8,gaze_end:.8} };
      },
      getPlaybackTime: advance,
      getPlaybackState: () => ({ time: advance(), cycles: 0 }),
      getState: () => ({ actor_role: 'avatar', input_kind: 'acting_direction_or_dialogue', current_action: latest?.originalText || '' }),
      fetchImpl: async (url, options) => {
        const route = new URL(url).pathname, body = JSON.parse(options.body);
        if (replay && route === '/sessions') { body.seed = 42; options = { ...options, body: JSON.stringify(body) }; }
        const request = { phase, route, startedAtMs: elapsed(), body };
        result.requests.push(request);
        if (definition.planner === 'codex' && (route === '/sessions' || /\/(?:append|update)$/.test(route))) {
          assert.ok(!('text' in body), 'Codex generation must never send raw text to ARDY');
          if (body.segments) {
            const authored = result.plans.at(-1)?.segments ?? [];
            assert.ok(authored.length > 0, 'ARDY started before the first authored segment');
            const physical = segments => segments.map(segment => ({ text: segment.text, duration: segment.duration }));
            assert.deepEqual(physical(body.segments), physical(authored.slice(0, body.segments.length).map(entry => entry.segment)),
              'ARDY received an unplanned or reordered segment');
            const key = route === '/sessions' ? 'initial' : route.split('/')[2];
            const previous = submittedPrefixes.get(key) ?? submittedPrefixes.get('initial') ?? [];
            if (route.endsWith('/append')) assert.deepEqual(physical(body.segments.slice(0, previous.length)), physical(previous),
              'Appending the plan changed its accepted prefix');
            submittedPrefixes.set(key, structuredClone(body.segments));
            request.authoredPrefixLength = body.segments.length;
            request.firstAuthoredSegmentAtMs = authored[0].atMs;
          }
        }
        const signal = route.endsWith('/close') ? options.signal : AbortSignal.any([controller.signal, options.signal]);
        try {
          const response = await fetch(url, { ...options, signal });
          request.httpStatus = response.status;
          // Observe JSON without changing the runtime's response or swallowing errors.
          const event = await response.clone().json();
          request.receivedAtMs = elapsed(); request.elapsedMs = round(request.receivedAtMs - request.startedAtMs);
          request.type = event.type; request.revision = event.revision; request.sessionId = event.sessionId;
          request.startTime = event.startTime; request.endTime = event.endTime;
          request.replaceFrom = event.replaceFrom; request.targetDuration = event.targetDuration;
          request.frames = event.tracks ? Object.values(event.tracks)[0]?.length ?? 0 : 0;
          if (route === '/sessions' && event.sessionId) createdIds.add(event.sessionId);
          if (event.type === 'chunk') result.timings.firstChunkReceivedMs ??= request.receivedAtMs;
          return response;
        } catch (error) { request.error = error.message; request.elapsedMs = round(elapsed() - request.startedAtMs); throw error; }
      },
      plan: async (text, options) => {
        assert.equal(definition.planner, 'codex', 'ARDY-only cases must never request Codex');
        const planned = { text, startedAtMs: elapsed(), segments: [] }; result.plans.push(planned);
        try {
          if (replay) {
            const value = structuredClone(replay.cases.find(entry => entry.id === definition.id)?.plans[0]?.value);
            assert.ok(value, 'Missing saved plan');
            for (const [index, segment] of value.segments.entries()) {
              const entry = { index, segment, duration:value.duration, continuous:value.continuous };
              planned.firstSegmentAtMs ??= elapsed();
              planned.segments.push({ ...entry, atMs:elapsed() });
              options.onSegment?.(entry);
            }
            planned.completedAtMs = elapsed(); planned.value = value; return value;
          }
          const value = await planRealtimeMotionStream(text, { ...options, model: report.model, effort: report.effort,
            availableExpressions: ['happy', 'sad', 'angry', 'surprised', 'relaxed'],
            onSegment: entry => {
              planned.firstSegmentAtMs ??= elapsed();
              planned.segments.push({ ...structuredClone(entry), atMs: elapsed() });
              options.onSegment?.(entry);
            },
            request: async (input, streamOptions) => {
              const signal = AbortSignal.any([controller.signal, streamOptions.signal]);
              const response = await fetch(`${bridge}/__codex/review-stream`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
              return readCodexJsonStream(response, { ...streamOptions, signal, onDelta: delta => {
                if (delta) planned.firstDeltaAtMs ??= elapsed();
                streamOptions.onDelta?.(delta);
              } });
            },
          });
          planned.completedAtMs = elapsed(); planned.value = value; return value;
        } catch (error) { planned.error = error.message; planned.endedAtMs = elapsed(); throw error; }
      },
      onStatus: status => { result.lastStatus = status; },
      onProgress: progress => result.progress.push({ ...progress, atMs: elapsed(), phase }),
      play: async (spec, active, options) => {
        assert.ok(active(), 'Stale playback callback');
        const playedUntil = advance();
        checkPlayedPrefix(latest, spec, playedUntil, result);
        if (options.append) assert.ok(spec.duration >= playedUntil - 0.05, 'Future replacement removed the current playback position');
        const calledAt = elapsed(), beforeBuild = performance.now(), buffer = buildVRMA(spec);
        assert.equal(new DataView(buffer).getUint32(0, true), 0x46546c67, 'VRMA must be a GLB');
        assert.ok(buffer.byteLength > 1000, 'VRMA is unexpectedly empty');
        const buildMs = round(performance.now() - beforeBuild), builtAt = elapsed();
        advance();
        if (!options.append) cursor = 0;
        playbackStarted = true; availableEnd = spec.duration; exhaustedIsFinal = options.final === true;
        lastClock = performance.now(); latest = structuredClone(spec);
        result.timings.firstVRMACallMs ??= calledAt;
        result.timings.firstVRMABuiltMs ??= builtAt;
        result.playbacks.push({ phase, calledAtMs: calledAt, builtAtMs: builtAt, buildMs, duration: spec.duration,
          cursor: round(cursor), append: !!options.append, final: !!options.final,
          sessionId: spec.realtime.sessionId, revision: spec.realtime.revision, faceReady: spec.realtime.faceReady,
          bytes: buffer.byteLength, loop: spec.loop });
        if (options.final) { finalSpec = structuredClone(spec); finalBuffer = buffer; result.timings.finalVRMABuiltMs = builtAt; }
      },
    });
    const options = { duration: definition.duration, steps: report.steps, planner: definition.planner, autoDuration: arguments_.includes('--auto'), loop: 'off' };
    if (!definition.update) await runtime.react(definition.text, endpoint, options);
    else {
      const initial = runtime.react(definition.text, endpoint, options);
      // Attach a handler immediately, but still fail if the first direction errors.
      let initialError; const observedInitial = initial.catch(error => { initialError = error; });
      await waitFor(() => initialError || (latest && advance() >= definition.update.afterPlaybackSeconds));
      if (initialError) throw initialError;
      const beforeUpdate = structuredClone(latest);
      result.update = { ...definition.update, requestedAtMs: elapsed(), cursor: round(advance()),
        sessionId: beforeUpdate.realtime.sessionId, previousRevision: beforeUpdate.realtime.revision };
      await writeFile(new URL(`${definition.id}-before-update.spec.json`, directory), JSON.stringify(beforeUpdate));
      phase = 'updated'; exhaustedIsFinal = false; finalSpec = undefined; finalBuffer = undefined;
      await runtime.react(definition.update.text, endpoint, { ...options, duration: definition.update.duration, continuation: true, replaceActive: true });
      await observedInitial; if (initialError) throw initialError;
      assert.equal(finalSpec?.realtime.sessionId, result.update.sessionId, 'Direction change created a new session');
      assert.ok(finalSpec.realtime.revision > result.update.previousRevision, 'Direction update did not advance revision');
      assert.equal(createdIds.size, 1, 'Direction update must preserve the physical session');
      const firstNewChunk = result.requests.find(request => request.type === 'chunk' && request.revision > result.update.previousRevision);
      result.update.firstRevisedBodyAtMs = firstNewChunk ? result.playbacks.find(playback => playback.phase === 'updated'
        && playback.revision === firstNewChunk.revision && playback.builtAtMs >= firstNewChunk.receivedAtMs
        && playback.duration >= firstNewChunk.endTime - 1e-6)?.builtAtMs ?? null : null;
      assert.notEqual(result.update.firstRevisedBodyAtMs, null, 'No newly generated body from the revised direction was presented');
    }
    controller.signal.throwIfAborted();
    assert.ok(finalSpec && finalBuffer, 'Expected completed motion and VRMA');
    assert.equal(result.progress.at(-1)?.percent, 100, 'Completion must reach 100 percent');
    assert.equal(result.plans.length, definition.planner === 'codex' ? 1 : 0);
    if (definition.planner === 'codex') {
      assert.ok(result.plans[0]?.value, 'Selected Codex planning must complete successfully');
      const create = result.requests.find(request => request.route === '/sessions');
      assert.ok(create?.authoredPrefixLength > 0 && create.startedAtMs >= result.plans[0].firstSegmentAtMs,
        'First ARDY inference must follow the first authored segment');
      assert.ok(result.requests.some(request => request.body.planComplete === true), 'Complete validated plan was not committed');
      result.authoredFirst = { firstSegmentAtMs: result.plans[0].firstSegmentAtMs, sessionCreatedAtMs: create.startedAtMs,
        firstVRMABuiltMs: result.timings.firstVRMABuiltMs, planCompletedAtMs: result.plans[0].completedAtMs,
        firstPlaybackBeforeCompletePlan: result.timings.firstVRMABuiltMs < result.plans[0].completedAtMs };
    }
    assert.ok(result.prefixChecks.length, 'No played-prefix comparisons were performed');
    advance();
    const elapsedSeconds = (performance.now() - began) / 1000;
    const chunks = result.requests.filter(request => request.type === 'chunk' && request.frames > 0);
    const generatedSeconds = chunks.reduce((sum, request) => sum + request.frames / (report.health.fps || 20), 0);
    const generatedComputeSeconds = chunks.reduce((sum, request) => sum + request.elapsedMs / 1000, 0);
    result.status = 'passed'; result.timings.totalMs = elapsed();
    result.playbackSimulation = { cursor: round(cursor), stalledTimeMs: round(stalledMs), stalls,
      startupWaitMs: result.timings.firstVRMABuiltMs, browserRenderedFramesMeasured: false };
    result.rates = { finalMotionSecondsPerWallSecond: round(finalSpec.duration / elapsedSeconds),
      endToEndRuntimeFactor: round(elapsedSeconds / finalSpec.duration),
      generatedSecondsIncludingReplacedFuture: round(generatedSeconds),
      chunkRequestsRuntimeFactor: round(generatedComputeSeconds / generatedSeconds),
      meanChunkRequestMs: round(average(chunks.map(request => request.elapsedMs))) };
    result.realtime = finalSpec.realtime; result.metrics = motionMetrics(finalSpec);
    result.plannerOutcome = definition.planner === 'none' ? 'disabled' : 'completed';
    result.specFile = `${definition.id}.spec.json`; result.vrmaFile = `${definition.id}.vrma`;
    await writeFile(new URL(result.specFile, directory), JSON.stringify(finalSpec));
    await writeFile(new URL(result.vrmaFile, directory), Buffer.from(finalBuffer));
  } catch (error) {
    result.status = result.timedOut ? 'timeout' : 'failed'; result.error = error.message;
    result.timings.totalMs = elapsed(); result.playbackSimulation = { cursor: round(advance()), stalledTimeMs: round(stalledMs), stalls };
    if (latest) await writeFile(new URL(`${definition.id}.partial.spec.json`, directory), JSON.stringify(latest));
  } finally {
    clearInterval(heartbeat); clearTimeout(timeout); controller.abort(); runtime?.stop();
    // Idempotent explicit cleanup also covers a timeout between create and react.
    result.cleanup = await Promise.all([...createdIds].map(async sessionId => {
      try {
        const response = await fetch(`${endpoint}/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
        return { sessionId, closed: response.ok };
      } catch (error) { return { sessionId, closed: false, error: error.message }; }
    }));
    await save();
    console.log(JSON.stringify({ id: result.id, status: result.status, error: result.error,
      firstVRMABuiltMs: result.timings.firstVRMABuiltMs, totalMs: result.timings.totalMs,
      stalledTimeMs: result.playbackSimulation?.stalledTimeMs, planState: result.realtime?.planState,
      rates: result.rates, prefixChecks: result.prefixChecks.length, update: result.update }));
  }
}
report.status = report.cases.every(result => result.status === 'passed') ? 'passed' : 'failed';
await save();
if (report.status !== 'passed') process.exitCode = 1;
