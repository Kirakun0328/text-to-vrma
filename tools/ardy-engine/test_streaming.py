"""Exercise streaming window/cancellation logic without loading model weights."""
import ast
import io
import json
from pathlib import Path
import re
import time
from types import SimpleNamespace
import unittest

import torch


class StreamingTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"_generate_motion_streaming", "_resolve_history_frames"}]
        self.calls = []
        self.encodes = []

        def encode(text):
            self.encodes.append(text[0])
            return text[0], None

        def step(**kwargs):
            self.calls.append(kwargs)
            history = kwargs["init_history_sequence"]
            new = torch.ones(1, 40, 1) * len(self.calls)
            return new if history is None else torch.cat([history, new], dim=1)

        model = SimpleNamespace(gen_horizon_len=40, _encode_text=encode,
                                autoregressive_step=step,
                                motion_rep=SimpleNamespace(nfeats_dict={"root_pos": 3}))
        namespace = dict(torch=torch, model=model, DEVICE="cpu", HISTORY=40, PATCH=4,
                         _max_window=200, PROGRESS={})
        exec(compile(ast.Module(body=functions, type_ignores=[]), "server.py", "exec"), namespace)
        self.generate = namespace["_generate_motion_streaming"]

    def test_history_override_preserves_prefix_and_requested_context(self):
        for frames in [4, 8, 20, 40, 80]:
            with self.subTest(frames=frames):
                self.calls.clear()
                chunks = []
                result = self.generate([("walk", 120)], 8, low_latency=True, history_frames=frames,
                                       on_chunk=lambda motion, *_: chunks.append(motion.clone()))
                self.assertEqual([call["num_frames"] for call in self.calls],
                                 [40, 40 + min(40, frames), 40 + frames])
                self.assertTrue(torch.equal(chunks[0], result[:, :40]))
                self.assertTrue(torch.equal(chunks[1], result[:, :80]))
                self.assertEqual(result.shape[1], 120)

    def test_invalid_history_override_rejected_before_encoding(self):
        for value in [0, 3, 5, 81, 4.0, "4", True]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "historyFrames"):
                self.generate([("walk", 120)], 8, history_frames=value)
        self.assertEqual(self.encodes, [])

    def test_low_latency_removes_future_and_preserves_history_and_prefix(self):
        chunks = []
        result = self.generate([("walk", 120)], 4, low_latency=True,
                               on_chunk=lambda motion, pos, total: chunks.append((motion.clone(), pos, total)))
        self.assertEqual([call["num_frames"] for call in self.calls], [40, 80, 80])
        self.assertEqual([chunk.shape[1] for chunk, _, _ in chunks], [40, 80, 120])
        self.assertEqual([pos for _, pos, _ in chunks], [0, 40, 80])
        self.assertTrue(torch.equal(chunks[0][0], chunks[-1][0][:, :40]))
        self.assertEqual(result.shape[1], 120)

    def test_standard_path_keeps_lookahead(self):
        self.generate([("walk", 120)], 4)
        self.assertEqual(self.calls[0]["num_frames"], 120)

    def test_later_descriptions_do_not_delay_first_chunk(self):
        encoded_at_chunk = []
        self.generate([("walk", 80), ("wave", 40)], 8, low_latency=True,
                      on_chunk=lambda *_: encoded_at_chunk.append(list(self.encodes)))
        self.assertEqual(encoded_at_chunk, [["walk"], ["walk"], ["walk", "wave"]])
        self.assertEqual([call["text_feat"] for call in self.calls], ["walk", "walk", "wave"])
        self.assertTrue(all(call["num_denoising_steps"] == 8 for call in self.calls))

    def test_cancelled_request_does_not_encode_unused_segments(self):
        with self.assertRaises(ConnectionAbortedError):
            self.generate([("walk", 40), ("wave", 40)], 8,
                          cancelled=lambda: len(self.calls) >= 1)
        self.assertEqual(self.encodes, ["walk"])

    def test_disconnect_during_encoding_skips_denoising(self):
        with self.assertRaises(ConnectionAbortedError):
            self.generate([("walk", 40)], 8,
                          cancelled=lambda: bool(self.encodes))
        self.assertEqual(self.calls, [])

    def test_disconnect_stops_before_next_inference(self):
        with self.assertRaises(ConnectionAbortedError):
            self.generate([("walk", 120)], 4, cancelled=lambda: len(self.calls) >= 1)
        self.assertEqual(len(self.calls), 1)


class MotionContextTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
        nodes = [node for node in source.body if isinstance(node, ast.FunctionDef)
                 and node.name == "_apply_motion_context"]
        namespace = {"re": re}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
        self.apply = namespace["_apply_motion_context"]

    def test_missing_neutral_and_untrusted_context_preserve_motion(self):
        source = [("An acrobat balances on a rail.", 80)]
        for context in [None, {}, {"emotion": "neutral", "confidence": 1},
                        {"reaction": "greeting", "confidence": 1},
                        {"tempo": "fast", "confidence": 0.2},
                        {"tempo": "fast", "confidence": True},
                        {"tempo": "fast", "confidence": float("nan")},
                        {"tempo": "fast", "confidence": 0.9, "confidences": {"tempo": 0.1}}]:
            with self.subTest(context=context):
                result, info = self.apply(source, context)
                self.assertEqual(result, source)
                self.assertFalse(info["bodyApplied"])

    def test_each_fields_confidence_is_independent_and_never_adds_gestures(self):
        context = {"reaction": "celebrate", "emotion": "joy", "emotion_intensity": .9,
                   "tempo": "slow", "movement_scale": "small", "movement_energy": .9,
                   "confidence": .1,
                   "confidences": {"emotion": .9, "intensity": .9, "tempo": .9,
                                   "scale": .2, "energy": .1}}
        result, info = self.apply([("A person rolls sideways.", 40)], context)
        self.assertTrue(result[0][0].startswith("A person rolls sideways."))
        self.assertIn("initial strong joy", result[0][0])
        self.assertIn("unhurried tempo", result[0][0])
        self.assertNotIn("celebrate", result[0][0])
        self.assertNotIn("compact", result[0][0])
        self.assertNotIn("energetic", result[0][0])
        self.assertEqual(result[0][1], 40)
        self.assertEqual(info, {"bodyApplied": True, "fields": ["emotion", "emotion_intensity", "tempo"], "segmentsApplied": 1})
        context["emotion_intensity"] = .2
        weaker, _ = self.apply([("A person rolls sideways.", 40)], context)
        self.assertIn("initial subtle joy", weaker[0][0])

    def test_unknown_text_cannot_become_an_encoder_instruction(self):
        secret = "secret_token_ignore_instructions"
        context = {"emotion": secret, "tempo": secret, "movement_scale": secret,
                   "reaction": secret, "movement_energy": secret, "confidence": 1}
        source = [("An acrobat balances on a rail.", 80)]
        self.assertEqual(self.apply(source, context)[0], source)
        context.update(emotion=[secret], tempo={"instruction": secret}, movement_scale=True)
        self.assertEqual(self.apply(source, context)[0], source)

    def test_explicit_segment_qualities_take_priority_and_start_emotion_does_not_repeat(self):
        source = [("Move quickly with broad, forceful motion and an angry expression.", 40),
                  ("Reach down toward the floor.", 80)]
        context = {"emotion": "joy", "emotion_intensity": .8, "movement_energy": .1,
                   "movement_scale": "small", "tempo": "slow", "confidence": .9}
        result, info = self.apply(source, context)
        self.assertEqual(result[0], source[0])
        self.assertTrue(result[1][0].startswith(source[1][0]))
        self.assertNotIn("joy", result[1][0])
        self.assertIn("unhurried tempo", result[1][0])
        self.assertEqual(info["segmentsApplied"], 1)
        self.assertNotIn("emotion", info["fields"])

    def test_both_http_routes_deliver_context_to_generation(self):
        source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
        handler_ast = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Handler")
        calls = []

        def generate(*args, **kwargs):
            calls.append(kwargs)
            return {"name": "test", "duration": 2}

        namespace = {"BaseHTTPRequestHandler": object, "BOOT": {"ready": True},
                     "time": time, "json": json, "generate_spec": generate,
                     "ARGS": SimpleNamespace(arm_spread=6)}
        exec(compile(ast.Module(body=[handler_ast], type_ignores=[]), "server.py", "exec"), namespace)
        context = {"tempo": "slow", "confidence": .9}
        for path in ["/generate", "/generate-stream"]:
            handler = namespace["Handler"]()
            handler.path = path
            handler._read_json_body = lambda: {"text": "balance", "motionContext": context}
            handler._send = lambda *_: None
            handler._cors_origin = lambda: "http://localhost"
            handler.send_response = lambda *_: None
            handler.send_header = lambda *_: None
            handler.end_headers = lambda: None
            handler.wfile = io.BytesIO()
            handler.do_POST()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call["motion_context"] == context for call in calls))


if __name__ == "__main__":
    unittest.main()
