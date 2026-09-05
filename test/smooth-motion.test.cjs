const test = require('node:test');
const assert = require('node:assert/strict');

test('smooths a raised leg and ankle while preserving the supporting leg and travel', async () => {
  const {softenMotion} = await import('../src/smoothMotion.js');
  const keys = fn => Array.from({length:41},(_,i)=>({t:i/20,r:[fn(i/20),0,0]}));
  const raised = t => t<.4 ? 60*t/.4 : t>1.6 ? 60*(2-t)/.4 : 60;
  const spec = {duration:2,tracks:{
    leftUpperLeg:keys(t=>raised(t)+(t===1?20:0)),
    leftLowerLeg:keys(t=>t===1?20:0), leftFoot:keys(t=>t===1?20:0),
    rightUpperLeg:keys(()=>0), rightLowerLeg:keys(()=>0),rightFoot:keys(()=>0),
    hips:keys(()=>0),
  },hips:[{t:0,p:[0,0,0]},{t:2,p:[0,0,1]}],expressions:{happy:[{t:0,w:1}]}};
  const original = structuredClone(spec), result = softenMotion(spec);
  for(const bone of ['leftUpperLeg','leftLowerLeg','leftFoot']) {
    const before=spec.tracks[bone].find(k=>k.t===1).r[0];
    const after=result.tracks[bone].find(k=>k.t===1).r[0];
    assert.ok(after<before && before-after<=2.00001,`${bone}: ${before} -> ${after}`);
    assert.deepEqual(result.tracks[bone][0],spec.tracks[bone][0]);
    assert.deepEqual(result.tracks[bone].at(-1),spec.tracks[bone].at(-1));
    assert.deepEqual(result.tracks[bone].find(k=>k.t===.05),spec.tracks[bone].find(k=>k.t===.05));
  }
  for(const bone of ['rightUpperLeg','rightLowerLeg','rightFoot','hips']) assert.deepEqual(result.tracks[bone],spec.tracks[bone]);
  assert.deepEqual(spec,original);
  assert.deepEqual(result.hips,spec.hips);
  assert.deepEqual(result.expressions,spec.expressions);
  assert.equal(result.duration,spec.duration);
  assert.equal(result.smoothing.scope,'fullBody');
  assert.equal(softenMotion(result),result);
});

test('smooths the pelvis in flight, preserves landings, and upgrades old smoothing without repeating it', async()=>{
  const {softenMotion} = await import('../src/smoothMotion.js');
  const keys=Array.from({length:41},(_,i)=>({t:i/20,r:[i===20?20:0,0,0]}));
  const spec={duration:2,tracks:{hips:keys,head:structuredClone(keys)},
    hips:[{t:0,p:[0,0,0]},{t:.4,p:[0,.4,0]},{t:1.6,p:[0,.4,0]},{t:2,p:[0,0,0]}],smoothing:{version:1,scope:'upperBody'}};
  const result=softenMotion(spec);
  const peak=result.tracks.hips.find(k=>k.t===1).r[0];
  assert.ok(peak<20 && peak>=18.99999);
  assert.deepEqual(result.tracks.head,spec.tracks.head);
  assert.deepEqual(result.hips,spec.hips);
  assert.deepEqual(result.tracks.hips[0],spec.tracks.hips[0]);
  assert.deepEqual(result.tracks.hips.at(-1),spec.tracks.hips.at(-1));
});
