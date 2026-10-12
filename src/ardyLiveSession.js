import { createReaction, isFaceOnlyUpdate } from './jevRuntime.js';
import { autoExpressions } from './autoExpressions.js';
import { naturalBlinks, speechMouth } from './facialPerformance.js';
import { plannedFaceTracks, validateAuthoredChannels } from './realtimePlan.js';
import { syncAuthoredMotion, applyAuthoredMotion } from './authoredMotion.js';
import { DEFAULT_JEV_TIMEOUT_MS } from './jevAnalyzer.js';
import { applyJevExpressions, toMotionSemanticContext } from './jevMotionContext.js';
import { isLoopFriendly } from './specMerge.js';
import { enrichJevSegment } from './jevSegment.js';
import { motionLookaheadSeconds, updateMotionLatency } from './motionLookahead.js';

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function weightAt(keys, time) {
  const left = keys.findLast(k => k.t <= time), right = keys.find(k => k.t > time);
  if (!left) return right?.w ?? 0;
  return right ? left.w + (right.w - left.w) * (time - left.t) / (right.t - left.t) : left.w;
}

function visibleExpressions(expressions, end) {
  return Object.fromEntries(Object.entries(expressions).map(([name, keys]) => [name,
    [...keys.filter(k => k.t < end).map(k => ({ ...k })), { t: end, w: weightAt(keys, end) }],
  ]));
}

// Keep played facial keys intact, then blend toward the NEW plan at its current
// absolute time. A late plan must never replay its starting emotion.
function replaceExpressions(previous, future, from, origin, end) {
  const result = {};
  for (const name of new Set([...Object.keys(previous), ...Object.keys(future)])) {
    const old = previous[name] ?? [], next = (future[name] ?? []).map(k => ({ ...k, t: k.t + origin }));
    const blendEnd = Math.min(end, from + 0.15);
    result[name] = [...(from > 0 && !old.length ? [{ t: 0, w: 0 }] : old.filter(k => k.t < from)),
      { t: from, w: from > 0 ? weightAt(old, from) : weightAt(next, from) },
      ...(blendEnd > from ? [{ t: blendEnd, w: weightAt(next, blendEnd) }] : []),
      ...next.filter(k => k.t > blendEnd)];
  }
  return result;
}

function trimFuture(session, from) {
  for (const [bone, keys] of Object.entries(session.spec.tracks)) session.spec.tracks[bone] = keys.filter(k => k.t < from);
  session.spec.hips = session.spec.hips.filter(k => k.t < from);
  session.spec.duration = Math.max(0, ...Object.values(session.spec.tracks).map(keys => keys.at(-1)?.t ?? 0));
  session.complete = false;
}

function appendChunk(session, event) {
  if (!event.tracks || !Array.isArray(event.hips)) throw new Error('ARDYチャンクの形式が不正です');
  for (const [bone, keys] of Object.entries(event.tracks)) {
    if (!Array.isArray(keys)) throw new Error('ARDYボーントラックが不正です');
    const track = session.spec.tracks[bone] ??= [];
    for (const key of keys) {
      if (!Number.isFinite(key.t) || key.t < 0 || (track.length && key.t <= track.at(-1).t)) throw new Error('ARDYチャンクの時刻が不正です');
      track.push(key);
      session.spec.duration = Math.max(session.spec.duration, key.t);
    }
  }
  session.spec.hips.push(...event.hips);
  session.complete = event.complete === true;
  if (event.jev) session.spec.jev = event.jev;
}

/** Codex authors every planned interval before ARDY generates it. */
export function createArdyLiveSession({ analyze, plan, play, fetchImpl = (...args) => fetch(...args),
  onStatus = () => {}, onProgress = () => {}, onReaction = () => {}, getState = () => ({}),
  getPlaybackTime, getPlaybackState = () => null, now = () => performance.now(), wait = pause,
  analysisBudgetMs = DEFAULT_JEV_TIMEOUT_MS + 500 } = {}) {
  let epoch = 0, wireRevision = 0, reactionRevision = 0, controller, updateController, session;
  let mutations = Promise.resolve();
  const enqueue = operation => {
    const result = mutations.then(operation);
    mutations = result.catch(() => {});
    return result;
  };
  async function request(base, path, body, signal) {
    const response = await fetchImpl(`${base}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) {
      let detail, code;
      try { const payload = await response.json(); detail = payload.error; code = payload.code; } catch { /* HTTP status remains useful. */ }
      const error = new Error(detail || (response.status === 404 && path === '/sessions'
        ? '連続生成を有効にするため、ARDYサーバーを再起動してください'
        : `ARDY生成に失敗しました (HTTP ${response.status})`));
      error.status = response.status;
      error.code = code;
      throw error;
    }
    return response.json();
  }
  const close = current => current && request(current.base, `/sessions/${encodeURIComponent(current.id)}/close`, {},
    AbortSignal.timeout(5000)).catch(() => {});
  function stop() {
    epoch++;
    reactionRevision++;
    controller?.abort();
    updateController?.abort();
    onReaction(null);
    void enqueue(async () => { const old = session; session = undefined; await close(old); });
  }
  return {
    stop,
    async update(text, _url, options = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('セリフ・状況を入力してください');
      updateController?.abort();
      const pending = updateController = new AbortController();
      const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(analysisBudgetMs)]);
      let context;
      try { context = await abortable(Promise.resolve(analyze?.(text, { useCache: false, state: getState(), signal })), signal); } catch { /* Body edits still work without Jev. */ }
      if (pending.signal.aborted) return;
      if (getState().current_action && isFaceOnlyUpdate(context)) {
        reactionRevision++;
        onReaction(context, { preview: false, persistent: true });
        onStatus('Jevで表情を更新しました。身体の動きは継続します。');
        return { faceOnly: true };
      }
      return { replan: true, context };
    },
    async react(text, url, { duration = 6, steps = 8, planner = 'codex', initialContext,
      autoDuration = false, continuation = false, replaceActive = false, loop = 'auto' } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('セリフ・状況を入力してください');
      if (!Number.isFinite(duration) || duration < 2 || duration > 30) throw new Error('生成秒数は2〜30秒で指定してください');
      if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('推論ステップ数が不正です');
      if (!['auto', 'on', 'off'].includes(loop) || !['none', 'codex'].includes(planner)) throw new Error('生成設定が不正です');
      controller?.abort();
      updateController?.abort();
      const id = ++epoch, local = controller = new AbortController();
      const reactionId = ++reactionRevision;
      const helpers = new AbortController(), failedPlan = new AbortController();
      const signal = AbortSignal.any([local.signal, failedPlan.signal, AbortSignal.timeout(180000)]);
      const helperSignal = AbortSignal.any([signal, helpers.signal]);
      const active = () => id === epoch && !signal.aborted;
      const base = url.replace(/\/+$/, ''), start = now();
      const physicalState = replaceActive && !continuation ? getState() : undefined;
      const snapshot = continuation ? getState() : physicalState ? {
        posture: physicalState.posture, playback: physicalState.playback,
        expressions: physicalState.expressions,
      } : undefined;
      let current, finished = false, context = initialContext, contextVersion = initialContext ? 1 : 0, sentContextVersion = 0;
      let firstFrameMs = null, firstChunkMs = null, planMs = null, bodyPlanMs = null, analysisMs = null;
      let chunks = 0, lastPercent = 0, planFailure, analysisError;
      let stage = planner === 'codex' ? 'Codexが最初の動作区間を設計中…' : 'ARDYで新しい動きを生成中…';
      let planState = planner === 'none' ? 'disabled' : 'pending';
      let header, planned = [], planDone = planner === 'none', sentSegments = 0;
      const designed = [];
      let firstSegment;
      const firstPlan = new Promise(resolve => { firstSegment = resolve; });
      const usage = { analysisStatus: 'pending', planner: false, bodyRequested: false,
        bodyApplied: false, bodyApplicationConfirmed: false, preview: false, late: false, bodyRequestMs: null,
        enrichedSegments: [], appliedFields: [] };
      const cursor = () => Math.max(0, Math.min(current?.spec.duration ?? 0,
        getPlaybackTime ? Number(getPlaybackTime()) || 0 : current?.spec.duration ?? 0));
      const knownUntil = () => Object.values(current?.spec.tracks ?? {}).some(keys => keys.length)
        ? current.spec.duration + 1 / current.fps : 0;
      const report = message => {
        if (message) stage = message;
        if (!active()) return;
        const planning = planner === 'none' ? '' : planState === 'pending' ? ''
          : planState === 'streaming' ? ' / Codexが続きの区間を設計中'
          : ' / Codexの設計で生成';
        const jev = usage.appliedFields.length ? ' / Jev: ' + usage.appliedFields.map(field => ({ face: '表情', gaze: '視線', body_style: '身体のニュアンス' })[field]).join('・') + 'を補助'
          : usage.planner ? ' / Jev: 動作設計へ反映'
          : usage.bodyApplied ? ' / Jev: 身体生成へ反映' : usage.bodyRequested ? ' / Jev: 身体生成へ送信済み'
          : usage.analysisStatus === 'pending' ? ' / Jev解析中'
          : usage.analysisStatus === 'failed' ? ` / Jev補助なし（${analysisError}）`
          : usage.analysisStatus === 'available' ? ' / Jev解析済み（補助対象なし、または区間確定後）'
          : usage.analysisStatus === 'not_ready' ? ' / Jev解析は今回の生成に間に合いませんでした'
          : ' / Jev補助なし（APIキー未設定、または解析結果なし）';
        onStatus(stage + planning + jev);
      };
      const checkSegment = segment => {
        validateAuthoredChannels(segment ?? {});
        const faceNames = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
        const aligned = n => Number.isFinite(n) && Math.abs(n * 5 - Math.round(n * 5)) < 1e-6;
        if (typeof segment?.text !== 'string' || !segment.text.trim() || segment.text.length > 2000
          || !aligned(segment.duration) || segment.duration < .4 || segment.duration > 30
          || typeof segment.continuous !== 'boolean' || !Array.isArray(segment.face)
          || segment.face.length < 2 || segment.face.length > 8 || segment.face.some((key, i) =>
            !Number.isFinite(key?.at) || key.at < 0 || key.at > 1 || (i > 0 && key.at <= segment.face[i - 1].at)
            || faceNames.some(name => !Number.isFinite(key[name]) || key[name] < 0 || key[name] > 1)
            || faceNames.reduce((sum, name) => sum + key[name], 0) > 1 + 1e-6)
          || segment.face[0].at !== 0 || segment.face.at(-1).at !== 1) throw new Error('Codexの動作区間・表情の設計が不正です');
        return structuredClone(segment);
      };
      const receiveSegment = event => {
        if (!active() || finished) return;
        if (!Number.isInteger(event?.index) || event.index !== planned.length || planned.length >= 12
          || typeof event.continuous !== 'boolean' || !Number.isFinite(event.duration)
          || event.duration < 2 || event.duration > 30 || Math.abs(event.duration * 5 - Math.round(event.duration * 5)) > 1e-6
          || (!autoDuration && Math.abs(event.duration - duration) > 1e-6)) throw new Error('Codexの区間の順序・生成尺が不正です');
        if (header && (header.duration !== event.duration || header.continuous !== event.continuous)) throw new Error('Codexが確定済みの生成条件を変更しました');
        const authored = checkSegment(event.segment);
        const offset = planned.reduce((sum, s) => sum + s.duration, 0);
        const enriched = initialContext ? { segment: authored, fields: [] }
          : enrichJevSegment(authored, context, offset, event.duration);
        const segment = checkSegment(enriched.segment);
        if (planned.reduce((sum, s) => sum + s.duration, segment.duration) > event.duration + 1e-6) throw new Error('Codexの動作区間が予定尺を超えています');
        header ??= { duration: event.duration, continuous: event.continuous };
        designed.push(authored);
        planned.push(segment);
        if (enriched.fields.length) {
          usage.bodyRequested ||= enriched.fields.includes('body_style');
          usage.enrichedSegments = [...usage.enrichedSegments, event.index];
          usage.appliedFields = [...new Set([...usage.appliedFields, ...enriched.fields])];
        }
        bodyPlanMs ??= Math.round(now() - start);
        planState = 'streaming';
        firstSegment();
      };
      let presentations = Promise.resolve();
      const present = (final = false) => {
        const revision = current.revision;
        const operation = presentations.then(async () => {
          if (!active() || current.revision !== revision || !(current.spec.duration > 0)) return;
          const shouldLoop = loop === 'on' || (loop === 'auto' && (typeof header?.continuous === 'boolean'
            ? header.continuous : isLoopFriendly(current.spec, text)));
          const output = { ...applyAuthoredMotion(current.spec, current.authoredMotion), name: text.slice(0, 60), originalText: text,
            loop: final && shouldLoop, expressions: visibleExpressions(current.expressions, current.spec.duration),
            ...(toMotionSemanticContext(context) ? { jevContext: toMotionSemanticContext(context) } : {}),
            realtime: { source: 'ardy-session', sessionId: current.id, revision, chunks, complete: final,
              planner, planState, analysisMs, planMs, bodyPlanMs, firstChunkMs, firstFrameMs,
              instructionStartTime: current.origin, horizonFrames: current.horizonFrames,
              faceReady: planner === 'codex' ? current.faceSegments > 0 : false,
              bodyScopeEnforced: planner === 'codex' && planned.every(s => Array.isArray(s.body)),
              authoredFromStart: planner === 'codex', plannedSegments: sentSegments,
              plannedDuration: current.plannedDuration, loopPreference: loop, jev: { ...usage } } };
          if (!current.displayed && reactionId === reactionRevision) onReaction(null);
          await play(output, () => active() && current.revision === revision, { append: current.displayed, final });
          if (!active() || current.revision !== revision) return;
          current.displayed = true;
          firstFrameMs ??= Math.round(now() - start);
          output.realtime.firstFrameMs = firstFrameMs;
          const span = Math.max(1 / current.fps, current.target - current.origin);
          lastPercent = final ? 100 : Math.max(lastPercent, Math.min(99,
            Math.floor((current.spec.duration + 1 / current.fps - current.origin) / span * 100)));
          onProgress({ stage: final ? 'complete' : 'generating', percent: lastPercent });
          report(`${final ? '生成完了' : '生成しながら再生中'} / 初動 ${firstFrameMs} ms / ${current.spec.duration.toFixed(2)}秒`);
          return output;
        });
        presentations = operation.catch(() => {});
        return operation;
      };
      const setDirectFaces = from => {
        const span = current.target - current.origin;
        const face = applyJevExpressions({ duration: span, expressions: autoExpressions(text, span) }, context).expressions;
        current.expressions = replaceExpressions(current.expressions, face, from, current.origin, current.target);
      };
      const appendAuthoredFaces = () => {
        current.authoredMotion = syncAuthoredMotion(current.authoredMotion, planned, current.origin);
        let offset = current.origin;
        for (const [index, segment] of planned.entries()) {
          if (index >= current.faceSegments) {
            const future = plannedFaceTracks(segment.face, segment.duration);
            const old = current.expressions;
            for (const [name, relativeKeys] of Object.entries(future)) {
              const keys = old[name] ?? [];
              const end = offset + segment.duration;
              const blendEnd = offset === 0 ? 0 : Math.min(end, offset + .15);
              // Keep the previous segment's exact endpoint. Appending a new
              // expression must not change interpolation in the played prefix.
              const earlier = keys.filter(key => key.t < offset);
              if (offset > 0 && !earlier.length) earlier.push({ t: 0, w: 0 });
              old[name] = [...earlier, { t: offset, w: offset > 0 ? weightAt(keys, offset) : relativeKeys[0].w },
                ...(blendEnd > offset ? [{ t: blendEnd, w: weightAt(relativeKeys, blendEnd - offset) }] : []),
                ...relativeKeys.filter(key => key.t + offset > blendEnd).map(key => ({ ...key, t: key.t + offset }))];
            }
          }
          offset += segment.duration;
        }
        current.faceSegments = planned.length;
      };
      const patchContext = async () => {
        // Codex has already interpreted this evidence. Appending emotion text
        // downstream would override its concrete body instructions.
        if (planner === 'codex' || contextVersion <= sentContextVersion || !toMotionSemanticContext(context)) return;
        await enqueue(async () => {
          if (!active() || finished || session !== current) return;
          const version = contextVersion;
          const meta = await request(base, `/sessions/${encodeURIComponent(current.id)}/update`,
            { motionContext: toMotionSemanticContext(context), playbackTime: cursor(),
              knownUntil: knownUntil(), revision: ++wireRevision }, signal);
          if (!active()) return;
          current.revision = meta.revision;
          current.origin = meta.instructionStartTime;
          current.target = meta.targetDuration;
          current.plannedDuration = meta.plannedDuration ?? current.target;
          trimFuture(current, meta.replaceFrom);
          usage.bodyRequested = true;
          sentContextVersion = version;
          if (planner === 'none') setDirectFaces(Math.min(current.target, Math.max(current.origin,
            cursor() + (current.displayed ? .2 : 0))));
          if (current.displayed && current.spec.duration > 0) await present();
        });
      };
      const syncPlan = async () => {
        if (planner === 'none' || (sentSegments === planned.length && current.planComplete === planDone)) return;
        await enqueue(async () => {
          if (!active() || finished || session !== current) return;
          const prefix = structuredClone(planned), complete = planDone;
          const meta = await request(base, `/sessions/${encodeURIComponent(current.id)}/append`,
            { segments: prefix, planComplete: complete, revision: current.revision }, signal);
          if (!active()) return;
          if (meta.revision !== current.revision || !Number.isFinite(meta.plannedDuration)
            || meta.instructionStartTime !== current.origin) throw new Error('ARDYが確定済み区間の時刻を変更しました');
          sentSegments = prefix.length;
          current.planComplete = complete;
          current.plannedDuration = meta.plannedDuration;
          current.target = meta.targetDuration;
          current.complete = false;
          // If additional events arrived during the request, only materialize
          // the prefix that the server accepted; later ones sync next iteration.
          const available = planned;
          planned = prefix;
          appendAuthoredFaces();
          planned = available;
        });
      };
      try {
        onReaction(null);
        onProgress({ stage: planner === 'codex' ? 'planning' : 'generating', percent: planner === 'codex' ? null : 0 });
        report();
        // Start semantic analysis and motion planning independently. Analysis
        // is bounded but never gates the first motion-design request.
        const analysisTask = (async () => {
          try {
            const analysisSignal = AbortSignal.any([helperSignal, AbortSignal.timeout(analysisBudgetMs)]);
            const result = initialContext ?? await abortable(Promise.resolve().then(() => analyze?.(text,
              { useCache: false, state: snapshot, signal: analysisSignal })), analysisSignal);
            if (!active() || finished) return;
            context = result;
            analysisMs = Math.round(now() - start);
            const safe = toMotionSemanticContext(result);
            usage.analysisStatus = safe ? 'available' : 'unavailable';
            if (safe) {
              contextVersion++;
              usage.late = Boolean(current?.displayed);
              if (!current?.displayed && !replaceActive && !continuation && reactionId === reactionRevision) {
                onReaction(context, { preview: true });
                usage.preview = Object.values(createReaction(context, { preview: true })?.strengths ?? {}).some(w => w > 0);
              }
            }
          } catch (error) {
            if (!active() || finished || helpers.signal.aborted) return;
            usage.analysisStatus = 'failed'; analysisError = error.message || '接続に失敗しました';
          }
          report();
        })();
        if (planner === 'codex') {
          void (async () => {
            try {
              if (!plan) throw new Error('Codexの動作設計が設定されていません');
              helperSignal.throwIfAborted();
              const safe = toMotionSemanticContext(initialContext);
              usage.planner = !!safe;
              const result = await abortable(Promise.resolve().then(() => plan(text,
                { duration, autoDuration, motionContext: safe ?? undefined, state: snapshot,
                  signal: helperSignal, onSegment: receiveSegment })), helperSignal);
              if (!active() || finished) return;
              if (!Array.isArray(result?.segments) || !result.segments.length || result.segments.length > 12) throw new Error('Codexの最終計画が不正です');
              const finalSegments = result.segments.map(checkSegment);
              if (designed.length > finalSegments.length || designed.some((s, index) => JSON.stringify(s) !== JSON.stringify(finalSegments[index]))) throw new Error('Codexが確定済みの動作区間を変更しました');
              for (let index = planned.length; index < finalSegments.length; index++) receiveSegment({
                index, segment: finalSegments[index], duration: result.duration, continuous: result.continuous,
              });
              if (!header || header.duration !== result.duration || header.continuous !== result.continuous
                || Math.abs(planned.reduce((sum, s) => sum + s.duration, 0) - header.duration) > 1e-6) throw new Error('Codexの最終計画と区間の長さが一致しません');
              planDone = true;
              planMs = Math.round(now() - start);
              planState = 'applied';
              report();
            } catch (error) {
              if (id !== epoch || local.signal.aborted || helpers.signal.aborted || finished) return;
              planFailure = error;
              failedPlan.abort(error);
            }
          })();
          await abortable(firstPlan, signal);
          if (!active()) { if (planFailure) throw planFailure; return; }
        }
        // Explicit fresh generations start independent motion. Only an active
        // redirection or an explicit edit inherits the physical pose/history.
        await enqueue(async () => {
          if (!active()) return;
          const playback = getPlaybackState();
          if (session && (!(continuation || replaceActive) || session.base !== base || (session.complete &&
            ((playback?.cycles ?? 0) > 0 || playback?.sourceTimeReliable === false || now() - session.completedAt > 150000 ||
              (playback && (playback.sourceTime ?? playback.time) < (session.lastPlayback ?? 0) - .05))))) {
            const old = session; session = undefined; await close(old);
          }
          const safe = toMotionSemanticContext(context);
          const sendingContextVersion = contextVersion;
          const prefix = structuredClone(planned);
          const complete = planDone;
          const instruction = planner === 'codex'
            ? { segments: prefix, duration: header.duration, planComplete: complete, historyFrames: 40, plannerOwned: true }
            : { text, duration, plannerOwned: false };
          const common = { ...instruction, steps, motionContext: safe ?? null };
          const applyMeta = meta => {
            if (!Number.isFinite(meta.revision) || !Number.isFinite(meta.targetDuration) || !Number.isFinite(meta.instructionStartTime)
              || (planner === 'codex' && (!Number.isFinite(meta.plannedDuration) || typeof meta.planComplete !== 'boolean'))) {
              throw new Error('区間ごとの生成を有効にするため、ARDYサーバーを再起動してください');
            }
            if (prefix.some(s => s.body !== undefined) && meta.bodyScopeSupported !== true) {
              throw new Error('動かす部位の制御を有効にするため、ARDYサーバーを再起動してください');
            }
            if (prefix.some(s => s.rootAxes !== undefined) && meta.rootAxesSupported !== true) {
              throw new Error('移動方向の制御を有効にするため、ARDYサーバーを再起動してください');
            }
            if (prefix.some(s => s.turn?.length) && meta.turnSupported !== true) {
              throw new Error('回転と軸足の制御を有効にするため、ARDYサーバーを再起動してください');
            }
            current.revision = meta.revision; current.origin = meta.instructionStartTime; current.target = meta.targetDuration;
            current.plannedDuration = meta.plannedDuration ?? meta.targetDuration;
            current.planComplete = planner === 'none' || meta.planComplete;
            current.faceSegments = 0;
          };
          const open = async () => {
            const opening = request(base, '/sessions', { ...common, revision: ++wireRevision },
              AbortSignal.any([signal, AbortSignal.timeout(15000)]));
            // Even a transport that ignores cancellation must not hold the
            // mutation queue. Close a late response without publishing its ID.
            void opening.then(meta => {
              if (!active() && meta?.sessionId) void close({ id: meta.sessionId, base });
            }, () => {});
            const meta = await abortable(opening, signal);
            signal.throwIfAborted();
            if (!meta.sessionId) throw new Error('ARDYセッション応答の形式が不正です');
            current = { id: meta.sessionId, base, fps: meta.fps ?? 20, horizonFrames: meta.horizonFrames ?? 40,
              displayed: false, complete: false, expressions: {}, spec: { duration: 0, loop: false, tracks: {}, hips: [] } };
            session = current;
            applyMeta(meta);
          };
          if (!session) await open();
          else {
            current = session;
            try {
              const meta = await abortable(request(base, `/sessions/${encodeURIComponent(current.id)}/update`,
                { ...common, playbackTime: cursor(), knownUntil: knownUntil(),
                  revision: ++wireRevision }, AbortSignal.any([signal, AbortSignal.timeout(15000)])), signal);
              signal.throwIfAborted();
              applyMeta(meta);
              trimFuture(current, meta.replaceFrom);
            } catch (error) {
              if (![404, 410].includes(error.status) && error.code !== 'history_expired') throw error;
              await close(current); session = undefined; await open();
            }
          }
          if (!active()) return;
          sentSegments = prefix.length;
          usage.bodyRequested = planner === 'none' ? !!safe : planned.some(segment => segment.jevContext);
          sentContextVersion = sendingContextVersion;
          usage.bodyRequestMs = Math.round(now() - start);
          if (planner === 'codex') {
            const latest = planned; planned = prefix;
            appendAuthoredFaces();
            planned = latest;
            // Natural blinking and speech mouth shapes are independent of the
            // authored emotional face. Speech timing follows the original text.
            const tracks = { ...speechMouth(text, header.duration) };
            const blink = naturalBlinks(header.duration, { seed: text });
            if (blink) tracks.blink = blink;
            for (const [name, keys] of Object.entries(tracks)) current.expressions[name] = [
              ...(current.expressions[name] ?? []).filter(k => k.t < current.origin),
              ...keys.map(k => ({ ...k, t: k.t + current.origin })),
            ];
          } else setDirectFaces(current.origin);
          onProgress({ stage: 'generating', percent: 0 });
          report('ARDYで最初の動作区間を生成中…');
          if (current.displayed && current.spec.duration > 0) await present();
        });
        let chunkLatencyMs = 0;
        while (active()) {
          await syncPlan();
          await patchContext();
          if (!active()) break;
          if (current.complete) {
            if (planDone) break;
            report('生成済みの区間を再生中…Codexが続きを設計しています');
            await wait(40, signal);
            continue;
          }
          const ahead = current.spec.duration - cursor(), horizon = current.horizonFrames / current.fps;
          if (current.displayed && ahead > motionLookaheadSeconds(horizon, chunkLatencyMs)) { await wait(40, signal); continue; }
          const requestedRevision = current.revision;
          current.lastPlayback = cursor();
          let event;
          const chunkStarted = now();
          try { event = await request(base, `/sessions/${encodeURIComponent(current.id)}/next`,
            { playbackTime: cursor(), revision: requestedRevision }, signal); }
          catch (error) { if (error.status === 409) { await wait(40, signal); continue; } throw error; }
          if (!active()) break;
          if (event.type === 'stale' || requestedRevision !== current.revision || event.revision !== current.revision) continue;
          if (event.type === 'waiting') {
            report('生成済みの区間を再生中…Codexが続きを設計しています');
            await wait(40, signal);
            continue;
          }
          if (event.type === 'complete') { current.complete = true; continue; }
          if (event.type !== 'chunk') throw new Error('ARDYセッションイベントの形式が不正です');
          firstChunkMs ??= Math.round(now() - start);
          appendChunk(current, event); chunks++;
          if (Number.isFinite(event.targetDuration)) current.target = event.targetDuration;
          usage.bodyApplied ||= usage.bodyRequested && event.jev?.bodyApplied === true;
          usage.bodyApplicationConfirmed ||= typeof event.jev?.bodyApplied === 'boolean';
          await present();
          chunkLatencyMs = updateMotionLatency(chunkLatencyMs, now() - chunkStarted);
        }
        if (planFailure) throw planFailure;
        if (!active()) return;
        if (planner === 'codex' && (!planDone || sentSegments !== planned.length)) throw new Error('Codexの動作設計が完了していません');
        if (usage.analysisStatus === 'pending') usage.analysisStatus = 'not_ready';
        finished = true;
        helpers.abort();
        const output = await present(true);
        if (active()) current.completedAt = now();
        return output;
      } catch (error) {
        if (id !== epoch || local.signal.aborted) return;
        local.abort();
        onReaction(null);
        onProgress({ stage: 'error', percent: null });
        void enqueue(async () => { if (session === current) { session = undefined; await close(current); } });
        throw planFailure ?? error;
      } finally { finished = true; helpers.abort(); }
    },
  };
}
