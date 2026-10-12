// facialPerformance.js — 自然なまばたきと、セリフに合わせた口の動き。
// 追加のモデル呼び出しはしない。原文から決まる擬似乱数で毎回同じ結果になる。

// 文字列から決まる擬似乱数 (同じ原文なら同じまばたき・口の揺らぎになる)
function seededRandom(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一定間隔ではなく、人のまばたきに近い間隔・形にする。
 * 閉じるのは速く開くのは遅い。ときどき2回続ける。驚きの表情が強い間は控える。
 * @param {number} duration
 * @param {{seed?: string, suppressAt?: (t:number)=>boolean}} [options]
 */
export function naturalBlinks(duration, { seed = '', suppressAt = () => false } = {}) {
  if (!Number.isFinite(duration) || duration <= 1) return null;
  const random = seededRandom(`blink:${seed}`);
  const keys = [{ t: 0, w: 0 }];
  const close = 0.07, hold = 0.03, open = 0.12;
  const blinkAt = t => {
    keys.push({ t: t - close, w: 0 }, { t, w: 1 }, { t: t + hold, w: 1 }, { t: t + hold + open, w: 0 });
  };
  // 最初の瞬きは早めに来ることもある。人の間隔はおおむね2〜5秒でばらつく
  let t = 0.8 + random() * 2.2;
  while (t < duration - 0.4) {
    if (!suppressAt(t)) {
      blinkAt(t);
      if (random() < 0.15 && t + 0.32 < duration - 0.4) { t += 0.32; blinkAt(t); }
    }
    t += 2 + random() * 3;
  }
  return keys.length > 1 ? keys : null;
}

const SPEECH_VERB = /言う|言っ|言い|話す|話し|しゃべ|喋|伝え|告げ|叫|怒鳴|呼びかけ|呼ぶ|歌う|歌い|つぶや|呟|ささや|囁|返事|答え|挨拶する|お礼を|謝る|謝り|説明|\b(?:says?|said|saying|speaks?|speaking|talks?|talking|tells?|telling|shouts?|shouting|yells?|yelling|calls? out|sings?|singing|whispers?|whispering|murmurs?|answers?|replies|thanks?)\b/i;
const LOUD = /叫|怒鳴|大声|絶叫|\b(?:shout|yell|scream)/i;
const QUIET = /ささや|囁|小声|つぶや|呟|\b(?:whisper|murmur|mutter)/i;
const QUOTE = /「([^」]+)」|『([^』]+)』|"([^"]+)"|“([^”]+)”/g;
const HAS_QUOTE = new RegExp(QUOTE.source);

// かな → 母音 (VRMの口の形)。漢字は読めないので母音を順に当てる
const VOWEL_OF = {};
const ROWS = ['あかさたなはまやらわがざだばぱぁゃゎ', 'いきしちにひみりぎじぢびぴぃ', 'うくすつぬふむゆるぐずづぶぷぅゅゔ', 'えけせてねへめれげぜでべぺぇ', 'おこそとのほもよろをごぞどぼぽぉょ'];
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
ROWS.forEach((row, index) => { for (const ch of row) VOWEL_OF[ch] = MOUTH[index]; });
const toHiragana = ch => {
  const code = ch.codePointAt(0);
  return code >= 0x30A1 && code <= 0x30F6 ? String.fromCodePoint(code - 0x60) : ch;
};

/**
 * セリフを口の形の並び (モーラ単位) にする。null は口を閉じる・間を置く。
 * @returns {{mouth: string|null, beats: number}[]}
 */
export function speechMorae(line) {
  const morae = [];
  const english = /[a-z]/i.test(line) && !/[぀-ヿ一-鿿]/.test(line);
  if (english) {
    // 英語は母音のまとまりを音節として扱う
    for (const word of line.toLowerCase().split(/([\s,.!?;:]+)/)) {
      if (/^[\s,.!?;:]+$/.test(word)) { morae.push({ mouth: null, beats: /[.!?]/.test(word) ? 2 : /,/.test(word) ? 1 : 0.4 }); continue; }
      for (const vowel of word.match(/[aeiouy]+/g) ?? []) {
        const v = vowel[0];
        morae.push({ mouth: v === 'a' ? 'aa' : v === 'i' || v === 'y' ? 'ih' : v === 'u' ? 'ou' : v === 'e' ? 'ee' : 'oh', beats: 1.3 });
      }
    }
    return morae;
  }
  let kanji = 0;
  for (const raw of line) {
    const ch = toHiragana(raw);
    if (/[、,，]/.test(ch)) morae.push({ mouth: null, beats: 1.5 });
    else if (/[。.!！?？…]/.test(ch)) morae.push({ mouth: null, beats: 2.5 });
    else if (/[ゃゅょぁぃぅぇぉゎ]/.test(ch) && morae.length && morae.at(-1).mouth) morae.at(-1).mouth = VOWEL_OF[ch];
    else if (ch === 'ー' && morae.length) morae.push({ mouth: morae.at(-1).mouth, beats: 1 });
    else if (ch === 'っ' || ch === 'ッ') morae.push({ mouth: null, beats: 1 });
    else if (ch === 'ん') morae.push({ mouth: null, beats: 0.8 });
    else if (VOWEL_OF[ch]) morae.push({ mouth: VOWEL_OF[ch], beats: 1 });
    else if (/[一-鿿]/.test(ch)) {
      // 漢字はおよそ2モーラ。口の形は順に変えて単調にしない
      morae.push({ mouth: MOUTH[kanji % 5], beats: 1 }, { mouth: MOUTH[(kanji + 2) % 5], beats: 1 });
      kanji++;
    }
  }
  return morae;
}

const MORA_SECONDS = 0.13; // 日本語のふつうの話速 (約7.5モーラ/秒)

/**
 * 原文に話す動作があれば、その区間に口の動きを付ける。
 * セリフが「」等で書かれていればその母音で、無ければ自然な口の開閉で表す。
 * @param {string} text 原文
 * @param {number} duration モーション全体の長さ
 * @param {{start:number,end:number,text:string}[]} [phases] 文や区間ごとの時間配分
 * @returns {{[name:string]: {t:number,w:number}[]}}
 */
export function speechMouth(text, duration, phases = null) {
  const tracks = {};
  if (typeof text !== 'string' || !Number.isFinite(duration) || duration <= 0) return tracks;
  const spans = (phases?.length ? phases : [{ start: 0, end: duration, text }])
    .filter(phase => SPEECH_VERB.test(phase.text) || HAS_QUOTE.test(phase.text));
  if (!spans.length) return tracks;
  const random = seededRandom(`mouth:${text}`);
  const add = (name, t, w) => (tracks[name] ??= [{ t: 0, w: 0 }]).push({ t, w });
  for (const span of spans) {
    const quoted = [...span.text.matchAll(QUOTE)].map(m => m.slice(1).find(Boolean)).join('、');
    // セリフが無い「話す」は、短い言葉を交わす程度の口の開閉にする
    const morae = speechMorae(quoted || 'あいうえおあおいえあう、おあいう');
    if (!morae.length) continue;
    const available = Math.max(0.3, (span.end - span.start) * (quoted ? 0.92 : 0.75));
    const beats = morae.reduce((sum, mora) => sum + mora.beats, 0);
    // ふつうの話速を基準に、区間に収まらなければ少しだけ速め、長すぎれば区間で切る
    const unit = Math.min(MORA_SECONDS, Math.max(available / beats, 0.085));
    const loudness = LOUD.test(span.text) ? 1 : QUIET.test(span.text) ? 0.35 : 0.7;
    let t = span.start + Math.min(0.15, (span.end - span.start) * 0.1);
    for (const mora of morae) {
      const length = mora.beats * unit;
      if (t + length > span.end - 0.05) break;
      if (mora.mouth) {
        const w = Math.min(1, loudness * (0.85 + random() * 0.3));
        add(mora.mouth, t, 0);
        add(mora.mouth, t + length * 0.4, w);
        add(mora.mouth, t + length * 0.9, 0);
      }
      t += length;
    }
  }
  for (const [name, keys] of Object.entries(tracks)) {
    keys.push({ t: duration, w: 0 });
    tracks[name] = [...new Map(keys.map(k => [Math.round(k.t * 1000) / 1000, { t: Math.round(k.t * 1000) / 1000, w: Math.round(k.w * 100) / 100 }])).values()].sort((a, b) => a.t - b.t);
  }
  return tracks;
}
