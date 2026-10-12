"""Compare fresh H40/H8 inference with one shared CPU text encoder.

Prepare with `node tools/ardy-horizon-compare.mjs --prepare`, coordinate GPU use,
then run this script using the existing ARDY venv and PYTHONPATH. Model defaults,
the live server and its cache are never changed. Fixed seeds are only controls
for this experiment; every case invokes fresh inference and fresh text encoding.
"""
import argparse
import ast
import importlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "release" / "ardy-horizon-comparison"
MODELS = ["ARDY-Core-RP-20FPS-Horizon40", "ARDY-Core-RP-20FPS-Horizon8"]
CASES = [
    {"id": "walk", "segments": [("A person walks in place, alternating steps with natural arm swing.", 4)], "history": 4},
    {"id": "wave", "segments": [("A person repeatedly waves their right hand.", 4)], "history": 4},
    {"id": "clap", "segments": [("A person repeatedly claps their hands together.", 4)], "history": 4},
    {"id": "bow", "segments": [("A person bows once and returns upright.", 4)], "history": 40},
    {"id": "jump", "segments": [("A person jumps once and lands on both feet.", 4)], "history": 40},
    {"id": "switch", "segments": [("A person walks forward.", 2), ("A person bows once.", 2)], "history": 4},
]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merged-base", default="C:/text-to-motion-ardy-poc/llm2vec-base-merged")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seeds", type=int, nargs="+", default=[7, 17])
    parser.add_argument("--cases", nargs="+", choices=[case["id"] for case in CASES])
    parser.add_argument("--models", nargs="+", choices=MODELS, default=MODELS)
    return parser.parse_args()


def stream_function(model, torch, device):
    # Reuse the current server's exact sampling/window loop without importing its
    # executable server entry point or starting another background service.
    source = ast.parse((ROOT / "tools" / "ardy-engine" / "server.py").read_text(encoding="utf-8"))
    names = {"_resolve_history_frames", "_generate_motion_streaming"}
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(nodes) != len(names):
        raise RuntimeError("Server streaming helpers changed; review benchmark before use")
    namespace = dict(model=model, torch=torch, DEVICE=device, PATCH=model.num_frames_per_token,
                     HISTORY=40, _max_window=int(model.motion_rep.fps * 10), PROGRESS={})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server-streaming-benchmark", "exec"), namespace)
    return namespace["_generate_motion_streaming"]


class MeasuredModel:
    def __init__(self, model, torch):
        self.model, self.torch = model, torch
        self.encodes, self.inferences = [], []

    def __getattr__(self, name):
        return getattr(self.model, name)

    def synchronize(self):
        self.torch.cuda.synchronize()

    def _encode_text(self, texts):
        self.synchronize()
        start = time.perf_counter()
        value = self.model._encode_text(texts)
        self.synchronize()
        self.encodes.append({"text": texts[0], "ms": (time.perf_counter() - start) * 1000})
        return value

    def autoregressive_step(self, **kwargs):
        self.synchronize()
        start = time.perf_counter()
        value = self.model.autoregressive_step(**kwargs)
        self.synchronize()
        self.inferences.append({"windowFrames": kwargs["num_frames"], "ms": (time.perf_counter() - start) * 1000})
        return value


def diagnostics(np, local, root, joints, horizon, fps):
    # These are kinematic diagnostics, not a semantic correctness/naturalness score.
    relative = np.swapaxes(local[:-1], -1, -2) @ local[1:]
    angle = np.degrees(np.arccos(np.clip((np.trace(relative, axis1=-2, axis2=-1) - 1) / 2, -1, 1)))
    boundary = np.arange(1, local.shape[0]) % horizon == 0
    names = {"hips": 0, "head": 6, "rightUpperArm": 8, "rightHand": 10, "leftUpperArm": 14,
             "leftHand": 16, "rightUpperLeg": 19, "rightLowerLeg": 20, "leftUpperLeg": 23, "leftLowerLeg": 24}
    metrics = {}
    for name, index in names.items():
        steps = angle[:, index]
        metrics[name] = {"firstSecondMeanSpeedDegS": float(np.mean(steps[:int(fps)]) * fps),
                         "lastSecondMeanSpeedDegS": float(np.mean(steps[-int(fps):]) * fps),
                         "p95StepDeg": float(np.percentile(steps, 95)),
                         "maxBoundaryStepDeg": float(np.max(steps[boundary])) if np.any(boundary) else None}
    feet = joints[:, [21, 25]]
    floor = np.percentile(feet[:, :, 1], 5)
    near_floor = feet[:-1, :, 1] < floor + .04
    foot_speed = np.linalg.norm(np.diff(feet[:, :, [0, 2]], axis=0), axis=-1) * fps
    return {"joints": metrics, "rootRangeM": np.ptp(root, axis=0).tolist(),
            "estimatedNearFloorFootSpeedMps": float(np.mean(foot_speed[near_floor])) if np.any(near_floor) else None,
            "footHeightRangeM": np.ptp(feet[:, :, 1], axis=0).tolist(),
            "bothFeetAboveFloor8cmFrames": int(np.sum(np.all(feet[:, :, 1] > floor + .08, axis=1))),
            "finite": bool(np.all(np.isfinite(local)) and np.all(np.isfinite(root)))}


def run():
    args = parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT):
        raise ValueError("Benchmark artifacts must stay inside this workspace")
    if args.steps < 1 or args.steps > 100:
        raise ValueError("steps must be in [1, 100]")
    # All model/adapter files must have been prepared already. No background HF
    # download, token lookup, live service restart or default model change occurs.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["LOCAL_CACHE"] = "true"
    os.environ["TEXT_ENCODER_DEVICE"] = "cpu"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ.pop("CHECKPOINTS_DIR", None)
    import numpy as np
    import torch
    from ardy.model import load_model
    from ardy.model.load_model import load_text_encoder
    from ardy.skeleton.kinematics import fk
    from ardy.tools import seed_everything
    sys.path.insert(0, str(ROOT / "tools" / "ardy-engine"))
    from retarget import spec_from_arrays
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this comparison")
    output.mkdir(parents=True, exist_ok=True)
    loader = importlib.import_module("ardy.model.load_model")
    loader.TEXT_ENCODER_PRESETS["llm2vec"]["kwargs"]["base_model_name_or_path"] = args.merged_base
    report = {"recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "status": "running",
              "device": torch.cuda.get_device_name(), "steps": args.steps, "cfg": 3.0,
              "postprocess": False, "sharedCpuEncoder": True, "seeds": args.seeds,
              "limitations": "ARDY-only timings exclude Codex/Jev/network. Fixed seeds control comparisons; all motions and text embeddings are newly computed. Kinematic metrics cannot establish semantic fidelity or naturalness.",
              "modelLoads": [], "cases": []}
    save = lambda: (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    start = time.perf_counter()
    encoder = load_text_encoder(mode="local", device="cpu")
    report["encoderLoadMs"] = (time.perf_counter() - start) * 1000
    models = {}
    for name in args.models:
        local = output / "checkpoints" / name
        start = time.perf_counter()
        model = load_model(name, device="cuda:0", text_encoder=encoder,
                           checkpoints_dir=str(local.parent) if local.is_dir() else None)
        models[name] = model
        report["modelLoads"].append({"model": name, "ms": (time.perf_counter() - start) * 1000,
                                     "horizon": model.gen_horizon_len, "patch": model.num_frames_per_token,
                                     "fps": model.motion_rep.fps})
        # Warmup is recorded separately and excluded from candidate results.
        probe = MeasuredModel(model, torch)
        with torch.no_grad():
            seed_everything(0)
            stream_function(probe, torch, "cuda:0")([("A person moves.", model.gen_horizon_len)], args.steps, low_latency=True, history_frames=4)
        report["modelLoads"][-1]["warmupEncodeMs"] = sum(item["ms"] for item in probe.encodes)
        report["modelLoads"][-1]["warmupInferenceMs"] = sum(item["ms"] for item in probe.inferences)
        save()
    selected = [case for case in CASES if not args.cases or case["id"] in args.cases]
    for case_index, case in enumerate(selected):
        for seed_index, seed in enumerate(args.seeds):
            # Alternate model order to reduce systematic thermal/order bias.
            order = args.models if (case_index + seed_index) % 2 == 0 else list(reversed(args.models))
            for name in order:
                model = models[name]
                probe = MeasuredModel(model, torch)
                fps, patch = model.motion_rep.fps, model.num_frames_per_token
                segments = [(text, max(patch, int(seconds * fps) // patch * patch)) for text, seconds in case["segments"]]
                record = {"id": case["id"], "model": name, "seed": seed, "history": case["history"],
                          "segments": case["segments"], "chunks": []}
                report["cases"].append(record)
                start = time.perf_counter()
                def chunk(motion, previous, total):
                    probe.synchronize()
                    record["chunks"].append({"frames": int(motion.shape[1]), "elapsedMs": (time.perf_counter() - start) * 1000})
                    if len(record["chunks"]) == 1:
                        first = model.motion_rep.inverse(motion, is_normalized=True)
                        first_global, _, _ = fk(first["local_rot_mats"], first["root_positions"], model.skeleton)
                        first_spec = spec_from_arrays(first_global[0].cpu().numpy(), first["root_positions"][0].cpu().numpy(),
                                                      fps, segments[0][0], arm_spread_deg=6)
                        json.dumps(first_spec)
                        record["firstSpecMs"] = (time.perf_counter() - start) * 1000
                try:
                    with torch.no_grad():
                        seed_everything(seed)
                        motion = stream_function(probe, torch, "cuda:0")(segments, args.steps, cfg=3.0,
                            low_latency=True, history_frames=case["history"], on_chunk=chunk)
                        decoded = model.motion_rep.inverse(motion, is_normalized=True)
                        global_rotations, joint_positions, _ = fk(decoded["local_rot_mats"], decoded["root_positions"], model.skeleton)
                        probe.synchronize()
                    record.update(firstChunkMs=record["chunks"][0]["elapsedMs"],
                                  inferenceAndDecodeMs=(time.perf_counter() - start) * 1000,
                                  encodeMs=sum(item["ms"] for item in probe.encodes),
                                  firstInferMs=probe.inferences[0]["ms"], inferences=probe.inferences,
                                  encodes=probe.encodes)
                    steady = [item["ms"] for item in probe.inferences[1:]]
                    record["steadyInferMsMean"] = sum(steady) / len(steady) if steady else None
                    record["horizonMs"] = model.gen_horizon_len / fps * 1000
                    record["steadyInferenceBudgetRatio"] = record["steadyInferMsMean"] / record["horizonMs"] if steady else None
                    local_np = decoded["local_rot_mats"][0].cpu().numpy()
                    root_np = decoded["root_positions"][0].cpu().numpy()
                    joints_np = joint_positions[0].cpu().numpy()
                    record["metrics"] = diagnostics(np, local_np, root_np, joints_np, model.gen_horizon_len, fps)
                    filename = f"{case['id']}-h{model.gen_horizon_len}-s{seed}.spec.json"
                    spec = spec_from_arrays(global_rotations[0].cpu().numpy(), root_np, fps, " / ".join(text for text, _ in case["segments"]), arm_spread_deg=6)
                    (output / filename).write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
                    record.update(spec=filename, status="completed", totalMs=(time.perf_counter() - start) * 1000)
                except Exception as error:
                    record.update(status="failed", error=f"{type(error).__name__}: {error}")
                save()
                print(json.dumps({key: record.get(key) for key in ["id", "model", "seed", "status", "firstChunkMs", "firstSpecMs", "encodeMs", "firstInferMs", "steadyInferMsMean", "steadyInferenceBudgetRatio", "totalMs", "error"]}), flush=True)
    report["status"] = "completed" if all(case["status"] == "completed" for case in report["cases"]) else "failed"
    save()


if __name__ == "__main__":
    run()
