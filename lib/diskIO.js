// ============================================================
// Node.js wrapper around the Lua `disk.lua` module.
//
// Every operation spawns `<luaExe> -e <inline Lua>` with cwd set
// to the project dir so `require("disk")` and `require("json")`
// resolve. Structured results are printed as JSON on stdout; tiny
// status results use "OK" / "ERR:<msg>". File *content* is moved
// through OS temp files (not JSON) so binary data survives.
//
// Paths embedded in Lua string literals are escaped via
// `_escapeLuaString` (backslash, quote, CR, LF, NUL).
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

class DiskIO {
  constructor({ projectDir, luaExe } = {}) {
    this.projectDir = projectDir || process.cwd();
    if (!luaExe) {
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
  }

  // Escape a JS string for safe inclusion in a Lua double-quoted literal.
  _escapeLuaString(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\0/g, '');
  }

  // Check if a file path points to a floppy image (.ocf format).
  _isFloppy(filePath) {
    return filePath.toLowerCase().endsWith('.ocf');
  }

  // Spawn <luaExe> -e <code> with cwd=projectDir. Returns stdout (utf8).
  _runLua(code) {
    let stdout;
    try {
      stdout = execFileSync(this.luaExe, ['-e', code], {
        cwd: this.projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const e = new Error(
        `Lua execution failed: ${err.message}` +
        (err.stderr ? `\nstderr: ${err.stderr}` : '') +
        (err.stdout ? `\nstdout: ${err.stdout}` : '')
      );
      e.stdout = err.stdout;
      e.stderr = err.stderr;
      throw e;
    }
    return stdout;
  }

  // Run Lua code that prints a single JSON object/array to stdout.
  _runLuaJSON(code) {
    const out = this._runLua(code);
    const start = out.search(/[\[{]/);
    if (start < 0) {
      throw new Error(`No JSON in Lua output: ${out}`);
    }
    return JSON.parse(out.slice(start));
  }

  // Run Lua code that prints "OK" or "ERR:<msg>".
  _runLuaStatus(code) {
    const out = this._runLua(code).trim();
    if (out.startsWith('ERR:')) {
      throw new Error(out.slice(4));
    }
    if (out !== 'OK') {
      throw new Error(`Unexpected Lua output: ${out}`);
    }
    return { ok: true };
  }

  // Create a new empty .ocd disk (locked by default).
  create({ path: diskPath, label, size, tier } = {}) {
    if (!diskPath) throw new Error('create: path is required');
    const p = this._escapeLuaString(diskPath);
    const l = this._escapeLuaString(label || 'Untitled');
    const s = parseInt(size, 10) || (4 * 1024 * 1024);
    const t = parseInt(tier, 10) || 3;
    const code =
      'local disk = require("disk")\n' +
      'local ok, err = disk.save("' + p + '", "' + l + '", {}, ' + s + ', ' + t + ', true)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Load disk info. Returns { ok, label, size, tier, version, locked,
  // fileCount, files? } where files is present only when unlocked.
  load(diskPath) {
    if (!diskPath) throw new Error('load: path is required');
    const p = this._escapeLuaString(diskPath);
    const code =
      'local disk = require("disk")\n' +
      'local json = require("json")\n' +
      'local info = disk.load("' + p + '")\n' +
      'if not info then\n' +
      '  io.stdout:write(json.encode({ok=false, error="cannot load disk"}))\n' +
      '  return\n' +
      'end\n' +
      'local result = {\n' +
      '  ok = true,\n' +
      '  label = info.label,\n' +
      '  size = info.size,\n' +
      '  tier = info.tier,\n' +
      '  version = info.version,\n' +
      '  locked = info.locked == true,\n' +
      '  fileCount = info.fileCount,\n' +
      '  files = nil,\n' +
      '}\n' +
      'if info.files then\n' +
      '  result.files = {}\n' +
      '  for fp, f in pairs(info.files) do\n' +
      '    result.files[fp] = {\n' +
      '      type = f.type,\n' +
      '      modified = f.modified,\n' +
      '      content = f.content,\n' +
      '    }\n' +
      '  end\n' +
      'end\n' +
      'io.stdout:write(json.encode(result))';
    const r = this._runLuaJSON(code);
    if (!r.ok) throw new Error(r.error || 'load failed');
    return r;
  }

  // Save disk. files is { [path]: { type, content, modified } }.
  // Files are passed through a temp JSON file to avoid command-line
  // length limits and to keep binary-safe where possible.
  save(diskPath, { label, files, size, tier, locked } = {}) {
    if (!diskPath) throw new Error('save: path is required');
    const p = this._escapeLuaString(diskPath);
    const l = this._escapeLuaString(label || 'Untitled');
    const s = parseInt(size, 10) || (4 * 1024 * 1024);
    const t = parseInt(tier, 10) || 3;
    const isLocked = locked ? 'true' : 'false';

    const tmp = path.join(os.tmpdir(), `diskio-save-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ files: files || {} }), 'utf8');
    const tmpLua = this._escapeLuaString(tmp.replace(/\\/g, '/'));
    try {
      const code =
        'local disk = require("disk")\n' +
        'local json = require("json")\n' +
        'local f = io.open("' + tmpLua + '", "rb")\n' +
        'if not f then io.stdout:write("ERR:cannot open temp file") return end\n' +
        'local data = f:read("*a")\n' +
        'f:close()\n' +
        'local parsed = json.decode(data)\n' +
        'local filesTable = parsed.files or parsed\n' +
        'local ok, err = disk.save("' + p + '", "' + l + '", filesTable, ' + s + ', ' + t + ', ' + isLocked + ')\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // Unlock disk (clears the locked flag in the header).
  // Auto-detects .ocd disk vs .ocf floppy format.
  unlock(diskPath) {
    if (!diskPath) throw new Error('unlock: path is required');
    const p = this._escapeLuaString(diskPath);
    if (this._isFloppy(diskPath)) {
      // For floppy: load, then re-save with locked=false
      const code =
        'local disk = require("disk")\n' +
        'local info = disk.loadFloppy("' + p + '")\n' +
        'if not info then io.stdout:write("ERR:cannot load floppy") return end\n' +
        'local ok, err = disk.saveFloppy("' + p + '", info.label, info.files or {}, info.size, false)\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    }
    const code =
      'local disk = require("disk")\n' +
      'local ok, err = disk.unlock("' + p + '")\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Lock disk (sets the locked flag; body is left untouched).
  // Auto-detects .ocd disk vs .ocf floppy format.
  lock(diskPath) {
    if (!diskPath) throw new Error('lock: path is required');
    const p = this._escapeLuaString(diskPath);
    if (this._isFloppy(diskPath)) {
      // For floppy: load, then re-save with locked=true
      const code =
        'local disk = require("disk")\n' +
        'local info = disk.loadFloppy("' + p + '")\n' +
        'if not info then io.stdout:write("ERR:cannot load floppy") return end\n' +
        'local ok, err = disk.saveFloppy("' + p + '", info.label, info.files or {}, info.size, true)\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    }
    const code =
      'local disk = require("disk")\n' +
      'local ok, err = disk.lock("' + p + '")\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Check lock status. Returns boolean.
  // Auto-detects .ocd disk vs .ocf floppy format.
  isLocked(diskPath) {
    if (!diskPath) throw new Error('isLocked: path is required');
    const p = this._escapeLuaString(diskPath);
    if (this._isFloppy(diskPath)) {
      const code =
        'local disk = require("disk")\n' +
        'local info = disk.getFloppyInfo("' + p + '")\n' +
        'if info == nil then io.stdout:write("ERR:cannot load floppy")\n' +
        'else io.stdout:write((info.locked and "LOCKED") or "UNLOCKED") end';
      const out = this._runLua(code).trim();
      if (out.startsWith('ERR:')) throw new Error(out.slice(4));
      return out === 'LOCKED';
    }
    const code =
      'local disk = require("disk")\n' +
      'local locked, err = disk.isLocked("' + p + '")\n' +
      'if locked == nil then io.stdout:write("ERR:" .. tostring(err))\n' +
      'else io.stdout:write(locked and "LOCKED" or "UNLOCKED") end';
    const out = this._runLua(code).trim();
    if (out.startsWith('ERR:')) throw new Error(out.slice(4));
    return out === 'LOCKED';
  }

  // Get header info only (does not unlock, does not read body).
  // Auto-detects .ocd disk vs .ocf floppy format.
  getInfo(diskPath) {
    if (!diskPath) throw new Error('getInfo: path is required');
    const p = this._escapeLuaString(diskPath);
    if (this._isFloppy(diskPath)) {
      const code =
        'local disk = require("disk")\n' +
        'local json = require("json")\n' +
        'local info = disk.getFloppyInfo("' + p + '")\n' +
        'if not info then\n' +
        '  io.stdout:write(json.encode({ok=false, error="cannot read floppy info"}))\n' +
        'else\n' +
        '  info.ok = true\n' +
        '  info.isFloppy = true\n' +
        '  io.stdout:write(json.encode(info))\n' +
        'end';
      const r = this._runLuaJSON(code);
      if (!r.ok) throw new Error(r.error || 'getInfo failed');
      return r;
    }
    const code =
      'local disk = require("disk")\n' +
      'local json = require("json")\n' +
      'local info = disk.getInfo("' + p + '")\n' +
      'if not info then\n' +
      '  io.stdout:write(json.encode({ok=false, error="cannot read disk info"}))\n' +
      'else\n' +
      '  info.ok = true\n' +
      '  info.isFloppy = false\n' +
      '  io.stdout:write(json.encode(info))\n' +
      'end';
    const r = this._runLuaJSON(code);
    if (!r.ok) throw new Error(r.error || 'getInfo failed');
    return r;
  }

  // Format disk: erase all files, keep label/size/tier, unlocked.
  // Auto-detects .ocd disk vs .ocf floppy format.
  format(diskPath) {
    if (!diskPath) throw new Error('format: path is required');
    const p = this._escapeLuaString(diskPath);
    if (this._isFloppy(diskPath)) {
      const code =
        'local disk = require("disk")\n' +
        'local ok, err = disk.formatFloppy("' + p + '")\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    }
    const code =
      'local disk = require("disk")\n' +
      'local ok, err = disk.format("' + p + '")\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // ========== Floppy (.ocf) methods ==========

  // Load floppy image (.ocf format).
  loadFloppy(floppyPath) {
    if (!floppyPath) throw new Error('loadFloppy: path is required');
    const p = this._escapeLuaString(floppyPath);
    const code =
      'local disk = require("disk")\n' +
      'local json = require("json")\n' +
      'local info = disk.loadFloppy("' + p + '")\n' +
      'if not info then\n' +
      '  io.stdout:write(json.encode({ok=false, error="cannot load floppy"}))\n' +
      '  return\n' +
      'end\n' +
      'local result = {\n' +
      '  ok = true,\n' +
      '  label = info.label,\n' +
      '  size = info.size,\n' +
      '  version = info.version,\n' +
      '  locked = info.locked or false,\n' +
      '  fileCount = info.fileCount or 0,\n' +
      '  files = info.files or {},\n' +
      '}\n' +
      'io.stdout:write(json.encode(result))';
    const r = this._runLuaJSON(code);
    if (!r.ok) throw new Error(r.error || 'loadFloppy failed');
    return r;
  }

  // Save floppy image (.ocf format).
  saveFloppy(floppyPath, { label, files, size, locked } = {}) {
    if (!floppyPath) throw new Error('saveFloppy: path is required');
    const p = this._escapeLuaString(floppyPath);
    const l = this._escapeLuaString(label || 'Floppy');
    const s = parseInt(size, 10) || (2048 * 1024);
    const isLocked = locked ? 'true' : 'false';

    const tmp = path.join(os.tmpdir(), `diskio-savefloppy-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ files: files || {} }), 'utf8');
    const tmpLua = this._escapeLuaString(tmp.replace(/\\/g, '/'));
    try {
      const code =
        'local disk = require("disk")\n' +
        'local json = require("json")\n' +
        'local f = io.open("' + tmpLua + '", "rb")\n' +
        'if not f then io.stdout:write("ERR:cannot open temp file") return end\n' +
        'local data = f:read("*a")\n' +
        'f:close()\n' +
        'local parsed = json.decode(data)\n' +
        'local filesTable = parsed.files or parsed\n' +
        'local ok, err = disk.saveFloppy("' + p + '", "' + l + '", filesTable, ' + s + ', ' + isLocked + ')\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // Format floppy: erase all files, keep label/size, unlocked.
  formatFloppy(floppyPath) {
    if (!floppyPath) throw new Error('formatFloppy: path is required');
    const p = this._escapeLuaString(floppyPath);
    const code =
      'local disk = require("disk")\n' +
      'local ok, err = disk.formatFloppy("' + p + '")\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // List file tree as a nested object:
  //   { name: "/", type: "dir", children: [{ name, type, size?, children? }] }
  // Auto-detects .ocd disk vs .ocf floppy format.
  listTree(diskPath) {
    if (!diskPath) throw new Error('listTree: path is required');
    const p = this._escapeLuaString(diskPath);
    const loadFunc = this._isFloppy(diskPath) ? 'disk.loadFloppy' : 'disk.load';
    const lockedErr = this._isFloppy(diskPath) ? 'floppy locked' : 'disk locked';
    const loadErr = this._isFloppy(diskPath) ? 'cannot load floppy' : 'cannot load disk';
    const code =
      'local disk = require("disk")\n' +
      'local json = require("json")\n' +
      'local info = ' + loadFunc + '("' + p + '")\n' +
      'if not info then\n' +
      '  io.stdout:write(json.encode({ok=false, error="' + loadErr + '"}))\n' +
      '  return\n' +
      'end\n' +
      'if info.locked then\n' +
      '  io.stdout:write(json.encode({ok=false, error="' + lockedErr + '"}))\n' +
      '  return\n' +
      'end\n' +
      'local files = info.files or {}\n' +
      'local root = { name = "/", type = "dir", children = {} }\n' +
      'local dirIndex = { [""] = root }\n' +
      'local function ensureDir(dirPath)\n' +
      '  if dirIndex[dirPath] then return dirIndex[dirPath] end\n' +
      '  local parentPath, name = "", dirPath\n' +
      '  local lastSlash = dirPath:reverse():find("/")\n' +
      '  if lastSlash then\n' +
      '    local pos = #dirPath - lastSlash + 1\n' +
      '    parentPath = dirPath:sub(1, pos - 1)\n' +
      '    name = dirPath:sub(pos + 1)\n' +
      '  end\n' +
      '  local parent = ensureDir(parentPath)\n' +
      '  local node = { name = name, type = "dir", children = {} }\n' +
      '  parent.children[#parent.children + 1] = node\n' +
      '  dirIndex[dirPath] = node\n' +
      '  return node\n' +
      'end\n' +
      'for filePath, f in pairs(files) do\n' +
      '  local cleanPath = filePath\n' +
      '  if cleanPath:sub(1, 1) == "/" then cleanPath = cleanPath:sub(2) end\n' +
      '  if cleanPath:sub(-1) == "/" then cleanPath = cleanPath:sub(1, -2) end\n' +
      '  if (f.type == "dir" or f.type == "directory") or cleanPath == "" then\n' +
      '    if cleanPath ~= "" then ensureDir(cleanPath) end\n' +
      '  else\n' +
      '    local dirPart, name = "", cleanPath\n' +
      '    local lastSlash = cleanPath:reverse():find("/")\n' +
      '    if lastSlash then\n' +
      '      local pos = #cleanPath - lastSlash + 1\n' +
      '      dirPart = cleanPath:sub(1, pos - 1)\n' +
      '      name = cleanPath:sub(pos + 1)\n' +
      '    end\n' +
      '    local parent = (dirPart == "") and root or ensureDir(dirPart)\n' +
      '    parent.children[#parent.children + 1] = {\n' +
      '      name = name,\n' +
      '      type = "file",\n' +
      '      size = #(f.content or ""),\n' +
      '    }\n' +
      '  end\n' +
      'end\n' +
      'local function sortNode(node)\n' +
      '  if node.children then\n' +
      '    table.sort(node.children, function(a, b)\n' +
      '      if a.type ~= b.type then return a.type < b.type end\n' +
      '      return a.name < b.name\n' +
      '    end)\n' +
      '    for _, c in ipairs(node.children) do sortNode(c) end\n' +
      '  end\n' +
      'end\n' +
      'sortNode(root)\n' +
      'io.stdout:write(json.encode({ok=true, tree=root}))';
    const r = this._runLuaJSON(code);
    if (!r.ok) throw new Error(r.error || 'listTree failed');
    return r.tree;
  }

  // Read a file inside the disk.
  // Returns { ok, type, content, modified? } (content nil for dirs).
  // Auto-detects .ocd disk vs .ocf floppy format.
  read(diskPath, innerPath) {
    if (!diskPath) throw new Error('read: path is required');
    if (!innerPath) throw new Error('read: innerPath is required');
    const dp = this._escapeLuaString(diskPath);
    const ip = this._escapeLuaString(innerPath);
    const loadFunc = this._isFloppy(diskPath) ? 'disk.loadFloppy' : 'disk.load';
    const lockedErr = this._isFloppy(diskPath) ? 'floppy locked' : 'disk locked';
    const loadErr = this._isFloppy(diskPath) ? 'cannot load floppy' : 'cannot load disk';
    const code =
      'local disk = require("disk")\n' +
      'local json = require("json")\n' +
      'local info = ' + loadFunc + '("' + dp + '")\n' +
      'if not info then\n' +
      '  io.stdout:write(json.encode({ok=false, error="' + loadErr + '"}))\n' +
      '  return\n' +
      'end\n' +
      'if info.locked then\n' +
      '  io.stdout:write(json.encode({ok=false, error="' + lockedErr + '"}))\n' +
      '  return\n' +
      'end\n' +
      'local f = info.files and info.files["' + ip + '"]\n' +
      'if not f then\n' +
      '  io.stdout:write(json.encode({ok=false, error="not found"}))\n' +
      '  return\n' +
      'end\n' +
      'if f.type == "dir" or f.type == "directory" then\n' +
      '  io.stdout:write(json.encode({ok=true, type="dir", content=nil}))\n' +
      '  return\n' +
      'end\n' +
      'io.stdout:write(json.encode({ok=true, type="file", content=f.content or "", modified=f.modified}))';
    const r = this._runLuaJSON(code);
    if (!r.ok) throw new Error(r.error || 'read failed');
    return r;
  }

  // Write a file inside the disk. Content is moved via temp file so
  // binary content is preserved byte-for-byte.
  // Auto-detects .ocd disk vs .ocf floppy format.
  write(diskPath, innerPath, content) {
    if (!diskPath) throw new Error('write: path is required');
    if (!innerPath) throw new Error('write: innerPath is required');
    const dp = this._escapeLuaString(diskPath);
    const ip = this._escapeLuaString(innerPath);
    const tmp = path.join(os.tmpdir(), `diskio-write-${Date.now()}-${process.pid}.bin`);
    fs.writeFileSync(tmp, Buffer.from(content == null ? '' : content, 'utf8'));
    const tmpLua = this._escapeLuaString(tmp.replace(/\\/g, '/'));
    const isFloppy = this._isFloppy(diskPath);
    const loadFunc = isFloppy ? 'disk.loadFloppy' : 'disk.load';
    const saveFunc = isFloppy ? 'disk.saveFloppy' : 'disk.save';
    const loadErr = isFloppy ? 'cannot load floppy' : 'cannot load disk';
    const lockedErr = isFloppy ? 'floppy locked' : 'disk locked';
    const saveExtraArgs = isFloppy ? '' : ', info.tier';
    try {
      const code =
        'local disk = require("disk")\n' +
        'local f = io.open("' + tmpLua + '", "rb")\n' +
        'if not f then io.stdout:write("ERR:cannot open temp file") return end\n' +
        'local content = f:read("*a")\n' +
        'f:close()\n' +
        'local info = ' + loadFunc + '("' + dp + '")\n' +
        'if not info then io.stdout:write("ERR:' + loadErr + '") return end\n' +
        'if info.locked then io.stdout:write("ERR:' + lockedErr + '") return end\n' +
        'local files = info.files or {}\n' +
        'files["' + ip + '"] = {\n' +
        '  type = "file",\n' +
        '  content = content,\n' +
        '  modified = os.time(),\n' +
        '}\n' +
        'local ok, err = ' + saveFunc + '("' + dp + '", info.label, files, info.size' + saveExtraArgs + ', false)\n' +
        'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
      return this._runLuaStatus(code);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // Remove a file (or dir entry) inside the disk.
  // Auto-detects .ocd disk vs .ocf floppy format.
  remove(diskPath, innerPath) {
    if (!diskPath) throw new Error('remove: path is required');
    if (!innerPath) throw new Error('remove: innerPath is required');
    const dp = this._escapeLuaString(diskPath);
    const ip = this._escapeLuaString(innerPath);
    const isFloppy = this._isFloppy(diskPath);
    const loadFunc = isFloppy ? 'disk.loadFloppy' : 'disk.load';
    const saveFunc = isFloppy ? 'disk.saveFloppy' : 'disk.save';
    const loadErr = isFloppy ? 'cannot load floppy' : 'cannot load disk';
    const lockedErr = isFloppy ? 'floppy locked' : 'disk locked';
    const saveExtraArgs = isFloppy ? '' : ', info.tier';
    // 目录会连同其下所有文件一起删除
    const code =
      'local disk = require("disk")\n' +
      'local info = ' + loadFunc + '("' + dp + '")\n' +
      'if not info then io.stdout:write("ERR:' + loadErr + '") return end\n' +
      'if info.locked then io.stdout:write("ERR:' + lockedErr + '") return end\n' +
      'local files = info.files or {}\n' +
      'local target = "' + ip + '"\n' +
      'local prefix = target .. "/"\n' +
      'local removed = 0\n' +
      'for key in pairs(files) do\n' +
      '  if key == target or key:sub(1, #prefix) == prefix then\n' +
      '    files[key] = nil\n' +
      '    removed = removed + 1\n' +
      '  end\n' +
      'end\n' +
      'if removed == 0 then io.stdout:write("ERR:not found") return end\n' +
      'local ok, err = ' + saveFunc + '("' + dp + '", info.label, files, info.size' + saveExtraArgs + ', false)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Create a new directory inside the disk.
  // Auto-detects .ocd disk vs .ocf floppy format.
  mkdir(diskPath, innerPath) {
    if (!diskPath) throw new Error('mkdir: path is required');
    if (!innerPath) throw new Error('mkdir: innerPath is required');
    // 规范化路径: 确保以 / 开头且不以 / 结尾(根目录除外)
    if (innerPath !== '/' && innerPath.endsWith('/')) innerPath = innerPath.slice(0, -1);
    if (!innerPath.startsWith('/')) innerPath = '/' + innerPath;
    const dp = this._escapeLuaString(diskPath);
    const ip = this._escapeLuaString(innerPath);
    const isFloppy = this._isFloppy(diskPath);
    const loadFunc = isFloppy ? 'disk.loadFloppy' : 'disk.load';
    const saveFunc = isFloppy ? 'disk.saveFloppy' : 'disk.save';
    const loadErr = isFloppy ? 'cannot load floppy' : 'cannot load disk';
    const lockedErr = isFloppy ? 'floppy locked' : 'disk locked';
    const saveExtraArgs = isFloppy ? '' : ', info.tier';
    const code =
      'local disk = require("disk")\n' +
      'local info = ' + loadFunc + '("' + dp + '")\n' +
      'if not info then io.stdout:write("ERR:' + loadErr + '") return end\n' +
      'if info.locked then io.stdout:write("ERR:' + lockedErr + '") return end\n' +
      'local files = info.files or {}\n' +
      'if files["' + ip + '"] ~= nil then\n' +
      '  io.stdout:write("ERR:already exists")\n' +
      '  return\n' +
      'end\n' +
      'files["' + ip + '"] = {\n' +
      '  type = "dir",\n' +
      '  children = {},\n' +
      '}\n' +
      'local ok, err = ' + saveFunc + '("' + dp + '", info.label, files, info.size' + saveExtraArgs + ', false)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // ========== Mirror mode methods ==========
  // Mirror mode: disk operations are routed to a real folder on the host.
  // This enables real-time sync between the folder and the VM's disk.

  // Check if a disk slot in a VM config has a mirror path.
  // config = VM config object, diskSlot = 'disk1' or 'disk2'
  getMirrorPath(config, diskSlot) {
    if (!config || !config.hardware) return null;
    const mirrorKey = diskSlot + 'Mirror';
    const mirrorPath = config.hardware[mirrorKey];
    if (!mirrorPath) return null;
    // Resolve relative to project dir
    if (path.isAbsolute(mirrorPath)) return mirrorPath;
    return path.join(this.projectDir, mirrorPath);
  }

  // Read a file from the mirror folder.
  readFromFolder(folderPath, innerPath) {
    const fullPath = path.join(folderPath, innerPath);
    if (!fs.existsSync(fullPath)) return { ok: false, error: 'not found' };
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return { ok: true, type: 'dir', content: null };
    const content = fs.readFileSync(fullPath, 'utf8');
    return { ok: true, type: 'file', content, modified: stat.mtime.getTime() / 1000 };
  }

  // Write a file to the mirror folder.
  writeToFolder(folderPath, innerPath, content) {
    const fullPath = path.join(folderPath, innerPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content == null ? '' : content, 'utf8');
    return true;
  }

  // List files in the mirror folder (recursive, flat list).
  listFolder(folderPath, dirPath) {
    dirPath = dirPath || '/';
    const fullDir = path.join(folderPath, dirPath === '/' ? '' : dirPath);
    if (!fs.existsSync(fullDir)) return [];

    const entries = [];
    const walk = (absPath, relPath) => {
      const items = fs.readdirSync(absPath);
      for (const item of items) {
        const itemAbs = path.join(absPath, item);
        const itemRel = (relPath === '/' ? '' : relPath) + '/' + item;
        const stat = fs.statSync(itemAbs);
        if (stat.isDirectory()) {
          entries.push({ name: item, path: itemRel, type: 'dir', size: 0, modified: stat.mtime.getTime() / 1000 });
          walk(itemAbs, itemRel);
        } else {
          entries.push({ name: item, path: itemRel, type: 'file', size: stat.size, modified: stat.mtime.getTime() / 1000 });
        }
      }
    };
    walk(fullDir, dirPath);
    return entries;
  }

  // List mirror folder as a tree structure (compatible with listTree format).
  // Returns { name, type: "dir", children: [...] }
  listFolderTree(folderPath) {
    const root = { name: '/', type: 'dir', children: [] };
    const dirIndex = { '/': root, '': root };

    const walk = (absPath, relPath) => {
      if (!fs.existsSync(absPath)) return;
      const items = fs.readdirSync(absPath);
      for (const item of items) {
        const itemAbs = path.join(absPath, item);
        const itemRel = (relPath === '/' ? '' : relPath) + '/' + item;
        const stat = fs.statSync(itemAbs);
        if (stat.isDirectory()) {
          const node = { name: item, type: 'dir', children: [] };
          dirIndex[itemRel] = node;
          // Find parent node
          const parentRel = itemRel.substring(0, itemRel.lastIndexOf('/')) || '/';
          const parent = dirIndex[parentRel] || root;
          parent.children.push(node);
          walk(itemAbs, itemRel);
        } else {
          const parent = dirIndex[relPath] || root;
          parent.children.push({
            name: item,
            type: 'file',
            size: stat.size,
          });
        }
      }
    };
    walk(folderPath, '/');

    // Sort: dirs first, then files, alphabetically
    const sortNode = (node) => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type < b.type ? 1 : -1;
          return a.name < b.name ? -1 : 1;
        });
        for (const c of node.children) sortNode(c);
      }
    };
    sortNode(root);
    return root;
  }

  // Remove a file from the mirror folder.
  removeFromFolder(folderPath, innerPath) {
    const fullPath = path.join(folderPath, innerPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
    return true;
  }

  // Create directory in mirror mode folder
  mkdirInFolder(folderPath, innerPath) {
    const fullPath = path.join(folderPath, innerPath);
    if (fs.existsSync(fullPath)) {
      if (fs.statSync(fullPath).isDirectory()) return true;
      throw new Error('A file with that name already exists');
    }
    fs.mkdirSync(fullPath, { recursive: true });
    return true;
  }

  // Sync: folder → .ocd disk (used at VM start)
  syncFolderToDisk(folderPath, diskPath, opts) {
    const files = {};
    const dirSet = new Set(['/']);

    const walk = (absPath, relPath) => {
      const items = fs.readdirSync(absPath);
      for (const item of items) {
        const itemAbs = path.join(absPath, item);
        const itemRel = (relPath === '/' ? '' : relPath) + '/' + item;
        const stat = fs.statSync(itemAbs);
        if (stat.isDirectory()) {
          dirSet.add(itemRel);
          walk(itemAbs, itemRel);
        } else {
          files[itemRel] = {
            type: 'file',
            content: fs.readFileSync(itemAbs, 'utf8'),
            modified: stat.mtime.getTime() / 1000,
          };
        }
      }
    };
    walk(folderPath, '/');

    for (const dir of dirSet) {
      if (!files[dir]) files[dir] = { type: 'directory', modified: Date.now() / 1000 };
    }

    this.save(diskPath, {
      label: opts.label || 'Mirror',
      files,
      size: opts.size || 4194304,
      tier: opts.tier || 3,
      locked: false,
    });
  }

  // Sync: .ocd disk → folder (used at VM stop)
  syncDiskToFolder(diskPath, folderPath) {
    const tree = this.listTree(diskPath);
    fs.mkdirSync(folderPath, { recursive: true });

    for (const entry of tree) {
      if (entry.type === 'file') {
        const fileData = this.read(diskPath, entry.path);
        if (fileData.ok && fileData.content != null) {
          const fullPath = path.join(folderPath, entry.path);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, fileData.content, 'utf8');
        }
      }
    }
  }

  // Import a .oce EEPROM file: load source, save to destPath.
  importEEPROM(uploadFile, destPath) {
    if (!uploadFile) throw new Error('importEEPROM: uploadFile is required');
    if (!destPath) throw new Error('importEEPROM: destPath is required');
    const src = this._escapeLuaString(uploadFile);
    const dst = this._escapeLuaString(destPath);
    const code =
      'local disk = require("disk")\n' +
      'local info = disk.loadEEPROM("' + src + '")\n' +
      'if not info then io.stdout:write("ERR:cannot load source EEPROM") return end\n' +
      'local ok, err = disk.saveEEPROM("' + dst + '", info.label, info.content)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Change the label of a .ocd disk without touching its files.
  setDiskLabel(diskPath, newLabel) {
    if (!diskPath) throw new Error('setDiskLabel: diskPath is required');
    if (!newLabel) throw new Error('setDiskLabel: newLabel is required');
    const p = this._escapeLuaString(diskPath);
    const l = this._escapeLuaString(String(newLabel).substring(0, 16));
    const code =
      'local disk = require("disk")\n' +
      'local info = disk.load("' + p + '")\n' +
      'if not info then io.stdout:write("ERR:cannot load disk") return end\n' +
      'local ok, err = disk.save("' + p + '", "' + l + '", info.files or {}, info.size, info.tier, info.locked == true)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }

  // Change the label of a .oce EEPROM file (keeps content intact).
  setEEPROMLabel(eepromPath, newLabel) {
    if (!eepromPath) throw new Error('setEEPROMLabel: eepromPath is required');
    if (!newLabel) throw new Error('setEEPROMLabel: newLabel is required');
    const p = this._escapeLuaString(eepromPath);
    const l = this._escapeLuaString(String(newLabel).substring(0, 16));
    const code =
      'local disk = require("disk")\n' +
      'local info = disk.loadEEPROM("' + p + '")\n' +
      'if not info then io.stdout:write("ERR:cannot load EEPROM") return end\n' +
      'local ok, err = disk.saveEEPROM("' + p + '", "' + l + '", info.content)\n' +
      'if ok then io.stdout:write("OK") else io.stdout:write("ERR:" .. tostring(err)) end';
    return this._runLuaStatus(code);
  }
}

module.exports = { DiskIO };
