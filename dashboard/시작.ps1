param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$runtimeDir = Join-Path $taskRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
try {
  $health = Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 2
  if ($health.app -eq 'lapis-office-dashboard') {
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4310' }
    exit 0
  }
} catch { }
$existing = Get-NetTCPConnection -State Listen -LocalPort 4310 -ErrorAction SilentlyContinue
if ($existing) { throw '4310 포트를 다른 프로그램이 사용 중입니다. 기존 프로그램을 자동 종료하지 않았습니다.' }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$entryPath = Join-Path $taskRoot 'src\server.mjs'
$taskProcess = Start-Process -FilePath $nodeExe -ArgumentList @('--no-warnings', ('"' + $entryPath + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.out.log') -RedirectStandardError (Join-Path $runtimeDir 'server.err.log') -PassThru
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeDir 'server.pid')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 300
  try {
    $health = Invoke-RestMethod 'http://127.0.0.1:4310/api/health' -TimeoutSec 2
    if ($health.app -eq 'lapis-office-dashboard') { if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4310' }; exit 0 }
  } catch { }
}
throw '대시보드 시작을 확인하지 못했습니다. .runtime/server.err.log를 확인해 주세요.'
