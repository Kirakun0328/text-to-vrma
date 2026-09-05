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
