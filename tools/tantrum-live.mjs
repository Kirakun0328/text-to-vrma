// Fixed-seed real ARDY comparison. Motion magnitude does not establish semantic correctness.
import {writeFile} from 'node:fs/promises';
import {Euler,Quaternion,MathUtils} from 'three';
const emotions=process.argv.includes('--emotions');
const prompts=emotions?{
 joy:'A person joyfully opens their arms, lifts their chest and makes a buoyant upward body movement.',
 anger:'A person throws an angry tantrum, repeatedly stamping their feet and flailing both arms with forceful, irregular movements.',
 sadness:'A person slowly slumps their shoulders and chest, lowers their head and lets their arms hang heavily in sadness.',
 enjoyment:'A person playfully sways from side to side with a light, relaxed rhythm, their arms following the body movement.',
}: {vague:'A person looks angry.',explicit:'A person throws an angry tantrum, repeatedly stamping their feet and flailing both arms with forceful, irregular movements.'};
const prefix=emotions?'emotion':'tantrum';
const result={};
for(const [name,text] of Object.entries(prompts)){
 const response=await fetch('http://127.0.0.1:2337/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,duration:5,seed:42})});
 if(!response.ok)throw Error('ARDY HTTP '+response.status);
 const spec=await response.json();
 const travel={};
 for(const bone of ['head','chest','leftUpperArm','rightUpperArm','leftUpperLeg','rightUpperLeg']){
  const keys=spec.tracks[bone]??[];let total=0,previous=null;
  for(const key of keys){const current=new Quaternion().setFromEuler(new Euler(...key.r.map(MathUtils.degToRad),'XYZ'));if(previous)total+=previous.angleTo(current);previous=current;}
  travel[bone]=Math.round(MathUtils.radToDeg(total));
 }
 result[name]={prompt:text,duration:spec.duration,angularTravelDegrees:travel};
 await writeFile('release/'+prefix+'-'+name+'.json',JSON.stringify(spec));
}
await writeFile('release/'+prefix+'-comparison.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
