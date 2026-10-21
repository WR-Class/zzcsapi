# Dedicated opencode sidecar for the gateway's `opencode` channel (fixed port + fixed password).
#
# Why this exists (2026-10-21 postmortem): the gateway used to point at a sidecar owned by another
# app (omnirush desktop). That app chooses its own port and its own random password, so when it
# restarted the gateway silently kept probing a dead endpoint -- 87 failures in 8.7 hours, one every
# 5 minutes (health.intervalSec=300), zero successes, error text was the sidecar "cannot connect" message
# (AggregateError = both the IPv4 and the IPv6 address of host.docker.internal refused the connection).
# Owning the sidecar means the port and the password are OURS and do not drift.
#
# Password source: OPENCODE_SIDECAR_PASSWORD in the repo's .env (gitignored). Never pass it on the
# command line -- `opencode serve` has no --password flag at all; it reads the env var, and if the var
# is MISSING it invents a random password and prints it to stdout (so "leave it unset" is not an option,
# and its stdout is a leak surface). The channel's "API Key" field must hold the SAME value.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\opencode-sidecar.ps1            # start (idempotent)
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\opencode-sidecar.ps1 -Stop      # stop
#
# Auto-start after reboot (no elevation needed), same pattern as start-reverse-proxy.ps1:
#   Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'zzcsapi-opencode' `
#     -Value 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\DSHXM\ZZCSAPI\deploy\opencode-sidecar.ps1"'
# Remove auto-start:
#   Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'zzcsapi-opencode'
#
# NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM,
# and non-ASCII comments break the tokenizer (hit once, 2026-10-04).

param(
  [int]$Port = 4666,
  [string]$Bind = '127.0.0.1',
  [string]$Exe  = 'C:\Users\RongWu\AppData\Local\Programs\@omnirushdesktop\resources\sidecars\opencode-x86_64-pc-windows-msvc.exe',
  [string]$LogDir = (Join-Path $env:LOCALAPPDATA 'zzcsapi\opencode-sidecar'),
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

# Working directory MUST be an empty dedicated folder, never the repo.
# Why: the sidecar treats its cwd as the PROJECT ROOT and injects that project's files into every
# session as context. Measured 2026-10-21: started from D:\DSHXM\ZZCSAPI, one trivial prompt cost
# `tokens.input = 50627` (the whole gateway repo went to a free-tier model -- privacy leak + ~9s
# latency + wasted quota). From an empty folder the same prompt is a few hundred input tokens.
$WorkDir = Join-Path $LogDir 'work'

if ($Stop) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { Write-Output "nothing listening on $Port"; exit 0 }
  foreach ($c in $conns) { try { Stop-Process -Id $c.OwningProcess -Force; Write-Output "stopped pid $($c.OwningProcess)" } catch { Write-Output "stop failed: $($_.Exception.Message)" } }
  exit 0
}

# Idempotent: already served -> leave it alone.
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "already listening on $Port"
  exit 0
}

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envFile)) { Write-Error ".env not found at $envFile"; exit 1 }
$pwLine = Select-String -Path $envFile -Pattern '^\s*OPENCODE_SIDECAR_PASSWORD\s*=' | Select-Object -Last 1
if (-not $pwLine) { Write-Error "OPENCODE_SIDECAR_PASSWORD missing from $envFile -- add it first (it must equal the channel's API Key)."; exit 1 }
$pw = ($pwLine.Line -replace '^\s*OPENCODE_SIDECAR_PASSWORD\s*=\s*', '').Trim()
if ($pw -match ':') { Write-Error "password must not contain ':' -- opencode splits Basic auth on the first colon"; exit 1 }
if ($pw.Length -lt 16) { Write-Error "password too short (need >= 16 chars)"; exit 1 }

if (-not (Test-Path $Exe)) { Write-Error "sidecar exe not found: $Exe (pass -Exe)"; exit 1 }
New-Item -ItemType Directory -Force $LogDir | Out-Null
New-Item -ItemType Directory -Force $WorkDir | Out-Null

$env:OPENCODE_SERVER_PASSWORD = $pw
$log = Join-Path $LogDir ("sidecar-$Port.log")
Write-Output "starting: $Exe serve --hostname $Bind --port $Port  (cwd=$WorkDir)"
Start-Process -FilePath $Exe `
  -ArgumentList 'serve', '--hostname', $Bind, '--port', "$Port" `
  -WorkingDirectory $WorkDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $log `
  -RedirectStandardError (Join-Path $LogDir ("sidecar-$Port.err.log"))

# Wait for the port, then say whether Basic auth is accepted.
for ($i = 0; $i -lt 60; $i++) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { break }
  Start-Sleep -Milliseconds 250
}
if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  Write-Error "sidecar did not start listening on $Port within 15s -- see $log"
  exit 1
}

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pw"))
try {
  $r = Invoke-WebRequest -Uri "http://${Bind}:$Port/api/model" -Headers @{ Authorization = "Basic $b64" } -UseBasicParsing -TimeoutSec 10
  # NOTE: do NOT print $r.Content.Length here -- Windows PowerShell reports a wildly inflated length
  # for this response (4.9 MB measured vs 23850 bytes actual via node fetch), i.e. a misleading number.
  Write-Output "listening on ${Bind}:$Port ; GET /api/model -> $($r.StatusCode) (auth accepted)"
} catch {
  $code = $null
  try { $code = $_.Exception.Response.StatusCode.value__ } catch { }
  Write-Error "listening on ${Bind}:$Port but GET /api/model failed (HTTP $code) -- the password does not match the sidecar. See $log"
  exit 1
}
