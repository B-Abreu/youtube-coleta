# Wrapper para o Task Scheduler. Garante CWD correto e log diario.
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$logsDir = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$log = Join-Path $logsDir ("run-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
& node coletor.js *>&1 | Tee-Object -FilePath $log -Append
