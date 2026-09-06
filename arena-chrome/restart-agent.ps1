# 重启 arena agent（安全版：kill 由本文件进程名隔离，不会自杀）
$ag = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*arena-agent.js*' }
$ag | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*zzcsapi-arena-profile*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Seconds 4
$env:ZZCSAPI_ARENA_HEADFUL = '1'
Start-Process node -WindowStyle Hidden -ArgumentList 'D:\DSHXM\ZZCSAPI\arena-agent.js' `
  -RedirectStandardOutput 'D:\DSHXM\ZZCSAPI\arena-data\agent.log' `
  -RedirectStandardError 'D:\DSHXM\ZZCSAPI\arena-data\agent-err.log'
Start-Sleep -Seconds 8
Write-Output 'agent restarted'
