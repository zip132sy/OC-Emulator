-- ============================================================
-- OpenComputers emulator (OC Emulator) v2.0
-- Emulates OC mod computers (web control-panel edition)
--
-- Usage: lua oc-emulator.lua --vm <vm_dir> --json-io
-- I/O: JSON lines on stdin/stdout (talks to server.js)
-- ============================================================

-- ============================================================
-- Credits
--   Source: DeepSeek, Trea
--   Verification and testing: zip132sy, DeepSeek
--   Free and open source!
-- ============================================================

local verifyProjectInfo

do
  local infoText = "源码提供: DeepSeek , Trea\n校验与测试: zip132sy , DeepSeek\n本项目免费且开源!"
  local infoHash = 219526294
  local infoOpen = io.open
  local infoStderr = io.stderr
  local remoteLoaded, remoteText = false, nil

  local function hashOf(s)
    local h = 7
    for i = 1, #s do h = (h * 131 + s:byte(i)) % 1000000007 end
    return h
  end

  local function loadRemote()
    if remoteLoaded then return remoteText end
    remoteLoaded = true
    local f = infoOpen("cache/attribution.txt", "rb")
    if f then
      local text = f:read("*a")
      f:close()
      if type(text) == "string" then
        text = text:gsub("%s+$", "")
        if text ~= "" then remoteText = text end
      end
    end
    return remoteText
  end

  verifyProjectInfo = function(where)
    local localOk = type(infoText) == "string" and hashOf(infoText) == infoHash
    local remote = loadRemote()
    local remoteOk = (remote == nil) or (hashOf(remote) == infoHash)
    if not (localOk and remoteOk) then
      local msg = "[OC Emulator] 项目信息与源码不一致, 请使用完整版本 (" .. tostring(where) .. ")"
      infoStderr:write(msg .. "\n")
      error(msg, 0)
    end
  end
end

verifyProjectInfo("startup")

-- Debug logging goes to stderr so it never pollutes the JSON on stdout
-- Keep the original io references: OpenOS overwrites _G.io when it loads /lib/io.lua
local _stderr = io.stderr
local _stdout = io.stdout
local _stdin = io.stdin
local _io_read = io.read
local _io_open = io.open
local _io_popen = io.popen
local _io_lines = io.lines
local _io_tmpfile = io.tmpfile
-- Keep the original os functions: OpenOS overwrites _G.os
local _os_tmpname = os.tmpname
local _os_remove = os.remove
local _os_execute_raw = os.execute
local _os_clock = os.clock       -- Original os.clock, used for frame pacing
local _os_exit = os.exit        -- Original os.exit: the guest may replace _G.os.exit, so host exits must use this
_stderr:setvbuf("no")

-- Lua 5.1 compatibility: string.format("%s", table) does not call tostring
-- OpenOS (Lua 5.2+) relies on that behaviour, so patch it
local _orig_string_format = string.format
string.format = function(fmt, ...)
  local args = { ... }
  -- Convert non-string arguments for %s to strings
  local i = 0
  local n = select("#", ...)
  fmt = fmt:gsub("%%[0-9%.]*[a-zA-Z]", function(spec)
    i = i + 1
    if spec:match("%%%a*s$") and args[i] ~= nil and type(args[i]) ~= "string" then
      args[i] = tostring(args[i])
    end
    return spec
  end)
  return _orig_string_format(fmt, (table.unpack or unpack)(args, 1, n))
end

-- Lua 5.2+ compatibility: table.pack / table.unpack
if not table.pack then
  table.pack = function(...) return { n = select("#", ...), ... } end
end
if not table.unpack then
  table.unpack = unpack
end
local dbg = nil

-- Log level: "error" = errors only (default), "full" = normal info, "off" = silent
-- High-frequency debug logs (component.invoke / filesystem / pullSignal) are gated by
-- verboseLog and are off by default. They sit on the hottest paths (every draw, file access
-- and idle poll); enabling them emits hundreds of stderr lines per second, which the server
-- forwards synchronously to the console and browser, saturating Node's event loop and slowing
-- the pull_signal <-> tick round trips until the VM stalls badly after ~10 s.
-- Enable temporarily with --log-level verbose or --verbose when debugging.
local logLevel = "error"

-- High-frequency debug logging (only true in verbose mode)
local verboseLog = false

-- Original directory separator, captured before the sandbox replaces _G.package
local DIR_SEP = package.config:sub(1, 1)
local function dlog(...)
  if not verboseLog then return end
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
  _stderr:write("[dlog] " .. table.concat(parts, "\t") .. "\n")
end

-- Error log to stderr (error and full levels only)
local function elog(msg)
  if logLevel == "off" then return end
  _stderr:write("[emulator] " .. msg .. "\n")
end

-- Info log (full level only): render frames, input events, diagnostics
local function ilog(msg)
  if logLevel ~= "full" then return end
  _stderr:write("[emulator] " .. msg .. "\n")
end

-- Lua 5.5 removed bit32
if not _G.bit32 then
  bit32 = {}
  bit32.band = function(a, b)
    local r, bit = 0, 1
    while a > 0 or b > 0 do
      if a % 2 == 1 and b % 2 == 1 then r = r + bit end
      a = math.floor(a / 2); b = math.floor(b / 2); bit = bit * 2
    end
    return r
  end
  bit32.bor = function(a, b)
    local r, bit = 0, 1
    while a > 0 or b > 0 do
      if a % 2 == 1 or b % 2 == 1 then r = r + bit end
      a = math.floor(a / 2); b = math.floor(b / 2); bit = bit * 2
    end
    return r
  end
  bit32.bxor = function(a, b)
    local r, bit = 0, 1
    while a > 0 or b > 0 do
      if (a % 2) ~= (b % 2) then r = r + bit end
      a = math.floor(a / 2); b = math.floor(b / 2); bit = bit * 2
    end
    return r
  end
  bit32.bnot = function(x) return 0xFFFFFFFF - x end
  bit32.lshift = function(x, n) return x * (2 ^ n) end
  bit32.rshift = function(x, n) return math.floor(x / (2 ^ n)) end
  -- Lua 5.3 names mapped to 5.1 equivalents (used by data card code)
  bit32.blshift = bit32.lshift
  bit32.brshift = bit32.rshift
  bit32.arshift = function(x, n)
    local sign = x >= 0 and 0 or 1
    x = math.floor(math.abs(x) / (2 ^ n))
    return sign == 1 and -x or x
  end
  bit32.btest = function(...) return bit32.band(...) ~= 0 end
  bit32.extract = function(x, field, width)
    width = width or 1
    return bit32.band(bit32.rshift(x, field), (2 ^ width) - 1)
  end
  bit32.replace = function(x, v, field, width)
    width = width or 1
    local mask = (2 ^ width) - 1
    return bit32.bor(bit32.band(x, bit32.bnot(bit32.lshift(mask, field))), bit32.lshift(bit32.band(v, mask), field))
  end
end

-- Lua 5.1 compatibility: table.pack / table.unpack
if not table.pack then
  table.pack = function(...)
    return { n = select("#", ...), ... }
  end
end
if not table.unpack then table.unpack = unpack end

-- Lua 5.1 compatibility: load() accepting a string
-- Lua 5.3+ load() accepts strings; 5.1 only accepts a function
-- Polyfill: use loadstring when given a string on Lua 5.1
if loadstring then
  local _orig_load = load
  load = function(chunk, chunkname, mode, env)
    local t = type(chunk)
    if t == "string" or t == "number" then
      -- Lua 5.1: loadstring(s, name) has no mode/env arguments
      local fn, err = loadstring(chunk, chunkname)
      return fn
    elseif t == "function" then
      -- Function chunk: delegate to the native load
      if _orig_load then return _orig_load(chunk, chunkname) end
      -- No native load: collect the lines and use loadstring
      local collected = {}
      local line = chunk()
      while line do collected[#collected + 1] = line; line = chunk() end
      return loadstring(table.concat(collected, "\n"), chunkname)
    end
    error("bad argument #1 to 'load' (string or function expected, got " .. t .. ")")
  end
end

local socket_ok, socket = pcall(require, "socket")
if not socket_ok then socket = nil end

-- ============================================================
-- ============================================================
-- Embedded JSON library (full UTF-8 support, reentrant)
-- ============================================================
local json = {}

-- Null sentinel: decoded null; encode emits null for both nil and json.null
local jsonNull = {}
json.null = jsonNull

local function encodeString(s)
  local result = {'"'}
  local i = 1
  local len = #s
  while i <= len do
    local b = s:byte(i)
    if b == 34 then result[#result+1] = '\\"'; i = i + 1
    elseif b == 92 then result[#result+1] = '\\\\'; i = i + 1
    elseif b == 10 then result[#result+1] = '\\n'; i = i + 1
    elseif b == 13 then result[#result+1] = '\\r'; i = i + 1
    elseif b == 9 then result[#result+1] = '\\t'; i = i + 1
    elseif b == 8 then result[#result+1] = '\\b'; i = i + 1
    elseif b == 12 then result[#result+1] = '\\f'; i = i + 1
    elseif b < 32 then
      result[#result+1] = string.format('\\u%04x', b); i = i + 1
    elseif b < 128 then
      result[#result+1] = s:sub(i, i); i = i + 1
    else
      -- Multi-byte UTF-8: keep the sequence verbatim only if every continuation byte is 0x80-0xBF,
      -- otherwise escape the byte as Latin-1 \u00XX.
      -- Node reads stdout with data.toString('utf8'), which turns invalid UTF-8 into
      -- U+FFFD and corrupts binary data (e.g. .pic images read over a network mount),
      -- hanging the guest's image parser. Escaped \u00XX decodes back to the same
      -- byte, so binary content crosses Lua -> Node -> Lua losslessly, byte for byte.
      local charLen = 1
      if b >= 0xF0 then charLen = 4
      elseif b >= 0xE0 then charLen = 3
      elseif b >= 0xC0 then charLen = 2 end
      local valid = charLen > 1 and (i + charLen - 1 <= len)
      if valid then
        for k = 1, charLen - 1 do
          local cb = s:byte(i + k)
          if not cb or cb < 0x80 or cb > 0xBF then valid = false; break end
        end
      end
      if valid then
        result[#result+1] = s:sub(i, i + charLen - 1)
        i = i + charLen
      else
        result[#result+1] = string.format('\\u%04x', b)
        i = i + 1
      end
    end
  end
  result[#result+1] = '"'
  return table.concat(result)
end

local function isArray(t)
  local max = 0
  local count = 0
  for k, _ in pairs(t) do
    if type(k) == "number" and k > 0 and k == math.floor(k) then
      if k > max then max = k end
      count = count + 1
    else
      return false
    end
  end
  if count == 0 then return false end  -- empty table → object
  -- Holes are allowed: a modem reply such as (nil, "invalid handle") leaves nil at index 4.
  -- Positive integer keys alone mean array encoding, holes become null; the sparse cap stops huge arrays.
  -- With a max == count test such tables would encode as objects {"1":..,"5":..}; Node's
  -- object expansion fails, messages cannot be routed and the client request loop hangs.
  return max <= count + 64
end

local jsonEncodeVal

local function encodeTable(t)
  if isArray(t) then
    local max = 0
    for k in pairs(t) do
      if k > max then max = k end
    end
    if max == 0 then return "[]" end
    local parts = {}
    for i = 1, max do parts[i] = jsonEncodeVal(t[i]) end  -- holes become "null"
    return "[" .. table.concat(parts, ",") .. "]"
  else
    local parts = {}
    for k, v in pairs(t) do
      parts[#parts+1] = encodeString(tostring(k)) .. ":" .. jsonEncodeVal(v)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
end

jsonEncodeVal = function(v)
  if v == jsonNull then return "null" end
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "number" then
    if v ~= v then return "null" end
    if v == math.huge or v == -math.huge then return "null" end
    if v == math.floor(v) and math.abs(v) < 1e15 then
      return string.format("%d", v)
    end
    return string.format("%.17g", v)
  elseif t == "string" then return encodeString(v)
  elseif t == "table" then return encodeTable(v)
  end
  return "null"
end

json.encode = jsonEncodeVal
local jsonEncode = jsonEncodeVal

-- ---------- Decoding ----------

local function utf8Encode(code)
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(
      0xC0 + math.floor(code / 0x40),
      0x80 + (code % 0x40)
    )
  elseif code < 0x10000 then
    return string.char(
      0xE0 + math.floor(code / 0x1000),
      0x80 + (math.floor(code / 0x40) % 0x40),
      0x80 + (code % 0x40)
    )
  else
    return string.char(
      0xF0 + math.floor(code / 0x40000),
      0x80 + (math.floor(code / 0x1000) % 0x40),
      0x80 + (math.floor(code / 0x40) % 0x40),
      0x80 + (code % 0x40)
    )
  end
end

local function skipWs(s, p, len)
  while p <= len do
    local c = s:byte(p)
    if c == 32 or c == 9 or c == 10 or c == 13 then p = p + 1
    else break end
  end
  return p
end

local function decodeString(s, p, len)
  if s:byte(p) ~= 34 then error("expected '\"' at " .. p) end
  p = p + 1
  local result = {}
  while p <= len do
    local b = s:byte(p)
    if b == 34 then
      p = p + 1
      return table.concat(result), p
    elseif b == 92 then
      p = p + 1
      if p > len then error("unexpected end after '\\'") end
      local esc = s:byte(p)
      p = p + 1
      if esc == 34 then result[#result+1] = '"'
      elseif esc == 92 then result[#result+1] = '\\'
      elseif esc == 47 then result[#result+1] = '/'
      elseif esc == 98 then result[#result+1] = '\b'
      elseif esc == 102 then result[#result+1] = '\f'
      elseif esc == 110 then result[#result+1] = '\n'
      elseif esc == 114 then result[#result+1] = '\r'
      elseif esc == 116 then result[#result+1] = '\t'
      elseif esc == 117 then  -- \uXXXX
        if p + 3 > len then error("incomplete \\u escape at " .. p) end
        local hex = s:sub(p, p + 3)
        if not hex:match("^%x%x%x%x$") then error("invalid \\u escape: " .. hex) end
        p = p + 4
        local code = tonumber(hex, 16)
        -- high surrogate: expect a low surrogate
        if code >= 0xD800 and code <= 0xDBFF then
          if p + 5 <= len and s:byte(p) == 92 and s:byte(p + 1) == 117 then
            p = p + 2
            local hex2 = s:sub(p, p + 3)
            if hex2:match("^%x%x%x%x$") then
              local code2 = tonumber(hex2, 16)
              if code2 >= 0xDC00 and code2 <= 0xDFFF then
                p = p + 4
                local cp = 0x10000 + (code - 0xD800) * 0x400 + (code2 - 0xDC00)
                result[#result+1] = utf8Encode(cp)
              else
                error("invalid low surrogate: \\u" .. hex2)
              end
            else
              error("invalid \\u in low surrogate")
            end
          else
            error("missing low surrogate after high surrogate")
          end
        elseif code >= 0xDC00 and code <= 0xDFFF then
          error("unexpected low surrogate")
        else
          -- Latin-1 range (0-255): emit a raw byte with string.char so binary data survives
          -- the server escapes bytes 128-255 as \u00XX; restore them to single bytes
          if code <= 255 then
            result[#result+1] = string.char(code)
          else
            result[#result+1] = utf8Encode(code)
          end
        end
      else
        error("invalid escape: \\" .. string.char(esc))
      end
    elseif b < 32 then
      error("unescaped control char at " .. p)
    else
      result[#result+1] = string.char(b)
      p = p + 1
    end
  end
  error("unterminated string")
end

local function decodeNumber(s, p, len)
  local startPos = p
  if s:byte(p) == 45 then p = p + 1 end  -- -
  local intStart = p
  while p <= len do
    local c = s:byte(p)
    if c >= 48 and c <= 57 then p = p + 1 else break end
  end
  if p == intStart then error("invalid number at " .. startPos) end
  if p <= len and s:byte(p) == 46 then  -- .
    p = p + 1
    local fStart = p
    while p <= len do
      local c = s:byte(p)
      if c >= 48 and c <= 57 then p = p + 1 else break end
    end
    if p == fStart then error("invalid number: no digits after '.'") end
  end
  if p <= len then
    local ec = s:byte(p)
    if ec == 101 or ec == 69 then  -- e/E
      p = p + 1
      if p <= len then
        local sc = s:byte(p)
        if sc == 43 or sc == 45 then p = p + 1 end
      end
      local eStart = p
      while p <= len do
        local c = s:byte(p)
        if c >= 48 and c <= 57 then p = p + 1 else break end
      end
      if p == eStart then error("invalid number: no digits in exponent") end
    end
  end
  local num = tonumber(s:sub(startPos, p - 1))
  if not num then error("invalid number") end
  return num, p
end

local decodeValue

local function decodeObject(s, p, len)
  p = p + 1
  p = skipWs(s, p, len)
  local obj = {}
  if p <= len and s:byte(p) == 125 then p = p + 1; return obj, p end
  while true do
    p = skipWs(s, p, len)
    if p > len or s:byte(p) ~= 34 then error("expected string key at " .. p) end
    local key
    key, p = decodeString(s, p, len)
    p = skipWs(s, p, len)
    if p > len or s:byte(p) ~= 58 then error("expected ':' at " .. p) end
    p = p + 1
    obj[key], p = decodeValue(s, p, len)
    p = skipWs(s, p, len)
    if p > len then error("unexpected end in object") end
    local sep = s:byte(p)
    if sep == 44 then p = p + 1  -- ,
    elseif sep == 125 then p = p + 1; return obj, p  -- }
    else error("expected ',' or '}' at " .. p) end
  end
end

local function decodeArray(s, p, len)
  p = p + 1
  p = skipWs(s, p, len)
  local arr = {}
  if p <= len and s:byte(p) == 93 then p = p + 1; return arr, p end
  local i = 1
  while true do
    arr[i], p = decodeValue(s, p, len)
    i = i + 1
    p = skipWs(s, p, len)
    if p > len then error("unexpected end in array") end
    local sep = s:byte(p)
    if sep == 44 then p = p + 1  -- ,
    elseif sep == 93 then p = p + 1; return arr, p  -- ]
    else error("expected ',' or ']' at " .. p) end
  end
end

decodeValue = function(s, p, len)
  p = skipWs(s, p, len)
  if p > len then error("unexpected end of input") end
  local c = s:byte(p)
  if c == 34 then  -- "
    return decodeString(s, p, len)
  elseif c == 123 then  -- {
    return decodeObject(s, p, len)
  elseif c == 91 then  -- [
    return decodeArray(s, p, len)
  elseif c == 116 then  -- true
    if s:sub(p, p + 3) == "true" then return true, p + 4 end
    error("invalid token at " .. p)
  elseif c == 102 then  -- false
    if s:sub(p, p + 4) == "false" then return false, p + 5 end
    error("invalid token at " .. p)
  elseif c == 110 then  -- null
    if s:sub(p, p + 3) == "null" then return nil, p + 4 end
    error("invalid token at " .. p)
  elseif c == 45 or (c >= 48 and c <= 57) then
    return decodeNumber(s, p, len)
  else
    error("unexpected character '" .. string.char(c) .. "' at " .. p)
  end
end

local function jsonDecode(s)
  if type(s) ~= "string" then return nil, "expected string" end
  local len = #s
  local ok, val, p = pcall(decodeValue, s, 1, len)
  if not ok then return nil, val end
  -- Reject trailing content
  p = skipWs(s, p, len)
  if p <= len then return nil, "trailing content at " .. p end
  return val
end
json.decode = jsonDecode

-- ============================================================
-- stdin/stdout JSON Lines transport
-- ============================================================
-- stdout is unbuffered: flush after every message
_stdout:setvbuf("no")
-- Send a message to the server (write to stdout)
local function sendToServer(msg)
  verifyProjectInfo("sendToServer")
  _stdout:write(jsonEncode(msg) .. "\n")
end

-- Async network requests: callback table plus incrementing ids
local pendingNetCallbacks = {}
local pendingNetId = 0

-- Read one line from stdin (blocking, no timeout)
local function readStdinLine()
  local line = _io_read("*l")
  return line
end

-- ============================================================
-- Command-line parsing: --vm <dir> --json-io
-- ============================================================
local EMU_DIR = arg[0]:match("^(.*[/\\])") or "./"
local vmDir = nil
local jsonIO = false

local i = 1
while i <= #arg do
  if arg[i] == "--vm" and arg[i+1] then
    vmDir = arg[i+1]; i = i + 2
  elseif arg[i] == "--json-io" then
    jsonIO = true; i = i + 1
  elseif arg[i] == "--verbose" then
    verboseLog = true; logLevel = "full"; i = i + 1
  elseif arg[i] == "--log-level" and arg[i+1] then
    local lv = arg[i+1]
    if lv == "verbose" then
      verboseLog = true; logLevel = "full"
    elseif lv == "full" or lv == "error" or lv == "off" then
      logLevel = lv
    end
    i = i + 2
  elseif arg[i]:match("^%-%-vm=") then
    vmDir = arg[i]:sub(6); i = i + 1
  elseif arg[i]:match("^%-%-log%-level=") then
    local lv = arg[i]:sub(13)
    if lv == "verbose" then
      verboseLog = true; logLevel = "full"
    elseif lv == "full" or lv == "error" or lv == "off" then
      logLevel = lv
    end
    i = i + 1
  else
    i = i + 1
  end
end

if not vmDir then
  _stderr:write("[emulator] ERROR: --vm <dir> argument required\n")
  os.exit(1)
end

-- Hide the host command line from guest code. Programs inside the VM inspect arg[0] to
-- locate themselves; here it held the host path of oc-emulator.lua, so the ChatRoom
-- server wrote "/home/C:/Users/.../server.lua" into its autostart script and never
-- started. Real OC exposes no host arguments, so the guest sees nil.
local hostArg = arg
arg = nil

-- Add EMU_DIR to package.path
package.path = EMU_DIR .. "?.lua;" .. package.path

-- Load modules
local disk = require("disk")
-- Mods: unified robot / drone / microcontroller component
local mods = require("mods")
-- Use server wall-clock time for Mods (updated on every tick)
mods.setClock(function()
  local ms = tonumber(mods._wallMs) or 0
  if ms > 0 then return ms / 1000 end
  return os.clock()
end)

-- ============================================================
-- Load config.json from the VM directory
-- ============================================================
local function loadVMConfig(vmDir)
  local cfgPath = vmDir .. "/config.json"
  local f = _io_open(cfgPath, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()

  -- Minimal JSON decoder
  local function decode(str, pos)
    pos = pos or 1
    local function skip()
      while pos <= #str do
        local c = str:byte(pos)
        if c == 32 or c == 9 or c == 10 or c == 13 then pos = pos + 1
        else break end
      end
    end
    local function decodeVal()
      skip()
      local c = str:byte(pos)
      if c == 34 then  -- string "
        pos = pos + 1
        local result = {}
        while pos <= #str do
          local ch = str:byte(pos)
          if ch == 34 then pos = pos + 1; return table.concat(result)
          elseif ch == 92 then  -- \
            pos = pos + 1
            local esc = str:byte(pos)
            pos = pos + 1
            if esc == 34 then result[#result+1] = '"'
            elseif esc == 92 then result[#result+1] = '\\'
            elseif esc == 110 then result[#result+1] = '\n'
            elseif esc == 114 then result[#result+1] = '\r'
            elseif esc == 116 then result[#result+1] = '\t'
            elseif esc == 98 then result[#result+1] = '\b'
            elseif esc == 102 then result[#result+1] = '\f'
            elseif esc == 47 then result[#result+1] = '/'
            elseif esc == 117 then  -- uXXXX
              local hex = str:sub(pos, pos+3); pos = pos + 4
              local code = tonumber(hex, 16) or 0
              if code < 0x80 then result[#result+1] = string.char(code)
              elseif code < 0x800 then
                result[#result+1] = string.char(0xC0 + math.floor(code/0x40), 0x80 + (code%0x40))
              else
                result[#result+1] = string.char(0xE0 + math.floor(code/0x1000), 0x80 + (math.floor(code/0x40)%0x40), 0x80 + (code%0x40))
              end
            end
          else
            result[#result+1] = string.char(ch); pos = pos + 1
          end
        end
        error("unterminated string")
      elseif c == 123 then  -- {
        pos = pos + 1; skip()
        local obj = {}
        if str:byte(pos) == 125 then pos = pos + 1; return obj end
        while true do
          skip()
          local key = decodeVal()
          skip()
          if str:byte(pos) ~= 58 then error("expected ':'") end
          pos = pos + 1
          obj[key] = decodeVal()
          skip()
          local sep = str:byte(pos)
          if sep == 44 then pos = pos + 1
          elseif sep == 125 then pos = pos + 1; return obj
          else error("expected ',' or '}'") end
        end
      elseif c == 91 then  -- [
        pos = pos + 1; skip()
        local arr = {}
        if str:byte(pos) == 93 then pos = pos + 1; return arr end
        local idx = 1
        while true do
          arr[idx] = decodeVal()
          idx = idx + 1
          skip()
          local sep = str:byte(pos)
          if sep == 44 then pos = pos + 1
          elseif sep == 93 then pos = pos + 1; return arr
          else error("expected ',' or ']'") end
        end
      elseif c == 116 then  -- true
        pos = pos + 4; return true
      elseif c == 102 then  -- false
        pos = pos + 5; return false
      elseif c == 110 then  -- null
        pos = pos + 4; return nil
      elseif c == 45 or (c >= 48 and c <= 57) then
        local start = pos
        if str:byte(pos) == 45 then pos = pos + 1 end
        while pos <= #str do
          local b = str:byte(pos)
          if (b >= 48 and b <= 57) or b == 46 or b == 101 or b == 69 or b == 43 or b == 45 then
            pos = pos + 1
          else break end
        end
        return tonumber(str:sub(start, pos - 1))
      end
      error("unexpected char at " .. pos)
    end
    return decodeVal()
  end

  return decode(content)
end

local vmConfig = loadVMConfig(vmDir)
if not vmConfig then
  _stderr:write("[emulator] ERROR: cannot load config.json from " .. vmDir .. "\n")
  os.exit(1)
end

-- Build the config table from vmConfig
local function memTierToSize(tier)
  local sizes = { [1]=192*1024, [1.5]=256*1024, [2]=384*1024, [2.5]=512*1024, [3]=768*1024, [3.5]=1024*1024 }
  return sizes[tier] or 768*1024
end

local function apuTierToGpuTier(apuTier)
  if apuTier == "creative" or apuTier == 0 then return 3 end
  if apuTier == 1 then return 1 end
  if apuTier == 2 then return 2 end
  return 3
end

local hw = vmConfig.hardware or {}
local memSizes = hw.memory or {3, 3}
local apuTier = (hw.apu or {}).tier or 2
local screenTier = (vmConfig.screen or {}).tier or 3

local config = {
  -- Memory: hardware.memoryMB wins when set (0 = empty slot), otherwise derive from the tier
  ramSize = (function()
    local mbList = hw.memoryMB
    if type(mbList) ~= "table" then
      return memTierToSize(memSizes[1] or 3) + memTierToSize(memSizes[2] or 3)
    end
    local function stick(i)
      local mb = tonumber(mbList[i])
      if mb and mb >= 0 then return math.floor(mb * 1024 * 1024) end
      return memTierToSize(memSizes[i] or 3)
    end
    return stick(1) + stick(2)
  end)(),
  screenWidth = screenTier == 1 and 50 or screenTier == 2 and 80 or 160,
  screenHeight = screenTier == 1 and 16 or screenTier == 2 and 25 or 50,
  gpuTier = apuTierToGpuTier(apuTier),
  screenTier = screenTier,
  hddSize = 4096 * 1024,
  -- Disk paths (relative to vmDir)
  disk1File = hw.disk1 and hw.disk1 ~= "empty" and (vmDir .. "/" .. hw.disk1) or nil,
  disk2File = hw.disk2 and hw.disk2 ~= "empty" and (vmDir .. "/" .. hw.disk2) or nil,
  floppyFile = hw.floppy and hw.floppy ~= "empty" and (vmDir .. "/" .. hw.floppy) or nil,
  eepromFile = (hw.eeprom and hw.eeprom ~= "built-in") and (vmDir .. "/" .. hw.eeprom) or nil,
  -- Boot order
  bootOrder = hw.bootOrder,
  -- Expansion cards
  expansion = hw.expansion or {nil, nil, nil},
  -- Unified Mods component (robot / drone / microcontroller), enabled by default
  modsEnabled = hw.mods ~= false,
  -- Mods device mode: created by the control panel, boots the built-in EFI and reports state
  modsDevice = vmConfig.modsDevice == true,
  modsName = hw.modsName,
  modsType = hw.modsType,
  -- Mods device profile (robot: main/offhand tools; drone: speed, etc.)
  robotProfile = hw.robot,
  droneProfile = hw.drone,
  -- APU
  apuTier = apuTier,
  useAPU = true,
}

-- Disk file paths (disk1="empty" loads no disk, allowing floppy-only boot)
config.diskFile = config.disk1File  -- may be nil when disk1="empty"
config.disk2File = config.disk2File
config.floppyFile = config.floppyFile

_stderr:write("[emulator] VM: " .. (vmConfig.name or "unnamed") .. "\n")
_stderr:write("[emulator] APU tier: " .. tostring(apuTier) .. "\n")
_stderr:write("[emulator] RAM: " .. config.ramSize .. " bytes\n")
_stderr:write("[emulator] Screen: " .. config.screenWidth .. "x" .. config.screenHeight .. " (tier " .. screenTier .. ")\n")
_stderr:write("[emulator] Disk1: " .. (config.disk1File or "none") .. "\n")
_stderr:write("[emulator] Disk2: " .. (config.disk2File or "none") .. "\n")
_stderr:write("[emulator] Floppy: " .. (config.floppyFile or "none") .. "\n")
_stderr:write("[emulator] EEPROM: " .. (config.eepromFile or "built-in") .. "\n")

-- Apply Mods device metadata
if config.modsName then mods.setName(config.modsName) end
if config.modsType then mods.setDeviceType(config.modsType) end

-- Apply the device profile (robot tools, drone speed, ...)
if config.robotProfile then mods.setProfile(config.robotProfile) end
if config.droneProfile then mods.setProfile(config.droneProfile) end

-- The Mods EFI uses these globals to report state and read wall-clock time
if config.modsDevice then
  _G.modWallTime = function()
    local ms = tonumber(mods._wallMs) or 0
    if ms > 0 then return ms / 1000 end
    return os.clock()
  end
  _G.modsEmit = function(payload)
    if type(payload) ~= "table" then return end
    local out = {}
    for k, v in pairs(payload) do out[k] = v end
    sendToServer(out)
  end
end

-- Report running state
sendToServer({ type = "state", state = "running" })

-- ============================================================
-- Helpers
-- ============================================================
local function genAddr()
  local hex = "0123456789abcdef"
  local t = {}
  for i = 1, 36 do
    if i == 9 or i == 14 or i == 19 or i == 24 then
      t[i] = "-"
    else
      -- Take a single hex character: must be sub(p, p).
      -- With independent random bounds (hex:sub(math.random(1,16), math.random(1,16)))
      -- several characters come out at once, so addresses vary in length and do not look like UUIDs.
      local p = math.random(1, 16)
      t[i] = hex:sub(p, p)
    end
  end
  return table.concat(t)
end

-- Random seed.
-- Unseeded, every Lua process starts from the same default seed, so each VM generates
-- identical component addresses (two runs produced byte-identical modem addresses). Collisions overwrite
-- the server's address -> VM table and the other VM never receives messages, breaking networking.
-- Mix three entropy sources: time, CPU clock and a heap object address; the server also passes
-- a per-VM seed via OC_VM_SEED so VMs started together still differ.
do
  local entropy = os.time()
  if os.clock then entropy = entropy + math.floor(os.clock() * 1000000) end
  local tblAddr = tonumber(tostring({}):match("0x(%x+)") or "", 16)
  if tblAddr then entropy = entropy + tblAddr end
  local seedStr = os.getenv and os.getenv("OC_VM_SEED") or nil
  if seedStr and #seedStr > 0 then
    local h = 5381
    for i = 1, #seedStr do
      h = (h * 33 + seedStr:byte(i)) % 2147483647
    end
    entropy = entropy + h
  end
  math.randomseed(entropy % 2147483647)
  -- Discard a few values so nearby seeds do not produce similar sequences
  for _ = 1, 5 do math.random() end
end

-- Try LuaFileSystem. lfs is a separate C module that stock Lua lacks,
-- so an lfs-free shell fallback is required; otherwise Linux/macOS would fall back to
-- Windows dir / if exist commands and break (unknown directories, empty listings).
local lfs = nil
pcall(function() lfs = require("lfs") end)

-- Platform check: package.config starts with the directory separator ('\\' = Windows, '/' = POSIX)
local PLATFORM_IS_WINDOWS = (DIR_SEP == "\\")
-- Output redirection (nul on Windows, /dev/null on POSIX)
local SHELL_SILENCE = PLATFORM_IS_WINDOWS and " 2>nul" or " 2>/dev/null"

-- Directory listing fallback (without lfs)
local function shellListDir(path)
  local result = {}
  local cmd = PLATFORM_IS_WINDOWS
    and ('dir /b "' .. path .. '"' .. SHELL_SILENCE)
    or ('ls -A "' .. path .. '"' .. SHELL_SILENCE)
  local f = _io_popen(cmd)
  if f then
    for line in f:lines() do
      if line and #line > 0 then table.insert(result, line) end
    end
    f:close()
  end
  return result
end

-- Directory check fallback (without lfs)
local function shellIsDir(path)
  if not PLATFORM_IS_WINDOWS then
    local pf = _io_popen('test -d "' .. path .. '" && echo 1 || echo 0')
    if pf then
      local r = pf:read("*l")
      pf:close()
      return r == "1"
    end
    return false
  end
  -- Windows: a failed file open may mean a directory
  local f = _io_open(path, "r")
  if f then f:close(); return false end
  local pf = _io_popen('if exist "' .. path .. '\\*" (echo 1) else (echo 0)')
  if pf then
    local r = pf:read("*l")
    pf:close()
    return r == "1"
  end
  return true
end

-- Unified directory listing API
local function fsListDir(path)
  if lfs then
    local result = {}
    for name in lfs.dir(path) do
      if name ~= "." and name ~= ".." then table.insert(result, name) end
    end
    return result
  end
  return shellListDir(path)
end

-- Unified directory check API
local function fsIsDir(path)
  if lfs then
    local attr = lfs.attributes(path)
    return attr and attr.mode == "directory"
  end
  return shellIsDir(path)
end

-- Create a directory without lfs. POSIX uses mkdir -p to create parents too.
local function fsMkdir(path)
  if lfs then
    pcall(function() lfs.mkdir(path) end)
    return true
  end
  local cmd = PLATFORM_IS_WINDOWS
    and ('mkdir "' .. path .. '"' .. SHELL_SILENCE)
    or ('mkdir -p "' .. path .. '"' .. SHELL_SILENCE)
  _os_execute_raw(cmd)
  return true
end

local function normalizePath(path)
  path = path:gsub("\\", "/")
  if path:sub(1, 1) ~= "/" then path = "/" .. path end
  return path
end

-- ============================================================
-- Virtual disk images (disk.lua .ocd format)
-- ============================================================
local vdisk = { files = {}, label = "OpenOS", modified = 0, size = 4 * 1024 * 1024, tier = 3 }

-- Save a disk to file (.ocd format)
local function saveDisk(path)
  if projectPath then return true end  -- project mode does not persist disks
  local size = vdisk.size or config.hddSize or (4 * 1024 * 1024)
  local tier = vdisk.tier or 3
  -- Write back the disk's own size/tier; using config.hddSize would inflate small disks
  -- to 4MB and force tier 3, contradicting what the disk declares.
  local ok, err = disk.save(path, vdisk.label, vdisk.files, size, tier, false)
  if not ok then
    _stderr:write("[emulator] WARNING: save disk1 failed: " .. tostring(err) .. "\n")
  end
  return ok, err
end

-- Forward declarations: label and file tables for fs2/floppy/eeprom, assigned later
-- (saveAllDisks is defined above and references them)
local fs2Files, fs2Label, fs2Size, fs2Tier, floppyFiles, floppyLabel, floppyLocked
local eepromData, eepromLabel, eepromCode

-- Save all disks and the EEPROM (called on shutdown or abnormal exit)
local function saveAllDisks()
  if config.diskFile then
    saveDisk(config.diskFile)
  end
  -- disk2: if mounted, write back the fs2 proxy's label and files
  if config.disk2File and fs2Files and fs2Label then
    local ok, err = pcall(function()
      local size2 = fs2Size or (4 * 1024 * 1024)
      local tier2 = fs2Tier or 3
      local ok2, err2 = disk.save(config.disk2File, fs2Label, fs2Files, size2, tier2, false)
      if not ok2 then error(err2 or "disk2 save failed") end
    end)
    if not ok then _stderr:write("[emulator] WARNING: save disk2 failed: " .. tostring(err) .. "\n") end
  end
  -- floppy: same, using the .ocf floppy format
  if config.floppyFile and floppyFiles and floppyLabel then
    local ok, err = pcall(function()
      disk.saveFloppy(config.floppyFile, floppyLabel, floppyFiles, config.floppySize or (512 * 1024), floppyLocked)
    end)
    if not ok then _stderr:write("[emulator] WARNING: save floppy failed: " .. tostring(err) .. "\n") end
  end
  -- No EEPROM write-back: eeprom.set() persists immediately, and writing the in-memory copy
  -- would overwrite the EFI the control panel just saved.
end

-- ============================================================
-- Disk write-through
-- Mark the disk dirty on any write, then flush the file periodically (1 s by default)
-- and immediately on a shutdown / flush command.
-- Writing back only on a clean shutdown (computer.shutdown or end of process) loses
-- the in-memory install when the VM is killed mid-install (user presses stop -> SIGTERM after
-- 3 s, or the service shuts down) and the next boot starts over.
-- ============================================================
local diskPersist = { dirty = false, lastFlush = 0, interval = 1, job = nil, slice = 0.12 }

-- Background flush task (coroutine)
--
-- A full save does serialize + LZW + encrypt, 2-4 s of CPU for a 3 MB disk. Doing it inline
-- in tick handling blocks event pulls and redraws, visibly freezing the UI.
-- So saveAllDisks runs in a coroutine, one slice per tick (120 ms by default); the guest
-- stays responsive and the disk file is replaced atomically once the slices finish.
--
-- Task state and tuning live on diskPersist to avoid more top-level locals.

-- Advance the background flush; budget is the maximum CPU seconds to spend.
-- true when the task finished (or there was none), false when it is unfinished or failed.
function diskPersist.stepJob(budget)
  local job = diskPersist.job
  if not job then return true end
  local deadline = _os_clock() + budget
  disk.setYieldHook(coroutine.yield)
  while true do
    local ok, res = coroutine.resume(job)
    if not ok then
      disk.setYieldHook(nil)
      diskPersist.job = nil
      _stderr:write("[emulator] WARNING: autosave disks failed: " .. tostring(res) .. "\n")
      return false
    end
    if coroutine.status(job) == "dead" then
      disk.setYieldHook(nil)
      diskPersist.job = nil
      return true
    end
    if _os_clock() >= deadline then
      disk.setYieldHook(nil)
      return false
    end
  end
end

function diskPersist.mark()
  diskPersist.dirty = true
end

-- Flush synchronously (shutdown, rename, exit: cases that must take effect immediately).
-- If a background slice task is still running, let it finish first: it holds an old snapshot
-- and would write stale data over the new result after the file swap.
function diskPersist.saveNow()
  if diskPersist.job then diskPersist.stepJob(math.huge) end
  saveAllDisks()
end

function diskPersist.flush(force)
  -- Background task exists: advance one slice, or when forced, finish it (it holds an old snapshot)
  if diskPersist.job then
    diskPersist.stepJob(force and math.huge or diskPersist.slice)
    if diskPersist.job then return end
  end
  if not diskPersist.dirty then return end
  local now = os.time()
  if not force and (now - diskPersist.lastFlush) < diskPersist.interval then return end
  diskPersist.lastFlush = now
  diskPersist.dirty = false
  diskPersist.job = coroutine.create(saveAllDisks)
  local done = diskPersist.stepJob(force and math.huge or diskPersist.slice)
  if not done and not diskPersist.job then
    -- Keep the dirty flag on failure and retry next round instead of losing data silently
    diskPersist.dirty = true
  end
end

-- Load a disk from file (.ocd and legacy .img)
local function loadDisk(path)
  -- Try .ocd first
  local loaded = disk.load(path)
  if loaded then
    vdisk.label = loaded.label or "Untitled"
    vdisk.files = loaded.files or {}
    vdisk.size = loaded.size or config.hddSize
    vdisk.tier = loaded.tier or 3
    return true
  end
  -- Fall back to the legacy Lua-table format
  local f = _io_open(path, "rb")
  if not f then return false end
  local data = f:read("*a")
  f:close()
  local fn = (loadstring or load)(data)
  if fn then
    local ok, result = pcall(fn)
    if ok and type(result) == "table" then
      vdisk.label = result.label or "OpenOS"
      vdisk.files = result.files or {}
      vdisk.size = config.hddSize
      vdisk.tier = 3
      return true
    end
  end
  return false
end

-- Virtual filesystem operations
local function vfsNormalize(p)
  p = normalizePath(p)
  -- Resolve .. and .
  local parts = {}
  for part in p:gmatch("[^/]+") do
    if part == ".." then
      table.remove(parts)
    elseif part ~= "." then
      table.insert(parts, part)
    end
  end
  return "/" .. table.concat(parts, "/")
end

local function vfsExists(path)
  path = vfsNormalize(path)
  if projectPath then
    if path == "/" then return true end
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    local f = _io_open(realPath, "r")
    if f then f:close(); return true end
    return fsIsDir(realPath)
  end
  if path == "/" then return true end
  -- explicit entry
  if vdisk.files[path] ~= nil then return true end
  -- Implicit directory: a child entry starts with path/
  local prefix = path .. "/"
  for p in pairs(vdisk.files) do
    if p:sub(1, #prefix) == prefix then return true end
  end
  return false
end

local function vfsIsDirectory(path)
  path = vfsNormalize(path)
  if projectPath then
    if path == "/" then return true end
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    return fsIsDir(realPath)
  end
  if path == "/" then return true end
  -- Implicit directory: treat as a directory when a child entry starts with path/
  local prefix = path .. "/"
  for p in pairs(vdisk.files) do
    if p:sub(1, #prefix) == prefix then
      return true
    end
  end
  -- explicit directory entry
  local info = vdisk.files[path]
  return info and (info.type == "directory" or info.type == "dir")
end

local function vfsList(path)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    return fsListDir(realPath)
  end
  local prefix = path == "/" and "/" or path .. "/"
  -- Collect direct child names
  local childNames = {}
  for p in pairs(vdisk.files) do
    if p:sub(1, #prefix) == prefix then
      local rest = p:sub(#prefix + 1)
      if rest ~= "" then
        local slashPos = rest:find("/")
        local name = slashPos and rest:sub(1, slashPos - 1) or rest
        childNames[name] = true
      end
    end
  end
  -- Classify each child as file or directory
  local result = {}
  for name in pairs(childNames) do
    local childPath = path == "/" and "/" .. name or path .. "/" .. name
    if vfsIsDirectory(childPath) then
      table.insert(result, name .. "/")
    else
      table.insert(result, name)
    end
  end
  return result
end

local function vfsMkdir(path)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    fsMkdir(realPath)
    return true
  end
  if vdisk.files[path] then return false end
  -- Create the parent directory
  local parent = vfsNormalize(path:match("^(.*/)[^/]+$") or "/")
  if parent ~= "/" and not vdisk.files[parent] then
    vfsMkdir(parent)
  end
  vdisk.files[path] = { type = "directory", modified = os.time() }
  diskPersist.mark()
  return true
end

local function vfsWrite(path, content)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    -- Ensure the parent directory exists
    local parentDir = realPath:match("^(.+)[/\\][^/\\]+$")
    if parentDir then
      fsMkdir(parentDir)
    end
    local f = _io_open(realPath, "wb")
    if f then f:write(content or ""); f:close(); return true end
    return false
  end
  -- Create the parent directory
  local parent = vfsNormalize(path:match("^(.*/)[^/]+$") or "/")
  if parent ~= "/" and not vdisk.files[parent] then
    vfsMkdir(parent)
  end
  vdisk.files[path] = { type = "file", content = content, modified = os.time() }
  diskPersist.mark()
  return true
end

local function vfsRead(path)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    local f = _io_open(realPath, "rb")
    if f then local c = f:read("*a"); f:close(); return c end
    return nil
  end
  local info = vdisk.files[path]
  if info and info.type == "file" then
    return info.content or ""
  end
  return nil
end

local function vfsRemove(path)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    if PLATFORM_IS_WINDOWS then
      _os_execute_raw('rmdir /s /q "' .. realPath .. '"' .. SHELL_SILENCE)
      _os_execute_raw('del /q "' .. realPath .. '"' .. SHELL_SILENCE)
    else
      -- POSIX: one rm -rf covers files and directories
      _os_execute_raw('rm -rf "' .. realPath .. '"' .. SHELL_SILENCE)
    end
    return true
  end
  local prefix = path .. "/"
  for p in pairs(vdisk.files) do
    if p == path or p:sub(1, #prefix) == prefix then
      vdisk.files[p] = nil
    end
  end
  diskPersist.mark()
  return true
end

local function vfsSize(path)
  path = vfsNormalize(path)
  if projectPath then
    local realPath = projectPath .. path:gsub("/", DIR_SEP)
    local f = _io_open(realPath, "rb")
    if f then local c = f:read("*a"); f:close(); return #c end
    return 0
  end
  local info = vdisk.files[path]
  if info then
    if info.type == "file" then return #info.content end
    return 0
  end
  return 0
end

local function vfsSpaceUsed()
  if projectPath then return 0 end
  local total = 0
  for _, info in pairs(vdisk.files) do
    if info.content then total = total + #info.content end
  end
  return total
end

local function vfsRename(from, to)
  from = vfsNormalize(from)
  to = vfsNormalize(to)
  local prefixFrom = from .. "/"
  for p, info in pairs(vdisk.files) do
    if p == from then
      vdisk.files[to] = info
      vdisk.files[p] = nil
    elseif p:sub(1, #prefixFrom) == prefixFrom then
      local newPath = to .. p:sub(#prefixFrom)
      vdisk.files[newPath] = info
      vdisk.files[p] = nil
    end
  end
  diskPersist.mark()
  return true
end

-- Open file handles (vfs-backed)
local openHandles = {}
local handleCount = 0

-- ============================================================
-- Signal queue
-- ============================================================
local signalQueue = {}
-- Component addresses used by dispatchServerMessage/pushSignal but defined later
local gpuAddr = nil
local screenAddr = nil
local keyboardAddr = nil
local screen  -- Forward declaration: screen is defined later, referenced by dispatchServerMessage/sendScreenUpdate
local fsAddr = nil
local eepromAddr = nil
local modemAddr = nil
local function pushSignal(name, ...)
  table.insert(signalQueue, {name, ...})
  if name == "scroll" then
    ilog("pushSignal: scroll queueSize=" .. #signalQueue .. " x=" .. tostring(select(2, ...)) .. " y=" .. tostring(select(3, ...)) .. " delta=" .. tostring(select(4, ...)))
  end
end

-- Read and parse one JSON line from stdin (used by pullSignal in JSON mode)
-- Returns the decoded table, or nil on EOF/error
local function readJSONInput(timeout)
  verifyProjectInfo("readJSONInput")
  -- io.read("*l") blocks and has no timeout
  -- the server sends a tick when the timeout expires, so a blocking read is fine
  local line = _io_read("*l")
  if not line or line == "" then return nil end
  -- use the embedded JSON decoder
  local ok, msg = pcall(jsonDecode, line)
  if not ok then
    dlog("readJSONInput: parse error:", msg, "line:", line:sub(1, 80))
    return nil
  end
  return msg
end

-- Pause flag (must be declared before dispatchServerMessage)
local vmPaused = false
-- Forward declarations: componentRegistry, floppyAddr and computer are defined later but used here
local componentRegistry
local floppyAddr
local computer
-- External RAM usage pushed by the server (actual process memory)
local _externalRamUsed = 0
local _externalRamTotal = 0

-- Turn server JSON messages into OC signals and enqueue them
local function dispatchServerMessage(msg)
  verifyProjectInfo("dispatchServerMessage")
  if type(msg) ~= "table" then return end
  -- The server sends a tick every 50 ms to 10 s, carrying wall-clock time for Mods drones and state
  if msg.wall then
    mods._wallMs = tonumber(msg.wall) or mods._wallMs
    -- Stamp the host clock so uptime can extrapolate between server ticks
    mods._wallCpu = _os_clock()
  end
  local t = msg.type
  -- External devices: list and state snapshot
  if t == "ext_devices" then
    if extComponents then extComponents.apply(msg.devices) end
    return
  end
  if t == "ext_state" then
    if extComponents then extComponents.update(msg.devices) end
    return
  end
  -- Convert frontend "OC pixel coordinates" into the coordinates OC signals actually use.
  --
  -- In precise mode (setPrecise) OC does not return pixels but 0-based fractional
  -- character coordinates (pixels / 6 or 9). MineOS GUI converts them back with math.ceil(e3)
  -- (Libraries/GUI.lua, isScreenEvent branch). Sending raw pixels means the
  -- rounded value still exceeds the grid size, hit tests always fail and clicks/scroll do nothing.
  -- Non-precise mode uses 1-based integer character coordinates.
  local function screenInputCoords(m)
    local px = tonumber(m.px)
    local py = tonumber(m.py)
    if screen and screen._precise and px and py then
      return (px - 1) / 6, (py - 1) / 9
    end
    return tonumber(m.x) or 1, tonumber(m.y) or 1
  end

  if t == "input" then
    -- Input event: { type:"input", event:"key_down", char:97, code:30 }
    local ev = msg.event
    dlog("dispatchServerMessage: input event:", tostring(ev), "char:", tostring(msg.char), "code:", tostring(msg.code))
    if ev == "key_down" or ev == "key_up" then
      local code = msg.code or 0
      -- Update modifier state
      if code == 0x2A or code == 0x36 then  -- lshift, rshift
        keyboard._shift = (ev == "key_down")
      elseif code == 0x1D or code == 0x9D then  -- lcontrol, rcontrol
        keyboard._control = (ev == "key_down")
      elseif code == 0x38 or code == 0xB8 then  -- lalt, ralt
        keyboard._alt = (ev == "key_down")
      end
      -- OC key_down/up signal: (address, char, code, player)
      -- the 4th argument, player, must be a string; a number breaks OpenOS keyboard.lua
      pushSignal(ev, keyboardAddr, msg.char or 0, code, "player")
    elseif ev == "touch" or ev == "drag" or ev == "drop" then
      -- OC signal: touch/drag/drop(address, x, y, button, playerName)
      -- in OC a mouse release is called "drop", not "up"
      if not screen then return end  -- ignore events until the screen component exists
      local mx, my = screenInputCoords(msg)
      pushSignal(ev, screenAddr, mx, my, msg.btn or 0, "player")
    elseif ev == "scroll" then
      -- OC scroll signal: scroll(address, x, y, direction, playerName)
      if not screen then
        ilog("INPUT: scroll ignored (screen not ready)")
        return
      end
      local sx, sy = tonumber(msg.x) or 1, tonumber(msg.y) or 1
      -- Scrolling only needs the character cell under the cursor, not sub-cell precision, and
      -- integer cell coordinates hit correctly in both modes (MineOS rounds with math.ceil).
      -- So skip screenInputCoords here to avoid the precise-mode coordinate space
      -- breaking hit tests.
      ilog("INPUT: scroll x=" .. tostring(sx) .. " y=" .. tostring(sy)
        .. " delta=" .. tostring(msg.delta or 1) .. " precise=" .. tostring(screen._precise))
      pushSignal("scroll", screenAddr, sx, sy, msg.delta or 1, "player")
    elseif ev == "clipboard" then
      pushSignal("clipboard", keyboardAddr, msg.text or "")
    end
  elseif t == "tick" then
    -- Heartbeat: not queued, just wakes pullSignal
    -- Also check for dirty disks (write back, throttled to 1 s)
    diskPersist.flush()
  elseif t == "ram_update" then
    -- RAM sync: update the externally visible process memory
    -- computer.freeMemory() uses it to compute free memory
    if msg.used ~= nil then
      _externalRamUsed = tonumber(msg.used) or _externalRamUsed
    end
    if msg.total ~= nil then
      _externalRamTotal = tonumber(msg.total) or _externalRamTotal
    end
  elseif t == "battery" then
    -- Power sync: update computer.energy and computer.maxEnergy
    if computer and computer._energy ~= nil then
      if msg.energy ~= nil then
        computer._energy = tonumber(msg.energy) or computer._energy
      end
      if msg.maxEnergy ~= nil then
        computer._maxEnergy = tonumber(msg.maxEnergy) or computer._maxEnergy
      end
    end
  elseif t == "command" then
    if msg.cmd == "shutdown" then
      -- Flush disks before a soft shutdown: if the guest ignores shutdown and the server
      -- kills it after 3 s, this write is not lost.
      diskPersist.flush(true)
      -- Soft shutdown signal
      pushSignal("shutdown")
    elseif msg.cmd == "flush" then
      -- Explicit flush request (sent before stopping a VM as a safety net)
      diskPersist.flush(true)
    elseif msg.cmd == "pause" then
      vmPaused = true
    elseif msg.cmd == "resume" then
      vmPaused = false
    elseif msg.cmd == "mod_command" then
      -- Local command from the control panel to the Mods device EFI
      pushSignal("mod_command", msg.data)
    elseif msg.cmd == "floppy_reload" then
      -- Reload the floppy image (hot swap)
      -- msg.data may carry a new file path (optional)
      local floppyPath = config.floppyFile
      if msg.data and msg.data.path then
        floppyPath = msg.data.path
        config.floppyFile = floppyPath
      end
      if floppyPath then
        local loadedF = disk.loadFloppy(floppyPath)
        if loadedF then
          -- Drop existing files
          for k in pairs(floppyFiles) do floppyFiles[k] = nil end
          -- Copy the new content
          for k, v in pairs(loadedF.files or {}) do floppyFiles[k] = v end
          -- Mark dirty and flush now so a hot-swapped floppy survives a hard kill
          diskPersist.mark()
          diskPersist.flush(true)
          -- Update the label
          if loadedF.label then
            pcall(function() floppy.setLabel(loadedF.label) end)
          end
          -- Register the floppy component lazily if it is not registered yet
          if not componentRegistry[floppyAddr] then
            componentRegistry[floppyAddr] = { type = "filesystem", proxy = floppy }
            pushSignal("component_added", floppyAddr, "filesystem")
          else
            -- Emit component_changed
            pushSignal("component_removed", floppyAddr, "filesystem")
            pushSignal("component_added", floppyAddr, "filesystem")
          end
          _stderr:write("[emulator] Floppy reloaded: " .. (loadedF.label or "Floppy") .. "\n")
        else
          _stderr:write("[emulator] WARNING: cannot reload floppy: " .. floppyPath .. "\n")
        end
      else
        _stderr:write("[emulator] Floppy reload: no floppy file configured\n")
      end
    end
  elseif t == "modem_message" then
    -- modem message from another VM
    -- OC signature: modem_message(receiverAddress, senderAddress, port, distance, ...payload)
    -- Order matters: passing the data table as distance with a hardcoded 1,1 payload
    -- misaligns the message body: the signal arrives but the content is wrong or missing.
    local unpackFn = table.unpack or unpack
    local payload = msg.data
    if type(payload) ~= "table" then payload = { payload } end
    local n = msg.n
    if not n then
      -- Use the largest integer key as the length: JSON nulls become Lua holes, so #payload
      -- truncates values after a hole (e.g. ("network","response","read",null,"invalid handle")
      -- would drop "invalid handle", giving the guest a wrong result).
      n = 0
      for k in pairs(payload) do
        if type(k) == "number" and k == math.floor(k) and k > n then n = k end
      end
    end
    pushSignal("modem_message", modemAddr, msg.from or "", msg.port or 0, msg.distance or 0, unpackFn(payload, 1, n))
  elseif t == "net_response" or t == "net_tcp_connected"
    or t == "net_tcp_read_result" or t == "net_tcp_write_result" then
    -- Result of a network request or socket op, handed to the registered callback
    local cb = pendingNetCallbacks[msg.reqId]
    if cb then
      pendingNetCallbacks[msg.reqId] = nil
      cb(msg)
    end
  end
end

-- Forward declaration of flushRender (implemented in the screen section)
local flushRender

local function pullSignal(timeout)
  verifyProjectInfo("pullSignal")
  dlog("pullSignal called, timeout:", tostring(timeout), "queue:", #signalQueue)
  -- Check the signal queue first
  if #signalQueue > 0 then
    flushRender()
    local sig = table.remove(signalQueue, 1)
    dlog("pullSignal: from queue:", sig[1], "code:", tostring(sig[4]))
    if sig[1] == "scroll" then
      ilog("pullSignal: scroll x=" .. tostring(sig[3]) .. " y=" .. tostring(sig[4]) .. " delta=" .. tostring(sig[5]) .. " queueSize=" .. #signalQueue)
    end
    return table.unpack(sig)
  end

  -- timeout=0 means non-blocking (return immediately)
  -- In JSON mode input arrives on stdin; not reading means no input
  -- so even timeout=0 must read once (the server answers instantly with a tick)
  if type(timeout) ~= "number" then timeout = nil end
  if timeout and timeout <= 0 then
    if not jsonIO then
      flushRender()
      return nil
    end
    -- Non-blocking poll: always ask the server and block on stdin. The server
    -- answers after a short delay, which caps the poll rate and keeps this
    -- process idle. Throttling here with os.clock() instead was wrong: on
    -- Linux/Android that clock measures CPU time, so the check never passed
    -- in a sleeping loop, the request was skipped and the guest spun forever
    -- (MineOS froze on its boot animation).
    timeout = 0  -- 0 ms; the server answers with a tick or input plus a tick
  end

  if jsonIO then
    -- JSON mode: tell the server we are waiting, then read stdin
    -- timeout is in seconds in Lua and milliseconds on the server, hence * 1000
    -- nil / huge values use a 5000 ms heartbeat
    local timeoutMs
    if not timeout or timeout == math.huge or timeout > 3600 then
      timeoutMs = 5000
    else
      timeoutMs = math.floor(timeout * 1000)
    end
    sendToServer({ type = "pull_signal", timeout = timeoutMs })
    -- Block on stdin until a signal arrives or EOF
    while true do
      -- Paused: block until resume arrives
      while vmPaused do
        local msg = readJSONInput(0)
        if not msg then
          flushRender()
          return nil
        end
        dispatchServerMessage(msg)
      end
      -- The server may push messages while waiting, so handle them first
      -- Flush the screen before blocking so the latest frame is sent (otherwise GUI waits freeze the display)
      flushRender(true) -- force a flush before the blocking read
      local msg = readJSONInput(timeout)
      if not msg then
        -- stdin EOF: exit
        flushRender()
        return nil
      end
      dispatchServerMessage(msg)
      -- dispatching may enqueue new signals
      if #signalQueue > 0 then
        flushRender()
        local sig = table.remove(signalQueue, 1)
        if sig[1] == "scroll" then
          ilog("pullSignal(loop): scroll x=" .. tostring(sig[3]) .. " y=" .. tostring(sig[4]) .. " delta=" .. tostring(sig[5]) .. " queueSize=" .. #signalQueue)
        end
        return table.unpack(sig)
      end
      -- otherwise keep reading (the server's tick after the timeout returns nil)
      -- tick = heartbeat/timeout: always return nil
      -- (timeout=nil waits forever, but the server still sends periodic ticks)
      if msg.type == "tick" then
        flushRender()
        return nil
      end
    end
  end

  -- Legacy file mode: only without --json-io, kept for old callers
  if not config.inputFile then return nil end
  local startTime = os.clock()
  local maxWait = timeout or math.huge
  local checkInterval = 0.05
  while true do
    local tmpFile = config.inputFile .. ".tmp"
    local renamed = os.rename(config.inputFile, tmpFile)
    if renamed then
      local f = _io_open(tmpFile, "rb")
      if f then
        local data = f:read("*a")
        f:close()
        _os_remove(tmpFile)
        if data and #data > 0 then
          if data:byte(1) == 0xEF and data:byte(2) == 0xBB and data:byte(3) == 0xBF then
            data = data:sub(4)
          end
          local pos = 1
          while pos <= #data do
            local nl = data:find("\n", pos)
            local lineEnd = nl or (#data + 1)
            local line = data:sub(pos, lineEnd - 1)
            pos = lineEnd + 1
            if #line > 0 then
              local typ, val = line:match("^([^:]+):(.*)$")
              if typ == "key_down" or typ == "key" then
                local lastColon = val:match(".*():") or 0
                local charStr = val:sub(1, lastColon - 1)
                local codeStr = val:sub(lastColon + 1)
                local code = tonumber(codeStr) or 0
                -- OC key_down char must be a Unicode code point (number)
                local char = tonumber(charStr) or (charStr:byte() or 0)
                pushSignal("key_down", keyboardAddr, char, code, "player")
              elseif typ == "key_up" then
                local lastColon = val:match(".*():") or 0
                local charStr = val:sub(1, lastColon - 1)
                local codeStr = val:sub(lastColon + 1)
                local code = tonumber(codeStr) or 0
                local char = tonumber(charStr) or (charStr:byte() or 0)
                pushSignal("key_up", keyboardAddr, char, code, "player")
              elseif typ == "touch" then
                local x, y, btn = val:match("^(%d+),(%d+),(%d+)$")
                pushSignal("touch", screenAddr, tonumber(x) or 1, tonumber(y) or 1, tonumber(btn) or 0)
              elseif typ == "drag" then
                local x, y, btn = val:match("^(%d+),(%d+),(%d+)$")
                pushSignal("drag", screenAddr, tonumber(x) or 1, tonumber(y) or 1, tonumber(btn) or 0)
              elseif typ == "drop" then
                local x, y, btn = val:match("^(%d+),(%d+),(%d+)$")
                pushSignal("drop", screenAddr, tonumber(x) or 1, tonumber(y) or 1, tonumber(btn) or 0)
              elseif typ == "clipboard" then
                pushSignal("clipboard", keyboardAddr, val)
              end
            end
          end
          if #signalQueue > 0 then
            local sig = table.remove(signalQueue, 1)
            return table.unpack(sig)
          end
        end
      end
    end
    local elapsed = os.clock() - startTime
    if elapsed >= maxWait then return nil end
    local sleepTime = math.min(checkInterval, maxWait - elapsed)
    if sleepTime > 0 then
      local t0 = os.clock()
      while os.clock() - t0 < sleepTime do end
    end
  end
end

-- ============================================================
-- computer API
-- ============================================================
-- Assign the forward-declared local (see "local computer" above dispatchServerMessage)
-- instead of declaring a new one: a second "local computer" would shadow it, leaving the
-- message dispatcher with a nil upvalue, so battery sync (computer.energy) was dropped.
computer = {
  _address = genAddr(),
  _tmpAddr = nil,
  _bootAddr = nil,
  _energy = 100000,       -- full charge by default (matches server maxEnergy; 100000 = tier-2 battery)
  _maxEnergy = 100000,   -- default 100000 EU (tier-2 battery); stay at 100% when no reading is available
  _totalMemory = config.ramSize,
  _runlevel = "S",
}
local showScreenMessage  -- Forward declaration used by computer.shutdown and others
function computer.address() return computer._address end
function computer.tmpAddress() return computer._tmpAddr end
function computer.freeMemory()
  -- Prefer the externally pushed process memory (more accurate) when valid,
  -- otherwise fall back to the Lua GC estimate
  local used
  if _externalRamTotal and _externalRamTotal > 0 and _externalRamUsed and _externalRamUsed > 0 then
    used = _externalRamUsed
  else
    used = math.floor(collectgarbage("count") * 1024)
  end
  if used > config.ramSize then used = config.ramSize end
  return config.ramSize - used
end
function computer.totalMemory() return computer._totalMemory end
function computer.energy() return computer._energy end
function computer.maxEnergy() return computer._maxEnergy end
-- Uptime must follow wall-clock time. On Linux/Android os.clock() reports CPU time,
-- which barely advances while the guest waits for events; the MineOS boot screen paces
-- itself with computer.uptime(), so on phones it stayed forever on "MineOS EFI" while it
-- booted on Windows (there clock() already returns wall time).
-- The server stamps every tick with Date.now(); the host clock only fills the gaps
-- between those stamps, so uptime keeps advancing even without incoming messages.
function computer._wallSeconds()
  local ms = tonumber(mods._wallMs) or 0
  if ms > 0 then
    local stamp = tonumber(mods._wallCpu) or _os_clock()
    local drift = _os_clock() - stamp
    if drift < 0 or drift > 10 then drift = 0 end
    return ms / 1000 + drift, "server"
  end
  if socket then return socket.gettime(), "socket" end
  return _os_clock(), "cpu"
end
function computer.uptime()
  local now, src = computer._wallSeconds()
  local anchor = computer._uptimeAnchor
  if not anchor then
    computer._uptimeAnchor = { src = src, base = now, elapsed = 0 }
    return 0
  end
  -- The first server tick replaces the CPU-clock fallback: keep the elapsed time continuous
  if anchor.src ~= src then
    anchor.src = src
    anchor.base = now - anchor.elapsed
  end
  local d = now - anchor.base
  if d < 0 then
    -- The clock source stepped backwards: hold the last value instead of going back
    d = anchor.elapsed
    anchor.base = now - d
  end
  anchor.elapsed = d
  return d
end
function computer.shutdown(reboot)
  -- Save all disks and the EEPROM
  diskPersist.saveNow()
  _stderr:write("[emulator] computer " .. (reboot and "reboot" or "shutdown") .. "\n")
  if reboot then
    showScreenMessage("Rebooting...")
  else
    showScreenMessage("System shut down.\nPress any key to restart.")
  end
  -- Use the host os.exit: the guest may replace os.exit (Fuchas ties it to the current process)
  _os_exit(reboot and 2 or 0)
end
function computer.getBootAddress() return computer._bootAddr end
function computer.setBootAddress(addr) dlog("setBootAddress:", tostring(addr):sub(1,8)); computer._bootAddr = addr end
function computer.runlevel() return computer._runlevel end
-- Architectures: the emulator reports only Lua 5.3.
-- MineOS Settings -> System lists architectures via getArchitectures() and highlights
-- the current one via getArchitecture(); a missing API raises "attempt to call a nil value".
local ARCHITECTURE_NAME = "Lua 5.3"
function computer.getArchitectures() return { ARCHITECTURE_NAME } end
function computer.getArchitecture() return ARCHITECTURE_NAME end
function computer.setArchitecture(arch) return arch == ARCHITECTURE_NAME end
function computer.users() return "admin" end
function computer.addUser() return true end
function computer.removeUser() return true end
function computer.pushSignal(name, ...) pushSignal(name, ...) end
-- Signal forwarding must pass through every return value unchanged.
-- Taking only 8 return values (e1..e8) breaks modem_message, whose signature is
--   name, receiver, sender, port, distance, payload[1], payload[2], payload[3], ...
-- Values from the 9th on are truncated. MineOS networking sends ("network","response",method,data),
-- so the data always lands 9th and is dropped, leaving text.deserialize(nil) to crash.
-- ("Text.lua:98: bad argument #1 (string expected, got nil)")。
local _packArgs = table.pack or function(...) return { n = select("#", ...), ... } end
local _unpackArgs = table.unpack or unpack
function computer.pullSignal(timeout)
  local r = _packArgs(pullSignal(timeout))
  if r[1] then
    dlog("computer.pullSignal ->", r[1], "char:", tostring(r[3]), "code:", tostring(r[4]))
  else
    dlog("computer.pullSignal -> nil (timeout)")
  end
  return _unpackArgs(r, 1, r.n)
end
function computer.beep(freq, dur) end
function computer.getProgramLocations() return {} end

-- Maximum modem packet size (real OC's modem.maxPacketSize() / DeviceInfo.capacity default).
-- MineOS networking (Libraries/Network.lua) uses it to fragment large messages:
--   available via modem.maxPacketSize() or computer.getDeviceInfo()[addr].capacity.
-- If both are missing the fragment size becomes nil, large replies (FTP listings) cannot be sent
-- and the client ends up with "Text.lua:98: bad argument #1 (string expected, got nil)".
local MODEM_MAX_PACKET_SIZE = 8192

function computer.getDeviceInfo()
  local result = { [computer._address] = { description = "OC Emulator", product = "Emulator" } }
  -- Real OC also returns info per component (including modem capacity)
  for addr, reg in pairs(componentRegistry or {}) do
    result[addr] = {
      type = reg.type,
      address = addr,
      description = reg.type,
      product = "OC Emulator",
      vendor = "OC Emulator",
      capacity = (reg.type == "modem") and MODEM_MAX_PACKET_SIZE or nil,
    }
  end
  return result
end

-- ============================================================
-- Screen buffer
-- ============================================================
local Screen = {
  width = config.screenWidth,
  height = config.screenHeight,
  bg = {}, fg = {}, char = {},
  bgi = {}, fgi = {},
}
for y = 1, Screen.height do
  Screen.bg[y] = {}; Screen.fg[y] = {}; Screen.char[y] = {}
  Screen.bgi[y] = {}; Screen.fgi[y] = {}
  for x = 1, Screen.width do
    Screen.bg[y][x] = 0x000000; Screen.fg[y][x] = 0xFFFFFF; Screen.char[y][x] = " "
  end
end

-- JSON mode: track dirty cells and send incremental or full updates
local dirtyMap = {}     -- key = y*1000 + x, value = true (dedupe)
local dirtyCount = 0
local screenInitialized = false
local renderScheduled = false  -- dirty regions pending?
local _lastFlushTime = 0       -- last flush time (os.clock seconds)
local _minFrameInterval = 1/20 -- minimum frame interval: ~20 fps is smooth enough for a terminal

local function sendScreenUpdate()
  if not jsonIO then
    -- legacy file mode: write screen.dat
    local f = _io_open(config.screenFile, "wb")
    if not f then return end
    f:write(string.format("%d %d\n", Screen.width, Screen.height))
    for y = 1, Screen.height do
      for x = 1, Screen.width do
        f:write(string.format("%d:%d:%s;", Screen.bg[y][x], Screen.fg[y][x], Screen.char[y][x]))
      end
      f:write("\n")
    end
    f:close()
    return
  end

  -- JSON mode
  if not screenInitialized then
    -- Send the full screen
    local cells = {}
    for y = 1, Screen.height do
      for x = 1, Screen.width do
        cells[(y - 1) * Screen.width + x] = {
          Screen.bg[y][x],
          Screen.fg[y][x],
          Screen.char[y][x],
        }
      end
    end
    sendToServer({
      type = "screen",
      w = Screen.width,
      h = Screen.height,
      full = true,
      cells = cells,
      cursor = { x = screen._cursorX, y = screen._cursorY, blink = screen._cursorBlink },
    })
    screenInitialized = true
    dirtyMap = {}
    dirtyCount = 0
    renderScheduled = false
    ilog("render: full " .. Screen.width .. "x" .. Screen.height)
  elseif dirtyCount > 0 then
    -- Collect dirty cells
    local dirty = {}
    local idx = 1
    for key, _ in pairs(dirtyMap) do
      local y = math.floor(key / 1000)
      local x = key - y * 1000
      dirty[idx] = { x, y, Screen.bg[y][x], Screen.fg[y][x], Screen.char[y][x] }
      idx = idx + 1
    end
    sendToServer({
      type = "screen",
      w = Screen.width,
      h = Screen.height,
      dirty = dirty,
      cursor = { x = screen._cursorX, y = screen._cursorY, blink = screen._cursorBlink },
    })
    ilog("render: dirty=" .. (idx - 1) .. " " .. Screen.width .. "x" .. Screen.height)
    dirtyMap = {}
    dirtyCount = 0
    renderScheduled = false
  end
end

local function markDirty(x, y)
  if x >= 1 and x <= Screen.width and y >= 1 and y <= Screen.height then
    local key = y * 1000 + x
    if not dirtyMap[key] then
      dirtyMap[key] = true
      dirtyCount = dirtyCount + 1
    end
  end
end

-- Reset when the resolution changes
local function onResolutionChange()
  screenInitialized = false
  dirtyMap = {}
  dirtyCount = 0
  renderScheduled = false
end

local function scheduleRender()
  renderScheduled = true
  -- Flush when the minimum frame interval has elapsed (~60 fps)
  -- so the display does not freeze if pullSignal is not called for a while
  if jsonIO then
    local now = _os_clock()
    if now - _lastFlushTime >= _minFrameInterval then
      sendScreenUpdate()
      _lastFlushTime = now
    end
  end
end

-- Flush the screen before pullSignal returns so updates are timely
-- Rate-limited by the minimum frame interval to avoid excessive flushes
-- force=true flushes even before blocking, so no dirty cells stay buffered
flushRender = function(force)
  if not (renderScheduled or (screenInitialized and dirtyCount > 0)) then return end
  if jsonIO then
    local now = _os_clock()
    if not force and now - _lastFlushTime < _minFrameInterval then return end -- not yet the next frame
    _lastFlushTime = now
  end
  sendScreenUpdate()
end

-- ============================================================
-- GPU component
-- ============================================================

-- Wide-character helpers (must be defined before the GPU functions)
-- Is the character wide (display width 2)?
local function isWideChar(ch)
  if not ch or ch == "" then return false end
  local b = ch:byte(1)
  if not b then return false end
  -- ASCII is never wide
  if b < 0x80 then return false end
  -- Decode the UTF-8 code point
  local cp
  if b < 0xE0 then
    cp = ((b % 0x20) * 0x40) + (ch:byte(2) % 0x40)
  elseif b < 0xF0 then
    cp = ((b % 0x10) * 0x1000) + ((ch:byte(2) % 0x40) * 0x40) + (ch:byte(3) % 0x40)
  else
    cp = ((b % 0x08) * 0x40000) + ((ch:byte(2) % 0x40) * 0x1000) + ((ch:byte(3) % 0x40) * 0x40) + (ch:byte(4) % 0x40)
  end
  -- Wide ranges: CJK ideographs, fullwidth forms, Hangul, ...
  if (cp >= 0x1100 and cp <= 0x115F) or
     (cp >= 0x2E80 and cp <= 0xA4CF) or
     (cp >= 0xAC00 and cp <= 0xD7A3) or
     (cp >= 0xF900 and cp <= 0xFAFF) or
     (cp >= 0xFE30 and cp <= 0xFE4F) or
     (cp >= 0xFF00 and cp <= 0xFF60) or
     (cp >= 0xFFE0 and cp <= 0xFFE6) or
     (cp >= 0x1F300 and cp <= 0x1FAFF) then
    return true
  end
  return false
end

-- isWideChar cache (hot-path optimisation), defined after isWideChar
local wideCharCache = {}
local function isWideCharCached(ch)
  if not ch or ch == "" then return false end
  local cached = wideCharCache[ch]
  if cached ~= nil then return cached end
  local result = isWideChar(ch)
  wideCharCache[ch] = result
  -- Cap the cache size
  if not wideCharCache._count then wideCharCache._count = 0 end
  wideCharCache._count = wideCharCache._count + 1
  if wideCharCache._count > 2000 then
    wideCharCache = { _count = 0 }
  end
  return result
end

gpuAddr = genAddr()
local gpuBound = nil
local gpu = {
  _resolution = { Screen.width, Screen.height },
  _bg = 0x000000, _fg = 0xFFFFFF,
  -- Palette index, recorded only for setBackground(color, true); nil for RGB colours
  _bgIndex = nil, _fgIndex = nil,
  _depth = config.gpuTier == 1 and 1 or config.gpuTier == 2 and 4 or 8,
  _palette = {},
  -- Expose tier; programs read it via component.proxy(addr).tier
  tier = config.gpuTier,
}

-- Default 16-colour palette (Minecraft standard)
local defaultPalette = {
  [0] = 0x000000, [1] = 0x0000AA, [2] = 0x00AA00, [3] = 0x00AAAA,
  [4] = 0xAA0000, [5] = 0xAA00AA, [6] = 0xFFAA00, [7] = 0xAAAAAA,
  [8] = 0x555555, [9] = 0x5555FF, [10] = 0x55FF55, [11] = 0x55FFFF,
  [12] = 0xFF5555, [13] = 0xFF55FF, [14] = 0xFFFF55, [15] = 0xFFFFFF,
}
for i = 0, 15 do gpu._palette[i] = defaultPalette[i] end

-- Palette size for a colour depth
local function paletteSize(depth)
  if depth == 1 then return 2
  elseif depth == 4 then return 16
  elseif depth == 8 then return 256
  else return 16 end  -- T1 GPU
end
-- GPU max resolution by tier: T1=50x16, T2=80x25, T3/Creative=160x50
local gpuMaxW = config.gpuTier == 1 and 50 or config.gpuTier == 2 and 80 or 160
local gpuMaxH = config.gpuTier == 1 and 16 or config.gpuTier == 2 and 25 or 50

gpu.bind = function(address) gpuBound = address; return true end
gpu.getScreen = function() return gpuBound end
gpu.getResolution = function() return gpu._resolution[1], gpu._resolution[2] end
gpu.setResolution = function(w, h)
  w, h = tonumber(w), tonumber(h)
  -- As in OpenComputers: out-of-range or invalid values raise an error
  if not w or not h or w < 1 or h < 1 or w > gpuMaxW or h > gpuMaxH
    or w ~= math.floor(w) or h ~= math.floor(h) then
    error("unsupported resolution", 2)
  end
  if w == gpu._resolution[1] and h == gpu._resolution[2] then return false end
  gpu._resolution = { w, h }
  Screen.width, Screen.height = w, h
  Screen.bg, Screen.fg, Screen.char = {}, {}, {}
  Screen.bgi, Screen.fgi = {}, {}
  for y = 1, h do
    Screen.bg[y] = {}; Screen.fg[y] = {}; Screen.char[y] = {}
    Screen.bgi[y] = {}; Screen.fgi[y] = {}
    for x = 1, w do
      Screen.bg[y][x] = 0x000000; Screen.fg[y][x] = 0xFFFFFF; Screen.char[y][x] = " "
    end
  end
  onResolutionChange()
  scheduleRender()
  return true
end
-- maxResolution reports the tier's maximum, matching real OC
gpu.maxResolution = function() return gpuMaxW, gpuMaxH end
gpu.maxDepth = function()
  return config.gpuTier == 1 and 1 or config.gpuTier == 2 and 4 or 8
end
-- Viewport (required by the OpenOS tty)
gpu._viewport = nil  -- nil means fullscreen
gpu.getViewport = function()
  if gpu._viewport then
    return gpu._viewport[1], gpu._viewport[2]
  end
  return gpu._resolution[1], gpu._resolution[2]
end
gpu.setViewport = function(w, h)
  gpu._viewport = { tonumber(w) or gpu._resolution[1], tonumber(h) or gpu._resolution[2] }
  return true
end
gpu.getDepth = function() return gpu._depth end
gpu.setDepth = function(d)
  local previous = gpu._depth
  local value = tonumber(d)
  local maxDepth = config.gpuTier == 1 and 1 or config.gpuTier == 2 and 4 or 8
  -- As in OpenComputers: only 1 / 4 / 8 are accepted; other depths raise an error
  if not value or (value ~= 1 and value ~= 4 and value ~= 8) or value > maxDepth then
    error("unsupported color depth", 2)
  end
  gpu._depth = value
  -- Reset the palette to defaults
  gpu._palette = {}
  for i = 0, math.min(paletteSize(value) - 1, 15) do
    gpu._palette[i] = defaultPalette[i]
  end
  -- As in OpenComputers: return the previous depth's name
  return ({ [1] = "OneBit", [4] = "FourBit", [8] = "EightBit" })[previous]
end
-- Off-screen buffers: each keeps its own chars and colours; drawing goes to the active buffer until bitblt
gpu._buffers = {}
gpu._nextBuffer = 1
gpu._activeBuffer = 0

gpu.allocateBuffer = function(w, h)
  local id = gpu._nextBuffer
  gpu._nextBuffer = id + 1
  local bw = math.max(1, math.min(tonumber(w) or gpu._resolution[1], gpuMaxW))
  local bh = math.max(1, math.min(tonumber(h) or gpu._resolution[2], gpuMaxH))
  local s = { width = bw, height = bh, char = {}, fg = {}, bg = {}, fgi = {}, bgi = {} }
  for y = 1, bh do
    s.char[y], s.fg[y], s.bg[y] = {}, {}, {}
    s.fgi[y], s.bgi[y] = {}, {}
    for x = 1, bw do
      s.char[y][x] = " "
      s.fg[y][x] = 0xFFFFFF
      s.bg[y][x] = 0x000000
    end
  end
  gpu._buffers[id] = s
  return id
end

gpu.freeBuffer = function(id)
  id = tonumber(id)
  if not id or not gpu._buffers[id] then return false end
  gpu._buffers[id] = nil
  if gpu._activeBuffer == id then gpu._activeBuffer = 0 end
  return true
end

gpu.freeAllBuffers = function()
  gpu._buffers = {}
  gpu._activeBuffer = 0
end

gpu.setActiveBuffer = function(id)
  id = tonumber(id) or 0
  if id ~= 0 and not gpu._buffers[id] then return false end
  gpu._activeBuffer = id
  return true
end

gpu.getActiveBuffer = function() return gpu._activeBuffer end

gpu.getBufferSize = function(id)
  local buffer = gpu._buffers[tonumber(id) or 0]
  if not buffer then return gpu._resolution[1], gpu._resolution[2] end
  return buffer.width, buffer.height
end

-- VRAM = max resolution cells x tier factor (T1=1, T2=2, T3=3), as on real hardware
-- The screen itself is excluded; real totalMemory/freeMemory count only off-screen buffers
local vramFactor = config.gpuTier == 1 and 1 or config.gpuTier == 2 and 2 or 3
gpu.totalMemory = function()
  return gpuMaxW * gpuMaxH * vramFactor
end

gpu.freeMemory = function()
  local used = 0
  for _, buffer in pairs(gpu._buffers) do
    used = used + buffer.width * buffer.height
  end
  return gpu.totalMemory() - used
end

-- Select a draw surface by index: 0 is the screen, the rest are off-screen buffers
local function drawSurface(id)
  local n = tonumber(id) or 0
  if n == 0 then return Screen end
  local buffer = gpu._buffers[n]
  if buffer and buffer.char then return buffer end
  return nil
end

gpu.get = function(x, y)
  local s = drawSurface(gpu._activeBuffer) or Screen
  if x < 1 or x > s.width or y < 1 or y > s.height then return nil, nil end
  local ch = s.char[y][x]
  -- If the cell is a wide-char continuation (empty string), return the previous cell's char
  if ch == "" and x > 1 then
    ch = s.char[y][x - 1]
  end
  -- Return values 4 and 5: palette index for palette colours, nil for RGB
  return ch, s.fg[y][x], s.bg[y][x], s.fgi[y][x], s.bgi[y][x]
end
gpu.set = function(x, y, text, vertical)
  text = tostring(text)
  local s = drawSurface(gpu._activeBuffer) or Screen
  local onScreen = (s == Screen)
  local W, H = s.width, s.height
  local i = 1
  local len = #text
  if vertical then
    local row = y
    while i <= len do
      -- Decode one UTF-8 character
      local b = text:byte(i)
      local charLen = 1
      if b >= 0xF0 then charLen = 4
      elseif b >= 0xE0 then charLen = 3
      elseif b >= 0xC0 then charLen = 2 end
      local ch = text:sub(i, i + charLen - 1)
      if x >= 1 and x <= W and row >= 1 and row <= H then
        s.char[row][x] = ch
        s.bg[row][x] = gpu._bg
        s.fg[row][x] = gpu._fg
        s.bgi[row][x] = gpu._bgIndex
        s.fgi[row][x] = gpu._fgIndex
        if onScreen then markDirty(x, row) end
      end
      i = i + charLen
      row = row + 1
    end
  else
    local col = x
    while i <= len do
      local b = text:byte(i)
      local charLen = 1
      if b >= 0xF0 then charLen = 4
      elseif b >= 0xE0 then charLen = 3
      elseif b >= 0xC0 then charLen = 2 end
      local ch = text:sub(i, i + charLen - 1)
      -- Display width: wide chars take 2 columns (cached)
      local cw = isWideCharCached(ch) and 2 or 1
      if col >= 1 and col + cw - 1 <= W and y >= 1 and y <= H then
        s.char[y][col] = ch
        s.bg[y][col] = gpu._bg
        s.fg[y][col] = gpu._fg
        s.bgi[y][col] = gpu._bgIndex
        s.fgi[y][col] = gpu._fgIndex
        if onScreen then markDirty(col, y) end
        -- Wide char: mark the second cell as a continuation, stored as an empty string
        if cw == 2 and col + 1 <= W then
          s.char[y][col + 1] = ""
          s.bg[y][col + 1] = gpu._bg
          s.fg[y][col + 1] = gpu._fg
          s.bgi[y][col + 1] = gpu._bgIndex
          s.fgi[y][col + 1] = gpu._fgIndex
          if onScreen then markDirty(col + 1, y) end
        end
      end
      i = i + charLen
      col = col + cw
    end
    -- Track tty text position for the browser cursor
    -- OpenOS never uses the hardware cursor, but the browser still needs its position
    if onScreen and screen then
      screen._cursorX = math.min(col, W + 1)
      screen._cursorY = y
    end
  end
  if onScreen then scheduleRender() end
  return true
end
gpu.copy = function(x, y, w, h, dx, dy)
  local s = drawSurface(gpu._activeBuffer) or Screen
  local onScreen = (s == Screen)
  local W, H = s.width, s.height
  -- Snapshot the source region
  local src = {}
  for ry = 0, h - 1 do
    src[ry] = {}
    for rx = 0, w - 1 do
      local sx, sy = x + rx, y + ry
      if sx >= 1 and sx <= W and sy >= 1 and sy <= H then
        src[ry][rx] = {
          char = s.char[sy][sx], fg = s.fg[sy][sx], bg = s.bg[sy][sx],
          fgi = s.fgi[sy][sx], bgi = s.bgi[sy][sx],
        }
      else
        src[ry][rx] = { char = " ", fg = 0xFFFFFF, bg = 0x000000 }
      end
    end
  end
  -- Write the destination region
  for ry = 0, h - 1 do
    for rx = 0, w - 1 do
      local tx, ty = x + rx + dx, y + ry + dy
      if tx >= 1 and tx <= W and ty >= 1 and ty <= H then
        s.char[ty][tx] = src[ry][rx].char
        s.fg[ty][tx] = src[ry][rx].fg
        s.bg[ty][tx] = src[ry][rx].bg
        s.fgi[ty][tx] = src[ry][rx].fgi
        s.bgi[ty][tx] = src[ry][rx].bgi
        if onScreen then markDirty(tx, ty) end
      end
    end
  end
  if onScreen then scheduleRender() end
  return true
end
gpu.fill = function(x, y, w, h, ch)
  -- Decode the first UTF-8 character, not the first byte
  ch = tostring(ch)
  local b = ch:byte(1) or 32
  local charLen = 1
  if b >= 0xF0 then charLen = 4
  elseif b >= 0xE0 then charLen = 3
  elseif b >= 0xC0 then charLen = 2 end
  ch = ch:sub(1, charLen)
  local cw = isWideCharCached(ch) and 2 or 1
  local s = drawSurface(gpu._activeBuffer) or Screen
  local onScreen = (s == Screen)
  local W, H = s.width, s.height
  for ry = y, y + h - 1 do
    if ry >= 1 and ry <= H then
      local rx = x
      local filled = 0
      while filled < w do
        local remaining = w - filled
        if cw == 2 and remaining < 2 then
          -- Not enough room for a wide char: pad with spaces
          if rx >= 1 and rx <= W then
            s.char[ry][rx] = " "
            s.bg[ry][rx] = gpu._bg
            s.fg[ry][rx] = gpu._fg
            s.bgi[ry][rx] = gpu._bgIndex
            s.fgi[ry][rx] = gpu._fgIndex
            if onScreen then markDirty(rx, ry) end
          end
          filled = filled + 1
          rx = rx + 1
        else
          if rx >= 1 and rx <= W then
            s.char[ry][rx] = ch
            s.bg[ry][rx] = gpu._bg
            s.fg[ry][rx] = gpu._fg
            s.bgi[ry][rx] = gpu._bgIndex
            s.fgi[ry][rx] = gpu._fgIndex
            if onScreen then markDirty(rx, ry) end
            if cw == 2 and rx + 1 <= W then
              s.char[ry][rx + 1] = ""
              s.bg[ry][rx + 1] = gpu._bg
              s.fg[ry][rx + 1] = gpu._fg
              s.bgi[ry][rx + 1] = gpu._bgIndex
              s.fgi[ry][rx + 1] = gpu._fgIndex
              if onScreen then markDirty(rx + 1, ry) end
            end
          end
          filled = filled + cw
          rx = rx + cw
        end
      end
    end
  end
  if onScreen then scheduleRender() end
  return true
end
gpu.setBackground = function(color, isPalette)
  local oldColor, oldIndex = gpu._bg, gpu._bgIndex
  color = math.floor(tonumber(color) or 0)
  if isPalette then
    gpu._bgIndex = color
    gpu._bg = gpu._palette[color] or 0
  else
    gpu._bgIndex = nil
    gpu._bg = color
  end
  return oldColor, oldIndex
end
gpu.setForeground = function(color, isPalette)
  local oldColor, oldIndex = gpu._fg, gpu._fgIndex
  color = math.floor(tonumber(color) or 0)
  if isPalette then
    gpu._fgIndex = color
    gpu._fg = gpu._palette[color] or 0
  else
    gpu._fgIndex = nil
    gpu._fg = color
  end
  return oldColor, oldIndex
end
gpu.getBackground = function() return gpu._bg, gpu._bgIndex ~= nil end
gpu.getForeground = function() return gpu._fg, gpu._fgIndex ~= nil end
gpu.getPaletteColor = function(idx)
  idx = math.floor(tonumber(idx) or 0)
  return gpu._palette[idx] or 0
end
gpu.setPaletteColor = function(idx, color)
  idx = math.floor(tonumber(idx) or 0)
  color = math.floor(tonumber(color) or 0)
  local maxIdx = paletteSize(gpu._depth) - 1
  if idx < 0 or idx > maxIdx then return nil, "index out of range" end
  gpu._palette[idx] = color
  return true
end
gpu.getBufferPalette = function()
  local p = {}
  for i = 0, paletteSize(gpu._depth) - 1 do
    p[i] = gpu._palette[i] or 0
  end
  return p
end
gpu.setBufferPalette = function(p)
  if type(p) ~= "table" then return false end
  for i = 0, paletteSize(gpu._depth) - 1 do
    if p[i] then gpu._palette[i] = math.floor(tonumber(p[i]) or 0) end
  end
  return true
end
gpu.setBufferSize = function(w, h) gpu.setResolution(w, h); return true end

-- Copy a rectangle between buffers; buffer 0 is the screen
-- Args: dst buffer, dst col, dst row, width, height, src buffer, src col, src row
gpu.bitblt = function(dst, dc, dx, w, h, src, sc, sy)
  local d = drawSurface(dst)
  local s = drawSurface(src)
  if not d or not s then return false end
  w, h = math.floor(tonumber(w) or 0), math.floor(tonumber(h) or 0)
  if w <= 0 or h <= 0 then return false end
  dc, dx = math.floor(tonumber(dc) or 0), math.floor(tonumber(dx) or 0)
  sc, sy = math.floor(tonumber(sc) or 0), math.floor(tonumber(sy) or 0)
  local dW, dH = d.width, d.height
  local sW, sH = s.width, s.height
  local onScreen = (d == Screen)
  -- Source and destination may be the same surface; snapshot first to avoid overlap
  local snap = {}
  for ry = 0, h - 1 do
    snap[ry] = {}
    for rx = 0, w - 1 do
      local sx, syy = sc + rx, sy + ry
      if sx >= 1 and sx <= sW and syy >= 1 and syy <= sH then
        snap[ry][rx] = {
          s.char[syy][sx], s.fg[syy][sx], s.bg[syy][sx],
          s.fgi[syy][sx], s.bgi[syy][sx],
        }
      end
    end
  end
  for ry = 0, h - 1 do
    for rx = 0, w - 1 do
      local cell = snap[ry][rx]
      local tx, ty = dc + rx, dx + ry
      if cell and tx >= 1 and tx <= dW and ty >= 1 and ty <= dH then
        d.char[ty][tx], d.fg[ty][tx], d.bg[ty][tx] = cell[1], cell[2], cell[3]
        d.fgi[ty][tx], d.bgi[ty][tx] = cell[4], cell[5]
        if onScreen then markDirty(tx, ty) end
      end
    end
  end
  if onScreen then scheduleRender() end
  return true
end

-- ============================================================
-- Screen component
-- ============================================================
screenAddr = genAddr()
screen = {
  _on = true, _precise = false, _touchInverted = false,
  _cursorX = 1, _cursorY = 1, _cursorBlink = false,
  -- Expose tier; programs read it via component.proxy(addr).tier
  tier = config.screenTier,
}
screen.isOn = function() return screen._on end
screen.turnOn = function() screen._on = true; return true, true end
screen.turnOff = function() screen._on = false; return true, false end
screen.getAspectRatio = function() return 1, 1 end
screen.getKeyboards = function() return { keyboardAddr } end
screen.setPrecise = function(v) screen._precise = v; return true end
screen.isPrecise = function() return screen._precise end
screen.setTouchModeInverted = function(v) screen._touchInverted = v; return true end
screen.isTouchModeInverted = function() return screen._touchInverted end
-- Cursor control (required by the OpenOS term)
screen.setCursor = function(x, y)
  screen._cursorX = tonumber(x) or 1
  screen._cursorY = tonumber(y) or 1
  return true
end
screen.getCursor = function() return screen._cursorX, screen._cursorY end
screen.setCursorBlink = function(enabled)
  screen._cursorBlink = enabled and true or false
  return true
end
screen.isCursorBlinking = function() return screen._cursorBlink end
screen.getResolution = function() return gpu._resolution[1], gpu._resolution[2] end
screen.setResolution = function(w, h) return gpu.setResolution(w, h) end

-- ============================================================
-- Keyboard component
-- ============================================================
keyboardAddr = genAddr()
local keyboard = { _shift = false, _control = false, _alt = false }
keyboard.isShiftPressed = function() return keyboard._shift end
keyboard.isControlPressed = function() return keyboard._control end
keyboard.isAltPressed = function() return keyboard._alt end
keyboard.isKeyDown = function(code) return false end

-- ============================================================
-- Filesystem component (backed by virtual disks)
-- ============================================================
fsAddr = genAddr()
-- Virtual read-only files so require("mods") inside the guest returns the injected component.
-- Never written to disk images; visible only through the filesystem proxy.
config.virtualFsFiles = {}
if config.modsEnabled then
  config.virtualFsFiles["/lib/mods.lua"] = "return mods\n"
end

local filesystem = { _label = vdisk.label, _address = fsAddr }
filesystem.getLabel = function() local l = vdisk.label or "Untitled"; dlog("fs.getLabel ->", l); return l end
filesystem.setLabel = function(label)
  vdisk.label = tostring(label or ""):sub(1, 16)
  -- Flush now so a forced VM stop does not lose the rename
  pcall(diskPersist.saveNow)
  return vdisk.label
end
filesystem.spaceUsed = function() return vfsSpaceUsed() end
-- Report the capacity recorded in the disk header, not the default config value.
filesystem.spaceTotal = function() return vdisk.size or config.hddSize end
filesystem.isReadOnly = function() return false end
filesystem.exists = function(path)
  path = vfsNormalize(path)
  if config.virtualFsFiles[path] ~= nil then return true end
  local r = vfsExists(path); dlog("fs.exists", path, "->", r); return r
end
filesystem.isDirectory = function(path)
  path = vfsNormalize(path)
  if config.virtualFsFiles[path] ~= nil then return false end
  return vfsIsDirectory(path)
end
filesystem.list = function(path)
  path = vfsNormalize(path)
  local list = vfsList(path)
  if path == "/lib" and vfsIsDirectory("/lib") and config.virtualFsFiles["/lib/mods.lua"] ~= nil then
    local found = false
    for _, name in ipairs(list) do
      if name == "mods.lua" then found = true; break end
    end
    if not found then list[#list + 1] = "mods.lua" end
  end
  local i = 0
  -- Return a real array table with a __call metamethod for iteration
  -- so #list, ipairs, pairs, table.concat and indexing all work natively
  -- while for entry in fs.list(path) do still works
  return setmetatable(list, {
    __call = function()
      i = i + 1
      return list[i]
    end,
  })
end
filesystem.size = function(path)
  path = vfsNormalize(path)
  if config.virtualFsFiles[path] ~= nil then return #config.virtualFsFiles[path] end
  return vfsSize(path)
end
filesystem.lastModified = function(path)
  path = vfsNormalize(path)
  if config.virtualFsFiles[path] ~= nil then return os.time() * 1000 end
  -- OC standard: lastModified returns milliseconds (real-world timestamp)
  local mod = vdisk.files[path] and vdisk.files[path].modified or os.time()
  return mod * 1000
end
filesystem.open = function(path, mode)
  dlog("fs.open", path, "mode", mode)
  mode = mode or "r"
  path = vfsNormalize(path)
  -- Virtual read-only file (e.g. /lib/mods.lua)
  if config.virtualFsFiles[path] ~= nil then
    if mode:match("w") or mode:match("a") then
      return nil, "read-only"
    end
    handleCount = handleCount + 1
    local handle = handleCount
    openHandles[handle] = { mode = mode, pos = 0, buffer = config.virtualFsFiles[path], path = path }
    return handle
  end
  -- directories cannot be opened
  if vfsIsDirectory(path) then
    dlog("fs.open: cannot open directory:", path)
    return nil, "is a directory"
  end
  -- read mode: nil when the file is missing
  if not mode:match("w") and not mode:match("a") then
    if not vfsExists(path) then
      dlog("fs.open: file not found:", path)
      return nil, "file not found"
    end
  end
  handleCount = handleCount + 1
  local handle = handleCount
  -- w truncates, a appends, anything else reads from the start
  local content = mode:match("w") and "" or (vfsRead(path) or "")
  local pos = mode:match("a") and #content or 0
  openHandles[handle] = { mode = mode, pos = pos, buffer = content, path = path }
  return handle
end
filesystem.read = function(handle, count)
  local h = openHandles[handle]
  if not h then return nil, "invalid handle" end
  if h.pos >= #h.buffer then return nil end
  -- Lua 5.1: math.huge (inf) causes string.sub to return empty string
  -- Clamp count to remaining bytes
  local remaining = #h.buffer - h.pos
  count = math.floor(math.min(count or remaining, remaining))
  if count <= 0 then return nil end
  local chunk = h.buffer:sub(h.pos + 1, h.pos + count)
  h.pos = h.pos + #chunk
  return chunk
end
filesystem.write = function(handle, data)
  local h = openHandles[handle]
  if not h then return nil, "invalid handle" end
  h.buffer = h.buffer:sub(1, h.pos) .. data .. h.buffer:sub(h.pos + #data + 1)
  h.pos = h.pos + #data
  return true
end
filesystem.close = function(handle)
  local h = openHandles[handle]
  if h then
    if h.mode:match("w") or h.mode:match("a") then
      vfsWrite(h.path, h.buffer)
    end
    openHandles[handle] = nil
  end
end
filesystem.seek = function(handle, whence, offset)
  local h = openHandles[handle]
  if not h then return nil, "invalid handle" end
  whence = whence or "cur"; offset = offset or 0
  if whence == "set" then h.pos = offset
  elseif whence == "cur" then h.pos = h.pos + offset
  elseif whence == "end" then h.pos = #h.buffer + offset end
  return h.pos
end
filesystem.makeDirectory = function(path) return vfsMkdir(path) end
filesystem.remove = function(path)
  path = vfsNormalize(path)
  if config.virtualFsFiles[path] ~= nil then return nil, "read-only" end
  return vfsRemove(path)
end
filesystem.rename = function(from, to)
  from = vfsNormalize(from)
  to = vfsNormalize(to)
  if config.virtualFsFiles[from] ~= nil or config.virtualFsFiles[to] ~= nil then return nil, "read-only" end
  return vfsRename(from, to)
end
filesystem.format = function()
  -- Drop all files, keep the root
  for k in pairs(vdisk.files) do
    if k ~= "/" then vdisk.files[k] = nil end
  end
  -- Ensure the root exists
  vdisk.files["/"] = { type = "directory", modified = os.time() }
  -- Mark dirty and flush now, so a hard kill cannot resurrect the old content
  diskPersist.mark()
  diskPersist.flush(true)
  return true
end

-- ============================================================
-- EEPROM component
-- ============================================================
eepromAddr = genAddr()
eepromData = ""
eepromLabel = "OC-Emulator EEPROM"
eepromCode = nil  -- EEPROM code loaded from a .oce file

-- Built-in OC BIOS (Lua) used as the default EEPROM
-- Try the usual boot-script paths in order
local BUILTIN_EEPROM = [[local init
do
  local component_invoke = component.invoke
  local function boot_invoke(address, method, ...)
    local result = table.pack(pcall(component_invoke, address, method, ...))
    if not result[1] then
      return nil, result[2]
    else
      return table.unpack(result, 2, result.n)
    end
  end
  local eeprom = component.list("eeprom")()
  computer.getBootAddress = function()
    return boot_invoke(eeprom, "getData")
  end
  computer.setBootAddress = function(address)
    return boot_invoke(eeprom, "setData", address)
  end
  do
    local screen = component.list("screen")()
    local gpu = component.list("gpu")()
    if gpu and screen then
      boot_invoke(gpu, "bind", screen)
      boot_invoke(gpu, "setResolution", 80, 25)
      boot_invoke(gpu, "fill", 1, 1, 80, 25, " ")
    end
  end
  local function tryLoadFrom(address)
    local handle, reason = boot_invoke(address, "open", "/init.lua")
    if not handle then
      handle, reason = boot_invoke(address, "open", "/OS.lua")
    end
    if not handle then
      handle, reason = boot_invoke(address, "open", "/BIOS/Manager.lua")
      if not handle then return nil, reason end
    end
    local buffer = ""
    repeat
      local data, reason = boot_invoke(address, "read", handle, math.maxinteger or math.huge)
      if not data and reason then
        return nil, reason
      end
      buffer = buffer .. (data or "")
    until not data
    boot_invoke(address, "close", handle)
    return load(buffer, "=init")
  end
  local reason
  if computer.getBootAddress() then
    init, reason = tryLoadFrom(computer.getBootAddress())
  end
  if not init then
    computer.setBootAddress()
    for address in component.list("filesystem") do
      init, reason = tryLoadFrom(address)
      if init then
        computer.setBootAddress(address)
        break
      end
    end
  end
  if not init then
    -- Show the "no bootable medium" message and wait.
    local gpu = component.list("gpu")()
    if gpu then
      boot_invoke(gpu, "set", 1, 1, "No bootable medium found")
      boot_invoke(gpu, "set", 1, 2, "Insert a disk with /init.lua or /OS.lua and press any key")
      boot_invoke(gpu, "set", 1, 4, "Press Ctrl+Alt+Insert in the web panel to restart")
    end
    computer.beep(200, 0.5)
    -- Idle loop: keep the VM alive until the user presses a key.
    while true do
      local sig = computer.pullSignal(1)
      if sig and sig[1] == "key_down" then
        computer.shutdown("reboot")
      end
    end
  end
  computer.beep(1000, 0.2)
end
return init()
]]

-- Try loading the EEPROM file from the config
if config.eepromFile and config.eepromFile ~= "" then
  -- accept a full path or a relative file name
  local eepromPath = config.eepromFile
  if not eepromPath:match("^[A-Za-z]:") and not eepromPath:match("^[/\\]") then
    -- relative path: prefix the VM directory
    eepromPath = config.vmDir .. "/" .. eepromPath
  end
  -- .oce binary format or plain .lua text
  if eepromPath:match("%.oce$") then
    local eepromInfo = disk.loadEEPROM(eepromPath)
    if eepromInfo then
      if eepromInfo.content and #eepromInfo.content > 0 then
        eepromCode = eepromInfo.content
        eepromLabel = eepromInfo.label or eepromLabel
        _stderr:write("[emulator] EEPROM loaded: " .. eepromLabel .. " (" .. #eepromCode .. " bytes)\n")
      else
        _stderr:write("[emulator] WARNING: EEPROM file content is empty, falling back to built-in BIOS: " .. eepromPath .. "\n")
      end
    else
      _stderr:write("[emulator] WARNING: EEPROM file not found: " .. eepromPath .. "\n")
    end
  else
    -- Plain Lua file (e.g. bios.lua from the OC GitHub)
    local f = _io_open(eepromPath, "rb")
    if f then
      local content = f:read("*a") or ""
      f:close()
      if #content == 0 then
        _stderr:write("[emulator] WARNING: EEPROM file is empty, falling back to built-in BIOS: " .. eepromPath .. "\n")
      else
        eepromCode = content
        if #eepromCode > 4096 then eepromCode = eepromCode:sub(1, 4096) end
        eepromLabel = (vmConfig and vmConfig.hardware and vmConfig.hardware.eepromLabel) or "Custom BIOS"
        _stderr:write("[emulator] EEPROM (Lua) loaded: " .. #eepromCode .. " bytes, label=" .. eepromLabel .. "\n")
      end
    else
      _stderr:write("[emulator] WARNING: EEPROM file not found: " .. eepromPath .. "\n")
    end
  end
end

-- Fall back to the built-in OC BIOS when there is no custom EEPROM, or it is empty
if not eepromCode or #eepromCode == 0 then
  eepromCode = BUILTIN_EEPROM
  eepromLabel = "OpenOS EEPROM"
  _stderr:write("[emulator] using built-in OC BIOS EEPROM\n")
end

local eeprom = {}
eeprom._readonly = false
eeprom.get = function()
  -- Always return the current EEPROM code (built-in or custom)
  return eepromCode
end
eeprom.set = function(data)
  if eeprom._readonly then return false, "read-only" end
  -- Validate arguments so empty files are not written
  if not data or #data == 0 then
    _stderr:write("[emulator] WARNING: eeprom.set() called with empty data, skipping write\n")
    return false, "empty data"
  end

  -- Enforce the 4 KB limit
  if #data > 4096 then data = data:sub(1, 4096) end
  eepromCode = data
  -- Persist: write back to the current EEPROM file, or create eeprom.lua for the built-in BIOS
  local eepromPath
  if config.eepromFile and config.eepromFile ~= "" then
    eepromPath = config.eepromFile
    if not eepromPath:match("^[A-Za-z]:") and not eepromPath:match("^[/\\]") then
      eepromPath = config.vmDir .. "/" .. eepromPath
    end
  else
    eepromPath = vmDir .. "/eeprom.lua"
  end
  if eepromPath:match("%.oce$") then
    -- .oce: write with the binary header format
    local ok, err = pcall(function()
      disk.saveEEPROM(eepromPath, eepromLabel, eepromCode)
    end)
    if ok then
      _stderr:write("[emulator] EEPROM flashed (OCE), saved to " .. eepromPath .. " (" .. #data .. " bytes)\n")
    else
      _stderr:write("[emulator] WARNING: cannot save EEPROM (OCE): " .. tostring(err) .. "\n")
    end
  else
    -- .lua: write plain text
    local f, err = _io_open(eepromPath, "wb")
    if f then
      f:write(eepromCode or "")
      f:close()
      _stderr:write("[emulator] EEPROM flashed, saved to " .. eepromPath .. " (" .. #data .. " bytes)\n")
    else
      _stderr:write("[emulator] WARNING: cannot save EEPROM: " .. tostring(err) .. "\n")
    end
  end
  -- Update config.json: eeprom changes from "built-in" to "eeprom.lua"
  if vmConfig and vmConfig.hardware then
    if vmConfig.hardware.eeprom == "built-in" or not vmConfig.hardware.eeprom then
      vmConfig.hardware.eeprom = "eeprom.lua"
      config.eepromFile = vmDir .. "/eeprom.lua"
      local cfgPath = vmDir .. "/config.json"
      local cfgF, cfgErr = _io_open(cfgPath, "wb")
      if cfgF then
        cfgF:write(jsonEncode(vmConfig))
        cfgF:close()
        _stderr:write("[emulator] config.json updated: eeprom -> eeprom.lua\n")
      else
        _stderr:write("[emulator] WARNING: cannot update config.json: " .. tostring(cfgErr) .. "\n")
      end
    end
  end
  return true
end
eeprom.getData = function() return eepromData end
eeprom.setData = function(data)
  if eeprom._readonly then return false, "read-only" end
  eepromData = (data or ""):sub(1, 256)
end
eeprom.getLabel = function() return eepromLabel end
eeprom.setLabel = function(label)
  if eeprom._readonly then return nil, "read-only" end
  if #label > 16 then label = label:sub(1, 16) end
  eepromLabel = label
  -- Persist the label to config.json; .lua EEPROMs have no label field of their own
  if vmConfig and vmConfig.hardware then
    vmConfig.hardware.eepromLabel = eepromLabel
    local cfgPath = vmDir .. "/config.json"
    local cfgF, cfgErr = _io_open(cfgPath, "wb")
    if cfgF then
      cfgF:write(jsonEncode(vmConfig))
      cfgF:close()
      _stderr:write("[emulator] config.json updated: eepromLabel -> " .. eepromLabel .. "\n")
    else
      _stderr:write("[emulator] WARNING: cannot update config.json for eepromLabel: " .. tostring(cfgErr) .. "\n")
    end
  end
  return label
end
eeprom.getSize = function() return 4096 end
eeprom.getDataSize = function() return 256 end
eeprom.getChecksum = function()
  local data = eepromCode or ""
  local h = 5381
  for i = 1, #data do
    h = (h * 33 + data:byte(i)) % 0x100000000
  end
  return string.format("%08x", h)
end
eeprom.makeReadonly = function()
  eeprom._readonly = true
  return true
end

-- ============================================================
-- Internet component
-- ============================================================
local internetAddr = genAddr()
local internet = {}
internet.isTcpEnabled = function() return true end
internet.isHttpEnabled = function() return true end

-- Socket data travels as base64 inside JSON so binary bytes are not mangled by escaping
internet.encodeBase64 = function(s)
  local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  local out = {}
  local i = 1
  while i <= #s do
    local a, b, c = s:byte(i, i + 2)
    local n = (a or 0) * 65536 + (b or 0) * 256 + (c or 0)
    out[#out + 1] = chars:sub(math.floor(n / 262144) % 64 + 1, math.floor(n / 262144) % 64 + 1)
      .. chars:sub(math.floor(n / 4096) % 64 + 1, math.floor(n / 4096) % 64 + 1)
      .. (b and chars:sub(math.floor(n / 64) % 64 + 1, math.floor(n / 64) % 64 + 1) or "=")
      .. (c and chars:sub(n % 64 + 1, n % 64 + 1) or "=")
    i = i + 3
  end
  return table.concat(out)
end

internet.decodeBase64 = function(t)
  local map = internet._b64map
  if not map then
    map = {}
    local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for i = 1, 64 do map[chars:sub(i, i)] = i - 1 end
    internet._b64map = map
  end
  t = tostring(t or ""):gsub("[^%w%+/=]", "")
  local out = {}
  local i = 1
  while i <= #t do
    local c1 = map[t:sub(i, i)] or 0
    local c2 = map[t:sub(i + 1, i + 1)] or 0
    local c3 = map[t:sub(i + 2, i + 2)]
    local c4 = map[t:sub(i + 3, i + 3)]
    local n = c1 * 262144 + c2 * 4096 + (c3 or 0) * 64 + (c4 or 0)
    out[#out + 1] = string.char(math.floor(n / 65536) % 256)
    if c3 then out[#out + 1] = string.char(math.floor(n / 256) % 256) end
    if c4 then out[#out + 1] = string.char(n % 256) end
    i = i + 4
  end
  return table.concat(out)
end
internet.request = function(url, postData, headers)
  if jsonIO then
    -- Async mode: send a request over the JSON I/O protocol and await net_response
    pendingNetId = pendingNetId + 1
    local reqId = "req_" .. pendingNetId
    local method = (postData and postData ~= "") and "POST" or "GET"

    -- Register a callback and wait for net_response
    local responseData = nil
    local responseStatus = 0
    local responseStatusText = ""
    local responseHeaders = {}
    local responseError = nil
    local gotResponse = false

    pendingNetCallbacks[reqId] = function(msg)
      if msg.error then
        responseError = msg.error
        responseStatus = msg.status or 0
        responseStatusText = msg.statusText or "Error"
      else
        responseStatus = msg.status or 0
        responseStatusText = msg.statusText or "OK"
        responseHeaders = msg.headers or {}
        -- chunks is an array; join it into the full body
        local parts = msg.chunks or {}
        responseData = table.concat(parts)
      end
      gotResponse = true
    end

    -- Send net_request to the server
    sendToServer({
      type = "net_request",
      url = url,
      method = method,
      postData = postData,
      headers = headers,
      reqId = reqId,
    })

    -- Block for the reply (up to 90 s; big files or slow links need it)
    -- Count only rounds that really waited 1 s: queued events (e.g. the click that started the download)
    -- make pullSignal return immediately and would exhaust the timeout early.
    local maxWait = 90
    local waited = 0
    while not gotResponse and waited < maxWait do
      local sig = pullSignal(1)
      if sig == nil then waited = waited + 1 end
    end

    -- Clean up the callback on timeout
    if not gotResponse then
      pendingNetCallbacks[reqId] = nil
      responseError = "request timed out after " .. maxWait .. "s (url: " .. url:sub(1, 80) .. ")"
    end

    local handle = { data = responseData, closed = false }
    handle.read = function(n)
      -- Return nil once the data is consumed (real OC semantics), otherwise sub keeps returning ""
      -- and guest read loops (Internet.lua download) spin forever.
      if handle.closed or not handle.data or #handle.data == 0 then return nil end
      if n and n < math.huge and n == math.floor(n) then
        local chunk = handle.data:sub(1, n)
        handle.data = handle.data:sub(n + 1)
        return chunk
      elseif n and n < math.huge then
        n = math.floor(n)
        if n <= 0 then return nil end
        local chunk = handle.data:sub(1, n)
        handle.data = handle.data:sub(n + 1)
        return chunk
      else
        local all = handle.data; handle.data = ""; return all
      end
    end
    handle.response = function()
      return responseStatus, responseStatusText, responseHeaders
    end
    handle.close = function() handle.closed = true end
    handle.finishConnect = function() return true end

    -- Return nil on failure, matching real OC
    if responseError then
      elog("internet.request failed: " .. tostring(url) .. " (" .. tostring(responseError) .. ")")
      return nil, responseError
    end
    return handle
  end

  -- Legacy fallback: synchronous popen, only in file mode
  local cmd = 'powershell -NoProfile -Command "'
  if postData then
    cmd = cmd .. '$headers = @{}; '
    if headers then for k, v in pairs(headers) do cmd = cmd .. "$headers['" .. k .. "'] = '" .. v .. "'; " end end
    cmd = cmd .. "Invoke-WebRequest -Uri '" .. url .. "' -Method Post -Body '" .. postData .. "' -Headers $headers -UseBasicParsing | Select-Object -ExpandProperty Content"
  else
    cmd = cmd .. "Invoke-WebRequest -Uri '" .. url .. "' -UseBasicParsing | Select-Object -ExpandProperty Content"
  end
  cmd = cmd .. '"'
  local f = _io_popen(cmd)
  if not f then
    return nil, "failed to execute HTTP request"
  end
  local handle = { data = nil, closed = false }
  handle.data = f:read("*a")
  f:close()
  if not handle.data or handle.data == "" then
    return nil, "HTTP request returned no data"
  end
  handle.read = function(a, b)
    local n = (type(a) == "table") and b or a
    if handle.closed or not handle.data or #handle.data == 0 then return nil end
    if n and n < math.huge and n == math.floor(n) then
      local chunk = handle.data:sub(1, n)
      handle.data = handle.data:sub(n + 1)
      return chunk
    elseif n and n < math.huge then
      n = math.floor(n)
      if n <= 0 then return nil end
      local chunk = handle.data:sub(1, n)
      handle.data = handle.data:sub(n + 1)
      return chunk
    else
      local all = handle.data; handle.data = ""; return all
    end
  end
  handle.response = function() return 200, "OK", {} end
  handle.close = function() handle.closed = true end
  handle.finishConnect = function() return true end
  return handle
end
internet.connect = function(addr, port)
  local handle = { closed = false, _err = nil, _socket = nil }

  handle.id = function() return handle._socket or 0 end
  handle.finishConnect = function()
    if handle._err then return nil, handle._err end
    return true
  end
  -- Support both sock.read(n) and sock:read(n)
  handle.read = function(a, b)
    local count = (type(a) == "table") and b or a
    if handle._err then return nil, handle._err end
    if handle.closed or not handle._socket then return nil end
    pendingNetId = pendingNetId + 1
    local rid = "tcpr_" .. pendingNetId
    local res = nil
    pendingNetCallbacks[rid] = function(msg) res = msg end
    sendToServer({ type = "net_tcp_read", reqId = rid, id = handle._socket, count = tonumber(count) })
    local waited = 0
    while not res and waited < 120 do
      pullSignal(1)
      waited = waited + 1
    end
    pendingNetCallbacks[rid] = nil
    if not res then return nil, "read timed out" end
    if res.error then return nil, res.error end
    if res.closed and not res.data then
      handle.closed = true
      return nil
    end
    return internet.decodeBase64(res.data or "")
  end
  handle.write = function(a, b)
    local data = (type(a) == "table") and b or a
    if handle._err then return nil, handle._err end
    if handle.closed or not handle._socket then return nil, "socket closed" end
    data = tostring(data or "")
    pendingNetId = pendingNetId + 1
    local wid = "tcpw_" .. pendingNetId
    local res = nil
    pendingNetCallbacks[wid] = function(msg) res = msg end
    sendToServer({ type = "net_tcp_write", reqId = wid, id = handle._socket, data = internet.encodeBase64(data) })
    local waited = 0
    while not res and waited < 30 do
      pullSignal(1)
      waited = waited + 1
    end
    pendingNetCallbacks[wid] = nil
    if not res then return nil, "write timed out" end
    if res.error then return nil, res.error end
    return res.written or 0
  end
  handle.close = function()
    if handle.closed then return true end
    handle.closed = true
    if handle._socket then
      sendToServer({ type = "net_tcp_close", id = handle._socket })
      handle._socket = nil
    end
    return true
  end

  if not jsonIO then
    handle._err = "TCP requires JSON I/O mode"
    return handle
  end

  pendingNetId = pendingNetId + 1
  local reqId = "tcpc_" .. pendingNetId
  local result = nil
  pendingNetCallbacks[reqId] = function(msg) result = msg end
  sendToServer({
    type = "net_tcp_connect",
    reqId = reqId,
    host = tostring(addr or ""),
    port = tonumber(port) or 0,
  })
  local waited = 0
  while not result and waited < 15 do
    pullSignal(1)
    waited = waited + 1
  end
  pendingNetCallbacks[reqId] = nil
  if not result then
    handle._err = "connect timed out"
  elseif result.ok ~= true then
    handle._err = result.error or "connection failed"
  else
    handle._socket = result.id
  end
  return handle
end

-- ============================================================
-- Data Card: standard OC API, implemented per tier
-- T1: encode64/decode64, serialize/deserialize, crc32
-- T2: + md5, sha256, deflate/inflate, random
-- T3: + encrypt/decrypt, generateKeyPair, sign/verify, diffieHellman
-- ============================================================
local dataAddr = genAddr()

-- Base64 lookup table (tier 1, pure Lua)
local b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local b64lookup = {}
for i = 1, 64 do b64lookup[b64chars:sub(i, i)] = i - 1 end

local function _encode64(s)
  s = s or ""
  local result = {}
  local i = 1
  while i <= #s do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    table.insert(result, b64chars:sub(bit32.band(bit32.rshift(n, 18), 63) + 1, bit32.band(bit32.rshift(n, 18), 63) + 1))
    table.insert(result, b64chars:sub(bit32.band(bit32.rshift(n, 12), 63) + 1, bit32.band(bit32.rshift(n, 12), 63) + 1))
    table.insert(result, b and b64chars:sub(bit32.band(bit32.rshift(n, 6), 63) + 1, bit32.band(bit32.rshift(n, 6), 63) + 1) or "=")
    table.insert(result, c and b64chars:sub(bit32.band(n, 63) + 1, bit32.band(n, 63) + 1) or "=")
    i = i + 3
  end
  return table.concat(result)
end

local function _decode64(s)
  s = (s or ""):gsub("[^" .. b64chars .. "=]", "")
  local result = {}
  local i = 1
  while i <= #s do
    local c1, c2, c3, c4 = s:byte(i, i + 3)
    local n = bit32.blshift(b64lookup[string.char(c1)] or 0, 18)
    n = bit32.bor(n, bit32.blshift(b64lookup[string.char(c2)] or 0, 12))
    n = bit32.bor(n, bit32.blshift(b64lookup[string.char(c3)] or 0, 6))
    n = bit32.bor(n, b64lookup[string.char(c4)] or 0)
    table.insert(result, string.char(bit32.band(bit32.rshift(n, 16), 0xFF)))
    if c3 ~= 61 then table.insert(result, string.char(bit32.band(bit32.rshift(n, 8), 0xFF))) end
    if c4 ~= 61 then table.insert(result, string.char(bit32.band(n, 0xFF))) end
    i = i + 4
  end
  return table.concat(result)
end

local function _serialize(value)
  local function ser(v)
    local t = type(v)
    if t == "nil" then return "nil"
    elseif t == "boolean" then return tostring(v)
    elseif t == "number" then return tostring(v)
    elseif t == "string" then return string.format("%q", v)
    elseif t == "table" then
      local parts = {}
      for k, val in pairs(v) do
        local key = type(k) == "string" and k or "[" .. ser(k) .. "]"
        table.insert(parts, key .. "=" .. ser(val))
      end
      return "{" .. table.concat(parts, ",") .. "}"
    else
      return "nil"
    end
  end
  return ser(value)
end

local function _deserialize(s)
  local fn = (loadstring or load)("return " .. s)
  if fn then
    local ok, result = pcall(fn)
    if ok then return result end
  end
  return nil
end

local function _crc32(s)
  s = s or ""
  local crc = 0xFFFFFFFF
  for i = 1, #s do
    crc = bit32.bxor(crc, s:byte(i))
    for _ = 1, 8 do
      local mask = bit32.band(crc, 1) == 1 and 0xEDB88320 or 0
      crc = bit32.bor(bit32.rshift(crc, 1), mask)
    end
  end
  return bit32.band(bit32.bnot(crc), 0xFFFFFFFF)
end

-- crypto-helper.js bridge: run Node.js via io.popen for crypto operations
-- Returns stdout as a string, or nil plus an error message
local cryptoHelperPath = EMU_DIR .. "lib/crypto-helper.js"
local function _cryptoBridge(op, inputData, ...)
  local tmpIn = _os_tmpname()
  local f = _io_open(tmpIn, "wb")
  if not f then return nil, "cannot create temp file" end
  f:write(inputData or "")
  f:close()
  local cmd = 'node "' .. cryptoHelperPath .. '" ' .. op .. ' "' .. tmpIn .. '"'
  -- Extra arguments (key files etc.)
  local args = { ... }
  for _, a in ipairs(args) do
    -- Write extra arguments to a temp file
    local tmpArg = _os_tmpname()
    local af = _io_open(tmpArg, "wb")
    if af then af:write(a); af:close() end
    cmd = cmd .. ' "' .. tmpArg .. '"'
  end
  local h = _io_popen(cmd, "r")
  local result = h and h:read("*a") or nil
  if h then h:close() end
  _os_remove(tmpIn)
  -- Remove the extra-argument temp file (referenced by cmd)
  -- delete it once popen has finished
  return result
end

-- Simple crypto bridge: one argument (md5, sha256, deflate, inflate)
local function _cryptoSingle(op, inputData)
  local tmpIn = _os_tmpname()
  local f = _io_open(tmpIn, "wb")
  if not f then return nil, "cannot create temp file" end
  f:write(inputData or "")
  f:close()
  local cmd = 'node "' .. cryptoHelperPath .. '" ' .. op .. ' "' .. tmpIn .. '"'
  local h = _io_popen(cmd, "r")
  local result = h and h:read("*a") or nil
  if h then h:close() end
  _os_remove(tmpIn)
  return result
end

-- Two-argument crypto bridge for encrypt/decrypt (inputData, key)
local function _cryptoDouble(op, inputData, keyData)
  local tmpIn = _os_tmpname()
  local tmpKey = _os_tmpname()
  local f1 = _io_open(tmpIn, "wb")
  if not f1 then return nil, "cannot create temp file" end
  f1:write(inputData or "")
  f1:close()
  local f2 = _io_open(tmpKey, "wb")
  if not f2 then _os_remove(tmpIn); return nil, "cannot create key file" end
  f2:write(keyData or "")
  f2:close()
  local cmd = 'node "' .. cryptoHelperPath .. '" ' .. op .. ' "' .. tmpIn .. '" "' .. tmpKey .. '"'
  local h = _io_popen(cmd, "r")
  local result = h and h:read("*a") or nil
  if h then h:close() end
  _os_remove(tmpIn)
  _os_remove(tmpKey)
  return result
end

-- Create a tiered data card
-- tier: 1, 2 or 3
local function createDataCard(tier)
  local card = {
    type = "data",
    tier = tier,
  }

  -- ==== Tier 1 methods (available on every tier) ====
  card.encode64 = function(s) return _encode64(s) end
  card.decode64 = function(s) return _decode64(s) end
  card.encodeBase64 = card.encode64  -- compatibility alias
  card.decodeBase64 = card.decode64
  card.serialize = function(v) return _serialize(v) end
  card.deserialize = function(s) return _deserialize(s) end
  card.crc32 = function(s) return _crc32(s) end

  -- ==== Tier 2 methods (tier >= 2) ====
  if tier >= 2 then
    card.md5 = function(s)
      local result = _cryptoSingle("md5", s or "")
      if not result or result == "" then error("md5 failed") end
      return result
    end
    card.sha256 = function(s)
      local result = _cryptoSingle("sha256", s or "")
      if not result or result == "" then error("sha256 failed") end
      return result
    end
    card.deflate = function(s)
      local result = _cryptoSingle("deflate", s or "")
      if not result or result == "" then error("deflate failed") end
      return result
    end
    card.inflate = function(s)
      local result = _cryptoSingle("inflate", s or "")
      if not result or result == "" then error("inflate failed") end
      return result
    end
    card.random = function(len)
      len = len or 1
      local result = {}
      for _ = 1, len do
        table.insert(result, string.char(math.random(0, 255)))
      end
      return table.concat(result)
    end
    card.rotate32 = function(value, amount)
      value = bit32.band(value, 0xFFFFFFFF)
      amount = (amount % 32 + 32) % 32
      if amount == 0 then return value end
      return bit32.band(bit32.bor(bit32.blshift(value, amount), bit32.rshift(value, 32 - amount)), 0xFFFFFFFF)
    end
  end

  -- ==== Tier 3 methods (tier >= 3) ====
  if tier >= 3 then
    -- AES-256-CBC encrypt: encrypt(data, key) -> base64(iv + encrypted)
    card.encrypt = function(data, key)
      local result = _cryptoDouble("encrypt", data or "", key or "")
      if not result or result == "" then error("encrypt failed") end
      return result
    end
    -- AES-256-CBC decrypt: decrypt(base64(iv + encrypted), key) -> original
    card.decrypt = function(data, key)
      local result = _cryptoDouble("decrypt", data or "", key or "")
      if not result then error("decrypt failed") end
      return result
    end
    -- Generate an RSA key pair: generateKeyPair([bits]) -> {public, private}
    card.generateKeyPair = function(bits)
      bits = bits or 2048
      local tmpArg = _os_tmpname()
      local f = _io_open(tmpArg, "wb")
      if f then f:write(tostring(bits)); f:close() end
      local cmd = 'node "' .. cryptoHelperPath .. '" generateKeyPair "' .. tmpArg .. '"'
      local h = _io_popen(cmd, "r")
      local result = h and h:read("*a") or nil
      if h then h:close() end
      _os_remove(tmpArg)
      if not result or result == "" then error("generateKeyPair failed") end
      local ok, parsed = pcall(function() return _deserialize(result:match("^%s*({.*})%s*$") or result) end)
      if ok and type(parsed) == "table" then
        return parsed.public, parsed.private
      end
      -- try JSON parsing
      local fn = (loadstring or load)("return " .. result)
      if fn then
        local ok2, r = pcall(fn)
        if ok2 and type(r) == "table" then
          return r.public, r.private
        end
      end
      error("cannot parse key pair")
    end
    -- RSA sign: sign(data, privateKey) -> base64 signature
    card.sign = function(data, privateKey)
      local result = _cryptoDouble("sign", data or "", privateKey or "")
      if not result or result == "" then error("sign failed") end
      return result
    end
    -- RSA verify: verify(data, signature, publicKey) -> boolean
    card.verify = function(data, signature, publicKey)
      local tmpData = _os_tmpname()
      local tmpSig = _os_tmpname()
      local tmpPub = _os_tmpname()
      local f1 = _io_open(tmpData, "wb"); if f1 then f1:write(data or ""); f1:close() end
      local f2 = _io_open(tmpSig, "wb"); if f2 then f2:write(signature or ""); f2:close() end
      local f3 = _io_open(tmpPub, "wb"); if f3 then f3:write(publicKey or ""); f3:close() end
      local cmd = 'node "' .. cryptoHelperPath .. '" verify "' .. tmpData .. '" "' .. tmpSig .. '" "' .. tmpPub .. '"'
      local h = _io_popen(cmd, "r")
      local result = h and h:read("*a") or nil
      if h then h:close() end
      _os_remove(tmpData); _os_remove(tmpSig); _os_remove(tmpPub)
      return result == "true"
    end
    -- DH exchange: diffieHellman(privateKey, publicKey) -> shared secret
    card.diffieHellman = function(privateKey, publicKey)
      local result = _cryptoDouble("diffieHellman", privateKey or "", publicKey or "")
      if not result or result == "" then error("diffieHellman failed") end
      return result
    end
  end

  return card
end

-- data defaults to tier 1 and is replaced with the configured tier at card registration
local data = createDataCard(1)

-- ============================================================
-- Component registry
-- ============================================================
-- Creative chassis: 2 HDD slots + 1 floppy slot + expansion cards
-- Second HDD: load the configured disk2 .ocd, otherwise empty
local fs2Addr = genAddr()
-- tmpfs: RAM-based temporary filesystem, always writable, separate from disks
local tmpAddr = genAddr()
local tmpFiles = {}
fs2Files = {}
fs2Label = "HDD2"
fs2Size = 4 * 1024 * 1024
fs2Tier = 3
if config.disk2File then
  local loaded2 = disk.load(config.disk2File)
  if loaded2 then
    fs2Files = loaded2.files or {}
    fs2Label = loaded2.label or "HDD2"
    fs2Size = loaded2.size or fs2Size
    fs2Tier = loaded2.tier or 3
    _stderr:write("[emulator] Disk2 loaded: " .. fs2Label .. " (" .. (loaded2.size or 0) .. " bytes)\n")
  else
    _stderr:write("[emulator] WARNING: cannot load disk2: " .. config.disk2File .. "\n")
  end
end

-- Floppy drive: also loaded from .ocd
floppyAddr = genAddr()
floppyFiles = {}
floppyLabel = "Floppy"
floppyLocked = false
if config.floppyFile then
  local loadedF = disk.loadFloppy(config.floppyFile)
  if loadedF then
    floppyFiles = loadedF.files or {}
    floppyLabel = loadedF.label or "Floppy"
    floppyLocked = loadedF.locked == true
    -- Keep the capacity from the image so a custom-sized floppy survives a save.
    if loadedF.size then config.floppySize = loadedF.size end
    _stderr:write("[emulator] Floppy loaded: " .. floppyLabel .. " (locked=" .. tostring(floppyLocked) .. ")\n")
  else
    _stderr:write("[emulator] WARNING: cannot load floppy: " .. config.floppyFile .. "\n")
  end
end

-- Create a generic filesystem proxy.
-- onLabelSet: label-change callback. Store the new label in the outer variable, otherwise
-- saveAllDisks() writes the label captured at creation and renames last only until restart.
local function makeFsProxy(filesTable, label, capacity, readOnly, onLabelSet, onDirty)
  local fs = {}
  -- Notify the caller on modification (marks disks dirty; tmpfs passes no callback)
  local function touch()
    if onDirty then pcall(onDirty) end
  end
  fs.getLabel = function() return label end
  fs.setLabel = function(l)
    if readOnly then return nil, "filesystem is read-only" end
    label = tostring(l or "")
    if onLabelSet then pcall(onLabelSet, label) end
    -- Flush now so a forced VM stop does not lose the rename
    pcall(diskPersist.saveNow)
    return label
  end
  fs.isReadOnly = function() return readOnly == true end
  fs.spaceTotal = function() return capacity end
  fs.spaceUsed = function()
    local total = 0
    for _, info in pairs(filesTable) do
      if info.content then total = total + #info.content end
    end
    return total
  end
  fs.exists = function(path)
    path = vfsNormalize(path)
    if path == "/" then return true end
    if filesTable[path] ~= nil then return true end
    -- Implicit directory: a child entry starts with path/
    local prefix = path .. "/"
    for p in pairs(filesTable) do
      if p:sub(1, #prefix) == prefix then return true end
    end
    return false
  end
  fs.isDirectory = function(path)
    path = vfsNormalize(path)
    if path == "/" then return true end
    local info = filesTable[path]
    if info and info.type == "directory" then return true end
    -- Implicit directory: treat as a directory when a child entry starts with path/
    local prefix = path .. "/"
    for p in pairs(filesTable) do
      if p:sub(1, #prefix) == prefix then return true end
    end
    return false
  end
  fs.list = function(path)
    path = vfsNormalize(path)
    -- Group by entry name: the same name may come from an explicit entry ("/lib") or
    -- from its children ("/lib/core/x.lua"); keying by name avoids duplicates;
    -- the root entry "/" has an empty rest, and skipping it avoids an empty name: OpenOS full_ls
    -- calls filesystem.name() per name, gets nil for the empty one and `ls /` fails.
    local names = {}
    local prefix = path == "/" and "/" or path .. "/"
    for p, info in pairs(filesTable) do
      if p:sub(1, #prefix) == prefix then
        local rest = p:sub(#prefix + 1)
        if rest ~= "" then
          local slash = rest:find("/")
          local name = slash and rest:sub(1, slash - 1) or rest
          if slash then
            names[name] = true -- has children => directory
          elseif names[name] == nil then
            names[name] = info ~= nil and info.type == "directory"
          end
        end
      end
    end
    local result = {}
    for name, isDir in pairs(names) do
      table.insert(result, isDir and (name .. "/") or name)
    end
    local i = 0
    -- Return a real array table with __call iteration for full compatibility
    return setmetatable(result, {
      __call = function()
        i = i + 1
        return result[i]
      end,
    })
  end
  fs.makeDirectory = function(path)
    if readOnly then return nil, "filesystem is read-only" end
    path = vfsNormalize(path)
    if filesTable[path] then return false end
    filesTable[path] = { type = "directory", modified = os.time() }
    touch()
    return true
  end
  -- Handles are numbers, as in OpenComputers, kept in this filesystem's handle table
  local handles, nextHandle = {}, 1
  local function handleOf(handle)
    local key = tonumber(handle)
    if not key then return nil end
    return handles[key]
  end

  fs.open = function(path, mode)
    path = vfsNormalize(path)
    mode = mode or "r"
    if readOnly and (mode:find("w") or mode:find("a")) then
      return nil, "filesystem is read-only"
    end
    local info = filesTable[path]
    if mode:find("w") or mode:find("a") then
      if not info then
        filesTable[path] = { type = "file", content = "", modified = os.time() }
        info = filesTable[path]
      end
      if mode:find("w") then info.content = "" end
      touch()
    elseif not info then
      return nil, "file not found"
    end
    local handle = nextHandle
    nextHandle = nextHandle + 1
    local content = info.content or ""
    handles[handle] = {
      path = path,
      mode = mode,
      pos = mode:find("a") and #content or 0,
      buffer = content,
    }
    return handle
  end
  fs.read = function(handle, n)
    local h = handleOf(handle)
    if not h then return nil, "invalid handle" end
    if h.pos >= #h.buffer then return nil end
    local remaining = #h.buffer - h.pos
    n = math.floor(tonumber(n) or remaining)
    if n >= math.huge or n > remaining then n = remaining end
    if n <= 0 then return nil end
    local chunk = h.buffer:sub(h.pos + 1, h.pos + n)
    h.pos = h.pos + #chunk
    return chunk
  end
  fs.write = function(handle, value)
    local h = handleOf(handle)
    if not h then return nil, "invalid handle" end
    if readOnly then return nil, "filesystem is read-only" end
    value = tostring(value or "")
    h.buffer = h.buffer:sub(1, h.pos) .. value .. h.buffer:sub(h.pos + #value + 1)
    h.pos = h.pos + #value
    filesTable[h.path].content = h.buffer
    touch()
    return true
  end
  fs.seek = function(handle, whence, offset)
    local h = handleOf(handle)
    if not h then return nil, "invalid handle" end
    whence = whence or "cur"
    offset = math.floor(tonumber(offset) or 0)
    local pos = h.pos
    if whence == "set" then pos = offset
    elseif whence == "cur" then pos = pos + offset
    elseif whence == "end" then pos = #h.buffer + offset end
    if pos < 0 then pos = 0 end
    h.pos = pos
    return pos
  end
  fs.close = function(handle)
    local key = tonumber(handle)
    if key then handles[key] = nil end
  end
  fs.remove = function(path)
    if readOnly then return nil, "filesystem is read-only" end
    path = vfsNormalize(path)
    filesTable[path] = nil
    touch()
    return true
  end
  fs.rename = function(from, to)
    if readOnly then return nil, "filesystem is read-only" end
    from = vfsNormalize(from)
    to = vfsNormalize(to)
    filesTable[to] = filesTable[from]
    filesTable[from] = nil
    touch()
    return true
  end
  fs.format = function()
    if readOnly then return nil, "filesystem is read-only" end
    -- Drop all files, keep the root
    for k in pairs(filesTable) do
      if k ~= "/" then filesTable[k] = nil end
    end
    filesTable["/"] = { type = "directory", modified = os.time() }
    touch()
    return true
  end
  fs.size = function(path)
    path = vfsNormalize(path)
    local info = filesTable[path]
    if info and info.type == "file" then return #info.content end
    return 0
  end
  fs.lastModified = function(path)
    path = vfsNormalize(path)
    local info = filesTable[path]
    -- OC standard: lastModified returns milliseconds (real-world timestamp)
    local mod = info and info.modified or os.time()
    return mod * 1000
  end
  return fs
end

local fs2 = makeFsProxy(fs2Files, fs2Label, fs2Size or (4 * 1024 * 1024), false, function(l) fs2Label = l end, diskPersist.mark)
local floppy = makeFsProxy(floppyFiles, floppyLabel, config.floppySize or (512 * 1024), floppyLocked, function(l) floppyLabel = l end, diskPersist.mark)
-- tmpfs: RAM-based, always writable, empty on boot (never persisted, so no onDirty)
local tmpfs = makeFsProxy(tmpFiles, "tmpfs", 4 * 1024 * 1024, false)

componentRegistry = {
  [gpuAddr] = { type = "gpu", proxy = gpu },
  [screenAddr] = { type = "screen", proxy = screen },
  [keyboardAddr] = { type = "keyboard", proxy = keyboard },
  [fsAddr] = { type = "filesystem", proxy = filesystem },
  [eepromAddr] = { type = "eeprom", proxy = eeprom },
}
-- disk2: registered only when configured
if config.disk2File then
  componentRegistry[fs2Addr] = { type = "filesystem", proxy = fs2 }
end
-- floppy: registered only when configured
if config.floppyFile then
  componentRegistry[floppyAddr] = { type = "filesystem", proxy = floppy }
end
-- tmpfs: always registered, RAM scratch filesystem
componentRegistry[tmpAddr] = { type = "filesystem", proxy = tmpfs }

-- Mods: robot / drone / microcontroller merged into one component
modsAddr = nil
if config.modsEnabled then
  modsAddr = genAddr()
  mods.address = modsAddr
  componentRegistry[modsAddr] = { type = "mods", proxy = mods }
  _stderr:write("[emulator] Mods: robot / drone / microcontroller merged component\n")
end

-- Expansion cards: registered according to config
local modem = nil

for i = 1, 3 do
  local card = config.expansion and config.expansion[i]
  if card then
    if card:match("^internet") then
      componentRegistry[internetAddr] = { type = "internet", proxy = internet }
      _stderr:write("[emulator] Expansion " .. i .. ": Internet Card\n")
    elseif card:match("^data") then
      -- Tier from the card type: data_t1=1, data_t2=2, data_t3=3
      local dtier = tonumber(card:match("t(%d)") or "1")
      if dtier < 1 then dtier = 1 end
      if dtier > 3 then dtier = 3 end
      data = createDataCard(dtier)
      componentRegistry[dataAddr] = { type = "data", proxy = data }
      _stderr:write("[emulator] Expansion " .. i .. ": Data Card T" .. dtier .. "\n")
    elseif card:match("^modem") or card:match("^wireless") then
      -- Wireless modem
      --
      -- Signal strength maps to real OC's range in blocks; the emulator has no
      -- spatial notion, so range becomes a discrete signal strength:
      --   strength = 1  -> isolated: cannot see or reach other VMs in this tool
      --   strength >= 2 -> discovers other VMs and exchanges modem messages
      -- Defaults to the card tier (T1=1, T2=2); override in config.json via
      -- hardware.modemStrength (max 16).
      local tier = tonumber(card:match("%d") or "1")
      if tier < 1 then tier = 1 end
      if tier > 2 then tier = 2 end
      modemAddr = genAddr()
      local strength = tonumber(hw.modemStrength) or tier
      if strength < 1 then strength = 1 end
      if strength > 16 then strength = 16 end
      local maxStrength = 16
      modem = {
        -- Public fields (as in real OC, readable from scripts)
        type = "modem",
        tier = tier,
        -- Internal state
        _openPorts = {},
        _strength = strength,
        _maxStrength = maxStrength,
      }
      modem.open = function(port)
        checkArg(1, port, "number")
        modem._openPorts[port] = true
        -- Must notify the server: modemHub routes by which ports are open,
        -- otherwise other VMs silently receive nothing.
        sendToServer({ type = "modem_open_port", port = port })
        return true
      end
      modem.close = function(port)
        if port then
          checkArg(1, port, "number")
          modem._openPorts[port] = nil
          sendToServer({ type = "modem_close_port", port = port })
        else
          -- no argument: close every port
          for p in pairs(modem._openPorts) do
            sendToServer({ type = "modem_close_port", port = p })
          end
          modem._openPorts = {}
        end
        return true
      end
      modem.isOpen = function(port)
        checkArg(1, port, "number")
        return modem._openPorts[port] == true
      end
      modem.getOpenPorts = function()
        local ports = {}
        for p in pairs(modem._openPorts) do
          ports[#ports + 1] = p
        end
        return ports
      end
      -- Maximum packet size (modem.maxPacketSize). MineOS networking probes this first
      -- and falls back to getDeviceInfo()[addr].capacity (see MODEM_MAX_PACKET_SIZE above).
      -- Without it the fragment size is nil and large replies cannot be sent.
      modem.maxPacketSize = function()
        return MODEM_MAX_PACKET_SIZE
      end
      modem.send = function(dest, port, ...)
        checkArg(1, dest, "string")
        checkArg(2, port, "number")
        -- Route to other VMs through the server.
        -- Must include both our modem address (from) and the target (to).
        -- Without from the server reads msg.from/msg.to as nil,
        -- treats every cross-VM message as having no destination and drops it.
        sendToServer({
          type = "modem_send",
          from = modemAddr,
          to = dest,
          dest = dest,   -- legacy field name
          port = port,
          data = { ... },
        })
        return true
      end
      modem.broadcast = function(port, ...)
        checkArg(1, port, "number")
        sendToServer({
          type = "modem_broadcast",
          from = modemAddr,
          port = port,
          data = { ... },
        })
        return true
      end
      modem.getStrength = function() return modem._strength end
      modem.setStrength = function(s)
        checkArg(1, s, "number")
        if s < 0 then s = 0 end
        if s > modem._maxStrength then s = modem._maxStrength end
        modem._strength = s
        -- Sync to the server: strength < 2 isolates this VM (no sends, no receives)
        sendToServer({ type = "modem_strength", strength = s })
        return s
      end
      modem.getMaxStrength = function() return modem._maxStrength end
      modem.isWireless = function() return true end
      -- T2 modems support cable and wireless; T1 is wireless only
      modem.isWired = function() return tier >= 2 end
      componentRegistry[modemAddr] = { type = "modem", proxy = modem }
      -- Register with the server (including strength; the hub uses it for routing)
      sendToServer({ type = "modem_register", address = modemAddr, tier = tier, wired = (tier >= 2), strength = strength })
      _stderr:write("[emulator] Expansion " .. i .. ": Wireless Modem T" .. tier .. " (signal strength=" .. strength .. ")\n")
    end
  end
end

computer._bootAddr = fsAddr
computer._tmpAddr = tmpAddr

-- ============================================================
-- component API
-- ============================================================
local component = {}
component._primaries = {
  gpu = gpuAddr, screen = screenAddr, keyboard = keyboardAddr,
  filesystem = fsAddr, eeprom = eepromAddr,
}
-- Add primaries based on what was registered
if componentRegistry[internetAddr] then component._primaries.internet = internetAddr end
if componentRegistry[dataAddr] then component._primaries.data = dataAddr end
if modemAddr then component._primaries.modem = modemAddr end
if modsAddr then component._primaries.mods = modsAddr end
function component.list(filter, exact)
  dlog("component.list called with filter:", tostring(filter))
  local list = {}
  for addr, info in pairs(componentRegistry) do
    if not filter or (exact and info.type == filter) or (not exact and info.type:find(filter)) then
      list[addr] = info.type
      dlog("  match:", info.type, addr:sub(1,8))
    end
  end
  -- OC's component.list result supports two usages:
  -- 1) for addr, type in pairs(component.list()) do
  -- 2) for addr in component.list() do (iterator via __call)
  setmetatable(list, {
    __call = function(t, state, current)
      local k = next(t, current)
      if k then return k, t[k] end
    end
  })
  return list
end
function component.proxy(address)
  local info = componentRegistry[address]
  if info then
    dlog("component.proxy:", info.type, "->", address:sub(1,8))
    -- OpenOS reads the address from proxy.address
    if not info.proxy.address then
      info.proxy.address = address
    end
    info.proxy.type = info.type
    return info.proxy
  end
  dlog("component.proxy FAIL:", tostring(address):sub(1,8))
  return nil, "no such component"
end
function component.invoke(address, method, ...)
  local info = componentRegistry[address]
  if not info then
    dlog("invoke FAIL: no component", tostring(address):sub(1,8), "method", method)
    return nil, "no such component"
  end
  local fn = info.proxy[method]
  if not fn then
    dlog("invoke FAIL: no method", method, "on", info.type)
    return nil, "no such method: " .. method
  end
  local results = {pcall(fn, ...)}
  local ok = table.remove(results, 1)
  if not ok then
    dlog("invoke ERROR:", info.type, method, "-", tostring(results[1]):sub(1,100))
    return nil, results[1]
  end
  dlog("invoke OK:", info.type, method)
  return (table.unpack or unpack)(results)
end
function component.type(address) return componentRegistry[address] and componentRegistry[address].type end
function component.methods(address)
  local info = componentRegistry[address]
  if not info then return {} end
  local methods = {}
  for name, fn in pairs(info.proxy) do
    if type(fn) == "function" and not name:match("^_") then methods[name] = true end
  end
  return methods
end
function component.doc(address, method)
  local info = componentRegistry[address]
  if not info or not info.proxy[method] then return nil end
  return method
end
function component.get(address, ctype)
  for addr, info in pairs(componentRegistry) do
    if addr:find(address, 1, true) == 1 and (not ctype or info.type == ctype) then return addr end
  end
  return nil, "no such component"
end
function component.isAvailable(ctype) return component._primaries[ctype] ~= nil end
function component.getPrimary(ctype)
  local addr = component._primaries[ctype]
  if not addr then error("no primary " .. ctype) end
  return componentRegistry[addr].proxy
end
function component.setPrimary(ctype, address) component._primaries[ctype] = address end
function component.slot(address) return -1 end
function component.fields(address) return {} end
setmetatable(component, {
  __index = function(t, key)
    local addr = component._primaries[key]
    if addr then
      local info = componentRegistry[addr]
      if info then
        -- Ensure address/type are present when accessed via component.xxx
        -- OpenOS 91_gpu.lua relies on component.screen.address
        if not info.proxy.address then
          info.proxy.address = addr
        end
        info.proxy.type = info.type
        return info.proxy
      end
    end
    return nil
  end
})

-- ============================================================
-- External device components
--
-- Devices like reactors are not computers; in real OC they join the component network via adapters.
-- The server pushes a state snapshot (ext_state) every second; these methods read it locally,
-- writes (setActive) go back through ext_command.
--
-- Lua 5.1 allows at most 200 locals per chunk, so state lives in a global table
-- to save local slots.
-- ============================================================
extComponents = { devices = {} }   -- devices: address -> proxy

-- Read-only instrument components: MineOS IC2Reactors.app reads these via reactor_chamber
extComponents.makeReactorChamber = function(address)
  local dev = { address = address, type = "reactor_chamber", _state = {} }
  local function S() return dev._state end

  function dev.getHeat() return tonumber(S().hullHeat) or 0 end
  function dev.getMaxHeat() return tonumber(S().hullHeatCapacity) or 0 end
  -- Temperature: ambient + core heat, capped at casing capacity + ambient
  function dev.getTemperature() return tonumber(S().temperature) or 0 end
  function dev.getMaxTemperature() return tonumber(S().maxTemperature) or 0 end
  function dev.getHeatCapacity() return dev.getMaxTemperature() end
  -- Set temperature (clamped between ambient and the cap) and return it
  function dev.setTemperature(value)
    local v = tonumber(value) or 0
    local max = dev.getMaxTemperature()
    if v < 0 then v = 0 end
    if max > 0 and v > max then v = max end
    sendToServer({ type = "ext_command", address = address, method = "setTemperature", args = { v } })
    S().temperature = v
    S().overheated = (max > 0 and v >= max) or false
    return v
  end
  function dev.getReactorEUOutput() return tonumber(S().euPerTick) or 0 end
  dev.getReactorEUEnergyOutput = dev.getReactorEUOutput
  function dev.getEnergyOutput() return tonumber(S().euPerTick) or 0 end
  -- Heat per second (IC2 advances heat by the second)
  function dev.getHeatOutput()
    local s = S()
    return tonumber(s.heatPerSecond) or ((tonumber(s.heatPerTick) or 0) * 20)
  end
  function dev.isActive() return S().active == true end
  function dev.getActive() return S().active == true end
  -- Producing power when active and at least one fuel rod still has fuel
  function dev.producesEnergy()
    local s = S()
    if s.active ~= true then return false end
    return (tonumber(s.activeRods) or 0) > 0
  end
  function dev.getSize() return tonumber(S().columns) or 0, tonumber(S().rows) or 0 end
  function dev.slotCount() return (tonumber(S().columns) or 0) * (tonumber(S().rows) or 0) end
  dev.getSlotCount = dev.slotCount
  -- Slots are 1-based, as in OpenComputers' reactor_chamber
  local function slotAt(slot)
    local index = tonumber(slot)
    local slots = S().slots
    if not index or index < 1 or type(slots) ~= "table" then return nil end
    local item = slots[index]
    if type(item) ~= "table" then return nil end
    return item
  end

  function dev.getStackInSlot(slot) return slotAt(slot) end
  dev.getComponentInfo = dev.getStackInSlot

  -- Component durability: current, max; empty slot returns 0, 0
  function dev.getComponentDurability(slot)
    local item = slotAt(slot)
    if not item then return 0, 0 end
    return tonumber(item.durability) or 0, tonumber(item.maxDurability) or 0
  end
  dev.getSlotDurability = dev.getComponentDurability

  -- Remaining durability ratio (0-1); 0 for empty slots or components without durability
  function dev.getComponentDurabilityRatio(slot)
    local item = slotAt(slot)
    if not item then return 0 end
    local max = tonumber(item.maxDurability) or 0
    if max <= 0 then return 0 end
    local cur = tonumber(item.durability) or 0
    if cur < 0 then cur = 0 elseif cur > max then cur = max end
    return cur / max
  end

  local function lowestDurability(category)
    local s = S()
    local slots = s.slots
    if type(slots) ~= "table" then return nil end
    local total = (tonumber(s.columns) or 0) * (tonumber(s.rows) or 0)
    local min
    for i = 1, total do
      local item = slots[i]
      local max = type(item) == "table" and (tonumber(item.maxDurability) or 0) or 0
      if max > 0 and (category == nil or item.category == category) then
        local cur = tonumber(item.durability) or 0
        local r = cur / max
        if r < 0 then r = 0 elseif r > 1 then r = 1 end
        if min == nil or r < min then min = r end
      end
    end
    return min
  end

  -- Lowest durability ratio in a category (0-1); omitted category means all, 0 when none
  function dev.getDurabilityRatio(category)
    local r = lowestDurability(category)
    return r or 0
  end

  -- Current temperature of one component (C); 0 for an empty slot
  function dev.getComponentTemperature(slot)
    local item = slotAt(slot)
    if not item then return 0 end
    return tonumber(item.temperature) or 0
  end
  dev.getSlotTemperature = dev.getComponentTemperature

  -- Temperature ratio of one component (0-1); 0 for an empty slot
  function dev.getComponentTemperatureRatio(slot)
    local item = slotAt(slot)
    if not item then return 0 end
    local max = tonumber(item.maxTemperature) or tonumber(S().maxTemperature) or 0
    if max <= 0 then return 0 end
    local t = tonumber(item.temperature) or 0
    if t < 0 then t = 0 elseif t > max then t = max end
    return t / max
  end
  function dev.getStats()
    local s = S()
    return {
      active = s.active == true,
      columns = tonumber(s.columns) or 0,
      rows = tonumber(s.rows) or 0,
      euPerTick = tonumber(s.euPerTick) or 0,
      heatPerTick = tonumber(s.heatPerTick) or 0,
      heatPerSecond = tonumber(s.heatPerSecond) or ((tonumber(s.heatPerTick) or 0) * 20),
      fuelRods = tonumber(s.fuelRods) or 0,
      activeRods = tonumber(s.activeRods) or 0,
      hullHeat = tonumber(s.hullHeat) or 0,
      hullHeatCapacity = tonumber(s.hullHeatCapacity) or 0,
      temperature = tonumber(s.temperature) or tonumber(s.hullHeat) or 0,
      maxTemperature = tonumber(s.maxTemperature) or tonumber(s.hullHeatCapacity) or 0,
      overheated = s.overheated == true,
      remainingCapacity = tonumber(s.remainingCapacity) or 0,
      totalCapacity = tonumber(s.totalCapacity) or 0,
      generatedEu = tonumber(s.generatedEu) or 0,
      status = s.status,
    }
  end
  return dev
end

-- Actuator component: side 0 = reactor core, 1 = fuel tank, 2 = waste tank
-- Inventory refreshes with ext_state every second; transferItem goes through ext_command
extComponents.makeTransposer = function(address)
  local dev = { address = address, type = "transposer", _state = {} }

  local function sideData(side)
    local sides = type(dev._state.sides) == "table" and dev._state.sides or {}
    return sides[tostring(tonumber(side) or 0)]
  end

  local function sideSlots(data)
    if type(data) ~= "table" then return {}, 0 end
    local slots = type(data.slots) == "table" and data.slots or {}
    return slots, tonumber(data.size) or 0
  end

  function dev.getSize(side)
    local _, size = sideSlots(sideData(side))
    return size
  end
  -- OpenComputers inventory size method name
  dev.getInventorySize = dev.getSize

  function dev.getStackInSlot(side, slot)
    local slots = sideSlots(sideData(side))
    local index = tonumber(slot) or 1
    if index < 1 then return nil end
    return slots[tostring(index - 1)]
  end

  -- Inventory descriptor: callable iterator (like the OpenComputers inventory object)
  -- plus getAll / count / reset / getSize / getStackInSlot; slots start at 1
  function dev.getAllStacks(side)
    local slots, size = sideSlots(sideData(side))
    local cursor = 0
    local controller = { address = address .. "-" .. tostring(tonumber(side) or 0) }
    function controller.getSize() return size end
    function controller.count() return size end
    function controller.reset() cursor = 0 end
    function controller.getAll()
      local out = {}
      for i = 1, size do out[i] = slots[tostring(i - 1)] end
      return out
    end
    function controller.getStackInSlot(slot)
      local index = tonumber(slot) or 1
      if index < 1 then return nil end
      return slots[tostring(index - 1)]
    end
    function controller.addItems() return 0 end
    function controller.removeItems() return 1 end
    return setmetatable(controller, {
      __call = function()
        -- skip empty slots; iteration ends only at the end
        while cursor < size do
          cursor = cursor + 1
          local stack = slots[tostring(cursor - 1)]
          if stack then return stack end
        end
        return nil
      end,
    })
  end

  -- Move one item between sides; slots are 1-based, 0 or nil picks automatically
  -- Returns the moved count, as in OpenComputers
  function dev.transferItem(from, to, count, fromSlot, toSlot)
    sendToServer({
      type = "ext_command",
      address = address,
      method = "transferItem",
      args = { from, to, count, fromSlot, toSlot },
    })
    return 1
  end

  return dev
end

-- Custom-script machine components: properties, read-only methods and actions come from machine.lua;
-- the server sends property tables and method names in ext_devices meta.
extComponents.makeMachineComponent = function(address, meta)
  meta = type(meta) == "table" and meta or {}
  local dev = { address = address, type = "machine_component", _state = {}, _meta = meta }
  local function S() return dev._state end
  local function props() return type(meta.props) == "table" and meta.props or {} end

  local function capitalize(key)
    return string.upper(string.sub(key, 1, 1)) .. string.sub(key, 2)
  end

  function dev.getValue(key)
    if type(key) ~= "string" then return nil end
    return S()[key]
  end

  function dev.setValue(key, value)
    if type(key) ~= "string" then return false end
    for _, prop in ipairs(props()) do
      if prop.key == key then
        if prop.writable ~= true then return false end
        sendToServer({ type = "ext_command", address = address, method = "setValue", args = { key, value } })
        S()[key] = value
        return true
      end
    end
    return false
  end

  function dev.getState()
    local copy = {}
    for _, prop in ipairs(props()) do
      local key = prop.key
      if type(key) == "string" then copy[key] = S()[key] end
    end
    return copy
  end

  function dev.listProps() return props() end
  function dev.getLabel() return meta.label or "" end
  function dev.getComponentType() return dev.type end
  dev.getType = dev.getComponentType

  -- Each writable property gets generated getXxx() / setXxx()
  for _, prop in ipairs(props()) do
    if type(prop.key) == "string" and prop.key:match("^[%a_][%w_]*$") then
      local suffix = capitalize(prop.key)
      local getter = "get" .. suffix
      local setter = "set" .. suffix
      if dev[getter] == nil then
        dev[getter] = function() return S()[prop.key] end
      end
      if prop.writable == true and dev[setter] == nil then
        dev[setter] = function(value) return dev.setValue(prop.key, value) end
      end
    end
  end

  -- Read-only methods: computed once per tick and shipped in the state snapshot
  if type(meta.methods) == "table" then
    for _, name in ipairs(meta.methods) do
      if type(name) == "string" and name:match("^[%a_][%w_]*$") and dev[name] == nil then
        dev[name] = function() return S()[name] end
      end
    end
  end

  -- Actions: sent back to the script asynchronously; results appear in the next snapshot
  if type(meta.actions) == "table" then
    for _, name in ipairs(meta.actions) do
      if type(name) == "string" and name:match("^[%a_][%w_]*$") and dev[name] == nil then
        dev[name] = function(...)
          local callArgs = { ... }
          sendToServer({ type = "ext_command", address = address, method = "action", args = { name, callArgs } })
        end
      end
    end
  end

  return dev
end

extComponents.makeRedstone = function(address, meta)
  local dev = {
    address = address,
    type = "redstone",
    _state = {},
    _out = {},
    _bout = {},
    _meta = type(meta) == "table" and meta or {},
  }
  local function S() return dev._state end

  local STATUS_CODE = { off = 0, idle = 3, depleted = 3, stable = 8, warning = 12, critical = 15, overheat = 15 }

  local function clamp(v)
    v = tonumber(v) or 0
    if v < 0 then return 0 end
    if v > 15 then return 15 end
    return math.floor(v)
  end

  local function ratio(value, max)
    value = tonumber(value) or 0
    max = tonumber(max) or 0
    if max <= 0 then return 0 end
    local r = value / max
    if r < 0 then r = 0 end
    if r > 1 then r = 1 end
    return math.floor(r * 15 + 0.5)
  end

  -- Lowest durability ratio in a category; nil when no component matches
  local function lowestDurability(category)
    local s = S()
    local slots = s.slots
    if type(slots) ~= "table" then return nil end
    local total = (tonumber(s.columns) or 0) * (tonumber(s.rows) or 0)
    local min
    for i = 1, total do
      local item = slots[i]
      local max = type(item) == "table" and (tonumber(item.maxDurability) or 0) or 0
      if max > 0 and (category == nil or item.category == category) then
        local cur = tonumber(item.durability) or 0
        local r = cur / max
        if r < 0 then r = 0 elseif r > 1 then r = 1 end
        if min == nil or r < min then min = r end
      end
    end
    return min
  end

  -- Durability ratio mapped to a 0-15 signal; 0 when no component matches
  local function durabilitySignal(category)
    local r = lowestDurability(category)
    if r == nil then return 0 end
    return clamp(r * 15 + 0.5)
  end

  -- Highest temperature ratio in a category; nil when no component matches
  local function highestTemperatureRatio(category)
    local s = S()
    local slots = s.slots
    if type(slots) ~= "table" then return nil end
    local max = tonumber(s.maxTemperature) or tonumber(s.hullHeatCapacity) or 0
    if max <= 0 then return nil end
    local total = (tonumber(s.columns) or 0) * (tonumber(s.rows) or 0)
    local highest
    for i = 1, total do
      local item = slots[i]
      if type(item) == "table" and (category == nil or item.category == category) then
        local t = tonumber(item.temperature) or 0
        if highest == nil or t > highest then highest = t end
      end
    end
    if highest == nil then return nil end
    local r = highest / max
    if r < 0 then r = 0 elseif r > 1 then r = 1 end
    return r
  end

  -- Temperature ratio mapped to a 0-15 signal; 0 when no component matches
  local function temperatureSignal(category)
    local r = highestTemperatureRatio(category)
    if r == nil then return 0 end
    return clamp(r * 15 + 0.5)
  end

  -- Input channels (reactor -> computer)
  --   0: core heat %   1: EU/t (one step per 100 EU/t, max 15)
  --   2: fuel rod count   3: state (off 0 / idle 3 / stable 8 / warning 12 / critical or overheat 15)
  --   4: remaining cooling %   5: running (0 / 15)
  --   6: min fuel rod durability   7: min coolant durability
  --   8: min condenser durability   9: min over all components (percent x 15)
  --  10: max fuel rod temperature  11: max coolant temperature
  --  12: max condenser temperature  13: max over all components (ratio x 15)
  -- Custom-script machine redstone port: its state has machine = true,
  -- and inputs / outputs are 0-15 arrays in property order.
  local function isMachine() return S().machine == true or dev._meta.machine == true end

  local function machineSideCount()
    local count = tonumber(S().sideCount) or 0
    if count > 0 then return count end
    local inputs = S().inputs
    if type(inputs) == "table" then return #inputs end
    return 0
  end

  local function machineInput(side)
    local inputs = S().inputs
    if type(inputs) ~= "table" then return 0 end
    return clamp(inputs[(tonumber(side) or 0) + 1])
  end

  function dev.getInput(side)
    -- As in OpenComputers: no side returns readings for every channel
    if side == nil then
      local all = {}
      for i = 0, 13 do all[i] = dev.getInput(i) end
      return all
    end
    side = tonumber(side) or 0
    if isMachine() then return machineInput(side) end
    local s = S()
    if side == 0 then
      return ratio(s.hullHeat, s.hullHeatCapacity)
    elseif side == 1 then
      return clamp((tonumber(s.euPerTick) or 0) / 100)
    elseif side == 2 then
      return clamp(s.fuelRods)
    elseif side == 3 then
      return STATUS_CODE[s.status] or 0
    elseif side == 4 then
      return ratio(s.remainingCapacity, s.totalCapacity)
    elseif side == 5 then
      return (s.active == true) and 15 or 0
    elseif side == 6 then
      return durabilitySignal("fuel")
    elseif side == 7 then
      return durabilitySignal("coolant")
    elseif side == 8 then
      return durabilitySignal("condensator")
    elseif side == 9 then
      return durabilitySignal(nil)
    elseif side == 10 then
      return temperatureSignal("fuel")
    elseif side == 11 then
      return temperatureSignal("coolant")
    elseif side == 12 then
      return temperatureSignal("condensator")
    elseif side == 13 then
      return temperatureSignal(nil)
    end
    return 0
  end
  dev.getComparatorInput = dev.getInput

  function dev.getOutput(side)
    -- As in OpenComputers: no side returns outputs for every channel
    if side == nil then
      local all = {}
      for i = 0, 13 do all[i] = dev.getOutput(i) end
      return all
    end
    side = tonumber(side) or 0
    if isMachine() then
      local outputs = S().outputs
      if type(outputs) == "table" then
        local value = tonumber(outputs[side + 1])
        if value then return clamp(value) end
      end
      return 0
    end
    -- Reactor port: outputs mirror the actual on/off state so IC2Reactors can init buttons
    if S().active ~= nil then
      return S().active == true and 15 or 0
    end
    return dev._out[side] or 0
  end

  -- Output channels (computer -> machine): any channel sets the switch; > 0 means active
  function dev.setOutput(side, value)
    side = tonumber(side) or 0
    value = clamp(value)
    -- As in OpenComputers: return the previous value
    local previous = dev.getOutput(side)
    dev._out[side] = value
    sendToServer({ type = "ext_command", address = address, method = "setOutput", args = { side, value } })
    if not isMachine() then dev._state.active = value > 0 end
    return previous
  end

  function dev.getBundledOutput(side)
    if side == nil then
      local all = {}
      for i = 0, 13 do all[i] = dev.getBundledOutput(i) end
      return all
    end
    return dev._bout[tonumber(side) or 0] or 0
  end

  -- bit0 is the switch on any channel; return the previous value
  function dev.setBundledOutput(side, mask)
    side = tonumber(side) or 0
    mask = tonumber(mask) or 0
    if isMachine() then return 0 end
    local previous = dev._bout[side] or 0
    dev._bout[side] = mask
    sendToServer({ type = "ext_command", address = address, method = "setBundledOutput", args = { side, mask } })
    dev._state.active = (mask % 2) == 1
    return previous
  end

  -- channel 0 bit0..bit3: running / stable / warning / danger
  function dev.getBundledInput(side)
    side = tonumber(side) or 0
    if isMachine() then return 0 end
    if side ~= 0 then return 0 end
    local s = S()
    local mask = 0
    if s.active == true then mask = mask + 1 end
    if s.status == "stable" then mask = mask + 2 end
    if s.status == "warning" then mask = mask + 4 end
    if s.status == "critical" or s.status == "overheat" then mask = mask + 8 end
    return mask
  end

  function dev.getSides()
    if isMachine() then
      local count = machineSideCount()
      local sides = {}
      for i = 0, count - 1 do sides[#sides + 1] = i end
      return sides
    end
    return { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 }
  end

  return dev
end

extComponents.apply = function(list)
  if type(list) ~= "table" then return end
  local seen = {}
  for _, entry in ipairs(list) do
    local address = entry.address
    local ctype = entry.type
    if type(address) == "string" and type(ctype) == "string" then
      seen[address] = true
      if not extComponents.devices[address] then
        local proxy = nil
        if ctype == "reactor_chamber" then proxy = extComponents.makeReactorChamber(address)
        elseif ctype == "transposer" then proxy = extComponents.makeTransposer(address)
        elseif ctype == "redstone" then proxy = extComponents.makeRedstone(address, entry.meta)
        else proxy = extComponents.makeMachineComponent(address, entry.meta) end
        if proxy then
          extComponents.devices[address] = proxy
          componentRegistry[address] = { type = ctype, proxy = proxy }
          if not component._primaries[ctype] then component._primaries[ctype] = address end
          pushSignal("component_added", address, ctype)
        end
      end
    end
  end
  -- Drop devices the server no longer knows about
  for address, proxy in pairs(extComponents.devices) do
    if not seen[address] then
      extComponents.devices[address] = nil
      componentRegistry[address] = nil
      if component._primaries[proxy.type] == address then component._primaries[proxy.type] = nil end
      pushSignal("component_removed", address, proxy.type)
    end
  end
end

extComponents.update = function(list)
  if type(list) ~= "table" then return end
  for _, entry in ipairs(list) do
    local proxy = extComponents.devices[entry.address]
    if proxy and type(entry.state) == "table" then
      for k, v in pairs(entry.state) do proxy._state[k] = v end
    end
  end
end

-- Load devices.json at startup so external devices exist as soon as programs run
do
  local f = _io_open(vmDir .. "/devices.json", "r")
  if f then
    local text = f:read("*a")
    f:close()
    local ok, list = pcall(jsonDecode, text or "")
    if ok and type(list) == "table" then
      extComponents.apply(list)
      extComponents.update(list)
    end
  end
end

-- ============================================================
-- unicode API (UTF-8)
-- ============================================================
local unicode = {}

-- Lua's string functions convert numbers implicitly (string.gsub(123, ...) works), so the
-- guest may pass a number where a string is expected. MineOS does this from GUI widgets
-- (string.wlen of a numeric value); without the conversion the method form (s:gmatch)
-- raises "attempt to index a number value".
unicode._str = function(v)
  if type(v) == "number" then return tostring(v) end
  return v
end

-- Count characters in a UTF-8 string
unicode.len = function(s)
  s = unicode._str(s)
  local n = 0
  for _ in s:gmatch(".[\128-\191]*") do n = n + 1 end
  return n
end

-- Display width (narrow = 1, wide = 2)
unicode.wlen = function(s)
  s = unicode._str(s)
  local w = 0
  for ch in s:gmatch(".[\128-\191]*") do
    w = w + (unicode.isWide(ch) and 2 or 1)
  end
  return w
end

-- Substring by character index (UTF-8 safe)
unicode.sub = function(s, i, j)
  s = unicode._str(s)
  local chars = {}
  for ch in s:gmatch(".[\128-\191]*") do table.insert(chars, ch) end
  i = i < 0 and #chars + i + 1 or i
  j = j or #chars
  j = j < 0 and #chars + j + 1 or j
  local result = {}
  for k = i, j do if chars[k] then table.insert(result, chars[k]) end end
  return table.concat(result)
end

unicode.upper = function(s)
  -- Simple implementation: ASCII only
  return (unicode._str(s):gsub("%a", string.upper))
end
unicode.lower = function(s)
  return (unicode._str(s):gsub("%a", string.lower))
end

-- UTF-8 character from a Unicode code point
unicode.char = function(...)
  local result = {}
  for _, cp in ipairs({...}) do
    if cp < 0x80 then
      table.insert(result, string.char(cp))
    elseif cp < 0x800 then
      table.insert(result, string.char(0xC0 + math.floor(cp / 0x40), 0x80 + (cp % 0x40)))
    elseif cp < 0x10000 then
      table.insert(result, string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + (math.floor(cp / 0x40) % 0x40), 0x80 + (cp % 0x40)))
    else
      table.insert(result, string.char(0xF0 + math.floor(cp / 0x40000), 0x80 + (math.floor(cp / 0x1000) % 0x40), 0x80 + (math.floor(cp / 0x40) % 0x40), 0x80 + (cp % 0x40)))
    end
  end
  return table.concat(result)
end

-- Unicode code point from a UTF-8 string
unicode.byte = function(s, i, j)
  s = unicode._str(s)
  i = i or 1
  j = j or i
  local result = {}
  local pos = 1
  local idx = 0
  for ch in s:gmatch(".[\128-\191]*") do
    idx = idx + 1
    if idx >= i and idx <= j then
      local b1, b2, b3, b4 = ch:byte(1, 4)
      local cp
      if not b2 then cp = b1
      elseif b1 < 0xE0 then cp = (b1 % 0x20) * 0x40 + (b2 % 0x40)
      elseif b1 < 0xF0 then cp = (b1 % 0x10) * 0x1000 + (b2 % 0x40) * 0x40 + (b3 % 0x40)
      else cp = (b1 % 0x08) * 0x40000 + (b2 % 0x40) * 0x1000 + (b3 % 0x40) * 0x40 + (b4 % 0x40) end
      table.insert(result, cp)
    end
  end
  return table.unpack(result)
end

unicode.reverse = function(s)
  s = unicode._str(s)
  local chars = {}
  for ch in s:gmatch(".[\128-\191]*") do table.insert(chars, 1, ch) end
  return table.concat(chars)
end

unicode.rep = string.rep
unicode.find = string.find
unicode.gfind = string.gfind
unicode.gmatch = string.gmatch
unicode.gsub = string.gsub
unicode.match = string.match

-- Is the character wide (display width 2)?
-- OC: only CJK ideographs, fullwidth characters etc. are wide
-- Latin extensions and block characters (█▀▄) are narrow (width 1)
unicode.isWide = function(ch)
  if not ch or ch == "" then return false end
  ch = unicode._str(ch)
  -- Decode the UTF-8 code point
  local b = ch:byte(1)
  local cp
  if b < 0x80 then
    cp = b
  elseif b < 0xE0 then
    cp = ((b % 0x20) * 0x40) + (ch:byte(2) % 0x40)
  elseif b < 0xF0 then
    cp = ((b % 0x10) * 0x1000) + ((ch:byte(2) % 0x40) * 0x40) + (ch:byte(3) % 0x40)
  else
    cp = ((b % 0x08) * 0x40000) + ((ch:byte(2) % 0x40) * 0x1000) + ((ch:byte(3) % 0x40) * 0x40) + (ch:byte(4) % 0x40)
  end
  -- Wide ranges: CJK ideographs, fullwidth forms, Hangul, ...
  -- 0x1100-0x115F: Hangul Jamo
  -- 0x2E80-0xA4CF: CJK radicals, Kangxi, CJK symbols, Japanese, Hangul
  -- 0xAC00-0xD7A3: Hangul Syllables
  -- 0xF900-0xFAFF: CJK compatibility ideographs
  -- 0xFE30-0xFE4F: CJK compatibility forms
  -- 0xFF00-0xFF60: fullwidth ASCII
  -- 0xFFE0-0xFFE6: fullwidth signs
  -- 0x1F300-0x1FAFF: emoji and symbols
  if (cp >= 0x1100 and cp <= 0x115F) or
     (cp >= 0x2E80 and cp <= 0xA4CF) or
     (cp >= 0xAC00 and cp <= 0xD7A3) or
     (cp >= 0xF900 and cp <= 0xFAFF) or
     (cp >= 0xFE30 and cp <= 0xFE4F) or
     (cp >= 0xFF00 and cp <= 0xFF60) or
     (cp >= 0xFFE0 and cp <= 0xFFE6) or
     (cp >= 0x1F300 and cp <= 0x1FAFF) then
    return true
  end
  return false
end

-- Truncate a string to a display width
unicode.wtrunc = function(s, width)
  s = unicode._str(s)
  if width <= 0 then return "" end
  local w = 0
  local result = {}
  for ch in s:gmatch(".[\128-\191]*") do
    local cw = unicode.isWide(ch) and 2 or 1
    if w + cw > width then break end
    w = w + cw
    table.insert(result, ch)
  end
  return table.concat(result)
end

-- Character iterator
unicode.chars = function(s)
  return unicode._str(s):gmatch(".[\128-\191]*")
end

-- ============================================================
-- Global keyboard library
-- ============================================================
keyboard.keys = {
  escape = 1, f1 = 2, f2 = 3, f3 = 4, f4 = 5, f5 = 6, f6 = 7, f7 = 8, f8 = 9,
  f9 = 10, f10 = 11, f11 = 12, f12 = 13, ["break"] = 14, home = 199,
  ["end"] = 207, pageUp = 201, pageDown = 209, up = 200, down = 208,
  left = 203, right = 205, enter = 28, back = 14, tab = 15, space = 57,
  insert = 210, delete = 211, lshift = 42, rshift = 54, lcontrol = 29,
  rcontrol = 157, lmenu = 56, rmenu = 184,
}
keyboard.isControlPressed = function() return keyboard._control end
keyboard.isShiftPressed = function() return keyboard._shift end
keyboard.isAltPressed = function() return keyboard._alt end
keyboard.isKeyDown = function() return false end
keyboard.ESCAPE = 1

-- ============================================================
-- colors / sides / text / serialization
-- ============================================================
local colors = {
  white = 0xFFFFFF, orange = 0xFFA500, magenta = 0xFF00FF, lightBlue = 0x55FFFF,
  yellow = 0xFFFF00, lime = 0x00FF00, pink = 0xFF69B4, gray = 0x808080,
  lightGray = 0xD3D3D3, cyan = 0x00FFFF, purple = 0x800080, blue = 0x0000FF,
  brown = 0x8B4513, green = 0x008000, red = 0xFF0000, black = 0x000000,
}
local sides = { bottom = 0, top = 1, back = 2, front = 3, right = 4, left = 5 }
sides.sides = function() return 0, 1, 2, 3, 4, 5 end
local text = {
  split = function(s, sep)
    local p = {}; for part in s:gmatch("[^" .. sep .. "]+") do table.insert(p, part) end; return p
  end,
  trim = function(s) return s:match("^%s*(.-)%s*$") end,
}
local serialization = {}
serialization.serialize = function(val)
  local t = type(val)
  if t == "string" then return '"' .. val:gsub('"', '\\"') .. '"' end
  if t == "number" then return tostring(val) end
  if t == "boolean" then return tostring(val) end
  if t == "nil" then return "nil" end
  if t == "table" then
    local p = {}
    for k, v in pairs(val) do table.insert(p, "[" .. serialization.serialize(k) .. "]=" .. serialization.serialize(v)) end
    return "{" .. table.concat(p, ",") .. "}"
  end
  return "nil"
end
serialization.unserialize = function(s)
  local fn = load("return " .. s)
  return fn and fn() or nil
end

-- ============================================================
-- Inject into the global environment
-- ============================================================
_G.component = component
_G.computer = computer
_G.unicode = unicode
_G.keyboard = keyboard
_G.colors = colors
_G.sides = sides
_G.text = text
_G.serialization = serialization
_G.filesystem = filesystem
_G.bit32 = bit32
if modsAddr then _G.mods = mods end

if not _G.checkArg then
  function checkArg(n, val, ...)
    local t = type(val)
    for i = 1, select("#", ...) do
      if t == select(i, ...) then return end
    end
    error("bad argument #" .. n .. " (" .. table.concat({...}, " or ") .. " expected, got " .. t .. ")", 2)
  end
end

-- Keep original os functions (avoid recursion)
local _os_time = os.time
local _os_date = os.date
-- _os_clock is defined at the top of the file
local _os_execute = os.execute

if not _G.os then _G.os = {} end
if not _G.os.sleep then _G.os.sleep = function(t) computer.pullSignal(t or 0) end end
_G.os.time = function() return _os_time() end
-- Windows strftime lacks POSIX extension specifiers (%T/%D/%R/%r/%n/%t/%s/%e),
-- while real OC on LuaJ supports them (Fuchas' task bar uses os.date("%T")).
-- Expand them into host-supported equivalents before calling the native os.date.
local posixDateAliases = {
  T = "%H:%M:%S",
  D = "%m/%d/%y",
  R = "%H:%M",
  r = "%I:%M:%S %p",
  n = "\n",
  t = "\t",
  e = "%d",
}
-- Expand each specifier; "%s" has no strftime equivalent, so inline the timestamp
local function normalizeDateFormat(fmt, now)
  local out, i, len = {}, 1, #fmt
  while i <= len do
    local c = fmt:sub(i, i)
    if c == "%" and i < len then
      local spec = fmt:sub(i + 1, i + 1)
      if spec == "s" then
        out[#out + 1] = tostring(now)
      else
        out[#out + 1] = posixDateAliases[spec] or ("%" .. spec)
      end
      i = i + 2
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
  return table.concat(out)
end
_G.os.date = function(fmt, t)
  if t ~= nil then
    t = math.floor(tonumber(t) or 0)
  end
  if type(fmt) ~= "string" or fmt:find("*t", 1, true) then
    return _os_date(fmt, t)
  end
  return _os_date(normalizeDateFormat(fmt, t or _os_time()), t)
end
-- Guest timing must be wall-clock based as well: the host clock() measures CPU time on
-- Linux/Android, so any guest timing loop (MineOS' boot splash) stalled while it waited.
_G.os.clock = function() return computer.uptime() end
_G.os.difftime = function(t2, t1) return t2 - t1 end
_G.os.execute = function(cmd)
  if not cmd then return true end
  return _os_execute(cmd)
end
_G.os.exit = function(code) _os_exit(code or 0) end
-- Real OC sandboxes do not expose os.getenv; stay consistent (Fuchas checks this)
_G.os.getenv = nil
_G.os.remove = function(path) return vfsRemove(path) end
_G.os.rename = function(from, to) return vfsRename(from, to) end
_G.os.tmpname = function() return "/tmp/tmp" .. math.random(100000, 999999) end

-- event library
local event = {}
local eventHandlers = {}
event.addHandler = function(cb, name) table.insert(eventHandlers, { callback = cb, name = name }); return #eventHandlers end
event.removeHandler = function(id) eventHandlers[id] = nil end
event.pull = function(...)
  local timeout, name = nil, nil
  local args = { ... }
  if type(args[1]) == "number" then timeout = args[1]; table.remove(args, 1) end
  if type(args[1]) == "string" then name = args[1] end
  while true do
    local ev = table.pack(computer.pullSignal(timeout))
    if ev.n == 0 or not ev[1] then return nil end
    if not name or ev[1] == name then return table.unpack(ev) end
  end
end
event.sleep = function(t) computer.pullSignal(t or 0) end
event.listen = function(name, cb) table.insert(eventHandlers, { callback = cb, name = name }) end
event.ignore = function(name, cb)
  for i, h in ipairs(eventHandlers) do
    if h.name == name and h.callback == cb then table.remove(eventHandlers, i); break end
  end
end
_G.event = event

-- loadfile / dofile use virtual paths
function _G.loadfile(path, ...)
  local content = vfsRead(path)
  if not content then return nil, "file not found: " .. path end
  -- loadstring on 5.1, load on 5.2+
  if loadstring then
    return loadstring(content, "=" .. path)
  else
    return load(content, "=" .. path, ...)
  end
end
function _G.dofile(path, ...)
  local chunk, err = _G.loadfile(path, ...)
  if chunk then return chunk() end
  error(err)
end

-- ============================================================
-- require: load modules from the virtual filesystem
-- ============================================================
-- Keep the original package path/config/cpath/loaders fields
-- (OpenOS /lib/package.lua needs them)
local _orig_package = package
_G.package = {
  loaded = {},
  loading = {},
  preload = {},
  path = _orig_package.path or "",
  cpath = _orig_package.cpath or "",
  config = _orig_package.config or "/\n;\n?\n!\n-\n",
  loaders = _orig_package.loaders or {},
  searchers = _orig_package.searchers or {},
  loadlib = _orig_package.loadlib or function() end,
  seeall = _orig_package.seeall or function(t) end,
}

-- Preload core modules
_G.package.loaded.component = component
_G.package.loaded.computer = computer
_G.package.loaded.unicode = unicode
_G.package.loaded.keyboard = keyboard
_G.package.loaded.colors = colors
_G.package.loaded.sides = sides
_G.package.loaded.text = text
_G.package.loaded.serialization = serialization
_G.package.loaded.bit32 = bit32
_G.package.loaded.event = event
_G.package.loaded.data = data
_G.package.loaded.internet = internet
if modsAddr then _G.package.loaded.mods = mods end
_G.package.loaded.filesystem = {
  proxy = function(addr) return component.proxy(addr) end,
  mount = function() end,
  get = function() return filesystem end,
  exists = function(p) return vfsExists(p) end,
  isDirectory = function(p) return vfsIsDirectory(p) end,
  list = function(p) return vfsList(p) end,
  size = function(p) return vfsSize(p) end,
  open = function(p, m) return filesystem.open(p, m) end,
}

function _G.require(name)
  if _G.package.loaded[name] then return _G.package.loaded[name] end
  if _G.package.loading[name] then error("loop loading " .. name) end
  _G.package.loading[name] = true
  -- try /lib/name.lua
  local path = "/lib/" .. name .. ".lua"
  local content = vfsRead(path)
  if not content then
    -- try /lib/name/init.lua
    path = "/lib/" .. name .. "/init.lua"
    content = vfsRead(path)
  end
  if not content then
    _G.package.loading[name] = nil
    error("module not found: " .. name)
  end
  local chunk
  if loadstring then
    chunk = loadstring(content, "=" .. path)
    if chunk and setfenv then setfenv(chunk, _G) end
  else
    chunk = load(content, "=" .. path, "t", _G)
  end
  local result = chunk()
  _G.package.loaded[name] = result ~= nil and result or true
  _G.package.loading[name] = nil
  return _G.package.loaded[name]
end

-- ============================================================
-- Screen error display helper (must exist before disk loading, which may fail)
-- ============================================================
local function _showScreenMessage(msg)
  pcall(function()
    gpu.bind(screenAddr)
    local w = Screen.width
    local h = Screen.height
    gpu.fill(1, 1, w, h, " ")
    local lines = {}
    for line in msg:gmatch("[^\n]+") do
      table.insert(lines, line)
    end
    local startY = math.max(1, math.floor((h - #lines) / 2))
    for i, line in ipairs(lines) do
      local x = math.max(1, math.floor((w - #line) / 2) + 1)
      gpu.set(x, startY + i - 1, line)
    end
  end)
end
showScreenMessage = _showScreenMessage

-- ============================================================
-- Load disks
-- ============================================================
if projectPath then
  -- Project mode: use the project folder directly, no disk image
  _stderr:write("[emulator] using project folder: " .. projectPath .. "\n")
elseif config.diskFile then
  dlog("loading disk:", config.diskFile)
  _stderr:write("[emulator] loading disk: " .. config.diskFile .. "\n")
  local diskLoaded = loadDisk(config.diskFile)
  if not diskLoaded then
    dlog("ERROR: disk not found")
    _stderr:write("[emulator] ERROR: disk not found: " .. config.diskFile .. "\n")
    _stderr:write("[emulator] Please create a disk image using the launcher GUI.\n")
    _showScreenMessage("No bootable disk found\nPlease insert a disk and restart")
    os.exit(1)
  end
  dlog("disk loaded:", vdisk.label, "files:", #vdisk.files)
  _stderr:write("[emulator] disk loaded: " .. vdisk.label .. " (" .. vdisk.size / 1024 .. " KB)\n")
else
  _stderr:write("[emulator] disk1: none (empty)\n")
end

-- Detect the OS type (logging only)
dlog("/init.lua exists:", vfsExists("/init.lua"))
dlog("/OS.lua exists:", vfsExists("/OS.lua"))
if vfsExists("/init.lua") then
  _stderr:write("[emulator] detected: OpenOS (/init.lua)\n")
elseif vfsExists("/OS.lua") then
  _stderr:write("[emulator] detected: MineOS (/OS.lua)\n")
end

-- ============================================================
-- Boot: run the EEPROM (BIOS)
-- ============================================================
-- Boot order: pick the first bootable device from bootOrder
-- ============================================================
local function isBootable(fsProxy)
  -- Any accessible filesystem counts as potentially bootable
  -- The EEPROM/BIOS decides; the emulator does not hardcode file names
  -- so any OS works (OpenOS, MineOS, ...)
  if not fsProxy then return false end
  if fsProxy.exists and fsProxy.open and fsProxy.list then
    return true
  end
  return false
end

local function resolveBootAddress()
  -- Read the boot order
  local order = config.bootOrder
  if not order or type(order) ~= "table" or #order == 0 then
    order = { "disk1", "disk2", "floppy" }
  end
  -- Device address map
  local deviceMap = {
    disk1 = fsAddr,
    disk2 = fs2Addr,
    floppy = floppyAddr,
  }
  -- Device filesystem proxy map
  local fsMap = {
    disk1 = filesystem,
    disk2 = fs2,
    floppy = floppy,
  }
  -- Find the first bootable device
  for _, dev in ipairs(order) do
    local addr = deviceMap[dev]
    local proxy = fsMap[dev]
    if addr and proxy and isBootable(proxy) then
      dlog("boot address resolved from bootOrder:", dev, addr:sub(1, 8))
      return addr
    end
  end
  -- Nothing bootable: show an error and exit
  dlog("no bootable device found")
  _stderr:write("[emulator] no bootable device found\n")
  showScreenMessage("No bootable device found\nNo filesystem available (check disk/floppy)")
  os.exit(1)
end

gpu.bind(screenAddr)
-- Set the boot address so the BIOS loads its boot script from that disk
local bootAddr = resolveBootAddress()
eepromData = bootAddr
computer._bootAddr = bootAddr
computer._runlevel = 1

-- Run the EEPROM code (built-in OC BIOS or custom)
local bootCode = eepromCode
local bootPath = "eeprom"
dlog("booting EEPROM, size:", #bootCode)
_stderr:write("[emulator] booting EEPROM (" .. eepromLabel .. ", " .. #bootCode .. " bytes)\n")
_stderr:write("[emulator] boot address: " .. bootAddr:sub(1, 8) .. "\n")
-- support Lua 5.1 (loadstring) and 5.2+ (load)
local loadfunc = loadstring or load
local chunk, err = loadfunc(bootCode, "=" .. bootPath)
if not chunk then
  dlog("load error:", err)
  _stderr:write("[emulator] load error: " .. tostring(err) .. "\n")
  showScreenMessage("EEPROM load error\n" .. tostring(err))
  _os_exit(1)
end

-- Lua 5.1 compatibility: setfenv
if setfenv then setfenv(chunk, _G) end

local ok, err = xpcall(chunk, function(e) return debug.traceback(e) end)
if not ok then
  _stderr:write("[emulator] runtime error:\n" .. tostring(err) .. "\n")
  if modsAddr and mods.reportError then mods.reportError(tostring(err)) end
  showScreenMessage("Runtime error\n" .. tostring(err))
  diskPersist.saveNow()
  _os_exit(1)
end

diskPersist.saveNow()

-- With a temporary VM disk, try to write changes back to the VM files
if vmTempDisk and hostArg[1] and hostArg[1]:match("%.ocvm$") then
  local f = _io_open(vmTempDisk, "rb")
  if f then
    local diskData = f:read("*a")
    f:close()
    _os_remove(vmTempDisk)
    local vmCfg = vm.load(hostArg[1])
    if vmCfg then
      vm.save(hostArg[1], vmCfg, diskData)
      _stderr:write("[emulator] VM disk saved back to " .. hostArg[1] .. "\n")
    end
  end
end
