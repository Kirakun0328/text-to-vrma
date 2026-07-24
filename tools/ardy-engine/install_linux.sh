#!/usr/bin/env bash
# install_linux.sh — ARDYローカルエンジンのセットアップスクリプト (Linux)
#
# ターミナルから起動します: bash tools/ardy-engine/install_linux.sh
# インストール先を変える場合: bash tools/ardy-engine/install_linux.sh --engine-root /path/to/ardy-engine
#
# やること (全自動):
#   1. Python 3.10+ / Git / C++ビルドツール (gcc/g++/cmake) を確認し、必要なら導入
#   2. NVIDIA GPU を検出して PyTorch (CUDA / CPU) を出し分け
#   3. ARDY本体の取得とビルド
#   4. モデル重みのダウンロード (約20GB)
#   5. アプリ用設定ファイルの書き出し
#
# 必要ディスク: 約35GB / 必要RAM: 16GB以上
#
# 対応パッケージマネージャ: apt / dnf / yum / pacman / zypper
# (それ以外の場合は必要なツールを手動でインストールしてから再実行してください)

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/text-to-vrma/ardy-engine"
# Windows版と揃えた検証済みバージョン/固定リビジョン
TORCH_VERSION="2.11.0"
CUDA_INDEX_URL="https://download.pytorch.org/whl/cu128"
ARDY_COMMIT="693f74d13b3d04a0a22ce127ee79c929dd89756b"
ARDY_MODEL_REPO="nvidia/ARDY-Core-RP-20FPS-Horizon40"
ARDY_MODEL_REVISION="abe6c43beb28c867c950acb824b9c4ef3d63fb76"

usage() {
  cat <<'EOF'
使い方: install_linux.sh [--engine-root PATH]

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

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "このスクリプトは Linux 専用です。Windows では install.ps1、macOS では install_mac.sh を使用してください。" >&2
  exit 1
fi

echo "=========================================="
echo " Text-To-VRMA : ARDYエンジン セットアップ"
echo "=========================================="
echo "インストール先: ${ENGINE_ROOT}"
echo "約20GBをダウンロードします。回線により30分〜1時間程度かかります。"
echo

# --- パッケージマネージャ検出 ---
PM=""
PM_INSTALL=""
if command -v apt-get >/dev/null 2>&1; then
  PM="apt"; PM_INSTALL="apt-get install -y"
elif command -v dnf >/dev/null 2>&1; then
  PM="dnf"; PM_INSTALL="dnf install -y"
elif command -v yum >/dev/null 2>&1; then
  PM="yum"; PM_INSTALL="yum install -y"
elif command -v pacman >/dev/null 2>&1; then
  PM="pacman"; PM_INSTALL="pacman -S --noconfirm --needed"
elif command -v zypper >/dev/null 2>&1; then
  PM="zypper"; PM_INSTALL="zypper install -y"
fi

# sudo が必要か判定 (root で実行中なら不要)
SUDO=""
if [[ "$(id -u)" != "0" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

# ディストリごとのパッケージ名を返す
pkg_names() {
  # $1: 論理名 (python / venv / git / build / cmake / pydev)
  case "$PM:$1" in
    apt:python)   echo "python3" ;;
    apt:venv)     echo "python3-venv python3-pip" ;;
    apt:build)    echo "build-essential" ;;
    apt:cmake)    echo "cmake" ;;
    apt:pydev)    echo "python3-dev" ;;
    apt:git)      echo "git" ;;
    dnf:python|yum:python)   echo "python3" ;;
    dnf:venv|yum:venv)       echo "python3-pip" ;;
    dnf:build|yum:build)     echo "gcc-c++ make" ;;
    dnf:cmake|yum:cmake)     echo "cmake" ;;
    dnf:pydev|yum:pydev)     echo "python3-devel" ;;
    dnf:git|yum:git)         echo "git" ;;
    pacman:python) echo "python" ;;
    pacman:venv)   echo "python-pip" ;;
    pacman:build)  echo "base-devel" ;;
    pacman:cmake)  echo "cmake" ;;
    pacman:pydev)  echo "" ;;
    pacman:git)    echo "git" ;;
    zypper:python) echo "python3" ;;
    zypper:venv)   echo "python3-pip python3-virtualenv" ;;
    zypper:build)  echo "gcc-c++ make" ;;
    zypper:cmake)  echo "cmake" ;;
    zypper:pydev)  echo "python3-devel" ;;
    zypper:git)    echo "git" ;;
    *) echo "" ;;
  esac
}

# パッケージ群をインストール (失敗しても呼び出し側で個別に再確認する)
install_pkgs() {
  local pkgs="$1"
  [[ -z "$pkgs" ]] && return 0
  if [[ -z "$PM" ]]; then
    echo "対応するパッケージマネージャが見つかりません。次を手動でインストールしてください: $pkgs" >&2
    return 1
  fi
  echo "パッケージをインストールしています: $pkgs"
  if [[ "$PM" == "apt" ]]; then
    $SUDO apt-get update -y || true
  fi
  # shellcheck disable=SC2086
  $SUDO $PM_INSTALL $pkgs
}

# --- 1. Python ---
python_is_supported() {
  "$1" -c 'import sys; raise SystemExit(sys.version_info[:2] < (3, 10))' \
    >/dev/null 2>&1
}

find_python() {
  local candidate
  for candidate in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && python_is_supported "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

PYTHON="$(find_python || true)"
if [[ -z "$PYTHON" ]]; then
  echo "[1/5] Python 3.10+ をインストールしています..."
  install_pkgs "$(pkg_names python) $(pkg_names venv) $(pkg_names pydev)" || true
  PYTHON="$(find_python || true)"
fi
if [[ -z "$PYTHON" ]] || ! python_is_supported "$PYTHON"; then
  echo "Python 3.10以上を用意できませんでした。お使いのディストリのパッケージマネージャ、または" >&2
  echo "https://www.python.org/ から Python 3.10+ をインストールして再実行してください。" >&2
  exit 1
fi
echo "[1/5] Python: OK ($("$PYTHON" --version 2>&1))"

# venv モジュールが使えるか確認 (Debian/Ubuntu は python3-venv が別パッケージ)
if ! "$PYTHON" -c 'import venv, ensurepip' >/dev/null 2>&1; then
  echo "python venv モジュールが不足しています。導入します..."
  install_pkgs "$(pkg_names venv) $(pkg_names pydev)" || true
  if ! "$PYTHON" -c 'import venv, ensurepip' >/dev/null 2>&1; then
    echo "python の venv/pip モジュールを用意できませんでした。" >&2
    echo "  Debian/Ubuntu: sudo apt-get install python3-venv python3-pip" >&2
    exit 1
  fi
fi

# --- 2. Git ---
if ! command -v git >/dev/null 2>&1; then
  echo "[2/5] Git をインストールしています..."
  install_pkgs "$(pkg_names git)" || true
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Git をインストールできませんでした。https://git-scm.com/ から導入して再実行してください。" >&2
  exit 1
fi
GIT="$(command -v git)"
echo "[2/5] Git: OK"

# --- 3. C++ビルドツール (gcc/g++ + cmake) ---
if ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
  echo "[3/5] C++ビルドツールをインストールしています..."
  install_pkgs "$(pkg_names build)" || true
fi
if ! command -v cmake >/dev/null 2>&1; then
  echo "[3/5] cmake をインストールしています..."
  install_pkgs "$(pkg_names cmake)" || true
fi
if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
  echo "C++ビルドツール (g++) を用意できませんでした。" >&2
  echo "  Debian/Ubuntu: sudo apt-get install build-essential cmake" >&2
  echo "  Fedora/RHEL:   sudo dnf install gcc-c++ make cmake" >&2
  echo "  Arch:          sudo pacman -S base-devel cmake" >&2
  exit 1
fi
echo "[3/5] C++ビルドツール: OK ($( (g++ --version 2>/dev/null || c++ --version 2>/dev/null) | head -n1))"

# --- GPU 検出 ---
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  HAS_NVIDIA=1
  echo "NVIDIA GPU: あり (高速生成)"
else
  HAS_NVIDIA=0
  echo "NVIDIA GPU: なし (CPU生成: 1回数十秒)"
fi

# ダウンロード時の紛らわしい警告を抑制
export HF_HUB_DISABLE_SYMLINKS_WARNING=1

# HuggingFace のモデルキャッシュ (合計約30GB) をエンジンと同じディスクに置く。
# 既定の ~/.cache/huggingface はホーム (別ディスク/小容量のことがある) に落ちるため、
# --engine-root で大容量ディスクを指定しても溢れて "No space left on device" になる。
# 実行時 (server.py) も同じ HF_HOME を見る必要があるので、設定ファイルにも保存する。
export HF_HOME="$ENGINE_ROOT/hf-cache"
mkdir -p "$HF_HOME"

# --- 4. Python環境 + ARDY本体 + モデル ---
mkdir -p "$ENGINE_ROOT"
VENV_PY="$ENGINE_ROOT/venv/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  "$PYTHON" -m venv "$ENGINE_ROOT/venv"
fi
"$VENV_PY" -m pip install --upgrade pip --quiet

echo "[4/5] AIエンジンを構築しています... (数GBのダウンロード)"
# PyTorchは動作検証済みバージョンに固定する。GPUがあれば CUDA 版、無ければ CPU 版
if [[ "$HAS_NVIDIA" == "1" ]]; then
  "$VENV_PY" -m pip install "torch==$TORCH_VERSION" --index-url "$CUDA_INDEX_URL"
else
  "$VENV_PY" -m pip install "torch==$TORCH_VERSION"
fi

# PyTorch が本当に import できるか検証。失敗時は CPU 版へ切り替えて再試行
if ! "$VENV_PY" -c "import torch; print('torch-ok', torch.__version__)"; then
  echo "PyTorchの動作確認に失敗しました。CPU版に切り替えて再インストールします..." >&2
  "$VENV_PY" -m pip uninstall -y torch || true
  "$VENV_PY" -m pip install --no-cache-dir "torch==$TORCH_VERSION"
fi
if ! "$VENV_PY" -c "import torch; print('PyTorch: OK (' + torch.__version__ + ')')"; then
  echo "PyTorchを起動できませんでした。ディストリを更新し、スクリプトを再実行してください。" >&2
  echo "AVX2非対応の古いCPUでは公式PyTorchは動作しません。" >&2
  exit 1
fi

# --- ARDY本体 (検証済みコミットに固定) ---
ARDY_REPO="$ENGINE_ROOT/ardy"
if [[ ! -f "$ARDY_REPO/setup.py" ]]; then
  if [[ -e "$ARDY_REPO" ]]; then
    echo "ARDYの取得先に不完全なファイルがあります: $ARDY_REPO" >&2
    echo "内容を確認して別の場所へ移動してから再実行してください。" >&2
    exit 1
  fi
  "$GIT" clone https://github.com/nv-tlabs/ardy.git "$ARDY_REPO"
  # 特定コミットへ固定 (取得できない場合は最新のまま続行)
  "$GIT" -C "$ARDY_REPO" checkout "$ARDY_COMMIT" 2>/dev/null || \
    echo "警告: 固定コミットへの切り替えに失敗しました。最新版のまま続行します。" >&2
fi

"$VENV_PY" -m pip install cmake sentencepiece --quiet
(
  cd "$ARDY_REPO"
  "$VENV_PY" -m pip install -e .
)

# 空き容量の事前チェック (ARDYコア約7GB + Llama-3-8B約16GB + 統合済み約16GB + 作業領域)。
# キャッシュとエンジンは同じディスク (ENGINE_ROOT) なので、その空きを見る。
FREE_GB="$(df -PBG "$ENGINE_ROOT" | awk 'NR==2 {gsub(/G/,"",$4); print $4}')"
if [[ -n "$FREE_GB" ]]; then
  if ((FREE_GB < 20)); then
    echo "エラー: インストール先の空き容量が不足しています (現在 ${FREE_GB}GB)。" >&2
    echo "モデルの構築には最低20GB、初回ダウンロードも含めると約40GBの空きが必要です。" >&2
    echo "空きの多いディスクを --engine-root で指定して再実行してください。" >&2
    echo "  例: bash $(basename "${BASH_SOURCE[0]}") --engine-root /path/to/large-disk/ardy-engine" >&2
    exit 1
  elif ((FREE_GB < 40)); then
    echo "注意: 空き容量が少なめです (${FREE_GB}GB)。初回はモデルDLも含め約40GB使用します。"
  fi
fi

echo "[5/5] モデルをダウンロードしています... (約20GB。ここが一番時間がかかります)"
"$VENV_PY" -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='$ARDY_MODEL_REPO', revision='$ARDY_MODEL_REVISION')"

# テキストエンコーダーの構築。完了マーカーで成否を管理する:
# フォルダやmodel.safetensorsの存在だけで判定すると、ディスク不足等で
# 書きかけのまま失敗したものを「構築済み」と誤認してしまう
MERGED_BASE="$ENGINE_ROOT/llm2vec-base-merged"
MERGED_MARKER="$MERGED_BASE/build-complete.marker"
if [[ -d "$MERGED_BASE" && ! -f "$MERGED_MARKER" ]]; then
  echo "前回のモデル構築が途中で終わっているため、作り直します..."
  rm -rf "$MERGED_BASE"
fi
if [[ ! -f "$MERGED_MARKER" ]]; then
  "$VENV_PY" "$SCRIPT_DIR/build_text_encoder.py" --out "$MERGED_BASE"
  touch "$MERGED_MARKER"
fi

# --- 5. アプリ用設定ファイル ---
# Electron の userData は Linux では ~/.config/<appName>。
# 開発版 (package.json name → text-to-vrma) と配布版 (productName → Text-To-VRMA)、
# および name 未解決時の既定 (Electron) の各候補へ書き出す。
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
for config_dir in \
  "$CONFIG_BASE/text-to-vrma" \
  "$CONFIG_BASE/Text-To-VRMA" \
  "$CONFIG_BASE/Electron"; do
  mkdir -p "$config_dir"
  CONFIG_PATH="$config_dir/ardy-engine.json" \
  CONFIG_PYTHON="$VENV_PY" \
  CONFIG_MERGED_BASE="$MERGED_BASE" \
  CONFIG_HF_HOME="$HF_HOME" \
    "$VENV_PY" -c 'import json, os
path = os.environ["CONFIG_PATH"]
config = {
    "pythonExe": os.environ["CONFIG_PYTHON"],
    "mergedBase": os.environ["CONFIG_MERGED_BASE"],
    "hfHome": os.environ["CONFIG_HF_HOME"],
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
echo "(ブラウザ版を使う場合は、次のコマンドでエンジンを手動起動できます)"
echo "  HF_HOME=\"$HF_HOME\" \"$VENV_PY\" \"$SCRIPT_DIR/server.py\" --port 2337 --merged-base \"$MERGED_BASE\""
echo
echo "本エンジンは Meta Llama 3 を利用しています (Built with Meta Llama 3)。"
echo "ライセンス: ARDY=NVIDIA Open Model / Llama-3-8B=Meta Llama 3 Community License / FuguMT=CC BY-SA 4.0"
wait_exit 0
