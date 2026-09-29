# Idempotent starter for the host-side nginx reverse-proxy layer (8787 -> gateway container 127.0.0.1:18787).
#
# Why this exists: in reverse-proxy mode (README section 3) nginx is NOT a Windows service, so after a
# reboot nothing listens on 8787 and every client fails to connect. Register this script for auto-start
# (HKCU Run key, no elevation needed):
#   Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
#     -Name 'zzcsapi-nginx' `
#     -Value 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\DSHXM\ZZCSAPI\deploy\start-reverse-proxy.ps1"'
# Remove auto-start:
#   Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'zzcsapi-nginx'
#
# Exits silently when 8787 is already served (idempotent). After editing the conf, run nginx -s reload.
# NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM,
# and non-ASCII comments break the tokenizer (hit once, 2026-10-04).

param(
  [string]$Runtime = 'D:\DSHXM\nginx-rt',
  [string]$Conf    = (Join-Path $PSScriptRoot 'nginx-reverse-proxy.conf')
)

if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) {
  exit 0
}

$exe = Join-Path $Runtime 'nginx.exe'
if (-not (Test-Path $exe)) {
  Write-Error "nginx.exe not found at $exe -- unpack the nginx for Windows zip into $Runtime first (see README section 3)."
  exit 1
}

New-Item -ItemType Directory -Force (Join-Path $Runtime 'logs') | Out-Null
Start-Process -FilePath $exe -ArgumentList '-p', "$Runtime\", '-c', $Conf -WorkingDirectory $Runtime
