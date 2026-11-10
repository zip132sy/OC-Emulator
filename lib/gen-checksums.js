// ============================================================
// gen-checksums.js - generate / verify SHA256SUMS
//
// Usage:
//   node lib/gen-checksums.js           generate SHA256SUMS
//   node lib/gen-checksums.js --check   verify current files against SHA256SUMS
//
// Each SHA256SUMS line uses the standard "<sha256>  <relative path>" format,
// confirming that downloaded files are intact (no corruption / tampering):
//   Linux / macOS : sha256sum -c SHA256SUMS
//   Windows       : same command in Git Bash (Git ships sha256sum)
//
// Note: re-run this script after any repository change to refresh SHA256SUMS,
//       otherwise users' verification will fail.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_DIR = path.dirname(__dirname);
const OUT_NAME = 'SHA256SUMS';
const OUT_PATH = path.join(PROJECT_DIR, OUT_NAME);

// Directory-walk exclusions (used when git is missing or the cwd is not a repo)
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'logs', 'vms', 'Mods', 'cache', 'docs', 'scripts',
  '.trae', '.trae-html-share-packages', '.vscode', '.idea', 'assets',
]);
const SKIP_FILES = new Set(['settings.json', '!PS_SCRIPT!', 'create-openos-disk.lua']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walk(dir, rel) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const child = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, child));
    else if (st.isFile()) out.push(child);
  }
  return out;
}

// Prefer git's list of tracked files, which is exactly the set shipped with the repo
function listTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files.map(toPosix);
  } catch (e) {
    // Fall back to a directory walk when git is unavailable
  }
  return walk(PROJECT_DIR, '');
}

function listForHashing() {
  return listTrackedFiles()
    .filter((f) => f !== OUT_NAME)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function generate() {
  const lines = [];
  let skipped = 0;
  for (const rel of listForHashing()) {
    const full = path.join(PROJECT_DIR, rel);
    if (!fs.existsSync(full)) {
      console.log('[跳过] 文件不存在: ' + rel);
      skipped++;
      continue;
    }
    lines.push(sha256(full) + '  ' + rel);
  }
  fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`[OK] 已生成 ${OUT_NAME}: ${lines.length} 个文件` + (skipped ? `, 跳过 ${skipped} 个` : ''));
}

function check() {
  if (!fs.existsSync(OUT_PATH)) {
    console.error(`[ERROR] 找不到 ${OUT_NAME}, 请先运行: node lib/gen-checksums.js`);
    process.exit(1);
  }
  const text = fs.readFileSync(OUT_PATH, 'utf8');
  let ok = 0;
  let mismatch = 0;
  let missing = 0;
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!m) continue;
    const hash = m[1];
    const rel = m[2];
    const full = path.join(PROJECT_DIR, rel);
    if (!fs.existsSync(full)) {
      console.log('[缺失] ' + rel);
      missing++;
      continue;
    }
    if (sha256(full) === hash) {
      ok++;
    } else {
      console.log('[不一致] ' + rel);
      mismatch++;
    }
  }
  console.log(`[结果] 一致 ${ok}, 不一致 ${mismatch}, 缺失 ${missing}`);
  process.exit(mismatch || missing ? 1 : 0);
}

if (process.argv.includes('--check')) check();
else generate();
