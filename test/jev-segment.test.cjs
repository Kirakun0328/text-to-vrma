const test = require('node:test');
const assert = require('node:assert/strict');
const base = () => ({text:'A person raises the left hand.', duration:2, continuous:false, body:['leftArm'], rootAxes:[false,true,false],
  head:[],gaze:[],face:[{at:0,happy:.4,sad:0,angry:0,surprised:0,relaxed:.2},{at:1,happy:.6,sad:0,angry:0,surprised:0,relaxed:.1}]});
const context = {confidence:.05,affect:{happy:{value:.8,confidence:.9}},affect_end:{happy:{value:.2,confidence:.8}},
  gaze:'down',gaze_end:'forward',tempo:'slow',movement_scale:'small',reaction:'wave',
  confidences:{gaze:.8,gaze_end:.9,tempo:.9,scale:.8}};
test('Jev changes only delegated nuance, preserving actions, timing, ownership and source data',async()=>{
  const {enrichJevSegment}=await import('../src/jevSegment.js');
  for(const jev of [0,1,2,4,7]){
    const source={...base(),jev}, before=structuredClone(source);
    const {segment,fields}=enrichJevSegment(source,context,0,2);
    assert.deepEqual(source,before);
    for(const key of ['text','duration','continuous','body','rootAxes','head'])assert.deepEqual(segment[key],source[key]);
    if(!(jev&1))assert.deepEqual(segment.face,source.face);else{assert.ok(segment.face[0].happy>.4);assert.ok(segment.face[1].happy<.6);}
    if(!(jev&2))assert.deepEqual(segment.gaze,[]);else assert.ok(segment.gaze[0][1]>0);
    if(!(jev&4))assert.equal(segment.jevContext,undefined);else{
      assert.equal(segment.jevContext.tempo,'slow');assert.equal(segment.jevContext.reaction,undefined);
      assert.equal(segment.jevContext.affect,undefined);
    }
    assert.equal(fields.length,jev===7?3:jev===0?0:1);
  }
});
test('explicit gaze and neutral moments remain intact; late segments use end evidence',async()=>{
  const {enrichJevSegment}=await import('../src/jevSegment.js');
  const source={...base(),jev:3,gaze:[[0,0,-20],[1,0,0]]};
  source.face[0].happy=0;source.face[0].relaxed=0;
  const result=enrichJevSegment(source,context,8,10).segment;
  assert.deepEqual(result.gaze,source.gaze);assert.deepEqual(result.face[0],source.face[0]);
  assert.ok(result.face[1].happy<source.face[1].happy);
  assert.deepEqual(enrichJevSegment(source,null,0,2).segment,source);
});

test('zero-confidence evidence leaves authored channels untouched; starting tempo does not leak into changed actions', async () => {
  const { enrichJevSegment } = await import('../src/jevSegment.js');
  const source = { ...base(), jev: 7 };
  const zero = { gaze:'left', tempo:'fast', confidence:0 };
  assert.deepEqual(enrichJevSegment(source, zero, 0, 4), { segment:source, fields:[] });
  const changed = { ...context, temporal:{body_changes:.9} };
  assert.equal(enrichJevSegment(source, changed, 0, 4).segment.jevContext.tempo, 'slow');
  const later = enrichJevSegment(source, changed, 2, 4).segment;
  assert.equal(later.jevContext.tempo, undefined);
  assert.equal(later.jevContext.movement_scale, 'small');
});
