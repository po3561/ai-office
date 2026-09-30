# AI-Office 설치 스크립트
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Prefix 경로] [-NoShortcuts] [-NoAutostart] [-NoLaunch] [-Yes]
# 프로그램은 <Prefix>\app 에, 설정·사무실 데이터는 <Prefix> 아래에 둔다(기본 %LOCALAPPDATA%\AI-Office).
# 바탕화면이나 다운로드 폴더가 바뀌거나 정리되어도 계속 동작하도록 고정 위치에 설치한다.
param(
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'AI-Office'),
    [string]$SourceDir = $PSScriptRoot,
    [switch]$NoShortcuts,
    [switch]$NoAutostart,
    [switch]$NoLaunch,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }
function Ask($q) {
    if ($Yes) { return $true }
    $a = Read-Host "$q [Y/n]"
    return ($a -eq '' -or $a -match '^[Yy]')
}
function Find-Cmd($name) { $c = Get-Command $name -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { $null } }

Say ''
Say '  AI-Office 설치' 'Cyan'
Say '  ─────────────────────────────'

# 1) Node.js
$node = Find-Cmd 'node'
if ($node) {
    $ver = [version]((& $node --version).TrimStart('v'))
    if ($ver.Major -lt 20) { Say "  Node.js $ver 는 너무 오래되었습니다(20 이상 필요)." 'Yellow'; $node = $null }
}
if (-not $node) {
    Say '  Node.js 20 이상이 필요합니다.' 'Yellow'
    if ((Find-Cmd 'winget') -and (Ask '  winget 으로 Node.js LTS 를 설치할까요?')) {
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Find-Cmd 'node'
    }
    if (-not $node) { Say '  Node.js 를 설치한 뒤 다시 실행해 주세요: https://nodejs.org' 'Red'; exit 1 }
}
Say "  ✓ Node.js  $node"

# 2) 프로그램 복사(기존 설치는 덮어써서 업그레이드)
$app = Join-Path $Prefix 'app'
$cli = Join-Path $app 'bin\ai-office.mjs'
if (Test-Path $cli) {
    Say '  기존 설치를 업그레이드합니다. 실행 중인 대시보드를 잠시 멈춥니다…'
    try { & $node $cli stop | Out-Null } catch { }
    Start-Sleep -Seconds 1
}
New-Item -ItemType Directory -Force -Path $app | Out-Null
$items = 'bin', 'src', 'web', 'templates', 'scripts', 'assets'
foreach ($i in $items) {
    $from = Join-Path $SourceDir $i
    if (Test-Path $from) { robocopy $from (Join-Path $app $i) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
}
foreach ($f in 'package.json', 'README.md', 'LICENSE') {
    $from = Join-Path $SourceDir $f
    if (Test-Path $from) { Copy-Item $from (Join-Path $app $f) -Force }
}
if (-not (Test-Path $cli)) { Say "  설치 파일을 찾을 수 없습니다: $SourceDir" 'Red'; exit 1 }
$pkg = Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
@{ version = $pkg.version; node = $node; app = $app; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content (Join-Path $Prefix 'install.json') -Encoding UTF8
Say "  ✓ 프로그램 설치  $app"

# 3) 바로가기·자동 시작
$vbs = Join-Path $app 'scripts\launch.vbs'
$icon = Join-Path $app 'assets\ai-office.ico'
if (-not $NoShortcuts) {
    $sh = New-Object -ComObject WScript.Shell
    $make = {
        param($path)
        $l = $sh.CreateShortcut($path)
        $l.TargetPath = "$env:SystemRoot\System32\wscript.exe"
        $l.Arguments = "`"$vbs`" `"$node`" `"$cli`" open"
        $l.WorkingDirectory = $app
        $l.Description = 'AI-Office 대시보드'
        if (Test-Path $icon) { $l.IconLocation = $icon }
        $l.Save()
    }
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AI-Office'
    New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
    & $make (Join-Path $startMenu 'AI-Office 대시보드.lnk')
    & $make (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI-Office 대시보드.lnk')
    Say '  ✓ 바로가기  시작 메뉴 · 바탕화면'
}
if (-not $NoAutostart) {
    # 경로에 공백이 있어도 안전하도록 schtasks 대신 작업 스케줄러 cmdlet 을 쓴다.
    try {
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$vbs`" `"$node`" `"$cli`" serve"
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName 'AI-Office Dashboard' -Action $action -Trigger $trigger -Settings $settings -Description 'AI-Office 대시보드 서버 자동 시작' -Force | Out-Null
        Say '  ✓ 로그인할 때 자동으로 대시보드 서버 시작'
    } catch {
        Say "  ✗ 자동 시작을 등록하지 못했습니다: $($_.Exception.Message)" 'Yellow'
    }
}

# 4) 함께 필요한 도구 점검
Say ''
Say '  필요한 도구 확인' 'Cyan'
$claude = Find-Cmd 'claude'
if (-not $claude) { $claude = Get-ChildItem (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe') -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if ($claude) { Say "  ✓ Claude Code  $claude" } else { Say '  ✗ Claude Code 가 없습니다 — 대시보드의 「연결 · 계정」에서 설치할 수 있습니다.' 'Yellow' }
$bun = Find-Cmd 'bun'
if ($bun) { Say "  ✓ Bun  $bun" }
else {
    Say '  ✗ Bun 이 없습니다 (텔레그램 플러그인 실행에 필요).' 'Yellow'
    if ((Find-Cmd 'winget') -and (Ask '  winget 으로 Bun 을 설치할까요?')) { winget install -e --id Oven-sh.Bun --accept-source-agreements --accept-package-agreements }
}

Say ''
Say '  설치가 끝났습니다. 시작 메뉴의 「AI-Office 대시보드」로 열 수 있습니다.' 'Green'
if (-not $NoLaunch) { Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$vbs`" `"$node`" `"$cli`" open" }
