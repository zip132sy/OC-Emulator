// ============================================================
// ensureDeps.js - pre-start dependency check and install
//
//   1. npm dependencies (reads dependencies from package.json, verifies installed versions)
//   2. Lua interpreter (the project pins 5.3.x; missing or mismatched versions install 5.3.6)
//
// Behaviour:
//   - dependency missing       -> install directly
//   - dependency version wrong -> ask the user whether to reinstall
//   - Lua (pinned version)     -> no prompt, install the pinned version
//   - exit code 0 when everything is ready, 1 otherwise (the launcher uses it to decide)
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, execSync } = require('child_process');

const PROJECT_DIR = path.dirname(__dirname);

// ---------- pre-start scripts ----------
// This check runs first in the launcher chain, so the scripts that drive the
// later stages (integrity check / auto update / repair) are restored here when
// they are missing; otherwise the launcher would stop with a module error.
const BOOTSTRAP_FILES = [
  'server.js',
  'lib/setupLua.js',
  'lib/updateSource.js',
  'lib/startupPrep.js',
  'lib/repair.js',
];

// Branch of this checkout first, main as the fallback; GitHub then Gitee
function sourceBases() {
  const branches = ['main'];
  try {
    const head = fs.readFileSync(path.join(PROJECT_DIR, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m && !branches.includes(m[1])) branches.unshift(m[1]);
  } catch { /* not a git checkout */ }
  const bases = [];
  for (const b of branches) {
    bases.push(`https://raw.githubusercontent.com/zip132sy/OC-Emulator/${b}/`);
    bases.push(`https://gitee.com/zip132sy/OC-Emulator/raw/${b}/`);
  }
  return bases;
}

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('too many redirects')); return; }
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'OC-Emulator/2.2.3' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        downloadFile(next, destPath, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('download timeout')));
  });
}

function isPresent(rel) {
  try {
    const st = fs.statSync(path.join(PROJECT_DIR, rel));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function ensurePrepScripts() {
  const missing = BOOTSTRAP_FILES.filter((rel) => !isPresent(rel));
  if (missing.length === 0) return true;

  log(`[WARN] 缺少启动脚本: ${missing.join(', ')}, 正在尝试联网恢复...`);
  const bases = sourceBases();
  let ok = true;
  for (const rel of missing) {
    const abs = path.join(PROJECT_DIR, rel);
    const tmp = abs + '.part';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let restored = false;
    for (const base of bases) {
      try {
        await downloadFile(base + rel, tmp);
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          try { fs.rmSync(abs, { force: true }); } catch {}
          fs.renameSync(tmp, abs);
          restored = true;
          break;
        }
      } catch { /* try the next source */ }
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    if (restored) log(`[OK] 已恢复: ${rel}`);
    else { log(`[ERROR] 无法恢复: ${rel}`); ok = false; }
  }
  return ok;
}

// The emulator runs Lua 5.1+, but 5.3 / 5.4 are the most stable, so 5.x with minor >= 3 is required.
function isUsableLuaVersion(version) {
  const m = /Lua\s+5\.(\d+)/i.exec(version || '');
  return !!m && parseInt(m[1], 10) >= 3;
}

function log(...a) { console.log(...a); }

function ask(question) {
  return new Promise((resolve) => {
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question + ' [Y/N] ', (ans) => {
        rl.close();
        resolve(/^y/i.test(String(ans).trim()));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

// Simplified version match: same major and minor >= required covers ^x.y.z / x.y.z
function satisfies(version, range) {
  if (!version) return false;
  const want = String(range).replace(/[^0-9.]/g, '').split('.').filter(Boolean).map(Number);
  const have = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  if (want.length === 0 || Number.isNaN(want[0])) return true; // unparseable range counts as satisfied
  if (have[0] !== want[0]) return false;
  return have[1] >= (want[1] || 0);
}

// ---------- npm dependencies ----------
function readDeps() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
    return pkg.dependencies || {};
  } catch {
    return {};
  }
}

function checkNpmDeps() {
  const deps = readDeps();
  const problems = [];
  for (const [name, range] of Object.entries(deps)) {
    const p = path.join(PROJECT_DIR, 'node_modules', name, 'package.json');
    if (!fs.existsSync(p)) {
      problems.push({ name, range, status: 'missing', have: null });
      continue;
    }
    let have = '';
    try { have = JSON.parse(fs.readFileSync(p, 'utf8')).version || ''; } catch {}
    if (!satisfies(have, range)) problems.push({ name, range, status: 'mismatch', have });
  }
  return problems;
}

function runNpmInstall(dropLockfile) {
  // npm 12 refuses any tarball whose host differs from the configured registry
  // (error EALLOWREMOTE). A committed package-lock.json pins one specific mirror,
  // so every user on another registry fails to install. The lockfile is no longer
  // tracked; if an old clone still carries one, drop it and let npm resolve the
  // ranges against the local registry.
  if (dropLockfile) {
    try {
      fs.rmSync(path.join(PROJECT_DIR, 'package-lock.json'), { force: true });
      log('[INFO] 已移除旧的 package-lock.json (它固定了某个镜像源)');
    } catch {}
  }
  // Show npm's own output (including progress); on Windows npm is a .cmd, so a shell is needed
  execSync('npm install --no-audit --no-fund', { cwd: PROJECT_DIR, stdio: 'inherit' });
}

async function ensureNpmDeps() {
  let problems = checkNpmDeps();
  if (problems.length === 0) {
    log('[OK] npm 依赖已就绪');
    return true;
  }

  const missing = problems.filter((p) => p.status === 'missing');
  const mismatch = problems.filter((p) => p.status === 'mismatch');
  for (const m of missing) log(`[INFO] 缺少依赖: ${m.name} (需要 ${m.range})`);
  for (const m of mismatch) log(`[WARN] ${m.name} 版本不符: 已安装 ${m.have}, 需要 ${m.range}`);

  if (mismatch.length > 0) {
    const yes = await ask('检测到 npm 依赖版本不符, 是否重新安装?');
    if (!yes) {
      log('[ERROR] 依赖未满足, 已取消启动。');
      return false;
    }
  }

  log('[INFO] 正在安装 npm 依赖...');
  // The second attempt always drops the lockfile: the usual reason the first
  // attempt fails on a fresh clone is a lockfile pointing at another mirror.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      runNpmInstall(attempt > 1);
    } catch (e) {
      log(`[WARN] npm install 失败 (第 ${attempt}/2 次): ${e.message}`);
    }
    problems = checkNpmDeps();
    if (problems.length === 0) {
      log('[OK] npm 依赖安装完成');
      return true;
    }
    if (attempt < 2) log('[INFO] 重试中 (不使用 package-lock.json)...');
  }
  log('[ERROR] npm 依赖仍不满足: ' + problems.map((p) => p.name).join(', '));
  log('        可手动执行: npm install --no-package-lock');
  return false;
}

// ---------- Lua (pinned version) ----------

// Synchronous sleep (the Node main thread allows Atomics.wait)
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Ignore unsupported edge environments, we simply skip waiting
  }
}

// Probe the Lua version.
// A single probe failing is common: a freshly downloaded exe may be under
// anti-virus scan, the disk may be busy, or the file handle may be locked,
// all of which slow the process down or make it fail outright. With one
// short-timeout attempt that failure would be misread as "no Lua detected",
// trigger a re-download and potentially abort startup. Hence several retries
// with a generous timeout; only consecutive failures count as unusable.
const LUA_PROBE_TIMEOUT_MS = 15000;
const LUA_PROBE_ATTEMPTS = 3;

function probeLuaVersion(exe) {
  for (let attempt = 1; attempt <= LUA_PROBE_ATTEMPTS; attempt++) {
    try {
      const out = execFileSync(exe, ['-e', 'io.write(_VERSION)'], {
        encoding: 'utf8',
        timeout: LUA_PROBE_TIMEOUT_MS,
        windowsHide: true,
      }).trim();
      if (out) return out;
    } catch {
      // Treat as a transient failure, retry later
    }
    if (attempt < LUA_PROBE_ATTEMPTS) sleepMs(400);
  }
  return '';
}

function findLua() {
  const candidates = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'settings.json'), 'utf8'));
    if (settings.luaExe) candidates.push(settings.luaExe);
  } catch {}
  const names = process.platform === 'win32'
    ? ['lua5.3.exe', 'lua53.exe', 'lua5.4.exe', 'lua54.exe', 'lua.exe']
    : ['lua5.3', 'lua53', 'lua5.4', 'lua54', 'lua'];
  for (const n of names) candidates.push(n);
  for (const c of candidates) {
    const v = probeLuaVersion(c);
    if (v) return { exe: c, version: v };
  }
  return null;
}

async function ensureLua() {
  const found = findLua();
  if (found && isUsableLuaVersion(found.version)) {
    log(`[OK] ${found.version}`);
    return true;
  }
  if (found) {
    log(`[WARN] Lua 版本过低: 当前 ${found.version}, 需要 Lua 5.3 或 5.4`);
  } else {
    // Tell "not installed" apart from "file present but not runnable": the latter
    // is usually a temporary anti-virus / other-process lock, and reporting it
    // avoids misreading the case as "no Lua detected".
    let configuredExists = false;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'settings.json'), 'utf8'));
      configuredExists = !!(s.luaExe && fs.existsSync(s.luaExe));
    } catch { /* ignore */ }
    if (configuredExists) {
      log('[WARN] 已配置的 Lua 存在但无法运行 (可能被占用或拦截), 将尝试重新安装。');
    } else {
      log('[INFO] 未检测到 Lua 解释器');
    }
  }

  log('[INFO] 正在准备 Lua 5.3 (Termux 使用系统包管理器安装, 其他平台自动下载/编译) ...');
  let result;
  try {
    const { ensureLua: installLua } = require(path.join(PROJECT_DIR, 'lib', 'setupLua.js'));
    result = await installLua(found ? found.exe : '');
  } catch (e) {
    log('[ERROR] Lua 安装过程出错: ' + e.message);
    return false;
  }
  if (result && result.message) log('[setupLua] ' + result.message);
  if (!result || !result.ok) {
    log('[ERROR] Lua 自动安装失败, 请手动安装 Lua 5.3。');
    return false;
  }
  const check = findLua();
  if (check && isUsableLuaVersion(check.version)) {
    log(`[OK] ${check.version}`);
    return true;
  }
  log('[ERROR] Lua 安装后版本校验失败。');
  return false;
}

// ---------- entry point ----------
(async () => {
  log('');
  log('[INFO] 检查运行依赖 (npm / Lua)...');
  if (!await ensurePrepScripts()) {
    log('[ERROR] 启动脚本缺失且无法恢复, 请检查网络后重试, 或重新克隆仓库。');
    process.exit(1);
  }
  const okNpm = await ensureNpmDeps();
  if (!okNpm) process.exit(1);
  const okLua = await ensureLua();
  if (!okLua) process.exit(1);
  log('[OK] 运行依赖检查完成。');
  process.exit(0);
})();
