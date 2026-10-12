# Motion naturalness investigation

## Findings and changes

1. **Every authored action boundary inserted a stop.** `blend_action_start`
   blended from a static last pose, and its first output duplicated the last
   history frame. It now extrapolates the last two frames' local angular and
   root velocity through the short fade into the new inference. Rotation is
   handled with relative rotations, not component-wise Euler interpolation.
   Already generated frames are unchanged, as are samples after the fade.
   A stationary or one-frame history still introduces no invented velocity.

2. **Body permissions can make ordinary gestures rigid.** Unselected groups
   are physically frozen, not merely excluded from the text description.
   The streamed planner now explicitly permits supporting torso/pelvis/legs
   for balance unless the user requests isolation, stillness or fixed contact.
   Hard constraints in the engine remain enforced. This change requires Codex
   planning; ARDY-only generation does not use these planner permissions.

3. **Native generation also contains fast wrist rotation.** It is already
   present in saved specifications before browser playback. Increasing steps
   from 8 to 16 did not consistently resolve it in the matched wave samples.
   Moving wrist twist into the forearm merely moved the rapid rotation to
   another joint, so that experimental retargeting was not shipped. Extending
   recurrent history reduced motion but could stop the wave; that experiment
   was not shipped either. Neither remaining issue is claimed resolved.

## Evidence

`tools/ardy-naturalness-eval.py` loads the local native model directly and resets
its seed to 42 per case. No external API is used. It writes samples to
`release/naturalness-before/` (including both transition variants). The legacy
transition is reproduced by giving the velocity-aware blend a one-frame
history; its velocity is zero, matching the old static-anchor blend.

At the 2-second walking-to-waving boundary:

| Measurement | Previous frame | Old first frame | New first frame |
| --- | ---: | ---: | ---: |
| Root speed (m/s) | 1.277 | 0 | 1.279 |
| Pelvis angular speed (degrees/s) | 48.40 | 0 | 48.18 |
| Right upper leg angular speed (degrees/s) | 82.08 | ~0 | 82.29 |

`tools/transition-continuity-audit.mjs` produces the numerical report.
`tools/ardy-live-session-render.mjs naturalness-before` renders the saved
specifications on the actual VRM for inspection.

Real Astra plans in `release/naturalness-planner/results.json` allowed
root/torso/rightArm/both legs for an ordinary happy greeting, while the explicit
right-arm-only request allowed only rightArm. These are two samples, not a
guarantee of planner compliance for every prompt.

Validation: 11 motion-scope tests (including constant-velocity transition and
single-frame history), 34 session tests, 266 JavaScript tests, and Vite build.
The local engine on port 2337 was restarted with the same Mini configuration.

This fixes demonstrated implementation problems. It does not establish that
all generated motion is natural, eliminate native wrist noise, or guarantee
long-sequence semantic fidelity.
