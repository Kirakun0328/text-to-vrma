const test=require('node:test');
const assert=require('node:assert/strict');
const active=keys=>keys.filter(k=>k.w>0).map(k=>k.t);
test('restrained and intense emotion have different bounded strengths',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 const peak=text=>Math.max(...autoExpressions(text,6).angry.map(k=>k.w));
 assert.ok(peak('怒りを抑える')<peak('怒る'));
 assert.ok(peak('激しく怒る')>peak('怒る'));
 assert.ok(peak('激しく怒る')<=1);
});
test('gradual emotion builds later than a sudden reaction without changing duration',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 const ramp=autoExpressions('徐々に喜びがこみ上げる',6).happy;
 const burst=autoExpressions('突然喜ぶ',6).happy;
 assert.ok(ramp.find(k=>k.w>0).t>burst.find(k=>k.w>0).t);
 assert.equal(ramp.at(-1).t,6);assert.equal(burst.at(-1).t,6);
});
test('mixed emotions overlap but sequential emotions remain separate',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 for(const text of ['嬉しいけど照れる','A person is happy but shyly turns away.']){
  const result=autoExpressions(text,6);
  assert.ok(active(result.happy).some(t=>active(result.relaxed).includes(t)));
  assert.ok(Math.max(...result.happy.map(k=>k.w))+Math.max(...result.relaxed.map(k=>k.w))<=1);
 }
 const separate=autoExpressions('喜ぶ。その後、照れる',6);
 assert.ok(active(separate.happy).every(t=>t<3));
 assert.ok(active(separate.relaxed).every(t=>t>3));
});
test('VRM basic emotions and derived emotions use only supported bounded presets',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 const {EXPRESSION_PRESETS}=await import('../src/vrmaBuilder.js');
 for(const [text,presets] of [
  ['無表情で立つ',['neutral']],['嬉しそう',['happy']],['怒る',['angry']],['悲しそう',['sad']],['穏やか',['relaxed']],['驚く',['surprised']],
  ['怯える',['sad','surprised']],['不安そう',['sad','surprised']],['困惑する',['sad','surprised']],['嫌悪する',['angry','sad']],['眠そう',['relaxed']],['照れる',['relaxed']],
 ]){
  const tracks=autoExpressions(text,5);
  for(const preset of presets)assert.ok(tracks[preset],text+': '+preset);
  for(const [name,keys] of Object.entries(tracks)){
   assert.ok(EXPRESSION_PRESETS.includes(name));
   assert.ok(keys.every(k=>k.w>=0&&k.w<=1&&k.t>=0&&k.t<=5));
  }
 }
 assert.equal(autoExpressions('An interested person walks.',4).relaxed,undefined);
});
test('planned emotion changes use segment times instead of one global preset',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 const result=autoExpressions('怒ったあと喜ぶ',8,'happy',[
  {text:'A person looks angry.',duration:3},{text:'A person looks happy.',duration:1},
 ]);
 assert.ok(active(result.angry).every(t=>t>0&&t<6));
 assert.ok(active(result.happy).every(t=>t>6&&t<8));
 for(const keys of Object.values(result)){
  assert.equal(new Set(keys.map(k=>k.t)).size,keys.length);
  assert.ok(keys.every(k=>k.t>=0&&k.t<=8&&Number.isFinite(k.w)));
 }
});
test('pride changes to embarrassment within a connected gesture',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 const result=autoExpressions('得意げにポーズを決める。直後に照れて肩をすくめる。',8);
 assert.ok(active(result.happy).every(t=>t<4));
 assert.ok(active(result.relaxed).every(t=>t>4));
 assert.equal(Math.max(...result.relaxed.map(k=>k.w)),.35);
});
test('neutral dance does not force happiness and invalid duration produces no tracks',async()=>{
 const {autoExpressions}=await import('../src/autoExpressions.js');
 assert.equal(autoExpressions('その場でダンスする',4).happy,undefined);
 assert.deepEqual(autoExpressions('happy',NaN),{});
 assert.ok(autoExpressions('wave',4,'happy').happy);
});
