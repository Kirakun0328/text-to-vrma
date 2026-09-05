import { Euler, Quaternion, Vector3, MathUtils } from 'three';
import { SKELETON } from './vrmaBuilder.js';

const q = r => new Quaternion().setFromEuler(new Euler(...r.map(MathUtils.degToRad), 'XYZ'));
const legSide = name => /^(left|right)(UpperLeg|LowerLeg|Foot|Toes)$/.exec(name)?.[1];
function sampler(keys, field, convert, blend, fallback) {
  const values = keys.map(k => convert(k[field]));
  return t => {
    if (!keys.length) return fallback.clone();
    if (t <= keys[0].t) return values[0].clone();
    let lo = 0, hi = keys.length - 1;
    if (t >= keys[hi].t) return values[hi].clone();
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
    return blend(values[lo].clone(), values[hi], (t - keys[lo].t) / (keys[hi].t - keys[lo].t));
  };
}

// Source-skeleton ankle clearance is a conservative contact proxy, not a foot lock.
// Keep the original lower-body rotations near the ground and around landing/takeoff.
function contactWeights(spec, rotations, radius) {
  const root = sampler(spec.hips ?? [], 'p', p => new Vector3(...p), (a,b,f) => a.lerp(b,f), new Vector3());
  const count = Math.max(1, Math.ceil(spec.duration * 60));
  const times = Array.from({length:count+1}, (_,i) => spec.duration*i/count);
  const heights = {left:[], right:[]};
  for (const t of times) {
    for (const side of ['left','right']) {
      const position = new Vector3(...SKELETON.hips[1]).add(root(t));
      const rotation = rotations.hips?.(t) ?? new Quaternion();
      for (const bone of [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`]) {
        position.add(new Vector3(...SKELETON[bone][1]).applyQuaternion(rotation));
        rotation.multiply(rotations[bone]?.(t) ?? new Quaternion());
      }
      heights[side].push(position.y);
    }
  }
  const floors = Object.fromEntries(['left','right'].map(side => [side, heights[side].reduce((a,b)=>Math.min(a,b), Infinity)]));
  return (side,t) => {
    const from = Math.max(0, Math.floor((t-radius)/spec.duration*count));
    const to = Math.min(count, Math.ceil((t+radius)/spec.duration*count));
    let clearance = Infinity;
    for (let i=from;i<=to;i++) clearance = Math.min(clearance, heights[side][i]-floors[side]);
    const f = MathUtils.clamp((clearance-.02)/.06,0,1);
    return f*f*(3-2*f);
  };
}

export function softenMotion(spec) {
  if (spec.smoothing?.version===2 || !Number.isFinite(spec.duration) || spec.duration<=0) return spec;
  const result = structuredClone(spec), radius = .075;
  const rotations = Object.fromEntries(Object.entries(spec.tracks ?? {}).map(([bone,keys]) =>
    [bone, sampler(keys,'r',q,(a,b,f)=>a.slerp(b,f),new Quaternion())]));
  const weight = contactWeights(spec, rotations, radius);
  for (const [bone,keys] of Object.entries(spec.tracks ?? {})) {
    if (!(bone in SKELETON) || keys.length<2) continue;
    const side = legSide(bone), lower = Boolean(side) || bone==='hips';
    // Upgrading an older smoothed spec must not apply the upper-body filter twice.
    if (spec.smoothing?.version===1 && !lower) continue;
    const at = rotations[bone], count = Math.ceil(spec.duration*(lower?60:30));
    const times = [...new Set([...keys.map(k=>k.t), ...Array.from({length:count+1},(_,i)=>spec.duration*i/count)])]
      .sort((a,b)=>a-b).filter((t,i,a)=>!i||t-a[i-1]>1e-6);
    const contactAt = t => side ? weight(side,t) : bone==='hips' ? Math.min(weight('left',t),weight('right',t)) : 1;
    if (lower && times.every(t=>contactAt(t)===0)) continue;
    const originals = new Map(keys.map(k=>[k.t,k]));
    result.tracks[bone] = times.map(t => {
      if (t===keys[0].t) return structuredClone(keys[0]);
      if (t===keys.at(-1).t) return structuredClone(keys.at(-1));
      const original = at(t), neighbors = at(t-radius).slerp(at(t+radius),.5);
      const edge = Math.max(0,Math.min(1,(t-keys[0].t)/radius,(keys.at(-1).t-t)/radius));
      const contact = contactAt(t);
      let amount = (lower ? .35 : .6)*edge*contact;
      // Preserve kicks and steps: lower-body corrections are capped at two degrees.
      if (lower) amount = Math.min(amount,MathUtils.degToRad(bone==='hips'?1:2)/Math.max(1e-9,original.angleTo(neighbors)));
      const exact = originals.get(t);
      if (amount===0 && exact) return structuredClone(exact);
      const e = new Euler().setFromQuaternion(original.slerp(neighbors,amount),'XYZ');
      return {t,r:[e.x,e.y,e.z].map(MathUtils.radToDeg)};
    });
  }
  result.smoothing = {version:2,radiusSeconds:radius,scope:'fullBody',contactProtection:'sourceAnkleClearance',rootTranslation:'preserved'};
  return result;
}
