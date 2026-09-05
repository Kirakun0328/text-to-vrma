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
