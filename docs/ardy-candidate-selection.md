# ARDY candidate comparison

The ARDY UI offers one candidate (default) or three candidates. Three-candidate mode reuses one motion plan and changes the ARDY random seed for each generation. It makes no additional planner/reviewer AI requests. Automatic AI correction remains separately opt-in.

Candidates are measured on the loaded VRM through the same animation playback path used by the preview. Measurement skips contact-sheet rendering and restores playback and camera state. Candidate selection uses estimated contact sliding plus twice the ankle sinking distance. All candidates use the same scoring metric. When estimated contact is unavailable for any candidate, selection uses low-foot horizontal motion as a **kinematic reference**, clearly labeled separately from ground contact.

The original candidate is retained for unknown metrics, differences smaller than 0.005 in the combined score, changed duration, regressed physical metrics, or a reduction of more than 45% in a tracked body's travel distance (when original travel exceeded 5 cm). These thresholds are conservative heuristics, not proof of semantic fidelity, balance, or natural acting. The comparison dialog lets the user preview and explicitly adopt any generated candidate. Exports follow the adopted candidate. Later generation failures preserve already measured candidates.

Seeds and measurements are retained in the candidate report. `candidateInfo` on each motion records its index, seed, and candidate count. Candidate reports are in memory until the next generation; adopted motions are saved in history.

## Verification

- `npm test`: selection, motion-collapse rejection, metric regression, missing contact, duration differences, distinct seeds, partial failure preservation.
- `node tools/review-candidates-live.mjs`: real local ARDY, no planner AI, three 4-second waving motions, avatar measurement and manual adoption. Observed approximately 4.7 seconds for generation/measurement/adoption on the configured machine. This excludes AI planning and is not a general latency guarantee.
- The live greeting example had no confirmed rest-height contact; the UI correctly showed a separate low-foot-motion reference. The improvement was below the selection threshold, so the original remained the automatic choice.
- `node tools/settings-layout-smoke.mjs`: compact settings, collapsed correction options, four languages.

This increment does not yet add end-effector constraints, avatar IK correction, or semantic candidate scoring. Those require separate coordinate/retargeting and motion-quality validation.
