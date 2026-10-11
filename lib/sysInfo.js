// ============================================================
// sysInfo.js - 系统信息 (电量 / 内存) 提供给 VM 内的系统使用
// ============================================================
// 性能约定 (非常重要, 请勿违反):
//   1) 绝不使用 execSync / execFileSync —— 同步调用会冻结整个 Node 事件循环,
//      曾导致 VM 的 pull_signal <-> tick 往返被拖慢(严重卡顿),
//      并触发 run.bat/run.sh 看门狗的 10 秒健康检查超时, 服务器被误杀重启。
//   2) 优先使用原生工具: Windows 用 tasklist (约 0.6s), 避免 PowerShell 启动开销
//      (本机实测 PowerShell 启动 + WMI 查询约 4s, 旧版 Get-WmiObject 高达 17s)。
//   3) 结果长时间缓存 + 并发去重; 判定为"无电池"(台式机/服务器) 后不再查询。
//   4) node 服务进程自身的内存和宿主总内存用 Node 内置 API 直接读取, 零成本。
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// 默认开启: 电量 / 内存需要提供给 VM 内的操作系统使用
let _enabled = true;
function setEnabled(v) { _enabled = !!v; }
function isEnabled() { return _enabled; }

const PS_TIMEOUT = 8000;

function psPath() {
  if (process.env.WINDIR) {
    const p = path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

// 异步执行 PowerShell, 返回 stdout (异步 => 不阻塞事件循环)
function runPowerShell(script, timeout = PS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(
      psPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout || ''))
    );
  });
}

// 异步执行原生程序, 返回 stdout
function runNative(file, args, timeout = PS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(file, args,
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout || '')));
  });
}

// ============================================================
// 电量 (提供给 VM: computer.energy())
// ============================================================
const BATTERY_TTL = 60000;                                  // 60 秒缓存
const BATTERY_DEFAULT = { percent: 100, charging: true };   // 无电池设备默认: 满电充电中

let _batteryCache = { ...BATTERY_DEFAULT };
let _batteryCacheTime = 0;
let _batteryNoBattery = false;    // 已确认无电池 -> 之后不再查询
let _batteryInflight = null;

async function getBatteryInfo() {
  if (!_enabled || _batteryNoBattery) return _batteryCache;
  if (Date.now() - _batteryCacheTime < BATTERY_TTL) return _batteryCache;
  if (_batteryInflight) return _batteryInflight;            // 并发去重

  _batteryInflight = (async () => {
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        // Get-CimInstance 比已弃用的 Get-WmiObject 快数倍
        const out = await runPowerShell(
          'Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue ' +
          '| Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'
        );
        const t = (out || '').trim();
        if (!t) {
          _batteryNoBattery = true;                         // 台式机/服务器: 无电池
        } else {
          const parsed = JSON.parse(t);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          const bat = arr.find(b => b && b.EstimatedChargeRemaining != null);
          if (!bat) {
            _batteryNoBattery = true;
          } else {
            const charge = parseInt(bat.EstimatedChargeRemaining, 10);
            const status = parseInt(bat.BatteryStatus, 10);
            // BatteryStatus: 2/6/7/8/9 表示接电中
            if (!isNaN(charge) && charge >= 0 && charge <= 100) {
              _batteryCache = { percent: charge, charging: [2, 6, 7, 8, 9].includes(status) };
            }
          }
        }
      } else if (platform === 'darwin') {
        const out = await runNative('pmset', ['-g', 'batt']);
        const m = out.match(/(\d+)%/);
        if (m) {
          _batteryCache = {
            percent: parseInt(m[1], 10),
            charging: /charging|AC Power|charged/.test(out),
          };
        }
      } else {
        const dir = '/sys/class/power_supply';
        let dirs = [];
        try { dirs = fs.readdirSync(dir); } catch (e) { dirs = []; }
        const batDir = dirs.find(d => d.startsWith('BAT'));
        if (!batDir) {
          _batteryNoBattery = true;
        } else {
          const base = path.join(dir, batDir);
          const full = parseInt(fs.readFileSync(path.join(base, 'energy_full'), 'utf8').trim(), 10);
          const now = parseInt(fs.readFileSync(path.join(base, 'energy_now'), 'utf8').trim(), 10);
          const status = fs.readFileSync(path.join(base, 'status'), 'utf8').trim();
          if (full > 0) {
            _batteryCache = {
              percent: Math.round((now / full) * 100),
              charging: status === 'Charging' || status === 'Full',
            };
          }
        }
      }
      _batteryCache.percent = Math.max(0, Math.min(100, _batteryCache.percent));
    } catch (e) {
      // 查询失败: 保持默认值, 下次仍会重试
    }
    _batteryCacheTime = Date.now();
    return _batteryCache;
  })();

  try {
    return await _batteryInflight;
  } finally {
    _batteryInflight = null;
  }
}

// ============================================================
// 内存: 本工具占用了宿主多少内存 (占宿主总内存的百分比)
// ============================================================
const ALL_MEM_TTL = 20000;                       // 进程内存表 20 秒缓存
let _allMemCache = { value: new Map(), time: 0 };
let _allMemInflight = null;

// Windows: 一次 tasklist 拿到所有进程的内存占用 (原生程序, 约 0.6s)
// 输出形如: "node.exe","1234","Console","1","45,632 K"
function readAllProcessMemoryWindows() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const map = new Map();
        if (err || !stdout) return resolve(map);
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^"[^"]*","(\d+)","[^"]*","[^"]*","([\d,]+) K"/);
          if (m) {
            const pid = parseInt(m[1], 10);
            const kb = parseInt(m[2].replace(/,/g, ''), 10);
            if (!isNaN(pid) && !isNaN(kb)) map.set(pid, kb * 1024);
          }
        }
        resolve(map);
      }
    );
  });
}

// Linux / macOS: ps 一次性拿到所有进程的 RSS
async function readAllProcessMemoryUnix() {
  const map = new Map();
  try {
    const out = await runNative('ps', ['-eo', 'pid=,rss=']);
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(parseInt(m[1], 10), parseInt(m[2], 10) * 1024);  // ps 返回 KB
    }
  } catch (e) { /* ignore */ }
  return map;
}

async function getAllProcessMemory() {
  const now = Date.now();
  if (_allMemCache.value.size && (now - _allMemCache.time) < ALL_MEM_TTL) return _allMemCache.value;
  if (_allMemInflight) return _allMemInflight;

  _allMemInflight = (async () => {
    let map;
    try {
      map = (os.platform() === 'win32')
        ? await readAllProcessMemoryWindows()
        : await readAllProcessMemoryUnix();
    } catch (e) {
      map = new Map();
    }
    if (map && map.size) _allMemCache = { value: map, time: Date.now() };
    return _allMemCache.value;
  })();

  try {
    return await _allMemInflight;
  } finally {
    _allMemInflight = null;
  }
}

/**
 * 本工具的内存占用情况。
 *   toolUsed = node 服务进程 + 所有 VM 子进程 的常驻内存
 *   hostTotal = 宿主机器总内存
 *   percent   = toolUsed / hostTotal * 100  (本工具占宿主内存的百分比)
 * @param {number[]} childPids 本工具拉起的 VM 子进程 PID 列表
 */
async function getToolMemoryInfo(childPids = []) {
  // node 进程自身内存: 内置 API, 零成本
  let selfRss = 0;
  try { selfRss = process.memoryUsage().rss; } catch (e) { selfRss = 0; }

  let childRss = 0;
  if (_enabled && childPids && childPids.length) {
    const all = await getAllProcessMemory();
    for (const pid of childPids) {
      const v = all.get(Number(pid));
      if (v) childRss += v;
    }
  }

  const hostTotal = os.totalmem();
  const toolUsed = selfRss + childRss;
  const percent = hostTotal > 0 ? (toolUsed / hostTotal) * 100 : 0;
  return { hostTotal, toolUsed, percent, selfRss, childRss };
}

// 兼容旧接口: 单个进程的内存 (字节)
async function getProcessMemory(pid) {
  if (!pid) return 0;
  const all = await getAllProcessMemory();
  return all.get(Number(pid)) || 0;
}

// VM 退出时清理该进程的缓存 (整表缓存, 这里只需要让下次刷新即可)
function forgetProcess(pid) {
  if (pid) _allMemCache.time = 0;
}

module.exports = {
  getBatteryInfo,
  getProcessMemory,
  getToolMemoryInfo,
  setEnabled,
  isEnabled,
  forgetProcess,
};
