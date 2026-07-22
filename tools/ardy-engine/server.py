# server.py — ARDY ローカルエンジンサーバー (text-to-vrma 用)
#
# NVIDIA ARDY (Autoregressive Diffusion for Interactive Motion) を常駐させ、
# アプリからHTTPで叩けるようにする。日本語プロンプトはローカル翻訳 (FuguMT) で自動英訳。
#
# 起動例:
#   python server.py --merged-base C:\path\to\llm2vec-base-merged
#   (テキストエンコーダをCPUで動かす場合は環境変数 TEXT_ENCODER_DEVICE=cpu)
#
# API:
#   GET  /health   → {"status":"ok","model":...,"translator":...}
#   POST /generate body: {"text":"...", "duration":5.0, "seed":0(省略可)}
#                  → モーションspec JSON (buildVRMA互換)。日本語入力時は
#                    spec.name が英訳、spec.originalText に原文が入る
import argparse
import importlib
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JP_RE = re.compile(r"[぀-ヿ一-鿿]")
TRANSLATOR_MODEL = "staka/fugumt-ja-en"


def parse_args():
    ap = argparse.ArgumentParser(description="ARDY local engine server for text-to-vrma")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ARDY_PORT", 2337)))
    ap.add_argument("--model", default="ARDY-Core-RP-20FPS-Horizon40")
    ap.add_argument(
        "--merged-base",
        default=os.environ.get("ARDY_MERGED_BASE", ""),
        help="mntpマージ済みLlama-3-8Bのローカルパス (未指定なら公式gatedリポジトリ経由)",
    )
    ap.add_argument("--no-translate", action="store_true", help="日本語自動英訳を無効化")
    ap.add_argument(
        "--arm-spread", type=float, default=6.0,
        help="上腕を外側に開くオフセット (度)。アニメ体型への腕のめり込み対策 (既定: 6)",
    )
    ap.add_argument(
        "--history", type=int, default=40,
        help="自己回帰の履歴フレーム数。長いと文脈が滑らかだが、動きの慣性が勝って"
             "テキスト追従が落ちる (NVIDIAデモの既定は最小=4)。既定: 40",
    )
    return ap.parse_args()


ARGS = parse_args()

# --- 起動状態 ---
# モデル読み込みは _boot() が別スレッドで行う。これによりサーバーは起動直後から
# HTTPで応答でき、GET /health が読み込み進捗 (%) を返せる
BOOT = {"ready": False, "stage": "libs", "fraction": 0.01, "error": None}
GEN_LOCK = threading.Lock()


def _watch_encoder_rss(start_frac, end_frac, expected_bytes):
    """エンコーダ読み込み中、プロセスのメモリ増加量から実進捗を推定してBOOTに反映する"""
    def run():
        try:
            import psutil
            proc = psutil.Process()
            base = proc.memory_info().rss
            while BOOT["stage"] == "encoder":
                grown = proc.memory_info().rss - base
                frac = start_frac + (end_frac - start_frac) * min(1.0, max(0.0, grown / expected_bytes))
                BOOT["fraction"] = max(BOOT["fraction"], min(frac, end_frac - 0.01))
                time.sleep(1)
        except Exception:  # noqa: BLE001 (psutil無し等でも起動は続行)
            pass
    threading.Thread(target=run, daemon=True).start()


def _boot():
    """重いimportとモデル読み込み (プロセスで1回)。進捗は BOOT → GET /health で見える"""
    global torch, np, SciRot, Root2DConstraintSet, load_model, post_process_motion
    global fk, seed_everything, to_numpy, spec_from_arrays
    global DEVICE, model, FPS, PATCH, NUM_BASE_STEPS, HISTORY, _max_window
    try:
        print("loading ARDY model... (first time: 1-2 min)", flush=True)
        import torch

        if ARGS.merged_base:
            lm = importlib.import_module("ardy.model.load_model")
            lm.TEXT_ENCODER_PRESETS["llm2vec"]["kwargs"]["base_model_name_or_path"] = ARGS.merged_base

        import numpy as np
        from scipy.spatial.transform import Rotation as SciRot

        from ardy.constraints import Root2DConstraintSet
        from ardy.model import load_model
        from ardy.postprocess import post_process_motion
        from ardy.skeleton.kinematics import fk
        from ardy.tools import seed_everything, to_numpy

        from retarget import spec_from_arrays

        DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

        # ardy側の load_text_encoder は最後に .to(model_device) するため、そのままだと
        # TEXT_ENCODER_DEVICE=cpu の指定が上書きされる (8Bエンコーダが VRAM ~15GB を占有)。
        # 指定がある場合はエンコーダを先に目的デバイスで構築して load_model に渡す
        BOOT["stage"] = "encoder"
        BOOT["fraction"] = 0.05
        _watch_encoder_rss(0.05, 0.80, 17 * 1024 ** 3)  # 8Bエンコーダ ≒ 16GB
        _enc_dev = os.environ.get("TEXT_ENCODER_DEVICE", "").strip().lower()
        _pre_encoder = None
        if _enc_dev:
            try:
                from ardy.model.load_model import load_text_encoder
                _pre_encoder = load_text_encoder(device=_enc_dev)
            except (ImportError, AttributeError):
                _pre_encoder = None  # 旧版ardy: 下の保険で移動する

        BOOT["stage"] = "ardy"
        BOOT["fraction"] = max(BOOT["fraction"], 0.82)
        if _pre_encoder is not None:
            model = load_model(ARGS.model, device=DEVICE, text_encoder=_pre_encoder)
        else:
            model = load_model(ARGS.model, device=DEVICE)

        # 保険: それでもエンコーダが指定と違うデバイスに居たら移し直す
        if _enc_dev and getattr(model, "text_encoder", None) is not None:
            model.text_encoder.to(_enc_dev)
            if DEVICE.startswith("cuda") and _enc_dev == "cpu":
                torch.cuda.empty_cache()
        FPS = model.motion_rep.fps
        PATCH = model.num_frames_per_token
        NUM_BASE_STEPS = int(model.diffusion.num_base_steps)
        # 履歴上限 (訓練10秒窓 - ホライズン)。実際の履歴長は --history (既定40) で制御
        _max_window = (int(10 * FPS) // PATCH) * PATCH
        _history_cap = ((_max_window - model.gen_horizon_len) // PATCH) * PATCH
        HISTORY = max(PATCH, min(_history_cap, (ARGS.history // PATCH) * PATCH))
        BOOT["stage"] = "ready"
        BOOT["fraction"] = 1.0
        BOOT["ready"] = True
        print(f"ready: {ARGS.model} on {DEVICE} ({FPS} fps)", flush=True)
        # 翻訳モデルは本体の準備完了後にバックグラウンドでロードする
        if not ARGS.no_translate:
            threading.Thread(target=_load_translator, daemon=True).start()
    except Exception as e:  # noqa: BLE001
        BOOT["error"] = str(e)
        BOOT["stage"] = "error"
        print(f"boot failed: {e}", flush=True)

# --- 日本語→英語翻訳 (FuguMT、バックグラウンドでロード) ---
_translator = None
_translator_state = "disabled" if ARGS.no_translate else "loading"


def _load_translator():
    # transformers 5.x では translation パイプラインが廃止されたため、MarianMTを直接使う
    global _translator, _translator_state
    try:
        from transformers import MarianMTModel, MarianTokenizer

        tok = MarianTokenizer.from_pretrained(TRANSLATOR_MODEL)
        mt = MarianMTModel.from_pretrained(TRANSLATOR_MODEL)
        mt.eval()

        def translate(text: str) -> str:
            batch = tok([text], return_tensors="pt", truncation=True, max_length=256)
            with torch.no_grad():
                out = mt.generate(**batch, max_length=256, num_beams=4)
            return tok.decode(out[0], skip_special_tokens=True)

        _translator = translate
        _translator_state = "ready"
        print(f"translator ready: {TRANSLATOR_MODEL}", flush=True)
    except Exception as e:  # noqa: BLE001
        _translator_state = f"error: {e}"
        print(f"translator failed to load: {e}", flush=True)


# (翻訳モデルのロードは _boot() の完了後にバックグラウンドで開始される)


def maybe_translate(text: str):
    """日本語を含むテキストを英訳して (english, original|None) を返す。"""
    if not JP_RE.search(text):
        return text, None
    if _translator is None:
        if _translator_state == "loading":
            # 初回リクエストがロードと競合した場合は最大60秒待つ
            for _ in range(60):
                if _translator is not None or _translator_state.startswith("error"):
                    break
                time.sleep(1)
        if _translator is None:
            raise RuntimeError(f"日本語翻訳を利用できません ({_translator_state})")
    english = _translator(text).strip()
    print(f"translated: '{text}' -> '{english}'", flush=True)
    return english, text


# 自動判定 (estimate_duration) の上限。手動指定にはこの上限は適用しない
AUTO_MAX_DURATION = 60.0
# 手動指定の安全上限 (秒)。実質無制限だが、誤入力による極端な生成
# (時間・メモリの暴走) を防ぐための最終ガードとして残す
MAX_DURATION = 3600.0

# --- 進捗トラッキング ---
# stage: translate (翻訳・エンコード) → generate (チャンク生成、fractionが本当の進捗) → finalize (変換)
PROGRESS = {"active": False, "stage": "", "started": 0.0, "fraction": 0.0, "text": ""}


def estimate_duration(english: str, original: str | None) -> float:
    """プロンプト内容からモーション長 (秒) を推定する。"""
    t = english.lower()
    base = 5.0
    # 連続動作 (「〜してから〜」等) は接続表現の数だけ延長
    seq = len(re.findall(r"\b(then|after that|afterwards|next|followed by)\b|,| and ", t))
    base += 3.0 * min(seq, 6)
    # 移動・リズム系はサイクルを見せるため長めに
    if re.search(r"danc|run|jog|walk|march|stroll|wander|sneak|stagger", t):
        base += 4.0
    if re.search(r"in a circle|around|back and forth|repeatedly|keep", t):
        base += 3.0
    if re.search(r"slowly|slow|gradually", t):
        base += 2.0
    # 単発ジェスチャは短く
    if seq == 0 and re.search(r"^\s*(a person )?(wave|bow|nod|clap|salute|point)s?\b", t):
        base = 3.5
    return max(3.0, min(AUTO_MAX_DURATION, base))


VRM_SCALE = 0.9 / 0.896  # retarget.py と同じ (アプリ座標 = Core座標 × scale)


def build_waypoint_conditions(waypoints, num_frames):
    """クリック経由地 [{x,z}...] をARDYのルート2D制約に変換する。

    時刻はパスの累積距離に比例して 1秒〜終端-0.5秒 に配分する。
    Returns (observed_motion, motion_mask) — フル長 [1, T, F]。
    """
    pts = [(float(w["x"]) / VRM_SCALE, float(w["z"]) / VRM_SCALE) for w in waypoints]
    dists = [0.0]
    prev = (0.0, 0.0)  # キャラは原点から出発
    for p in pts:
        dists.append(dists[-1] + ((p[0] - prev[0]) ** 2 + (p[1] - prev[1]) ** 2) ** 0.5)
        prev = p
    total = max(dists[-1], 1e-6)
    # 開始1秒後 〜 終端2秒前に距離比例で配分
    t0 = FPS
    t1 = max(t0 + PATCH, num_frames - 2 * FPS)
    frame_indices = [
        min(num_frames - 1, int(t0 + (t1 - t0) * (dists[i + 1] / total)))
        for i in range(len(pts))
    ]
    # 経路に沿って約1秒間隔の中間制約を追加 (位置は線形補間)。
    # 経由地の瞬間だけの制約だと、間の区間で後ろ向き・横向き移動の解が
    # 許されてしまうため、経路全体を密に誘導する
    dense_pts, dense_frames = [], []
    all_pts = [(0.0, 0.0)] + pts
    all_frames = [t0 // 2] + frame_indices
    for i in range(1, len(all_pts)):
        f_a, f_b = all_frames[i - 1], all_frames[i]
        p_a, p_b = all_pts[i - 1], all_pts[i]
        for f in range(f_a + FPS, f_b, FPS):
            w = (f - f_a) / max(1, f_b - f_a)
            dense_pts.append((p_a[0] + (p_b[0] - p_a[0]) * w, p_a[1] + (p_b[1] - p_a[1]) * w))
            dense_frames.append(f)
        if not dense_frames or f_b > dense_frames[-1]:
            dense_pts.append(p_b)
            dense_frames.append(f_b)
    pts, frame_indices = dense_pts, dense_frames
    # 最終経由地に「留まる」制約: 終端までルートを同じ位置にピン留めして、
    # モデル自身に減速→停止させる (これがないとテキスト通り歩き続けて
    # 歩行姿勢のままクリップが終わる)
    for f in (num_frames - FPS, num_frames - PATCH):
        if f > frame_indices[-1]:
            frame_indices.append(f)
            pts.append(pts[-1])
    # 向き (heading) の制約: 各経由地で「進行方向を向く」よう指定する。
    # 位置だけの制約だと後ろ向き・横向きに移動する解も許されてしまう
    headings = []
    for i in range(len(pts)):
        src = (0.0, 0.0) if i == 0 else pts[i - 1]
        dx, dz = pts[i][0] - src[0], pts[i][1] - src[1]
        if dx * dx + dz * dz < 1e-8:  # 停止ピンは直前の向きを維持
            headings.append(headings[-1] if headings else 0.0)
        else:
            headings.append(float(np.arctan2(dx, dz)))  # 0 = +Z正面
    constraint = Root2DConstraintSet(
        model.skeleton,
        frame_indices=torch.tensor(frame_indices),
        root_2d=torch.tensor(pts, dtype=torch.float32, device=DEVICE),
        global_root_heading=torch.tensor(headings, dtype=torch.float32, device=DEVICE),
    )
    lengths = torch.tensor([num_frames], device=DEVICE)
    observed, mask = model.motion_rep.create_conditions_from_constraints_batched(
        [constraint], lengths, to_normalize=True, device=DEVICE,
    )
    return observed, mask


def _locomotion_speed(english: str) -> float:
    """テキストから移動速度 (m/s) を推定する。経路制約のペース配分に使う。"""
    t = english.lower()
    if re.search(r"run|dash|sprint", t):
        return 2.5
    if re.search(r"jog", t):
        return 1.8
    if re.search(r"skip|hop", t):
        return 1.4
    if re.search(r"sneak|crawl|tip.?toe|creep|stagger", t):
        return 0.5
    return 1.0


def waypoint_duration(waypoints, speed: float = 1.0) -> float:
    """経由地の合計距離から所要時間を見積もる (開始1秒+移動+停止余白2秒)。"""
    prev, dist = (0.0, 0.0), 0.0
    for w in waypoints:
        p = (float(w["x"]), float(w["z"]))
        dist += ((p[0] - prev[0]) ** 2 + (p[1] - prev[1]) ** 2) ** 0.5
        prev = p
    return max(4.0, min(MAX_DURATION, dist / speed + 3.0))


def _generate_motion_streaming(
    segments: list, steps: int, observed=None, mask=None, on_chunk=None, cfg=2.0,
    progress_base=0.0, progress_span=1.0,
):
    """デモと同じチャンク逐次生成。セグメントごとにプロンプトを切り替える。

    バッチAPI (model.__call__) は各チャンクで残り全フレームを処理するため
    長尺で二次関数的に遅くなる。autoregressive_step で「履歴+1ホライズン」だけを
    処理すればコストは長さに比例し、チャンクごとに本当の進捗も取れる。
    プロンプトはチャンク開始フレームが属するセグメントのものを使う (ARDYの
    ストリーミングテキスト条件付けと同じ仕組み)。

    Args:
        segments: [(english_text, num_frames), ...]
    """
    horizon = model.gen_horizon_len
    feats = [model._encode_text([en]) for en, _ in segments]
    bounds = []  # セグメント開始フレーム
    acc = 0
    for _, nf in segments:
        bounds.append(acc)
        acc += nf
    num_frames = acc
    motion = None  # 正規化済みハイブリッドモーション [1, T, F]
    while motion is None or motion.shape[1] < num_frames:
        pos = 0 if motion is None else motion.shape[1]
        seg_idx = max(i for i, b in enumerate(bounds) if b <= pos)
        text_feat, text_pad_mask = feats[seg_idx]
        PROGRESS["text"] = segments[seg_idx][0]
        if motion is None:
            hist, hist_len = None, 0
            init_transl = torch.zeros(1, model.motion_rep.nfeats_dict["root_pos"], device=DEVICE)
            init_heading = torch.zeros(1, device=DEVICE)
        else:
            # セグメント切替直後は履歴を短くして新プロンプトへ素早く遷移させる
            # (長い履歴は直前の動きの慣性が勝ち、テキスト切替が効かない)。
            # 単一セグメントでは従来通り HISTORY まで履歴を使う
            frames_since_seg = pos - bounds[seg_idx]
            max_hist = min(HISTORY, frames_since_seg + PATCH * 2)
            hist_len = min(motion.shape[1], max_hist) // PATCH * PATCH
            hist_len = max(hist_len, PATCH)
            hist = motion[:, -hist_len:]
            init_transl, init_heading = None, None
        # 未来領域: 制約 (ウェイポイント等) を先読みさせるための空きトークン。
        # 訓練10秒窓に収める
        remaining = max(0, num_frames - (pos + horizon))
        future_len = min(remaining, _max_window - hist_len - horizon)
        future_len = max(0, future_len // PATCH * PATCH)
        window_frames = hist_len + horizon + future_len
        # ウェイポイント制約: 窓に対応する区間を切り出し、履歴部分は無効化
        # (デモ GenerationMixin._generate_step と同じ扱い)
        win_mask = win_observed = None
        if mask is not None:
            start = pos - hist_len
            win_mask = mask[:, start:start + window_frames].clone()
            win_observed = observed[:, start:start + window_frames].clone()
            if win_mask.shape[1] < window_frames:  # 終端で足りない分はゼロ埋め
                pad = window_frames - win_mask.shape[1]
                win_mask = torch.nn.functional.pad(win_mask, (0, 0, 0, pad))
                win_observed = torch.nn.functional.pad(win_observed, (0, 0, 0, pad))
            win_mask[:, :hist_len] = 0.0
            win_observed[:, :hist_len] = 0.0
        samples = model.autoregressive_step(
            num_frames=window_frames,
            num_denoising_steps=steps,
            motion_mask=win_mask,
            observed_motion=win_observed,
            cfg_weight=(cfg, 2.0),
            text_feat=text_feat,
            text_pad_mask=text_pad_mask,
            init_history_sequence=hist,
            init_global_translation=init_transl,
            init_first_heading_angle=init_heading,
        )
        new = samples[:, hist_len:]
        # チャンクをセグメント境界に整列: 境界を越えた分は捨てて、
        # 次のチャンクが新セグメントのプロンプトで境界ちょうどから始まるようにする
        next_bound = min((b for b in bounds if b > pos), default=num_frames)
        keep = max(PATCH, (next_bound - pos) // PATCH * PATCH) if next_bound - pos < new.shape[1] else new.shape[1]
        new = new[:, :keep]
        motion = new if motion is None else torch.cat([motion, new], dim=1)
        PROGRESS["fraction"] = min(0.99, progress_base + progress_span * motion.shape[1] / num_frames)
        if on_chunk is not None:
            end = min(motion.shape[1], num_frames)
            if end > pos:
                on_chunk(motion[:, pos:end], pos, num_frames)
    return motion[:, :num_frames]


def _hips_yaw(rot):
    """Hipsグローバル回転行列 [3,3] から水平面の向き (yaw, ラジアン) を取り出す。"""
    fwd = rot @ np.array([0.0, 0.0, 1.0])
    return float(np.arctan2(fwd[0], fwd[2]))


def _roty(angle):
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _generate_stitched(segments: list, steps: int, cfg: float):
    """セグメントごとに独立生成し、位置・向きを揃えて縫い合わせる。

    連続生成 (履歴引き継ぎ) は直前の動きの慣性が勝って新しい動作
    (ジャンプ等) が発火しないことがある。各セグメントを履歴なしで生成すると
    単体生成と同じ再現度になるため、終端の位置・向きに次セグメントを整列し、
    つなぎ目を短いクロスフェード (0.3秒) で滑らかにする。

    Returns:
        (local_rot_mats [T,J,3,3], root_positions [T,3], foot_contacts [T,...]) — numpy
    """
    BLEND = 6  # クロスフェードするフレーム数
    total = sum(nf for _, nf in segments)
    done = 0
    out_local = out_root = out_fc = None
    for en, nf in segments:
        PROGRESS["text"] = en
        motion = _generate_motion_streaming(
            [(en, nf)], steps, cfg=cfg,
            progress_base=done / total, progress_span=nf / total,
        )
        o = to_numpy(model.motion_rep.inverse(motion, is_normalized=True))
        local = np.asarray(o["local_rot_mats"])[0]
        root = np.asarray(o["root_positions"])[0]
        fc = np.asarray(o["foot_contacts"])[0]
        if out_local is None:
            out_local, out_root, out_fc = local.copy(), root.copy(), fc.copy()
        else:
            # 前セグメント終端の向き・位置に整列 (Y軸回転 + 平行移動)
            Ry = _roty(_hips_yaw(out_local[-1, 0]) - _hips_yaw(local[0, 0]))
            r0 = root[0].copy()
            r0[1] = 0.0
            root = (root - r0) @ Ry.T
            root[:, 0] += out_root[-1, 0]
            root[:, 2] += out_root[-1, 2]
            local = local.copy()
            local[:, 0] = np.einsum("ab,tbc->tac", Ry, local[:, 0])
            # つなぎ目のクロスフェード: 前終端ポーズから新セグメントへ滑らかに移行
            B = min(BLEND, local.shape[0] - 1)
            q_prev = SciRot.from_matrix(out_local[-1]).as_quat()  # [J,4]
            for i in range(B):
                w = (i + 1) / (B + 1)
                q_i = SciRot.from_matrix(local[i]).as_quat()
                dot = np.sum(q_i * q_prev, axis=1, keepdims=True)
                q_p = np.where(dot < 0, -q_prev, q_prev)
                q = (1 - w) * q_p + w * q_i
                q /= np.linalg.norm(q, axis=1, keepdims=True)
                local[i] = SciRot.from_quat(q).as_matrix()
                root[i, 1] = (1 - w) * out_root[-1, 1] + w * root[i, 1]
            out_local = np.concatenate([out_local, local])
            out_root = np.concatenate([out_root, root])
            out_fc = np.concatenate([out_fc, fc])
        done += nf
    return out_local, out_root, out_fc


# 「〜してから」等の日本語接続表現。GPTなしでもセグメント分割できるようにする
JP_SEQUENCE_RE = re.compile(r"てから|それから|そのあと|その後|、そして|。そして|、次に|。次に")


def _split_japanese_sequence(text: str):
    """日本語の連続動作表現を分割する。分割できなければ [text] を返す。"""
    parts = []
    rest = text
    while True:
        m = JP_SEQUENCE_RE.search(rest)
        if not m:
            break
        head = rest[: m.end()].rstrip("、。 ")
        if head:
            parts.append(head)
        rest = rest[m.end():].lstrip("、。 ")
    if rest.strip():
        parts.append(rest.strip())
    return parts if len(parts) > 1 else [text]


def _resolve_segments(text, duration, segments_req):
    """リクエストを [(english, num_frames), ...] と表示名に正規化する。"""
    if segments_req:
        segments, originals = [], []
        for seg in segments_req[:12]:
            seg_text = str(seg.get("text", "")).strip()
            if not seg_text:
                continue
            english, original = maybe_translate(seg_text)
            seg_dur = seg.get("duration") or estimate_duration(english, original)
            nf = max(PATCH, int(float(seg_dur) * FPS) // PATCH * PATCH)
            segments.append((english, nf))
            originals.append(original or english)
        if not segments:
            raise ValueError("segments に有効なテキストがありません")
        # 合計が安全上限を超える場合のみ比例縮小する (通常は指定どおり)
        total = sum(nf for _, nf in segments)
        max_frames = int(MAX_DURATION * FPS)
        if total > max_frames:
            ratio = max_frames / total
            segments = [(en, max(PATCH, int(nf * ratio) // PATCH * PATCH)) for en, nf in segments]
        name = " / ".join(en for en, _ in segments)
        return segments, name, None
    # GPT計画なしでも「〜してから」等の連続動作はセグメント分割する
    parts = _split_japanese_sequence(text.strip())
    if len(parts) > 1 and duration is None:
        return _resolve_segments(text, None, [{"text": p} for p in parts])
    english, original = maybe_translate(text.strip())
    if duration is None:
        duration = estimate_duration(english, original)
        print(f"auto duration: {duration:.1f}s for '{english[:50]}'", flush=True)
    # 下限は0.1秒 (実際は下の num_frames が最小PATCHフレーム=約0.2秒に丸める)
    duration = max(0.1, min(MAX_DURATION, float(duration)))
    num_frames = max(PATCH, int(duration * FPS) // PATCH * PATCH)
    return [(english, num_frames)], english, original


def generate_spec(
    text: str, duration=None, seed=None, steps=None, arm_spread=None, segments_req=None,
    postprocess=True, waypoints=None, on_chunk=None, cfg=None,
) -> dict:
    arm_spread = ARGS.arm_spread if arm_spread is None else max(0.0, min(20.0, float(arm_spread)))
    steps = int(steps) if steps else NUM_BASE_STEPS
    steps = max(1, min(NUM_BASE_STEPS, steps))
    # 既定CFG 3.0: 2.0より動作のテキスト追従が安定する (実測: 歩行速度の再現性向上)
    cfg = 3.0 if cfg is None else max(1.0, min(6.0, float(cfg)))
    with GEN_LOCK, torch.no_grad():
        PROGRESS.update(active=True, stage="translate", started=time.time(), fraction=0.0, text=text)
        try:
            segments, english, original = _resolve_segments(text, duration, segments_req)
            num_frames = sum(nf for _, nf in segments)
            # 経由地がある場合、経路を回りきれる長さまで比例拡大する。
            # 所要時間は動作の速度 (走る=2.5m/s、歩く=1m/s等) をテキストから推定して決める
            if waypoints:
                speed = _locomotion_speed(" ".join(en for en, _ in segments))
                needed = int(waypoint_duration(waypoints, speed) * FPS) // PATCH * PATCH
                print(f"waypoints: {len(waypoints)} points, speed={speed}m/s -> min {needed / FPS:.1f}s", flush=True)
                if len(segments) == 1 and duration is None:
                    # 単一動作+経由地は経路所要時間ちょうどにする
                    # (長すぎると速度が薄まり、走り指定でも早足になってしまう)
                    segments = [(segments[0][0], needed)]
                    num_frames = needed
                elif num_frames < needed:
                    ratio = needed / num_frames
                    segments = [
                        (en, max(PATCH, int(nf * ratio) // PATCH * PATCH)) for en, nf in segments
                    ]
                    num_frames = sum(nf for _, nf in segments)
                    print(
                        f"segments scaled x{ratio:.1f} for waypoints -> {num_frames / FPS:.1f}s",
                        flush=True,
                    )
            if len(segments) > 1:
                plan = ", ".join(f"'{en[:30]}'x{nf}f" for en, nf in segments)
                print(f"segments: {plan}", flush=True)
            observed = cmask = None
            if waypoints:
                observed, cmask = build_waypoint_conditions(waypoints, num_frames)
            if seed is not None:
                seed_everything(int(seed))
            PROGRESS.update(stage="generate", started=time.time(), text=original or english)
            t_model = time.time()
            # 複数セグメント (経由地なし) は独立生成+縫い合わせ:
            # 履歴引き継ぎだと直前動作の慣性で新しい動作が発火しないことがあるため
            use_stitch = len(segments) > 1 and not waypoints
            if use_stitch:
                local_np, root_np, fc_np = _generate_stitched(segments, steps, cfg)
                output = {
                    "local_rot_mats": torch.tensor(local_np, dtype=torch.float32, device=DEVICE)[None],
                    "root_positions": torch.tensor(root_np, dtype=torch.float32, device=DEVICE)[None],
                    "foot_contacts": torch.tensor(fc_np, device=DEVICE)[None],
                }
            else:
                motion = _generate_motion_streaming(segments, steps, observed, cmask, on_chunk, cfg)
                output = model.motion_rep.inverse(motion, is_normalized=True)
            t_inverse = time.time()
            PROGRESS["stage"] = "finalize"
            if postprocess:
                corrected = post_process_motion(
                    output["local_rot_mats"],
                    output["root_positions"],
                    output["foot_contacts"],
                    model.skeleton,
                )
                output.update(corrected)
            if "global_rot_mats" not in output:
                glob, _, _ = fk(output["local_rot_mats"], output["root_positions"], model.skeleton)
                output["global_rot_mats"] = glob
            t_done = time.time()
            print(
                f"timing: generate={t_inverse-t_model:.1f}s finalize={t_done-t_inverse:.1f}s "
                f"({num_frames}f, {steps} steps)",
                flush=True,
            )
            output = to_numpy(output)
            spec = spec_from_arrays(
                output["global_rot_mats"], output["root_positions"], FPS, english,
                arm_spread_deg=arm_spread,
            )
            if original is not None:
                spec["originalText"] = original
            return spec
        finally:
            PROGRESS["active"] = False


# CORSを許可する呼び出し元 (アプリ本体 app:// / ローカル開発 / file://) のみに限定する。
# 無関係なWebサイトから 127.0.0.1:2337 を叩かれてGPU/メモリを消費されるのを防ぐ
_ALLOWED_ORIGIN_PREFIXES = ("app://", "http://localhost", "http://127.0.0.1", "file://")
# リクエストボディの上限 (巨大bodyによるメモリ枯渇DoS対策)
MAX_REQUEST_BYTES = 8 * 1024 * 1024  # 8MB


class Handler(BaseHTTPRequestHandler):
    def _cors_origin(self) -> str:
        o = self.headers.get("Origin", "")
        return o if o.startswith(_ALLOWED_ORIGIN_PREFIXES) else "null"

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        """Content-Lengthを検証してJSONボディを読む (上限超過はNoneを返す)"""
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_REQUEST_BYTES:
            self._send(413, {"error": "request too large"})
            return None
        return json.loads(self.rfile.read(length) or b"{}")

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/health":
            if not BOOT["ready"]:
                # 読み込み中: 進捗% (0〜1) と段階を返す
                self._send(200, {
                    "status": "error" if BOOT["error"] else "loading",
                    "stage": BOOT["stage"],
                    "progress": round(BOOT["fraction"], 3),
                    "error": BOOT["error"],
                })
                return
            self._send(200, {
                "status": "ok",
                "model": ARGS.model,
                "device": DEVICE,
                "fps": FPS,
                "translator": _translator_state,
            })
        elif self.path == "/progress":
            if PROGRESS["active"]:
                elapsed = time.time() - PROGRESS["started"]
                frac = PROGRESS["fraction"]
                # 残り時間は実進捗ベースで推定 (fraction=生成済みフレーム/総フレーム)
                remaining = (elapsed / frac - elapsed) if frac > 0.02 else None
                self._send(200, {
                    "active": True,
                    "stage": PROGRESS["stage"],
                    "elapsed": round(elapsed, 1),
                    "remaining": None if remaining is None else round(remaining, 1),
                    "fraction": round(frac, 3),
                    "text": PROGRESS["text"],
                })
            else:
                self._send(200, {"active": False})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not BOOT["ready"]:
            self._send(503, {"error": "loading", "progress": round(BOOT["fraction"], 3)})
            return
        if self.path == "/generate-stream":
            self._handle_generate_stream()
            return
        if self.path != "/generate":
            self._send(404, {"error": "not found"})
            return
        try:
            req = self._read_json_body()
            if req is None:
                return  # サイズ超過 (413応答済み)
            text = str(req.get("text", "")).strip()
            segments_req = req.get("segments")
            duration = req.get("duration")  # 省略時はプロンプトから自動推定
            if not text and not segments_req:
                self._send(400, {"error": "text or segments is required"})
                return
            t0 = time.time()
            spec = generate_spec(
                text, duration, req.get("seed"), req.get("steps"), req.get("armSpread"),
                segments_req, req.get("postprocess", True), req.get("waypoints"),
                cfg=req.get("cfg"),
            )
            print(f"generated '{spec['name'][:50]}' ({spec['duration']}s) in {time.time()-t0:.1f}s", flush=True)
            self._send(200, spec)
        except Exception as e:  # noqa: BLE001 — クライアントにエラーを返して継続
            import traceback

            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def _handle_generate_stream(self):
        """NDJSONストリーミング生成: チャンクができるたびにspec断片を送る。

        行の種類: {"type":"meta",...} → {"type":"chunk",tracks,hips}× → {"type":"final","spec":...}
        エラー時は {"type":"error","error":...}
        """
        try:
            req = self._read_json_body()
            if req is None:
                return  # サイズ超過 (413応答済み)
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": str(e)})
            return
        text = str(req.get("text", "")).strip()
        segments_req = req.get("segments")
        if not text and not segments_req:
            self._send(400, {"error": "text or segments is required"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()

        arm = req.get("armSpread")
        arm = ARGS.arm_spread if arm is None else max(0.0, min(20.0, float(arm)))
        state = {"meta_sent": False}

        def on_chunk(chunk, pos, total):
            if not state["meta_sent"]:
                emit({"type": "meta", "fps": FPS, "numFrames": total, "duration": round(total / FPS, 3)})
                state["meta_sent"] = True
            out = to_numpy(model.motion_rep.inverse(chunk, is_normalized=True))
            frag = spec_from_arrays(
                out["global_rot_mats"], out["root_positions"], FPS, "chunk",
                arm_spread_deg=arm, t_offset=pos / FPS,
            )
            emit({"type": "chunk", "tracks": frag["tracks"], "hips": frag["hips"]})

        try:
            t0 = time.time()
            spec = generate_spec(
                text, req.get("duration"), req.get("seed"), req.get("steps"), arm,
                segments_req, req.get("postprocess", True), req.get("waypoints"),
                on_chunk=on_chunk,
            )
            print(f"stream-generated '{spec['name'][:50]}' in {time.time()-t0:.1f}s", flush=True)
            emit({"type": "final", "spec": spec})
        except Exception as e:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            try:
                emit({"type": "error", "error": str(e)})
            except Exception:  # noqa: BLE001 — クライアント切断時
                pass

    def log_message(self, *args):
        pass  # アクセスログは抑制 (生成ログだけ出す)


if __name__ == "__main__":
    # サーバーを先に立ててからモデルを読み込む (読み込み中も /health が進捗を返せる)
    threading.Thread(target=_boot, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"ARDY engine server listening on http://127.0.0.1:{ARGS.port}", flush=True)
    server.serve_forever()
