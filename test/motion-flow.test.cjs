const test=require('node:test');const assert=require('node:assert/strict');
test('finite stationary gestures preserve the ending instead of looping automatically',async()=>{
 const {isLoopFriendly}=await import('../src/specMerge.js');
 const spec={hips:[{t:0,p:[0,0,0]},{t:6,p:[0,0,0]}]};
 for(const text of ['右手を2回振る。その後、手をゆっくり下ろして自然に立つ。','Wave twice, then lower the hand.','挥手然后放下','손을 내리고 마무리'])assert.equal(isLoopFriendly(spec,text),false);
 assert.equal(isLoopFriendly(spec,'その場で歩き続ける'),true);
});
test('planner preserves a connected gesture and its ending in the same segment',async()=>{
 const {planArdySegments}=await import('../src/llm.js');
 const result=await planArdySegments('右手を2回振って下ろす','','model',{verify:false,request:async()=>JSON.stringify({segments:[{text:'A person waves their right hand twice, then gently lowers their right hand to their side.',duration:6}]})});
 assert.equal(result.segments.length,1);
 assert.equal(result.segments.reduce((sum,s)=>sum+s.duration,0),6);
 assert.match(result.segments[0].text,/twice/);
 assert.match(result.segments[0].text,/lowers their right hand/);
 assert.equal(result.segments[0].duration,6);
 const many=await planArdySegments('sequence','','model',{verify:false,request:async()=>JSON.stringify({segments:Array.from({length:11},()=>({text:'A person waves, then lowers their hand.',duration:6}))})});
 assert.equal(many.segments.length,11);
});
test('upper-body smoothing reduces a sharp peak without changing legs, path, duration, or endpoints',async()=>{
 const {softenMotion}=await import('../src/smoothMotion.js');
 const keys=Array.from({length:41},(_,i)=>({t:i/20,r:[i===20?20:0,0,0]}));
 const spec={duration:2,tracks:{head:keys,leftUpperLeg:structuredClone(keys)},hips:[{t:0,p:[0,0,0]},{t:2,p:[0,0,1]}]};
 const copy=structuredClone(spec),result=softenMotion(spec);
 assert.deepEqual(spec,copy);assert.deepEqual(result.tracks.leftUpperLeg,spec.tracks.leftUpperLeg);assert.deepEqual(result.hips,spec.hips);assert.equal(result.duration,2);
 assert.ok(result.tracks.head.find(k=>k.t===1).r[0]<15);
 assert.deepEqual(result.tracks.head[0],keys[0]);assert.deepEqual(result.tracks.head.at(-1),keys.at(-1));
 assert.equal(softenMotion(result),result);
});
test('loop blending closes stationary pose/expression seams and preserves duration',async()=>{
 const THREE=await import('three');const {prepareContinuousLoop}=await import('../src/loopPlayback.js');
 const q=deg=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),deg*Math.PI/180).toArray();
 const source=new THREE.AnimationClip('loop',2,[new THREE.QuaternionKeyframeTrack('head.quaternion',[0,1,2],[...q(0),...q(30),...q(50)]),new THREE.NumberKeyframeTrack('face.weight',[0,1,2],[0,.8,.2])]);
 const {clip,state}=prepareContinuousLoop(source,'hips');assert.equal(clip.duration,2);assert.equal(state.traveling,false);
 for(const track of clip.tracks){const it=track.createInterpolant();const a=Array.from(it.evaluate(0)),b=Array.from(it.evaluate(2));for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<1e-5);}
 assert.equal(source.tracks[0].times.length,3);
});
test('traveling loops join root position and orientation across mixer cycles',async()=>{
 const THREE=await import('three');const {prepareContinuousLoop}=await import('../src/loopPlayback.js');
 const hips=new THREE.Object3D();hips.name='hips';const scene=new THREE.Object3D();scene.add(hips);
 const q=deg=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),deg*Math.PI/180).toArray();
 const source=new THREE.AnimationClip('walk',2,[new THREE.VectorKeyframeTrack('hips.position',[0,1,2],[0,1,0,0,1,1,1,1,2]),new THREE.QuaternionKeyframeTrack('hips.quaternion',[0,1,2],[...q(0),...q(30),...q(60)])]);
 const {clip,state}=prepareContinuousLoop(source,'hips');assert.equal(state.traveling,true);
 const mixer=new THREE.AnimationMixer(scene),action=mixer.clipAction(clip);mixer.addEventListener('loop',e=>state.cycles+=e.loopDelta);action.play();
 mixer.update(1.9999);const before=hips.position.clone(),beforeQ=hips.quaternion.clone();
 mixer.update(.0002);assert.ok(hips.position.distanceTo(before)<.003);assert.ok(hips.quaternion.angleTo(beforeQ)<.003);assert.equal(state.cycles,1);
 const stable=hips.position.clone();mixer.update(0);assert.ok(hips.position.distanceTo(stable)<1e-6);
 mixer.update(2);assert.equal(state.cycles,2);assert.ok(hips.position.distanceTo(stable)>.5);
});

test('switching a streamed prefix to a loop resumes the same source pose instead of skipping its phase',async()=>{
 const THREE=await import('three');const {prepareContinuousLoop}=await import('../src/loopPlayback.js');
 const source=new THREE.AnimationClip('motion',4,[new THREE.NumberKeyframeTrack('face.weight',[0,1,2,3,4],[0,.2,.8,.4,.1])]);
 const prepared=prepareContinuousLoop(source,'hips');
 for(const sourceTime of [.8,1.4,2.5]){
   const before=source.tracks[0].createInterpolant().evaluate(sourceTime)[0];
   const loopTime=prepared.sourceTimeToLoopTime(sourceTime);
   const after=prepared.clip.tracks[0].createInterpolant().evaluate(loopTime)[0];
   assert.ok(Math.abs(before-after)<.001);
   assert.ok(Math.abs(prepared.loopTimeToSourceTime(loopTime)-sourceTime)<1e-8);
   assert.equal(prepared.sourceTimeReliable(loopTime),true);
 }
 assert.equal(prepared.sourceTimeToLoopTime(0),0);
 assert.equal(prepared.sourceTimeToLoopTime(100),4);
 assert.equal(prepared.loopTimeToSourceTime(4),4);
 assert.equal(prepared.sourceTimeReliable(3.8),false);
 assert.equal(prepared.state.loopTimeToSourceTime,prepared.loopTimeToSourceTime);
});

test('viewer exposes original source time and marks the non-invertible seam for live resume',async()=>{
 const THREE=await import('three');const {Viewer}=await import('../src/viewer.js');
 const {prepareContinuousLoop}=await import('../src/loopPlayback.js');
 const source=new THREE.AnimationClip('source',4,[new THREE.NumberKeyframeTrack('face.weight',[0,4],[0,1])]);
 const {clip,state}=prepareContinuousLoop(source,'hips');
 const viewer=Object.create(Viewer.prototype),action={time:1,loop:THREE.LoopRepeat,getClip:()=>clip,isRunning:()=>true};
 viewer.currentAction=action;viewer._loopStates=new WeakMap([[action,state]]);
 assert.equal(viewer.getPlayback().time,1);
 assert.ok(Math.abs(viewer.getPlayback().sourceTime-1.3375)<1e-8);
 assert.equal(viewer.getPlayback().sourceTimeReliable,true);
 action.time=3.8;
 assert.equal(viewer.getPlayback().sourceTimeReliable,false);
 viewer._loopStates.delete(action);action.loop=THREE.LoopOnce;
 assert.equal(viewer.getPlayback().sourceTime,3.8);
 assert.equal(viewer.getPlayback().sourceTimeReliable,true);
});

test('viewer distinguishes a user pause from an exhausted streaming chunk',async()=>{
 const {Viewer}=await import('../src/viewer.js');
 const {LoopRepeat}=await import('three');
 const viewer=Object.create(Viewer.prototype);
 const action={time:1.25,paused:true,getClip:()=>({duration:1.25}),isRunning(){return !this.paused;}};
 viewer.currentAction=action;
 viewer._loopStates=new WeakMap();
 let updates=0;viewer.mixer={update:()=>updates++,stopAllAction(){}};
 // three.js clamps completed partial clips, which must not mean user-paused.
 assert.equal(viewer.getPlayback().paused,false);
 viewer.setPaused(true);
 assert.equal(viewer.getPlayback().paused,true);
 assert.equal(viewer.getPlayback().time,1.25);
 viewer.setPaused(false);
 assert.equal(action.paused,false);
 viewer.setPaused(true);viewer.seek(.5);
 assert.equal(viewer.getPlayback().paused,false);
 assert.equal(viewer.getPlayback().time,.5);
 assert.equal(updates,1);
 viewer.setPaused(true);viewer.stop();
 assert.equal(viewer.getPlayback().paused,false);
 action.loop=LoopRepeat;viewer._loopStates.set(action,{cycles:2});
 assert.equal(viewer.getPlayback().loop,true);
 assert.equal(viewer.getPlayback().cycles,2);
});

function parseVRMA(buffer){
 const view=new DataView(buffer),jsonLength=view.getUint32(12,true);
 const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonLength)));
 const binaryStart=20+jsonLength+8;
 const values=index=>{
   const accessor=json.accessors[index],part=json.bufferViews[accessor.bufferView];
   const size={SCALAR:1,VEC3:3,VEC4:4}[accessor.type];
   return Array.from(new Float32Array(buffer,binaryStart+(part.byteOffset??0)+(accessor.byteOffset??0),accessor.count*size));
 };
 const track=(name,path)=>{
   const channel=json.animations[0].channels.find(channel=>json.nodes[channel.target.node].name===name&&channel.target.path===path);
   const sampler=json.animations[0].samplers[channel.sampler];
   return {times:values(sampler.input),values:values(sampler.output)};
 };
 return {json,track};
}

test('VRMA loop export bakes matching pose, position and expression seams without mutating the source',async()=>{
 const {buildVRMA}=await import('../src/vrmaBuilder.js');
 const spec={name:'loop',duration:2,loop:true,
   tracks:{head:[{t:0,r:[0,0,0]},{t:1,r:[35,0,0]},{t:2,r:[60,0,0]}]},
   hips:[{t:0,p:[0,0,0]},{t:1,p:[.1,.1,0]},{t:2,p:[.15,0,0]}],
   expressions:{happy:[{t:0,w:0},{t:1,w:.8},{t:2,w:.4}]}};
 const snapshot=structuredClone(spec);
 const raw=parseVRMA(buildVRMA(spec)),baked=parseVRMA(buildVRMA(spec,{seamlessLoop:true}));
 assert.deepEqual(spec,snapshot);
 assert.equal(raw.json.animations[0].extras.textToMotionLoop.prepared,false);
 assert.deepEqual(baked.json.animations[0].extras.textToMotionLoop,
   {version:1,enabled:true,prepared:true,traveling:false,rootMotion:'accumulate'});
 for(const [name,path,size] of [['J_head','rotation',4],['J_hips','translation',3],['E_happy','translation',3]]){
   const original=raw.track(name,path),joined=baked.track(name,path);
   assert.ok(joined.times.length>original.times.length);
   assert.equal(joined.times.at(-1),2);
   for(let i=0;i<size;i++)assert.ok(Math.abs(joined.values[i]-joined.values.at(-size+i))<1e-5);
 }
 const finite=parseVRMA(buildVRMA({...spec,loop:false},{seamlessLoop:true}));
 assert.equal(finite.json.animations[0].extras.textToMotionLoop.enabled,false);
 assert.equal(finite.json.animations[0].extras.textToMotionLoop.prepared,false);
 assert.deepEqual(finite.track('J_head','rotation'),raw.track('J_head','rotation'));
});

test('reloading an exported traveling loop does not blend it twice and still joins root cycles',async()=>{
 const THREE=await import('three');const {buildVRMA}=await import('../src/vrmaBuilder.js');
 const {prepareContinuousLoop}=await import('../src/loopPlayback.js');
 const spec={name:'travel',duration:2,loop:true,
   tracks:{hips:[{t:0,r:[0,0,0]},{t:1,r:[0,25,0]},{t:2,r:[0,60,0]}]},
   hips:[{t:0,p:[0,0,0]},{t:1,p:[0,0,1]},{t:2,p:[1,0,2]}]};
 const baked=parseVRMA(buildVRMA(spec,{seamlessLoop:true}));
 const p=baked.track('J_hips','translation'),q=baked.track('J_hips','rotation');
 const source=new THREE.AnimationClip('travel',2,[new THREE.VectorKeyframeTrack('hips.position',p.times,p.values),new THREE.QuaternionKeyframeTrack('hips.quaternion',q.times,q.values)]);
 const metadata=baked.json.animations[0].extras.textToMotionLoop;
 const {clip,state,sourceTimeToLoopTime}=prepareContinuousLoop(source,'hips',metadata);
 assert.equal(sourceTimeToLoopTime(.75),.75);
 for(let i=0;i<source.tracks.length;i++){
   assert.deepEqual(Array.from(clip.tracks[i].times),Array.from(source.tracks[i].times));
   assert.deepEqual(Array.from(clip.tracks[i].values),Array.from(source.tracks[i].values));
 }
 const scene=new THREE.Object3D(),hips=new THREE.Object3D();hips.name='hips';scene.add(hips);
 const mixer=new THREE.AnimationMixer(scene),action=mixer.clipAction(clip);
 mixer.addEventListener('loop',event=>state.cycles+=event.loopDelta);action.play();
 mixer.update(1.9999);const before=hips.position.clone(),rotation=hips.quaternion.clone();
 mixer.update(.0002);
 assert.equal(state.cycles,1);
 assert.ok(hips.position.distanceTo(before)<.003);
 assert.ok(hips.quaternion.angleTo(rotation)<.003);
});
