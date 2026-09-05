import { tr, locale } from './i18n.js';
import { planArdySegments } from './llm.js';
import { hasMetricRegression } from './motionReview.js';
import { assessMotion } from './motionAssessment.js';

// ARDY retains responsibility for dense motion and path following. AI revises its instructions.
export async function refineArdyMotion(text, draft, {
  request, apiKey, model, visual, inspect, regenerate, skeleton, plannerOptions = {},
  onProgress = () => {}, onDraft, speed = 'fast',
}) {
  await onDraft?.(draft);
  // No invented support contacts or target locations for an already generated motion.
  const plan = { duration: draft.duration, intent: text, phases: [
    { start: 0, end: draft.duration, support: 'none', targets: [], action: text },
  ], note: 'ARDYの支持脚・到達目標は未指定のため、滑りと到達誤差は未測定です。' };
  onProgress(tr('ARDYの初稿を再生中。生成した動きを測定しています…'));
  const before = await inspect(draft, plan);
  let candidate = null, after = null, error = null, accepted = false, correction = null, assessment = null;
  try {
    onProgress(tr('修正する前に、AIが修正の必要性を確認中…'));
    assessment = await assessMotion(text,before,{request,apiKey,model,visual,speed});
    if (!assessment.needed) return {model,speed,spec:draft,draft,candidate,before,after,plan:{...plan,correction},accepted,error,assessment};
    onProgress(visual ? tr('正面・側面画像をAIが確認し、ARDYへの修正指示を作成中…') : tr('動作データをAIが確認し、ARDYへの修正指示を作成中…'));
    const feedback = `${text}\nこれは既に生成したARDYモーションの修正です。元の動作・移動経路を保ち、不自然な部分のみ改善する英語の動作指示をsegmentsに返してください。予備動作・重心移動・視線・緩急を具体化。合計${draft.duration}秒。\n実寸骨格:${JSON.stringify(skeleton)}\n測定:${JSON.stringify(before.metrics)}\n実測関節位置:${JSON.stringify(before.keyPositions)}`;
    correction = await planArdySegments(feedback, apiKey, model, {
      ...plannerOptions, verify: false, effort: { fast: 'low', balanced: 'medium', quality: 'high' }[speed],
      request: (messages, ...args) => request(messages.map((message, i) => visual && i === messages.length - 1
        ? { ...message, content: [{ type: 'text', text: message.content }, ...before.images.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))] }
        : message), ...args),
    });
    if (!correction?.segments?.length) throw new Error(tr('修正指示を取得できませんでした'));
    onProgress(tr('ARDYで修正版を生成中（2パス目）…'));
    candidate = await regenerate(correction);
    after = await inspect(candidate, plan);
    accepted = !hasMetricRegression(before.metrics, after.metrics);
  } catch (e) { error = e.message; }
  return { model, speed, assessment, spec: accepted ? candidate : draft, draft, candidate, before, after,
    plan: { ...plan, correction }, accepted, error };
}

export function claudeReviewMessages(messages) {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map(part => {
      if (part.type !== 'image_url') return part;
      const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(part.image_url.url);
      if (!match) throw new Error(tr('画像形式が不正です'));
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }) : message.content }));
}
