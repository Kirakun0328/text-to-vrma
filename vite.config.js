import { defineConfig } from 'vite';
import http from 'node:http';
import https from 'node:https';

function llmProxyPlugin() {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm-proxy', (req, res) => {
        const target = req.headers['x-llm-target'];
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing X-LLM-Target header');
          return;
        }

        let targetUrl;
        try {
          targetUrl = new URL(target);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid target URL');
          return;
        }

        const suffix = req.url || '/';
        const fwdUrl = new URL(suffix, targetUrl.origin);
        const isHttps = fwdUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);

          const fwdHeaders = {};
          const ct = req.headers['content-type'];
          if (ct) fwdHeaders['content-type'] = ct;
          const auth = req.headers['authorization'];
          if (auth) fwdHeaders['authorization'] = auth;
          if (body.length > 0) fwdHeaders['content-length'] = String(body.length);

          console.log(`[llm-proxy] → ${req.method} ${fwdUrl.href} (${body.length}b)`);

          const proxyReq = transport.request(fwdUrl.href, {
            method: req.method,
            headers: fwdHeaders,
            agent: false,
          }, (proxyRes) => {
            console.log(`[llm-proxy] ← ${proxyRes.statusCode}`);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            console.error(`[llm-proxy] ${req.method} ${fwdUrl.href} → ${err.message}`);
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
          });

          if (body.length > 0) proxyReq.write(body);
          proxyReq.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [llmProxyPlugin()],
  server: {
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
