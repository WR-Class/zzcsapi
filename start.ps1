# ZZCSAPI 启动脚本
# 用法： .\start.ps1
$env:ADMIN_KEY = if ($env:ZZCSAPI_ADMIN_KEY) { $env:ZZCSAPI_ADMIN_KEY } else { 'zz-admin-local' }
$env:GATEWAY_KEY = if ($env:ZZCSAPI_GATEWAY_KEY) { $env:ZZCSAPI_GATEWAY_KEY } else { 'zz-gw-local' }
Set-Location $PSScriptRoot
Write-Host "[zzcsapi] admin key  = $env:ADMIN_KEY" -ForegroundColor Cyan
Write-Host "[zzcsapi] gateway key= $env:GATEWAY_KEY" -ForegroundColor Cyan
Write-Host "[zzcsapi] console    = http://127.0.0.1:8787/console?key=$env:ADMIN_KEY" -ForegroundColor Green
Write-Host "[zzcsapi] openai url = http://127.0.0.1:8787/v1" -ForegroundColor Green
node server.js
