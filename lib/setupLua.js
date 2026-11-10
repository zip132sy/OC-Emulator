// ============================================================
// setupLua.js - Auto-download and install Lua 5.3
//
// When Lua is missing or the configured path is invalid,
// this module attempts to:
//   1. Download Lua 5.3 (prebuilt binary for Windows,
//      source tarball for Linux/macOS)
//   2. Extract/compile and install
//   3. Update settings.json with the new path
//   4. If installation fails, open the download folder
//      for the user to install manually
// ============================================================

const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn, spawnSync } = require('child_process');
const os = require('os');
const https = require('https');
const http = require('http');

const LUA_VERSION = '5.3.6';
const PROJECT_DIR = path.dirname(__dirname);

// Lua binaries for Windows (prebuilt)
// Source: https://sourceforge.net/projects/luabinaries/
const WIN_LUA_URLS = {
  x64: 'https://sourceforge.net/projects/luabinaries/files/5.3.6/Tools%20Executables/lua-5.3.6_Win64_bin.zip/download',
  x86: 'https://sourceforge.net/projects/luabinaries/files/5.3.6/Tools%20Executables/lua-5.3.6_Win32_bin.zip/download',
};

// Lua source tarballs (compiled on Linux/macOS). The official site times out on
// some networks, so mirrors are tried in order; the first success wins.
const LUA_SOURCE_URLS = [
  `https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz`,
  `https://github.com/lua/lua/archive/refs/tags/v${LUA_VERSION}.tar.gz`,
  `https://codeload.github.com/lua/lua/tar.gz/refs/tags/v${LUA_VERSION}`,
];

// ============================================================
// Download a file via HTTPS/HTTP with redirect support
// ============================================================
function downloadFile(url, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, {
      headers: { 'User-Agent': 'OC-Emulator/2.0' },
      timeout: 30000,
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
            process.stdout.write(`\r[setupLua] ${label} 下载中 ${pct}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
          }
        } else {
          const mb = Math.floor(received / 1048576);
          if (mb !== lastTick) {
            lastTick = mb;
            process.stdout.write(`\r[setupLua] ${label} 已下载 ${(received / 1048576).toFixed(1)} MB`);
          }
        }
      });
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (received > 0) process.stdout.write('\n');
          if (err) reject(err);
          else resolve(destPath);
        });
      });
      file.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Download timeout'));
    });
  });
}

// ============================================================
// Extract a ZIP file (Windows)
//
// Try several methods in turn; any one success is enough:
//   1. tar (bundled with Windows 10 1803+, most reliable)
//   2. PowerShell Expand-Archive (called by absolute path, no PATH dependency)
//   3. .NET ZipFile
//   4. 7z (if installed)
// Relying on "powershell" from PATH fails outright when the PowerShell
// directory is not on PATH ("'powershell' is not recognized..."), so the
// absolute path is used instead.
// ============================================================
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Escape for a PowerShell single-quoted string
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

  const candidates = [
    `tar -xf "${zipPath}" -C "${destDir}"`,
    `"${psExe}" -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(destDir)} -Force"`,
    `"${psExe}" -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${q(zipPath)},${q(destDir)},$true)"`,
    `7z x "${zipPath}" -o"${destDir}" -y`,
  ];

  for (const cmd of candidates) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 60000 });
      return true;
    } catch (e) {
      // Try the next method
    }
  }
  return false;
}

// ============================================================
// Extract a tar.gz file (Linux/macOS)
// ============================================================
function extractTarGz(tarPath, destDir) {
  try {
    execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'pipe', timeout: 30000 });
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// Compile Lua from source (Linux/macOS)
// ============================================================
function compileLua(sourceDir) {
  try {
    execSync(`cd "${sourceDir}" && make clean 2>/dev/null; make linux 2>/dev/null || make posix 2>/dev/null || make`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    const luaBin = path.join(sourceDir, 'src', 'lua');
    if (fs.existsSync(luaBin)) {
      // Install to /usr/local/bin
      try {
        execSync(`cp "${luaBin}" /usr/local/bin/lua5.3 && chmod +x /usr/local/bin/lua5.3`, { stdio: 'pipe' });
        return '/usr/local/bin/lua5.3';
      } catch (e) {
        // Try local install
        const localBin = path.join(os.homedir(), '.local', 'bin');
        fs.mkdirSync(localBin, { recursive: true });
        execSync(`cp "${luaBin}" "${localBin}/lua5.3" && chmod +x "${localBin}/lua5.3"`, { stdio: 'pipe' });
        return path.join(localBin, 'lua5.3');
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// Find lua executable in extracted folder
// ============================================================
function findLuaInDir(dir) {
  const candidates = [
    path.join(dir, 'lua53.exe'),
    path.join(dir, 'lua5.3.exe'),
    path.join(dir, 'lua.exe'),
    path.join(dir, 'lua53'),
    path.join(dir, 'lua5.3'),
    path.join(dir, 'lua'),
    path.join(dir, 'bin', 'lua53'),
    path.join(dir, 'bin', 'lua'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Search recursively
  function searchDir(d, depth) {
    if (depth > 3) return null;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isFile() && /^lua(d?5\.3|53|)\.(exe|elf)?$/i.test(entry.name)) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          const found = searchDir(fullPath, depth + 1);
          if (found) return found;
        }
      }
    } catch (e) {}
    return null;
  }
  return searchDir(dir, 0);
}

// ============================================================
// Open a folder in the file manager
// ============================================================
function openFolder(folderPath) {
  try {
    if (process.platform === 'win32') {
      execSync(`explorer.exe "${folderPath}"`, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync(`open "${folderPath}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${folderPath}"`, { stdio: 'ignore' });
    }
  } catch (e) {}
}

// ============================================================
// Update settings.json with new Lua path
// ============================================================
function updateSettings(luaPath) {
  const settingsPath = path.join(PROJECT_DIR, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {}
  settings.luaExe = luaPath;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

// ============================================================
// Lua interpreter discovery
//
// No which / where: minimal systems (e.g. Termux's bundled sh) may lack which,
// so the call fails with "which: not found" and is misread as "no Lua". Instead
// the executable is looked up in common install directories and on PATH, then
// its version is probed with <lua> -v.
//
// A single probe can fail transiently (anti-virus scan, busy disk, locked file
// handle), so each candidate is retried; only repeated failures count.
// ============================================================
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* ignore */ }
}

// Termux (Android) environment: PREFIX points at /data/data/com.termux/files/usr
function isTermux() {
  if (process.platform !== 'linux' && process.platform !== 'android') return false;
  if (/com\.termux/i.test(process.env.PREFIX || '')) return true;
  try {
    return fs.existsSync('/data/data/com.termux/files/usr/bin');
  } catch (e) {
    return false;
  }
}

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function luaCandidateNames() {
  return process.platform === 'win32'
    ? ['lua.exe', 'lua53.exe', 'lua5.3.exe', 'lua54.exe', 'lua5.4.exe', 'lua52.exe', 'lua51.exe']
    : ['lua', 'lua5.4', 'lua54', 'lua5.3', 'lua53', 'lua5.2', 'lua52', 'lua5.1', 'lua51'];
}

// Common install directories + PATH (deduplicated). Termux binaries live in
// $PREFIX/bin and that directory is not necessarily on the current process's
// PATH, so it is listed explicitly.
function luaSearchDirs() {
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  if (isTermux()) {
    add(process.env.PREFIX && path.join(process.env.PREFIX, 'bin'));
    add('/data/data/com.termux/files/usr/bin');
  }
  add(process.env.HOME && path.join(process.env.HOME, '.local', 'bin'));
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');
  add('/opt/homebrew/bin');
  add('/opt/local/bin');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) add(dir);
  return dirs;
}

function parseLuaVersion(output) {
  const m = /Lua\s+([\d.]+)/i.exec(output || '');
  return m ? m[1] : null;
}

// Accepted versions, kept in sync with ensureDeps: 5.3 / 5.4.
function isSupportedLuaVersion(output) {
  const version = parseLuaVersion(output);
  if (!version) return false;
  const major = parseInt(version.split('.')[0], 10);
  const minor = parseInt(version.split('.')[1] || '0', 10);
  return major > 5 || (major === 5 && minor >= 3);
}

function probeLuaVersionOutput(exe) {
  if (!exe) return '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = spawnSync(exe, ['-v'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      const out = ((result.stdout || '') + (result.stderr || '')).trim();
      if (out) return out;
    } catch (e) { /* treat as transient failure, retry later */ }
    if (attempt < 3) sleepMs(400);
  }
  return '';
}

function findExecutableByName(name) {
  if (!name) return null;
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isExecutableFile(name) ? name : null;
  }
  for (const dir of luaSearchDirs()) {
    const candidate = path.resolve(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function findLuaBinary() {
  const names = luaCandidateNames();
  const dirs = luaSearchDirs();
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.resolve(dir, name);
      if (!isExecutableFile(candidate)) continue;
      if (isSupportedLuaVersion(probeLuaVersionOutput(candidate))) return candidate;
    }
  }
  return null;
}

// ============================================================
// Locating the source directory: different mirrors extract to different top-level names
// ============================================================
function hasLuaSource(dir) {
  try {
    return fs.existsSync(path.join(dir, 'src', 'lua.c'))
      || fs.existsSync(path.join(dir, 'src', 'lua.h'));
  } catch (e) {
    return false;
  }
}

function findLuaSourceDir(root, depth = 0) {
  if (hasLuaSource(root)) return root;
  if (depth >= 3) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findLuaSourceDir(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// ============================================================
// Termux: install through the package manager instead of downloading from lua.org
// ============================================================
function installLuaWithPackageManager() {
  for (const pkg of ['lua53', 'lua']) {
    try {
      console.log(`[setupLua] Termux: 尝试 pkg install -y ${pkg} ...`);
      execSync(`pkg install -y ${pkg}`, { stdio: 'pipe', timeout: 180000, env: process.env });
    } catch (e) {
      console.log(`[setupLua] pkg install ${pkg} 未成功: ${e.message}`);
      continue;
    }
    const found = findLuaBinary();
    if (found) return found;
  }
  return null;
}

// ============================================================
// Main: Try to find/download/install Lua
// Returns: { ok: boolean, luaExe?: string, message: string }
// ============================================================
async function ensureLua(existingPath) {
  // 1. Path given in settings (may be a bare command name)
  const configured = findExecutableByName(existingPath);
  if (configured && isSupportedLuaVersion(probeLuaVersionOutput(configured))) {
    return { ok: true, luaExe: configured, message: `Lua found at configured path: ${configured}` };
  }

  // 2. Common install directories and PATH
  const found = findLuaBinary();
  if (found) {
    updateSettings(found);
    return { ok: true, luaExe: found, message: `Found Lua: ${found}` };
  }

  // 3. Termux: install with pkg (lua53 is 5.3.x, matching the pinned project version)
  if (isTermux()) {
    console.log('[setupLua] 未找到 Lua, 在 Termux 中尝试 pkg install lua53 ...');
    const installed = installLuaWithPackageManager();
    if (installed) {
      updateSettings(installed);
      console.log(`[setupLua] Lua installed: ${installed}`);
      return { ok: true, luaExe: installed, message: `Lua installed with pkg: ${installed}` };
    }
  }

  // 4. Auto-download
  const downloadDir = path.join(PROJECT_DIR, 'cache', 'lua-download');
  fs.mkdirSync(downloadDir, { recursive: true });

  console.log('[setupLua] Lua 5.3 not found. Attempting auto-download...');

  if (process.platform === 'win32') {
    // Windows: download prebuilt binaries
    const arch = process.arch === 'x64' ? 'x64' : 'x86';
    const url = WIN_LUA_URLS[arch] || WIN_LUA_URLS.x64;
    const zipPath = path.join(downloadDir, `lua-${LUA_VERSION}-win-${arch}.zip`);

    console.log(`[setupLua] Downloading from: ${url}`);
    try {
      await downloadFile(url, zipPath);
      console.log('[setupLua] Download complete. Extracting...');

      const extractDir = path.join(downloadDir, `lua-${LUA_VERSION}-win-${arch}`);
      if (!extractZip(zipPath, extractDir)) {
        // Try 7z
        try {
          execSync(`7z x "${zipPath}" -o"${extractDir}" -y`, { stdio: 'pipe' });
        } catch (e) {
          openFolder(downloadDir);
          return {
            ok: false,
            message: 'Failed to extract Lua zip. Please extract manually from the opened folder.',
          };
        }
      }

      const luaExe = findLuaInDir(extractDir);
      if (luaExe) {
        updateSettings(luaExe);
        console.log(`[setupLua] Lua installed: ${luaExe}`);
        return { ok: true, luaExe: luaExe, message: `Lua downloaded to: ${luaExe}` };
      }

      openFolder(downloadDir);
      return {
        ok: false,
        message: 'Lua binary not found in extracted archive. Please check the opened folder.',
      };
    } catch (e) {
      console.error(`[setupLua] Download failed: ${e.message}`);
      openFolder(downloadDir);
      return { ok: false, message: `Download failed: ${e.message}. Please download Lua 5.3 manually.` };
    }
  } else {
    // Linux/macOS: download source (mirror fallback) and compile
    const tarPath = path.join(downloadDir, `lua-${LUA_VERSION}.tar.gz`);

    let downloaded = false;
    for (const url of LUA_SOURCE_URLS) {
      try {
        console.log(`[setupLua] Downloading Lua ${LUA_VERSION} source: ${url}`);
        await downloadFile(url, tarPath);
        downloaded = true;
        break;
      } catch (e) {
        console.error(`[setupLua] Download failed (${url}): ${e.message}`);
        try { fs.unlinkSync(tarPath); } catch (err) { /* ignore */ }
      }
    }
    if (!downloaded) {
      openFolder(downloadDir);
      return {
        ok: false,
        message: isTermux()
          ? 'Lua download failed. Please run "pkg install lua53" in Termux, then retry.'
          : 'Lua download failed. Please install Lua 5.3 manually and set luaExe in settings.json.',
      };
    }

    console.log('[setupLua] Download complete. Extracting...');
    if (!extractTarGz(tarPath, downloadDir)) {
      return { ok: false, message: 'Failed to extract Lua source archive.' };
    }

    const sourceDir = findLuaSourceDir(downloadDir);
    if (!sourceDir) {
      return { ok: false, message: 'Lua source directory not found in the extracted archive.' };
    }

    console.log('[setupLua] Compiling Lua (this may take a minute)...');
    const installedPath = compileLua(sourceDir);
    if (installedPath) {
      updateSettings(installedPath);
      console.log(`[setupLua] Lua installed: ${installedPath}`);
      return { ok: true, luaExe: installedPath, message: `Lua compiled and installed to: ${installedPath}` };
    }

    openFolder(downloadDir);
    return {
      ok: false,
      message: 'Compilation failed. Please compile Lua manually from the opened folder.',
    };
  }
}

module.exports = { ensureLua, downloadFile, openFolder };
