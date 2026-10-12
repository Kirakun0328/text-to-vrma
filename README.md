# Text-To-VRMA — VRM特化型Text-To-Motionツール

[![GitHub Sponsors](https://img.shields.io/badge/♥_Sponsor-支援する-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/Kirakun0328)

![デモ: テキストからモーション生成](video/demo.gif)

テキストを入力すると AI がモーションを生成し、
**VRMA (VRM Animation / `.vrma`)** ファイルをブラウザ内で生成して、
その場で VRM キャラクターを動かす Web アプリです。
生成した `.vrma` はファイルとして保存でき、VRMA 対応アプリでそのまま利用できます。

例:「その場で歩く」「喜んでジャンプする」「手を振る」「悲しそうにうつむく」

## ✨ 主な機能

- 📝 **テキストからモーション生成** (日本語OK) — LLMキーフレーム / NVIDIA ARDY の2エンジン
- 🧠 **Jev (TypeSafe AI) 対応** — 入力文から感情・視線・動きのテンポを解析し、表情や動き方を自動で補います (v1.1.9〜)
- 🚀 **最新モデル対応** — OpenAI は GPT-6 世代 (`gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna`)、Claude は Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5
- 💳 **Codexサブスクリプション対応** — デスクトップ版に加え、ローカルWeb版からも利用枠で呼べます
- 🎬 生成したモーションを **GIF / 動画 (1080p)** で書き出し — SNSにそのまま共有できます
- 🎨 **背景色の自由指定** — グリーンバック等のクロマキー合成用の単色背景にできます
- ⏱ **モーションの長さを秒数で指定** (空欄で自動判定・「自動補正」オプションあり)
- ▶ **再生シークバー** — 現在秒数の表示、任意の地点へスクラブ、一時停止
- 📍 **経由地モード** — 3Dビューの床をクリックして移動経路を指定 (ARDY)
- 🎭 **感情を身体で表現** — 表情だけでなく姿勢・腕・重心・動きの緩急にも反映
- 🔍 **AIで動きを見直す** — 生成後にAIが必要性を判定し、必要なときだけ補正
- 🎯 **指示追従チェック** — 移動・ジャンプ・しゃがみ・手上げをアバター上で計測
- 🎲 **3候補の生成と比較** — 別seedで生成して見比べ、良いものを採用
- ✨ **全身のなめらか補正** — 急な角度変化をやわらげ、接地付近は保護
- 🔁 **ループ再生** — 頭と末尾をつないで途切れなく再生
- 😊 **表情の自動生成** — 自然なまばたきと、セリフに合わせた口の動き (「ありがとう」→ あ・い・あ・お・う) + 4言語UI (日本語 / English / 中文 / 한국어)
- 🔌 **OpenAI互換プロバイダ対応** — OpenRouter / DeepSeek / Ollama 等も使えます
- 🟣 **Claude API対応** — Anthropic の Claude (claude-opus-5-5 等) でもモーション生成できます
- 🧭 **接続の案内** — ARDYエンジンが起動していないなど接続できないときは、原因と「エンジンを起動」等のボタンを表示します

生成エンジンは2種類から選べます:

| エンジン | 特徴 | 必要なもの |
| --- | --- | --- |
| **LLMキーフレーム** (OpenAI API / Claude API / Codex / 互換API) | 正確なポーズ・手指・表情の指定が得意。セットアップ不要でどのPCでも動く。OpenAI互換API (OpenRouter/DeepSeek/Ollama等) や Anthropic の Claude API も指定可 | APIキー または Codexプラン |
| **ARDYローカルエンジン** (v1.1〜) | NVIDIAのモーション生成AI [ARDY](https://github.com/nv-tlabs/ardy) をローカル実行。歩行・ダンス・ジャンプ等の全身運動が**モーションキャプチャ品質**。生成無制限・オフライン動作 | 追加セットアップ (下記) |

ARDYモードではARDYが身体のモーションを生成します。Codex併用では、最初の動作区間の身体・表情を設計してから生成・再生を始め、その間に後続区間を設計します。確定した区間の時刻や内容を保ち、末尾へ追加します。「ARDYのみ」は入力文から直接生成します。Jevの解析は並行して補助に使います。通常の新規生成は独立し、生成中の再入力や明示的な追加修正では現在の物理履歴からつなぎます。操作と制約は [ARDY連続生成](docs/ardy-realtime.md) を参照してください。

| 動作を考えるAI | 必要なもの | 備考 |
| --- | --- | --- |
| **ARDY単体** (初期表示) | なし | ARDY内蔵の翻訳で生成します |
| **Codexサブスクリプション** | ChatGPT/Codexプラン | 利用枠の使用率・残り・リセット時刻を設定欄に表示 |
| **OpenAI API** | APIキー | GPT-6 Astra / GPT-6.1 Sol (既定) / GPT-6 Luna |
| **Claude API** | APIキー | Fable 5.1 / Opus 5.5 (既定) / Sonnet 5.5 / Haiku 5.5 |

- Codexを選んだ連続生成で認証や計画に失敗した場合は、理由を表示します。ARDY単独や有料APIへ自動では切り替えません。直接生成は「ARDYのみ」で選べます
- 生成後のレビュー・品質設定は [モーション品質の仕組み](#モーション品質の仕組み) を参照してください

モーションと同時に**表情** (笑顔・悲しみ・驚き・まばたき等) も生成されます。
まばたきは間隔にばらつきを持たせ、驚いた表情の間は控えます。「話す」「お礼を伝える」「『ありがとう』と言う」のような
指示では口も動き、セリフが「」で書かれていればかなの母音に合わせて口の形を変えます (叫ぶと大きく、ささやくと小さく開きます)。
`.vrma` 保存時に「表情を含める / 含めない (ボーンモーションのみ)」を選択できます。

UIは **日本語 / English / 中文 / 한국어** の4言語に対応 (画面右上のセレクタで即時切替。
初回はブラウザの言語設定から自動判定) 。
*The UI is available in Japanese, English, Chinese and Korean — switch instantly from the selector at the top.*

## セットアップ & 起動

> 🎁 **ビルド不要で使いたい方 (Windows):**
> [Releases から最新版のzipをダウンロード](https://github.com/Kirakun0328/text-to-vrma/releases/latest)
> — 解凍してexeをダブルクリックするだけ (インストール不要、ARDYエンジンのセットアップ一式も同梱)。
> 以下のセットアップは全て不要です。

ソースから動かす場合は2通りあります。迷ったら **A. ブラウザ版** が最短です。

| | 起動コマンド | 向いている人 |
| --- | --- | --- |
| **A. ブラウザ版** | `npm run dev` | まず試したい人 (全OS・最短3コマンド) |
| **B. デスクトップ版 (Electron)** | `npm run build` → `npm run app:dev` | Codexサブスク認証や、ARDYエンジンのアプリ内セットアップ・自動起動を使いたい人 |

**事前に必要なもの:**

| 何をするか | 必要なもの |
| --- | --- |
| 共通 | Node.js 20+、git |
| モーション生成 (LLMキーフレーム) | OpenAI APIキー ([platform.openai.com](https://platform.openai.com/) で取得) または Claude APIキー ([console.anthropic.com](https://console.anthropic.com/) で取得)。ローカルWeb版・デスクトップ版は代わりにCodexとChatGPT/Codexプランでも可 |
| ARDYローカルエンジン (任意) | [下記セクション](#ardyローカルエンジン-オプション)参照 (Python 3.10+ / git、約20GBダウンロード)。**こちらはAPIキーなしでも動きます** |

VRMモデルは [VRoid 公式サンプルモデル (AvatarSample)](https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604)
の VRM1.0 版・VRM0.0 版を同梱しており、起動時に VRM1.0 版が読み込まれます。手持ちの `.vrm` への
差し替えも可能で、**0.x / 1.0 の両形式に対応**しています (three-vrm が自動判別し、向きも正規化)。

### A. ブラウザ版

```sh
git clone https://github.com/Kirakun0328/text-to-vrma.git
cd text-to-vrma
npm install
npm run dev
# → http://localhost:5173 をブラウザで開く
```

### B. デスクトップ版 (Electron)

```sh
git clone https://github.com/Kirakun0328/text-to-vrma.git
cd text-to-vrma
npm install
npm run build
npm run app:dev
```

- Electron 版は Vite のビルド結果 `dist/index.html` を読み込みます。初回とソースコード変更後は
  **必ず `npm run build` を実行してから** `npm run app:dev` で起動してください
  (ビルド済みのまま再起動するだけなら `npm run app:dev` のみでOK)
- Codexサブスクリプション認証はデスクトップ版と `npm run dev` / `npm run preview` のローカルWeb版で利用できます。
  使う場合は事前に Codex CLI のインストール・認証・PATH設定を済ませてください
  (Codex CLI はアプリに同梱していません)。
  未導入または古いバージョンの場合は、アプリ内に導入・更新の手順を表示します
  (動作確認済みは 0.153.3)
  ローカルWeb版は同一オリジンのNodeサーバーから `codex app-server` に接続します。
  静的ファイルのみの配信では利用できません。モデル一覧はログインしたアカウントから取得し、
  GPT-6 Astraが一覧にない場合はサブスク側でまだ選択できません。
  ソース版の `npm install` は動作確認済みのCodex CLI 0.153.3も導入します。
  プロジェクト内のCLIを優先し、存在しない場合のみPATHのCLIを使います。
  古いCLIでは利用可能なAstraが一覧に出ない場合があります（0.144.1と0.153.3で確認）。

> [!NOTE]
> 現在の `npm run app:build` (exe作成) は Windows Portable 版専用です。macOS 向けの `.app` や `.dmg` は生成しません。

## 使い方

1. 起動するとサンプルモデル (AvatarSample VRM1.0版) が読み込まれます。
   「VRMファイルを開く」または 3D ビューへのドラッグ&ドロップで手持ちの VRM に差し替え可能
2. 生成エンジンを選択
   - **OpenAI APIキー**: キーを入力し、モデルを選択します。キーはブラウザの
     localStorage にのみ保存され、OpenAI 以外には送信されません。
     「🔌 OpenAI互換プロバイダを使う」からベースURL・モデル名を指定すれば、
     OpenRouter / DeepSeek / Ollama 等の互換APIも使えます
     モデル一覧から **GPT-6 Astra** (`gpt-6-astra`) も選択できます。
     生成・自己修正・ARDYの動作計画に利用でき、既定モデルは `gpt-6.1-sol` です。
     [OpenAI公式モデル情報](https://developers.openai.com/api/docs/models/gpt-6-astra)では
     段階提供中のため、利用するAPIプロジェクトにアクセス権が必要です。
     ローカルHTTP APIではリクエストの `model` に `gpt-6-astra`、
     または環境変数 `OPENAI_MODEL=gpt-6-astra` を指定できます。
   - **Claude API**: Anthropic の Claude APIキー (sk-ant-...) を入力し、モデル
     (claude-fable-5-1 / claude-opus-5-5 / claude-sonnet-5-5 / claude-haiku-5-5) を選択します。
     キーはブラウザの localStorage にのみ保存され、Anthropic 以外には送信されません。
     Claude API対応は [@AUDOSt0ck1ng](https://github.com/AUDOSt0ck1ng) さん
     ([#9](https://github.com/Kirakun0328/text-to-vrma/pull/9)) のコントリビュートによるもので、
     **コントリビューターがブラウザ版・デスクトップ版で動作確認していますが、作者環境では未確認です**。
     不具合報告・動作報告を歓迎します
   - **Codexサブスクリプション（デスクトップ版・ローカルWeb版）**: 「ChatGPTでログイン」を押して
     既定ブラウザで認証します。既にCodex CLIでログイン済みなら、その認証を再利用します
   - **ARDYローカルエンジン**: ローカルで動くモーション生成AI (下記セクション参照)
3. テキストで動きを指示して「▶ モーション生成 & 再生」 (Ctrl+Enter でも可)
   - 「⏱ 長さ (秒)」で生成するモーションの長さを指定できます (空欄なら自動判定)。
     「長さを自動補正」ONにすると、動作数に見合った自然な長さへ自動調整します
   - 「ループ再生」で 自動 / 常にループ / 1回だけ を選択できます
   - 「🔍 自己修正」(LLMモード) では生成後にもう1パスかけて品質を上げます
   - **演技設計＋画像レビュー**: Codex（サブスク利用枠）または公式GPT-6 Astra APIで利用できます。
     演技の段取り・支持脚・重心・視線・手足の到達位置を計画し、読み込んだVRMの実寸を使って生成。
     正面・側面のコマ送り画像と実測位置をモデルに返し、1回修正します（合計3回の生成）。
     APIモードは従量課金、CodexモードはChatGPTログインを必須としAPIキーへ自動切替しません。
     1〜15秒対応。「通常の自己修正」の代わりに実行します。
     完了後の比較パネルで修正前・修正後を再生し、演技設計・測定値・送信画像を確認できます。
     数値が大きく悪化した候補は自動採用せず、比較用に残します。測定値は物理品質の保証ではありません。
     「速度優先」は推論量とキー数を抑え、「品質優先」は詳しく考えます。
     修正完了前に初稿を先に再生します。比較パネルに初稿までの時間と全体の時間を表示します。
4. 生成された動きは3Dビューで再生されます
   - 下部の**再生バー**で現在秒数の確認・任意地点へのスクラブ・一時停止ができます
   - 右上の**カメラリセット / フルスクリーン**、下部の**背景切替**でプレビューを調整
5. 「4. 書き出し・共有」から出力
   - **⬇ .vrma 保存** — VRMA対応アプリ (VRoid Hub / cluster 等) で使えるファイル
   - **🎞 GIF書き出し / 🎬 動画書き出し** — 1080pで書き出してSNSにそのまま共有
   - 生成履歴の各項目からも再生・保存・GIF/動画書き出しができます

## モーション品質の仕組み

生成したモーションをそのまま出すのではなく、複数の段階で品質を上げています。
いずれも**幾何学的な計測に基づく補助であり、品質の保証ではありません**。

### 生成品質

「標準」「速度優先」「品質優先」から選べます (既定は標準)。
計画時の推論量とレビュー回数が変わります。速度優先は推論量を抑え、
品質優先は詳しく考えたうえで再評価を最大2回まで行います。

### 終わりの姿勢の保持

連続生成では、各区間で動かさない部位を固定します。下ろしていた腕は胴体が傾いても重力方向に垂れたまま保ち、
「腕を下ろして終わる」区間ではまだ上がっている腕だけを動かします。空中から始まる区間は脚と腰の上下を動かして着地させます。
詳細は [終端姿勢の保持](docs/end-pose-holding.md) を参照してください。

### AIで動きを見直す

生成後、AIが**まず修正が必要かを判定**します。不要なら元の動きをそのまま採用し、
その理由をプレビューの「修正前後を比較」に表示します。

- **標準・品質優先** — 元のモーションの関節に補正を直接適用し、別の判定で再評価します
- **速度優先** — ARDYへの指示を見直して再生成します
- **画像も使う** — アプリが生成モーションを正面・側面から自動撮影し、選んだAIへ送ります
  (参照画像をユーザーが用意する必要はありません)

自動修正は起動時OFFです。生成後に「この動きを修正」から手動で実行できます。
物理指標が悪化した場合や、指示された動作が消えた場合は自動採用しません。
ARDYの終了姿勢は保持し、足を滑らせる強制的な直立補間は行いません。

| | |
| --- | --- |
| 対応する長さ | 1〜15秒 (Web版・デスクトップ版の機能) |
| AIへ渡す情報 | 足滑り・関節の角速度・手足の速度と加速度 |
| 足滑りの測り方 | 足の高さと上下速度から接地を近似。**物理シミュレーションや全身衝突判定ではありません** |

### 指示追従チェック

移動・両足ジャンプ・腰を落とす・手を顔付近まで上げる、の4種について、
アバター上の関節位置を最大20Hzで計測して検出します。

これは**幾何学的な代理指標**です。厳密な歩数・移動方向・動作順・表情・自然さ・
衝突・物理安定性を保証するものではありません。

### 3候補の生成と比較

比較したい場合、別のseedで3候補を生成して見比べられます (通常は1候補)。
比較可能なチェックが揃う場合は検出数を優先し、足滑り・沈み込みも確認します。
追加のAI計画呼び出しはありませんが、ARDYの生成時間は増えます。

### 全身のなめらか補正

急な角度変化をやわらげます (標準ON、「動きの詳細設定」内)。
腕・上半身に加えて脚・足首・腰・指も対象です。

足首の高さから接地を推定し、**足が低い区間では補正を抑えて移動経路を保ちます**。
足首高による推定であり、実アバターの足裏接触を測るIK固定ではありません。
階段・段差や特殊姿勢での接地判定、足滑りの完全防止は保証しません。

### ループ再生

有限回数や終了動作がある場合は自動ループせず、最後のポーズを保持します。
明示的にループさせる場合は頭と末尾を重ねてつなぎます。
移動を伴うループでは位置・向きを累積し、周期ごとに原点へ戻る問題を抑えます。

> この継ぎ目処理は**ビューアでの再生用**です。書き出した `.vrma` に同じ処理は入りません。

## ARDYローカルエンジン (オプション)

NVIDIA Research の text-to-motion モデル
[ARDY](https://research.nvidia.com/labs/sil/projects/ardy/) (SIGGRAPH 2026) を
ローカルで動かし、モーションキャプチャ品質の全身モーションを生成するモードです。

**できること:**

- 歩く・走る・踊る・ジャンプ・格闘などの全身運動を、実際の人間のモーション
  キャプチャデータで学習したAIが生成 (重心移動・勢い・足の接地が本物らしい)
- **日本語プロンプトOK** — ローカル翻訳 (FuguMT) で自動英訳。
  OpenAI APIキーが保存済みなら GPT が英訳+連続動作の分割まで行い、精度が上がります
- **📍 経由地モード** — 3Dビューの床をクリックして経由地を置くと、
  キャラクターがその順番に通るモーションを生成 (右クリックで1つ取り消し)
- **「歩いて走ってジャンプして転んで」** のような連続動作も、GPTが動作を分割・
  検証して最大12動作まで繋げて生成します (APIキー保存時)
- モーションの長さは秒数で指定 (0.1秒〜) または内容から自動判断。表情・ループ可否も自動
- 生成回数無制限・完全ローカル (セットアップ後はオフラインで動作)

**動作要件と速度:**

| | 最低 | 推奨 |
| --- | --- | --- |
| OS | Windows 10/11 64bit、macOS、Linux | 同左 |
| RAM | 16GB | 32GB+ |
| ディスク | 35GB | 同左 |
| GPU | VRAM 4GB〜 (無くてもCPUで1回数十秒) | NVIDIA GPU 6GB+ (1回数秒) |

> 💡 **ARDY公式のデモはVRAM 20〜24GBを要求しますが、本アプリはモーションモデル本体の
> GPU使用を実測で約1.2GBまで削減しています** (VRAMの大半を占めるテキスト理解部の
> 8B LLM をCPU側で動かす構成のため)。生成中もVRAMはほぼ増えません (実測 +約12MiB)。
> モーションモデル本体・拡散ステップ数は公式そのままなので **生成品質は一切落ちていません**。
> ※ 数値は nvidia-smi による実測 (プロセス停止/起動時のVRAM差分)。
> モデル使用は約1.2GBで生成しても増えないため、デスクトップ表示分を足しても
> **VRAM 4GB のGPUで十分動く見込み**です (動作確認は12GBで実施。4〜6GBは未検証のため推奨6GB以上)。
> GPUがなくてもCPUで動作します (生成が数倍遅くなります)。

**品質を支える3層構成** — 役割分担は「GPTが頭、ARDYが体」:

| 層 | 役割 |
| --- | --- |
| GPT (任意・APIキー保存時) | 日本語の意図理解、連続動作の分割、ARDYが得意な英語表現への言い換え |
| Llama-3-8B (ローカル・CPU) | 英文をARDY専用のベクトルに変換 (LLM2Vec) |
| ARDY (ローカル・GPU) | 実際のモーションキャプチャデータで学習したAIが動きを生成 |

APIキーなしでもローカル翻訳 (FuguMT) で完結しますが、キーがあると
「走ってからジャンプして、最後にお辞儀」のような複雑な指示の再現度が上がります。

**セットアップ** (Python 3.10+ と git が必要。約20GBダウンロードします):

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\ardy-engine\install.ps1
```

macOS:

```bash
bash tools/ardy-engine/install_mac.sh
```

Linux:

```bash
bash tools/ardy-engine/install_linux.sh
```

Linux版は apt / dnf / yum / pacman / zypper に対応し、Python 3.10+・git・C++ビルドツール
(gcc/g++・cmake) を必要に応じて自動導入します (パッケージ導入には sudo を使います)。
NVIDIA GPU があれば CUDA 版 PyTorch を自動選択します (`nvidia-smi` で判定)。
ブラウザ版から使う場合は、セットアップ完了時に表示される `server.py` 起動コマンドで
エンジンを手動起動してください。

macOSでHomebrewが未導入の場合は、セットアップ中に自動でインストールされます。
macOS対応は [@emadurandal](https://github.com/emadurandal) さん ([#2](https://github.com/Kirakun0328/text-to-vrma/pull/2))、
Linux対応は [@mouseos](https://github.com/mouseos) さん ([#7](https://github.com/Kirakun0328/text-to-vrma/pull/7)) の
コントリビュートによるものです。
**開発者 (作者) が動作確認しているのはWindowsのみで、macOS / Linux は作者環境では未確認です**
(macOS はコントリビューターが、Linux はコントリビューターが実機で動作確認しています)。
これらの環境の不具合報告・動作報告・修正PRを歓迎します。

完了後、エンジンを起動してからアプリの「ARDYローカルエンジン」モードを選択します。
詳細・手動起動・APIは [tools/ardy-engine/README.md](tools/ardy-engine/README.md) を参照してください。

本機能は Meta Llama 3 をテキストエンコーダとして利用しています。**Built with Meta Llama 3**

## Jev (TypeSafe AI) による意味・感情解析 (オプション)

[Jev](https://typesafe.ai/) は TypeSafe AI の「System One モデル」で、文章を生成する
LLMとは違い、入力文を typed な選択肢・スコアに高速分類するモデルです。
Text-To-VRMA では **Jevにモーションそのものは作らせません**。役割はあくまで、

- 入力文の感情 (`emotion`) とその強さ (`emotion_intensity`)
- 各感情の独立スコア (`affect`) と項目ごとの信頼度 (`confidences`)
- エネルギー量 (`movement_energy`)・動きの規模・テンポ・対人態度・明示された視線

を解析し、その結果を**補助情報として**生成プロンプト (ARDY / OpenAI / Claude / Codex
共通) へ渡します。原文を優先し、動作の種類を固定しません。旧分類 `reaction` は解析APIの
互換用で、身体生成には渡しません。実際のモーションは毎回 ARDY やLLMが生成します。
独立した感情スコアは先行表情にも使用し、ARDYの顔が未設計なら短い開始表情としてVRMAへ補完します。
既存の表情トラックや途中の感情変化は保持します。

**JevのAPIキーがあれば自動利用します。** 未設定・エラー・タイムアウトではJevなしで
生成を続行します。総合信頼度が低くても解析全体を捨てず、各項目の信頼度に応じて扱います。
Codex併用の連続生成では、区間設計とJev解析を並行し、最初の身体・表情区間が確定してからARDYを開始します。
後続の計画は末尾へ追加し、後着のJev解析は未再生の区間の生成条件へ渡します。既に再生した動きやCodexが設計した表情を上書きしません。

### 有効にする方法

- **アプリ / ブラウザ版**: 言語切り替えの左の「設定」で、他のAPIキーと同じ欄にある
  Jev APIキーを入力し、モデル (`jev-latest` / `jev-preview` / `jev-1.13.0`) を選びます。変更は自動保存されます。
- **ローカルHTTP API (`npm run api`)**: `.env` に `JEV_API_KEY` を設定します。
  `JEV_ENABLED=false` でサーバー全体を明示的に無効化できます (`.env.example` 参照)。

### 日本語は英訳してから解析します

Jevは英語が主な対象で、TypeSafe AIの資料でも他の言語は精度が下がるとされています。そのため日本語の入力は、
ARDYエンジンに内蔵の翻訳モデル (FuguMT) で英訳してからJevへ送ります。ARDYが起動していない・翻訳が2秒以内に
終わらない場合は、これまでどおり原文のまま送ります。設定の「Jevへは英訳して送る」でオフにできます
(ローカルHTTP APIでは環境変数 `JEV_TRANSLATE=0`)。動作を考えるAI (Astra / Claude 等) には日本語のまま渡します。

### APIキーの取り扱い

OpenAI / Claude のキーと同じ方針です。アプリでは `localStorage` に保存し、Electron IPC
または同一オリジンのローカル接続サーバーを経由してJev (`https://api.typesafe.ai`) に送ります。ソースコードへの
ハードコードはなく、ログにも出力しません (解析結果のログには感情・反応・信頼度のみを
残し、APIキーと入力全文は出しません)。

### ローカルHTTP APIからの利用

`POST /v1/motions` の `use_jev` は任意の真偽値です。省略時はサーバーにキーがあれば
自動利用し、`false` ならそのリクエストだけ解析を省略します。

```bash
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"やったー！ついに完成した！！","engine":"ardy","use_jev":true}'
```

解析結果だけが欲しい場合 (モーションは生成しない) は専用エンドポイントを使えます。

```bash
curl -X POST http://127.0.0.1:8787/v1/motion-context \
  -H "Content-Type: application/json" \
  -d '{"text":"えっ！？本当に！？"}'
# => {"emotion":"surprise","emotion_intensity":0.8,"reaction":"startled", ...}
```

`use_jev` はサーバー側で `JEV_API_KEY` が設定され、明示的に無効化されていない場合のみ実際に
動作し、リクエスト側からAPIキーを渡したり運用者の設定を上書きしたりすることはできません。
既存のHost/Origin/トークン検証もこの2つのエンドポイントに対して同様に適用されます。

### 通信について

Jevを有効にすると、入力テキスト (最大2000文字に切り詰め) が TypeSafe AI のAPI
(`https://api.typesafe.ai`) へ送信されます。新規生成は前回の演技状態を送りません。
明示的な追加修正では、現在の動作・姿勢・表情・再生位置の限定された状態も渡します。

利用経路・遅着・身体への適用確認は生成specの `jevContext` / `jev` / `realtime.jev` に記録します。
経路と制約は [Jevの生成経路への接続](docs/jev-generation-integration.md) を参照してください。

## アーキテクチャ

```text
[LLMキーフレームモード]
テキスト ── OpenAI API / Codex CLI ──▶ モーション spec (ボーン別オイラー角キーフレーム JSON)

[ARDYモード]
テキスト ── 選択したAI (演技計画・動作分割) ──▶ ARDYエンジンサーバー (localhost:2337)
              │  Codex / OpenAI / Claude        │ 拡散モデルで20fpsモーション生成
              └ AIなしならARDY内蔵翻訳          │ → 足滑り補正 → VRMリターゲット
                                                ▼
                                    モーション spec ──▶ なめらか補正 ──▶ AIレビュー (任意)
```

spec 以降は両モード共通:

```text
                          モーション spec
                                   │
                                   ▼
              vrmaBuilder.js ── glTF + VRMC_vrm_animation 拡張 → GLB (.vrma)
                                   │
                                   ▼
              viewer.js ── three.js + @pixiv/three-vrm-animation で VRM に再生
```

| ファイル | 役割 |
| --- | --- |
| `src/llm.js` | OpenAI API へのプロンプト (ボーン規約・お手本モーション5種) / 2パス自己修正 / spec 検証・角度クランプ |
| `src/vrmaBuilder.js` | モーション spec から VRMA (GLB) をバイナリ生成。VRM1 規約の T ポーズ骨格を埋め込み、`VRMC_vrm_animation` 拡張でヒューマノイドボーンをマッピング |
| `src/viewer.js` | three.js シーン / VRM ロード / VRMA 再生 |
| `src/idleMotion.js` | 待機モーション (呼吸) |
| `src/main.js` | UI 結線 |
| `src/autoExpressions.js` | ARDYモード用: 感情語からの表情自動付与 + まばたき (混合感情・時間順の感情に対応) |
| `src/emotionActing.js` | 感情を身体動作へ反映する共通指針 (計画・生成・レビューで共有) |
| `src/smoothMotion.js` | 全身のなめらか補正。足首高から接地を推定し、接地付近は補正を抑える |
| `src/motionCompliance.js` | 指示追従チェック。移動・ジャンプ・しゃがみ・手上げをアバター上で計測 |
| `src/ardyCandidates.js` / `src/candidatePanel.js` | 3候補の生成と比較・選択 |
| `src/motionReview.js` / `src/ardyReview.js` | 生成後のAIレビュー (修正が必要かの判定を含む) |
| `src/directMotionReview.js` / `src/motionPatch.js` | 関節を直接補正する経路と、その適用・検証 |
| `src/segmentedReview.js` | 長い動作を15秒程度の区間へ分けて修正 |
| `src/motionAssessment.js` | 足滑り・沈み込み等の物理指標の算出 |
| `src/reviewCapture.js` | 生成モーションの正面・側面を自動撮影 (画像レビュー用) |
| `src/motionCheckPanel.js` / `src/reviewI18n.js` | 再生状態・生成経路・チェック結果の表示と多言語化 |
| `src/loopPlayback.js` | ループ再生時に頭と末尾をつなぐ処理 |
| `src/codexWebBridge.js` / `src/codexUsage.js` | ローカルWeb版のCodex接続と利用枠表示 |
| `tools/codex-web.mjs` | Vite開発サーバーから `codex app-server` へ中継するプラグイン |
| `electron/codex-client.cjs` | Codex app-server接続 / ChatGPT認証 / モデル取得 / 一時スレッドでの生成 |
| `electron/ardy-client.cjs` | ARDYエンジンサーバーの起動・監視 (デスクトップ版) |
| `electron/preload.cjs` | 認証情報を公開しない限定IPCブリッジ |
| `src/apiServer.js` | ローカルHTTP API本体 (OpenAI / ARDY 両エンジンに対応) |
| `tools/api-server.mjs` | APIサーバーの起動エントリ (`npm run api`) |
| `tools/ardy-engine/server.py` | ARDY常駐サーバー: 生成・日本語翻訳・経由地制約・進捗API |
| `tools/ardy-engine/retarget.py` | ARDY Coreスケルトン → VRM Humanoid リターゲット |
| `tools/ardy-engine/install.ps1` | エンジンのワンコマンドセットアップ (Windows) |
| `tools/ardy-engine/install_mac.sh` | macOS用エンジンのワンコマンドセットアップ |
| `tools/ardy-engine/install_linux.sh` | Linux用エンジンのワンコマンドセットアップ |

## モーション spec フォーマット

LLM が生成する中間表現です:

```json
{
  "name": "wave",
  "duration": 2.6,
  "loop": true,
  "tracks": {
    "rightUpperArm": [
      { "t": 0, "r": [0, 0, 70] },
      { "t": 0.4, "r": [0, 0, -45] }
    ]
  },
  "hips": [ { "t": 0, "p": [0, 0, 0] } ]
}
```

- `r` = T ポーズからのオイラー角 [X, Y, Z] (度) / `p` = 腰位置オフセット (m)
- `expressions` は VRM プリセット表情 (happy / blink 等) のウェイト (0〜1)。
  プレビューでは常に再生され、`.vrma` 保存時は含めるかどうかを選択できます
  (再生側アプリが VRMA の表情トラックに対応している必要があります)
- 座標規約: モデルは +Z 正面 / +X が左手側 (VRM 1.0 準拠)

## ローカルHTTP API (開発者向け・試験的機能)

> **v1.1.7 で追加した試験的機能です。** 特に ARDY エンジン経由の生成は
> 検証が浅く、インターフェースも今後変わる可能性があります。
> **実際に使ってみた感想・不具合報告を歓迎します** —
> [Issues](https://github.com/Kirakun0328/text-to-vrma/issues) までどうぞ。

他のアプリやスクリプトから Text-To-VRMA を呼び出すためのローカルAPIサーバーです。
Unity / Blender / 自作ツール / シェルスクリプトなどから、テキストを投げて
モーション spec や `.vrma` を受け取れます。

```bash
cp .env.example .env   # 初回のみ。OPENAI_API_KEY を書いておく (ARDYだけなら不要)
npm run api            # http://127.0.0.1:8787 で起動
```

`.env` はリポジトリ直下に置けば起動時に自動で読まれます (Gitには入りません)。
起動すると、どのエンジンが今すぐ使えるかが表示されます:

```text
.env を読み込みました
Text-To-VRMA API listening on http://127.0.0.1:8787
  engine=openai : 未設定 (.env に OPENAI_API_KEY を設定してください)
  engine=claude : 未設定 (.env に ANTHROPIC_API_KEY を設定してください)
  engine=ardy   : 利用可能 (ARDY-Core-RP-20FPS-Horizon40 / GPU)
```

`engine=ardy` は**APIキーなしで使えます** (ARDYローカルエンジンの起動が必要)。
`engine=openai` / `engine=claude` はキーが要りますが、ARDYのセットアップは不要です。

### デスクトップ版から使う (v1.1.7〜)

コマンドを使わず、アプリの「詳細設定 → ローカルHTTP API」から有効にできます。
**既定はオフ**で、チェックを入れたときだけ 127.0.0.1 にポートを開きます。

- アプリに設定済みの OpenAI / Claude のキーをそのまま使うので、二重の設定は不要です
- **アクセストークンが必須**です。設定欄に表示されるので、呼び出す側の
  `Authorization: Bearer <token>` に指定してください。インストールごとに固定なので
  外部ツール側は一度書けば済みます。漏れた場合は「🔄 再生成」で無効化できます
- ポートが使用中の場合はその旨を表示します (別のポートを指定してください)

```bash
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Authorization: Bearer <アプリに表示されたトークン>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"前に歩いて手を振る","engine":"ardy","format":"vrma"}' \
  -o walk.vrma
```

### セキュリティ

**既定では 127.0.0.1 のみで待ち受ける**ため、同じPC上のアプリからのみ到達できます。
外部へ公開する場合は `TEXT_TO_MOTION_API_TOKEN` の設定が必須で、未設定なら起動時に
エラーになります (その場合は全リクエストに `Authorization: Bearer <token>` が必要)。

| エンドポイント | 説明 |
| --- | --- |
| `GET /health` | 稼働状態・利用可能エンジン・キー設定の有無 |
| `GET /openapi.json` | OpenAPI 3.1 定義 |
| `POST /v1/motions` | テキストからモーションを生成 |
| `POST /v1/vrma` | 既存の spec を `.vrma` に変換 (キー不要) |
| `POST /v1/motion-context` | Jevで意味・感情のみを解析 (Jev設定時のみ。下記参照) |

`POST /v1/motions` のリクエスト:

| フィールド | 既定 | 説明 |
| --- | --- | --- |
| `prompt` | (必須) | 動きの指示。1〜4000文字 |
| `engine` | `openai` | `openai` / `claude` / `codex` = LLMキーフレーム / `ardy` = ARDYローカルエンジン |
| `planner` | `codex` | `ardy` のみ: 動作計画に使うAI (`codex` / `openai` / `claude` / `none`) |
| `speed` | — | `openai` / `codex`: `fast` / `balanced` / `quality`。`fast` は推論量とキー数を抑える |
| `format` | `json` | `json` は spec、`vrma` は `.vrma` バイナリを返す |
| `model` | 環境変数 | `openai`・`claude` では生成モデル、`ardy` では動作分割に使うGPTモデル |
| `refine` | `true` | `openai`・`claude` で有効な2パス自己修正 |
| `duration` | — | `ardy` のみ: 生成する長さ (秒) |
| `waypoints` | — | `ardy` のみ: 移動経路 `[{ "x": 1, "z": 2 }]` |
| `use_jev` | キー設定時に自動 | Jevで意味・感情を解析し補助情報として使う。`false` はリクエスト単位で無効。サーバーにJevが未設定なら従来どおり生成 |

```bash
# ARDYローカルエンジンで生成 (APIキー不要。エンジンの起動が必要)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"前に歩いて手を振る","engine":"ardy","format":"vrma"}' \
  -o walk.vrma

# OpenAI APIキーで生成 (サーバー起動時に OPENAI_API_KEY が必要)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"お辞儀する"}'
```

```bash
# Claude で生成 (サーバー起動時に ANTHROPIC_API_KEY が必要)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"お辞儀する","engine":"claude","model":"claude-sonnet-5-5"}'
```

環境変数: `PORT` (既定 8787) / `HOST` (既定 127.0.0.1) / `OPENAI_API_KEY` /
`OPENAI_BASE_URL` / `OPENAI_MODEL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` /
`ARDY_URL` (既定 `http://127.0.0.1:2337`) /
`TEXT_TO_MOTION_API_TOKEN` / `TEXT_TO_MOTION_CORS_ORIGIN` /
`JEV_API_KEY` / `JEV_ENABLED` / `JEV_MODEL` / `JEV_TIMEOUT_MS` /
`JEV_CONFIDENCE_THRESHOLD` (詳細は後述の「Jev (TypeSafe AI) による意味・感情解析」を参照)。

悪意あるWebページから勝手に叩かれないよう、以下を多層で防いでいます。

| 対策 | 内容 |
| --- | --- |
| バインド先 | 127.0.0.1 のみ。外部公開は `TEXT_TO_MOTION_API_TOKEN` 必須 |
| Host検証 | ループバック名以外を403 (DNSリバインディング対策) |
| Origin検証 | 付いていれば検証。外部オリジンを403 |
| Sec-Fetch-Site | `cross-site` を403 |
| Content-Type | POSTは `application/json` のみ (それ以外は415) |
| メソッド | GET / POST / OPTIONS 以外は405 |
| CORS | 既定でヘッダーを返さない (ワイルドカードは使わない) |
| サイズ上限 | リクエスト本文 1 MiB |
| トークン | デスクトップ版では必須。CLIでも `TEXT_TO_MOTION_API_TOKEN` で有効化 |

APIキーの値がレスポンスに含まれないことはテストで固定しています。
ただし**APIに到達できる相手はキーを見なくても「使える」**点には注意してください
(生成が走り、利用料が消費されます)。デスクトップ版でトークンを必須にしているのは
このためです。

> **ブラウザ上の Web ページから呼ぶ場合のみ** `TEXT_TO_MOTION_CORS_ORIGIN` の設定が必要です
> (既定ではCORSヘッダーを返さないため、ブラウザ側がブロックします)。
> curl・Python・Unity・Node などブラウザ外のクライアントには制限はありません。

## 注意事項

- **動作確認環境: Windows 11** (macOS / Linux にはセットアップスクリプトを用意して
  いますが、開発者による動作確認は Windows のみです。ブラウザで動く Web アプリのため
  動作する見込みはありますが、保証はありません。不具合報告・修正PRを歓迎します)
- APIキーモードのモーション生成には OpenAI API の利用料が発生します (1回あたり数円〜十数円程度。
  使用モデルとモーションの長さによって変動)
- OpenAI の [データ共有プログラム (Complimentary daily tokens)](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)
  を有効にすると、1日あたりの無料トークン枠内で**無料で試せます**
  (API の入出力が OpenAI のモデル学習に共有される点に注意。対象アカウント・地域の条件あり。
  本プログラムは OpenAI 側の都合で変更・終了される可能性があります)
- Codexモードはログイン中のChatGPT/Codexプランの利用上限と組織ポリシーに従います。
  Codexサブスクリプションの本ツールでの利用が OpenAI の利用規約・ポリシー上
  許容されるかは利用者自身でご確認ください (利用は自己責任です)
- アプリ内のCodexログアウトは、このPC上のCodex CLI全体のログイン状態へ影響します
- **ARDYローカルエンジンを使う場合でも、OpenAI APIキー (または互換API) を設定しておくと、
  複雑な動作の解釈・分割・検証を AI が担い、より意図どおりのモーションになりやすくなります**
  (APIキーが無くてもローカル翻訳で動作します)
- ARDYローカルエンジンは実験的機能です。モデルの性質上、同じテキストでも生成のたびに
  違うモーションになります (気に入らなければ再生成してください)。
  モデル重み (NVIDIA ARDY / Meta Llama 3 / FuguMT) は本リポジトリに含まれず、
  セットアップ時に各配布元 (Hugging Face) から利用者自身がダウンロードします。
  各モデルのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください
- 生成される `.vrma` の利用は各自の責任で行ってください

## 免責事項

本ソフトウェアは現状のまま・無保証で提供されます。
本ソフトウェアの利用または利用不能により生じたいかなる損害
(API 利用料、データの損失、生成物に起因するトラブル等を含む) についても、
開発者は一切の責任を負いません。
生成された `.vrma` の利用、および各種AI・APIの利用は、各自の責任で行ってください。

## 💖 支援のお願い / Support This Project

**Text-To-VRMA は、個人開発の無料オープンソースです。**

「テキストを打つだけで、誰でも自分のキャラクターを動かせる」——
その世界を目指して、NVIDIAの最新モーションAI (ARDY) の統合のような挑戦も含め、
これからも便利で使いやすいオープンソースを公開していく予定です。

正直に書くと、いまは職を離れ、生活的に厳しい状況の中で開発を続けています。
それでも作りたいものがたくさんあります。もし本ツールが役に立ったなら、
応援・ご支援をいただけるととても励みになります 🙇

---

**Text-To-VRMA is free & open-source, built by an independent developer in Japan.**

The goal: anyone can bring their VRM character to life just by typing —
powered by state-of-the-art motion AI, running on your own PC, free forever.

I'll be honest: I'm currently between jobs and building this through financially
difficult times. But there is so much more I want to create — more open-source
tools for the VRM / VTuber / creative community.

If this tool helps you, or you simply want to see more projects like it,
your support genuinely keeps this work (and its developer) going 💚

### **[❤️ GitHub Sponsors — github.com/sponsors/Kirakun0328](https://github.com/sponsors/Kirakun0328)**

スターを付けてもらえるだけでも大きな励みになります! / Even a ⭐ on this repo means a lot!

## 🙏 コントリビューター / Contributors

- [@emadurandal](https://github.com/emadurandal) — macOS対応 (ARDYエンジンのmacOSインストーラーと起動安定化、[#2](https://github.com/Kirakun0328/text-to-vrma/pull/2))、および長さ指定の不具合報告 ([#5](https://github.com/Kirakun0328/text-to-vrma/issues/5))。
  素晴らしいコントリビュートをありがとうございます!
- [@taiyop](https://github.com/taiyop) — Electronデスクトップ版のビルド・起動手順をREADMEに追記 ([#3](https://github.com/Kirakun0328/text-to-vrma/pull/3))。
  ありがとうございます!
- [@zzmzaizai](https://github.com/zzmzaizai) — OpenAI互換プロバイダ対応のご提案 ([#4](https://github.com/Kirakun0328/text-to-vrma/issues/4))。
  ありがとうございます!
- [@mouseos](https://github.com/mouseos) — Linux対応 (ARDYエンジンのLinuxインストーラーと起動分岐、実機で動作確認、[#7](https://github.com/Kirakun0328/text-to-vrma/pull/7))。
  素晴らしいコントリビュートをありがとうございます!
- [@Misuta890](https://github.com/Misuta890) — Electron版のエンジン切替の不具合修正 ([#8](https://github.com/Kirakun0328/text-to-vrma/pull/8))。
  ありがとうございます!
- [@AUDOSt0ck1ng](https://github.com/AUDOSt0ck1ng) — Claude API (Anthropic) 対応 (ブラウザ版・デスクトップ版で動作確認、[#9](https://github.com/Kirakun0328/text-to-vrma/pull/9) / [#11](https://github.com/Kirakun0328/text-to-vrma/issues/11))。
  素晴らしいコントリビュートをありがとうございます!
- [@hsm-hx](https://github.com/hsm-hx) — Claude 5.5 世代と Fable 5.1 への対応、拒否時のサーバー側フォールバック ([#17](https://github.com/Kirakun0328/text-to-vrma/pull/17))。
  ありがとうございます!
- [@meryuhi](https://github.com/meryuhi) — ARDYエンジンのリターゲットで足が浮く問題の修正 (Unityで足首の高さを計測して確認、[#18](https://github.com/Kirakun0328/text-to-vrma/pull/18))。
  ありがとうございます!

バグ報告・機能提案・PRを歓迎しています。macOS / Linux 環境の改善はコミュニティの力が頼りです。

## 開発者

- X (Twitter): [@Kiratchi0328](https://x.com/Kiratchi0328)

## ライセンス

- ソースコード: MIT License (Copyright (c) 2026 Kiratchi)。
  **MIT License はソースコードにのみ適用され、サードパーティ素材 (同梱 VRM モデル等) は対象外です**
  (詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
- **クレジット表記のお願い**: 本ツールをアプリやサービスに組み込む場合、
  義務ではありませんが、画面やクレジット欄に以下のような表記をしていただけると嬉しいです。

  ```text
  Motion generation powered by Text-To-VRMA (© Kiratchi)
  https://github.com/Kirakun0328/text-to-vrma
  ```

  なお MIT ライセンスの条件として、コードのコピー・再配布時には上記の著作権表示と
  ライセンス文の同梱が必要です。

- ARDYローカルエンジンが利用する外部モデルのライセンス:
  - NVIDIA ARDY — コード: Apache-2.0 / 重み: NVIDIA Open Model Agreement (商用利用可)
  - Meta Llama 3 — Meta Llama 3 Community License。本機能は **Built with Meta Llama 3**
  - FuguMT (日英翻訳) — CC BY-SA 4.0
  - 詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照
- 同梱の AvatarSample モデル (© pixiv Inc.) は **MIT ライセンスの対象外**です。
  ピクシブ株式会社の [AvatarSample A〜Z 利用条件](https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z)
  が適用されます (無償利用・再配布可 / **有償での再配布と CC0 としての配布は禁止**)。
  モデルに関する著作権その他の権利は各権利者に帰属します
- その他の VRM モデルは各モデルの利用規約に従ってください
- **生成された `.vrma` は MIT ライセンスの対象外**で、生成した利用者のものです。
  本プロジェクトが生成物に権利を主張することはなく、商用含め自由に利用できます
