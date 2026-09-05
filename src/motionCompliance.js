// Coarse geometric checks, not semantic scoring: repetitions, acting, collisions
// and exact targets still require review. Thresholds scale with avatar height.
export function normalizeMotionChecks(checks, segmentCount) {
  if (!Array.isArray(checks)) return [];
  const result=[];
  for (const c of checks.slice(0,48)) {
    if (!['travel','jump','crouch','raiseHand'].includes(c?.kind) || !Number.isInteger(c.segmentIndex) || c.segmentIndex<0 || c.segmentIndex>=segmentCount) continue;
    const side=['left','right','both'].includes(c.side)?c.side:'both';
    const item={kind:c.kind,segmentIndex:c.segmentIndex,side};
    if (!result.some(r=>JSON.stringify(r)===JSON.stringify(item))) result.push(item);
  }
  return result;
}

export function hasComplianceRegression(before,after){
  if(!before?.total||before.contract!==after?.contract)return false;
  return before.checks.some((check,i)=>check.passed===true&&after.checks[i]?.passed!==true);
}

export function measureMotionChecks(samples, motionPlan, duration, rest) {
  const segments=motionPlan?.segments??[];
  const checks=normalizeMotionChecks(motionPlan?.checks,segments.length);
  const totalTime=segments.reduce((s,p)=>s+Number(p.duration||0),0);
  const footY=(rest?.leftFoot?.[1]+rest?.rightFoot?.[1])/2;
  const height=rest?.head?.[1]-footY;
  const rows=checks.map(check=>{
    const start=segments.slice(0,check.segmentIndex).reduce((s,p)=>s+p.duration,0)/totalTime*duration;
    const end=start+segments[check.segmentIndex].duration/totalTime*duration;
    const frames=samples.filter(s=>s.t>=start-.001&&s.t<=end+.001);
    const row={...check,start,end,passed:null,value:null,threshold:null};
    const sides=check.side==='both'?['left','right']:[check.side];
    const required=check.kind==='raiseHand'?['head',...sides.map(s=>s+'Hand')]:check.kind==='jump'?['leftFoot','rightFoot']:['hips'];
    if(!(height>.2)||frames.length<3||frames.some(f=>required.some(n=>f.positions?.[n]?.length!==3||!f.positions[n].every(Number.isFinite))))return row;
    let values,threshold;
    if(check.kind==='travel'){
      const p=frames[0].positions.hips;
      values=frames.map(f=>Math.hypot(f.positions.hips[0]-p[0],f.positions.hips[2]-p[2]));threshold=height*.12;
    } else if(check.kind==='jump'){
      values=frames.map(f=>Math.min(f.positions.leftFoot[1]-rest.leftFoot[1],f.positions.rightFoot[1]-rest.rightFoot[1]));threshold=height*.04;
    } else if(check.kind==='crouch'){
      const initial=frames[0].positions.hips[1];values=frames.map(f=>initial-f.positions.hips[1]);threshold=height*.1;
    } else {
      values=frames.map(f=>Math.min(...sides.map(s=>f.positions[s+'Hand'][1]-f.positions.head[1])));threshold=-height*.18;
    }
    row.value=Math.max(...values);row.threshold=threshold;
    // Require two adjacent frames; a single noisy frame is not a completed action.
    row.passed=values.some((v,i)=>i>0&&v>=threshold&&values[i-1]>=threshold);
    return row;
  });
  return {checks:rows,total:rows.length,measured:rows.filter(r=>r.passed!==null).length,passed:rows.filter(r=>r.passed===true).length,
    contract:JSON.stringify({checks,segments:segments.map(s=>s.duration)})};
}
