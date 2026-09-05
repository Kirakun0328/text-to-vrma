const test = require('node:test');
const assert = require('node:assert/strict');
const draft=()=>({name:'dense',duration:2,loop:false,tracks:{head:[{t:0,r:[0,0,0]},{t:0.5,r:[0,0,0]},{t:1,r:[0,0,0]},{t:2,r:[0,0,0]}],spine:[{t:0,r:[0,0,0]},{t:2,r:[0,0,0]}]},hips:[{t:0,p:[0,0,0]},{t:2,p:[1,0,0]}]});
const patch=()=>({summary:'視線を修正',issues:[{start:0,end:2,bone:'head',problem:'視線が低い',change:'頭を上げる'}],rotations:[{bone:'head',keys:[{t:0,r:[0,0,0]},{t:1,r:[10,0,0]},{t:2,r:[0,0,0]}]}],root:[]});
test('review input compaction preserves samples and bounds numeric rounding error',async()=>{
 const {reviewJSON}=await import('../src/directMotionReview.js');
 const input=Array.from({length:200},(_,i)=>({t:i/30,p:[Math.sin(i),Math.cos(i),i/7]}));
 const encoded=reviewJSON(input),decoded=JSON.parse(encoded);
 assert.equal(decoded.length,input.length);assert.ok(encoded.length<JSON.stringify(input).length*.7);
 for(let i=0;i<input.length;i++) for(let j=0;j<3;j++) assert.ok(Math.abs(decoded[i].p[j]-input[i].p[j])<=.000051);
});
for(const [speed,effort] of [['fast','low'],['balanced','medium'],['quality','xhigh']]) test(`manual ${speed} uses ${effort} and still compares the result`,async()=>{
 const {directlyReviewMotion}=await import('../src/directMotionReview.js');const calls=[];
 await directlyReviewMotion('nod',draft(),{model:'gpt-6-astra',speed,force:true,visual:false,
 inspect:async()=>({images:[],metrics:{maxFootDropBelowRestM:0},keyPositions:[]}),
 request:async(_m,_k,_mo,_d,c)=>{assert.equal(c.effort,effort);calls.push(c.outputType);return JSON.stringify(c.outputType==='patch'?patch():{improved:true,reason:'ok',resolvedIssues:[],remainingIssues:[]});}});
 assert.deepEqual(calls,['patch','verdict']);
});
for (const duration of [17,61,301]) test(`manual correction segments ${duration}s without changing duration or seams`,async()=>{
 const {directlyReviewMotion}=await import('../src/directMotionReview.js');
 const base=draft();base.duration=duration;
 for(const keys of [...Object.values(base.tracks),base.hips]) for(const k of keys) k.t*=duration/2;
 const snapshot=structuredClone(base);let calls=0;
 const count=Math.ceil(duration/15);
 const result=await directlyReviewMotion('nod',base,{model:'mock',force:true,speed:'balanced',visual:false,
 inspect:async()=>({images:[],metrics:{maxFootDropBelowRestM:0},keyPositions:[]}),
 request:async(_m,_k,_mo,_d,c)=>{calls++;assert.notEqual(c.outputType,'assessment');if(c.outputType==='verdict')return JSON.stringify({improved:false,reason:'uncertain',resolvedIssues:[],remainingIssues:[]});
 const size=Math.min(15,duration-Math.floor((calls-1)/2)*15);const p=patch();p.issues[0].end=size;p.rotations[0].keys=[{t:0,r:[0,0,0]},{t:size/2,r:[10,0,0]},{t:size,r:[0,0,0]}];return JSON.stringify(p);}
 });
 assert.equal(calls,count*2);assert.equal(result.candidate.duration,duration);assert.deepEqual(base,snapshot);
 assert.deepEqual(result.candidate.hips,base.hips);assert.deepEqual(result.candidate.tracks.spine,base.tracks.spine);
 assert.equal(result.spec,base);assert.equal(result.accepted,false);
 for(let i=0;i<=count;i++) {const k=result.candidate.tracks.head.find(k=>Math.abs(k.t-Math.min(duration,i*15))<1e-6);assert.ok(k);assert.ok(Math.abs(k.r[0])<1e-6);}
});
test('kinematics distinguishes constant motion from abrupt acceleration',async()=>{
 const {measureKinematics}=await import('../src/motionReview.js');
 const samples=Array.from({length:21},(_,i)=>({t:i/20,positions:{leftHand:[i/20,0,0]}}));
 const smooth=measureKinematics(samples).leftHand;
 assert.ok(Math.abs(smooth.peakSpeedMps-1)<1e-9);assert.ok(smooth.peakAccelerationMps2<1e-9);
 samples[10].positions.leftHand[0]+=0.05;
 assert.ok(measureKinematics(samples).leftHand.peakAccelerationMps2>10);
});
test('direct patch preserves untouched tracks, trajectory and dense keys',async()=>{
 const {applyMotionPatch}=await import('../src/motionPatch.js');const base=draft(),snapshot=structuredClone(base);
 const result=applyMotionPatch(base,patch());
 assert.deepEqual(base,snapshot);assert.deepEqual(result.spec.tracks.spine,base.tracks.spine);assert.deepEqual(result.spec.hips,base.hips);
 assert.deepEqual(result.spec.tracks.head.map(k=>k.t),base.tracks.head.map(k=>k.t));
 assert.ok(Math.abs(result.spec.tracks.head[1].r[0]-5)<1e-6);assert.equal(result.changes.changed,true);
 assert.deepEqual(result.spec.tracks.head[0],base.tracks.head[0]);assert.deepEqual(result.spec.tracks.head.at(-1),base.tracks.head.at(-1));
});
test('direct patch rejects out-of-range offsets, duplicated bones, bad timing and loop seam',async()=>{
 const {applyMotionPatch}=await import('../src/motionPatch.js');
 for(const edit of [p=>p.rotations[0].keys[1].r=[31,0,0],p=>p.rotations.push(p.rotations[0]),p=>p.rotations[0].keys[1].t=0,p=>p.root=[{t:0,p:[0,0,0]},{t:2,p:[0.1,0,0]}]]){const p=patch();edit(p);assert.throws(()=>applyMotionPatch(draft(),p));}
 const p=patch();p.rotations[0].keys.at(-1).r=[1,0,0];assert.throws(()=>applyMotionPatch({...draft(),loop:true},p));
 const noop=applyMotionPatch(draft(),{summary:'変更なし',issues:[],rotations:[],root:[]});assert.equal(noop.changes.changed,false);
});
test('near-identical base and correction timestamps merge without angular-speed spikes',async()=>{
 const {applyMotionPatch,rotationDiagnostics}=await import('../src/motionPatch.js');const base=draft();
 base.tracks.head=[{t:0,r:[0,0,0]},{t:1.2000000000000002,r:[10,0,0]},{t:2,r:[0,0,0]}];
 const p=patch();p.rotations[0].keys[1].t=1.2;
 const result=applyMotionPatch(base,p);
 assert.equal(result.spec.tracks.head.length,3);
 assert.ok(rotationDiagnostics(result.spec).head.peakAngularSpeedDegPerSec<100);
});
for(const improved of [true,false]) test(`direct review requires a separate comparison verdict: ${improved}`,async()=>{
 const {directlyReviewMotion}=await import('../src/directMotionReview.js');const base=draft();let calls=0,compares=0;
 const metrics={plannedContactSlideMps:null,maxFootDropBelowRestM:0,meanTargetErrorM:null};
 const result=await directlyReviewMotion('nod',base,{model:'gpt-6-astra',visual:true,speed:'quality',
 inspect:async(spec,_plan,options)=>{if(spec!==base)assert.deepEqual(options.framing,{test:true});return {images:['front','side'],metrics,keyPositions:[],framing:{test:true}};},
 compareImages:async()=>{compares++;return ['comparison front','comparison side'];},
 request:async(messages,_key,_model,_delta,config)=>{calls++;if(config.outputType==='assessment')return JSON.stringify({needed:true,reason:'修正が必要',issues:[]});assert.equal(config.effort,'xhigh');if(config.outputType==='patch')return JSON.stringify(patch());assert.equal(messages[1].content[1].image_url.url,'comparison front');return JSON.stringify({improved,reason:'比較結果',resolvedIssues:[],remainingIssues:[]});}
 });
 assert.equal(calls,3);assert.equal(compares,1);assert.equal(result.accepted,improved);assert.equal(result.spec===base,!improved);
});
test('direct review rejects metric regression even when AI says improved',async()=>{
 const {directlyReviewMotion}=await import('../src/directMotionReview.js');const base=draft();
 const result=await directlyReviewMotion('nod',base,{model:'mock',visual:false,speed:'balanced',inspect:async s=>({images:[],keyPositions:[],metrics:{maxFootDropBelowRestM:s===base?0:0.1}}),request:async(_m,_k,_mo,_d,c)=>JSON.stringify(c.outputType==='assessment'?{needed:true,reason:'修正',issues:[]}:c.outputType==='patch'?patch():{improved:true,reason:'better',resolvedIssues:[],remainingIssues:[]})});
 assert.equal(result.accepted,false);assert.equal(result.spec,base);assert.ok(result.attempts[0].rejection);
});
test('preflight skips correction and comparison when no repair is needed',async()=>{
 const {directlyReviewMotion}=await import('../src/directMotionReview.js');const base=draft();let calls=0;
 const result=await directlyReviewMotion('nod',base,{model:'mock',visual:false,inspect:async()=>({images:[],metrics:{},keyPositions:[]}),request:async(_m,_k,_mo,_d,c)=>{calls++;assert.equal(c.outputType,'assessment');return JSON.stringify({needed:false,reason:'具体的な問題は確認できません',issues:[]});}});
 assert.equal(calls,1);assert.equal(result.spec,base);assert.equal(result.candidate,null);assert.equal(result.assessment.needed,false);
});
