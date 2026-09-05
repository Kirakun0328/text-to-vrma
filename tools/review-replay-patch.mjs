// Re-evaluate the actual Astra patch from the previous live run against the SAME draft.
// Assessment and comparison call live Codex. The patch is replayed, not generated again.
import { writeFile } from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&t.url.startsWith('http://localhost:5173'));
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map();
ws.onmessage=e=>{const d=JSON.parse(e.data);if(pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id);}};
const call=(method,params)=>new Promise(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
try {
 await call('Page.reload',{});await new Promise(r=>setTimeout(r,1800));
 await call('Runtime.evaluate',{expression:`void (async()=>{try {
  for(let i=0;i<120&&!window.__viewer?.vrm;i++)await new Promise(r=>setTimeout(r,250));
  const original=await fetch('/release/review-complete-report.json').then(r=>r.json());
  if(!original.attempts?.[0]?.patch)throw new Error('Missing real Astra patch');
  const {directlyReviewMotion}=await import('/src/directMotionReview.js');
  const {inspectMotion,comparisonImages}=await import('/src/reviewCapture.js');
  const viewer=window.__viewer;
  window.__verificationReport=await directlyReviewMotion(original.plan.intent,original.draft,{
   model:'gpt-6-astra',visual:true,speed:'balanced',skeleton:viewer.reviewSkeleton,
   inspect:(s,p,o)=>inspectMotion(viewer,s,p,o),compareImages:comparisonImages,
   onProgress:message=>{window.__verificationProgress=message;},
   request:(messages,_key,model,_delta,config)=>config.outputType==='patch'?Promise.resolve(JSON.stringify(original.attempts[0].patch)):window.codexBridge.generateJson({messages,model,...config}),
  });
 }catch(e){window.__verificationError=e.message;}})()`});
 let last='';
 for(let i=0;i<180;i++) {
  await new Promise(r=>setTimeout(r,3000));
  const state=(await call('Runtime.evaluate',{returnByValue:true,expression:'({progress:window.__verificationProgress,done:!!window.__verificationReport,error:window.__verificationError})'})).result.result.value;
  if(state.progress!==last){console.log(state.progress);last=state.progress;}
  if(state.error)throw new Error(state.error);
  if(state.done) {
   const report=(await call('Runtime.evaluate',{returnByValue:true,expression:'window.__verificationReport'})).result.result.value;
   await writeFile('release/review-replayed-report.json',JSON.stringify(report,null,2));
   console.log(JSON.stringify({assessment:report.assessment,accepted:report.accepted,error:report.error,attempts:report.attempts.map(a=>({changes:a.changes,verdict:a.verdict,rejection:a.rejection}))}));
   break;
  }
  if(i===179)throw new Error('Verification timed out');
 }
}finally{ws.close();}
