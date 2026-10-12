// Jev (TypeSafe AI) is trained mainly on English, and its documentation states
// that other languages are analysed less accurately. Japanese requests are
// therefore translated with the ARDY engine's local translator before analysis.
// Translation is optional: without ARDY, or when it fails or is slow, the
// original text is analysed exactly as before.

const JAPANESE = /[぀-ヿ一-鿿]/;
export const JEV_TRANSLATE_TIMEOUT_MS = 2000;

/**
 * @returns {Promise<{text: string, translated: boolean}>}
 */
export async function englishForJev(text, { ardyUrl, enabled = true, signal,
  timeoutMs = JEV_TRANSLATE_TIMEOUT_MS, fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!enabled || !ardyUrl || typeof text !== 'string' || !JAPANESE.test(text)) return { text, translated: false };
  try {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const response = await fetchImpl(`${String(ardyUrl).replace(/\/+$/, '')}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.any(signals),
    });
    if (!response.ok) return { text, translated: false };
    const data = await response.json();
    const english = typeof data?.english === 'string' ? data.english.trim() : '';
    return english && !JAPANESE.test(english) ? { text: english, translated: true } : { text, translated: false };
  } catch {
    return { text, translated: false };
  }
}
