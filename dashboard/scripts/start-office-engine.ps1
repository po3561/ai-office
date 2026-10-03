# Claude Office 사무실 엔진(127.0.0.1:5000)을 창 없이 켠다. 이미 켜져 있으면 그대로 둔다.
# 엔진은 화면 없이 API만 쓰고, 화면은 LAPIS 앱 하나뿐이다.
$log = Join-Path $env:LOCALAPPDATA 'AI-Office\logs\engine-start.log'
function Note($text) { try { Add-Content -LiteralPath $log -Value ("{0:s} {1}" -f (Get-Date), $text) -Encoding UTF8 } catch {} }
$app = Join-Path $env:LOCALAPPDATA 'AI-Office\app'
$entry = Join-Path $app 'bin\ai-office.mjs'
if (-not (Test-Path -LiteralPath $entry)) { Note "엔진 파일 없음: $entry"; exit 1 }
if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) { Note '이미 실행 중'; exit 0 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
Start-Process -FilePath $node -ArgumentList @("`"$entry`"", 'serve') -WorkingDirectory $app -WindowStyle Hidden
Note "시작: $node"
exit 0
