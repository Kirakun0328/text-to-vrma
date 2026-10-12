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

test('all keyframe providers preserve generated arm and wrist tracks without adding random choreography', async t => {
  const { generateMotionWithOpenAI, generateMotionWithClaude, generateMotionWithCodex } = await import('../src/llm.js');
  const spec = {
    name: 'requestedMotion', duration: 2, loop: false,
    tracks: {
      rightUpperArm: [{ t: 0, r: [0, 0, -60] }, { t: 2, r: [0, 0, -60] }],
      rightLowerArm: [{ t: 0, r: [0, 0, -45] }, { t: 2, r: [0, 0, -45] }],
      rightHand: [{ t: 0, r: [12, 3, 4] }, { t: 2, r: [10, 4, 2] }],
    },
  };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    sent.push(request.messages.find(message => message.role === 'user').content);
    return Response.json({
      choices: [{ message: { content: JSON.stringify(spec) } }],
      content: [{ type: 'text', text: JSON.stringify(spec) }],
    });
  });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { codexBridge: { generateMotion: async input => {
      sent.push(input.prompt);
      return structuredClone(spec);
    } } },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  });
  for (const input of ['手を振る', '手を振るのではなく右腕を伸ばす']) {
    const results = [
      await generateMotionWithOpenAI(input, 'test', 'model', { refine: false }),
      await generateMotionWithClaude(input, 'test', 'claude-opus-5-5', { refine: false }),
      await generateMotionWithCodex(input, 'model', { refine: false }),
    ];
    for (const result of results) {
      assert.deepEqual(result.tracks, spec.tracks);
      assert.equal(Object.hasOwn(result, 'flavor'), false);
    }
    for (const prompt of sent.splice(0)) assert.equal(prompt, `次の動きのモーションを作成: ${input}\n`);
  }
});

test('Jev context keeps semantic assistance without injecting a gesture classification', async () => {
  const { formatMotionContextBlock } = await import('../src/llm.js');
  const context = formatMotionContextBlock({
    emotion: 'joy', emotion_intensity: 0.4, reaction: 'wave',
    movement_energy: 0.7, movement_scale: 'large', tempo: 'fast',
  });
  assert.equal(JSON.parse(context.split('\n').at(-1)).emotion, 'joy');
  assert.equal(JSON.parse(context.split('\n').at(-1)).movement_energy, 0.7);
  assert.doesNotMatch(context, /"reaction"|wave/);
});
