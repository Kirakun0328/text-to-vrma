import { tr, locale } from './i18n.js';
import { Euler, Quaternion, MathUtils } from 'three';
import { SKELETON } from './vrmaBuilder.js';

const xyz = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const quat = r => new Quaternion().setFromEuler(new Euler(...r.map(MathUtils.degToRad), 'XYZ'));
export function rotationDiagnostics(spec) {
  return Object.fromEntries(Object.entries(spec.tracks).map(([bone,keys])=>{
    let peak=0,totalAngle=0,totalTime=0;
    for(let i=1;i<keys.length;i++) {
      const dt=keys[i].t-keys[i-1].t;if(dt<=1e-6)continue;
      const angle=MathUtils.radToDeg(quat(keys[i-1].r).angleTo(quat(keys[i].r)));
      peak=Math.max(peak,angle/dt);totalAngle+=angle;totalTime+=dt;
    }
    return [bone,{peakAngularSpeedDegPerSec:peak,meanAngularSpeedDegPerSec:totalTime?totalAngle/totalTime:0}];
  }));
}
function validateKeys(keys, field, duration, limit) {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 12 ||
    keys.some((key, i) => !Number.isFinite(key.t) || key.t < 0 || key.t > duration ||
      (i > 0 && key.t - keys[i-1].t <= 1e-6) || !xyz(key[field]) || Math.hypot(...key[field]) > limit)) throw new Error(tr('補正値・時刻が許容範囲外です'));
  if (Math.abs(keys[0].t) > 1e-6 || Math.abs(keys.at(-1).t - duration) > 1e-6) throw new Error(tr('補正は開始から終了までのキーが必要です'));
}
function interpolate(keys, t, field, smooth = false) {
  if (t <= keys[0].t) return keys[0][field];
  const i = keys.findIndex(key => key.t >= t);
  if (i < 0) return keys.at(-1)[field];
  const a = keys[i-1], b = keys[i];
  const linear = (t - a.t) / (b.t - a.t);
  const f = smooth ? linear * linear * (3 - 2 * linear) : linear;
  return a[field].map((v,j) => v + (b[field][j]-v)*f);
}
export function applyMotionPatch(draft, patch) {
  if (!Array.isArray(patch.rotations) || patch.rotations.length > 12 || !Array.isArray(patch.root) || !Array.isArray(patch.issues) || typeof patch.summary !== 'string') throw new Error(tr('補正データの形式が不正です'));
  const allowed = new Set(Object.keys(SKELETON));
  const seen = new Set();
  const duration = draft.duration;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15) throw new Error(tr('直接修正は1〜15秒に対応しています'));
  if (patch.issues.length > 8 || patch.issues.some(issue=>!Number.isFinite(issue.start)||!Number.isFinite(issue.end)||issue.start<0||issue.end<issue.start||issue.end>duration||typeof issue.problem!=='string'||typeof issue.change!=='string'||!allowed.has(issue.bone))) throw new Error(tr('問題箇所の記述が不正です'));
  for (const rotation of patch.rotations) {
    if (!allowed.has(rotation.bone) || seen.has(rotation.bone) || !draft.tracks?.[rotation.bone]?.length) throw new Error(tr('存在しない関節または重複した補正です'));
    seen.add(rotation.bone); validateKeys(rotation.keys, 'r', duration, 30);
  }
  if (patch.root.length) validateKeys(patch.root, 'p', duration, 0.08);
  if (draft.loop) for (const [keys, field] of [...patch.rotations.map(r => [r.keys,'r']), ...(patch.root.length ? [[patch.root,'p']] : [])]) {
    if (Math.hypot(...keys[0][field].map((v,i) => v-keys.at(-1)[field][i])) > 1e-6) throw new Error(tr('ループの開始・終了の補正を揃えてください'));
  }
  const result = structuredClone(draft);
  let maxRotationDeg = 0, maxRootMeters = 0;
  for (const rotation of patch.rotations) {
    const base = draft.tracks[rotation.bone];
    const times = mergeTimes(base,rotation.keys);
    result.tracks[rotation.bone] = times.map(t => {
      const i = base.findIndex(k=>k.t>=t);
      const a = i <= 0 ? (i < 0 ? base.at(-1) : base[0]) : base[i-1];
      const b = i <= 0 ? a : base[i];
      const q = quat(a.r).slerp(quat(b.r), b.t === a.t ? 0 : (t-a.t)/(b.t-a.t));
      const correction = interpolate(rotation.keys,t,'r',true);
      maxRotationDeg = Math.max(maxRotationDeg, Math.hypot(...correction));
      const exact = base.find(key=>key.t===t);
      if (Math.hypot(...correction) < 1e-9 && exact) return structuredClone(exact);
      q.multiply(quat(correction));
      const e = new Euler().setFromQuaternion(q,'XYZ');
      return {t,r:[e.x,e.y,e.z].map(MathUtils.radToDeg)};
    });
  }
  if (patch.root.length) {
    const base = draft.hips?.length ? draft.hips : [{t:0,p:[0,0,0]},{t:duration,p:[0,0,0]}];
    result.hips = mergeTimes(base,patch.root).map(t=>{
      const p = interpolate(base,t,'p'), delta = interpolate(patch.root,t,'p',true);
      maxRootMeters = Math.max(maxRootMeters,Math.hypot(...delta));
      return {t,p:p.map((v,i)=>v+delta[i])};
    });
  }
  return { spec: result, changes: { bones: [...seen], maxRotationDeg, maxRootMeters, changed: maxRotationDeg > 0.01 || maxRootMeters > 0.0001 } };
}

function mergeTimes(base, patch) {
  const times=base.map(key=>key.t);
  for(const key of patch) if(!times.some(t=>Math.abs(t-key.t)<=1e-6)) times.push(key.t);
  return times.sort((a,b)=>a-b).filter((t,i,all)=>i===0||t-all[i-1]>1e-6);
}
