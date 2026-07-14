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

let lastVRMA = null; // { buffer: ArrayBuffer, name: string }

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// --- ビューア初期化 ---
const viewer = new Viewer($('canvas'));
const DEFAULT_MODEL_URL = '/models/Zundamon.vrm';

async function init() {
  try {
    setStatus('VRMモデルを読み込み中...');
    await viewer.loadVRM(DEFAULT_MODEL_URL);
    setStatus('準備完了。テキストを入力して「モーション生成」を押してください。', 'ok');
    await playSpec(idleSpec(), { silent: true });
  } catch {
    // デフォルトモデル未配置 (クローン直後など) は VRM アップロードを促す
    vrmName.textContent = 'モデル未読込 — VRMファイルを開いてください。';
    setStatus(
      'デフォルトのVRMモデルが見つかりません。\n' +
      '「VRMファイルを開く」から手持ちの .vrm を読み込んでください。',
      'err'
    );
  }
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
    await playSpec(spec);
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
