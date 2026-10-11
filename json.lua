-- ============================================================
-- JSON 库 (Lua 5.1+ 兼容, UTF-8 完整支持)
-- 用法: local json = require("json")
--   json.encode(value) -> string
--   json.encode(value, true) -> string (美化输出)
--   json.decode(string) -> value, err
--   json.null -> 空值占位符 (table, 可用于区分 nil 和 null)
-- ============================================================

local json = {}

-- null 占位符: 解码时 JSON null 会变成 json.null
-- 这样可以区分 table 中 "键不存在" 和 "键值为 null"
json.null = setmetatable({}, { __tostring = function() return "null" end })

-- ---------- 编码 ----------

local encodeString
do
  local map = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r',
    ['\t'] = '\\t', ['\b'] = '\\b', ['\f'] = '\\f',
  }
  function encodeString(s)
    local result = {'"'}
    local i = 1
    local len = #s
    while i <= len do
      local b = s:byte(i)
      if b == 34 or b == 92 or b == 10 or b == 13 or b == 9 or b == 8 or b == 12 then
        result[#result+1] = map[s:sub(i, i)]
        i = i + 1
      elseif b < 32 then
        -- 控制字符转义为 \u00XX
        result[#result+1] = string.format('\\u%04x', b)
        i = i + 1
      elseif b < 128 then
        -- ASCII 可打印字符
        result[#result+1] = s:sub(i, i)
        i = i + 1
      else
        -- UTF-8 多字节: 直接保留 (JSON 规范允许 UTF-8)
        local charLen = 1
        if b >= 0xF0 then charLen = 4
        elseif b >= 0xE0 then charLen = 3
        elseif b >= 0xC0 then charLen = 2 end
        result[#result+1] = s:sub(i, i + charLen - 1)
        i = i + charLen
      end
    end
    result[#result+1] = '"'
    return table.concat(result)
  end
end

local function isArray(t)
  local max = 0
  local count = 0
  for k, _ in pairs(t) do
    if type(k) == "number" and k > 0 and k == math.floor(k) then
      if k > max then max = k end
      count = count + 1
    else
      -- 有非数字键 → 对象
      return false
    end
  end
  -- 所有键都是正整数, 且 max == count → 连续数组
  -- 空表 → 空对象 (更符合 JSON 惯例, 避免类型信息丢失)
  if count == 0 then return false end
  return max == count
end

local encode -- 前向声明

local function encodeTable(t, pretty, indent, indentStr)
  if isArray(t) then
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    if n == 0 then return "[]" end
    if not pretty then
      local parts = {}
      for i = 1, n do parts[i] = encode(t[i], false, indent, indentStr) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      local subIndent = indent .. indentStr
      for i = 1, n do
        parts[i] = subIndent .. encode(t[i], true, subIndent, indentStr)
      end
      return "[\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "]"
    end
  else
    -- 对象
    local keys = {}
    for k, _ in pairs(t) do keys[#keys+1] = k end
    if #keys == 0 then return "{}" end
    -- 按键排序 (美化模式下)
    if pretty then
      table.sort(keys, function(a, b)
        if type(a) == type(b) then return tostring(a) < tostring(b) end
        return type(a) < type(b)
      end)
    end
    if not pretty then
      local parts = {}
      for _, k in ipairs(keys) do
        parts[#parts+1] = encodeString(tostring(k)) .. ":" .. encode(t[k], false, indent, indentStr)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    else
      local parts = {}
      local subIndent = indent .. indentStr
      for _, k in ipairs(keys) do
        parts[#parts+1] = subIndent .. encodeString(tostring(k)) .. ": " .. encode(t[k], true, subIndent, indentStr)
      end
      return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
    end
  end
end

encode = function(v, pretty, indent, indentStr)
  indent = indent or ""
  indentStr = indentStr or "  "
  if v == json.null then return "null" end
  local tv = type(v)
  if tv == "nil" then return "null"
  elseif tv == "boolean" then return v and "true" or "false"
  elseif tv == "number" then
    if v ~= v then return "null" end          -- NaN → null
    if v == math.huge or v == -math.huge then return "null" end  -- inf → null (标准 JSON 不支持)
    -- 整数用整数格式
    if v == math.floor(v) and math.abs(v) < 1e15 then
      return string.format("%d", v)
    end
    return string.format("%.17g", v)
  elseif tv == "string" then return encodeString(v)
  elseif tv == "table" then return encodeTable(v, pretty, indent, indentStr)
  else
    return "null"  -- function / userdata / thread
  end
end

function json.encode(val, pretty)
  if pretty then
    return encode(val, true, "", "  ")
  end
  return encode(val, false, "", "")
end

-- 紧凑编码 (向后兼容)
json.encodeCompact = function(val) return encode(val, false, "", "") end

-- 美化编码
json.encodePretty = function(val) return encode(val, true, "", "  ") end

-- ---------- 解码 ----------

-- 辅助: UTF-8 编码一个 Unicode 码点
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

-- 解码使用局部状态 table (可重入)
local function createDecoder(s)
  return {
    str = s,
    pos = 1,
    len = #s,
  }
end

local function skipWhitespace(d)
  while d.pos <= d.len do
    local c = d.str:byte(d.pos)
    if c == 32 or c == 9 or c == 10 or c == 13 then
      d.pos = d.pos + 1
    else break end
  end
end

local function decodeString(d)
  if d.str:byte(d.pos) ~= 34 then error("expected '\"' at " .. d.pos) end
  d.pos = d.pos + 1
  local result = {}
  while d.pos <= d.len do
    local b = d.str:byte(d.pos)
    if b == 34 then  -- "  结束
      d.pos = d.pos + 1
      return table.concat(result)
    elseif b == 92 then  -- \  转义
      d.pos = d.pos + 1
      if d.pos > d.len then error("unexpected end after '\\'") end
      local esc = d.str:byte(d.pos)
      d.pos = d.pos + 1
      if esc == 34 then result[#result+1] = '"'
      elseif esc == 92 then result[#result+1] = '\\'
      elseif esc == 47 then result[#result+1] = '/'
      elseif esc == 98 then result[#result+1] = '\b'
      elseif esc == 102 then result[#result+1] = '\f'
      elseif esc == 110 then result[#result+1] = '\n'
      elseif esc == 114 then result[#result+1] = '\r'
      elseif esc == 116 then result[#result+1] = '\t'
      elseif esc == 117 then  -- \uXXXX
        if d.pos + 3 > d.len then error("incomplete \\u escape at " .. d.pos) end
        local hex = d.str:sub(d.pos, d.pos + 3)
        if not hex:match("^%x%x%x%x$") then error("invalid \\u escape: " .. hex) end
        d.pos = d.pos + 4
        local code = tonumber(hex, 16)
        -- 检查 UTF-16 高代理 (high surrogate): D800-DBFF
        if code >= 0xD800 and code <= 0xDBFF then
          -- 期待低代理 (low surrogate): \uDC00-\uDFFF
          if d.pos + 5 <= d.len and d.str:byte(d.pos) == 92 and d.str:byte(d.pos + 1) == 117 then
            d.pos = d.pos + 2  -- 跳过 \u
            local hex2 = d.str:sub(d.pos, d.pos + 3)
            if hex2:match("^%x%x%x%x$") then
              local code2 = tonumber(hex2, 16)
              if code2 >= 0xDC00 and code2 <= 0xDFFF then
                d.pos = d.pos + 4
                -- 代理对 → 码点
                local cp = 0x10000 + (code - 0xD800) * 0x400 + (code2 - 0xDC00)
                result[#result+1] = utf8Encode(cp)
              else
                error("invalid low surrogate: \\u" .. hex2)
              end
            else
              error("invalid \\u escape in low surrogate")
            end
          else
            error("missing low surrogate after high surrogate")
          end
        elseif code >= 0xDC00 and code <= 0xDFFF then
          error("unexpected low surrogate without high surrogate")
        else
          result[#result+1] = utf8Encode(code)
        end
      else
        error("invalid escape: \\" .. string.char(esc))
      end
    elseif b < 32 then
      error("unescaped control character at " .. d.pos)
    else
      -- 普通字符 (包括 UTF-8 多字节)
      result[#result+1] = string.char(b)
      d.pos = d.pos + 1
    end
  end
  error("unterminated string")
end

local function decodeNumber(d)
  local startPos = d.pos
  -- 负号
  if d.str:byte(d.pos) == 45 then d.pos = d.pos + 1 end
  -- 整数部分
  local intStart = d.pos
  while d.pos <= d.len do
    local c = d.str:byte(d.pos)
    if c >= 48 and c <= 57 then d.pos = d.pos + 1
    else break end
  end
  if d.pos == intStart then error("invalid number at " .. startPos) end
  -- 小数部分
  if d.pos <= d.len and d.str:byte(d.pos) == 46 then
    d.pos = d.pos + 1
    local fracStart = d.pos
    while d.pos <= d.len do
      local c = d.str:byte(d.pos)
      if c >= 48 and c <= 57 then d.pos = d.pos + 1
      else break end
    end
    if d.pos == fracStart then error("invalid number: missing digits after '.'") end
  end
  -- 指数部分
  if d.pos <= d.len then
    local ec = d.str:byte(d.pos)
    if ec == 101 or ec == 69 then  -- e / E
      d.pos = d.pos + 1
      if d.pos <= d.len then
        local sc = d.str:byte(d.pos)
        if sc == 43 or sc == 45 then d.pos = d.pos + 1 end  -- + / -
      end
      local expStart = d.pos
      while d.pos <= d.len do
        local c = d.str:byte(d.pos)
        if c >= 48 and c <= 57 then d.pos = d.pos + 1
        else break end
      end
      if d.pos == expStart then error("invalid number: missing digits in exponent") end
    end
  end
  local numStr = d.str:sub(startPos, d.pos - 1)
  local num = tonumber(numStr)
  if not num then error("invalid number: " .. numStr) end
  return num
end

local function decodeValue(d)
  skipWhitespace(d)
  if d.pos > d.len then error("unexpected end of input") end
  local c = d.str:byte(d.pos)
  if c == 34 then  -- "
    return decodeString(d)
  elseif c == 123 then  -- {
    d.pos = d.pos + 1
    skipWhitespace(d)
    local obj = {}
    if d.pos <= d.len and d.str:byte(d.pos) == 125 then
      d.pos = d.pos + 1
      return obj
    end
    while true do
      skipWhitespace(d)
      if d.pos > d.len or d.str:byte(d.pos) ~= 34 then
        error("expected string key at position " .. d.pos)
      end
      local key = decodeString(d)
      skipWhitespace(d)
      if d.pos > d.len or d.str:byte(d.pos) ~= 58 then
        error("expected ':' after key at position " .. d.pos)
      end
      d.pos = d.pos + 1
      obj[key] = decodeValue(d)
      skipWhitespace(d)
      if d.pos > d.len then error("unexpected end in object") end
      local sep = d.str:byte(d.pos)
      if sep == 44 then d.pos = d.pos + 1  -- ,
      elseif sep == 125 then d.pos = d.pos + 1; return obj  -- }
      else error("expected ',' or '}' at position " .. d.pos) end
    end
  elseif c == 91 then  -- [
    d.pos = d.pos + 1
    skipWhitespace(d)
    local arr = {}
    if d.pos <= d.len and d.str:byte(d.pos) == 93 then
      d.pos = d.pos + 1
      return arr
    end
    local i = 1
    while true do
      arr[i] = decodeValue(d)
      i = i + 1
      skipWhitespace(d)
      if d.pos > d.len then error("unexpected end in array") end
      local sep = d.str:byte(d.pos)
      if sep == 44 then d.pos = d.pos + 1  -- ,
      elseif sep == 93 then d.pos = d.pos + 1; return arr  -- ]
      else error("expected ',' or ']' at position " .. d.pos) end
    end
  elseif c == 116 then  -- true
    if d.str:sub(d.pos, d.pos + 3) == "true" then
      d.pos = d.pos + 4
      return true
    end
    error("invalid token at " .. d.pos)
  elseif c == 102 then  -- false
    if d.str:sub(d.pos, d.pos + 4) == "false" then
      d.pos = d.pos + 5
      return false
    end
    error("invalid token at " .. d.pos)
  elseif c == 110 then  -- null
    if d.str:sub(d.pos, d.pos + 3) == "null" then
      d.pos = d.pos + 4
      return json.null  -- 返回 null 占位符
    end
    error("invalid token at " .. d.pos)
  elseif c == 45 or (c >= 48 and c <= 57) then  -- - or digit
    return decodeNumber(d)
  else
    error("unexpected character '" .. string.char(c) .. "' at position " .. d.pos)
  end
end

function json.decode(s)
  if type(s) ~= "string" then return nil, "expected string" end
  local d = createDecoder(s)
  local ok, result = pcall(decodeValue, d)
  if not ok then return nil, result end
  -- 检查是否有尾部内容
  skipWhitespace(d)
  if d.pos <= d.len then
    return nil, "unexpected trailing content at position " .. d.pos
  end
  -- 把 json.null 转成 nil? 不, 保留 json.null 以便区分
  -- 但如果用户期望 null → nil, 可以后处理
  return result
end

-- 解码后把所有 json.null 替换为 nil (递归)
function json.nullToNil(val)
  if val == json.null then return nil end
  if type(val) == "table" then
    local result = {}
    for k, v in pairs(val) do
      local newV = json.nullToNil(v)
      if newV ~= nil then result[k] = newV end
    end
    return result
  end
  return val
end

return json
