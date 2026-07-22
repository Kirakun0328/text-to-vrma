// main.js — UI と各モジュールの結線
import pkg from '../package.json';
import { t, locale, setLocale, applyStaticI18n } from './i18n.js';
import { Viewer } from './viewer.js';
import { buildVRMA } from './vrmaBuilder.js';
import { idleSpec } from './idleMotion.js';
import { autoExpressions } from './autoExpressions.js';
import { appendNeutralEnding } from './specMerge.js';
import { exportGIF, exportWebM, downloadBlob } from './recorder.js';
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
const gifBtn = $('gifBtn');
const webmBtn = $('webmBtn');
const exprCheck = $('exprCheck');

// .vrma保存・録画ボタンの有効/無効をまとめて切り替える。
// 初めてモーションが用意できた時に「書き出し・共有」セクションを出現させる
function setExportEnabled(on) {
  exportBtn.disabled = !on;
  gifBtn.disabled = !on;
  webmBtn.disabled = !on;
}
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
const ardySetupBtn = $('ardySetupBtn');
const ardyDurationInput = $('ardyDuration');
const genProgress = $('genProgress');
const genProgressBar = $('genProgressBar');
const genProgressText = $('genProgressText');
const waypointCheck = $('waypointCheck');
const waypointClearBtn = $('waypointClearBtn');
const waypointGuide = $('waypointGuide');
const loopSelect = $('loopSelect');

// --- UI言語 (日本語 / English / 中文 / 한국어) ---
const langSelect = $('langSelect');
langSelect.value = locale;
langSelect.addEventListener('change', () => {
  setLocale(langSelect.value); // 押した瞬間に画面全体へ即時反映 (リロードなし)
  updateWaypointUI();
});
applyStaticI18n();

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
// 個数は無制限。ただし経路の所要時間 (歩速1m/s換算+2秒) が安全上限に収まる範囲まで
const waypoints = [];
const MAX_MOTION_SECONDS = 300;

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
  waypointClearBtn.textContent = t('wp.clearN', { n: waypoints.length });
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

const panelEl = $('panel');
const ardyGptSlot = $('ardyGptSlot');
function renderAuthMode() {
  const mode = authModeSelect.value;
  const codexMode = mode === 'codex' && Boolean(codexBridge);
  const ardyMode = mode === 'ardy';
  // OpenAIキー+モデル選択は、api-keyモード(エンジン本体)でもARDYモード(任意の頭脳)でも使う。
  // ARDYモードでは同じ要素をARDYパネル内の「GPT (頭)」欄へ移動して見せる
  if (ardyMode) ardyGptSlot.appendChild(apiSettings);
  else panelEl.insertBefore(apiSettings, codexSettings);
  apiSettings.classList.toggle('hidden', codexMode);
  codexSettings.classList.toggle('hidden', !codexMode);
  ardySettings.classList.toggle('hidden', !ardyMode);
  // 経由地モード (セクション3) はARDYモード専用なので、それ以外では隠す
  $('waypointRow').classList.toggle('hidden', !ardyMode);
  refineCheck.parentElement.classList.toggle('hidden', ardyMode); // 自己修正はLLMキーフレーム専用
  if (ardyMode) checkArdyHealth();
}

// --- ARDYローカルエンジン ---
function setArdyState(message, kind = '') {
  ardyState.textContent = message;
  ardyState.className = `auth-state${kind ? ` ${kind}` : ''}`;
}

async function checkArdyHealth({ showFailure = true } = {}) {
  const url = ardyUrlInput.value.trim().replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    if (info.status === 'loading') {
      // モデル読み込み中: サーバーが返す実進捗%を表示する
      setArdyState(t('ardy.booting', { pct: Math.round((info.progress || 0) * 100) }), 'ok');
      ardyStartBtn.classList.add('hidden');
      ardySetupBtn.classList.add('hidden');
      return false;
    }
    if (info.status === 'error') {
      setArdyState(`❌ ${info.error || t('err.engineStart')}`, 'err');
      return false;
    }
    if (info.status !== 'ok') throw new Error('unexpected response');
    const ja = info.translator === 'ready' ? t('ardy.jaOK') : '';
    setArdyState(t('ardy.connected', { model: info.model, device: info.device === 'cpu' ? 'CPU' : 'GPU', ja }), 'ok');
    ardyStartBtn.classList.add('hidden');
    ardySetupBtn.classList.add('hidden');
    return true;
  } catch {
    // 起動待ちのポーリング中は、モデル初期化中の接続失敗で
    // 「未起動」表示や起動ボタンを一時的に復活させない。
    if (!showFailure) return false;
    if (window.ardyBridge) {
      // 未セットアップならボタンを「セットアップ」に切り替える (JSONを触らせない)
      const st = await window.ardyBridge.getStatus().catch(() => null);
      const configured = Boolean(st?.configured);
      ardyStartBtn.textContent = t('btn.engineStart');
      ardyStartBtn.dataset.mode = configured ? 'start' : 'setup';
      ardyStartBtn.classList.remove('hidden');
      // セットアップボタンは常設 (導入済みなら「再セットアップ」として途中失敗からの修復に使える)
      ardySetupBtn.textContent = configured ? t('btn.engineResetup') : t('btn.engineSetup');
      ardySetupBtn.classList.remove('hidden');
      setArdyState(
        configured ? t('ardy.notRunning', { hint: t('ardy.hintStartBtn') }) : t('ardy.notInstalled'),
        'err'
      );
    } else {
      setArdyState(t('ardy.notRunning', { hint: t('ardy.hintManual') }), 'err');
      ardyStartBtn.classList.add('hidden');
      ardySetupBtn.classList.add('hidden');
    }
    return false;
  }
}

// エンジンのセットアップ (install.ps1 を可視ウィンドウで実行)
async function setupArdyEngine() {
  if (!window.confirm(t('ardy.setupConfirm'))) return;
  try {
    await window.ardyBridge.setup();
    setArdyState(t('ardy.setupStarted'), 'ok');
    watchArdySetup();
  } catch (e) {
    setArdyState(`❌ ${e.message}`, 'err');
  }
}

// セットアップ完了の監視: 設定ファイルが書かれたら再起動なしでUIに反映する
let ardySetupWatchTimer = null;
function watchArdySetup() {
  if (ardySetupWatchTimer) clearInterval(ardySetupWatchTimer);
  ardySetupWatchTimer = setInterval(refreshArdyConfigured, 5000);
}

async function refreshArdyConfigured() {
  if (!window.ardyBridge) return;
  const st = await window.ardyBridge.getStatus().catch(() => null);
  if (!st?.configured) return;
  if (ardySetupWatchTimer) { clearInterval(ardySetupWatchTimer); ardySetupWatchTimer = null; }
  // 「セットアップ」表示のままなら「起動」ボタンに切り替える
  if (ardyStartBtn.dataset.mode !== 'start') {
    ardyStartBtn.textContent = t('btn.engineStart');
    ardyStartBtn.dataset.mode = 'start';
    ardyStartBtn.classList.remove('hidden');
    ardySetupBtn.textContent = t('btn.engineResetup');
    setArdyState(t('ardy.setupDone'), 'ok');
  }
}

// 別ウィンドウでセットアップを済ませて戻ってきた時にも反映する
window.addEventListener('focus', () => {
  if (ardyStartBtn.dataset.mode === 'setup') refreshArdyConfigured();
});

// LLM (OpenAI) 生成の進捗バー: ストリーミング受信文字数ベースの%表示
function startLLMProgressBar() {
  genProgressBar.style.width = '0%';
  genProgressText.textContent = t('llm.designing');
  genProgress.classList.remove('hidden');
  return {
    update(fraction, pass) {
      genProgressBar.style.width = `${Math.round(fraction * 100)}%`;
      genProgressText.textContent =
        t(pass === 2 ? 'llm.pass2' : 'llm.pass1', { pct: Math.round(fraction * 100) });
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
  genProgressText.textContent = t('ardy.connecting');
  genProgress.classList.remove('hidden');
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${url}/progress`, { signal: AbortSignal.timeout(1500) });
      const p = await res.json();
      if (!p.active) return;
      if (p.stage === 'translate') {
        genProgressBar.style.width = '3%';
        genProgressText.textContent = t('ardy.prep');
      } else if (p.stage === 'finalize') {
        genProgressBar.style.width = '100%';
        genProgressText.textContent = t('ardy.finalize');
      } else {
        genProgressBar.style.width = `${Math.round(p.fraction * 100)}%`;
        const eta = p.remaining != null ? t('ardy.eta', { s: Math.max(1, Math.ceil(p.remaining)) }) : '';
        genProgressText.textContent = t('ardy.genProgress', { pct: Math.round(p.fraction * 100), eta });
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
      onProgress?.(t('ardy.analyzing'));
      plan = await planArdySegments(text, apiKey, gptModel, {
        waypointCount: waypoints.length,
        pathMeters: waypoints.length ? waypointPathSeconds(waypoints) - 2 : 0,
      });
      console.log('[ARDY] GPT plan:', plan);
    } catch (e) {
      console.warn('[ARDY] GPT計画に失敗、ローカル翻訳にフォールバック:', e);
    }
  }

  const waypointsActive = waypointCheck.checked && waypoints.length > 0;

  // ARDYエンジン (サーバー) でセグメント群を生成する
  async function ardyGenerate(body) {
    const stopProgress = startArdyProgressBar(url);
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
      throw new Error(err.error || t('err.ardyHttp', { code: res.status }));
    }
    return res.json();
  }

  // モーション生成はすべてARDY (GPTは計画のみ。キーフレーム生成は混ぜない)
  onProgress?.(t('ardy.generating'));
  const body = plan?.segments?.length
    ? { segments: plan.segments.map((s) => ({ text: s.text, duration: s.duration })) }
    : { text };
  if (waypointsActive) body.waypoints = waypoints.map((w) => ({ x: w.x, z: w.z }));

  // 長さの手動指定 (空欄なら自動判定)。指定時は全体をその秒数に合わせる
  const manualDur = parseFloat(ardyDurationInput.value);
  if (Number.isFinite(manualDur) && manualDur > 0) {
    body.duration = manualDur;
    if (body.segments?.length) {
      // 複数セグメントは、GPTが割り振った比率を保ったまま合計が指定秒数になるよう按分
      const durs = body.segments.map((s) => Number(s.duration) || 0);
      const sum = durs.reduce((a, b) => a + b, 0);
      body.segments = sum > 0
        ? body.segments.map((s, i) => ({ ...s, duration: (durs[i] / sum) * manualDur }))
        : body.segments.map((s) => ({ ...s, duration: manualDur / body.segments.length }));
    }
  }
  const spec = await ardyGenerate(body);
  if (plan) spec.originalText = text;

  // 自動判定時のループ既定値 (共通のon/off上書きは生成ハンドラ側で行う)
  spec.loop = isLoopFriendly(spec);
  // 非ループは最後に自然な直立姿勢へ戻して終わる (中途半端なポーズで固まらない)
  if (!spec.loop) appendNeutralEnding(spec);
  // ARDYは表情を生成しないので自動付与する (GPTの感情判定があれば優先、
  // なければ原文の感情語からのキーワードマッチ)
  spec.expressions = autoExpressions(spec.originalText ?? text, spec.duration, plan?.expression);
  return spec;
}

// Electron デスクトップ版ではエンジンをアプリから起動できる
async function startArdyEngine() {
  if (!window.ardyBridge) return;
  try {
    const status = await window.ardyBridge.start().catch((e) => {
      if (String(e?.message).includes('ARDY_NOT_CONFIGURED')) {
        setupArdyEngine();
        return null;
      }
      throw e;
    });
    if (!status) return;
    if (!status.running) throw new Error(status.lastError || t('err.engineStart'));
    setArdyState(t('ardy.starting'));
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await checkArdyHealth({ showFailure: false })) return;
      const s = await window.ardyBridge.getStatus();
      if (!s.running) {
        setArdyState(`❌ ${s.lastError || t('ardy.exited')}`, 'err');
        return;
      }
    }
    setArdyState(t('ardy.startTimeout'), 'err');
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
    option.textContent = `${model.displayName}${model.isDefault ? t('model.recommended') : ''}`;
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
      setCodexAuthState(codexStatus.error || t('codex.unavailable'), 'err');
    } else if (account?.type === 'chatgpt') {
      const identity = maskEmail(account.email) || t('codex.account');
      setCodexAuthState(
        t('codex.loggedIn', { id: identity, plan: account.planType, ver: codexStatus.version }),
        'ok'
      );
      await loadCodexModels();
    } else {
      setCodexAuthState(t('codex.loggedOut', { ver: codexStatus.version }));
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
  statusEl.textContent = msg || '';
  statusEl.className = kind;
  statusEl.classList.toggle('hidden', !msg); // 空メッセージのときは枠ごと隠す
}

// --- ビューア初期化 ---
const viewer = new Viewer($('canvas'));
window.__viewer = viewer; // デバッグ・検証用

// --- 再生シークバー (現在の再生秒数の表示・スクラブ) ---
const playbackBar = $('playbackBar');
const pbPlayBtn = $('pbPlayBtn');
const pbTime = $('pbTime');
const pbDur = $('pbDur');
const pbSeek = $('pbSeek');
let pbScrubbing = false;
let pbPaused = false;

// 待機モーション (呼吸ループ) の時はバーを出さない。実モーション再生時だけ表示する
function showPlaybackBar(show) {
  playbackBar.classList.toggle('hidden', !show);
  if (show) { pbPaused = false; pbPlayBtn.textContent = '⏸'; }
}

viewer.onFrame = () => {
  if (pbScrubbing || playbackBar.classList.contains('hidden')) return;
  const p = viewer.getPlayback();
  if (!p) return;
  pbTime.textContent = p.time.toFixed(1);
  pbDur.textContent = p.duration.toFixed(1);
  pbSeek.value = String(Math.round((p.time / p.duration) * 1000));
};

pbPlayBtn.addEventListener('click', () => {
  pbPaused = !pbPaused;
  viewer.setPaused(pbPaused);
  pbPlayBtn.textContent = pbPaused ? '▶' : '⏸';
});
pbSeek.addEventListener('pointerdown', () => { pbScrubbing = true; });
pbSeek.addEventListener('input', () => {
  const p = viewer.getPlayback();
  if (!p) return;
  const time = (Number(pbSeek.value) / 1000) * p.duration;
  pbTime.textContent = time.toFixed(1);
  viewer.seek(time);
});
const endScrub = () => { pbScrubbing = false; };
pbSeek.addEventListener('pointerup', endScrub);
pbSeek.addEventListener('pointercancel', endScrub);
// 起動時の読み込み優先順: VRoidサンプル VRM1.0 → VRM0.0
const DEFAULT_MODEL_URLS = [
  '/models/AvatarSample_VRM1.0.vrm',
  '/models/AvatarSample_VRM0.0.vrm',
];

async function init() {
  setStatus(t('vrm.loadingModel'));
  for (const url of DEFAULT_MODEL_URLS) {
    try {
      await viewer.loadVRM(url);
      const name = url.split('/').pop();
      vrmName.textContent = t('vrm.replaced', { name });
      setStatus(''); // 「準備完了…」は出さない (枠ごと非表示)
      await playSpec(idleSpec(), { silent: true });
      return;
    } catch { /* 次の候補へ */ }
  }
  vrmName.textContent = t('vrm.none');
  setStatus(
    t('vrm.hint'),
    'err'
  );
}

// --- モーション再生共通処理 (プレビューは表情込み) ---
async function playSpec(spec, { silent = false, seek = 0 } = {}) {
  const buffer = buildVRMA(spec);
  await viewer.playVRMA(buffer, spec.loop ?? true, seek);
  lastVRMA = { spec, name: spec.name || 'motion' };
  setExportEnabled(true);
  showPlaybackBar(!silent); // 待機モーション (silent) 以外は再生バーを表示
  if (!silent) {
    setStatus(
      t('playing', { name: spec.name, dur: spec.duration.toFixed(1), loop: spec.loop ? t('loop.yes') : t('loop.no') }),
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
    setExportEnabled(true);
    showPlaybackBar(true);
    setStatus(t('playing.hist', { name: item.name, text: item.text }), 'ok');
  } catch (e) {
    console.error(e);
    setStatus(t('error', { msg: e.message }), 'err');
  }
}

function renderHistory() {
  historyEl.innerHTML = '';
  $('clearHistoryBtn').classList.toggle('hidden', history.length === 0);
  if (history.length === 0) {
    historyEl.innerHTML = `<p class="sub">${t('history.empty')}</p>`;
    return;
  }
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'hist-item';

    const play = document.createElement('button');
    play.className = 'play';
    play.textContent = '▶';
    play.title = t('hist.play');
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
    save.title = t('hist.save');
    save.addEventListener('click', () => downloadVRMA(item));

    const gif = document.createElement('button');
    gif.textContent = '🎞';
    gif.title = t('hist.gif');
    gif.addEventListener('click', () => exportHistoryItem(item, 'gif'));

    const webm = document.createElement('button');
    webm.textContent = '🎬';
    webm.title = t('hist.webm');
    webm.addEventListener('click', () => exportHistoryItem(item, 'webm'));

    const copy = document.createElement('button');
    copy.textContent = '📋';
    copy.title = t('hist.copy');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(item.spec, null, 1));
      setStatus(t('json.copied'), 'ok');
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = t('hist.delete');
    del.addEventListener('click', () => {
      const idx = history.indexOf(item);
      if (idx !== -1) history.splice(idx, 1);
      renderHistory();
    });

    row.append(play, name, meta, save, gif, webm, copy, del);
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
    setStatus(t('err.noText'), 'err');
    return;
  }
  const authMode = authModeSelect.value;
  const apiKey = apiKeyInput.value.trim();
  if (authMode === 'api-key' && !apiKey) {
    setStatus(t('err.noApiKey'), 'err');
    return;
  }
  if (authMode === 'codex' && codexStatus?.account?.type !== 'chatgpt') {
    setStatus(t('err.codexAuth'), 'err');
    return;
  }
  if (authMode === 'ardy' && !(await checkArdyHealth())) {
    setStatus(t('err.ardyConn'), 'err');
    return;
  }
  if (!viewer.vrm) {
    setStatus(t('err.noVrm'), 'err');
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
      setStatus(t('ardy.generating'));
      spec = await generateMotionWithArdy(text, options);
    } else {
      const model = authMode === 'codex' ? codexModelSelect.value : apiModelSelect.value;
      if (!model) throw new Error(t('err.noModel'));
      if (authMode === 'api-key') {
        localStorage.setItem('openai-api-key', apiKey);
        localStorage.setItem('openai-model', model);
      } else {
        localStorage.setItem('codex-model', model);
      }
      localStorage.setItem('refine-enabled', refineCheck.checked ? '1' : '0');
      setStatus(t('gen.llm', { engine: authMode === 'codex' ? 'Codex' : 'OpenAI', model }));
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
        t('playing', { name: spec.name, dur: spec.duration.toFixed(1), loop: spec.loop ? t('loop.yes') : t('loop.no') }) + `\n🎬 ${spec.flavor}`,
        'ok'
      );
    } else if (authMode === 'ardy') {
      const jaNote = spec.originalText ? t('ja.note', { en: spec.name }) : '';
      const loopNote = spec.loop ? t('loop.playing') : t('loop.once');
      setStatus(
        t('playing.ardy', { name: spec.originalText ?? spec.name, ja: jaNote, dur: spec.duration.toFixed(1), loop: loopNote, auto: loopSelect.value === 'auto' ? t('loop.autoJudged') : '' }),
        'ok'
      );
    }
  } catch (e) {
    console.error(e);
    setStatus(t('error', { msg: e.message }), 'err');
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
  const exprNote = exprCheck.checked ? t('expr.included') : t('expr.bonesOnly');
  setStatus(t('vrma.saved', { name: lastVRMA.name, note: exprNote }), 'ok');
});

// --- GIF / 動画(WebM) 書き出し (共有用) ---
const GIF_MAX_SECONDS = 12; // 長すぎるとファイルが肥大するためGIFは先頭12秒まで
let recording = false;

// バイト数を KB / MB / GB へ読みやすく整形する
function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

function recordDuration() {
  const p = viewer.getPlayback();
  return p?.duration || lastVRMA?.spec?.duration || 3;
}

async function runExport(kind) {
  if (!lastVRMA || recording) return;
  recording = true;
  setExportEnabled(false);
  generateBtn.disabled = true;
  const wasPaused = viewer.getPlayback() && !viewer.getPlayback().running;
  try {
    const fullDur = recordDuration();
    const bar = startRecordProgress();
    let blob, ext;
    if (kind === 'gif') {
      const dur = Math.min(fullDur, GIF_MAX_SECONDS);
      if (fullDur > GIF_MAX_SECONDS) setStatus(t('rec.gifClip', { s: GIF_MAX_SECONDS }));
      viewer.setRenderLoop(false); // コマ送りに専念 (裏ループとの競合防止)
      try {
        blob = await exportGIF(viewer, { duration: dur, onProgress: bar.update });
      } finally {
        viewer.setRenderLoop(true);
      }
      ext = 'gif';
    } else {
      blob = await exportWebM(viewer, { duration: fullDur, onProgress: bar.update });
      ext = 'webm';
    }
    bar.done();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(blob, `${lastVRMA.name || 'motion'}_${stamp}.${ext}`);
    setStatus(t('rec.done', { ext: ext.toUpperCase(), size: formatBytes(blob.size) }), 'ok');
  } catch (e) {
    console.error(e);
    setStatus(t('error', { msg: e.message }), 'err');
  } finally {
    recording = false;
    setExportEnabled(true);
    generateBtn.disabled = false;
    // 書き出し後は先頭から再生を続ける (GIFのコマ送りで止まった状態を解消)
    viewer.seek(0);
    viewer.setPaused(Boolean(wasPaused));
  }
}

// 書き出し進捗バー (生成用の進捗バーを流用)
function startRecordProgress() {
  genProgressBar.style.width = '0%';
  genProgressText.textContent = t('rec.working');
  genProgress.classList.remove('hidden');
  return {
    update(fraction) {
      genProgressBar.style.width = `${Math.round(fraction * 100)}%`;
      genProgressText.textContent = t('rec.workingPct', { pct: Math.round(fraction * 100) });
    },
    done() {
      genProgressBar.style.width = '100%';
      setTimeout(() => genProgress.classList.add('hidden'), 400);
    },
  };
}

gifBtn.addEventListener('click', () => runExport('gif'));
webmBtn.addEventListener('click', () => runExport('webm'));

// 履歴項目の書き出し: いったんその項目を再生してから書き出す
async function exportHistoryItem(item, kind) {
  if (recording) return;
  await playHistoryItem(item);
  await runExport(kind);
}

// --- 背景切り替え (標準 / 単色: 全色から自由に指定) ---
const bgSelect = $('bgSelect');
const bgColor = $('bgColor');
bgSelect.value = localStorage.getItem('bg-mode') || 'default';
bgColor.value = localStorage.getItem('bg-color') || '#00b140';
function applyBackground() {
  viewer.setBackground(bgSelect.value, bgColor.value);
  localStorage.setItem('bg-mode', bgSelect.value);
  localStorage.setItem('bg-color', bgColor.value);
}
applyBackground();
bgSelect.addEventListener('change', applyBackground);
// 色を選んだら自動で「単色」モードに切り替える
bgColor.addEventListener('input', () => {
  if (bgSelect.value !== 'solid') bgSelect.value = 'solid';
  applyBackground();
});

// --- 3Dプレビュー: カメラリセット / フルスクリーン ---
$('camResetBtn').addEventListener('click', () => viewer.resetCamera());
$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else viewerWrap.requestFullscreen?.();
});

// --- 履歴クリア ---
$('clearHistoryBtn').addEventListener('click', () => {
  history.length = 0;
  renderHistory();
});

// --- VRMアップロード ---
async function loadVRMFile(file) {
  if (!file || !/\.vrm$/i.test(file.name)) {
    setStatus(t('err.pickVrm'), 'err');
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    setStatus(t('file.loading', { name: file.name }));
    await viewer.loadVRM(url);
    vrmName.textContent = t('vrm.replaced', { name: file.name });
    setStatus(t('file.loaded', { name: file.name }), 'ok');
    await playSpec(idleSpec(), { silent: true });
  } catch (e) {
    console.error(e);
    setStatus(t('err.vrmLoad', { msg: e.message }), 'err');
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
    setStatus(t('file.loading', { name: file.name }));
    const buf = await file.arrayBuffer();
    await viewer.playVRMA(buf, true);
    showPlaybackBar(true);
    setStatus(t('file.playing', { name: file.name }), 'ok');
  } catch (e) {
    console.error(e);
    setStatus(t('err.vrmaLoad', { msg: e.message }), 'err');
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

// --- 更新チェック: 公開リポジトリの最新バージョンと比較して通知する ---
// (バージョン番号の取得だけで、個人情報は一切送信されません)
const VERSION_URL = 'https://raw.githubusercontent.com/Kirakun0328/text-to-vrma/master/package.json';
const RELEASES_URL = 'https://github.com/Kirakun0328/text-to-vrma/releases';

function isNewerVersion(remote, local) {
  const r = String(remote).split('.').map(Number);
  const l = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    const remote = (await res.json()).version;
    if (!isNewerVersion(remote, pkg.version)) return;
    if (localStorage.getItem('update-dismissed') === remote) return;
    const banner = document.createElement('div');
    banner.id = 'updateBanner';
    banner.innerHTML =
      `${t('update.msg', { v: remote, cur: pkg.version })}` +
      `<a href="${RELEASES_URL}" target="_blank" rel="noopener">${t('update.dl')}</a> ` +
      `<button type="button">×</button>`;
    banner.querySelector('button').addEventListener('click', () => {
      localStorage.setItem('update-dismissed', remote);
      banner.remove();
    });
    document.body.prepend(banner);
  } catch {
    // オフライン等で確認できない場合は何もしない
  }
}
checkForUpdate();

// --- サードパーティ ライセンス表示 ---
const LICENSE_TEXT = `Text-To-VRMA — MIT License
Copyright (c) 2026 Kiratchi

This application uses the following third-party software and models.
本アプリは以下のサードパーティ ソフトウェア・モデルを利用しています。

■ ARDY (NVIDIA / nv-tlabs/ardy)
  Source code: Apache License 2.0
  Model weights: NVIDIA Open Model Agreement
  https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/
  NVIDIA does not claim ownership of any outputs generated by the model.

■ Meta Llama 3 (Meta-Llama-3-8B-Instruct)
  Meta Llama 3 Community License
  https://llama.meta.com/llama3/license
  Built with Meta Llama 3.
  "Meta Llama 3 is licensed under the Meta Llama 3 Community License,
   Copyright (c) Meta Platforms, Inc. All Rights Reserved."

■ LLM2Vec (McGill-NLP) — MIT License
■ FuguMT (staka/fugumt-ja-en, JA->EN translation) — CC BY-SA 4.0
■ VRoid AvatarSample (pixiv Inc.) — AvatarSample A-Z Terms of Use
  https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z

モデル重みは本アプリに同梱されず、セットアップ時に各配布元 (Hugging Face) から
利用者自身がダウンロードします。生成された .vrma の利用は各自の責任で行ってください。

Full notices: https://github.com/Kirakun0328/text-to-vrma/blob/master/THIRD_PARTY_NOTICES.md`;

const licenseModal = $('licenseModal');
$('licenseBtn').addEventListener('click', () => {
  $('licenseText').textContent = LICENSE_TEXT;
  licenseModal.classList.remove('hidden');
});
$('licenseCloseBtn').addEventListener('click', () => licenseModal.classList.add('hidden'));
licenseModal.addEventListener('click', (e) => {
  if (e.target === licenseModal) licenseModal.classList.add('hidden');
});
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
    setStatus(t('wp.locked'), 'err');
    return;
  }
  // モーション再生中は床クリック(経由地配置)を無効にする (待機モーションは除く)
  const pb = viewer.getPlayback();
  if (pb?.running && !$('playbackBar').classList.contains('hidden')) {
    setStatus(t('wp.playing'), 'err');
    return;
  }
  if (pointerDownAt && Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 5) return;
  const p = viewer.groundPointFromClick(e.clientX, e.clientY);
  if (!p) return;
  const est = waypointPathSeconds([...waypoints, { x: p.x, z: p.z }]);
  if (est > MAX_MOTION_SECONDS) {
    setStatus(t('wp.tooLong', { est: Math.round(est), max: MAX_MOTION_SECONDS }), 'err');
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
  setStatus(t('wp.undone', { n: waypoints.length }), 'ok');
});
waypointCheck.addEventListener('change', () => {
  waypointGuide.classList.toggle('hidden', !waypointCheck.checked);
  // OFF時はマーカーも消して「経由地は使われない」ことを見た目で示す
  viewer.setWaypointMarkers(waypointCheck.checked ? waypoints : []);
  waypointClearBtn.classList.toggle('hidden', !waypointCheck.checked || waypoints.length === 0);
  if (waypointCheck.checked) {
    setStatus(t('wp.modeOn'), 'ok');
  }
});
waypointClearBtn.addEventListener('click', () => {
  if (generateBtn.disabled) return; // 生成中は変更不可
  waypoints.length = 0;
  updateWaypointUI();
  setStatus(t('wp.cleared'), 'ok');
});
ardySetupBtn.addEventListener('click', () => {
  setupArdyEngine();
});

ardyStartBtn.addEventListener('click', () => {
  if (ardyStartBtn.dataset.mode === 'setup') {
    setupArdyEngine();
    return;
  }
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
