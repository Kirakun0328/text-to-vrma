"""Offline session lifecycle and native-window tests; no model weights loaded."""
import ast
from copy import deepcopy
from pathlib import Path
import re
import threading
from types import SimpleNamespace
import unittest
from urllib.parse import urlparse

import torch

from rolling_sessions import RollingSessions, SessionError, segment_frame_counts


def server_nodes(names, namespace):
    source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
    nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
    return namespace


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.now = 0

        def generate(snapshot, cancelled):
            self.calls.append(snapshot)
            count = min(40, snapshot["target_frame"] - snapshot["start_frame"])
            values = [len(self.calls)] * count
            return {"frames": count, "motion": (snapshot["motion"] or []) + values,
                    "payload": {"tracks": {"hips": values}, "hips": []}, "jev": {"bodyApplied": False}}

        self.registry = RollingSessions(20, 40, 4, generate, lambda motion, start, end: motion[start:end],
                                        max_sessions=2, ttl=10, clock=lambda: self.now)

    def create(self, **options):
        metadata = self.registry.create({"text": "current instruction", **options})
        return metadata["sessionId"]

    def test_create_does_not_generate_and_next_returns_one_horizon(self):
        sid = self.create(revision=3)
        self.assertEqual(self.calls, [])
        first = self.registry.next(sid, {"revision": 3})
        self.assertEqual((first["startTime"], first["endTime"], first["targetDuration"]), (0, 1.95, 6))
        self.assertEqual(first["duration"], first["endTime"])
        self.assertFalse(first["complete"])
        self.registry.next(sid)
        self.assertEqual(self.calls[1]["motion"], [1] * 40)
        self.assertEqual(len(self.calls), 2)

    def test_body_ownership_is_validated_and_advertised_without_restricting_legacy(self):
        groups = ["root", "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"]
        for body in [[], groups, ["leftArm"]]:
            metadata = self.registry.create({"segments": [{"text": "an original action", "duration": 2, "body": body}],
                                             "plannerOwned": True})
            self.assertTrue(metadata["bodyScopeSupported"])
            stored = self.registry.sessions[metadata["sessionId"]].request
            self.assertEqual(stored["segments"][0]["body"], body)
            self.assertTrue(stored["plannerOwned"])
            self.registry.close(metadata["sessionId"])
        for body in [None, "leftArm", ["leftArm", "leftArm"], ["gesture"], [1], [{}]]:
            with self.subTest(body=body), self.assertRaises(SessionError):
                self.registry.create({"segments": [{"text": "action", "duration": 2, "body": body}]})
        for value in [None, 1, "true"]:
            with self.assertRaises(SessionError):
                self.create(plannerOwned=value)
        sid = self.create()
        self.assertNotIn("body", self.registry.sessions[sid].request)

    def test_planner_ownership_survives_context_and_append_but_not_new_raw_instruction(self):
        segments = [{"text": "first", "duration": 2, "body": ["head"]}]
        sid = self.registry.create({"segments": segments, "duration": 4, "planComplete": False,
                                    "plannerOwned": True})["sessionId"]
        self.registry.update(sid, {"motionContext": {"emotion": "joy"}, "revision": 1})
        self.assertTrue(self.registry.sessions[sid].request["plannerOwned"])
        with self.assertRaisesRegex(SessionError, "already authored"):
            self.registry.append(sid, {"segments": [{**segments[0], "body": ["leftArm"]}],
                                       "planComplete": False, "revision": 1})
        self.registry.append(sid, {"segments": segments + [{"text": "second", "duration": 2, "body": []}],
                                   "planComplete": True, "revision": 1})
        self.assertTrue(self.registry.sessions[sid].request["plannerOwned"])
        self.registry.update(sid, {"text": "new raw instruction", "revision": 2})
        self.assertNotIn("plannerOwned", self.registry.sessions[sid].request)

    def test_update_keeps_played_prefix_and_runway_but_drops_previous_semantics(self):
        sid = self.create(motionContext={"emotion": "joy"})
        self.registry.next(sid)
        self.registry.next(sid)
        update = self.registry.update(sid, {"text": "new unrelated instruction", "playbackTime": .7, "revision": 1})
        self.assertEqual(update["replaceFrom"], 1.6)
        self.assertEqual(update["instructionStartTime"], 1.6)
        self.assertEqual(update["targetDuration"], 7.6)
        session = self.registry.sessions[sid]
        self.assertEqual(session.motion, [1] * 32)
        self.assertNotIn("motionContext", session.request)
        fresh = self.registry.next(sid)
        self.assertEqual(fresh["startTime"], 1.6)
        self.assertEqual(self.calls[-1]["request"]["text"], "new unrelated instruction")
        self.assertEqual(session.motion[:32], [1] * 32)

    def test_known_until_discards_committed_but_unreceived_chunk_without_a_gap(self):
        sid = self.create()
        received = self.registry.next(sid)
        committed = self.registry.next(sid)
        self.assertEqual((received["endTime"], committed["endTime"]), (1.95, 3.95))
        update = self.registry.update(sid, {"text": "new instruction", "revision": 1,
                                           "playbackTime": 1.95, "knownUntil": 2})
        self.assertEqual(update["replaceFrom"], 2)
        self.assertEqual(self.registry.sessions[sid].motion, [1] * 40)
        following = self.registry.next(sid)
        self.assertAlmostEqual(following["startTime"] - received["endTime"], 1 / 20)

    def test_known_until_zero_can_replace_unreceived_first_chunk(self):
        sid = self.create()
        self.registry.next(sid)
        update = self.registry.update(sid, {"text": "replacement before playback", "revision": 1,
                                           "playbackTime": 0, "knownUntil": 0})
        self.assertEqual(update["replaceFrom"], 0)
        self.assertEqual(self.registry.sessions[sid].motion, [])
        self.assertEqual(self.registry.next(sid)["startTime"], 0)

    def test_known_until_rounds_down_to_patch_without_discarding_played_frames(self):
        sid = self.create()
        self.registry.next(sid)
        self.registry.next(sid, {"playbackTime": 1.95})
        for value in [True, -1, float("nan"), float("inf"), "2", 2.03, 86401, 1.6]:
            with self.subTest(value=value), self.assertRaises(SessionError):
                self.registry.update(sid, {"text": "invalid update", "revision": 1, "knownUntil": value})
            self.assertEqual(self.registry.sessions[sid].revision, 0)
            self.assertEqual(self.registry.sessions[sid].cursor, 80)
        update = self.registry.update(sid, {"text": "new instruction", "revision": 1, "knownUntil": 2.05})
        self.assertEqual(update["replaceFrom"], 2)

    def test_refinement_and_context_patch_preserve_instruction_origin(self):
        sid = self.create(motionContext={"tempo": "slow", "confidence": .9})
        self.registry.next(sid)
        self.registry.next(sid)
        refined = self.registry.update(sid, {"segments": [{"text": "already elapsed", "duration": 1},
                                                         {"text": "remaining action", "duration": 5}],
                                            "instructionStartTime": 0, "playbackTime": 2.1, "revision": 1})
        self.assertEqual(refined["instructionStartTime"], 0)
        self.assertEqual(refined["targetDuration"], 6)
        self.assertEqual(self.registry.sessions[sid].request["motionContext"]["tempo"], "slow")
        context = self.registry.update(sid, {"motionContext": {"tempo": "fast"}, "revision": 2})
        self.assertEqual(context["instructionStartTime"], 0)
        self.assertEqual(context["targetDuration"], 6)
        self.assertEqual(self.registry.sessions[sid].request["segments"][1]["text"], "remaining action")

    def test_complete_can_be_updated_and_does_not_reemit_last_chunk(self):
        sid = self.create(duration=2)
        self.assertTrue(self.registry.next(sid)["complete"])
        done = self.registry.next(sid)
        self.assertEqual(done["type"], "complete")
        self.assertEqual(done["tracks"], {})
        self.assertEqual(len(self.calls), 1)
        update = self.registry.update(sid, {"text": "new action", "duration": 2, "playbackTime": 1.95})
        self.assertEqual(update["instructionStartTime"], 2)
        self.assertEqual(self.registry.next(sid)["endTime"], 3.95)

    def test_inflight_update_is_nonblocking_and_old_generation_is_not_committed(self):
        sid = self.create()
        entered, release = threading.Event(), threading.Event()
        generate = self.registry.generate

        def blocked(snapshot, cancelled):
            entered.set()
            release.wait(3)
            return generate(snapshot, cancelled)

        self.registry.generate = blocked
        response = []
        worker = threading.Thread(target=lambda: response.append(self.registry.next(sid)))
        worker.start()
        self.assertTrue(entered.wait(2))
        try:
            with self.assertRaises(SessionError) as busy:
                self.registry.next(sid)
            self.assertEqual(busy.exception.code, "session_busy")
            updated = self.registry.update(sid, {"text": "replacement", "revision": 1})
            self.assertEqual(updated["replaceFrom"], 0)
            self.assertTrue(worker.is_alive())
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(response[0]["type"], "stale")
        self.assertIsNone(self.registry.sessions[sid].motion)
        self.registry.generate = generate
        self.assertEqual(self.registry.next(sid, {"revision": 1})["revision"], 1)

    def test_close_or_disconnect_discards_generated_motion(self):
        sid = self.create()
        response = self.registry.next(sid, disconnected=lambda: True)
        self.assertEqual(response["type"], "stale")
        self.assertIsNone(self.registry.sessions[sid].motion)
        self.assertTrue(self.registry.close(sid)["closed"])
        self.assertTrue(self.registry.close(sid)["closed"])
        with self.assertRaises(SessionError):
            self.registry.next(sid)

    def test_invalid_updates_do_not_change_live_state(self):
        sid = self.create(revision=4)
        initial = deepcopy(self.registry.sessions[sid].request)
        for body in [{"revision": 4, "text": "stale"}, {"revision": 5, "duration": float("nan")},
                     {"revision": 5, "historyFrames": True}, {"revision": 5, "instructionStartTime": .1},
                     {"revision": 5, "text": ""}]:
            with self.subTest(body=body), self.assertRaises(SessionError):
                self.registry.update(sid, body)
            self.assertEqual(self.registry.sessions[sid].request, initial)
            self.assertEqual(self.registry.sessions[sid].revision, 4)
        self.assertEqual(self.registry.next(sid, {"revision": 3})["type"], "stale")
        self.assertEqual(self.calls, [])

    def test_session_count_ttl_and_retained_history_are_bounded(self):
        sid = self.create(duration=30)
        self.create()
        with self.assertRaises(SessionError) as full:
            self.create()
        self.assertEqual(full.exception.code, "session_limit")
        for index in range(15):
            self.registry.next(sid, {"playbackTime": max(0, index * 2 - .05)})
        state = self.registry.sessions[sid]
        self.assertGreater(state.motion_start, 0)
        self.assertLessEqual(len(state.motion), 124)
        self.assertEqual(state.motion_start + len(state.motion), state.cursor)
        self.now = 11
        self.create()
        with self.assertRaises(SessionError):
            self.registry.next(sid)

    def test_progressive_prefix_waits_without_extrapolating_or_repeating(self):
        prefix = [{"text": "authored first action", "duration": 1.2, "continuous": False,
                   "face": [{"at": 0, "happy": 0}, {"at": 1, "happy": .5}]}]
        sid = self.create(segments=prefix, duration=6, planComplete=False)
        chunk = self.registry.next(sid)
        self.assertEqual((chunk["endTime"], chunk["plannedDuration"], chunk["targetDuration"]), (1.15, 1.2, 6))
        self.assertFalse(chunk["complete"])
        for _ in range(2):
            waiting = self.registry.next(sid)
            self.assertEqual(waiting["type"], "waiting")
            self.assertFalse(waiting["complete"])
        self.assertEqual(len(self.calls), 1)
        extended = prefix + [{"text": "authored later action", "duration": 4.8, "continuous": True}]
        append = self.registry.append(sid, {"segments": extended, "planComplete": True, "revision": 0})
        self.assertEqual((append["plannedDuration"], append["revision"]), (6, 0))
        self.assertEqual(self.registry.sessions[sid].cursor, 24)
        next_chunk = self.registry.next(sid)
        self.assertEqual(next_chunk["startTime"], 1.2)
        self.assertEqual(self.calls[-1]["motion"], [1] * 24)

    def test_reaching_total_still_waits_for_validated_terminal_plan(self):
        prefix = [{"text": "complete authored span", "duration": 2}]
        sid = self.create(segments=prefix, duration=2, planComplete=False)
        chunk = self.registry.next(sid)
        self.assertFalse(chunk["complete"])
        self.assertEqual(self.registry.next(sid)["type"], "waiting")
        final = {"segments": prefix, "planComplete": True, "revision": 0}
        self.assertEqual(self.registry.append(sid, final), self.registry.append(sid, final))
        self.assertTrue(self.registry.next(sid)["complete"])
        self.assertEqual(len(self.calls), 1)

    def test_append_validates_immutable_prefix_total_revision_and_fields(self):
        prefix = [{"text": "original", "duration": .4, "continuous": True, "face": [{"at": 0, "happy": .1}]}]
        sid = self.create(segments=prefix, duration=2, planComplete=False)
        invalid = [({"text": "changed"}, "plan_prefix_changed"),
                   ({"duration": .6}, "plan_prefix_changed"),
                   ({"continuous": False}, "plan_prefix_changed"),
                   ({"face": [{"at": 0, "happy": .2}]}, "plan_prefix_changed")]
        for change, code in invalid:
            with self.subTest(change=change), self.assertRaises(SessionError) as error:
                self.registry.append(sid, {"segments": [{**prefix[0], **change}], "planComplete": False, "revision": 0})
            self.assertEqual(error.exception.code, code)
        for body in [{"segments": prefix, "planComplete": True, "revision": 0},
                     {"segments": prefix, "planComplete": False, "revision": 1},
                     {"segments": prefix, "planComplete": False},
                     {"segments": prefix, "planComplete": False, "revision": 0, "duration": 3},
                     {"segments": prefix + [{"text": "overflow", "duration": 2}], "planComplete": False, "revision": 0}]:
            with self.subTest(body=body), self.assertRaises(SessionError):
                self.registry.append(sid, body)
        self.assertEqual(self.registry.sessions[sid].request["segments"], prefix)
        self.assertEqual(self.registry.sessions[sid].cursor, 0)

    def test_append_during_generation_preserves_old_chunk_and_prefix_cursor(self):
        prefix = [{"text": "first", "duration": .4}]
        sid = self.create(segments=prefix, duration=2, planComplete=False)
        entered, release = threading.Event(), threading.Event()
        generate = self.registry.generate

        def blocked(snapshot, cancelled):
            entered.set()
            release.wait(3)
            return generate(snapshot, cancelled)

        self.registry.generate = blocked
        responses = []
        worker = threading.Thread(target=lambda: responses.append(self.registry.next(sid)))
        worker.start()
        self.assertTrue(entered.wait(2))
        try:
            self.registry.append(sid, {"segments": prefix + [{"text": "second", "duration": 1.6}],
                                       "planComplete": True, "revision": 0})
            self.assertEqual(self.registry.sessions[sid].cursor, 0)
            self.assertTrue(worker.is_alive())
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(responses[0]["type"], "chunk")
        self.assertEqual(responses[0]["endTime"], .35)
        self.registry.generate = generate
        following = self.registry.next(sid)
        self.assertEqual(following["startTime"], .4)
        self.assertTrue(following["complete"])

    def test_progressive_context_patch_retains_prefix_and_new_instruction_has_new_origin(self):
        prefix = [{"text": "ongoing first instruction", "duration": 2}]
        sid = self.create(segments=prefix, duration=6, planComplete=False, motionContext={"tempo": "slow"})
        self.registry.next(sid)
        context = self.registry.update(sid, {"motionContext": {"tempo": "fast"}, "revision": 1, "playbackTime": .2})
        self.assertEqual((context["instructionStartTime"], context["plannedDuration"]), (0, 2))
        self.assertFalse(context["planComplete"])
        new_prefix = [{"text": "new instruction", "duration": .4}]
        with self.assertRaises(SessionError):
            self.registry.update(sid, {"segments": new_prefix, "duration": 2, "planComplete": False,
                                       "revision": 2, "instructionStartTime": 0})
        update = self.registry.update(sid, {"segments": new_prefix, "duration": 2, "planComplete": False,
                                           "revision": 2})
        self.assertEqual(update["instructionStartTime"], update["replaceFrom"])
        self.assertAlmostEqual(update["plannedDuration"], update["instructionStartTime"] + .4)
        self.assertNotIn("motionContext", self.registry.sessions[sid].request)

    def test_progressive_validation_and_legacy_scaling_default_remain_distinct(self):
        for body in [{"text": "raw", "duration": 2, "planComplete": False},
                     {"segments": [{"text": "too short", "duration": .1}], "duration": 2, "planComplete": False},
                     {"segments": [{"text": "incomplete", "duration": 1}], "duration": 2, "planComplete": True}]:
            with self.subTest(body=body), self.assertRaises(SessionError):
                self.registry.create(body)
        sid = self.create(segments=[{"text": "legacy scaled action", "duration": 1}], duration=6)
        self.assertEqual(self.registry.next(sid)["plannedDuration"], 6)
        self.assertEqual(self.registry.sessions[sid].request["armSpread"], 6)
        explicit = self.create(armSpread=0)
        self.assertEqual(self.registry.sessions[explicit].request["armSpread"], 0)

    def test_thirty_second_plan_tolerates_float_rounding_at_create_and_final_append(self):
        segments = [{"text": f"authored action {index}", "duration": duration}
                    for index, duration in enumerate([1.8, 5.2, 17.6, 5.4])]
        self.assertGreater(sum(segment["duration"] for segment in segments), 30)
        complete = self.registry.create({"segments": segments, "duration": 30, "planComplete": True})
        self.assertEqual(complete["plannedDuration"], 30)
        prefix = self.registry.create({"segments": segments[:1], "duration": 30, "planComplete": False})
        final = self.registry.append(prefix["sessionId"], {"segments": segments, "planComplete": True, "revision": 0})
        self.assertEqual(final["plannedDuration"], 30)
        self.assertTrue(final["planComplete"])


class NativeWindowTests(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        # These tests use scalar frame counters, not a kinematic codec. Actual
        # quaternion/root blending is covered by test_motion_scope.
        blending = patch('motion_scope.blend_action_start', side_effect=lambda rep, previous, samples, frames: samples)
        blending.start()
        self.addCleanup(blending.stop)
        self.steps, self.encodes, self.translations = [], [], []

        def encode(text):
            self.encodes.append(text[0])
            return text[0], None

        def step(**kwargs):
            self.steps.append(kwargs)
            history = kwargs["init_history_sequence"]
            value = history[0, -1, 0].item() + 1 if history is not None else kwargs['init_global_translation'][0, 0].item()
            new = torch.arange(value, value + 8).view(1, 8, 1)
            return new if history is None else torch.cat([history, new], dim=1)

        def inverse(motion, **kwargs):
            return {"global_rot_mats": torch.zeros(1, motion.shape[1], 1, 3, 3).numpy(),
                    "root_positions": motion.expand(-1, -1, 3).numpy()}

        def fragment(glob, root, fps, text, t_offset, **kwargs):
            return {"tracks": {"hips": [{"t": t_offset + index / fps, "r": [0, 0, 0]} for index in range(len(root))]},
                    "hips": [{"t": t_offset + index / fps, "p": value.tolist()} for index, value in enumerate(root)]}

        def translate(text):
            self.translations.append(text)
            return text, None

        model = SimpleNamespace(gen_horizon_len=8, _encode_text=encode, autoregressive_step=step,
                                _encode_init_history=lambda history, batch: (None, (history[:, -1] + 1).expand(-1, 3), torch.zeros(batch)),
                                motion_rep=SimpleNamespace(nfeats_dict={"root_pos": 3}, inverse=inverse,
                                    unnormalize=lambda value: value, get_root_heading_angle=lambda value: torch.zeros(*value.shape[:2])))
        namespace = server_nodes({"_session_plan", "_generate_session_chunk", "_apply_motion_context"},
                                 dict(torch=torch, re=re, FPS=20, PATCH=4, GEN_LOCK=threading.Lock(),
                                      model=model, DEVICE="cpu", NUM_BASE_STEPS=8,
                                      SessionError=SessionError, maybe_translate=translate,
                                      segment_frame_counts=segment_frame_counts,
                                      to_numpy=lambda value: value, spec_from_arrays=fragment))
        self.registry = RollingSessions(20, 8, 4, namespace["_generate_session_chunk"],
                                        lambda motion, start, end: motion[:, start:end].clone())

    def test_one_horizon_uses_contiguous_physical_history_and_lazy_text_features(self):
        sid = self.registry.create({"segments": [{"text": "first action", "duration": .4},
                                                 {"text": "future action", "duration": 1.6}]})["sessionId"]
        self.assertEqual(self.encodes, [])
        first = self.registry.next(sid)
        self.assertEqual(self.translations, ["first action"])
        self.assertEqual(len(first["hips"]), 8)
        self.assertEqual(first["endTime"], .35)
        second = self.registry.next(sid)
        self.assertEqual(self.encodes, ["first action", "future action"])
        self.assertEqual(second["hips"][0]["p"][0], 8)
        self.assertEqual(second["hips"][0]["t"], .4)
        self.assertIsNone(self.steps[1]["init_history_sequence"])
        self.assertTrue(second['actionRestarted'])
        self.assertEqual([step["num_frames"] for step in self.steps], [8, 8])
        self.assertTrue(all(step["num_denoising_steps"] == 8 for step in self.steps))

    def test_late_plan_skips_elapsed_semantics_without_restarting_motion(self):
        sid = self.registry.create({"text": "original direction"})["sessionId"]
        for _ in range(4):
            self.registry.next(sid)
        update = self.registry.update(sid, {"segments": [{"text": "expired action must not run", "duration": .4},
                                                         {"text": "new future action", "duration": 1.6}],
                                            "instructionStartTime": 0, "playbackTime": 1, "revision": 1})
        self.assertEqual(update["replaceFrom"], 1.4)
        chunk = self.registry.next(sid)
        self.assertEqual(self.encodes, ["original direction", "new future action"])
        self.assertEqual(chunk["hips"][0]["p"][0], 28)
        self.assertEqual(chunk["startTime"], 1.4)
        self.assertEqual(chunk["targetDuration"], 2)

    def test_context_only_patch_keeps_action_and_reports_actual_application(self):
        sid = self.registry.create({"text": "A person balances."})["sessionId"]
        for _ in range(4):
            self.registry.next(sid)
        self.registry.update(sid, {"motionContext": {"emotion": "joy", "emotion_intensity": .8,
                                                     "tempo": "slow", "confidence": .9},
                                   "playbackTime": 1, "revision": 1})
        chunk = self.registry.next(sid)
        self.assertTrue(self.encodes[-1].startswith("A person balances."))
        self.assertIn("unhurried tempo", self.encodes[-1])
        self.assertNotIn("joy", self.encodes[-1])
        self.assertEqual(chunk["jev"]["fields"], ["tempo"])
        self.assertTrue(chunk["jev"]["bodyApplied"])

    def test_planner_owned_caption_is_unchanged_by_later_jev_hints(self):
        caption = "A person looks to the side."
        sid = self.registry.create({"segments": [{"text": caption, "duration": 2}], "plannerOwned": True,
                                    "motionContext": {"emotion": "embarrassment", "emotion_intensity": .8,
                                                      "tempo": "slow", "confidence": .9}})["sessionId"]
        chunk = self.registry.next(sid)
        self.assertEqual(self.encodes, [caption])
        self.assertFalse(chunk["jev"]["bodyApplied"])
        self.registry.update(sid, {"motionContext": {"tempo": "fast", "confidence": 1}, "revision": 1})
        chunk = self.registry.next(sid)
        self.assertEqual(self.encodes, [caption, caption])
        self.assertFalse(chunk["jev"]["bodyApplied"])

    def test_planner_delegates_only_style_to_jev(self):
        for permission in [0, 4]:
            caption = "A person balances."
            sid = self.registry.create({"segments": [{"text": caption, "duration": 2,
                "jev": permission, "jevContext": {"tempo": "slow", "confidences": {"tempo": .9},
                    "emotion": "joy", "emotion_intensity": 1}}], "plannerOwned": True})["sessionId"]
            chunk = self.registry.next(sid)
            self.assertEqual(chunk["jev"]["bodyApplied"], bool(permission))
            self.assertNotIn("joy", self.encodes[-1])
            if permission:
                self.assertIn("unhurried tempo", self.encodes[-1])
            else:
                self.assertEqual(self.encodes[-1], caption)

    def test_full_body_ownership_preserves_the_unrestricted_native_path(self):
        groups = ["root", "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"]
        sid = self.registry.create({"segments": [{"text": "unusual whole body motion", "duration": 2, "body": groups}]})["sessionId"]
        self.registry.next(sid)
        self.assertIsNone(self.steps[-1]["observed_motion"])
        self.assertIsNone(self.steps[-1]["motion_mask"])

    def test_native_prefix_append_never_stretches_or_encodes_unknown_future(self):
        prefix = [{"text": "first authored action", "duration": .4, "continuous": False}]
        sid = self.registry.create({"segments": prefix, "duration": 2, "planComplete": False})["sessionId"]
        self.registry.next(sid)
        self.assertEqual(self.registry.next(sid)["type"], "waiting")
        self.assertEqual(len(self.steps), 1)
        self.registry.append(sid, {"segments": prefix + [{"text": "second authored action", "duration": 1.6, "continuous": True}],
                                   "planComplete": True, "revision": 0})
        chunk = self.registry.next(sid)
        self.assertEqual(chunk["startTime"], .4)
        self.assertIsNone(self.steps[-1]["init_history_sequence"])
        self.assertEqual(self.encodes, ["first authored action", "second authored action"])
        self.assertEqual(chunk["hips"][0]["p"][0], 8)

    def test_action_boundary_restarts_and_subsequent_history_excludes_the_previous_action(self):
        segments = [{"text": "first", "duration": 2, "continuous": False},
                    {"text": "second", "duration": 2, "continuous": False}]
        sid = self.registry.create({"segments": segments, "duration": 4, "planComplete": True})["sessionId"]
        for _ in range(5):
            self.registry.next(sid)
        boundary = self.registry.next(sid)
        self.assertEqual(boundary["startTime"], 2)
        self.assertIsNone(self.steps[-1]["init_history_sequence"])
        self.registry.next(sid)
        self.assertEqual(self.steps[-1]["init_history_sequence"].shape[1], 8)
        update = self.registry.update(sid, {"segments": [{"text": "unrelated new instruction", "duration": 2, "continuous": False}],
                                           "duration": 2, "planComplete": True, "playbackTime": 2.5, "revision": 1})
        chunk = self.registry.next(sid)
        self.assertEqual(chunk["startTime"], update["instructionStartTime"])
        self.assertIsNone(self.steps[-1]["init_history_sequence"])
        self.assertEqual(self.encodes[-1], "unrelated new instruction")
        self.assertEqual(chunk["hips"][0]["p"][0], int(chunk["startTime"] * 20))


class SessionHTTPTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.registry = SimpleNamespace(create=lambda body: self.calls.append(("create", body)) or {"sessionId": "test"})
        namespace = server_nodes({"Handler", "_is_local_origin"}, {"BaseHTTPRequestHandler": object, "BOOT": {"ready": True},
                                               "urlparse": urlparse, "re": re, "SessionError": SessionError,
                                               "_rolling_sessions": lambda: self.registry})
        self.handler = namespace["Handler"]()
        self.handler.path = "/sessions"
        self.handler.headers = {"Host": "127.0.0.1:2337", "Origin": "http://localhost:5173", "Content-Type": "application/json"}
        self.handler._read_json_body = lambda: {"text": "test"}
        self.responses = []
        self.handler._send = lambda status, body: self.responses.append((status, body))

    def test_local_json_request_reaches_registry(self):
        self.handler.do_POST()
        self.assertEqual(self.calls, [("create", {"text": "test"})])
        self.assertEqual(self.responses[0][0], 200)

    def test_append_endpoint_routes_current_revision_without_changing_origin_rules(self):
        sid = "12345678-1234-1234-1234-123456789abc"
        self.registry.append = lambda session_id, body: self.calls.append(("append", session_id, body)) or {"revision": 2}
        self.handler.path = f"/sessions/{sid}/append"
        body = {"revision": 2, "segments": [{"text": "action", "duration": 2}], "planComplete": True}
        self.handler._read_json_body = lambda: body
        self.handler.headers["Sec-Fetch-Site"] = "cross-site"
        self.handler.do_POST()
        self.assertEqual(self.calls, [("append", sid, body)])
        self.assertEqual(self.responses[-1][0], 200)

    def test_verified_local_origins_work_even_when_browser_marks_them_cross_site(self):
        for origin in ["http://localhost:5173", "http://127.0.0.1:5175", "http://[::1]:5173", "app://bundle"]:
            with self.subTest(origin=origin):
                self.handler.headers["Origin"] = origin
                self.handler.headers["Sec-Fetch-Site"] = "cross-site"
                self.handler.do_POST()
                self.assertEqual(self.responses[-1][0], 200)
                self.assertEqual(self.handler._cors_origin(), origin)
        self.assertEqual(len(self.calls), 4)

    def test_cross_site_request_without_origin_is_rejected(self):
        self.handler.headers.pop("Origin")
        self.handler.headers["Sec-Fetch-Site"] = "cross-site"
        self.handler.do_POST()
        self.assertEqual(self.responses[-1][0], 403)
        self.assertEqual(self.calls, [])

    def test_cli_request_without_browser_origin_remains_supported(self):
        self.handler.headers.pop("Origin")
        self.handler.do_POST()
        self.assertEqual(self.responses[-1][0], 200)

    def test_cross_origin_host_and_non_json_requests_are_rejected(self):
        for header, value, status in [("Origin", "https://remote.example", 403), ("Host", "remote.example:2337", 403),
                                      ("Origin", "null", 403), ("Origin", "http://[", 403),
                                      ("Origin", "http://localhost.evil.example:5173", 403),
                                      ("Origin", "http://127.0.0.1.evil.example", 403),
                                      ("Origin", "http://localhost:invalid", 403),
                                      ("Origin", "http://localhost@remote.example", 403),
                                      ("Origin", "http://localhost:5173/path", 403),
                                      ("Origin", "app://remote", 403),
                                      ("Content-Type", "text/plain", 415)]:
            with self.subTest(header=header, value=value):
                original = dict(self.handler.headers)
                self.handler.headers[header] = value
                self.handler.do_POST()
                self.assertEqual(self.responses[-1][0], status)
                if header == "Origin" and value != "null":
                    self.assertNotEqual(self.handler._cors_origin(), value)
                self.handler.headers = original
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
