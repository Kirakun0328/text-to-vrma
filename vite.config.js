import { defineConfig } from 'vite';
import codexWebPlugin from './tools/codex-web.mjs';
import jevWebPlugin from './tools/jev-web.mjs';

export default defineConfig({
  plugins: [codexWebPlugin(), jevWebPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/release/**'] } },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
