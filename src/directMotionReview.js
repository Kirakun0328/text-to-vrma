import { tr, locale } from './i18n.js';
import { EMOTION_ACTING_GUIDE } from './emotionActing.js';
import { hasComplianceRegression } from './motionCompliance.js';
import { applyMotionPatch, rotationDiagnostics } from './motionPatch.js';
import { hasMetricRegression } from './motionReview.js';
import { assessMotion } from './motionAssessment.js';
import { reviewSegments } from './segmentedReview.js';

const parse = raw => JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
const imageParts = images => images.map(url=>({type:'image_url',image_url:{url,detail:'high'}}));
// Preserve every sample while avoiding long floating-point tails in model input.
export const reviewJSON = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'number' && Number.isFinite(item) ? Number(item.toFixed(4)) : item);
const compactMotion = (spec, count = 20, bones = Object.keys(spec.tracks)) => Object.fromEntries(bones.map(bone=>{
  const keys=spec.tracks[bone];
  const chosen=keys.length<=count?keys:Array.from({length:count},(_,i)=>keys[Math.round(i*(keys.length-1)/(count-1))]);
  return [bone,chosen.map(k=>({t:Math.round(k.t*10000)/10000,r:k.r.map(v=>Math.round(v*10000)/10000)}))];
}));

export async function directlyReviewMotion(text, draft, {
  request, apiKey, model, visual, inspect, compareImages, skeleton, onProgress = ()=>{}, onDraft,
  speed = 'quality', force = false, seam = false,
}) {
  if(!Number.isFinite(draft.duration)||draft.duration<=0)throw new Error(tr('生成秒数が不正です'));
  const originalRequest=request;
  request=(messages,...args)=>originalRequest(messages.map(m=>m.role==='system'?{...m,content:m.content+EMOTION_ACTING_GUIDE+`\n修正時は、原文が求めた感情の強さや動作の大きさを消さない。測定・画像で判断できない感情は確認できたと断言しない。\nAll human-readable explanations MUST be in ${{ja:'Japanese',en:'English',zh:'Simplified Chinese',ko:'Korean'}[locale]}. This overrides earlier language instructions. Keep JSON field names unchanged.`}:m),...args);
  if (draft.duration > 15) return reviewSegments(text,draft,{request,apiKey,model,visual,inspect,compareImages,skeleton,onProgress,onDraft,speed,force},directlyReviewMotion);
  const start=performance.now();
  const effort = speed === 'quality' ? (/^gpt-6-astra(?:-|$)/.test(model)?'xhigh':'high') : speed==='fast'?'low':'medium';
  const plan={duration:draft.duration,intent:text,phases:[{start:0,end:draft.duration,support:'none',targets:[],action:text}],correction:null};
  await onDraft?.(draft);
  onProgress(tr('初稿を撮影・測定し、関節データをAstraの直接修正に渡しています…'),{stage:'capture'});
  let before=await inspect(draft,plan);
  if(!force) onProgress(tr('修正する前に、AIが修正の必要性を確認中…'),{stage:'assessment'});
  const assessment=force ? {needed:true,reason:tr('手動で修正が指定されたため、事前判定で省略せず修正を試します。'),issues:[]} : await assessMotion(text,before,{request,apiKey,model,visual,speed});
  let best=draft, bestView=before, candidate=null, after=null, accepted=false, error=null;
  const attempts=[];
  for(let round=0;assessment.needed && round<(speed==='quality'?2:1);round++) {
    try {
      onProgress(tr('直接修正 {n}：補正値を設計中…',{n:round+1}),{stage:'design',round:round+1,rounds:speed==='quality'?2:1});
      const prompt=`指示:${text}\n長さ:${draft.duration}秒、ループ:${draft.loop}。骨格:${reviewJSON(skeleton)}\n現在の関節回転（度、ローカルXYZ）:${reviewJSON(compactMotion(best))}\nQuaternion差から測った関節の角速度:${reviewJSON(rotationDiagnostics(best))}。Euler角の数値の飛びだけで問題と判断しないこと。\n実測関節位置:${reviewJSON(bestView.keyPositions)}\nサンプル軌道（tは秒）:${reviewJSON(bestView.trajectory)}\n20Hz測定の運動量:${reviewJSON(bestView.kinematics)}\n測定:${reviewJSON({physical:bestView.metrics,requestedActions:bestView.compliance})}\n前回の評価:${reviewJSON(attempts.at(-1)?.verdict??null)}`;
      const patch=parse(await request([
        {role:'system',content:`あなたは動作編集を行うアニメーター。日本語で問題箇所と改善案を説明し、元の密なキーフレームに加える局所的な補正JSONを返す。元のダンスや経路を保持し、足滑りを減らすために全身を停止させない。画像・実測データで裏付けられる問題に絞る。演技の予備動作、重心、視線、緩急、手首の硬さ、体幹の傾きのうち、実際に問題のある部分を選ぶ。\n形式:{summary:日本語,issues:[{start:秒,end:秒,bone:関節名,problem:日本語,change:日本語}],rotations:[{bone:既存関節名,keys:[{t:秒,r:[x,y,z]}]}],root:[{t:秒,p:[x,y,z]}]}。rotationsは元のローカル回転の後に合成する追加回転（度、XYZ）。各補正のベクトル長は最大30度。rootは元の腰移動への追加オフセット（メートル、最大0.08m）。最大12関節、各2〜12キー。各補正カーブは必ずt=0と最終秒のキーを含み、直したい区間の外はゼロへ滑らかに戻す。ループでは両端の値を一致させる。問題がない箇所の補正は空配列。接地の推定は不確実。飛び跳ね・しゃがみを勝手に消さない。JSONのみ。`},
        {role:'user',content:visual ? [{type:'text',text:prompt},...imageParts(bestView.images)] : prompt},
      ],apiKey,model,undefined,{outputType:'patch',effort}));
      // Keep segment boundaries identical to the source to avoid joining jumps.
      if (seam) {
        for (const rotation of patch.rotations ?? []) {
          if(rotation.keys?.length) {rotation.keys[0].r=[0,0,0];rotation.keys.at(-1).r=[0,0,0];}
        }
        if(patch.root?.length) {patch.root[0].p=[0,0,0];patch.root.at(-1).p=[0,0,0];}
      }
      const applied=applyMotionPatch(best,patch);
      const attempt={patch,changes:applied.changes,verdict:null,accepted:false};attempts.push(attempt);
      if(!applied.changes.changed) { attempt.verdict={improved:false,reason:tr('有効な補正値がなく、動きは変更されていません。'),resolvedIssues:[],remainingIssues:[]};break; }
      candidate=applied.spec;
      onProgress(tr('直接修正 {n}：補正を適用し、同じ画角・時刻で撮影中…',{n:round+1}),{stage:'apply',round:round+1,rounds:speed==='quality'?2:1});
      let framing=before.framing;
      if (framing?.times) {
        const times=[...new Set([...framing.times,...patch.issues.flatMap(issue=>[issue.start-0.1,issue.start,issue.start+0.1,(issue.start+issue.end)/2,issue.end-0.1,issue.end,issue.end+0.1])].map(t=>Math.max(0,Math.min(draft.duration,Math.round(t*1000)/1000))))].sort((a,b)=>a-b);
        framing={...framing,times:times.length<=24?times:Array.from({length:24},(_,i)=>times[Math.round(i*(times.length-1)/23)])};
        before=await inspect(draft,plan,{framing});
        bestView=best===draft?before:await inspect(best,plan,{framing});
      }
      after=await inspect(candidate,plan,{framing});
      const pairs=visual ? await compareImages(bestView,after) : [];
      onProgress(tr('直接修正 {n}：修正前後を再評価中…',{n:round+1}),{stage:'evaluate',round:round+1,rounds:speed==='quality'?2:1});
      const evaluation=`元の指示:${text}\n修正の意図:${reviewJSON(patch)}\n変更量:${reviewJSON(applied.changes)}\nA（今回の修正前）の測定:${reviewJSON({physical:bestView.metrics,requestedActions:bestView.compliance})}\nB（修正後）の測定:${reviewJSON({physical:after.metrics,requestedActions:after.compliance})}\nAのサンプル軌道（tは秒）:${reviewJSON(bestView.trajectory??bestView.keyPositions)}\nBのサンプル軌道（tは秒）:${reviewJSON(after.trajectory??after.keyPositions)}\nAの20Hz運動量:${reviewJSON(bestView.kinematics)}\nBの20Hz運動量:${reviewJSON(after.kinematics)}\nAの補正対象関節の実際のローカル回転:${reviewJSON(compactMotion(best,64,applied.changes.bones))}\nBの同関節の適用後回転:${reviewJSON(compactMotion(candidate,64,applied.changes.bones))}\nAのQuaternion差による角速度:${reviewJSON(rotationDiagnostics(best))}\nBのQuaternion差による角速度:${reviewJSON(rotationDiagnostics(candidate))}\n位置はメートル。最大速度・加速度・ジャークは離散計測。低い数値だけで改善とせず、元の動作やリズムを維持したか確認する。画像は問題区間の前後を重点撮影している。Euler角の数値差だけでなくQuaternion差の角速度で回転の急変を確認する。`;
      const verdict=parse(await request([
        {role:'system',content:'あなたは厳しいアニメーション比較レビュアー。Aは初稿、Bは修正候補。補正を書いた側の主張を信用せず、提供された比較画像と実測データで改善を確認する。原指示への忠実さ、自然さ、演技の魅力を総合してBが明確に良いと確認できたときだけimproved:true。差が分からない、動きが消えた、問題が悪化した、判断材料不足ならfalse。測定値が同じだけでは改善にならない。形式:{improved:boolean,reason:日本語,resolvedIssues:[日本語],remainingIssues:[日本語]}。改善した点と未解決点を具体的な秒数と部位で述べる。JSONのみ。'},
        {role:'user',content:visual ? [{type:'text',text:evaluation},...imageParts(pairs)] : evaluation},
      ],apiKey,model,undefined,{outputType:'verdict',effort}));
      if(typeof verdict.improved!=='boolean'||typeof verdict.reason!=='string'||!Array.isArray(verdict.remainingIssues)||!Array.isArray(verdict.resolvedIssues)) throw new Error(tr('比較評価の形式が不正です'));
      attempt.verdict=verdict;
      const regressed=hasMetricRegression(before.metrics,after.metrics)||hasMetricRegression(bestView.metrics,after.metrics)||hasComplianceRegression(before.compliance,after.compliance)||hasComplianceRegression(bestView.compliance,after.compliance);
      attempt.accepted=verdict.improved && !regressed;
      if(regressed) attempt.rejection=tr('測定値が悪化したため採用しませんでした。');
      if(attempt.accepted) {best=candidate;bestView=after;accepted=true;}
      // A rejected candidate is never used as the base of another patch.
      if(!attempt.accepted || !verdict.remainingIssues.length) break;
    } catch(e) {error=e.message;break;}
  }
  if(accepted) {candidate=best;after=bestView;}
  return {model,speed,mode:'direct',manual:force,assessment,spec:best,draft,candidate,before,after,accepted,error,
    plan:{...plan,correction:attempts.findLast(a=>a.accepted)?.patch??attempts.at(-1)?.patch??null},
    attempts,timing:{draftSeconds:0,totalSeconds:(performance.now()-start)/1000}};
}
