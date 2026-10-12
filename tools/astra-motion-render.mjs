import { readFile, writeFile } from 'node:fs/promises';
import { createArdyRealtime } from '../src/ardyRealtime.js';
import { buildVRMA } from '../src/vrmaBuilder.js';
const cases=JSON.parse(await readFile('release/astra-motion-eval.json','utf8'));
for(const [index,item] of cases.entries()) {
  const start=performance.now(); let first=null;
  const runtime=createArdyRealtime({analyze:async()=>null,plan:async()=>item.plan,
    play:async(spec,_active,{final})=>{
      first??=Math.round(performance.now()-start);
      if(final){
        await writeFile(`release/astra-motion-${index+1}.json`,JSON.stringify(spec));
        await writeFile(`release/astra-motion-${index+1}.vrma`,Buffer.from(buildVRMA(spec)));
        console.log(JSON.stringify({case:index+1,ardyFirstMs:first,ardyTotalMs:Math.round(performance.now()-start),duration:spec.duration,expressions:Object.keys(spec.expressions)}));
      }
    }});
  await runtime.react(item.text,'http://127.0.0.1:2337',{duration:6,steps:8});
}
