"""Paired native-condition evaluation; seeds apply only to this offline tool."""
import argparse
import json
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ardy-root", default="C:/text-to-motion-ardy-poc/ardy")
    parser.add_argument("--merged-base", default="C:/text-to-motion-ardy-poc/llm2vec-base-merged")
    parser.add_argument("--out", default="release/ardy-scope-conditioning-eval")
    parser.add_argument("--feature-file", help="Reuse this evaluation's saved caption embedding without loading the text encoder")
    parser.add_argument("--variants", nargs="+", choices=["native-full", "projection-only", "root-only"], default=["native-full", "projection-only"])
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = (root / args.out).resolve()
    target.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, args.ardy_root)
    sys.path.insert(0, str(root / "tools/ardy-engine"))
    sys.argv = ["server.py", "--merged-base", args.merged_base, "--no-translate"]
    import server
    import torch
    import motion_scope
    cached = None
    if args.feature_file:
        import importlib
        cached = torch.load(root / args.feature_file, map_location="cpu", weights_only=True)
        loader = importlib.import_module("ardy.model.load_model")
        loader.load_text_encoder = lambda **_: torch.nn.Identity()

    source = json.loads((root / "release/jev-intent-scope-eval/results.json").read_text(encoding="utf-8"))
    case = next(case for case in source["cases"] if case["id"] == "astra-order")
    segment = case["plans"][0]["value"]["segments"][0]
    server._boot()
    if not server.BOOT["ready"]:
        raise RuntimeError(server.BOOT["error"])
    if cached:
        if cached["text"] != segment["text"]:
            raise ValueError("cached feature does not match the evaluated caption")
        feature, pad = cached["feature"].to(server.DEVICE), cached["pad"].to(server.DEVICE)
    else:
        feature, pad = server.model._encode_text([segment["text"]])
    torch.save({"text": segment["text"], "feature": feature.cpu(), "pad": pad.cpu()}, target / "caption-feature.pt")
    server.model._encode_text = lambda texts: (feature, pad) if texts == [segment["text"]] else (_ for _ in ()).throw(ValueError("unexpected caption"))
    original_conditions = motion_scope.scope_conditions
    original_step = server.model.autoregressive_step
    raw = []

    def capture_step(**kwargs):
        samples = original_step(**kwargs)
        raw.append(samples)
        return samples

    server.model.autoregressive_step = capture_step
    report = {"seed": 20260921, "seedScope": "Offline evaluation only; production inference has no fixed seed.",
              "caption": segment["text"], "body": segment["body"], "duration": segment["duration"], "cases": []}

    def metrics(motion):
        decoded = server.model.motion_rep.inverse(motion, is_normalized=True)
        names = server.model.motion_rep.skeleton.bone_order_names
        hand = decoded["posed_joints"][0, :, names.index("LeftHand")]
        hips = decoded["root_positions"][0]
        relative = hand - hips
        return {"handPathM": float(torch.linalg.vector_norm(torch.diff(hand, dim=0), dim=-1).sum()),
                "handHeightAboveHipsMinM": float(relative[:, 1].min()),
                "handHeightAboveHipsMaxM": float(relative[:, 1].max()),
                "handZMinM": float(relative[:, 2].min()), "handZMaxM": float(relative[:, 2].max())}

    def dense_conditions(rep, reference, count):
        # Preserve the old dense-mask experiment independently of the current
        # production implementation, so this comparison remains reproducible.
        observed = rep(reference["local"].expand(-1, count, -1, -1, -1),
                       reference["root"].expand(-1, count, -1), to_normalize=True)
        mask = torch.zeros_like(observed)
        if not reference["owns_root"]:
            mask[..., rep.root_slice] = 1
        fixed = ~reference["owned"].clone()
        for index, parent in enumerate(rep.skeleton.joint_parents.tolist()):
            if parent >= 0:
                fixed[index] &= fixed[parent]
        rotations = mask[..., rep.slice_dict["global_rot_data"]].reshape(1, count, len(fixed), 6)
        rotations[..., fixed, :] = 1
        return observed * mask, mask

    for variant in args.variants:
        motion_scope.scope_conditions = {"native-full": dense_conditions,
                                        "projection-only": lambda *_: (None, None), "root-only": original_conditions}[variant]
        torch.manual_seed(report["seed"])
        torch.cuda.manual_seed_all(report["seed"])
        raw.clear()
        registry = server._rolling_sessions()
        sid = registry.create({"segments": [segment], "duration": segment["duration"], "steps": 8,
                               "planComplete": True, "plannerOwned": True})["sessionId"]
        started = time.perf_counter()
        result = registry.next(sid)
        elapsed = (time.perf_counter() - started) * 1000
        spec = {"name": variant, "duration": result["duration"], "loop": False,
                "tracks": result["tracks"], "hips": result["hips"]}
        (target / (variant + ".spec.json")).write_text(json.dumps(spec), encoding="utf-8")
        data = server.to_numpy(server.model.motion_rep.inverse(raw[0], is_normalized=True))
        raw_spec = server.spec_from_arrays(data["global_rot_mats"], data["root_positions"], server.FPS, variant + " raw", arm_spread_deg=6)
        (target / (variant + "-raw.spec.json")).write_text(json.dumps(raw_spec), encoding="utf-8")
        item = {"id": variant, "elapsedMs": round(elapsed, 2), "raw": metrics(raw[0]),
                "projected": metrics(registry.sessions[sid].motion)}
        report["cases"].append(item)
        print(json.dumps(item), flush=True)
        registry.close(sid)
    (target / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    motion_scope.scope_conditions = original_conditions


if __name__ == "__main__":
    main()
