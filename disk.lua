-- ============================================================
-- OC Emulator disk image module
-- .ocd format v4 - encrypted, compressed disk image
--
-- A custom encrypted archive format:
--   - Custom "OCDISK" magic, unrecognized by archive tools (7-Zip/WinRAR)
--   - LZW-compressed, then XOR-encrypted with a rolling 16-byte key
--   - Encrypted payload looks like random bytes and cannot be read directly
--
-- Layout:
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
-- EEPROM format (.oce):
--   Header (25 bytes):
--     Magic:   "OCEEPROM" (8 bytes)
--     Version: 1 byte
--     Label:   16 bytes (null-padded)
--   Body:
--     Text content (max 4096 bytes)
-- ============================================================

local disk = {}

local MAGIC = "OCDISK"
local VERSION = 4              -- v4: lock/unlock, tier and encryption
local HEADER_SIZE = 36         -- v3 header
local HEADER_SIZE_V4 = 40     -- v4 header (includes tier + unlockToken)
local FLAG_COMPRESSED = 1
local FLAG_LOCKED = 2          -- v4: disk locked
local FLAG_TIER = 4            -- v4: tier field is valid
local FLAG_ENCRYPT_V2 = 8      -- v4: 16-byte rolling-key encryption

-- ============================================================
-- Host filesystem access (must be captured at module load time)
--
-- Once the guest OS boots, the emulator swaps the global io / os tables for the guest's own virtual implementations
-- (see the _G.os.remove / _G.os.rename / _G.io overrides at the end of oc-emulator.lua).
-- Host and guest share the same globals, so calling the global io.open /
-- os.remove / os.rename here writes into the guest's internal filesystem and leaves the host
-- .ocd / .ocf files untouched: label or file changes made in the VM silently revert on restart,
-- accompanied by "WARNING: save disk1 failed: ...".
-- So copy the real implementations at load time and shadow the globals in this file.
-- ============================================================
local real_io, real_os = {}, {}
for k, v in pairs(io) do real_io[k] = v end
for k, v in pairs(os) do real_os[k] = v end
local io, os = real_io, real_os

-- Tier capacity limits (standard OpenComputers values)
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
-- Binary encode/decode helpers
-- ============================================================

-- Lua 5.1 has no bitwise operators: use lookup tables
-- Precompute the 256x256 XOR table once at startup; lookups are O(1)
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

-- AND: masking to 0xFF only needs a byte-level operation
local function band(a, b)
  if b == 0xFF then return a % 256 end
  if a == 0xFF then return b % 256 end
  -- General case: bitwise AND, only used for small values
  local r, p = 0, 1
  for _ = 0, 7 do
    if math.floor(a / p) % 2 == 1 and math.floor(b / p) % 2 == 1 then
      r = r + p
    end
    p = p * 2
  end
  return r
end

-- OR: combine high and low bytes (a = hi*256 + lo)
local function bor(a, b)
  return a + b  -- valid because a and b never overlap (a=hi*256, b=lo)
end

-- Fast XOR (byte-level, table lookup)
local function bxor(a, b)
  if a <= 255 and b <= 255 then
    return xorTable[a][b]
  end
  -- Large values: XOR the high and low bytes separately
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
-- LZW compression/decompression (fixed 16-bit codes) and encryption
-- ============================================================

-- Single-byte XOR key (needed for v3 and early v4 disks; do not remove)
local XOR_KEY_V1 = 0xA5

-- 16-byte rolling key, so encrypted data looks random and cannot be read directly
-- Arbitrary constants mixed with the disk label, so each disk gets a different key
local XOR_KEY_V2 = { 0x4F, 0x43, 0x45, 0x4D, 0x75, 0x6C, 0x61, 0x74,
                     0x6F, 0x72, 0x21, 0x39, 0x41, 0x7E, 0xC3, 0x5B }

-- Derive a 16-byte salt from the disk label (unique per disk)
-- The salt must stay deterministic even for an empty label. Then labelBytes is empty,
-- so (i - 1) % #labelBytes becomes % 0 and Lua raises "attempt to perform 'n%0'",
-- surfacing as "WARNING: save ... failed" when a label change saves the disk.
local function deriveLabelSalt(label)
  local salt = {}
  local labelBytes = { string.byte(label, 1, #label) }
  if #labelBytes == 0 then labelBytes = { 0 } end
  for i = 1, 16 do
    local lb = labelBytes[(i - 1) % #labelBytes + 1] or 0
    -- Simple hash: mix position with label bytes
    salt[i] = bxor(bxor(lb, (i * 37) % 256), XOR_KEY_V2[i])
  end
  return salt
end

-- Single-byte XOR (needed for v3 and early v4 disks)
local function xorTransformV1(data)
  local result = {}
  for i = 1, #data do
    result[i] = string.char(bxor(data:byte(i), XOR_KEY_V1))
  end
  return table.concat(result)
end

-- Chunked yield hook: compression/encryption loops over the whole disk (2-4 s for 3 MB).
-- The emulator runs save in a coroutine, one small slice per tick, so the guest stays responsive.
-- With no hook the work runs synchronously.
local stepYield = nil
function disk.setYieldHook(fn) stepYield = fn end

-- V2 encryption: 16-byte rolling key + label salt
-- data: string to encrypt or decrypt
-- label: disk label (used to derive the salt)
--
-- Performance: three bxors per byte take seconds on a 3 MB disk, and running that
-- synchronously would stall the whole VM on one small write. The merged keystream repeats
-- every lcm(16, 256, 65536) = 65536 bytes, so large blocks precompute one period and index it;
-- output is identical to the per-byte path.
local XOR_STREAM_PERIOD = 65536
local XOR_CHUNK = 4096        -- must divide XOR_STREAM_PERIOD
local charByByte = {}
for b = 0, 255 do charByByte[b] = string.char(b) end

local function xorTransformV2(data, label)
  local n = #data
  if n == 0 then return "" end
  local salt = deriveLabelSalt(label or "")

  -- Small input: byte by byte (precomputing the keystream is not worth it)
  if n <= XOR_STREAM_PERIOD then
    local result = {}
    for i = 1, n do
      local keyByte = salt[((i - 1) % 16) + 1]
      -- Mix in position data every 256 bytes to resist analysis
      local posByte = bxor((i % 256), (math.floor(i / 256) % 256))
      result[i] = charByByte[bxor(bxor(data:byte(i), keyByte), bxor(posByte, (i * 7) % 256))]
    end
    return table.concat(result)
  end

  -- Large input: precompute one full period of the merged keystream, then index it per chunk
  local stream = {}
  for i = 1, XOR_STREAM_PERIOD do
    local keyByte = salt[((i - 1) % 16) + 1]
    local posByte = bxor((i % 256), (math.floor(i / 256) % 256))
    stream[i] = bxor(keyByte, bxor(posByte, (i * 7) % 256))
  end

  local out = {}
  local outN = 0
  local chunkSinceYield = 0
  for i = 0, n - 1, XOR_CHUNK do
    local chunk = data:sub(i + 1, i + XOR_CHUNK)
    local bytes = { chunk:byte(1, -1) }
    -- i is a multiple of XOR_CHUNK, which divides the period, so base lands on a chunk boundary and
    -- base + j never exceeds one period; no extra modulo needed.
    local base = i % XOR_STREAM_PERIOD
    local parts = {}
    for j = 1, #bytes do
      parts[j] = charByByte[xorTable[bytes[j]][stream[base + j]]]
    end
    outN = outN + 1
    out[outN] = table.concat(parts)
    -- Yield every 64 KB (~20 ms) so saving is spread across ticks
    if stepYield then
      chunkSinceYield = chunkSinceYield + 1
      if chunkSinceYield >= 16 then
        chunkSinceYield = 0
        stepYield()
      end
    end
  end
  return table.concat(out)
end

-- Raw LZW compression (no encryption; callers encrypt separately)
--
-- Performance: numeric dictionary keys (prefix code << 8 | byte) avoid per-byte string
-- concatenation, hashing and comparison, which noticeably speeds up 3.3 MB disks.
-- The code stream matches the string-key implementation (greedy match order is unchanged).
local function lzwCompressRaw(input)
  local len = #input
  if len == 0 then return "" end

  local dict = {}
  local dictSize = 256
  local result = {}
  local resultN = 0
  local wcode = -1              -- -1 means no character read yet
  local sinceYield = 0

  for i = 1, len do
    local c = string.byte(input, i)
    if wcode < 0 then
      wcode = c
    else
      local key = wcode * 256 + c
      local code = dict[key]
      if code then
        wcode = code
      else
        resultN = resultN + 1
        result[resultN] = string.char(math.floor(wcode / 256) % 256, wcode % 256)
        if dictSize < 65536 then
          dict[key] = dictSize
          dictSize = dictSize + 1
        end
        wcode = c
      end
    end
    -- Yield every 64 KB processed (~20 ms)
    if stepYield then
      sinceYield = sinceYield + 1
      if sinceYield >= 65536 then
        sinceYield = 0
        stepYield()
      end
    end
  end
  if wcode >= 0 then
    resultN = resultN + 1
    result[resultN] = string.char(math.floor(wcode / 256) % 256, wcode % 256)
  end
  return table.concat(result)
end

-- Raw LZW decompression (no decryption; callers decrypt separately)
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

-- LZW + single-byte XOR (compat interface used by saveV3)
local function lzwCompress(input)
  return xorTransformV1(lzwCompressRaw(input))
end

-- LZW + single-byte XOR (compat interface for loading older disks)
local function lzwDecompress(input)
  if #input == 0 then return "" end
  return lzwDecompressRaw(xorTransformV1(input))
end

-- ============================================================
-- Filesystem serialization (binary, not text)
-- ============================================================

local function serializeFSBinary(files)
  local parts = {}
  local count = 0
  for path, info in pairs(files) do
    count = count + 1
    local content = info.content or ""
    local pathBytes = path
    local modified = info.modified or 0

    -- PathLen (2 bytes) + path + type (1 byte) + data length (4 bytes) + data + mtime (8 bytes)
    -- Lua 5.1/5.3 compatible: mtime stored as an 8-byte little-endian integer
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
      -- Lua 5.1 compatible: read the 8-byte little-endian integer manually
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
-- Disk save/load
-- ============================================================

-- Atomic write: write a temp file, then rename.
-- The emulator periodically writes disks back (write-through). Overwriting in place means
-- a process killed mid-write leaves a truncated or corrupt image, losing the installation too.
-- The temp file guarantees the disk holds either the old or the new content, never a mix.
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
  -- Windows rename cannot overwrite, so remove the target first (tiny race window)
  os.remove(path)
  local renamed, err = os.rename(tmp, path)
  if not renamed then
    os.remove(tmp)
    return false, err or "rename failed"
  end
  return true
end

-- v4 save: tier + locked parameters and V2 encryption
-- @param path     output path
-- @param label    disk label
-- @param files    file table
-- @param size     disk capacity (bytes)
-- @param tier     tier 1/2/3 (optional, default 3)
-- @param locked   lock flag (optional, default false)
function disk.save(path, label, files, size, tier, locked)
  label = label or "Untitled"
  size = size or (4 * 1024 * 1024)
  files = files or {}
  tier = tier or 3
  locked = locked or false

  -- Validate capacity against the tier limit
  local maxTier = TIER_LIMITS[tier] or TIER_LIMITS[3]
  if size > maxTier then
    return false, string.format("size %d exceeds tier %d limit %d", size, tier, maxTier)
  end

  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)

  -- Serialize
  local body, fileCount = serializeFSBinary(files)

  -- LZW compression (no encryption)
  local compressed = lzwCompressRaw(body)
  local flags = bxor(FLAG_COMPRESSED, FLAG_ENCRYPT_V2)

  -- Compress only when it shrinks the data (still encrypted)
  if #compressed >= #body then
    -- Compression does not help: store raw data, still encrypted
    compressed = body
    flags = FLAG_ENCRYPT_V2  -- ENCRYPT_V2 without COMPRESSED
  end

  -- V2 encryption: 16-byte rolling key + label salt
  compressed = xorTransformV2(compressed, label)

  -- v4 flags
  if locked then flags = bxor(flags, FLAG_LOCKED) end
  flags = bxor(flags, FLAG_TIER)  -- tier field is valid

  -- v4 header (40 bytes): Magic(6) + Ver(1) + Flags(1) + Label(16) + Size(4) + FileCount(4) + Tier(1) + UnlockToken(4) + Reserved(3)
  local header = MAGIC .. string.char(VERSION) .. string.char(flags) .. labelPadded .. packU32(size) .. packU32(fileCount) .. string.char(tier) .. packU32(0) .. string.rep("\0", 3)

  return writeFileAtomic(path, header .. compressed)
end

-- disk.save defaults to tier=3, locked=false when tier/locked are omitted

-- v3 save (for backward-compatible export)
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
    -- v4: lock/unlock, tier and V2 encryption
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
    if tier == 0 then tier = 3 end  -- older disks may leave tier unset

    local locked = band(flags, FLAG_LOCKED) ~= 0
    local body = f:read("*a")
    f:close()

    if locked then
      -- Locked: return header info only, files=nil
      return {
        label = label, size = size, tier = tier, version = 4,
        flags = flags, files = nil, locked = true, fileCount = fileCount
      }
    end

    -- Detect encryption version (V2 = 16-byte rolling key, V1 = single-byte XOR)
    local useEncryptV2 = band(flags, FLAG_ENCRYPT_V2) ~= 0
    local useCompressed = band(flags, FLAG_COMPRESSED) ~= 0

    if useEncryptV2 then
      -- V2: 16-byte rolling key + label salt (symmetric, same function decrypts)
      body = xorTransformV2(body, label)
      if useCompressed then
        body = lzwDecompressRaw(body)
      end
    else
      -- V1 compat: XOR_V1 lives inside lzwDecompress and only applies when compressed
      if useCompressed then
        body = lzwDecompress(body)  -- includes XOR_V1 decryption + LZW decompression
      end
      -- Uncompressed v4 disk: body is raw data, nothing to do
    end

    local files = deserializeFSBinary(body)
    return {
      label = label, size = size, tier = tier, version = 4,
      flags = flags, files = files, locked = false, fileCount = fileCount
    }

  elseif version == 3 then
    -- v3: binary format
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
    -- v2: LZW-compressed Lua table serialization (legacy)
    local rest = f:read(30)
    if not rest or #rest < 30 then f:close(); return nil, "invalid v2 header" end
    local flags = rest:byte(1)
    local label = rest:sub(2, 17):match("^%Z*") or ""
    local size = unpackU32(rest, 18)
    local body = f:read("*a")
    f:close()
    if flags % 2 == 1 then body = lzwDecompress(body) end
    local fn, err = load(body)
    if not fn then return nil, "cannot parse v2 content: " .. tostring(err) end
    local ok, result = pcall(fn)
    if not ok then return nil, result end
    return { label = label, size = size, version = version, flags = flags, files = result }

  elseif version == 1 then
    -- v1: uncompressed Lua table serialization (legacy)
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
-- v4 lock/unlock/format operations
-- ============================================================

-- Patch only the header flags byte (body untouched)
local function rewriteFlags(path, newFlags)
  local f = io.open(path, "r+b")
  if not f then return false, "cannot open file" end
  -- flags at byte offset 7: Magic(6) + Version(1), 1-based index 8
  f:seek("set", 7)
  f:write(string.char(newFlags))
  f:close()
  return true
end

-- Read flags without loading the whole disk
local function readFlags(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  f:seek("set", 7)
  local b = f:read(1)
  f:close()
  if not b then return nil end
  return b:byte(1)
end

function disk.lock(path)
  local flags = readFlags(path)
  if not flags then return false, "cannot read disk" end
  if band(flags, FLAG_LOCKED) ~= 0 then return true end
  return rewriteFlags(path, bxor(flags, FLAG_LOCKED))
end

function disk.unlock(path)
  local flags = readFlags(path)
  if not flags then return false, "cannot read disk" end
  if band(flags, FLAG_LOCKED) == 0 then return true end
  return rewriteFlags(path, band(flags, bxor(0xFF, FLAG_LOCKED)))
end

function disk.isLocked(path)
  local flags = readFlags(path)
  if not flags then return nil, "cannot read disk" end
  return band(flags, FLAG_LOCKED) ~= 0
end

-- Format: drop all files, keep label/size/tier
function disk.format(path)
  local info = disk.load(path)
  if not info then return false, "cannot load disk" end
  -- Unlock first: format needs to read files
  if info.locked then
    disk.unlock(path)
    info = disk.load(path)
    if not info then return false, "cannot load after unlock" end
  end
  local ok, err = disk.save(path, info.label, {}, info.size, info.tier, false)
  return ok, err
end

-- Disk info from the header only (never unlocks)
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
-- Floppy image (.ocf) - distinct from .ocd disk images
-- ============================================================
-- Layout:
--   Header (36 bytes):
--     Magic:      "OCFLOPPY" (8 bytes)
--     Version:    1 byte
--     Flags:      1 byte (bit0=compressed, bit1=locked, bit3=encrypt_v2)
--     Label:      16 bytes (null-padded)
--     Size:       4 bytes (uint32 BE, floppy capacity, fixed at 512KB)
--     FileCount:  4 bytes (uint32 BE)
--   Body (LZW compressed, then encrypted):
--     Same file serialization as .ocd
-- ============================================================

local FLOPPY_MAGIC = "OCFLOPPY"
local FLOPPY_VERSION = 1
local FLOPPY_HEADER_SIZE = 36
local FLOPPY_DEFAULT_SIZE = 2048 * 1024  -- 2MB (enough for a full OpenOS install)

function disk.saveFloppy(path, label, files, size, locked)
  label = label or "Floppy"
  size = size or FLOPPY_DEFAULT_SIZE
  files = files or {}
  locked = locked or false

  -- Clamp to the floppy capacity limit
  if size > FLOPPY_DEFAULT_SIZE then
    size = FLOPPY_DEFAULT_SIZE
  end

  if #label > 16 then label = label:sub(1, 16) end
  local labelPadded = label .. string.rep("\0", 16 - #label)

  -- Serialize
  local body, fileCount = serializeFSBinary(files)

  -- LZW compression (no encryption)
  local compressed = lzwCompressRaw(body)
  local flags = bxor(FLAG_COMPRESSED, FLAG_ENCRYPT_V2)

  -- Compress only when it shrinks the data
  if #compressed >= #body then
    compressed = body
    flags = FLAG_ENCRYPT_V2
  end

  -- V2 encryption
  compressed = xorTransformV2(compressed, label)

  if locked then flags = bxor(flags, FLAG_LOCKED) end

  -- Header: Magic(8) + Ver(1) + Flags(1) + Label(16) + Size(4) + FileCount(4) = 34
  -- Pad to 36 bytes with 2 reserved bytes
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
    local f = io.open(path, "r+b")
    if f then
      f:seek("set", 10)  -- flags at offset 9 (1-based byte 10)
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
-- EEPROM files (.oce)
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
