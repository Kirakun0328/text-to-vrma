import { tr } from './i18n.js';
import { motionCheckSummary } from './motionCheckPanel.js';

export function renderCandidatePanel(report,{preview,adopt}) {
  const rows=document.getElementById('candidateRows');rows.replaceChildren();
  document.getElementById('candidateError').textContent=[report.metric==='lowFootHorizontalSpeedMps'?tr('接地を判定できないため、低い位置にある足の横移動を参考に比較しています。'):null,report.error?tr('追加候補の生成に失敗しました。生成済みの候補を保持しています。')+` ${report.error}`:null].filter(Boolean).join('\n');
  const reasons={eligible:'測定値による比較対象',unmeasured:'測定不足のため自動選択しません',duration:'長さが異なるため自動選択しません',regression:'測定値が悪化したため自動選択しません',activity:'動きが大幅に減ったため自動選択しません'};
  for(const [index,entry] of report.entries.entries()) {
    const row=document.createElement('div');row.className='candidate-row';row.classList.toggle('selected',index===report.selected);
    const title=document.createElement('strong');title.textContent=tr('候補 {n}',{n:index+1})+(index===report.selected?` · ${tr('選択中')}`:'');
    const metrics=document.createElement('p');metrics.className='sub';
    const value=n=>Number.isFinite(n)?(n*100).toFixed(2):tr('未測定');
    metrics.textContent=[tr('推定接地中の滑り：{value}',{value:value(entry.view.metrics.estimatedContactSlideMps)+' cm/s'}),
      ...(entry.view.compliance?.total?[motionCheckSummary(entry.view.compliance)]:[]),
      ...(report.metric==='lowFootHorizontalSpeedMps'?[tr('低い位置にある足の横移動（参考）：{value}',{value:value(entry.view.metrics.lowFootHorizontalSpeedMps)+' cm/s'})]:[]),
      tr('足首の沈み込み（近似）：{value}cm',{value:value(entry.view.metrics.maxFootDropBelowRestM)}),tr(reasons[report.decisions[index].reason]),`Seed: ${entry.seed}`].join('\n');
    const actions=document.createElement('div');actions.className='inline';
    const play=document.createElement('button');play.className='btn-soft';play.textContent=tr('再生して確認');play.onclick=()=>preview(index);
    const use=document.createElement('button');use.className='btn-blue';use.textContent=tr('この候補を使う');use.onclick=()=>adopt(index);
    actions.append(play,use);row.append(title,metrics,actions);rows.append(row);
  }
}
