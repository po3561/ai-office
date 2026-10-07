# Claude Office 사무실 엔진(127.0.0.1:5000)을 창 없이 켠다. 이미 켜져 있으면 그대로 둔다.
# 단, 켜져 있는 엔진이 설치된 프로그램보다 옛 버전이면(업데이트 뒤 옛 프로세스가 남은 경우) 내리고 새 코드로 다시 켠다.
# 엔진은 화면 없이 API만 쓰고, 화면은 LAPIS 앱 하나뿐이다.
$log = Join-Path $env:LOCALAPPDATA 'AI-Office\logs\engine-start.log'
function Note($text) { try { Add-Content -LiteralPath $log -Value ("{0:s} {1}" -f (Get-Date), $text) -Encoding UTF8 } catch {} }
$app = Join-Path $env:LOCALAPPDATA 'AI-Office\app'
$entry = Join-Path $app 'bin\ai-office.mjs'
if (-not (Test-Path -LiteralPath $entry)) { Note "엔진 파일 없음: $entry"; exit 1 }

$listener = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $running = $null
  try { $running = Invoke-RestMethod 'http://127.0.0.1:5000/api/ping' -TimeoutSec 3 } catch { }
  $installed = ''
  try { $installed = [string](Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
  # 우리 엔진으로 확인되고 버전이 다를 때만 내린다(다른 프로그램이 5000번을 쓰고 있으면 건드리지 않는다).
  if (-not ($running -and $running.app -eq 'ai-office' -and $installed -and [string]$running.version -ne $installed)) { Note '이미 실행 중'; exit 0 }
  Note "옛 엔진($($running.version))을 새 버전($installed)으로 바꿉니다"
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 300 }
  if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) { Note '옛 엔진을 내리지 못했습니다'; exit 1 }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
Start-Process -FilePath $node -ArgumentList @("`"$entry`"", 'serve') -WorkingDirectory $app -WindowStyle Hidden
Note "시작: $node"
exit 0
