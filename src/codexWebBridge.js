// Same-origin local Vite bridge; no OAuth tokens or API keys enter the browser.
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
