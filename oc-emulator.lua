-- ============================================================
-- OpenComputers 模拟器 (OC Emulator) v2.0
-- 模拟 OC 模组电脑环境 (Web 控制面板版)
--
-- 用法: lua oc-emulator.lua --vm <vm_dir> --json-io
-- I/O: stdin/stdout JSON lines (与 server.js 通信)
-- ============================================================

-- ============================================================
-- 项目署名
--   源码提供: DeepSeek , Trea
--   校验与测试: zip132sy , DeepSeek
--   本项目免费且开源!
--
-- 不能删除, 删除后崩溃。
--   署名文本存放在 ATTRIBUTION.text 中, 由 ocCheckAttribution() 在启动、
--   消息收发、事件轮询等多个环节校验。校验依据是署名文本的指纹, 因此整体
--   替换署名声同样会被发现。署名文本、指纹函数、校验函数或任意一处调用被
--   删除或改写, 都会立即中断运行。
-- ============================================================
local ATTRIBUTION = {
  text = "源码提供: DeepSeek , Trea\n校验与测试: zip132sy , DeepSeek\n本项目免费且开源!",
  seal = "OC-EMULATOR-ATTRIBUTION",
  stderr = io.stderr,
}

-- 署名文本指纹 (131 进制滚动哈希, 取模 1000000007)
local function attrFingerprint(s)
  local h = 7
  for i = 1, #s do h = (h * 131 + s:byte(i)) % 1000000007 end
  return h
end

local function ocCheckAttribution(where)
  local ok = type(ATTRIBUTION) == "table"
    and ATTRIBUTION.seal == "OC-EMULATOR-ATTRIBUTION"
    and type(ATTRIBUTION.text) == "string"
    and attrFingerprint(ATTRIBUTION.text) == 219526294
  if not ok then
    local msg = "[OC Emulator] 项目署名被删除或修改 (" .. tostring(where) ..
      ")。本项目免费且开源, 请保留源码署名。"
    if type(ATTRIBUTION) == "table" and ATTRIBUTION.stderr then
      ATTRIBUTION.stderr:write(msg .. "\n")
    end
    error(msg, 0)
  end
  return true
end

ocCheckAttribution("startup")

-- 调试日志 (写到 stderr, 不干扰 stdout JSON)
-- 保存原始 io 引用: OpenOS 加载 /lib/io.lua 后会覆盖 _G.io
local _stderr = io.stderr
local _stdout = io.stdout
local _stdin = io.stdin
local _io_read = io.read       -- 保存原始 io.read
local _io_open = io.open       -- 保存原始 io.open
local _io_popen = io.popen     -- 保存原始 io.popen
local _io_lines = io.lines      -- 保存原始 io.lines
local _io_tmpfile = io.tmpfile  -- 保存原始 io.tmpfile
-- 保存原始 os 函数: OpenOS 加载后会覆盖 _G.os
local _os_tmpname = os.tmpname
local _os_remove = os.remove
local _os_execute_raw = os.execute
local _os_clock = os.clock       -- 保存原始 os.clock (渲染帧率控制用)
_stderr:setvbuf("no")

-- Lua 5.1 兼容: string.format("%s", table) 不会自动 tostring
-- OpenOS (Lua 5.2+) 依赖此行为, 这里 patch 一下
local _orig_string_format = string.format
string.format = function(fmt, ...)
  local args = { ... }
  -- 对 %s 对应的参数, 如果不是字符串, 用 tostring 转换
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

-- Lua 5.2+ 兼容: table.pack / table.unpack
if not table.pack then
  table.pack = function(...) return { n = select("#", ...), ... } end
end
if not table.unpack then
  table.unpack = unpack  -- Lua 5.1 的全局 unpack
end
local dbg = nil  -- 调试日志当前关闭

-- 日志级别: "error" = 仅错误 (默认), "full" = 常规信息, "off" = 全部关闭
-- 注意: 高频调试日志 (component.invoke / filesystem / pullSignal) 由 verboseLog
--   单独控制, 默认关闭。这些日志处在最热路径上 (每次绘图 / 每次文件访问 /
--   每次空闲轮询都会触发), 开启后每秒会产生上百行 stderr 输出, 而 server 会
--   同步转发到控制台和浏览器。这会占满 Node 单线程事件循环, 使 VM 协议往返
--   (pull_signal <-> tick) 被拖慢, 表现为系统启动十几秒后开始严重卡顿。
--   需要排查问题时再用 --log-level verbose 或 --verbose 临时开启。
local logLevel = "error"

-- 高频调试日志开关 (仅 verbose 模式下为 true)
local verboseLog = false

-- 保存原始目录分隔符 (在 _G.package 被沙箱替换前)
local DIR_SEP = package.config:sub(1, 1)
local function dlog(...)
  -- 高频调试日志: 默认关闭
  if not verboseLog then return end
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
  _stderr:write("[dlog] " .. table.concat(parts, "\t") .. "\n")
end

-- 输出错误日志到 stderr (仅 error 和 full 级别输出)
local function elog(msg)
  if logLevel == "off" then return end
  _stderr:write("[emulator] " .. msg .. "\n")
end

-- 常规信息日志 (仅 full 级别输出): 渲染帧、输入事件等排查用信息
local function ilog(msg)
  if logLevel ~= "full" then return end
  _stderr:write("[emulator] " .. msg .. "\n")
end

-- Lua 5.5 移除了 bit32
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

-- Lua 5.1 兼容: table.pack / table.unpack
if not table.pack then
  table.pack = function(...)
    return { n = select("#", ...), ... }
  end
end
if not table.unpack then table.unpack = unpack end

-- Lua 5.1 兼容: load() 接受字符串
-- 在 Lua 5.3+ 中 load() 可直接接受字符串, 但 5.1 中只接受函数
-- 这里做一层 polyfill: 如果传入字符串, 使用 loadstring (Lua 5.1)
if loadstring then
  local _orig_load = load
  load = function(chunk, chunkname, mode, env)
    local t = type(chunk)
    if t == "string" or t == "number" then
      -- Lua 5.1: loadstring(s, name) (无 mode/env 参数)
      local fn, err = loadstring(chunk, chunkname)
      return fn
    elseif t == "function" then
      -- 函数 loader: 调用原生 load (5.1 中是有的)
      if _orig_load then return _orig_load(chunk, chunkname) end
      -- 完全没有 load (5.1 标准库本身有,但实现不同)
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
-- JSON 库 (内嵌版, UTF-8 完整支持, 可重入)
-- ============================================================
local json = {}

-- null 占位符 (解码时用, encode 中 nil 和 json.null 都输出 null)
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
      -- 多字节 UTF-8 字符: 只有当后续字节都是合法续接字节 (0x80-0xBF) 时才原样保留,
      -- 否则按 Latin-1 单字节转义为 \u00XX。
      -- 原因: Node 端用 data.toString('utf8') 读取 stdout, 非法 UTF-8 字节会被替换成
      -- U+FFFD, 从而损坏二进制数据 (例如通过网络挂载读取 .pic 图片时数据被破坏,
      -- 客户机的图片解析器就会卡死/报错)。转义后的 \u00XX 在接收端会还原成同一个
      -- 字节, 因此二进制内容可以逐字节无损地穿过 Lua -> Node -> Lua。
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
  if count == 0 then return false end  -- 空表 → 对象
  -- 允许空洞: 例如 modem 响应 (nil, "invalid handle") 会让 payload 表在第 4 位出现 nil。
  -- 判据取「键都是正整数即按数组编码」, 空洞位置补 null; 稀疏上限防止极端稀疏表生成巨大数组。
  -- 若改用 max == count 判定, 这类表会被当成对象编码成 {"1":..,"5":..}; Node 端展开对象
  -- 会失败 → 消息无法路由 → 客户端 request 死循环 → 虚拟机卡住。
  return max <= count + 64
end

local jsonEncodeVal  -- 前向声明

local function encodeTable(t)
  if isArray(t) then
    local max = 0
    for k in pairs(t) do
      if k > max then max = k end
    end
    if max == 0 then return "[]" end
    local parts = {}
    for i = 1, max do parts[i] = jsonEncodeVal(t[i]) end  -- 空洞 → "null"
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
local jsonEncode = jsonEncodeVal  -- 向后兼容别名

-- ---------- 解码 ----------

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
        -- 高代理 → 期待低代理
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
          -- Latin-1 范围 (0-255): 使用 string.char 保持单字节, 避免二进制数据损坏
          -- 服务器将 byte 128-255 编码为 \u00XX, 这里需要还原为单字节
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

local decodeValue  -- 前向声明

local function decodeObject(s, p, len)
  p = p + 1  -- 跳过 {
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
  p = p + 1  -- 跳过 [
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
  -- 检查尾部内容
  p = skipWs(s, p, len)
  if p <= len then return nil, "trailing content at " .. p end
  return val
end
json.decode = jsonDecode

-- ============================================================
-- stdin/stdout JSON Lines 通信层
-- ============================================================
-- stdout 无缓冲: 每条消息立即 flush
_stdout:setvbuf("no")
-- 发送消息到 server (写到 stdout)
local function sendToServer(msg)
  ocCheckAttribution("sendToServer")
  _stdout:write(jsonEncode(msg) .. "\n")
end

-- 异步网络请求: 回调表 + 自增 ID
local pendingNetCallbacks = {}
local pendingNetId = 0

-- 读取 stdin 一行 (阻塞, 不带超时)
local function readStdinLine()
  local line = _io_read("*l")
  return line
end

-- ============================================================
-- 命令行参数解析: --vm <dir> --json-io
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

-- 将 EMU_DIR 加入 package.path
package.path = EMU_DIR .. "?.lua;" .. package.path

-- 加载模块
local disk = require("disk")
-- Mods: 机器人 / 无人机 / 单片机 统一组件
local mods = require("mods")
-- 使用服务端墙钟作为 Mods 的时间源 (收到 tick 时更新)
mods.setClock(function()
  local ms = tonumber(mods._wallMs) or 0
  if ms > 0 then return ms / 1000 end
  return os.clock()
end)

-- ============================================================
-- 从 VM 目录加载 config.json
-- ============================================================
local function loadVMConfig(vmDir)
  local cfgPath = vmDir .. "/config.json"
  local f = _io_open(cfgPath, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()

  -- 极简 JSON 解码
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

-- 从 vmConfig 构建 config 表
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
  ramSize = memTierToSize(memSizes[1] or 3) + memTierToSize(memSizes[2] or 3),
  screenWidth = screenTier == 1 and 50 or screenTier == 2 and 80 or 160,
  screenHeight = screenTier == 1 and 16 or screenTier == 2 and 25 or 50,
  gpuTier = apuTierToGpuTier(apuTier),
  screenTier = screenTier,
  hddSize = 4096 * 1024,
  -- 磁盘路径 (相对于 vmDir)
  disk1File = hw.disk1 and hw.disk1 ~= "empty" and (vmDir .. "/" .. hw.disk1) or nil,
  disk2File = hw.disk2 and hw.disk2 ~= "empty" and (vmDir .. "/" .. hw.disk2) or nil,
  floppyFile = hw.floppy and hw.floppy ~= "empty" and (vmDir .. "/" .. hw.floppy) or nil,
  eepromFile = (hw.eeprom and hw.eeprom ~= "built-in") and (vmDir .. "/" .. hw.eeprom) or nil,
  -- 启动顺序
  bootOrder = hw.bootOrder,
  -- 扩展卡
  expansion = hw.expansion or {nil, nil, nil},
  -- Mods 统一组件 (机器人 / 无人机 / 单片机), 默认启用
  modsEnabled = hw.mods ~= false,
  -- Mods 设备模式: 由控制面板创建, 使用内置 EFI 启动并上报状态
  modsDevice = vmConfig.modsDevice == true,
  modsName = hw.modsName,
  modsType = hw.modsType,
  -- Mods 设备专属配置 (机器人: 主手 / 副手工具等, 无人机: 速度等)
  robotProfile = hw.robot,
  droneProfile = hw.drone,
  -- APU
  apuTier = apuTier,
  useAPU = true,
}

-- 磁盘文件路径 (disk1 为 empty 时不加载磁盘，允许纯软盘启动)
config.diskFile = config.disk1File  -- 可能为 nil (当 disk1="empty" 时)
config.disk2File = config.disk2File  -- 可能为 nil
config.floppyFile = config.floppyFile  -- 可能为 nil

_stderr:write("[emulator] VM: " .. (vmConfig.name or "unnamed") .. "\n")
_stderr:write("[emulator] APU tier: " .. tostring(apuTier) .. "\n")
_stderr:write("[emulator] RAM: " .. config.ramSize .. " bytes\n")
_stderr:write("[emulator] Screen: " .. config.screenWidth .. "x" .. config.screenHeight .. " (tier " .. screenTier .. ")\n")
_stderr:write("[emulator] Disk1: " .. (config.disk1File or "none") .. "\n")
_stderr:write("[emulator] Disk2: " .. (config.disk2File or "none") .. "\n")
_stderr:write("[emulator] Floppy: " .. (config.floppyFile or "none") .. "\n")
_stderr:write("[emulator] EEPROM: " .. (config.eepromFile or "built-in") .. "\n")

-- 应用 Mods 设备元数据
if config.modsName then mods.setName(config.modsName) end
if config.modsType then mods.setDeviceType(config.modsType) end

-- 应用设备专属配置 (机器人主手 / 副手工具、无人机速度等)
if config.robotProfile then mods.setProfile(config.robotProfile) end
if config.droneProfile then mods.setProfile(config.droneProfile) end

-- Mods 设备的 EFI 通过这两个全局向服务端上报状态 / 读取墙钟
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

-- 发送状态: running
sendToServer({ type = "state", state = "running" })

-- ============================================================
-- 工具
-- ============================================================
local function genAddr()
  local hex = "0123456789abcdef"
  local t = {}
  for i = 1, 36 do
    if i == 9 or i == 14 or i == 19 or i == 24 then
      t[i] = "-"
    else
      -- 取"单个"十六进制字符: 必须 sub(p, p)。
      -- 若起止下标各自随机 (如 hex:sub(math.random(1,16), math.random(1,16))),
      -- 经常一次取出好几个字符, 地址长度飘忽不定、格式不像 UUID。
      local p = math.random(1, 16)
      t[i] = hex:sub(p, p)
    end
  end
  return table.concat(t)
end

-- 随机数种子。
-- 不播种时, 每个 Lua 进程都从同一个默认种子开始, 于是每台虚拟机生成的组件地址
-- 完全一样 (实测两次启动的 modem 地址逐字节相同)。地址撞车会让 server 端的
-- "地址 -> 虚拟机" 表被覆盖, 另一台虚拟机永远收不到消息 —— 网络互通必然失败。
-- 混合三种熵: 时间 + CPU 时钟 + 一个堆对象地址; 另外 server 会通过环境变量
-- OC_VM_SEED 传入每台 VM 唯一的种子, 保证同时启动的多台虚拟机地址也必然不同。
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
  -- 丢弃几个数, 避免相邻种子产生高度相似的序列
  for _ = 1, 5 do math.random() end
end

-- 尝试加载 LuaFileSystem。lfs 是独立 C 模块, 标准 Lua 安装通常不带,
-- 因此必须提供不依赖 lfs 的 shell 回退; 否则 Linux/macOS 会退化成
-- Windows 的 dir / if exist 命令而直接失效 (目录无法识别、列表为空)。
local lfs = nil
pcall(function() lfs = require("lfs") end)

-- 平台判断: package.config 的第一个字符是目录分隔符 ('\' = Windows, '/' = POSIX)
local PLATFORM_IS_WINDOWS = (DIR_SEP == "\\")
-- 屏蔽输出的写法 (Windows 用 nul, POSIX 用 /dev/null)
local SHELL_SILENCE = PLATFORM_IS_WINDOWS and " 2>nul" or " 2>/dev/null"

-- 目录列表回退 (lfs 不可用时)
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

-- 目录判断回退 (lfs 不可用时)
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
  -- Windows: 不能以文件方式打开 → 可能是目录
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

-- 统一的目录列表接口
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

-- 统一的目录判断接口
local function fsIsDir(path)
  if lfs then
    local attr = lfs.attributes(path)
    return attr and attr.mode == "directory"
  end
  return shellIsDir(path)
end

-- 创建目录 (lfs 不可用时)。POSIX 用 mkdir -p 以便顺带创建父目录。
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
-- 虚拟磁盘镜像 (使用 disk.lua 模块的 .ocd 格式)
-- ============================================================
local vdisk = { files = {}, label = "OpenOS", modified = 0, size = 4 * 1024 * 1024, tier = 3 }

-- 保存磁盘到文件 (使用 .ocd 格式)
local function saveDisk(path)
  if projectPath then return true end  -- 项目模式不保存磁盘
  local size = vdisk.size or config.hddSize or (4 * 1024 * 1024)
  local tier = vdisk.tier or 3
  -- 用磁盘自身记录的 size/tier 写回。若固定用 config.hddSize, 会把小容量磁盘
  -- 撑成 4MB, 且 tier 恒为 3, 与磁盘实际声明不符。
  local ok, err = disk.save(path, vdisk.label, vdisk.files, size, tier, false)
  if not ok then
    -- 兜底: 若磁盘声明的 tier 小于其实际容量 (手工制作的镜像可能出现),
    -- 抬高 tier 再试一次, 保证安装/写入不会因为容量校验被静默丢弃。
    local limits = disk.TIER_LIMITS or { [1] = 1048576, [2] = 2097152, [3] = 4194304 }
    local needTier = 3
    if size <= (limits[1] or 1048576) then needTier = 1
    elseif size <= (limits[2] or 2097152) then needTier = 2 end
    if needTier > tier then
      ok, err = disk.save(path, vdisk.label, vdisk.files, size, needTier, false)
    end
  end
  if not ok then
    _stderr:write("[emulator] WARNING: save disk1 failed: " .. tostring(err) .. "\n")
  end
  return ok, err
end

-- 前向声明: fs2/floppy/eeprom 的标签和文件表, 后面才真正赋值
-- (saveAllDisks 在前面定义, 需要引用这些变量)
local fs2Files, fs2Label, fs2Size, fs2Tier, floppyFiles, floppyLabel, floppyLocked
local eepromData, eepromLabel, eepromCode

-- 保存所有磁盘 + EEPROM (在 shutdown / 异常退出时调用)
local function saveAllDisks()
  if config.diskFile then
    saveDisk(config.diskFile)
  end
  -- disk2: 如果挂载了, 把 fs2 代理的标签/文件写回
  if config.disk2File and fs2Files and fs2Label then
    local ok, err = pcall(function()
      local size2 = fs2Size or (4 * 1024 * 1024)
      local tier2 = fs2Tier or 3
      local ok2, err2 = disk.save(config.disk2File, fs2Label, fs2Files, size2, tier2, false)
      if not ok2 then
        -- 同 disk1: tier 与容量不符时抬高 tier 再试, 避免写入被静默丢弃
        local limits = disk.TIER_LIMITS or { [1] = 1048576, [2] = 2097152, [3] = 4194304 }
        local needTier = 3
        if size2 <= (limits[1] or 1048576) then needTier = 1
        elseif size2 <= (limits[2] or 2097152) then needTier = 2 end
        if needTier > tier2 then
          ok2, err2 = disk.save(config.disk2File, fs2Label, fs2Files, size2, needTier, false)
        end
      end
      if not ok2 then error(err2 or "disk2 save failed") end
    end)
    if not ok then _stderr:write("[emulator] WARNING: save disk2 failed: " .. tostring(err) .. "\n") end
  end
  -- floppy: 同样写回 (使用 .ocf 软盘格式)
  if config.floppyFile and floppyFiles and floppyLabel then
    local ok, err = pcall(function()
      disk.saveFloppy(config.floppyFile, floppyLabel, floppyFiles, 512 * 1024, floppyLocked)
    end)
    if not ok then _stderr:write("[emulator] WARNING: save floppy failed: " .. tostring(err) .. "\n") end
  end
  -- EEPROM 不参与关机写回: eeprom.set() 会立即持久化, 关机时再写回内存副本
  -- 会覆盖控制面板刚保存的 EFI。
end

-- ============================================================
-- 磁盘自动落盘 (write-through)
-- 任何磁盘写入都打脏标记, 之后周期性(默认 1 秒)把磁盘写回文件,
-- 并在收到 shutdown / flush 命令时立即落盘。
-- 若只在"正常关机"(computer.shutdown / 进程跑到结尾)时才写回文件, VM 在安装过程中
-- 被强制结束(用户在界面上点停止 -> 3 秒超时 SIGTERM, 或服务被关闭)就会丢掉内存里的
-- 安装结果, 下次启动又从头装一遍。
-- ============================================================
local diskPersist = { dirty = false, lastFlush = 0, interval = 1 }

function diskPersist.mark()
  diskPersist.dirty = true
end

function diskPersist.flush(force)
  if not diskPersist.dirty then return end
  local now = os.time()
  if not force and (now - diskPersist.lastFlush) < diskPersist.interval then return end
  diskPersist.lastFlush = now
  diskPersist.dirty = false
  local ok, err = pcall(saveAllDisks)
  if not ok then
    -- 落盘失败时保留脏标记, 下一轮再试 (避免静默丢数据)
    diskPersist.dirty = true
    _stderr:write("[emulator] WARNING: autosave disks failed: " .. tostring(err) .. "\n")
  end
end

-- 从文件加载磁盘 (支持 .ocd 和旧 .img 格式)
local function loadDisk(path)
  -- 先尝试 .ocd 格式
  local loaded = disk.load(path)
  if loaded then
    vdisk.label = loaded.label or "Untitled"
    vdisk.files = loaded.files or {}
    vdisk.size = loaded.size or config.hddSize
    vdisk.tier = loaded.tier or 3
    return true
  end
  -- 回退到旧格式 (Lua table)
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

-- 虚拟文件系统操作
local function vfsNormalize(p)
  p = normalizePath(p)
  -- 解析 .. 和 .
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
  -- 显式条目
  if vdisk.files[path] ~= nil then return true end
  -- 隐式目录: 存在以 path/ 开头的子条目
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
  -- 隐式目录: 如果存在以 path/ 开头的子条目, 则视为目录
  local prefix = path .. "/"
  for p in pairs(vdisk.files) do
    if p:sub(1, #prefix) == prefix then
      return true
    end
  end
  -- 显式目录条目
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
  -- 收集直接子条目名称
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
  -- 判断每个子条目是文件还是目录
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
  -- 创建父目录
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
    -- 确保父目录存在
    local parentDir = realPath:match("^(.+)[/\\][^/\\]+$")
    if parentDir then
      fsMkdir(parentDir)
    end
    local f = _io_open(realPath, "wb")
    if f then f:write(content or ""); f:close(); return true end
    return false
  end
  -- 创建父目录
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
      -- POSIX: 一条 rm -rf 同时覆盖文件与目录
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

-- 打开的文件句柄（基于 vfs 的句柄）
local openHandles = {}
local handleCount = 0

-- ============================================================
-- 信号队列
-- ============================================================
local signalQueue = {}
local lastPollTime = 0  -- pullSignal(0) 节流, 避免疯狂轮询
-- 组件地址前向声明: 在 dispatchServerMessage/pushSignal 中使用,
-- 但实际定义在后面 (gpu/screen/keyboard 等组件注册处)
local gpuAddr = nil
local screenAddr = nil
local keyboardAddr = nil
local screen  -- 前向声明: screen 组件在后面定义, dispatchServerMessage/sendScreenUpdate 需要引用
local fsAddr = nil
local eepromAddr = nil
local modemAddr = nil
local function pushSignal(name, ...)
  table.insert(signalQueue, {name, ...})
  if name == "scroll" then
    ilog("pushSignal: scroll queueSize=" .. #signalQueue .. " x=" .. tostring(select(2, ...)) .. " y=" .. tostring(select(3, ...)) .. " delta=" .. tostring(select(4, ...)))
  end
end

-- 读取 stdin 一行 JSON 输入并解析 (用于 pullSignal 在 JSON 模式下)
-- 返回: 解析后的表, 或 nil (EOF/错误)
local function readJSONInput(timeout)
  ocCheckAttribution("readJSONInput")
  -- io.read("*l") 是阻塞的, 无超时控制
  -- server 端会在 timeout 到期后发 tick, 所以这里直接阻塞读
  local line = _io_read("*l")
  if not line or line == "" then return nil end
  -- 用内嵌 JSON 解码
  local ok, msg = pcall(jsonDecode, line)
  if not ok then
    dlog("readJSONInput: parse error:", msg, "line:", line:sub(1, 80))
    return nil
  end
  return msg
end

-- 暂停标志 (必须在 dispatchServerMessage 之前声明)
local vmPaused = false
-- 前向声明: componentRegistry, floppyAddr, computer 在后面才定义, 但 dispatchServerMessage 需要引用
local componentRegistry
local floppyAddr
local computer
-- 外部 RAM 统计 (由 server 推送的进程实际内存占用)
local _externalRamUsed = 0
local _externalRamTotal = 0

-- 把 server 的 JSON 消息转换为 OC 信号并加入队列
local function dispatchServerMessage(msg)
  ocCheckAttribution("dispatchServerMessage")
  if type(msg) ~= "table" then return end
  -- 服务端每 50ms~10s 会发 tick; 携带真实墙钟, 供 Mods 无人机运动与状态上报使用
  if msg.wall then
    mods._wallMs = tonumber(msg.wall) or mods._wallMs
  end
  local t = msg.type
  -- 外部设备: 列表与状态快照
  if t == "ext_devices" then
    if extComponents then extComponents.apply(msg.devices) end
    return
  end
  if t == "ext_state" then
    if extComponents then extComponents.update(msg.devices) end
    return
  end
  -- 把前端传来的 "OC 像素坐标" 换算成 OC 信号真正使用的坐标。
  --
  -- 关键点: OC 在精确模式 (setPrecise) 下返回的并不是像素值, 而是"0 基分数字符
  -- 坐标", 即像素除以 6 / 9。MineOS 的 GUI 就是用 math.ceil(e3) 把它换算回字符
  -- 格的 (见 Libraries/GUI.lua 的 isScreenEvent 分支)。若直接把像素值当坐标发过
  -- 去, 取整后仍然远大于屏幕格数, 命中判定必然失败 —— 表现就是点击与滚轮都没有
  -- 反应。非精确模式才是 1 基整数字符坐标。
  local function screenInputCoords(m)
    local px = tonumber(m.px)
    local py = tonumber(m.py)
    if screen and screen._precise and px and py then
      return (px - 1) / 6, (py - 1) / 9
    end
    return tonumber(m.x) or 1, tonumber(m.y) or 1
  end

  if t == "input" then
    -- 输入事件: { type:"input", event:"key_down", char:97, code:30 }
    local ev = msg.event
    dlog("dispatchServerMessage: input event:", tostring(ev), "char:", tostring(msg.char), "code:", tostring(msg.code))
    if ev == "key_down" or ev == "key_up" then
      local code = msg.code or 0
      -- 更新修饰键状态
      if code == 0x2A or code == 0x36 then  -- lshift, rshift
        keyboard._shift = (ev == "key_down")
      elseif code == 0x1D or code == 0x9D then  -- lcontrol, rcontrol
        keyboard._control = (ev == "key_down")
      elseif code == 0x38 or code == 0xB8 then  -- lalt, ralt
        keyboard._alt = (ev == "key_down")
      end
      -- OC key_down/up 信号格式: (address, char, code, player)
      -- 第4个参数 player 必须是字符串, 传数字会导致 OpenOS keyboard.lua 处理失败
      pushSignal(ev, keyboardAddr, msg.char or 0, code, "player")
    elseif ev == "touch" or ev == "drag" or ev == "drop" then
      -- OC 标准信号格式: touch/drag/drop(address, x, y, button, playerName)
      -- OC 中鼠标松开叫 "drop" (不是 "up")
      if not screen then return end  -- screen 组件尚未初始化时忽略
      local mx, my = screenInputCoords(msg)
      pushSignal(ev, screenAddr, mx, my, msg.btn or 0, "player")
    elseif ev == "scroll" then
      -- OC scroll 信号: scroll(address, x, y, direction, playerName)
      if not screen then
        ilog("INPUT: scroll ignored (screen not ready)")
        return
      end
      local sx, sy = tonumber(msg.x) or 1, tonumber(msg.y) or 1
      -- 滚轮只需要"光标落在哪个字符格", 不需要亚格精度; 而且不论精确模式是否
      -- 开启, 传整数格坐标都能被正确命中 (MineOS 用 math.ceil 换算回格)。
      -- 因此这里有意不走 screenInputCoords, 避免精确模式下的坐标空间差异
      -- 使命中判定失败。
      ilog("INPUT: scroll x=" .. tostring(sx) .. " y=" .. tostring(sy)
        .. " delta=" .. tostring(msg.delta or 1) .. " precise=" .. tostring(screen._precise))
      pushSignal("scroll", screenAddr, sx, sy, msg.delta or 1, "player")
    elseif ev == "clipboard" then
      pushSignal("clipboard", keyboardAddr, msg.text or "")
    end
  elseif t == "tick" then
    -- 心跳, 不入队 (用于唤醒 pullSignal)
    -- 顺便做一次磁盘自动落盘检查 (脏则写回, 带 1 秒节流)
    diskPersist.flush()
  elseif t == "ram_update" then
    -- RAM 使用同步: 更新外部观察到的进程内存占用
    -- computer.freeMemory() 会使用这个值来计算剩余内存
    if msg.used ~= nil then
      _externalRamUsed = tonumber(msg.used) or _externalRamUsed
    end
    if msg.total ~= nil then
      _externalRamTotal = tonumber(msg.total) or _externalRamTotal
    end
  elseif t == "battery" then
    -- 电量同步: 更新 computer.energy 和 computer.maxEnergy
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
      -- 软关机前先把磁盘写回: 即使 guest 迟迟不响应 shutdown 而被服务端
      -- 在 3 秒后强杀, 这次安装/写入也不会丢。
      diskPersist.flush(true)
      -- 软关机信号
      pushSignal("shutdown")
    elseif msg.cmd == "flush" then
      -- 显式落盘请求 (服务端在停止 VM 前会先发这条, 作为双保险)
      diskPersist.flush(true)
    elseif msg.cmd == "pause" then
      vmPaused = true
    elseif msg.cmd == "resume" then
      vmPaused = false
    elseif msg.cmd == "mod_command" then
      -- 控制面板 → Mods 设备 EFI 的本地命令
      pushSignal("mod_command", msg.data)
    elseif msg.cmd == "floppy_reload" then
      -- 重新加载软盘镜像 (热插拔)
      -- msg.data 可包含新的文件路径 (可选)
      local floppyPath = config.floppyFile
      if msg.data and msg.data.path then
        floppyPath = msg.data.path
        config.floppyFile = floppyPath
      end
      if floppyPath then
        local loadedF = disk.loadFloppy(floppyPath)
        if loadedF then
          -- 清空现有文件表
          for k in pairs(floppyFiles) do floppyFiles[k] = nil end
          -- 复制新内容
          for k, v in pairs(loadedF.files or {}) do floppyFiles[k] = v end
          -- 标记脏 + 立即落盘 (热插拔软盘后即便进程被强杀也不丢)
          diskPersist.mark()
          diskPersist.flush(true)
          -- 更新标签
          if loadedF.label then
            pcall(function() floppy.setLabel(loadedF.label) end)
          end
          -- 软盘组件尚未注册时, 在此注册
          if not componentRegistry[floppyAddr] then
            componentRegistry[floppyAddr] = { type = "filesystem", proxy = floppy }
            pushSignal("component_added", floppyAddr, "filesystem")
          else
            -- 发送组件变更信号
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
    -- 收到其他虚拟机的 modem 消息
    -- OC 官方信号签名: modem_message(receiverAddress, senderAddress, port, distance, ...payload)
    -- 必须按此顺序组装: 若把 data 表当成 distance 传、payload 又写死成 1,1,
    -- 客户机收到的消息体完全错位, 表现为"能收到信号但内容不对/收不到"。
    local unpackFn = table.unpack or unpack
    local payload = msg.data
    if type(payload) ~= "table" then payload = { payload } end
    local n = msg.n
    if not n then
      -- 用最大整数键作为长度: JSON 数组中的 null 在 Lua 表里会形成空洞, #payload 不可靠,
      -- 会把空洞之后的返回值截掉 (例如 ("network","response","read",null,"invalid handle")
      -- 里的 "invalid handle" 会被丢掉, 客户机拿到错误的返回值)。
      n = 0
      for k in pairs(payload) do
        if type(k) == "number" and k == math.floor(k) and k > n then n = k end
      end
    end
    pushSignal("modem_message", modemAddr, msg.from or "", msg.port or 0, msg.distance or 0, unpackFn(payload, 1, n))
  elseif t == "net_response" then
    -- 网络请求响应 (异步)
    -- 由 internet.request 处理回调
    local cb = pendingNetCallbacks[msg.reqId]
    if cb then
      pendingNetCallbacks[msg.reqId] = nil
      cb(msg)
    end
  end
end

-- flushRender 前向声明 (实现在屏幕渲染部分)
local flushRender

local function pullSignal(timeout)
  ocCheckAttribution("pullSignal")
  dlog("pullSignal called, timeout:", tostring(timeout), "queue:", #signalQueue)
  -- 先检查信号队列
  if #signalQueue > 0 then
    flushRender()
    local sig = table.remove(signalQueue, 1)
    dlog("pullSignal: from queue:", sig[1], "code:", tostring(sig[4]))
    if sig[1] == "scroll" then
      ilog("pullSignal: scroll x=" .. tostring(sig[3]) .. " y=" .. tostring(sig[4]) .. " delta=" .. tostring(sig[5]) .. " queueSize=" .. #signalQueue)
    end
    return table.unpack(sig)
  end

  -- timeout=0 表示非阻塞 (立即返回)
  -- 注意: JSON 模式下, 输入消息来自 stdin, 不读就收不到
  -- 所以即使 timeout=0 也需要尝试读一次 (通过 server 立即回 tick 实现"非阻塞")
  if type(timeout) ~= "number" then timeout = nil end
  if timeout and timeout <= 0 then
    if not jsonIO then
      flushRender()
      return nil
    end
    -- 节流: pullSignal(0) 轮询频率限制为 50Hz (20ms)
    -- 避免 MineOS 桌面空转时每秒上千次 stdin 往返, 消耗大量 CPU
    local now = os.clock()
    if now - lastPollTime < 0.02 then  -- 20ms = 50Hz
      return nil
    end
    lastPollTime = now
    -- JSON 模式: 发 pull_signal(0), server 会立即回 tick 或先回输入消息再 tick
    -- 这样既能读到新消息, 又不会长时间阻塞
    timeout = 0  -- 传 0ms, server 收到后立即回 tick
  end

  if jsonIO then
    -- JSON 模式: 通知 server 正在等待, 然后从 stdin 读
    -- timeout 单位: Lua 是秒, server 是毫秒 → * 1000
    -- nil / 极大值 / math.huge → 用 5000ms 作为心跳间隔
    local timeoutMs
    if not timeout or timeout == math.huge or timeout > 3600 then
      timeoutMs = 5000
    else
      timeoutMs = math.floor(timeout * 1000)
    end
    sendToServer({ type = "pull_signal", timeout = timeoutMs })
    -- 阻塞读 stdin 直到有信号或 EOF
    while true do
      -- 暂停模式: 阻塞直到收到 resume
      while vmPaused do
        local msg = readJSONInput(0)
        if not msg then
          flushRender()
          return nil
        end
        dispatchServerMessage(msg)
      end
      -- 在等待期间也可能有 server 主动推的消息, 需要先处理
      -- 阻塞前先刷新屏幕, 确保最新画面已经发送出去 (否则 GUI 渲染完后调用 pullSignal 等待时画面会卡住)
      flushRender(true) -- 强制刷新, 因为接下来要进入阻塞读
      local msg = readJSONInput(timeout)
      if not msg then
        -- stdin EOF, 退出
        flushRender()
        return nil
      end
      dispatchServerMessage(msg)
      -- 派发后可能有新信号
      if #signalQueue > 0 then
        flushRender()
        local sig = table.remove(signalQueue, 1)
        if sig[1] == "scroll" then
          ilog("pullSignal(loop): scroll x=" .. tostring(sig[3]) .. " y=" .. tostring(sig[4]) .. " delta=" .. tostring(sig[5]) .. " queueSize=" .. #signalQueue)
        end
        return table.unpack(sig)
      end
      -- 否则继续读 (server 会在 timeout 到期后发 tick, 触发返回 nil)
      -- tick = 心跳/超时, 无论 timeout 值都应返回 nil
      -- (timeout=nil 表示无限等待, 但 server 仍会周期性发 tick)
      if msg.type == "tick" then
        flushRender()
        return nil
      end
    end
  end

  -- 文件模式 (legacy): 仅在未启用 --json-io 时使用, 保留以兼容旧调用方式
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
                -- OC key_down 信号 char 应为 Unicode code point (数字)
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
local computer = {
  _address = genAddr(),
  _tmpAddr = nil,
  _bootAddr = nil,
  _energy = 100000,       -- 默认满电 (与 server 端 maxEnergy 一致, 100000 = 二级电池容量)
  _maxEnergy = 100000,   -- 默认 100000 EU (二级电池), 获取不到电量时保持 100%
  _totalMemory = config.ramSize,
  _runlevel = "S",
}
computer._startWall = socket and socket.gettime() or os.clock()
local showScreenMessage  -- 前向声明: 在后面定义, 供 computer.shutdown 等使用
function computer.address() return computer._address end
function computer.tmpAddress() return computer._tmpAddr end
function computer.freeMemory()
  -- 优先使用外部推送的进程实际内存占用 (更准确)
  -- 如果外部数据可用且有效, 则使用外部值
  -- 否则回退到 Lua GC 估算
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
function computer.uptime()
  if socket then return socket.gettime() - computer._startWall end
  return os.clock() - computer._startWall
end
function computer.shutdown(reboot)
  -- 保存所有磁盘 + EEPROM
  saveAllDisks()
  _stderr:write("[emulator] computer " .. (reboot and "reboot" or "shutdown") .. "\n")
  if reboot then
    showScreenMessage("Rebooting...")
  else
    showScreenMessage("System shut down.\nPress any key to restart.")
  end
  os.exit(reboot and 2 or 0)
end
function computer.getBootAddress() return computer._bootAddr end
function computer.setBootAddress(addr) dlog("setBootAddress:", tostring(addr):sub(1,8)); computer._bootAddr = addr end
function computer.runlevel() return computer._runlevel end
-- CPU 架构: 模拟器只提供 Lua 5.3 一种。
-- MineOS 的"设置 → 系统"用 getArchitectures() 列出可选架构、用 getArchitecture()
-- 高亮当前架构, 缺失时该模块会以 "attempt to call a nil value" 报错。
local ARCHITECTURE_NAME = "Lua 5.3"
function computer.getArchitectures() return { ARCHITECTURE_NAME } end
function computer.getArchitecture() return ARCHITECTURE_NAME end
function computer.setArchitecture(arch) return arch == ARCHITECTURE_NAME end
function computer.users() return "admin" end
function computer.addUser() return true end
function computer.removeUser() return true end
function computer.pushSignal(name, ...) pushSignal(name, ...) end
-- 信号转发辅助: 必须原样转发全部返回值。
-- computer.pullSignal 若固定只取 8 个返回值 (e1..e8), 而 modem_message 信号是
--   name, 接收方地址, 发送方地址, 端口, 距离, payload[1], payload[2], payload[3], payload[4]...
-- 第 9 个及之后的值会被截断。MineOS 的网络层正是发 ("network","response",方法,数据),
-- 于是数据永远落在第 9 位被丢掉, 客户端拿到 nil 后调用 text.deserialize(nil) 崩溃
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

-- 网卡单包最大字节数 (真实 OC 的 modem.maxPacketSize() / DeviceInfo.capacity 默认值)。
-- MineOS / PixelOS 的网络层 (Libraries/Network.lua) 用它给大消息分片:
--   可通过 modem.maxPacketSize() 或 computer.getDeviceInfo()[addr].capacity 获取。
-- 两者都缺失时分片长度会算成 nil, 于是 FTP 目录列表之类的大响应发不回去,
-- 客户端最终报 "Text.lua:98: bad argument #1 (string expected, got nil)"。
local MODEM_MAX_PACKET_SIZE = 8192

function computer.getDeviceInfo()
  local result = { [computer._address] = { description = "OC Emulator", product = "Emulator" } }
  -- 真实 OC 还会为每个组件返回一条信息 (含 modem 的 capacity)
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
}
for y = 1, Screen.height do
  Screen.bg[y] = {}; Screen.fg[y] = {}; Screen.char[y] = {}
  for x = 1, Screen.width do
    Screen.bg[y][x] = 0x000000; Screen.fg[y][x] = 0xFFFFFF; Screen.char[y][x] = " "
  end
end

-- JSON 模式: 跟踪脏单元格, 发送增量/全屏更新
local dirtyMap = {}     -- 键: y*1000 + x, 值: true  (去重用)
local dirtyCount = 0
local screenInitialized = false
local renderScheduled = false  -- 是否有待发送的脏区
local _lastFlushTime = 0       -- 上次刷新时间 (os.clock 秒)
local _minFrameInterval = 1/20 -- 最小帧间隔 (秒), 约 20fps (终端界面足够流畅)

local function sendScreenUpdate()
  if not jsonIO then
    -- 文件模式 (legacy): 写 screen.dat
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

  -- JSON 模式
  if not screenInitialized then
    -- 发送全屏
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
    -- 收集所有脏单元格
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

-- 分辨率变化时重置
local function onResolutionChange()
  screenInitialized = false
  dirtyMap = {}
  dirtyCount = 0
  renderScheduled = false
end

local function scheduleRender()
  renderScheduled = true
  -- 时间阈值: 如果距离上次刷新超过最小帧间隔 (约60fps), 立即刷新
  -- 防止长时间没有 pullSignal 时画面卡住 (例如启动过程中的大量渲染)
  if jsonIO then
    local now = _os_clock()
    if now - _lastFlushTime >= _minFrameInterval then
      sendScreenUpdate()
      _lastFlushTime = now
    end
  end
end

-- 刷新屏幕 (在 pullSignal 返回前调用, 确保屏幕更新及时)
-- 遵守最小帧间隔限制, 避免事件频繁时过度刷新导致性能问题
-- force=true 时强制刷新 (用于进入阻塞读之前, 避免脏区留在缓冲区)
flushRender = function(force)
  if not (renderScheduled or (screenInitialized and dirtyCount > 0)) then return end
  if jsonIO then
    local now = _os_clock()
    if not force and now - _lastFlushTime < _minFrameInterval then return end -- 还没到下一帧, 跳过
    _lastFlushTime = now
  end
  sendScreenUpdate()
end

-- ============================================================
-- GPU 组件
-- ============================================================

-- 宽字符检测辅助函数 (必须在 GPU 函数之前定义)
-- 判断字符是否为宽字符（显示宽度=2）
local function isWideChar(ch)
  if not ch or ch == "" then return false end
  local b = ch:byte(1)
  if not b then return false end
  -- ASCII 直接返回 false
  if b < 0x80 then return false end
  -- 解析 UTF-8 码点
  local cp
  if b < 0xE0 then
    cp = ((b % 0x20) * 0x40) + (ch:byte(2) % 0x40)
  elseif b < 0xF0 then
    cp = ((b % 0x10) * 0x1000) + ((ch:byte(2) % 0x40) * 0x40) + (ch:byte(3) % 0x40)
  else
    cp = ((b % 0x08) * 0x40000) + ((ch:byte(2) % 0x40) * 0x1000) + ((ch:byte(3) % 0x40) * 0x40) + (ch:byte(4) % 0x40)
  end
  -- 宽字符范围: CJK 统一表意文字、全角形式、韩文等
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

-- isWideChar 缓存 (热点路径优化) - 必须在 isWideChar 之后定义
local wideCharCache = {}
local function isWideCharCached(ch)
  if not ch or ch == "" then return false end
  local cached = wideCharCache[ch]
  if cached ~= nil then return cached end
  local result = isWideChar(ch)
  wideCharCache[ch] = result
  -- 限制缓存大小 (防止内存膨胀)
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
  _bg = 0x000000, _fg = 0xFFFFFF, _depth = 8,
  _palette = {},
  -- 暴露 tier 给程序: 程序通过 component.proxy(addr).tier 读取
  tier = config.gpuTier,
}

-- 默认 16 色调色板 (MC 标准)
local defaultPalette = {
  [0] = 0x000000, [1] = 0x0000AA, [2] = 0x00AA00, [3] = 0x00AAAA,
  [4] = 0xAA0000, [5] = 0xAA00AA, [6] = 0xFFAA00, [7] = 0xAAAAAA,
  [8] = 0x555555, [9] = 0x5555FF, [10] = 0x55FF55, [11] = 0x55FFFF,
  [12] = 0xFF5555, [13] = 0xFF55FF, [14] = 0xFFFF55, [15] = 0xFFFFFF,
}
for i = 0, 15 do gpu._palette[i] = defaultPalette[i] end

-- 根据 depth 计算调色板大小的辅助函数
local function paletteSize(depth)
  if depth == 1 then return 2
  elseif depth == 4 then return 16
  elseif depth == 8 then return 256
  else return 16 end  -- T1 GPU
end
-- GPU 最大分辨率 (基于 GPU tier): T1=50x16, T2=80x25, T3/Creative=160x50
local gpuMaxW = config.gpuTier == 1 and 50 or config.gpuTier == 2 and 80 or 160
local gpuMaxH = config.gpuTier == 1 and 16 or config.gpuTier == 2 and 25 or 50

gpu.bind = function(address) gpuBound = address; return true end
gpu.getScreen = function() return gpuBound end
gpu.getResolution = function() return gpu._resolution[1], gpu._resolution[2] end
gpu.setResolution = function(w, h)
  -- 限制在 GPU 最大分辨率内
  w = math.min(tonumber(w) or gpuMaxW, gpuMaxW)
  h = math.min(tonumber(h) or gpuMaxH, gpuMaxH)
  if w < 1 then w = 1 end
  if h < 1 then h = 1 end
  gpu._resolution = { w, h }
  Screen.width, Screen.height = w, h
  Screen.bg, Screen.fg, Screen.char = {}, {}, {}
  for y = 1, h do
    Screen.bg[y] = {}; Screen.fg[y] = {}; Screen.char[y] = {}
    for x = 1, w do
      Screen.bg[y][x] = 0x000000; Screen.fg[y][x] = 0xFFFFFF; Screen.char[y][x] = " "
    end
  end
  onResolutionChange()
  scheduleRender()
  return true
end
-- maxResolution 返回 GPU 的最大分辨率 (基于 GPU tier), 与真实 OC 一致
gpu.maxResolution = function() return gpuMaxW, gpuMaxH end
gpu.maxDepth = function()
  return config.gpuTier == 1 and 1 or config.gpuTier == 2 and 4 or 8
end
-- Viewport (OpenOS tty 依赖)
gpu._viewport = nil  -- nil 表示使用全屏
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
  d = tonumber(d) or 1
  -- 限制可用深度: T1=1, T2=4, T3=8
  local maxDepth = config.gpuTier == 1 and 1 or config.gpuTier == 2 and 4 or 8
  if d > maxDepth then d = maxDepth end
  if d < 1 then d = 1 end
  gpu._depth = d
  -- 重置调色板到默认
  gpu._palette = {}
  for i = 0, math.min(paletteSize(d) - 1, 15) do
    gpu._palette[i] = defaultPalette[i]
  end
  return d
end
gpu.get = function(x, y)
  if x < 1 or x > Screen.width or y < 1 or y > Screen.height then return nil, nil end
  local ch = Screen.char[y][x]
  -- 如果当前格是宽字符续接格(空字符串), 返回前一格的字符
  if ch == "" and x > 1 then
    ch = Screen.char[y][x - 1]
  end
  return ch, Screen.fg[y][x], Screen.bg[y][x]
end
gpu.set = function(x, y, text, vertical)
  text = tostring(text)
  local i = 1
  local len = #text
  if vertical then
    local row = y
    while i <= len do
      -- 解析一个 UTF-8 字符
      local b = text:byte(i)
      local charLen = 1
      if b >= 0xF0 then charLen = 4
      elseif b >= 0xE0 then charLen = 3
      elseif b >= 0xC0 then charLen = 2 end
      local ch = text:sub(i, i + charLen - 1)
      if x >= 1 and x <= Screen.width and row >= 1 and row <= Screen.height then
        Screen.char[row][x] = ch
        Screen.bg[row][x] = gpu._bg
        Screen.fg[row][x] = gpu._fg
        markDirty(x, row)
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
      -- 计算字符显示宽度: 宽字符占2列 (使用缓存优化)
      local cw = isWideCharCached(ch) and 2 or 1
      if col >= 1 and col + cw - 1 <= Screen.width and y >= 1 and y <= Screen.height then
        Screen.char[y][col] = ch
        Screen.bg[y][col] = gpu._bg
        Screen.fg[y][col] = gpu._fg
        markDirty(col, y)
        -- 宽字符: 第二格也标记 (存储为特殊的"续接"标记, 用空字符串表示被宽字符覆盖)
        if cw == 2 and col + 1 <= Screen.width then
          Screen.char[y][col + 1] = ""
          Screen.bg[y][col + 1] = gpu._bg
          Screen.fg[y][col + 1] = gpu._fg
          markDirty(col + 1, y)
        end
      end
      i = i + charLen
      col = col + cw
    end
    -- 追踪 tty 文本输出位置, 用于浏览器光标渲染
    -- OpenOS 不调用硬件光标, 但浏览器需要知道光标在哪
    if screen then
      screen._cursorX = math.min(col, Screen.width + 1)
      screen._cursorY = y
    end
  end
  scheduleRender()
  return true
end
gpu.copy = function(x, y, w, h, dx, dy)
  -- 保存源区域
  local src = {}
  for ry = 0, h - 1 do
    src[ry] = {}
    for rx = 0, w - 1 do
      local sx, sy = x + rx, y + ry
      if sx >= 1 and sx <= Screen.width and sy >= 1 and sy <= Screen.height then
        src[ry][rx] = { char = Screen.char[sy][sx], fg = Screen.fg[sy][sx], bg = Screen.bg[sy][sx] }
      else
        src[ry][rx] = { char = " ", fg = 0xFFFFFF, bg = 0x000000 }
      end
    end
  end
  -- 写入目标区域
  for ry = 0, h - 1 do
    for rx = 0, w - 1 do
      local tx, ty = x + rx + dx, y + ry + dy
      if tx >= 1 and tx <= Screen.width and ty >= 1 and ty <= Screen.height then
        Screen.char[ty][tx] = src[ry][rx].char
        Screen.fg[ty][tx] = src[ry][rx].fg
        Screen.bg[ty][tx] = src[ry][rx].bg
        markDirty(tx, ty)
      end
    end
  end
  scheduleRender()
  return true
end
gpu.fill = function(x, y, w, h, ch)
  -- 正确解析第一个 UTF-8 字符 (而非第一个字节)
  ch = tostring(ch)
  local b = ch:byte(1) or 32
  local charLen = 1
  if b >= 0xF0 then charLen = 4
  elseif b >= 0xE0 then charLen = 3
  elseif b >= 0xC0 then charLen = 2 end
  ch = ch:sub(1, charLen)
  local cw = isWideCharCached(ch) and 2 or 1
  for ry = y, y + h - 1 do
    if ry >= 1 and ry <= Screen.height then
      local rx = x
      local filled = 0
      while filled < w do
        local remaining = w - filled
        if cw == 2 and remaining < 2 then
          -- 剩余空间不足放一个宽字符, 填空格
          if rx >= 1 and rx <= Screen.width then
            Screen.char[ry][rx] = " "
            Screen.bg[ry][rx] = gpu._bg
            Screen.fg[ry][rx] = gpu._fg
            markDirty(rx, ry)
          end
          filled = filled + 1
          rx = rx + 1
        else
          if rx >= 1 and rx <= Screen.width then
            Screen.char[ry][rx] = ch
            Screen.bg[ry][rx] = gpu._bg
            Screen.fg[ry][rx] = gpu._fg
            markDirty(rx, ry)
            if cw == 2 and rx + 1 <= Screen.width then
              Screen.char[ry][rx + 1] = ""
              Screen.bg[ry][rx + 1] = gpu._bg
              Screen.fg[ry][rx + 1] = gpu._fg
              markDirty(rx + 1, ry)
            end
          end
          filled = filled + cw
          rx = rx + cw
        end
      end
    end
  end
  scheduleRender()
  return true
end
gpu.setBackground = function(color, isPalette)
  local old = gpu._bg
  color = math.floor(tonumber(color) or 0)
  if isPalette then
    gpu._bg = gpu._palette[color] or 0
  else
    gpu._bg = color
  end
  return old
end
gpu.setForeground = function(color, isPalette)
  local old = gpu._fg
  color = math.floor(tonumber(color) or 0)
  if isPalette then
    gpu._fg = gpu._palette[color] or 0
  else
    gpu._fg = color
  end
  return old
end
gpu.getBackground = function() return gpu._bg, false end
gpu.getForeground = function() return gpu._fg, false end
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
gpu.getBufferSize = function() return Screen.width, Screen.height end
gpu.setBufferSize = function(w, h) gpu.setResolution(w, h); return true end
gpu.bitblt = function() return true end

-- ============================================================
-- Screen 组件
-- ============================================================
screenAddr = genAddr()
screen = {
  _on = true, _precise = false, _touchInverted = false,
  _cursorX = 1, _cursorY = 1, _cursorBlink = false,
  -- 暴露 tier 给程序: 程序通过 component.proxy(addr).tier 读取
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
-- 光标控制 (OpenOS term 依赖)
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
-- Keyboard 组件
-- ============================================================
keyboardAddr = genAddr()
local keyboard = { _shift = false, _control = false, _alt = false }
keyboard.isShiftPressed = function() return keyboard._shift end
keyboard.isControlPressed = function() return keyboard._control end
keyboard.isAltPressed = function() return keyboard._alt end
keyboard.isKeyDown = function(code) return false end

-- ============================================================
-- Filesystem 组件（基于虚拟磁盘）
-- ============================================================
fsAddr = genAddr()
-- 虚拟只读文件: 让系统内的 require("mods") 直接拿到模拟器注入的组件。
-- 不写入磁盘镜像, 仅在文件系统代理层可见。
config.virtualFsFiles = {}
if config.modsEnabled then
  config.virtualFsFiles["/lib/mods.lua"] = "return mods\n"
end

local filesystem = { _label = vdisk.label, _address = fsAddr }
filesystem.getLabel = function() local l = vdisk.label or "Untitled"; dlog("fs.getLabel ->", l); return l end
filesystem.setLabel = function(label)
  vdisk.label = tostring(label or ""):sub(1, 16)
  -- 立即落盘, 避免 VM 被强制结束时丢掉这次改名
  pcall(saveAllDisks)
  return vdisk.label
end
filesystem.spaceUsed = function() return vfsSpaceUsed() end
filesystem.spaceTotal = function() return config.hddSize end
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
  -- 返回真实的数组 table，附加 __call 元方法用于迭代
  -- 这样 #list、ipairs、pairs、table.concat、索引访问全部原生支持
  -- 同时支持 for entry in fs.list(path) do 迭代用法
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
  -- OC 标准: lastModified 返回毫秒 (real world timestamp)
  local mod = vdisk.files[path] and vdisk.files[path].modified or os.time()
  return mod * 1000
end
filesystem.open = function(path, mode)
  dlog("fs.open", path, "mode", mode)
  mode = mode or "r"
  path = vfsNormalize(path)
  -- 虚拟只读文件 (如 /lib/mods.lua)
  if config.virtualFsFiles[path] ~= nil then
    if mode:match("w") or mode:match("a") then
      return nil, "read-only"
    end
    handleCount = handleCount + 1
    local handle = handleCount
    openHandles[handle] = { mode = mode, pos = 0, buffer = config.virtualFsFiles[path], path = path }
    return handle
  end
  -- 目录不能打开
  if vfsIsDirectory(path) then
    dlog("fs.open: cannot open directory:", path)
    return nil, "is a directory"
  end
  -- 读模式: 文件不存在则返回 nil
  if not mode:match("w") and not mode:match("a") then
    if not vfsExists(path) then
      dlog("fs.open: file not found:", path)
      return nil, "file not found"
    end
  end
  handleCount = handleCount + 1
  local handle = handleCount
  if mode:match("w") then
    openHandles[handle] = { mode = mode, pos = 0, buffer = "", path = path }
  else
    local content = vfsRead(path) or ""
    openHandles[handle] = { mode = mode, pos = 0, buffer = content, path = path }
  end
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
  -- 清空所有文件, 保留根目录
  for k in pairs(vdisk.files) do
    if k ~= "/" then vdisk.files[k] = nil end
  end
  -- 确保根目录存在
  vdisk.files["/"] = { type = "directory", modified = os.time() }
  -- 标记磁盘已修改 (立即落盘, 避免格式化后进程被强杀导致旧内容复活)
  diskPersist.mark()
  diskPersist.flush(true)
  return true
end

-- ============================================================
-- EEPROM 组件
-- ============================================================
eepromAddr = genAddr()
eepromData = ""
eepromLabel = "OC-Emulator EEPROM"
eepromCode = nil  -- 从 .oce 文件加载的 EEPROM 代码

-- 内置 OC 模组 BIOS (Lua 版) - 作为默认 EEPROM
-- 兼容两种引导布局: /init.lua 与 /BIOS/Manager.lua
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
    -- 在屏幕上显示 "no bootable medium" 并等待
    local gpu = component.list("gpu")()
    if gpu then
      boot_invoke(gpu, "set", 1, 1, "No bootable medium found")
      boot_invoke(gpu, "set", 1, 2, "Insert a disk with /init.lua or /OS.lua and press any key")
      boot_invoke(gpu, "set", 1, 4, "Press Ctrl+Alt+Insert in the web panel to restart")
    end
    computer.beep(200, 0.5)
    -- 等待用户输入 (保持 VM 运行)
    while true do
      local sig = computer.pullSignal(1)
      if sig and sig[1] == "key_down" then
        -- 重启
        computer.shutdown("reboot")
      end
    end
  end
  computer.beep(1000, 0.2)
end
return init()
]]

-- 尝试从配置加载 EEPROM 文件
if config.eepromFile and config.eepromFile ~= "" then
  -- 支持完整路径或相对文件名
  local eepromPath = config.eepromFile
  if not eepromPath:match("^[A-Za-z]:") and not eepromPath:match("^[/\\]") then
    -- 相对路径，加上 VM 目录前缀
    eepromPath = config.vmDir .. "/" .. eepromPath
  end
  -- 支持 .oce 二进制格式和 .lua 纯文本格式
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
    -- 纯 Lua 文件 (如从 OC GitHub 下载的 bios.lua)
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

-- 如果没有自定义 EEPROM 或 EEPROM 为空，使用内置 OC BIOS
if not eepromCode or #eepromCode == 0 then
  eepromCode = BUILTIN_EEPROM
  eepromLabel = "OpenOS EEPROM"
  _stderr:write("[emulator] using built-in OC BIOS EEPROM\n")
end

local eeprom = {}
eeprom.get = function()
  -- 始终返回当前 EEPROM 代码 (内置 OC BIOS 或自定义)
  return eepromCode
end
eeprom.set = function(data)
  -- 参数校验: 防止写入空文件
  if not data or #data == 0 then
    _stderr:write("[emulator] WARNING: eeprom.set() called with empty data, skipping write\n")
    return false, "empty data"
  end

  -- 强制 4KB 限制
  if #data > 4096 then data = data:sub(1, 4096) end
  eepromCode = data
  -- 持久化: 优先写回到当前 EEPROM 文件; 若无 (built-in), 则创建 eeprom.lua
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
    -- .oce 格式: 使用二进制头格式写入
    local ok, err = pcall(function()
      disk.saveEEPROM(eepromPath, eepromLabel, eepromCode)
    end)
    if ok then
      _stderr:write("[emulator] EEPROM flashed (OCE), saved to " .. eepromPath .. " (" .. #data .. " bytes)\n")
    else
      _stderr:write("[emulator] WARNING: cannot save EEPROM (OCE): " .. tostring(err) .. "\n")
    end
  else
    -- .lua 格式: 纯文本写入
    local f, err = _io_open(eepromPath, "wb")
    if f then
      f:write(eepromCode or "")
      f:close()
      _stderr:write("[emulator] EEPROM flashed, saved to " .. eepromPath .. " (" .. #data .. " bytes)\n")
    else
      _stderr:write("[emulator] WARNING: cannot save EEPROM: " .. tostring(err) .. "\n")
    end
  end
  -- 更新 config.json, 把 eeprom 从 "built-in" 改为 "eeprom.lua"
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
eeprom.setData = function(data) eepromData = (data or ""):sub(1, 256) end
eeprom.getLabel = function() return eepromLabel end
eeprom.setLabel = function(label)
  if #label > 16 then label = label:sub(1, 16) end
  eepromLabel = label
  -- 持久化标签到 config.json (对 .lua EEPROM 尤其重要, 因为 .lua 文件没有标签位)
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
eeprom.makeReadonly = function() return false, "not supported" end

-- ============================================================
-- Internet 组件
-- ============================================================
local internetAddr = genAddr()
local internet = {}
internet.isTcpEnabled = function() return false end
internet.isHttpEnabled = function() return true end
internet.request = function(url, postData, headers)
  if jsonIO then
    -- 异步模式: 通过 JSON I/O 协议发请求, 等待 net_response
    pendingNetId = pendingNetId + 1
    local reqId = "req_" .. pendingNetId
    local method = (postData and postData ~= "") and "POST" or "GET"

    -- 注册回调, 等待 server 返回 net_response
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
        -- chunks 是数组, 拼接为完整响应体
        local parts = msg.chunks or {}
        responseData = table.concat(parts)
      end
      gotResponse = true
    end

    -- 发送 net_request 到 server
    sendToServer({
      type = "net_request",
      url = url,
      method = method,
      postData = postData,
      headers = headers,
      reqId = reqId,
    })

    -- 阻塞等待响应 (最长 90 秒，大文件或网络慢时需要更多时间)
    local maxWait = 90
    local waited = 0
    while not gotResponse and waited < maxWait do
      -- pullSignal 会阻塞直到收到消息或超时
      -- server 在 pull_signal timeout 到期后发 tick, pullSignal 返回 nil
      pullSignal(1)
      waited = waited + 1
    end

    -- 超时清理回调
    if not gotResponse then
      pendingNetCallbacks[reqId] = nil
      responseError = "request timed out after " .. maxWait .. "s (url: " .. url:sub(1, 80) .. ")"
    end

    local handle = { data = responseData, closed = false }
    handle.read = function(n)
      if handle.closed or not handle.data then return nil end
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
        local all = handle.data; handle.data = nil; return all
      end
    end
    handle.response = function()
      return responseStatus, responseStatusText, responseHeaders
    end
    handle.close = function() handle.closed = true end
    handle.finishConnect = function() return true end

    -- 请求失败时返回 nil, 与真实 OC 行为一致
    if responseError then
      return nil, responseError
    end
    return handle
  end

  -- 非 JSON 模式回退 (同步 popen, 仅在 legacy 文件模式使用)
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
  handle.read = function(n)
    if handle.closed or not handle.data then return nil end
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
      local all = handle.data; handle.data = nil; return all
    end
  end
  handle.response = function() return 200, "OK", {} end
  handle.close = function() handle.closed = true end
  handle.finishConnect = function() return true end
  return handle
end
internet.connect = function(addr, port) return nil, "TCP not supported" end

-- ============================================================
-- 数据卡 (Data Card) - OC 模组标准 API, 分 Tier 实现
-- T1: encode64/decode64, serialize/deserialize, crc32
-- T2: + md5, sha256, deflate/inflate, random
-- T3: + encrypt/decrypt, generateKeyPair, sign/verify, diffieHellman
-- ============================================================
local dataAddr = genAddr()

-- Base64 编码表 (T1 级, 纯 Lua)
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

-- crypto-helper.js 桥接: 通过 io.popen 调用 Node.js 执行加密操作
-- 返回 stdout 输出 (字符串), 出错返回 nil, errorMsg
local cryptoHelperPath = EMU_DIR .. "lib/crypto-helper.js"
local function _cryptoBridge(op, inputData, ...)
  local tmpIn = _os_tmpname()
  local f = _io_open(tmpIn, "wb")
  if not f then return nil, "cannot create temp file" end
  f:write(inputData or "")
  f:close()
  local cmd = 'node "' .. cryptoHelperPath .. '" ' .. op .. ' "' .. tmpIn .. '"'
  -- 附加额外参数 (密钥文件等)
  local args = { ... }
  for _, a in ipairs(args) do
    -- 写入额外参数到 temp 文件
    local tmpArg = _os_tmpname()
    local af = _io_open(tmpArg, "wb")
    if af then af:write(a); af:close() end
    cmd = cmd .. ' "' .. tmpArg .. '"'
  end
  local h = _io_popen(cmd, "r")
  local result = h and h:read("*a") or nil
  if h then h:close() end
  _os_remove(tmpIn)
  -- 清理额外参数 temp 文件 (它们在 cmd 中被引用)
  -- 由于在 popen 完成后文件已不需要, 清理
  return result
end

-- 简化版 crypto bridge: 单参数 (md5, sha256, deflate, inflate)
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

-- 双参数 crypto bridge: 用于 encrypt/decrypt (inputData, key)
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

-- 创建分 Tier 的数据卡
-- tier: 1, 2, 或 3
local function createDataCard(tier)
  local card = {
    type = "data",
    tier = tier,
  }

  -- ==== T1 方法 (所有 Tier 都有) ====
  card.encode64 = function(s) return _encode64(s) end
  card.decode64 = function(s) return _decode64(s) end
  card.encodeBase64 = card.encode64  -- 兼容别名
  card.decodeBase64 = card.decode64
  card.serialize = function(v) return _serialize(v) end
  card.deserialize = function(s) return _deserialize(s) end
  card.crc32 = function(s) return _crc32(s) end

  -- ==== T2 方法 (Tier >= 2) ====
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

  -- ==== T3 方法 (Tier >= 3) ====
  if tier >= 3 then
    -- AES-256-CBC 加密: encrypt(data, key) → base64(iv + encrypted)
    card.encrypt = function(data, key)
      local result = _cryptoDouble("encrypt", data or "", key or "")
      if not result or result == "" then error("encrypt failed") end
      return result
    end
    -- AES-256-CBC 解密: decrypt(base64(iv + encrypted), key) → original
    card.decrypt = function(data, key)
      local result = _cryptoDouble("decrypt", data or "", key or "")
      if not result then error("decrypt failed") end
      return result
    end
    -- 生成 RSA 密钥对: generateKeyPair([bits]) → {public, private}
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
      -- 尝试 JSON 解析
      local fn = (loadstring or load)("return " .. result)
      if fn then
        local ok2, r = pcall(fn)
        if ok2 and type(r) == "table" then
          return r.public, r.private
        end
      end
      error("cannot parse key pair")
    end
    -- RSA 签名: sign(data, privateKey) → base64 signature
    card.sign = function(data, privateKey)
      local result = _cryptoDouble("sign", data or "", privateKey or "")
      if not result or result == "" then error("sign failed") end
      return result
    end
    -- RSA 验证: verify(data, signature, publicKey) → boolean
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
    -- DH 密钥交换: diffieHellman(privateKey, publicKey) → shared secret
    card.diffieHellman = function(privateKey, publicKey)
      local result = _cryptoDouble("diffieHellman", privateKey or "", publicKey or "")
      if not result or result == "" then error("diffieHellman failed") end
      return result
    end
  end

  return card
end

-- data 变量: 默认 T1 (会在扩展卡注册时被替换为正确 Tier)
local data = createDataCard(1)

-- ============================================================
-- 组件注册表
-- ============================================================
-- 创造机箱: 2个硬盘位 + 1个软盘位 + 扩展卡
-- 第二个硬盘: 如果配置了 disk2 文件则从 .ocd 加载, 否则空磁盘
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

-- 软盘驱动器: 同样从 .ocd 加载
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
    _stderr:write("[emulator] Floppy loaded: " .. floppyLabel .. " (locked=" .. tostring(floppyLocked) .. ")\n")
  else
    _stderr:write("[emulator] WARNING: cannot load floppy: " .. config.floppyFile .. "\n")
  end
end

-- 创建通用文件系统代理。
-- onLabelSet: 标签变更回调。必须把新标签写回外层变量, 否则 saveAllDisks() 写盘时
--   用的是创建代理时的标签, 导致改标签只在本次运行内有效。
local function makeFsProxy(filesTable, label, capacity, readOnly, onLabelSet, onDirty)
  local fs = {}
  -- 发生修改时通知调用方 (磁盘打脏标记, tmpfs 不传此回调)
  local function touch()
    if onDirty then pcall(onDirty) end
  end
  fs.getLabel = function() return label end
  fs.setLabel = function(l)
    if readOnly then return nil, "filesystem is read-only" end
    label = tostring(l or "")
    if onLabelSet then pcall(onLabelSet, label) end
    -- 立即落盘: 这样即使 VM 随后被强制结束, 这次改名也不会丢
    pcall(saveAllDisks)
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
    -- 隐式目录: 存在以 path/ 开头的子条目
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
    -- 隐式目录: 如果存在以 path/ 开头的子条目, 则视为目录
    local prefix = path .. "/"
    for p in pairs(filesTable) do
      if p:sub(1, #prefix) == prefix then return true end
    end
    return false
  end
  fs.list = function(path)
    path = vfsNormalize(path)
    local entries = {}
    local prefix = path == "/" and "/" or path .. "/"
    for p, info in pairs(filesTable) do
      if p:sub(1, #prefix) == prefix then
        local rest = p:sub(#prefix + 1)
        if rest:find("/") then
          local dirName = rest:match("^([^/]+)/")
          if dirName then entries[dirName .. "/"] = true end
        else
          entries[rest] = true
        end
      end
    end
    local result = {}
    for name in pairs(entries) do table.insert(result, name) end
    local i = 0
    -- 返回真实数组 table + __call 迭代，确保全面兼容
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
    local handle = { path = path, mode = mode, pos = 1, buffer = info.content or "" }
    return handle
  end
  fs.read = function(handle, n)
    if not handle then return nil end
    if handle.pos > #handle.buffer then return nil end
    local remaining = #handle.buffer - handle.pos + 1
    if not n or n >= math.huge then n = remaining
    else n = math.floor(n) end
    n = math.min(n, remaining)
    if n <= 0 then return nil end
    local chunk = handle.buffer:sub(handle.pos, handle.pos + n - 1)
    handle.pos = handle.pos + #chunk
    return chunk
  end
  fs.write = function(handle, value)
    if not handle then return nil, "no handle" end
    if readOnly then return nil, "filesystem is read-only" end
    handle.buffer = handle.buffer .. value
    filesTable[handle.path].content = handle.buffer
    touch()
    return true
  end
  fs.close = function(handle)
    if handle then handle.closed = true end
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
    -- 清空所有文件, 保留根目录
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
    -- OC 标准: lastModified 返回毫秒 (real world timestamp)
    local mod = info and info.modified or os.time()
    return mod * 1000
  end
  return fs
end

local fs2 = makeFsProxy(fs2Files, fs2Label, 4 * 1024 * 1024, false, function(l) fs2Label = l end, diskPersist.mark)
local floppy = makeFsProxy(floppyFiles, floppyLabel, 512 * 1024, floppyLocked, function(l) floppyLabel = l end, diskPersist.mark)
-- tmpfs: RAM-based, always writable, empty on boot (不落盘, 因此不传 onDirty)
local tmpfs = makeFsProxy(tmpFiles, "tmpfs", 4 * 1024 * 1024, false)

componentRegistry = {
  [gpuAddr] = { type = "gpu", proxy = gpu },
  [screenAddr] = { type = "screen", proxy = screen },
  [keyboardAddr] = { type = "keyboard", proxy = keyboard },
  [fsAddr] = { type = "filesystem", proxy = filesystem },
  [eepromAddr] = { type = "eeprom", proxy = eeprom },
}
-- disk2: 只有配置了才注册
if config.disk2File then
  componentRegistry[fs2Addr] = { type = "filesystem", proxy = fs2 }
end
-- 软盘: 只有配置了才注册
if config.floppyFile then
  componentRegistry[floppyAddr] = { type = "filesystem", proxy = floppy }
end
-- tmpfs: 始终注册, RAM 临时文件系统
componentRegistry[tmpAddr] = { type = "filesystem", proxy = tmpfs }

-- Mods: 机器人 / 无人机 / 单片机 合并为一个组件
modsAddr = nil
if config.modsEnabled then
  modsAddr = genAddr()
  mods.address = modsAddr
  componentRegistry[modsAddr] = { type = "mods", proxy = mods }
  _stderr:write("[emulator] Mods: robot / drone / microcontroller merged component\n")
end

-- 扩展卡: 根据配置条件注册
local modem = nil

for i = 1, 3 do
  local card = config.expansion and config.expansion[i]
  if card then
    if card:match("^internet") then
      componentRegistry[internetAddr] = { type = "internet", proxy = internet }
      _stderr:write("[emulator] Expansion " .. i .. ": Internet Card\n")
    elseif card:match("^data") then
      -- 根据扩展卡类型确定 Tier: data_t1=1, data_t2=2, data_t3=3
      local dtier = tonumber(card:match("t(%d)") or "1")
      if dtier < 1 then dtier = 1 end
      if dtier > 3 then dtier = 3 end
      data = createDataCard(dtier)
      componentRegistry[dataAddr] = { type = "data", proxy = data }
      _stderr:write("[emulator] Expansion " .. i .. ": Data Card T" .. dtier .. "\n")
    elseif card:match("^modem") or card:match("^wireless") then
      -- 无线网卡 (modem)
      --
      -- 信号强度 (对应现实 OC 的"格数限制"): 现实 OC 里无线范围按"格"(方块) 计算, 模拟器没有
      -- 空间概念, 因此把范围改造成一个离散的"信号强度":
      --   strength = 1  -> 本机自成一网, 无法发现/连接这台工具里的其他虚拟机
      --   strength >= 2 -> 可以与其他虚拟机互相发现并收发 modem 消息
      -- 默认值取卡片等级 (T1=1, T2=2), 也可以在 config.json 的
      -- hardware.modemStrength 里显式指定 (上限 16)。
      local tier = tonumber(card:match("%d") or "1")
      if tier < 1 then tier = 1 end
      if tier > 2 then tier = 2 end
      modemAddr = genAddr()
      local strength = tonumber(hw.modemStrength) or tier
      if strength < 1 then strength = 1 end
      if strength > 16 then strength = 16 end
      local maxStrength = 16
      modem = {
        -- 公开字段 (与真实 OC 一致, 脚本可直接读取)
        type = "modem",
        tier = tier,
        -- 内部状态
        _openPorts = {},
        _strength = strength,
        _maxStrength = maxStrength,
      }
      modem.open = function(port)
        checkArg(1, port, "number")
        modem._openPorts[port] = true
        -- 必须通知 server: modemHub 靠"哪些端口开着"来决定投递,
        -- 不上报就会表现为"另一个虚拟机收不到消息"。
        sendToServer({ type = "modem_open_port", port = port })
        return true
      end
      modem.close = function(port)
        if port then
          checkArg(1, port, "number")
          modem._openPorts[port] = nil
          sendToServer({ type = "modem_close_port", port = port })
        else
          -- 无参数: 关闭所有端口
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
      -- 单包最大字节数 (modem.maxPacketSize)。MineOS / PixelOS 的网络层优先检测这个方法,
      -- 缺失时才会退回 getDeviceInfo()[addr].capacity (见上面的 MODEM_MAX_PACKET_SIZE)。
      -- 用不了就会导致大消息分片长度算成 nil, 大响应发不回去。
      modem.maxPacketSize = function()
        return MODEM_MAX_PACKET_SIZE
      end
      modem.send = function(dest, port, ...)
        checkArg(1, dest, "string")
        checkArg(2, port, "number")
        -- 通过 server 路由到其他 VM。
        -- 关键: 必须带上自己的 modem 地址 (from) 和目标地址 (to)。
        -- 若只发 dest 而没有 from, server 端按 msg.from/msg.to 读取全是 nil,
        -- 所有跨 VM 消息都会被判定为"没有目标地址"直接丢掉。
        sendToServer({
          type = "modem_send",
          from = modemAddr,
          to = dest,
          dest = dest,   -- 兼容旧字段名
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
        -- 同步给 server: 信号强度 < 2 时这台 VM 会被隔离 (收不到也发不出)
        sendToServer({ type = "modem_strength", strength = s })
        return s
      end
      modem.getMaxStrength = function() return modem._maxStrength end
      modem.isWireless = function() return true end
      -- T2 modem 同时支持有线 (cable) 和无线; T1 仅无线
      modem.isWired = function() return tier >= 2 end
      componentRegistry[modemAddr] = { type = "modem", proxy = modem }
      -- 注册到 server (带上信号强度, hub 据此判断能否跨 VM 通信)
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
-- 根据注册情况添加 primaries
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
  -- OC 的 component.list 返回的表支持两种用法:
  -- 1) for addr, type in pairs(component.list()) do
  -- 2) for addr in component.list() do  (通过 __call 实现迭代器协议)
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
    -- OpenOS 依赖 proxy.address 获取组件地址
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
        -- 确保通过 component.xxx 访问时也有 address/type 字段
        -- OpenOS 的 91_gpu.lua 依赖 component.screen.address
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
-- 外部设备组件
--
-- 核电站这类设备不是计算机, 在真实环境里通过适配器接入组件网络。
-- 服务端每秒推送一次状态快照 (ext_state), 这里的组件方法读取本地快照;
-- 写操作 (setActive) 通过 ext_command 发回服务端执行。
--
-- 说明: Lua 5.1 的单个 chunk 最多 200 个 local, 这里用全局表保存,
-- 避免再占用 local 名额。
-- ============================================================
extComponents = { devices = {} }   -- devices: address -> proxy

-- 只读仪表组件: MineOS IC2Reactors.app 等程序通过 reactor_chamber 读取数值
extComponents.makeReactorChamber = function(address)
  local dev = { address = address, type = "reactor_chamber", _state = {} }
  local function S() return dev._state end

  function dev.getHeat() return tonumber(S().hullHeat) or 0 end
  function dev.getMaxHeat() return tonumber(S().hullHeatCapacity) or 0 end
  -- 温度: 环境温度 + 堆芯热量, 上限为外壳热容量 + 环境温度
  function dev.getTemperature() return tonumber(S().temperature) or 0 end
  function dev.getMaxTemperature() return tonumber(S().maxTemperature) or 0 end
  function dev.getHeatCapacity() return dev.getMaxTemperature() end
  -- 设置温度 (自动夹在环境温度 ~ 上限), 返回设置后的温度
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
  function dev.getHeatOutput() return tonumber(S().heatPerTick) or 0 end
  function dev.isActive() return S().active == true end
  function dev.getActive() return S().active == true end
  function dev.getSize() return tonumber(S().columns) or 0, tonumber(S().rows) or 0 end
  function dev.slotCount() return (tonumber(S().columns) or 0) * (tonumber(S().rows) or 0) end
  dev.getSlotCount = dev.slotCount
  local function slotAt(slot)
    local index = tonumber(slot)
    local slots = S().slots
    if not index or type(slots) ~= "table" then return nil end
    local item = slots[index + 1]
    if type(item) ~= "table" then return nil end
    return item
  end

  function dev.getStackInSlot(slot) return slotAt(slot) end
  dev.getComponentInfo = dev.getStackInSlot

  -- 组件耐久: 返回当前耐久, 最大耐久; 空槽返回 0, 0
  function dev.getComponentDurability(slot)
    local item = slotAt(slot)
    if not item then return 0, 0 end
    return tonumber(item.durability) or 0, tonumber(item.maxDurability) or 0
  end
  dev.getSlotDurability = dev.getComponentDurability

  -- 组件剩余耐久比例 (0 ~ 1); 空槽或没有耐久的组件返回 0
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

  -- 同类组件中最低的耐久比例 (0 ~ 1); category 省略表示全部组件, 无对应组件返回 0
  function dev.getDurabilityRatio(category)
    local r = lowestDurability(category)
    return r or 0
  end

  -- 单个组件的当前温度 (°C); 空槽返回 0
  function dev.getComponentTemperature(slot)
    local item = slotAt(slot)
    if not item then return 0 end
    return tonumber(item.temperature) or 0
  end
  dev.getSlotTemperature = dev.getComponentTemperature

  -- 单个组件的温度比例 (0 ~ 1); 空槽返回 0
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

-- 自定义脚本机器的组件: 属性 / 只读方法 / 动作由 machine.lua 定义,
-- 服务端在 ext_devices 的 meta 中下发属性表与方法名。
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

  -- 每个可写属性自动生成 getXxx() / setXxx()
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

  -- 只读方法: 脚本每 tick 计算一次, 结果随状态快照下发
  if type(meta.methods) == "table" then
    for _, name in ipairs(meta.methods) do
      if type(name) == "string" and name:match("^[%a_][%w_]*$") and dev[name] == nil then
        dev[name] = function() return S()[name] end
      end
    end
  end

  -- 动作: 异步发回脚本执行, 结果在下一帧状态里可见
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

  -- 同类组件中最低的耐久比例; 无对应组件返回 nil
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

  -- 耐久比例换算成 0~15 信号; 没有对应组件时返回 0
  local function durabilitySignal(category)
    local r = lowestDurability(category)
    if r == nil then return 0 end
    return clamp(r * 15 + 0.5)
  end

  -- 同类组件中最高的温度比例; 无对应组件返回 nil
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

  -- 温度比例换算成 0~15 信号; 没有对应组件时返回 0
  local function temperatureSignal(category)
    local r = highestTemperatureRatio(category)
    if r == nil then return 0 end
    return clamp(r * 15 + 0.5)
  end

  -- 输入通道 (反应堆 -> 计算机)
  --   0: 堆芯热量百分比   1: EU/t (每 100 EU/t 一档, 上限 15)
  --   2: 燃料棒数量       3: 状态 (off 0 / idle 3 / stable 8 / warning 12 / critical、overheat 15)
  --   4: 剩余吸热百分比   5: 是否运行 (0 / 15)
  --   6: 燃料棒最低耐久   7: 冷却单元最低耐久
  --   8: 冷凝模块最低耐久 9: 全部组件最低耐久 (均为百分比 × 15)
  --  10: 燃料棒最高温度  11: 冷却单元最高温度
  --  12: 冷凝模块最高温度 13: 全部组件最高温度 (均为温度比例 × 15)
  -- 自定义脚本机器的红石端口: 状态里带 machine = true,
  -- inputs / outputs 是按属性顺序排列的 0~15 数组。
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
    side = tonumber(side) or 0
    if isMachine() then
      local outputs = S().outputs
      if type(outputs) == "table" then
        local value = tonumber(outputs[side + 1])
        if value then return clamp(value) end
      end
    end
    return dev._out[side] or 0
  end

  -- 输出通道 (计算机 -> 机器): 任一通道都可控制开关, > 0 为运行
  function dev.setOutput(side, value)
    side = tonumber(side) or 0
    value = clamp(value)
    dev._out[side] = value
    sendToServer({ type = "ext_command", address = address, method = "setOutput", args = { side, value } })
    if not isMachine() then dev._state.active = value > 0 end
    return value
  end

  function dev.getBundledOutput(side)
    return dev._bout[tonumber(side) or 0] or 0
  end

  -- bit0 表示开关, 任一通道均可
  function dev.setBundledOutput(side, mask)
    side = tonumber(side) or 0
    mask = tonumber(mask) or 0
    if isMachine() then return 0 end
    dev._bout[side] = mask
    sendToServer({ type = "ext_command", address = address, method = "setBundledOutput", args = { side, mask } })
    dev._state.active = (mask % 2) == 1
    return mask
  end

  -- 0 号通道的 bit0..bit3: 运行 / 稳定 / 注意 / 危险
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
  -- 服务端已不存在的设备要从组件表里移除
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

-- 启动时载入 devices.json: 程序一开始运行就能访问外部设备
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
-- unicode API (UTF-8 支持)
-- ============================================================
local unicode = {}

-- 计算 UTF-8 字符串的字符数
unicode.len = function(s)
  local n = 0
  for _ in s:gmatch(".[\128-\191]*") do n = n + 1 end
  return n
end

-- 计算显示宽度 (窄字符=1, 宽字符=2)
unicode.wlen = function(s)
  local w = 0
  for ch in s:gmatch(".[\128-\191]*") do
    w = w + (unicode.isWide(ch) and 2 or 1)
  end
  return w
end

-- 按字符索引截取（UTF-8 安全）
unicode.sub = function(s, i, j)
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
  -- 简单实现：只处理 ASCII
  return (s:gsub("%a", string.upper))
end
unicode.lower = function(s)
  return (s:gsub("%a", string.lower))
end

-- 从 Unicode 码点生成 UTF-8 字符
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

-- 从 UTF-8 字符串获取 Unicode 码点
unicode.byte = function(s, i, j)
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

-- 判断字符是否为宽字符（显示宽度=2）
-- OC 标准: 只有 CJK 统一表意文字、全角字符等才是宽字符
-- 拉丁扩展、块字符(█▀▄)等都是窄字符(宽度=1)
unicode.isWide = function(ch)
  if not ch or ch == "" then return false end
  -- 解析 UTF-8 码点
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
  -- 宽字符范围: CJK 统一表意文字、全角形式、韩文等
  -- 0x1100-0x115F: Hangul Jamo
  -- 0x2E80-0xA4CF: CJK 部首、康熙字典、CJK符号、日文、韩文
  -- 0xAC00-0xD7A3: Hangul Syllables
  -- 0xF900-0xFAFF: CJK 兼容表意文字
  -- 0xFE30-0xFE4F: CJK 兼容形式
  -- 0xFF00-0xFF60: 全角ASCII
  -- 0xFFE0-0xFFE6: 全角符号
  -- 0x1F300-0x1FAFF: Emoji 和符号
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

-- 按显示宽度截断字符串
unicode.wtrunc = function(s, width)
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

-- 字符迭代器
unicode.chars = function(s)
  return s:gmatch(".[\128-\191]*")
end

-- ============================================================
-- keyboard 全局库
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
-- 注入全局环境
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

-- 保存原始 os 函数（避免递归调用）
local _os_time = os.time
local _os_date = os.date
-- _os_clock 已在文件开头定义
local _os_exit = os.exit
local _os_getenv = os.getenv
local _os_execute = os.execute

if not _G.os then _G.os = {} end
if not _G.os.sleep then _G.os.sleep = function(t) computer.pullSignal(t or 0) end end
_G.os.time = function() return _os_time() end
_G.os.date = function(fmt, t)
  if t ~= nil then
    t = math.floor(tonumber(t) or 0)
  end
  return _os_date(fmt, t)
end
_G.os.clock = function() return _os_clock() end
_G.os.difftime = function(t2, t1) return t2 - t1 end
_G.os.execute = function(cmd)
  if not cmd then return true end
  return _os_execute(cmd)
end
_G.os.exit = function(code) _os_exit(code or 0) end
_G.os.getenv = function(name) return _os_getenv(name) end
_G.os.remove = function(path) return vfsRemove(path) end
_G.os.rename = function(from, to) return vfsRename(from, to) end
_G.os.tmpname = function() return "/tmp/tmp" .. math.random(100000, 999999) end

-- event 库
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

-- loadfile / dofile 使用虚拟路径
function _G.loadfile(path, ...)
  local content = vfsRead(path)
  if not content then return nil, "file not found: " .. path end
  -- Lua 5.1 用 loadstring, 5.2+ 用 load
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
-- require: 从虚拟文件系统加载模块
-- ============================================================
-- 保留原始 package 的 path/config/cpath/loaders 等字段
-- (OpenOS 的 /lib/package.lua 需要这些字段)
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

-- 预加载核心模块
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
  -- 尝试 /lib/name.lua
  local path = "/lib/" .. name .. ".lua"
  local content = vfsRead(path)
  if not content then
    -- 尝试 /lib/name/init.lua
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
-- 屏幕错误显示辅助函数 (必须在磁盘加载之前定义, 因为加载失败时需要调用)
-- ============================================================
local function _showScreenMessage(msg)
  pcall(function()
    gpu.bind(screenAddr)
    local w = Screen.width
    local h = Screen.height
    gpu.setResolution(w, h)
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
-- 加载磁盘
-- ============================================================
if projectPath then
  -- 项目模式: 直接使用项目文件夹, 不加载磁盘镜像
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

-- 检测操作系统类型 (仅用于日志显示)
dlog("/BIOS/Manager.lua exists:", vfsExists("/BIOS/Manager.lua"))
dlog("/init.lua exists:", vfsExists("/init.lua"))
dlog("/OS.lua exists:", vfsExists("/OS.lua"))
if vfsExists("/BIOS/Manager.lua") then
  _stderr:write("[emulator] detected: /BIOS/Manager.lua\n")
elseif vfsExists("/init.lua") then
  _stderr:write("[emulator] detected: OpenOS (/init.lua)\n")
elseif vfsExists("/OS.lua") then
  _stderr:write("[emulator] detected: MineOS (/OS.lua)\n")
else
  _stderr:write("[emulator] WARNING: no bootable OS found on disk\n")
  showScreenMessage("No bootable OS found\nNo /init.lua or /OS.lua on disk")
end

-- ============================================================
-- 启动 - 运行 EEPROM (BIOS)
-- ============================================================
-- 启动顺序: 按配置的 bootOrder 查找第一个可引导的设备
-- ============================================================
local function isBootable(fsProxy)
  -- 只要文件系统存在且可访问,就认为可能可引导
  -- 具体能否引导由 EEPROM/BIOS 决定,模拟器不做硬编码的文件名判断
  -- 这样可以兼容任何操作系统 (OpenOS, MineOS 等)
  if not fsProxy then return false end
  if fsProxy.exists and fsProxy.open and fsProxy.list then
    return true
  end
  return false
end

local function resolveBootAddress()
  -- 读取启动顺序配置
  local order = config.bootOrder
  if not order or type(order) ~= "table" or #order == 0 then
    order = { "disk1", "disk2", "floppy" }
  end
  -- 设备地址映射
  local deviceMap = {
    disk1 = fsAddr,
    disk2 = fs2Addr,
    floppy = floppyAddr,
  }
  -- 设备 filesystem proxy 映射
  local fsMap = {
    disk1 = filesystem,
    disk2 = fs2,
    floppy = floppy,
  }
  -- 按顺序查找第一个可引导的设备
  for _, dev in ipairs(order) do
    local addr = deviceMap[dev]
    local proxy = fsMap[dev]
    if addr and proxy and isBootable(proxy) then
      dlog("boot address resolved from bootOrder:", dev, addr:sub(1, 8))
      return addr
    end
  end
  -- 都不可引导, 显示错误并退出
  dlog("no bootable device found")
  _stderr:write("[emulator] no bootable device found\n")
  showScreenMessage("No bootable device found\nNo filesystem available (check disk/floppy)")
  os.exit(1)
end

gpu.bind(screenAddr)
-- 根据启动顺序设置启动地址，BIOS 会从该磁盘加载 /init.lua 或 /BIOS/Manager.lua
local bootAddr = resolveBootAddress()
eepromData = bootAddr
computer._bootAddr = bootAddr
computer._runlevel = 1

-- 执行 EEPROM 代码 (内置 OC BIOS 或自定义 EEPROM)
local bootCode = eepromCode
local bootPath = "eeprom"
dlog("booting EEPROM, size:", #bootCode)
_stderr:write("[emulator] booting EEPROM (" .. eepromLabel .. ", " .. #bootCode .. " bytes)\n")
_stderr:write("[emulator] boot address: " .. bootAddr:sub(1, 8) .. "\n")
-- 兼容 Lua 5.1 (loadstring) 和 5.2+ (load)
local loadfunc = loadstring or load
local chunk, err = loadfunc(bootCode, "=" .. bootPath)
if not chunk then
  dlog("load error:", err)
  _stderr:write("[emulator] load error: " .. tostring(err) .. "\n")
  showScreenMessage("EEPROM load error\n" .. tostring(err))
  os.exit(1)
end

-- Lua 5.1 兼容: setfenv 设置环境
if setfenv then setfenv(chunk, _G) end

local ok, err = xpcall(chunk, function(e) return debug.traceback(e) end)
if not ok then
  _stderr:write("[emulator] runtime error:\n" .. tostring(err) .. "\n")
  if modsAddr and mods.reportError then mods.reportError(tostring(err)) end
  showScreenMessage("Runtime error\n" .. tostring(err))
  saveAllDisks()
  os.exit(1)
end

saveAllDisks()

-- 如果使用了临时 VM 磁盘，尝试将修改写回 VM 文件
if vmTempDisk and arg[1] and arg[1]:match("%.ocvm$") then
  local f = _io_open(vmTempDisk, "rb")
  if f then
    local diskData = f:read("*a")
    f:close()
    _os_remove(vmTempDisk)
    local vmCfg = vm.load(arg[1])
    if vmCfg then
      vm.save(arg[1], vmCfg, diskData)
      _stderr:write("[emulator] VM disk saved back to " .. arg[1] .. "\n")
    end
  end
end
