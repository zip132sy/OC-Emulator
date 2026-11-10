// ============================================================
// repair.js - pre-start self-check of dependency files with online repair
//
// When a hard dependency file is missing (accidentally deleted / corrupted /
// incompletely transferred), the original is fetched from the remote repository
// so the program can usually start without a fresh clone.
// Remote sources: GitHub raw (first) -> Gitee raw (fallback)
//
// Exit codes: 0 = everything ready; 1 = some files could not be restored
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PROJECT_DIR = path.dirname(__dirname);

const SOURCES = [
  'https://raw.githubusercontent.com/zip132sy/OC-Emulator/main/',
  'https://gitee.com/zip132sy/OC-Emulator/raw/main/',
];

// Hard dependency list: without these the program cannot run normally
const REQUIRED = [
  'package.json',
  'server.js',
  'oc-emulator.lua',
  'mods.lua',
  'mods-efi.lua',
  'machine-host.lua',
  'disk.lua',
  'json.lua',
  'lua_check.lua',
  'lib/crypto-helper.js',
  'lib/deviceBus.js',
  'lib/diskIO.js',
  'lib/ensureDeps.js',
  'lib/floppyTemplates.js',
  'lib/internetProxy.js',
  'lib/luaCheck.js',
  'lib/modemHub.js',
  'lib/modsManager.js',
  'lib/machineHost.js',
  'lib/reactor.js',
  'lib/setupLua.js',
  'lib/startupPrep.js',
  'lib/sysInfo.js',
  'lib/updateSource.js',
  'lib/vmManager.js',
  'web/index.html',
  'web/styles.css',
  'web/i18n.js',
  'web/app.js',
  'web/console.js',
  'web/diskEditor.js',
  'web/errorReporter.js',
  'web/exportWizard.js',
  'web/modView.js',
  'web/reactorView.js',
  'web/machineView.js',
  'web/wizard.js',
  'web/fonts/font.hex',
  'web/fonts/unifont.ttf',
  'disks/openos.ocd',
];

function log(...a) { console.log(...a); }

// Download with redirect and progress display (avoiding external commands as much as possible)
function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error('too many redirects')); return; }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'OC-Emulator/2.0' }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        downloadFile(next, destPath, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastTick = -1;
      const label = path.basename(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastTick) {
            lastTick = pct;
            process.stdout.write(`\r[repair] ${label} 下载中 ${pct}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
          }
        }
      });
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (received > 0) process.stdout.write('\n');
          if (err) reject(err); else resolve();
        });
      });
      file.on('error', reject);
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

async function restore(rel) {
  const abs = path.join(PROJECT_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.part';
  for (const base of SOURCES) {
    try {
      await downloadFile(base + rel, tmp);
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch {}
        fs.renameSync(tmp, abs);
        return true;
      }
    } catch (e) {
      // Try the next source
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  return false;
}

(async () => {
  const missing = REQUIRED.filter((rel) => !isPresent(rel));
  if (missing.length === 0) {
    log('[OK] 依赖文件完整');
    process.exit(0);
  }

  log(`[WARN] 检测到 ${missing.length} 个依赖文件缺失, 正在尝试联网修复...`);
  const failed = [];
  for (const rel of missing) {
    const ok = await restore(rel);
    if (ok) log(`[OK] 已恢复: ${rel}`);
    else { failed.push(rel); log(`[ERROR] 修复失败: ${rel}`); }
  }

  if (failed.length > 0) {
    log('[ERROR] 以下文件未能恢复, 请检查网络后重试, 或重新克隆仓库:');
    for (const f of failed) log('        - ' + f);
    process.exit(1);
  }

  log('[OK] 依赖文件修复完成');
  process.exit(0);
})();
