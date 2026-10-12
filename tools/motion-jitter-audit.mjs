import {readFile,writeFile} from 'node:fs/promises';
import {Euler,Quaternion,MathUtils} from 'three';
const compact=process.argv.includes('--compact');
const files=process.argv.slice(2).filter(v=>v!=='--compact');
for(const file of files){
 const spec=JSON.parse(await readFile(file,'utf8'));
 const joints={};
 for(const [bone,keys] of Object.entries(spec.tracks)){
  const q=keys.map(k=>new Quaternion().setFromEuler(new Euler(...k.r.map(MathUtils.degToRad),'XYZ')));
  const velocities=q.slice(1).map((v,i)=>({t:keys[i+1].t,speed:MathUtils.radToDeg(q[i].angleTo(v))/(keys[i+1].t-keys[i].t)}));
  const sorted=velocities.map(v=>v.speed).sort((a,b)=>a-b);
  joints[bone]={p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),peaks:velocities.sort((a,b)=>b.speed-a.speed).slice(0,4)};
 }
 console.log(JSON.stringify({file,duration:spec.duration,joints:compact?Object.fromEntries(['rightUpperArm','rightLowerArm','rightHand'].map(n=>[n,joints[n]])):joints}));
}
