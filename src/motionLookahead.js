// Budget for inference, transport and VRMA presentation; never alter sampling quality.
export function motionLookaheadSeconds(horizon, latencyMs) {
  const baseline = Math.max(.6, horizon * .75);
  return Math.min(Math.max(baseline, 3), Math.max(baseline, latencyMs / 1000 * 1.25 + .15));
}

export function updateMotionLatency(previous, elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return previous;
  // React immediately to slow chunks, decay gradually when throughput recovers.
  return Math.max(elapsed, previous * .8);
}
