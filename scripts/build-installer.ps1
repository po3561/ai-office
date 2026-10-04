# LAPIS 설치 파일(dist\LAPIS-Setup.exe)과 앱 zip(dist\ai-office-app.zip)을 만든다.
#   LAPIS-Setup.exe  약 1MB 부트스트래퍼. 실행하면 앱 본체와 휴대용 Node 를 내려받아 설치한다(scripts\Bootstrap.cs).
#   LAPIS.exe        트레이 실행기. 설치 파일 안에 들어 있다(scripts\Launcher.cs).
#   ai-office-app.zip 릴리스에 붙는 앱 본체. 설치 파일과 앱 안의 자동 업데이트가 이 파일을 받는다.
# Windows 에 기본으로 들어 있는 C# 컴파일러(csc.exe)만 쓰므로 추가 도구가 필요 없다.
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 1) 배포할 파일만 모은다
foreach ($i in 'bin', 'src', 'web', 'templates', 'scripts', 'assets') { Copy-Item (Join-Path $root $i) (Join-Path $stage $i) -Recurse -Force }
# 대시보드: 개인 설정·시험·개발 스크립트·한글 이름의 개발용 실행 파일은 뺀다
robocopy (Join-Path $root 'dashboard') (Join-Path $stage 'dashboard') /E /XD tests .runtime node_modules scripts /XF config.local.json '*.log' '*.ps1' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'dashboard 복사에 실패했습니다.' }
foreach ($f in 'package.json', 'README.md', 'LICENSE', 'install.ps1', 'uninstall.ps1') { Copy-Item (Join-Path $root $f) $stage -Force }
# 설치 파일 소스(.cs)는 앱에 넣지 않는다
Remove-Item (Join-Path $stage 'scripts\*.cs') -Force -ErrorAction SilentlyContinue

# 2) zip — 한글 파일 이름이 다른 언어의 Windows 에서도 깨지지 않도록 UTF-8 이름으로 직접 만든다
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = Join-Path $dist 'ai-office-app.zip'
$fs = [IO.File]::Create($zip)
$za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
$base = (Resolve-Path $stage).Path.TrimEnd('\') + '\'
Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($base.Length).Replace('\', '/')
    $entry = $za.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open(); $in = [IO.File]::OpenRead($_.FullName)
    try { $in.CopyTo($es) } finally { $in.Dispose(); $es.Dispose() }
}
$za.Dispose(); $fs.Dispose()

# 3) 컴파일: 실행기(LAPIS.exe) → 설치 파일(LAPIS-Setup.exe, 실행기를 리소스로 품는다)
$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe(.NET Framework 4.x)를 찾을 수 없습니다.' }
$icon = Join-Path $root 'assets\ai-office.ico'
$iconArg = @(); if (Test-Path $icon) { $iconArg = @("/win32icon:$icon") }

$launcher = Join-Path $dist 'LAPIS.exe'
& $csc /nologo /target:winexe /codepage:65001 "/out:$launcher" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll @iconArg (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $launcher)) { throw '실행기(LAPIS.exe)를 만들지 못했습니다.' }

$setup = Join-Path $dist 'LAPIS-Setup.exe'
& $csc /nologo /target:winexe /codepage:65001 "/out:$setup" "/resource:$launcher,launcher.exe" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll `
    @iconArg (Join-Path $PSScriptRoot 'Bootstrap.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setup)) { throw '설치 파일(LAPIS-Setup.exe)을 만들지 못했습니다.' }

Remove-Item $stage -Recurse -Force
Remove-Item $launcher -Force
Get-ChildItem $dist | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
Write-Host "완료: $setup"
