// llm.js — OpenAI (ChatGPT) API で自由なテキストからモーション spec を生成する (オプション機能)
import { BONE_NAMES } from './vrmaBuilder.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

const SYSTEM_PROMPT = `あなたはVRMヒューマノイドキャラクターのモーションデザイナーです。
ユーザーのテキストから、キーフレームアニメーションのJSONを生成してください。
出力はJSONオブジェクトのみ。説明文やコードブロックは不要です。

# 座標規約 (VRM 1.0 / T-pose レスト)
- モデルは +Z を向いて立つ。+X はモデルの左手側、+Y が上。
- 回転はレストポーズ(Tポーズ)からのオイラー角 [X, Y, Z] (度、XYZ順)。
- 腕はTポーズで真横に伸びている:
  - 左腕を下ろす: leftUpperArm Z=-70 / 右腕を下ろす: rightUpperArm Z=+70
  - 右腕を高く上げる: rightUpperArm Z=-60 前後 / 左腕: Z=+60 前後
  - 肘を曲げる: leftLowerArm / rightLowerArm を回転 (右肘を曲げて手を上げる: rightLowerArm Z=-90 付近)
  - 腕を前に出す: leftUpperArm Y=-60 / rightUpperArm Y=+60
- 前屈・うなずき: spine/chest/neck/head の X を正方向 (+20 で前へ 20 度)
- 頭を左右に向ける: head Y (正 = モデルの左を向く)
- しゃがむ: hips の p.y を負に + leftUpperLeg/rightUpperLeg X=-45, leftLowerLeg/rightLowerLeg X=+80 など
- ジャンプ: hips の p.y を一時的に +0.2〜0.3
- 体全体の向き変更は hips の Y 回転

# 使用可能なボーン
${BONE_NAMES.join(', ')}

# 出力フォーマット (このJSON構造のみを返す)
{
  "name": "モーション名(英数字)",
  "duration": 秒数,
  "loop": true/false,
  "tracks": { "ボーン名": [ { "t": 秒, "r": [X度, Y度, Z度] }, ... ], ... },
  "hips": [ { "t": 秒, "p": [dx, dy, dz] }, ... ]
}
hips は腰位置のオフセット(メートル)。不要なら空配列 [] にする。

# ルール
- 常に腕を下ろした自然な姿勢から始める (leftUpperArm Z=-70, rightUpperArm Z=+70 を t=0 に置く)。
- 使うボーンには必ず t=0 と t=duration のキーを置き、非ループなら最初と最後をニュートラルに戻す。
- キーは滑らかに補間される (線形+球面補間)。動きに緩急をつけるためキーを十分に打つ (1モーションあたり4〜12キー程度)。
- duration は 1.5〜6 秒程度。感情や勢いをテキストから読み取って表現豊かに。
- 回転角は関節の可動域内 (概ね ±150 度以内) に収める。`;

/**
 * OpenAI API でテキストからモーション spec を生成する。
 * @param {string} text ユーザー入力
 * @param {string} apiKey OpenAI API キー (sk-...)
 * @param {string} model 使用するモデル ID (例: 'gpt-5.1', 'gpt-4o')
 * @returns {Promise<object>} モーション spec
 */
export async function generateMotionWithChatGPT(text, apiKey, model = DEFAULT_OPENAI_MODEL) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `次の動きのモーションを作成: ${text}` },
      ],
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.error?.message ?? detail;
    } catch { /* JSONでないエラー応答はステータスのみ */ }
    throw new Error(`OpenAI API エラー: ${detail}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('ChatGPT から有効な応答が得られませんでした');

  const spec = JSON.parse(content);
  validateSpec(spec);
  if (!spec.hips?.length) delete spec.hips;
  return spec;
}

function validateSpec(spec) {
  if (typeof spec.duration !== 'number' || spec.duration <= 0) {
    throw new Error('生成されたモーションの duration が不正です');
  }
  if (!spec.tracks || typeof spec.tracks !== 'object') {
    throw new Error('生成されたモーションに tracks がありません');
  }
  // 不明なボーンや壊れたキーは除去して続行
  for (const [bone, keys] of Object.entries(spec.tracks)) {
    if (!BONE_NAMES.includes(bone) || !Array.isArray(keys)) {
      delete spec.tracks[bone];
      continue;
    }
    spec.tracks[bone] = keys.filter(
      (k) => typeof k?.t === 'number' && Array.isArray(k.r) && k.r.length === 3
    );
    if (spec.tracks[bone].length === 0) delete spec.tracks[bone];
  }
  if (Object.keys(spec.tracks).length === 0 && !spec.hips?.length) {
    throw new Error('生成されたモーションに有効なトラックがありません');
  }
  if (Array.isArray(spec.hips)) {
    spec.hips = spec.hips.filter(
      (k) => typeof k?.t === 'number' && Array.isArray(k.p) && k.p.length === 3
    );
  }
}
