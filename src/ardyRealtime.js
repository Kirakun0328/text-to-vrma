import { createReaction, isFaceOnlyUpdate } from './jevRuntime.js';
import { autoExpressions } from './autoExpressions.js';
import { plannedFaceTracks } from './realtimePlan.js';
import { DEFAULT_JEV_TIMEOUT_MS } from './jevAnalyzer.js';
import { toMotionSemanticContext } from './jevMotionContext.js';
import { isLoopFriendly } from './specMerge.js';

// Every utterance starts fresh ARDY inference, without a motion library or cache.
function availableExpressions(expressions, end) {
  return Object.fromEntries(Object.entries(expressions).map(([name, keys]) => {
    const ready = keys.filter(key => key.t <= end).map(key => ({ ...key }));
    const left = ready.at(-1), right = keys.find(key => key.t > end);
    if (left && left.t < end) ready.push({ t: end, w: right
      ? left.w + (right.w - left.w) * (end - left.t) / (right.t - left.t) : left.w });
    return [name, ready];
  }));
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readArdyStream(response, onEvent, signal) {
  if (!response.ok) throw new Error(`ARDY生成に失敗しました (HTTP ${response.status})`);
  if (!response.body) throw new Error('ARDYの生成ストリームがありません');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finished = false;
  const line = async value => {
    if (!value.trim()) return;
    const event = JSON.parse(value);
    if (event.type === 'error') throw new Error(event.error || 'ARDY生成エラー');
    if (finished) throw new Error('ARDYストリームの終了後にデータが届きました');
    await onEvent(event);
    if (event.type === 'final') finished = true;
  };
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw new Error('ARDYの生成データが大きすぎます');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const value = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        await line(value);
      }
      if (done) { await line(buffer); break; }
    }
    if (!finished) throw new Error('ARDYの生成が完了前に切断されました');
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createArdyRealtime({ analyze, plan, play, fetchImpl = (...args) => fetch(...args),
  onStatus = () => {}, onProgress = () => {}, onReaction = () => {}, getState = () => ({}), now = () => performance.now(), analysisBudgetMs = DEFAULT_JEV_TIMEOUT_MS + 500 } = {}) {
  let revision = 0, controller, updateRevision = 0, updateController, reactionRevision = 0;
  function stop() { revision++; updateRevision++; reactionRevision++; controller?.abort(); updateController?.abort(); onReaction(null); }
  return {
    stop,
    async update(text, url, options = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('セリフ・状況を入力してください');
      updateController?.abort();
      const updateId = ++updateRevision;
      const pending = updateController = new AbortController();
      const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(analysisBudgetMs)]);
      let context;
      try {
        context = await Promise.race([
          analyze(text, { useCache: false, state: getState(), signal }),
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        ]);
      } catch { /* A failed analysis must not discard the new instruction. */ }
      if (pending.signal.aborted || updateId !== updateRevision) return;
      if (getState().current_action && isFaceOnlyUpdate(context)) {
        reactionRevision++;
        onReaction(context, { preview: false, persistent: true });
        onStatus('Jevで表情を更新しました。身体の動きは継続します。');
        return { faceOnly: true };
      }
      return { replan: true, context };
    },
    async react(text, url, { duration = 6, steps = 8, initialContext, autoDuration = false, continuation = false, loop = 'auto' } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('セリフ・状況を入力してください');
      if (!Number.isFinite(duration) || duration < 2 || duration > 30) throw new Error('生成秒数は2〜30秒で指定してください');
      if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('推論ステップ数が不正です');
      if (!['auto', 'on', 'off'].includes(loop)) throw new Error('ループ設定が不正です');
      stop();
      const id = revision;
      const reactionId = reactionRevision;
      const requestController = controller = new AbortController();
      const signal = AbortSignal.any([requestController.signal, AbortSignal.timeout(180000)]);
      const start = now();
      const active = () => id === revision && !signal.aborted;
      const analysisController = new AbortController();
      let finished = false;
      try {
        let context = initialContext, analysisMs = null, hasBody = false;
        const usage = { analysisStatus: 'pending', planner: false, bodyRequested: false,
          bodyApplied: false, bodyApplicationConfirmed: false, preview: false, late: false, bodyRequestMs: null };
        let analysisError;
        const analysisNote = () => {
          const routes = [];
          if (usage.planner) routes.push('Codex計画');
          if (usage.bodyApplied) routes.push('身体生成');
          else if (usage.bodyRequested) routes.push(usage.bodyApplicationConfirmed ? '身体補助の適用なし' : '身体生成へ送信済み（適用未確認）');
          if (usage.preview) routes.push('先行表情');
          if (routes.length) return ` / Jev: ${routes.join('・')}`;
          if (usage.analysisStatus === 'pending') return ' / Jev解析中（生成は並行）';
          if (usage.analysisStatus === 'not_ready') return ' / Jev解析は生成完了に間に合わず（追加待ちなし）';
          if (usage.analysisStatus === 'failed') return ` / Jev補助なし（${analysisError}）。Codexで生成を継続`;
          if (usage.analysisStatus === 'available') return ' / Jev解析済み（今回の演技への適用なし）';
          return ' / Jev補助なし（APIキー未設定、または解析結果なし）';
        };
        let stage = 'Codexが状況を理解して動作を計画中…';
        const report = message => { stage = message; if (active()) onStatus(stage + analysisNote()); };
        // Fresh generation must not inherit the last instruction, pose or facial state.
        const snapshot = continuation ? getState() : undefined;
        onProgress({ stage: 'planning', percent: null });
        report(stage);
        const analysisSignal = AbortSignal.any([signal, analysisController.signal]);
        void (async () => {
          let timer;
          try {
            context = initialContext ?? await Promise.race([
              Promise.resolve().then(() => analyze(text, { useCache: false, state: snapshot, signal: analysisSignal })),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Jev解析がタイムアウトしました')), analysisBudgetMs); }),
              new Promise((_, reject) => analysisSignal.addEventListener('abort', () => reject(analysisSignal.reason), { once: true })),
            ]);
            if (!active() || finished) return;
            analysisMs = Math.round(now() - start);
            usage.analysisStatus = toMotionSemanticContext(context) ? 'available' : 'unavailable';
            usage.late = !!context && usage.bodyRequestMs !== null;
            // This analysis describes the start, so never overlay it on a later acting beat.
            if (context && !hasBody && reactionId === reactionRevision) {
              onReaction(context, { preview: true });
              usage.preview = Object.values(createReaction(context, { preview: true })?.strengths ?? {})
                .some(strength => strength > 0);
            }
          } catch (error) {
            if (!active() || finished) return;
            analysisMs = Math.round(now() - start);
            usage.analysisStatus = 'failed';
            analysisError = error.message || '接続に失敗しました';
          } finally {
            clearTimeout(timer);
            analysisController.abort();
          }
          report(stage);
        })();
        // Use only analysis already available at each boundary. Neither planner nor ARDY
        // waits for Jev, and late analysis never changes already generated motion.
        if (!plan) throw new Error('Codexの動作計画が設定されていません');
        let acting, planMs;
        let bodyReady;
        const earlyBody = new Promise(resolve => { bodyReady = resolve; });
        const planning = abortable(Promise.resolve().then(() => {
          const plannerContext = toMotionSemanticContext(context) ?? undefined;
          usage.planner = !!plannerContext;
          return plan(text, {
            motionContext: plannerContext, state: snapshot, duration, autoDuration, signal,
            onBodyPlan: body => { if (active()) bodyReady(body); },
          });
        }).then(result => {
          signal.throwIfAborted();
          acting = result;
          planMs = Math.round(now() - start);
          return result;
        }), signal);
        planning.catch(() => {});
        const bodyPlan = await Promise.race([earlyBody, planning]);
        const bodyPlanMs = Math.round(now() - start);
        signal.throwIfAborted();
        if (!active()) return;
        if (!Array.isArray(bodyPlan?.segments) || !bodyPlan.segments.length || bodyPlan.segments.some(s =>
          !s.text?.trim() || !Number.isFinite(s.duration) || s.duration <= 0)) throw new Error('Codexの動作計画が不正です');
        const total = bodyPlan.segments.reduce((sum, s) => sum + s.duration, 0);
        if (autoDuration) {
          if (total < 2 || total > 30) throw new Error('Codexの自動生成尺は2〜30秒に収める必要があります');
          duration = total;
        }
        const segments = bodyPlan.segments.map(s => ({ text: s.text, duration: s.duration * duration / total }));
        const bodyContext = toMotionSemanticContext(context) ?? undefined;
        usage.bodyRequested = !!bodyContext;
        usage.bodyRequestMs = Math.round(now() - start);
        onProgress({ stage: 'generating', percent: 0 });
        report('ARDYで新しい動きを生成中…最初のフレームを待っています');
        const response = await Promise.race([fetchImpl(`${url.replace(/\/+$/, '')}/generate-stream`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ text, segments, duration, steps, motionContext: bodyContext,
            historyFrames: bodyPlan.continuous === true ? 4 : 40,
            lowLatency: true, postprocess: false }),
        }), planning.then(() => new Promise(() => {}))]);
        let spec = { name: text.slice(0, 60), duration: 0, loop: false, tracks: {}, hips: [] };
        let finalOutput;
        let firstFrameMs = null, firstChunkMs = null, chunks = 0, targetDuration = duration, fps = 20, lastPercent = 0;
        let expressions;
        const updateExpressions = span => {
          expressions = autoExpressions(text, span, acting.expression || 'neutral', segments);
          if (acting.face) {
            delete expressions.neutral;
            Object.assign(expressions, plannedFaceTracks(acting.face, span));
          }
        };
        await Promise.race([readArdyStream(response, async event => {
          if (!active()) return;
          if (event.type === 'meta') {
            if (Number.isFinite(event.duration) && event.duration > 0) targetDuration = event.duration;
            if (Number.isFinite(event.fps) && event.fps > 0) fps = event.fps;
            return;
          }
          // Show the real generated body immediately. A pending face must not block it.
          // Do not invent a replacement expression; attach the authored face once ready.
          // Only completion/export waits for the entire validated plan.
          if (event.type === 'chunk') firstChunkMs ??= Math.round(now() - start);
          if (event.type === 'final') await planning;
          if (acting && (!expressions || event.type === 'final')) {
            updateExpressions(event.type === 'final' ? event.spec?.duration : targetDuration);
          }
          if (!active()) return;
          if (event.type === 'chunk') {
            if (!event.tracks || !Array.isArray(event.hips)) throw new Error('ARDYチャンクの形式が不正です');
            for (const [bone, keys] of Object.entries(event.tracks)) {
              if (!Array.isArray(keys)) throw new Error('ARDYボーントラックが不正です');
              const track = spec.tracks[bone] ??= [];
              for (const key of keys) {
                if (!Number.isFinite(key.t) || key.t < 0 || (track.length && key.t <= track.at(-1).t)) {
                  throw new Error('ARDYチャンクの時刻が不正です');
                }
                track.push(key);
                spec.duration = Math.max(spec.duration, key.t);
              }
            }
            spec.hips.push(...event.hips);
            chunks++;
          } else if (event.type === 'final') {
            if (!(event.spec?.duration > 0) || !event.spec.tracks) throw new Error('ARDYの最終モーションが不正です');
            spec = event.spec;
            usage.bodyApplied = usage.bodyRequested && spec.jev?.bodyApplied === true;
            usage.bodyApplicationConfirmed = typeof spec.jev?.bodyApplied === 'boolean';
            if (usage.analysisStatus === 'pending') usage.analysisStatus = 'not_ready';
            finished = true;
            analysisController.abort();
          } else throw new Error(`未対応のARDYイベント: ${event.type}`);
          if (!(spec.duration > 0)) return;
          const final = event.type === 'final';
          const recordedContext = toMotionSemanticContext(context);
          const shouldLoop = loop === 'on' || (loop === 'auto' &&
            (typeof bodyPlan.continuous === 'boolean' ? bodyPlan.continuous : isLoopFriendly(spec, text)));
          const output = { ...structuredClone(spec), loop: final && shouldLoop,
            expressions: expressions ? availableExpressions(expressions, spec.duration) : {},
            originalText: text,
            ...(recordedContext ? { jevContext: recordedContext } : {}),
            realtime: { source: 'ardy-stream', chunks, complete: final, analysisMs, planMs: planMs ?? null, bodyPlanMs,
              firstChunkMs, firstFrameMs, faceReady: !!acting, loopPreference: loop,
              jev: { ...usage } } };
          if (firstFrameMs === null) {
            hasBody = true;
            if (reactionId === reactionRevision) onReaction(null);
          }
          await play(output, active, { append: firstFrameMs !== null, final });
          if (!active()) return;
          if (final) finalOutput = output;
          firstFrameMs ??= Math.round(now() - start);
          output.realtime.firstFrameMs = firstFrameMs;
          const elapsed = Math.round(now() - start);
          const ratio = ((elapsed / 1000) / spec.duration).toFixed(2);
          lastPercent = final ? 100 : Math.max(lastPercent, Math.min(99, Math.floor((spec.duration + 1 / fps) / targetDuration * 100)));
          onProgress({ stage: final ? 'complete' : 'generating', percent: lastPercent });
          report(`${final ? '生成完了' : '生成しながら再生中'} / 初動 ${firstFrameMs} ms / `
            + `${spec.duration.toFixed(2)}秒の動き / 経過 ${elapsed} ms / 実時間比 ${ratio}`
            + ` / Codex身体計画 ${bodyPlanMs} ms・${acting ? `表情込み ${planMs} ms` : '表情は生成中'}`);
        }, signal), planning.then(() => new Promise(() => {}))]);
        return active() ? finalOutput : undefined;
      } catch (error) {
        if (id !== revision || requestController.signal.aborted) return;
        requestController.abort();
        onReaction(null);
        onProgress({ stage: 'error', percent: null });
        throw error;
      } finally {
        finished = true;
        analysisController.abort();
      }
    },
  };
}
