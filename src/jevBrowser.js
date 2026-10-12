export async function analyzeJevInApp(text, { apiKey, model, timeoutMs, signal, state } = {}) {
  const input = { text, apiKey, model, timeoutMs, state };
  let result;
  try {
    signal?.throwIfAborted();
    if (window.jevBridge) result = await window.jevBridge.analyze(input);
    else {
      const response = await fetch('/__jev/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal,
      });
      if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) {
        throw Object.assign(new Error('Jev接続機能が読み込まれていません。設定の「アプリ／接続サーバーを再起動」を押してください'), { code: 'jev_bridge_missing' });
      }
      result = await response.json();
    }
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted || error.code) throw error;
    throw Object.assign(new Error('Jevのローカル接続に失敗しました。アプリ／開発サーバーを再起動してください'), { code: 'jev_bridge_unavailable' });
  }
  if (result.error) throw Object.assign(new Error(result.error), { code: result.code, status: result.status });
  return result.context;
}
