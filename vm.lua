-- ============================================================
-- OC Emulator 虚拟机文件模块
-- .ocvm 格式 (OpenComputers Virtual Machine)
--
-- 格式:
--   Header (16 bytes):
--     Magic:    "OCVM" (4 bytes)
--     Version:  1 byte
--     CfgLen:   4 bytes (uint32 BE, 配置长度)
--     DskLen:   4 bytes (uint32 BE, 磁盘数据长度)
--     Reserved: 3 bytes
--   Body:
--     Config (Lua 序列化)
--     Disk   (.ocd 磁盘镜像, 已压缩)
-- ============================================================

local vm = {}

local MAGIC = "OCVM"
local VERSION = 1
local HEADER_SIZE = 16

-- OC 模组等级配置表
vm.TIERS = {
  cpu = {
    [1] = { name = "Tier 1 (x86)", speed = 1, desc = "基础 CPU" },
    [2] = { name = "Tier 2 (x86)", speed = 2, desc = "双核 CPU" },
    [3] = { name = "Tier 3 (x86)", speed = 4, desc = "四核 CPU" },
  },
  ram = {
    [1]   = { name = "Tier 1 (192KB)",   size = 192 * 1024 },
    [1.5] = { name = "Tier 1.5 (256KB)", size = 256 * 1024 },
    [2]   = { name = "Tier 2 (384KB)",   size = 384 * 1024 },
    [2.5] = { name = "Tier 2.5 (512KB)", size = 512 * 1024 },
    [3]   = { name = "Tier 3 (768KB)",   size = 768 * 1024 },
    [3.5] = { name = "Tier 3.5 (1MB)",   size = 1024 * 1024 },
  },
  gpu = {
    [1] = { name = "Tier 1", width = 50,  height = 16, depth = 1 },
    [2] = { name = "Tier 2", width = 80,  height = 25, depth = 4 },
    [3] = { name = "Tier 3", width = 160, height = 50, depth = 8 },
  },
  screen = {
    [1] = { name = "Tier 1", width = 50,  height = 16 },
    [2] = { name = "Tier 2", width = 80,  height = 25 },
    [3] = { name = "Tier 3", width = 160, height = 50 },
  },
  hdd = {
    [1] = { name = "Tier 1 (1MB)", size = 1 * 1024 * 1024 },
    [2] = { name = "Tier 2 (2MB)", size = 2 * 1024 * 1024 },
    [3] = { name = "Tier 3 (4MB)", size = 4 * 1024 * 1024 },
    [4] = { name = "Tier 4 (8MB)", size = 8 * 1024 * 1024 },
  },
}

-- uint32 编码/解码 (big-endian)
local function packUint32(n)
  return string.char(
    math.floor(n / 0x1000000) % 256,
    math.floor(n / 0x10000) % 256,
    math.floor(n / 0x100) % 256,
    n % 256
  )
end

local function unpackUint32(s, pos)
  local b1, b2, b3, b4 = s:byte(pos, pos + 3)
  return b1 * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4
end

-- 序列化配置表
local function serializeConfig(cfg)
  local lines = {}
  table.insert(lines, "return {")
  for k, v in pairs(cfg) do
    if type(v) == "string" then
      table.insert(lines, string.format("  %s = %q,", k, v))
    elseif type(v) == "number" then
      table.insert(lines, string.format("  %s = %s,", k, v))
    elseif type(v) == "boolean" then
      table.insert(lines, string.format("  %s = %s,", k, tostring(v)))
    end
  end
  table.insert(lines, "}")
  return table.concat(lines, "\n")
end

local function deserializeConfig(data)
  -- 兼容 Lua 5.1 (loadstring) 和 5.2+ (load)
  local loadfunc = loadstring or load
  local fn, err = loadfunc(data)
  if not fn then return nil, err end
  local ok, result = pcall(fn)
  if not ok then return nil, result end
  return result
end

-- 保存 VM 文件
-- @param path  输出路径
-- @param cfg   配置表
-- @param diskData .ocd 磁盘镜像数据 (字符串)
function vm.save(path, cfg, diskData)
  cfg = cfg or {}
  diskData = diskData or ""

  local configStr = serializeConfig(cfg)
  local header = MAGIC .. string.char(VERSION) .. packUint32(#configStr) .. packUint32(#diskData) .. string.rep("\0", 3)

  local f = io.open(path, "wb")
  if not f then return false, "cannot open file for writing" end
  f:write(header)
  f:write(configStr)
  f:write(diskData)
  f:close()
  return true
end

-- 加载 VM 文件
-- @param path .ocvm 文件路径
-- @return config表, diskData(字符串)
function vm.load(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end

  local header = f:read(HEADER_SIZE)
  if not header or #header < HEADER_SIZE then
    f:close()
    return nil, "invalid header"
  end

  if header:sub(1, 4) ~= MAGIC then
    f:close()
    return nil, "not an OCVM file"
  end

  local version = header:byte(5)
  local cfgLen = unpackUint32(header, 6)
  local dskLen = unpackUint32(header, 10)

  local configData = f:read(cfgLen)
  local diskData = f:read(dskLen)
  f:close()

  if not configData or #configData < cfgLen then
    return nil, "config section truncated"
  end

  local config, err = deserializeConfig(configData)
  if not config then return nil, "cannot parse config: " .. tostring(err) end

  return config, diskData or ""
end

-- 创建默认配置
function vm.defaultConfig(name)
  return {
    name = name or "NewVM",
    cpuTier = 3,
    ramSize = 768 * 1024,
    gpuTier = 3,
    screenWidth = 160,
    screenHeight = 50,
    gpuDepth = 8,
    screenTier = 3,
    hddSize = 4 * 1024 * 1024,
    osType = "openos",
    eepromFile = "",
    created = os.date("%Y-%m-%d %H:%M:%S"),
  }
end

-- 获取等级信息
function vm.getTierInfo(category, tier)
  local cat = vm.TIERS[category]
  if not cat then return nil end
  -- 支持 1.5, 2.5 等半级 (传入字符串)
  if type(tier) == "string" then
    return cat[tonumber(tier)] or cat[tier]
  end
  return cat[tier]
end

return vm
