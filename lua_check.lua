-- ============================================================
-- Lua 解释器校验模块 (含 hash 缓存)
-- 用法: lua lua_check.lua <luaExe路径>
-- 输出: 单行 JSON 到 stdout
-- ============================================================

local json = require("json")

local target = arg and arg[1]
if not target or target == "" then
  io.stdout:write(json.encode({ok=false, errors={"no lua path specified"}}) .. "\n")
  os.exit(1)
end

-- Adler-32 hash
local function adler32(data)
  local a, b = 1, 0
  for i = 1, #data do
    a = (a + data:byte(i)) % 65521
    b = (b + a) % 65521
  end
  return b * 65536 + a
end

-- 计算 luaExe 的 hash (size + 内容前 4KB 的 adler32)
local function computeHash(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open" end
  local size = f:seek("end")
  f:seek("set", 0)
  local head = f:read(4096) or ""
  f:close()
  return string.format("%d:%d", size, adler32(head))
end

-- 通过 io.popen 执行 Lua 代码片段
local function runLuaSnippet(luaPath, code)
  local tmpFile = os.tmpname and os.tmpname() or "/tmp/lua_check_snippet"
  local f = io.open(tmpFile, "w")
  if not f then return nil, "cannot write tmp file" end
  f:write(code)
  f:close()
  local pipe = io.popen('"' .. luaPath .. '" "' .. tmpFile .. '"', "r")
  if not pipe then os.remove(tmpFile); return nil, "cannot execute" end
  local output = pipe:read("*a")
  local ok = pipe:close()
  os.remove(tmpFile)
  return output, ok
end

local hash = computeHash(target)
local result = {
  ok = false,
  hash = hash,
  path = target,
  version = nil,
  libs = {},
  errors = {},
}

-- 1. 检查文件存在
if not hash then
  result.errors[1] = "file not found or unreadable"
  io.stdout:write(json.encode(result) .. "\n")
  os.exit(1)
end

-- 2. 获取版本
local versionOutput = runLuaSnippet(target, [[
  print("VERSION:" .. _VERSION)
  print("HAS_BIT32:" .. tostring(bit32 ~= nil))
  print("HAS_IO_POPEN:" .. tostring(io.popen ~= nil))
  print("HAS_OS_EXECUTE:" .. tostring(os.execute ~= nil))
  print("HAS_MATH_RANDOM:" .. tostring(math.random ~= nil))
  print("HAS_STRING_FORMAT:" .. tostring(string.format ~= nil))
  print("HAS_UTF8:" .. tostring(utf8 ~= nil))
  print("HAS_TABLE_PACK:" .. tostring(table.pack ~= nil))
  -- Lua 5.3+ 才有 // 整除运算符, 5.1/5.2 没有 (但 emulator 自带 polyfill)
  local fn = load("return 1 // 2")
  print("HAS_BITOP:" .. tostring(fn ~= nil))
  print("TEST:" .. string.format("%d", 42))
]])

if not versionOutput then
  result.errors[1] = "cannot execute lua"
  io.stdout:write(json.encode(result) .. "\n")
  os.exit(1)
end

-- 解析输出
for line in versionOutput:gmatch("[^\r\n]+") do
  local key, val = line:match("^([^:]+):(.*)$")
  if key then
    if key == "VERSION" then
      result.version = val
      -- 接受 Lua 5.1+ (emulator 自带 bit32 / table.pack polyfill)
      local major, minor = val:match("Lua (5)%.(%d)")
      if major and minor then
        local mi = tonumber(minor)
        if mi >= 1 then result.ok = true
        else result.errors[1] = "need Lua 5.1+, got " .. val end
      else
        result.errors[1] = "unknown version: " .. val
      end
    elseif key:match("^HAS_") then
      result.libs[key:sub(5)] = (val == "true")
    end
  end
end

-- 3. 检查必需库
local required = {"IO_POPEN", "OS_EXECUTE", "MATH_RANDOM", "STRING_FORMAT"}
for _, req in ipairs(required) do
  if result.libs[req] == false then
    result.ok = false
    table.insert(result.errors, "missing: " .. req)
  end
end

result.checkedAt = os.date("%Y-%m-%dT%H:%M:%S")

io.stdout:write(json.encode(result) .. "\n")
