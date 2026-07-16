// main.js — UI と各モジュールの結線
import { Viewer } from './viewer.js';
import { buildVRMA } from './vrmaBuilder.js';
import { idleSpec } from './idleMotion.js';
import { autoExpressions } from './autoExpressions.js';
import {
  generateMotionWithOpenAI,
  generateMotionWithCodex,
  planArdySegments,
  DEFAULT_OPENAI_MODEL,
} from './llm.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const textInput = $('textInput');
const generateBtn = $('generateBtn');
const exportBtn = $('exportBtn');
const exprCheck = $('exprCheck');
const apiKeyInput = $('apiKey');
const authModeSelect = $('authMode');
const apiSettings = $('apiSettings');
const codexSettings = $('codexSettings');
const apiModelSelect = $('apiModelSelect');
const codexModelSelect = $('codexModelSelect');
const codexAuthState = $('codexAuthState');
const codexLoginBtn = $('codexLoginBtn');
const codexLogoutBtn = $('codexLogoutBtn');
const refineCheck = $('refineCheck');
const ardySettings = $('ardySettings');
const ardyState = $('ardyState');
const ardyUrlInput = $('ardyUrl');
const ardyStartBtn = $('ardyStartBtn');
const genProgress = $('genProgress');
const genProgressBar = $('genProgressBar');
const genProgressText = $('genProgressText');
const waypointCheck = $('waypointCheck');
const waypointClearBtn = $('waypointClearBtn');
const waypointGuide = $('waypointGuide');
const loopSelect = $('loopSelect');

// その場の動き (移動が少なく、終了時に開始位置付近へ戻る) ならループ向きと判定する
function isLoopFriendly(spec) {
  const hips = spec.hips;
  if (!hips?.length) return true;
  const first = hips[0].p;
  const last = hips.at(-1).p;
  const endOffset = Math.hypot(last[0] - first[0], last[2] - first[2]);
  const maxOffset = Math.max(
    ...hips.map((k) => Math.hypot(k.p[0] - first[0], k.p[2] - first[2]))
  );
  return endOffset < 0.35 && maxOffset < 1.5;
}

// ARDYモードの経由地 (床クリックで配置、生成リクエストに同送)
// 個数は無制限。ただし経路の所要時間 (歩速1m/s換算+2秒) が60秒に収まる範囲まで
const waypoints = [];
const MAX_MOTION_SECONDS = 60;

function waypointPathSeconds(points) {
  let dist = 0;
  let prev = { x: 0, z: 0 };
  for (const p of points) {
    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return dist / 1.0 + 2;
}

function updateWaypointUI() {
  viewer.setWaypointMarkers(waypoints);
  waypointClearBtn.classList.toggle('hidden', waypoints.length === 0);
  waypointClearBtn.textContent = `経由地をクリア (${waypoints.length}個)`;
}
const vrmBtn = $('vrmBtn');
const vrmFile = $('vrmFile');
const vrmName = $('vrmName');
const viewerWrap = $('viewerWrap');
const historyEl = $('history');

let lastVRMA = null; // { spec, name }
const history = []; // [{ name, spec, buffer, loop, duration, text }]
const MAX_HISTORY = 20;
const codexBridge = window.codexBridge;
let codexStatus = null;

function setCodexAuthState(message, kind = '') {
  codexAuthState.textContent = message;
  codexAuthState.className = `auth-state${kind ? ` ${kind}` : ''}`;
}

// スクリーンショットや配信への写り込み対策としてメールアドレスをマスクする
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

function renderAuthMode() {
  const mode = authModeSelect.value;
  const codexMode = mode === 'codex' && Boolean(codexBridge);
  const ardyMode = mode === 'ardy';
  apiSettings.classList.toggle('hidden', codexMode || ardyMode);
  codexSettings.classList.toggle('hidden', !codexMode);
  ardySettings.classList.toggle('hidden', !ardyMode);
  refineCheck.parentElement.classList.toggle('hidden', ardyMode); // 自己修正はLLMモード専用
  if (ardyMode) checkArdyHealth();
}

// --- ARDYローカルエンジン ---
function setArdyState(message, kind = '') {
  ardyState.textContent = message;
  ardyState.className = `auth-state${kind ? ` ${kind}` : ''}`;
}

async function checkArdyHealth() {
  const url = ardyUrlInput.value.trim().replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    if (info.status !== 'ok') throw new Error('unexpected response');
    const ja = info.translator === 'ready' ? ' / 日本語OK' : '';
    setArdyState(`✅ ${info.model} (${info.device === 'cpu' ? 'CPU' : 'GPU'}${ja}) 接続OK`, 'ok');
    ardyStartBtn.classList.add('hidden');
    return true;
  } catch {
    const hint = window.ardyBridge
      ? '「エンジンを起動」を押してください。'
      : 'tools/ardy-engine/server.py を起動してください。';
    setArdyState(`❌ エンジン未起動。${hint}`, 'err');
    ardyStartBtn.classList.toggle('hidden', !window.ardyBridge);
    return false;
  }
}

// LLM (OpenAI) 生成の進捗バー: ストリーミング受信文字数ベースの%表示
function startLLMProgressBar() {
  genProgressBar.style.width = '0%';
  genProgressText.textContent = 'GPTがモーションを設計中...';
  genProgress.classList.remove('hidden');
  return {
    update(fraction, pass) {
      genProgressBar.style.width = `${Math.round(fraction * 100)}%`;
      genProgressText.textContent =
        `GPTがモーションを${pass === 2 ? '自己修正' : '設計'}中... ${Math.round(fraction * 100)}%`;
    },
    done() {
      genProgressBar.style.width = '100%';
      setTimeout(() => genProgress.classList.add('hidden'), 400);
    },
  };
}

// 生成中の進捗バー: エンジンの /progress をポーリングして残り時間を表示する
function startArdyProgressBar(url) {
  genProgressBar.style.width = '0%';
  genProgressText.textContent = 'エンジンに接続中...';
  genProgress.classList.remove('hidden');
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${url}/progress`, { signal: AbortSignal.timeout(1500) });
      const p = await res.json();
      if (!p.active) return;
      if (p.stage === 'translate') {
        genProgressBar.style.width = '3%';
        genProgressText.textContent = '準備中 (翻訳・テキスト解析)...';
      } else if (p.stage === 'finalize') {
        genProgressBar.style.width = '100%';
        genProgressText.textContent = '仕上げ処理中 (足滑り補正・変換)...';
      } else {
        genProgressBar.style.width = `${Math.round(p.fraction * 100)}%`;
        const eta = p.remaining != null ? ` (あと約${Math.max(1, Math.ceil(p.remaining))}秒)` : '';
        genProgressText.textContent = `モーション生成中... ${Math.round(p.fraction * 100)}%${eta}`;
      }
    } catch {
      // 一時的な取得失敗は無視して次のポーリングへ
    }
  }, 500);
  return () => {
    clearInterval(timer);
    genProgressBar.style.width = '100%';
    setTimeout(() => genProgress.classList.add('hidden'), 400);
  };
}

async function generateMotionWithArdy(text, { onProgress } = {}) {
  const url = ardyUrlInput.value.trim().replace(/\/$/, '');

  // GPT (頭) がエンジン振り分けと生成計画を担当し、ARDY (体) が動きを作る。
  // キーがない・失敗した場合はエンジン内蔵のローカル翻訳にフォールバック
  let plan = null;
  const apiKey = (apiKeyInput.value || localStorage.getItem('openai-api-key') || '').trim();
  const gptModel = localStorage.getItem('openai-model') || DEFAULT_OPENAI_MODEL;
  if (apiKey) {
    try {
      onProgress?.('GPTが依頼を分析中 (エンジン選択・英訳・動作分割)...');
      plan = await planArdySegments(text, apiKey, gptModel, {
        waypointCount: waypoints.length,
        pathMeters: waypoints.length ? waypointPathSeconds(waypoints) - 2 : 0,
      });
      console.log('[ARDY] GPT plan:', plan);
    } catch (e) {
      console.warn('[ARDY] GPT計画に失敗、ローカル翻訳にフォールバック:', e);
    }
  }

  // GPTが「精密ポーズ向き」と判断した依頼はキーフレーム方式に自動で切り替える
  // (ただし経由地が置かれている場合は移動が主目的なのでARDYを維持)
  if (plan?.engine === 'keyframes' && waypoints.length > 0) plan.engine = 'ardy';
  if (plan?.engine === 'keyframes') {
    onProgress?.('この依頼は精密ポーズ向きと判断 → GPTキーフレーム方式で生成中...');
    const progress = startLLMProgressBar();
    try {
      const spec = await generateMotionWithOpenAI(text, apiKey, gptModel, {
        refine: refineCheck.checked,
        onProgress,
        onFraction: progress.update,
      });
      spec.routedEngine = 'keyframes';
      return spec;
    } finally {
      progress.done();
    }
  }

  onProgress?.('ARDYがモーションを生成中... (長さは内容から自動判断)');
  const stopProgress = startArdyProgressBar(url);
  const body = plan?.segments?.length ? { segments: plan.segments } : { text };
  if (waypoints.length) body.waypoints = waypoints.map((w) => ({ x: w.x, z: w.z }));
  let res;
  try {
    res = await fetch(`${url}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    stopProgress();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `ARDYエンジンがエラーを返しました (HTTP ${res.status})`);
  }
  const spec = await res.json();
  if (plan) spec.originalText = text;
  // 自動判定時のループ既定値 (共通のon/off上書きは生成ハンドラ側で行う)
  spec.loop = isLoopFriendly(spec);
  // ARDYは表情を生成しないので自動付与する (GPTの感情判定があれば優先、
  // なければ原文の感情語からのキーワードマッチ)
  spec.expressions = autoExpressions(spec.originalText ?? text, spec.duration, plan?.expression);
  return spec;
}

// Electron デスクトップ版ではエンジンをアプリから起動できる
async function startArdyEngine() {
  if (!window.ardyBridge) return;
  try {
    const status = await window.ardyBridge.start();
    if (!status.running) throw new Error(status.lastError || 'エンジンを起動できませんでした。');
    setArdyState('⏳ エンジン起動中... (初回は1〜2分かかります)');
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await checkArdyHealth()) return;
      const s = await window.ardyBridge.getStatus();
      if (!s.running) {
        setArdyState(`❌ ${s.lastError || 'エンジンが終了しました。'}`, 'err');
        return;
      }
    }
    setArdyState('❌ エンジンの起動がタイムアウトしました。', 'err');
  } catch (e) {
    setArdyState(`❌ ${e.message}`, 'err');
  }
}

async function loadCodexModels() {
  const models = await codexBridge.listModels();
  codexModelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.model;
    option.textContent = `${model.displayName}${model.isDefault ? ' (推奨)' : ''}`;
    option.title = model.description;
    codexModelSelect.appendChild(option);
  }
  const saved = localStorage.getItem('codex-model');
  const savedOption = [...codexModelSelect.options].find((option) => option.value === saved);
  const defaultModel = models.find((model) => model.isDefault)?.model;
  codexModelSelect.value = savedOption?.value || defaultModel || models[0]?.model || '';
  codexModelSelect.disabled = models.length === 0;
}

async function refreshCodexStatus(providedStatus) {
  if (!codexBridge) return;
  try {
    codexStatus = providedStatus || await codexBridge.getStatus();
    const account = codexStatus.account;
    if (!codexStatus.available) {
      setCodexAuthState(codexStatus.error || 'Codex CLIを利用できません。', 'err');
    } else if (account?.type === 'chatgpt') {
      const identity = maskEmail(account.email) || 'ChatGPTアカウント';
      setCodexAuthState(
        `ログイン済み: ${identity}\nプラン: ${account.planType} / CLI: ${codexStatus.version}`,
        'ok'
      );
      await loadCodexModels();
    } else {
      setCodexAuthState(`未ログイン / Codex CLI ${codexStatus.version}`);
      codexModelSelect.disabled = true;
    }
    codexLoginBtn.disabled = !codexStatus.available || account?.type === 'chatgpt';
    codexLogoutBtn.disabled = account?.type !== 'chatgpt';
  } catch (error) {
    codexStatus = { available: false, account: null };
    setCodexAuthState(error.message, 'err');
    codexLoginBtn.disabled = true;
    codexLogoutBtn.disabled = true;
  }
}

async function initializeAuth() {
  const savedMode = localStorage.getItem('openai-auth-mode');
  if (!codexBridge) {
    authModeSelect.querySelector('option[value="codex"]')?.remove();
    authModeSelect.value = savedMode === 'ardy' ? 'ardy' : 'api-key';
    renderAuthMode();
    return;
  }
  authModeSelect.value = ['codex', 'ardy'].includes(savedMode) ? savedMode : 'api-key';
  renderAuthMode();
  await refreshCodexStatus();
}

// エクスポート用 VRMA を生成する (表情の有無はチェックボックスで選択)
function buildExportVRMA(spec) {
  localStorage.setItem('export-expressions', exprCheck.checked ? '1' : '0');
  if (exprCheck.checked) return buildVRMA(spec);
  const { expressions, ...motionOnly } = spec;
  return buildVRMA(motionOnly);
}

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// --- ビューア初期化 ---
const viewer = new Viewer($('canvas'));
window.__viewer = viewer; // デバッグ・検証用
// 起動時の読み込み優先順: VRoidサンプル VRM1.0 → VRM0.0
const DEFAULT_MODEL_URLS = [
  '/models/AvatarSample_VRM1.0.vrm',
  '/models/AvatarSample_VRM0.0.vrm',
];

async function init() {
  setStatus('VRMモデルを読み込み中...');
  for (const url of DEFAULT_MODEL_URLS) {
    try {
      await viewer.loadVRM(url);
      const name = url.split('/').pop();
      vrmName.textContent = `${name} — 3Dビューへのドラッグ&ドロップでも差し替えできます。`;
      setStatus('準備完了。テキストを入力して「モーション生成」を押してください。', 'ok');
      await playSpec(idleSpec(), { silent: true });
      return;
    } catch { /* 次の候補へ */ }
  }
  vrmName.textContent = 'モデル未読込 — VRMファイルを開いてください。';
  setStatus(
    '「VRMファイルを開く」から手持ちの .vrm を読み込んでください。\n' +
    '(VRMモデルは VRoid Hub の AvatarSample などから無料で入手できます)',
    'err'
  );
}

// --- モーション再生共通処理 (プレビューは表情込み) ---
async function playSpec(spec, { silent = false, seek = 0 } = {}) {
  const buffer = buildVRMA(spec);
  await viewer.playVRMA(buffer, spec.loop ?? true, seek);
  lastVRMA = { spec, name: spec.name || 'motion' };
  exportBtn.disabled = false;
  if (!silent) {
    setStatus(
      `再生中: ${spec.name}\n長さ: ${spec.duration.toFixed(1)}秒 / ループ: ${spec.loop ? 'あり' : 'なし'}\n` +
      `「.vrma 保存」でファイルに書き出せます。`,
      'ok'
    );
  }
  return buffer;
}

// --- 生成履歴 ---
function downloadVRMA(item) {
  const buffer = buildExportVRMA(item.spec);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${item.name}.vrma`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function playHistoryItem(item) {
  try {
    await viewer.playVRMA(item.buffer.slice(0), item.loop);
    lastVRMA = { spec: item.spec, name: item.name };
    exportBtn.disabled = false;
    setStatus(`再生中: ${item.name} (履歴)\n「${item.text}」`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`エラー: ${e.message}`, 'err');
  }
}

function renderHistory() {
  historyEl.innerHTML = '';
  if (history.length === 0) {
    historyEl.innerHTML = '<p class="sub">まだ生成したモーションはありません。</p>';
    return;
  }
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'hist-item';

    const play = document.createElement('button');
    play.className = 'play';
    play.textContent = '▶';
    play.title = '再生';
    play.addEventListener('click', () => playHistoryItem(item));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.text || item.name;
    name.title = `${item.name} — ${item.text}`;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${item.duration.toFixed(1)}s`;

    const save = document.createElement('button');
    save.textContent = '⬇';
    save.title = '.vrma 保存';
    save.addEventListener('click', () => downloadVRMA(item));

    const copy = document.createElement('button');
    copy.textContent = '📋';
    copy.title = 'モーションJSONをコピー (不具合報告・調整用)';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(item.spec, null, 1));
      setStatus('モーションJSONをクリップボードにコピーしました。', 'ok');
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '履歴から削除';
    del.addEventListener('click', () => {
      const idx = history.indexOf(item);
      if (idx !== -1) history.splice(idx, 1);
      renderHistory();
    });

    row.append(play, name, meta, save, copy, del);
    historyEl.appendChild(row);
  }
}

function addHistory(spec, buffer, text) {
  history.unshift({
    name: spec.name || 'motion',
    spec,
    buffer, // プレビュー再生用 (表情込み)
    loop: spec.loop ?? true,
    duration: spec.duration,
    text,
  });
  if (history.length > MAX_HISTORY) history.pop();
  renderHistory();
}

// --- 生成ボタン ---
generateBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('テキストを入力してください。', 'err');
    return;
  }
  const authMode = authModeSelect.value;
  const apiKey = apiKeyInput.value.trim();
  if (authMode === 'api-key' && !apiKey) {
    setStatus('OpenAI APIキーを入力してください。', 'err');
    return;
  }
  if (authMode === 'codex' && codexStatus?.account?.type !== 'chatgpt') {
    setStatus('先に「ChatGPTでログイン」からCodexを認証してください。', 'err');
    return;
  }
  if (authMode === 'ardy' && !(await checkArdyHealth())) {
    setStatus('ARDYエンジンに接続できません。ardy_server.py を起動してください。', 'err');
    return;
  }
  if (!viewer.vrm) {
    setStatus('先にVRMモデルを読み込んでください。', 'err');
    return;
  }
  generateBtn.disabled = true;
  waypointClearBtn.disabled = true;
  try {
    localStorage.setItem('openai-auth-mode', authMode);
    const options = {
      refine: refineCheck.checked,
      onProgress: (msg) => setStatus(msg),
    };
    let spec;
    if (authMode === 'ardy') {
      setStatus('ARDYローカルエンジンがモーションを生成中...');
      spec = await generateMotionWithArdy(text, options);
    } else {
      const model = authMode === 'codex' ? codexModelSelect.value : apiModelSelect.value;
      if (!model) throw new Error('利用可能なモデルがありません。');
      if (authMode === 'api-key') {
        localStorage.setItem('openai-api-key', apiKey);
        localStorage.setItem('openai-model', model);
      } else {
        localStorage.setItem('codex-model', model);
      }
      localStorage.setItem('refine-enabled', refineCheck.checked ? '1' : '0');
      setStatus(`${authMode === 'codex' ? 'Codex' : 'OpenAI'} (${model}) がモーションを生成中...`);
      if (authMode === 'codex') {
        spec = await generateMotionWithCodex(text, model, options);
      } else {
        const progress = startLLMProgressBar();
        try {
          spec = await generateMotionWithOpenAI(text, apiKey, model, {
            ...options,
            onFraction: progress.update,
          });
        } finally {
          progress.done();
        }
      }
    }
    // ループ再生: ユーザー指定 (常に/1回) は全エンジン共通で上書き。
    // 「自動」はエンジンの判断 (LLM: spec.loop / ARDY: 動きから判定) をそのまま使う
    const loopPref = loopSelect.value;
    if (loopPref !== 'auto') spec.loop = loopPref === 'on';
    window.__lastSpec = spec; // 診断用
    console.log('[Text-To-VRMA] generated spec:', spec);
    const buffer = await playSpec(spec);
    addHistory(spec, buffer, text);
    if (spec.flavor) {
      setStatus(
        `再生中: ${spec.name}\n長さ: ${spec.duration.toFixed(1)}秒 / ループ: ${spec.loop ? 'あり' : 'なし'}\n` +
        `演出: ${spec.flavor}`,
        'ok'
      );
    } else if (authMode === 'ardy') {
      const jaNote = spec.originalText ? `\n自動英訳: ${spec.name}` : '';
      const loopNote = spec.loop ? 'ループ再生' : '1回再生';
      setStatus(
        `再生中: ${spec.originalText ?? spec.name}${jaNote}\n` +
        `長さ: ${spec.duration.toFixed(1)}秒 / ${loopNote}${loopSelect.value === 'auto' ? ' (自動判定)' : ''} (ARDYローカルエンジン)`,
        'ok'
      );
    }
  } catch (e) {
    console.error(e);
    setStatus(`エラー: ${e.message}`, 'err');
  } finally {
    generateBtn.disabled = false;
    waypointClearBtn.disabled = false;
  }
});

// --- エクスポート ---
exportBtn.addEventListener('click', () => {
  if (!lastVRMA) return;
  const buffer = buildExportVRMA(lastVRMA.spec);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${lastVRMA.name}.vrma`;
  a.click();
  URL.revokeObjectURL(a.href);
  const exprNote = exprCheck.checked ? '表情トラック込み' : 'ボーンモーションのみ';
  setStatus(`${lastVRMA.name}.vrma を保存しました (${exprNote})。\nVRMA対応アプリ (VRoid Hub, cluster 等) で利用できます。`, 'ok');
});

// --- VRMアップロード ---
async function loadVRMFile(file) {
  if (!file || !/\.vrm$/i.test(file.name)) {
    setStatus('VRMファイル (.vrm) を選択してください。', 'err');
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    setStatus(`${file.name} を読み込み中...`);
    await viewer.loadVRM(url);
    vrmName.textContent = `${file.name} — 3Dビューへのドラッグ&ドロップでも読み込めます。`;
    setStatus(`${file.name} を読み込みました。`, 'ok');
    await playSpec(idleSpec(), { silent: true });
  } catch (e) {
    console.error(e);
    setStatus(`VRMの読み込みに失敗しました: ${e.message}`, 'err');
  } finally {
    URL.revokeObjectURL(url);
  }
}

vrmBtn.addEventListener('click', () => vrmFile.click());
vrmFile.addEventListener('change', () => {
  loadVRMFile(vrmFile.files?.[0]);
  vrmFile.value = '';
});

// --- 外部VRMAの読み込み再生 (ドラッグ&ドロップ) ---
async function loadVRMAFile(file) {
  try {
    setStatus(`${file.name} を読み込み中...`);
    const buf = await file.arrayBuffer();
    await viewer.playVRMA(buf, true);
    setStatus(`${file.name} を再生中です。`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`VRMAの読み込みに失敗しました: ${e.message}`, 'err');
  }
}

// 3Dビューへのドラッグ&ドロップ
viewerWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewerWrap.classList.add('dragover');
});
viewerWrap.addEventListener('dragleave', () => viewerWrap.classList.remove('dragover'));
viewerWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  viewerWrap.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.vrma$/i.test(file.name)) {
    loadVRMAFile(file);
  } else {
    loadVRMFile(file);
  }
});

// --- 設定復元 / Ctrl+Enterで生成 ---
apiKeyInput.value = localStorage.getItem('openai-api-key') ?? '';
refineCheck.checked = localStorage.getItem('refine-enabled') !== '0';
exprCheck.checked = localStorage.getItem('export-expressions') !== '0';
loopSelect.value = 'auto'; // ループ再生は毎回「自動」で開始 (記憶しない)
const savedModel = localStorage.getItem('openai-model');
if (savedModel && [...apiModelSelect.options].some((o) => o.value === savedModel)) {
  apiModelSelect.value = savedModel;
} else {
  apiModelSelect.value = DEFAULT_OPENAI_MODEL;
}
ardyUrlInput.addEventListener('change', () => checkArdyHealth());

// --- 経由地モード: 床クリックで配置 ---
// カメラ回転のドラッグと区別するため、押した位置から動いていないクリックだけ拾う
let pointerDownAt = null;
viewerWrap.addEventListener('pointerdown', (e) => {
  pointerDownAt = { x: e.clientX, y: e.clientY };
});
viewerWrap.addEventListener('click', (e) => {
  if (!waypointCheck.checked || authModeSelect.value !== 'ardy') return;
  if (generateBtn.disabled) {
    setStatus('生成中は経由地を変更できません。完了までお待ちください。', 'err');
    return;
  }
  if (pointerDownAt && Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 5) return;
  const p = viewer.groundPointFromClick(e.clientX, e.clientY);
  if (!p) return;
  const est = waypointPathSeconds([...waypoints, { x: p.x, z: p.z }]);
  if (est > MAX_MOTION_SECONDS) {
    setStatus(`経路が長すぎます (推定${Math.round(est)}秒 > 上限${MAX_MOTION_SECONDS}秒)。これ以上は置けません。`, 'err');
    return;
  }
  waypoints.push({ x: p.x, z: p.z });
  updateWaypointUI();
  setStatus(
    `経由地 ${waypoints.length} を (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) に配置。` +
    `経路の推定所要時間: 約${Math.round(est)}秒。右クリックで1つ戻せます。`,
    'ok'
  );
});
// 右クリックで最後の経由地を取り消す
viewerWrap.addEventListener('contextmenu', (e) => {
  if (!waypointCheck.checked || authModeSelect.value !== 'ardy' || waypoints.length === 0) return;
  e.preventDefault();
  if (generateBtn.disabled) return; // 生成中は変更不可
  waypoints.pop();
  updateWaypointUI();
  setStatus(`経由地を1つ取り消しました (残り${waypoints.length}個)。`, 'ok');
});
waypointCheck.addEventListener('change', () => {
  waypointGuide.classList.toggle('hidden', !waypointCheck.checked);
  if (waypointCheck.checked) {
    setStatus('経由地モード: 3Dビューの床をクリックして経由地を置いてください。', 'ok');
  }
});
waypointClearBtn.addEventListener('click', () => {
  if (generateBtn.disabled) return; // 生成中は変更不可
  waypoints.length = 0;
  updateWaypointUI();
  setStatus('経由地をクリアしました。', 'ok');
});
ardyStartBtn.addEventListener('click', () => {
  ardyStartBtn.disabled = true;
  startArdyEngine().finally(() => { ardyStartBtn.disabled = false; });
});
authModeSelect.addEventListener('change', () => {
  localStorage.setItem('openai-auth-mode', authModeSelect.value);
  renderAuthMode();
  if (authModeSelect.value === 'codex') refreshCodexStatus();
});
codexModelSelect.addEventListener('change', () => {
  localStorage.setItem('codex-model', codexModelSelect.value);
});
codexLoginBtn.addEventListener('click', async () => {
  codexLoginBtn.disabled = true;
  try {
    await codexBridge.login();
    setCodexAuthState('ブラウザでChatGPTへのログインを完了してください...');
  } catch (error) {
    setCodexAuthState(error.message, 'err');
    await refreshCodexStatus();
  }
});
codexLogoutBtn.addEventListener('click', async () => {
  codexLogoutBtn.disabled = true;
  try {
    await refreshCodexStatus(await codexBridge.logout());
  } catch (error) {
    setCodexAuthState(error.message, 'err');
  }
});
codexBridge?.onAccountChanged((status) => refreshCodexStatus(status));
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateBtn.click();
});

initializeAuth();
init();
