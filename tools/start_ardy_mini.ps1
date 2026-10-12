param(
    [string]$PythonExe = 'C:\text-to-motion-ardy-poc\venv\Scripts\python.exe',
    [string]$ArdySource = 'C:\text-to-motion-ardy-poc\ardy',
    [int]$Port = 2337
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$artifact = Join-Path $workspace 'release\ardy-mini-model'
if (!(Test-Path -LiteralPath (Join-Path $artifact 'text_encoder.onnx'))) {
    throw 'Run tools/setup_ardy_mini.py before starting the Mini encoder.'
}
$env:PYTHONPATH = (Join-Path $workspace 'release\mini-python') + ';' + $ArdySource
$env:TEXT_ENCODER_DEVICE = 'cpu'
& $PythonExe (Join-Path $PSScriptRoot 'ardy-engine\server.py') --mini-encoder $artifact --port $Port
exit $LASTEXITCODE
