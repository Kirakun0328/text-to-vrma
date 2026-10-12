import {writeFile} from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9224/json').then(r=>r.json());
const socket=new WebSocket(tabs.find(t=>t.type==='page'&&t.url.includes(':5175')).webSocketDebuggerUrl);
await new Promise(r=>socket.onopen=r);
let id=0;const pending=new Map();
socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
try {
  for(const [index,time] of [[1,2.5],[2,5.5]]) {
    const result=await call('Runtime.evaluate',{awaitPromise:true,expression:`(async()=>{
      for(let n=0;n<100&&!window.__viewer?.vrm;n++)await new Promise(r=>setTimeout(r,100));
      const {buildVRMA}=await import('/src/vrmaBuilder.js');
      const spec=await fetch('/release/astra-motion-${index}.json').then(r=>r.json());
      await window.__viewer.playVRMA(buildVRMA(spec),false,${time});
      window.__viewer.currentAction.paused=true;
      await new Promise(r=>setTimeout(r,100));
    })()`});
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
    const shot=await call('Page.captureScreenshot',{format:'png'});
    await writeFile(`release/astra-motion-${index}.png`,Buffer.from(shot.data,'base64'));
  }
}finally{await call('Browser.close').catch(()=>{});socket.close();}
