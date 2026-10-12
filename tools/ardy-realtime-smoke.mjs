// Dedicated Chrome on 9224, dummy keys and mocked providers only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9224/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&t.url.includes(':5175'));
assert.ok(tab,'Open a dedicated debug browser on the local app');
const socket=new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let next=0;const pending=new Map();
socket.onmessage=event=>{const data=JSON.parse(event.data),p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result);};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});

async function browserSmoke(){
  const $=id=>document.getElementById(id),pause=ms=>new Promise(r=>setTimeout(r,ms));
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const waitFor=async(predicate,message)=>{for(let i=0;i<200;i++){if(predicate())return;await pause(40);}throw Error(message+': '+$('status').textContent);};
  await waitFor(()=>$('vrmName')?.textContent.includes('.vrm'),'VRM failed to load');
  const {LoopOnce,LoopRepeat}=await import('/node_modules/three/build/three.module.js');
  const viewer=window.__viewer,historyCount=()=>document.querySelectorAll('#history .hist-item').length;
  const initialHistory=historyCount();
  let codexRequests=0,codexAuthenticated=true,planFinished=false,faceOnlyUpdate=false,failNext=false,failPlan=false,playbackCalls=0;
  let playedBeforePlan=false,inferredBeforePlan=false,partialResumedAt=0,expectedPlanner='codex';
  const sessions=new Map(),creates=[],updates=[],appends=[],closes=[],nextRequests=[],plannerInputs=[],statuses=[];
  let emittedSegments=[];
  const authoredSegments=[
    {text:'A person lowers their torso and bends both knees.',duration:1,continuous:false,face:[[0,0,.6,0,0,0],[1,0,.6,0,0,0]]},
    {text:'A person rises upright and opens both arms.',duration:1,continuous:false,face:[[0,0,.6,0,0,0],[1,0,.6,0,0,0]]},
  ];
  const physical=segments=>segments.map(({text,duration})=>({text,duration}));
  const verifyAuthored=segments=>{
    check(segments?.length>0&&segments.length<=emittedSegments.length,'ARDY received a segment before it was authored');
    check(JSON.stringify(physical(segments))===JSON.stringify(physical(emittedSegments.slice(0,segments.length))),'ARDY received reordered or unplanned body text');
  };
  const copies=[],downloads=[],urls=new Map();
  const context={emotion:'joy',reaction:'nod',confidence:.2,movement_energy:.3,movement_scale:'small',tempo:'slow',
    confidences:{emotion:.85,energy:.9,scale:.9,tempo:.9},affect:{happy:{value:.8,confidence:.9},sad:{value:.2,confidence:.8}},debug:'private-do-not-forward'};
  const verifyContext=value=>{
    check(value?.confidence===.2&&value.affect?.happy?.confidence===.9&&value.confidences?.tempo===.9,'Independent Jev confidence was lost');
    check(!('reaction'in value)&&!('debug'in value),'Raw Jev data leaked into generation');
  };
  const originalFetch=window.fetch,originalPlay=viewer.playVRMA.bind(viewer),originalClipboard=navigator.clipboard.writeText;
  const originalCreateURL=URL.createObjectURL,originalAnchorClick=HTMLAnchorElement.prototype.click;
  navigator.clipboard.writeText=async text=>{copies.push(JSON.parse(text));};
  URL.createObjectURL=blob=>{const url=originalCreateURL.call(URL,blob);urls.set(url,blob);return url;};
  HTMLAnchorElement.prototype.click=function(){if(this.download&&urls.has(this.href))downloads.push({name:this.download,blob:urls.get(this.href)});else originalAnchorClick.call(this);};
  viewer.playVRMA=async(...args)=>{
    const result=await originalPlay(...args);playbackCalls++;
    if(args[3]?.active&&result!==null){
      if(expectedPlanner==='codex'&&!planFinished)playedBeforePlan=true;
      if(!args[1])check(viewer.currentAction.loop===LoopOnce,'Partial motion must not repeat');
      if(args[3]?.resume&&!args[1])partialResumedAt=Math.max(partialResumedAt,viewer.currentAction.time);
    }return result;
  };
  const observer=new MutationObserver(()=>statuses.push({planner:expectedPlanner,text:$('status').textContent}));
  observer.observe($('status'),{childList:true,characterData:true,subtree:true});
  const plannedEnd=s=>s.segments?s.origin+s.segments.reduce((sum,segment)=>sum+segment.duration,0):s.target;
  const metadata=s=>({sessionId:s.id,revision:s.revision,instructionStartTime:s.origin,targetDuration:s.target,
    plannedDuration:plannedEnd(s),planComplete:s.planComplete,duration:s.target,fps:20,horizonFrames:10});
  window.fetch=async(url,options={})=>{
    const address=String(url);
    if(address==='/__codex/status')return Response.json({available:true,account:codexAuthenticated?{type:'chatgpt'}:null});
    if(address==='/__codex/review-stream'){
      codexRequests++;planFinished=false;emittedSegments=[];
      const input=JSON.parse(options.body);check(input.outputType==='realtime_stream','Live planner did not request the streamed segment protocol');
      plannerInputs.push(JSON.parse(input.messages[1].content));
      if(failPlan)return Response.json({error:'smoke planner failed'},{status:500});
      const prefix='{"continuous":false,"duration":2,"segments":['+JSON.stringify(authoredSegments[0])+',';
      const suffix=JSON.stringify(authoredSegments[1])+']}',plan=prefix+suffix,timers=[];
      return new Response(new ReadableStream({start(c){
        const send=event=>c.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));
        timers.push(setTimeout(()=>{emittedSegments=[authoredSegments[0]];send({type:'delta',delta:prefix});},300));
        timers.push(setTimeout(()=>{emittedSegments=authoredSegments;send({type:'delta',delta:suffix});planFinished=true;send({type:'final',text:plan});c.close();},800));
      },cancel(){timers.forEach(clearTimeout);}}));
    }
    if(address.startsWith('/__codex/review')||/api\.openai\.com|api\.anthropic\.com/.test(address)){codexRequests++;throw Error('Unexpected planner endpoint: '+address);}
    if(address==='/__jev/analyze'){
      check(JSON.parse(options.body).apiKey==='smoke-test-only','Only the isolated mock Jev key may be used');await pause(30);
      return Response.json({status:200,context:faceOnlyUpdate?{update_scope:'face_only',confidences:{update_scope:.99},affect:context.affect}:context});
    }
    if(address.endsWith('/health'))return Response.json({status:'ok',model:'smoke-ARDY',device:'cpu',translator:'ready'});
    if(address.endsWith('/sessions')){
      const input=JSON.parse(options.body),id='smoke-session-'+(creates.length+1);
      if(expectedPlanner==='codex'){
        check(!('text'in input)&&input.planComplete===false,'Codex generation fell back to a raw instruction');verifyAuthored(input.segments);
        check(input.segments.length===1&&!planFinished,'Inference waited for later authored segments');
      }else check(typeof input.text==='string'&&!input.segments,'ARDY-only inference did not receive the direct instruction');
      creates.push({id,...input});
      const s={id,revision:input.revision,origin:0,target:input.duration,nextFrame:0,text:input.text,context:input.motionContext,
        segments:input.segments,planComplete:input.planComplete!==false};sessions.set(id,s);
      return Response.json(metadata(s));
    }
    const route=/\/sessions\/([^/]+)\/(next|update|append|close)$/.exec(address);
    if(route){
      const s=sessions.get(route[1]),input=JSON.parse(options.body);
      if(route[2]==='close'){closes.push(route[1]);sessions.delete(route[1]);return Response.json({closed:true});}
      if(!s)return Response.json({error:'Session is closed'},{status:404});
      if(route[2]==='append'){
        check(input.revision===s.revision&&!('text'in input),'Append changed revision or used raw text');verifyAuthored(input.segments);
        check(JSON.stringify(physical(input.segments.slice(0,s.segments.length)))===JSON.stringify(physical(s.segments)),'Append rewrote the existing prefix');
        check(!input.planComplete||planFinished,'Incomplete plan was committed');
        appends.push({sessionId:s.id,...input});s.segments=input.segments;s.planComplete=input.planComplete===true;
        return Response.json(metadata(s));
      }
      if(route[2]==='update'){
        updates.push({sessionId:s.id,...input});if(input.motionContext)verifyContext(input.motionContext);
        const retained=Math.min(s.nextFrame,Math.max(0,Math.ceil((input.playbackTime+.15)*20))),replaceFrom=retained/20;
        s.nextFrame=retained;s.revision=input.revision;
        if(input.text||input.segments){s.text=input.text;s.origin=replaceFrom;}
        if(input.segments){verifyAuthored(input.segments);s.segments=input.segments;s.planComplete=input.planComplete!==false;}
        if(input.instructionStartTime!==undefined)s.origin=input.instructionStartTime;
        if(input.duration!==undefined)s.target=Math.max(replaceFrom+.1,s.origin+input.duration);
        if('motionContext'in input)s.context=input.motionContext;
        return Response.json({...metadata(s),replaceFrom});
      }
      if(failNext)return Response.json({error:'smoke session failed'},{status:500});
      inferredBeforePlan ||=expectedPlanner==='codex'&&!planFinished;
      nextRequests.push({sessionId:s.id,revision:s.revision,...input});const revision=s.revision;await pause(90);
      if(s.revision!==revision)return Response.json({type:'stale',revision});
      const limit=Math.ceil(Math.min(s.target,plannedEnd(s))*20);
      if(s.nextFrame>=limit)return Response.json({type:s.planComplete?'complete':'waiting',revision,complete:s.planComplete});
      const frames=Array.from({length:Math.min(10,limit-s.nextFrame)},(_,i)=>(s.nextFrame+i)/20);s.nextFrame+=frames.length;
      return Response.json({type:'chunk',revision,targetDuration:s.target,complete:s.planComplete&&s.nextFrame>=limit,
        tracks:{head:frames.map(t=>({t,r:[Math.sin(t*4)*8,0,0]})),leftUpperArm:frames.map(t=>({t,r:[0,0,-70]})),rightUpperArm:frames.map(t=>({t,r:[0,0,70]}))},
        hips:frames.map(t=>({t,p:[0,0,0]})),jev:{bodyApplied:!!s.context,fields:s.context?['tempo','movement_energy']:[],segmentsApplied:s.context?1:0}});
    }
    if(address.endsWith('/generate')||address.endsWith('/generate-stream'))throw Error('Live generation used a legacy endpoint');
    return originalFetch(url,options);
  };
  const submit=(text,shift=false)=>{$('textInput').value=text;$('textInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,shiftKey:shift,bubbles:true}));};
  const waitComplete=count=>waitFor(()=>historyCount()===count&&$('genProgressText').textContent.includes('100%'),'Completed history/progress missing');
  const verifyLoop=expected=>{
    const action=viewer.currentAction;check(window.__lastSpec?.loop===expected&&action.loop===(expected?LoopRepeat:LoopOnce),'Loop preference was lost');
    viewer.setPaused(false);action.time=action.getClip().duration-.02;viewer.mixer.update(.1);
    check(expected?!action.paused&&action.time<.2:action.paused&&action.clampWhenFinished,'Loop boundary did not repeat/clamp');
  };
  const verifyExport=async(loop,authored=false)=>{
    const buttons=[...document.querySelector('#history .hist-item').querySelectorAll('button')],oldCopies=copies.length;
    buttons.find(b=>b.textContent==='📋').click();await waitFor(()=>copies.length>oldCopies,'History JSON missing');
    const copied=copies.at(-1);check(copied.loop===loop&&copied.realtime?.complete,'History JSON lost completion or loop');
    if(authored)check(copied.expressions?.sad?.at(-1)?.w===.6,'Completed authored face was not retained');
    buttons.find(b=>b.textContent==='⬇').click();const buffer=await downloads.at(-1).blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true);
    const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length))),meta=json.animations[0].extras.textToMotionLoop;
    check(meta.enabled===loop&&meta.prepared===loop,'VRMA repeat/bake metadata mismatch');
    check(json.extensions.VRMC_vrm_animation.expressions?.preset?.sad,'VRMA lost emotional face');
    await viewer.playVRMA(buffer);verifyLoop(loop);
  };
  try{
    $('authMode').value='ardy';$('authMode').dispatchEvent(new Event('change'));$('ardyPlanner').value='codex';$('ardyPlanner').dispatchEvent(new Event('change'));
    $('ardyCandidateCount').value='1';$('waypointCheck').checked=false;$('autoLengthCheck').checked=false;$('ardyDuration').value='2';$('realtimeDuration').value='2';
    $('refineCheck').checked=false;$('exprCheck').checked=true;await pause(150);
    $('jevApiKey').value='smoke-test-only';$('jevApiKey').dispatchEvent(new Event('input',{bubbles:true}));
    const settings=$('settingsBtn').getBoundingClientRect(),language=$('langSelect').getBoundingClientRect();
    check(settings.right<=language.left&&Math.abs(settings.top-language.top)<10,'Settings position regressed');
    check(!$('advancedFold')&&!$('realtimePlayBtn')&&!$('realtimeStopBtn')&&!$('jevEnable'),'Redundant controls returned');
    $('settingsBtn').click();for(const id of ['apiKey','claudeApiKey','jevApiKey','jevModel','codexSettings'])check($('apiCredentialsSettings').contains($(id)),'Credentials split: '+id);
    check($('jevApiKey').getClientRects().length&&!$('jevApiKey').disabled,'Jev key cannot be edited');
    check(localStorage.getItem('jev-api-key')==='smoke-test-only','Jev key not autosaved');check(!$('settingsDialog').contains($('motionDetails')),'Motion settings moved into API dialog');$('settingsCloseBtn').click();

    $('loopSelect').value='on';submit('自由な演技');
    await waitFor(()=>window.__lastSpec?.realtime?.source==='ardy-session'&&!window.__lastSpec.realtime.complete,'Live body did not start');
    const early=$('status').textContent;check(!planFinished&&playedBeforePlan,'Body waited for the full Codex plan');
    check(window.__lastSpec.expressions.sad?.some(key=>key.w===.6),'First authored segment started without its face');
    check(window.__lastSpec.loop===false&&historyCount()===initialHistory,'Partial motion looped or entered history');check(/\d+%/.test($('genProgressText').textContent),'Live percentage missing');
    await waitComplete(initialHistory+1);const completed=$('status').textContent;
    // Resume a raw live clip from a completed, retimed loop without changing
    // its actual pose. Pause rendering time to isolate the mapping itself.
    const {buildVRMA}=await import('/src/vrmaBuilder.js');await pause(230);
    viewer.setPaused(true);viewer.currentAction.time=.4;viewer.mixer.update(0);
    const sourceCursor=viewer.getPlayback().sourceTime;
    const head=viewer.vrm.humanoid.getNormalizedBoneNode('head'),headBefore=head.quaternion.clone();
    check(viewer.getPlayback().sourceTimeReliable&&sourceCursor>.4,'Loop did not expose original source time');
    const rawLoop=buildVRMA(window.__lastSpec);
    await viewer.playVRMA(rawLoop,false,0,{resume:true});
    check(Math.abs(viewer.getPlayback().time-sourceCursor)<.00001&&head.quaternion.angleTo(headBefore)<.003,
      'Loop-to-live resume skipped the source pose: '+JSON.stringify({expected:sourceCursor,actual:viewer.getPlayback().time,angle:head.quaternion.angleTo(headBefore)}));
    await viewer.playVRMA(rawLoop,true);
    verifyLoop(true);verifyContext(window.__lastSpec.jevContext);
    check(window.__lastSpec.realtime.jev.bodyApplied&&window.__lastSpec.jev.bodyApplied,'Jev body application not confirmed');check(window.__lastSpec.expressions.sad.at(-1).w===.6,'Final Codex face missing');
    const beforePlay=playbackCalls;document.querySelector('#history .hist-item .play').click();await waitFor(()=>playbackCalls>beforePlay,'History replay missing');
    check(historyCount()===initialHistory+1,'History replay duplicated generation');verifyLoop(true);await verifyExport(true,true);
    const beforeFreshCreate=creates.length;
    $('loopSelect').value='off';submit('単発の演技');await waitComplete(initialHistory+2);
    check(creates.length===beforeFreshCreate+1,'A new completed generation reused an old physical session');
    verifyLoop(false);await verifyExport(false,true);

    codexAuthenticated=false;$('ardyPlanner').dispatchEvent(new Event('change'));
    await waitFor(()=>$('codexAuthState').textContent.includes('未ログイン'),'Mock Codex logout was not applied');
    const beforeAuth={creates:creates.length,next:nextRequests.length,history:historyCount(),codex:codexRequests};
    submit('ログイン前の指示');await waitFor(()=>$('status').textContent.includes('ログインしてください'),'Missing credentials were not reported');await pause(180);
    check(creates.length===beforeAuth.creates&&nextRequests.length===beforeAuth.next&&historyCount()===beforeAuth.history&&codexRequests===beforeAuth.codex,
      'Unauthenticated Codex generation called ARDY or added history');
    codexAuthenticated=true;$('ardyPlanner').dispatchEvent(new Event('change'));
    await waitFor(()=>!$('codexAuthState').textContent.includes('未ログイン'),'Mock Codex login was not restored');
    failPlan=true;submit('設計が失敗する指示');await waitFor(()=>$('status').textContent.includes('smoke planner failed'),'Planner failure was not reported');await pause(180);
    check(creates.length===beforeAuth.creates&&nextRequests.length===beforeAuth.next&&historyCount()===beforeAuth.history,
      'Failed selected planner fell back to raw ARDY or entered history');failPlan=false;
    $('ardyPlanner').value='none';$('ardyPlanner').dispatchEvent(new Event('change'));expectedPlanner='none';planFinished=false;
    const codexBefore=codexRequests,updatesBefore=updates.length;submit('最初の自由な動き');
    await waitFor(()=>window.__lastSpec?.originalText==='最初の自由な動き'&&!window.__lastSpec.realtime.complete,'ARDY-only did not stream');
    const sessionId=window.__lastSpec.realtime.sessionId,activeCreates=creates.length;check($('generateBtn').textContent.includes('停止'),'Live session lost stop button');
    $('pbPlayBtn').click();const pausedAt=viewer.getPlayback().time,playCount=playbackCalls;await pause(450);
    check(playbackCalls>playCount,'Pause test received no appended chunk');
    check(viewer.getPlayback().paused&&Math.abs(viewer.getPlayback().time-pausedAt)<.03&&$('pbPlayBtn').textContent==='▶','Incoming chunks cancelled manual pause');
    const beforeFaceUpdates=updates.length;faceOnlyUpdate=true;submit('身体はそのまま、表情だけ変える',true);
    await waitFor(()=>viewer._reaction?.targets?.happy>0,'Face-only update lost');check(updates.length===beforeFaceUpdates,'Face-only update regenerated body');faceOnlyUpdate=false;
    const playedPrefix=window.__lastSpec.tracks.head.filter(k=>k.t<=pausedAt);submit('次の自由な動き');
    await waitFor(()=>updates.slice(updatesBefore).some(u=>u.text==='次の自由な動き'),'Live instruction update not sent');
    check(creates.length===activeCreates&&updates.at(-1).sessionId===sessionId,'Live update created a new inference session');
    await waitFor(()=>window.__lastSpec.originalText==='次の自由な動き','Updated session not displayed');
    check(JSON.stringify(window.__lastSpec.tracks.head.filter(k=>k.t<=pausedAt))===JSON.stringify(playedPrefix),'Live update rewrote played prefix');
    check(viewer.getPlayback().paused,'Instruction update cancelled manual pause');$('pbPlayBtn').click();await waitComplete(initialHistory+3);
    check(codexRequests===codexBefore,'ARDY-only called Codex');check(window.__lastSpec.realtime.planner==='none','ARDY-only retained a Codex plan');verifyContext(window.__lastSpec.jevContext);
    check(window.__lastSpec.realtime.jev.bodyApplied,'ARDY-only lost Jev body context');
    check(window.__lastSpec.expressions.happy?.some(k=>k.w>0)&&window.__lastSpec.expressions.sad?.some(k=>k.w>0),'ARDY-only lost independent mixed affect');
    check(document.querySelector('#history .hist-item .name').textContent==='次の自由な動き','Updated history has wrong instruction');
    check(!statuses.filter(s=>s.planner==='none').some(s=>/Codex|ChatGPT/.test(s.text)),'ARDY-only displayed Codex status');verifyLoop(false);await verifyExport(false);

    const beforeIndependentCreate=creates.length;
    $('jevApiKey').value='';submit('停止する動き');await waitFor(()=>window.__lastSpec.originalText==='停止する動き','Stop specimen did not start');
    check(creates.length===beforeIndependentCreate+1,'A completed ARDY-only session leaked into a fresh generation');
    const closedBeforeStop=closes.length;$('generateBtn').click();const stopped=$('status').textContent;await pause(350);check(historyCount()===initialHistory+3,'Stopped session entered history');
    check(closes.length>closedBeforeStop,'Manual stop did not close the live session');
    failNext=true;submit('失敗する動き');await waitFor(()=>$('status').textContent.includes('smoke session failed'),'Session error not reported');
    check(historyCount()===initialHistory+3,'Failed session entered history');failNext=false;
    check(inferredBeforePlan&&playedBeforePlan,'Authored prefix did not start before the remaining plan');
    check(appends.some(entry=>entry.planComplete&&entry.segments.length===2),'Full validated plan was not appended');
    return{early,completed,stopped,codexRequests,sessionCreates:creates.length,sessionUpdates:updates.length,sessionAppends:appends.length,nextRequests:nextRequests.length,
      historyAdded:historyCount()-initialHistory,partialResumedAt,firstAuthoredPrefixBeforeCompletePlan:true,sameSessionUpdate:true,playedPrefixPreserved:true,
      authoredPrefixOrder:true,noRawArdyFallback:true,authFailureNoInference:true,plannerFailureNoInference:true,newGenerationStartsFresh:true,
      manualPausePreserved:true,sourceTimeResume:true,ardyOnlyWithoutCodex:true,jevBodyAndFace:true,loopOnOffHistoryExport:true,incompleteHistory:0,settingsUnified:true,plannerRequests:plannerInputs.length};
  }finally{
    observer.disconnect();window.fetch=originalFetch;viewer.playVRMA=originalPlay;navigator.clipboard.writeText=originalClipboard;URL.createObjectURL=originalCreateURL;HTMLAnchorElement.prototype.click=originalAnchorClick;
  }
}
try{
  const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(${browserSmoke.toString()})()`});
  assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));const value=result.result.value;
  assert.equal(value.historyAdded,3);assert.ok(value.partialResumedAt>0);assert.match(value.stopped,/停止しました/);console.log(JSON.stringify(value));
  await writeFile('release/ardy-realtime-smoke.json',JSON.stringify({recordedAt:new Date().toISOString(),providers:'mock',...value},null,2));
  await call('Runtime.evaluate',{expression:"document.getElementById('jevApiKey').value='smoke-test-only';document.getElementById('jevApiKey').dispatchEvent(new Event('input',{bubbles:true}))"});
  await call('Page.reload');await new Promise(r=>setTimeout(r,1500));
  const restored=await call('Runtime.evaluate',{returnByValue:true,expression:"document.getElementById('jevApiKey')?.value==='smoke-test-only'"});assert.equal(restored.result.value,true,'Jev key must survive reload');
  await call('Runtime.evaluate',{expression:"document.getElementById('settingsBtn').click()"});const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile('release/settings-dialog.png',Buffer.from(shot.data,'base64'));
}finally{await call('Browser.close').catch(()=>{});socket.close();}
