// main.js — UI と各モジュールの結線
import { Viewer } from './viewer.js';
import { buildVRMA } from './vrmaBuilder.js';
import { idleSpec } from './idleMotion.js';
import { generateMotionWithChatGPT, DEFAULT_OPENAI_MODEL } from './llm.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const textInput = $('textInput');
const generateBtn = $('generateBtn');
const exportBtn = $('exportBtn');
const stopBtn = $('stopBtn');
const apiKeyInput = $('apiKey');
const modelSelect = $('modelSelect');
const vrmBtn = $('vrmBtn');
const vrmFile = $('vrmFile');
const vrmName = $('vrmName');
const viewerWrap = $('viewerWrap');
const historyEl = $('history');

let lastVRMA = null; // { buffer: ArrayBuffer, name: string }
const history = []; // [{ name, buffer, loop, duration, text }]
const MAX_HISTORY = 20;

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// --- ビューア初期化 ---
const viewer = new Viewer($('canvas'));
// 起動時は同梱サンプルを読み込む (手持ちモデルは「VRMファイルを開く」で差し替え)
const DEFAULT_MODEL_URLS = ['/models/SampleBot.vrm'];

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
  setStatus('VRMモデルが見つかりません。\n「VRMファイルを開く」から .vrm を読み込んでください。', 'err');
}

// --- モーション再生共通処理 ---
async function playSpec(spec, { silent = false } = {}) {
  const buffer = buildVRMA(spec);
  await viewer.playVRMA(buffer, spec.loop ?? true);
  lastVRMA = { buffer, name: spec.name || 'motion' };
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
  const blob = new Blob([item.buffer], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${item.name}.vrma`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function playHistoryItem(item) {
  try {
    await viewer.playVRMA(item.buffer.slice(0), item.loop);
    lastVRMA = { buffer: item.buffer, name: item.name };
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

    row.append(play, name, meta, save);
    historyEl.appendChild(row);
  }
}

function addHistory(spec, buffer, text) {
  history.unshift({
    name: spec.name || 'motion',
    buffer,
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
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus('OpenAI APIキーを入力してください。', 'err');
    return;
  }
  if (!viewer.vrm) {
    setStatus('先にVRMモデルを読み込んでください。', 'err');
    return;
  }
  generateBtn.disabled = true;
  try {
    localStorage.setItem('openai-api-key', apiKey);
    const model = modelSelect.value;
    localStorage.setItem('openai-model', model);
    setStatus(`ChatGPT (${model}) がモーションを生成中... (数十秒かかることがあります)`);
    const spec = await generateMotionWithChatGPT(text, apiKey, model);
    const buffer = await playSpec(spec);
    addHistory(spec, buffer, text);
  } catch (e) {
    console.error(e);
    setStatus(`エラー: ${e.message}`, 'err');
  } finally {
    generateBtn.disabled = false;
  }
});

// --- エクスポート ---
exportBtn.addEventListener('click', () => {
  if (!lastVRMA) return;
  const blob = new Blob([lastVRMA.buffer], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${lastVRMA.name}.vrma`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`${lastVRMA.name}.vrma を保存しました。\nVRMA対応アプリ (VRoid Hub, cluster 等) で利用できます。`, 'ok');
});

// --- 停止 ---
stopBtn.addEventListener('click', () => {
  viewer.stop();
  setStatus('停止しました。');
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

// 3Dビューへのドラッグ&ドロップ
viewerWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewerWrap.classList.add('dragover');
});
viewerWrap.addEventListener('dragleave', () => viewerWrap.classList.remove('dragover'));
viewerWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  viewerWrap.classList.remove('dragover');
  loadVRMFile(e.dataTransfer?.files?.[0]);
});

// --- 設定復元 / Ctrl+Enterで生成 ---
apiKeyInput.value = localStorage.getItem('openai-api-key') ?? '';
const savedModel = localStorage.getItem('openai-model');
if (savedModel && [...modelSelect.options].some((o) => o.value === savedModel)) {
  modelSelect.value = savedModel;
} else {
  modelSelect.value = DEFAULT_OPENAI_MODEL;
}
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateBtn.click();
});

init();
