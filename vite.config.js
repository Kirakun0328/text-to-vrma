import { defineConfig } from 'vite';
import codexWebPlugin from './tools/codex-web.mjs';

export default defineConfig({
  plugins: [codexWebPlugin()],
  server: { host: 'localhost', watch: { ignored: ['**/release/**'] } },
  preview: { host: 'localhost' },
});
