// Shared directing rules for generation and review. These are acting cues, not
// a claim that the generated body motion has been semantically verified.
export const EMOTION_ACTING_GUIDE = `
# 感情を身体の演技にする
感情語を表情ウェイトだけで処理しない。顔の表情を隠しても、姿勢・動く部位・速度変化から読み取れる演技を設計する。
最優先はユーザーの動作・強さ・左右・回数・姿勢・禁止事項。以下は指示を具体化する例であり、必ず全部を追加する規則ではない。
- 喜び: 胸が開く、顔が上がる、腕が外へ開く、軽い弾みなどで喜びの高まりを示す。
  「静かに喜ぶ」は小さく胸を起こして拳を寄せる程度。「大喜び・大はしゃぎ」は大きな腕の動きと体の弾み。
  跳ぶ指定がない限り、必ずジャンプする演技にはしない。
- 怒り: 肩・腕の緊張、前へ向く上体、鋭い動き出しと止めで示す。
  「怒ってジタバタ」は足を踏み鳴らす・腕を振り回す等の全身動作。「静かに怒る」は抑えた姿勢と緊張で区別。
  怒りだけで殴る・蹴る・暴れるを追加しない。座位・臥位や固定する手足の指定を守る。
- 哀しみ: 肩と胸が落ちる、顔が下がる、腕の力が抜ける、重心が沈む、動き出しが遅れる等で重さを示す。
  泣く・すすり泣く指定なら肩や胸の短い震えを伴う呼吸。「悲しい」だけで顔を覆う・床へ倒れるを追加しない。
- 楽しさ: 力みの少ない左右の重心移動、弾むリズム、腕と上体の自然な追従で示す。
  喜びの一度の高まりと、楽しさの持続するリズムを区別する。勝手にダンスや歩行へ変えない。
- 驚き・照れ: 驚きは短い反応と回復、照れは肩や顔の小さな向きの変化など。明示された動作を保つ。
- 標準・無表情: 勝手な笑顔や大きな感情動作を足さず、指示された動作を淡々と行う。
- 不安・恐怖: 不安は胸や肩の控えめな緊張とためらう動き。恐怖は身をすくめる・上体を引く等で区別。
  逃げる指示がなければ勝手に走り去らない。震えは小さく、全身の高速振動で代用しない。
- 困惑: 顔や上体のためらう向きの変化、短い間を置く動き。首を傾げる等は指定動作と矛盾しない範囲で。
- 嫌悪・うんざり: 顔や上体を対象からそらす、距離を取るような上体の引き等。怒りの暴れる動作と区別。
- 眠気: 頭や肩がゆっくり落ちる、遅い姿勢の立て直し等。指定なしに倒れたり座ったりしない。
VRM標準の感情表情は happy / angry / sad / relaxed / surprised / neutral。
照れ・恐怖・不安・困惑・嫌悪・眠気には共通の専用プリセットがないため、身体演技を主とし、
表情は標準プリセットの弱い組み合わせで近似する。存在しない blush / fear / confused 等の表情トラックを作らない。
基本表情の形はアバターごとに異なる。モデルにない表情を作成済みとみなさない。
感情の強さを読み分ける。激しい動作に gentle / subtle / small / calm を一律に加えない。
悲しみの遅さ・怒りの鋭さを、単調な「滑らかさ」で消さない。自然さは常に弱く動くことではない。
原文の感情が途中で変わるなら身体の演技も順番に変化させる。ただし感情の変化だけを理由に一続きの動作を分割しない。
感情の演技では次の情報を原文から読み取り、指定されたものだけ短い身体動作へ落とし込む:
- 強度: 控えめ・普通・強い・抑えている。大きさだけでなく、筋肉の緊張と加速・減速を変える。
- 時間変化: 徐々にこみ上げる、突然あふれる、抑える、余韻が残る。すべてを開始直後から最大にしない。
- 連動: 顔や胸の反応を腕が追う等、動作に合う自然なわずかな時間差。全部位を同時に同じ速さで動かさない。
  足の接地は保ち、時差をつけるために支持脚を滑らせない。指示が同時動作なら同時を優先。
- 混合: 「嬉しいけど照れる」は嬉しさを含む控えめな開きと、顔や肩のためらいが同時にある。
  「喜んだあと照れる」は順番に変わる。混合と時系列を混同せず、感情ごとに別モーションへ分割しない。
- 関係性: 相手・物を見る、近づく、離れるは原文にある場合に反映する。対象や歩行を勝手に追加しない。
英文は1セグメントにつき主要動作と重要な感情の手掛かりを1〜2文にまとめる。
全項目を羅列して長文化しない。弱い感情や複雑な心情を主動作の省略の理由にしない。
例: A person gradually brightens with joy, lifting their head and chest before their arms softly open.
例: A person holds back their anger, keeping their arms close with tense shoulders and restrained movements.
例: A person feels happy but shy, opening their chest slightly while bashfully turning their face aside.
終了時もユーザーが求めた姿勢を守り、勝手に笑顔・直立・リラックスで締めない。
ARDY向け英文は感情形容詞に加え、身体の具体的動詞と強さを簡潔に含める。例:
喜び: A person joyfully opens their arms, lifts their chest and makes a buoyant upward body movement.
怒りのジタバタ: A person throws an angry tantrum, repeatedly stamping their feet and flailing both arms with forceful, irregular movements.
哀しみ: A person slowly slumps their shoulders and chest, lowers their head and lets their arms hang heavily in sadness.
楽しさ: A person playfully sways from side to side with a light, relaxed rhythm, their arms following the body movement.
`;

// Text cues provide an approximate expression envelope; no extra model call or
// body-track retiming. The body acting is directed through the shared guide above.
export function emotionDynamics(text) {
  const restrained=/抑え|抑える|こらえ|堪え|控えめ|静かに|少しだけ|\b(?:restrained|subdued|slightly|quietly)\b|holds? back/i.test(text);
  const strong=/大喜び|大はしゃぎ|激怒|激しく|猛烈|強く|\b(?:furious|intensely|overjoyed|forceful)\b/i.test(text);
  const gradual=/徐々に|だんだん|こみ上げ|込み上げ|次第に|\b(?:gradually|builds?|wells?)\b/i.test(text);
  const sudden=/突然|一気に|ぱっと|爆発|\b(?:suddenly|bursts?|abruptly)\b/i.test(text);
  return {strength:restrained?.5:strong?1.3:1,peakAt:gradual?.7:sudden?.12:null};
}
