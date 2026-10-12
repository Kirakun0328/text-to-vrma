// Real local ARDY inference in the isolated browser; no mocked responses.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const outputFolder=process.argv.find(value=>value.startsWith('--output='))?.slice(9);
if(outputFolder&&!/^[a-zA-Z0-9-]+$/.test(outputFolder))throw Error('Invalid output folder');
const tabs=await fetch('http://127.0.0.1:9224/json').then(r=>r.json());
const gazeMode=process.argv.includes('--gaze');
const sequenceMode=process.argv.includes('--sequence');
const tab=tabs.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:5173'));
assert.ok(tab,'Open the dedicated browser on the local app');
const socket=new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let next=0;const pending=new Map();
socket.onmessage=event=>{const value=JSON.parse(event.data),p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(new Error(value.error.message)):p.resolve(value.result);};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
async function checkRealBrowser(gazeMode,sequenceMode){
  const $=id=>document.getElementById(id),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const waitFor=async(predicate,message,timeout=60000)=>{const until=performance.now()+timeout;while(performance.now()<until){if(predicate())return;await pause(30);}throw Error(message+': '+$('status').textContent);};
  await waitFor(()=>$('vrmName')?.textContent.includes('.vrm'),'VRM not loaded',10000);
  $('ardyPlanner').value=gazeMode||sequenceMode?'codex':'none';$('ardyPlanner').dispatchEvent(new Event('change'));
  $('authMode').value='ardy';$('authMode').dispatchEvent(new Event('change'));
  if(gazeMode||sequenceMode){
    await waitFor(()=>[...$('codexModelSelect').options].some(option=>option.value==='gpt-6-astra'),'Astra unavailable');
    $('codexModelSelect').value='gpt-6-astra';
  }
  $('ardyUrl').value='http://127.0.0.1:2337';$('ardyCandidateCount').value='1';$('waypointCheck').checked=false;
  $('autoLengthCheck').checked=false;$('ardyDuration').value='6';$('realtimeDuration').value='6';$('realtimeSteps').value='8';
  $('loopSelect').value='off';$('refineCheck').checked=false;$('visualReviewCheck').checked=false;
  $('jevApiKey').value='';$('jevApiKey').dispatchEvent(new Event('input',{bubbles:true}));
  const viewer=window.__viewer,originalFrame=viewer.onFrame,originalFetch=window.fetch;
  const requests=[],rendered=[];let started=0,firstRenderedMs=null,lastSample=-Infinity;
  window.fetch=(url,options)=>{if(started)requests.push(String(url));return originalFetch(url,options);};
  viewer.onFrame=()=>{
    originalFrame?.();
    if(!started||window.__lastSpec?.realtime?.source!=='ardy-session')return;
    firstRenderedMs??=performance.now()-started;
    if(performance.now()-lastSample<75)return;lastSample=performance.now();
    const joints={};
    for(const name of ['hips','head','leftUpperArm','leftLowerArm','rightUpperArm','rightLowerArm','leftUpperLeg','leftLowerLeg','rightUpperLeg','rightLowerLeg']){
      const node=viewer.vrm.humanoid.getNormalizedBoneNode(name);if(node)joints[name]=node.quaternion.toArray();
    }
    rendered.push({elapsedMs:performance.now()-started,playback:viewer.getPlayback(),joints,
      gaze:{yaw:viewer.vrm.lookAt?.yaw,pitch:viewer.vrm.lookAt?.pitch}});
  };
  const initialHistory=document.querySelectorAll('#history .hist-item').length;
  try{
    $('textInput').value=sequenceMode?'歩いてジャンプ':gazeMode?'好きな相手に褒められ、嬉しいけれど照れくさくて、一度視線をそらす。小さく微笑んでから相手を見て、お礼を伝える。':'その場で歩く';started=performance.now();$('generateBtn').click();
    await waitFor(()=>window.__lastSpec?.realtime?.source==='ardy-session','No live motion displayed');
    const firstSpecMs=performance.now()-started,firstMetadata=structuredClone(window.__lastSpec.realtime);
    await waitFor(()=>document.querySelectorAll('#history .hist-item').length===initialHistory+1&&$('genProgressText').textContent.includes('100%'),'No completed history');
    const completedMs=performance.now()-started,final=structuredClone(window.__lastSpec),status=$('status').textContent;
    await waitFor(()=>!viewer.getPlayback()?.running,'Nonlooping playback did not finish',15000);
    const excursion={};
    for(const bone of Object.keys(rendered[0]?.joints??{})){
      const reference=rendered[0].joints[bone];
      excursion[bone]=Math.max(...rendered.map(frame=>{const q=frame.joints[bone],dot=reference.reduce((sum,value,i)=>sum+value*q[i],0);return 2*Math.acos(Math.min(1,Math.abs(dot)))*180/Math.PI;}));
    }
    return{prompt:$('textInput').value,model:$('vrmName').textContent,steps:8,firstSpecMs,firstRenderedMs,completedMs,firstMetadata,
      finalMetadata:final.realtime,status,historyAdded:document.querySelectorAll('#history .hist-item').length-initialHistory,
      loop:final.loop,playback:viewer.getPlayback(),renderedSamples:rendered.length,angularExcursionDegrees:excursion,
      generationRequests:requests,finalSpec:final,rendered};
  }finally{viewer.onFrame=originalFrame;window.fetch=originalFetch;}
}
let liveSessionId;
try{
  const response=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(${checkRealBrowser.toString()})(${gazeMode},${sequenceMode})`});
  assert.equal(response.exceptionDetails,undefined,JSON.stringify(response.exceptionDetails));
  const result=response.result.value;
  liveSessionId=result.finalMetadata?.sessionId;
  assert.equal(result.historyAdded,1);assert.equal(result.loop,false);assert.equal(result.playback.running,false);
  assert.equal(result.finalMetadata.planner,gazeMode||sequenceMode?'codex':'none');assert.ok(result.renderedSamples>5);
  assert.ok(!result.generationRequests.some(url=>url.includes('/__jev/analyze')));
  if(gazeMode){
    assert.equal(result.finalMetadata.bodyScopeEnforced,true);
    assert.ok(result.finalSpec.lookAt.some(key=>Math.abs(key.r[0])+Math.abs(key.r[1])>5));
    assert.ok(result.rendered.some(frame=>Math.abs(frame.gaze.yaw)>5||Math.abs(frame.gaze.pitch)>5));
  }else if(sequenceMode){
    assert.ok(result.finalMetadata.plannedSegments>=2,'The later action must remain in the plan');
    assert.ok(result.generationRequests.some(url=>url.includes('/__codex/review')));
  }else assert.ok(!result.generationRequests.some(url=>url.includes('/__codex/review')));
  if(outputFolder)await mkdir(`release/${outputFolder}`,{recursive:true});
  const outputPath=outputFolder?`release/${outputFolder}/browser-check`:gazeMode?'release/intent-gaze-fix/browser-check':'release/ardy-live-browser-check';
  await writeFile(outputPath+'.json',JSON.stringify(result,null,2));
  const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(outputPath+'.png',Buffer.from(shot.data,'base64'));
  const {finalSpec,rendered,...summary}=result;console.log(JSON.stringify(summary));
}finally{
  if(liveSessionId)await fetch('http://127.0.0.1:2337/sessions/'+encodeURIComponent(liveSessionId)+'/close',{
    method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000),
  }).catch(()=>{});
  await call('Browser.close').catch(()=>{});socket.close();
}
