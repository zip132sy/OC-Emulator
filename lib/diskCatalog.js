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
// EFI (EEPROM boot programs) shipped alongside a disk live in a subfolder so the
// disk-template scan in server.js (top-level *.ocd only) ignores them.
const EEPROM_DIR = path.join(DISKS_DIR, 'eeprom');
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
    const req = mod.get(url, { timeout: FETCH_TIMEOUT, headers: { 'User-Agent': 'OC-Emulator/2.2.3' } }, (res) => {
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

// EFI files are stored next to the disk they belong to: <disk base>.efi
function efiFileName(diskFile) {
  return String(diskFile || '').replace(/\.ocd$/i, '') + '.efi';
}

function efiPath(diskFile) {
  return path.join(EEPROM_DIR, efiFileName(diskFile));
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
    // Optional EEPROM boot program published with the disk (Fuchas / MineOS)
    efi: d.efi && d.efi.file
      ? {
        file: efiFileName(d.file),
        size: Number(d.efi.size) || 0,
        sha256: d.efi.sha256 || '',
        installed: fs.existsSync(efiPath(d.file)),
      }
      : null,
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

// Download one catalog entry into disks/, plus its EFI when the entry has one.
// The checksums from the index are enforced for both files.
async function install(entry, { onProgress = () => {}, force = false } = {}) {
  const file = String(entry && entry.file || '');
  if (!/^[A-Za-z0-9._-]+\.ocd$/.test(file)) throw new Error('invalid disk file name');
  const dest = path.join(DISKS_DIR, file);
  // force = download again even when the image is already present
  let cached = !force && fs.existsSync(dest);
  let size = 0;

  if (!cached) {
    fs.mkdirSync(DISKS_DIR, { recursive: true });
    const tmp = dest + '.part';
    const errors = [];
    let downloaded = false;
    for (const source of SOURCES) {
      try {
        size = await download(source.base + 'disks/' + file, tmp, onProgress);
        verifyFile(tmp, entry);
        // Replace only after the new copy passed every check, so a failed
        // re-download leaves the existing image untouched.
        if (fs.existsSync(dest)) fs.rmSync(dest);
        fs.renameSync(tmp, dest);
        cached = false;
        downloaded = true;
        break;
      } catch (e) {
        errors.push(e.message);
        try { fs.rmSync(tmp, { force: true }); } catch (err) { /* ignore */ }
      }
    }
    if (!downloaded) {
      // A failed integrity check is more useful than a later mirror's timeout
      const verifyError = errors.find((m) => /校验|大小不符|不是有效|清单缺少/.test(m));
      throw new Error(verifyError || errors[errors.length - 1] || 'download failed');
    }
  }

  const efi = await installEfi(entry, { force });
  return {
    ok: true,
    cached,
    path: file,
    size: size || fs.statSync(dest).size,
    ...(efi ? { efi } : {}),
  };
}

// Download the EEPROM boot program published with a disk (optional).
async function installEfi(entry, { force = false } = {}) {
  const decl = entry && entry.efi;
  if (!decl || !decl.file) return null;
  const file = efiFileName(entry.file);
  if (!/^[A-Za-z0-9._-]+\.efi$/i.test(file)) throw new Error('invalid efi file name');
  const dest = efiPath(entry.file);
  const rel = 'eeprom/' + file;
  if (!force && fs.existsSync(dest)) return { ok: true, cached: true, path: rel };

  fs.mkdirSync(EEPROM_DIR, { recursive: true });
  const tmp = dest + '.part';
  const errors = [];
  for (const source of SOURCES) {
    try {
      const bytes = await download(source.base + 'efi/' + decl.file, tmp);
      verifyEfi(tmp, decl);
      if (fs.existsSync(dest)) fs.rmSync(dest);
      fs.renameSync(tmp, dest);
      return { ok: true, cached: false, path: rel, size: bytes };
    } catch (e) {
      errors.push(e.message);
      try { fs.rmSync(tmp, { force: true }); } catch (err) { /* ignore */ }
    }
  }
  const verifyError = errors.find((m) => /校验|大小不符|不是有效|清单缺少/.test(m));
  throw new Error('EFI ' + (verifyError || errors[errors.length - 1] || 'download failed'));
}

// Post-download integrity check: size and sha256 from index.json plus the ODCISK
// header, so a truncated or swapped image never reaches disks/.
function verifyFile(file, entry) {
  const stat = fs.statSync(file);
  if (entry.size && stat.size !== Number(entry.size)) {
    throw new Error(`大小不符 (清单 ${entry.size} B, 实际 ${stat.size} B)`);
  }
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.subarray(0, 6).toString('ascii') !== 'OCDISK') {
    throw new Error('不是有效的 .ocd 磁盘镜像');
  }
  if (entry.sha256) {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== String(entry.sha256).toLowerCase()) {
      throw new Error('sha256 校验失败 (文件已损坏)');
    }
  } else if (!entry.size) {
    throw new Error('清单缺少大小与哈希, 无法校验');
  }
  return true;
}

// EFI images are plain Lua text (max 4 KB), so only size and checksum apply.
function verifyEfi(file, entry) {
  const stat = fs.statSync(file);
  if (entry.size && stat.size !== Number(entry.size)) {
    throw new Error(`大小不符 (清单 ${entry.size} B, 实际 ${stat.size} B)`);
  }
  if (!entry.sha256) {
    throw new Error('清单缺少大小与哈希, 无法校验');
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== String(entry.sha256).toLowerCase()) {
    throw new Error('sha256 校验失败 (文件已损坏)');
  }
  return true;
}

module.exports = { SOURCES, list, install, efiFileName, efiPath };
