# android-build.ps1 - build the Plan Android WebView shell.
#
# Usage:
#   powershell -File plan/scripts/android-build.ps1
#   powershell -File plan/scripts/android-build.ps1 -VersionName 1.0.1 -VersionCode 2
#   powershell -File plan/scripts/android-build.ps1 -Debug
#
# Release builds reuse the aichatt keystore at D:/aichatt-secrets/keystore.properties
# (override with PLAN_KEYSTORE_PROPERTIES). The APK is copied to <repo>/plan-<variant>.apk.

param(
    [string]$VersionName = "1.0.0",
    [int]$VersionCode = 1,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"
$PlanRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = Split-Path $PlanRoot -Parent
$AndroidRoot = Join-Path $PlanRoot "android"
# AGP refuses non-ASCII project paths. Mirror the project to an ASCII directory
# and build there; plan/android stays the single source of truth.
$BuildRoot = "D:\plan-android"
$Variant = if ($Debug) { "debug" } else { "release" }
$Task = if ($Debug) { ":app:assembleDebug" } else { ":app:assembleRelease" }

$env:ANDROID_HOME = "D:\AndroidSDK"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "D:\JDK"

Write-Host "=== [0/3] mirror to ASCII path ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
robocopy $AndroidRoot $BuildRoot /MIR /XD build .gradle .kotlin /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy failed with code $LASTEXITCODE" }

$localProps = Join-Path $BuildRoot "local.properties"
if (-not (Test-Path $localProps)) {
    Set-Content -Path $localProps -Value "sdk.dir=D:/AndroidSDK" -Encoding ASCII
}

Write-Host "=== [1/3] gradle $Variant ===" -ForegroundColor Cyan
Push-Location $BuildRoot
try {
    & .\gradlew.bat $Task "--no-daemon" "-PplanVersionName=$VersionName" "-PplanVersionCode=$VersionCode"
    if ($LASTEXITCODE -ne 0) { throw "gradle failed with code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "=== [2/3] locate apk ===" -ForegroundColor Cyan
$apkDir = Join-Path $BuildRoot "app\build\outputs\apk\$Variant"
$apk = Get-ChildItem -Path $apkDir -Filter "*.apk" |
    Where-Object { $_.Name -notlike "*-unsigned.apk" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $apk) { throw "gradle succeeded but no signed $Variant apk found under $apkDir" }

Write-Host "=== [3/3] copy + verify ===" -ForegroundColor Cyan
$out = Join-Path $RepoRoot "plan-$Variant.apk"
Copy-Item $apk.FullName $out -Force

# 同步到 plan 网站的公开下载路径（release 才更新线上可下载包）
if (-not $Debug) {
    $webApp = Join-Path $PlanRoot "public\app"
    New-Item -ItemType Directory -Force -Path $webApp | Out-Null
    Copy-Item $out (Join-Path $webApp "plan.apk") -Force
    Write-Host "web download updated: public/app/plan.apk"
}

$buildTools = Get-ChildItem "D:\AndroidSDK\build-tools" -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
if (Test-Path $apksigner) {
    # Capture all output first: piping a native command into Select-Object -First
    # closes the pipe early and makes apksigner return a non-zero code.
    $verify = & $apksigner verify --print-certs $out 2>&1
    $verifyCode = $LASTEXITCODE
    $verify | Select-Object -First 3 | Write-Host
    if ($verifyCode -ne 0) { throw "apksigner verify failed" }
}

Write-Host ("APK ({0}): {1}  {2} MB" -f $Variant, $out, [math]::Round((Get-Item $out).Length / 1MB, 2)) -ForegroundColor Green
