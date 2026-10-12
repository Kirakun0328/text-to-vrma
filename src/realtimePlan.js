import { toMotionSemanticContext } from './jevMotionContext.js';

const PROMPT = `You are the acting director for a live humanoid avatar, not a translator. Return only JSON with continuous, segments, expression and face.
Translate the user's situation into concise concrete English motion descriptions starting with "A person".
Preserve every requested action, side, count, order, posture, target and prohibition. Do not add unrequested main actions or weaken intense actions.
Use one continuous segment for connected motion; split only when the requested action changes. Preserve the requested ending; do not invent a stop or reset to idle between segments.
Derive the entire performance from the current request. The user can request any motion, including unusual or combined movements; there is no action catalog. Do not replace unfamiliar requests with familiar gestures. Choose unspecified details only to realize the requested action, never to add an unrelated action, mood, body part emphasis or final pose.
Express the essential visible movement concisely: which body parts move, direction, rhythm, timing, contact and travel where relevant. Give enough detail to distinguish the requested motion without padding it with anatomy or incidental movement. Add anticipation, recovery or movement in other body parts only when needed for this particular request. Do not impose a fixed word count or a standard choreography on short requests.
For repetitive requests, maintain the cycle throughout the requested duration; do not spend it preparing, standing, easing out or stopping unless explicitly requested. For discrete actions, include their defining contact or landing rather than unrelated recovery. In-place constrains travel, not movement of the limbs. Use concise language aimed at motion generation rather than a long biomechanics explanation.
continuous is true only for an ongoing repeated/locomotor action that should remain active throughout, with no requested finite count or ending. It is false for a single action, still posture, a sequence with changing actions, a finite repetition count, or an explicit final pose/stop. Infer this from the actual user intent, not a fixed list of verbs. This controls generative history, not looping or prerecorded animation.
When emotion is requested, express it through the timing and intensity of the requested movement and the face. Infer it from this request, not a prescribed emotion-to-gesture mapping. Preserve simultaneous emotions and changes over time without adding unrelated bodily actions.
Preserve the user's requested starting posture, fixed limbs and final pose. State is supplied only for an explicit edit of an existing performance. Use it to resolve references; the latest request controls what changes. Without state, design a new independent performance. Maintain balance and contact where compatible with the requested motion, without restricting all motion to standing, grounded, gentle or symmetric gestures.
When autoDuration is false or absent, durations must total the requested seconds. When autoDuration is true, choose a natural length for the requested actions: generally 2-4 seconds for a single simple action, enough time for explicit counts and transitions (up to 30 seconds), and the given duration for ongoing continuous motion. Never stretch a single short gesture to fill an unrelated default duration. Keep connected gestures together, split only materially different actions; do not split the body merely to change the face. Each segment lasts at least 2 seconds because ARDY generates in 2-second blocks.
Expression: happy, sad, angry, surprised, relaxed or neutral. It is a fallback only.
face is 2-8 compact rows [at,happy,sad,angry,surprised,relaxed], exactly six numbers each. at is relative time in [0,1]; expression weights are in [0,1], total at most 1 per row. Include at=0 and at=1 with strictly increasing at. These weights directly animate the face: align onset, peak and recovery with the body, including emotional transitions and subtle mixtures. Zero weights mean neutral; do not invent emotion for a purely physical request. Use only availableExpressions when supplied; convey unsupported emotion through the body instead. Do not encode blink in face.
Jev hints are optional uncertain context; explicit user instructions take priority. Use each field's own confidence; a low overall confidence must not invalidate confident fields. Independent affect scores may coexist and describe only the START, not later changes. Make reasonable acting choices for unspecified details without asking questions. Silently check requested sides, counts, sequence, contact, ending and face/body timing before returning. No explanations, reviews, checks or tool calls.`;

// Only complete top-level JSON fields can start inference. No repairs of partial JSON.
export function completedPlanFields(text) {
  const fields = {};
  let i = 0;
  const skip = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  skip();
  if (text[i++] !== '{') return fields;
  while (i < text.length) {
    skip();
    if (text[i] !== '"') return fields;
    const start = i++;
    let escaped = false;
    for (; i < text.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (text[i] === '\\') { escaped = true; continue; }
      if (text[i] === '"') break;
    }
    if (i >= text.length) return fields;
    const key = JSON.parse(text.slice(start, ++i));
    skip();
    if (text[i++] !== ':') return fields;
    skip();
    const valueStart = i;
    let depth = 0, quoted = false;
    escaped = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else {
        if (c === '"') quoted = true;
        else if ((c === ',' || c === '}') && depth === 0) break;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
      }
    }
    if (i === text.length || quoted || depth !== 0) return fields;
    if (Object.hasOwn(fields, key)) throw new Error('Codexの計画に重複した項目があります');
    Object.defineProperty(fields, key, { value: JSON.parse(text.slice(valueStart, i)), enumerable: true });
    if (text[i++] === '}') return fields;
  }
  return fields;
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 12 || segments.some(s =>
    typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000 || !Number.isFinite(s.duration) || s.duration <= 0 || s.duration > 120)) {
    throw new Error('Codexの動作計画が不正です');
  }
}

export async function planRealtimeMotion(text, { request, model, duration, autoDuration, motionContext, state, signal, availableExpressions, onBodyPlan, effort = 'low' }) {
  signal?.throwIfAborted();
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('動作計画の推論設定が不正です');
  let streamed = '', emitted = null;
  // Jev's reaction label is a closed classification, not a body-motion vocabulary.
  const semanticContext = toMotionSemanticContext(motionContext);
  const output = await request({ model, outputType: 'realtime', effort, messages: [
    { role: 'system', content: PROMPT },
    { role: 'user', content: JSON.stringify({ text, duration, autoDuration, state,
      jev: semanticContext || undefined, availableExpressions }) },
  ] }, { signal, onDelta: delta => {
    signal?.throwIfAborted();
    if (typeof delta !== 'string' || (streamed += delta).length > 200000) throw new Error('Codexの計画が大きすぎます');
    if (!onBodyPlan || emitted) return;
    const fields = completedPlanFields(streamed);
    if (fields.segments && typeof fields.continuous === 'boolean') {
      validateSegments(fields.segments);
      emitted = JSON.stringify({ continuous: fields.continuous, segments: fields.segments });
      onBodyPlan({ continuous: fields.continuous, segments: fields.segments });
    }
  } });
  signal?.throwIfAborted();
  const result = JSON.parse(output);
  validateSegments(result.segments);
  if (result.continuous !== undefined && typeof result.continuous !== 'boolean') throw new Error('Codexの継続動作の指定が不正です');
  if (emitted && emitted !== JSON.stringify({ continuous: result.continuous, segments: result.segments })) throw new Error('Codexの途中計画と完成計画が一致しません');
  if (!['happy','sad','angry','surprised','relaxed','neutral'].includes(result.expression)) result.expression = 'neutral';
  if (result.face !== undefined) {
    const names = ['happy','sad','angry','surprised','relaxed'];
    if (Array.isArray(result.face)) result.face = result.face.map(key => {
      if (!Array.isArray(key)) return key; // Accept earlier object-form plans too.
      if (key.length !== 6) throw new Error('Codexの表情タイミングが不正です');
      return Object.fromEntries(['at', ...names].map((name, i) => [name, key[i]]));
    });
    if (!Array.isArray(result.face) || result.face.length < 2 || result.face.length > 8 || result.face.some((key, i) =>
      !key || !Number.isFinite(key.at) || key.at < 0 || key.at > 1 || (i > 0 && key.at <= result.face[i-1].at)
      || names.some(name => !Number.isFinite(key[name]) || key[name] < 0 || key[name] > 1))
      || result.face[0].at !== 0 || result.face.at(-1).at !== 1) throw new Error('Codexの表情タイミングが不正です');
    result.face = result.face.map(key => {
      const supported = name => !Array.isArray(availableExpressions) || availableExpressions.includes(name);
      const total = Math.max(1, names.reduce((sum, name) => sum + (supported(name) ? key[name] : 0), 0));
      return { at: key.at, ...Object.fromEntries(names.map(name => [name, supported(name) ? key[name] / total : 0])) };
    });
  }
  return result;
}

export function plannedFaceTracks(face, duration) {
  return Object.fromEntries(['happy','sad','angry','surprised','relaxed'].map(name =>
    [name, face.map(key => ({ t: key.at * duration, w: key[name] }))]));
}

const STREAM_PROMPT = `Design one original humanoid performance directly from the current request. Resolve only ambiguities that affect execution; do not explore alternative choreographies or rehearse the schema. Return only JSON with keys in order: continuous, duration, segments. Each segment's keys are text, duration, continuous, body, rootAxes, jev, turn, head, gaze, face. Completed segments execute immediately; commit every channel and timing before emitting each segment and never revise earlier segments.
Interpret the complete physical intention before emitting the first segment: distinguish simultaneous actions from sequential ones, identify support/contact and what stays true during later actions, and resolve references such as "the other foot" or "the foot that turned" consistently. Choose unspecified sides once and keep them consistent. Do not convert each verb into an unrelated clip. Each caption must describe a coherent physical phase, including the maintained posture and support of that phase. A body's final pose is not guaranteed merely because it appeared in the previous caption: keep the relevant body channels enabled when they must achieve or maintain a requested target posture, unless the user explicitly asks to freeze the ACTUAL pose.
Carry established support into later upper-body actions. If the feet have just been planted in a braced stance and only the arms/torso are to move next, keep the pelvis and legs fixed by excluding root/leftLeg/rightLeg from that later segment. Straightening the UPPER BODY is torso motion, not permission to bring the feet together or reset the lower body to standing. Conversely, do not lock a limb while it still needs to move to the requested target. Preserve the difference between achieving a target pose and retaining established support.
Preserve requested actions, sides, counts, order, simultaneous movement, targets, posture, fixed limbs, contact, travel limits, prohibitions, intensity and ending. There is no action catalog: realize unfamiliar movements rather than replacing them. Add only mechanics needed for the requested action, including balance, support, anticipation or recovery when necessary. Do not impose standing, grounded, gentle or symmetric motion. In-place limits travel, not limb movement. Emotion, dialogue, smiling or looking do not authorize unrelated gestures, nods, bows, head tilts or final poses.
text goes only to ARDY: a concise present-tense caption beginning "A person" centered on the requested primary action, with only essential requested constraints. Describe the visible physical movement and its direction, not merely an ambiguous action name or social meaning. Include the defining body movement or contact needed to distinguish that action, but no incidental limb mechanics, secondary actions, or generic naturalness/balance instructions. Those extra verbs compete with the primary action. Allow necessary supporting groups in body without narrating their conventional movement in text. Keep explicit simultaneous actions, sides, counts, initial posture, travel limits and ending; brevity must never remove a requested condition. Exclude facial expressions, eye direction, dialogue, relationships, offscreen events and bare emotion labels. Express requested movement style through physical speed, range and rhythm. For body=0 describe the maintained physical posture only.
Timing: 1-12 segments, each >=0.4 seconds; all durations are multiples of 0.2 seconds and sum exactly to the declared total of 2-30 seconds. With autoDuration:false or absent, total equals requested duration. With true, choose a natural duration that accommodates all actions/counts; retain supplied duration for ongoing motion. Split only at meaningful action changes, never merely for a timer or expression change. Prefer a natural first block of 2-4 seconds when such a boundary exists. Ongoing repetition remains active without invented idle, preparation or stopping. continuous is true only for ongoing repeated/locomotor movement without finite count or ending; apply this separately to the whole request and each segment. A changing action sequence is not globally continuous. It controls generative history, not looping.
Execution over time: ARDY receives only the CURRENT segment caption, repeatedly for each 2-second generation window. It cannot infer elapsed time, a future segment, or the overall story from that caption. Make each caption self-contained. Silently allocate time to the complete sequence and its ending before emitting the first segment. Do not pack successive main actions or a movement followed by a requested hold into one repeatedly applied caption. Separate sustained movement, its requested completion, and an explicit held posture at their meaningful boundaries. A repetition lasting until the next action is continuous:true within its own interval even though the overall sequence is finite; do not put a stop/landing/recovery instruction into every repeated window. Preserve exact counts when specified. Use body=0 for an explicitly requested hold AFTER the segment that reaches it, carrying the actual last pose instead of generating that action again. Do not invent holds or stretch a brief finite action across a long interval simply to fill time. Describe each new action's required starting and ending physical state consistently with its neighbors; never refer only to "the previous action" or "then". Allocate time within explicit user intervals without shifting later actions.
body is an integer sum of the groups requiring movement: root=1 (pelvis rotation+translation), torso=2, head=4 (neck+head), leftArm=8 (shoulder through fingers), rightArm=16, leftLeg=32, rightLeg=64. Add each needed group once; 0 holds all, 127 allows all. Unselected groups are HARD FROZEN in their previous local pose, initially anatomical standing rest with arms down; an unselected arm that is already lowered keeps hanging with gravity while the torso bends, and a caption requiring lowered arms lets the engine lower arms that are still raised. A frozen raised arm otherwise stays raised: enable an arm whenever it must reach any other new target. Do not freeze a group merely because the user did not name it. Allow the natural supporting torso, pelvis and legs needed for balance and weight shift in ordinary gestures, greetings, bows and emotional acting. A named acting hand does not imply a rigid torso. Preserve explicit isolation, stillness, fixed limbs and contact constraints; these override natural support. Use rootAxes to prevent travel without freezing pelvis rotation. These are channel permissions, not an action catalog or Jev probability thresholds.
rootAxes is an integer sum of permitted world translation axes: X=1, verticalY=2, Z=4. A missing axis is held at its segment-start coordinate; pelvis rotation and limbs remain free. In-place uses 2 so vertical motion remains available; unrestricted or uncertain travel uses 7. Only applies when body selects root. Preserve all requested travel constraints. Omit redundant in-place/no-travel wording from text when rootAxes enforces it: caption the action itself, preventing fixed location from being confused with still limbs.
turn: [] leaves heading/contact to the motion model. For an explicitly requested measurable turn, use [relativeYawDegrees,pivot], where positive yaw turns left, negative turns right; half a revolution is +/-180, one revolution +/-360. Resolve unspecified direction once. pivot=0 means no foot anchor, 1 anchors the LEFT foot, 2 anchors the RIGHT foot. A named axis/support foot must use the corresponding pivot; the other foot remains free. The turn progresses smoothly over that entire segment from its entry heading; root must be in body. A foot pivot requires rootAxes=7 so the pelvis can move around the planted foot, even for a turn on the spot. Do not spread one requested turn over multiple segments with the full angle in each. Do not invent turns for emotion or generic movement. Keep the new facing direction in later captions: a backward step is relative to the POST-TURN facing, not the camera. Finite turn segments use continuous:false. When arms must be spread during the turn, describe both together and keep both arms enabled; never rely on freezing a possibly incomplete prior pose.
jev is permission for optional parallel semantic refinement, whether or not evidence is already available: sum face=1, gaze=2, bodyStyle=4, or 0 for none. Select face only for emotional/social nuance with unspecified strength; existing emotion timing remains authoritative. Select gaze only if no gaze direction or timing is requested, and leave gaze:[] when delegating it. Select bodyStyle only when bodily expression is requested but tempo, range and energy are unspecified; never delegate explicit speed/range, precise counts/contact, or fixed poses. Pure physical instructions normally use 0. This never authorizes new actions, duration changes or bone ownership changes. Always produce a complete usable performance without waiting for Jev.
head: [] supplies no authored head curve; body ownership controls ARDY head motion. Otherwise rows [at,pitchDeg,yawDeg,rollDeg] specify absolute normalized local XYZ head-bone rotations. Positive pitch=down, yaw=character-left, roll=character-right; limits +/-60,+/-90,+/-45. Nonempty head requires omitting head from body. Use body head with head:[] for large motion involving neck/head.
gaze: [] means forward eyes; otherwise rows [at,pitchDeg,yawDeg] control eyes relative to the head. Positive pitch=down, yaw=character-left; limits +/-30,+/-45. Preserve requested changes/returns; add head rotation only when actually needed.
face: [] means neutral; otherwise rows [at,happy,sad,angry,surprised,relaxed], weights 0-1 with total <=1. Omit all trailing zero weights in each row; omitted weights are exactly zero, not inherited. Use only availableExpressions if supplied. No blink, invented emotion for physical requests, or substitute body gestures for unsupported expressions.
All nonempty curves have 2-8 rows, at increasing strictly from 0 to 1 within the segment. Coordinate channels and preserve adjacent-segment continuity. Emit only endpoints and knots needed for changes, holds or timing: constant curves need two identical endpoints; additional knots must preserve a meaningful feature. Do not add neutral lead-ins or recovery phases by default. Use at most 3 decimal places for at, 2 for weights and 1 for angles.
State resolves explicit edit references; latest instructions control changes. Without state, create an independent performance. Jev is optional uncertain evidence subordinate to the original request. Use each field's own confidence; low overall confidence does not negate confident fields. body_intent/channel_intent/temporal values are independent proposition probabilities, not motion weights or confidence. Choice distributions express uncertainty over alternatives, not mixed emotions. Independent affect/affect_end scores may encode simultaneous START/END emotions; derive intermediate timing from the request. Contradictory hints must not add or erase requested actions.
Keep successive requested physical actions as ordered segments unless explicitly simultaneous. Perception and preparation do not require a separate idle segment: coordinate their head/gaze timing within the relevant physical action unless the request specifies a pause or strict separation. A finite action must include its defining culmination/contact. Budget time for every later action before assigning time to ongoing motion. The complete result must preserve the requested order, counts, constraints and ending. Return no explanations, reviews or tool calls.`;

const FACE_NAMES = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
const INCOMPLETE_PLAN = Symbol('incomplete plan');
const streamPlanError = () => new Error('Codexの逐次動作計画が不正です');

export const BODY_GROUPS = ['root', 'torso', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

// These optional fields are also validated at the runtime boundary, where a
// custom planner can supply already-normalized face keys.
export function validateAuthoredChannels(segment) {
  if (segment.turn !== undefined && (!Array.isArray(segment.turn) || (segment.turn.length !== 0 && (segment.turn.length !== 2
    || !Number.isFinite(segment.turn[0]) || Math.abs(segment.turn[0]) > 720
    || !Number.isInteger(segment.turn[1]) || segment.turn[1] < 0 || segment.turn[1] > 2
    || !segment.body?.includes('root') || (segment.turn[1] && !segment.rootAxes?.every(Boolean)))))) throw streamPlanError();
  if (segment.jev !== undefined && (!Number.isInteger(segment.jev) || segment.jev < 0 || segment.jev > 7)) throw streamPlanError();
  if (segment.rootAxes !== undefined && (!Array.isArray(segment.body) || !Array.isArray(segment.rootAxes)
    || segment.rootAxes.length !== 3 || segment.rootAxes.some(value => typeof value !== 'boolean'))) throw streamPlanError();
  if (segment.body !== undefined && (!Array.isArray(segment.body)
    || new Set(segment.body).size !== segment.body.length
    || segment.body.some(group => !BODY_GROUPS.includes(group)))) throw streamPlanError();
  for (const [name, limits] of [['head', [60, 90, 45]], ['gaze', [30, 45]]]) {
    const rows = segment[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 8 || (rows.length && (rows.length < 2
      || rows.some((row, i) => !Array.isArray(row) || row.length !== limits.length + 1
        || !Number.isFinite(row[0]) || row[0] < 0 || row[0] > 1 || (i && row[0] <= rows[i - 1][0])
        || limits.some((limit, axis) => !Number.isFinite(row[axis + 1]) || Math.abs(row[axis + 1]) > limit))
      || rows[0][0] !== 0 || rows.at(-1)[0] !== 1))) throw streamPlanError();
  }
  if (segment.head?.length && segment.body?.includes('head')) throw streamPlanError();
  if (segment.lowerArms !== undefined && (!Array.isArray(segment.lowerArms) || !segment.lowerArms.length
    || new Set(segment.lowerArms).size !== segment.lowerArms.length
    || segment.lowerArms.some(group => !['leftArm', 'rightArm'].includes(group)))) throw streamPlanError();
}

// Scan complete values without repairing truncated JSON. Strings may contain
// braces, escaped quotes and property names; none of those become plan fields.
function jsonValueEnd(text, start) {
  const first = text[start];
  if (first === undefined) throw INCOMPLETE_PLAN;
  const containers = [], structured = first === '{' || first === '[';
  let quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        if (!structured) return i + 1;
      }
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') containers.push(char);
    else if (structured && (char === ']' || char === '}')) {
      if (containers.pop() !== (char === ']' ? '[' : '{')) throw streamPlanError();
      if (!containers.length) return i + 1;
    } else if (!structured && /[\s,}\]]/.test(char)) return i;
  }
  throw INCOMPLETE_PLAN;
}

function readStreamPlan(text) {
  const parsed = { header: null, segments: [], arrayComplete: false, complete: false };
  let offset = 0;
  const skip = () => { while (offset < text.length && /\s/.test(text[offset])) offset++; };
  const expect = expected => {
    skip();
    if (offset === text.length) throw INCOMPLETE_PLAN;
    if (text[offset++] !== expected) throw streamPlanError();
  };
  const value = () => {
    skip();
    const start = offset;
    offset = jsonValueEnd(text, start);
    return { value: JSON.parse(text.slice(start, offset)), source: text.slice(start, offset) };
  };
  const field = expected => {
    skip();
    if (offset === text.length) throw INCOMPLETE_PLAN;
    if (text[offset] !== '"' || value().value !== expected) throw streamPlanError();
    expect(':');
  };
  try {
    expect('{');
    field('continuous');
    const continuous = value().value;
    expect(',');
    field('duration');
    const duration = value().value;
    expect(',');
    field('segments');
    expect('[');
    parsed.header = { continuous, duration };
    skip();
    if (text[offset] !== ']') {
      while (true) {
        skip();
        if (offset === text.length) throw INCOMPLETE_PLAN;
        if (text[offset] !== '{') throw streamPlanError();
        const segment = value();
        // JSON.parse otherwise silently accepts duplicate keys in objects.
        completedPlanFields(segment.source);
        parsed.segments.push(segment.value);
        skip();
        if (offset === text.length) throw INCOMPLETE_PLAN;
        if (text[offset] === ']') break;
        expect(',');
      }
    }
    expect(']');
    parsed.arrayComplete = true;
    expect('}');
    skip();
    if (offset !== text.length) throw streamPlanError();
    parsed.complete = true;
  } catch (error) {
    if (error !== INCOMPLETE_PLAN) throw error;
  }
  return parsed;
}

function patchUnits(value, minimum) {
  const units = Math.round(value * 5);
  if (!Number.isFinite(value) || value < minimum || value > 30 || Math.abs(value * 5 - units) > 1e-8) {
    throw new Error('Codexの区間時間は0.2秒単位で、合計2〜30秒にする必要があります');
  }
  return units;
}

// A caption that requires the arms to END lowered cannot be satisfied while
// those arms are frozen in a raised pose: the previous segment may not have
// finished lowering, or ARDY may have raised them for balance in a squat.
// Evaluated plans then held the arms up for the final "arms down" pose.
// Enabling the arms unconditionally is worse when they are already down,
// because ARDY tends to raise them again (e.g. reaching forward in a squat).
// Only the engine knows the actual pose at the segment start, so the plan
// marks lowerArms and the engine enables just the arms that are still raised.
// Raised targets and body=[] holds are unaffected.
const ARM = String.raw`(?:(left|right)\s+)?(arms?)`;
const LOWERED_ARMS = [
  new RegExp(String.raw`\b(?:both\s+|the\s+|their\s+|his\s+|her\s+)?${ARM}\s+(?:hanging\s+|relaxed\s+|resting\s+|lowered\s+)?(?:down\b|lowered\b|(?:at|by)\s+(?:the|their|his|her)\s+sides?\b)`, 'gi'),
  new RegExp(String.raw`\blower(?:s|ing)?\s+(?:both\s+|the\s+|their\s+|his\s+|her\s+)?${ARM}\b`, 'gi'),
];
export function markLoweredArmTargets(segment) {
  if (!Array.isArray(segment.body) || !segment.body.length) return segment;
  const sides = new Set();
  for (const pattern of LOWERED_ARMS) {
    for (const [, side, noun] of segment.text.matchAll(pattern)) {
      if (side) sides.add(`${side.toLowerCase()}Arm`);
      else if (noun.toLowerCase() === 'arms') { sides.add('leftArm'); sides.add('rightArm'); }
    }
  }
  const lowerArms = ['leftArm', 'rightArm'].filter(group => sides.has(group) && !segment.body.includes(group));
  if (lowerArms.length) segment.lowerArms = lowerArms;
  return segment;
}

function normalizeStreamSegment(segment, availableExpressions) {
  if (!segment || !['text,duration,continuous,face', 'text,duration,continuous,body,head,gaze,face', 'text,duration,continuous,body,rootAxes,head,gaze,face', 'text,duration,continuous,body,rootAxes,jev,head,gaze,face', 'text,duration,continuous,body,rootAxes,jev,turn,head,gaze,face'].includes(Object.keys(segment).join(','))
    || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.length > 2000
    || typeof segment.continuous !== 'boolean') throw streamPlanError();
  patchUnits(segment.duration, 0.4);
  segment = structuredClone(segment);
  if (typeof segment.body === 'number') {
    if (!Number.isInteger(segment.body) || segment.body < 0 || segment.body > 127) throw streamPlanError();
    segment.body = BODY_GROUPS.filter((_, index) => segment.body & (1 << index));
  }
  if (typeof segment.rootAxes === 'number') {
    if (!Number.isInteger(segment.rootAxes) || segment.rootAxes < 0 || segment.rootAxes > 7) throw streamPlanError();
    segment.rootAxes = [1, 2, 4].map(bit => !!(segment.rootAxes & bit));
  }
  validateAuthoredChannels(segment);
  markLoweredArmTargets(segment);
  const compact = Object.hasOwn(segment, 'body');
  const rows = compact && Array.isArray(segment.face) && !segment.face.length ? [[0], [1]] : segment.face;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8 || rows.some((row, i) =>
    !Array.isArray(row) || row.length < (compact ? 1 : 6) || row.length > 6 || row.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || (i > 0 && row[0] <= rows[i - 1][0])) || rows[0][0] !== 0 || rows.at(-1)[0] !== 1) {
    throw new Error('Codexの表情タイミングが不正です');
  }
  const face = rows.map(row => {
    const weights = FACE_NAMES.map((name, i) => !Array.isArray(availableExpressions) || availableExpressions.includes(name) ? (row[i + 1] ?? 0) : 0);
    const total = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0));
    return { at: row[0], ...Object.fromEntries(FACE_NAMES.map((name, i) => [name, weights[i] / total])) };
  });
  return { ...structuredClone(segment), face };
}

const cloneSegment = segment => structuredClone(segment);

function awaitPlan(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

// Unlike the legacy whole-body plan, each accepted segment includes its own
// face and immutable duration. The caller can generate it while later actions
// are still being designed, without replacing an already playing performance.
export async function planRealtimeMotionStream(text, { request, model, duration = 6, autoDuration, motionContext,
  state, signal, availableExpressions, onSegment, effort = 'low' }) {
  signal?.throwIfAborted();
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('動作計画の推論設定が不正です');
  patchUnits(duration, 2);
  let streamed = '', header, finished = false;
  const accepted = [];
  const accept = (parsed, final = false) => {
    if (!parsed.header) { if (final) throw streamPlanError(); return; }
    const nextHeader = parsed.header;
    if (typeof nextHeader.continuous !== 'boolean') throw streamPlanError();
    const total = patchUnits(nextHeader.duration, 2);
    if (autoDuration !== true && total !== patchUnits(duration, 2)) throw new Error('Codexの合計時間が指定時間と一致しません');
    if (header && (header.continuous !== nextHeader.continuous || header.duration !== nextHeader.duration)) {
      throw new Error('Codexの途中計画と完成計画が一致しません');
    }
    if (parsed.segments.length > 12 || ((final || parsed.arrayComplete) && !parsed.segments.length)) throw streamPlanError();
    if (parsed.segments.length < accepted.length) throw new Error('Codexの途中計画と完成計画の区間数が一致しません');
    let used = 0;
    const additions = [];
    for (let index = 0; index < parsed.segments.length; index++) {
      const segment = parsed.segments[index], signature = JSON.stringify(segment);
      used += patchUnits(segment.duration, 0.4);
      if (used > total || (used < total && total - used < 2)) throw new Error('Codexの区間時間の合計が不正です');
      if (index < accepted.length) {
        if (accepted[index].signature !== signature) throw new Error('Codexの途中計画と完成計画が一致しません');
      } else additions.push({ signature, segment: normalizeStreamSegment(segment, availableExpressions) });
    }
    if ((final || parsed.arrayComplete || parsed.segments.length === 12) && used !== total) throw new Error('Codexの区間時間の合計が指定時間と一致しません');
    header ??= nextHeader;
    for (const item of additions) {
      signal?.throwIfAborted();
      const index = accepted.length;
      accepted.push(item);
      onSegment?.({ index, segment: cloneSegment(item.segment), duration: header.duration, continuous: header.continuous });
    }
  };
  try {
    const semanticContext = toMotionSemanticContext(motionContext);
    const output = await awaitPlan(request({ model, outputType: 'realtime_stream', effort, messages: [
      { role: 'system', content: STREAM_PROMPT },
      { role: 'user', content: JSON.stringify({ text, duration, autoDuration, state,
        jev: semanticContext || undefined, availableExpressions }) },
    ] }, { signal, onDelta: delta => {
      if (finished) return;
      signal?.throwIfAborted();
      if (typeof delta !== 'string' || (streamed += delta).length > 200000) throw new Error('Codexの計画が大きすぎます');
      accept(readStreamPlan(streamed));
    } }), signal);
    signal?.throwIfAborted();
    if (typeof output !== 'string' || output.length > 200000) throw new Error('Codexの計画が大きすぎます');
    const parsed = readStreamPlan(output);
    if (!parsed.complete) throw streamPlanError();
    accept(parsed, true);
    signal?.throwIfAborted();
    return { ...header, segments: accepted.map(item => cloneSegment(item.segment)) };
  } finally { finished = true; }
}
