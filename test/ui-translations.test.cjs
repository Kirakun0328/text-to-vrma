const test = require('node:test');
const assert = require('node:assert/strict');
test('live status templates translate numbers and Jev assistance without changing unknown text', async () => {
  const { setLocale, localizeUiMessage } = await import('../src/i18n.js');
  global.localStorage = { setItem() {} };
  global.document = { documentElement: {}, querySelectorAll: () => [] };
  try {
    const source = '生成完了 / 初動 12801 ms / 19.95秒 / Codexの設計で生成 / Jev: 表情・視線を補助';
    setLocale('en');
    assert.equal(localizeUiMessage(source), 'Generation complete / First motion 12801 ms / 19.95 s / Generated from the Codex plan / Jev: assisted Expression, Gaze');
    assert.equal(localizeUiMessage('provider-specific error 123'), 'provider-specific error 123');
    setLocale('ko'); assert.ok(!/[ぁ-んァ-ヶ]/.test(localizeUiMessage(source)));
    setLocale('zh'); assert.ok(!/[ぁ-んァ-ヶ]/.test(localizeUiMessage(source)));
    setLocale('ja'); assert.equal(localizeUiMessage(source), source);
  } finally { delete global.localStorage; delete global.document; }
});
