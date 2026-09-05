import { tr } from './i18n.js';
// main.js — UI と各モジュールの結線
import pkg from '../package.json';
import { t, locale, setLocale, applyStaticI18n } from './i18n.js';
import { Viewer } from './viewer.js';
import { generateReviewedMotion } from './motionReview.js';
import { inspectMotion, comparisonImages } from './reviewCapture.js';
import { directlyReviewMotion } from './directMotionReview.js';
import { generateArdyCandidates } from './ardyCandidates.js';
import { renderCandidatePanel } from './candidatePanel.js';
import { softenMotion } from './smoothMotion.js';
import { renderMotionChecks, renderGenerationRoute, renderPlaybackStatus } from './motionCheckPanel.js';
import { installCodexWebBridge } from './codexWebBridge.js';
import { renderUsage } from './codexUsage.js';
import { refineArdyMotion, claudeReviewMessages } from './ardyReview.js';
import { buildVRMA } from './vrmaBuilder.js';
import { idleSpec } from './idleMotion.js';
import { autoExpressions } from './autoExpressions.js';
import { rescaleSpec, isLoopFriendly } from './specMerge.js';
import { exportGIF, exportWebM, downloadBlob } from './recorder.js';
import {
  generateMotionWithOpenAI,
  generateMotionWithClaude,
  generateMotionWithCodex,
  planArdySegments,
  callClaude,
  callOpenAI,
  setApiBase,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_CLAUDE_MODEL,
} from './llm.js';

const $ = (id) => document.getElementById(id);
installCodexWebBridge();
let correctionProgress=0;
function showCorrectionProgress(message,details) {
  if(!details?.stage) return;
  const stages={capture:'動きを撮影・確認しています',assessment:'修正が必要な箇所を確認しています',design:'AIが動きの直し方を考えています',apply:'修正した動きを撮影しています',evaluate:'修正前後を比べています',finish:'比較結果を準備しています'};
  $('reviewProgress').classList.remove('hidden');
  $('reviewProgressStage').textContent=tr(stages[details.stage]||'修正処理中…');
  $('reviewProgressSection').textContent=[details.total ? tr('全{total}区間のうち {n}区間目（{start}〜{end}秒）',{total:details.total,n:details.section,start:Number(details.start.toFixed(1)),end:Number(details.end.toFixed(1))}) : '',details.round ? tr('{n}回目の見直し',{n:details.round}) : ''].filter(Boolean).join(' · ');
  const stageFraction={capture:0,assessment:.1,design:.2,apply:.6,evaluate:.8};
  const rounds=details.rounds||1;
  const sectionFraction=((details.round||1)-1+(stageFraction[details.stage]??0))/rounds;
  const percent=details.stage==='finish'?95:Math.floor(95*((details.section||1)-1+sectionFraction)/(details.total||1));
  correctionProgress=Math.max(correctionProgress,percent);
  $('reviewProgressBar').value=correctionProgress;
  $('reviewProgressPercent').textContent=tr('全体の進捗（目安）：{percent}%',{percent:correctionProgress});
}
let latestReview = null;
let latestCandidates=null;
function showCandidates(report) {
  latestCandidates=report;window.__lastCandidates=report;
  $('candidateCompareBtn').classList.remove('hidden');
  renderCandidatePanel(report,{
    preview:async index=>{
      if(generateBtn.disabled)return;
      generateBtn.disabled=true;
      try {const spec=report.entries[index].spec;await viewer.playVRMA(buildVRMA(spec),spec.loop);$('candidateResults').close();}
      catch(e){setStatus(e.message,'err');}finally{generateBtn.disabled=false;}
    },
    adopt:async index=>{
      if(generateBtn.disabled)return;
      generateBtn.disabled=true;
      try {
        const spec=report.entries[index].spec,buffer=await playSpec(spec);
        window.__lastSpec=spec;report.selected=index;
        await addHistory(spec,buffer,spec.originalText||spec.name);
        latestReview=null;window.__lastReview=null;$('reviewCompareBtn').classList.add('hidden');
        showCandidates(report);$('candidateResults').close();setStatus(tr('候補 {n}を採用しました。',{n:index+1}),'ok');
      }catch(e){setStatus(e.message,'err');}finally{generateBtn.disabled=false;}
    }
  });
}
$('candidateCompareBtn').addEventListener('click',()=>{if(!generateBtn.disabled&&latestCandidates)$('candidateResults').showModal();});
$('candidateCloseBtn').addEventListener('click',()=>$('candidateResults').close());
$('visualReviewCheck').checked = localStorage.getItem('visual-review') === '1';
$('visualReviewCheck').addEventListener('change', () => {
  localStorage.setItem('visual-review', $('visualReviewCheck').checked ? '1' : '0');
  renderAuthMode();
});
function showReview(result) {
  latestReview=result; window.__lastReview=result;
  $('reviewCompareBtn').classList.remove('hidden');
  $('reviewCompareBtn').textContent=tr('修正前後を比較');
  $('reviewCandidateBtn').disabled=$('reviewAdoptBtn').disabled=!result.candidate;
  const selected=result.attempts?.findLast(a=>a.accepted)??result.attempts?.at(-1);
  $('reviewOutcome').textContent=[result.manual ? (result.candidate ? tr('修正版を用意しました。比較して「この修正版を採用」で確定してください。') : tr('動きを変更する補正は得られませんでした。')) : result.accepted ? tr('修正版を採用しました。') : tr('初稿を採用しました。'),
    tr('AIの比較評価：{result}',{result:result.accepted?tr('改善あり'):tr('改善を確認できませんでした。')}),selected?.rejection||selected?.verdict?.reason||'',result.error||''].filter(Boolean).join('\n');
  $('reviewAssessment').classList.toggle('hidden',!result.assessment);
  $('reviewAssessment').textContent=result.assessment ? [tr(result.assessment.needed?'修正を推奨':'修正不要'),result.assessment.reason,...result.assessment.issues].join('\n') : '';
  const plan=result.plan;
  $('reviewRawPlan').textContent=JSON.stringify(result.attempts?{plan,attempts:result.attempts}:plan,null,2);
  $('reviewPlan').textContent=[tr('指示：{text}',{text:plan.intent||''}),tr('長さ：{seconds}秒',{seconds:Number(plan.duration.toFixed(2))}),
    ...(result.mode==='direct' ? result.attempts.map((a,i)=>[
      tr('試行{n}：{summary}',{n:i+1,summary:a.patch.summary}),
      ...a.patch.issues.map(issue=>`${issue.start.toFixed(2)}–${issue.end.toFixed(2)} s · ${issue.bone}: ${issue.problem} → ${issue.change}`),
      tr('最大補正：{degrees}度／腰移動 {cm}cm',{degrees:a.changes.maxRotationDeg.toFixed(1),cm:(a.changes.maxRootMeters*100).toFixed(1)}),
      tr('評価：{reason}',{reason:a.rejection||a.verdict?.reason||tr('未測定')}),
      tr('未解決：{issues}',{issues:a.verdict?.remainingIssues?.join(' / ')||tr('指摘なし')})].join('\n')) : Object.hasOwn(plan,'correction') ? [tr('ARDYへの修正指示です。支持脚・到達目標は未指定のため未測定です。')] : plan.phases.map(p=>`${p.start}–${p.end} s: ${[p.action,p.anticipation,p.weightShift,p.gaze,p.timing].filter(Boolean).join(' / ')}`))].join('\n\n');
  const value=(n,unit)=>Number.isFinite(n)?`${(n*100).toFixed(2)} ${unit}`:tr('未測定');
  const metrics=m=>!m?tr('未測定'):[
    tr('支持脚の滑り：{value}',{value:value(m.plannedContactSlideMps,'cm/s')}),
    tr('足首の沈み込み（近似）：{value}cm',{value:Number.isFinite(m.maxFootDropBelowRestM)?(m.maxFootDropBelowRestM*100).toFixed(2):tr('未測定')}),
    tr('到達誤差：{value}',{value:value(m.meanTargetErrorM,'cm')}),
    tr('推定接地中の滑り：{value}',{value:value(m.estimatedContactSlideMps,'cm/s')})].join('\n');
  $('reviewMetrics').textContent=[tr('修正前'),metrics(result.before.metrics),'',tr('修正後'),metrics(result.after?.metrics),'',result.model||'',
    result.timing?tr('処理時間：{seconds}秒',{seconds:result.timing.totalSeconds.toFixed(1)}):'',tr('接地・床貫通は近似値です。AIの評価とあわせて再生して確認してください。')].join('\n');
  $('reviewImages').replaceChildren();
  for(const [label,data] of [[tr('修正前'),result.before],[tr('修正後'),result.after]]) for(const [i,url] of (data?.images??[]).entries()) {
    const image=document.createElement('img');image.src=url;image.alt=`${label} ${tr(i?'側面':'正面')}`;image.style.width='100%';
    const caption=document.createElement('p');caption.textContent=image.alt;
    const figure=document.createElement('figure');figure.append(caption,image);$('reviewImages').append(figure);
  }
}
$('reviewCompareBtn').addEventListener('click', () => {
  if (!generateBtn.disabled) $('reviewResults').showModal();
});
$('reviewCloseBtn').addEventListener('click', () => $('reviewResults').close());
for (const [id, key] of [['reviewDraftBtn', 'draft'], ['reviewCandidateBtn', 'candidate']]) {
  $(id).addEventListener('click', async () => {
    if (!latestReview?.[key] || generateBtn.disabled) return;
    try {
      await viewer.playVRMA(buildVRMA(latestReview[key]),latestReview[key].loop);
      $('reviewResults').close();
      $('reviewCompareBtn').textContent = tr('{version}を再生中 · 比較を開く',{version:tr(key==='draft'?'修正前':'修正後')});
    } catch (e) { setStatus(e.message, 'err'); }
  });
}
$('reviewDownloadBtn').addEventListener('click', () => {
  if (latestReview) downloadBlob(new Blob([JSON.stringify(latestReview, null, 2)], { type: 'application/json' }), 'motion-review.json');
});
document.querySelector('.ai-settings-toggle').parentElement.addEventListener('toggle', event => {
  document.querySelector('.toggle-hint').textContent = event.currentTarget.open ? tr('設定を閉じる') : tr('設定を開く');
});
$('reviewAdoptBtn').addEventListener('click', async () => {
  if (!latestReview?.candidate || generateBtn.disabled) return;
  generateBtn.disabled = true;
  try {
    const spec=latestReview.candidate, buffer=await playSpec(spec);
    window.__lastSpec=spec;
    await addHistory(spec,buffer,latestReview.plan.intent);
    $('reviewResults').close();
    setStatus(tr('修正版を採用しました。書き出しにもこの動きを使います。'),'ok');
  } catch(e) {setStatus(e.message,'err');}
  finally {generateBtn.disabled=false;}
});
$('manualReviewBtn').addEventListener('click', async () => {
  if (generateBtn.disabled || !lastVRMA?.spec || !viewer.vrm) return;
  const original=lastVRMA.spec;
  const mode=authModeSelect.value, provider=mode==='ardy' ? $('ardyPlanner').value : mode==='api-key' ? 'openai' : mode;
  const key=provider==='claude' ? claudeApiKeyInput.value.trim() : apiKeyInput.value.trim();
  if(provider==='none') {setStatus(tr('「モーション生成に使うAI」で修正に使うAIを選んでください。'),'err');return;}
  if(provider==='codex' ? codexStatus?.account?.type!=='chatgpt' : !key) {setStatus(provider==='codex'?tr('Codexにログインしてください。'):tr('選択したAPIのキーを設定してください。'),'err');return;}
  const model=provider==='codex'?codexModelSelect.value:provider==='claude'?claudeModelSelect.value:apiCustomModelInput.value.trim()||apiModelSelect.value;
  const request=provider==='codex' ? (messages,_key,model,_delta,config)=>codexBridge.generateJson({messages,model,...config}) : provider==='claude' ? (messages,...args)=>callClaude(claudeReviewMessages(messages),...args) : callOpenAI;
  if(provider==='openai') setApiBase(apiBaseUrlInput.value);
  const locked=[...document.querySelectorAll('section.card,#playbackBar')];
  generateBtn.disabled=true; $('manualReviewBtn').disabled=true;
  correctionProgress=0;
  locked.forEach(el=>el.inert=true);
  try {
    const result=await directlyReviewMotion(original.originalText||original.name||textInput.value,original,{
      request,apiKey:key,model,force:true,visual:$('visualReviewCheck').checked,speed:$('reviewSpeed').value,
      skeleton:viewer.reviewSkeleton,inspect:(s,p,o)=>inspectMotion(viewer,s,p,o),compareImages:comparisonImages,
      onProgress:(message,details)=>{setStatus(message);showCorrectionProgress(message,details);}
    });
    showReview(result);
    $('reviewResults').showModal();
    setStatus(result.candidate?tr('修正版を比較画面で確認してください。'):tr('補正が得られませんでした。比較画面に理由を表示しています。'));
  } catch(e) {setStatus(tr('修正に失敗しました。元の動きは保持しています。{error}',{error:e.message}),'err');}
  finally {
    $('reviewProgress').classList.add('hidden');
    generateBtn.disabled=false; $('manualReviewBtn').disabled=false;
    $('manualReviewBtn').textContent=tr('この動きを修正');
    locked.forEach(el=>el.inert=false);
    void refreshCodexUsage();
  }
});
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
  $('manualReviewBtn').classList.toggle('hidden', !on);
  $('manualReviewBtn').disabled = !on;
  exportBtn.disabled = !on;
  gifBtn.disabled = !on;
  webmBtn.disabled = !on;
}
const apiKeyInput = $('apiKey');
const apiBaseUrlInput = $('apiBaseUrl');
const apiCustomModelInput = $('apiCustomModel');
const authModeSelect = $('authMode');
const apiSettings = $('apiSettings');
const claudeSettings = $('claudeSettings');
const claudeApiKeyInput = $('claudeApiKey');
const claudeModelSelect = $('claudeModelSelect');
const codexSettings = $('codexSettings');
const apiModelSelect = $('apiModelSelect');
const codexModelSelect = $('codexModelSelect');
const codexAuthState = $('codexAuthState');
const codexLoginBtn = $('codexLoginBtn');
const codexLogoutBtn = $('codexLogoutBtn');
const refineCheck = $('refineCheck');
refineCheck.addEventListener('change', renderAuthMode);
$('reviewSpeed').addEventListener('change', renderAuthMode);
const ardySettings = $('ardySettings');
const ardyState = $('ardyState');
const ardyUrlInput = $('ardyUrl');
const ardyStartBtn = $('ardyStartBtn');
const ardySetupBtn = $('ardySetupBtn');
const ardyDurationInput = $('ardyDuration');
const autoLengthCheck = $('autoLengthCheck');
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
  if (statusRenderer) setStatus(statusRenderer, statusKind);
  renderMotionChecks(window.__motionChecks);
  renderGenerationRoute(window.__motionPlanning);
  renderAuthMode();
  document.querySelector('.toggle-hint').textContent=tr(document.querySelector('.ai-settings-toggle').parentElement.open?'設定を閉じる':'設定を開く');
  if(latestReview) showReview(latestReview);
  if(latestCandidates) showCandidates(latestCandidates);
  void refreshCodexUsage();
  updateWaypointUI();
});
applyStaticI18n();

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

const apiSettingsHome = $('apiSettingsHome');
const ardyGptSlot = $('ardyGptSlot');
$('ardyPlanner').value = localStorage.getItem('ardy-planner') || 'none';
$('ardyPlanner').addEventListener('change', () => {
  localStorage.setItem('ardy-planner', $('ardyPlanner').value);
  renderAuthMode();
  if ($('ardyPlanner').value === 'codex') refreshCodexStatus();
});
function renderAuthMode() {
  const mode = authModeSelect.value;
  const codexMode = mode === 'codex' && Boolean(codexBridge);
  const ardyMode = mode === 'ardy';
  const claudeMode = mode === 'claude';
  // OpenAIキー+モデル選択は、api-keyモード(エンジン本体)でもARDYモード(任意の頭脳)でも使う。
  // ARDYモードでは同じ要素をARDYパネル内の「GPT (頭)」欄へ移動して見せる。
  // 復帰先は専用スロットに固定する。以前の #panel.insertBefore() は、#panel の
  // 子ではない codexSettings を referenceNode にしており NotFoundError になっていた。
  const planner = $('ardyPlanner').value;
  $('ardyLocalOnlyNote').classList.toggle('hidden',planner!=='none');
  for (const [element, home] of [[apiSettings, apiSettingsHome], [codexSettings, $('codexSettingsHome')], [claudeSettings, $('claudeSettingsHome')]]) {
    const slot = ardyMode ? ardyGptSlot : home;
    if (element.parentElement !== slot) slot.append(element);
  }
  apiSettings.classList.toggle('hidden', ardyMode ? planner !== 'openai' : codexMode || claudeMode);
  claudeSettings.classList.toggle('hidden', ardyMode ? planner !== 'claude' : !claudeMode);
  codexSettings.classList.toggle('hidden', ardyMode ? planner !== 'codex' : !codexMode);
  ardySettings.classList.toggle('hidden', !ardyMode);
  $('ardySmoothRow').classList.toggle('hidden',!ardyMode);
  // 経由地モード (セクション3) はARDYモード専用なので、それ以外では隠す
  $('waypointRow').classList.toggle('hidden', !ardyMode);
  refineCheck.parentElement.classList.remove('hidden');
  $('visualReviewCheck').disabled = ardyMode && planner === 'none';
  refineCheck.disabled = ardyMode && planner === 'none';
  $('reviewImageOption').classList.toggle('hidden', refineCheck.disabled);
  const visualEnabled = !$('visualReviewCheck').disabled && $('visualReviewCheck').checked;
  $('visualReviewNotice').classList.toggle('hidden', !visualEnabled);
  $('visualReviewNotice').textContent = tr('生成した動きの撮影画像を{provider}に送って確認します。',{provider:(ardyMode ? planner : mode)==='claude'?'Anthropic':'OpenAI'});
  $('reviewSpeedRow').classList.toggle('hidden', refineCheck.disabled);
  $('reviewModeNote').classList.toggle('hidden', !ardyMode || $('reviewSpeedRow').classList.contains('hidden'));
  $('reviewModeNote').textContent = { balanced: tr('AI計画は短時間。修正時は直接調整し、1回比較します。'), fast: tr('待ち時間を優先します。修正時はAIが指示を見直してARDYで再生成します。'), quality: tr('AIが生成前の動作計画をじっくり考えます。修正時も詳しく見直します（最大2回）。') }[$('reviewSpeed').value];
  if (ardyMode) checkArdyHealth();
  else cancelArdyHealthCheck();
}

// --- ARDYローカルエンジン ---
let ardyHealthController = null;

function isArdyMode() {
  return authModeSelect.value === 'ardy';
}

function cancelArdyHealthCheck() {
  ardyHealthController?.abort();
  ardyHealthController = null;
}

function setArdyState(message, kind = '') {
  ardyState.textContent = message;
  ardyState.className = `auth-state${kind ? ` ${kind}` : ''}`;
}

async function checkArdyHealth({ showFailure = true } = {}) {
  // ARDYを選択していない間は接続しない。切り替え直後に古い非同期応答が
  // 非表示のARDYパネルを書き換えることも防ぐ。
  if (!isArdyMode()) return false;
  cancelArdyHealthCheck();
  const controller = new AbortController();
  ardyHealthController = controller;
  const url = ardyUrlInput.value.trim().replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    const info = await res.json();
    if (controller.signal.aborted || !isArdyMode()) return false;
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
    if (controller.signal.aborted || !isArdyMode()) return false;
    // 起動待ちのポーリング中は、モデル初期化中の接続失敗で
    // 「未起動」表示や起動ボタンを一時的に復活させない。
    if (!showFailure) return false;
    if (window.ardyBridge) {
      // 未セットアップならボタンを「セットアップ」に切り替える (JSONを触らせない)
      const st = await window.ardyBridge.getStatus().catch(() => null);
      if (controller.signal.aborted || !isArdyMode()) return false;
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
  } finally {
    if (ardyHealthController === controller) ardyHealthController = null;
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

async function generateMotionWithArdy(text, { onProgress, refine = false } = {}) {
  const url = ardyUrlInput.value.trim().replace(/\/$/, '');

  // GPT (頭) がエンジン振り分けと生成計画を担当し、ARDY (体) が動きを作る。
  // キーがない・失敗した場合はエンジン内蔵のローカル翻訳にフォールバック
  let plan = null;
  let planCompletedAt = null;
  let plannerNote = '';
  const apiKey = (apiKeyInput.value || localStorage.getItem('openai-api-key') || '').trim();
  const provider = $('ardyPlanner').value;
  const gptModel = provider === 'codex' ? codexModelSelect.value : provider === 'claude' ? claudeModelSelect.value : apiCustomModelInput.value.trim() || apiModelSelect.value;
  const planningKey = provider === 'claude' ? claudeApiKeyInput.value.trim() : apiKey;
  const visual = refine && !$('visualReviewCheck').disabled && $('visualReviewCheck').checked;
  const correcting = provider !== 'none' && (refine || visual);
  const request = provider === 'codex'
    ? (messages, _key, model, _delta, config) => codexBridge.generateJson({ messages, model, ...config })
    : provider === 'claude' ? (messages, ...args) => callClaude(claudeReviewMessages(messages), ...args) : callOpenAI;
  if (provider === 'openai') setApiBase(apiBaseUrlInput.value);
  if (provider !== 'none') {
    try {
      if (provider === 'codex' && (!codexBridge || codexStatus?.account?.type !== 'chatgpt')) throw new Error('Codexにログインしてください');
      if (provider !== 'codex' && !planningKey) throw new Error('選択したAPIのキーが未設定です');
      onProgress?.(t('ardy.analyzing'));
      plan = await planArdySegments(text, planningKey, gptModel, {
        availableExpressions: viewer.reviewSkeleton?.availableExpressions,
        waypointCount: waypointCheck.checked ? waypoints.length : 0,
        pathMeters: waypointCheck.checked && waypoints.length ? waypointPathSeconds(waypoints) - 2 : 0,
        verify: false,
        effort: $('reviewSpeed').value === 'quality' ? 'high' : 'low',
        ...(provider === 'codex' ? { request: (messages, _key, model, _delta, config) => codexBridge.generateJson({ messages, model, ...config }) } :
          provider === 'claude' ? { request: callClaude } : {}),
      });
      console.log('[ARDY] GPT plan:', plan);
      planCompletedAt = new Date().toISOString();
    } catch (e) {
      if (correcting || e.code === 'ARDY_INVALID_PLAN') throw e;
      plannerNote = `動作計画を利用できないためローカル翻訳で生成: ${e.message}`;
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

  // Both passes are generated by ARDY; AI revises the generation instructions.
  onProgress?.(t('ardy.generating'));
  const body = plan?.segments?.length
    ? { segments: plan.segments.map((s) => ({ text: s.text, duration: s.duration })) }
    : { text };
  if (waypointsActive) body.waypoints = waypoints.map((w) => ({ x: w.x, z: w.z }));

  // 長さの手動指定。「自動補正」ONのときは秒数を固定せず、ARDYに自然な長さで
  // 生成させる (動作の数に見合った長さになり、詰め込みすぎを防ぐ)
  const manualDur = parseFloat(ardyDurationInput.value);
  const forceDur = Number.isFinite(manualDur) && manualDur > 0 && !autoLengthCheck.checked;
  if (forceDur) {
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
  function finalize(spec, expression = plan?.expression, expressionSegments = plan?.segments) {
  spec.planning={used:Boolean(plan),provider:plan?provider:'none',model:plan?gptModel:null,completedAt:planCompletedAt};
  if (plannerNote) spec.plannerNote = plannerNote;
  if (plan) spec.originalText = text;
  if (plan) spec.motionPlan = {segments:plan.segments,checks:plan.checks};

  // 自動判定時のループ既定値 (共通のon/off上書きは生成ハンドラ側で行う)
  spec.loop = isLoopFriendly(spec, text);
  if(loopSelect.value==='on')spec.loop=true;
  if(loopSelect.value==='off')spec.loop=false;
  // Preserve ARDY's ending pose. Forcing every leg joint to zero slid planted feet inward.
  // 秒数を固定する場合のみ全体を指定秒数へ補正する
  // (「自動補正」ONのときは固定せず、動きが自然に収まる長さのままにする)
  if (forceDur) rescaleSpec(spec, manualDur);
  // ARDYは表情を生成しないので自動付与する (GPTの感情判定があれば優先、
  // なければ原文の感情語からのキーワードマッチ)
  spec.expressions = autoExpressions(spec.originalText ?? text, spec.duration, expression, expressionSegments);
  return $('ardySmoothCheck').checked ? softenMotion(spec) : spec;
  }
  let spec;
  if($('ardyCandidateCount').value==='3') {
    const report=await generateArdyCandidates({count:3,
      generate:async seed=>finalize(await ardyGenerate({...body,seed})),
      inspect:motion=>inspectMotion(viewer,motion,{duration:motion.duration,phases:[{start:0,end:motion.duration,support:'none',targets:[]}]},{captureImages:false}),
      onProgress:(n,total,stage)=>{
        const message=tr(stage==='generate'?'候補 {n}/{total}をARDYで生成中…':'候補 {n}/{total}の足滑りを測定中…',{n,total});
        onProgress?.(message);
      }
    });
    for(const [index,entry] of report.entries.entries()) entry.spec.candidateInfo={index,seed:entry.seed,count:report.entries.length};
    showCandidates(report);spec=report.entries[report.selected].spec;
    $('reviewProgress').classList.add('hidden');
  } else spec = finalize(await ardyGenerate(body));
  if (!correcting) return spec;
  let result;
  const reviewer = $('reviewSpeed').value === 'fast' ? refineArdyMotion : directlyReviewMotion;
  try { result = await reviewer(text, spec, {
    request, apiKey: planningKey, model: gptModel, visual, skeleton: viewer.reviewSkeleton,
    speed: $('reviewSpeed').value, onProgress, onDraft: motion => playSpec(motion),
    plannerOptions: { waypointCount: waypointsActive ? waypoints.length : 0, pathMeters: waypointsActive ? waypointPathSeconds(waypoints) - 2 : 0 },
    inspect: (motion, reviewPlan, captureOptions) => inspectMotion(viewer, motion, reviewPlan, captureOptions),
    compareImages: comparisonImages,
    regenerate: async correction => {
      const sum = correction.segments.reduce((total, segment) => total + segment.duration, 0);
      const revisedBody = { ...body, duration: spec.duration, segments: correction.segments.map(segment => ({ text: segment.text, duration: segment.duration / sum * spec.duration })) };
      delete revisedBody.text;
      const revised = finalize(await ardyGenerate(revisedBody), correction.expression, correction.segments);
      rescaleSpec(revised, spec.duration);
      return revised;
    },
  });
  } catch (error) {
    spec.plannerNote = `修正を実行できなかったため初稿を採用: ${error.message}`;
    return spec;
  }
  showReview(result);
  if (result.error) result.spec.plannerNote = `${result.accepted ? '追加の修正を完了できなかったため、直前に採用した修正版を保持' : '修正に失敗したため初稿を採用'}: ${result.error}`;
  return result.spec;
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

let usageLoading = false;
let usageAccountEpoch = 0;
async function refreshCodexUsage() {
  if(authModeSelect.value!=='codex'&&!(authModeSelect.value==='ardy'&&$('ardyPlanner').value==='codex'))return;
  if (usageLoading || !codexBridge?.getUsage || codexStatus?.account?.type !== 'chatgpt') return;
  usageLoading = true;
  const epoch = usageAccountEpoch;
  $('codexUsageRefresh').disabled = true;
  try {
    const data = await codexBridge.getUsage();
    if (epoch !== usageAccountEpoch) return;
    renderUsage($('codexUsageRows'), data);
    $('codexUsageUpdated').textContent = tr('更新：{time}',{time:new Date().toLocaleTimeString()});
  } catch {
    if (epoch === usageAccountEpoch) $('codexUsageUpdated').textContent = tr('最新の使用量を取得できませんでした。表示済みの数値は前回取得時のものです。「更新」で再試行できます。');
  } finally {
    usageLoading = false;
    $('codexUsageRefresh').disabled = codexStatus?.account?.type !== 'chatgpt';
  }
}
$('codexUsageRefresh').addEventListener('click', refreshCodexUsage);
setInterval(() => {
  if (!document.hidden && $('codexUsage').getClientRects().length) refreshCodexUsage();
}, 60_000);

async function refreshCodexStatus(providedStatus) {
  if (!codexBridge) return;
  try {
    codexStatus = providedStatus || await codexBridge.getStatus();
    $('codexSetupHelp').classList.toggle('hidden', codexStatus.available && !codexStatus.updateRecommended);
    const account = codexStatus.account;
    if (!codexStatus.available) {
      setCodexAuthState(codexStatus.error || t('codex.unavailable'), 'err');
    } else if (account?.type === 'chatgpt') {
      const identity = maskEmail(account.email) || t('codex.account');
      setCodexAuthState(
        t('codex.loggedIn', { id: identity, plan: account.planType, ver: codexStatus.version }),
        'ok'
      );
      void refreshCodexUsage();
      await loadCodexModels();
    } else {
      setCodexAuthState(t('codex.loggedOut', { ver: codexStatus.version }));
      codexModelSelect.disabled = true;
    }
    codexLoginBtn.disabled = !codexStatus.available || account?.type === 'chatgpt';
    codexLogoutBtn.disabled = account?.type !== 'chatgpt';
  } catch (error) {
    codexStatus = { available: false, account: null };
    $('codexSetupHelp').classList.remove('hidden');
    setCodexAuthState(error.message, 'err');
    codexLoginBtn.disabled = true;
    codexLogoutBtn.disabled = true;
  }
  if (codexStatus?.account?.type !== 'chatgpt') {
    usageAccountEpoch++;
    $('codexUsageRows').replaceChildren();
    $('codexUsageUpdated').textContent = tr('ChatGPTでログインすると表示します。');
    $('codexUsageRefresh').disabled = true;
  }
}

async function initializeAuth() {
  const savedMode = localStorage.getItem('engine-order-v2') ? localStorage.getItem('openai-auth-mode') : 'ardy';
  localStorage.setItem('engine-order-v2', '1');
  if (!codexBridge) {
    authModeSelect.querySelector('option[value="codex"]')?.remove();
    authModeSelect.value = ['ardy', 'claude', 'api-key'].includes(savedMode) ? savedMode : 'ardy';
    renderAuthMode();
    return;
  }
  authModeSelect.value = ['codex', 'ardy', 'claude', 'api-key'].includes(savedMode) ? savedMode : 'ardy';
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

let statusRenderer = null;
let statusKind = '';
function setStatus(msg, kind = '') {
  statusRenderer = typeof msg === 'function' ? msg : null;
  statusKind = kind;
  if (statusRenderer) msg = statusRenderer();
  const playback=Boolean(msg?.playback);
  $('playbackCard').classList.toggle('hidden',!playback);
  if(playback){renderPlaybackStatus(msg);statusEl.textContent='';statusEl.className='hidden';return;}
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
  window.__motionPlanning=silent?null:spec.planning;
  renderGenerationRoute(window.__motionPlanning);
  window.__motionChecks=null;
  renderMotionChecks(null);
  if(!silent){
    if(spec.motionPlan?.checks?.length){
      try{
        const view=await inspectMotion(viewer,spec,{phases:[{start:0,end:spec.duration,support:'none',targets:[]}]},{captureImages:false});
        window.__motionChecks=view.compliance;
      }catch(error){console.warn('Motion measurements unavailable:',error);}
    }
    renderMotionChecks(window.__motionChecks);
  }
  lastVRMA = { spec, name: spec.name || 'motion' };
  setExportEnabled(true);
  if (silent) $('manualReviewBtn').classList.add('hidden');
  showPlaybackBar(!silent); // 待機モーション (silent) 以外は再生バーを表示
  if (!silent) {
    setStatus(
      () => ({playback:spec}),
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
    await playSpec(item.spec);
    lastVRMA = { spec: item.spec, name: item.name };
    setExportEnabled(true);
    showPlaybackBar(true);
    setStatus(() => ({playback:item.spec,text:item.text}), 'ok');
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
  const claudeApiKey = claudeApiKeyInput.value.trim();
  if (authMode === 'api-key' && !apiKey) {
    setStatus(t('err.noApiKey'), 'err');
    return;
  }
  if (authMode === 'claude' && !claudeApiKey) {
    setStatus(t('err.noClaudeKey'), 'err');
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
  // Keep the avatar, timing and playback stable while capture/review is in flight.
  latestReview = null;
  latestCandidates=null;window.__lastCandidates=null;$('candidateCompareBtn').classList.add('hidden');
  correctionProgress=0;
  window.__lastReview = null;
  $('reviewCompareBtn').classList.add('hidden');
  const lockedElements = [...document.querySelectorAll('section.card, #playbackBar')];
  for (const element of lockedElements) element.inert = true;
  waypointClearBtn.disabled = true;
  try {
    localStorage.setItem('openai-auth-mode', authMode);
    const options = {
      refine: refineCheck.checked,
      onProgress: (msg,details) => {setStatus(msg);showCorrectionProgress(msg,details);},
    };
    let spec;
    if (authMode === 'ardy') {
      setStatus(t('ardy.generating'));
      spec = await generateMotionWithArdy(text, options);
    } else {
      // api-keyモードはカスタムモデル入力があればそれを優先 (OpenAI互換プロバイダ対応)
      const customModel = apiCustomModelInput.value.trim();
      let model;
      if (authMode === 'codex') model = codexModelSelect.value;
      else if (authMode === 'claude') model = claudeModelSelect.value;
      else model = customModel || apiModelSelect.value;
      if (!model) throw new Error(t('err.noModel'));
      if (authMode === 'api-key') {
        localStorage.setItem('openai-api-key', apiKey);
        localStorage.setItem('openai-model', model);
        setApiBase(apiBaseUrlInput.value); // カスタムベースURL (空欄なら公式)
      } else if (authMode === 'claude') {
        localStorage.setItem('claude-api-key', claudeApiKey);
        localStorage.setItem('claude-model', model);
      }
      const engineLabel = authMode === 'codex' ? 'Codex' : authMode === 'claude' ? 'Claude' : 'OpenAI';
      setStatus(t('gen.llm', { engine: engineLabel, model }));
      if (authMode === 'codex') {
        if (refineCheck.checked && !$('visualReviewCheck').disabled && $('visualReviewCheck').checked) {
          const fixedDuration = !autoLengthCheck.checked && ardyDurationInput.value ? Number(ardyDurationInput.value) : undefined;
          if (fixedDuration !== undefined && (!Number.isFinite(fixedDuration) || fixedDuration < 1 || fixedDuration > 15)) throw new Error('画像レビューの長さは1〜15秒で指定してください');
          const result = await generateReviewedMotion(text, '', model, {
            speed: $('reviewSpeed').value, onDraft: motion => playSpec(motion),
            skeleton: viewer.reviewSkeleton, inspect: (motion, plan) => inspectMotion(viewer, motion, plan),
            duration: fixedDuration, loop: loopSelect.value === 'auto' ? undefined : loopSelect.value === 'on',
            onProgress: options.onProgress,
            request: (messages, _key, selectedModel, _delta, config) => codexBridge.generateJson({ messages, model: selectedModel, outputType: config?.outputType ?? 'motion', effort: config?.effort }),
          });
          spec = result.spec; showReview(result);
        } else {
          spec = await generateMotionWithCodex(text, model, options);
        }
      } else if (authMode === 'claude') {
        const progress = startLLMProgressBar();
        try {
          spec = await generateMotionWithClaude(text, claudeApiKey, model, {
            ...options,
            onFraction: progress.update,
          });
        } finally {
          progress.done();
        }
      } else {
        const progress = startLLMProgressBar();
        try {
          if (refineCheck.checked && !$('visualReviewCheck').disabled && $('visualReviewCheck').checked) {
            if (model !== 'gpt-6-astra' || apiBaseUrlInput.value.trim()) throw new Error('画像レビューは公式OpenAIのGPT-6 Astraを選択してください');
            const fixedDuration = !autoLengthCheck.checked && ardyDurationInput.value ? Number(ardyDurationInput.value) : undefined;
            if (fixedDuration !== undefined && (!Number.isFinite(fixedDuration) || fixedDuration < 1 || fixedDuration > 15)) throw new Error('画像レビューの長さは1〜15秒で指定してください');
            const result = await generateReviewedMotion(text, apiKey, model, {
              speed: $('reviewSpeed').value, onDraft: motion => playSpec(motion),
              skeleton: viewer.reviewSkeleton,
              inspect: (motion, plan) => inspectMotion(viewer, motion, plan),
              duration: fixedDuration,
              loop: loopSelect.value === 'auto' ? undefined : loopSelect.value === 'on',
              onProgress: options.onProgress,
            });
            spec = result.spec;
            showReview(result);
          } else {
            spec = await generateMotionWithOpenAI(text, apiKey, model, {
              ...options,
              onFraction: progress.update,
            });
          }
        } finally {
          progress.done();
        }
      }
      // 長さ指定を全エンジンで有効に: LLMキーフレームは生成後に目標秒数へリスケール
      // (「自動補正」ONのときは固定しない)
      const manualDur = parseFloat(ardyDurationInput.value);
      if (Number.isFinite(manualDur) && manualDur > 0 && !autoLengthCheck.checked) {
        rescaleSpec(spec, manualDur);
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
        () => ({playback:spec}),
        'ok'
      );
    } else if (authMode === 'ardy') {
      setStatus(
        () => ({playback:spec}),
        'ok'
      );
    }
    if (spec.plannerNote) {
      const message = statusEl.textContent;
      const render = statusRenderer ?? (() => message);
      setStatus(() => {const value=render();return value?.playback?{...value,note:spec.plannerNote}:`${value}\n${spec.plannerNote}`;}, 'ok');
    }
  } catch (e) {
    console.error(e);
    setStatus(t('error', { msg: e.message }), 'err');
  } finally {
    generateBtn.disabled = false;
    $('reviewProgress').classList.add('hidden');
    for (const element of lockedElements) element.inert = false;
    waypointClearBtn.disabled = false;
    void refreshCodexUsage();
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
  if (generateBtn.disabled) return;
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
  if (generateBtn.disabled) return;
  window.__motionChecks=null;
  renderMotionChecks(null);
  window.__motionPlanning=null;
  renderGenerationRoute(null);
  try {
    setStatus(t('file.loading', { name: file.name }));
    const buf = await file.arrayBuffer();
    await viewer.playVRMA(buf, true);
    showPlaybackBar(true);
    setStatus(() => t('file.playing', { name: file.name }), 'ok');
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
apiBaseUrlInput.value = localStorage.getItem('openai-base-url') ?? '';
apiCustomModelInput.value = localStorage.getItem('openai-custom-model') ?? '';
claudeApiKeyInput.value = localStorage.getItem('claude-api-key') ?? '';
const savedClaudeModel = localStorage.getItem('claude-model');
if (savedClaudeModel && [...claudeModelSelect.options].some((o) => o.value === savedClaudeModel)) {
  claudeModelSelect.value = savedClaudeModel;
} else {
  claudeModelSelect.value = DEFAULT_CLAUDE_MODEL;
}
apiBaseUrlInput.addEventListener('change', () => {
  localStorage.setItem('openai-base-url', apiBaseUrlInput.value.trim());
  setApiBase(apiBaseUrlInput.value);
});
apiCustomModelInput.addEventListener('change', () => {
  localStorage.setItem('openai-custom-model', apiCustomModelInput.value.trim());
});
setApiBase(apiBaseUrlInput.value); // 起動時に保存済みのベースURLを反映
refineCheck.checked = false;
function syncAutoLength() {
  autoLengthCheck.checked = ardyDurationInput.value.trim() === '';
}
syncAutoLength();
ardyDurationInput.addEventListener('input', syncAutoLength);
ardyDurationInput.addEventListener('change', syncAutoLength);
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
    // リモート由来の文字列 (remote) は textContent で入れる (innerHTMLに入れるとXSSになる)
    const msg = document.createElement('span');
    msg.textContent = t('update.msg', { v: remote, cur: pkg.version });
    const link = document.createElement('a');
    link.href = RELEASES_URL; // 定数 (リモート値ではない)
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = t('update.dl');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', () => {
      localStorage.setItem('update-dismissed', remote);
      banner.remove();
    });
    banner.append(msg, link, document.createTextNode(' '), close);
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
// ARDYの動作計画とローカルAPIにも、生成前から選択したモデルを反映する。
apiModelSelect.addEventListener('change', () => {
  localStorage.setItem('openai-model', apiCustomModelInput.value.trim() || apiModelSelect.value);
});
ardyUrlInput.addEventListener('change', () => {
  if (isArdyMode()) checkArdyHealth();
});

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
  if (authModeSelect.value === 'codex' || (authModeSelect.value === 'ardy' && $('ardyPlanner').value === 'codex')) refreshCodexStatus();
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

// --- ローカルHTTP API (デスクトップ版のみ・オプトイン) ---
const localApiBridge = window.localApiBridge;
const localApiRow = $('localApiRow');
const localApiEnable = $('localApiEnable');
const localApiPort = $('localApiPort');
const localApiState = $('localApiState');
const localApiTokenRow = $('localApiTokenRow');
const localApiToken = $('localApiToken');

function renderLocalApiStatus(status) {
  if (!status) return;
  localApiEnable.checked = status.running;
  localApiTokenRow.classList.toggle('hidden', !status.token);
  if (status.token) localApiToken.value = status.token;
  if (status.lastError) {
    localApiState.textContent = `❌ ${status.lastError}`;
    localApiState.className = 'auth-state err';
  } else if (status.running) {
    localApiState.textContent = t('localApi.running', { url: status.url });
    localApiState.className = 'auth-state ok';
  } else {
    localApiState.textContent = t('localApi.stopped');
    localApiState.className = 'auth-state';
  }
}

// サーバーは環境変数ではなくアプリの設定 (localStorage) からキーを受け取る。
// 利用者がアプリで設定済みのキーをそのままAPIでも使えるようにするため
function localApiConfig() {
  return {
    port: Number(localApiPort.value) || 8787,
    openaiApiKey: (localStorage.getItem('openai-api-key') || '').trim(),
    claudeApiKey: (localStorage.getItem('claude-api-key') || '').trim(),
    openaiBaseUrl: (localStorage.getItem('openai-base-url') || '').trim(),
    openaiModel: (localStorage.getItem('openai-model') || '').trim(),
    claudeModel: (localStorage.getItem('claude-model') || '').trim(),
  };
}

async function initLocalApi() {
  if (!localApiBridge) return; // ブラウザ版では出さない
  localApiRow.classList.remove('hidden');
  localApiPort.value = localStorage.getItem('local-api-port') || '8787';

  const status = await localApiBridge.getStatus().catch(() => null);
  renderLocalApiStatus(status);
  // 前回有効にしていたら復帰させる
  if (localStorage.getItem('local-api-enabled') === '1' && !status?.running) {
    renderLocalApiStatus(await localApiBridge.start(localApiConfig()));
  }

  localApiEnable.addEventListener('change', async () => {
    const enabled = localApiEnable.checked;
    localStorage.setItem('local-api-enabled', enabled ? '1' : '0');
    localApiState.textContent = t(enabled ? 'localApi.starting' : 'localApi.stopping');
    renderLocalApiStatus(enabled
      ? await localApiBridge.start(localApiConfig())
      : await localApiBridge.stop());
  });

  localApiPort.addEventListener('change', async () => {
    localStorage.setItem('local-api-port', String(Number(localApiPort.value) || 8787));
    if (!localApiEnable.checked) return;
    await localApiBridge.stop();
    renderLocalApiStatus(await localApiBridge.start(localApiConfig()));
  });

  $('localApiCopyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(localApiToken.value).catch(() => {});
    setStatus(t('localApi.copied'), 'ok');
  });

  $('localApiRegenBtn').addEventListener('click', async () => {
    renderLocalApiStatus(await localApiBridge.regenerateToken());
    setStatus(t('localApi.regenerated'), 'ok');
  });
}

initializeAuth();
initLocalApi();
init();
