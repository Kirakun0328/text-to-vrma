const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('local Codex bridge rejects cross origin, remote Host and non-JSON requests', async t => {
  const { codexMiddleware } = await import('../tools/codex-web.mjs');
  let calls = 0;
  const middleware = codexMiddleware({ getStatus: async () => { calls++; return { available: true }; } });
  const server = http.createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/__codex/status`;
  for (const headers of [{Origin:'https://evil.example','Content-Type':'application/json'}, {'Content-Type':'text/plain'}]) {
    const response=await fetch(url,{method:'POST',headers,body:'{}'});
    assert.ok([403,405].includes(response.status));
  }
  const remoteHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(url, {method:'POST',headers:{Host:'evil.example','Content-Type':'application/json'}}, res => {res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end('{}');
  });
  assert.equal(remoteHostStatus,403);
  assert.equal(calls,0);
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
  assert.equal(calls,1);
});

test('local Codex stream forwards deltas and final JSON, aborts inference on disconnect, and releases busy', async t => {
  const { codexMiddleware } = await import('../tools/codex-web.mjs');
  let calls = 0, aborts = 0, aborted;
  const cancellation = new Promise(resolve => { aborted = resolve; });
  const middleware = codexMiddleware({ generateJson: async (_input, { signal, onDelta }) => {
    calls++;
    onDelta('{"segments":');
    if (calls === 1) {
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborts++; aborted(); reject(signal.reason);
      }, { once: true }));
    }
    onDelta('[]}');
    return '{"segments":[]}';
  } });
  const server = http.createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/__codex/review-stream`;
  const controller = new AbortController();
  const request = {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  const response = await fetch(url, {...request,signal:controller.signal});
  assert.match(response.headers.get('Content-Type'), /ndjson/);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.equal(JSON.parse(new TextDecoder().decode(value)).type,'delta');
  assert.equal((await fetch(url, request)).status,409);
  controller.abort();
  await cancellation;
  await new Promise(resolve=>setImmediate(resolve));
  await reader.cancel().catch(()=>{});
  const next = await fetch(url,request);
  assert.equal(next.status,200);
  const events = (await next.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event=>event.type),['delta','delta','final']);
  assert.equal(events.at(-1).text,'{"segments":[]}');
  assert.equal(aborts,1);
  assert.equal(calls,2);
});

test('local Codex stream reports errors after headers and keeps same-origin checks', async t => {
  const { codexMiddleware } = await import('../tools/codex-web.mjs');
  let calls=0;
  const middleware=codexMiddleware({generateJson:async()=>{calls++;throw new Error('test failure');}});
  const server=http.createServer((req,res)=>middleware(req,res,()=>res.end()));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/__codex/review-stream`;
  const request={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(url,{...request,headers:{...request.headers,Origin:'https://evil.example'}})).status,403);
  assert.equal(calls,0);
  const result=await fetch(url,request);
  assert.equal(result.status,200);
  assert.deepEqual(JSON.parse(await result.text()),{type:'error',error:'test failure'});
});
