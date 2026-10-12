// ============================================================
// ensureDeps.js - 启动前依赖检查与安装
//
//   1. npm 依赖 (读取 package.json 的 dependencies, 校验已装版本)
//   2. Lua 解释器 (项目固定使用 5.3.x, 缺失或版本不符时自动安装 5.3.6)
//
// 行为:
//   - 依赖缺失        -> 直接安装
//   - 依赖版本不符    -> 询问用户是否重新安装
//   - Lua (固定版本)  -> 不做询问, 直接安装固定版本
//   - 全部就绪退出码 0, 否则退出码 1 (启动脚本据此决定是否启动)
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, execSync } = require('child_process');

const PROJECT_DIR = path.dirname(__dirname);
const LUA_FIXED_PREFIX = 'Lua 5.3';

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

// 简化的版本满足判断: 比较主版本, 次版本不小于要求即可 (足以覆盖 ^x.y.z / x.y.z)
function satisfies(version, range) {
  if (!version) return false;
  const want = String(range).replace(/[^0-9.]/g, '').split('.').filter(Boolean).map(Number);
  const have = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  if (want.length === 0 || Number.isNaN(want[0])) return true; // 无法解析的范围视为满足
  if (have[0] !== want[0]) return false;
  return have[1] >= (want[1] || 0);
}

// ---------- npm 依赖 ----------
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

function runNpmInstall() {
  // 显示 npm 自身输出 (含进度); Windows 上 npm 是 .cmd, 需要 shell
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
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      runNpmInstall();
    } catch (e) {
      log(`[WARN] npm install 失败 (第 ${attempt}/2 次): ${e.message}`);
    }
    problems = checkNpmDeps();
    if (problems.length === 0) {
      log('[OK] npm 依赖安装完成');
      return true;
    }
    if (attempt < 2) log('[INFO] 重试中...');
  }
  log('[ERROR] npm 依赖仍不满足: ' + problems.map((p) => p.name).join(', '));
  log('        可手动执行: npm install');
  return false;
}

// ---------- Lua (固定版本) ----------

// 同步休眠 (Node 主线程允许 Atomics.wait)
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 极端环境不支持时忽略, 只是不再等待
  }
}

// 探测 Lua 版本。
// 单次探测偶发失败是很常见的现象: 刚下载的 exe 正被杀毒软件扫描、磁盘繁忙、
// 文件句柄被占用等, 都会让进程启动变慢甚至直接失败。原来只探测一次而且超时
// 只有 5 秒, 一次失败就会被误判成"未检测到 Lua", 进而触发重新下载, 严重时
// 直接导致启动失败。这里改为重试多次 + 放宽超时, 只有连续失败才认定不可用。
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
      // 视为瞬时失败, 稍后重试
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
    ? ['lua5.3.exe', 'lua53.exe', 'lua.exe']
    : ['lua5.3', 'lua53', 'lua'];
  for (const n of names) candidates.push(n);
  for (const c of candidates) {
    const v = probeLuaVersion(c);
    if (v) return { exe: c, version: v };
  }
  return null;
}

async function ensureLua() {
  const found = findLua();
  if (found && found.version.startsWith(LUA_FIXED_PREFIX)) {
    log(`[OK] ${found.version} (固定版本)`);
    return true;
  }
  if (found) {
    log(`[WARN] Lua 版本不符: 当前 ${found.version}, 需要固定版本 ${LUA_FIXED_PREFIX}.x`);
  } else {
    // 区分"确实没装"和"有文件但跑不起来": 后者多半是被杀毒软件/其他程序暂时占用,
    // 提示出来可以避免被误判成"未检测到 Lua"。
    let configuredExists = false;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'settings.json'), 'utf8'));
      configuredExists = !!(s.luaExe && fs.existsSync(s.luaExe));
    } catch { /* 忽略 */ }
    if (configuredExists) {
      log('[WARN] 已配置的 Lua 存在但无法运行 (可能被占用或拦截), 将尝试重新安装。');
    } else {
      log('[INFO] 未检测到 Lua 解释器');
    }
  }

  log('[INFO] 正在下载并安装固定版本 Lua 5.3.6 ...');
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
  if (check && check.version.startsWith(LUA_FIXED_PREFIX)) {
    log(`[OK] ${check.version}`);
    return true;
  }
  log('[ERROR] Lua 安装后版本校验失败。');
  return false;
}

// ---------- 入口 ----------
(async () => {
  log('');
  log('[INFO] 检查运行依赖 (npm / Lua)...');
  const okNpm = await ensureNpmDeps();
  if (!okNpm) process.exit(1);
  const okLua = await ensureLua();
  if (!okLua) process.exit(1);
  log('[OK] 运行依赖检查完成。');
  process.exit(0);
})();
