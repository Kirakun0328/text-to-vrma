import {readFile,writeFile} from 'node:fs/promises';
import {Euler,Quaternion,MathUtils} from 'three';
const results=[];
for(const name of ['transition-stopped','transition-flowing']){
 const spec=JSON.parse(await readFile(`release/naturalness-before/${name}.spec.json`,'utf8'));
 const index=spec.hips.findIndex(k=>k.t===2), speed=i=>Math.hypot(...spec.hips[i].p.map((v,j)=>(v-spec.hips[i-1].p[j])/.05));
 const angular=bone=>{
  const keys=spec.tracks[bone],q=i=>new Quaternion().setFromEuler(new Euler(...keys[i].r.map(MathUtils.degToRad),'XYZ'));
  return {before:MathUtils.radToDeg(q(index-2).angleTo(q(index-1)))/.05,after:MathUtils.radToDeg(q(index-1).angleTo(q(index)))/.05};
 };
 results.push({name,boundarySeconds:2,rootMetersPerSecond:{before:speed(index-1),after:speed(index)},angularDegreesPerSecond:{hips:angular('hips'),rightUpperLeg:angular('rightUpperLeg')}});
}
await writeFile('release/naturalness-before/continuity.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
