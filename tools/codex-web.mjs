import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { CodexClient } = createRequire(import.meta.url)(fileURLToPath(new URL('../electron/codex-client.cjs', import.meta.url)));
import { tmpdir } from 'node:os';

export function codexMiddleware(client) {
  let busy = false;
  return async (req, res, next) => {
    if (!req.url?.startsWith('/__codex/')) return next();
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(403, { error: 'ローカルの同一オリジンから利用してください' });
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(405, { error: 'POST application/jsonが必要です' });
    const methods = { status: 'getStatus', models: 'listModels', usage: 'getUsage', login: 'login', logout: 'logout', motion: 'generateMotion', review: 'generateJson' };
    const method = methods[req.url.slice('/__codex/'.length)];
    if (!method) return send(404, { error: 'Not found' });
    const generating = ['generateMotion', 'generateJson'].includes(method);
    if (generating && busy) return send(409, { error: 'Codexは生成中です' });
    if (generating) busy = true;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 18_000_000) return send(413, { error: '入力が大きすぎます' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const result = await client[method](input);
      send(200, result);
    } catch (error) { send(500, { error: error.message }); }
    finally { if (generating) busy = false; }
  };
}

export default function codexWebPlugin() {
  const attach = server => {
    const client = new CodexClient({ cwd: tmpdir() });
    server.middlewares.use(codexMiddleware(client));
    server.httpServer?.once('close', () => client.close());
  };
  return { name: 'local-codex', configureServer: attach, configurePreviewServer: attach };
}
