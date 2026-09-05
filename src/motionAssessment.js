import { tr, locale } from './i18n.js';
export async function assessMotion(text, view, { request, apiKey, model, visual, speed }) {
  const originalRequest=request;
  request=(messages,...args)=>originalRequest(messages.map(m=>m.role==='system'?{...m,content:m.content+`\nWrite explanations in ${{ja:'Japanese',en:'English',zh:'Simplified Chinese',ko:'Korean'}[locale]}, overriding any earlier language instruction.`}:m),...args);
  const context=`元の指示:${text}\n測定:${JSON.stringify(view.metrics)}\n指示動作の位置チェック（参考）:${JSON.stringify(view.compliance)}\n実測位置:${JSON.stringify(view.trajectory??view.keyPositions)}\n動作の速度・加速度:${JSON.stringify(view.kinematics)}`;
  const raw=await request([
    {role:'system',content:'あなたはアニメーションの品質確認担当。修正に着手する前に、元の指示と動作データ・提供された画像から修正が必要か判定する。明確な違和感、指示違反、改善すべき動作があるときneeded:true。良好で具体的な問題を確認できなければfalse。判断材料が足りない場合はその旨をreasonに書き、品質保証はしない。形式:{needed:boolean,reason:日本語,issues:[時刻と部位を含む日本語の具体的指摘]}。自然なダンスの加速やジャンプを、数値が高いだけで問題扱いしない。JSONのみ。'},
    {role:'user',content:visual?[{type:'text',text:context},...view.images.map(url=>({type:'image_url',image_url:{url,detail:'high'}}))]:context},
  ],apiKey,model,undefined,{outputType:'assessment',effort:speed==='fast'?'low':speed==='balanced'?'medium':'high'});
  const result=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  if(typeof result.needed!=='boolean'||typeof result.reason!=='string'||!Array.isArray(result.issues)||result.issues.some(i=>typeof i!=='string')) throw new Error(tr('修正要否の判定形式が不正です'));
  return result;
}
