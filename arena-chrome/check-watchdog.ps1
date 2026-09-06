# 查询 watchdog 存活（命令行文本隔离防自杀）
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*ZZCSAPI*watchdog.ps1*' }
if ($wd) { Write-Output ("watchdog alive pid=" + ($wd.ProcessId -join ',')) }
else { Write-Output 'watchdog NOT RUNNING' }
