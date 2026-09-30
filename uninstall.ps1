# AI-Office 제거 스크립트
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-PurgeData]
# 기본은 프로그램·바로가기·자동 시작만 지우고, 설정과 사무실 데이터(대화·결과물)는 남긴다.
param(
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'AI-Office'),
    [switch]$PurgeData
)
$ErrorActionPreference = 'Continue'
$app = Join-Path $Prefix 'app'
$cli = Join-Path $app 'bin\ai-office.mjs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node -and (Test-Path $cli)) { try { & $node $cli stop | Out-Null } catch { } }
schtasks /Delete /F /TN 'AI-Office Dashboard' 2>$null | Out-Null
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI-Office') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI-Office 대시보드.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Prefix 'install.json') -Force -ErrorAction SilentlyContinue
if ($PurgeData) {
    Write-Host "데이터까지 모두 지웁니다: $Prefix" -ForegroundColor Yellow
    Remove-Item $Prefix -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "프로그램을 제거했습니다. 사무실 데이터는 그대로 있습니다: $Prefix"
}
