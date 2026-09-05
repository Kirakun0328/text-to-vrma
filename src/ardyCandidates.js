import { hasMetricRegression } from './motionReview.js';

// Physical plausibility checks; these do not measure adherence to the prompt.
export function candidateActivity(view) {
  const result={};
  for(const bone of ['hips','head','leftHand','rightHand','leftFoot','rightFoot']) {
    let distance=0;
    const frames=view.trajectory??[];
    for(let i=1;i<frames.length;i++) {
      const a=frames[i-1].positions?.[bone],b=frames[i].positions?.[bone];
      if(a?.length===3&&b?.length===3)distance+=Math.hypot(...a.map((v,j)=>b[j]-v));
    }
    result[bone]=distance;
  }
  return result;
}
export function chooseArdyCandidate(entries) {
  if(!entries.length)throw new Error('No motion candidates');
  const first=entries[0],reference=candidateActivity(first.view);
  const metric=entries.every(e=>Number.isFinite(e.view.metrics?.estimatedContactSlideMps))?'estimatedContactSlideMps':'lowFootHorizontalSpeedMps';
  const score=view=>{
    const m=view.metrics;
    return Number.isFinite(m?.[metric])&&Number.isFinite(m?.maxFootDropBelowRestM)
      ? m[metric]+2*m.maxFootDropBelowRestM : null;
  };
  const decisions=entries.map((entry,index)=>{
    const activity=candidateActivity(entry.view),value=score(entry.view);
    let reason='eligible';
    if(value===null)reason='unmeasured';
    else if(Math.abs(entry.spec.duration-first.spec.duration)>.05)reason='duration';
    else if(hasMetricRegression(first.view.metrics,entry.view.metrics))reason='regression';
    else if(Object.keys(reference).some(b=>reference[b]>.05&&activity[b]<reference[b]*.55))reason='activity';
    return {index,score:value,activity,reason};
  });
  let selected=0;
  const compliance=entries.map(e=>e.view.compliance);
  const compareCompliance=compliance.every(c=>c?.total>0&&c.measured===c.total&&c.contract===compliance[0]?.contract);
  for(const item of decisions){
    if(item.reason!=='eligible')continue;
    if(compareCompliance&&compliance[item.index].passed!==compliance[selected].passed){
      if(compliance[item.index].passed>compliance[selected].passed)selected=item.index;
    }else if(decisions[selected].score!==null&&item.score<decisions[selected].score-.005)selected=item.index;
  }
  return {selected,decisions,metric,compareCompliance};
}

export async function generateArdyCandidates({count,generate,inspect,onProgress=()=>{},seed=()=>crypto.getRandomValues(new Uint32Array(1))[0]}) {
  const entries=[];let error=null;
  for(let i=0;i<count;i++) {
    onProgress(i+1,count,'generate');
    try {
      const candidateSeed=(seed()+i)>>>0;
      const spec=await generate(candidateSeed);
      onProgress(i+1,count,'measure');
      const view=await inspect(spec);
      entries.push({spec,view,seed:candidateSeed});
    }catch(e){if(!entries.length)throw e;error=e.message;break;}
  }
  return {...chooseArdyCandidate(entries),entries,error};
}
