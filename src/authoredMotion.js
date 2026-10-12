import { Euler, MathUtils, Quaternion } from 'three';

const BLEND_SECONDS = .15;
const SAMPLE_STEP = .05;
const ZERO = [0, 0, 0];
const quaternion = (r, order) => new Quaternion().setFromEuler(new Euler(
  ...r.map(MathUtils.degToRad), order));
const angles = (q, order) => {
  const euler = new Euler().setFromQuaternion(q, order);
  return [euler.x, euler.y, order === 'YXZ' ? 0 : euler.z].map(MathUtils.radToDeg);
};
const mix = (a, b, weight, order) => weight <= 0 ? [...a] : weight >= 1 ? [...b]
  : angles(quaternion(a, order).slerp(quaternion(b, order), weight), order);

function sample(keys, time, order) {
  if (!keys?.length) return [...ZERO];
  const left = keys.findLast(key => key.t <= time), right = keys.find(key => key.t > time);
  if (!left) return [...keys[0].r];
  if (!right || left.t === time) return [...left.r];
  if (left.r.every((value, index) => value === right.r[index])) return [...left.r];
  return mix(left.r, right.r, (time - left.t) / (right.t - left.t), order);
}

function curve(rows, start, duration, dimensions) {
  if (rows == null || (Array.isArray(rows) && !rows.length)) return [];
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8 || rows.some((row, index) =>
    !Array.isArray(row) || row.length !== dimensions || row.some(value => !Number.isFinite(value))
    || row[0] < 0 || row[0] > 1 || (index > 0 && row[0] <= rows[index - 1][0]))
    || rows[0][0] !== 0 || rows.at(-1)[0] !== 1) throw new Error('頭部・視線の設計が不正です');
  return rows.map(row => ({ t: Number((start + row[0] * duration).toFixed(8)), r: dimensions === 3 ? [...row.slice(1), 0] : row.slice(1) }));
}

/** Rebuild the immutable known prefix at origin, retaining already played instructions. */
export function syncAuthoredMotion(previous, planned, origin = 0) {
  if (!Number.isFinite(origin) || origin < 0 || !Array.isArray(planned)) throw new Error('演技の開始時刻・区間が不正です');
  const intervals = (previous?.intervals ?? []).filter(interval => interval.start < origin).map(interval => {
    const next = structuredClone(interval);
    if (next.end > origin) {
      next.end = origin;
      // Keep original control points and blend end under this shortened active
      // interval. Rebaking a cutoff gaze quaternion into zero-roll Euler keys
      // would slightly change interpolation in the already played prefix.
    }
    return next;
  });
  let start = origin;
  for (const segment of planned) {
    if (!Number.isFinite(segment?.duration) || segment.duration <= 0) throw new Error('演技区間の長さが不正です');
    const end = Number((start + segment.duration).toFixed(8));
    const head = curve(segment.head, start, segment.duration, 4);
    const preceding = intervals.at(-1);
    // The generated head does not inherit our display-only authored pose.
    // Release ownership over a short future transition when ARDY takes over.
    const handoff = !head.length && Array.isArray(segment.body) && segment.body.includes('head')
      && Boolean(preceding?.head.length) && Math.abs(preceding.end - start) < 1e-8;
    intervals.push({ start, end, blendEnd: Math.min(end, Number((start + BLEND_SECONDS).toFixed(8))),
      head, handoff,
      gaze: curve(segment.gaze, start, segment.duration, 3) });
    start = end;
  }
  return { intervals };
}

/** Apply only to a display/export copy; raw ARDY motion and session history stay untouched. */
export function applyAuthoredMotion(spec, authored) {
  const output = structuredClone(spec), intervals = authored?.intervals ?? [];
  if (!intervals.length || !(spec.duration >= 0)) return output;
  const end = spec.duration;
  const baseHead = spec.tracks?.head ?? [], baseGaze = spec.lookAt ?? [];
  const evaluate = (time, kind, limit = intervals.length - 1) => {
    const order = kind === 'head' ? 'XYZ' : 'YXZ';
    const base = at => sample(kind === 'head' ? baseHead : baseGaze, at, order);
    let index = limit;
    // At a shared boundary retain the previous interval's exact endpoint.
    while (index >= 0 && !(time > intervals[index].start || (time === 0 && intervals[index].start === 0))) index--;
    if (index < 0) return base(time);
    const interval = intervals[index];
    if (time > interval.end) return kind === 'gaze'
      ? evaluate(interval.end, kind, index) : base(time);
    const keys = interval[kind];
    if (kind === 'head' && !keys.length && !interval.handoff) return base(time);
    const target = keys.length ? sample(keys, time, order) : kind === 'head' ? base(time) : [...ZERO];
    if (time >= interval.blendEnd) return target;
    const previous = evaluate(interval.start, kind, index - 1);
    const amount = Math.max(0, Math.min(1, (time - interval.start) / (interval.blendEnd - interval.start)));
    return mix(previous, target, amount * amount * (3 - 2 * amount), order);
  };

  const times = (kind, base) => {
    const result = new Set(base.filter(key => key.t >= 0 && key.t <= end).map(key => key.t));
    result.add(0);
    result.add(end);
    for (const interval of intervals) {
      if (interval.start > end || (kind === 'head' && !interval.head.length && !interval.handoff)) continue;
      const until = kind === 'head' && !interval.head.length ? Math.min(interval.end, interval.blendEnd) : interval.end;
      for (const t of [interval.start, interval.blendEnd, until, ...interval[kind].map(key => key.t)]) {
        if (t >= 0 && t <= Math.min(end, until)) result.add(t);
      }
      // Resample authored interpolation and transition easing at the body rate.
      // Anchoring to absolute time preserves sampled prefixes across appends.
      for (let frame = Math.ceil(interval.start / SAMPLE_STEP); frame * SAMPLE_STEP < Math.min(end, until); frame++) {
        result.add(Math.round(frame * SAMPLE_STEP * 1e8) / 1e8);
      }
    }
    return [...result].sort((a, b) => a - b);
  };

  if (intervals.some(interval => interval.head.length && interval.start <= end)) {
    output.tracks ??= {};
    output.tracks.head = times('head', baseHead).map(t => ({ t, r: evaluate(t, 'head') }));
  }
  // Empty gaze is an authored release to forward, rather than absence of a
  // track. This prevents a previous instruction's eye direction from sticking.
  output.lookAt = times('gaze', baseGaze).map(t => ({ t, r: evaluate(t, 'gaze') }));
  return output;
}
