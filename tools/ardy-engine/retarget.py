# ardy2spec.py — ARDY生成npz (cskel27) を text-to-vrma のモーションspec JSONに変換する
#
# 使い方: python ardy2spec.py input.npz output.json [--fps-div N]
#
# 前提 (検証済み):
#  - ARDY Core スケルトンのFKは「恒等回転 = Tポーズ」規約、ワールドはY-up / +Z正面 / +Xが左手側
#  - アプリ側 (src/vrmaBuilder.js) のVRMAレスト骨格も同一規約 (Tポーズ、回転なしノード)
#  → グローバル回転がそのまま転写でき、VRMボーンのローカル回転は
#     R_local(b) = R_global(coreParent)^T @ R_global(core) で得られる
import argparse
import json

import numpy as np
from scipy.spatial.transform import Rotation as R

# cskel27 の関節順 (ardy.skeleton.definitions.CoreSkeleton27.bone_order_names_with_parents)
CORE_JOINTS = [
    "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
]
CORE_IDX = {n: i for i, n in enumerate(CORE_JOINTS)}

# VRMボーン → (対応Core関節, VRM親ボーン)。親子はアプリのSKELETON定義に合わせる
VRM_MAP = {
    "hips":          ("Hips", None),
    "spine":         ("Spine", "hips"),
    "chest":         ("Spine1", "spine"),
    "upperChest":    ("Spine3", "chest"),      # Spine2はスキップ (回転は合成される)
    "neck":          ("Neck", "upperChest"),
    "head":          ("Head", "neck"),
    "leftShoulder":  ("LeftShoulder", "upperChest"),
    "leftUpperArm":  ("LeftArm", "leftShoulder"),
    "leftLowerArm":  ("LeftForeArm", "leftUpperArm"),
    "leftHand":      ("LeftHand", "leftLowerArm"),
    "rightShoulder": ("RightShoulder", "upperChest"),
    "rightUpperArm": ("RightArm", "rightShoulder"),
    "rightLowerArm": ("RightForeArm", "rightUpperArm"),
    "rightHand":     ("RightHand", "rightLowerArm"),
    "leftUpperLeg":  ("LeftUpLeg", "hips"),
    "leftLowerLeg":  ("LeftLeg", "leftUpperLeg"),
    "leftFoot":      ("LeftFoot", "leftLowerLeg"),
    "rightUpperLeg": ("RightUpLeg", "hips"),
    "rightLowerLeg": ("RightLeg", "rightUpperLeg"),
    "rightFoot":     ("RightFoot", "rightLowerLeg"),
}

CORE_REST_HIPS_HEIGHT = 0.896  # cskel27 neutral: Hips→Foot の高さ
APP_HIPS_HEIGHT = 0.9          # vrmaBuilder.js HIPS_HEIGHT


def convert(npz_path: str, fps_div: int = 1) -> dict:
    data = np.load(npz_path, allow_pickle=False)
    return spec_from_arrays(
        data["global_rot_mats"],
        data["root_positions"],
        float(data["fps"]),
        str(data["text"]) if "text" in data else "ardy motion",
        fps_div,
    )


# 上腕を外側に開くオフセット (度)。リアル体型のモーキャプをアニメ体型に当てると
# 腕が胴・服にめり込みやすいため、リターゲット時に少し開いて回避する
ARM_SPREAD_SIGN = {"leftUpperArm": 1.0, "rightUpperArm": -1.0}


def _rz(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def spec_from_arrays(
    global_rot_mats, root_positions, fps: float, text: str, fps_div: int = 1,
    arm_spread_deg: float = 0.0, t_offset: float = 0.0,
) -> dict:
    glob = np.asarray(global_rot_mats, dtype=np.float64)  # [T, J, 3, 3]
    root = np.asarray(root_positions, dtype=np.float64)   # [T, 3]

    if glob.ndim == 5:  # 念のためバッチ次元を潰す
        glob, root = glob[0], root[0]
    T = glob.shape[0]
    frames = range(0, T, fps_div)
    scale = APP_HIPS_HEIGHT / CORE_REST_HIPS_HEIGHT

    tracks = {bone: [] for bone in VRM_MAP}
    hips_pos = []
    for f in frames:
        t = round(t_offset + f / fps, 4)
        G = glob[f]  # [J,3,3]
        for bone, (core, parent) in VRM_MAP.items():
            Rg = G[CORE_IDX[core]]
            if parent is None:
                Rl = Rg
            else:
                pcore = VRM_MAP[parent][0]
                Rl = G[CORE_IDX[pcore]].T @ Rg
            if arm_spread_deg and bone in ARM_SPREAD_SIGN:
                # 肩フレーム基準で腕全体を外側へ回す (左=+Z, 右=-Z)
                Rl = _rz(ARM_SPREAD_SIGN[bone] * arm_spread_deg) @ Rl
            # THREE.Euler 'XYZ' (= Rx@Ry@Rz) に一致する intrinsic XYZ
            e = R.from_matrix(Rl).as_euler("XYZ", degrees=True)
            tracks[bone].append({"t": t, "r": [round(v, 2) for v in e]})
        p = root[f] * scale
        hips_pos.append({
            "t": t,
            "p": [round(p[0], 4), round(p[1] - APP_HIPS_HEIGHT, 4), round(p[2], 4)],
        })

    duration = round(t_offset + (T - 1) / fps, 4)
    return {
        "name": text[:60],
        "duration": duration,
        "loop": False,
        "tracks": tracks,
        "hips": hips_pos,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("npz")
    ap.add_argument("out_json")
    ap.add_argument("--fps-div", type=int, default=1, help="フレーム間引き係数 (1=全フレーム)")
    args = ap.parse_args()
    spec = convert(args.npz, args.fps_div)
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False)
    n_keys = sum(len(v) for v in spec["tracks"].values())
    print(f"OK: {args.out_json}  duration={spec['duration']}s  bones={len(spec['tracks'])}  keys={n_keys}")


if __name__ == "__main__":
    main()
