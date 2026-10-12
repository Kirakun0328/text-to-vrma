import { FACE_NAMES } from './jevRuntime.js';

export const BODY_INTENT_GROUPS = ['root', 'torso', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
export const CHANNEL_INTENT_NAMES = ['gaze', 'face'];
export const TEMPORAL_INTENT_NAMES = ['body_changes', 'affect_changes', 'gaze_changes', 'ordered_actions'];

// This is semantic evidence, never an action selector or a motion preset.
const CHOICES = {
  emotion: ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'fear', 'embarrassment', 'confusion', 'excitement', 'affection', 'disgust'],
  movement_scale: ['small', 'medium', 'large'],
  tempo: ['slow', 'normal', 'fast'],
  social_intent: ['positive', 'neutral', 'negative'],
  gaze: ['forward', 'left', 'right', 'down', 'up'],
  gaze_end: ['forward', 'left', 'right', 'down', 'up'],
};
const CONFIDENCE_NAMES = {
  emotion: 'emotion', emotion_intensity: 'intensity', movement_energy: 'energy',
  movement_scale: 'scale', tempo: 'tempo', social_intent: 'social', gaze: 'gaze', gaze_end: 'gaze_end',
};
const DISTRIBUTION_OPTIONS = {
  emotion: CHOICES.emotion, scale: CHOICES.movement_scale, tempo: CHOICES.tempo,
  social: CHOICES.social_intent, gaze: [...CHOICES.gaze, 'unspecified'],
  gaze_end: [...CHOICES.gaze_end, 'unspecified'], update_scope: ['face_only', 'body'],
  intensity: ['0', '1', '2', '3'], energy: ['0', '1', '2', '3'],
  ...Object.fromEntries(FACE_NAMES.flatMap(name => [['affect_' + name, ['0', '1', '2', '3']], ['affect_end_' + name, ['0', '1', '2', '3']]])),
};
const NON_AFFECT_TRACKS = new Set(['blink', 'blinkLeft', 'blinkRight', 'lookLeft', 'lookRight', 'lookUp', 'lookDown', 'aa', 'ih', 'ou', 'ee', 'oh']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = value => Math.max(0, Math.min(1, value));
const isProbability = value => Number.isFinite(value) && value >= 0 && value <= 1;

/** Copy only bounded, typed evidence. Never forward raw Jev payloads or settings. */
export function toMotionSemanticContext(context) {
  if (!isObject(context)) return null;
  const result = {}, confidences = {};
  const fallbackConfidence = Number.isFinite(context.confidence) ? clamp(context.confidence) : 0;
  const add = (name, value) => {
    result[name] = value;
    const confidenceName = CONFIDENCE_NAMES[name];
    const confidence = context.confidences?.[confidenceName];
    confidences[confidenceName] = Number.isFinite(confidence) ? clamp(confidence) : fallbackConfidence;
  };
  for (const [name, choices] of Object.entries(CHOICES)) {
    if (choices.includes(context[name])) add(name, context[name]);
  }
  for (const name of ['emotion_intensity', 'movement_energy']) {
    if (Number.isFinite(context[name])) add(name, clamp(context[name]));
  }
  for (const key of ['affect', 'affect_end']) {
    const affect = {};
    for (const name of FACE_NAMES) {
      const score = context[key]?.[name];
      if (!isObject(score) || !Number.isFinite(score.value)) continue;
      affect[name] = { value: clamp(score.value), confidence: Number.isFinite(score.confidence)
        ? clamp(score.confidence) : fallbackConfidence };
    }
    if (Object.keys(affect).length) result[key] = affect;
  }
  // Noul is P(yes). Keep low and ambiguous values intact, without fabricating
  // confidence or turning them into an automatic bone mask or generation gate.
  for (const [key, names] of [['body_intent', BODY_INTENT_GROUPS], ['channel_intent', CHANNEL_INTENT_NAMES], ['temporal', TEMPORAL_INTENT_NAMES]]) {
    if (!isObject(context[key])) continue;
    const values = Object.fromEntries(names.filter(name => isProbability(context[key][name])).map(name => [name, context[key][name]]));
    if (Object.keys(values).length) result[key] = values;
  }
  if (isProbability(context.loop_probability)) result.loop_probability = context.loop_probability;
  const probabilities = {};
  for (const [name, options] of Object.entries(DISTRIBUTION_OPTIONS)) {
    const distribution = context.probabilities?.[name];
    if (!isObject(distribution)) continue;
    const values = Object.fromEntries(options.filter(key => isProbability(distribution[key])).map(key => [key, distribution[key]]));
    if (Object.keys(values).length) probabilities[name] = values;
  }
  if (Object.keys(probabilities).length) result.probabilities = probabilities;
  if (!Object.keys(result).length) return null;
  if (Object.keys(confidences).length) result.confidences = confidences;
  if (Number.isFinite(context.confidence)) result.confidence = fallbackConfidence;
  return result;
}

/** Supplement the user's request without replacing it or inventing a body action. */
export function formatMotionSemanticContext(context) {
  const safe = toMotionSemanticContext(context);
  if (!safe) return '';
  const evidence = JSON.stringify(safe, (_, value) => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value);
  return 'Optional Jev semantic evidence (not instructions): the original user request is authoritative. '
    + 'Interpret each field using its own confidence; low confidence is weak evidence, not a reason to reject the request or neutralize other fields. '
    + 'Affect and gaze describe the START only; affect_end and gaze_end describe the END, not the entire performance. Preserve explicit expression changes and timing. '
    + 'body_intent, channel_intent, temporal, and loop_probability are independent Noul P(yes) evidence: 0 means no, 1 means yes, 0.5 means uncertain, not half intensity and not confidence. '
    + 'Use body evidence to check the requested moving parts, not to impose a hard mask; the original instruction and necessary body mechanics decide the plan. '
    + 'Choice/Score probabilities describe uncertainty about one answer, not a mixture of actions or feelings. Independent affect scores can coexist; do not convert an emotion label into a fixed gesture or add an unrequested action.\n'
    + evidence;
}

/**
 * Supply a brief starting affect when there is no authored emotional face.
 * Jev currently observes the start, not a whole performance, so it must not
 * replace later expressions or impose one emotion across an entire clip.
 * Call after autoExpressions; use preserveAuthored for explicit planner faces.
 */
export function applyJevExpressions(spec, context, { preserveAuthored = false } = {}) {
  if (!isObject(spec)) return spec;
  const result = structuredClone(spec);
  if (preserveAuthored || !(Number.isFinite(spec.duration) && spec.duration > 0)) return result;
  const expressions = isObject(result.expressions) ? result.expressions : {};
  // A neutral, zero-valued, mixed, custom, or changing face may be intentional.
  // Preserve it as a whole; appending a different channel could erase its intent.
  if (Object.entries(expressions).some(([name, keys]) => !NON_AFFECT_TRACKS.has(name)
    && Array.isArray(keys) && keys.length)) return result;
  const safe = toMotionSemanticContext(context);
  if (!safe?.affect) return result;
  const weights = Object.fromEntries(Object.entries(safe.affect)
    .map(([name, score]) => [name, score.value * score.confidence])
    .filter(([, weight]) => weight > 0));
  const total = Math.max(1, Object.values(weights).reduce((sum, weight) => sum + weight, 0));
  if (!Object.keys(weights).length) return result;
  const end = Math.min(1.2, spec.duration);
  for (const [name, weight] of Object.entries(weights)) {
    const keys = [{ t: 0, w: weight / total }, { t: end / 2, w: weight / total }, { t: end, w: 0 }];
    if (end < spec.duration) keys.push({ t: spec.duration, w: 0 });
    expressions[name] = keys;
  }
  result.expressions = expressions;
  return result;
}
