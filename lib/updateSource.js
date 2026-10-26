// ============================================================
// updateSource.js - 选择更快的更新源 (GitHub / Gitee)
//
// 首次运行会同时探测两个源的响应时间, 选择更快的一个并写入
// cache/update-source.json; 之后启动直接复用该结果, 不再测速。
//
// 所有网络与 git 操作都带超时: 网络较慢或不可达时跳过更新,
// 不影响服务器正常启动。
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.dirname(__dirname);
const CACHE_DIR = path.join(PROJECT_DIR, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'update-source.json');

const SOURCES = {
  github: {
    label: 'GitHub',
    probe: 'https://raw.githubusercontent.com/zip132sy/OC-Emulator/main/package.json',
  },
  gitee: {
    label: 'Gitee',
    probe: 'https://gitee.com/zip132sy/OC-Emulator/raw/main/package.json',
  },
};

const PROBE_TIMEOUT = 5000;
const PULL_TIMEOUT = 20000;
const FALLBACK_PULL_TIMEOUT = 15000;

// git 可能没有加入 PATH (例如只装了 Git for Windows 的默认安装),
// Windows 下按常见安装位置查找一次。
let gitExe = null;
function resolveGit() {
  if (gitExe) return gitExe;
  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        gitExe = candidate;
        return gitExe;
      }
    }
  }
  gitExe = 'git';
  return gitExe;
}

function git(args, timeout = 15000) {
  const r = spawnSync(resolveGit(), args, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    ok: r.status === 0,
    status: r.status,
    timedOut: !!(r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ABORT_ERR')),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data && SOURCES[data.source]) return data;
  } catch {
    /* 缓存不存在或损坏时重新测速 */
  }
  return null;
}

function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 缓存写入失败不影响本次更新 */
  }
}

// 读取 git 远端名, 按 URL 归到 github / gitee
function detectRemotes() {
  const out = { github: null, gitee: null };
  const r = git(['remote', '-v'], 5000);
  if (!r.ok) return out;
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    const url = m[2];
    if (!out.github && /github\.com/i.test(url)) out.github = name;
    if (!out.gitee && /gitee\.com/i.test(url)) out.gitee = name;
  }
  return out;
}

function probe(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 3) {
      resolve({ ok: false, ms: Infinity });
      return;
    }
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.get(url, {
      timeout: PROBE_TIMEOUT,
      headers: { 'User-Agent': 'OC-Emulator/2.0' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        done({ ok: false, ms: Infinity, redirect: next });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done({ ok: false, ms: Infinity });
        return;
      }
      res.on('data', () => {});
      res.on('end', () => done({ ok: true, ms: Date.now() - started }));
      res.on('error', () => done({ ok: false, ms: Infinity }));
    });
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, ms: Infinity });
    });
    req.on('error', () => done({ ok: false, ms: Infinity }));
  });
}

async function probeSource(key) {
  const first = await probe(SOURCES[key].probe);
  if (first.redirect) return probe(first.redirect, 1);
  return first;
}

// 选择更新源。force=true 时忽略缓存重新测速。
async function pickSource({ force = false, log = () => {} } = {}) {
  const remotes = detectRemotes();
  const cache = readCache();

  if (!force && cache) {
    const remote = remotes[cache.source] || cache.remote || null;
    if (remote) {
      log(`[update] 使用上次测速结果: ${SOURCES[cache.source].label}`);
      return { source: cache.source, remote, remotes, cached: true, timings: cache.timings || {} };
    }
  }

  log('[update] 正在测速: GitHub / Gitee ...');
  const results = await Promise.all(Object.keys(SOURCES).map(async (key) => ({
    key,
    ...(await probeSource(key)),
  })));

  const timings = {};
  for (const r of results) {
    timings[r.key] = r.ok ? r.ms : null;
    log(`[update] ${SOURCES[r.key].label}: ${r.ok ? `${r.ms} ms` : '不可达'}`);
  }

  const reachable = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  if (reachable.length === 0) {
    log('[update] 两个更新源均不可达, 跳过自动更新');
    return { source: null, remote: null, remotes, cached: false, timings };
  }

  const best = reachable[0].key;
  const remote = remotes[best] || null;
  writeCache({
    source: best,
    remote,
    checkedAt: new Date().toISOString(),
    timings,
  });
  log(`[update] 使用更快的更新源: ${SOURCES[best].label}`);
  return { source: best, remote, remotes, cached: false, timings };
}

function currentBranch() {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
  const branch = r.ok ? r.stdout.trim() : '';
  return branch && branch !== 'HEAD' ? branch : 'main';
}

// 按选定源拉取, 失败时再试另一个源; 全部失败或超时都只记录日志。
function pullUpdate(picked, { log = () => {} } = {}) {
  if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) {
    log('[update] 不是 git 仓库, 跳过自动更新');
    return { ok: false, skipped: true };
  }

  const remotes = (picked && picked.remotes) || detectRemotes();
  const order = [];
  if (picked && picked.source && picked.remote) {
    order.push({ key: picked.source, remote: picked.remote, timeout: PULL_TIMEOUT });
  }
  if (picked && picked.source === 'gitee' && remotes.github) {
    order.push({ key: 'github', remote: remotes.github, timeout: FALLBACK_PULL_TIMEOUT });
  }
  if (picked && picked.source === 'github' && remotes.gitee) {
    order.push({ key: 'gitee', remote: remotes.gitee, timeout: FALLBACK_PULL_TIMEOUT });
  }

  if (order.length === 0) {
    log('[update] 未找到可用远端, 跳过自动更新');
    return { ok: false, skipped: true };
  }

  const branch = currentBranch();
  for (const item of order) {
    log(`[update] 从 ${SOURCES[item.key].label} 拉取 ...`);
    const r = git(['pull', '--ff-only', '--quiet', item.remote, branch], item.timeout);
    if (r.ok) {
      log('[update] 更新检查完成');
      return { ok: true, remote: item.remote };
    }
    const why = r.timedOut ? ' (超时)' : '';
    log(`[update] ${SOURCES[item.key].label} 拉取失败${why}`);
  }

  log('[update] 自动更新失败 (已跳过, 继续启动)');
  return { ok: false };
}

if (require.main === module) {
  (async () => {
    const picked = await pickSource({
      force: process.argv.includes('--refresh'),
      log: console.log,
    });
    if (picked.source) pullUpdate(picked, { log: console.log });
    process.exit(0);
  })().catch((err) => {
    console.error('[update] 检查失败 (已跳过):', err && err.message ? err.message : err);
    process.exit(0);
  });
}

module.exports = {
  SOURCES,
  CACHE_FILE,
  detectRemotes,
  pickSource,
  pullUpdate,
  readCache,
  writeCache,
};
