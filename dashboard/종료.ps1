$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.runtime\server.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Output '이 폴더에서 시작한 대시보드 기록이 없습니다.'; exit 0 }
$taskPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid"
$entryPath = Join-Path $PSScriptRoot 'src\server.mjs'
if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine.Contains('"' + $entryPath + '"')) {
  Stop-Process -Id $taskPid
  Write-Output '통합 대시보드를 종료했습니다. Office와 Telegram 수신자는 계속 동작합니다.'
} elseif ($taskProcess) { throw 'PID가 다른 프로그램을 가리켜 종료하지 않았습니다.' }
