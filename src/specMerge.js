// specMerge.js — 複数エンジンで生成したモーションspecの合成と終端処理
import * as THREE from 'three';

// --- 複数エンジンのspecを時間・位置・向きを揃えて1本に合成する ---
const _yawQuat = new THREE.Quaternion();
const _keyQuat = new THREE.Quaternion();
const _eulerTmp = new THREE.Euler();

function _eulerToYaw(deg) {
  _eulerTmp.set(
    THREE.MathUtils.degToRad(deg[0]),
    THREE.MathUtils.degToRad(deg[1]),
    THREE.MathUtils.degToRad(deg[2]),
    'XYZ'
  );
  const fwd = new THREE.Vector3(0, 0, 1).applyEuler(_eulerTmp);
  return Math.atan2(fwd.x, fwd.z);
}

function _composeYaw(deg, yaw) {
  _eulerTmp.set(
    THREE.MathUtils.degToRad(deg[0]),
    THREE.MathUtils.degToRad(deg[1]),
    THREE.MathUtils.degToRad(deg[2]),
    'XYZ'
  );
  _keyQuat.setFromEuler(_eulerTmp);
  _yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  _keyQuat.premultiply(_yawQuat);
  _eulerTmp.setFromQuaternion(_keyQuat, 'XYZ');
  return [
    THREE.MathUtils.radToDeg(_eulerTmp.x),
    THREE.MathUtils.radToDeg(_eulerTmp.y),
    THREE.MathUtils.radToDeg(_eulerTmp.z),
  ].map((v) => Math.round(v * 100) / 100);
}

export function mergeSequentialSpecs(parts) {
  const GAP = 0.15; // つなぎ目: この間はキー補間 (スラープ) が自動でブレンドしてくれる
  const merged = { name: '', duration: 0, loop: false, tracks: {}, hips: [] };
  let tOff = 0;
  let x0 = 0;
  let z0 = 0;
  let yaw = 0;
  const names = [];
  for (const part of parts) {
    const gap = tOff > 0 ? GAP : 0;
    const base = tOff + gap;
    for (const [bone, keys] of Object.entries(part.tracks ?? {})) {
      const out = (merged.tracks[bone] ??= []);
      for (const k of keys) {
        const r = bone === 'hips' && yaw !== 0 ? _composeYaw(k.r, yaw) : k.r;
        out.push({ t: Math.round((base + k.t) * 1000) / 1000, r });
      }
    }
    const hipsKeys = part.hips?.length ? part.hips : [{ t: 0, p: [0, 0, 0] }];
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const k of hipsKeys) {
      const px = k.p[0] * cos + k.p[2] * sin + x0;
      const pz = -k.p[0] * sin + k.p[2] * cos + z0;
      merged.hips.push({
        t: Math.round((base + k.t) * 1000) / 1000,
        p: [Math.round(px * 1000) / 1000, k.p[1], Math.round(pz * 1000) / 1000],
      });
    }
    // 次パートの基準位置・向きを更新
    const lastP = merged.hips.at(-1).p;
    x0 = lastP[0];
    z0 = lastP[2];
    const hipsRot = merged.tracks.hips;
    if (hipsRot?.length) yaw = _eulerToYaw(hipsRot.at(-1).r);
    tOff = base + (part.duration ?? 0);
    names.push(part.name ?? '');
  }
  merged.duration = Math.round(tOff * 100) / 100;
  merged.name = names.filter(Boolean).join(' / ').slice(0, 60) || 'motion';
  return merged;
}

// 非ループモーションの終端に「自然に直立へ戻る」キーを足す
export function appendNeutralEnding(spec) {
  const SETTLE = 0.8;
  const T = spec.duration;
  const NEUTRAL = { leftUpperArm: [0, 0, -70], rightUpperArm: [0, 0, 70] };
  for (const [bone, keys] of Object.entries(spec.tracks ?? {})) {
    if (!keys?.length) continue;
    if (bone === 'hips') {
      // 体の向きは保ったまま、傾きだけ直す
      const yawDeg = THREE.MathUtils.radToDeg(_eulerToYaw(keys.at(-1).r));
      keys.push({ t: T + SETTLE, r: [0, Math.round(yawDeg * 100) / 100, 0] });
    } else {
      keys.push({ t: T + SETTLE, r: NEUTRAL[bone] ?? [0, 0, 0] });
    }
  }
  if (spec.hips?.length) {
    const last = spec.hips.at(-1).p;
    spec.hips.push({ t: T + SETTLE, p: [last[0], 0, last[2]] });
  }
  spec.duration = Math.round((T + SETTLE) * 100) / 100;
}

