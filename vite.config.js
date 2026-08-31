import { defineConfig } from 'vite';
import http from 'node:http';
import https from 'node:https';

function llmProxyPlugin() {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm-proxy', (req, res) => {
        // Host check: only allow dev server origins (DNS rebinding / LAN scan mitigation)
        const host = req.headers.host || '';
        const hostOk = /^(localhost:\d+|127\.0\.0\.1:\d+|\[::1\]:\d+)$/.test(host);
        // In Vite dev, host always includes port; allow also without port for tooling
        const hostOkNoPort = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
        if (host && !hostOk && !hostOkNoPort) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: invalid Host');
          return;
        }
        // Body size guard (DoS)
        const clen = Number(req.headers['content-length'] || 0);
        if (clen > 2 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large');
          return;
        }

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

        // Only allow loopback targets to prevent the dev server from becoming an open proxy
        const rawHost = targetUrl.hostname;
        const hostname = rawHost.replace(/^\[|\]$/g, '');
        const isLoopback =
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          /^127\.\d+\.\d+\.\d+$/.test(hostname);
        if (!isLoopback || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: target must be loopback http(s)');
          return;
        }

        // Prevent path bypass: normalize suffix and block query-driven origin change
        const suffix = req.url || '/';
        if (suffix.includes('//') && suffix.startsWith('//')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid request path');
          return;
        }
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

          const proxyReq = transport.request(fwdUrl.href, {
            method: req.method,
            headers: fwdHeaders,
            agent: false,
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
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
