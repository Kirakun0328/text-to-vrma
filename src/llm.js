// llm.js — OpenAI API でテキストからモーション spec を生成する
import { BONE_NAMES } from './vrmaBuilder.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

export const SYSTEM_PROMPT = `あなたはVRMヒューマノイドキャラクターのモーションデザイナーです。
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
- キーは滑らかに補間される (線形+球面補間)。動きに緩急をつけるためキーを十分に打つ。
- duration は 1.5〜15 秒。内容に合わせて決める:
  - 単発の動作 (うなずく・手を振る等) は 2〜4 秒
  - 複数動作の連続・ダンス・演技は 8〜15 秒。動きをフェーズに分けて構成し、
    フェーズの区切りに短い静止や姿勢の切り替えを入れる
- キー数は動きの長さに比例させる (目安: 1秒あたり 2〜4 キー、1ボーン最大 40 キー)。
  長いモーションでも間延びしないよう、常にどこかの部位が動いているようにする。
- 回転角は関節の可動域内に収める。特に:
  - leftHand / rightHand (手首) は動かさない (自然な手のポーズが自動で適用される)。
  - leftShoulder / rightShoulder (肩) も動かさない (服のメッシュが歪みやすい)。腕の動きは upperArm で作る。
  - 肘 (lowerArm) は1軸中心に曲げる。複数軸を同時に大きく回すと関節が破綻する。
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

# 設計の手順 (重要)
1. まず、その動きを実際の人間がどうやるかを頭の中で再生する。
   どの関節が、どの順序で、どんなリズムで動くか。重心はどう移動するか。
2. それを座標規約に従って数値化する。定型パターンに当てはめない。
3. 同じ指示でも毎回同じ振り付けにしない。人によって動きに個性があるように、
   表現には幅がある。ルールの範囲内で自由に演技を設計してよい。

# 参考例 (JSONの書式と品質水準の見本。動き・角度・キー配置をコピーしないこと)

## お辞儀 (背骨を分散して曲げる + 静止の間)
{"name":"bow","duration":2.4,"loop":false,
 "tracks":{
  "leftUpperArm":[{"t":0,"r":[0,0,-70]},{"t":2.4,"r":[0,0,-70]}],
  "rightUpperArm":[{"t":0,"r":[0,0,70]},{"t":2.4,"r":[0,0,70]}],
  "spine":[{"t":0,"r":[0,0,0]},{"t":0.7,"r":[22,0,0]},{"t":1.6,"r":[22,0,0]},{"t":2.4,"r":[0,0,0]}],
  "chest":[{"t":0,"r":[0,0,0]},{"t":0.7,"r":[18,0,0]},{"t":1.6,"r":[18,0,0]},{"t":2.4,"r":[0,0,0]}],
  "neck":[{"t":0,"r":[0,0,0]},{"t":0.7,"r":[12,0,0]},{"t":1.6,"r":[12,0,0]},{"t":2.4,"r":[0,0,0]}]
 },
 "hips":[]}

## ジャンプ (しゃがみの予備動作 → 空中 → 着地の沈み込み)
{"name":"jump","duration":1.8,"loop":false,
 "tracks":{
  "leftUpperArm":[{"t":0,"r":[0,0,-70]},{"t":0.35,"r":[0,0,-50]},{"t":0.55,"r":[0,0,60]},{"t":0.9,"r":[0,0,60]},{"t":1.3,"r":[0,0,-70]},{"t":1.8,"r":[0,0,-70]}],
  "rightUpperArm":[{"t":0,"r":[0,0,70]},{"t":0.35,"r":[0,0,50]},{"t":0.55,"r":[0,0,-60]},{"t":0.9,"r":[0,0,-60]},{"t":1.3,"r":[0,0,70]},{"t":1.8,"r":[0,0,70]}],
  "leftUpperLeg":[{"t":0,"r":[0,0,0]},{"t":0.35,"r":[-40,0,0]},{"t":0.55,"r":[0,0,0]},{"t":1.1,"r":[-25,0,0]},{"t":1.4,"r":[0,0,0]},{"t":1.8,"r":[0,0,0]}],
  "rightUpperLeg":[{"t":0,"r":[0,0,0]},{"t":0.35,"r":[-40,0,0]},{"t":0.55,"r":[0,0,0]},{"t":1.1,"r":[-25,0,0]},{"t":1.4,"r":[0,0,0]},{"t":1.8,"r":[0,0,0]}],
  "leftLowerLeg":[{"t":0,"r":[0,0,0]},{"t":0.35,"r":[70,0,0]},{"t":0.55,"r":[0,0,0]},{"t":1.1,"r":[45,0,0]},{"t":1.4,"r":[0,0,0]},{"t":1.8,"r":[0,0,0]}],
  "rightLowerLeg":[{"t":0,"r":[0,0,0]},{"t":0.35,"r":[70,0,0]},{"t":0.55,"r":[0,0,0]},{"t":1.1,"r":[45,0,0]},{"t":1.4,"r":[0,0,0]},{"t":1.8,"r":[0,0,0]}]
 },
 "hips":[{"t":0,"p":[0,0,0]},{"t":0.35,"p":[0,-0.18,0]},{"t":0.65,"p":[0,0.28,0]},{"t":1.0,"p":[0,-0.1,0]},{"t":1.4,"p":[0,0,0]},{"t":1.8,"p":[0,0,0]}]}

## 後ろを振り返る (視線が先行 → 体が追従する順序付け)
{"name":"turnBack","duration":3.0,"loop":false,
 "tracks":{
  "leftUpperArm":[{"t":0,"r":[0,0,-70]},{"t":3.0,"r":[0,0,-70]}],
  "rightUpperArm":[{"t":0,"r":[0,0,70]},{"t":3.0,"r":[0,0,70]}],
  "head":[{"t":0,"r":[0,0,0]},{"t":0.3,"r":[0,35,0]},{"t":0.8,"r":[0,50,0]},{"t":2.2,"r":[0,20,0]},{"t":3.0,"r":[0,0,0]}],
  "chest":[{"t":0,"r":[0,0,0]},{"t":0.5,"r":[0,20,0]},{"t":1.0,"r":[0,25,0]},{"t":2.3,"r":[0,10,0]},{"t":3.0,"r":[0,0,0]}]
 },
 "hips":[{"t":0,"p":[0,0,0]},{"t":0.6,"p":[0,0,0]},{"t":3.0,"p":[0,0,0]}]}

## 喜んで跳ねる (感情表現 = 体全体のリズム + 頭の上向き)
{"name":"joy","duration":2.4,"loop":true,
 "tracks":{
  "leftUpperArm":[{"t":0,"r":[0,0,-70]},{"t":0.3,"r":[0,0,60]},{"t":0.7,"r":[0,0,80]},{"t":1.1,"r":[0,0,60]},{"t":1.5,"r":[0,0,80]},{"t":1.9,"r":[0,0,60]},{"t":2.4,"r":[0,0,-70]}],
  "rightUpperArm":[{"t":0,"r":[0,0,70]},{"t":0.3,"r":[0,0,-60]},{"t":0.7,"r":[0,0,-80]},{"t":1.1,"r":[0,0,-60]},{"t":1.5,"r":[0,0,-80]},{"t":1.9,"r":[0,0,-60]},{"t":2.4,"r":[0,0,70]}],
  "head":[{"t":0,"r":[0,0,0]},{"t":0.4,"r":[-12,0,0]},{"t":1.9,"r":[-12,0,0]},{"t":2.4,"r":[0,0,0]}]
 },
 "hips":[{"t":0,"p":[0,0,0]},{"t":0.3,"p":[0,-0.08,0]},{"t":0.6,"p":[0,0.12,0]},{"t":0.9,"p":[0,-0.05,0]},{"t":1.2,"p":[0,0.12,0]},{"t":1.5,"p":[0,-0.05,0]},{"t":1.8,"p":[0,0.1,0]},{"t":2.1,"p":[0,0,0]},{"t":2.4,"p":[0,0,0]}]}`;

// 2パス目: 生成結果を検証・修正させるプロンプト
export const REFINE_INSTRUCTION = `以下は上記の指示で生成されたモーションJSONです。アニメーターとしてレビューし、
問題があれば修正した完全なJSONのみを返してください (問題がなければそのまま返す)。

チェック観点:
1. 可動域: 各関節がルールの範囲内か。腕が真上 (±90度) を超えていないか。
2. 軌道: 腕や脚が体・頭と交差していないか。左右の取り違えがないか。
3. 自然さ: 肘が伸びきっていないか。往復運動の端で減速しているか。予備動作と余韻があるか。
4. 完全性: 使うボーンに t=0 と t=duration のキーがあるか。非ループは最初と最後がニュートラルか。
5. 意図: そもそもユーザーの指示した動きになっているか。
6. 表現: 定型的・機械的すぎないか。実際の人間がやる動きとして違和感がないか。`;

// ボーン別の安全な角度上限 (度)。LLM出力の暴れをクランプする
const ANGLE_LIMITS = {
  leftHand: 25, rightHand: 25,
  leftUpperArm: 90, rightUpperArm: 90,
  neck: 45, head: 70,
  spine: 45, chest: 45, upperChest: 45,
  leftFoot: 60, rightFoot: 60,
};
const DEFAULT_ANGLE_LIMIT = 175;

async function callOpenAI(messages, apiKey, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages,
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
  if (!content) throw new Error('OpenAI API から有効な応答が得られませんでした');
  return content;
}

/**
 * OpenAI API でテキストからモーション spec を生成する。
 * @param {string} text ユーザー入力
 * @param {string} apiKey OpenAI API キー (sk-...)
 * @param {string} model 使用するモデル ID (例: 'gpt-5.6-sol')
 * @param {object} [options]
 * @param {boolean} [options.refine=true] 2パス目で自己修正を行う
 * @param {(msg: string) => void} [options.onProgress] 進捗表示コールバック
 * @returns {Promise<object>} モーション spec
 */
export async function generateMotionWithOpenAI(
  text,
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  { refine = true, onProgress } = {}
) {
  // 演出の味付けをランダムに混ぜて、同じ指示でも毎回違う振り付けを引き出す
  const flavor = randomFlavor();
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    `(今回の演出の味付け: ${flavor}。ただしユーザーの指示と矛盾する場合は指示を優先)`;

  // 1パス目: 生成
  const draft = await callOpenAI(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    apiKey,
    model
  );
  let spec = JSON.parse(draft);
  validateSpec(spec);

  // 2パス目: 自己修正 (失敗しても1パス目の結果を使う)
  if (refine) {
    onProgress?.('生成したモーションを検証・修正中... (2パス目)');
    try {
      const refined = await callOpenAI(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: JSON.stringify(spec) },
          { role: 'user', content: REFINE_INSTRUCTION },
        ],
        apiKey,
        model
      );
      const refinedSpec = JSON.parse(refined);
      validateSpec(refinedSpec);
      spec = refinedSpec;
    } catch (e) {
      console.warn('自己修正パスに失敗したため1パス目の結果を使用します:', e);
    }
  }

  if (!spec.hips?.length) delete spec.hips;
  spec.flavor = flavor; // 表示用 (buildVRMA では無視される)
  return spec;
}

const MAX_DURATION = 20; // 秒

// 毎回ランダムに混ぜる「演出の味付け」— 同じ指示でも違う振り付けを引き出す
const FLAVOR_AXES = [
  ['エネルギッシュに', 'しっとり落ち着いて', 'コミカルに', 'クールに', '照れくさそうに', '堂々と', '優雅に', '無邪気に'],
  ['速いテンポで小気味よく', 'ゆったり大きく動く', '緩急を強くつける', '一定のリズムで繰り返す'],
  ['腕の動きを主役に', '腰と重心の移動を主役に', '頭と上半身の表情を主役に', '全身をまんべんなく使って', '脚のステップを主役に'],
  ['左右非対称の振り付けで', '途中に一度タメ(静止)を入れて', '最後に決めポーズで締めて', '回転やターンを織り交ぜて', '上下動を強調して'],
];

function randomFlavor() {
  // 4軸から2〜3個をランダムに選ぶ
  const shuffled = [...FLAVOR_AXES].sort(() => Math.random() - 0.5);
  const count = 2 + Math.floor(Math.random() * 2);
  return shuffled
    .slice(0, count)
    .map((axis) => axis[Math.floor(Math.random() * axis.length)])
    .join('、');
}

function validateSpec(spec) {
  if (typeof spec.duration !== 'number' || spec.duration <= 0) {
    throw new Error('生成されたモーションの duration が不正です');
  }
  if (spec.duration > MAX_DURATION) {
    spec.duration = MAX_DURATION;
    for (const keys of Object.values(spec.tracks ?? {})) {
      if (Array.isArray(keys)) {
        const inRange = keys.filter((k) => k?.t <= MAX_DURATION);
        keys.length = 0;
        keys.push(...inRange);
      }
    }
    if (Array.isArray(spec.hips)) {
      spec.hips = spec.hips.filter((k) => k?.t <= MAX_DURATION);
    }
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
    // 肩はビルダーの自動追従に任せる (LLM の肩回転は服を歪めやすい)
    if (bone === 'leftShoulder' || bone === 'rightShoulder') {
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
