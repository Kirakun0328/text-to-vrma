import {readFile,writeFile} from 'node:fs/promises';
import {Euler,Quaternion,Vector3,MathUtils} from 'three';
for(const folder of process.argv.slice(2)){
 const report=JSON.parse(await readFile(`release/${folder}/results.json`,'utf8'));
 const entry=report.cases.find(c=>c.id==='astra-pivot-step');
 const spec=JSON.parse(await readFile(`release/${folder}/${entry.specFile}`,'utf8'));
 let start=0;const phases=[];
 for(const s of entry.plans[0].value.segments){
  const end=start+s.duration;
  const keys=spec.tracks.hips.filter(k=>k.t>=start-1e-6&&k.t<end-1e-6);
  const angles=keys.map(k=>{const v=new Vector3(0,0,1).applyQuaternion(new Quaternion().setFromEuler(new Euler(...k.r.map(MathUtils.degToRad),'XYZ')));return Math.atan2(v.x,v.z);});
  const turn=angles.slice(1).reduce((sum,a,i)=>sum+Math.atan2(Math.sin(a-angles[i]),Math.cos(a-angles[i])),0)*180/Math.PI;
  phases.push({start,end,text:s.text,constraint:s.turn,measuredTurnDegrees:turn});start=end;
 }
 let inspection;try{inspection=JSON.parse(await readFile(`release/${folder}/visual-inspection.json`,'utf8')).cases[0];}catch{}
 if(inspection){
  for(const phase of phases){
   const pivot=phase.constraint?.[1];if(!pivot)continue;
   const bone=pivot===1?'leftFoot':'rightFoot';
   const frames=inspection.trajectory.filter(f=>f.t>=phase.start&&f.t<phase.end);
   const anchor=frames[0]?.positions[bone];
   if(anchor)phase.vrmPivotDriftMeters=Math.max(...frames.map(f=>Math.hypot(...f.positions[bone].map((v,i)=>v-anchor[i]))));
  }
 }
 await writeFile(`release/${folder}/intent-audit.json`,JSON.stringify(phases,null,2));console.log(JSON.stringify({folder,phases}));
}
