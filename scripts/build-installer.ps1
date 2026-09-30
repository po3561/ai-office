# Windows 설치 파일(dist\AI-Office-Setup.exe)과 배포용 zip(dist\ai-office-app.zip)을 만든다.
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
foreach ($f in 'package.json', 'README.md', 'LICENSE', 'install.ps1', 'uninstall.ps1') { Copy-Item (Join-Path $root $f) $stage -Force }

# 2) zip (소스 배포·수동 설치용이며, 설치 파일 안에도 들어간다)
$zip = Join-Path $dist 'ai-office-app.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force

# 3) 설치 파일(.exe): 작은 C# 실행기 안에 payload.zip 을 넣는다.
$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe(.NET Framework 4.x)를 찾을 수 없습니다.' }
$target = Join-Path $dist 'AI-Office-Setup.exe'
$icon = Join-Path $root 'assets\ai-office.ico'
$cscArgs = @('/nologo', '/target:exe', '/codepage:65001', "/out:$target", "/resource:$zip,payload.zip",
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll')
if (Test-Path $icon) { $cscArgs += "/win32icon:$icon" }
$cscArgs += (Join-Path $PSScriptRoot 'SetupStub.cs')
& $csc @cscArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $target)) { throw '설치 파일(.exe)을 만들지 못했습니다.' }
Remove-Item $stage -Recurse -Force
Get-ChildItem $dist | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
Write-Host "완료: $target"
