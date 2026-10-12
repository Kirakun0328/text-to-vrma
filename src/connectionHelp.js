// A browser fetch that never reaches its server only says "Failed to fetch".
// First-time users cannot tell which of the local engine, the app's own
// connection server or the internet is missing, so find out and offer the
// one action that fixes it.

const NETWORK_FAILURE = /failed to fetch|networkerror when attempting to fetch|load failed|fetch failed|err_connection_refused|econnrefused/i;

export function isNetworkFailure(message) {
  return NETWORK_FAILURE.test(String(message ?? ''));
}

// Each check resolves true when that connection works. A check that throws
// counts as unreachable.
const reachable = async check => {
  try { return Boolean(await check?.()); } catch { return false; }
};

/**
 * @returns {Promise<{message: string, action: 'ardy-start'|'ardy-setup'|'restart'|'retry'|null}>}
 */
export async function diagnoseConnection({ usesArdy, usesBridge, checkArdy, checkBridge,
  canStartArdy, ardyConfigured }) {
  if (usesArdy && !await reachable(checkArdy)) {
    if (!canStartArdy) return { action: 'retry',
      message: 'ARDYエンジンに接続できません。エンジンを起動してから、もう一度お試しください。' };
    return await reachable(ardyConfigured)
      ? { action: 'ardy-start', message: 'ARDYエンジンが起動していません。「エンジンを起動」を押し、接続できたらもう一度生成してください。' }
      : { action: 'ardy-setup', message: 'ARDYエンジンがまだ導入されていません。「エンジンをセットアップ」から導入してください。' };
  }
  if (usesBridge && !await reachable(checkBridge)) return { action: 'restart',
    message: 'アプリ内の接続サーバーに接続できません。「接続を再起動」を押してください。' };
  return { action: 'retry',
    message: 'サーバーに接続できませんでした。インターネット接続を確認してから、もう一度お試しください。' };
}
