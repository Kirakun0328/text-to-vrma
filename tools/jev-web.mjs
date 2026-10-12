import { handleJevAnalysis } from '../src/jevService.js';

export function jevMiddleware({ analyze = handleJevAnalysis, restart, instance = 'ready' } = {}) {
  return async (req, res, next) => {
    if (!['/__jev/analyze', '/__jev/health', '/__jev/restart'].includes(req.url)) return next();
    const send = (status, data) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
      || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      return send(403, { error: '同じローカルアプリから接続してください', code: 'jev_origin' });
    }
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return send(405, { error: 'POST application/jsonが必要です', code: 'jev_method' });
    }
    if (req.url === '/__jev/health') return send(200, { ready: true, instance });
    if (req.url === '/__jev/restart') {
      if (!restart) return send(409, { error: 'プレビューサーバーは端末から再起動してください。開発時は npm.cmd run dev を使用してください。' });
      res.once('finish', () => { setTimeout(() => Promise.resolve().then(restart).catch(error => console.error('Jev server restart failed:', error.message)), 100); });
      return send(202, { restarting: true, instance });
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) return send(413, { error: '入力が大きすぎます', code: 'jev_input_size' });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, { error: '入力形式が不正です', code: 'jev_input_json' }); }
      const result = await analyze(input, { signal: controller.signal });
      send(result.status, result);
    } catch { send(502, { error: 'Jev接続処理に失敗しました', code: 'jev_bridge_error' }); }
  };
}

export default function jevWebPlugin() {
  const attach = server => { server.middlewares.use(jevMiddleware({
    restart: typeof server.restart === 'function' ? () => server.restart() : undefined,
    instance: crypto.randomUUID(),
  })); };
  return { name: 'local-jev', configureServer: attach, configurePreviewServer: attach };
}
