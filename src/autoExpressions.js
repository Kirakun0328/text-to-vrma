// autoExpressions.js — プロンプトの感情語から表情トラックを自動生成する
// (ARDYモード用: ARDYはボーンモーションのみで表情を作らないため、ここで補う)
import { emotionDynamics } from './emotionActing.js';

// 感情語 → VRM表情プリセット。上から順に最初にマッチした1つを採用
const EMOTION_RULES = [
  { re: /neutral|expressionless|無表情|真顔|標準の表情|面无表情|무표정/i, preset: 'neutral', weight: 1 },
  { re: /happy|joy|smil|laugh|cheer|excit|celebrat|proud|confident|嬉し|うれし|楽し|たのし|笑|喜|わーい|やった|得意げ|誇らし/i, preset: 'happy', weight: 0.7 },
  { re: /sad|cry|sob|depress|gloomy|悲し|かなし|泣|涙|しょんぼり|落ち込|うつむ/i, preset: 'sad', weight: 0.7 },
  { re: /angry|mad|furious|rage|stomp|怒|おこ|イライラ|憤|キレ/i, preset: 'angry', weight: 0.7 },
  { re: /surpris|shock|astonish|startl|驚|おどろ|びっくり|ビックリ|仰天|惊讶|놀라/i, preset: 'surprised', weight: 0.8 },
  { re: /relax|calm|\brest(?:s|ing|ed)?\b|sleep|drowsy|yawn|stretch|リラックス|くつろ|眠|ねむ|あくび|伸び|穏やか|困倦|졸리/i, preset: 'relaxed', weight: 0.6 },
  { re: /embarrass|bashful|shyly|照れ|恥ずかし|はにか/i, preset: 'relaxed', weight: 0.35 },
  { re: /afraid|fearful|scared|frighten|terrifi|怯え|おびえ|怖が|恐怖|害怕|두려|무서/i, preset: 'sad', weight: .45, blend: {surprised:.3} },
  { re: /anxious|worried|nervous|不安|心配|緊張|焦虑|担心|불안|걱정/i, preset: 'sad', weight: .35, blend: {surprised:.15} },
  { re: /confus|puzzl|perplex|困惑|戸惑|とまど|困って|困り|疑問|迷茫|困惑|당황|혼란/i, preset: 'sad', weight: .25, blend: {surprised:.2} },
  { re: /disgust|disdain|嫌悪|嫌が|うんざり|呆れ|厌恶|싫어|혐오/i, preset: 'angry', weight: .35, blend: {sad:.2} },
];

const BLINK_INTERVAL = 3.2; // 秒
const BLINK_CLOSE = 0.08;   // 閉じるのにかかる時間

/**
 * プロンプトとモーション長から表情トラックを作る。
 * @param {string} text 原文プロンプト (日本語/英語)
 * @param {number} duration モーション長 (秒)
 * @param {string|null} [forcedPreset] GPT等が判定した表情プリセット (キーワードより優先)
 * @returns {{ [preset: string]: {t:number,w:number}[] }}
 */
export function autoExpressions(text, duration, forcedPreset = null, segments = []) {
  const expressions = {};
  if (!Number.isFinite(duration) || duration <= 0) return expressions;
  // Use planned segment timing. Within a segment, textual transitions are only an
  // approximate timing cue; they are not measured emotion recognition.
  const validSegments=segments.filter(s=>typeof s?.text==='string'&&Number.isFinite(s.duration)&&s.duration>0);
  const source=validSegments.length?validSegments:[{text,duration}];
  const total=source.reduce((sum,s)=>sum+s.duration,0);
  const phases=[];let offset=0;
  for(const segment of source){
    const clauses=segment.text.split(/(?:[。.!;；]|\bthen\b|\bafterwards\b|その後|直後|最後|それから)/i).map(s=>s.trim()).filter(Boolean);
    const span=segment.duration/total*duration;
    for(const [i,clause] of clauses.entries()){
      const matches=EMOTION_RULES.map(rule=>({rule,index:clause.search(rule.re)})).filter(m=>m.index>=0).sort((a,b)=>a.index-b.index);
      const mixed=matches.length>1&&/けど|けれど|ながら|つつ|\b(?:but|yet|while)\b/i.test(clause)&&matches[0].rule.preset!=='neutral';
      phases.push({start:offset+span*i/clauses.length,end:offset+span*(i+1)/clauses.length,rule:matches[0]?.rule,secondary:mixed?matches[1].rule:null,dynamics:emotionDynamics(clause)});
    }
    offset+=span;
  }
  if(!phases.some(p=>p.rule)){
    const rule=EMOTION_RULES.find(r=>r.preset===forcedPreset)??EMOTION_RULES.find(r=>r.re.test(text));
    if(rule)phases.splice(0,phases.length,{start:0,end:duration,rule,dynamics:emotionDynamics(text)});
  }
  for(const phase of phases){
    if(!phase.rule)continue;
    const {start,end,rule,secondary,dynamics}=phase,fade=Math.min(.35,(end-start)*.25);
    const weights={};
    for(const [part,share] of secondary?[[rule,.65],[secondary,.35]]:[[rule,1]]){
      for(const [preset,weight] of Object.entries({[part.preset]:part.weight,...part.blend}))weights[preset]=(weights[preset]??0)+weight*share*(preset==='neutral'?1:dynamics.strength);
    }
    const sum=Object.values(weights).reduce((a,b)=>a+b,0),scale=1/Math.max(1,sum);
    const peak=dynamics.peakAt===null?start+fade:start+(end-start)*dynamics.peakAt;
    for(const [preset,rawWeight] of Object.entries(weights)){
      const weight=rawWeight*scale;
      const keys=expressions[preset]??=[{t:0,w:0}];
      keys.push({t:start,w:0},{t:peak,w:weight},{t:end-fade,w:weight},{t:end,w:0});
    }
  }
  for(const [preset,keys] of Object.entries(expressions)){
    keys.push({t:duration,w:0});
    expressions[preset]=[...new Map(keys.map(k=>[k.t,k])).values()].sort((a,b)=>a.t-b.t);
  }

  // まばたき: 一定間隔で閉じる (最初と最後の0.5秒は避ける)
  const blink = [{ t: 0, w: 0 }];
  for (let t = BLINK_INTERVAL; t < duration - 0.5; t += BLINK_INTERVAL) {
    blink.push(
      { t: t - BLINK_CLOSE, w: 0 },
      { t, w: 1 },
      { t: t + BLINK_CLOSE, w: 0 },
    );
  }
  if (blink.length > 1) expressions.blink = blink;

  return expressions;
}
