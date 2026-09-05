import { t } from './i18n.js';
import { EMOTION_ACTING_GUIDE } from './emotionActing.js';
import { normalizeMotionChecks } from './motionCompliance.js';
// llm.js — OpenAI API でテキストからモーション spec を生成する
import { BONE_NAMES, EXPRESSION_PRESETS } from './vrmaBuilder.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

export const SYSTEM_PROMPT = `あなたはVRMヒューマノイドキャラクターのモーションデザイナーです。
ユーザーのテキストから、キーフレームアニメーションのJSONを生成してください。
出力はJSONオブジェクトのみ。説明文やコードブロックは不要です。
${EMOTION_ACTING_GUIDE}

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
  "hips": [ { "t": 秒, "p": [dx, dy, dz] }, ... ],
  "expressions": { "表情名": [ { "t": 秒, "w": 0〜1 }, ... ], ... }
}
hips は腰位置のオフセット(メートル)。不要なら空配列 [] にする。

# 表情 (expressions) の使い方
- 使える感情表情: happy, angry, sad, relaxed, surprised, neutral。補助: blink (まばたき), aa (口を開く)
- w はウェイト 0〜1。感情表情は 0.4〜1.0、変化には 0.2〜0.4 秒かける。
- モーションの感情に合った表情を必ず入れる (喜ぶ→happy、落ち込む→sad、驚く→surprised 等)。
- まばたき (blink) を 2〜4 秒おきに入れると生きて見える: 0→1→0 を約 0.15 秒で。
- 表情に対応していないモデルでは自動的に無視されるので、遠慮なく使ってよい。

# ルール
- 開始姿勢の指定がなければ腕を下ろした自然な姿勢から始める (leftUpperArm Z=-70, rightUpperArm Z=+70 を t=0 に置く)。指定があればそれを優先する。
- 使うボーンには必ず t=0 と t=duration のキーを置く。終了は指示された姿勢・感情を保ち、非ループでも一律にニュートラルへ戻さない。
- キーは滑らかに補間される (線形+球面補間)。動きに緩急をつけるためキーを十分に打つ。
- duration は 1.5〜15 秒。内容に合わせて決める:
  - 単発の動作 (うなずく・手を振る等) は 2〜4 秒
  - 複数動作の連続・ダンス・演技は 8〜15 秒。動きをフェーズに分けて構成し、
    指示に合う緩急をつけ、連続する動作の区切りには不要な静止を入れない
- キー数は動きの長さに比例させる (目安: 1秒あたり 2〜4 キー、1ボーン最大 40 キー)。
  長いモーションでも間延びしないよう、常にどこかの部位が動いているようにする。
- 回転角は関節の可動域内に収める。特に:
  - leftHand / rightHand (手首) は動かさない (自然な手のポーズが自動で適用される)。
  - leftShoulder / rightShoulder (肩) も動かさない (服のメッシュが歪みやすい)。腕の動きは upperArm で作る。
  - 肘 (lowerArm) の曲げは Z (または Y) を主軸に。X は使わない (前腕が後ろに流れて破綻する)。
  - 首・頭の合計は ±60 度以内。spine/chest はそれぞれ ±30 度以内。
- 動きの主役となる関節を決め、それ以外は控えめに。全身の関節を同時に大きく動かさない。

# 自然なポーズの原則 (違和感を出さないために厳守)
- 腕を上げるときは斜め上まで: upperArm の Z は右 -75〜-40 / 左 +40〜+75 の範囲。
  真上 (±90) を超えて頭の上に腕を被せない。腕は常に体の輪郭の外側で動かす。
- 肘は伸ばしきらない (立ち姿勢の話): 立って腕を使うポーズでは lowerArm に
  10〜30 度の曲げを残す (完全に伸びた腕はロボットのように見える)。
- 寝転ぶ・倒れる・仰向け・うつ伏せ (hips を大きく回転させる姿勢) では逆:
  腕は体の横で床に沿わせ、肘の曲げは 0〜15 度まで。立ちポーズの癖で肘を曲げると
  前腕が天井に突き出た不気味なポーズになる。脚もまっすぐ床に沿わせる。
  手をお腹に載せたい場合のみ upperArm の Y で腕を体の上へ回し、肘は 40 度以下。
- 往復運動 (振る・揺れる等) は端で減速する: 折り返し点の直前に中間キーを入れて
  緩急をつける (等速の往復は機械的に見える)。
- 動き出しに小さな予備動作 (0.1〜0.2秒の逆方向の溜め)、終わりに余韻を入れると自然。
- 体の向きと視線を添える: 大きな動作には head や chest の小さな傾き (5〜10度) を
  連動させる。ただし主役の関節より控えめに。

# 頻出動作の解剖学メモ (形の正解。リズム・回数・演出は自由に設計してよい)
- 手を振る: 上腕は横斜め上 45〜60 度まで (rightUpperArm Z=-45〜-60 / leftUpperArm Z=+45〜+60)。
  肘 (lowerArm) を 60〜90 度曲げて手を「顔の横〜頭の高さ」に置き、前腕を左右に往復させる。
  腕を真上に伸ばしたまま振るのは絶対に不自然。振りの主役は肘から先。
- 手のひらの向きはアプリ側で自動調整されるため、ひねりを自分で入れない。
  lowerArm の X は常に 0 にする (X を入れると前腕が後ろに流れて破綻する)。
- 上腕を 60 度以上上げた状態で肘を 60 度以上曲げない (前腕が頭に被さって不自然)。
- 右手を振る形の正解例 (この骨格の使い方を守る。振る速さ・回数・首の演技などは自由):
  rightUpperArm を [0,0,-50] 前後で維持し、
  rightLowerArm を [0,0,-40] ⇔ [0,0,-55] の間で往復させる。
- 挨拶や合図など腕を上げる動作全般: 手の高さは頭の高さまでで十分。
  それ以上は「上腕を上げる」のではなく「肘の曲げ」で調整する。
- 拍手: 両腕を体の前で構え (upperArm Y ±50〜60 前後 + 少し下げ)、
  肘から先を小さく開閉する。腕全体を大きく開閉しない。

# 脚の解剖学メモ
- 膝 (lowerLeg) は蝶番関節。使うのは X の 0〜130 (後ろに曲げる) のみ。
  負の値 (逆関節) は絶対禁止。Y/Z もほぼ使わない。
- 太もも (upperLeg): X 負で前に上げる (キック・足上げ・歩き)、X 正で後ろへ。
  開脚・ステップの横方向は Z を使う。
- 足踏み・歩く: 左右の upperLeg X を交互に (-30 ⇔ +10 程度)、膝も連動して曲げ、
  腕を逆位相で軽く振る。hips を歩調に合わせて小さく上下させる。
- 足首 (foot): つま先を伸ばす = X 正 (+20〜40、キックやつま先立ち)、反らす = X 負 (-20 程度)。
- キック: 溜め (upperLeg X +10 と膝曲げ) → 素早く蹴り出す (upperLeg X -60〜-90、膝を伸ばす)
  → 戻す。蹴り足と逆側に軽く体重移動 (hips の p.x) を入れるとリアル。
- 膝を曲げる姿勢 (しゃがむ・溜め・着地) では必ず hips の p.y を下げる。
  下げないと足が地面から浮いて見える。目安: 浅い曲げ -0.05〜-0.1 / 深いしゃがみ -0.2〜-0.35。

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
   手を振る系の動作で「解剖学メモ」の形 (上腕45〜60度 + 肘曲げ + 前腕の往復) になっているか。
2. 軌道: 腕や脚が体・頭と交差していないか。前腕が頭の上に被さっていないか
   (上腕60度以上 + 肘60度以上の組み合わせは禁止)。左右の取り違えがないか。
3. 自然さ: 立ち姿勢で肘が伸びきっていないか。逆に寝転び・倒れ姿勢で肘や膝が
   宙に突き出ていないか (床に沿っているか)。往復運動の端で減速しているか。予備動作と余韻があるか。
4. 完全性: 使うボーンに t=0 と t=duration のキーがあるか。開始・終了姿勢と感情が原文の指定に合うか。一律にニュートラルへ変えない。
5. 意図: そもそもユーザーの指示した動きになっているか。
6. 表現: 定型的・機械的すぎないか。実際の人間がやる動きとして違和感がないか。`;

// Claude API (Anthropic) 対応: ブラウザから直接呼び出す (OpenAIキーと同様、localStorageにのみ保存)
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
const CLAUDE_API_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_VERSION = '2023-06-01';
// claude-opus-5 / claude-sonnet-5 は既定でadaptive thinkingが有効 (claude-haiku-4-5は既定オフ)
const THINKING_MODELS = ['claude-opus-5', 'claude-sonnet-5'];

// 進捗%の分母。Claudeは thinking の文字数も分子に入れるので、本文だけを学習する
// OpenAI側のEMA (expectedResponseChars) を使うと分母が小さすぎて早々に99%で
// 頭打ちになる。thinkingの量はモデル差が大きい (haiku 4.5 は思考なし) ため
// モデル別に学習する
const CLAUDE_RESP_CHARS_KEY = 'claude-resp-chars-ema';
// localStorageが無いNode環境 (ローカルHTTP API) ではメモリ上に保持する
const nodeExpectedClaudeChars = new Map();
function expectedClaudeChars(model) {
  const fallback = THINKING_MODELS.includes(model) ? 10000 : 6000;
  if (typeof localStorage === 'undefined') {
    return nodeExpectedClaudeChars.get(model) ?? fallback;
  }
  return Number(localStorage.getItem(`${CLAUDE_RESP_CHARS_KEY}:${model}`)) || fallback;
}
function updateExpectedClaudeChars(model, actual) {
  const prev = expectedClaudeChars(model);
  const next = Math.round(prev * 0.6 + actual * 0.4);
  if (typeof localStorage === 'undefined') nodeExpectedClaudeChars.set(model, next);
  else localStorage.setItem(`${CLAUDE_RESP_CHARS_KEY}:${model}`, String(next));
}

export async function callClaude(messages, apiKey, model, onDelta) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const claudeMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(`${CLAUDE_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_VERSION,
      // ブラウザから直接APIを叩くための必須ヘッダー (Anthropicは既定でCORSをブロックする)
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      // claude-opus-5 / claude-sonnet-5 は既定でadaptive thinkingが有効で、
      // 思考トークンも max_tokens の枠を消費する。長い複合モーションのJSONが
      // 途中で打ち切られないよう、思考+応答の余裕を持たせて大きめに確保する
      max_tokens: 16000,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: claudeMessages,
      // display を明示的に 'summarized' にしないと、thinking の既定 display は
      // 'omitted' で thinking 中は text_delta が一切来ず、進捗バーが 0% のまま
      // 長時間止まって見える。thinking_delta の文字数も進捗計算に使う (下記)
      ...(THINKING_MODELS.includes(model)
        ? { thinking: { type: 'adaptive', display: 'summarized' } }
        : {}),
      ...(onDelta ? { stream: true } : {}),
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.error?.message ?? detail;
    } catch { /* JSONでないエラー応答はステータスのみ */ }
    throw new Error(`Claude API エラー: ${detail}`);
  }

  // ストリーミング受信: 受信文字数を進捗コールバックに流す
  if (onDelta && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    // thinking の文字数。content には含めない (JSON本体ではないため) が、
    // 進捗バーが thinking フェーズ中も動くよう分数計算の分子には加える
    let thinkingChars = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data: /, '').trim();
        if (!data) continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // SSEイベント境界等のパース失敗は無視
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          content += evt.delta.text;
          onDelta(content.length + thinkingChars);
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          thinkingChars += evt.delta.thinking?.length ?? 0;
          onDelta(content.length + thinkingChars);
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          if (evt.delta.stop_reason === 'refusal') {
            throw new Error('Claude が安全性の理由でリクエストを拒否しました');
          }
          if (evt.delta.stop_reason === 'max_tokens') {
            throw new Error(t('llm.claudeMaxTokens'));
          }
        }
      }
    }
    if (!content) throw new Error('Claude API から有効な応答が得られませんでした');
    return content;
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude が安全性の理由でリクエストを拒否しました');
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(t('llm.claudeMaxTokens'));
  }
  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock?.text) throw new Error('Claude API から有効な応答が得られませんでした');
  return textBlock.text;
}

// Claude には output_config.format (json_schema) による厳密なJSON強制モードがあるが、
// 今回はスコープを絞り採用していない (parseJsonLenient をフォールバックとして使う)。
// コードフェンスに包まれた場合や前後に余計な文字が付いた場合に備えて緩めにパースする
function parseJsonLenient(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Claude の応答をJSONとして解析できませんでした');
  }
}

/**
 * Claude API でテキストからモーション spec を生成する。
 * @param {string} text ユーザー入力
 * @param {string} apiKey Claude APIキー (sk-ant-...)
 * @param {string} model 使用するモデル ID (例: 'claude-opus-5')
 * @param {object} [options]
 * @param {boolean} [options.refine=true] 2パス目で自己修正を行う
 * @param {(msg: string) => void} [options.onProgress] 進捗表示コールバック
 * @returns {Promise<object>} モーション spec
 */
export async function generateMotionWithClaude(
  text,
  apiKey,
  model = DEFAULT_CLAUDE_MODEL,
  { refine = true, onProgress, onFraction } = {}
) {
  const flavor = randomFlavor();
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    `(今回の演出の味付け: ${flavor}。ただしユーザーの指示と矛盾する場合は指示を優先)`;

  const expected = expectedClaudeChars(model);
  const pass1End = refine ? 0.6 : 1.0;

  // 進捗コールバックが最後に報告した文字数 (thinking込み)。次回の分母の学習に使う
  let observed = 0;
  const draft = await callClaude(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    apiKey,
    model,
    onFraction && ((chars) => {
      observed = chars;
      onFraction(Math.min(0.99, (chars / expected) * pass1End), 1);
    })
  );
  // 非ストリーミング時は thinking の文字数が分からないので本文長で代用する
  updateExpectedClaudeChars(model, observed || draft.length);
  let spec = parseJsonLenient(draft);
  validateSpec(spec);

  // 2パス目: 自己修正 (失敗しても1パス目の結果を使う)
  if (refine) {
    onProgress?.(t('gen.refine2nd'));
    try {
      const refined = await callClaude(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: JSON.stringify(spec) },
          { role: 'user', content: REFINE_INSTRUCTION },
        ],
        apiKey,
        model,
        onFraction && ((chars) => onFraction(Math.min(0.99, pass1End + (chars / expected) * (1 - pass1End)), 2))
      );
      const refinedSpec = parseJsonLenient(refined);
      validateSpec(refinedSpec);
      spec = refinedSpec;
    } catch (e) {
      console.warn('自己修正パスに失敗したため1パス目の結果を使用します:', e);
    }
  }

  if (!spec.hips?.length) delete spec.hips;
  if (WAVE_RE.test(text)) applyWaveCorrection(spec);
  spec.flavor = flavor; // 表示用 (buildVRMA では無視される)
  return spec;
}

// ボーン別の安全な角度上限 (度)。LLM出力の暴れをクランプする
const ANGLE_LIMITS = {
  leftHand: 25, rightHand: 25,
  leftUpperArm: 75, rightUpperArm: 75,
  neck: 45, head: 70,
  spine: 45, chest: 45, upperChest: 45,
  leftFoot: 60, rightFoot: 60,
};
const DEFAULT_ANGLE_LIMIT = 175;

// 「手を振る」系テキストの検出
const WAVE_RE = /手を振|手をふ|バイバイ|ばいばい|さようなら|さよなら|bye|wave|おいで/i;

// トラックの Z 値を時刻 t で線形補間サンプリング
function sampleZ(keys, t) {
  const s = [...keys].sort((a, b) => a.t - b.t);
  if (t <= s[0].t) return s[0].r[2];
  for (let i = 0; i < s.length - 1; i++) {
    if (t <= s[i + 1].t) {
      const span = s[i + 1].t - s[i].t || 1;
      const f = (t - s[i].t) / span;
      return s[i].r[2] + (s[i + 1].r[2] - s[i].r[2]) * f;
    }
  }
  return s[s.length - 1].r[2];
}

// 手を振る動作の幾何学的な矯正: 上腕は52度まで + 腕を上げている間は手のひらを正面に
function applyWaveCorrection(spec) {
  for (const side of ['left', 'right']) {
    const raiseSign = side === 'left' ? 1 : -1;
    const ua = spec.tracks[`${side}UpperArm`];
    const la = spec.tracks[`${side}LowerArm`];
    if (!ua?.length) continue;
    const maxRaise = Math.max(...ua.map((k) => raiseSign * k.r[2]));
    if (maxRaise < 35) continue; // 振っていない側の腕は触らない
    for (const k of ua) {
      if (raiseSign * k.r[2] > 52) k.r[2] = raiseSign * 52;
    }
    if (!la?.length) continue;
    for (const k of la) {
      const raise = raiseSign * sampleZ(ua, k.t);
      if (raise <= 30) continue;
      // lowerArm の X ひねりは前腕が後ろへ流れるコーン回転になるため除去
      k.r[0] = 0;
      // 前腕の世界角 (上腕の上げ + 肘の曲げ) を 88〜108 度 = ほぼ垂直に保つ
      // → 手が「顔の横」に来る、自然な手振りの形になる
      const bend = raiseSign * k.r[2];
      const lo = Math.max(20, 88 - raise);
      const hi = 108 - raise;
      k.r[2] = raiseSign * Math.min(hi, Math.max(lo, bend));
    }
    // 真の回内 (手のひらを正面に向ける) は手首ボーンの X ひねりで行う
    // (親チェーンの回転により、hand の X 軸は前腕の長軸 = ひねり軸になる)
    spec.tracks[`${side}Hand`] = la.map((k) => ({
      t: k.t,
      r: [raiseSign * sampleZ(ua, k.t) > 30 ? -85 : 0, 0, 0],
    }));
  }
}

// OpenAI互換プロバイダ対応: ベースURLを差し替え可能にする (OpenRouter / DeepSeek / Ollama 等)
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
let API_BASE = DEFAULT_API_BASE;
export function setApiBase(url) {
  const u = (url || '').trim().replace(/\/+$/, '');
  API_BASE = u || DEFAULT_API_BASE;
}

export async function callOpenAI(messages, apiKey, model, onDelta, { effort } = {}) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      ...((/^gpt-6-astra(?:-|$)|^gpt-5\.6-/.test(model) && effort) ? { reasoning_effort: effort } : {}),
      messages,
      ...(onDelta ? { stream: true } : {}),
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

  // ストリーミング受信: 受信文字数を進捗コールバックに流す
  if (onDelta && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data: /, '').trim();
        if (!data || data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta(content.length);
          }
        } catch { /* SSEコメント等は無視 */ }
      }
    }
    if (!content) throw new Error('OpenAI API から有効な応答が得られませんでした');
    return content;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI API から有効な応答が得られませんでした');
  return content;
}

// 進捗%の分母に使う「1回の応答のだいたいの文字数」を過去実績のEMAで学習する
const RESP_CHARS_KEY = 'llm-resp-chars-ema';
let nodeExpectedResponseChars = 6000;
function expectedResponseChars() {
  if (typeof localStorage === 'undefined') return nodeExpectedResponseChars;
  return Number(localStorage.getItem(RESP_CHARS_KEY)) || 6000;
}
function updateExpectedResponseChars(actual) {
  const prev = expectedResponseChars();
  const next = Math.round(prev * 0.6 + actual * 0.4);
  if (typeof localStorage === 'undefined') nodeExpectedResponseChars = next;
  else localStorage.setItem(RESP_CHARS_KEY, String(next));
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
  { refine, onProgress, onFraction, speed } = {}
) {
  refine ??= speed !== 'fast';
  const effort = { fast: 'low', balanced: 'medium', quality: 'high' }[speed];
  // 演出の味付けをランダムに混ぜて、同じ指示でも毎回違う振り付けを引き出す
  const flavor = randomFlavor();
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    `(今回の演出の味付け: ${flavor}。ただしユーザーの指示と矛盾する場合は指示を優先)` +
    (speed === 'fast' ? '\n速度優先。主役の関節に絞り、1ボーン最大8キー。必要な予備動作・本動作・余韻を保ち、コンパクトなJSONで返す。' : '');

  // 進捗%: 受信文字数 ÷ 過去実績の期待文字数。2パス構成なら 1パス目=0〜60%
  const expected = expectedResponseChars();
  const pass1End = refine ? 0.6 : 1.0;

  // 1パス目: 生成
  const draft = await callOpenAI(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    apiKey,
    model,
    onFraction && ((chars) => onFraction(Math.min(0.99, (chars / expected) * pass1End), 1)),
    { effort }
  );
  updateExpectedResponseChars(draft.length);
  let spec = JSON.parse(draft);
  validateSpec(spec);

  // 2パス目: 自己修正 (失敗しても1パス目の結果を使う)
  if (refine) {
    onProgress?.(t('gen.refine2nd'));
    try {
      const refined = await callOpenAI(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: JSON.stringify(spec) },
          { role: 'user', content: REFINE_INSTRUCTION },
        ],
        apiKey,
        model,
        onFraction && ((chars) => onFraction(Math.min(0.99, pass1End + (chars / expected) * (1 - pass1End)), 2)),
        { effort }
      );
      const refinedSpec = JSON.parse(refined);
      validateSpec(refinedSpec);
      spec = refinedSpec;
    } catch (e) {
      console.warn('自己修正パスに失敗したため1パス目の結果を使用します:', e);
    }
  }

  if (!spec.hips?.length) delete spec.hips;
  if (WAVE_RE.test(text)) applyWaveCorrection(spec);
  spec.flavor = flavor; // 表示用 (buildVRMA では無視される)
  return spec;
}

// ARDYモード用: GPTが「頭脳」として英訳・動作分割・時間配分を行う
// (モーション生成そのものは常にARDY。キーフレーム生成は混ぜない)
const ARDY_PLAN_PROMPT = `あなたはモーションディレクターです。ユーザーの指示を、
text-to-motionモデル (ARDY) に渡す英語の動作セグメント列に変換してください。
${EMOTION_ACTING_GUIDE}

ルール:
- 各セグメントは "A person ..." で始まる、具体的で簡潔な英文にする。
- 指定された左右・回数・順序・到達位置・禁止事項を必ず守り、動作を省略しない。
- 最優先は指示への忠実さ。自然さや滑らかさを理由に、振る回数・動作の大きさ・速さ・停止位置を変更しない。
  「怒ってジタバタする」「暴れる」「大はしゃぎ」等は感情ラベルではなく全身の主動作。
  looks angry や clenches fists だけに置き換えず、手足が実際に大きく動く具体的な動詞で伝える。
  激しい動作に gentle / subtle / calm / small / relaxed を一律に補わない。自然さは動作の強さを下げる意味ではない。
  例「怒ってジタバタする」: "A person throws an angry tantrum, repeatedly stamping their feet and flailing both arms with forceful, irregular movements."
  姿勢指定がある場合は必ず合わせる。床に寝てジタバタなら lying on the floor, kicking their legs and flailing their arms、
  椅子に座ってなら seated とし、立って足踏みへ置き換えない。足を動かさない指定なら腕・上体だけで表現する。
  単に「怒る」だけならジタバタを勝手に追加しない。「ジタバタしない」等の否定にも従う。
  「左腕は下ろしたまま」等の条件は関係する全セグメントに明記する。
  顔の横・胸の前等の目標は単なる「手を振る」に要約せず、対象の手と到達位置を英文に残す。
  回数指定は exactly N complete cycles とし、開始姿勢→往復→終了姿勢までを1回として記述する。
  返答前に元の指示を動作・左右・回数・順序・到達位置・固定する部位・終了姿勢に分け、
  すべてがセグメント列に含まれ、矛盾や余分な主動作がないことを照合する。
- セグメントは意味のある演技のまとまりで分ける。細かな動詞ごとに分断しない。
  手を上げる→3回振る→下ろす、は一続きの挨拶として1セグメントにまとめる。
  終了動作まで含む時間を確保し、途中で切らずに生成する。
  歩く→走る→ジャンプ→転ぶ、のように運動の種類が変わる場合は分ける (最大12個)。
- 停止の指示がなければ各仕草の間で直立・静止へ戻さない。主動作に合う予備動作、
  小さな重心移動、肘や手首の遅れ、動作後の余韻を指示と矛盾しない範囲だけ短い英文で補う。
  主動作に必要な自然な全身連動に限り、指定にない歩行・回転・ジャンプは追加しない。
  例: "A person smoothly raises their right hand beside their face, gives exactly three small waves with relaxed elbow and wrist follow-through, then gently lowers the hand."
  終了まで前の動作の姿勢・左右を保ち、唐突な姿勢リセットを指示しない。
  終了姿勢はユーザーの指示に従い、座る・しゃがむ・腕を上げて止める等を勝手に直立へ変えない。
- duration の合計は120秒以内
- 持続動作 (歩く・走る・踊る等) を5秒以上続けたい場合は、同じ英文を
  duration 4〜5秒のセグメントとして必要な回数繰り返す
  (モデルは1セグメント内で動作を完了すると止まる癖があるため)
  ただし回数指定のある動作を尺埋めのために繰り返さない。余った時間は指定された終了姿勢で保持する。
- ジャンプ・キック等の単発アクションは duration 3〜4秒とし、動作が明確に
  伝わる具体的な英文にする (例: "A person jumps up high with both feet
  leaving the ground." — 曖昧な "jumps" だけより確実に発火する)
- 小道具が必要な動作は体の動きだけで表現できる形に言い換える
  (例: ボールを蹴る → "A person kicks with the right leg.")
- expression: モーション全体の感情 happy / sad / angry / surprised / relaxed / neutral のどれか、
  読み取れなければ null
- 感情は expression だけで済ませず、該当する英文にも happy / sad / angry / surprised / relaxed / embarrassed 等を残す。
  喜びは胸が開く・軽い弾み、怒りは肩や腕の緊張と鋭い緩急、悲しみは肩が落ちる・顔が下がる・遅い動き、
  楽しさは軽やかな重心移動など、指示された動作の範囲で全身の演技に反映する。
  感情が途中で変わる場合は順序と変化を英文に明記する。感情だけを理由に区間を分割しない。
  ダンスや歩行などの動作名だけから勝手に喜びを付けない。表情が不明なら null。

測定計画 checks も返す。原文が明示する動作だけを対象にする。配列が空でもよい。
kind は travel (実際に歩く・走る等で移動)、jump (両足が離地)、crouch (腰を落とす)、raiseHand (手を顔付近以上へ上げる)。
segmentIndex はその動作を行う segments の0始まりの番号、side は left/right/both（手以外はboth）。
「足を動かさない」「ジャンプしない」等を肯定のチェックにしない。感情語や重心移動だけをtravelにしない。
これは粗い位置測定。回数やパンチの正確さ等、測れない条件を上記へ無理に変換せず checks に含めない。
JSON形式で返答:
{"checks":[{"kind":"travel","segmentIndex":0,"side":"both"},{"kind":"jump","segmentIndex":1,"side":"both"}],"segments": [
  {"text": "A person runs forward fast.", "duration": 4},
  {"text": "A person jumps up high with both feet leaving the ground.", "duration": 3}
], "expression": null}`;

// LLM監視: 分割結果に抜け・統合がないか検証して補正する
const ARDY_VERIFY_PROMPT = `あなたはモーション計画の検証者です。ユーザーの元の指示と、
生成済みのセグメント列を突き合わせ、次を厳密にチェックして修正版を返してください。
${EMOTION_ACTING_GUIDE}

チェック項目:
- ユーザーが指示した動作が1つも欠けていないか (欠けていれば "A person ..." の英文で追加)
- 動作の順序が指示どおりか (違えば並べ替える)
- 左右・回数・順序が指示どおりか
- ジタバタする・暴れる等の主動作が、怒った表情や静止ポーズだけに置き換わっていないか。動作の強さ・姿勢・否定条件も照合する。
- 一続きの仕草を細かく分断していないか。手を振って下ろす等のつながる動作は、終了まで同じセグメントでよい。
- 指定されていない主動作を追加していないか。自然な全身連動と余韻は残す。
持続動作 (歩く・走る等) の繰り返しセグメントはそのまま残してよい。最大12セグメント。

修正後の完全なセグメント列だけをJSONで返答:
{"segments": [{"text": "A person ...", "duration": 4}], "expression": null, "checks": []}
checks は修正後の区間番号で返す。kindはtravel/jump/crouch/raiseHandのみ。原文で肯定指定された測定可能な動作だけにする。`;

/**
 * GPTが「頭脳」としてエンジン振り分けとARDY用の生成計画 (英訳+動作分割) を作る。
 * @returns {Promise<{engine: 'ardy'|'keyframes', segments?: {text: string, duration: number}[], expression?: string|null}>}
 */
export async function planArdySegments(text, apiKey, model, { waypointCount = 0, pathMeters = 0, availableExpressions, request = callOpenAI, verify = true, effort = 'low' } = {}) {
  let userMsg = text;
  if (Array.isArray(availableExpressions)) {
    userMsg += `\nアバターで利用できる表情: ${JSON.stringify(availableExpressions)}。表情がない感情も身体の演技で伝える。未対応の表情が見える前提で演技を省略しない。`;
  }
  if (waypointCount > 0) {
    userMsg +=
      `\n\n(参考: ユーザーは3Dビューに経由地を${waypointCount}個置いており、` +
      `合計約${Math.round(pathMeters)}mの経路を通る移動になります。` +
      `移動しながら行う動作として計画し、合計durationは歩速1m/s換算で経路を回りきれる長さにしてください。` +
      `この場合 engine は "ardy" にしてください)`;
  }
  const content = await request(
    [
      { role: 'system', content: ARDY_PLAN_PROMPT },
      { role: 'user', content: userMsg },
    ],
    apiKey,
    model, undefined, { outputType: 'ardy', effort }
  );
  const plan = JSON.parse(content);
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) {
    throw new Error('GPTの動作分割結果が不正です');
  }
  const normalize = (segs) => {
    // Never silently drop actions or replace their timing with arbitrary defaults.
    if (!Array.isArray(segs) || !segs.length || segs.length > 12 || segs.some(s =>
      typeof s?.text !== 'string' || !s.text.trim() || !Number.isFinite(s.duration) || s.duration <= 0 || s.duration > 120
    ) || segs.reduce((sum,s) => sum + s.duration,0) > 120) {
      const error = new Error(t('動作計画に空の動作・不正な時間・対応上限の超過があります。指示を省略しないため生成を中止しました。'));
      error.code = 'ARDY_INVALID_PLAN';
      throw error;
    }
    return segs.map(s => ({text:s.text.trim(),duration:s.duration}));
  };
  plan.segments = normalize(plan.segments);
  plan.checks = normalizeMotionChecks(plan.checks,plan.segments.length);
  if (plan.segments.length === 0) {
    throw new Error('GPTの動作分割結果が不正です');
  }

  // LLM監視: 分割結果を再チェックし、抜け・統合を補正する (失敗時は1回目を採用)
  if (verify) try {
    const verifyContent = await request(
      [
        { role: 'system', content: ARDY_VERIFY_PROMPT },
        { role: 'user', content: `元の指示: ${text}\n\n現在のセグメント:\n${JSON.stringify(plan.segments)}` },
      ],
      apiKey,
      model, undefined, { outputType: 'ardy', effort }
    );
    const verified = JSON.parse(verifyContent);
    const vsegs = normalize(Array.isArray(verified.segments) ? verified.segments : []);
    if (vsegs.length) {
      plan.segments = vsegs; // Removing an unrequested action can also improve fidelity.
      plan.checks = normalizeMotionChecks(verified.checks,vsegs.length);
      if (['happy', 'sad', 'angry', 'surprised', 'relaxed', 'neutral'].includes(verified.expression)) {
        plan.expression = verified.expression;
      }
    }
  } catch (e) {
    console.warn('[ARDY] 計画の検証パスに失敗、1回目の分割を使用:', e.message);
  }
  if (!['happy', 'sad', 'angry', 'surprised', 'relaxed', 'neutral'].includes(plan.expression)) {
    plan.expression = null;
  }
  return plan;
}

/**
 * Electron の Codex CLI (ChatGPT/Codex サブスクリプション) でモーション spec を生成する。
 * 認証情報は preload の限定 IPC 内に留まり、レンダラーには渡されない。
 */
export async function generateMotionWithCodex(
  text,
  model,
  { refine = true, onProgress } = {}
) {
  if (!window.codexBridge) {
    throw new Error('Codex認証はデスクトップ版でのみ利用できます。');
  }

  const flavor = randomFlavor();
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    `(今回の演出の味付け: ${flavor}。ただしユーザーの指示と矛盾する場合は指示を優先)`;

  onProgress?.(
    refine
      ? t('gen.codexRefine', { model })
      : t('gen.codex', { model })
  );
  const spec = await window.codexBridge.generateMotion({
    model,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMsg,
    refinePrompt: REFINE_INSTRUCTION,
    refine,
  });

  validateSpec(spec);
  if (!spec.hips?.length) delete spec.hips;
  if (WAVE_RE.test(text)) applyWaveCorrection(spec);
  spec.flavor = flavor;
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

export function validateSpec(spec) {
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
    // 膝は蝶番関節: 逆関節 (X 負) と横曲げを防ぐ
    if (bone === 'leftLowerLeg' || bone === 'rightLowerLeg') {
      for (const k of spec.tracks[bone]) {
        k.r[0] = Math.max(-3, Math.min(140, k.r[0]));
        k.r[1] = Math.max(-15, Math.min(15, k.r[1]));
        k.r[2] = Math.max(-15, Math.min(15, k.r[2]));
      }
    }
    // 肘のガード: X ひねり (コーン回転) と後方への折れ (Y 逆方向 = 過伸展) を防ぐ
    if (bone === 'leftLowerArm' || bone === 'rightLowerArm') {
      const fwdSign = bone === 'rightLowerArm' ? 1 : -1; // 前方への曲げ: 右 Y 正 / 左 Y 負
      for (const k of spec.tracks[bone]) {
        k.r[0] = Math.max(-10, Math.min(10, k.r[0]));
        const y = fwdSign * k.r[1];
        k.r[1] = fwdSign * Math.max(-15, Math.min(135, y));
      }
    }
    if (spec.tracks[bone].length === 0) delete spec.tracks[bone];
  }
  if (Object.keys(spec.tracks).length === 0 && !spec.hips?.length) {
    throw new Error('生成されたモーションに有効なトラックがありません');
  }
  // 肘の過伸展ガード: 上腕を大きく回した向きと逆方向へ肘が大きく折れるのを防ぐ
  // (例: 腕を上げているのに肘が下向きに折れる)。逆方向は 15 度まで許容
  for (const side of ['left', 'right']) {
    const ua = spec.tracks[`${side}UpperArm`];
    const la = spec.tracks[`${side}LowerArm`];
    if (!ua?.length || !la?.length) continue;
    for (const k of la) {
      const uaZ = sampleZ(ua, k.t);
      if (Math.abs(uaZ) < 40) continue;
      const sign = Math.sign(uaZ);
      if (Math.sign(k.r[2]) === -sign && Math.abs(k.r[2]) > 15) {
        k.r[2] = -sign * 15;
      }
    }
  }

  // 前腕が頭に被さる構図の防止: 肘を深く曲げる腕は、上腕の上げを 58 度までに自動補正
  for (const side of ['left', 'right']) {
    const ua = spec.tracks[`${side}UpperArm`];
    const la = spec.tracks[`${side}LowerArm`];
    if (!ua?.length || !la?.length) continue;
    const raiseSign = side === 'left' ? 1 : -1;
    const maxBend = Math.max(
      ...la.map((k) => Math.max(Math.abs(k.r[1]), Math.abs(k.r[2])))
    );
    if (maxBend > 55) {
      for (const k of ua) {
        if (raiseSign * k.r[2] > 58) k.r[2] = raiseSign * 58;
      }
    }
  }
  if (Array.isArray(spec.hips)) {
    spec.hips = spec.hips.filter(
      (k) => typeof k?.t === 'number' && Array.isArray(k.p) && k.p.length === 3
    );
  }
  // 表情の検証: 未知の表情名を除去し、ウェイトを 0〜1 にクランプ
  if (spec.expressions && typeof spec.expressions === 'object') {
    for (const [name, keys] of Object.entries(spec.expressions)) {
      if (!EXPRESSION_PRESETS.includes(name) || !Array.isArray(keys)) {
        delete spec.expressions[name];
        continue;
      }
      spec.expressions[name] = keys
        .filter((k) => typeof k?.t === 'number' && typeof k?.w === 'number' && k.t <= MAX_DURATION)
        .map((k) => ({ t: k.t, w: Math.max(0, Math.min(1, k.w)) }));
      if (spec.expressions[name].length === 0) delete spec.expressions[name];
    }
    if (Object.keys(spec.expressions).length === 0) delete spec.expressions;
  } else {
    delete spec.expressions;
  }
}
