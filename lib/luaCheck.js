// ============================================================
// Lua interpreter validator with on-disk cache.
//
// Strategy (avoids the chicken-and-egg of needing a known-good
// Lua to run lua_check.lua): talk to the Lua binary directly via
//   <luaExe> -v          -> version string
//   <luaExe> -e <code>   -> library probe
// Hash = "<size>:<adler32 of first 4KB>" so it matches the format
// produced by lua_check.lua. Result is cached to
//   <projectDir>/cache/lua_check.json
// keyed by { path, mtime, size, hash }.
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureLua } = require('./setupLua');

// Lua 探测: 单次运行偶发失败(杀毒软件扫描 / 磁盘繁忙 / 句柄被占用)不应被当成
// "Lua 检测不通过", 因此加超时并重试。
const LUA_RUN_TIMEOUT_MS = 15000;
const LUA_RUN_ATTEMPTS = 3;

class LuaCheck {
  constructor({ projectDir, luaExe } = {}) {
    this.projectDir = projectDir || process.cwd();
    if (!luaExe) {
      // Fallback: read luaExe from settings.json in projectDir
      try {
        const settingsPath = path.join(this.projectDir, 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        luaExe = settings.luaExe;
      } catch (err) {
        throw new Error(`luaExe not provided and cannot read settings.json: ${err.message}`);
      }
    }
    if (!luaExe) {
      throw new Error('luaExe not provided and not found in settings.json');
    }
    this.luaExe = luaExe;
    this.cachePath = path.join(this.projectDir, 'cache', 'lua_check.json');
  }

  // Adler-32 checksum (matches lua_check.lua's hash format)
  _adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b * 65536) + a) >>> 0;
  }

  // Hash = "<size>:<adler32 of first 4KB>". Returns null if file cannot be read.
  _computeHash(filePath, size) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return null;
    }
    const head = Buffer.alloc(4096);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, head, 0, Math.min(4096, size), 0);
    } catch {
      fs.closeSync(fd);
      return null;
    }
    fs.closeSync(fd);
    const slice = head.subarray(0, bytesRead);
    return `${size}:${this._adler32(slice)}`;
  }

  // Stat luaExe and build the cache key fields
  _stat() {
    const st = fs.statSync(this.luaExe);
    const size = st.size;
    const mtime = Math.floor(st.mtimeMs);
    const hash = this._computeHash(this.luaExe, size);
    return { path: this.luaExe, mtime, size, hash };
  }

  _readCache() {
    try {
      const data = fs.readFileSync(this.cachePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  _writeCache(data) {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // ignore cache write errors
    }
  }

  // 运行 <luaExe> 并返回 stdout。带超时与重试, 避免瞬时失败被误判成"检测不通过"。
  _execLua(args, what) {
    let lastErr = null;
    for (let attempt = 1; attempt <= LUA_RUN_ATTEMPTS; attempt++) {
      try {
        return execFileSync(this.luaExe, args, {
          encoding: 'utf8',
          timeout: LUA_RUN_TIMEOUT_MS,
          windowsHide: true,
        });
      } catch (err) {
        lastErr = err;
        const out = (err.stdout || '') + (err.stderr || '');
        if (String(out).trim()) return out;
        if (attempt < LUA_RUN_ATTEMPTS) LuaCheck._sleepMs(400);
      }
    }
    throw new Error(`cannot run ${what}: ${lastErr ? lastErr.message : 'unknown error'}`);
  }

  // 同步休眠 (Node 主线程允许 Atomics.wait)
  static _sleepMs(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch { /* 忽略 */ }
  }

  // Run <luaExe> -e "print(_VERSION)" and return the version string.
  // (Using -e instead of -v works uniformly across Lua 5.1/5.2/5.3/5.4/5.5
  // and prints to stdout, avoiding stderr-capture issues.)
  _runVersion() {
    return this._execLua(['-e', 'print(_VERSION)'], "lua -e print(_VERSION)").trim();
  }

  // Run <luaExe> -e <probe> and parse "KEY:value" lines into an object.
  _runLibCheck() {
    // Lua 5.1-compatible probe. Use loadstring (5.1) or load (5.3+)
    // wrapped in pcall so the probe never aborts on older Lua.
    const code = [
      'print("BIT32:" .. tostring(bit32 ~= nil))',
      'print("IO_POPEN:" .. tostring(io.popen ~= nil))',
      'print("OS_EXECUTE:" .. tostring(os.execute ~= nil))',
      'print("MATH_RANDOM:" .. tostring(math.random ~= nil))',
      'print("STRING_FORMAT:" .. tostring(string.format ~= nil))',
      'print("UTF8:" .. tostring(utf8 ~= nil))',
      'print("TABLE_PACK:" .. tostring(table.pack ~= nil))',
      'local loader = loadstring or load',
      'local ok, fn = pcall(loader, "return 1 // 2")',
      'print("BITOP:" .. tostring(ok and fn ~= nil))',
    ].join('\n');
    const out = this._execLua(['-e', code], 'lua lib check');
    const libs = {};
    for (const line of out.split(/\r?\n/)) {
      // Key may contain digits (e.g. BIT32, UTF8) -- allow A-Z 0-9 _
      const m = line.match(/^([A-Z][A-Z0-9_]*):([a-z]+)$/);
      if (m) {
        libs[m[1]] = m[2] === 'true';
      }
    }
    return libs;
  }

  // Validate the Lua interpreter, using cache when possible.
  // If Lua is missing, attempts to auto-download and install.
  // Returns: { ok, version, libs, errors, hash, path, mtime, size, checkedAt, cached }
  async ensure() {
    // 1. stat the luaExe file
    let stat;
    try {
      stat = this._stat();
    } catch (err) {
      // Lua not found — try auto-download
      console.log('[luaCheck] Lua not found at configured path. Attempting auto-download...');
      const result = await ensureLua(this.luaExe);
      if (result.ok && result.luaExe) {
        // Update this instance's path and retry
        this.luaExe = result.luaExe;
        try {
          stat = this._stat();
        } catch (err2) {
          return {
            ok: false,
            path: this.luaExe,
            version: null,
            libs: {},
            errors: [`Lua auto-installed but cannot stat: ${err2.message}`],
            hash: null, mtime: null, size: null,
            checkedAt: new Date().toISOString(),
            cached: false,
          };
        }
      } else {
        return {
          ok: false,
          path: this.luaExe,
          version: null,
          libs: {},
          errors: [`Lua not found and auto-download failed: ${result.message}`],
          hash: null, mtime: null, size: null,
          checkedAt: new Date().toISOString(),
          cached: false,
        };
      }
    }

    if (!stat.hash) {
      return {
        ok: false,
        path: this.luaExe,
        version: null,
        libs: {},
        errors: ['cannot read lua binary for hashing'],
        hash: null,
        mtime: stat.mtime,
        size: stat.size,
        checkedAt: new Date().toISOString(),
        cached: false,
      };
    }

    // 2. check cache for matching { path, mtime, size, hash }
    const cache = this._readCache();
    if (cache && cache.entries && cache.entries[stat.path]) {
      const entry = cache.entries[stat.path];
      if (
        entry.path === stat.path &&
        entry.mtime === stat.mtime &&
        entry.size === stat.size &&
        entry.hash === stat.hash
      ) {
        return { ...entry.result, cached: true };
      }
    }

    // 3. run live checks
    const errors = [];
    let version = null;
    let libs = {};
    let ok = false;

    try {
      const vOut = this._runVersion();
      const m = vOut.match(/Lua\s+([\d.]+)/i);
      if (m) {
        version = `Lua ${m[1]}`;
        const parts = m[1].split('.');
        const major = parseInt(parts[0], 10);
        const minor = parseInt(parts[1] || '0', 10);
        // 接受 Lua 5.1+ (emulator 自带 bit32 / table.pack polyfill)
        if (major === 5 && minor >= 1) {
          ok = true;
        } else {
          errors.push(`need Lua 5.1+, got ${m[1]}`);
        }
      } else {
        version = vOut;
        errors.push(`unknown version: ${vOut}`);
      }
    } catch (err) {
      errors.push(`version check failed: ${err.message}`);
    }

    try {
      libs = this._runLibCheck();
    } catch (err) {
      errors.push(`lib check failed: ${err.message}`);
    }

    // Required libs (must be present)
    const required = ['IO_POPEN', 'OS_EXECUTE', 'MATH_RANDOM', 'STRING_FORMAT'];
    for (const req of required) {
      if (libs[req] === false) {
        ok = false;
        errors.push(`missing: ${req}`);
      }
    }

    const result = {
      ok,
      path: this.luaExe,
      version,
      libs,
      errors,
      hash: stat.hash,
      mtime: stat.mtime,
      size: stat.size,
      checkedAt: new Date().toISOString(),
      cached: false,
    };

    // 4. save to cache
    const newCache = (cache && typeof cache === 'object') ? cache : { entries: {} };
    if (!newCache.entries) newCache.entries = {};
    newCache.entries[stat.path] = {
      path: stat.path,
      mtime: stat.mtime,
      size: stat.size,
      hash: stat.hash,
      result,
    };
    this._writeCache(newCache);

    return result;
  }

  // Delete the cache file so the next ensure() runs live checks.
  invalidate() {
    try {
      if (fs.existsSync(this.cachePath)) {
        fs.unlinkSync(this.cachePath);
      }
    } catch {
      // ignore
    }
  }
}

module.exports = { LuaCheck };
