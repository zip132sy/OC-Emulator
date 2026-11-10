// ============================================================
// lib/modTransfer.js - Mods device export / import / network download
//
// Export: packs Mods/<name>/ into a zip (frontend triggers the download).
// Import: unpacks the zip, validates mod.json, writes it to Mods/<name>/ and
//         hands over to modsManager.provision() to fill in missing files.
// Download: supports direct zip links as well as GitHub / Gitee repo URLs
//         (resolves the default branch and fetches the archive zip).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { zipEntries, unzipEntries } = require('./zip');

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;    // download cap: 64MB
const MAX_EXTRACT_BYTES = 256 * 1024 * 1024;    // extracted total cap: 256MB
const MAX_EXTRACT_FILES = 2000;                 // file count cap
const DOWNLOAD_TIMEOUT_MS = 30000;              // per-request timeout
const MAX_REDIRECTS = 5;

// ---------- export ----------
// Pack every file under modDir into a zip Buffer (relative paths, "/" separators).
function buildModZip(modDir) {
  const entries = [];
  (function walk(dir, rel) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      const relPath = rel ? rel + '/' + item.name : item.name;
      if (item.isDirectory()) {
        walk(abs, relPath);
      } else if (item.isFile()) {
        const st = fs.statSync(abs);
        entries.push({ name: relPath, data: fs.readFileSync(abs), mtime: st.mtime });
      }
    }
  })(modDir, '');
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return zipEntries(entries);
}

// ---------- import ----------
// Validate an extraction target path to block directory traversal.
function safeJoin(root, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return null;
  const abs = path.join(root, ...parts);
  const rootAbs = path.resolve(root);
  if (!path.resolve(abs).startsWith(rootAbs + path.sep)) return null;
  return abs;
}

// Locate the mod.json prefix among the entries:
//   * mod.json directly at the root -> prefix ''
//   * all entries share one top-level directory that holds mod.json -> '<top>/'
//     (the layout of GitHub / Gitee repository archive zips)
// Anything else is an error.
function findPrefix(entries) {
  if (entries.some((e) => !e.isDir && e.name === 'mod.json')) return '';
  const tops = new Set();
  for (const e of entries) {
    const seg = e.name.replace(/\\/g, '/').split('/')[0];
    if (seg) tops.add(seg);
  }
  if (tops.size === 1) {
    const top = [...tops][0];
    if (entries.some((e) => !e.isDir && e.name === top + '/mod.json')) return top + '/';
  }
  return null;
}

// Import one Mod from a zip Buffer. When requestedName is empty, the name in
// mod.json is used. Returns the imported device name. Throws when the target
// directory already exists or the zip is invalid.
function importModFromZip(zipBuf, modsManager, requestedName) {
  const entries = unzipEntries(zipBuf);
  const prefix = findPrefix(entries);
  if (prefix === null) {
    throw new Error('ZIP 中找不到 mod.json (需位于根目录或唯一顶层目录内)');
  }

  // Parse mod.json for the default name
  const metaEntry = entries.find((e) => !e.isDir && e.name === prefix + 'mod.json');
  let meta = {};
  try {
    meta = JSON.parse(metaEntry.data.toString('utf8'));
  } catch (e) {
    throw new Error('mod.json 不是有效的 JSON');
  }

  const name = String(requestedName || meta.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error('设备名称无效 (1-32 位字母 / 数字 / _ / -)');
  }
  const destDir = modsManager.modDir(name);
  if (fs.existsSync(destDir)) {
    throw new Error(`已存在同名设备: ${name}`);
  }

  // Extract into a temp directory first and move it in one go, so a failure
  // midway cannot leave half a device behind
  const tmpDir = path.join(modsManager.modsDir, `.importing-${process.pid}-${Date.now()}`);
  let fileCount = 0;
  let totalBytes = 0;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const entry of entries) {
      if (entry.isDir) continue;
      const rel = entry.name.slice(prefix.length);
      if (!rel) continue;
      const abs = safeJoin(tmpDir, rel);
      if (!abs) throw new Error('ZIP 内含非法路径: ' + entry.name);
      fileCount++;
      totalBytes += entry.data.length;
      if (fileCount > MAX_EXTRACT_FILES) throw new Error(`ZIP 内文件过多 (上限 ${MAX_EXTRACT_FILES})`);
      if (totalBytes > MAX_EXTRACT_BYTES) throw new Error('ZIP 解压后过大 (上限 256MB)');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.data);
    }
    if (!fs.existsSync(path.join(tmpDir, 'mod.json'))) {
      throw new Error('ZIP 中找不到 mod.json');
    }
    fs.renameSync(tmpDir, destDir);
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  // Fill in missing EFI / boot disk / config, and register machine-type devices on the bus
  modsManager.provision(name);
  return name;
}

// ---------- network download ----------
function fetchToBuffer(urlStr, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('URL 无效'));
      return;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      reject(new Error('仅支持 http/https 链接'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'OC-Emulator-ModDownloader', Accept: '*/*' },
        timeout: DOWNLOAD_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if ((redirectsLeft || 0) <= 0) {
            reject(new Error('重定向次数过多'));
            return;
          }
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error(`HTTP ${status}: 缺少重定向目标`));
            return;
          }
          resolve(fetchToBuffer(new URL(loc, urlStr).toString(), (redirectsLeft || 0) - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`下载失败: HTTP ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error('文件过大 (上限 64MB)'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

// Read the repository's default branch; fall back to main on failure.
async function defaultBranch(host, owner, repo) {
  const api = host === 'gitee.com'
    ? `https://gitee.com/api/v5/repos/${owner}/${repo}`
    : `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const buf = await fetchToBuffer(api, 2);
    const branch = (JSON.parse(buf.toString('utf8')) || {}).default_branch;
    if (typeof branch === 'string' && /^[\w./-]{1,100}$/.test(branch)) return branch;
  } catch (e) { /* fall back to main when the API is unavailable */ }
  return 'main';
}

// Normalize the user-supplied address into a direct zip link:
//   * direct links (containing .zip or /archive/) are used as is
//   * github.com/<owner>/<repo>[/tree/<branch>] -> archive zip
//   * gitee.com/<owner>/<repo>[/tree/<branch>] -> archive zip
async function resolveDownloadUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入下载地址');
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw new Error('URL 无效');
  }
  const host = u.hostname.replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);

  if (host === 'github.com' || host === 'gitee.com') {
    // /owner/repo or /owner/repo/tree/<branch>
    if (segs.length >= 2 && (segs.length === 2 || segs[2] === 'tree')) {
      const owner = encodeURIComponent(segs[0]);
      const repo = encodeURIComponent(segs[1].replace(/\.git$/, ''));
      const branch = segs[3] ? segs.slice(3).join('/') : null;
      const ref = branch || (await defaultBranch(host, segs[0], segs[1].replace(/\.git$/, '')));
      if (!/^[\w./-]{1,100}$/.test(ref)) throw new Error('分支名无效');
      return host === 'github.com'
        ? `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${ref}`
        : `https://gitee.com/${owner}/${repo}/repository/archive/${ref}.zip`;
    }
  }
  return raw;
}

module.exports = {
  buildModZip,
  importModFromZip,
  fetchToBuffer,
  resolveDownloadUrl,
  MAX_DOWNLOAD_BYTES,
};
