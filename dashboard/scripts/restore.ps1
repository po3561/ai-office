# LAPIS 복원: 백업 폴더(이 파일이 있는 곳)의 내용을 원래 자리로 되돌린다.
#   -Apply 없이 실행하면 아무것도 바꾸지 않고 무엇을 되돌릴지 목록만 보여 준다.
#   -Apply                 : 실제로 복원
#   -IncludeTelegramState  : 텔레그램 봇 상태(토큰 포함)도 되돌린다(지금 쓰는 값을 덮어쓰므로 기본은 제외)
#   -IncludeDashboardData  : 라피스 대시보드의 일정·로그인 정보도 되돌린다(기본 제외)
param([switch]$Apply, [switch]$IncludeTelegramState, [switch]$IncludeDashboardData)
$ErrorActionPreference = 'Stop'
$bk = $PSScriptRoot
$manifestPath = Join-Path $bk 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'manifest.json 이 없어 백업 폴더가 맞는지 확인할 수 없습니다.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Step($text) { if ($Apply) { Write-Host "▶ $text" } else { Write-Host "· (미리보기) $text" } }

foreach ($item in $manifest.items) {
  if ($item.name -eq '텔레그램-상태' -and -not $IncludeTelegramState) { Write-Host "· 제외: $($item.name) (-IncludeTelegramState 로 포함)"; continue }
  if ($item.name -eq '라피스대시보드-데이터' -and -not $IncludeDashboardData) { Write-Host "· 제외: $($item.name) (-IncludeDashboardData 로 포함)"; continue }
  $from = Join-Path $bk $item.name
  Step "$($item.name) → $($item.source) ($($item.files)개 파일)"
  if ($Apply) {
    if (-not (Test-Path -LiteralPath $from)) { throw "백업에 없습니다: $($item.name)" }
    New-Item -ItemType Directory -Force $item.source | Out-Null
    & robocopy $from $item.source /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "복원 실패: $($item.name) (robocopy $LASTEXITCODE)" }
  }
}
foreach ($name in $manifest.tasks) {
  $xml = Join-Path $bk ('예약작업\' + $name + '.xml')
  if (-not (Test-Path -LiteralPath $xml)) { continue }
  Step "예약 작업 등록: $name"
  if ($Apply) { schtasks /Create /TN $name /XML $xml /F | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Warning "예약 작업을 등록하지 못했습니다: $name" } }
}
foreach ($s in $manifest.shortcuts) {
  $src = Join-Path $bk ('바로가기\' + $s.saved)
  if (-not (Test-Path -LiteralPath $src)) { continue }
  Step "바로가기 복원: $($s.original)"
  if ($Apply) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $s.original) | Out-Null
    Copy-Item -LiteralPath $src -Destination $s.original -Recurse -Force
  }
}
if ($Apply) {
  Write-Host ''
  Write-Host '복원을 마쳤습니다. Office 대시보드는 로그인하거나 바탕화면의 「AI-Office 대시보드」 바로가기로 다시 시작할 수 있습니다.' -ForegroundColor Green
} else {
  Write-Host ''; Write-Host '실제로 되돌리려면 -Apply 를 붙여 다시 실행하세요.'
}
