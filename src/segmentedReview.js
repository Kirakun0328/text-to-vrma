import { tr } from './i18n.js';
import { Euler, Quaternion, MathUtils } from 'three';

function sample(keys, t, field) {
  const b = keys.find(k => k.t >= t) ?? keys.at(-1);
  const a = keys.findLast(k => k.t <= t) ?? keys[0];
  if (a.t === b.t) return [...a[field]];
  const f = (t-a.t)/(b.t-a.t);
  if (field === 'p') return a.p.map((v,i)=>v+(b.p[i]-v)*f);
  const q = r => new Quaternion().setFromEuler(new Euler(...r.map(MathUtils.degToRad),'XYZ'));
  const e = new Euler().setFromQuaternion(q(a.r).slerp(q(b.r),f),'XYZ');
  return [e.x,e.y,e.z].map(MathUtils.radToDeg);
}
export function sliceMotion(spec, start, end) {
  const slice = (keys,field) => [{t:0,[field]:sample(keys,start,field)},
    ...keys.filter(k=>k.t>start && k.t<end).map(k=>({...k,t:k.t-start})),
    {t:end-start,[field]:sample(keys,end,field)}];
  const expressionAt=(keys,t)=>{
    const a=keys.findLast(k=>k.t<=t)??keys[0],b=keys.find(k=>k.t>=t)??keys.at(-1);
    return a.t===b.t?a.w:a.w+(b.w-a.w)*(t-a.t)/(b.t-a.t);
  };
  const expressions=Object.fromEntries(Object.entries(spec.expressions??{}).filter(([,keys])=>Array.isArray(keys)&&keys.length).map(([name,keys])=>[name,
    [{t:0,w:expressionAt(keys,start)},...keys.filter(k=>k.t>start&&k.t<end).map(k=>({...k,t:k.t-start})),{t:end-start,w:expressionAt(keys,end)}]]));
  return {...spec,duration:end-start,loop:false,expressions,
    tracks:Object.fromEntries(Object.entries(spec.tracks).map(([b,k])=>[b,slice(k,'r')])),
    ...(spec.hips?.length ? {hips:slice(spec.hips,'p')} : {})};
}
function mergeMotion(target, part, start, end, changes) {
  const merge = (base,keys) => [...base.filter(k=>k.t<start),...keys.map(k=>({...k,t:k.t+start})),...base.filter(k=>k.t>end)];
  for (const bone of new Set(changes.flatMap(a=>a.changes.bones))) target.tracks[bone]=merge(target.tracks[bone],part.tracks[bone]);
  if(changes.some(a=>a.changes.maxRootMeters>0) && part.hips) target.hips=merge(target.hips??[],part.hips);
}
export async function reviewSegments(text,draft,options,review) {
  const started=performance.now(), candidate=structuredClone(draft), best=structuredClone(draft), attempts=[];
  let changed=false,accepted=false,error=null;
  const count=Math.ceil(draft.duration/15), size=15;
  for(let i=0;i<count;i++) {
    const start=i*size,end=i===count-1?draft.duration:(i+1)*size;
    const section={section:i+1,total:count,start,end};
    options.onProgress?.(tr('修正処理中…'),{...section,stage:'capture'});
    const result=await review(`${text}\n全体${draft.duration}秒のうち${start}〜${end}秒。以下の時刻はこの区間の先頭からの秒数です。`,sliceMotion(draft,start,end),
      {...options,onDraft:undefined,seam:true,onProgress:(s,details)=>options.onProgress?.(s,{...section,...details})});
    if(result.candidate) {mergeMotion(candidate,result.candidate,start,end,result.attempts);changed=true;}
    if(result.accepted) {mergeMotion(best,result.spec,start,end,result.attempts.filter(a=>a.accepted));accepted=true;}
    attempts.push(...result.attempts.map(a=>({...a,patch:{...a.patch,issues:a.patch.issues.map(issue=>({...issue,start:issue.start+start,end:issue.end+start}))}})));
    if(result.error) {error=`${start.toFixed(1)}〜${end.toFixed(1)}秒：${result.error}`;break;}
  }
  const plan={duration:draft.duration,intent:text,phases:[{start:0,end:draft.duration,support:'none',targets:[],action:text}],correction:null};
  options.onProgress?.(tr('修正処理中…'),{stage:'finish'});
  const before=await options.inspect(draft,plan);
  const after=changed?await options.inspect(candidate,plan,{framing:before.framing}):null;
  return {model:options.model,speed:options.speed,mode:'direct',manual:options.force,assessment:{needed:true,reason:tr('{n}区間に分けて確認しました。',{n:count}),issues:[]},
    spec:accepted?best:draft,draft,candidate:changed?candidate:null,before,after,accepted,error,plan,attempts,timing:{draftSeconds:0,totalSeconds:(performance.now()-started)/1000}};
}
