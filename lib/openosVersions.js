// ============================================================
// openosVersions.js - download an OpenOS release and build a disk image
//
// Only one OpenOS template ships with the project (disks/openos.ocd). Other
// releases are fetched on demand from the upstream loot directory, assembled
// into disks/openos-<version>.ocd and reused afterwards; nothing is bundled.
//
// Every file is verified against the version marker in lib/core/boot.lua, so a
// mirror that answers with a different release is rejected instead of producing
// a mixed image.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_DIR = path.dirname(__dirname);
const DISKS_DIR = path.join(PROJECT_DIR, 'disks');
const BUNDLED_IMAGE = path.join(DISKS_DIR, 'openos.ocd');

// Bases that serve the *same* release are listed together and tried per file.
// Never mix releases in one list: a fallback pointing at another version would
// silently assemble a mismatched disk.
const VERSIONS = [
  {
    id: '1.7.5',
    label: 'OpenOS 1.7.5',
    sources: [
      'https://gitee.com/Hansonspace/OpenComputers/raw/master-MC1.12/src/main/resources/assets/opencomputers/loot/openos/',
    ],
  },
  {
    id: '1.8.10',
    label: 'OpenOS 1.8.10',
    sources: [
      'https://raw.githubusercontent.com/MightyPirates/OpenComputers/master-MC1.12/src/main/resources/assets/opencomputers/loot/openos/',
    ],
  },
];

const FETCH_TIMEOUT = 20000;
const CONCURRENCY = 6;

function imagePath(id) {
  return path.join(DISKS_DIR, `openos-${id}.ocd`);
}

function listVersions() {
  return VERSIONS.map((v) => ({
    id: v.id,
    label: v.label,
    path: `openos-${v.id}.ocd`,
    cached: fs.existsSync(imagePath(v.id)),
  }));
}

// GET a text file, following redirects (Gitee bounces to raw.giteeusercontent.com)
function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) { reject(new Error('too many redirects')); return; }
    const req = https.get(url, { timeout: FETCH_TIMEOUT, headers: { 'User-Agent': 'OC-Emulator/2.1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchText(next, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchFromSources(sources, rel) {
  for (const base of sources) {
    try {
      return await fetchText(base + rel);
    } catch (e) {
      /* try the next mirror of the same release */
    }
  }
  return null;
}

// File list of the bundled template (the same names exist in 1.7.x / 1.8.x)
function manifestFrom(diskIO) {
  const info = diskIO.load(BUNDLED_IMAGE);
  return Object.keys(info.files).filter((k) => info.files[k].type === 'file');
}

// Download `id` and build disks/openos-<id>.ocd. onProgress(done, total) is called
// every few files so the UI can show a percentage.
async function build(id, { diskIO, onProgress = () => {} } = {}) {
  const version = VERSIONS.find((v) => v.id === id);
  if (!version) throw new Error(`unknown OpenOS version: ${id}`);
  const target = imagePath(version.id);
  const name = path.basename(target);
  if (fs.existsSync(target)) {
    return { ok: true, cached: true, path: name, label: version.label };
  }

  const manifest = manifestFrom(diskIO);
  const total = manifest.length;
  const files = {};
  const failed = [];
  let done = 0;
  const queue = manifest.slice();

  const worker = async () => {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      const text = await fetchFromSources(version.sources, key.slice(1));
      if (text === null) failed.push(key);
      else files[key] = { type: 'file', content: text, modified: Date.now() / 1000 };
      done++;
      if (done % 5 === 0 || done === total) onProgress(done, total);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failed.length > 0) {
    throw new Error(`无法下载 ${failed.length}/${total} 个文件 (例如 ${failed[0]})`);
  }

  // Make sure the mirror really served the requested release
  const boot = files['/lib/core/boot.lua'];
  const marker = boot && /_OSVERSION = "OpenOS ([0-9.]+)"/.exec(boot.content);
  if (!marker || marker[1] !== version.id) {
    throw new Error(`远端内容不是 OpenOS ${version.id} (检测到 ${marker ? marker[1] : '未知版本'})`);
  }

  const dirSet = new Set(['/']);
  for (const key of Object.keys(files)) {
    const parts = key.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) dirSet.add('/' + parts.slice(0, i).join('/'));
  }
  for (const dir of dirSet) {
    if (!files[dir]) files[dir] = { type: 'directory', modified: Date.now() / 1000 };
  }

  fs.mkdirSync(DISKS_DIR, { recursive: true });
  diskIO.save(target, { label: version.label, files, size: 4 * 1024 * 1024, tier: 3, locked: false });
  return { ok: true, cached: false, path: name, label: version.label, files: Object.keys(files).length };
}

module.exports = { VERSIONS, listVersions, build, imagePath };
