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
| OS | Windows 10/11 64bit、macOS、Linux | 同左 |
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

Linux:

```bash
bash tools/ardy-engine/install_linux.sh
```

Linux版は apt / dnf / yum / pacman / zypper に対応し、不足しているツール (Python 3.10+ /
git / gcc・g++ / cmake) を必要に応じて自動導入します (sudo を使用)。NVIDIA GPU があれば
CUDA 版 PyTorch を自動選択します。

Python 3.10+ と git が必要です。ダウンロード合計約20GBのため時間がかかります。
完了後、アプリの「ARDYローカルエンジン」モードの「エンジンを起動」ボタンで利用できます。

## 手動起動

```powershell
# Windows
<venvのpython> tools\ardy-engine\server.py --merged-base <llm2vec-base-mergedのパス>
```

```bash
# macOS / Linux
<venvのpython> tools/ardy-engine/server.py --merged-base <llm2vec-base-mergedのパス>
```

- `--port` (既定 2337) / `--no-translate` (日本語英訳を無効化)
- `--text-encoder <パス>` — テキストエンコーダを明示指定 (ローカルディレクトリ)。
  指定ディレクトリだけを読み込み、ARDY既定のエンコーダや別のHugging Faceモデルは取得しません。
  BF16 / 8-bit / 4-bit はディレクトリの config.json の `quantization_config` で自動判別。
  `--merged-base` より優先
- `--text-encoder-device cuda|cpu|cuda:1` — テキストエンコーダのデバイス。
  環境変数 `TEXT_ENCODER_DEVICE` より優先 (未指定なら従来通り)。アニメーションモデルと
  エンコーダは別デバイスにできます

```bash
# アニメモデルはcuda、テキストエンコーダもcudaで明示指定
<venvのpython> tools/ardy-engine/server.py \
  --model ARDY-Core-RP-20FPS-Horizon40 \
  --text-encoder <encoder-dir> \
  --text-encoder-device cuda
```

- テキストエンコーダのデバイスは環境変数 `TEXT_ENCODER_DEVICE` でも指定可 (既定はアプリ起動時 `cpu`)

## API

- `GET /health` → `{"status":"ok","model":...,"device":...,"translator":...}`
- `POST /generate` `{"text":"お辞儀する","duration":4}` → モーションspec JSON

## 量子化 (4-bit / 8-bit)  [実験的]

llm2vec-base-merged (~16GB bf16) を bitsandbytes で量子化し、VRAM / ディスクを大幅削減できます。

| ビット | 目安サイズ | VRAM (推論時) | 備考 |
|---|---|---|---|
| bf16 (非量子化) | ~16 GB | ~16 GB | 既定 |
| **4-bit (nf4)** | **~4.5 GB** | **~5 GB** | 推奨。コサイン類似度 ≥0.98 で実用的 |
| 8-bit | ~8.7 GB | ~9 GB | より高品質だが VRAM 要求大 |

### 手順

1. **engine venv に bitsandbytes を導入** (Linux / Windows / macOS 共通):
   ```bash
   <venvのpython> -m pip install bitsandbytes
   ```

2. **量子化実行** (engine venv 内で):
   ```bash
   # 4-bit (推奨)
   <venvのpython> tools/ardy-engine/quantize_text_encoder.py --in <llm2vec-base-merged> --out <llm2vec-base-4bit> --bits 4 --verify 3

   # 8-bit
   <venvのpython> tools/ardy-engine/quantize_text_encoder.py --in <llm2vec-base-merged> --out <llm2vec-base-8bit> --bits 8 --verify 3
   ```

3. **量子化モデルでエンジン起動**:
   ```bash
   TEXT_ENCODER_DEVICE=cuda <venvのpython> tools/ardy-engine/server.py --merged-base <llm2vec-base-4bit>
   ```

   - `--merged-base` に量子化先ディレクトリを指定するだけで、config.json の `quantization_config` から自動的に量子化モードで読み込まれます。
   - `TEXT_ENCODER_DEVICE=cuda` を推奨 (4bit/8bit は CUDA 必須)。

### 注意点

- Kaggle 等の GPU ノートブックで実行推奨 (T4 16GB VRAM で 4-bit 余裕、8-bit ギリギリ)。
- 量子化にはソース (~16GB) + 出力 (~4.5/8.7GB) のディスクが必要。`df -h` で確認を。
- 出力ディレクトリに `quantize-complete.marker` が作成されます (installer と同じ慣習)。
- 検証 (`--verify`) は bf16 基準とコサイン類似度 ≥0.98 で判定。RAM 不足時は整合性チェックのみにフォールバック。

## ライセンス表記

このエンジンは以下のモデル・ソフトウェアを利用します。再配布時は各ライセンスに従ってください。

- **ARDY** — コード: Apache-2.0 / モデル重み: [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/) (商用利用可)
- **Meta Llama 3 (8B Instruct)** — [Meta Llama 3 Community License](https://llama.meta.com/llama3/license)。**Built with Meta Llama 3**
- **LLM2Vec アダプタ** (McGill-NLP) — MIT
- **FuguMT** (staka/fugumt-ja-en) — CC BY-SA 4.0

モデル重みはこのリポジトリに同梱せず、セットアップ時に各配布元 (Hugging Face) から取得します。
