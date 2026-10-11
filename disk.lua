-- ============================================================
-- OC Emulator 磁盘镜像模块
-- .ocd 格式 v4 - 加密压缩磁盘镜像
--
-- 本质: 特殊格式的加密压缩包
--   - 使用自定义 "OCDISK" 魔数, 普通解压软件 (7-Zip/WinRAR) 无法识别
--   - 内容经 LZW 压缩 + 16 字节滚动密钥 XOR 加密
--   - 加密后数据呈现随机字节分布, 无法直接阅读
--
-- 格式:
--   Header (40 bytes, v4):
--     Magic:   "OCDISK" (6 bytes)
--     Version: 1 byte (4)
--     Flags:   1 byte (bit0=compressed, bit1=locked, bit2=tier, bit3=encrypt_v2)
--     Label:   16 bytes (null-padded)
--     Size:    4 bytes (uint32 BE, disk capacity)
--     Files:   4 bytes (uint32 BE, file count)
--     Tier:    1 byte
--     UnlockToken: 4 bytes (reserved)
--     Reserved: 3 bytes
--   Body (LZW compressed, then encrypted):
--     For each file:
--       PathLen:  2 bytes (uint16 BE)
--       Path:     N bytes (UTF-8)
--       Type:     1 byte (0=file, 1=dir)
--       DataLen:  4 bytes (uint32 BE)
--       Data:     N bytes (raw content)
--       Modified: 8 bytes (double, Lua number format)
--
-- EEPROM 格式 (.oce):
--   Header (25 bytes):
--     Magic:   "OCEEPROM" (8 bytes)
--     Version: 1 byte
--     Label:   16 bytes (null-padded)
--   Body:
--     文本内容 (最大 4096 字节)
-- ============================================================

local disk = {}

local MAGIC = "OCDISK"
local VERSION = 4              -- v4: 支持 lock/unlock + tier + 加密
local HEADER_SIZE = 36         -- v3 header
local HEADER_SIZE_V4 = 40     -- v4 header (新增 tier+unlockToken)
local FLAG_COMPRESSED = 1
local FLAG_LOCKED = 2          -- v4: 磁盘锁定
local FLAG_TIER = 4            -- v4: tier 字段有效
local FLAG_ENCRYPT_V2 = 8      -- v4: 16 字节滚动密钥加密

-- tier 容量上限 (OC 模组标准)
local TIER_LIMITS = {
  [1] = 1 * 1024 * 1024,   -- T1: 1MB
  [2] = 2 * 1024 * 1024,   -- T2: 2MB
  [3] = 4 * 1024 * 1024,   -- T3: 4MB
}

local EEPROM_MAGIC = "OCEEPROM"
local EEPROM_VERSION = 1
local EEPROM_HEADER_SIZE = 25
local EEPROM_MAX_SIZE = 4096

-- ============================================================
-- 二进制编码/解码工具
-- ============================================================

-- Lua 5.1 兼容: 位运算 - 查表法 (高效)
-- 预计算 256x256 XOR 表 (启动时一次, 后续 O(1))
local xorTable = {}
for i = 0, 255 do
  xorTable[i] = {}
  for j = 0, 255 do
    local r, p = 0, 1
    for _ = 0, 7 do
      if math.floor(i / p) % 2 ~= math.floor(j / p) % 2 then
        r = r + p
      end
      p = p * 2
    end
    xorTable[i][j] = r
  end
end

local function rshift(n, b) return math.floor(n / (2 ^ b)) end
local function lshift(n, b) return n * (2 ^ b) end

-- AND: 只需要 mask 到 0xFF (字节级)
local function band(a, b)
  if b == 0xFF then return a % 256 end
  if a == 0xFF then return b % 256 end
  -- 通用: 逐位 AND (仅用于小数值)
  local r, p = 0, 1
  for _ = 0, 7 do
    if math.floor(a / p) % 2 == 1 and math.floor(b / p) % 2 == 1 then
      r = r + p
    end
    p = p * 2
  end
  return r
end

-- OR: 组合高低字节 (a = hi*256 + lo)
local function bor(a, b)
  return a + b  -- 仅当 a 和 b 不重叠时 (如 a=hi*256, b=lo)
end

-- 快速 XOR (字节级, 使用查表)
local function bxor(a, b)
  if a <= 255 and b <= 255 then
    return xorTable[a][b]
  end
  -- 大数值: 分高低字节分别 XOR
  local al = a % 256
  local ah = math.floor(a / 256) % 256
  local bl = b % 256
  local bh = math.floor(b / 256) % 256
  return xorTable[ah][bh] * 256 + xorTable[al][bl]
end

local function packU16(n)
  return string.char(band(rshift(n, 8), 0xFF), band(n, 0xFF))
end

local function unpackU16(s, pos)
  local b1, b2 = s:byte(pos, pos + 1)
  return bor(lshift(b1, 8), b2)
end

local function packU32(n)
  return string.char(
    band(rshift(n, 24), 0xFF),
    band(rshift(n, 16), 0xFF),
    band(rshift(n, 8), 0xFF),
    band(n, 0xFF)
  )
end

local function unpackU32(s, pos)
  local b1, b2, b3, b4 = s:byte(pos, pos + 3)
  return bor(bor(lshift(b1, 24), lshift(b2, 16)), bor(lshift(b3, 8), b4))
end

-- ============================================================
-- LZW 压缩/解压 (固定 16-bit 码字) + 加密
-- ============================================================

-- 旧版 XOR 密钥 (兼容 v3/旧 v4 磁盘, 不可删除)
local XOR_KEY_V1 = 0xA5

-- 新版 16 字节滚动密钥 (让加密后数据呈现随机分布, 无法直接阅读)
-- 密钥选择不可预测的常量, 加上磁盘 label 混入, 每张盘密钥不同
local XOR_KEY_V2 = { 0x4F, 0x43, 0x45, 0x4D, 0x75, 0x6C, 0x61, 0x74,
                     0x6F, 0x72, 0x21, 0x39, 0x41, 0x7E, 0xC3, 0x5B }

-- 从磁盘 label 生成 16 字节盐值 (每张盘不同)
-- 注意: 标签为空时也必须能算出确定性的盐值。空标签下 labelBytes 为空表,
-- (i - 1) % #labelBytes 就是 % 0, Lua 会直接抛 "attempt to perform 'n%0'",
-- 表现为"改标签/保存磁盘时报 WARNING: save ... failed"。
local function deriveLabelSalt(label)
  local salt = {}
  local labelBytes = { string.byte(label, 1, #label) }
  if #labelBytes == 0 then labelBytes = { 0 } end
  for i = 1, 16 do
    local lb = labelBytes[(i - 1) % #labelBytes + 1] or 0
    -- 简单 hash: 位置相关 + label 字节
    salt[i] = bxor(bxor(lb, (i * 37) % 256), XOR_KEY_V2[i])
  end
  return salt
end

-- 旧版加密: 单字节 XOR (兼容旧磁盘)
local function xorTransformV1(data)
  local result = {}
  for i = 1, #data do
    result[i] = string.char(bxor(data:byte(i), XOR_KEY_V1))
  end
  return table.concat(result)
end

-- 新版加密: 16 字节滚动密钥 + label 盐值
-- data: 要加密/解密的字符串
-- label: 磁盘标签 (用于生成盐值)
local function xorTransformV2(data, label)
  local salt = deriveLabelSalt(label or "")
  local result = {}
  for i = 1, #data do
    local keyByte = salt[((i - 1) % 16) + 1]
    -- 每 256 字节额外混入位置信息, 增强抗分析能力
    local posByte = bxor((i % 256), (math.floor(i / 256) % 256))
    result[i] = string.char(bxor(bxor(data:byte(i), keyByte), bxor(posByte, (i * 7) % 256)))
  end
  return table.concat(result)
end

-- LZW 纯压缩 (不做加密, 加密由调用方处理)
local function lzwCompressRaw(input)
  if #input == 0 then return "" end
  local dict = {}
  local dictSize = 256
  for i = 0, 255 do dict[string.char(i)] = i end

  local w = ""
  local result = {}

  for i = 1, #input do
    local c = input:sub(i, i)
    local wc = w .. c
    if dict[wc] then
      w = wc
    else
      local code = dict[w]
      result[#result + 1] = packU16(code)
      if dictSize < 65536 then
        dict[wc] = dictSize
        dictSize = dictSize + 1
      end
      w = c
    end
  end
  if w ~= "" then
    result[#result + 1] = packU16(dict[w])
  end
  return table.concat(result)
end

-- LZW 纯解压 (不做解密, 解密由调用方处理)
local function lzwDecompressRaw(input)
  if #input == 0 then return "" end
  if #input % 2 == 1 then input = input .. "\0" end

  local dict = {}
  local dictSize = 256
  for i = 0, 255 do dict[i] = string.char(i) end

  local result = {}
  local pos = 1

  local function readCode()
    if pos > #input then return nil end
    local b1, b2 = input:byte(pos, pos + 1)
    pos = pos + 2
    return bor(lshift(b1, 8), b2)
  end

  local firstCode = readCode()
  if firstCode == nil then return "" end
  local w = dict[firstCode]
  if not w then return "" end
  result[#result + 1] = w

  while true do
    local k = readCode()
    if k == nil then break end
    local entry
    if dict[k] then
      entry = dict[k]
    elseif k == dictSize then
      entry = w .. w:sub(1, 1)
    else
      break
    end
    result[#result + 1] = entry
    if dictSize < 65536 then
      dict[dictSize] = w .. entry:sub(1, 1)
      dictSize = dictSize + 1
    end
    w = entry
  end
  return table.concat(result)
end

-- 兼容接口: 旧版 LZW 压缩 + 单字节 XOR (用于 saveV3)
local function lzwCompress(input)
  return xorTransformV1(lzwCompressRaw(input))
end

-- 兼容接口: 旧版 LZW 解压 + 单字节 XOR (用于加载旧磁盘)
local function lzwDecompress(input)
  if #input == 0 then return "" end
  return lzwDecompressRaw(xorTransformV1(input))
end

-- ============================================================
-- 二进制文件系统序列化 (纯二进制, 非文本)
-- ============================================================

local function serializeFSBinary(files)
  local parts = {}
  local count = 0
  for path, info in pairs(files) do
    count = count + 1
    local content = info.content or ""
    local pathBytes = path
    local modified = info.modified or 0

    -- 路径长度 (2 bytes) + 路径 + 类型 (1 byte) + 数据长度 (4 bytes) + 数据 + 修改时间 (8 bytes)
    -- Lua 5.1/5.3 兼容: 用整数的二进制表示 (8 字节, little-endian)
    local modBytes = ""
    local m = math.floor(tonumber(modified) or 0)
    for i = 1, 8 do
      modBytes = modBytes .. string.char(math.floor(m % 256))
      m = math.floor(m / 256)
    end
    local entry = packU16(#pathBytes) .. pathBytes .. string.char((info.type == "dir" or info.type == "directory") and 1 or 0) .. packU32(#content) .. content .. modBytes
    parts[#parts + 1] = entry
  end
  return table.concat(parts), count
end

local function deserializeFSBinary(data)
  local files = {}
  local pos = 1
  while pos <= #data do
    if pos + 2 > #data then break end
    local pathLen = unpackU16(data, pos)
    pos = pos + 2
    if pos + pathLen > #data + 1 then break end
    local path = data:sub(pos, pos + pathLen - 1)
    pos = pos + pathLen

    if pos + 5 > #data then break end
    local fileType = data:byte(pos)
    pos = pos + 1
    local dataLen = unpackU32(data, pos)
    pos = pos + 4

    if pos + dataLen > #data + 1 then break end
    local content = data:sub(pos, pos + dataLen - 1)
    pos = pos + dataLen

    local modified = 0
    if pos + 8 <= #data + 1 then
      -- Lua 5.1 兼容: 手动读取 8 字节 little-endian 整数
      local m = 0
      for i = 7, 0, -1 do
        m = m * 256 + data:byte(pos + i)
      end
      modified = m
      pos = pos + 8
    end

    files[path] = {
      type = (fileType == 1) and "directory" or "file",
      content = content,
      modified = modified,
    }
  end
  return files
end

-- ============================================================
-- 磁盘保存/加载
-- ============================================================

-- 原子写入: 先写临时文件再改名。
-- 模拟器现在会周期性把磁盘写回文件 (写穿), 若直接原地覆盖, 进程在写一半时
-- 被杀掉就会留下一个截断/损坏的镜像 —— 安装成果同样会丢。
-- 先写临时文件可以保证磁盘文件要么是旧的完整内容, 要么是新的完整内容。
local function writeFileAtomic(path, data)
  local tmp = path .. ".tmp"
  local f = io.open(tmp, "wb")
  if not f then return false, "cannot open temp file for writing" end
  local ok = f:write(data)
  f:close()
  if not ok then
    os.remove(tmp)
    return false, "write failed"
  end
  -- Windows 的 rename 不能覆盖已存在文件, 先删目标再改名 (窗口极短)
  os.remove(path)
  local renamed, err = os.rename(tmp, path)
  if not renamed then
    os.remove(tmp)
    return false, err or "rename failed"
  end
  return true
end

-- v4 保存: 支持 tier + locked 参数 + V2 加密
-- @param path     输出路径
-- @param label    磁盘标签
-- @param files    文件表
-- @param size     磁盘容量 (字节)
-- @param tier     等级 1/2/3 (可选, 默认 3)
-- @param locked   是否锁定 (可选, 默认 false)
function disk.save(path, label, files, size, tier, locked)
  label = label or "Untitled"
  size = size or (4 * 1024 * 1024)
  files = files or {}
  tier = tier or 3
  locked = locked or false

  -- tier 容量校验
  local maxTier = TIER_LIMITS[tier] or TIER_LIMITS[3]
  if size > maxTier then
    return false, string.format("size %d exceeds tier %d limit %d", size, tier, maxTier)
  end

  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)

  -- 二进制序列化
  local body, fileCount = serializeFSBinary(files)

  -- LZW 压缩 (纯压缩, 不含加密)
  local compressed = lzwCompressRaw(body)
  local flags = bxor(FLAG_COMPRESSED, FLAG_ENCRYPT_V2)

  -- 只在压缩后更小时使用压缩 (但仍加密)
  if #compressed >= #body then
    -- 压缩无优势, 存储原始数据但仍加密
    compressed = body
    flags = FLAG_ENCRYPT_V2  -- 不设 COMPRESSED, 但设 ENCRYPT_V2
  end

  -- V2 加密: 16 字节滚动密钥 + label 盐值
  compressed = xorTransformV2(compressed, label)

  -- v4 flags
  if locked then flags = bxor(flags, FLAG_LOCKED) end
  flags = bxor(flags, FLAG_TIER)  -- tier 字段有效

  -- v4 header (40 bytes): Magic(6) + Ver(1) + Flags(1) + Label(16) + Size(4) + FileCount(4) + Tier(1) + UnlockToken(4) + Reserved(3)
  local header = MAGIC .. string.char(VERSION) .. string.char(flags) .. labelPadded .. packU32(size) .. packU32(fileCount) .. string.char(tier) .. packU32(0) .. string.rep("\0", 3)

  return writeFileAtomic(path, header .. compressed)
end

-- v4 兼容旧调用: disk.save(path, label, files, size) 不传 tier/locked 时默认 tier=3, locked=false
-- (Lua 函数参数可选, 上方已处理)

-- v3 保存 (用于向后兼容导出)
function disk.saveV3(path, label, files, size)
  label = label or "Untitled"
  size = size or (4 * 1024 * 1024)
  files = files or {}

  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)

  local body, fileCount = serializeFSBinary(files)
  local compressed = lzwCompress(body)
  local flags = FLAG_COMPRESSED
  if #compressed >= #body then
    flags = 0
    compressed = body
  end

  local header = MAGIC .. string.char(3) .. string.char(flags) .. labelPadded .. packU32(size) .. packU32(fileCount) .. string.rep("\0", 4)

  return writeFileAtomic(path, header .. compressed)
end

function disk.load(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end

  local magic_ver = f:read(7)
  if not magic_ver or #magic_ver < 7 then
    f:close()
    return nil, "invalid header"
  end

  if magic_ver:sub(1, 6) ~= MAGIC then
    f:close()
    return nil, "not an OCD disk image"
  end

  local version = magic_ver:byte(7)

  if version == 4 then
    -- v4: 支持 lock/unlock + tier + V2 加密
    local rest = f:read(HEADER_SIZE_V4 - 7)
    if not rest or #rest < HEADER_SIZE_V4 - 7 then
      f:close()
      return nil, "invalid v4 header"
    end
    local flags = rest:byte(1)
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local fileCount = unpackU32(rest, 22)
    local tier = rest:byte(26)
    if tier == 0 then tier = 3 end  -- 兼容未设 tier

    local locked = band(flags, FLAG_LOCKED) ~= 0
    local body = f:read("*a")
    f:close()

    if locked then
      -- 锁定状态: 只返回 header 信息, files=nil
      return {
        label = label, size = size, tier = tier, version = 4,
        flags = flags, files = nil, locked = true, fileCount = fileCount
      }
    end

    -- 判断加密版本 (V2 加密使用 16 字节滚动密钥, V1 是旧版单字节 XOR)
    local useEncryptV2 = band(flags, FLAG_ENCRYPT_V2) ~= 0
    local useCompressed = band(flags, FLAG_COMPRESSED) ~= 0

    if useEncryptV2 then
      -- V2 加密: 16 字节滚动密钥 + label 盐值 (对称, 同函数解密)
      body = xorTransformV2(body, label)
      if useCompressed then
        body = lzwDecompressRaw(body)
      end
    else
      -- V1 兼容模式: 旧版 XOR_V1 内嵌于 lzwDecompress, 仅在压缩时生效
      if useCompressed then
        body = lzwDecompress(body)  -- 包含 XOR_V1 解密 + LZW 解压
      end
      -- 未压缩的旧 v4 磁盘: body 是原始数据, 无需处理
    end

    local files = deserializeFSBinary(body)
    return {
      label = label, size = size, tier = tier, version = 4,
      flags = flags, files = files, locked = false, fileCount = fileCount
    }

  elseif version == 3 then
    -- v3: 纯二进制格式
    local rest = f:read(HEADER_SIZE - 7)
    if not rest or #rest < HEADER_SIZE - 7 then
      f:close()
      return nil, "invalid v3 header"
    end
    local flags = rest:byte(1)
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local fileCount = unpackU32(rest, 22)

    local body = f:read("*a")
    f:close()

    if flags % 2 == 1 then
      body = lzwDecompress(body)
    end

    local files = deserializeFSBinary(body)
    return { label = label, size = size, version = version, flags = flags, files = files }

  elseif version == 2 then
    -- v2: LZW 压缩的 Lua 表序列化 (兼容)
    local rest = f:read(30)
    if not rest or #rest < 30 then f:close(); return nil, "invalid v2 header" end
    local flags = rest:byte(1)
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local body = f:read("*a")
    f:close()
    if flags % 2 == 1 then body = lzwDecompress(body) end
    -- v2 用 Lua 表格式
    local fn, err = load(body)
    if not fn then return nil, "cannot parse v2 content: " .. tostring(err) end
    local ok, result = pcall(fn)
    if not ok then return nil, result end
    return { label = label, size = size, version = version, flags = flags, files = result }

  elseif version == 1 then
    -- v1: 无压缩 Lua 表序列化 (兼容)
    local rest = f:read(29)
    if not rest or #rest < 29 then f:close(); return nil, "invalid v1 header" end
    local label = rest:sub(1, 16):match("^%Z*") or ""
    local size = unpackU32(rest, 17)
    local body = f:read("*a")
    f:close()
    local fn, err = load(body)
    if not fn then return nil, "cannot parse v1 content: " .. tostring(err) end
    local ok, result = pcall(fn)
    if not ok then return nil, result end
    return { label = label, size = size, version = version, flags = 0, files = result }
  else
    f:close()
    return nil, "unsupported version: " .. version
  end
end

function disk.createEmpty(label, size, tier)
  return {
    label = label or "Untitled",
    size = size or (4 * 1024 * 1024),
    tier = tier or 3,
    files = {},
    locked = false,
  }
end

-- ============================================================
-- v4 锁定/解锁/格式化 操作
-- ============================================================

-- 仅修改 header 的 flags 字段 (不改动 body)
local function rewriteFlags(path, newFlags)
  local f = io.open(path, "r+b")
  if not f then return false, "cannot open file" end
  -- flags 在 offset 7 (Magic(6) + Version(1) = 7, flags 在第 8 字节即 index 8)
  -- 但 Lua string 索引从 1 开始, 读 7 字节后 flags 在第 8 字节
  f:seek("set", 7)  -- 跳过 Magic(6) + Version(1)
  f:write(string.char(newFlags))
  f:close()
  return true
end

-- 读取当前 flags (不加载整个磁盘)
local function readFlags(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  f:seek("set", 7)  -- flags 在 offset 7
  local b = f:read(1)
  f:close()
  if not b then return nil end
  return b:byte(1)
end

function disk.lock(path)
  local flags = readFlags(path)
  if not flags then return false, "cannot read disk" end
  if band(flags, FLAG_LOCKED) ~= 0 then return true end  -- 已锁
  return rewriteFlags(path, bxor(flags, FLAG_LOCKED))
end

function disk.unlock(path)
  local flags = readFlags(path)
  if not flags then return false, "cannot read disk" end
  if band(flags, FLAG_LOCKED) == 0 then return true end  -- 已解锁
  return rewriteFlags(path, band(flags, bxor(0xFF, FLAG_LOCKED)))
end

function disk.isLocked(path)
  local flags = readFlags(path)
  if not flags then return nil, "cannot read disk" end
  return band(flags, FLAG_LOCKED) ~= 0
end

-- 格式化: 清空所有文件, 保留 label/size/tier
function disk.format(path)
  local info = disk.load(path)
  if not info then return false, "cannot load disk" end
  -- 先解锁 (format 需要读取 files)
  if info.locked then
    disk.unlock(path)
    info = disk.load(path)
    if not info then return false, "cannot load after unlock" end
  end
  -- 保存空磁盘
  local ok, err = disk.save(path, info.label, {}, info.size, info.tier, false)
  return ok, err
end

-- 获取磁盘信息 (不解锁, 只读 header)
function disk.getInfo(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end
  local magic_ver = f:read(7)
  if not magic_ver or magic_ver:sub(1,6) ~= MAGIC then
    f:close(); return nil, "not an OCD disk image"
  end
  local version = magic_ver:byte(7)
  if version == 4 then
    local rest = f:read(HEADER_SIZE_V4 - 7)
    f:close()
    if not rest or #rest < HEADER_SIZE_V4 - 7 then return nil, "invalid v4 header" end
    local flags = rest:byte(1)
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local fileCount = unpackU32(rest, 22)
    local tier = rest:byte(26)
    if tier == 0 then tier = 3 end
    return {
      label = label, size = size, tier = tier, version = 4,
      fileCount = fileCount, locked = band(flags, FLAG_LOCKED) ~= 0,
      encrypted = band(flags, FLAG_ENCRYPT_V2) ~= 0,
      compressed = band(flags, FLAG_COMPRESSED) ~= 0
    }
  elseif version == 3 then
    local rest = f:read(HEADER_SIZE - 7)
    f:close()
    if not rest or #rest < HEADER_SIZE - 7 then return nil, "invalid v3 header" end
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local fileCount = unpackU32(rest, 22)
    return { label = label, size = size, tier = 3, version = 3, fileCount = fileCount, locked = false }
  else
    f:close()
    return nil, "unsupported version: " .. version
  end
end

disk.TIER_LIMITS = TIER_LIMITS
disk.FLAG_LOCKED = FLAG_LOCKED
disk.FLAG_COMPRESSED = FLAG_COMPRESSED
disk.FLAG_ENCRYPT_V2 = FLAG_ENCRYPT_V2
disk.HEADER_SIZE_V4 = HEADER_SIZE_V4
disk.VERSION = VERSION

-- ============================================================
-- 软盘镜像 (.ocf) - 与磁盘 .ocd 格式区分
-- ============================================================
-- 格式:
--   Header (36 bytes):
--     Magic:      "OCFLOPPY" (8 bytes)
--     Version:    1 byte
--     Flags:      1 byte (bit0=compressed, bit1=locked, bit3=encrypt_v2)
--     Label:      16 bytes (null-padded)
--     Size:       4 bytes (uint32 BE, 软盘容量, 固定 512KB)
--     FileCount:  4 bytes (uint32 BE)
--   Body (LZW compressed, then encrypted):
--     与 .ocd 相同的文件序列化格式
-- ============================================================

local FLOPPY_MAGIC = "OCFLOPPY"
local FLOPPY_VERSION = 1
local FLOPPY_HEADER_SIZE = 36
local FLOPPY_DEFAULT_SIZE = 2048 * 1024  -- 2MB (足够容纳完整 OpenOS)

function disk.saveFloppy(path, label, files, size, locked)
  label = label or "Floppy"
  size = size or FLOPPY_DEFAULT_SIZE
  files = files or {}
  locked = locked or false

  -- 软盘容量限制: 最大 512KB
  if size > FLOPPY_DEFAULT_SIZE then
    size = FLOPPY_DEFAULT_SIZE
  end

  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)

  -- 二进制序列化
  local body, fileCount = serializeFSBinary(files)

  -- LZW 压缩 (纯压缩, 不含加密)
  local compressed = lzwCompressRaw(body)
  local flags = bxor(FLAG_COMPRESSED, FLAG_ENCRYPT_V2)

  -- 只在压缩后更小时使用压缩
  if #compressed >= #body then
    compressed = body
    flags = FLAG_ENCRYPT_V2
  end

  -- V2 加密
  compressed = xorTransformV2(compressed, label)

  if locked then flags = bxor(flags, FLAG_LOCKED) end

  -- Header: Magic(8) + Ver(1) + Flags(1) + Label(16) + Size(4) + FileCount(4) = 34
  -- 补齐到 36 字节 (加 2 字节 reserved)
  local header = FLOPPY_MAGIC .. string.char(FLOPPY_VERSION) .. string.char(flags) ..
                 labelPadded .. packU32(size) .. packU32(fileCount) .. string.rep("\0", 2)

  return writeFileAtomic(path, header .. compressed)
end

function disk.loadFloppy(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end

  local header = f:read(FLOPPY_HEADER_SIZE)
  if not header or #header < FLOPPY_HEADER_SIZE then
    f:close()
    return nil, "invalid floppy header"
  end

  if header:sub(1, 8) ~= FLOPPY_MAGIC then
    f:close()
    return nil, "not an OCF floppy image (wrong magic number)"
  end

  local version = header:byte(9)
  local flags = header:byte(10)
  local label = header:sub(11, 26):match("^%Z*") or ""
  local size = unpackU32(header, 27)
  local fileCount = unpackU32(header, 31)
  local locked = band(flags, FLAG_LOCKED) ~= 0

  local body = f:read("*a")
  f:close()

  local useEncryptV2 = band(flags, FLAG_ENCRYPT_V2) ~= 0
  local useCompressed = band(flags, FLAG_COMPRESSED) ~= 0

  if useEncryptV2 then
    body = xorTransformV2(body, label)
    if useCompressed then
      body = lzwDecompressRaw(body)
    end
  else
    if useCompressed then
      body = lzwDecompress(body)
    end
  end

  local files = deserializeFSBinary(body)
  return {
    label = label, size = size, version = version,
    flags = flags, files = files, locked = locked, fileCount = fileCount
  }
end

function disk.formatFloppy(path)
  local info = disk.loadFloppy(path)
  if not info then return false, "cannot load floppy" end
  if info.locked then
    -- 解锁后 format
    local f = io.open(path, "r+b")
    if f then
      f:seek("set", 10)  -- flags 在 offset 9 (0-based), 第 10 字节
      local f0 = f:read(1)
      f:seek("set", 10)
      f:write(string.char(band(f0:byte(1), bxor(0xFF, FLAG_LOCKED))))
      f:close()
    end
    info = disk.loadFloppy(path)
    if not info then return false, "cannot load after unlock" end
  end
  return disk.saveFloppy(path, info.label, {}, info.size, false)
end

function disk.getFloppyInfo(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end
  local header = f:read(FLOPPY_HEADER_SIZE)
  if not header or #header < FLOPPY_HEADER_SIZE then
    f:close()
    return nil, "invalid header"
  end
  if header:sub(1, 8) ~= FLOPPY_MAGIC then
    f:close()
    return nil, "not an OCF floppy image"
  end
  local version = header:byte(9)
  local flags = header:byte(10)
  local label = header:sub(11, 26):match("^%Z*") or ""
  local size = unpackU32(header, 27)
  local fileCount = unpackU32(header, 31)
  f:close()
  return {
    label = label, size = size, version = version,
    fileCount = fileCount, locked = band(flags, FLAG_LOCKED) ~= 0,
  }
end

disk.FLOPPY_MAGIC = FLOPPY_MAGIC
disk.FLOPPY_VERSION = FLOPPY_VERSION
disk.FLOPPY_DEFAULT_SIZE = FLOPPY_DEFAULT_SIZE

-- ============================================================
-- EEPROM 文件 (.oce)
-- ============================================================

function disk.saveEEPROM(path, label, content)
  label = label or "EEPROM"
  content = content or ""
  if #content > EEPROM_MAX_SIZE then content = content:sub(1, EEPROM_MAX_SIZE) end
  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)
  local header = EEPROM_MAGIC .. string.char(EEPROM_VERSION) .. labelPadded
  local ok, err = writeFileAtomic(path, header .. content)
  if not ok then return false, err end
  return true, #content
end

function disk.loadEEPROM(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open file" end
  local header = f:read(EEPROM_HEADER_SIZE)
  if not header or #header < EEPROM_HEADER_SIZE then f:close(); return nil, "invalid header" end
  if header:sub(1, 8) ~= EEPROM_MAGIC then f:close(); return nil, "not an OC EEPROM file" end
  local version = header:byte(9)
  local label = header:sub(10, 25):match("^%Z*") or ""
  local content = f:read("*a") or ""
  f:close()
  if #content > EEPROM_MAX_SIZE then content = content:sub(1, EEPROM_MAX_SIZE) end
  return { label = label, version = version, content = content, size = #content }
end

disk.EEPROM_MAX_SIZE = EEPROM_MAX_SIZE

return disk
