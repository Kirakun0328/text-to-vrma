import { tr, locale } from './i18n.js';
import { callOpenAI, SYSTEM_PROMPT, validateSpec } from './llm.js';
import { SKELETON } from './vrmaBuilder.js';
import { rescaleSpec } from './specMerge.js';

const xyz = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

export function validatePlan(plan) {
  if (!Number.isFinite(plan?.duration) || plan.duration < 1 || plan.duration > 15 ||
      !Array.isArray(plan.phases) || !plan.phases.length || plan.phases.length > 8) {
    throw new Error(tr('演技設計の形式が不正です'));
  }
  for (const phase of plan.phases) {
    if (!Number.isFinite(phase.start) || !Number.isFinite(phase.end) || phase.start < 0 ||
        phase.end <= phase.start || phase.end > plan.duration ||
        !['both', 'left', 'right', 'none'].includes(phase.support) ||
        !Array.isArray(phase.targets) || phase.targets.some(target =>
          !['leftHand', 'rightHand', 'leftFoot', 'rightFoot'].includes(target.bone) || !xyz(target.position))) {
      throw new Error(tr('演技設計の時間・支持脚・到達位置が不正です'));
    }
  }
  const phases = [...plan.phases].sort((a, b) => a.start - b.start);
  if (Math.abs(phases[0].start) > 0.001 || Math.abs(phases.at(-1).end - plan.duration) > 0.001 ||
      phases.some((p, i) => i && Math.abs(p.start - phases[i - 1].end) > 0.001)) {
    throw new Error(tr('演技設計のフェーズは全時間を隙間なく覆う必要があります'));
  }
  plan.phases = phases;
  return plan;
}

// Actual retargeted joint positions, sampled at 20 Hz. Contact is planned, not inferred.
export function measureMotion(samples, plan, rest) {
  let slide = 0, contactTime = 0, penetration = 0, targetError = 0, targetCount = 0;
  let estimatedSlide = 0, estimatedTime = 0;
  let lowSlide=0,lowTime=0;
  const lowHeight=Object.fromEntries(['leftFoot','rightFoot'].map(bone=>{
    const heights=samples.map(s=>s.positions[bone]?.[1]).filter(Number.isFinite).sort((a,b)=>a-b);
    return [bone,heights[Math.floor((heights.length-1)*.05)]];
  }));
  for (let i = 0; i < samples.length; i++) {
    const frame = samples[i];
    const phase = plan.phases.find(p => frame.t >= p.start && frame.t < p.end) ?? plan.phases.at(-1);
    for (const side of ['left', 'right']) {
      const bone = `${side}Foot`, p = frame.positions[bone];
      if (!p || !rest[bone]) continue;
      penetration = Math.max(penetration, rest[bone][1] - p[1]);
      const prev = samples[i - 1];
      if (prev?.positions[bone]) {
        const q = prev.positions[bone], dt = frame.t-prev.t;
        // A separate kinematic reference when rest-height contact cannot be established.
        // This is not evidence that the foot is touching the physical floor.
        if(dt>0 && p[1]<=lowHeight[bone]+.035 && q[1]<=lowHeight[bone]+.035 && Math.abs(p[1]-q[1])/dt<.2) {
          lowSlide+=Math.hypot(p[0]-q[0],p[2]-q[2]);lowTime+=dt;
        }
        // Independent of horizontal speed, so horizontal sliding is not excluded by definition.
        if (dt > 0 && Math.abs(p[1]-rest[bone][1]) < 0.035 && Math.abs(q[1]-rest[bone][1]) < 0.035 && Math.abs(p[1]-q[1])/dt < 0.2) {
          estimatedSlide += Math.hypot(p[0]-q[0],p[2]-q[2]);estimatedTime += dt;
        }
      }
      if (prev && prev.t >= phase.start && (phase.support === 'both' || phase.support === side)) {
        const q = prev.positions[bone];
        if (q) {
          slide += Math.hypot(p[0] - q[0], p[2] - q[2]);
          contactTime += frame.t - prev.t;
        }
      }
    }
  }
  for (const phase of plan.phases) {
    const nearest = samples.reduce((a, b) => Math.abs(a.t - phase.end) < Math.abs(b.t - phase.end) ? a : b);
    for (const target of phase.targets) {
      const p = nearest.positions[target.bone];
      if (p) { targetError += Math.hypot(...p.map((v, i) => v - target.position[i])); targetCount++; }
    }
  }
  return {
    plannedContactSlideMps: contactTime ? slide / contactTime : null,
    estimatedContactSlideMps: estimatedTime ? estimatedSlide / estimatedTime : null,
    lowFootHorizontalSpeedMps: lowTime ? lowSlide/lowTime : null,
    maxFootDropBelowRestM: Math.max(0, penetration),
    meanTargetErrorM: targetCount ? targetError / targetCount : null,
    note: '支持脚は計画による仮定。床貫通は足首の静止高との差による近似。身体衝突・物理安定性は未計測。',
  };
}

export function hasMetricRegression(before, after) {
  return ['plannedContactSlideMps', 'estimatedContactSlideMps', 'maxFootDropBelowRestM', 'meanTargetErrorM'].some(key =>
    Number.isFinite(before[key]) && Number.isFinite(after[key]) && after[key] > before[key] * 1.15 + 0.01);
}

export function measureKinematics(samples) {
  const result = {};
  for (const bone of ['hips','head','leftHand','rightHand','leftFoot','rightFoot']) {
    const positions = samples.filter(s=>s.positions[bone]).map(s=>({t:s.t,v:s.positions[bone]}));
    const derivative = values => values.slice(1).flatMap((b,i)=>{
      const a=values[i],dt=b.t-a.t;
      return dt>0 ? [{t:(a.t+b.t)/2,v:b.v.map((v,j)=>(v-a.v[j])/dt)}] : [];
    });
    const velocity=derivative(positions),acceleration=derivative(velocity),jerk=derivative(acceleration);
    const peak = values => values.length ? Math.max(...values.map(s=>Math.hypot(...s.v))) : null;
    result[bone]={peakSpeedMps:peak(velocity),peakAccelerationMps2:peak(acceleration),peakJerkMps3:peak(jerk)};
  }
  return result;
}

export async function generateReviewedMotion(text, apiKey, model, {
  skeleton, inspect, duration, loop, onProgress = () => {}, onDraft, speed = 'fast', request = callOpenAI,
}) {
  const originalRequest=request;
  request=(messages,...args)=>originalRequest(messages.map(m=>m.role==='system'?{...m,content:m.content+`\nWrite human-readable explanations in ${{ja:'Japanese',en:'English',zh:'Simplified Chinese',ko:'Korean'}[locale]}, overriding earlier language instructions. Keep JSON field names unchanged.`}:m),...args);
  if (typeof inspect !== 'function') throw new Error(tr('画像レビューにはVRMビューアが必要です'));
  const effort = { fast: 'low', balanced: 'medium', quality: 'high' }[speed];
  if (!effort) throw new Error(tr('速度設定が不正です'));
  const startTime = performance.now();
  const context = JSON.stringify({ actualAvatar: skeleton, exportSkeleton: SKELETON });
  const constraints = `指定秒数: ${duration ?? '自動(1〜15秒)'}。ループ: ${loop ?? '自動'}。`;
  onProgress(tr('1/4 演技設計：予備動作・重心・視線・支持脚を計画中…'));
  const plan = validatePlan(JSON.parse(await request([
    { role: 'system', content: `あなたはアニメーター。JSONのみ返す。ユーザーの動作を予備動作・本動作・余韻に設計する。
座標はメートル、+Y上、+Z正面、+Xキャラクター左。原点は開始時の床中央。targetsは各フェーズ終了時の世界座標。
骨格の実寸から到達可能な手足位置を設定。空中はsupport:none。接地中の支持足は動かさない。寝る・座る指示の終了姿勢を保持する。
形式: {duration:数値, intent:説明, ending:終了姿勢, phases:[{start:秒,end:秒,action:説明,anticipation:予備動作,weightShift:重心移動,gaze:視線,timing:緩急,support:both|left|right|none,targets:[{bone:leftHand|rightHand|leftFoot|rightFoot,position:[x,y,z]}]}]}。
phasesは時間全体を連続して覆う。各説明は簡潔に。最大8フェーズ。` },
    { role: 'user', content: `${text}\n${constraints}\n骨格: ${context}` },
  ], apiKey, model, undefined, { outputType: 'plan', effort })));
  if (duration && Math.abs(plan.duration - duration) > 0.001) {
    const ratio = duration / plan.duration;
    for (const phase of plan.phases) { phase.start *= ratio; phase.end *= ratio; }
    plan.duration = duration;
    validatePlan(plan);
  }
  const system = SYSTEM_PROMPT + '\n今回の追加規則: 以下の演技計画と実寸骨格を優先する。終了時に必ずニュートラルに戻す規則は適用せず、指示された終了姿勢を守る。改行とインデントを省いたコンパクトJSONのみ返す。' +
    (speed === 'fast' ? '\n速度優先。主役の関節に絞り、1ボーン最大8キー。予備動作・本動作・余韻は保つ。動かさないボーンは空配列。' : '');
  const prompt = `${text}\n${constraints}\n演技計画:${JSON.stringify(plan)}\n骨格:${context}`;
  const normalize = raw => {
    const spec = JSON.parse(raw);
    if (!Number.isFinite(spec.duration) || spec.duration <= 0 || spec.duration > 15) throw new Error(tr('生成秒数が不正です'));
    for (const keys of Object.values(spec.tracks ?? {})) {
      if (!Array.isArray(keys) || keys.some(k => !Number.isFinite(k?.t) || k.t < 0 || k.t > spec.duration || !xyz(k.r))) throw new Error(tr('生成キーフレームが不正です'));
      keys.sort((a, b) => a.t - b.t);
      if (keys.some((k, i) => i && k.t <= keys[i - 1].t)) throw new Error(tr('キーフレーム時刻が重複しています'));
    }
    if (spec.hips && (!Array.isArray(spec.hips) || spec.hips.some(k => !Number.isFinite(k?.t) || k.t < 0 || k.t > spec.duration || !xyz(k.p)))) throw new Error(tr('腰位置が不正です'));
    validateSpec(spec);
    rescaleSpec(spec, plan.duration);
    if (loop !== undefined) spec.loop = loop;
    return spec;
  };
  onProgress(tr('2/4 骨格と到達位置に合わせてポーズを生成中…'));
  const draft = normalize(await request([{ role: 'system', content: system }, { role: 'user', content: prompt }], apiKey, model, undefined, { effort }));
  const draftSeconds = (performance.now() - startTime) / 1000;
  await onDraft?.(draft);
  onProgress(tr('3/4 修正前を正面・側面から撮影し、接地と到達位置を測定中…'));
  const before = await inspect(draft, plan);
  let candidate = null, after = null, error = null, accepted = false;
  try {
    onProgress(tr('4/4 初稿を再生中。画像と測定値を見て修正中（追加1回）…'));
    candidate = normalize(await request([
      { role: 'system', content: system },
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify(draft) },
      { role: 'user', content: [
        { type: 'text', text: `実際のVRMの正面・側面コマ送り画像です。各コマに秒数があります。元の指示への忠実さ、予備動作、視線、緩急、手足の位置を評価して修正してください。問題のない区間は維持。測定値は近似であり点数を下げるため動きを消さないこと。完全なモーションJSONのみ返す。\n測定:${JSON.stringify(before.metrics)}\n主要時刻の実測位置:${JSON.stringify(before.keyPositions)}` },
        ...before.images.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
      ] },
    ], apiKey, model, undefined, { effort }));
    onProgress(tr('修正後を再描画して比較中…'));
    after = await inspect(candidate, plan);
    accepted = !hasMetricRegression(before.metrics, after.metrics);
  } catch (e) { error = e.message; }
  return { model, speed, timing: { draftSeconds, totalSeconds: (performance.now() - startTime) / 1000 }, spec: accepted ? candidate : draft, draft, candidate, plan, before, after, accepted, error };
}
