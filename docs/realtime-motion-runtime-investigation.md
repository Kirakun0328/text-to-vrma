# リアルタイムモーション生成アーキテクチャ 調査レポート

> 2026-09-21追記: 以下は当時の調査・候補案の記録です。現在はユーザーの希望に合わせ、
> 毎回の新規生成を採用し、この文書中のキャッシュ／固定モーションライブラリ案は導入していません。
> 総合信頼度による生成ゲートも使用しません。現行の接続と確認範囲は
> [Jevの生成経路への接続](jev-generation-integration.md) を参照してください。

調査日: 2026-09-19
スコープ: 現状パイプラインの実測ボトルネック分析と、AIキャラクターのリアルタイム会話用途に向けた
アーキテクチャ提案。**このレポートの範囲ではコード変更を行っていない。**

## TL;DR

- **Jevは「判断」を速くするが「生成」は速くしない。** 生成のボトルネックはLLMのJSON生成
  (数秒〜数十秒) と ARDYのGPU拡散生成 (実測で最短でも約4秒、長い動きは30秒以上) にあり、
  JS側の後処理・VRMA変換は無視できるレベル (1件あたり1〜2ミリ秒未満) だった。
- **単発の生成をどれだけ最適化しても、会話向けの「即座の反応」(数百ms) には原理的に届かない。**
  これは実測値からの結論であり、Jev統合だけで解決しないという前提は正しい。
- **重要な発見**: ARDYエンジン (`tools/ardy-engine/server.py`) には既に
  `POST /generate-stream` というNDJSONストリーミング生成エンドポイントが実装済みだが、
  **Text-To-VRMA側 (`src/apiServer.js` / `src/main.js`) は一度も呼び出していない。**
  実測したところ、ストリーミングは「長い動きの体感時間」を約1/3に縮めるが、
  最初のチャンクが届くまでにも約9.7秒かかっており、**<500msの初動反応には使えない**。
  → 初動の速さは生成方式の改善では達成できず、**事前生成・キャッシュ済みモーションの
  即時再生**でしか実現できない、という結論を裏付けるデータになった。
- 推奨は、ユーザー提案どおりの **Hybrid Architecture (Option C)**: Jevで即座に
  キャッシュ済み/事前生成モーションを再生しつつ、裏でLLM+ARDYの詳細モーションを非同期生成し、
  間に合えば差し替え・間に合わなければ破棄してキャッシュに保存する方式。
- 複数モーションを跨いで自然に繋ぐ機能 (`src/specMerge.js` の `mergeSequentialSpecs`) は
  **既に実装済みで未使用**。Motion Primitive合成の土台としてそのまま使える。
- 永続的なモーションキャッシュ/ライブラリは**現状まったく存在しない** (`history` はセッション内
  メモリ配列のみ)。Embedding DBのような重い依存を入れる前に、まず単純なメタデータ
  (emotion/reaction/intensity + キーワード) によるルールベース検索から始めるべき規模感。

---

## 1. 計測方法・環境

- ARDYエンジン: `ARDY-Core-RP-20FPS-Horizon40`、GPU = NVIDIA GeForce RTX 5070 Ti Laptop
  (12GB VRAM、計測時使用率17%・温度58℃、サーマルスロットリングなし)。
- `POST /generate` / `POST /generate-stream` に対し `curl` および Node の `fetch` で直接
  リクエストを送り、`time_total` およびサーバーログの `timing: generate=...s finalize=...s
  (Nf, Msteps)` 行を突き合わせて計測。
- JS側 (`buildVRMA` / `autoExpressions` / `isLoopFriendly` / `rescaleSpec`) は実際にARDYが
  返したspecを使い、Node上で20回反復のマイクロベンチマークを実施。
- **LLM (GPT-6 Astra / Claude) 側は実APIキーが無く直接計測できていない。** 本レポートの
  当該箇所は実測ではなく、コード上の根拠 (thinking modeのmax_tokens設定、2パス自己修正の
  有無、進捗バーEMAの初期値) からの推定であることを明記する。実測が必要なら次のアクション
  項目 (§9) を参照。

---

## 2. 実測結果

### 2.1 ARDY `/generate` (非ストリーミング、現状の唯一の呼び出し方)

| リクエスト内容 | フレーム数 (20fps) | 動き秒数 | `generate`実測時間 | 1フレームあたり |
|---|---|---|---|---|
| "A person nods." | 20f | 0.95s | 4.2s | 210ms |
| "A person nods once." | 28f | 1.35s | 4.1s | 146ms |
| "A person waves at the camera." | 60f | 2.95s | 9.1〜9.2s | 153ms |
| 3セグメント連結 (歩く→跳ぶ→手を振る) | 140f | 6.95s | 17.5s | 125ms |
| "A person dances energetically." | 160f | 7.95s | 29.8s | 186ms |
| 誤エンコードされた和文 (参考値・外れ値) | 360f | 17.95s | 114.7s | 319ms |

観測事実:

- **固定オーバーヘッドが大きい**: わずか1秒未満の「うなずく」でも4.2秒かかる。テキスト
  エンコード・翻訳判定・CUDAカーネル初期化などの固定コストが支配的な領域がある。
- 同一リクエストを2回送っても速度は変わらない (ARDY側に結果キャッシュは無い)。
- 複数セグメント連結 (`_generate_stitched`) はセグメントごとに独立生成して縫い合わせる
  実装のため、セグメント数を増やしても合計フレーム数が同じならコストはほぼ同水準
  (140f=17.5s と 160f=29.8s の逆転が示す通り、フレーム数以外の変動要因 — GPU側の
  ウォームアップ状態や生成内容 — によるブレも無視できない)。
- 長尺の外れ値 (360f) は明らかに1フレームあたりコストが増えているが、サーバーコード内の
  コメント (`server.py` L327-331) によれば、単一セグメントの自己回帰生成は意図的に
  「履歴+1ホライズン」だけを処理して線形コストになるよう設計されている。今回の外れ値は
  誤エンコード入力によるものでもあり、実行順序 (直前のリクエストの余熱) 由来のブレの
  可能性もある。**きれいな二次関数的劣化と断定はしない。**

### 2.2 ARDY `/generate-stream` (NDJSONストリーミング、既存だが未使用)

`tools/ardy-engine/server.py` の `_handle_generate_stream` / `_generate_motion_streaming`
を発見。1本のHTTPレスポンスを `application/x-ndjson` で返し、
`{"type":"meta",...}` → `{"type":"chunk","tracks":...,"hips":...}` × N →
`{"type":"final","spec":...}` の順にフレーム断片を逐次送信する仕組みが**既に実装済み**。

実測 ("A person dances energetically.", duration=8s, 160フレーム):

| イベント | 到達時刻 | 累積フレーム |
|---|---|---|
| `meta` | 9.67s | 0 |
| `chunk #1` | 9.72s | 40f (2.0s分) |
| `chunk #2` | 19.18s | 80f (4.0s分) |
| `chunk #3` | 25.16s | 120f (6.0s分) |
| `chunk #4` (`final`) | 30.13s (30.31s) | 160f (8.0s分) |

**重要な発見**: 最初のチャンクが届くまでに**9.7秒**かかっている。これは非ストリーミング
`/generate` の最短ケース (4.2秒) より遅く、体感上「即座」とは言えない。理由は、
`_generate_motion_streaming` の各ウィンドウが `future_len` として残りフレームを先読みする
実装になっており (学習時10秒ウィンドウに収める設計、`server.py` L366-371)、最初のウィンドウ
自体が実質的に大きな範囲を計算しているため。

→ **結論**: ストリーミングは「長尺モーションの体感待ち時間」を短縮する効果はある
(このケースでは合計30秒のうち70%地点=約8秒分の動きを見るまでの時間が30秒→9.7秒に、
約1/3に短縮) が、**<500msの初動反応には使えない**。またこの機能は現状、単一セグメント/
経由地ありのリクエストのみ対応で、複数セグメント連結 (`_generate_stitched`) 経由では
`on_chunk` が配線されておらず、ストリーミングの恩恵を受けない。

このAPIはText-To-VRMA側 (`src/apiServer.js` の `generateMotionWithArdy`、
`src/main.js` の同名関数) から**一度も呼ばれていない** — `fetch(`${url}/generate`...)`
のみで、`/generate-stream` への参照はコードベース全体で0件。

### 2.3 JS側の後処理・VRMA変換 (`src/vrmaBuilder.js` 等)

実際にARDYが返したspec (最大3200キーフレーム、20ボーン) を使い、Node上で計測:

| 処理 | 平均時間 (20回試行) |
|---|---|
| `isLoopFriendly` (ループ判定) | 0.003〜0.006ms |
| `autoExpressions` (表情自動付与) | 0.002〜0.006ms |
| `rescaleSpec` (秒数リスケール、ディープコピー込み) | 0.44〜1.2ms |
| `buildVRMA` (spec → GLBバイナリ) | 0.41〜0.56ms |

**結論**: JS側のパイプライン (spec加工・VRMAパッキング) は合計でも2ミリ秒未満。
最適化の余地はほぼゼロで、ボトルネックはGPU生成 (ARDY) とLLM API呼び出しの2箇所に完全に
集中している。

### 2.4 LLM (GPT-6 Astra / Claude) 側 — 推定値 (未実測)

実APIキーが無いため直接計測できていないが、コードから読み取れる設計上の根拠:

- `src/llm.js` はOpenAI/Claudeとも**既定で2パス構成** (下書き生成→自己修正) を持ち、
  `refineCheck` がONの場合は生成が2倍のLLM呼び出しになる。
- Claudeの `claude-opus-5`/`claude-sonnet-5` は既定でadaptive thinkingが有効
  (`THINKING_MODELS`, `llm.js:180`) で `max_tokens: 16000` を確保しており、コード内コメント
  自体が「thinking中は進捗が0%のまま長時間止まって見える」ことを課題として認識している
  (`llm.js:226-228`)。
- 進捗バーの学習初期値 (`expectedResponseChars = 6000`, `expectedClaudeChars` は
  thinkingモデルで10000) は、実運用で数千〜1万文字規模のJSON応答を前提にしている。
  ストリーミングでも数千文字のJSON出力には数秒〜十数秒、thinking込みなら数十秒かかることが
  一般的な同クラスモデルの傾向から見込まれる。
- ARDYエンジン経由の場合も、生成前に「GPTが頭」としてJSON計画 (`planArdySegments`) を
  1〜2回 (検証パスありなら2回) 呼ぶため、ARDYのGPU時間に**加えて**LLM往復が乗る。

**したがって、現状の「LLM (計画/keyframe) + ARDY」パイプラインの総レイテンシは、
実測できたARDY単体の4〜30秒に、LLM側の数秒〜数十秒がほぼそのまま加算される構造**と
推定される。これは今回計測した中で最大のボトルネック候補だが、実測での裏付けは別途必要
(§9のアクション項目を参照)。

### 2.5 その他の関連実装状況

- `src/specMerge.js` の `mergeSequentialSpecs` は、複数のモーションspecを時刻・位置・
  向きを揃えて1本に合成する機能が**既に完成している**が、現在の生成フロー
  (`main.js`/`apiServer.js`) からは呼ばれていない (ARDY自身が複数セグメントを内部で
  縫い合わせて1つのspecを返すため)。**Motion Primitive合成のための土台として転用可能。**
- 永続的なモーション「履歴」は `src/main.js` の `history` 配列のみで、**メモリ上・
  セッション限りの「最近生成した一覧」に過ぎず、保存も類似検索も無い。** Motion Cache /
  Fast Reaction Layerを作るなら、ここは実質ゼロから設計することになる。
- Electron側には `userData/ardy-engine.json` や `userData/local-api.json` のような
  小さなJSON設定を永続化する既存パターン (`electron/ardy-client.cjs`,
  `electron/api-server-client.cjs`) があり、モーションキャッシュのインデックス
  (JSON) + `.vrma` ファイル置き場を同じ `userData` 配下に置くのは、既存の設計思想と
  自然に整合する。

---

## 3. ボトルネックの順位付け

| 順位 | 箇所 | 実測/推定 | 規模感 |
|---|---|---|---|
| 1 | LLM (計画 or キーフレームJSON生成) | 推定 | 数秒〜数十秒、2パスで倍増 |
| 2 | ARDY GPU生成 (`/generate`) | 実測 | 最短4.2秒〜、長い動きは30秒以上 |
| 3 | ARDY起動時のモデルロード | 実測 (今回の起動時) | 初回1〜2分 (常駐させれば1回のみ) |
| 4 | JS後処理・VRMAパッキング | 実測 | 2ミリ秒未満、無視できる |
| 5 | Jev解析 (今回実装分) | 未実測・設計上の想定 | 数百ms級 (公称40〜200倍高速)、他に比べ十分小さい |

**結論**: 「生成」そのものを高速化する努力 (プロンプト最適化・ARDYパラメータ調整等) は、
数秒〜数十秒のオーダーを数割改善する程度にしかならず、会話のテンポ (数百ms) には届かない。
アーキテクチャレベルでの変更 (即時反応レイヤーの追加) が必須という、ユーザーの問題意識は
実測によって裏付けられた。

---

## 4. 推奨アーキテクチャ

ユーザー提案のセクション1〜11について、実測結果を踏まえた評価と推奨を述べる。

### 4.1 Fast Reaction Layer (§1) — 推奨・最優先

Jevの `emotion` / `reaction` / `intensity` (`src/jevAnalyzer.js` で既に実装済み) を
キーにして、事前生成済み `.vrma` ライブラリから即時再生する。

- 実測ではARDY/LLMの生成が最短でも4秒以上かかるため、**これ以外に<1秒の初動反応を
  実現する方法は無い**。
- 単純な固定マッピング (`emotion+reaction` → 1本のvrma) から始め、後述のMotion Cache
  (§4.4) で「複数候補から選ぶ」拡張は段階的に追加する。
- 素材: `release/emotion-*.vrma` (joy/anger/sadness/enjoyment) が既に同梱されている
  ものの、これはリリース広報用アセットで実行時には読み込まれていない。ライブラリ化の
  出発点の候補にはなるが、reaction (nod/shake_head/celebrate等) のカバレッジは
  ゼロから作る必要がある。

### 4.2 Generated Motion Layer / Hybrid (§2, §3) — 推奨・§4.1とセットで

`isConfident()` (既存のJev信頼度ゲート、`src/jevAnalyzer.js`) が既に「使ってよいか」の
判定を持っているので、これをMotion Routerの判断にも転用できる:

```
confidence高 & ライブラリに近い候補あり → 即時再生のみ
confidence低 or 新規性の高い表現       → 即時再生 + 裏でLLM+ARDY生成
```

裏側の生成は既存の `generateMotionWithArdy` / `generateMotionWithOpenAI` 等を
**そのまま**流用でき、新規のGPU/LLM呼び出しロジックは不要。追加が必要なのは
「非同期で走らせて、結果をどう扱うか」というスケジューリング層 (§4.3)。

### 4.3 Background Generation とキャンセル/鮮度管理 (§3, §9) — 推奨

現状、生成結果を「間に合わなくても必ず再生する」設計上の制約は無い (`playSpec`は
呼び出し側が任意のタイミングで呼んでいるだけ) ので、新たに次を管理するだけで実現できる:

- 生成要求ごとに `requestId` と `issuedAt` を持たせる。
- 発話 (テキスト受付) から一定時間 (例: Latency Budget §4.6 参照) 経過した生成結果は
  「有効期限切れ」として**再生せず**、Motion Cacheにのみ保存する。
- 現在再生中の即時リアクションを、詳細モーションが「間に合った」場合にのみ滑らかに
  差し替える (`mergeSequentialSpecs` のクロスフェード手法が流用できる)。

これは新規のUIロジック・状態管理が中心で、GPU/LLM呼び出し自体の変更は不要 =
**実装難易度は中程度、しかしリアルタイム品質への影響は最大**。

### 4.4 Motion Cache (§4) — 単純な設計を推奨、Embedding DBは時期尚早

現状ライブラリ規模がゼロからのスタートであることを踏まえ、**Embedding DBの導入は
過剰**と判断する。理由:

- 起動時間・メモリ・依存関係のコストに見合うほどのライブラリ規模 (数百〜数千件) には
  当面到達しない見込み。
- `src/jevAnalyzer.js` が既に `emotion` (11種) × `reaction` (15種) ×
  `movement_scale`/`tempo` (各3種) という**十分に細かい離散キー**を提供している。
  まずは `emotion+reaction` の組み合わせ (最大165通り) をキーにしたルックアップ
  テーブル + intensityによる複数候補からのランダム/最近傍選択で十分な多様性が出せる。
- 将来的にライブラリが数千件規模になり、「めちゃくちゃ嬉しい」と「やったー」のような
  自由文の類似検索が本当に必要になった時点で、軽量なローカル埋め込み
  (例: 小さいsentence-transformersをJev同様に外部API化する、または
  すでにJevのconfidence/probabilitiesが意味的な近さのヒントになる) を追加すれば良い。
  **今は作らない。**

保存形式は既存パターンに合わせ、`userData/motion-cache/` 配下に `.vrma` ファイル +
`index.json` (キー→ファイル名・メタデータ・生成日時・利用回数) で十分。

### 4.5 Progressive Motion Generation (§5) — 部分的に可能、ただし効果は限定的

§2.2の実測の通り、ARDY側の `/generate-stream` は**既に実装済みで技術的に可能**。
ただし:

- 最初のチャンクの到達に約9.7秒かかっており、<500msの初動には使えない。
- 効果があるのは「長尺モーションを待つ体感時間の短縮」(実測で最大約1/3) であり、
  Fast Reaction Layerの代替にはならない。
- 複数セグメント連結には現状 `on_chunk` が配線されておらず (`_generate_stitched`
  がストリーミング非対応)、ARDY側に追加改修が要る。

**推奨**: Phase 3以降で「裏側の詳細生成をより早く体感させる」補助策として採用する
(§4.2のHybridの背面生成に組み込む)。優先度は§4.1〜4.3より低い。

### 4.6 Motion Chunks / Primitive Composition (§6) — 既存機能で対応可能

`src/specMerge.js` の `mergeSequentialSpecs` が、複数の短いモーションspecを時刻・
位置・向きを揃えて1本に合成する処理を**既に実装済み** (0.15秒のクロスフェードgap込み)。
これは0.5〜2秒のMotion Primitiveを組み合わせて「startled → step_back → look_at_viewer」
のような合成モーションを作る用途にそのまま使える。**新規実装は不要、既存関数の呼び出し元を
増やすだけ**でOption D (Motion Primitive Composition) が成立する。

課題は合成そのものではなく、**Primitiveのライブラリをどう用意するか** (§4.1のFast
Reaction Layerと同じ資産)。

### 4.7 Speculative Motion Generation (§7) — 現時点では非推奨

LLMのストリーミング出力から文の途中で感情を検出し先読み準備する案について:

- 技術的には可能 (LLMのstreaming delta自体は `callOpenAI`/`callClaude` で既に扱っている)
  が、Jevは現状「1回の完結したテキスト」を分析する設計であり、部分文への逐次適用は
  誤判定率が上がりやすい (例: 「えっ！？それって……」の時点では喜びか驚きか悲しみか
  確定しないケースが多い)。
- 誤判定時のキャンセル・巻き戻しの複雑さに対して、Fast Reaction Layer
  (発話確定後に即座に反応、数百ms) で十分な体感速度が既に得られる見込みのため、
  投資対効果が低い。
- **推奨: 保留。** Fast Reaction Layer/Hybridの実運用データを見て、それでも
  「発話確定を待つ数百msすら遅い」と分かった場合にのみ再検討する。

### 4.8 Speech / Motion Synchronization (§8) — 今回の調査範囲外

Text-To-VRMAには現状、TTS (音声合成) や音声再生開始時刻を扱う仕組みが存在しない
(コードベース内にTTS関連の実装なし)。この項目は「外部のAIキャラクターシステム側で
TTSと本アプリのモーション再生タイミングをどう合わせるか」という統合設計の話であり、
本リポジトリ単体の変更では完結しない。Local HTTP API (`POST /v1/motions`,
`POST /v1/motion-context`) が返す結果に、再生開始を遅らせるための
`readyAt`/`estimatedDuration` 等のメタデータを含めることは可能だが、実装は
外部システムとの結合方法が具体化してから検討すべき。

### 4.9 Motion Scheduler (§9) — §4.3と統合して設計

要求される機能 (再生中/次/古い要求の破棄/優先度/interrupt/loop・idle/生成中/
キャッシュ済みの区別/発話終了時刻) は、実質的に§4.3の非同期生成管理と同じ状態機械。
新規モジュール (例: `src/motionRuntime.js`) として、次の状態を持つキュー管理を推奨:

```
idle → reacting(cached) → detailing(generating) → { replaced | discarded | cached }
```

`interrupt可能か` は現在の3D再生 (`playSpec`) 側にクロスフェード機構
(`mergeSequentialSpecs`の手法が流用可) を足すことで対応できる。

### 4.10 Latency Budget (§10) — 実測ベースに補正した目標値

| 項目 | ユーザー提案 | 実測ベースの補正案 |
|---|---|---|
| Jev decision | <300ms | 妥当。Jev自体は公称40〜200倍高速、`DEFAULT_JEV_TIMEOUT_MS=4000`のタイムアウト内で通常は数百ms級と想定 (要実測、§9) |
| Cached motion selection | <100ms | 妥当。ローカルJSON検索+ファイル読み込みなら達成容易 |
| First visible reaction | <500ms | Jev(数百ms)+キャッシュ選択(<100ms)+再生開始で達成可能圏内。**ただしこれは「事前生成キャッシュがヒットした場合」に限る** |
| Generated custom motion | background task | 実測を踏まえ明確化: ARDY単体で4〜30秒+、LLM計画/キーフレームが乗ると数十秒〜1分規模もあり得る。**バックグラウンドタスクとして「秒〜分オーダー」を許容する設計が前提** |
| Total speech-motion perceived latency | 可能な限り500ms以下 | キャッシュヒット時のみ達成可能。**キャッシュミス時は「即座の汎用リアクション」で500ms以下を守り、詳細モーションは非同期に後追いする」という2階建ての目標にすべき** (単一の500ms目標をすべてのケースに課すのは実測上不可能) |

---

## 5. 方式比較 (§11)

| | A. 現在方式 | B. Jev+既存モーション | C. Hybrid | D. Motion Primitive合成 |
|---|---|---|---|---|
| Latency (初動) | 数秒〜数十秒 (実測4〜30秒+LLM) | <500ms (キャッシュヒット時) | <500ms (常に) | <500ms〜数秒 (合成コストによる) |
| Motion quality | 高 (専用生成) | ライブラリ依存、単調になりやすい | 高 (裏で高品質に差し替え) | 中〜高 (Primitiveの繋ぎ目品質に依存) |
| Naturalness | 高 | 低〜中 (汎用モーションの使い回し感) | 高 (段階的に自然な詳細へ移行) | 中 (mergeSequentialSpecsのクロスフェードで緩和済み) |
| GPU負荷 | 都度発生 | ほぼゼロ | Bと同程度+裏で都度発生 | Primitiveが既存なら低、新規合成時は都度 |
| API cost | 都度発生 (LLM) | ゼロ (キャッシュヒット時) | 都度発生 (裏側のみ) | 低 (LLM呼び出し頻度を減らせる) |
| Implementation complexity | 現状維持 | 中 (ライブラリ整備が主コスト) | 高 (§4.3のスケジューラが必要) | 中 (合成関数は既存、ライブラリ整備は必要) |
| Long-running stability | 実績あり | 未検証、要ライブラリメンテ | 新規、テスト要 | 新規、テスト要 |
| AI character向き適性 | 低 (会話テンポに合わない) | 中 (反応は速いが表現が単調になりがち) | **高** (速さと表現の両立) | 高 (表現の幅を保ちつつ速い) |

**総合推奨**: **C (Hybrid) を軸に、D (Primitive合成) をCの「即時リアクション」層の
表現力強化として組み込む**。B単体は表現が単調になりやすくAI キャラクター用途としては
物足りないが、Cへの土台として最初に作る価値はある (§6のロードマップ参照)。

---

## 6. 変更対象ファイル (実装時の見込み・現時点では未着手)

| ファイル | 変更内容 |
|---|---|
| `src/motionLibrary.js` (新規) | Fast Reaction Layer: emotion/reaction→候補vrmaの検索・選択 |
| `src/motionRuntime.js` (新規) | §4.9 Motion Scheduler: 再生キュー・鮮度管理・interrupt |
| `src/specMerge.js` | 既存 `mergeSequentialSpecs` を実際に呼び出す経路を追加 (変更は呼び出し元のみ、関数自体は無改修で流用可) |
| `src/apiServer.js` / `src/main.js` | Hybrid生成フロー (即時再生+裏側生成) の呼び出し順序変更、`/v1/motion-context`結果をFast Reaction Layerに接続 |
| `tools/ardy-engine/server.py` | (Phase 3以降・任意) `_generate_stitched` へ `on_chunk` を配線しマルチセグメントもストリーミング対応させる |
| `electron/*.cjs` | Motion Cacheの永続化 (`userData/motion-cache/`) の読み書き |
| `index.html` | キャッシュ状況・即時/詳細モーションの切り替わりを示すデバッグ表示 (任意) |

## 7. 実装難易度

| 項目 | 難易度 | 理由 |
|---|---|---|
| Fast Reaction Layer (固定マッピング版) | 低〜中 | ロジックは単純だが、reaction別のvrma素材を用意する制作コストが主 |
| Hybrid (即時+裏側生成の切り替え) | 中〜高 | 非同期状態管理・鮮度判定・クロスフェード差し替えが新規実装 |
| Motion Cache (単純なキー検索) | 低 | 既存の`userData`永続化パターンを踏襲すれば良い |
| Motion Primitive合成 | 低 | `mergeSequentialSpecs`が既にある |
| Progressive Streaming (単一セグメント) | 低 (クライアント側) | サーバーAPIは既存、NDJSON parserを書くだけ |
| Progressive Streaming (複数セグメント対応) | 中 | Python側 (`_generate_stitched`) の改修が必要 |
| Speculative Generation | 高 (かつROI低) | 誤判定時のキャンセル設計が複雑、優先度低 |
| Speech/Motion同期 | 不定 | 外部システムとの結合方法次第、本リポジトリ単体では未確定 |

## 8. 期待できるレイテンシ改善

- **初動反応**: 現状「生成完了まで数秒〜数十秒」→ キャッシュヒット時 **数百ms**
  (実測ではARDY/LLM生成そのものが4秒を切ることがないため、これは生成の高速化ではなく
  「生成を待たない」ことによる改善)。
- **長尺モーションの体感待ち時間**: Progressive Streaming採用時、実測ケースで
  約30秒→約9.7秒 (最初の意味のある動きが見えるまで)、**約1/3に短縮**。
- **キャッシュミス時の総生成時間そのもの**: 大きな改善は見込めない (現状のARDY/LLM
  性能に依存)。ただし体感上は「キャラクターは既に反応している」ため、ユーザーが
  待たされている感覚は大幅に緩和される。

## 9. 段階的な実装計画

1. **Phase 0 (計測の補完、コード変更なし)**: 実APIキーでOpenAI/Claude/Codexの
   実測を取る。Jev自体のAPI往復時間も実際のTypeSafe AI keyで計測する。本レポートの
   §2.4を実測値に置き換える。
2. **Phase 1 (Fast Reaction Layerの最小版)**: emotion×reaction の固定マッピングで
   10〜20本程度の短いvrmaライブラリを用意し、Jevの解析結果から即時再生するだけの
   スタンドアロン機能を追加 (既存の生成フローとは独立、既存動作を壊さない)。
3. **Phase 2 (Motion Cache + Hybrid)**: Phase 1のライブラリを`userData`永続化に拡張し、
   裏側でLLM+ARDY生成→鮮度判定→差し替え/キャッシュ保存、という§4.3のスケジューラを追加。
4. **Phase 3 (仕上げ)**: Motion Primitive合成 (`mergeSequentialSpecs`の実運用適用)、
   ARDYストリーミングの単一セグメント対応クライアント実装、必要なら
   `_generate_stitched`のストリーミング対応。
5. **Phase 4 (任意・ROI次第)**: Speculative Generation、Speech/Motion同期は、
   外部AIキャラクターシステムとの実運用を経てから再評価する。

---

## 付録: 生データ

- ARDY `/generate` 実測ログ: 本文中の表に集約。生ログは
  `%LOCALAPPDATA%\Temp\ardy-server.log` 相当 (このセッションでは `/tmp/ardy-server.log`)。
- ARDY `/generate-stream` 実測: 本文§2.2の表。
- JSベンチマークスクリプトは使い捨て (`_bench_tmp.mjs`) で、リポジトリには残していない。
  再計測が必要な場合は `src/vrmaBuilder.js` の `buildVRMA` / `src/autoExpressions.js` /
  `src/specMerge.js` を直接importして計測すれば同様の結果が得られる。
