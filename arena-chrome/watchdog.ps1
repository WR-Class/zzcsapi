# ZZCSAPI Arena Chrome 守护进程
# 保持宿主机 arena-agent（内含 headless 真 Chrome 的 arena.ai sidecar）常驻运行。
# 该计划任务开机登录后自动启动；进程崩溃/被杀后 30 秒内自动重启。
$ErrorActionPreference = 'SilentlyContinue'

$root = 'D:\DSHXM\ZZCSAPI'
$marker = "$root\arena-agent.js"

# headful：arena.ai 的 reCAPTCHA v3 对 headless 行为评分低，GPT 系模型会 403；
# headful（app 窗口）+ 行为预热可通过校验。桌面会常驻一个 arena 工作窗口。
$env:ZZCSAPI_ARENA_HEADFUL = '1'

function Test-AgentAlive {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9225/healthz' -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

while ($true) {
  # 心跳日志（每轮覆盖写一行，证明 watchdog 存活 + 诊断用）
  try { Set-Content "$root\arena-data\watchdog.heartbeat" -Value ("loop " + (Get-Date -Format 'HH:mm:ss') + " alive=" + (Test-AgentAlive)) -ErrorAction SilentlyContinue } catch {}
  if (-not (Test-AgentAlive)) {
    # 杀掉可能残留的旧 sidecar 浏览器（实际 profile 在 %TEMP%\zzcsapi-arena-profile；
    # arena-data\chrome-profile 是旧架构遗留，一并清理）
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
      Where-Object { $_.CommandLine -like "*zzcsapi-arena-profile*" -or $_.CommandLine -like "*$root\arena-data\chrome-profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Start-Process node -WindowStyle Hidden -ArgumentList @($marker) `
      -RedirectStandardOutput "$root\arena-data\agent.log" `
      -RedirectStandardError "$root\arena-data\agent-err.log"
  }
  Start-Sleep -Seconds 30
}
