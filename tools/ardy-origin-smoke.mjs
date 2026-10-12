// Actual Chrome CORS/session requests. No credentials; one chunk after the fix.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const expectRejected=process.argv.includes('--expect-rejected');
const tabs=await fetch('http://127.0.0.1:9224/json').then(response=>response.json());
const tab=tabs.find(tab=>tab.type==='page'&&/^http:\/\/localhost:517[35]/.test(tab.url));
assert.ok(tab,'Open the dedicated Chrome at localhost, not 127.0.0.1');
const socket=new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let next=0;const pending=new Map(),requests=new Map(),headers=new Map(),responses=new Map();
socket.onmessage=event=>{
  const data=JSON.parse(event.data);
  if(data.method==='Network.requestWillBeSent')requests.set(data.params.requestId,data.params.request);
  if(data.method==='Network.requestWillBeSentExtraInfo')headers.set(data.params.requestId,data.params.headers);
  if(data.method==='Network.responseReceived')responses.set(data.params.requestId,data.params.response);
  const request=pending.get(data.id);if(!request)return;pending.delete(data.id);
  data.error?request.reject(new Error(data.error.message)):request.resolve(data.result);
};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const base='http://127.0.0.1:2337';
const payload={text:'その場で歩く',duration:2,steps:8,revision:1};
async function browserProbe(infer){
  const base='http://127.0.0.1:2337';
  const request=async(path,body)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return{status:response.status,body:await response.json()};
  };
  const created=await request('/sessions',{text:'その場で歩く',duration:2,steps:8,revision:1});
  let next=null,closed=null;
  if(created.body.sessionId){
    const path='/sessions/'+encodeURIComponent(created.body.sessionId);
    try{
      if(infer){const result=await request(path+'/next',{playbackTime:0}),keys=result.body.tracks?.hips??Object.values(result.body.tracks??{})[0]??[];
        next={status:result.status,type:result.body.type,revision:result.body.revision,frames:keys.length,firstTime:keys[0]?.t,lastTime:keys.at(-1)?.t};}
    }finally{closed=await request(path+'/close',{});}
  }
  return{pageOrigin:location.origin,created,next,closed};
}
try{
  await call('Network.enable');
  const response=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(${browserProbe.toString()})(${!expectRejected})`});
  assert.equal(response.exceptionDetails,undefined,JSON.stringify(response.exceptionDetails));
  const browser=response.result.value;
  await new Promise(resolve=>setTimeout(resolve,100));
  const observed=[...requests.entries()].filter(([,request])=>request.url.startsWith(base+'/sessions')&&request.method==='POST').map(([id,request])=>{
    const actual=headers.get(id)??request.headers;
    const header=name=>Object.entries(actual).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
    const response=responses.get(id),corsOrigin=Object.entries(response?.headers??{}).find(([key])=>key.toLowerCase()==='access-control-allow-origin')?.[1];
    return{url:request.url,method:request.method,origin:header('Origin'),fetchSite:header('Sec-Fetch-Site'),host:header('Host'),status:response?.status,corsOrigin};
  });
  assert.equal(browser.pageOrigin,new URL(tab.url).origin);
  assert.ok(observed.some(request=>request.origin===browser.pageOrigin&&request.fetchSite==='cross-site'),'Real Chrome Origin + cross-site headers were not observed');
  assert.equal(browser.created.status,expectRejected?403:200);
  if(expectRejected)assert.equal(browser.created.body.code,'forbidden_origin');
  else{
    assert.equal(browser.closed.status,200);assert.equal(browser.closed.body.closed,true);
    assert.equal(browser.next.status,200);assert.equal(browser.next.type,'chunk');assert.ok(browser.next.frames>0);
    assert.ok(observed.every(request=>request.corsOrigin===browser.pageOrigin),'Browser CORS did not echo the validated local origin');
  }
  // Negative Origin tests use actual HTTP headers. Browser fetch cannot forge
  // an Origin; these prove server enforcement in addition to browser CORS.
  const denied=[];
  for(const origin of ['https://untrusted.example','http://localhost.evil.invalid','app://other','null']){
    const result=await fetch(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'Sec-Fetch-Site':'cross-site'},body:JSON.stringify(payload)});
    const body=await result.json();denied.push({origin,status:result.status,code:body.code,corsOrigin:result.headers.get('access-control-allow-origin')});
    assert.equal(result.status,403);assert.equal(body.code,'forbidden_origin');
  }
  let desktop;
  if(!expectRejected){
    const localHeaders={'Content-Type':'application/json',Origin:'app://bundle','Sec-Fetch-Site':'cross-site'};
    const response=await fetch(base+'/sessions',{method:'POST',headers:localHeaders,body:JSON.stringify(payload)});
    const created=await response.json();assert.equal(response.status,200);
    assert.equal(response.headers.get('access-control-allow-origin'),'app://bundle');
    const closed=await fetch(base+'/sessions/'+encodeURIComponent(created.sessionId)+'/close',{method:'POST',headers:localHeaders,body:'{}'});
    const result=await closed.json();assert.equal(closed.status,200);assert.equal(result.closed,true);
    desktop={origin:'app://bundle',fetchSite:'cross-site',createdStatus:response.status,closedStatus:closed.status,corsOrigin:response.headers.get('access-control-allow-origin')};
  }
  const result={expectedLocalRejection:expectRejected,browser,observed,desktop,denied,inferenceRequests:expectRejected?0:1};
  await writeFile('release/ardy-origin-'+(expectRejected?'before':'after')+'.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await call('Browser.close').catch(()=>{});socket.close();}
