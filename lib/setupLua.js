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
const { exec, execSync, spawn } = require('child_process');
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

// Lua source tarball (for Linux/macOS compilation)
const LUA_SOURCE_URL = `https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz`;

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
      timeout: 60000,
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
// 依次尝试多种方式, 只要有一种成功即可:
//   1. tar (Windows 10 1803+ 自带, 最稳定)
//   2. PowerShell Expand-Archive (用绝对路径调用, 不依赖 PATH)
//   3. .NET ZipFile
//   4. 7z (若已安装)
// 早期版本只调用 `powershell`, 在 PATH 未包含 PowerShell 目录时会
// 直接报 "powershell 不是内部或外部命令", 导致解压失败。
// ============================================================
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // PowerShell 单引号字符串转义
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
      // 尝试下一种方式
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
// Main: Try to find/download/install Lua 5.3
// Returns: { ok: boolean, luaExe?: string, message: string }
// ============================================================
async function ensureLua(existingPath) {
  // 1. Check if existing path works
  if (existingPath && fs.existsSync(existingPath)) {
    try {
      const ver = execSync(`"${existingPath}" -v 2>&1`, { encoding: 'utf8', timeout: 5000 });
      if (ver.includes('5.3')) {
        return { ok: true, luaExe: existingPath, message: 'Lua found at configured path.' };
      }
    } catch (e) {}
  }

  // 2. Check PATH
  const pathCandidates = process.platform === 'win32'
    ? ['lua5.3.exe', 'lua53.exe', 'lua.exe', 'luac5.3.exe', 'luac53.exe']
    : ['lua5.3', 'lua53', 'lua'];

  for (const candidate of pathCandidates) {
    try {
      const ver = execSync(`${candidate} -v 2>&1`, { encoding: 'utf8', timeout: 5000 });
      if (ver.includes('5.3')) {
        const fullPath = execSync(
          process.platform === 'win32' ? `where ${candidate}` : `which ${candidate}`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim().split('\n')[0];
        updateSettings(fullPath);
        return { ok: true, luaExe: fullPath, message: `Found Lua in PATH: ${fullPath}` };
      }
    } catch (e) {}
  }

  // 3. Auto-download
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
    // Linux/macOS: download source and compile
    const tarPath = path.join(downloadDir, `lua-${LUA_VERSION}.tar.gz`);

    console.log(`[setupLua] Downloading Lua ${LUA_VERSION} source...`);
    try {
      await downloadFile(LUA_SOURCE_URL, tarPath);
      console.log('[setupLua] Download complete. Extracting...');

      const extractDir = path.join(downloadDir, `lua-${LUA_VERSION}`);
      extractTarGz(tarPath, downloadDir);

      const sourceDir = path.join(downloadDir, `lua-${LUA_VERSION}`);
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
    } catch (e) {
      console.error(`[setupLua] Download failed: ${e.message}`);
      openFolder(downloadDir);
      return { ok: false, message: `Download failed: ${e.message}. Please download Lua 5.3 manually.` };
    }
  }
}

module.exports = { ensureLua, downloadFile, openFolder };
