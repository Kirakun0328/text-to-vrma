#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApiServer } from '../src/apiServer.js';

// リポジトリ直下の .env があれば読む。APIキーを毎回環境変数で渡さずに済ませるため
// (Node 20.6+ の標準機能。既に設定済みの環境変数は上書きしない)
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
    console.log('.env を読み込みました');
  } catch (error) {
    console.warn(`.env の読み込みに失敗しました: ${error.message}`);
  }
}

// 起動直後に「どのエンジンが今すぐ使えるか」を表示する。
// engine=openai はキー必須、engine=ardy はローカルエンジンの起動が必要
async function reportEngines() {
  const openai = process.env.OPENAI_API_KEY
    ? '利用可能'
    : '未設定 (.env に OPENAI_API_KEY を設定してください)';
  const claude = process.env.ANTHROPIC_API_KEY
    ? '利用可能'
    : '未設定 (.env に ANTHROPIC_API_KEY を設定してください)';
  const ardyUrl = (process.env.ARDY_URL || 'http://127.0.0.1:2337').replace(/\/+$/, '');
  let ardy;
  try {
    const res = await fetch(`${ardyUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const info = res.ok ? await res.json().catch(() => ({})) : null;
    ardy = res.ok
      ? `利用可能 (${info.model ?? 'model?'} / ${info.device === 'cpu' ? 'CPU' : 'GPU'})`
      : `応答異常 (HTTP ${res.status})`;
  } catch {
    ardy = `未起動 (${ardyUrl})`;
  }
  console.log(`  engine=openai : ${openai}`);
  console.log(`  engine=claude : ${claude}`);
  console.log('  engine=codex  : ChatGPTログインの利用枠 (生成時に認証確認、APIキー不要)');
  console.log(`  engine=ardy   : ${ardy}`);
}

try {
  const server = startApiServer();
  server.on('listening', () => { reportEngines(); });
} catch (error) {
  console.error(`API server failed to start: ${error.message}`);
  process.exitCode = 1;
}
