# install.ps1 — ARDYローカルエンジンのセットアップスクリプト (Windows)
#
# アプリの「エンジンをセットアップ」ボタンから自動で起動されます。
# 手動実行する場合: powershell -ExecutionPolicy Bypass -File install.ps1
#
# やること (全自動):
#   1. Python 3.10+ / Git を確認。無ければ winget で自動インストール
#   2. ARDY本体の取得とビルド (C++ビルドツールも自動導入)
#   3. モデル重みのダウンロード (約20GB)
#   4. アプリ用設定ファイルの書き出し
#
# 必要ディスク: 約35GB / 必要RAM: 16GB以上
param(
    [string]$EngineRoot = "$env:LOCALAPPDATA\text-to-vrma\ardy-engine"
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Wait-Exit($code) {
    Write-Host ""
    Read-Host "Enterキーを押すとウィンドウを閉じます"
    exit $code
}

try {

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Text-To-VRMA : ARDYエンジン セットアップ" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "インストール先: $EngineRoot"
Write-Host "約20GBをダウンロードします。回線により30分〜1時間程度かかります。"
Write-Host ""

# --- 0. winget の確認 ---
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $hasWinget) {
    Write-Host "winget が見つかりません。Windows 10 (更新済み) / 11 が必要です。" -ForegroundColor Yellow
    Write-Host "Python 3.10以上と Git を手動でインストールしてから再実行してください:"
    Write-Host "  https://www.python.org/downloads/  /  https://git-scm.com/"
}

# --- 1. Python ---
$py = $null
foreach ($cand in @('py -3.12', 'py -3.11', 'py -3.10', 'python')) {
    try {
        $v = Invoke-Expression "$cand --version" 2>$null
        if ($v -match 'Python 3\.(1[0-9])') { $py = $cand; break }
    } catch {}
}
if (-not $py -and $hasWinget) {
    Write-Host "[1/5] Python 3.12 をインストールしています..." -ForegroundColor Green
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
    $pyExe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    if (Test-Path $pyExe) { $py = "`"$pyExe`"" }
}
if (-not $py) { throw "Python 3.10以上をインストールできませんでした。https://www.python.org/ から手動でインストールして再実行してください。" }
Write-Host "[1/5] Python: OK ($py)" -ForegroundColor Green

# --- 2. Git ---
$git = 'git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if ($hasWinget) {
        Write-Host "[2/5] Git をインストールしています..." -ForegroundColor Green
        winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
    }
    $gitExe = "$env:ProgramFiles\Git\cmd\git.exe"
    if (Test-Path $gitExe) { $git = $gitExe }
    elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git をインストールできませんでした。https://git-scm.com/ から手動でインストールして再実行してください。"
    }
}
Write-Host "[2/5] Git: OK" -ForegroundColor Green

# --- 2.5. Visual C++ ランタイム (PyTorchのDLLに必須。無いと WinError 1114 で失敗する) ---
$vcOk = (Test-Path "$env:SystemRoot\System32\vcruntime140_1.dll") -and (Test-Path "$env:SystemRoot\System32\msvcp140.dll")
if (-not $vcOk -and $hasWinget) {
    Write-Host "Visual C++ ランタイムをインストールしています... (確認画面が出たら「はい」を押してください)" -ForegroundColor Green
    winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-source-agreements --accept-package-agreements | Out-Null
}

$hasNvidia = $false
try { $null = nvidia-smi 2>$null; $hasNvidia = ($LASTEXITCODE -eq 0) } catch {}
Write-Host "NVIDIA GPU: $(if ($hasNvidia) {'あり (高速生成)'} else {'なし (CPU生成: 1回数十秒)'})"

# ダウンロード時の紛らわしい警告を抑制
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'

# --- 3. C++ビルドツール (MinGW) ---
$mingwPkg = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe"
$gxx = Get-ChildItem -Path $mingwPkg -Filter 'g++.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $gxx) {
    Write-Host "[3/5] C++ビルドツールをインストールしています..." -ForegroundColor Green
    winget install BrechtSanders.WinLibs.POSIX.UCRT --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
    $gxx = Get-ChildItem -Path $mingwPkg -Filter 'g++.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $gxx) { throw "C++ビルドツール (MinGW) のインストールに失敗しました。" }
$mingwBin = $gxx.DirectoryName
Write-Host "[3/5] C++ビルドツール: OK" -ForegroundColor Green

# --- 4. Python環境 + ARDY本体 + モデル ---
New-Item -ItemType Directory -Force $EngineRoot | Out-Null
$venvPy = Join-Path $EngineRoot 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    Invoke-Expression "$py -m venv `"$EngineRoot\venv`""
}
& $venvPy -m pip install --upgrade pip --quiet

Write-Host "[4/5] AIエンジンを構築しています... (数GBのダウンロード)" -ForegroundColor Green
if ($hasNvidia) {
    & $venvPy -m pip install torch --index-url https://download.pytorch.org/whl/cu128
} else {
    & $venvPy -m pip install torch
}

# PyTorchが本当に動くか検証 (WinError 1114 = VC++ランタイム不足を自己修復)
& $venvPy -c "import torch" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyTorchの動作確認に失敗。Visual C++ ランタイムを再インストールします..." -ForegroundColor Yellow
    if ($hasWinget) {
        winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-source-agreements --accept-package-agreements --force | Out-Null
    }
    & $venvPy -c "import torch" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw ("PyTorchを起動できません。以下を手動でインストール後、再実行してください:`n" +
               "  Microsoft Visual C++ 再頒布可能パッケージ (x64)`n" +
               "  https://aka.ms/vs/17/release/vc_redist.x64.exe")
    }
}
Write-Host "PyTorch: OK" -ForegroundColor Green

$ardyRepo = Join-Path $EngineRoot 'ardy'
if (-not (Test-Path "$ardyRepo\setup.py")) {
    & $git clone --depth 1 https://github.com/nv-tlabs/ardy.git $ardyRepo
}
$env:PATH = "$mingwBin;$env:PATH"
& $venvPy -m pip install cmake sentencepiece --quiet
Push-Location $ardyRepo
& $venvPy -m pip install -e .
Pop-Location

Write-Host "[5/5] モデルをダウンロードしています... (約20GB。ここが一番時間がかかります)" -ForegroundColor Green
& $venvPy -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='nvidia/ARDY-Core-RP-20FPS-Horizon40')"

$mergedBase = Join-Path $EngineRoot 'llm2vec-base-merged'
if (-not (Test-Path "$mergedBase\model.safetensors")) {
    & $venvPy (Join-Path $ScriptDir 'build_text_encoder.py') --out $mergedBase
}

# --- 5. アプリ用設定ファイル ---
$config = @{
    pythonExe         = $venvPy
    mergedBase        = $mergedBase
    port              = 2337
    textEncoderDevice = 'cpu'
} | ConvertTo-Json
foreach ($dir in @("$env:APPDATA\text-to-vrma", "$env:APPDATA\Electron")) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $config | Out-File -Encoding utf8 (Join-Path $dir 'ardy-engine.json')
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " セットアップ完了!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "アプリに戻り、「エンジンを起動」を押してください。"
Write-Host ""
Write-Host "本エンジンは Meta Llama 3 を利用しています (Built with Meta Llama 3)。"
Write-Host "ライセンス: ARDY=NVIDIA Open Model / Llama-3-8B=Meta Llama 3 Community License / FuguMT=CC BY-SA 4.0"
Wait-Exit 0

} catch {
    Write-Host ""
    Write-Host "エラーが発生しました:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "解決しない場合は GitHub の Issue でお知らせください:"
    Write-Host "  https://github.com/Kirakun0328/text-to-vrma/issues"
    Wait-Exit 1
}
