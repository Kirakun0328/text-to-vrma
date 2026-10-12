"""Bounded rolling inference sessions; independent of ARDY/model imports.

The client owns the finished animation. A session retains only physical history
and unplayed frames. Every next() invokes the injected generator for new motion.
"""
from copy import deepcopy
from dataclasses import dataclass, field
import json
import math
import threading
import time
from uuid import uuid4

BODY_GROUPS = frozenset({"root", "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"})


class SessionError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _number(value, name, minimum, maximum):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not minimum <= value <= maximum):
        raise SessionError(400, "invalid_session_request", f"{name} must be between {minimum} and {maximum}")
    return value


def _integer(value, name, minimum, maximum):
    _number(value, name, minimum, maximum)
    if not isinstance(value, int):
        raise SessionError(400, "invalid_session_request", f"{name} must be an integer")
    return value


def segment_frame_counts(request, fps, patch):
    """Use fixed cumulative boundaries for authored prefixes, legacy scaling otherwise."""
    total = max(patch, int(request["duration"] * fps + 1e-6) // patch * patch)
    source = request.get("segments") or [{"text": request["text"], "duration": request["duration"]}]
    elapsed, allocated, counts = 0, 0, []
    weight = sum(segment["duration"] for segment in source)
    for index, segment in enumerate(source):
        elapsed += segment["duration"]
        if request.get("_progressive"):
            # Appending a future action must never shift an existing boundary.
            boundary = int(elapsed * fps + 1e-6) // patch * patch
            if boundary <= allocated:
                raise SessionError(400, "invalid_session_request", "each planned action needs at least one model patch")
        else:
            remaining = len(source) - index - 1
            boundary = total if not remaining else max(allocated + patch, min(total - remaining * patch, round(elapsed / weight * total / patch) * patch))
        counts.append(boundary - allocated)
        allocated = boundary
    return counts


def _instruction(body, previous=None):
    if not isinstance(body, dict):
        raise SessionError(400, "invalid_session_request", "request must be an object")
    request = deepcopy(previous) if previous else {}
    if "segments" in body:
        segments = body["segments"]
        if not isinstance(segments, list) or not 1 <= len(segments) <= 12:
            raise SessionError(400, "invalid_session_request", "segments must contain 1 to 12 actions")
        normalized = []
        for segment in segments:
            if not isinstance(segment, dict) or not isinstance(segment.get("text"), str) or not segment["text"].strip() or len(segment["text"]) > 4000:
                raise SessionError(400, "invalid_session_request", "each segment needs nonempty text")
            duration = _number(segment.get("duration"), "segment.duration", .01, 30)
            if "rootAxes" in segment and (not isinstance(segment.get("body"), list)
                    or not isinstance(segment["rootAxes"], list) or len(segment["rootAxes"]) != 3
                    or any(not isinstance(axis, bool) for axis in segment["rootAxes"])):
                raise SessionError(400, "invalid_session_request", "segment.rootAxes must contain three booleans with body ownership")
            normalized_segment = deepcopy(segment)
            turn = segment.get('turn', [])
            if not isinstance(turn, list) or (turn and (len(turn) != 2
                    or isinstance(turn[0], bool) or not isinstance(turn[0], (int, float)) or not math.isfinite(turn[0]) or abs(turn[0]) > 720
                    or isinstance(turn[1], bool) or not isinstance(turn[1], int) or turn[1] not in [0, 1, 2]
                    or 'root' not in segment.get('body', [])
                    or (turn[1] and segment.get('rootAxes') != [True, True, True]))):
                raise SessionError(400, 'invalid_session_request', 'segment.turn requires a finite angle, pivot 0/1/2, and compatible root permissions')
            if "jev" in segment and (isinstance(segment["jev"], bool) or not isinstance(segment["jev"], int) or not 0 <= segment["jev"] <= 7):
                raise SessionError(400, "invalid_session_request", "segment.jev must be a permission mask from 0 to 7")
            if "jevContext" in segment and not isinstance(segment["jevContext"], dict):
                raise SessionError(400, "invalid_session_request", "segment.jevContext must be an object")
            normalized_segment.update(text=segment["text"].strip(), duration=float(duration))
            if "continuous" in segment and not isinstance(segment["continuous"], bool):
                raise SessionError(400, "invalid_session_request", "segment.continuous must be a boolean")
            if "body" in segment:
                groups = segment["body"]
                if (not isinstance(groups, list) or len(groups) > len(BODY_GROUPS)
                        or any(not isinstance(group, str) or group not in BODY_GROUPS for group in groups)
                        or len(set(groups)) != len(groups)):
                    raise SessionError(400, "invalid_session_request", "segment.body must contain unique body ownership groups")
            if "lowerArms" in segment and (not isinstance(segment["lowerArms"], list)
                    or any(arm not in ("leftArm", "rightArm") for arm in segment["lowerArms"])
                    or len(set(segment["lowerArms"])) != len(segment["lowerArms"])):
                raise SessionError(400, "invalid_session_request", "segment.lowerArms must list leftArm/rightArm once")
            # Keep authored face/head/gaze data for immutable-prefix checks.
            try:
                json.dumps(normalized_segment, allow_nan=False)
            except (ValueError, TypeError):
                raise SessionError(400, "invalid_session_request", "segment metadata must be finite JSON data")
            normalized.append(normalized_segment)
        if sum(segment["duration"] for segment in normalized) > 30 + 1e-6:
            raise SessionError(400, "invalid_session_request", "segments exceed 30 seconds")
        request["segments"] = normalized
        request.pop("text", None)
    elif "text" in body:
        text = body["text"]
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise SessionError(400, "invalid_session_request", "text must contain 1 to 4000 characters")
        request["text"] = text.strip()
        request.pop("segments", None)
    if "planComplete" in body:
        if not isinstance(body["planComplete"], bool):
            raise SessionError(400, "invalid_session_request", "planComplete must be a boolean")
        request["planComplete"] = body["planComplete"]
        request["_progressive"] = True
    elif ("text" in body or "segments" in body) and "instructionStartTime" not in body:
        request.pop("_progressive", None)
        request["planComplete"] = True
    if not request.get("text") and not request.get("segments"):
        raise SessionError(400, "invalid_session_request", "text or segments is required")
    for key in ["duration", "steps", "historyFrames", "cfg", "armSpread"]:
        if key in body:
            request[key] = body[key]
    if "plannerOwned" in body:
        if not isinstance(body["plannerOwned"], bool):
            raise SessionError(400, "invalid_session_request", "plannerOwned must be a boolean")
        request["plannerOwned"] = body["plannerOwned"]
    elif previous and ("text" in body or "segments" in body) and "instructionStartTime" not in body:
        request.pop("plannerOwned", None)
    if "motionContext" in body:
        context = body["motionContext"]
        if context is not None and not isinstance(context, dict):
            raise SessionError(400, "invalid_session_request", "motionContext must be an object or null")
        request["motionContext"] = deepcopy(context)
    elif previous and ("text" in body or "segments" in body) and "instructionStartTime" not in body:
        # A new direction never inherits the old direction's semantic analysis.
        request.pop("motionContext", None)
    return request


@dataclass
class _Session:
    session_id: str
    request: dict
    revision: int
    target_frame: int
    touched: float
    instruction_frame: int = 0
    cursor: int = 0
    motion_start: int = 0
    motion: object = None
    prepared: object = None
    playback_time: float = 0
    replace_frame: int = 0
    closed: bool = False
    jev: dict = field(default_factory=dict)
    lock: object = field(default_factory=threading.Lock)
    next_lock: object = field(default_factory=threading.Lock)


class RollingSessions:
    def __init__(self, fps, horizon_frames, patch, generate, slice_motion,
                 default_steps=8, default_history=40, max_sessions=8, ttl=180,
                 clock=time.monotonic, default_arm_spread=6):
        self.fps, self.horizon, self.patch = fps, horizon_frames, patch
        self.generate, self.slice_motion = generate, slice_motion
        self.default_steps, self.default_history = default_steps, default_history
        self.default_arm_spread = default_arm_spread
        self.max_sessions, self.ttl, self.clock = max_sessions, ttl, clock
        self.sessions = {}
        self.lock = threading.Lock()

    def _validate(self, request, body, new_direction=False):
        if "duration" in body:
            duration = _number(body["duration"], "duration", 2, 30)
        elif new_direction:
            duration = sum(s["duration"] for s in request.get("segments", [])) or 6
            duration = _number(duration, "duration", 2, 30)
        else:
            duration = _number(request.get("duration", 6), "duration", 2, 30)
        request["duration"] = duration
        if len(request.get("segments", [])) > self._frame_count(duration) // self.patch:
            raise SessionError(400, "invalid_session_request", "duration is too short for the requested action sequence")
        if request.get("_progressive"):
            if not request.get("segments"):
                raise SessionError(400, "invalid_session_request", "progressive plans require authored segments")
            authored = sum(segment["duration"] for segment in request["segments"])
            if authored > duration + 1e-6 or (request.get("planComplete", True) and abs(authored - duration) > 1e-6):
                raise SessionError(400, "invalid_session_request", "complete plan must sum to duration; a prefix must not exceed it")
            segment_frame_counts(request, self.fps, self.patch)
        request["steps"] = _integer(request.get("steps", self.default_steps), "steps", 1, 100)
        history = _integer(request.get("historyFrames", self.default_history), "historyFrames", self.patch, 80)
        if history % self.patch:
            raise SessionError(400, "invalid_session_request", "historyFrames must align to the model patch")
        request["historyFrames"] = history
        request["cfg"] = _number(request.get("cfg", 3), "cfg", 1, 6)
        request["armSpread"] = _number(request.get("armSpread", self.default_arm_spread), "armSpread", 0, 20)
        return request

    def _expire(self):
        now = self.clock()
        for session_id, session in list(self.sessions.items()):
            if now - session.touched > self.ttl:
                with session.lock:
                    session.closed = True
                    session.motion = session.prepared = None
                del self.sessions[session_id]

    def _get(self, session_id):
        with self.lock:
            self._expire()
            session = self.sessions.get(session_id)
            if session is None:
                raise SessionError(404, "session_not_found", "session was closed or expired")
            session.touched = self.clock()
            return session

    def _frame_count(self, duration):
        return max(self.patch, int(duration * self.fps + 1e-6) // self.patch * self.patch)

    def _planned_frame(self, session):
        if not session.request.get("_progressive"):
            return session.target_frame
        return session.instruction_frame + sum(segment_frame_counts(session.request, self.fps, self.patch))

    def _metadata(self, session):
        return {"sessionId": session.session_id, "revision": session.revision,
                "bodyScopeSupported": True, "rootAxesSupported": True, "turnSupported": True,
                "fps": self.fps, "horizonFrames": self.horizon,
                "instructionStartTime": session.instruction_frame / self.fps,
                "replaceFrom": session.replace_frame / self.fps,
                "duration": session.target_frame / self.fps,
                "targetDuration": session.target_frame / self.fps,
                "plannedDuration": self._planned_frame(session) / self.fps,
                "planComplete": session.request.get("planComplete", True)}

    def create(self, body):
        request = self._validate(_instruction(body), body, new_direction=True)
        revision = _integer(body.get("revision", 0), "revision", 0, 2 ** 31 - 1)
        with self.lock:
            self._expire()
            if len(self.sessions) >= self.max_sessions:
                raise SessionError(429, "session_limit", "close an existing session before starting another")
            session = _Session(str(uuid4()), request, revision, self._frame_count(request["duration"]), self.clock())
            self.sessions[session.session_id] = session
        return self._metadata(session)

    def _playback(self, session, value):
        if value is None:
            return
        _number(value, "playbackTime", 0, 86400)
        # The client cannot claim a frame that has not been generated yet.
        session.playback_time = max(session.playback_time, min(value, max(0, (session.cursor - 1) / self.fps)))

    def update(self, session_id, body):
        if not isinstance(body, dict):
            raise SessionError(400, "invalid_session_request", "request must be an object")
        session = self._get(session_id)
        with session.lock:
            if session.closed:
                raise SessionError(410, "session_closed", "session is closed")
            revision = _integer(body.get("revision", session.revision + 1), "revision", 0, 2 ** 31 - 1)
            if revision <= session.revision:
                raise SessionError(409, "stale_revision", "revision must increase")
            new_direction = "text" in body or "segments" in body
            request = self._validate(_instruction(body, session.request), body, new_direction=new_direction)
            # Validate all request data before mutating any live state.
            playback = body.get("playbackTime", session.playback_time)
            _number(playback, "playbackTime", 0, 86400)
            playback = max(session.playback_time, min(playback, max(0, (session.cursor - 1) / self.fps)))
            played = math.floor(playback * self.fps + 1e-6) + 1 if session.cursor else 0
            known_frame = session.cursor
            if "knownUntil" in body:
                # Exclusive end of the frames actually received by this client.
                # A cancelled /next may have committed a chunk before its HTTP
                # response arrived; retaining those unknown frames would create
                # a gap in the client's animation when regeneration resumes.
                known_until = _number(body["knownUntil"], "knownUntil", 0, 86400)
                received = round(known_until * self.fps)
                if abs(received / self.fps - known_until) > 1e-6:
                    raise SessionError(400, "invalid_session_request", "knownUntil must align to a frame boundary")
                known_frame = min(session.cursor, received // self.patch * self.patch)
                if received == 0 and playback == 0:
                    # No first chunk received means frame zero has not played.
                    played = 0
                if known_frame < played:
                    raise SessionError(409, "invalid_playback_history", "knownUntil cannot precede an already played frame")
            # Keep a short runway of already generated motion while the next
            # native horizon is computed. Everything beyond it is replaceable.
            buffer_frames = min(.8 * self.fps, self.horizon / 2)
            replace = min(session.cursor, known_frame, math.ceil((played + buffer_frames) / self.patch) * self.patch)
            origin = body.get("instructionStartTime", replace / self.fps if new_direction else session.instruction_frame / self.fps)
            _number(origin, "instructionStartTime", 0, replace / self.fps)
            origin_frame = round(origin * self.fps)
            if origin_frame % self.patch or abs(origin_frame / self.fps - origin) > 1e-6:
                raise SessionError(400, "invalid_session_request", "instructionStartTime must align to a model patch")
            if new_direction and request.get("_progressive") and origin_frame != replace:
                raise SessionError(400, "invalid_session_request", "a new progressive instruction must start at replaceFrom; use append to extend a plan")
            if replace < session.motion_start:
                raise SessionError(409, "history_expired", "the requested playback history is no longer retained")
            if session.motion is not None:
                session.motion = self.slice_motion(session.motion, 0, replace - session.motion_start)
            session.request = request
            session.revision, session.replace_frame, session.cursor = revision, replace, replace
            session.playback_time, session.instruction_frame = playback, origin_frame
            session.target_frame = max(replace, origin_frame + self._frame_count(request["duration"]))
            session.prepared, session.jev = None, {}
            return self._metadata(session)

    def append(self, session_id, body):
        """Publish more authored actions without invalidating an in-flight chunk."""
        if not isinstance(body, dict) or not {"segments", "planComplete", "revision"} <= body.keys():
            raise SessionError(400, "invalid_session_request", "append requires segments, planComplete and current revision")
        if body.keys() - {"segments", "planComplete", "revision"}:
            raise SessionError(400, "invalid_session_request", "append cannot change instruction settings")
        session = self._get(session_id)
        with session.lock:
            if session.closed:
                raise SessionError(410, "session_closed", "session is closed")
            revision = _integer(body["revision"], "revision", 0, 2 ** 31 - 1)
            if revision != session.revision:
                raise SessionError(409, "stale_revision", "append must use the current revision")
            if not session.request.get("_progressive"):
                raise SessionError(409, "plan_not_progressive", "this session does not accept progressive plan appends")
            # Explicit origin marks this as the same instruction, preserving Jev.
            patch = {**body, "instructionStartTime": session.instruction_frame / self.fps}
            request = self._validate(_instruction(patch, session.request), patch)
            previous, current = session.request["segments"], request["segments"]
            stable = lambda value: json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))
            if len(current) < len(previous) or stable(current[:len(previous)]) != stable(previous):
                raise SessionError(409, "plan_prefix_changed", "append cannot modify an already authored segment")
            if session.request.get("planComplete", True) and not request["planComplete"]:
                raise SessionError(409, "plan_already_complete", "a completed plan cannot be reopened")
            session.request = request
            # Keep cursor, motion, prepared text features, origin and revision.
            # Native preparation merges this new prefix on its next invocation.
            return self._metadata(session)

    def next(self, session_id, body=None, disconnected=lambda: False):
        body = {} if body is None else body
        if not isinstance(body, dict):
            raise SessionError(400, "invalid_session_request", "request must be an object")
        session = self._get(session_id)
        if not session.next_lock.acquire(blocking=False):
            raise SessionError(409, "session_busy", "a chunk is already being generated for this session")
        try:
            with session.lock:
                if session.closed:
                    raise SessionError(410, "session_closed", "session is closed")
                if "revision" in body:
                    revision = _integer(body["revision"], "revision", 0, 2 ** 31 - 1)
                    if revision != session.revision:
                        return {"type": "stale", **self._metadata(session)}
                self._playback(session, body.get("playbackTime"))
                planned_frame = self._planned_frame(session)
                complete = session.cursor >= session.target_frame and session.request.get("planComplete", True)
                if complete or session.cursor >= planned_frame:
                    end = max(0, (session.cursor - 1) / self.fps)
                    return {"type": "complete" if complete else "waiting", **self._metadata(session), "complete": complete,
                            "startTime": session.cursor / self.fps, "endTime": end, "duration": end,
                            "tracks": {}, "hips": [], "jev": deepcopy(session.jev)}
                snapshot = {"revision": session.revision, "request": deepcopy(session.request),
                            "instruction_frame": session.instruction_frame, "start_frame": session.cursor,
                            "target_frame": min(session.target_frame, planned_frame), "motion_start": session.motion_start,
                            "motion": session.motion, "prepared": session.prepared}

            def cancelled():
                return disconnected() or session.closed or session.revision != snapshot["revision"]

            try:
                generated = self.generate(snapshot, cancelled)
            except ConnectionAbortedError:
                with session.lock:
                    return {"type": "stale", **self._metadata(session)}
            with session.lock:
                if cancelled():
                    return {"type": "stale", **self._metadata(session)}
                frames = generated["frames"]
                if not isinstance(frames, int) or not 1 <= frames <= self.horizon or session.cursor + frames > snapshot["target_frame"]:
                    raise SessionError(500, "invalid_session_chunk", "generator returned an invalid frame count")
                session.motion, session.prepared = generated["motion"], generated.get("prepared")
                session.cursor += frames
                # Keep enough physical history for any supported setting; release
                # completed old frames, never replaying them as newly generated.
                retain = max(session.motion_start, (int(session.playback_time * self.fps) - 80) // self.patch * self.patch)
                retain = max(0, min(retain, session.cursor))
                if retain > session.motion_start:
                    session.motion = self.slice_motion(session.motion, retain - session.motion_start, None)
                    session.motion_start = retain
                session.jev = deepcopy(generated.get("jev", {}))
                session.touched = self.clock()
                end = (session.cursor - 1) / self.fps
                return {**generated["payload"], "type": "chunk", **self._metadata(session),
                        "startTime": snapshot["start_frame"] / self.fps, "endTime": end,
                        "duration": end, "complete": session.cursor >= session.target_frame and session.request.get("planComplete", True),
                        "jev": deepcopy(session.jev)}
        finally:
            session.next_lock.release()

    def close(self, session_id):
        with self.lock:
            session = self.sessions.pop(session_id, None)
            if session:
                with session.lock:
                    session.closed = True
                    session.motion = session.prepared = None
        return {"closed": True, "sessionId": session_id}
