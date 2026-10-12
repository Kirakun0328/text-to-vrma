import { toMotionSemanticContext } from './jevMotionContext.js';

// Only designer-delegated channels may use Jev; no action selection or retiming.
export function enrichJevSegment(source, context, offset, total) {
  const segment = structuredClone(source), fields = [];
  const safe = toMotionSemanticContext(context), permissions = source.jev ?? 0;
  if (!safe || !permissions) return { segment, fields };
  const fraction = at => Math.max(0, Math.min(1, (offset + at * segment.duration) / total));
  if (permissions & 1) {
    const names = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
    for (const key of segment.face) {
      const p = fraction(key.at);
      // Preserve neutral moments and authored emotion timing. Refine existing
      // strengths rather than inventing expressions or replacing the curve.
      for (const name of names) {
        if (!key[name]) continue;
        const influence = (score, weight) => score ? weight * score.confidence * (score.value - key[name]) : 0;
        const adjustment = influence(safe.affect?.[name], 1 - p) + influence(safe.affect_end?.[name], p);
        if (adjustment) { key[name] = Math.max(0, Math.min(1, key[name] + .3 * adjustment)); fields.push('face'); }
      }
      const sum = Math.max(1, names.reduce((value, name) => value + key[name], 0));
      for (const name of names) key[name] /= sum;
    }
  }
  if ((permissions & 2) && !segment.gaze?.length) {
    const axes = { forward: [0, 0], left: [0, 18], right: [0, -18], up: [-12, 0], down: [12, 0] };
    const start = axes[safe.gaze], end = axes[safe.gaze_end];
    if ((start && safe.confidences?.gaze > 0) || (end && safe.confidences?.gaze_end > 0)) {
      segment.gaze = [0, 1].map(at => {
        const p = fraction(at);
        return [at, ...[0, 1].map(axis => (start?.[axis] ?? 0) * (safe.confidences?.gaze ?? 0) * (1 - p)
          + (end?.[axis] ?? 0) * (safe.confidences?.gaze_end ?? 0) * p)];
      });
      fields.push('gaze');
    }
  }
  if ((permissions & 4) && segment.body?.length) {
    const style = {}, confidences = {};
    for (const [name, confidence] of [['tempo', 'tempo'], ['movement_scale', 'scale'], ['movement_energy', 'energy']]) {
      // Tempo describes START. Do not repeat that evidence in a later action
      // when the independent temporal judgment indicates a change of motion.
      if (name === 'tempo' && offset > 0 && (safe.temporal?.body_changes ?? 0) > .5) continue;
      if (safe[name] !== undefined && (safe.confidences?.[confidence] ?? 0) > 0) {
        style[name] = safe[name]; confidences[confidence] = safe.confidences[confidence];
      }
    }
    if (Object.keys(style).length) { segment.jevContext = { ...style, confidences }; fields.push('body_style'); }
  }
  return { segment, fields: [...new Set(fields)] };
}
