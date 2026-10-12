// Shared directing rules for generation and review. These are acting cues, not
// a claim that the generated body motion has been semantically verified.
export const EMOTION_ACTING_GUIDE = `
# 感情と身体の演技
- 原文の動作・姿勢・左右・回数・順序・強度・禁止事項を最優先する。
- 指定された感情を表情ウェイトだけで処理せず、主動作の姿勢・速度変化・緊張・緩急へ反映する。
- 感情の名前を特定の仕草に対応付けない。その都度、原文と状況に合う身体の演技を設計する。
- 感情だけから新たな主動作や移動を追加しない。感情が不明なら勝手な表情・感情動作を加えない。
- 強度は原文から読み取り、大きさ・加速・減速・緊張へ反映する。自然さを一律の弱い動きや滑らかさと解釈しない。
- 時間変化を保つ。感情の発生・変化・持続・抑制・余韻を指示から読み取り、開始直後から常に最大にしない。
- 同時に混ざる感情と、時間順に移り変わる感情を区別する。感情だけを理由に一続きの身体動作を分割しない。
- 関係性や対象への身体の向き・距離は原文にある場合に反映し、未指定の対象や移動を追加しない。
- 身体の各部の連動と接地を保つ。原文が同時動作を指定していれば、その同時性を優先する。
- 基本表情の対応範囲は happy / angry / sad / relaxed / surprised / neutral。
  専用プリセットのない感情は対応する表情の組み合わせと身体の演技で表す。
  存在しない表情トラックを作らず、アバターにない表情を表示できる前提で身体動作を省略しない。
- ARDY向け英文は主要な身体動作と必要な感情の手掛かりを簡潔にまとめ、全項目の羅列で長文化しない。
- 終了時も原文で求めた姿勢・感情を保つ。一律の表情や姿勢で締めない。
`;

// Text cues provide an approximate expression envelope; no extra model call or
// body-track retiming. The body acting is directed through the shared guide above.
export function emotionDynamics(text) {
  const restrained=/抑え|抑える|こらえ|堪え|控えめ|静かに|少しだけ|\b(?:restrained|subdued|slightly|quietly)\b|holds? back/i.test(text);
  const strong=/大喜び|大はしゃぎ|激怒|激しく|猛烈|強く|\b(?:furious|intensely|overjoyed|forceful)\b/i.test(text);
  const gradual=/徐々に|だんだん|こみ上げ|込み上げ|次第に|\b(?:gradually|builds?|wells?)\b/i.test(text);
  const sudden=/突然|一気に|ぱっと|爆発|\b(?:suddenly|bursts?|abruptly)\b/i.test(text);
  return {strength:restrained?.5:strong?1.3:1,peakAt:gradual?.7:sudden?.12:null};
}
