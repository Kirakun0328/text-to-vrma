import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
const require = createRequire(import.meta.url);
const clientPath = fileURLToPath(new URL('../electron/codex-client.cjs', import.meta.url));
import { tmpdir } from 'node:os';

// Vite updates renderer modules without necessarily reloading dynamically
// required CJS. Refresh this client between requests, keeping an active stream
// (and its account/status requests) on the same instance until it finishes.
export function createReloadingCodexClient({ clientFile = clientPath, cwd = tmpdir() } = {}) {
  let client, loadedVersion, active = 0, closed = false;
  const idle = new Set();
  const closedError = () => new Error('Codex接続サーバーは終了しました');
  const version = () => {
    const source = statSync(clientFile, { bigint: true });
    return `${source.mtimeNs}:${source.ctimeNs}:${source.size}`;
  };
  const settleIdle = () => { for (const finish of [...idle]) finish(); };
  const waitForIdle = signal => new Promise((resolve, reject) => {
    const cleanup = () => { idle.delete(finish); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const finish = () => {
      if (!closed && active > 0) return;
      cleanup();
      if (closed) reject(closedError()); else resolve();
    };
    idle.add(finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else finish();
  });
  const invoke = async (method, args) => {
    const signal = args[1]?.signal;
    signal?.throwIfAborted();
    if (closed) throw closedError();
    let nextVersion = version();
    while (client && loadedVersion !== nextVersion && active > 0) {
      await waitForIdle(signal);
      signal?.throwIfAborted();
      if (closed) throw closedError();
      nextVersion = version();
    }
    if (!client || loadedVersion !== nextVersion) {
      delete require.cache[require.resolve(clientFile)];
      const { CodexClient } = require(clientFile);
      const previous = client;
      client = new CodexClient({ cwd });
      loadedVersion = nextVersion;
      previous?.close();
    }
    const current = client;
    active++;
    try { return await current[method](...args); }
    finally { active--; if (!active) settleIdle(); }
  };
  return {
    ...Object.fromEntries(['getStatus', 'listModels', 'getUsage', 'login', 'logout', 'generateMotion', 'generateJson']
      .map(method => [method, (...args) => invoke(method, args)])),
    close() {
      closed = true;
      settleIdle();
      client?.close();
      client = undefined;
    },
  };
}

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
    const streaming = req.url === '/__codex/review-stream';
    const methods = { status: 'getStatus', models: 'listModels', usage: 'getUsage', login: 'login', logout: 'logout', motion: 'generateMotion', review: 'generateJson', 'review-stream': 'generateJson' };
    const method = methods[req.url.slice('/__codex/'.length)];
    if (!method) return send(404, { error: 'Not found' });
    const generating = ['generateMotion', 'generateJson'].includes(method);
    if (generating && busy) return send(409, { error: 'Codexは生成中です' });
    if (generating) busy = true;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const write = value => {
      if (!controller.signal.aborted && !res.destroyed) res.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 18_000_000) return send(413, { error: '入力が大きすぎます' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      controller.signal.throwIfAborted();
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const result = await client.generateJson(input, { signal: controller.signal, onDelta: delta => write({ type: 'delta', delta }) });
        write({ type: 'final', text: result });
        if (!res.destroyed) res.end();
      } else {
        const result = await client[method](input, { signal: controller.signal });
        if (!controller.signal.aborted) send(200, result);
      }
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        if (res.headersSent) { write({ type: 'error', error: error.message }); res.end(); }
        else send(500, { error: error.message });
      }
    } finally {
      res.removeListener('close', abort);
      if (generating) busy = false;
    }
  };
}

export default function codexWebPlugin() {
  const attach = server => {
    const client = createReloadingCodexClient();
    server.middlewares.use(codexMiddleware(client));
    server.httpServer?.once('close', () => client.close());
  };
  return { name: 'local-codex', configureServer: attach, configurePreviewServer: attach };
}
