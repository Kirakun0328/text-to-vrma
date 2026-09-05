const test = require('node:test');
const assert = require('node:assert/strict');
test('ARDY planning does not silently truncate actions or alter valid timing', async () => {
  const {planArdySegments}=await import('../src/llm.js');
  const run=segments=>planArdySegments('request','','model',{verify:false,request:async()=>JSON.stringify({segments})});
  for(const segments of [Array.from({length:13},()=>({text:'walk',duration:1})),[{text:'',duration:2}],[{text:'wave',duration:0}],[{text:'wave',duration:121}]]) {
    await assert.rejects(run(segments),{code:'ARDY_INVALID_PLAN'});
  }
  const plan=await run([{text:'hold the requested pose',duration:40},{text:'blink',duration:.5}]);
  assert.deepEqual(plan.segments.map(s=>s.duration),[40,.5]);
});
test('ARDY verification can remove an unrequested action', async () => {
  const {planArdySegments}=await import('../src/llm.js');let calls=0;
  const plan=await planArdySegments('wave, do not jump','','model',{verify:true,request:async()=>JSON.stringify({segments:++calls===1?[{text:'wave',duration:3},{text:'jump',duration:3}]:[{text:'wave',duration:3}]})});
  assert.equal(plan.segments.length,1);assert.equal(plan.segments[0].text,'wave');
});

test('OpenAI fast lowers reasoning and defaults to a single generation', async t => {
  const { generateMotionWithOpenAI } = await import('../src/llm.js');
  const calls=[];
  const spec={name:'nod',duration:2,loop:false,tracks:{head:[{t:0,r:[0,0,0]},{t:2,r:[0,0,0]}]}};
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify(spec)}}]});
  });
  await generateMotionWithOpenAI('nod','test','gpt-6-astra',{speed:'fast'});
  assert.equal(calls.length,1);assert.equal(calls[0].reasoning_effort,'low');
  await generateMotionWithOpenAI('nod','test','gpt-6-astra',{speed:'fast',refine:true});
  assert.equal(calls.length,3);
});

test('ARDY planner can use an injected subscription or Claude transport once', async () => {
  const {planArdySegments}=await import('../src/llm.js');let calls=0;
  const result=await planArdySegments('walk','','gpt-6-astra',{verify:false,request:async(_messages,_key,_model,_delta,config)=>{
    calls++;assert.equal(config.outputType,'ardy');return JSON.stringify({segments:[{text:'walk forward',duration:3}],expression:null});
  }});
  assert.equal(calls,1);assert.equal(result.segments[0].text,'walk forward');
});
