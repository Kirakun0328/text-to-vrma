import {tr} from './i18n.js';
const names={travel:'移動',jump:'両足ジャンプ',crouch:'腰を落とす',raiseHand:'手を顔付近まで上げる'};
export function motionCheckSummary(result){return tr('位置の確認：{passed}/{total}項目を検出',{passed:result.passed,total:result.total});}
export function renderGenerationRoute(planning){
 const node=document.getElementById('generationRoute');
 node.classList.toggle('hidden',!planning);
 if(!planning)return;
 const provider={codex:'Codex',openai:'OpenAI API',claude:'Claude API'}[planning.provider]??planning.provider;
 node.textContent=planning.used?tr('計画AI：{provider} / {model}',{provider,model:planning.model}) : tr('AI計画なし：ARDYの内蔵翻訳で生成');
 document.getElementById('playbackTime').textContent=planning.completedAt?tr('計画完了：{time}',{time:new Date(planning.completedAt).toLocaleTimeString()}):'';
}
export function renderPlaybackStatus(data){
 const spec=data.playback;
 document.getElementById('playbackTitle').textContent=tr('▶ モーション再生');
 const meta=document.getElementById('playbackMeta');meta.replaceChildren();
 for(const label of [tr('{seconds}秒',{seconds:spec.duration.toFixed(1)}),tr(spec.loop?'ループ再生':'1回再生'),...(spec.planning?['ARDY']:[])]){
  const badge=document.createElement('span');badge.textContent=label;meta.append(badge);
 }
 document.getElementById('playbackPrompt').textContent=[data.text??spec.originalText??spec.name,spec.flavor,data.note].filter(Boolean).join('\n');
 document.getElementById('playbackTime').textContent='';
 renderGenerationRoute(spec.planning);
}
export function renderMotionChecks(result){
 const panel=document.getElementById('motionCheckResults');
 panel.classList.toggle('hidden',!result?.total);
 if(!result?.total)return;
 document.getElementById('motionCheckSummary').textContent=motionCheckSummary(result);
 const rows=document.getElementById('motionCheckRows');rows.replaceChildren();
 for(const check of result.checks){
  const row=document.createElement('p');row.className='sub';
  const side=check.kind==='raiseHand'?` (${tr({left:'左',right:'右',both:'両方'}[check.side])})`:'';
  row.textContent=`${check.passed===null?'—':check.passed?'✓':'△'} ${check.start.toFixed(1)}–${check.end.toFixed(1)}s · ${tr(names[check.kind])}${side} · ${tr(check.passed===null?'未測定':check.passed?'検出':'未検出')}`;
  rows.append(row);
 }
}
