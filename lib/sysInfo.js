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
const BATTERY_RETRY_NO_BATTERY = 10 * 60 * 1000;            // re-probe a "no battery" host every 10 min
const BATTERY_DEFAULT = { percent: 100, charging: true };   // devices without a battery: full and charging

let _batteryCache = { ...BATTERY_DEFAULT };
let _batteryCacheTime = 0;
let _batteryNoBatteryUntil = 0;   // no battery confirmed -> skip queries until this timestamp
let _batteryInflight = null;
let _batteryWarned = false;
let _batteryLogged = false;           // a real reading has been printed once
let _batteryNoneLogged = false;       // "no battery" has been printed once

function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return null; }
}

// Windows: Win32_Battery is enough for most laptops, but some drivers leave it empty.
// Fall back to the WMI battery classes and finally to Win32_PortableBattery.
const WINDOWS_BATTERY_SCRIPT = [
  '$r=$null;',
  '$b=Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue',
  '| Where-Object { $null -ne $_.EstimatedChargeRemaining } | Select-Object -First 1;',
  'if($b){$r=@{percent=[int]$b.EstimatedChargeRemaining;',
  'charging=(@(2,6,7,8,9) -contains [int]$b.BatteryStatus)}};',
  'if(-not $r){',
  '$f=(Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity',
  '-ErrorAction SilentlyContinue | Select-Object -First 1).FullChargedCapacity;',
  '$s=Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue',
  '| Where-Object { $_.BatteryPresent } | Select-Object -First 1;',
  'if($s -and $f -gt 0){$r=@{percent=[int][math]::Round(($s.RemainingCapacity/$f)*100);',
  'charging=[bool]($s.PowerOnline -or $s.Charging)}}};',
  'if(-not $r){',
  '$p=Get-CimInstance -ClassName Win32_PortableBattery -ErrorAction SilentlyContinue',
  '| Where-Object { $null -ne $_.EstimatedChargeRemaining } | Select-Object -First 1;',
  'if($p){$r=@{percent=[int]$p.EstimatedChargeRemaining;charging=$false}}};',
  'if($r){$r|ConvertTo-Json -Compress}else{\'{"present":false}\'}',
].join(' ');

async function readBatteryWindows() {
  const out = await runPowerShell(WINDOWS_BATTERY_SCRIPT);
  const text = (out || '').trim();
  if (!text) return null;                       // no battery (desktop / server)
  const parsed = JSON.parse(text);
  if (!parsed || parsed.present === false) return null;
  const percent = Number(parsed.percent);
  if (!Number.isFinite(percent)) return null;
  return { percent: percent, charging: !!parsed.charging };
}

async function readBatteryDarwin() {
  const out = await runNative('pmset', ['-g', 'batt']);
  const m = out.match(/(\d+)%/);
  if (!m) return null;
  return {
    percent: parseInt(m[1], 10),
    charging: /charging|AC Power|charged/.test(out),
  };
}

// One sysfs battery: "capacity" is a percentage; energy_now/energy_full are µWh and
// charge_now/charge_full are µAh (both give the same ratio). "uevent" is the last resort,
// because some Android kernels only allow reading the aggregated uevent file.
function batteryPercentFromSysfs(base) {
  const capacity = parseInt(readTextFile(path.join(base, 'capacity')) || '', 10);
  if (!isNaN(capacity) && capacity >= 0) return capacity;
  const pairs = [['energy_now', 'energy_full'], ['charge_now', 'charge_full']];
  for (const [nowFile, fullFile] of pairs) {
    const now = parseInt(readTextFile(path.join(base, nowFile)) || '', 10);
    const full = parseInt(readTextFile(path.join(base, fullFile)) || '', 10);
    if (!isNaN(now) && !isNaN(full) && full > 0) return Math.round((now / full) * 100);
  }
  const uevent = readTextFile(path.join(base, 'uevent'));
  if (uevent) {
    const m = /POWER_SUPPLY_CAPACITY=(\d+)/.exec(uevent);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function batteryStatusFromSysfs(base) {
  let status = readTextFile(path.join(base, 'status'));
  if (!status) {
    const uevent = readTextFile(path.join(base, 'uevent'));
    const m = uevent && /POWER_SUPPLY_STATUS=(\w+)/.exec(uevent);
    if (m) status = m[1];
  }
  return (status || '').toLowerCase();
}

function readBatteryLinux() {
  const root = '/sys/class/power_supply';
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return null; }
  let sum = 0;
  let count = 0;
  let charging = false;
  for (const name of entries) {
    const base = path.join(root, name);
    const type = (readTextFile(path.join(base, 'type')) || '').toLowerCase();
    const isBattery = type === 'battery' || /^bat/i.test(name) || name === 'battery';
    if (!isBattery) continue;
    const percent = batteryPercentFromSysfs(base);
    if (percent === null) continue;
    sum += percent;
    count++;
    const status = batteryStatusFromSysfs(base);
    if (status === 'charging' || status === 'full') charging = true;
  }
  if (!count) return null;
  return { percent: Math.round(sum / count), charging: charging };
}

// Android often denies readdir() on /sys/class/power_supply while single files stay
// readable, so probe the common supply names directly.
const SUPPLY_GUESSES = ['battery', 'bms', 'BAT0', 'BAT1', 'mtk-battery', 'bq27541-0'];

function readBatteryLinuxFallback() {
  for (const name of SUPPLY_GUESSES) {
    const base = path.join('/sys/class/power_supply', name);
    const percent = batteryPercentFromSysfs(base);
    if (percent === null) continue;
    const status = batteryStatusFromSysfs(base);
    return {
      percent: percent,
      charging: status === 'charging' || status === 'full',
    };
  }
  return null;
}

function isAndroid() {
  // Node.js built for Android reports platform "android", while Termux ships a linux
  // build that only exposes itself through PREFIX / TERMUX_VERSION.
  if (os.platform() === 'android') return true;
  if (process.env.TERMUX_VERSION) return true;
  if (process.env.PREFIX && process.env.PREFIX.indexOf('com.termux') >= 0) return true;
  if (os.platform() !== 'linux') return false;
  return fs.existsSync('/system/build.prop') || fs.existsSync('/system/app');
}

// Android: sysfs is often unreadable for apps, but Termux:API reports the real battery
async function readBatteryTermux() {
  let out;
  try {
    out = await runNative('termux-battery-status');
  } catch (e) {
    return null;                      // Termux:API is not installed: not a failure of the host
  }
  const info = JSON.parse(out);
  const percent = Number(info && info.percentage);
  if (!Number.isFinite(percent)) return null;
  const status = String((info && info.status) || '').toUpperCase();
  const plugged = String((info && info.plugged) || '').toUpperCase();
  return {
    percent: percent,
    charging: status === 'CHARGING' || status === 'FULL'
      || (plugged !== '' && plugged !== 'UNPLUGGED' && plugged !== 'UNDEFINED'),
  };
}

// Returns null when the host really has no battery; throws on transient failures
async function readBatteryAny() {
  const platform = os.platform();
  if (platform === 'win32') return readBatteryWindows();
  if (platform === 'darwin') return readBatteryDarwin();
  const linux = readBatteryLinux() || readBatteryLinuxFallback();
  if (linux) return linux;
  if (isAndroid()) return readBatteryTermux();
  return null;
}

// Dump what the battery probe can and cannot see, for /api/sysinfo/battery
async function getBatteryDiagnostics() {
  const diag = {
    enabled: _enabled,
    platform: os.platform(),
    android: isAndroid(),
    cached: { percent: _batteryCache.percent, charging: _batteryCache.charging },
    error: null,
    details: [],
  };
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      const out = await runPowerShell(WINDOWS_BATTERY_SCRIPT);
      diag.details.push({ step: 'powershell', output: (out || '').trim().slice(0, 500) });
    } else if (platform === 'darwin') {
      const out = await runNative('pmset', ['-g', 'batt']);
      diag.details.push({ step: 'pmset', output: (out || '').trim().slice(0, 500) });
    } else {
      const root = '/sys/class/power_supply';
      let entries = null;
      try {
        entries = fs.readdirSync(root);
        diag.details.push({ step: 'readdir', path: root, entries: entries });
      } catch (e) {
        diag.details.push({ step: 'readdir', path: root, error: e.message });
      }
      for (const name of (entries || [])) {
        const base = path.join(root, name);
        diag.details.push({
          step: 'supply',
          path: base,
          type: readTextFile(path.join(base, 'type')),
          capacity: readTextFile(path.join(base, 'capacity')),
          status: readTextFile(path.join(base, 'status')),
          energy_now: readTextFile(path.join(base, 'energy_now')),
          energy_full: readTextFile(path.join(base, 'energy_full')),
          charge_now: readTextFile(path.join(base, 'charge_now')),
          charge_full: readTextFile(path.join(base, 'charge_full')),
        });
      }
      const android = isAndroid();
      diag.android = android;
      diag.termuxPrefix = process.env.PREFIX || null;
      if (android) {
        try {
          const out = await runNative('termux-battery-status');
          diag.details.push({ step: 'termux-battery-status', output: (out || '').trim().slice(0, 500) });
        } catch (e) {
          diag.details.push({ step: 'termux-battery-status', error: e.message });
        }
      }
    }
  } catch (e) {
    diag.error = e.message;
  }
  // What the regular probe would return right now (null = nothing readable)
  try {
    diag.probe = await readBatteryAny();
  } catch (e) {
    diag.probeError = e.message;
  }
  return diag;
}

async function getBatteryInfo() {
  if (!_enabled) return _batteryCache;
  const now = Date.now();
  if (_batteryNoBatteryUntil && now < _batteryNoBatteryUntil) return _batteryCache;
  if (now - _batteryCacheTime < BATTERY_TTL) return _batteryCache;
  if (_batteryInflight) return _batteryInflight;            // deduplicate concurrent calls

  _batteryInflight = (async () => {
    let info;
    try {
      info = await readBatteryAny();
    } catch (e) {
      // Transient failure: keep the last reading and retry after the TTL
      info = undefined;
      if (!_batteryWarned) {
        _batteryWarned = true;
        console.warn('[sysInfo] battery query failed: ' + e.message);
      }
    }
    if (info) {
      const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
      const charging = !!info.charging;
      // Log the first reading and every change, so a wrong value is visible in the server console
      if (!_batteryLogged || percent !== _batteryCache.percent || charging !== _batteryCache.charging) {
        _batteryLogged = true;
        console.log(`[sysInfo] battery: ${percent}%${charging ? ' (charging)' : ''}`);
      }
      _batteryCache = { percent: percent, charging: charging };
      _batteryNoBatteryUntil = 0;
    } else if (info === null) {
      // No battery: report a full battery, but probe again later (a removable or USB
      // battery can show up, and one bad probe must not latch this state forever)
      if (!_batteryNoneLogged) {
        _batteryNoneLogged = true;
        console.log('[sysInfo] battery: none found (reporting 100%), see /api/sysinfo/battery');
      }
      _batteryCache = { ...BATTERY_DEFAULT };
      _batteryNoBatteryUntil = Date.now() + BATTERY_RETRY_NO_BATTERY;
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
  getBatteryDiagnostics,
  getProcessMemory,
  getToolMemoryInfo,
  setEnabled,
  isEnabled,
  forgetProcess,
};
