const test = require('node:test');
const assert = require('node:assert/strict');

const blinkTimes = keys => keys.filter(k => k.w === 1).map(k => k.t).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.1);

test('blinks vary in spacing, stay inside the clip and repeat for the same text', async () => {
  const { naturalBlinks } = await import('../src/facialPerformance.js');
  const keys = naturalBlinks(30, { seed: '手を振る' });
  const times = blinkTimes(keys);
  assert.ok(times.length >= 5 && times.length <= 16, String(times.length));
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(new Set(gaps.map(g => g.toFixed(2))).size > 2, 'intervals must not be constant');
  assert.ok(keys.every(k => k.t >= 0 && k.t <= 30 && k.w >= 0 && k.w <= 1));
  assert.deepEqual(naturalBlinks(30, { seed: '手を振る' }), keys);
  assert.notDeepEqual(naturalBlinks(30, { seed: '別の文' }), keys);
  // Opening is slower than closing.
  const peak = keys.findIndex(k => k.w === 1);
  assert.ok(keys[peak + 2].t - keys[peak + 1].t > keys[peak].t - keys[peak - 1].t);
  assert.equal(naturalBlinks(30, { seed: 'x', suppressAt: () => true }), null);
});

test('quoted Japanese dialogue drives vowel mouth shapes in order', async () => {
  const { speechMorae, speechMouth } = await import('../src/facialPerformance.js');
  assert.deepEqual(speechMorae('ありがとう').map(m => m.mouth), ['aa', 'ih', 'aa', 'oh', 'ou']);
  assert.deepEqual(speechMorae('きゃっ').map(m => m.mouth), ['aa', null]);
  const tracks = speechMouth('笑顔で「ありがとう」と言う', 4);
  assert.deepEqual(Object.keys(tracks).sort(), ['aa', 'ih', 'oh', 'ou']);
  const firstPeak = name => tracks[name].find(k => k.w > 0).t;
  assert.ok(firstPeak('aa') < firstPeak('ih') && firstPeak('ih') < firstPeak('oh') && firstPeak('oh') < firstPeak('ou'));
  for (const keys of Object.values(tracks)) assert.ok(keys.every(k => k.t >= 0 && k.t <= 4 && k.w <= 1));
});

test('speaking without a quote still moves the mouth; loudness follows the wording', async () => {
  const { speechMouth } = await import('../src/facialPerformance.js');
  const peak = tracks => Math.max(...Object.values(tracks).flat().map(k => k.w));
  const normal = speechMouth('照れながらお礼を伝える', 3);
  assert.ok(Object.keys(normal).length >= 3);
  assert.ok(peak(speechMouth('大声で「待って！」と叫ぶ', 3)) > peak(normal));
  assert.ok(peak(speechMouth('「ないしょ」とささやく', 3)) < 0.5);
  assert.ok(Object.keys(speechMouth('He says "thank you"', 3)).length > 0);
});

test('purely physical requests get no mouth movement', async () => {
  const { speechMouth } = await import('../src/facialPerformance.js');
  for (const text of ['右手を振る', 'ゆっくりしゃがむ', 'A person waves.']) assert.deepEqual(speechMouth(text, 4), {});
});

test('auto expressions place speech in its own clause and keep eyes open while surprised', async () => {
  const { autoExpressions } = await import('../src/autoExpressions.js');
  const e = autoExpressions('手を振る。その後「ありがとう」と言う', 6);
  const speechStart = Math.min(...['aa', 'ih', 'oh', 'ou'].map(n => e[n].find(k => k.w > 0).t));
  assert.ok(speechStart >= 3, `speech should begin in the second clause, got ${speechStart}`);
  assert.ok(e.blink.length > 1);
  const surprised = autoExpressions('びっくりする', 20);
  const peakSurprise = surprised.surprised.filter(k => k.w > 0.5).map(k => k.t);
  for (const t of blinkTimes(surprised.blink ?? [])) {
    assert.ok(!(t > peakSurprise[0] && t < peakSurprise.at(-1)), `blinked at ${t} during surprise`);
  }
});
