// Preserve ambiguity as evidence, not as a forced neutral pose.
export const FACE_NAMES = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
const emotionFace = { joy: 'happy', excitement: 'happy', affection: 'relaxed',
  sadness: 'sad', fear: 'sad', anger: 'angry', disgust: 'angry', surprise: 'surprised' };
const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function reactionTargets(context) {
  if (!context) return {};
  const result = {};
  for (const name of FACE_NAMES) {
    const score = context.affect?.[name];
    if (score && Number.isFinite(score.value)) {
      result[name] = clamp(score.value) * (0.2 + 0.8 * clamp(score.confidence));
    }
  }
  if (!Object.keys(result).length) {
    // A Choice distribution is uncertainty about alternatives, not mixed feelings.
    const name = emotionFace[context.emotion];
    if (name) result[name] = clamp(context.emotion_intensity ?? 0.4)
      * (0.2 + 0.8 * clamp(context.confidences?.emotion ?? context.confidence));
  }
  const total = Math.max(1, Object.values(result).reduce((a, b) => a + b, 0));
  for (const name of Object.keys(result)) result[name] /= total;
  if (['forward', 'left', 'right', 'down', 'up'].includes(context.gaze) && context.confidences?.gaze >= 0.55) {
    for (const direction of ['Left', 'Right', 'Down', 'Up']) result['look' + direction] =
      direction.toLowerCase() === context.gaze ? 0.5 : 0;
  }
  return result;
}

// Only an explicit, well-supported face-only instruction skips body planning.
export function isFaceOnlyUpdate(context) {
  return context?.update_scope === 'face_only' && (context.confidences?.update_scope ?? 0) >= 0.75;
}

export function smoothWeight(current, target, dt, seconds = 0.18) {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / seconds));
}

// Confidence controls how much a live hint may replace authored animation.
// Dimming a target alone is not sufficient: an uncertain zero would still
// replace a confident authored smile with a completely neutral expression.
export function createReaction(context, { persistent = false, preview = false } = {}, previous) {
  const targets = reactionTargets(context);
  if (!Object.keys(targets).length) return null;
  const strengths = {};
  for (const name of Object.keys(targets)) {
    const confidence = name.startsWith('look') ? context.confidences?.gaze
      : context.affect?.[name]?.confidence ?? context.confidences?.emotion ?? context.confidence;
    strengths[name] = clamp(confidence) * (preview ? 0.6 : 1);
  }
  return { targets, strengths, weights: { ...previous?.weights }, influences: { ...previous?.influences },
    remaining: persistent || preview ? Infinity : 1.5 };
}

// Evaluate every previously touched channel as well as the new targets, so a
// gaze or emotion omitted by a later hint fades back to its animation value.
export function advanceReaction(reaction, base, dt) {
  reaction.remaining -= Math.max(0, dt);
  const values = {}, channels = new Set([...Object.keys(reaction.targets), ...Object.keys(reaction.influences)]);
  let active = false, changesFace = false;
  for (const name of channels) {
    if (!Object.hasOwn(base, name)) continue; // Unsupported VRM expression.
    const targetStrength = reaction.remaining > 0 ? reaction.strengths[name] ?? 0 : 0;
    const strength = reaction.influences[name] = smoothWeight(reaction.influences[name] ?? 0, targetStrength, dt);
    const target = Object.hasOwn(reaction.targets, name) ? reaction.targets[name] : reaction.weights[name] ?? base[name];
    const weight = reaction.weights[name] = smoothWeight(reaction.weights[name] ?? base[name], target, dt);
    values[name] = clamp(base[name] + (weight - base[name]) * strength);
    if (strength > 0.001 || targetStrength > 0) {
      active = true;
      changesFace ||= FACE_NAMES.includes(name);
    } else if (!(name in reaction.targets)) {
      delete reaction.weights[name];
      delete reaction.influences[name];
    }
  }
  if (changesFace) {
    // Include the underlying channels in the budget: adding a happy hint to a
    // sad animation must not overdrive both blend shapes at once.
    const names = FACE_NAMES.filter(name => Object.hasOwn(base, name));
    const total = Math.max(1, names.reduce((sum, name) => sum + (values[name] ?? clamp(base[name])), 0));
    for (const name of names) values[name] = (values[name] ?? clamp(base[name])) / total;
  }
  for (const names of [['lookLeft', 'lookRight'], ['lookUp', 'lookDown']]) {
    if (!names.some(name => Object.hasOwn(values, name))) continue;
    const supported = names.filter(name => Object.hasOwn(base, name));
    const total = Math.max(1, supported.reduce((sum, name) => sum + (values[name] ?? clamp(base[name])), 0));
    for (const name of supported) values[name] = (values[name] ?? clamp(base[name])) / total;
  }
  return { values, active };
}

export function boundedState(state) {
  if (!state || typeof state !== 'object') return undefined;
  const result = {};
  for (const name of ['actor_role', 'previous_instruction', 'current_action', 'input_kind']) {
    if (typeof state[name] === 'string') result[name] = state[name].slice(0, 1200);
  }
  for (const name of ['posture', 'expressions', 'playback']) {
    const source = state[name];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    result[name] = Object.fromEntries(Object.entries(source).slice(0, 24).filter(([key, value]) =>
      key.length < 64 && (Number.isFinite(value) || typeof value === 'boolean'
      || (Array.isArray(value) && value.length <= 4 && value.every(Number.isFinite)))));
  }
  return result;
}
