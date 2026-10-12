export async function restartApp({ bridge = window.appBridge, fetchImpl = fetch, reload = () => location.reload(), report = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  report('再起動しています…');
  if (bridge) { await bridge.restart(); return; }
  const post = path => fetchImpl(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) });
  const response = await post('/__jev/restart');
  if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('このサーバーには再起動機能がまだありません。初回のみ、起動した端末で Ctrl+C を押し、npm.cmd run dev を実行してから画面を再読み込みしてください。');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '再起動に失敗しました');
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(500);
    try {
      const health = await post('/__jev/health');
      const state = await health.json();
      if (health.ok && state.ready && state.instance !== result.instance) { reload(); return; }
    } catch { /* The listener is temporarily unavailable during restart. */ }
  }
  throw new Error('再起動後の接続を確認できませんでした。開発サーバーの端末を確認してから、もう一度お試しください。');
}
