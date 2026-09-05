// Real ARDY generation and VRM playback; planner transport is a fixed fixture (no AI charge).
import {writeFile} from 'node:fs/promises';
import {planArdySegments} from '../src/llm.js';
const intent='右手を2回振る。その後、手をゆっくり下ろして自然に立つ。';
const plan=await planArdySegments(intent,'','fixture',{verify:false,request:async()=>JSON.stringify({segments:[{text:'A person raises their right hand beside their face and waves twice, then gently lowers their raised right hand to their side and stands relaxed.',duration:6}]})});
const res=await fetch('http://127.0.0.1:2337/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segments:plan.segments,seed:42})});
if(!res.ok)throw Error('ARDY HTTP '+res.status);
const spec=await res.json();spec.originalText=intent;
await writeFile('release/ending-live.json',JSON.stringify({plan,spec},null,2));
const tabs=await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&t.url.includes(':5173'));
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let next=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const call=(method,params={})=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}));});
try{
 await call('Page.navigate',{url:'http://localhost:5173/'});await new Promise(r=>setTimeout(r,1500));
 const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const {buildVRMA}=await import('/src/vrmaBuilder.js');const {isLoopFriendly}=await import('/src/specMerge.js');
 const spec=${JSON.stringify(spec)};const viewer=window.__viewer;
 for(let i=0;i<100&&!viewer.vrm;i++)await new Promise(r=>setTimeout(r,100));
 const loop=isLoopFriendly(spec);if(loop)throw Error('Finite gesture unexpectedly loops');
 await viewer.playVRMA(buildVRMA(spec),loop);viewer.setRenderLoop(false);
 try{
  const action=viewer.currentAction;const samples=[];
  for(const t of [0,3.5,spec.duration]){
   action.time=t;viewer.mixer.update(0);viewer.vrm.update(0);viewer.vrm.scene.updateMatrixWorld(true);
   const hand=viewer.vrm.humanoid.getNormalizedBoneNode('rightHand');
   samples.push({time:t,handHeight:hand.matrixWorld.elements[13]});
  }
  viewer.mixer.update(1);
  if(!action.paused||Math.abs(action.time-action.getClip().duration)>.001)throw Error('Playback did not hold last frame');
  return {loop,duration:spec.duration,clipDuration:action.getClip().duration,heldLastFrame:action.paused,samples};
 }finally{viewer.setRenderLoop(true);}
 })()`});
 if(result.error||result.result.exceptionDetails)throw Error(JSON.stringify(result.error||result.result.exceptionDetails));
 console.log(JSON.stringify({segments:plan.segments,...result.result.result.value}));
}finally{ws.close();}
