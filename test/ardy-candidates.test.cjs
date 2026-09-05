const test=require('node:test');const assert=require('node:assert/strict');
const entry=(sliding,drop=0,movement=1)=>({spec:{duration:3},view:{metrics:{estimatedContactSlideMps:sliding,maxFootDropBelowRestM:drop,plannedContactSlideMps:null,meanTargetErrorM:null},trajectory:[{t:0,positions:{leftHand:[0,0,0],hips:[0,0,0]}},{t:3,positions:{leftHand:[movement,0,0],hips:[movement,0,0]}}]}});
test('comparable measured actions outrank slightly lower sliding without bypassing physical checks',async()=>{
 const {chooseArdyCandidate}=await import('../src/ardyCandidates.js');
 const a=entry(.04),b=entry(.045),c=entry(.01,.2);
 [a,b,c].forEach((e,i)=>e.view.compliance={total:2,measured:2,passed:i?2:0,contract:'same'});
 const r=chooseArdyCandidate([a,b,c]);assert.equal(r.selected,1);assert.equal(r.compareCompliance,true);
 b.view.compliance.contract='different';assert.equal(chooseArdyCandidate([a,b]).compareCompliance,false);
});
test('candidate selection improves contact metrics without preferring motion collapse',async()=>{
 const {chooseArdyCandidate}=await import('../src/ardyCandidates.js');
 const report=chooseArdyCandidate([entry(.15),entry(.04,0,.9),entry(0,0,.1)]);
 assert.equal(report.selected,1);assert.equal(report.decisions[2].reason,'activity');
});
test('candidate selection preserves original for worsening, missing, or insignificant metrics',async()=>{
 const {chooseArdyCandidate}=await import('../src/ardyCandidates.js');
 assert.equal(chooseArdyCandidate([entry(.1),entry(.095),entry(.01,.15)]).selected,0);
 assert.equal(chooseArdyCandidate([entry(null),entry(.001)]).selected,0);
 const changed=entry(0);changed.spec.duration=7;
 assert.equal(chooseArdyCandidate([entry(.1),changed]).decisions[1].reason,'duration');
});
test('reference motion metric stays distinct from unconfirmed ground contact',async()=>{
 const {measureMotion}=await import('../src/motionReview.js');
 const samples=Array.from({length:21},(_,i)=>({t:i/20,positions:{leftFoot:[i/200,.2,0],rightFoot:[0,.2,0]}}));
 const metrics=measureMotion(samples,{phases:[{start:0,end:1,support:'none',targets:[]}]},{leftFoot:[0,0,0],rightFoot:[0,0,0]});
 assert.equal(metrics.estimatedContactSlideMps,null);
 assert.ok(Math.abs(metrics.lowFootHorizontalSpeedMps-.05)<1e-6);
 const {chooseArdyCandidate}=await import('../src/ardyCandidates.js');
 const a=entry(null),b=entry(null);a.view.metrics.lowFootHorizontalSpeedMps=.1;b.view.metrics.lowFootHorizontalSpeedMps=.03;
 const report=chooseArdyCandidate([a,b]);assert.equal(report.selected,1);assert.equal(report.metric,'lowFootHorizontalSpeedMps');
});
test('candidate generation uses different seeds and retains completed candidates on later failure',async()=>{
 const {generateArdyCandidates}=await import('../src/ardyCandidates.js');const seeds=[];
 const result=await generateArdyCandidates({count:3,seed:()=>42,generate:async seed=>{seeds.push(seed);if(seed===44)throw new Error('engine disconnected');return {duration:3};},inspect:async()=>entry(.1).view});
 assert.deepEqual(seeds,[42,43,44]);assert.equal(result.entries.length,2);assert.equal(result.selected,0);assert.equal(result.error,'engine disconnected');
 await assert.rejects(generateArdyCandidates({count:3,generate:async()=>{throw new Error('first failed');}}),/first failed/);
});
