// Chrome launched with --remote-debugging-port=9223; no model calls are made.
import { writeFile } from 'node:fs/promises';
const tabs = await fetch('http://127.0.0.1:9223/json').then(r => r.json());
const tab = tabs.find(t => t.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):5173/.test(t.url));
if (!tab) throw new Error('Open the local app in the debug browser first');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next = 0; const pending = new Map();
socket.onmessage = event => {
  const data = JSON.parse(event.data);
  if (pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  }
};
const call = (method, params = {}) => new Promise((resolve,reject)=>{
  const id=++next; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params}));
});
try {
  await call('Page.navigate', { url: 'http://localhost:5173/' });
  await new Promise(resolve=>setTimeout(resolve,1500));
  if (process.argv.includes('--live') || process.argv.includes('--live-ardy')) {
    const ardyLive = process.argv.includes('--live-ardy');
    const liveModel = process.env.REVIEW_MODEL || 'gpt-5.6-sol';
    // Explicit opt-in: consumes Codex subscription usage, never calls the API route.
    const started = await call('Runtime.evaluate', { awaitPromise: true, expression: `(async()=>{
      const auth=document.getElementById('authMode');auth.value=${JSON.stringify(ardyLive ? 'ardy' : 'codex')};auth.dispatchEvent(new Event('change'));
      document.getElementById('ardyPlanner').value='codex';document.getElementById('ardyPlanner').dispatchEvent(new Event('change'));
      for(let i=0;i<60 && document.getElementById('codexModelSelect').disabled;i++) await new Promise(r=>setTimeout(r,500));
      const model=document.getElementById('codexModelSelect');
      if(![...model.options].some(o=>o.value===${JSON.stringify(liveModel)})) throw new Error('Requested model unavailable');
      model.value=${JSON.stringify(liveModel)};
      document.getElementById('visualReviewCheck').checked=true;
      document.getElementById('visualReviewCheck').dispatchEvent(new Event('change'));
      document.getElementById('refineCheck').checked=true;
      document.getElementById('reviewSpeed').value=${JSON.stringify(process.env.REVIEW_SPEED || 'quality')};
      document.getElementById('ardyDuration').value='3';
      document.getElementById('autoLengthCheck').checked=false;
      document.getElementById('loopSelect').value='off';
      document.getElementById('textInput').value=${JSON.stringify(process.env.REVIEW_PROMPT || '両足を床につけた自然な立ち姿勢から、一度ゆっくりお辞儀して、元の立ち姿勢に戻る。腕は体の横に下ろす。')};
      document.getElementById('generateBtn').click();
    })()` });
    if (started.exceptionDetails) throw new Error(started.exceptionDetails.exception?.description || started.exceptionDetails.text);
    let last = '';
    for (let i=0;i<180;i++) {
      await new Promise(resolve=>setTimeout(resolve,3000));
      const r=await call('Runtime.evaluate',{returnByValue:true,expression:`({busy:document.getElementById('generateBtn').disabled,status:document.getElementById('status').textContent,outcome:document.getElementById('reviewOutcome').textContent,metrics:document.getElementById('reviewMetrics').textContent,spec:window.__lastSpec})`});
      const state=r.result.value;
      if(state.status!==last){console.log(state.status);last=state.status;}
      if(!state.busy){
        await writeFile('release/review-live-result.json',JSON.stringify(state,null,2));
        if(!state.spec || !state.outcome) throw new Error('Live generation failed: '+state.status);
        console.log(JSON.stringify({outcome:state.outcome,metrics:state.metrics}));
        const report=await call('Runtime.evaluate',{returnByValue:true,expression:'window.__lastReview'});
        await writeFile('release/review-complete-report.json',JSON.stringify(report.result.value,null,2));
        const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
        await writeFile('release/review-live-screen.png',Buffer.from(shot.data,'base64'));
        socket.close();process.exit(0);
      }
    }
    throw new Error('Live review timed out');
  }
  const response = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    for(let i=0;i<120 && !window.__viewer?.vrm;i++) await new Promise(r=>setTimeout(r,250));
    const viewer=window.__viewer;
    if (!viewer?.vrm) throw new Error('VRM failed to load');
    if(!document.getElementById('manualReviewBtn').classList.contains('hidden'))throw new Error('Manual correction must be hidden for idle motion');
    if(document.getElementById('refineCheck').checked)throw new Error('Automatic correction must start OFF');
    const auth=document.getElementById('authMode');
    if([...auth.options].map(o=>o.value).join(',')!=='ardy,codex,api-key,claude') throw new Error('Engine order is wrong');
    auth.value='ardy';auth.dispatchEvent(new Event('change'));
    const planner=document.getElementById('ardyPlanner');
    if([...document.getElementById('reviewSpeed').options].map(o=>o.textContent).join(',')!=='標準,速度優先,品質優先') throw new Error('Review mode labels/order incorrect');
    if(document.querySelector('[data-i18n="engine.apiKey"]').textContent!=='OpenAI API') throw new Error('Engine naming inconsistent');
    for(const [provider,id] of [['codex','codexSettings'],['openai','apiSettings'],['claude','claudeSettings']]) {
      planner.value=provider;planner.dispatchEvent(new Event('change'));
      if(document.getElementById(id).classList.contains('hidden') || document.getElementById(id).parentElement.id!=='ardyGptSlot') throw new Error('Planner UI routing failed: '+provider);
    }
    planner.value='codex';planner.dispatchEvent(new Event('change'));
    const visual=document.getElementById('visualReviewCheck'), refine=document.getElementById('refineCheck');
    refine.checked=true;
    visual.checked=true;visual.dispatchEvent(new Event('change'));
    if(visual.disabled || refine.disabled || refine.parentElement.classList.contains('hidden')) throw new Error('ARDY correction controls unavailable');
    planner.value='none';planner.dispatchEvent(new Event('change'));
    if(!visual.disabled || !refine.disabled) throw new Error('No-AI controls must explain unavailable correction');
    planner.value='codex';planner.dispatchEvent(new Event('change'));
    for(let i=0;i<80 && !document.querySelector('#codexUsageRows progress');i++) await new Promise(r=>setTimeout(r,250));
    const usage=document.getElementById('codexUsageRows').textContent;
    const otherUsage=document.querySelector('#codexUsageRows details');
    if(otherUsage?.open) throw new Error('Other model quotas should start collapsed');
    if(document.getElementById('correctionHelp').open) throw new Error('Long correction help should start collapsed');
    if(!usage.includes('使用') || !usage.includes('リセット')) throw new Error('Live usage not displayed: '+document.getElementById('codexUsageUpdated').textContent);
    const {inspectMotion}=await import('/src/reviewCapture.js');
    const {generateReviewedMotion}=await import('/src/motionReview.js');
    const spec={name:'nod',duration:2,loop:false,tracks:{head:[{t:0,r:[0,0,0]},{t:1,r:[20,0,0]},{t:2,r:[0,0,0]}],leftUpperArm:[{t:0,r:[0,0,-70]},{t:2,r:[0,0,-70]}],rightUpperArm:[{t:0,r:[0,0,70]},{t:2,r:[0,0,70]}]}};
    const plan={duration:2,phases:[{start:0,end:2,support:'both',targets:[]}]};
    let n=0; const previous=viewer.currentAction;
    const result=await generateReviewedMotion('nod','','mock',{skeleton:viewer.reviewSkeleton,inspect:(s,p)=>inspectMotion(viewer,s,p),request:async()=>JSON.stringify(++n===1?plan:spec)});
    if(viewer.currentAction!==previous) throw new Error('Playback was not restored');
    if(!result.before.images.every(u=>u.length>10000)) throw new Error('Missing rendered images');
    const originalFetch=window.fetch, originalGenerate=window.codexBridge.generateJson;
    let engineCalls=0, aiCalls=0, sawImages=false;
    try {
      window.fetch=async (url, init)=>{
        if(String(url).endsWith('/health')) return Response.json({status:'ok',model:'test',device:'cpu'});
        if(String(url).endsWith('/progress')) return Response.json({active:false});
        if(String(url).endsWith('/generate')) { engineCalls++; return Response.json(structuredClone(spec)); }
        return originalFetch(url,init);
      };
      window.codexBridge.generateJson=async ({messages,outputType})=>{
        aiCalls++;sawImages ||= messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
        return JSON.stringify(outputType==='assessment'?{needed:true,reason:'テストの修正判定',issues:[]}:{segments:[{text:'nod naturally',duration:2}],expression:null,checks:[{kind:'travel',segmentIndex:0,side:'both'}]});
      };
      document.getElementById('textInput').value='自然にうなずく';
      document.getElementById('autoLengthCheck').checked=false;
      document.getElementById('ardyDuration').value='2';
      refine.checked=true;
      document.getElementById('reviewSpeed').value='fast';
      for(const withImages of [false,true]) {
        engineCalls=0;aiCalls=0;sawImages=false;
        visual.checked=withImages;visual.dispatchEvent(new Event('change'));
        document.getElementById('generateBtn').click();
        await new Promise(r=>setTimeout(r,50));
        for(let i=0;i<200 && document.getElementById('generateBtn').disabled;i++) await new Promise(r=>setTimeout(r,50));
        if(engineCalls!==2 || aiCalls!==3 || sawImages!==withImages) throw new Error('ARDY integration failed '+JSON.stringify({engineCalls,aiCalls,sawImages,status:document.getElementById('status').textContent}));
        const dialog=document.getElementById('reviewResults');
        if(dialog.closest('#panel') || dialog.open) throw new Error('Comparison must not interrupt settings or playback');
        document.getElementById('reviewCompareBtn').click();
        if(!dialog.open || !document.getElementById('reviewPlan').textContent.includes('未測定') || document.getElementById('reviewPlan').textContent.includes('"support"')) throw new Error('Readable ARDY comparison missing');
        document.getElementById('reviewDraftBtn').click();
        for(let i=0;i<30 && dialog.open;i++) await new Promise(r=>setTimeout(r,50));
        if(dialog.open) throw new Error('Comparison playback must return to the viewer');
      }
      refine.checked=false;refine.dispatchEvent(new Event('change'));
      if(document.getElementById('reviewImageOption').classList.contains('hidden') || visual.disabled) throw new Error('Manual correction settings must remain available with automatic review OFF');
      engineCalls=0;aiCalls=0;sawImages=false;
      document.getElementById('generateBtn').click();
      await new Promise(r=>setTimeout(r,50));
      for(let i=0;i<200&&document.getElementById('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,50));
      if(engineCalls!==1||aiCalls!==1||sawImages) throw new Error('Review OFF still runs correction');
      if(window.__motionChecks?.total!==1||window.__motionChecks.passed!==0||document.getElementById('motionCheckResults').classList.contains('hidden'))throw Error('Missing action was not exposed');
      if(!document.getElementById('generationRoute').textContent.includes('Codex'))throw Error('Planning route missing');
      for (const [code, prefix] of [['en','▶ Motion playback'],['zh','▶ 动作播放'],['ko','▶ 모션 재생'],['ja','▶ モーション再生']]) {
        const language=document.getElementById('langSelect');language.value=code;language.dispatchEvent(new Event('change'));
        const message=document.getElementById('playbackTitle').textContent;
        if(!message.startsWith(prefix))throw new Error('Playback status did not change language: '+message);
        if(document.getElementById('playbackCard').classList.contains('hidden')||document.getElementById('playbackCard').querySelector('details').open)throw Error('Playback card should show compact metadata with details closed');
        if(code!=='ja'&&/[ぁ-ゖァ-ヺ]/.test(document.getElementById('motionCheckResults').textContent+document.getElementById('generationRoute').textContent))throw Error('Untranslated measurement UI');
        if(/自動英訳:|Auto-translated:/.test(message))throw new Error('Internal translation still shown in playback status');
      }
      if(!document.getElementById('reviewCompareBtn').classList.contains('hidden'))throw new Error('Stale comparison shown for new unreviewed motion');
      // Manual correction must work with automatic review off, without regenerating ARDY.
      spec.duration=17;
      for(const keys of Object.values(spec.tracks)) for(const k of keys) k.t*=17/2;
      document.getElementById('ardyDuration').value='17';
      document.getElementById('generateBtn').click();
      await new Promise(r=>setTimeout(r,50));
      for(let i=0;i<200&&document.getElementById('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,50));
      const beforeManual=engineCalls;let patches=0,verdicts=0;
      if(document.getElementById('manualReviewBtn').classList.contains('hidden'))throw new Error('Manual correction missing after generation');
      window.codexBridge.generateJson=async({outputType})=>{
        const panel=document.getElementById('reviewProgress');
        if(panel.classList.contains('hidden')||!document.getElementById('reviewProgressPercent').textContent.includes('%'))throw new Error('Correction progress panel missing');
        if(document.getElementById('manualReviewBtn').textContent!=='この動きを修正')throw new Error('Progress should not replace button text');
        const pct=document.getElementById('reviewProgressBar').value;
        if(pct<=0||pct>=100)throw new Error('Invalid in-flight stage progress');
        if(outputType==='assessment')throw new Error('Manual correction must bypass preflight');
        if(outputType==='verdict'){verdicts++;return JSON.stringify({improved:false,reason:'Test: improvement uncertain',resolvedIssues:[],remainingIssues:[]});}
        const d=patches++===0?15:2;
        return JSON.stringify({summary:'Test correction',issues:[{start:0,end:d,bone:'head',problem:'Test',change:'Test'}],root:[],rotations:[{bone:'head',keys:[{t:0,r:[0,0,0]},{t:d/2,r:[5,0,0]},{t:d,r:[0,0,0]}]}]});
      };
      document.getElementById('manualReviewBtn').click();
      await new Promise(r=>setTimeout(r,50));
      for(let i=0;i<400&&document.getElementById('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,50));
      if(patches!==2||verdicts!==2||engineCalls!==beforeManual||window.__lastReview?.candidate?.duration!==17)throw new Error('Manual 17s correction failed: '+document.getElementById('status').textContent);
      if(window.__lastReview.accepted)throw new Error('Rejected candidate should need explicit adoption');
      if(!document.getElementById('reviewResults').open)throw new Error('Manual comparison not opened');
      if(!document.getElementById('reviewProgress').classList.contains('hidden'))throw new Error('Progress remains after completion');
      document.getElementById('reviewAdoptBtn').click();
      for(let i=0;i<80&&document.getElementById('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,50));
      if(window.__lastSpec.duration!==17||document.getElementById('reviewResults').open)throw new Error('Manual adoption failed');
      const lang=document.getElementById('langSelect');
      for(const code of ['en','zh','ko']) {
        lang.value=code;lang.dispatchEvent(new Event('change'));
        for(const id of ['reviewImageOption','correctionHelp','reviewSpeedRow','reviewModeNote','reviewTitle','manualReviewBtn','reviewAdoptBtn']) {
          if(/[ぁ-ゖァ-ヺ]/.test(document.getElementById(id).textContent))throw new Error('Untranslated Japanese in '+code+': '+id);
        }
        const toggle=document.querySelector('.ai-settings-toggle');toggle.click();
        await new Promise(r=>setTimeout(r,30));
        if(/[ぁ-ゖァ-ヺ]/.test(toggle.textContent))throw new Error('Untranslated AI settings toggle');
      }
      lang.value='ja';lang.dispatchEvent(new Event('change'));
      refine.checked=true;refine.dispatchEvent(new Event('change'));
    } finally { window.fetch=originalFetch;window.codexBridge.generateJson=originalGenerate; }
    return {usage,bones:Object.keys(viewer.reviewSkeleton.restPositions).length,metrics:result.before.metrics,accepted:result.accepted,images:result.before.images};
  })()` });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  const result = response.result.value;
  for (const [i, data] of result.images.entries()) await writeFile(`release/review-${i ? 'side' : 'front'}.jpg`, Buffer.from(data.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ...result, images: result.images.map(u => u.length) }));
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Runtime.evaluate',{expression:"if(!document.getElementById('reviewCompareBtn').classList.contains('hidden')) document.getElementById('reviewCompareBtn').click(); document.getElementById('panel').scrollTop=300;"});
  const shot=await call('Page.captureScreenshot',{format:'png'});
  await writeFile('release/review-ui-screen.png',Buffer.from(shot.data,'base64'));
} finally { socket.close(); }
