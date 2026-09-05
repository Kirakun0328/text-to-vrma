// Uses the real local ARDY engine, with the planning AI explicitly disabled.
import {writeFile} from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&/^http:\/\/(localhost|127\.0\.0\.1):5173/.test(t.url));
if(!tab)throw new Error('Local debug browser unavailable');
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let next=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(m.error.message)):resolve(m.result);}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
try{
 await call('Page.navigate',{url:'http://localhost:5173/'});await new Promise(r=>setTimeout(r,1200));
 const output=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const $=id=>document.getElementById(id);
  for(let i=0;i<120&&!window.__viewer?.vrm;i++)await new Promise(r=>setTimeout(r,250));
  if(!window.__viewer?.vrm)throw Error('Avatar unavailable');
  $('authMode').value='ardy';$('authMode').dispatchEvent(new Event('change'));
  $('ardyPlanner').value='none';$('ardyPlanner').dispatchEvent(new Event('change'));
  $('ardyCandidateCount').value='3';$('refineCheck').checked=false;
  $('ardyDuration').value='4';$('autoLengthCheck').checked=false;$('loopSelect').value='off';
  $('textInput').value='A person stands on both feet and gently waves their right hand beside their face, then lowers the hand.';
  const original=window.codexBridge.generateJson;
  window.codexBridge.generateJson=()=>{throw Error('Unexpected AI call');};
  const start=performance.now();
  try{
   $('generateBtn').click();await new Promise(r=>setTimeout(r,100));
   for(let i=0;i<480&&$('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,250));
   if($('generateBtn').disabled)throw Error('Generation timed out');
   const report=window.__lastCandidates;
   if(report?.entries.length!==3)throw Error('Expected 3 real candidates: '+$('status').textContent);
   if(new Set(report.entries.map(e=>e.seed)).size!==3)throw Error('Seeds repeated');
   if(report.entries.some(e=>e.view.images.length))throw Error('Unneeded contact sheets captured');
   $('candidateCompareBtn').click();
   if(!$('candidateResults').open||document.querySelectorAll('.candidate-row').length!==3)throw Error('Candidate panel missing');
   const choose=(report.selected+1)%3;
   document.querySelectorAll('.candidate-row .btn-blue')[choose].click();
   for(let i=0;i<60&&$('generateBtn').disabled;i++)await new Promise(r=>setTimeout(r,100));
   if($('candidateResults').open||window.__lastSpec.candidateInfo.index!==choose)throw Error('Candidate adoption failed');
   return {seconds:(performance.now()-start)/1000,autoSelection:report.decisions,chosen:choose,entries:report.entries.map(e=>({seed:e.seed,spec:e.spec,metrics:e.view.metrics,kinematics:e.view.kinematics})),error:report.error};
  }finally{window.codexBridge.generateJson=original;}
 })()`});
 if(output.exceptionDetails)throw Error(output.exceptionDetails.exception?.description||output.exceptionDetails.text);
 await writeFile('release/ardy-candidates-live.json',JSON.stringify(output.result.value,null,2));
 console.log(JSON.stringify({...output.result.value,entries:output.result.value.entries.map(({seed,metrics})=>({seed,metrics}))}));
 await call('Runtime.evaluate',{expression:"document.getElementById('candidateCompareBtn').click()"});
 const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile('release/ardy-candidates-live.png',Buffer.from(shot.data,'base64'));
}finally{ws.close();}
