# LAPIS 백업: 대시보드 정리 전에 설정·중요 정보를 한 폴더에 모으고, 복원 스크립트를 함께 넣는다.
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 [-Dest <폴더>]
# 원본은 지우거나 바꾸지 않는다(복사만). 복사본은 해시로 원본과 같은지 확인한다.
param([string]$Dest = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Dest) { $Dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ('LAPIS_백업\' + (Get-Date -Format 'yyyy-MM-dd_HHmm')) }
New-Item -ItemType Directory -Force $Dest | Out-Null
$local = $env:LOCALAPPDATA
$home2 = $env:USERPROFILE

# 이름, 원본, 제외 폴더, 민감 여부
$items = @(
  @{ name = 'AI-Office-데이터';   src = "$local\AI-Office";                              skip = @('app', 'update'); secret = $false },
  @{ name = 'AI-Office-프로그램'; src = "$local\AI-Office\app";                          skip = @();                secret = $false },
  @{ name = '옛대시보드-3200';    src = "$home2\Desktop\AI-Office\.system\dashboard";   skip = @();                secret = $false },
  @{ name = '텔레그램-상태';      src = "$home2\.claude\channels\telegram";             skip = @();                secret = $true  },
  @{ name = '라피스대시보드-데이터'; src = "$root\.runtime\data";                         skip = @();                secret = $true  }
)
$manifest = [ordered]@{ createdAt = (Get-Date).ToString('o'); machine = $env:COMPUTERNAME; items = @(); tasks = @(); shortcuts = @() }

foreach ($item in $items) {
  if (-not (Test-Path -LiteralPath $item.src)) { Write-Host "건너뜀(없음): $($item.src)"; continue }
  $target = Join-Path $Dest $item.name
  $args2 = @($item.src, $target, '/E', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($item.skip.Count) { $args2 += '/XD'; $args2 += ($item.skip | ForEach-Object { Join-Path $item.src $_ }) }
  & robocopy @args2 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "복사 실패: $($item.src) (robocopy $LASTEXITCODE)" }
  # 원본과 복사본의 파일 해시를 비교한다.
  $files = Get-ChildItem -LiteralPath $item.src -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $rel = $_.FullName.Substring($item.src.Length).TrimStart('\'); -not ($item.skip | Where-Object { $rel -like "$_\*" })
  }
  $count = 0; $bad = @()
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($item.src.Length).TrimStart('\')
    $copy = Join-Path $target $rel
    if (-not (Test-Path -LiteralPath $copy)) { $bad += $rel; continue }
    if ((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) { $bad += $rel }
    $count++
  }
  if ($bad.Count) { throw "복사본이 원본과 다릅니다($($item.name)): $($bad[0..2] -join ', ')" }
  $manifest.items += [ordered]@{ name = $item.name; source = $item.src; files = $count; secret = $item.secret }
  Write-Host ("백업 완료: {0} ({1}개 파일)" -f $item.name, $count)
}

# 예약 작업(자동 시작·감시) 정의
$taskDir = Join-Path $Dest '예약작업'; New-Item -ItemType Directory -Force $taskDir | Out-Null
foreach ($name in @('AI-Office Dashboard', 'AI-Office 감시', 'AI-Office 스킬 동기화', 'LAPIS 대시보드')) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $xml = schtasks /Query /TN $name /XML 2>$null
  $ok = ($LASTEXITCODE -eq 0); $ErrorActionPreference = $prev
  if ($ok -and $xml) {
    $file = Join-Path $taskDir ($name + '.xml')
    [IO.File]::WriteAllText($file, ($xml -join "`r`n"), [Text.Encoding]::Unicode)
    $manifest.tasks += $name; Write-Host "예약 작업 저장: $name"
  }
}
# 바로가기
$lnkDir = Join-Path $Dest '바로가기'; New-Item -ItemType Directory -Force $lnkDir | Out-Null
$programs = [Environment]::GetFolderPath('Programs'); $startup = [Environment]::GetFolderPath('Startup'); $desktop = [Environment]::GetFolderPath('Desktop')
$shortcuts = @(
  @{ from = (Join-Path $programs 'AI-Office'); to = 'StartMenu-AI-Office'; folder = $true },
  @{ from = (Join-Path $startup 'AI-Office 자동출근.lnk'); to = 'Startup-AI-Office 자동출근.lnk'; folder = $false },
  @{ from = (Join-Path $desktop 'AI-Office 대시보드.lnk'); to = 'Desktop-AI-Office 대시보드.lnk'; folder = $false }
)
foreach ($s in $shortcuts) {
  if (Test-Path -LiteralPath $s.from) {
    Copy-Item -LiteralPath $s.from -Destination (Join-Path $lnkDir $s.to) -Recurse -Force
    $manifest.shortcuts += [ordered]@{ original = $s.from; saved = $s.to; folder = $s.folder }
  }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'restore.ps1') -Destination (Join-Path $Dest '복원.ps1') -Force
@"
LAPIS 백업 ($((Get-Date).ToString('yyyy-MM-dd HH:mm')))

복원: 이 폴더의 '복원.ps1'을 PowerShell에서 실행하세요.
  powershell -ExecutionPolicy Bypass -File "복원.ps1"            ← 무엇을 복원할지 먼저 목록만 보여 줍니다
  powershell -ExecutionPolicy Bypass -File "복원.ps1" -Apply     ← 실제로 되돌립니다

주의: '텔레그램-상태'와 '라피스대시보드-데이터'에는 봇 토큰과 로그인 정보가 들어 있습니다. 다른 사람과 공유하거나 클라우드에 올리지 마세요.
'라피스대시보드-데이터'의 로그인 정보는 이 PC의 Windows 계정으로만 풀립니다.
"@ | Set-Content -LiteralPath (Join-Path $Dest '읽어보세요.txt') -Encoding UTF8
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Dest 'manifest.json') -Encoding UTF8
Write-Host "백업 폴더: $Dest"
Write-Output $Dest
