// ============================================================
// OC Emulator - web control panel server
// HTTP + WebSocket, VMware Workstation style
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const { VMManager } = require('./lib/vmManager');
const { ModsManager } = require('./lib/modsManager');
const { DiskIO } = require('./lib/diskIO');
const { LuaCheck } = require('./lib/luaCheck');
const { ModemHub } = require('./lib/modemHub');
const { InternetProxy } = require('./lib/internetProxy');
const { DeviceBus } = require('./lib/deviceBus');
const floppyTemplates = require('./lib/floppyTemplates');
const sysInfo = require('./lib/sysInfo');
const updateSource = require('./lib/updateSource');
const openosVersions = require('./lib/openosVersions');
const diskCatalog = require('./lib/diskCatalog');
const modTransfer = require('./lib/modTransfer');

// Some networks have no working IPv6; prefer IPv4 so guest HTTP requests do not fail
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) { /* API missing in older Node */ }

// Floppy template aliases (legacy name -> current name)
const floppyAliases = {
  'DataCard': 'Data',
  'data_card': 'Data',
  'network': 'Network',
  'openloader': 'OpenLoader',
  'oppm': 'OPPM',
  'openirc': 'OpenIRC',
};

// ---------- Paths ----------
const PROJECT_DIR = __dirname;
const VMS_DIR = path.join(PROJECT_DIR, 'vms');
const MODS_DIR = path.join(PROJECT_DIR, 'Mods');
const DISKS_DIR = path.join(PROJECT_DIR, 'disks');
const WEB_DIR = path.join(PROJECT_DIR, 'web');
const CACHE_DIR = path.join(PROJECT_DIR, 'cache');

// Disks downloaded from the image repository may ship an EEPROM boot program
// ("EFI", e.g. Fuchas / MineOS). It is stored next to the disk and named after it.
function templateEfiName(diskFile) {
  const base = String(diskFile || '').replace(/\.ocd$/i, '');
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return fs.existsSync(path.join(DISKS_DIR, 'eeprom', base + '.efi')) ? base + '.efi' : null;
}

// Copy the EFI into the VM directory and use it as the EEPROM unless the user
// picked their own EEPROM image.
function applyTemplateEfi(vmName, tplFile, hardware) {
  const efi = templateEfiName(tplFile);
  if (!efi || !hardware) return;
  const vmDir = path.join(VMS_DIR, vmName);
  fs.mkdirSync(vmDir, { recursive: true });
  fs.copyFileSync(path.join(DISKS_DIR, 'eeprom', efi), path.join(vmDir, efi));
  if (!hardware.eeprom || hardware.eeprom === 'built-in') hardware.eeprom = efi;
}

const EMU_SCRIPT = path.join(PROJECT_DIR, 'oc-emulator.lua');

// App version, read once from package.json (npm keeps the semver there; the UI
// shows the channel-tagged form below)
const APP_VERSION = (() => {
  try {
    return require(path.join(PROJECT_DIR, 'package.json')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Version display: Release = v2.0(R), Beta = v2.0.2(B).
// Release hides a zero patch component, Beta always shows it.
function formatVersion(version, channel) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version || ''));
  if (!m) return String(version || '');
  const major = m[1];
  const minor = m[2];
  const patch = m[3] || '0';
  if (channel === 'beta') return `v${major}.${minor}.${patch}(B)`;
  return patch === '0' ? `v${major}.${minor}(R)` : `v${major}.${minor}.${patch}(R)`;
}

// Ensure directories exist
for (const d of [VMS_DIR, MODS_DIR, DISKS_DIR, CACHE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- Settings ----------
function loadSettings() {
  const settingsPath = path.join(PROJECT_DIR, 'settings.json');
  // sysInfoPolling: report host battery / this tool's memory usage to the guest OS.
  //   On by default. Queries are async (tasklist / PowerShell) and cached, so they never block the event loop.
  let settings = {
    luaExe: 'lua',
    port: 8080,
    host: '127.0.0.1',
    logLevel: 'error',
    sysInfoPolling: true,
    showConsole: true,   // show the console window hosting the server (toggleable in the UI)
    autoUpdate: true,    // launcher pulls updates from the remote repo (toggleable in the UI)
    updateSource: 'auto', // auto | gitee | github (which remote the updater uses)
    updateChannel: 'release', // release | beta (which branch the updater follows)
    skipIntegrityCheck: false, // skip the dependency integrity check at startup (toggleable in the UI)
  };
  if (fs.existsSync(settingsPath)) {
    try {
      settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
    } catch (e) {
      console.error('[settings] cannot load settings.json:', e.message);
    }
  }
  // settings.json may hold a path from another OS (e.g. C:\...\lua.exe on Linux/macOS);
  // ignore it and fall back to "lua" auto-detection instead of breaking on startup.
  if (settings.luaExe && !isPlausibleLuaPath(settings.luaExe)) {
    console.log(`[settings] luaExe 路径不适用于当前平台, 改为自动探测: ${settings.luaExe}`);
    settings.luaExe = 'lua';
  }
  return settings;
}

// Check whether luaExe can plausibly run on this platform
function isPlausibleLuaPath(p) {
  if (!p || p === 'lua') return true;
  if (process.platform === 'win32') return true;   // no extra checks on Windows
  // Non-Windows: drive-letter or .exe paths are never usable
  const looksWindows = /^[A-Za-z]:[\\/]/.test(p) || /\.exe$/i.test(p);
  return !looksWindows;
}

// ---------- Service control exit codes (read by the run.bat / run.sh watchdog) ----------
const EXIT_STOP = 4;      // UI requested "stop service": watchdog must not restart
const EXIT_RESTART = 5;   // UI requested "restart service": restart at once, not counted as a retry

// Exit the server; the watchdog decides on a restart from the exit code.
// Stop running VMs first so no orphan processes are left behind.
function shutDownForGuardian(code) {
  try {
    for (const vm of vmManager.list()) {
      if (vm.state === 'running' || vm.state === 'paused' || vm.state === 'starting') {
        try { vmManager.stop(vm.name); } catch (e) { /* ignore a single VM stop failure */ }
      }
    }
    for (const mod of modsManager.listMods()) {
      if (mod.state === 'running' || mod.state === 'paused' || mod.state === 'starting') {
        try { modsManager.stop(mod.name); } catch (e) { /* ignore a single Mod stop failure */ }
      }
    }
  } catch (e) { /* ignore */ }
  // Give the VMs a moment to exit gracefully before quitting
  setTimeout(() => process.exit(code), 1200);
}

// ---------- Update checks (git) ----------
// Run a git command once; never throws, always returns { ok, stdout, stderr, err }
function gitRun(args, timeout = 90000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: PROJECT_DIR, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        err: err ? String(err.message || err) : null,
      }));
  });
}

// Parse git log output (format: %H \x1f %h \x1f %s \x1f %ad)
const LOG_SEP = '\x1f';
async function gitLogLines(args) {
  const r = await gitRun(args, 30000);
  if (!r.ok) return [];
  return r.stdout.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(LOG_SEP);
      return {
        sha: parts[0] || '',
        short: parts[1] || parts[0] || '',
        subject: parts[2] || '',
        date: parts[3] || '',
      };
    });
}

// Which branch the selected update channel follows: Release = main, Beta = beta
function channelBranchName() {
  return updateSource.branchForChannel(settings.updateChannel);
}

// Channel of the running build: the checked-out branch decides, the setting is the fallback
async function versionChannel() {
  if (fs.existsSync(path.join(PROJECT_DIR, '.git'))) {
    const branch = await currentBranchName();
    if (branch === 'beta') return 'beta';
    if (branch === 'main' || branch === 'master') return 'release';
  }
  return settings.updateChannel === 'beta' ? 'beta' : 'release';
}

// Upstream ref of the given branch (e.g. origin/main); falls back to common remote branches
async function resolveUpstreamRef(branch) {
  const up = await gitRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 15000);
  const name = up.ok ? up.stdout.trim() : '';
  if (name && name.indexOf('/') >= 0 && name.endsWith('/' + branch)) return name;
  for (const ref of [`origin/${branch}`, `github/${branch}`, 'origin/main', 'origin/master']) {
    const r = await gitRun(['rev-parse', '--verify', ref], 15000);
    if (r.ok && r.stdout.trim()) return ref;
  }
  return null;
}

// Current branch name (falls back to main on detached HEAD)
async function currentBranchName() {
  const r = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
  const name = r.ok ? r.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : 'main';
}

// Update source candidates, tried in this order:
//   1. the faster source picked last time in cache/update-source.json
//   2. Gitee
//   3. GitHub
// Use the configured remote name when present, otherwise the official mirror URL
// (the updater is read-only and must not touch the user's git config).
function listUpdateTargets() {
  const remotes = updateSource.detectRemotes();
  const cache = updateSource.readCache();
  const targets = [];
  const add = (key) => {
    const remote = remotes[key] || updateSource.MIRRORS[key];
    if (!remote) return;
    if (targets.some((t) => t.remote === remote)) return;
    targets.push({
      key,
      remote,
      isUrl: !remotes[key],
      label: updateSource.SOURCES[key].label,
    });
  };
  // An explicit choice in the settings is used alone; "auto" keeps the measured order
  if (settings.updateSource === 'gitee' || settings.updateSource === 'github') {
    add(settings.updateSource);
    return { targets, remotes };
  }
  if (cache && cache.source) add(cache.source);
  add('gitee');
  add('github');
  return { targets, remotes };
}

// Update source label for the UI; custom remotes just show their remote name
function sourceLabel(target) {
  if (!target) return '';
  return target.label || target.remote || '';
}

// Check whether an update is available
async function checkForUpdate() {
  const out = { ok: false, available: false, behind: 0, current: null, latest: null, subject: '', error: null, detail: '', source: null, ref: null };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }

  // Fetch each source in turn; the first success becomes the comparison base
  const branch = channelBranchName();
  const { targets } = listUpdateTargets();
  let ref = null;
  let detail = '';
  for (const target of targets) {
    // URL fetches need an explicit branch; the result lands in FETCH_HEAD
    const fetchArgs = target.isUrl
      ? ['fetch', '--quiet', target.remote, branch]
      : ['fetch', '--quiet', target.remote];
    const fetch = await gitRun(fetchArgs, 45000);
    if (!fetch.ok) {
      detail = (fetch.stderr || fetch.err || '').trim().slice(0, 500);
      logger.log(`[update] ${target.label} 拉取失败, 尝试下一个源`);
      continue;
    }
    const candidate = target.isUrl ? 'FETCH_HEAD' : `${target.remote}/${branch}`;
    const verify = await gitRun(['rev-parse', '--verify', candidate], 10000);
    if (!verify.ok) {
      detail = `remote branch not found: ${candidate}`;
      continue;
    }
    ref = candidate;
    out.source = sourceLabel(target);
    break;
  }

  // No GitHub / Gitee remote detected (custom mirror etc.): fall back to the default upstream
  if (!ref) {
    const upstream = await resolveUpstreamRef(branch);
    if (upstream) {
      const fetch = await gitRun(['fetch', '--quiet'], 30000);
      if (fetch.ok) {
        ref = upstream;
        out.source = upstream.split('/')[0];
      } else {
        detail = (fetch.stderr || fetch.err || '').trim().slice(0, 500);
      }
    }
  }

  if (!ref) {
    out.error = 'fetch-failed';
    out.detail = detail;
    return out;
  }
  out.ref = ref;

  const cur = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.current = cur.ok ? cur.stdout.trim().slice(0, 7) : null;

  const cnt = await gitRun(['rev-list', '--count', `HEAD..${ref}`], 15000);
  out.behind = cnt.ok ? (parseInt(cnt.stdout.trim(), 10) || 0) : 0;

  const lat = await gitRun(['rev-parse', ref], 15000);
  out.latest = lat.ok ? lat.stdout.trim().slice(0, 7) : null;

  const sub = await gitRun(['log', '-1', '--pretty=%s', ref], 15000);
  out.subject = sub.ok ? sub.stdout.trim() : '';

  out.available = out.behind > 0;

  // Changelog: incoming commits when behind, latest commits of the current version when up to date
  const LOG_FMT = ['--pretty=%H%x1f%h%x1f%s%x1f%ad', '--date=short'];
  if (out.available) {
    out.logMode = 'new';
    out.log = await gitLogLines(['log', ...LOG_FMT, '-n', '30', `HEAD..${ref}`]);
  } else {
    out.logMode = 'current';
    out.log = await gitLogLines(['log', ...LOG_FMT, '-n', '10', ref]);
  }

  out.ok = true;
  return out;
}

// Switch the working tree to the branch the selected channel follows. An existing
// local branch is checked out; otherwise it is created from the fetched ref.
async function switchToChannelBranch(branch, targets) {
  if ((await currentBranchName()) === branch) return { ok: true };
  const local = await gitRun(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 10000);
  if (local.ok) {
    const r = await gitRun(['checkout', branch], 30000);
    return r.ok
      ? { ok: true }
      : { ok: false, detail: ((r.stderr || r.err || '') + '').trim().slice(0, 400) };
  }
  for (const target of targets) {
    const fetch = await gitRun(target.isUrl
      ? ['fetch', '--quiet', target.remote, branch]
      : ['fetch', '--quiet', target.remote], 45000);
    if (!fetch.ok) continue;
    const ref = target.isUrl ? 'FETCH_HEAD' : `${target.remote}/${branch}`;
    const create = await gitRun(['checkout', '-b', branch, ref], 30000);
    if (create.ok) return { ok: true };
  }
  return { ok: false, detail: `cannot switch to branch ${branch}` };
}

// Try `git pull --ff-only` from each source in turn, then from the default upstream.
// onLine receives streamed progress lines (null for a plain call).
async function pullFromUpdateSources(onLine) {
  const branch = channelBranchName();
  const { targets } = listUpdateTargets();
  const note = (text) => { if (onLine) onLine(text); };

  // The channel decides the branch: switching Release <-> Beta happens here
  note(`git checkout ${branch}`);
  const switched = await switchToChannelBranch(branch, targets);
  if (!switched.ok) {
    logger.log('[update] 切换版本分支失败: ' + (switched.detail || ''));
    note('切换版本分支失败: ' + (switched.detail || ''));
    return {
      ok: false,
      error: 'channel-switch-failed',
      source: null,
      remote: null,
      result: { ok: false, stdout: '', stderr: switched.detail || '' },
    };
  }

  const runPull = (args) => (onLine
    ? runGitStreaming(args, onLine)
    : gitRun(args, 180000));

  for (const target of targets) {
    logger.log(`[update] 从 ${target.label} 拉取`);
    note(`git pull ${target.remote} ${branch}`);
    const r = await runPull(['pull', '--ff-only', '--progress', target.remote, branch]);
    if (r.ok) return { ok: true, source: sourceLabel(target), remote: target.remote, result: r };
    note(`${target.label} 拉取失败, 尝试下一个源`);
  }

  // No matching GitHub / Gitee remote, or all failed: pull from the default upstream
  logger.log('[update] 使用默认上游拉取');
  note('git pull --ff-only');
  const r = await runPull(['pull', '--ff-only', '--progress']);
  return { ok: r.ok, source: r.ok ? 'upstream' : null, remote: null, result: r };
}

// Apply the update (git pull --ff-only); pull only, the UI decides whether to restart
async function applyUpdate() {
  const out = { ok: false, changed: false, before: null, after: null, output: '', error: null, source: null };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }

  const before = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.before = before.ok ? before.stdout.trim().slice(0, 7) : null;

  const pulled = await pullFromUpdateSources(null);
  const pull = pulled.result;
  out.source = pulled.source;
  out.output = ((pull.stdout || '') + (pull.stderr || '')).trim().slice(0, 2000);
  if (!pull.ok) { out.error = pulled.error || 'pull-failed'; return out; }

  const after = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.after = after.ok ? after.stdout.trim().slice(0, 7) : null;
  out.changed = !!(out.before && out.after && out.before !== out.after);
  out.ok = true;
  return out;
}

// ---------- Streaming update: parse git output line by line for real progress ----------
// git prints no progress off a TTY; --progress emits lines like
// "Receiving objects: 42% (…)", which we use to compute a real percentage.
function runGitStreaming(args, onLine) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('git', args, { cwd: PROJECT_DIR, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', err: String(e.message || e) });
      return;
    }
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 300000);
    const feed = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text; else stdout += text;
      // Progress lines redraw in place with \r, so split on both \r and \n
      for (const raw of text.split(/[\r\n]+/)) {
        const line = raw.trim();
        if (line && onLine) onLine(line);
      }
    };
    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));
    child.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ ok: false, stdout, stderr, err: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ ok: code === 0, code, stdout, stderr, err: code === 0 ? null : `git exited with ${code}` });
    });
  });
}

// Extract the percentage from a git progress line (e.g. "Receiving objects:  37% (…)")
function parseGitPercent(line) {
  const m = /(\d{1,3})%/.exec(line || '');
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

// Run the update as an NDJSON stream: one JSON event per line
// { stage, percent, line } … final line { done: true, result }
async function applyUpdateStreaming(res) {
  const out = { ok: false, changed: false, before: null, after: null, output: '', error: null, source: null };
  const startedAt = Date.now();
  let percent = 0;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (evt) => {
    if (res.writableEnded) return;
    try { res.write(JSON.stringify(evt) + '\n'); } catch (e) { /* client disconnected */ }
  };
  // Monotonic progress: git may repeat output, the bar must never go backwards
  const progress = (stage, nextPercent, line) => {
    percent = Math.max(percent, Math.min(100, Math.round(nextPercent)));
    emit({ stage, percent, line: line || '' });
  };
  const finish = () => { if (!res.writableEnded) res.end(); };

  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) {
    out.error = 'not-a-repo';
    emit({ done: true, result: out });
    finish();
    return;
  }

  progress('prepare', 5);
  const before = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.before = before.ok ? before.stdout.trim().slice(0, 7) : null;
  progress('prepare', 12, out.before ? `HEAD ${out.before}` : '');

  // Fetch stage: map git's percentage onto 12% - 82%
  const onLine = (line) => {
    const p = parseGitPercent(line);
    if (p !== null) progress('fetch', 12 + p * 0.7, line);
    else emit({ stage: 'fetch', percent, line });
  };

  progress('fetch', 18);
  // Try the Gitee / GitHub candidates in order; the first success wins
  const pulled = await pullFromUpdateSources(onLine);
  const pull = pulled.result;
  out.source = pulled.source;
  out.output = ((pull.stdout || '') + (pull.stderr || '')).trim().slice(0, 2000);
  if (!pull.ok) {
    out.error = pulled.error || 'pull-failed';
    emit({ stage: 'error', percent, line: (pull.stderr || pull.err || '').trim().slice(0, 500) });
    emit({ done: true, result: out });
    finish();
    return;
  }

  progress('checkout', 88);
  const after = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.after = after.ok ? after.stdout.trim().slice(0, 7) : null;
  out.changed = !!(out.before && out.after && out.before !== out.after);
  out.ok = true;
  progress('verify', 96, `${out.before || '?'} -> ${out.after || '?'}`);
  progress('done', 100, `${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  emit({ done: true, result: out });
  finish();
}

// Stream the download/build of an OpenOS release as NDJSON (percentage + result)
async function streamOpenOSBuild(res, version, force = false) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const emit = (evt) => {
    if (res.writableEnded) return;
    try { res.write(JSON.stringify(evt) + '\n'); } catch (e) { /* client disconnected */ }
  };

  emit({ stage: 'prepare', percent: 0, line: String(version || '') });
  try {
    const result = await openosVersions.build(version, {
      diskIO,
      force,
      onProgress: (done, total) => emit({
        stage: 'download',
        percent: Math.round((done / total) * 100),
        line: `${done}/${total}`,
      }),
    });
    emit({ done: true, result });
  } catch (e) {
    emit({ done: true, result: { ok: false, error: e.message } });
  }
  if (!res.writableEnded) res.end();
}

// Stream the download of a prebuilt disk image as NDJSON (percentage + result)
async function streamDiskInstall(res, entry) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const emit = (evt) => {
    if (res.writableEnded) return;
    try { res.write(JSON.stringify(evt) + '\n'); } catch (e) { /* client disconnected */ }
  };

  emit({ stage: 'prepare', percent: 0, line: String((entry && entry.file) || '') });
  try {
    // Only the file name comes from the client; size and sha256 are taken from
    // index.json so a tampered request cannot skip the integrity check.
    const catalog = await diskCatalog.list();
    const wanted = String((entry && entry.file) || '');
    const found = (catalog.disks || []).find((d) => d.file === wanted);
    if (!found) throw new Error(`磁盘不在仓库清单中: ${wanted}`);
    const result = await diskCatalog.install(found, {
      force: Boolean(entry && entry.force),
      onProgress: (received, total) => emit({
        stage: 'download',
        percent: total > 0 ? Math.round((received / total) * 100) : 0,
        line: total > 0 ? '' : `${Math.round(received / 1024)} KB`,
      }),
    });
    emit({ done: true, result });
  } catch (e) {
    emit({ done: true, result: { ok: false, error: e.message } });
  }
  if (!res.writableEnded) res.end();
}

// List recent versions for the "rollback" picker in settings
async function listVersions() {
  const out = { ok: false, error: null, current: null, versions: [] };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }
  const head = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.current = head.ok ? head.stdout.trim().slice(0, 7) : null;
  out.versions = await gitLogLines(['log', '--pretty=%H%x1f%h%x1f%s%x1f%ad', '--date=short', '-n', '15', 'HEAD']);
  out.ok = true;
  return out;
}

// Roll back to a commit (git reset --hard); switch only, the UI decides whether to restart
async function rollbackTo(ref) {
  const out = { ok: false, changed: false, before: null, after: null, output: '', error: null };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }
  if (!ref || typeof ref !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(ref)) { out.error = 'bad-ref'; return out; }

  const verify = await gitRun(['rev-parse', '--verify', `${ref}^{commit}`], 15000);
  if (!verify.ok) { out.error = 'bad-ref'; return out; }

  const before = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.before = before.ok ? before.stdout.trim().slice(0, 7) : null;

  const reset = await gitRun(['reset', '--hard', ref], 30000);
  out.output = ((reset.stdout || '') + (reset.stderr || '')).trim().slice(0, 1000);
  if (!reset.ok) { out.error = 'reset-failed'; return out; }

  const after = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.after = after.ok ? after.stdout.trim().slice(0, 7) : null;
  out.changed = !!(out.before && out.after && out.before !== out.after);
  out.ok = true;
  return out;
}

// ---------- Console window show / hide ----------
// Each platform has its own mechanism; if unavailable we skip safely and report why,
// and never hide an unrelated window.
//   Windows : PowerShell calling Win32 ShowWindow
//   macOS   : osascript toggling the terminal app hosting the server
//   Linux   : X11 only, requires xdotool (Wayland has no generic solution)
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 8000 },
      (err, stdout) => resolve({ ok: !err, out: (stdout || '').trim(), err: err ? err.message : null }));
  });
}

function setConsoleVisible(visible) {
  if (process.platform === 'win32') return setConsoleVisibleWindows(visible);
  if (process.platform === 'darwin') return setConsoleVisibleMac(visible);
  return setConsoleVisibleLinux(visible);
}

// Walk up the parent chain to find the terminal app hosting this process (macOS)
async function detectTerminalApp() {
  const KNOWN = ['Terminal', 'iTerm2', 'iTerm', 'WezTerm', 'Alacritty', 'kitty', 'Hyper', 'Warp', 'Ghostty'];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    const r = await runCmd('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
    const line = r.out.split('\n')[0].trim();
    if (!line) break;
    const sp = line.indexOf(' ');
    if (sp < 0) break;
    const ppid = parseInt(line.slice(0, sp), 10);
    const comm = line.slice(sp + 1).trim();
    // For /Applications/XXX.app/Contents/MacOS/XXX take the XXX.app name
    const appMatch = comm.match(/\/([^/]+)\.app\//);
    const candidate = appMatch ? appMatch[1] : path.basename(comm);
    const hit = KNOWN.find(k => k.toLowerCase() === candidate.toLowerCase());
    if (hit) return hit;
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
  return null;
}

async function setConsoleVisibleMac(visible) {
  const app = await detectTerminalApp();
  if (!app) return { ok: false, supported: true, reason: 'cannot-detect-terminal' };
  // Toggle the whole terminal app via System Events; the first run may need Accessibility permission.
  const script = visible
    ? `tell application "System Events" to set visible of process "${app}" to true\ntell application "${app}" to activate`
    : `tell application "System Events" to set visible of process "${app}" to false`;
  const r = await runCmd('osascript', ['-e', script]);
  if (!r.ok) return { ok: false, supported: true, reason: 'osascript-failed', detail: r.err, app };
  return { ok: true, supported: true, app };
}

async function setConsoleVisibleLinux(visible) {
  if (process.env.WAYLAND_DISPLAY) return { ok: false, supported: false, reason: 'wayland' };
  const has = await runCmd('sh', ['-c', 'command -v xdotool >/dev/null 2>&1 && echo 1 || echo 0']);
  if (!has.ok || has.out.indexOf('1') < 0) return { ok: false, supported: false, reason: 'missing-xdotool' };

  // Find the X11 window owned by one of this process's ancestors
  let winId = null;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    const r = await runCmd('xdotool', ['search', '--pid', String(pid)]);
    const first = r.out.split('\n').map(s => s.trim()).filter(Boolean)[0];
    if (first) { winId = first; break; }
    const p = await runCmd('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const v = parseInt(p.out.trim(), 10);
    if (!v || v === pid) break;
    pid = v;
  }
  if (!winId) return { ok: false, supported: true, reason: 'cannot-detect-window' };

  const r = await runCmd('xdotool', [visible ? 'windowmap' : 'windowunmap', winId]);
  if (!r.ok) return { ok: false, supported: true, reason: 'xdotool-failed', detail: r.err };
  return { ok: true, supported: true, window: winId };
}

function setConsoleVisibleWindows(visible) {
  const psExe = process.env.WINDIR
    ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const swCmd = visible ? 5 : 0;   // SW_SHOW = 5, SW_HIDE = 0
  const script = [
    "Add-Type -Namespace OCC -Name Win -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'",
    '$h = [OCC.Win]::GetConsoleWindow()',
    `if ($h -ne [IntPtr]::Zero) { [OCC.Win]::ShowWindow($h, ${swCmd}) | Out-Null; Write-Output "ok" } else { Write-Output "noconsole" }`,
  ].join('; ');

  return new Promise((resolve) => {
    // Do NOT pass windowsHide: true here. It spawns the child with CREATE_NO_WINDOW,
    // so PowerShell gets no console handle (GetConsoleWindow() returns 0).
    // Without it the child inherits the server's console and opens no extra window.
    execFile(psExe, ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 10000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, supported: true, reason: 'powershell-failed', detail: err.message });
        const raw = (stdout || '').trim();
        const ok = raw.indexOf('ok') >= 0;
        resolve({ ok, supported: true, reason: ok ? undefined : 'no-console-window', raw });
      });
  });
}

let settings = loadSettings();
// Apply the sysinfo polling switch
sysInfo.setEnabled(settings.sysInfoPolling === true);

// ---------- Process-level safety net: a single error must not take down the server ----------
// The run.bat watchdog force-kills the server when its health check times out, so log and stay alive.
process.on('uncaughtException', (e) => {
  console.error('[server] uncaughtException (ignored):', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[server] unhandledRejection (ignored):', e && e.stack ? e.stack : e);
});

function saveSettings(newSettings) {
  const prev = settings;
  settings = { ...settings, ...newSettings };
  const settingsPath = path.join(PROJECT_DIR, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  // Sysinfo polling switch
  if (prev.sysInfoPolling !== settings.sysInfoPolling) {
    sysInfo.setEnabled(settings.sysInfoPolling === true);
  }
  // Propagate luaExe to the modules that spawn Lua
  if (newSettings.luaExe) {
    diskIO.luaExe = newSettings.luaExe;
    luaCheck.luaExe = newSettings.luaExe;
    luaCheck.invalidate();
    vmManager.luaExe = newSettings.luaExe;
  }
}

// ---------- Module instances ----------
const logger = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

const modemHub = new ModemHub();
const internetProxy = new InternetProxy({ timeout: 60000 });
const diskIO = new DiskIO({ projectDir: PROJECT_DIR, luaExe: settings.luaExe });
const luaCheck = new LuaCheck({ projectDir: PROJECT_DIR, luaExe: settings.luaExe });
// Device bus: expose non-computer devices (reactors etc.) as components to every VM
const deviceBus = new DeviceBus({ logger });
const vmManager = new VMManager({
  projectDir: PROJECT_DIR,
  luaExe: settings.luaExe,
  emuScript: EMU_SCRIPT,
  modemHub,
  internetProxy,
  diskIO,
  deviceBus,
  logger,
  logLevel: settings.logLevel,
});

// Mods device manager: shares modemHub / diskIO with VMs but uses its own Mods/ dir
const modsManager = new ModsManager({
  projectDir: PROJECT_DIR,
  modsDir: MODS_DIR,
  luaExe: settings.luaExe,
  emuScript: EMU_SCRIPT,
  modemHub,
  internetProxy,
  diskIO,
  deviceBus,
  logger,
  logLevel: settings.logLevel,
});
deviceBus.attach(vmManager);
deviceBus.attach(modsManager);

// ---------- Static file serving ----------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.hex': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let filePath = path.join(WEB_DIR, req.pathname === '/' ? 'index.html' : req.pathname);
  // Prevent path traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath);
  const stat = fs.statSync(filePath);
  // Always revalidate static assets (no-cache) instead of hard caching.
  // The panel's JS/CSS change often while ?v=N in index.html must be bumped by hand,
  // so a stale cache looks like "my change did nothing". With ETag/Last-Modified
  // browsers still get cheap 304 responses.
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache, must-revalidate',
    'ETag': etag,
    'Last-Modified': lastModified,
  };
  const inm = req.headers && req.headers['if-none-match'];
  const ims = req.headers && req.headers['if-modified-since'];
  if ((inm && inm === etag) || (!inm && ims && ims === lastModified)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// List a host directory (used to pick the Lua interpreter in settings).
// Directory listing only, never file contents; an empty path yields the default start dir.
function listHostDirectory(rawPath) {
  const isWin = process.platform === 'win32';
  const limit = 3000;
  let target = String(rawPath || '').trim();

  if (!target) {
    if (isWin) {
      const entries = [];
      for (let code = 65; code <= 90; code++) {
        const drive = String.fromCharCode(code) + ':\\';
        try {
          if (fs.existsSync(drive)) {
            entries.push({ name: drive.slice(0, 2), path: drive, isDir: true, isExec: false });
          }
        } catch (e) { /* skip inaccessible drives */ }
      }
      return { ok: true, path: '', parent: null, entries };
    }
    // Termux keeps Lua in $PREFIX/bin, desktop Linux usually in /usr/bin
    const candidates = [
      process.env.PREFIX && path.join(process.env.PREFIX, 'bin'),
      '/usr/local/bin',
      '/usr/bin',
    ].filter(Boolean);
    target = candidates.find((dir) => {
      try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
    }) || '/';
  }

  let abs = path.resolve(target);
  try {
    if (!fs.statSync(abs).isDirectory()) abs = path.dirname(abs);
  } catch (e) {
    return { ok: false, path: abs, parent: null, entries: [], error: e.code === 'EACCES' ? 'permission' : 'not-found' };
  }

  let dirents = [];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    const up = path.dirname(abs);
    return {
      ok: false,
      path: abs,
      parent: up === abs ? null : up,
      entries: [],
      error: e.code === 'EACCES' ? 'permission' : 'not-found',
    };
  }

  const entries = [];
  for (const dirent of dirents) {
    if (entries.length >= limit) break;
    const full = path.join(abs, dirent.name);
    let isDir = dirent.isDirectory();
    let isExec = false;
    try {
      const st = fs.statSync(full); // follow symlinks
      isDir = st.isDirectory();
      if (!isDir) {
        if (isWin) {
          isExec = /\.(exe|cmd|bat|com)$/i.test(dirent.name);
        } else {
          try {
            fs.accessSync(full, fs.constants.X_OK);
            isExec = true;
          } catch (e) { /* not executable */ }
        }
      }
    } catch (e) {
      continue; // broken link or no permission
    }
    entries.push({ name: dirent.name, path: full, isDir, isExec });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));

  const parent = path.dirname(abs);
  return { ok: true, path: abs, parent: parent === abs ? null : parent, entries };
}

// ---------- REST API ----------
async function handleApi(req, res, body) {
  const parts = req.pathname.split('/').filter(Boolean); // ['api', 'vms', ...]
  const method = req.method;

  try {
    // /api/version
    if (parts[1] === 'version') {
      const channel = await versionChannel();
      return json(res, {
        version: APP_VERSION,
        channel,
        display: formatVersion(APP_VERSION, channel),
        name: 'OC Emulator',
      });
    }

    // /api/openos/versions and /api/openos/build: download another OpenOS release
    // and assemble it into disks/openos-<version>.ocd (never bundled with the project)
    if (parts[1] === 'openos') {
      if (parts[2] === 'versions' && method === 'GET') {
        return json(res, { versions: openosVersions.listVersions() });
      }
      // Prebuilt disks published in the separate OC-Emulator-Disks repository
      if (parts[2] === 'catalog' && method === 'GET') {
        return json(res, {
          catalog: await diskCatalog.list(),
          build: openosVersions.listVersions(),
        });
      }
      if (parts[2] === 'install' && method === 'POST') {
        const payload = JSON.parse(body || '{}');
        return streamDiskInstall(res, payload);
      }
      if (parts[2] === 'build' && method === 'POST') {
        const payload = JSON.parse(body || '{}');
        return streamOpenOSBuild(res, payload.version, payload.force === true);
      }
    }

    // /api/fs/list: list host directories (for picking the Lua interpreter in settings)
    if (parts[1] === 'fs' && parts[2] === 'list' && method === 'GET') {
      return json(res, listHostDirectory((req.query && req.query.path) || ''));
    }

    // /api/server/restart and /api/server/stop: service-level buttons in the UI
    if (parts[1] === 'server' && method === 'POST') {
      if (parts[2] === 'restart') {
        logger.log('[server] 前端请求重启服务');
        json(res, { ok: true, action: 'restart' });
        setTimeout(() => shutDownForGuardian(EXIT_RESTART), 200);
        return;
      }
      if (parts[2] === 'stop') {
        logger.log('[server] 前端请求停止服务');
        json(res, { ok: true, action: 'stop' });
        setTimeout(() => shutDownForGuardian(EXIT_STOP), 200);
        return;
      }
    }

    // /api/update/*: UI "check update" and "rollback"
    if (parts[1] === 'update') {
      if (parts[2] === 'check') {
        return json(res, await checkForUpdate());
      }
      if (parts[2] === 'apply' && method === 'POST') {
        logger.log('[server] 前端请求拉取更新');
        // Stream NDJSON progress when the client sends Accept: application/x-ndjson;
        // otherwise return a single JSON body.
        const wantsStream = String(req.headers.accept || '').indexOf('application/x-ndjson') >= 0
          || (req.query && req.query.stream === '1');
        if (wantsStream) return applyUpdateStreaming(res);
        return json(res, await applyUpdate());
      }
      if (parts[2] === 'versions') {
        return json(res, await listVersions());
      }
      if (parts[2] === 'rollback' && method === 'POST') {
        let ref = '';
        try { ref = (JSON.parse(body || '{}') || {}).ref || ''; } catch (e) { /* ignore malformed body */ }
        logger.log('[server] 前端请求回退版本: ' + ref);
        return json(res, await rollbackTo(ref));
      }
    }

    // /api/sysinfo/battery: battery probe diagnostics (which files / commands were readable)
    if (parts[1] === 'sysinfo' && parts[2] === 'battery' && method === 'GET') {
      return json(res, await sysInfo.getBatteryDiagnostics());
    }

    // /api/lua/check
    if (parts[1] === 'lua' && parts[2] === 'check') {
      if (method === 'POST') {
        luaCheck.invalidate();
      }
      const result = await luaCheck.ensure();
      return json(res, result);
    }

    // /api/settings
    if (parts[1] === 'settings') {
      if (method === 'GET') {
        return json(res, {
          luaExe: settings.luaExe,
          port: settings.port,
          host: settings.host,
          logLevel: settings.logLevel || 'full',
          showConsole: settings.showConsole !== false,
          autoUpdate: settings.autoUpdate !== false,
          updateSource: settings.updateSource === 'gitee' || settings.updateSource === 'github' ? settings.updateSource : 'auto',
          updateChannel: settings.updateChannel === 'beta' ? 'beta' : 'release',
          skipIntegrityCheck: settings.skipIntegrityCheck === true,
        });
      }
      if (method === 'PUT') {
        const patch = JSON.parse(body || '{}');
        // Only known values reach settings.json
        if (patch.updateSource !== undefined) {
          patch.updateSource = ['auto', 'gitee', 'github'].includes(patch.updateSource) ? patch.updateSource : 'auto';
        }
        if (patch.updateChannel !== undefined) {
          patch.updateChannel = patch.updateChannel === 'beta' ? 'beta' : 'release';
        }
        saveSettings(patch);
        // Apply the new logLevel to vmManager (affects VMs started later)
        if (patch.logLevel) {
          vmManager.logLevel = patch.logLevel;
          modsManager.logLevel = patch.logLevel;
        }
        // Console visibility toggle: applies immediately
        let consoleResult = null;
        if (patch.showConsole !== undefined) {
          consoleResult = await setConsoleVisible(settings.showConsole !== false);
        }
        return json(res, {
          ok: true,
          luaExe: settings.luaExe,
          logLevel: settings.logLevel,
          showConsole: settings.showConsole !== false,
          autoUpdate: settings.autoUpdate !== false,
          updateSource: settings.updateSource === 'gitee' || settings.updateSource === 'github' ? settings.updateSource : 'auto',
          updateChannel: settings.updateChannel === 'beta' ? 'beta' : 'release',
          skipIntegrityCheck: settings.skipIntegrityCheck === true,
          consoleResult,
        });
      }
    }

    // /api/mods - Mods devices (robots / drones)
    if (parts[1] === 'mods') {
      const validModName = (n) => typeof n === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(n);

      if (parts.length === 2) {
        if (method === 'GET') return json(res, modsManager.listMods());
        if (method === 'POST') {
          const spec = JSON.parse(body || '{}');
          return json(res, modsManager.create(spec));
        }
        return json(res, { error: 'Method not allowed' }, 405);
      }

      // /api/mods/import and /api/mods/download are fixed routes and must be handled
      // before modName parsing ("import" / "download" are not valid device names, but catch them early)
      if (parts.length === 3 && parts[2] === 'import' && method === 'POST') {
        try {
          const payload = JSON.parse(body || '{}');
          if (typeof payload.data !== 'string' || !payload.data) {
            return json(res, { error: '缺少 zip 数据' }, 400);
          }
          if (payload.data.length > modTransfer.MAX_DOWNLOAD_BYTES * 2) {
            return json(res, { error: '文件过大 (上限 64MB)' }, 413);
          }
          const zipBuf = Buffer.from(payload.data, 'base64');
          const name = modTransfer.importModFromZip(zipBuf, modsManager, payload.name);
          return json(res, { ok: true, name });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }
      if (parts.length === 3 && parts[2] === 'download' && method === 'POST') {
        try {
          const payload = JSON.parse(body || '{}');
          const dlUrl = await modTransfer.resolveDownloadUrl(payload.url);
          const zipBuf = await modTransfer.fetchToBuffer(dlUrl, 5);
          const name = modTransfer.importModFromZip(zipBuf, modsManager, payload.name);
          return json(res, { ok: true, name });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      const modName = decodeURIComponent(parts[2] || '');
      if (!validModName(modName)) return json(res, { error: 'Invalid mod name' }, 400);

      if (parts.length === 3) {
        if (method === 'GET') {
          const mod = modsManager.getMod(modName);
          if (!mod) return json(res, { error: 'Mod not found' }, 404);
          return json(res, mod);
        }
        if (method === 'DELETE') {
          if (!fs.existsSync(modsManager.modDir(modName))) {
            return json(res, { error: 'Mod not found' }, 404);
          }
          modsManager.delete(modName);
          return json(res, { ok: true });
        }
        return json(res, { error: 'Method not allowed' }, 405);
      }

      if (parts.length === 4) {
        const action = parts[3];

        // Export as a zip download; a running device writes its disk from a child process, so stop it first
        if (action === 'export' && method === 'GET') {
          const dir = modsManager.modDir(modName);
          if (!fs.existsSync(dir)) return json(res, { error: 'Mod not found' }, 404);
          const mod = modsManager.getMod(modName);
          if (mod && (mod.state === 'running' || mod.state === 'paused' || mod.state === 'starting')) {
            return json(res, { error: '设备正在运行, 请先停止再导出' }, 409);
          }
          try {
            const zipBuf = modTransfer.buildModZip(dir);
            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Length': zipBuf.length,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(modName)}.zip"`,
            });
            res.end(zipBuf);
          } catch (e) {
            return json(res, { error: e.message }, 500);
          }
          return;
        }

        if (action === 'start' && method === 'POST') {
          return json(res, modsManager.start(modName));
        }
        if (action === 'stop' && method === 'POST') {
          try { modsManager.stop(modName); } catch (e) { /* already stopped */ }
          return json(res, { ok: true });
        }
        if (action === 'restart' && method === 'POST') {
          try { modsManager.restart(modName); } catch (e) { /* ignore */ }
          return json(res, { ok: true });
        }
        if (action === 'pause' && method === 'POST') {
          try { modsManager.pause(modName); } catch (e) { /* ignore */ }
          return json(res, { ok: true });
        }
        if (action === 'resume' && method === 'POST') {
          try { modsManager.resume(modName); } catch (e) { /* ignore */ }
          return json(res, { ok: true });
        }
        if (action === 'state' && method === 'GET') {
          const mod = modsManager.getMod(modName);
          if (!mod) return json(res, { error: 'Mod not found' }, 404);
          return json(res, mod);
        }
        if (action === 'command' && method === 'POST') {
          const command = JSON.parse(body || '{}');
          modsManager.sendModCommand(modName, command);
          return json(res, { ok: true });
        }

        if (action === 'efi') {
          try {
            if (method === 'GET') return json(res, modsManager.getEfi(modName));
            if (method === 'PUT') {
              const payload = JSON.parse(body || '{}');
              return json(res, modsManager.saveEfi(modName, payload.content));
            }
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'config') {
          try {
            if (method === 'GET') {
              const cfg = modsManager.getConfig(modName);
              if (!cfg) return json(res, { error: 'Mod not found' }, 404);
              return json(res, cfg);
            }
            if (method === 'PUT') {
              const patch = JSON.parse(body || '{}');
              return json(res, modsManager.updateHardware(modName, patch));
            }
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'reactor') {
          try {
            if (method === 'GET') return json(res, modsManager.getReactor(modName));
            if (method === 'PUT') {
              const patch = JSON.parse(body || '{}');
              return json(res, modsManager.saveReactor(modName, patch));
            }
            // POST = reset the core (replace coolant cells, clear core heat)
            if (method === 'POST') return json(res, modsManager.resetReactor(modName));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'reactor-active' && method === 'POST') {
          try {
            const payload = JSON.parse(body || '{}');
            return json(res, modsManager.setReactorActive(modName, !!payload.active));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
        }

        if (action === 'reactor-options' && method === 'POST') {
          try {
            const payload = JSON.parse(body || '{}');
            return json(res, modsManager.setReactorOptions(modName, payload));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
        }

        // Fuel / waste tanks: virtual inventory reachable through the transposer
        if (action === 'reactor-inventory') {
          try {
            if (method === 'GET') return json(res, modsManager.getReactorInventory(modName));
            if (method === 'POST') {
              const payload = JSON.parse(body || '{}');
              return json(res, modsManager.setReactorInventory(modName, payload));
            }
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'reactor-temperature') {
          try {
            if (method === 'GET') {
              const reactor = modsManager.getReactor(modName);
              return json(res, {
                temperature: reactor.runtime ? reactor.runtime.temperature : 0,
                maxTemperature: reactor.runtime ? reactor.runtime.maxTemperature : 0,
                overheated: !!(reactor.runtime && reactor.runtime.overheated),
                running: !!(reactor.runtime && reactor.runtime.running),
              });
            }
            if (method === 'POST') {
              const payload = JSON.parse(body || '{}');
              return json(res, modsManager.setReactorTemperature(modName, payload.temperature));
            }
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'machine') {
          try {
            if (method === 'GET') return json(res, modsManager.getMachine(modName));
            if (method === 'PUT') {
              const payload = JSON.parse(body || '{}');
              return json(res, modsManager.saveMachineScript(modName, payload.script));
            }
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return json(res, { error: 'Method not allowed' }, 405);
        }

        if (action === 'machine-state' && method === 'POST') {
          try {
            const payload = JSON.parse(body || '{}');
            return json(res, modsManager.setMachineState(
              modName,
              Number(payload.component) || 0,
              payload.key,
              payload.value
            ));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
        }

        if (action === 'machine-action' && method === 'POST') {
          try {
            const payload = JSON.parse(body || '{}');
            return json(res, modsManager.runMachineAction(
              modName,
              Number(payload.component) || 0,
              payload.action,
              payload.args
            ));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
        }

        if (action === 'connect' && method === 'POST') {
          try {
            const payload = JSON.parse(body || '{}');
            return json(res, modsManager.connectDevice(modName, payload.vm || null));
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
        }
      }
    }

    // /api/vms
    if (parts[1] === 'vms') {
      if (parts.length === 2) {
        if (method === 'GET') return json(res, vmManager.list());
        if (method === 'POST') {
          const spec = JSON.parse(body || '{}');
          // A taken name is not an error: the disks below are written under the VM
          // directory, so the final name has to be known before any file is created.
          spec.name = vmManager.uniqueName(spec.name);
          // disk1/disk2 set to "new": create a fresh disk image
          if (spec.hardware && spec.hardware.disk1 === 'new') {
            const diskName = 'disk1.ocd';
            const diskPath = path.join(VMS_DIR, spec.name, diskName);
            const tier = spec.hardware.disk1Tier || 3;
            // T1 / T2 have a fixed capacity; only T3 is configurable.
            const size = tier === 1 ? 1048576 : tier === 2 ? 2097152
              : (spec.hardware.disk1Size || 4194304);
            const label = spec.hardware.disk1Label || `${spec.name}-disk1`;
            // Create the VM directory first
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });

            // Create the disk from imported files when present, otherwise an empty disk
            if (spec.hardware.disk1ImportFiles && spec.hardware.disk1ImportFiles.length > 0) {
              const files = {};
              const dirSet = new Set(['/']);
              for (const f of spec.hardware.disk1ImportFiles) {
                const p = f.path.startsWith('/') ? f.path : '/' + f.path;
                files[p] = { type: 'file', content: Buffer.from(f.content, 'base64').toString('utf8'), modified: Date.now() / 1000 };
                const parts2 = p.split('/').filter(Boolean);
                let dir = '';
                for (let j = 0; j < parts2.length - 1; j++) { dir += '/' + parts2[j]; dirSet.add(dir); }
              }
              for (const dir of dirSet) { if (!files[dir]) files[dir] = { type: 'directory', modified: Date.now() / 1000 }; }
              diskIO.save(diskPath, { label, files, size, tier, locked: false });
              // Drop it so it is not persisted to config
              delete spec.hardware.disk1ImportFiles;
            } else {
              diskIO.create({ path: diskPath, label, size, tier });
            }
            // Mirror mode: create the mirror folder and write the initial files
            if (spec.hardware.disk1Mirror) {
              const mirrorPath = path.isAbsolute(spec.hardware.disk1Mirror)
                ? spec.hardware.disk1Mirror
                : path.join(PROJECT_DIR, spec.hardware.disk1Mirror);
              fs.mkdirSync(mirrorPath, { recursive: true });
              if (spec.hardware.disk1MirrorFiles) {
                for (const f of spec.hardware.disk1MirrorFiles) {
                  const p = f.path.startsWith('/') ? f.path : '/' + f.path;
                  const fullPath = path.join(mirrorPath, p);
                  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                  fs.writeFileSync(fullPath, Buffer.from(f.content, 'base64'), 'utf8');
                }
                delete spec.hardware.disk1MirrorFiles;
              }
            }
            spec.hardware.disk1 = diskName;
          }
          if (spec.hardware && spec.hardware.disk2 === 'new') {
            const diskName = 'disk2.ocd';
            const diskPath = path.join(VMS_DIR, spec.name, diskName);
            const tier = spec.hardware.disk2Tier || 3;
            // T1 / T2 have a fixed capacity; only T3 is configurable.
            const size = tier === 1 ? 1048576 : tier === 2 ? 2097152
              : (spec.hardware.disk2Size || 4194304);
            const label = spec.hardware.disk2Label || `${spec.name}-disk2`;

            if (spec.hardware.disk2ImportFiles && spec.hardware.disk2ImportFiles.length > 0) {
              const files = {};
              const dirSet = new Set(['/']);
              for (const f of spec.hardware.disk2ImportFiles) {
                const p = f.path.startsWith('/') ? f.path : '/' + f.path;
                files[p] = { type: 'file', content: Buffer.from(f.content, 'base64').toString('utf8'), modified: Date.now() / 1000 };
                const parts2 = p.split('/').filter(Boolean);
                let dir = '';
                for (let j = 0; j < parts2.length - 1; j++) { dir += '/' + parts2[j]; dirSet.add(dir); }
              }
              for (const dir of dirSet) { if (!files[dir]) files[dir] = { type: 'directory', modified: Date.now() / 1000 }; }
              diskIO.save(diskPath, { label, files, size, tier, locked: false });
              delete spec.hardware.disk2ImportFiles;
            } else {
              diskIO.create({ path: diskPath, label, size, tier });
            }
            // Mirror mode: create the mirror folder and write the initial files
            if (spec.hardware.disk2Mirror) {
              const mirrorPath = path.isAbsolute(spec.hardware.disk2Mirror)
                ? spec.hardware.disk2Mirror
                : path.join(PROJECT_DIR, spec.hardware.disk2Mirror);
              fs.mkdirSync(mirrorPath, { recursive: true });
              if (spec.hardware.disk2MirrorFiles) {
                for (const f of spec.hardware.disk2MirrorFiles) {
                  const p = f.path.startsWith('/') ? f.path : '/' + f.path;
                  const fullPath = path.join(mirrorPath, p);
                  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                  fs.writeFileSync(fullPath, Buffer.from(f.content, 'base64'), 'utf8');
                }
                delete spec.hardware.disk2MirrorFiles;
              }
            }
            spec.hardware.disk2 = diskName;
          }
          // Disk template selected ('openos' or 'disk_template:xxx.ocd'): copy it
          if (spec.hardware && (spec.hardware.disk1 === 'openos' || (spec.hardware.disk1 || '').startsWith('disk_template:'))) {
            const tplFile = spec.hardware.disk1.startsWith('disk_template:')
              ? spec.hardware.disk1.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, spec.name, 'disk1.ocd');
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });
            if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, diskPath);
            applyTemplateEfi(spec.name, tplFile, spec.hardware);
            spec.hardware.disk1 = 'disk1.ocd';
          }
          if (spec.hardware && (spec.hardware.disk2 === 'openos' || (spec.hardware.disk2 || '').startsWith('disk_template:'))) {
            const tplFile = spec.hardware.disk2.startsWith('disk_template:')
              ? spec.hardware.disk2.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, spec.name, 'disk2.ocd');
            if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, diskPath);
            applyTemplateEfi(spec.name, tplFile, spec.hardware);
            spec.hardware.disk2 = 'disk2.ocd';
          }
          // Floppy selected: write the template contents or create an empty .ocf floppy
          if (spec.hardware && spec.hardware.floppy) {
            let tplName = spec.hardware.floppy;
            // Map legacy aliases
            if (floppyAliases[tplName]) tplName = floppyAliases[tplName];
            const floppyPath = path.join(VMS_DIR, spec.name, 'floppy.ocf');
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });
            if (tplName === 'empty') {
              // Empty floppy: use the size chosen by the user
              const size = spec.hardware.floppySize || 524288;
              const files = {
                '/': { type: 'directory', modified: Date.now() / 1000 },
              };
              diskIO.saveFloppy(floppyPath, { label: 'Floppy', files, size, locked: false });
              spec.hardware.floppy = 'floppy.ocf';
              delete spec.hardware.floppySize;
            } else if (floppyTemplates[tplName]) {
              const tpl = floppyTemplates[tplName];
              // Convert the template files to the expected format
              const files = {};
              for (const [fpath, content] of Object.entries(tpl.files)) {
                files[fpath] = { type: 'file', content: content, modified: Date.now() / 1000 };
              }
              // Add directory entries
              files['/'] = { type: 'directory', modified: Date.now() / 1000 };
              for (const fpath of Object.keys(tpl.files)) {
                const parts = fpath.split('/').filter(Boolean);
                let p = '';
                for (let i = 0; i < parts.length - 1; i++) {
                  p += '/' + parts[i];
                  if (!files[p]) files[p] = { type: 'directory', modified: Date.now() / 1000 };
                }
              }
              diskIO.saveFloppy(floppyPath, { label: tpl.label || tplName, files, size: 512 * 1024, locked: tpl.locked === true });
              spec.hardware.floppy = 'floppy.ocf';
            }
          }
          const config = vmManager.create(spec);
          return json(res, config);
        }
      }

      const vmName = parts[2];
      if (!vmName) return json(res, { error: 'VM name required' }, 400);

      if (parts.length === 3) {
        if (method === 'GET') {
          const cfg = vmManager.getConfig(vmName);
          if (!cfg) return json(res, { error: 'VM not found' }, 404);
          return json(res, cfg);
        }
        if (method === 'PUT') {
          const patch = JSON.parse(body || '{}');
          // disk1 as a disk template: copy it into the VM directory
          if (patch.hardware && (patch.hardware.disk1 === 'openos' || (patch.hardware.disk1 || '').startsWith('disk_template:'))) {
            const tplFile = patch.hardware.disk1.startsWith('disk_template:')
              ? patch.hardware.disk1.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, vmName, 'disk1.ocd');
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, diskPath);
              // Keep a custom EEPROM; adopt the disk's EFI when still on the built-in one
              const merged = {
                eeprom: patch.hardware.eeprom !== undefined
                  ? patch.hardware.eeprom
                  : (vmManager.getConfig(vmName) || { hardware: {} }).hardware.eeprom,
              };
              applyTemplateEfi(vmName, tplFile, merged);
              if (merged.eeprom) patch.hardware.eeprom = merged.eeprom;
              patch.hardware.disk1 = 'disk1.ocd';
            }
          }
          // disk2 as a disk template: copy it into the VM directory
          if (patch.hardware && (patch.hardware.disk2 === 'openos' || (patch.hardware.disk2 || '').startsWith('disk_template:'))) {
            const tplFile = patch.hardware.disk2.startsWith('disk_template:')
              ? patch.hardware.disk2.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, vmName, 'disk2.ocd');
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, diskPath);
              const merged = {
                eeprom: patch.hardware.eeprom !== undefined
                  ? patch.hardware.eeprom
                  : (vmManager.getConfig(vmName) || { hardware: {} }).hardware.eeprom,
              };
              applyTemplateEfi(vmName, tplFile, merged);
              if (merged.eeprom) patch.hardware.eeprom = merged.eeprom;
              patch.hardware.disk2 = 'disk2.ocd';
            }
          }
          // Floppy option: a template name or 'empty' requires creating floppy.ocf
          if (patch.hardware && patch.hardware.floppy) {
            let tplName = patch.hardware.floppy;
            // An existing floppy file name (e.g. floppy.ocf) is kept as is
            if (!tplName.endsWith('.ocf')) {
              if (floppyAliases[tplName]) tplName = floppyAliases[tplName];
              const floppyPath = path.join(VMS_DIR, vmName, 'floppy.ocf');
              fs.mkdirSync(path.join(VMS_DIR, vmName), { recursive: true });
              if (tplName === 'empty') {
                const size = patch.hardware.floppySize || 524288;
                const files = { '/': { type: 'directory', modified: Date.now() / 1000 } };
                try {
                  diskIO.saveFloppy(floppyPath, { label: 'Floppy', files, size, locked: false });
                  patch.hardware.floppy = 'floppy.ocf';
                } catch (e) {
                  return json(res, { error: 'Failed to create floppy: ' + e.message }, 500);
                }
                delete patch.hardware.floppySize;
              } else if (floppyTemplates[tplName]) {
                const tpl = floppyTemplates[tplName];
                const files = {};
                for (const [fpath, content] of Object.entries(tpl.files)) {
                  files[fpath] = { type: 'file', content: content, modified: Date.now() / 1000 };
                }
                files['/'] = { type: 'directory', modified: Date.now() / 1000 };
                for (const fpath of Object.keys(tpl.files)) {
                  const parts = fpath.split('/').filter(Boolean);
                  let p = '';
                  for (let i = 0; i < parts.length - 1; i++) {
                    p += '/' + parts[i];
                    if (!files[p]) files[p] = { type: 'directory', modified: Date.now() / 1000 };
                  }
                }
                try {
                  diskIO.saveFloppy(floppyPath, { label: tpl.label || tplName, files, size: 2048 * 1024, locked: tpl.locked === true });
                  patch.hardware.floppy = 'floppy.ocf';
                } catch (e) {
                  return json(res, { error: 'Failed to create floppy: ' + e.message }, 500);
                }
              }
            }
          }
          const updated = vmManager.updateConfig(vmName, patch);
          // Floppy changed on a running VM: trigger a hot reload
          if (patch.hardware && patch.hardware.floppy && vmManager.isRunning && vmManager.isRunning(vmName)) {
            const floppyFile = updated.hardware?.floppy;
            if (floppyFile) {
              const floppyPath = path.join(VMS_DIR, vmName, floppyFile);
              vmManager.sendCommand(vmName, 'floppy_reload', { path: floppyPath });
            }
          }
          return json(res, updated);
        }
        if (method === 'DELETE') {
          vmManager.delete(vmName);
          // Drop device wirings pointing at this VM so none dangle
          try { modsManager.clearVmConnections(vmName); } catch { /* ignore cleanup failure */ }
          return json(res, { ok: true });
        }
      }

      // /api/vms/:name/rename
      if (parts[3] === 'rename' && method === 'POST') {
        let newName = '';
        try { newName = String((JSON.parse(body || '{}') || {}).name || '').trim(); } catch (e) { /* ignore malformed body */ }
        try {
          const cfg = vmManager.rename(vmName, newName);
          try { modsManager.renameVmConnection(vmName, newName); } catch { /* wiring sync failure must not block the rename */ }
          return json(res, { ok: true, name: newName, config: cfg });
        } catch (e) {
          return json(res, { ok: false, error: e.message }, 400);
        }
      }
      // /api/vms/:name/start
      if (parts[3] === 'start' && method === 'POST') {
        const result = vmManager.start(vmName);
        return json(res, result);
      }
      // /api/vms/:name/stop
      if (parts[3] === 'stop' && method === 'POST') {
        vmManager.stop(vmName);
        return json(res, { ok: true });
      }
      // /api/vms/:name/pause
      if (parts[3] === 'pause' && method === 'POST') {
        vmManager.pause(vmName);
        return json(res, { ok: true });
      }
      // /api/vms/:name/resume
      if (parts[3] === 'resume' && method === 'POST') {
        vmManager.resume(vmName);
        return json(res, { ok: true });
      }
      // /api/vms/:name/restart
      if (parts[3] === 'restart' && method === 'POST') {
        const result = vmManager.restart(vmName);
        return json(res, result);
      }
      // /api/vms/:name/state
      if (parts[3] === 'state' && method === 'GET') {
        return json(res, vmManager.getState(vmName));
      }
      // /api/vms/:name/screen
      if (parts[3] === 'screen' && method === 'GET') {
        const state = vmManager.getState(vmName);
        return json(res, state.screen || { width: 0, height: 0, cells: [] });
      }
    }

    // /api/floppy/templates — list all floppy templates with metadata
    if (parts[1] === 'floppy' && parts[2] === 'templates' && method === 'GET') {
      const list = [];
      for (const [key, tpl] of Object.entries(floppyTemplates)) {
        list.push({
          key,
          label: tpl.label,
          locked: tpl.locked === true,
          disabled: tpl.disabled === true,
          disabledReason: tpl.disabledReason || null,
          fileCount: Object.keys(tpl.files).length,
        });
      }
      return json(res, list);
    }

    // /api/disks
    if (parts[1] === 'disks') {
      if (parts[2] === 'templates' && method === 'GET') {
        // Scan disks/ and return every .ocd disk template
        const templates = [];
        if (fs.existsSync(DISKS_DIR)) {
          for (const fname of fs.readdirSync(DISKS_DIR)) {
            if (!fname.endsWith('.ocd')) continue;
            const fullPath = path.join(DISKS_DIR, fname);
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            // Read the disk label (bytes 8-23, null-padded)
            let label = null;
            try {
              const buf = fs.readFileSync(fullPath);
              if (buf.length >= 24 && buf.subarray(0, 6).toString('ascii') === 'OCDISK') {
                label = buf.subarray(8, 24).toString('ascii').replace(/\0/g, '') || null;
              }
            } catch {}
            templates.push({
              name: label || fname.replace(/\.ocd$/i, ''),
              path: fname,
              size: stat.size,
              // Paired EEPROM boot program downloaded with the disk (if any)
              eeprom: templateEfiName(fname),
            });
          }
        }
        return json(res, templates);
      }
      if (parts[2] === 'create' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const diskPath = spec.path;
        const tier = Number(spec.tier) || 3;
        // T1 / T2 have a fixed capacity; only T3 is configurable.
        const size = tier === 1 ? 1048576 : tier === 2 ? 2097152 : (Number(spec.size) || 4194304);
        diskIO.create({
          path: diskPath,
          label: spec.label || 'Untitled',
          size,
          tier,
        });
        return json(res, { ok: true });
      }

      // /api/disks/create-from-folder — create .ocd disk from a host folder
      if (parts[2] === 'create-from-folder' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const folderPath = spec.folderPath;
        const diskPath = spec.diskPath;
        if (!folderPath || !diskPath) return json(res, { error: 'folderPath and diskPath required' }, 400);
        const absFolder = path.isAbsolute(folderPath) ? folderPath : path.join(PROJECT_DIR, folderPath);
        if (!fs.existsSync(absFolder)) return json(res, { error: 'folder not found' }, 404);
        try {
          diskIO.syncFolderToDisk(absFolder, diskPath, {
            label: spec.label || 'FolderDisk',
            size: spec.size || 4194304,
            tier: spec.tier || 3,
          });
          return json(res, { ok: true });
        } catch (e) {
          return json(res, { error: e.message }, 500);
        }
      }

      // /api/disks/sync-to-folder — sync .ocd disk to a host folder
      if (parts[2] === 'sync-to-folder' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const diskPath = spec.diskPath;
        const folderPath = spec.folderPath;
        if (!folderPath || !diskPath) return json(res, { error: 'diskPath and folderPath required' }, 400);
        const absFolder = path.isAbsolute(folderPath) ? folderPath : path.join(PROJECT_DIR, folderPath);
        try {
          diskIO.syncDiskToFolder(diskPath, absFolder);
          return json(res, { ok: true });
        } catch (e) {
          return json(res, { error: e.message }, 500);
        }
      }

      // /api/disks/sync-from-folder — sync host folder to .ocd disk
      if (parts[2] === 'sync-from-folder' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const diskPath = spec.diskPath;
        const folderPath = spec.folderPath;
        if (!folderPath || !diskPath) return json(res, { error: 'diskPath and folderPath required' }, 400);
        const absFolder = path.isAbsolute(folderPath) ? folderPath : path.join(PROJECT_DIR, folderPath);
        if (!fs.existsSync(absFolder)) return json(res, { error: 'folder not found' }, 404);
        try {
          diskIO.syncFolderToDisk(absFolder, diskPath, {
            label: spec.label,
            size: spec.size,
            tier: spec.tier,
          });
          return json(res, { ok: true });
        } catch (e) {
          return json(res, { error: e.message }, 500);
        }
      }

      // /api/disks/create-with-files — create disk from uploaded files
      if (parts[2] === 'create-with-files' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const diskPath = spec.path || spec.destPath;
        if (!diskPath) return json(res, { error: 'path required' }, 400);

        // Build files object for diskIO.save
        const files = {};
        const dirSet = new Set();
        dirSet.add('/');

        for (const f of (spec.files || [])) {
          const innerPath = f.path.startsWith('/') ? f.path : '/' + f.path;
          files[innerPath] = {
            type: 'file',
            content: Buffer.from(f.content, 'base64').toString('utf8'),
            modified: Date.now() / 1000,
          };
          // Register parent directories
          const parts2 = innerPath.split('/').filter(Boolean);
          let dir = '';
          for (let j = 0; j < parts2.length - 1; j++) {
            dir += '/' + parts2[j];
            dirSet.add(dir);
          }
        }
        for (const dir of dirSet) {
          if (!files[dir]) {
            files[dir] = { type: 'directory', modified: Date.now() / 1000 };
          }
        }

        try {
          diskIO.save(diskPath, {
            label: spec.label || 'Project',
            files,
            size: spec.size || 4194304,
            tier: spec.tier || 3,
            locked: false,
          });
          return json(res, { ok: true, path: diskPath, fileCount: Object.keys(files).length });
        } catch (e) {
          return json(res, { error: e.message }, 500);
        }
      }
      // /api/disks/:file/...
      const diskFile = decodeURIComponent(parts[2] || '');
      if (diskFile) {
        // diskFile may look like vms/xxx/disk1.ocd
        const diskPath = path.join(PROJECT_DIR, diskFile);

        // Mirror mode detection: derive the VM name and disk slot from the path,
        // e.g. vms/myvm/disk1.ocd -> vmName=myvm, slot=disk1.
        // Floppies work too: vms/myvm/floppy.ocf -> vmName=myvm, slot=floppy
        const pathMatch = diskFile.match(/^vms\/([^/]+)\/(disk[12]|floppy)\.(ocd|ocf)$/);
        let mirrorFolder = null;
        if (pathMatch) {
          const vmNameMatch = pathMatch[1];
          const slotMatch = pathMatch[2];
          const extMatch = pathMatch[3];
          // Mirror mode only applies to disks (disk1/disk2), not floppies
          if (extMatch === 'ocd' && (slotMatch === 'disk1' || slotMatch === 'disk2')) {
            const vmConfig = vmManager.getConfig(vmNameMatch);
            if (vmConfig && vmConfig.hardware && vmConfig.hardware[slotMatch + 'Mirror']) {
              const mPath = vmConfig.hardware[slotMatch + 'Mirror'];
              mirrorFolder = path.isAbsolute(mPath) ? mPath : path.join(PROJECT_DIR, mPath);
            }
          }
        }
        const vmRunning = pathMatch && vmManager.getState(pathMatch[1]) &&
          (vmManager.getState(pathMatch[1]).state === 'running' || vmManager.getState(pathMatch[1]).state === 'paused');

        if (parts[3] === 'unlock' && method === 'POST') {
          diskIO.unlock(diskPath);
          return json(res, { ok: true });
        }
        if (parts[3] === 'lock' && method === 'POST') {
          diskIO.lock(diskPath);
          return json(res, { ok: true });
        }
        if (parts[3] === 'info' && method === 'GET') {
          const info = diskIO.getInfo(diskPath);
          if (mirrorFolder) info.mirror = mirrorFolder;
          return json(res, info);
        }
        if (parts[3] === 'tree' && method === 'GET') {
          // Mirror mode with the VM stopped: read from the folder
          if (mirrorFolder && !vmRunning && fs.existsSync(mirrorFolder)) {
            const tree = diskIO.listFolderTree(mirrorFolder);
            return json(res, tree);
          }
          const tree = diskIO.listTree(diskPath);
          return json(res, tree);
        }
        if (parts[3] === 'read' && method === 'GET') {
          const innerPath = req.query.path || '/';
          // Mirror mode with the VM stopped: read from the folder
          if (mirrorFolder && !vmRunning && fs.existsSync(mirrorFolder)) {
            const result = diskIO.readFromFolder(mirrorFolder, innerPath);
            return json(res, { type: result.type, content: result.content, path: innerPath, ok: result.ok, error: result.error });
          }
          const fileData = diskIO.read(diskPath, innerPath);
          return json(res, { type: fileData.type, content: fileData.content, path: innerPath, ok: fileData.ok, error: fileData.error });
        }
        // Download an inner file as raw bytes so the UI can show progress
        if (parts[3] === 'download' && method === 'GET') {
          const innerPath = req.query.path;
          try {
            if (!innerPath) return json(res, { error: 'path required' }, 400);
            let result;
            if (mirrorFolder && !vmRunning && fs.existsSync(mirrorFolder)) {
              result = diskIO.readFromFolder(mirrorFolder, innerPath);
            } else {
              result = diskIO.read(diskPath, innerPath);
            }
            if (!result || result.ok === false) throw new Error((result && result.error) || 'cannot read file');
            if (result.type !== 'file') throw new Error('target is not a file');
            const buf = Buffer.from(result.content == null ? '' : result.content, 'utf8');
            const filename = path.basename(innerPath) || 'download';
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': buf.length,
              'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              'Cache-Control': 'no-store',
            });
            res.end(buf);
          } catch (e) {
            return json(res, { error: e.message }, 400);
          }
          return;
        }
        if (parts[3] === 'write' && method === 'PUT') {
          const innerPath = req.query.path;
          const data = JSON.parse(body || '{}');
          // Mirror mode with the VM stopped: write to the folder (synced to the disk on next start)
          if (mirrorFolder && !vmRunning) {
            diskIO.writeToFolder(mirrorFolder, innerPath, data.content || '');
            return json(res, { ok: true });
          }
          diskIO.write(diskPath, innerPath, data.content || '');
          return json(res, { ok: true });
        }
        if (parts[3] === 'remove' && method === 'DELETE') {
          const innerPath = req.query.path;
          if (mirrorFolder && !vmRunning) {
            diskIO.removeFromFolder(mirrorFolder, innerPath);
            return json(res, { ok: true });
          }
          diskIO.remove(diskPath, innerPath);
          return json(res, { ok: true });
        }
        if (parts[3] === 'mkdir' && method === 'POST') {
          const data = JSON.parse(body || '{}');
          const innerPath = req.query.path || data.path;
          if (!innerPath) return json(res, { error: 'path required' }, 400);
          if (mirrorFolder && !vmRunning) {
            diskIO.mkdirInFolder(mirrorFolder, innerPath);
            return json(res, { ok: true });
          }
          diskIO.mkdir(diskPath, innerPath);
          return json(res, { ok: true });
        }
        if (parts[3] === 'format' && method === 'POST') {
          diskIO.format(diskPath);
          return json(res, { ok: true });
        }
        // Mirror mode configuration
        if (parts[3] === 'mirror' && method === 'GET') {
          if (!pathMatch) return json(res, { error: 'Mirror only available for VM disks' }, 400);
          const slot = pathMatch[2];
          const ext = pathMatch[3];
          if (ext !== 'ocd' || (slot !== 'disk1' && slot !== 'disk2')) {
            return json(res, { error: 'Mirror only available for disk1/disk2 (.ocd)' }, 400);
          }
          const vmCfg = vmManager.getConfig(pathMatch[1]);
          const mirrorPath = vmCfg?.hardware?.[slot + 'Mirror'] || null;
          return json(res, { enabled: !!mirrorPath, path: mirrorPath || '', slot });
        }
        if (parts[3] === 'mirror' && method === 'POST') {
          if (!pathMatch) return json(res, { error: 'Mirror only available for VM disks' }, 400);
          const slot = pathMatch[2];
          const ext = pathMatch[3];
          if (ext !== 'ocd' || (slot !== 'disk1' && slot !== 'disk2')) {
            return json(res, { error: 'Mirror only available for disk1/disk2 (.ocd)' }, 400);
          }
          const vmName = pathMatch[1];
          const data = JSON.parse(body || '{}');
          const mirrorKey = slot + 'Mirror';
          if (data.enabled && data.path) {
            // Enable mirror mode
            const newPath = data.path.trim();
            if (!newPath) return json(res, { error: 'Path cannot be empty' }, 400);
            // Verify the folder exists
            const absPath = path.isAbsolute(newPath) ? newPath : path.join(PROJECT_DIR, newPath);
            if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
              return json(res, { error: 'Folder does not exist: ' + newPath }, 400);
            }
            const patch = { hardware: {} };
            patch.hardware[mirrorKey] = newPath;
            vmManager.updateConfig(vmName, patch);
            return json(res, { ok: true, enabled: true, path: newPath });
          } else {
            // Disable mirror mode
            const vmCfg = vmManager.getConfig(vmName);
            if (vmCfg && vmCfg.hardware) {
              delete vmCfg.hardware[mirrorKey];
              vmManager.saveConfig(vmName, vmCfg);
            }
            return json(res, { ok: true, enabled: false, path: '' });
          }
        }
      }
    }

    // /api/disks/import — import .ocd disk file into a VM folder
    // Body: { vmName, content (base64), filename }
    if (parts[1] === 'disks' && parts[2] === 'import' && method === 'POST') {
      const data = JSON.parse(body || '{}');
      const vmName = data.vmName;
      let filename = data.filename || 'imported.ocd';
      if (!filename.endsWith('.ocd')) filename += '.ocd';
      const destDir = path.join(VMS_DIR, vmName);
      fs.mkdirSync(destDir, { recursive: true });
      let destPath = path.join(destDir, filename);
      // Avoid overwrite if exists
      if (fs.existsSync(destPath) && data.makeUnique !== false) {
        const base = filename.replace(/\.ocd$/, '');
        let i = 2;
        while (fs.existsSync(path.join(destDir, `${base}${i}.ocd`))) i++;
        filename = `${base}${i}.ocd`;
        destPath = path.join(destDir, filename);
      }
      fs.writeFileSync(destPath, Buffer.from(data.content, 'base64'));
      return json(res, { ok: true, filename });
    }

    // /api/eeprom/import — accepts .oce (binary) or .lua (text) EEPROM
    // Body: { vmName, content (base64), format: 'lua'|'oce', filename?: 'custom.lua' }
    if (parts[1] === 'eeprom' && parts[2] === 'import' && method === 'POST') {
      const data = JSON.parse(body || '{}');
      const format = data.format || 'oce';
      const ext = format === 'lua' ? '.lua' : '.oce';
      // Use provided filename, or generate from original name, or default
      let filename = data.filename;
      if (!filename) {
        filename = format === 'lua' ? 'eeprom.lua' : 'eeprom.oce';
      }
      // Ensure extension is correct
      if (!filename.endsWith(ext)) filename += ext;
      // Avoid overwriting if file exists and is different from current
      const destPath = path.join(VMS_DIR, data.vmName, filename);
      if (fs.existsSync(destPath) && data.makeUnique !== false) {
        const base = filename.replace(/\.lua$|\.oce$/, '');
        let i = 2;
        while (fs.existsSync(path.join(VMS_DIR, data.vmName, `${base}${i}${ext}`))) i++;
        filename = `${base}${i}${ext}`;
      }
      fs.mkdirSync(path.join(VMS_DIR, data.vmName), { recursive: true });
      fs.writeFileSync(path.join(VMS_DIR, data.vmName, filename), Buffer.from(data.content, 'base64'));
      return json(res, { ok: true, path: filename, format });
    }

    // /api/vms/:name/storage — list EEPROM and disk files with labels
    if (parts[1] === 'vms' && parts[2] && parts[3] === 'storage' && method === 'GET') {
      const vmName = parts[2];
      const vmDir = path.join(VMS_DIR, vmName);
      if (!fs.existsSync(vmDir)) return json(res, { error: 'VM not found' }, 404);

      const cfg = vmManager.getConfig(vmName) || {};
      const hw = cfg.hardware || {};

      const eeproms = [];
      const disks = [];
      let floppy = null;

      // Read .oce label (bytes 9-24, null-padded)
      function readOceLabel(filePath) {
        try {
          const buf = fs.readFileSync(filePath);
          if (buf.length < 25) return null;
          if (buf.subarray(0, 8).toString('ascii') !== 'OCEEPROM') return null;
          return buf.subarray(9, 25).toString('ascii').replace(/\0/g, '') || null;
        } catch { return null; }
      }
      // Read .ocd label (bytes 8-23, null-padded)
      function readOcdLabel(filePath) {
        try {
          const buf = fs.readFileSync(filePath);
          if (buf.length < 24) return null;
          if (buf.subarray(0, 6).toString('ascii') !== 'OCDISK') return null;
          return buf.subarray(8, 24).toString('ascii').replace(/\0/g, '') || null;
        } catch { return null; }
      }
      // Read .ocf label (bytes 10-25, null-padded)
      function readOcfLabel(filePath) {
        try {
          const buf = fs.readFileSync(filePath);
          if (buf.length < 26) return null;
          if (buf.subarray(0, 8).toString('ascii') !== 'OCFLOPPY') return null;
          return buf.subarray(10, 26).toString('ascii').replace(/\0/g, '') || null;
        } catch { return null; }
      }

      for (const fname of fs.readdirSync(vmDir)) {
        const fullPath = path.join(vmDir, fname);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        if (fname.endsWith('.lua') || fname.endsWith('.oce')) {
          // Skip non-EEPROM lua files? We'll include all .lua/.oce as potential EEPROMs
          let label = null;
          if (fname.endsWith('.oce')) {
            label = readOceLabel(fullPath);
          }
          // For .lua, use config eepromLabel if it's the current one
          if (!label && fname === hw.eeprom) {
            label = hw.eepromLabel || null;
          }
          eeproms.push({
            filename: fname,
            label: label || fname.replace(/\.(lua|oce)$/, ''),
            type: fname.endsWith('.lua') ? 'lua' : 'oce',
            isCurrent: fname === hw.eeprom,
          });
        } else if (fname.endsWith('.ocd') || fname.endsWith('.ocf')) {
          const isOcf = fname.endsWith('.ocf');
          const label = isOcf
            ? (readOcfLabel(fullPath) || fname)
            : (readOcdLabel(fullPath) || fname);
          const isFloppy = (fname === hw.floppy);
          const isDisk1 = (fname === hw.disk1);
          const isDisk2 = (fname === hw.disk2);
          if (isFloppy) {
            floppy = { filename: fname, label };
          } else {
            disks.push({
              filename: fname,
              label,
              isDisk1,
              isDisk2,
              isCurrent: isDisk1 || isDisk2,
              isSystem: isDisk1,
            });
          }
        }
      }

      return json(res, { eeproms, disks, floppy });
    }

    // /api/vms/:name/eeprom-delete — delete an EEPROM file
    if (parts[1] === 'vms' && parts[2] && parts[3] === 'eeprom-delete' && method === 'POST') {
      const vmName = parts[2];
      const data = JSON.parse(body || '{}');
      const filename = data.filename;
      if (!filename) return json(res, { error: 'filename required' }, 400);
      // Safety: only allow .lua and .oce files, no path traversal
      if (!/^[\w\-]+\.(lua|oce)$/.test(filename)) {
        return json(res, { error: 'invalid filename' }, 400);
      }
      const filePath = path.join(VMS_DIR, vmName, filename);
      if (!filePath.startsWith(path.join(VMS_DIR, vmName))) {
        return json(res, { error: 'path traversal denied' }, 400);
      }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // If this was the current EEPROM, reset to built-in
      const cfg = vmManager.getConfig(vmName);
      if (cfg && cfg.hardware && cfg.hardware.eeprom === filename) {
        vmManager.updateConfig(vmName, { hardware: { eeprom: 'built-in', eepromLabel: null } });
      }
      return json(res, { ok: true });
    }

    // /api/vms/:name/disk-delete — delete a disk file
    if (parts[1] === 'vms' && parts[2] && parts[3] === 'disk-delete' && method === 'POST') {
      const vmName = parts[2];
      const data = JSON.parse(body || '{}');
      const filename = data.filename;
      if (!filename) return json(res, { error: 'filename required' }, 400);
      if (!/^[\w\-]+\.ocd$/.test(filename)) {
        return json(res, { error: 'invalid filename' }, 400);
      }
      const filePath = path.join(VMS_DIR, vmName, filename);
      if (!filePath.startsWith(path.join(VMS_DIR, vmName))) {
        return json(res, { error: 'path traversal denied' }, 400);
      }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // Clear from config if it was disk2 or floppy
      const cfg = vmManager.getConfig(vmName);
      if (cfg && cfg.hardware) {
        const patch = { hardware: {} };
        if (cfg.hardware.disk2 === filename) patch.hardware.disk2 = null;
        if (cfg.hardware.floppy === filename) patch.hardware.floppy = null;
        if (Object.keys(patch.hardware).length > 0) {
          vmManager.updateConfig(vmName, patch);
        }
      }
      return json(res, { ok: true });
    }

    // /api/vms/:name/export — Export VM as tar.gz archive
    if (parts[1] === 'vms' && parts[3] === 'export' && method === 'POST') {
      const vmName = parts[2];
      const vmDir = path.join(VMS_DIR, vmName);
      if (!fs.existsSync(vmDir)) {
        return json(res, { error: 'VM not found' }, 404);
      }

      // Read request body for extra files/dirs to include
      const spec = JSON.parse(body || '{}');
      const extraFiles = spec.extraFiles || [];  // [{path: "relative/path", content: "base64"}]
      const extraDirs = spec.extraDirs || [];    // [{path: "dir/name", files: [{path, content}]}]

      // Build the export manifest
      const config = vmManager.getConfig(vmName);
      if (!config) {
        return json(res, { error: 'VM config not found' }, 404);
      }

      // Collect all VM files
      const exportData = {
        manifest: {
          format: 'oc-vm-export',
          version: 1,
          exportedAt: new Date().toISOString(),
          vmName: vmName,
          config: config,
        },
        files: [],
      };

      // 1. config.json
      exportData.files.push({
        path: 'config.json',
        content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
      });

      // 2. Disk files
      const vmFiles = fs.readdirSync(vmDir);
      for (const file of vmFiles) {
        if (file === 'config.json') continue;  // already added
        const filePath = path.join(vmDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const content = fs.readFileSync(filePath);
          exportData.files.push({
            path: file,
            content: content.toString('base64'),
            binary: true,
          });
        }
      }

      // 3. Extra files from user
      for (const f of extraFiles) {
        if (f.path && f.content) {
          exportData.files.push({
            path: f.path,
            content: f.content,
            binary: f.binary || false,
          });
        }
      }

      // 4. Extra directories from user
      for (const d of extraDirs) {
        if (d.path && d.files) {
          for (const f of d.files) {
            if (f.path && f.content) {
              exportData.files.push({
                path: `${d.path}/${f.path}`,
                content: f.content,
                binary: f.binary || false,
              });
            }
          }
        }
      }

      return json(res, exportData);
    }

    // /api/vms/import — Import VM from export data
    if (parts[1] === 'vms' && parts[2] === 'import' && method === 'POST') {
      const data = JSON.parse(body || '{}');
      const manifest = data.manifest;
      if (!manifest || manifest.format !== 'oc-vm-export') {
        return json(res, { error: 'Invalid export format' }, 400);
      }

      const vmName = manifest.vmName || `Imported_${Date.now()}`;
      const vmDir = path.join(VMS_DIR, vmName);

      // Check if VM already exists
      if (fs.existsSync(path.join(vmDir, 'config.json'))) {
        return json(res, { error: `VM "${vmName}" already exists` }, 400);
      }

      fs.mkdirSync(vmDir, { recursive: true });

      // Write all files
      for (const file of (data.files || [])) {
        const filePath = path.join(vmDir, file.path);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, Buffer.from(file.content, 'base64'));
      }

      return json(res, { ok: true, name: vmName });
    }

    return json(res, { error: 'Not found' }, 404);
  } catch (e) {
    logger.error('[api]', e.message);
    // Streaming endpoints (e.g. update/apply) may have sent headers already; just end the response
    if (res.headersSent) {
      try { res.end(); } catch (err) { /* ignore */ }
      return;
    }
    return json(res, { error: e.message }, 500);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  req.pathname = parsed.pathname;
  req.query = parsed.query;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Read the request body
  let body = '';
  if (req.method === 'POST' || req.method === 'PUT') {
    for await (const chunk of req) body += chunk;
  }

  if (req.pathname.startsWith('/api/')) {
    await handleApi(req, res, body);
  } else {
    serveStatic(req, res);
  }
});

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  logger.log('[ws] client connected');
  let subscribedVm = null;
  let subscribedMod = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'c2s.subscribe':
          if (subscribedVm) vmManager.unsubscribe(subscribedVm, ws);
          if (subscribedMod) { modsManager.unsubscribe(subscribedMod, ws); subscribedMod = null; }
          subscribedVm = msg.vm;
          vmManager.subscribe(subscribedVm, ws);
          break;

        case 'c2s.unsubscribe':
          if (subscribedVm) {
            vmManager.unsubscribe(subscribedVm, ws);
            subscribedVm = null;
          }
          break;

        case 'c2s.mod.subscribe':
          if (subscribedVm) { vmManager.unsubscribe(subscribedVm, ws); subscribedVm = null; }
          if (subscribedMod) modsManager.unsubscribe(subscribedMod, ws);
          subscribedMod = msg.mod;
          modsManager.subscribe(subscribedMod, ws);
          break;

        case 'c2s.mod.unsubscribe':
          if (subscribedMod) {
            modsManager.unsubscribe(subscribedMod, ws);
            subscribedMod = null;
          }
          break;

        case 'c2s.mod.command':
          if (subscribedMod) modsManager.sendModCommand(subscribedMod, msg.command);
          break;

        case 'c2s.input':
          if (subscribedVm) {
            vmManager.sendInput(subscribedVm, {
              event: msg.event,
              char: msg.char,
              code: msg.code,
              x: msg.x,
              y: msg.y,
              px: msg.px,
              py: msg.py,
              btn: msg.btn,
              delta: msg.delta,
              text: msg.text,
            });
          }
          break;

        case 'c2s.command':
          if (subscribedVm) {
            vmManager.sendCommand(subscribedVm, msg.cmd);
          }
          break;

        default:
          // Ignore other messages
      }
    } catch (e) {
      logger.error('[ws] message error:', e.message);
    }
  });

  ws.on('close', () => {
    if (subscribedVm) vmManager.unsubscribe(subscribedVm, ws);
    if (subscribedMod) modsManager.unsubscribe(subscribedMod, ws);
    logger.log('[ws] client disconnected');
  });
});

// ---------- Dynamic port probing ----------
function tryListen(host, port, maxRetries = 20) {
  return new Promise((resolve, reject) => {
    function attempt(portNum, retriesLeft) {
      const testServer = http.createServer();
      testServer.once('error', (err) => {
        testServer.close();
        if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
          // Port in use, try the next one
          const nextPort = portNum + 1;
          logger.log(`  Port ${portNum} in use, trying ${nextPort}...`);
          attempt(nextPort, retriesLeft - 1);
        } else {
          reject(err);
        }
      });
      testServer.once('listening', () => {
        testServer.close(() => {
          // Port is free, start the real server
          resolve(portNum);
        });
      });
      testServer.listen(portNum, host);
    }
    attempt(port, maxRetries);
  });
}

// ---------- Startup ----------
// Probe whether another instance of this program already serves the port (single-instance guard)
function probeExistingInstance(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    // 0.0.0.0 / :: / empty are not valid connect addresses; fall back to loopback
    let connectHost = host;
    if (!connectHost || connectHost === '0.0.0.0' || connectHost === '::' || connectHost === '::0') {
      connectHost = '127.0.0.1';
    }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(
        { host: connectHost, port, path: '/api/version', timeout: timeoutMs },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              finish(!!(j && j.name === 'OC Emulator'));
            } catch (e) { finish(false); }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
    } catch (e) {
      finish(false);
    }
  });
}

async function main() {
  // Lua check
  logger.log('===============================================');
  logger.log('  OC Emulator - Web Control Panel v2.1');
  logger.log('===============================================');

  const HOST = settings.host || '127.0.0.1';
  const CONFIG_PORT = settings.port || 8080;

  // ---- Single-instance guard ----
  // Never auto-bump the port when it is taken, because:
  //   - the same VM would be spawned twice -> inconsistent screens per port;
  //   - two instances writing one disk image -> possible corruption.
  // So if an instance of this program already serves the configured port, exit instead.
  // (Exit code 3 = already running; run.bat then skips the restart.)
  if (await probeExistingInstance(HOST, CONFIG_PORT)) {
    logger.log('');
    logger.log('===============================================');
    logger.log(`  [INFO] 已检测到 OC Emulator 正在运行`);
    logger.log(`         地址: http://127.0.0.1:${CONFIG_PORT}/`);
    logger.log('');
    logger.log('  为避免重复启动 VM 导致画面不同步 / 磁盘冲突,');
    logger.log('  本次不再启动新实例。请直接使用上面的地址。');
    logger.log('  (如需重启, 请先关闭原来那个服务窗口)');
    logger.log('===============================================');
    logger.log('');
    process.exit(3);
    return;
  }

  logger.log('\n[1/2] Checking Lua interpreter...');
  const luaResult = await luaCheck.ensure();
  if (luaResult.ok) {
    logger.log(`  ✓ Lua OK: ${luaResult.version} ${luaResult.cached ? '(cached)' : '(verified)'}`);
    // The detected/installed path may differ from the command in settings.json
    // (e.g. lua5.3 under Termux); propagate it to every module that spawns Lua.
    if (luaResult.path && luaResult.path !== settings.luaExe) {
      settings.luaExe = luaResult.path;
      diskIO.luaExe = luaResult.path;
      vmManager.luaExe = luaResult.path;
      modsManager.luaExe = luaResult.path;
    }
  } else {
    logger.error(`  ✗ Lua check failed: ${(luaResult.errors || []).join(', ')}`);
    logger.error(`  Path: ${settings.luaExe}`);
    logger.error('  VMs will not be able to start. Please fix Lua installation.');
  }

  logger.log('\n[2/2] Starting web server...');

  // Find a free port: bump the configured port by one while it is taken
  let actualPort;
  try {
    actualPort = await tryListen(HOST, CONFIG_PORT, 20);
  } catch (err) {
    logger.error(`  ✗ Cannot find available port: ${err.message}`);
    logger.error(`  Tried ports ${CONFIG_PORT}-${CONFIG_PORT + 20}`);
    throw err;
  }

  if (actualPort !== CONFIG_PORT) {
    logger.log(`  Configured port ${CONFIG_PORT} in use, using ${actualPort} instead.`);
  }

  server.listen(actualPort, HOST, () => {
    logger.log(`\n===============================================`);
    logger.log(`  Server ready!`);

    // Collect this machine's IPv4 addresses
    function getLocalIPs() {
      const ifaces = os.networkInterfaces();
      const ips = [];
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            ips.push(iface.address);
          }
        }
      }
      return ips;
    }

    const isAnyHost = (HOST === '0.0.0.0' || HOST === '::' || HOST === '');

    if (isAnyHost) {
      // Listening on all addresses: show localhost, LAN IPs and a WAN hint
      logger.log(`  Local:   http://127.0.0.1:${actualPort}`);
      const localIPs = getLocalIPs();
      for (const ip of localIPs) {
        logger.log(`  内网:    http://${ip}:${actualPort}`);
      }
      logger.log(`  外网:    需要端口映射 + 公网IP/域名访问`);
    } else if (HOST === '127.0.0.1' || HOST === 'localhost') {
      // Local only: still show the LAN IP for reference (not actually reachable)
      logger.log(`  Local:   http://${HOST}:${actualPort}`);
      const localIPs = getLocalIPs();
      if (localIPs.length > 0) {
        // Keep console lines short, especially with double-width CJK text:
        // the Windows console truncates lines wider than the window instead of
        // wrapping them, so split this into two short lines.
        logger.log(`  本机IP:  http://${localIPs[0]}:${actualPort}`);
        logger.log(`  仅本地监听; 改 host 为 0.0.0.0 即可局域网访问`);
      }
    } else {
      // Explicit IP: print it directly
      logger.log(`  Open:    http://${HOST}:${actualPort}`);
    }

    logger.log(`  Press Ctrl+C to stop.`);
    logger.log(`===============================================\n`);

    // Write the actual port and PID to a state file under cache/ for the run.bat / run.sh watchdog.
    // The server may switch ports, so the watchdog must trust these values to watch the right process.
    // Writes land in a temp file and are then renamed, so readers never see a partial file;
    // the file survives process exit and always points at the latest run.
    try {
      const cacheDir = path.join(PROJECT_DIR, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const writeAtomic = (name, data) => {
        const file = path.join(cacheDir, name);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, data, 'utf8');
        fs.renameSync(tmp, file);
      };
      writeAtomic('.server-port', String(actualPort));
      writeAtomic('.server-pid', String(process.pid));
    } catch (e) { /* a failed state-file write must not stop the server; the watchdog just holds still */ }

    // Apply the "show console" setting (hidden at startup when off; can be re-enabled in the UI)
    if (settings.showConsole === false) {
      setConsoleVisible(false).catch(() => {});
    }

    // After 60s of uptime write a marker file; the run.bat / run.sh watchdog uses it
    // to treat this run as healthy and reset the restart counter. The path comes from
    // an env var set by the watchdog; when started directly with node it is absent, so skip.
    const uptimeMarker = process.env.OC_UPTIME_MARKER;
    if (uptimeMarker) {
      setTimeout(() => {
        try { fs.writeFileSync(uptimeMarker, String(Date.now())); } catch (e) { /* ignore */ }
      }, 60000);
    }
  });

  server.on('error', (err) => {
    logger.error(`  Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      logger.error(`  Port ${actualPort} is already in use.`);
    }
  });
}

main().catch(err => {
  logger.error('Fatal error:', err);
  logger.error('Press Enter to exit...');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
});
