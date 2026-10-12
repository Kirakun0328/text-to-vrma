"""Offline paired experiments; never changes production seeds or model settings."""
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "release/ardy-caption-start-eval"
OUT.mkdir(parents=True, exist_ok=True)
sys.path[:0] = ["C:/text-to-motion-ardy-poc/ardy", str(ROOT / "tools/ardy-engine")]
sys.argv = ["server.py", "--merged-base", "C:/text-to-motion-ardy-poc/llm2vec-base-merged", "--no-translate"]
import server
import torch
from motion_scope import scope_reference

server._boot()
if not server.BOOT["ready"]:
    raise RuntimeError(server.BOOT["error"])
groups = ["root", "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"]
cases = [
    ("walk", "A person walks in place with alternating steps and natural opposing arm swings, without traveling.", "A person walks in place.", groups, True),
    ("crouch", "A person slowly bends their hips and knees into a squat while keeping both feet planted and inclining their torso forward for balance.", "A person slowly squats down.", groups, False),
    ("wave", "A person raises the left hand, waves it once from side to side, and lowers it, keeping the right arm down.", "A person waves their left hand once, then lowers it.", ["leftArm"], False),
]
original_encode, original_step = server.model._encode_text, server.model.autoregressive_step
report = {"seed": 20260921, "seedScope": "Paired evaluation only, not production.",
          "limits": "One seed per caption, fixed steps/model; timings include CPU text encoding and cold/warm differences. Evaluate saved poses before quality claims.", "cases": []}

def measures(motion):
    data = server.model.motion_rep.inverse(motion, is_normalized=True)
    positions = data["posed_joints"][0]
    names = server.model.motion_rep.skeleton.bone_order_names
    hips = data["root_positions"][0]
    result = {"rootRangeM": (hips.max(0).values - hips.min(0).values).tolist(),
              "hipChangeM": float(hips[-1, 1] - hips[0, 1])}
    for name in ["LeftHand", "RightHand", "LeftFoot", "RightFoot"]:
        p = positions[:, names.index(name)]
        result[name] = {"pathM": float(torch.linalg.vector_norm(p.diff(dim=0), dim=-1).sum()),
                        "maxHeightAboveHipsM": float((p[:, 1] - hips[:, 1]).max()),
                        "minHeightM": float(p[:, 1].min()), "maxHeightM": float(p[:, 1].max())}
    return result

with torch.no_grad():
    ref = scope_reference(server.model.motion_rep, [], None)
    start_pose = server.model.motion_rep(ref["local"].expand(-1, server.PATCH, -1, -1, -1),
                                        ref["root"].expand(-1, server.PATCH, -1), to_normalize=True)
    for name, verbose, concise, body, continuous in cases:
        embeddings = {}
        for text in [verbose, concise]:
            before = time.perf_counter()
            embeddings[text] = original_encode([text])
            print(json.dumps({"encoded": name, "textLength": len(text), "ms": (time.perf_counter() - before) * 1000}), flush=True)
        for variant in ["verbose", "concise", "concise-primed"]:
            text = verbose if variant == "verbose" else concise
            server.model._encode_text = lambda texts: embeddings[texts[0]]
            def step(**kwargs):
                if variant == "concise-primed" and kwargs["init_history_sequence"] is None:
                    kwargs.update(num_frames=kwargs["num_frames"] + server.PATCH,
                                  init_history_sequence=start_pose, init_global_translation=None,
                                  init_first_heading_angle=None)
                    # Mask arrays belong to the original horizon; prepend the
                    # same held-root conditions for the extra history patch.
                    for field in ["motion_mask", "observed_motion"]:
                        if kwargs[field] is not None:
                            kwargs[field] = torch.cat([kwargs[field][:, :server.PATCH], kwargs[field]], dim=1)
                    return original_step(**kwargs)[:, server.PATCH:]
                return original_step(**kwargs)
            server.model.autoregressive_step = step
            torch.manual_seed(report["seed"])
            torch.cuda.manual_seed_all(report["seed"])
            registry = server._rolling_sessions()
            segment = {"text": text, "duration": 6, "continuous": continuous, "body": body}
            sid = registry.create({"segments": [segment], "duration": 6, "steps": 8,
                                   "plannerOwned": True, "planComplete": True})["sessionId"]
            spec = {"name": name + "-" + variant, "duration": 0, "loop": False, "tracks": {}, "hips": []}
            before = time.perf_counter()
            while True:
                event = registry.next(sid)
                if event["type"] != "chunk":
                    raise RuntimeError(event)
                for bone, keys in event["tracks"].items():
                    spec["tracks"].setdefault(bone, []).extend(keys)
                spec["hips"].extend(event["hips"])
                spec["duration"] = event["duration"]
                if event["complete"]:
                    break
            spec_file = spec["name"] + ".spec.json"
            (OUT / spec_file).write_text(json.dumps(spec), encoding="utf-8")
            entry = {"id": spec["name"], "text": text, "status": "passed", "specFile": spec_file,
                     "plans": [{"value": {"segments": [segment]}}],
                     "elapsedMs": (time.perf_counter() - before) * 1000,
                     "metrics": measures(registry.sessions[sid].motion)}
            report["cases"].append(entry)
            (OUT / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(entry), flush=True)
            registry.close(sid)
server.model._encode_text, server.model.autoregressive_step = original_encode, original_step
