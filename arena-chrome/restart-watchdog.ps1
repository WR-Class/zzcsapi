# 安全重启 watchdog（避免命令行自杀）
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
  Where-Object { $_.CommandLine -like '*arena-chrome*watchdog*' -and $_.ProcessId -ne $PID }
$wd | ForEach-Object { Write-Output ("kill watchdog pid=" + $_.ProcessId) }
$wd | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Seconds 2
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-ExecutionPolicy','Bypass','-File','D:\DSHXM\ZZCSAPI\arena-chrome\watchdog.ps1'
Start-Sleep -Seconds 5
Write-Output 'watchdog restarted'
