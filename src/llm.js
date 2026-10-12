import { t } from './i18n.js';
import { EMOTION_ACTING_GUIDE } from './emotionActing.js';
import { normalizeMotionChecks } from './motionCompliance.js';
import { formatMotionSemanticContext } from './jevMotionContext.js';
// llm.js — OpenAI API でテキストからモーション spec を生成する
import { BONE_NAMES, EXPRESSION_PRESETS } from './vrmaBuilder.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';

// Jev (TypeSafe AI) 等の意味・感情解析結果を、既存プロンプトへ「補助情報」として
// 追記するためのフォーマッタ。元テキストより優先度が低いことを明記し、
// 解析結果が指示そのものより強く作用しないようにする
export function formatMotionContextBlock(motionContext) {
  const supplement = formatMotionSemanticContext(motionContext);
  return supplement ? `\n\n${supplement}` : '';
}

export const SYSTEM_PROMPT = `あなたはVRMヒューマノイドキャラクターのモーションデザイナーです。
ユーザーのテキストから、キーフレームアニメーションのJSONを生成してください。
出力はJSONオブジェクトのみ。説明文やコードブロックは不要です。
${EMOTION_ACTING_GUIDE}

# 意図と演技設計
- 入力をその都度読み取り、指定された動作・姿勢・左右・回数・順序・強度・移動範囲・禁止事項を保つ。
- 短い指示でも、必要な身体の動きと時間変化を自分で設計する。動作名を固定の振り付けに置き換えない。
- 主動作を成立させる関節の連動、重心、接地、接触、緩急を考える。指定されていない主動作や演出を追加しない。
- 開始・終了姿勢は指示に合わせる。姿勢が未指定なら主動作に合う姿勢を選び、一律の立ち姿勢や静止を挿入しない。
- 持続する動作は指定された時間まで保つ。回数が指定された動作を尺埋めで繰り返さない。

# 座標規約 (VRM 1.0 / T-pose レスト)
- モデルは +Z 向き。+X はモデルの左側、+Y は上。
- 回転はレストポーズからのオイラー角 [X, Y, Z]。単位は度、回転順は XYZ。
- 上腕のレスト方向は水平。上腕 Z の負方向は左腕で下向き・右腕で上向き、正方向はその逆。
- 上腕の前方向への回転は左 Y 負・右 Y 正。肘は Y/Z を主軸にし、X のひねりを使わない。
- spine/chest/neck/head の X 正方向は前屈、head の Y 正方向はモデルの左向き。
- upperLeg は X 負方向で前方、正方向で後方、Z は横方向。lowerLeg の屈曲は X 正方向。
- foot は X 正方向で底屈、負方向で背屈。全身の向きは hips の回転で表す。
- hips の位置はレスト位置からのオフセット [dx, dy, dz]。単位はメートル。
- 地面に接触している部位と関節の屈曲に応じて hips を調整し、接地部位を浮かせたり滑らせたりしない。

# 使用可能なボーン
${BONE_NAMES.join(', ')}

# 出力構造
ルートは name, duration, loop, tracks, hips, expressions を持つオブジェクト。
- name: 動作を表す英数字の文字列。
- duration: 1.5〜15 秒の数値。原文の時間・回数・速度と動作の完了に必要な時間から決める。
- loop: ループするかを表す真偽値。原文の意図から決める。
- tracks: ボーン名をキー、キーフレーム配列を値とするオブジェクト。
  各キーは t (秒) と r (X/Y/Z の回転角3数値) を持つ。
- hips: 位置キーフレームの配列。各キーは t (秒) と p (X/Y/Z のオフセット3数値) を持つ。不要なら空配列。
- expressions: 表情名をキー、キーフレーム配列を値とするオブジェクト。
  各キーは t (秒) と w (0〜1 のウェイト) を持つ。感情が読み取れなければ勝手に追加しない。

# キーと関節の制約
- 使用するトラックは t=0 と t=duration のキーを含め、時刻順に並べる。
- 回転は球面補間、位置と表情は線形補間される。動作に必要な転換点へキーを配置し、1ボーン40キー以内に収める。
- キーの間隔は速度・加減速・接触に合わせる。身体の各部を一律の周期で動かさない。
- leftHand/rightHand の基本姿勢と leftShoulder/rightShoulder の追従はアプリ側で処理する。
- upperArm は各軸 ±75 度以内。neck は ±45、head は ±70、spine/chest/upperChest は ±45、foot は ±60 度以内。
- 首と頭の連動、関節の可動域、身体同士の交差を確認する。肘の過伸展や膝の逆関節を作らない。
- lowerLeg の X は 0〜130 度、Y/Z はほぼ使わない。
- 基本表情は happy / angry / sad / relaxed / surprised / neutral。補助は blink / aa。
- 表情ウェイトは 0〜1。利用可能な表情だけを使い、指示の強さと時間変化に合わせる。
- 原文の動作を省略せず、身体と表情を同じ時間軸で設計する。`;

// 2パス目: 生成結果を検証・修正させるプロンプト
export const REFINE_INSTRUCTION = `以下は上記の指示で生成されたモーションJSONです。アニメーターとしてレビューし、
問題があれば修正した完全なJSONのみを返してください (問題がなければそのまま返す)。

チェック観点:
1. 意図: 指定された動作・姿勢・左右・回数・順序・強度・移動範囲・禁止事項がすべて保たれているか。
2. 軌道: 各関節が座標規約と可動域を守り、身体同士の交差・過伸展・逆関節がないか。
3. 自然さ: 重心・接地・接触・関節の連動・加減速が、指示された身体動作として成立しているか。
4. 完全性: 使用するトラックに t=0 と t=duration のキーがあり、指示された終了まで動作を完了できるか。
5. 忠実さ: 未指定の主動作・姿勢リセット・繰り返し・固定の演出を加えていないか。元の指示を一律の動きへ置き換えない。
6. 表情: 利用可能な表情で、原文の感情・強さ・時間変化を保っているか。`;

// Claude API (Anthropic) 対応: ブラウザから直接呼び出す (OpenAIキーと同様、localStorageにのみ保存)
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
// 対応するのは最新世代のみ。旧世代 (claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 等) は
// 設定・環境変数・ローカルHTTP APIのどこから指定されても呼び出さない
export const CLAUDE_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const CLAUDE_API_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_VERSION = '2023-06-01';
// 対応モデルはすべて既定でadaptive thinkingが有効
const THINKING_MODELS = CLAUDE_MODELS;
// claude-opus-5-5 は effort の既定が 'medium'。
// 従来と同等の精度を保つため明示的に 'high' を指定する
// (claude-haiku-5-5 も既定 'medium' だが、低コスト枠なので既定のままにする)
const HIGH_EFFORT_MODELS = ['claude-opus-5-5'];
// 安全性分類器で拒否された場合に、サーバー側で推奨モデルへ自動で再実行させる
// (claude-haiku-5-5 はサーバー側フォールバック非対応のため含めない)
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// ストリーミング時はHTTPタイムアウトの心配がないので、思考+長いJSONの余裕を大きく取る。
// 非ストリーミングはSDK既定のタイムアウト内に収めるため従来の枠を維持する
const CLAUDE_MAX_TOKENS_STREAM = 64000;
const CLAUDE_MAX_TOKENS = 16000;

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
  if (!CLAUDE_MODELS.includes(model)) {
    throw new Error(`Claudeモデル ${model} は利用できません。${CLAUDE_MODELS.join(' / ')} から選んでください`);
  }
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
      ...(FALLBACK_MODELS.includes(model) ? { 'anthropic-beta': FALLBACK_BETA } : {}),
    },
    body: JSON.stringify({
      model,
      // haiku-4-5 以外は既定でadaptive thinkingが有効で、
      // 思考トークンも max_tokens の枠を消費する。長い複合モーションのJSONが
      // 途中で打ち切られないよう、思考+応答の余裕を持たせて大きめに確保する
      max_tokens: onDelta ? CLAUDE_MAX_TOKENS_STREAM : CLAUDE_MAX_TOKENS,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: claudeMessages,
      // display を明示的に 'summarized' にしないと、thinking の既定 display は
      // 'omitted' で thinking 中は text_delta が一切来ず、進捗バーが 0% のまま
      // 長時間止まって見える。thinking_delta の文字数も進捗計算に使う (下記)
      ...(THINKING_MODELS.includes(model)
        ? { thinking: { type: 'adaptive', display: 'summarized' } }
        : {}),
      ...(HIGH_EFFORT_MODELS.includes(model) ? { output_config: { effort: 'high' } } : {}),
      // 途中で拒否→フォールバックした場合も、ストリームは打ち切られず
      // フォールバック先モデルが続きを生成するので、受信処理は変更不要
      ...(FALLBACK_MODELS.includes(model) ? { fallbacks: 'default' } : {}),
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
 * @param {string} model 使用するモデル ID (例: 'claude-opus-5-5')
 * @param {object} [options]
 * @param {boolean} [options.refine=true] 2パス目で自己修正を行う
 * @param {(msg: string) => void} [options.onProgress] 進捗表示コールバック
 * @returns {Promise<object>} モーション spec
 */
export async function generateMotionWithClaude(
  text,
  apiKey,
  model = DEFAULT_CLAUDE_MODEL,
  { refine = true, onProgress, onFraction, motionContext } = {}
) {
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    formatMotionContextBlock(motionContext);

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

// OpenAI互換プロバイダ対応: ベースURLを差し替え可能にする (OpenRouter / DeepSeek / Ollama 等)
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
let API_BASE = DEFAULT_API_BASE;
export function setApiBase(url) {
  const u = (url || '').trim().replace(/\/+$/, '');
  API_BASE = u || DEFAULT_API_BASE;
}

export async function callOpenAI(messages, apiKey, model, onDelta, { effort, signal } = {}) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      ...((/^gpt-6(?:\.\d+)?-|^gpt-5\.6-/.test(model) && effort) ? { reasoning_effort: effort } : {}),
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
 * @param {string} model 使用するモデル ID (例: 'gpt-6.1-sol')
 * @param {object} [options]
 * @param {boolean} [options.refine=true] 2パス目で自己修正を行う
 * @param {(msg: string) => void} [options.onProgress] 進捗表示コールバック
 * @returns {Promise<object>} モーション spec
 */
export async function generateMotionWithOpenAI(
  text,
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  { refine, onProgress, onFraction, speed, motionContext } = {}
) {
  refine ??= speed !== 'fast';
  const effort = { fast: 'low', balanced: 'medium', quality: 'high' }[speed];
  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    (speed === 'fast' ? '\n速度優先。主役の関節に絞り、1ボーン最大8キー。必要な予備動作・本動作・余韻を保ち、コンパクトなJSONで返す。' : '') +
    formatMotionContextBlock(motionContext);

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
  return spec;
}

// ARDYモード用: GPTが「頭脳」として英訳・動作分割・時間配分を行う
// (モーション生成そのものは常にARDY。キーフレーム生成は混ぜない)
const ARDY_PLAN_PROMPT = `あなたはモーションディレクターです。ユーザーの指示を、
text-to-motionモデル (ARDY) に渡す英語の動作セグメント列に変換してください。
${EMOTION_ACTING_GUIDE}

ルール:
- 各セグメントは人物を主語とする、身体動作が伝わる具体的で簡潔な英文にする。
- 短い入力もその都度解釈し、主動作を成立させる部位・軌道・接触・時間変化を必要な範囲だけ補う。
- 指定された姿勢・左右・回数・順序・到達位置・固定する部位・強度・禁止事項をすべて保つ。
- 自然さや滑らかさを理由に、原文の動作の大きさ・速さ・停止位置を変更しない。
- 感情を伴う身体動作を、表情や静止姿勢だけに置き換えない。感情だけから未指定の主動作を追加しない。
- 部位や姿勢を固定する条件は、その条件が有効なすべてのセグメントに残す。
- 回数指定は完了する周期の正確な数として記述し、途中で切らず終了までの時間を確保する。
- 一続きの動作を細かな動詞ごとに分断しない。運動の種類や条件が明確に変わる境界だけで分割し、最大12セグメントにする。
- 開始・終了姿勢はユーザーの指示に従う。区切りごとに未指定の静止・直立・姿勢リセットを入れない。
- 連続動作は指定された時間まで持続させる。有限の回数を指定された動作を尺埋めで繰り返さない。
- duration は各セグメントの秒数。正の数値で合計120秒以内とし、指示の時間・回数・速度から決める。
- 小道具との関係は、身体の位置・向き・軌道・接触として記述する。必要な身体動作や対象との関係を省略しない。
- 感情は指示にある場合だけ身体の演技と英文へ反映し、途中で変わる場合は順序を保つ。感情だけを理由に区間を分割しない。
- 返答前に元の指示とセグメント列を照合し、抜け・矛盾・余分な主動作がないことを確認する。

出力構造:
- ルートは segments, expression, checks を持つJSONオブジェクト。説明文やコードブロックは不要。
- segments は1〜12要素の配列。各要素は text (英文の動作記述) と duration (秒数) を持つ。
- expression は原文から読み取れる全体の感情 happy / sad / angry / surprised / relaxed / neutral のいずれか。不明なら null。
- checks は測定可能な条件の配列。各要素は kind, segmentIndex, side を持つ。対象がなければ空配列。
- kind の対応範囲は travel (水平方向の移動)、jump (両足の離地)、crouch (腰の下降)、raiseHand (手の挙上)。
  これは検証器の分類であり、生成できる動作を限定するものではない。
- segmentIndex は条件が属する segments の0始まりの整数。side は left/right/both。手以外は both。
- checks は原文で肯定指定された測定可能な条件だけにする。否定・感情・測れない条件を無理に分類へ当てはめない。`;

// LLM監視: 分割結果に抜け・統合がないか検証して補正する
const ARDY_VERIFY_PROMPT = `あなたはモーション計画の検証者です。ユーザーの元の指示と、
生成済みのセグメント列を突き合わせ、次を厳密にチェックして修正版を返してください。
${EMOTION_ACTING_GUIDE}

チェック項目:
- 指示されたすべての身体動作と条件を保持しているか。不足があれば具体的な英文で補う。
- 姿勢・左右・回数・順序・強度・到達位置・固定する部位・終了姿勢・否定条件が指示どおりか。
- 身体の主動作を感情ラベルや静止姿勢だけに置き換えていないか。
- 一続きの動作を不要に分断していないか。指定された持続時間や終了までの時間を確保しているか。
- 指定されていない主動作・繰り返し・姿勢リセットを追加していないか。
- 主動作に必要な自然な全身連動と緩急を保っているか。

修正後の計画をJSONオブジェクトで返す。説明文やコードブロックは不要。
- segments は1〜12要素。各要素は text (英文の動作記述) と duration (正の秒数) を持ち、合計120秒以内。
- expression は happy / sad / angry / surprised / relaxed / neutral のいずれか、不明なら null。
- checks は修正後の区間番号を使う配列。各要素は kind, segmentIndex, side を持つ。
  kind は travel/jump/crouch/raiseHand、segmentIndex は0始まりの整数、side は left/right/both。
  これらは検証器の対応範囲だけを表す。生成動作を制限しない。原文で肯定指定された測定可能な条件だけを含める。`;

/**
 * GPTが「頭脳」としてエンジン振り分けとARDY用の生成計画 (英訳+動作分割) を作る。
 * @returns {Promise<{engine: 'ardy'|'keyframes', segments?: {text: string, duration: number}[], expression?: string|null}>}
 */
export async function planArdySegments(text, apiKey, model, { waypointCount = 0, pathMeters = 0, availableExpressions, request = callOpenAI, verify = true, effort = 'low', motionContext } = {}) {
  let userMsg = text + formatMotionContextBlock(motionContext);
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
  { refine = true, onProgress, motionContext } = {}
) {
  if (!window.codexBridge) {
    throw new Error('Codex認証はデスクトップ版でのみ利用できます。');
  }

  const userMsg =
    `次の動きのモーションを作成: ${text}\n` +
    formatMotionContextBlock(motionContext);

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
  return spec;
}

const MAX_DURATION = 20; // 秒

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
