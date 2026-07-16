// autoExpressions.js — プロンプトの感情語から表情トラックを自動生成する
// (ARDYモード用: ARDYはボーンモーションのみで表情を作らないため、ここで補う)

// 感情語 → VRM表情プリセット。上から順に最初にマッチした1つを採用
const EMOTION_RULES = [
  { re: /happy|joy|smil|laugh|cheer|excit|dance|celebrat|嬉し|うれし|楽し|たのし|笑|喜|踊|ダンス|わーい|やった/i, preset: 'happy', weight: 0.7 },
  { re: /sad|cry|sob|depress|gloomy|悲し|かなし|泣|涙|しょんぼり|落ち込|うつむ/i, preset: 'sad', weight: 0.7 },
  { re: /angry|mad|furious|rage|stomp|怒|おこ|イライラ|憤|キレ/i, preset: 'angry', weight: 0.7 },
  { re: /surpris|shock|astonish|startl|驚|おどろ|びっくり|ビックリ|仰天/i, preset: 'surprised', weight: 0.8 },
  { re: /relax|calm|rest|sleep|yawn|stretch|リラックス|くつろ|眠|ねむ|あくび|伸び|穏やか/i, preset: 'relaxed', weight: 0.6 },
];

const BLINK_INTERVAL = 3.2; // 秒
const BLINK_CLOSE = 0.08;   // 閉じるのにかかる時間

/**
 * プロンプトとモーション長から表情トラックを作る。
 * @param {string} text 原文プロンプト (日本語/英語)
 * @param {number} duration モーション長 (秒)
 * @param {string|null} [forcedPreset] GPT等が判定した表情プリセット (キーワードより優先)
 * @returns {{ [preset: string]: {t:number,w:number}[] }}
 */
export function autoExpressions(text, duration, forcedPreset = null) {
  const expressions = {};

  // 感情表情: フェードイン → 維持 → フェードアウト
  const rule = forcedPreset
    ? { preset: forcedPreset, weight: 0.7 }
    : EMOTION_RULES.find((r) => r.re.test(text));
  if (rule && duration > 0.8) {
    const fadeIn = Math.min(0.4, duration * 0.15);
    const fadeOut = Math.min(0.5, duration * 0.15);
    expressions[rule.preset] = [
      { t: 0, w: 0 },
      { t: fadeIn, w: rule.weight },
      { t: Math.max(fadeIn, duration - fadeOut), w: rule.weight },
      { t: duration, w: rule.preset === 'happy' ? rule.weight * 0.5 : 0 },
    ];
  }

  // まばたき: 一定間隔で閉じる (最初と最後の0.5秒は避ける)
  const blink = [{ t: 0, w: 0 }];
  for (let t = BLINK_INTERVAL; t < duration - 0.5; t += BLINK_INTERVAL) {
    blink.push(
      { t: t - BLINK_CLOSE, w: 0 },
      { t, w: 1 },
      { t: t + BLINK_CLOSE, w: 0 },
    );
  }
  if (blink.length > 1) expressions.blink = blink;

  return expressions;
}
