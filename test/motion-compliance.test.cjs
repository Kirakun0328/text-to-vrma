const test=require('node:test');const assert=require('node:assert/strict');
const rest={head:[0,1.6,0],hips:[0,.9,0],leftFoot:[-.1,0,0],rightFoot:[.1,0,0],leftHand:[-.3,.8,0],rightHand:[.3,.8,0]};
const frames=(change=()=>{})=>Array.from({length:41},(_,i)=>{const f={t:i/20,positions:structuredClone(rest)};change(f,i);return f;});
const plan=(kind,side='both')=>({segments:[{duration:2}],checks:[{kind,side,segmentIndex:0}]});
test('correction cannot trade away a previously detected action',async()=>{
 const {hasComplianceRegression:r}=await import('../src/motionCompliance.js');
 const a={total:2,contract:'same',checks:[{passed:true},{passed:false}]};
 assert.equal(r(a,{total:2,contract:'same',checks:[{passed:false},{passed:true}]}),true);
 assert.equal(r(a,{total:2,contract:'same',checks:[{passed:true},{passed:true}]}),false);
 assert.equal(r(a,{total:2,contract:'different',checks:[{passed:false},{passed:true}]}),false);
});
test('checks reject idle motion for travel and detect actual displacement',async()=>{
 const {measureMotionChecks:measure}=await import('../src/motionCompliance.js');
 assert.equal(measure(frames(),plan('travel'),2,rest).passed,0);
 assert.equal(measure(frames(f=>f.positions.hips[2]=f.t*.3),plan('travel'),2,rest).passed,1);
});
test('jump needs both feet and sustained clearance, not one foot or a noisy frame',async()=>{
 const {measureMotionChecks:m}=await import('../src/motionCompliance.js');
 assert.equal(m(frames(f=>f.positions.leftFoot[1]=.2),plan('jump'),2,rest).passed,0);
 assert.equal(m(frames((f,i)=>{if(i===20)f.positions.leftFoot[1]=f.positions.rightFoot[1]=.2;}),plan('jump'),2,rest).passed,0);
 assert.equal(m(frames((f,i)=>{if(i>=15&&i<=25)f.positions.leftFoot[1]=f.positions.rightFoot[1]=.2;}),plan('jump'),2,rest).passed,1);
});
test('crouching, hand side and phase windows are independently checked',async()=>{
 const {measureMotionChecks:m}=await import('../src/motionCompliance.js');
 const samples=frames(f=>{f.positions.hips[1]-=f.t*.2;f.positions.rightHand[1]=1.6;});
 assert.equal(m(samples,plan('crouch'),2,rest).passed,1);
 assert.equal(m(samples,plan('raiseHand','right'),2,rest).passed,1);
 assert.equal(m(samples,plan('raiseHand','left'),2,rest).passed,0);
 const p={segments:[{duration:1},{duration:1}],checks:[{kind:'raiseHand',side:'right',segmentIndex:1}]};
 assert.equal(m(frames(f=>{if(f.t<.8)f.positions.rightHand[1]=1.6;}),p,2,rest).passed,0);
});
test('missing skeleton or sparse samples are unknown, unsupported checks are not claimed',async()=>{
 const {measureMotionChecks:m,normalizeMotionChecks:n}=await import('../src/motionCompliance.js');
 assert.equal(m(frames(),plan('jump'),2,{}).measured,0);
 assert.equal(m(frames().slice(0,2),plan('travel'),2,rest).measured,0);
 assert.deepEqual(n([{kind:'waveCount',side:'right',segmentIndex:0}],1),[]);
});
