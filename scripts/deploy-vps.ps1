# deploy-vps.ps1 - build plan and atomically publish it to the VPS.
#
# First-time setup (already done for plan.yuban.icu):
#   - /opt/plan/.env          AICHATT_URL + AICHATT_TOKEN (mode 600)
#   - /opt/plan/data          SQLite data directory
#   - nginx + TLS + Basic Auth for plan.yuban.icu
#
# Usage: powershell -ExecutionPolicy Bypass -File plan/scripts/deploy-vps.ps1
#
# The package contains empty "data" and ".env" mountpoints. Docker cannot
# create a bind-mount target inside a read-only rootfs; keeping those entries
# in the package is what makes the nested mounts work.

param(
    [string]$VpsHost = "root@yuban.icu"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$DistDir = "/opt/plan-dist"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$PkgName = "plan-dist-$Stamp.tar.gz"

Write-Host "=== [1/4] build ===" -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
    npm run build:prod
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
} finally {
    Pop-Location
}

Write-Host "=== [2/4] stage ===" -ForegroundColor Cyan
$stage = Join-Path $env:TEMP "plan-dist-stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Recurse "$ProjectRoot\dist" "$stage\dist"
New-Item -ItemType Directory -Path "$stage\server" | Out-Null
Copy-Item "$ProjectRoot\server-dist\index.mjs" "$stage\server\index.mjs"
New-Item -ItemType Directory -Path "$stage\data" | Out-Null
New-Item -ItemType File -Path "$stage\.env" | Out-Null

$pkgPath = Join-Path $env:TEMP $PkgName
Remove-Item -Force $pkgPath -ErrorAction SilentlyContinue
& "$env:SystemRoot\System32\tar.exe" -czf $pkgPath -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
$pkgMB = [math]::Round((Get-Item $pkgPath).Length / 1MB, 2)
$pkgMd5 = (Get-FileHash -Algorithm MD5 -Path $pkgPath).Hash.ToLower()
Write-Host "OK ($pkgMB MB, md5 $pkgMd5)"

Write-Host "=== [3/4] upload ===" -ForegroundColor Cyan
& C:\Windows\System32\OpenSSH\scp.exe $pkgPath "${VpsHost}:/tmp/$PkgName"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

Write-Host "=== [4/4] switch + restart + health ===" -ForegroundColor Cyan
$remoteScript = @"
set -e
PKG=/tmp/$PkgName
echo "$pkgMd5  `$PKG" | md5sum -c -
rm -rf $DistDir.new $DistDir.old
mkdir -p $DistDir.new
tar -xzf `$PKG -C $DistDir.new
rm -f `$PKG
if [ -d $DistDir ]; then mv $DistDir $DistDir.old; fi
mv $DistDir.new $DistDir
chmod 600 $DistDir/.env || true
mkdir -p /opt/plan/data
docker rm -f plan-app >/dev/null 2>&1 || true
docker run -d --name plan-app --restart unless-stopped \
  --network aichatt_internal \
  -p 127.0.0.1:8788:8788 \
  -e NODE_ENV=production -e PORT=8788 -e TZ=Asia/Shanghai \
  -v ${DistDir}:/app:ro \
  -v /opt/plan/data:/app/data \
  -v /opt/plan/.env:/app/.env:ro \
  -w /app \
  node:24-slim node server/index.mjs
sleep 2
docker ps --filter name=plan-app --format '{{.Names}} {{.Status}}'
curl -fsS http://127.0.0.1:8788/api/health
echo
"@
# PowerShell pipes CRLF; strip CR or the last remote command becomes "echo\r"
$remoteScript | ssh $VpsHost "tr -d '\r' | bash -s"
if ($LASTEXITCODE -ne 0) { throw "remote deploy failed" }

Write-Host "DONE: https://plan.yuban.icu" -ForegroundColor Green
