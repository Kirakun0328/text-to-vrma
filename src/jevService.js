import { analyzeMotionContextStrict, DEFAULT_JEV_TIMEOUT_MS } from './jevAnalyzer.js';

// Shared by the local web server and Electron. Never return keys or upstream bodies.
export async function handleJevAnalysis(input, { signal, fetchImpl } = {}) {
  if (!input || typeof input.text !== 'string' || !input.text.trim()
    || input.text.length > 4000 || typeof input.apiKey !== 'string' || !input.apiKey.trim()) {
    return { status: 400, error: 'JevのAPIキーと解析する文章を入力してください', code: 'jev_missing_input' };
  }
  try {
    const context = await analyzeMotionContextStrict(input.text, {
      apiKey: input.apiKey.trim(), model: typeof input.model === 'string' ? input.model.slice(0, 100) : undefined,
      timeoutMs: Math.max(500, Math.min(30000, Number(input.timeoutMs) || DEFAULT_JEV_TIMEOUT_MS)),
      useCache: false, state: input.state, signal, ...(fetchImpl ? { fetchImpl } : {}),
    });
    return { status: 200, context };
  } catch (error) {
    return { status: error.status || 502, code: error.code || 'jev_error',
      error: error.code?.startsWith('jev_') ? error.message : 'Jevの応答を読み取れませんでした' };
  }
}
