// llm.js — OpenAI (ChatGPT) API で自由なテキストからモーション spec を生成する (オプション機能)
import { BONE_NAMES } from './vrmaBuilder.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

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
- 回転角は関節の可動域内に収める。特に:
  - leftHand / rightHand (手首) は動かさない (自然な手のポーズが自動で適用される)。
  - 肘 (lowerArm) は1軸中心に曲げる。複数軸を同時に大きく回すと関節が破綻する。
  - shoulder は ±15 度程度の補助にとどめ、腕の主な動きは upperArm で作る。
  - 首・頭の合計は ±60 度以内。spine/chest はそれぞれ ±30 度以内。
- 動きの主役となる関節を決め、それ以外は控えめに。全身の関節を同時に大きく動かさない。

# 自然なポーズの原則 (違和感を出さないために厳守)
- 腕を上げるときは斜め上まで: upperArm の Z は右 -75〜-40 / 左 +40〜+75 の範囲。
  真上 (±90) を超えて頭の上に腕を被せない。腕は常に体の輪郭の外側で動かす。
- 肘は伸ばしきらない: 腕を使うポーズでは lowerArm に常に 10〜30 度の曲げを残す
  (完全に伸びた腕はロボットのように見える)。
- 往復運動 (振る・揺れる等) は端で減速する: 折り返し点の直前に中間キーを入れて
  緩急をつける (等速の往復は機械的に見える)。
- 動き出しに小さな予備動作 (0.1〜0.2秒の逆方向の溜め)、終わりに余韻を入れると自然。
- 体の向きと視線を添える: 大きな動作には head や chest の小さな傾き (5〜10度) を
  連動させる。ただし主役の関節より控えめに。

# 良い例 (右手を振る)
{"name":"wave","duration":2.6,"loop":true,
 "tracks":{
  "leftUpperArm":[{"t":0,"r":[0,0,-70]},{"t":2.6,"r":[0,0,-70]}],
  "rightUpperArm":[{"t":0,"r":[0,0,70]},{"t":0.4,"r":[0,0,-45]},{"t":2.2,"r":[0,0,-45]},{"t":2.6,"r":[0,0,70]}],
  "rightLowerArm":[{"t":0,"r":[0,0,0]},{"t":0.4,"r":[0,0,-60]},{"t":0.8,"r":[0,0,-85]},{"t":1.2,"r":[0,0,-45]},{"t":1.6,"r":[0,0,-85]},{"t":2.0,"r":[0,0,-60]},{"t":2.6,"r":[0,0,0]}],
  "head":[{"t":0,"r":[0,0,0]},{"t":0.5,"r":[0,-8,5]},{"t":2.1,"r":[0,-8,5]},{"t":2.6,"r":[0,0,0]}]
 },
 "hips":[]}`;

// ボーン別の安全な角度上限 (度)。LLM出力の暴れをクランプする
const ANGLE_LIMITS = {
  leftHand: 25, rightHand: 25,
  leftShoulder: 30, rightShoulder: 30,
  leftUpperArm: 100, rightUpperArm: 100,
  neck: 45, head: 70,
  spine: 45, chest: 45, upperChest: 45,
  leftFoot: 60, rightFoot: 60,
};
const DEFAULT_ANGLE_LIMIT = 175;

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
    const limit = ANGLE_LIMITS[bone] ?? DEFAULT_ANGLE_LIMIT;
    spec.tracks[bone] = keys
      .filter((k) => typeof k?.t === 'number' && Array.isArray(k.r) && k.r.length === 3)
      .map((k) => ({
        t: k.t,
        r: k.r.map((v) => Math.max(-limit, Math.min(limit, Number(v) || 0))),
      }));
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
