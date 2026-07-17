#!/usr/bin/env bash
# install.sh — ARDYローカルエンジンのセットアップスクリプト (macOS)
#
# ターミナルから起動します: bash tools/ardy-engine/install.sh
# インストール先を変える場合: bash tools/ardy-engine/install.sh --engine-root /path/to/ardy-engine
#
# やること (全自動):
#   1. Python 3.10+ / Git / C++ビルドツールを確認し、必要なら導入
#   2. ARDY本体の取得とビルド
#   3. モデル重みのダウンロード (約20GB)
#   4. アプリ用設定ファイルの書き出し
#
# 必要ディスク: 約35GB / 必要RAM: 16GB以上

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="${HOME}/Library/Application Support/text-to-vrma/ardy-engine"
TORCH_VERSION="2.11.0"

usage() {
  cat <<'EOF'
使い方: install.sh [--engine-root PATH]

オプション:
  --engine-root PATH  エンジンのインストール先
  -h, --help          このヘルプを表示
EOF
}

while (($# > 0)); do
  case "$1" in
    --engine-root)
      if (($# < 2)); then
        echo "エラー: --engine-root にはパスが必要です。" >&2
        exit 2
      fi
      ENGINE_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "エラー: 不明なオプションです: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

wait_exit() {
  local code="$1"
  if [[ -t 0 ]]; then
    echo
    read -r -p "Enterキーを押すとウィンドウを閉じます" _ || true
  fi
  exit "$code"
}

on_error() {
  local code=$?
  local line="${BASH_LINENO[0]:-不明}"
  trap - ERR
  echo >&2
  echo "エラーが発生しました (スクリプト行: ${line})。" >&2
  echo "もう一度実行すると、完了済みの手順は再利用して続きから再開します。" >&2
  echo "解決しない場合は、直前のエラー内容を添えて GitHub の Issue でお知らせください:" >&2
  echo "  https://github.com/Kirakun0328/text-to-vrma/issues" >&2
  wait_exit "$code"
}
trap on_error ERR

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "このスクリプトは macOS 専用です。Windows では install.ps1 を使用してください。" >&2
  exit 1
fi

echo "=========================================="
echo " Text-To-VRMA : ARDYエンジン セットアップ"
echo "=========================================="
echo "インストール先: ${ENGINE_ROOT}"
echo "約20GBをダウンロードします。回線により30分〜1時間程度かかります。"
echo

# --- 0. Xcode Command Line Tools ---
if ! xcode-select -p >/dev/null 2>&1 || ! command -v clang++ >/dev/null 2>&1; then
  echo "Xcode Command Line Tools のインストーラーを起動します。"
  echo "インストール完了後、このスクリプトをもう一度実行してください。"
  xcode-select --install 2>/dev/null || true
  wait_exit 1
fi

# --- 0.5. Homebrew ---
find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    echo /opt/homebrew/bin/brew
  elif [[ -x /usr/local/bin/brew ]]; then
    echo /usr/local/bin/brew
  fi
  return 0
}

BREW="$(find_brew)"
if [[ -z "$BREW" ]]; then
  echo "Homebrew をインストールしています..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  BREW="$(find_brew)"
fi
if [[ -z "$BREW" ]]; then
  echo "Homebrew をインストールできませんでした: https://brew.sh/" >&2
  exit 1
fi
eval "$("$BREW" shellenv)"

# --- 1. Python ---
python_is_supported() {
  "$1" -c 'import sys; raise SystemExit(sys.version_info[:2] < (3, 10))' \
    >/dev/null 2>&1
}

PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && python_is_supported "$candidate"; then
    PYTHON="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "[1/5] Python 3.12 をインストールしています..."
  "$BREW" install python@3.12
  PYTHON="$($BREW --prefix python@3.12)/bin/python3.12"
fi
if ! python_is_supported "$PYTHON"; then
  echo "Python 3.10以上をインストールできませんでした。https://www.python.org/ から手動でインストールしてください。" >&2
  exit 1
fi
echo "[1/5] Python: OK ($("$PYTHON" --version 2>&1))"

# --- 2. Git ---
if ! command -v git >/dev/null 2>&1; then
  echo "[2/5] Git をインストールしています..."
  "$BREW" install git
fi
GIT="$(command -v git)"
echo "[2/5] Git: OK"

# --- 3. C++ビルドツール ---
if ! clang++ --version >/dev/null 2>&1; then
  echo "C++ビルドツール (clang++) を起動できません。Xcode Command Line Tools を再インストールしてください。" >&2
  exit 1
fi
echo "[3/5] C++ビルドツール: OK (Apple Clang)"

echo "実行デバイス: CPU (macOS)"

# ダウンロード時の紛らわしい警告を抑制
export HF_HUB_DISABLE_SYMLINKS_WARNING=1

# --- 4. Python環境 + ARDY本体 + モデル ---
mkdir -p "$ENGINE_ROOT"
VENV_PY="$ENGINE_ROOT/venv/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  "$PYTHON" -m venv "$ENGINE_ROOT/venv"
fi
"$VENV_PY" -m pip install --upgrade pip --quiet

echo "[4/5] AIエンジンを構築しています... (数GBのダウンロード)"
"$VENV_PY" -m pip install "torch==$TORCH_VERSION"

if ! "$VENV_PY" -c "import torch; print(torch.__version__)"; then
  echo "PyTorchの動作確認に失敗しました。検証済みバージョンを再インストールします..." >&2
  "$VENV_PY" -m pip uninstall -y torch
  "$VENV_PY" -m pip install --no-cache-dir "torch==$TORCH_VERSION"
fi
if ! "$VENV_PY" -c "import torch; print('PyTorch: OK (' + torch.__version__ + ')')"; then
  echo "PyTorchを起動できませんでした。macOSを更新し、スクリプトを再実行してください。" >&2
  exit 1
fi

ARDY_REPO="$ENGINE_ROOT/ardy"
if [[ ! -f "$ARDY_REPO/setup.py" ]]; then
  if [[ -e "$ARDY_REPO" ]]; then
    echo "ARDYの取得先に不完全なファイルがあります: $ARDY_REPO" >&2
    echo "内容を確認して別の場所へ移動してから再実行してください。" >&2
    exit 1
  fi
  "$GIT" clone --depth 1 https://github.com/nv-tlabs/ardy.git "$ARDY_REPO"
fi

"$VENV_PY" -m pip install cmake sentencepiece --quiet
(
  cd "$ARDY_REPO"
  "$VENV_PY" -m pip install -e .
)

echo "[5/5] モデルをダウンロードしています... (約20GB。ここが一番時間がかかります)"
"$VENV_PY" -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='nvidia/ARDY-Core-RP-20FPS-Horizon40')"

MERGED_BASE="$ENGINE_ROOT/llm2vec-base-merged"
if [[ ! -f "$MERGED_BASE/model.safetensors" ]]; then
  "$VENV_PY" "$SCRIPT_DIR/build_text_encoder.py" --out "$MERGED_BASE"
fi

# --- 5. アプリ用設定ファイル ---
# 開発版 (package.json の name) と配布版 (productName) の userData 候補へ保存する。
for config_dir in \
  "$HOME/Library/Application Support/text-to-vrma" \
  "$HOME/Library/Application Support/Text-To-VRMA"; do
  mkdir -p "$config_dir"
  CONFIG_PATH="$config_dir/ardy-engine.json" \
  CONFIG_PYTHON="$VENV_PY" \
  CONFIG_MERGED_BASE="$MERGED_BASE" \
    "$VENV_PY" -c 'import json, os
path = os.environ["CONFIG_PATH"]
config = {
    "pythonExe": os.environ["CONFIG_PYTHON"],
    "mergedBase": os.environ["CONFIG_MERGED_BASE"],
    "port": 2337,
    "textEncoderDevice": "cpu",
}
with open(path, "w", encoding="utf-8") as file:
    json.dump(config, file, ensure_ascii=False, indent=2)
    file.write("\n")'
done

echo
echo "=========================================="
echo " セットアップ完了!"
echo "=========================================="
echo "アプリに戻り、「エンジンを起動」を押してください。"
echo
echo "本エンジンは Meta Llama 3 を利用しています (Built with Meta Llama 3)。"
echo "ライセンス: ARDY=NVIDIA Open Model / Llama-3-8B=Meta Llama 3 Community License / FuguMT=CC BY-SA 4.0"
wait_exit 0
