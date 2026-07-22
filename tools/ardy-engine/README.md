# ARDY ローカルエンジン

[NVIDIA ARDY](https://github.com/nv-tlabs/ardy) (SIGGRAPH 2026) をローカルで動かし、
Text-To-VRMA アプリに**モーションキャプチャ品質のモーション生成**を提供するエンジンです。

- テキスト → 20fps の全身モーション (歩行・ジャンプ・ダンス等の全身連動が本物らしく出ます)
- **日本語プロンプトOK** — [FuguMT](https://huggingface.co/staka/fugumt-ja-en) でローカル自動英訳
- 完全オフライン・無料・生成回数無制限 (セットアップ後)
- 表情はアプリ側がプロンプトの感情語から自動付与します

## 動作要件

| | 最低 | 推奨 |
|---|---|---|
| OS | Windows 10/11 64bit、macOS | 同左 |
| RAM | 16GB | 32GB+ |
| ディスク | 35GB | 同左 |
| GPU | VRAM 4GB〜 (無くてもCPUで1回数十秒) | NVIDIA GPU 6GB+ (1回数秒) |

## セットアップ

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\ardy-engine\install.ps1
```

macOS:

```bash
bash tools/ardy-engine/install_mac.sh
```

macOSでHomebrewが未導入の場合は、セットアップ中に自動でインストールされます。
macOS対応は [@emadurandal](https://github.com/emadurandal) さんのコントリビュートによるものです。

Python 3.10+ と git が必要です。ダウンロード合計約20GBのため時間がかかります。
完了後、アプリの「ARDYローカルエンジン」モードの「エンジンを起動」ボタンで利用できます。

## 手動起動

```powershell
<venvのpython> tools\ardy-engine\server.py --merged-base <llm2vec-base-mergedのパス>
```

- `--port` (既定 2337) / `--no-translate` (日本語英訳を無効化)
- テキストエンコーダのデバイスは環境変数 `TEXT_ENCODER_DEVICE` (既定はアプリ起動時 `cpu`)

## API

- `GET /health` → `{"status":"ok","model":...,"device":...,"translator":...}`
- `POST /generate` `{"text":"お辞儀する","duration":4}` → モーションspec JSON

## ライセンス表記

このエンジンは以下のモデル・ソフトウェアを利用します。再配布時は各ライセンスに従ってください。

- **ARDY** — コード: Apache-2.0 / モデル重み: [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/) (商用利用可)
- **Meta Llama 3 (8B Instruct)** — [Meta Llama 3 Community License](https://llama.meta.com/llama3/license)。**Built with Meta Llama 3**
- **LLM2Vec アダプタ** (McGill-NLP) — MIT
- **FuguMT** (staka/fugumt-ja-en) — CC BY-SA 4.0

モデル重みはこのリポジトリに同梱せず、セットアップ時に各配布元 (Hugging Face) から取得します。
