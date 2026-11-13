// ============================================================
// diskCatalog.js - online repository with ready-made system disks
//
// Other OpenOS releases and systems such as MineOS / FuchasOS are published as
// prebuilt .ocd images in a separate repository (index.json + disks/*.ocd).
// This module fetches that index, caches it, and downloads a selected image into
// disks/ with progress. Nothing from the repository is bundled with the emulator.
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PROJECT_DIR = path.dirname(__dirname);
const DISKS_DIR = path.join(PROJECT_DIR, 'disks');
const CACHE_DIR = path.join(PROJECT_DIR, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'disk-catalog.json');

// Mirrors of the same repository; the first reachable one wins
const SOURCES = [
  {
    key: 'github',
    base: 'https://raw.githubusercontent.com/zip132sy/OC-Emulator-Disks/main/',
  },
  {
    key: 'gitee',
    base: 'https://gitee.com/zip132sy/OC-Emulator-Disks/raw/main/',
  },
];

const FETCH_TIMEOUT = 20000;
const DOWNLOAD_TIMEOUT = 120000;

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data && Array.isArray(data.disks)) return data;
  } catch (e) { /* missing or corrupt: refetch */ }
  return null;
}

function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* a failed cache write must not break the listing */ }
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) { reject(new Error('too many redirects')); return; }
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { timeout: FETCH_TIMEOUT, headers: { 'User-Agent': 'OC-Emulator/2.1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        request(next, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchText(url) {
  const res = await request(url);
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// Download a file and report progress as (received, total) with total possibly 0
async function download(url, dest, onProgress) {
  const res = await request(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let received = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    res.pipe(out);
    out.on('finish', () => out.close((err) => (err ? reject(err) : resolve(received))));
    out.on('error', reject);
    res.on('error', reject);
  });
}

function decorate(entries) {
  return entries.map((d) => ({
    file: d.file,
    label: d.label || d.file,
    system: d.system || '',
    version: d.version || '',
    size: Number(d.size) || 0,
    sha256: d.sha256 || '',
    installed: fs.existsSync(path.join(DISKS_DIR, d.file)),
  }));
}

// Fetch the catalog; falls back to the cached copy when every mirror fails
async function list() {
  let error = '';
  for (const source of SOURCES) {
    try {
      const raw = await fetchText(source.base + 'index.json');
      const catalog = JSON.parse(raw);
      if (!catalog || !Array.isArray(catalog.disks)) throw new Error('invalid index.json');
      writeCache({ base: source.base, fetchedAt: new Date().toISOString(), disks: catalog.disks });
      return { ok: true, stale: false, disks: decorate(catalog.disks) };
    } catch (e) {
      error = e.message;
    }
  }
  const cached = readCache();
  if (cached) return { ok: true, stale: true, error, disks: decorate(cached.disks) };
  return { ok: false, stale: false, error: error || 'catalog unavailable', disks: [] };
}

// Download one catalog entry into disks/. The checksum from the index is enforced.
async function install(entry, { onProgress = () => {} } = {}) {
  const file = String(entry && entry.file || '');
  if (!/^[A-Za-z0-9._-]+\.ocd$/.test(file)) throw new Error('invalid disk file name');
  const dest = path.join(DISKS_DIR, file);
  if (fs.existsSync(dest)) return { ok: true, cached: true, path: file };

  fs.mkdirSync(DISKS_DIR, { recursive: true });
  const tmp = dest + '.part';
  let lastError = '';
  for (const source of SOURCES) {
    try {
      const bytes = await download(source.base + 'disks/' + file, tmp, onProgress);
      if (entry.sha256) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        if (hash !== entry.sha256) throw new Error('checksum mismatch');
      }
      fs.renameSync(tmp, dest);
      return { ok: true, cached: false, path: file, size: bytes };
    } catch (e) {
      lastError = e.message;
      try { fs.rmSync(tmp, { force: true }); } catch (err) { /* ignore */ }
    }
  }
  throw new Error(lastError || 'download failed');
}

module.exports = { SOURCES, list, install };
