// Same-origin local Vite bridge; no OAuth tokens or API keys enter the browser.
export async function readCodexJsonStream(response, { signal, onDelta } = {}) {
  signal?.throwIfAborted();
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'ローカルCodexに接続できません');
  }
  if (!response.body) throw new Error('Codexのストリームがありません');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finalText = null, received = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const consume = line => {
    if (!line.trim()) return;
    signal?.throwIfAborted();
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error || 'Codexの生成に失敗しました');
    if (event.type === 'delta' && typeof event.delta === 'string' && finalText === null) onDelta?.(event.delta);
    else if (event.type === 'final' && typeof event.text === 'string' && finalText === null) {
      JSON.parse(event.text);
      finalText = event.text;
    } else throw new Error('Codexのストリーム形式が不正です');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (value) {
        received += value.byteLength;
        if (received > 8_000_000) throw new Error('Codexの応答が大きすぎます');
      }
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    consume(buffer);
    if (finalText === null) throw new Error('Codexの生成が完了する前に接続が切れました');
    return finalText;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// AbortSignal is not cloneable across Electron's contextBridge. Keep it in the
// renderer and send a scoped cancellation message instead.
export async function generateCodexJsonStream(bridge, input, { signal, onDelta } = {}) {
  signal?.throwIfAborted();
  if (!bridge?.generateJsonStream) throw new Error('Codex接続機能を更新するためアプリを再起動してください');
  if (!bridge.cancelJsonStream) return bridge.generateJsonStream(input, { signal, onDelta });
  const requestId = crypto.randomUUID();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    bridge.cancelJsonStream(requestId);
    rejectAbort(signal.reason || new DOMException('Cancelled', 'AbortError'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      bridge.generateJsonStream(input, { requestId, onDelta: delta => { if (!signal?.aborted) onDelta?.(delta); } }),
      aborted,
    ]);
  } finally { signal?.removeEventListener('abort', abort); }
}

export function installCodexWebBridge() {
  if (window.codexBridge || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const call = async (method, body = {}) => {
    const res = await fetch(`/__codex/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ローカルCodexに接続できません');
    return data;
  };
  const listeners = new Set();
  let polling;
  window.codexBridge = {
    getStatus: () => call('status'), listModels: () => call('models'), getUsage: () => call('usage'),
    generateMotion: data => call('motion', data), generateJson: data => call('review', data),
    async generateJsonStream(input, options = {}) {
      options.signal?.throwIfAborted();
      const response = await fetch('/__codex/review-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: options.signal,
      });
      return readCodexJsonStream(response, options);
    },
    async login() {
      const popup = window.open('about:blank', '_blank');
      try {
        const result = await call('login');
        const url = new URL(result.authUrl);
        if (url.protocol !== 'https:') throw new Error('ログインURLが不正です');
        if (popup) { popup.opener = null; popup.location.href = url.href; }
        else throw new Error('ログイン画面を開くためポップアップを許可してください');
        clearInterval(polling);
        let attempts = 0;
        polling = setInterval(async () => {
          try {
            const status = await call('status');
            if (status.account?.type === 'chatgpt' || ++attempts > 100) {
              clearInterval(polling); for (const listener of listeners) listener(status);
            }
          } catch { clearInterval(polling); }
        }, 3000);
        return result;
      } catch (e) { popup?.close(); throw e; }
    },
    logout: () => window.confirm('このPCのCodex CLI全体からログアウトしますか？') ? call('logout') : call('status'),
    onAccountChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
