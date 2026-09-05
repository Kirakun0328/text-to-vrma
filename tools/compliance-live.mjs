// End-to-end test: real Codex subscription / GPT-6 Astra planning and real ARDY.
import {writeFile} from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&t.url.includes(':5173'));
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let next=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);}};
const call=(method,params={})=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}));});
try{
 await call('Page.navigate',{url:'http://localhost:5173/'});await new Promise(r=>setTimeout(r,1500));
 const start=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const $=id=>document.getElementById(id);
 const initial={engine:$('authMode').value,planner:$('ardyPlanner').value,model:$('codexModelSelect').value};
 const before=await window.codexBridge.getUsage();
 $('authMode').value='ardy';$('authMode').dispatchEvent(new Event('change'));
 $('ardyPlanner').value='codex';$('ardyPlanner').dispatchEvent(new Event('change'));
 for(let i=0;i<100&&(!$('generateBtn')||!window.__viewer?.vrm||!Array.from($('codexModelSelect').options).some(o=>o.value==='gpt-6-astra'));i++)await new Promise(r=>setTimeout(r,250));
 if(!Array.from($('codexModelSelect').options).some(o=>o.value==='gpt-6-astra'))throw Error('GPT-6 Astra unavailable');
 $('codexModelSelect').value='gpt-6-astra';$('ardyCandidateCount').value=${JSON.stringify(process.argv.includes('--candidates')?'3':'1')};$('refineCheck').checked=false;$('visualReviewCheck').checked=false;
 $('reviewSpeed').value='quality';$('ardyDuration').value='8';$('autoLengthCheck').checked=false;$('loopSelect').value='off';
 $('textInput').value='正面へ2歩進み、足を止めて右手を顔の横まで上げる。左腕は下ろしたまま。';
 const original=window.codexBridge.generateJson;const calls=[];
 window.codexBridge.generateJson=async data=>{
  const entry={model:data.model,effort:data.effort,type:data.outputType,started:new Date().toISOString()};calls.push(entry);
  try{const response=await original(data);entry.completed=new Date().toISOString();entry.plan=JSON.parse(response);return response;}
  catch(error){entry.error=error.message;throw error;}
 };
 window.__liveCompliance={initial,before,calls,original};
 $('generateBtn').click();return {initial,before};
 })()`});
 if(start.exceptionDetails)throw Error(start.exceptionDetails.exception?.description);
 console.log('Started '+JSON.stringify({initial:start.result.value.initial,usage:start.result.value.before?.rateLimits?.primary?.usedPercent}));
 let last='',completed=false;
 for(let i=0;i<180;i++){
  await new Promise(r=>setTimeout(r,2000));
  const current=await call('Runtime.evaluate',{returnByValue:true,expression:`({busy:document.getElementById('generateBtn').disabled,status:document.getElementById('status').textContent,calls:window.__liveCompliance.calls})`});
  const state=current.result.value;if(state.status!==last){console.log(state.status);last=state.status;}
  if(state.busy)continue;
  const finished=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{const data=window.__liveCompliance;window.codexBridge.generateJson=data.original;const after=await window.codexBridge.getUsage();document.getElementById('codexUsageRefresh').click();return {initial:data.initial,before:data.before,after,calls:data.calls,checks:window.__motionChecks,spec:window.__lastSpec,route:document.getElementById('generationRoute').textContent,candidates:window.__lastCandidates?{selected:window.__lastCandidates.selected,compareCompliance:window.__lastCandidates.compareCompliance,results:window.__lastCandidates.entries.map(e=>e.view.compliance)}:null,status:document.getElementById('status').textContent};})()`});
  const result=finished.result.value;
  for(const key of ['before','after'])result[key]={rateLimits:result[key].rateLimits,rateLimitsByLimitId:result[key].rateLimitsByLimitId};
  await writeFile('release/compliance-live.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({calls:result.calls,checks:result.checks,usageAfter:result.after.rateLimits?.primary?.usedPercent}));
  if(!result.calls.some(c=>c.model==='gpt-6-astra'&&c.completed)||!result.checks?.total)throw Error('Live planning/checks did not complete');
  if(process.argv.includes('--candidates')&&result.candidates?.results.length!==3)throw Error('Three candidates not measured');
  if(!result.route.includes('gpt-6-astra'))throw Error('Actual planning model not shown');
  const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile('release/compliance-live.png',Buffer.from(shot.data,'base64'));
  completed=true;break;
 }
 if(!completed)throw Error('Live generation timed out');
}finally{ws.close();}
