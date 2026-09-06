# 列出所有 powershell/pwsh 进程的命令行（诊断 watchdog 查询为何匹配不到）
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
  ForEach-Object {
    $cl = $_.CommandLine
    if ($null -ne $cl) {
      if ($cl -like '*watchdog*' -or $cl -like '*arena*') {
        Write-Output ("pid=" + $_.ProcessId + " name=" + $_.Name)
        Write-Output ("  cmdline=" + $cl.Substring(0, [Math]::Min(180, $cl.Length)))
      }
    }
  }
