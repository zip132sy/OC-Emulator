-- ============================================================
-- Lua interpreter check module (with hash cache)
-- Usage: lua lua_check.lua <path-to-lua-executable>
-- Output: a single JSON line on stdout
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

-- Hash of the Lua executable: size + Adler-32 of the first 4 KB
local function computeHash(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open" end
  local size = f:seek("end")
  f:seek("set", 0)
  local head = f:read(4096) or ""
  f:close()
  return string.format("%d:%d", size, adler32(head))
end

-- Run a Lua snippet through io.popen
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

-- 1. Check that the file exists
if not hash then
  result.errors[1] = "file not found or unreadable"
  io.stdout:write(json.encode(result) .. "\n")
  os.exit(1)
end

-- 2. Get the version
local versionOutput = runLuaSnippet(target, [[
  print("VERSION:" .. _VERSION)
  print("HAS_BIT32:" .. tostring(bit32 ~= nil))
  print("HAS_IO_POPEN:" .. tostring(io.popen ~= nil))
  print("HAS_OS_EXECUTE:" .. tostring(os.execute ~= nil))
  print("HAS_MATH_RANDOM:" .. tostring(math.random ~= nil))
  print("HAS_STRING_FORMAT:" .. tostring(string.format ~= nil))
  print("HAS_UTF8:" .. tostring(utf8 ~= nil))
  print("HAS_TABLE_PACK:" .. tostring(table.pack ~= nil))
  -- Integer division (//) exists from Lua 5.3 on; the emulator ships a polyfill.
  local fn = load("return 1 // 2")
  print("HAS_BITOP:" .. tostring(fn ~= nil))
  print("TEST:" .. string.format("%d", 42))
]])

if not versionOutput then
  result.errors[1] = "cannot execute lua"
  io.stdout:write(json.encode(result) .. "\n")
  os.exit(1)
end

-- Parse the output
for line in versionOutput:gmatch("[^\r\n]+") do
  local key, val = line:match("^([^:]+):(.*)$")
  if key then
    if key == "VERSION" then
      result.version = val
      -- Accept Lua 5.1+ (the emulator ships bit32 / table.pack polyfills)
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

-- 3. Check required libraries
local required = {"IO_POPEN", "OS_EXECUTE", "MATH_RANDOM", "STRING_FORMAT"}
for _, req in ipairs(required) do
  if result.libs[req] == false then
    result.ok = false
    table.insert(result.errors, "missing: " .. req)
  end
end

result.checkedAt = os.date("%Y-%m-%dT%H:%M:%S")

io.stdout:write(json.encode(result) .. "\n")
