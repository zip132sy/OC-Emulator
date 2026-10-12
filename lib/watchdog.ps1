# ============================================================
# OC Emulator 外部看门狗 (由 run.bat 启动)
#
# 职责: 周期性检查后端服务是否还在正常响应。
#       如果服务卡死(进程还在但不再响应), 就把它重启 —— 守护脚本 run.bat 只对
#       "进程退出" 做出反应, 所以必须由外部把卡死的进程结束掉, 它才会被重新拉起。
#
# 关键点: 端口从 -PortFile 读取 (服务启动时会把实际端口写进去), 读不到才回退到
#         -Port。写死端口会导致: 配置端口被占用时服务换到 8081, 看门狗却一直监视
#         8080, 检查失败后退出 —— 服务真正卡死时反而没人管。
#
# 恢复顺序: 先请求 /api/server/restart (优雅重启, 服务会先停掉所有虚拟机);
#           该请求也超时/失败时才强杀端口对应的进程。
# ============================================================
param(
  [int]$Port = 8080,
  [string]$PortFile = '',
  [int]$Interval = 30,
  [int]$Timeout = 10,
  [string]$Sentinel = '',
  [string]$LogFile = ''
)

function Write-Log([string]$msg) {
  if (-not $LogFile) { return }
  try {
    Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: $msg" -ErrorAction SilentlyContinue
  } catch { }
}

function Resolve-Port {
  if ($PortFile -and (Test-Path $PortFile)) {
    try {
      $raw = (Get-Content -Path $PortFile -Raw -ErrorAction Stop).Trim()
      if ($raw -match '^[0-9]+$') { return [int]$raw }
    } catch { }
  }
  return $Port
}

function Find-PortOwner([int]$p) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conns) { return ($conns | Select-Object -First 1).OwningProcess }
  } catch { }
  try {
    $netstat = netstat -ano | Select-String "LISTENING"
    foreach ($line in $netstat) {
      if ("$line" -match ":$p\s+\S+\s+LISTENING\s+(\d+)") { return [int]$Matches[1] }
    }
  } catch { }
  return $null
}

while ($true) {
  Start-Sleep -Seconds $Interval

  # 守护脚本已结束 -> 看门狗随之退出
  if ($Sentinel -and -not (Test-Path $Sentinel)) { break }

  $port = Resolve-Port

  $healthy = $false
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/version" -UseBasicParsing -TimeoutSec $Timeout
    if ($r.StatusCode -eq 200) { $healthy = $true }
  } catch { }

  if ($healthy) { continue }

  # ---- 服务无响应 ----
  # 1) 先尝试优雅重启: 服务会先停掉所有虚拟机再退出(退出码 5), 守护脚本立即拉起。
  #    超时给短一点: 服务真的卡死时这个请求也必然超时, 没必要等太久。
  $graceful = $false
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/server/restart" -Method POST -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $graceful = $true }
  } catch { }

  if ($graceful) {
    Write-Log "服务在端口 $port 无响应, 已请求优雅重启"
    Start-Sleep -Seconds 5
    continue
  }

  # 2) 优雅重启也失败 -> 强杀进程, 让守护脚本重新拉起
  $ownerPid = Find-PortOwner $port
  if ($ownerPid) {
    Write-Log "服务在端口 $port 无响应且无法优雅重启, 强杀进程 PID $ownerPid"
    try { Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue } catch { }
  } else {
    Write-Log "服务在端口 $port 无响应, 未找到监听进程 (等待守护脚本拉起)"
  }
  Start-Sleep -Seconds 3
}
