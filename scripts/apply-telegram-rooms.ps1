# 텔레그램 플러그인(0.0.7)에 "그룹방 · 주제별 업무" 기능을 설치한다.
#  - 봇이 초대된 방·주제를 기록(rooms.json)하고, 허용된 계정(본인)이 초대하거나 방에서 @멘션하면 자동 연결
#  - 방·주제별 업무(/task), 새 방 기본 업무(/defaulttask), 방 현황(/rooms, list_rooms 도구)
#  - 주제 안에서는 답장이 같은 주제로 가도록 reply 에 thread_id 지원
#  - 대시보드(연결 · 계정 > 그룹방 · 주제별 업무)와 같은 rooms.json 을 공유
# 실행: powershell -ExecutionPolicy Bypass -File <설치폴더>\app\scripts\apply-telegram-rooms.ps1   (여러 번 실행해도 안전)
# 적용 후 대시보드에서 사무실을 다시 출근시켜야 한다. 플러그인이 업데이트되면 다시 실행한다.
# 이 파일의 server.0.0.7.ts 는 apply-korean-telegram.ps1·apply-telegram-html.ps1 을 적용한 0.0.7 위에 만든 것이라
# 한국어 안내문·HTML 서식 지원이 이미 들어 있다. 원본은 server.ts.before-rooms 로 백업한다.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.claude\plugins\cache\claude-plugins-official\telegram'
$src = Join-Path $PSScriptRoot 'telegram-rooms\server.0.0.7.ts'
if (-not (Test-Path $src)) { throw "설치용 파일이 없습니다: $src" }
$want = (Get-FileHash $src -Algorithm SHA256).Hash

$found = 0
foreach ($f in Get-ChildItem $root -Recurse -Filter server.ts -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\node_modules\\' }) {
  $found++
  $version = Split-Path -Leaf (Split-Path -Parent $f.FullName)
  if ($version -ne '0.0.7') {
    "$($f.FullName): 버전 $version 은 자동 적용 대상이 아닙니다(0.0.7 기준). 건드리지 않았습니다 — 새 버전에 맞게 옮겨야 합니다."
    continue
  }
  if ((Get-FileHash $f.FullName -Algorithm SHA256).Hash -eq $want) { "$($f.FullName): 이미 적용되어 있습니다."; continue }
  $bak = "$($f.FullName).before-rooms"
  if (-not (Test-Path $bak)) { Copy-Item $f.FullName $bak }
  Copy-Item $src $f.FullName -Force
  "$($f.FullName): 그룹방·주제별 업무 기능을 적용했습니다(원본 백업: $bak)."
}
if ($found -eq 0) { "텔레그램 플러그인을 찾지 못했습니다: $root" }
"→ 대시보드에서 사무실을 다시 출근시켜야 적용됩니다."
