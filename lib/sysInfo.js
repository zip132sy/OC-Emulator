// ============================================================
// sysInfo.js - system info (battery / memory) exposed to the OS inside the VM
// ============================================================
// Performance rules (very important, do not break):
//   1) Never use execSync / execFileSync -- a sync call freezes the entire Node
//      event loop, slowing the VM's pull_signal <-> tick round trip (severe lag)
//      and tripping the run.bat/run.sh watchdog's 10s health check, which
//      kills and restarts the server.
//   2) Prefer native tools: tasklist on Windows (about 0.6s), avoiding PowerShell
//      startup cost (measured here: PowerShell start + WMI query is about 4s).
//   3) Long-lived result cache + in-flight deduplication; once a machine is known
//      to have "no battery" (desktop/server), later queries are skipped.
//   4) The node process's own memory and the host total come straight from
//      built-in Node APIs at zero cost.
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Enabled by default: the guest OS inside the VM acquires battery / memory data
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

// Run PowerShell asynchronously and return stdout (async => the event loop keeps running)
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

// Run a native program asynchronously and return stdout
function runNative(file, args, timeout = PS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(file, args,
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout || '')));
  });
}

// ============================================================
// Battery (exposed to the VM as computer.energy())
// ============================================================
const BATTERY_TTL = 60000;                                  // 60 s cache
const BATTERY_DEFAULT = { percent: 100, charging: true };   // devices without a battery: full and charging

let _batteryCache = { ...BATTERY_DEFAULT };
let _batteryCacheTime = 0;
let _batteryNoBattery = false;    // no battery confirmed -> skip later queries
let _batteryInflight = null;

async function getBatteryInfo() {
  if (!_enabled || _batteryNoBattery) return _batteryCache;
  if (Date.now() - _batteryCacheTime < BATTERY_TTL) return _batteryCache;
  if (_batteryInflight) return _batteryInflight;            // deduplicate concurrent calls

  _batteryInflight = (async () => {
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        // Get-CimInstance is several times faster than the deprecated Get-WmiObject
        const out = await runPowerShell(
          'Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue ' +
          '| Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'
        );
        const t = (out || '').trim();
        if (!t) {
          _batteryNoBattery = true;                         // desktop / server: no battery
        } else {
          const parsed = JSON.parse(t);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          const bat = arr.find(b => b && b.EstimatedChargeRemaining != null);
          if (!bat) {
            _batteryNoBattery = true;
          } else {
            const charge = parseInt(bat.EstimatedChargeRemaining, 10);
            const status = parseInt(bat.BatteryStatus, 10);
            // BatteryStatus: 2/6/7/8/9 means plugged in
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
      // Query failed: keep the previous values, the next call retries
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
// Memory: how much of the host this tool occupies (as a percentage of host total)
// ============================================================
const ALL_MEM_TTL = 20000;                       // 20 s cache of the process memory table
let _allMemCache = { value: new Map(), time: 0 };
let _allMemInflight = null;

// Windows: one tasklist call yields the memory of every process (native, about 0.6s)
// Output looks like: "node.exe","1234","Console","1","45,632 K"
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

// Linux / macOS: one ps call yields the RSS of every process
async function readAllProcessMemoryUnix() {
  const map = new Map();
  try {
    const out = await runNative('ps', ['-eo', 'pid=,rss=']);
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(parseInt(m[1], 10), parseInt(m[2], 10) * 1024);  // ps reports KB
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
 * Memory usage of this tool.
 *   toolUsed = resident memory of the node server + all VM child processes
 *   hostTotal = total memory of the host machine
 *   percent   = toolUsed / hostTotal * 100  (share of host memory taken by this tool)
 * @param {number[]} childPids PIDs of the VM child processes spawned by this tool
 */
async function getToolMemoryInfo(childPids = []) {
  // The node process's own memory: built-in API, zero cost
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

// Memory used by a single process (bytes)
async function getProcessMemory(pid) {
  if (!pid) return 0;
  const all = await getAllProcessMemory();
  return all.get(Number(pid)) || 0;
}

// Drop the cached entry for a process when its VM exits (the cache is whole-table, so just force a refresh next time)
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
