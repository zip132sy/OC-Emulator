// ============================================================
// OC Emulator - Web 控制面板服务器
// HTTP + WebSocket, VMware Workstation 风格
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { execFile } = require('child_process');
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

// 软盘模板兼容性别名（旧名称 → 新名称）
const floppyAliases = {
  'DataCard': 'Data',
  'data_card': 'Data',
  'network': 'Network',
  'openloader': 'OpenLoader',
  'oppm': 'OPPM',
  'openirc': 'OpenIRC',
};

// ---------- 路径 ----------
const PROJECT_DIR = __dirname;
const VMS_DIR = path.join(PROJECT_DIR, 'vms');
const MODS_DIR = path.join(PROJECT_DIR, 'Mods');
const DISKS_DIR = path.join(PROJECT_DIR, 'disks');
const WEB_DIR = path.join(PROJECT_DIR, 'web');
const CACHE_DIR = path.join(PROJECT_DIR, 'cache');
const EMU_SCRIPT = path.join(PROJECT_DIR, 'oc-emulator.lua');

// 确保目录存在
for (const d of [VMS_DIR, MODS_DIR, DISKS_DIR, CACHE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- 设置 ----------
function loadSettings() {
  const settingsPath = path.join(PROJECT_DIR, 'settings.json');
  // sysInfoPolling: 是否查询系统电量 / 本工具内存占用, 并提供给 VM 内的系统使用。
  //   默认开启。所有查询都是异步的 (tasklist / PowerShell), 且带长缓存, 不会阻塞事件循环。
  let settings = {
    luaExe: 'lua',
    port: 8080,
    host: '127.0.0.1',
    logLevel: 'error',
    sysInfoPolling: true,
    showConsole: true,   // 是否显示服务器所在的命令行窗口 (可在前端设置里随时切换)
    autoUpdate: true,    // 启动脚本是否自动从远端仓库拉取更新 (可在前端设置里随时切换)
    skipIntegrityCheck: false, // 启动时跳过依赖文件完整性检查 (可在前端设置里随时切换)
  };
  if (fs.existsSync(settingsPath)) {
    try {
      settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
    } catch (e) {
      console.error('[settings] cannot load settings.json:', e.message);
    }
  }
  // 跨平台: settings.json 里可能残留另一个平台的可执行文件路径
  // (例如从 Windows 拷贝过来的 C:\...\lua.exe), 在 Linux/macOS 上不可用。
  // 这种情况直接忽略, 退回 "lua" 交由自动探测, 避免跨平台时开箱即坏。
  if (settings.luaExe && !isPlausibleLuaPath(settings.luaExe)) {
    console.log(`[settings] luaExe 路径不适用于当前平台, 改为自动探测: ${settings.luaExe}`);
    settings.luaExe = 'lua';
  }
  return settings;
}

// 判断 luaExe 是否有可能在当前平台上运行
function isPlausibleLuaPath(p) {
  if (!p || p === 'lua') return true;
  if (process.platform === 'win32') return true;   // Windows 下不做额外限制
  // 非 Windows: 带盘符或以 .exe 结尾的路径必然不可用
  const looksWindows = /^[A-Za-z]:[\\/]/.test(p) || /\.exe$/i.test(p);
  return !looksWindows;
}

// ---------- 服务控制退出码 (供前台守护脚本 run.bat / run.sh 识别) ----------
const EXIT_STOP = 4;      // 用户从前端请求"停止服务": 守护脚本不再拉起
const EXIT_RESTART = 5;   // 用户从前端请求"重启服务": 守护脚本立即重启且不计入重试次数

// 结束服务器进程, 交由守护脚本按退出码决定是否重启。
// 先把运行中的 VM 停掉, 避免宿主退出后留下孤儿进程。
function shutDownForGuardian(code) {
  try {
    for (const vm of vmManager.list()) {
      if (vm.state === 'running' || vm.state === 'paused' || vm.state === 'starting') {
        try { vmManager.stop(vm.name); } catch (e) { /* 忽略单个 VM 的停止失败 */ }
      }
    }
    for (const mod of modsManager.listMods()) {
      if (mod.state === 'running' || mod.state === 'paused' || mod.state === 'starting') {
        try { modsManager.stop(mod.name); } catch (e) { /* 忽略单个 Mod 的停止失败 */ }
      }
    }
  } catch (e) { /* 忽略 */ }
  // 给 VM 一点时间优雅退出, 再结束进程
  setTimeout(() => process.exit(code), 1200);
}

// ---------- 检查更新 (git) ----------
// 运行一次 git 命令; 不抛异常, 统一返回 { ok, stdout, stderr, err }
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

// 解析 git log 输出 (格式: %H \x1f %h \x1f %s \x1f %ad)
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

// 当前分支的上游 ref (如 origin/main); 没有上游时回退到常见远端分支
async function resolveUpstreamRef() {
  const up = await gitRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 15000);
  const name = up.ok ? up.stdout.trim() : '';
  if (name && name.indexOf('/') >= 0) return name;
  for (const ref of ['origin/main', 'origin/master', 'github/main']) {
    const r = await gitRun(['rev-parse', '--verify', ref], 15000);
    if (r.ok && r.stdout.trim()) return ref;
  }
  return null;
}

// 检查是否存在可用更新
async function checkForUpdate() {
  const out = { ok: false, available: false, behind: 0, current: null, latest: null, subject: '', error: null, detail: '' };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }

  const fetch = await gitRun(['fetch', '--quiet']);
  if (!fetch.ok) {
    out.error = 'fetch-failed';
    out.detail = (fetch.stderr || fetch.err || '').trim().slice(0, 500);
    return out;
  }

  const cur = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.current = cur.ok ? cur.stdout.trim().slice(0, 7) : null;

  const ref = await resolveUpstreamRef();
  if (!ref) { out.error = 'no-upstream'; return out; }

  const cnt = await gitRun(['rev-list', '--count', `HEAD..${ref}`], 15000);
  out.behind = cnt.ok ? (parseInt(cnt.stdout.trim(), 10) || 0) : 0;

  const lat = await gitRun(['rev-parse', ref], 15000);
  out.latest = lat.ok ? lat.stdout.trim().slice(0, 7) : null;

  const sub = await gitRun(['log', '-1', '--pretty=%s', ref], 15000);
  out.subject = sub.ok ? sub.stdout.trim() : '';

  out.available = out.behind > 0;

  // 更新日志: 有更新时列出待拉取的提交; 已是最新时列出当前版本最近的提交
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

// 执行更新 (git pull --ff-only); 仅拉取, 不重启, 由前端决定是否重启
async function applyUpdate() {
  const out = { ok: false, changed: false, before: null, after: null, output: '', error: null };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }

  const before = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.before = before.ok ? before.stdout.trim().slice(0, 7) : null;

  let pull = await gitRun(['pull', '--ff-only'], 180000);
  if (!pull.ok) {
    const ref = await resolveUpstreamRef();
    if (ref && ref.indexOf('/') > 0) {
      const remote = ref.slice(0, ref.indexOf('/'));
      const branch = ref.slice(ref.indexOf('/') + 1);
      pull = await gitRun(['pull', '--ff-only', remote, branch], 180000);
    }
  }
  out.output = ((pull.stdout || '') + (pull.stderr || '')).trim().slice(0, 2000);
  if (!pull.ok) { out.error = 'pull-failed'; return out; }

  const after = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.after = after.ok ? after.stdout.trim().slice(0, 7) : null;
  out.changed = !!(out.before && out.after && out.before !== out.after);
  out.ok = true;
  return out;
}

// 列出最近的历史版本 (供设置里的"版本回退"选择)
async function listVersions() {
  const out = { ok: false, error: null, current: null, versions: [] };
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { out.error = 'not-a-repo'; return out; }
  const head = await gitRun(['rev-parse', 'HEAD'], 15000);
  out.current = head.ok ? head.stdout.trim().slice(0, 7) : null;
  out.versions = await gitLogLines(['log', '--pretty=%H%x1f%h%x1f%s%x1f%ad', '--date=short', '-n', '15', 'HEAD']);
  out.ok = true;
  return out;
}

// 回退到指定提交 (git reset --hard); 仅切换版本, 不重启, 由前端决定是否重启
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

// ---------- 控制台窗口显示 / 隐藏 ----------
// 三个平台各有一套机制, 都做不到时会安全跳过并回报原因, 绝不误隐藏别的窗口。
//   Windows : PowerShell 调 Win32 ShowWindow
//   macOS   : osascript 控制承载服务器的终端 App 的可见性
//   Linux   : 仅 X11 + 已安装 xdotool 时可用 (Wayland 没有通用方案)
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

// 沿父进程链向上找承载本进程的终端 App (macOS)
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
    // 形如 /Applications/XXX.app/Contents/MacOS/XXX 时取 XXX.app 的名字
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
  // 用 System Events 切换整个终端 App 的可见性。首次可能需要授予"辅助功能"权限。
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

  // 找到属于本进程某个祖先的 X11 窗口
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
    // 这里不能用 windowsHide: true。它会以 CREATE_NO_WINDOW 启动子进程,
    // 使 PowerShell 拿不到控制台窗口句柄 (GetConsoleWindow() 返回 0)。
    // 不加该选项时子进程会直接继承服务器所在的控制台, 不会额外弹窗。
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
// 应用系统信息查询开关
sysInfo.setEnabled(settings.sysInfoPolling === true);

// ---------- 进程级兜底: 单个异常不应让整个服务器退出 ----------
// run.bat 的看门狗会在健康检查超时后强杀服务器, 因此这里尽量保活并记录。
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
  // 系统信息查询开关
  if (prev.sysInfoPolling !== settings.sysInfoPolling) {
    sysInfo.setEnabled(settings.sysInfoPolling === true);
  }
  // 更新使用 luaExe 的模块实例
  if (newSettings.luaExe) {
    diskIO.luaExe = newSettings.luaExe;
    luaCheck.luaExe = newSettings.luaExe;
    luaCheck.invalidate();
    vmManager.luaExe = newSettings.luaExe;
  }
}

// ---------- 模块实例 ----------
const logger = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

const modemHub = new ModemHub();
const internetProxy = new InternetProxy({ timeout: 60000 });
const diskIO = new DiskIO({ projectDir: PROJECT_DIR, luaExe: settings.luaExe });
const luaCheck = new LuaCheck({ projectDir: PROJECT_DIR, luaExe: settings.luaExe });
// 设备总线: 把核电站这类非计算机设备作为组件暴露给所有虚拟机
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

// Mods 设备管理器: 与 VM 共用 modemHub / diskIO, 但使用独立的 Mods/ 目录
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

// ---------- 静态文件服务 ----------
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
  // 防目录遍历
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
  // 静态资源一律"每次校验"(no-cache)而不是强缓存。
  // 面板的 JS/CSS 改动很频繁, 而 index.html 里的 ?v=N 需要人工递增 —— 一旦忘记
  // 递增, 浏览器就会一直复用旧文件, 表现出来就是"改了没用/功能还是坏的"。
  // 带上 ETag/Last-Modified 后浏览器仍会走 304, 开销极小。
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

// ---------- REST API ----------
async function handleApi(req, res, body) {
  const parts = req.pathname.split('/').filter(Boolean); // ['api', 'vms', ...]
  const method = req.method;

  try {
    // /api/version
    if (parts[1] === 'version') {
      return json(res, { version: '2.0.0', name: 'OC Emulator' });
    }

    // /api/server/restart 与 /api/server/stop: 前端控制面板里的服务级按钮
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

    // /api/update/* : 前端"检查更新"与"版本回退"
    if (parts[1] === 'update') {
      if (parts[2] === 'check') {
        return json(res, await checkForUpdate());
      }
      if (parts[2] === 'apply' && method === 'POST') {
        logger.log('[server] 前端请求拉取更新');
        return json(res, await applyUpdate());
      }
      if (parts[2] === 'versions') {
        return json(res, await listVersions());
      }
      if (parts[2] === 'rollback' && method === 'POST') {
        let ref = '';
        try { ref = (JSON.parse(body || '{}') || {}).ref || ''; } catch (e) { /* 忽略非法 body */ }
        logger.log('[server] 前端请求回退版本: ' + ref);
        return json(res, await rollbackTo(ref));
      }
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
          skipIntegrityCheck: settings.skipIntegrityCheck === true,
        });
      }
      if (method === 'PUT') {
        const patch = JSON.parse(body || '{}');
        saveSettings(patch);
        // 应用新的 logLevel 到 vmManager (影响后续启动的 VM)
        if (patch.logLevel) {
          vmManager.logLevel = patch.logLevel;
          modsManager.logLevel = patch.logLevel;
        }
        // 命令行窗口显示开关: 立即生效
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
          skipIntegrityCheck: settings.skipIntegrityCheck === true,
          consoleResult,
        });
      }
    }

    // /api/mods - Mods 设备 (机器人 / 无人机)
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

        if (action === 'start' && method === 'POST') {
          return json(res, modsManager.start(modName));
        }
        if (action === 'stop' && method === 'POST') {
          try { modsManager.stop(modName); } catch (e) { /* 已停止 */ }
          return json(res, { ok: true });
        }
        if (action === 'restart' && method === 'POST') {
          try { modsManager.restart(modName); } catch (e) { /* 忽略 */ }
          return json(res, { ok: true });
        }
        if (action === 'pause' && method === 'POST') {
          try { modsManager.pause(modName); } catch (e) { /* 忽略 */ }
          return json(res, { ok: true });
        }
        if (action === 'resume' && method === 'POST') {
          try { modsManager.resume(modName); } catch (e) { /* 忽略 */ }
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
            // POST = 复位堆芯 (更换冷却单元, 清空堆芯热量)
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
          // 如果指定了 disk1/disk2 为 "new", 创建新磁盘
          if (spec.hardware && spec.hardware.disk1 === 'new') {
            const diskName = 'disk1.ocd';
            const diskPath = path.join(VMS_DIR, spec.name, diskName);
            const tier = spec.hardware.disk1Tier || 3;
            const size = spec.hardware.disk1Size || (tier === 1 ? 1048576 : tier === 2 ? 2097152 : 4194304);
            const label = spec.hardware.disk1Label || `${spec.name}-disk1`;
            // 先创建 VM 目录
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });

            // 如果有导入文件, 用文件创建磁盘; 否则创建空磁盘
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
              // 清理, 不持久化到 config
              delete spec.hardware.disk1ImportFiles;
            } else {
              diskIO.create({ path: diskPath, label, size, tier });
            }
            // 镜像模式: 创建镜像文件夹并写入初始文件
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
            const size = spec.hardware.disk2Size || (tier === 1 ? 1048576 : tier === 2 ? 2097152 : 4194304);
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
            // 镜像模式: 创建镜像文件夹并写入初始文件
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
          // 如果选了磁盘模板 (如 'openos' 或 'disk_template:xxx.ocd'), 复制模板
          if (spec.hardware && (spec.hardware.disk1 === 'openos' || (spec.hardware.disk1 || '').startsWith('disk_template:'))) {
            const tplFile = spec.hardware.disk1.startsWith('disk_template:')
              ? spec.hardware.disk1.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, spec.name, 'disk1.ocd');
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });
            if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, diskPath);
            spec.hardware.disk1 = 'disk1.ocd';
          }
          if (spec.hardware && (spec.hardware.disk2 === 'openos' || (spec.hardware.disk2 || '').startsWith('disk_template:'))) {
            const tplFile = spec.hardware.disk2.startsWith('disk_template:')
              ? spec.hardware.disk2.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, spec.name, 'disk2.ocd');
            if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, diskPath);
            spec.hardware.disk2 = 'disk2.ocd';
          }
          // 如果选了 floppy, 写入模板内容或创建空软盘 (使用 .ocf 软盘格式)
          if (spec.hardware && spec.hardware.floppy) {
            let tplName = spec.hardware.floppy;
            // 兼容旧名称
            if (floppyAliases[tplName]) tplName = floppyAliases[tplName];
            const floppyPath = path.join(VMS_DIR, spec.name, 'floppy.ocf');
            fs.mkdirSync(path.join(VMS_DIR, spec.name), { recursive: true });
            if (tplName === 'empty') {
              // 空软盘: 按用户选择的大小创建
              const size = spec.hardware.floppySize || 524288;
              const files = {
                '/': { type: 'directory', modified: Date.now() / 1000 },
              };
              diskIO.saveFloppy(floppyPath, { label: 'Floppy', files, size, locked: false });
              spec.hardware.floppy = 'floppy.ocf';
              delete spec.hardware.floppySize;
            } else if (floppyTemplates[tplName]) {
              const tpl = floppyTemplates[tplName];
              // 将 files 转换为需要的格式
              const files = {};
              for (const [fpath, content] of Object.entries(tpl.files)) {
                files[fpath] = { type: 'file', content: content, modified: Date.now() / 1000 };
              }
              // 添加目录节点
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
          // 处理 disk1 = 磁盘模板: 复制模板到 VM 目录
          if (patch.hardware && (patch.hardware.disk1 === 'openos' || (patch.hardware.disk1 || '').startsWith('disk_template:'))) {
            const tplFile = patch.hardware.disk1.startsWith('disk_template:')
              ? patch.hardware.disk1.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, vmName, 'disk1.ocd');
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, diskPath);
              patch.hardware.disk1 = 'disk1.ocd';
            }
          }
          // 处理 disk2 = 磁盘模板: 复制模板到 VM 目录
          if (patch.hardware && (patch.hardware.disk2 === 'openos' || (patch.hardware.disk2 || '').startsWith('disk_template:'))) {
            const tplFile = patch.hardware.disk2.startsWith('disk_template:')
              ? patch.hardware.disk2.substring('disk_template:'.length)
              : 'openos.ocd';
            const srcPath = path.join(DISKS_DIR, tplFile);
            const diskPath = path.join(VMS_DIR, vmName, 'disk2.ocd');
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, diskPath);
              patch.hardware.disk2 = 'disk2.ocd';
            }
          }
          // 处理软盘选项: 模板名或 'empty' 需要创建 floppy.ocf 文件 (.ocf 软盘格式)
          if (patch.hardware && patch.hardware.floppy) {
            let tplName = patch.hardware.floppy;
            // 如果是已存在的软盘文件名(如 floppy.ocf)，保持不变，不重新创建
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
          // 如果 VM 在运行且软盘配置变了, 触发软盘实时刷新
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
          // 断开指向这台虚拟机的设备接线, 避免悬空连接
          try { modsManager.clearVmConnections(vmName); } catch { /* 忽略清理失败 */ }
          return json(res, { ok: true });
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
        // 扫描 disks/ 目录，返回所有 .ocd 磁盘模板
        const templates = [];
        if (fs.existsSync(DISKS_DIR)) {
          for (const fname of fs.readdirSync(DISKS_DIR)) {
            if (!fname.endsWith('.ocd')) continue;
            const fullPath = path.join(DISKS_DIR, fname);
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            // 读取磁盘标签 (bytes 8-23, null-padded)
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
            });
          }
        }
        return json(res, templates);
      }
      if (parts[2] === 'create' && method === 'POST') {
        const spec = JSON.parse(body || '{}');
        const diskPath = spec.path;
        diskIO.create({
          path: diskPath,
          label: spec.label || 'Untitled',
          size: spec.size || 4194304,
          tier: spec.tier || 3,
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
        // diskFile 可能是 vms/xxx/disk1.ocd 格式
        const diskPath = path.join(PROJECT_DIR, diskFile);

        // 镜像模式检测: 从路径提取 VM 名和磁盘槽位
        // 例如 vms/myvm/disk1.ocd → vmName=myvm, slot=disk1
        // 也支持软盘: vms/myvm/floppy.ocf → vmName=myvm, slot=floppy
        const pathMatch = diskFile.match(/^vms\/([^/]+)\/(disk[12]|floppy)\.(ocd|ocf)$/);
        let mirrorFolder = null;
        if (pathMatch) {
          const vmNameMatch = pathMatch[1];
          const slotMatch = pathMatch[2];
          const extMatch = pathMatch[3];
          // 镜像模式仅适用于磁盘 (disk1/disk2), 软盘不支持镜像模式
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
          // 镜像模式且VM未运行: 从文件夹读取
          if (mirrorFolder && !vmRunning && fs.existsSync(mirrorFolder)) {
            const tree = diskIO.listFolderTree(mirrorFolder);
            return json(res, tree);
          }
          const tree = diskIO.listTree(diskPath);
          return json(res, tree);
        }
        if (parts[3] === 'read' && method === 'GET') {
          const innerPath = req.query.path || '/';
          // 镜像模式且VM未运行: 从文件夹读取
          if (mirrorFolder && !vmRunning && fs.existsSync(mirrorFolder)) {
            const result = diskIO.readFromFolder(mirrorFolder, innerPath);
            return json(res, { type: result.type, content: result.content, path: innerPath, ok: result.ok, error: result.error });
          }
          const fileData = diskIO.read(diskPath, innerPath);
          return json(res, { type: fileData.type, content: fileData.content, path: innerPath, ok: fileData.ok, error: fileData.error });
        }
        if (parts[3] === 'write' && method === 'PUT') {
          const innerPath = req.query.path;
          const data = JSON.parse(body || '{}');
          // 镜像模式且VM未运行: 写入文件夹 (下次启动时会同步到磁盘)
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
        // 镜像模式配置
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
            // 启用镜像模式
            const newPath = data.path.trim();
            if (!newPath) return json(res, { error: 'Path cannot be empty' }, 400);
            // 验证路径是否存在(文件夹)
            const absPath = path.isAbsolute(newPath) ? newPath : path.join(PROJECT_DIR, newPath);
            if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
              return json(res, { error: 'Folder does not exist: ' + newPath }, 400);
            }
            const patch = { hardware: {} };
            patch.hardware[mirrorKey] = newPath;
            vmManager.updateConfig(vmName, patch);
            return json(res, { ok: true, enabled: true, path: newPath });
          } else {
            // 禁用镜像模式
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
    return json(res, { error: e.message }, 500);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------- HTTP 服务器 ----------
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

  // 读取 body
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

// ---------- WebSocket 服务器 ----------
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
          // 其他消息忽略
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

// ---------- 动态端口检测 ----------
function tryListen(host, port, maxRetries = 20) {
  return new Promise((resolve, reject) => {
    function attempt(portNum, retriesLeft) {
      const testServer = http.createServer();
      testServer.once('error', (err) => {
        testServer.close();
        if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
          // 端口被占用, 尝试下一个
          const nextPort = portNum + 1;
          logger.log(`  Port ${portNum} in use, trying ${nextPort}...`);
          attempt(nextPort, retriesLeft - 1);
        } else {
          reject(err);
        }
      });
      testServer.once('listening', () => {
        testServer.close(() => {
          // 端口可用, 立即启动真正的服务器
          resolve(portNum);
        });
      });
      testServer.listen(portNum, host);
    }
    attempt(port, maxRetries);
  });
}

// ---------- 启动 ----------
// 探测指定端口上是否已有本程序实例在运行 (用于单实例保护)
function probeExistingInstance(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    // 0.0.0.0 / :: / 空 都不能作为连接地址, 统一回落到回环地址
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
  // Lua 校验
  logger.log('===============================================');
  logger.log('  OC Emulator - Web Control Panel v2.0');
  logger.log('===============================================');

  const HOST = settings.host || '127.0.0.1';
  const CONFIG_PORT = settings.port || 8080;

  // ---- 单实例保护 ----
  // 端口被占用时不能自动 +1 另起实例, 因为:
  //   - 同一个 VM 被两个实例各自 spawn 一份 -> 不同端口看到的画面不一致;
  //   - 两个实例同时读写同一个磁盘镜像 -> 可能损坏数据。
  // 因此: 只要配置端口上已有本程序实例在服务, 就不再启动第二个, 直接退出。
  // (退出码 3 = 已有实例在运行, run.bat 据此不会自动重启)
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
  } else {
    logger.error(`  ✗ Lua check failed: ${(luaResult.errors || []).join(', ')}`);
    logger.error(`  Path: ${settings.luaExe}`);
    logger.error('  VMs will not be able to start. Please fix Lua installation.');
  }

  logger.log('\n[2/2] Starting web server...');

  // 动态查找可用端口: 如果配置端口被占用则自动 +1
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

    // 获取本机 IP 地址
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
      // 监听所有地址: 显示 localhost + 内网 IP + 外网提示
      logger.log(`  Local:   http://127.0.0.1:${actualPort}`);
      const localIPs = getLocalIPs();
      for (const ip of localIPs) {
        logger.log(`  内网:    http://${ip}:${actualPort}`);
      }
      logger.log(`  外网:    需要端口映射 + 公网IP/域名访问`);
    } else if (HOST === '127.0.0.1' || HOST === 'localhost') {
      // 仅本地: 也显示内网 IP 供参考 (但实际不能通过内网访问)
      logger.log(`  Local:   http://${HOST}:${actualPort}`);
      const localIPs = getLocalIPs();
      if (localIPs.length > 0) {
        // 输出到控制台的一行不要过长, 尤其含中文(双宽字符)时。
        // Windows 控制台在窗口宽度不足时会把这类行「直接截断」而不是换行,
        // 表现为中文显示不全。所以这里拆成两行短句。
        logger.log(`  本机IP:  http://${localIPs[0]}:${actualPort}`);
        logger.log(`  仅本地监听; 改 host 为 0.0.0.0 即可局域网访问`);
      }
    } else {
      // 指定 IP: 直接显示
      logger.log(`  Open:    http://${HOST}:${actualPort}`);
    }

    logger.log(`  Press Ctrl+C to stop.`);
    logger.log(`===============================================\n`);

    // 把实际监听端口写入固定文件, 供 run.bat / run.sh 的外部看门狗读取。
    // 看门狗若把端口写死: 当配置端口被占用导致服务器自动换到 8081 时, 它仍监视 8080,
    // 检查失败后直接退出 —— 结果就是服务真的卡死时既不会被杀掉也不会被重启,
    // 命令行上也不会有任何提示。写入实际端口后看门狗总能找到正确的服务。
    try {
      const portFile = path.join(PROJECT_DIR, 'cache', '.server-port');
      fs.mkdirSync(path.dirname(portFile), { recursive: true });
      fs.writeFileSync(portFile, String(actualPort), 'utf8');
      process.on('exit', () => { try { fs.unlinkSync(portFile); } catch (e) { /* 忽略 */ } });
    } catch (e) { /* 端口文件写入失败不影响服务运行 */ }

    // 应用"命令行窗口显示"设置 (关闭时启动即隐藏; 可在前端设置里重新打开)
    if (settings.showConsole === false) {
      setConsoleVisible(false).catch(() => {});
    }

    // 稳定运行 60 秒后写一个标记文件, 前台守护脚本 (run.bat / run.sh) 据此
    // 判断"这次运行是健康的"并重置重启计数。路径由守护脚本经环境变量传入;
    // 直接用 node 启动时该变量不存在, 跳过即可。
    const uptimeMarker = process.env.OC_UPTIME_MARKER;
    if (uptimeMarker) {
      setTimeout(() => {
        try { fs.writeFileSync(uptimeMarker, String(Date.now())); } catch (e) { /* 忽略 */ }
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
