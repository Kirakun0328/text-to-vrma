"""Optional CPU regression check using already cached FuguMT weights only."""
import ast
import importlib.util
import os
from pathlib import Path
import unittest


def _analysis_translator(fake):
    """translate_for_analysis from server.py with a stand-in translator (no weights)."""
    import re
    source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
    wanted = {"JP_RE", "_SENTENCE_END", "translate_for_analysis"}
    nodes = [node for node in source.body if (isinstance(node, ast.FunctionDef) and node.name in wanted)
             or (isinstance(node, ast.Assign) and any(getattr(t, "id", None) in wanted for t in node.targets))]
    namespace = {"re": re, "_translator": fake}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
    return namespace["translate_for_analysis"]


class AnalysisTranslationTests(unittest.TestCase):
    def test_japanese_is_translated_one_sentence_at_a_time(self):
        calls = []
        translate = _analysis_translator(lambda text: calls.append(text) or f"<{text}>")
        self.assertEqual(translate("照れる。お礼を言う！"), "<照れる。> <お礼を言う！>")
        self.assertEqual(calls, ["照れる。", "お礼を言う！"])

    def test_english_passes_through_and_missing_translator_never_waits(self):
        self.assertEqual(_analysis_translator(lambda text: "x")("He waves."), "He waves.")
        self.assertIsNone(_analysis_translator(None)("手を振る"))


@unittest.skipUnless(importlib.util.find_spec("transformers"), "transformers is not installed")
class TranslationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch

        explicit = os.environ.get("FUGUMT_TEST_MODEL")
        cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
        snapshots = cache / "hub" / "models--staka--fugumt-ja-en" / "snapshots"
        candidates = [Path(explicit)] if explicit else list(snapshots.glob("*"))
        model_dir = next((path for path in candidates if (path / "config.json").exists()
                          and ((path / "pytorch_model.bin").exists() or (path / "model.safetensors").exists())), None)
        if model_dir is None:
            raise unittest.SkipTest("FuguMT is not cached locally; tests never download weights")
        source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
        nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "_load_translator"]
        import threading
        namespace = {"torch": torch, "TRANSLATOR_MODEL": str(model_dir), "_TRANSLATOR_LOCK": threading.Lock()}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
        namespace["_load_translator"]()
        if namespace["_translator_state"] != "ready":
            raise RuntimeError(namespace["_translator_state"])
        cls.translate = staticmethod(namespace["_translator"])

    def test_beam_search_preserves_in_place_locomotion(self):
        result = self.translate("その場で歩く").lower()
        self.assertIn("walk", result)
        self.assertRegex(result, r"spot|place")

    def test_direction_and_sequence_are_not_lost(self):
        hand = self.translate("左手を上げる").lower()
        self.assertIn("left", hand)
        self.assertIn("hand", hand)
        sequence = self.translate("椅子に座ってから立ち上がる").lower()
        self.assertIn("chair", sequence)
        self.assertIn("sit", sequence)
        self.assertRegex(sequence, r"stand|get up|rise")

    def test_ordinary_sentence_does_not_collapse_into_repeated_fragments(self):
        result = self.translate("こんにちは。私は日本人です。").lower()
        self.assertIn("japanese", result)
        self.assertLess(len(result.split()), 15)


if __name__ == "__main__":
    unittest.main()
