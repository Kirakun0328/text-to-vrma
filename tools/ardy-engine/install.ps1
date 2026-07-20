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
    [string]$EngineRoot = "$env:LOCALAPPDATA\text-to-vrma\ardy-engine",
    # 開発者向け: PyTorch検証まで実行して終了する (モデルDLをスキップ)
    [switch]$SetupTestOnly
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

# --- 1. Python (検証済みバージョンの専用Pythonをエンジンフォルダ内に用意) ---
# ユーザーのPCに入っているPythonは使わない: 出どころ (Store版/32bit版/conda等) や
# バージョンの違いが環境依存トラブルの温床になるため、開発環境で検証したのと
# 完全に同じ構成を全ユーザーに再現する。nuget.org の公式CPython配布を使うので
# レジストリ・PATH・既存のPython環境には一切触れない (削除もフォルダ削除だけ)
$PyVer = '3.12.10'
New-Item -ItemType Directory -Force $EngineRoot | Out-Null
$privPyDir = Join-Path $EngineRoot 'python'
$privPy = Join-Path $privPyDir 'tools\python.exe'
if (-not (Test-Path $privPy)) {
    Write-Host "[1/5] 専用Python $PyVer を準備しています..." -ForegroundColor Green
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $pyZip = Join-Path $env:TEMP "python-$PyVer-nuget.zip"
        Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/python/$PyVer" -OutFile $pyZip -UseBasicParsing
        Expand-Archive -Path $pyZip -DestinationPath $privPyDir -Force
        Remove-Item $pyZip -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "専用Pythonの準備に失敗しました ($($_.Exception.Message))。PC内のPythonを探します..." -ForegroundColor Yellow
    }
}
$py = $null
if (Test-Path $privPy) {
    $py = "`"$privPy`""
    Write-Host "[1/5] Python: OK (専用 $PyVer)" -ForegroundColor Green
} else {
    # フォールバック: 従来通りPC内のPythonを探す / wingetで入れる
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
}

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
$venvPy = Join-Path $EngineRoot 'venv\Scripts\python.exe'
# 過去のバージョンでPC内のPythonから作られたvenvが残っている場合は、
# 専用Pythonベースで作り直す (トラブルの再発を防ぐため)
$venvCfg = Join-Path $EngineRoot 'venv\pyvenv.cfg'
if ((Test-Path $venvCfg) -and (Test-Path $privPy)) {
    $venvHome = (Get-Content $venvCfg | Select-String '^home\s*=\s*(.+)$').Matches
    $isPrivate = $venvHome.Count -gt 0 -and $venvHome[0].Groups[1].Value.Trim().StartsWith($privPyDir)
    if (-not $isPrivate) {
        Write-Host "以前のPython環境を専用Pythonで作り直します..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force (Join-Path $EngineRoot 'venv')
    }
}
if (-not (Test-Path $venvPy)) {
    Invoke-Expression "& $py -m venv `"$EngineRoot\venv`""
}
& $venvPy -m pip install --upgrade pip --quiet

# PATHを最小構成に洗浄する: 他のPyTorch/CUDA/conda環境がPATHにあると、
# そちらのDLLが混ざって読み込まれ WinError 1114 (DLL初期化失敗) の原因になる
$gitDir = try { Split-Path (Get-Command git -ErrorAction SilentlyContinue).Source } catch { $null }
$cleanPath = @(
    $mingwBin,
    (Split-Path $venvPy),
    "$env:SystemRoot\System32",
    "$env:SystemRoot",
    "$env:SystemRoot\System32\Wbem",
    "$env:SystemRoot\System32\WindowsPowerShell\v1.0"
)
if ($gitDir) { $cleanPath += $gitDir }
# winget は WindowsApps 配下にあるため、洗浄後も使えるよう残す (DLLは含まれない)
$cleanPath += "$env:LOCALAPPDATA\Microsoft\WindowsApps"
$env:PATH = ($cleanPath -join ';')

Write-Host "[4/5] AIエンジンを構築しています... (数GBのダウンロード)" -ForegroundColor Green
# PyTorchは動作検証済みバージョンに固定する (最新版は環境により WinError 1114 等の
# 初期化不具合が報告されるため、開発環境で確認した 2.11.0 を使う)
$TorchVer = '2.11.0'
if ($hasNvidia) {
    & $venvPy -m pip install "torch==$TorchVer" --index-url https://download.pytorch.org/whl/cu128
} else {
    & $venvPy -m pip install "torch==$TorchVer"
}

# PyTorchが本当に動くか検証。失敗時は実際のエラーを表示しつつ多段修復:
#   ① VC++ランタイム再導入 → ② CPU版PyTorchへ切り替え → ③ 案内して停止
function Test-TorchVersion {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $v = (& $venvPy -m pip show torch 2>&1 | Select-String '^Version:') -replace 'Version:\s*', ''
    $ErrorActionPreference = $eap
    return "$v".Trim()
}

function Test-TorchImport {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = (& $venvPy -c "import torch; print('torch-ok')" 2>&1) | ForEach-Object { "$_" } | Out-String
    $ErrorActionPreference = $eap
    return $out
}

$torchOut = Test-TorchImport
if ($torchOut -notmatch 'torch-ok') {
    Write-Host "PyTorchの動作確認に失敗しました。エラー内容:" -ForegroundColor Yellow
    Write-Host $torchOut.Trim() -ForegroundColor DarkGray
    # 修復 (1/4): 過去に入った未検証バージョンを、検証済みバージョンへ入れ替える
    $curVer = (Test-TorchVersion)
    if ($curVer -and $curVer -ne $TorchVer) {
        Write-Host "修復 (1/4): PyTorch $curVer を検証済みの $TorchVer に入れ替えます..." -ForegroundColor Yellow
        & $venvPy -m pip uninstall -y torch | Out-Null
        if ($hasNvidia) {
            & $venvPy -m pip install "torch==$TorchVer" --index-url https://download.pytorch.org/whl/cu128
        } else {
            & $venvPy -m pip install "torch==$TorchVer"
        }
        $torchOut = Test-TorchImport
    }
}
if ($torchOut -notmatch 'torch-ok') {
    Write-Host "修復 (2/4): Visual C++ ランタイムを公式サイトから直接インストールします..." -ForegroundColor Yellow
    try {
        $vcExe = Join-Path $env:TEMP 'vc_redist.x64.exe'
        Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vcExe -UseBasicParsing
        Start-Process $vcExe -ArgumentList '/install','/passive','/norestart' -Wait
        $torchOut = Test-TorchImport
    } catch {
        Write-Host "(スキップ: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}
if ($torchOut -notmatch 'torch-ok') {
    Write-Host "修復 (3/4): Visual C++ ランタイムを winget で再インストールします..." -ForegroundColor Yellow
    try {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-source-agreements --accept-package-agreements --force | Out-Null
        }
        $torchOut = Test-TorchImport
    } catch {
        Write-Host "(スキップ: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}
if ($torchOut -notmatch 'torch-ok') {
    Write-Host "修復 (4/4): CPU版PyTorchに切り替えて再試行します..." -ForegroundColor Yellow
    try {
        & $venvPy -m pip uninstall -y torch | Out-Null
        & $venvPy -m pip install "torch==$TorchVer"
        $torchOut = Test-TorchImport
    } catch {
        Write-Host "(スキップ: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}
if ($torchOut -notmatch 'torch-ok') {
    # 原因特定のための診断情報を収集して表示する
    Write-Host ""
    Write-Host "--- 診断情報 (問い合わせ時にこのブロックを丸ごと貼ってください) ---" -ForegroundColor Cyan
    $eap2 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        Write-Host ("OS: " + $os.Caption + " build " + $os.BuildNumber)
        $cpu = Get-CimInstance Win32_Processor
        Write-Host ("CPU: " + $cpu.Name)
        Write-Host ("メモリ: {0:N1} GB" -f ($os.TotalVisibleMemorySize / 1MB))
        $pf = Get-CimInstance Win32_PageFileUsage
        Write-Host ("ページファイル: " + $(if ($pf) { "有効 ($($pf.AllocatedBaseSize) MB)" } else { "無効 ← これが原因の可能性大" }))
        $vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
        Write-Host ("VC++ランタイム: " + $(if ($vc) { $vc.Version } else { "未検出 ← 要インストール" }))
        & $venvPy -m pip install py-cpuinfo --quiet 2>&1 | Out-Null
        $avx = (& $venvPy -c "import cpuinfo; f=cpuinfo.get_cpu_info().get('flags',[]); print('avx2:', 'avx2' in f)" 2>&1) | Out-String
        Write-Host ("CPU拡張命令 " + $avx.Trim() + $(if ($avx -match 'False') { " ← AVX2非対応CPUではPyTorch公式版は動きません" } else { "" }))
        $inject = Get-Process -Name 'Nahimic*','SonicStudio*','SonicRadar*','AWCC*','A-Volute*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique
        Write-Host ("DLL注入系ソフト: " + $(if ($inject) { ($inject -join ', ') + " ← DLL初期化を壊すことで有名です。一時停止して再実行を試してください" } else { "検出なし" }))
        try {
            $aslr = (Get-ProcessMitigation -System -ErrorAction Stop).Aslr
            $forceAslr = "$($aslr.ForceRelocateImages)"
            Write-Host ("強制ASLR: " + $(if ($forceAslr -eq 'ON') { "ON ← これが原因の可能性大。Windowsセキュリティ→アプリとブラウザーコントロール→Exploit protectionの設定→「イメージのランダム化を強制する」をオフにして再実行してください" } else { "既定 (問題なし)" }))
        } catch { Write-Host "強制ASLR: 確認不可" }
        $avs = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | Select-Object -ExpandProperty displayName
        Write-Host ("セキュリティソフト: " + $(if ($avs) { ($avs -join ', ') + $(if ($avs -notmatch 'Defender') { " ← Defender以外が入っている場合、一時停止して再実行を試してください" } else { "" }) } else { "不明" }))
    } catch {}
    $ErrorActionPreference = $eap2
    Write-Host "-------------------------------------------------------------" -ForegroundColor Cyan
    throw ("PyTorchを起動できませんでした。エラー内容:`n" + $torchOut.Trim() + "`n`n" +
           "次をお試しください (重要な順):`n" +
           "  1. ★PCを再起動して、もう一度このセットアップを実行★`n" +
           "     (ランタイム更新は再起動後に反映されることがあります)`n" +
           "  2. 上の診断情報で「無効」「未検出」「False」が出ていればその項目を対処`n" +
           "  3. Windows Update を最新化`n" +
           "それでも解決しない場合は、上の診断情報とエラー内容を添えてご連絡ください。")
}
Write-Host "PyTorch: OK ($TorchVer)" -ForegroundColor Green

if ($SetupTestOnly) {
    Write-Host "(テストモード: PyTorch検証まで成功。ここで終了します)" -ForegroundColor Cyan
    exit 0
}

# 動作検証済みのコミット/リビジョンに固定する (上流の変更やライセンス改定の影響を受けないため)
$ArdyCommit = '693f74d13b3d04a0a22ce127ee79c929dd89756b'  # 開発環境で動作検証したコミット
$ardyRepo = Join-Path $EngineRoot 'ardy'
if (-not (Test-Path "$ardyRepo\setup.py")) {
    & $git clone https://github.com/nv-tlabs/ardy.git $ardyRepo
    if ($LASTEXITCODE -ne 0) { throw "ARDYリポジトリの取得に失敗しました。ネットワークを確認して再実行してください。" }
    # 特定コミットへ固定 (取得できない場合は最新のまま続行)
    & $git -C $ardyRepo checkout $ArdyCommit 2>$null
}
& $venvPy -m pip install cmake sentencepiece --quiet
Push-Location $ardyRepo
& $venvPy -m pip install -e .
$ardyInstallCode = $LASTEXITCODE
Pop-Location
if ($ardyInstallCode -ne 0) { throw "ARDY本体のインストールに失敗しました。上のエラー内容を確認して再実行してください。" }

Write-Host "[5/5] モデルをダウンロードしています... (約20GB。ここが一番時間がかかります)" -ForegroundColor Green
& $venvPy -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='nvidia/ARDY-Core-RP-20FPS-Horizon40', revision='abe6c43beb28c867c950acb824b9c4ef3d63fb76')"
if ($LASTEXITCODE -ne 0) { throw "ARDYモデルのダウンロードに失敗しました。ネットワークとディスク空き容量を確認して再実行してください。" }

# テキストエンコーダーの構築。完了マーカーで成否を管理する:
# フォルダやmodel.safetensorsの存在だけで判定すると、ディスク不足等で
# 書きかけのまま失敗したものを「構築済み」と誤認してしまう
$mergedBase = Join-Path $EngineRoot 'llm2vec-base-merged'
$mergedMarker = Join-Path $mergedBase 'build-complete.marker'
if ((Test-Path $mergedBase) -and -not (Test-Path $mergedMarker)) {
    Write-Host "前回のモデル構築が途中で終わっているため、作り直します..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $mergedBase
}
if (-not (Test-Path $mergedMarker)) {
    # 空き容量の事前チェック (元モデル約16GB + 統合済み約16GB + 作業領域)
    $driveName = (Split-Path -Qualifier $EngineRoot).TrimEnd(':')
    $freeGB = [math]::Round((Get-PSDrive -Name $driveName).Free / 1GB, 1)
    if ($freeGB -lt 20) {
        $msg = "${driveName}ドライブの空き容量が不足しています (現在 ${freeGB}GB)。モデルの構築には最低20GB、" +
               "初回ダウンロードも含めると約40GBの空きが必要です。不要なファイルを削除してから再実行してください。"
        throw $msg
    } elseif ($freeGB -lt 40) {
        Write-Host "注意: 空き容量が少なめです (${freeGB}GB)。初回はモデルのダウンロードも含めて約40GB使用します。" -ForegroundColor Yellow
    }
    & $venvPy (Join-Path $ScriptDir 'build_text_encoder.py') --out $mergedBase
    if ($LASTEXITCODE -ne 0) {
        throw "テキストエンコーダーの構築に失敗しました。上のエラー内容と、ディスク空き容量 (推奨40GB以上) を確認して再実行してください。"
    }
    New-Item -ItemType File -Path $mergedMarker -Force | Out-Null
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
    # BOMなしUTF-8で書く (PS5.1のOut-File utf8はBOM付きになり、アプリ側のJSON.parseが失敗する)
    [System.IO.File]::WriteAllText((Join-Path $dir 'ardy-engine.json'), $config, (New-Object System.Text.UTF8Encoding $false))
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
    if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) {
        Write-Host "(スクリプト行: $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "もう一度このセットアップを実行すると、完了済みの手順はスキップして続きから再開します。"
    Write-Host "解決しない場合は、上のエラー内容を添えて GitHub の Issue でお知らせください:"
    Write-Host "  https://github.com/Kirakun0328/text-to-vrma/issues"
    Wait-Exit 1
}
