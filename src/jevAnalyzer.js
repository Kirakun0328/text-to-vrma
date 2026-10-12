import { boundedState, FACE_NAMES } from './jevRuntime.js';
import { BODY_INTENT_GROUPS, CHANNEL_INTENT_NAMES, TEMPORAL_INTENT_NAMES } from './jevMotionContext.js';
// jevAnalyzer.js — TypeSafe AI の Jev (System One モデル) でテキストの意味・感情を解析する。
// 責務は「自然文 → MotionContext」のみ。プロンプト構築やモーション生成には一切関与しない。
// Jevが使えない・失敗した場合は呼び出し側が従来どおりのパイプラインへフォールバックできるよう、
// analyzeMotionContext() は例外を投げず null を返す。

export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_JEV_TIMEOUT_MS = 4000;
export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.55;
export const JEV_MAX_INPUT_CHARS = 2000;
const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

export const EMOTIONS = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'fear', 'embarrassment', 'confusion', 'excitement', 'affection', 'disgust'];
// Legacy reaction strings may be read, but no gesture catalog is queried or selected.
const INTENSITY_LEVELS = ['subtle', 'normal', 'strong', 'extreme'];
const ENERGY_LEVELS = ['low', 'medium', 'high', 'extreme'];

// 同一テキスト(+モデル)の短時間の再解析を避けるだけの単純なメモリキャッシュ
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
}

function buildQuestions() {
  // Every independent question sees the same input. IDs are not model context:
  // name the actor, channel, and time in each instruction, then batch one call.
  const questions = {
    emotion: {
      type: 'choice',
      instructions: 'Which emotion best describes the AVATAR at the START of the performance requested in `input`? Follow explicit directions, not the user or listener. Choose neutral if none applies.',
      criteria: {
        neutral: 'No clear emotion, or none of the listed emotions fits.', joy: 'Happy, pleased or satisfied.',
        sadness: 'Sad or disappointed.', anger: 'Angry or irritated.', surprise: 'Surprised by an unexpected event.',
        fear: 'Afraid or anxious.', embarrassment: 'Shy, embarrassed or self-conscious.',
        confusion: 'Confused or unsure.', excitement: 'Excited or enthusiastic.',
        affection: 'Affection or fondness.', disgust: 'Disgust or distaste.',
      },
    },
    intensity: {
      type: 'score', instructions: 'How strong is the AVATAR emotion at the START of the performance requested in `input`? Do not rate a later emotion as already present.',
      criteria: ['Absent or suppressed', 'Slight', 'Clearly felt', 'Intense or overwhelming'],
    },
    energy: {
      type: 'score', instructions: 'How much physical energy does the AVATAR use for the movement requested in `input`? Respect restrictions and stillness. Emotional intensity alone does not require limb motion.',
      criteria: ['Still or minimal effort', 'Ordinary effort', 'Vigorous effort', 'Very strenuous effort'],
    },
    scale: {
      type: 'choice', instructions: 'What movement amplitude is requested for the AVATAR in `input`? Follow explicit size and limb restrictions; infer only unspecified style. Do not prescribe an action.',
      criteria: { small: 'Small movement.', medium: 'Ordinary amplitude.', large: 'Large amplitude.' },
    },
    tempo: {
      type: 'choice', instructions: 'What is the STARTING movement tempo requested for the AVATAR in `input`? Follow explicit speed and timing; do not confuse speech speed with movement.',
      criteria: { slow: 'Slow.', normal: 'Ordinary speed.', fast: 'Fast.' },
    },
    social: {
      type: 'choice', instructions: 'What social attitude does the AVATAR express toward others in `input`? Distinguish actor intent from other characters and the user. Respect negation.',
      criteria: { positive: 'Friendly or approving.', neutral: 'Neutral or unspecified.', negative: 'Unfriendly or rejecting.' },
    },
    loop: {
      type: 'noul', instructions: 'Does `input` request that the AVATAR repeat movement continuously? A finite count, explicit ending, or single action is not an ongoing loop. Do not infer repetition from emotion.',
    },
    update_scope: {
      type: 'choice', instructions: 'Does the NEW `input` explicitly change only the AVATAR facial expression while retaining `current_action`? When ambiguous, or no current action exists, choose body.',
      criteria: { face_only: 'Only facial expression changes; current body action explicitly continues unchanged.', body: 'A body action, posture, head movement, new performance, or ambiguous request.' },
    },
  };
  for (const [prefix, time] of [['affect_', 'START'], ['affect_end_', 'END']]) {
    for (const name of FACE_NAMES) questions[prefix + name] = {
      type: 'score',
      instructions: `Independently rate the AVATAR ${name} facial expression at the ${time} of the performance in ` + '`input`' + '. Allow simultaneous feelings. Respect suppression, changes and order; other times do not describe this endpoint.',
      criteria: ['Absent or explicitly suppressed', 'Slight but perceptible', 'Clearly present', 'Dominant and intense'],
    };
  }
  for (const [key, time] of [['gaze', 'START'], ['gaze_end', 'END']]) questions[key] = {
    type: 'choice', instructions: `What eye gaze direction is explicit or clearly supported by the AVATAR situation at the ${time} of ` + '`input`' + '? Explicit directions take priority. Choose unspecified when context gives no directional basis or the target location is unknown; do not assign a stock gaze to an emotion. Eye gaze does not require moving the head.',
    criteria: { forward: 'Look straight ahead.', left: 'Look left.', right: 'Look right.', down: 'Look down.', up: 'Look up.', unspecified: 'Direction not specified in these coordinates.' },
  };
  const bodyDescriptions = {
    root: 'root/pelvis world position or whole-body orientation', torso: 'torso/spine', head: 'head/neck',
    leftArm: 'left arm/hand', rightArm: 'right arm/hand', leftLeg: 'left leg/foot', rightLeg: 'right leg/foot',
  };
  for (const name of BODY_INTENT_GROUPS) questions['body_' + name] = {
    type: 'noul',
    instructions: 'Does `input` request active movement of the AVATAR ' + bodyDescriptions[name]
      + ', explicitly or as physically necessary to perform the requested action? Judge the entire performance. Respect sides, prohibitions and stillness; exclude incidental idle motion and gestures inferred solely from emotion. Eye motion alone does not count as head motion.',
    criteria: { true: 'Requested or physically necessary active movement of this group.', false: 'Unrequested, unnecessary, or explicitly held still.' },
  };
  questions.channel_gaze = {
    type: 'noul', instructions: 'Does `input` request the AVATAR to direct or change eye gaze? A specified look target counts even without a left/right direction. Do not invent gaze from an emotion alone.',
  };
  questions.channel_face = {
    type: 'noul', instructions: 'Does `input` request the AVATAR facial expression or a visible facial emotion? An explicitly restrained or suppressed expression counts. Physical movement alone does not imply emotion.',
  };
  const temporalQuestions = {
    body_changes: 'Does `input` request a change of AVATAR body action, posture or movement style over the course of the performance, beyond phases of one repeated movement?',
    affect_changes: 'Does `input` request that the AVATAR facial emotion changes during the performance? Simultaneous mixed feelings alone are not a temporal change.',
    gaze_changes: 'Does `input` request that the AVATAR eye gaze changes direction or target during the performance, rather than holding one gaze?',
    ordered_actions: 'Does `input` give an explicit before/after ordering of AVATAR actions, including body, face or gaze?',
  };
  for (const name of TEMPORAL_INTENT_NAMES) questions['temporal_' + name] = { type: 'noul', instructions: temporalQuestions[name] };
  return questions;
}

function normalizeAnswers(answers) {
  const questions = buildQuestions();
  const result = {}, confidences = {}, probabilities = {}, invalid = [];
  const valid = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers?.[name];
    if (!answer) continue;
    let value;
    if (question.type === 'choice' && Object.hasOwn(question.criteria, answer.choice)) value = answer.choice;
    if (question.type === 'score' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1) value = answer.score;
    if (question.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1) value = answer.noul;
    if (value === undefined || (answer.type !== undefined && answer.type !== question.type)) { invalid.push(name); continue; }
    valid[name] = value;
    if (question.type === 'noul') continue; // P(yes), never a confidence or a magnitude.
    confidences[name] = Number.isFinite(answer.confidence) ? clamp01(answer.confidence) : 0;
    const options = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)) {
      const distribution = Object.fromEntries(options.filter(key => Number.isFinite(answer.probabilities[key]) && answer.probabilities[key] >= 0 && answer.probabilities[key] <= 1)
        .map(key => [key, answer.probabilities[key]]));
      if (Object.keys(distribution).length) probabilities[name] = distribution;
    }
  }
  if (!Object.keys(valid).length) throw makeError(502, 'jev_invalid_response', 'Jev APIの応答形式が不正です');
  const choices = { emotion: 'emotion', scale: 'movement_scale', tempo: 'tempo', social: 'social_intent', update_scope: 'update_scope', gaze: 'gaze', gaze_end: 'gaze_end' };
  for (const [source, destination] of Object.entries(choices)) if (source in valid) result[destination] = valid[source];
  if ('intensity' in valid) result.emotion_intensity = valid.intensity / (INTENSITY_LEVELS.length - 1);
  if ('energy' in valid) result.movement_energy = valid.energy / (ENERGY_LEVELS.length - 1);
  for (const [key, prefix] of [['affect', 'affect_'], ['affect_end', 'affect_end_']]) {
    const scores = Object.fromEntries(FACE_NAMES.filter(name => prefix + name in valid).map(name => [name, {
      value: valid[prefix + name] / 3, confidence: confidences[prefix + name],
    }]));
    if (Object.keys(scores).length) result[key] = scores;
  }
  for (const [key, prefix, names] of [['body_intent', 'body_', BODY_INTENT_GROUPS], ['channel_intent', 'channel_', CHANNEL_INTENT_NAMES], ['temporal', 'temporal_', TEMPORAL_INTENT_NAMES]]) {
    const values = Object.fromEntries(names.filter(name => prefix + name in valid).map(name => [name, valid[prefix + name]]));
    if (Object.keys(values).length) result[key] = values;
  }
  if ('loop' in valid) { result.loop_probability = valid.loop; result.loop_preference = valid.loop > 0.5; }
  // Kept for legacy consumers only; motion context never exposes this string.
  if (typeof answers?.reaction?.choice === 'string' && /^[a-z_]{1,48}$/.test(answers.reaction.choice)) result.reaction = answers.reaction.choice;
  result.confidences = confidences;
  if (Object.keys(probabilities).length) result.probabilities = probabilities;
  const legacyConfidence = ['emotion', 'scale', 'tempo', 'social'].filter(name => name in confidences).map(name => confidences[name]);
  result.confidence = legacyConfidence.length ? Math.min(...legacyConfidence) : 0;
  if (invalid.length) result.invalid_fields = invalid;
  return result;
}

function makeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function statusToError(status) {
  if (status === 401) return makeError(401, 'jev_unauthorized', 'Jev APIキーが無効です');
  if (status === 422) return makeError(422, 'jev_invalid_request', 'Jevへのリクエストが不正です');
  if (status === 429) return makeError(429, 'jev_rate_limited', 'Jev APIのレート制限を超えました');
  if (status === 503) return makeError(503, 'jev_unavailable', 'Jevサービスが一時的に利用できません（HTTP 503）');
  if (status === 529) return makeError(502, 'jev_overloaded', 'Jev APIが過負荷状態です');
  return makeError(502, 'jev_error', `Jev APIがHTTP ${status}を返しました`);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Jevへ問い合わせて MotionContext を得る。失敗時は typed Error を投げる。
 * (通常はこの関数を直接使わず analyzeMotionContext / analyzeMotionContextStrict を使う)
 */
async function runJevAnalysis(text, {
  apiKey,
  model = DEFAULT_JEV_MODEL,
  timeoutMs = DEFAULT_JEV_TIMEOUT_MS,
  signal,
  fetchImpl = fetch,
  useCache = true,
  state,
} = {}) {
  const trimmed = (text || '').trim();
  if (!apiKey || !trimmed) return null;

  const truncated = trimmed.slice(0, JEV_MAX_INPUT_CHARS);
  const snapshot = boundedState(state);
  const inputState = { input: truncated, actor_role: 'avatar performing the requested direction', ...snapshot };
  const cacheKey = `${model}:${JSON.stringify(inputState)}`;
  if (useCache) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    let res;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
      requestSignal.throwIfAborted();
      res = await fetchImpl(JEV_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ state: inputState, model, questions: buildQuestions() }),
        signal: requestSignal,
      });
      if (attempt || ![502, 503, 504, 529].includes(res.status)) break;
      const retryAfter = res.headers?.get?.('retry-after');
      const delay = retryAfter == null ? 250 : Math.max(250,
        Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      if (!Number.isFinite(delay) || Date.now() - started + delay + 500 >= timeoutMs) break;
      await res.body?.cancel?.();
      await new Promise((resolve, reject) => {
        const aborted = () => { clearTimeout(wait); reject(requestSignal.reason); };
        const wait = setTimeout(() => { requestSignal.removeEventListener('abort', aborted); resolve(); }, delay);
        requestSignal.addEventListener('abort', aborted, { once: true });
        if (requestSignal.aborted) aborted();
      });
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      if (controller.signal.aborted || err.name === 'AbortError') {
        console.warn(`[Jev] timeout after ${timeoutMs}ms`);
        throw makeError(504, 'jev_timeout', 'Jev APIの応答がタイムアウトしました');
      }
      console.warn('[Jev] network error:', err.message);
      throw makeError(502, 'jev_unavailable', 'Jev APIに接続できません');
    }

    if (!res.ok) {
      console.warn(`[Jev] HTTP ${res.status}`);
      throw statusToError(res.status);
    }

    let data;
    try { data = await res.json(); }
    catch { throw makeError(502, 'jev_invalid_response', 'Jev APIの応答をJSONとして読み取れませんでした'); }
    const context = normalizeAnswers(data?.answers);

    if (useCache) cacheSet(cacheKey, context);
    // APIキー・入力全文はログに残さない (長さのみ)
    console.log('[Jev]', {
      latencyMs: Date.now() - started,
      textLength: trimmed.length,
      emotion: context.emotion,
      intensity: context.emotion_intensity,
      confidence: Number(context.confidence.toFixed(2)),
    });
    return context;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * パイプライン用: 失敗しても例外を投げず null を返す。
 * Jevが完全に利用不能でもモーション生成全体を止めないための唯一の入口。
 */
export async function analyzeMotionContext(text, options = {}) {
  try {
    return await runJevAnalysis(text, options);
  } catch (error) {
    console.warn('[Jev] analysis failed, falling back:', error.code || error.message);
    return null;
  }
}

/**
 * 解析専用エンドポイント用: 失敗時は typed Error (status/code付き) を投げる。
 */
export async function analyzeMotionContextStrict(text, options = {}) {
  return runJevAnalysis(text, options);
}

/** Legacy diagnostic only; never gate motion generation on overall confidence. */
export function isConfident(context, threshold = DEFAULT_JEV_CONFIDENCE_THRESHOLD) {
  return Boolean(context) && typeof context.confidence === 'number' && context.confidence >= threshold;
}

// Mark uncertain fields without replacing them by a fabricated neutral/idle value.
export function softenUncertainContext(context, threshold = DEFAULT_JEV_CONFIDENCE_THRESHOLD) {
  if (!context) return context;
  const result = { ...context, uncertain_fields: [] };
  for (const name of ['emotion', 'reaction', 'scale', 'tempo', 'social', 'intensity', 'energy', 'gaze']) {
    if ((context.confidences?.[name] ?? context.confidence ?? 0) < threshold) result.uncertain_fields.push(name);
  }
  return result;
}

/** 0-1の数値をUI表示用の4段階ラベルに変換する (例: emotion_intensity → "strong") */
export function bucketLevel(value) {
  if (!(value >= 0)) return 'subtle';
  if (value < 0.25) return 'subtle';
  if (value < 0.55) return 'normal';
  if (value < 0.8) return 'strong';
  return 'extreme';
}
