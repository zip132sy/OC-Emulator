-- ============================================================
-- machine-host.lua - 自定义脚本机器的宿主进程
--
-- 用法: <lua> machine-host.lua <projectDir>
-- 服务端通过 stdin/stdout 按行交换 JSON:
--   服务端 -> 宿主: init / tick / set / action / quit
--   宿主 -> 服务端: ready / state / error
--
-- 脚本 machine.lua 返回一个定义表 (见 MODS.md):
--   return {
--     redstone = true,
--     components = {
--       { type = "...", label = "...",
--         state = { energy = 0 },
--         readonly = { "maxEnergy" },
--         props = { energy = { label = "能量", unit = "EU", min = 0, max = 10000 } },
--         tick = function(self, dt) ... end,
--         methods = { isFull = function(self) ... end },
--         actions = { reset = function(self) ... end } }
--     }
--   }
-- ============================================================

local projectDir = arg[1] or "."
package.path = projectDir .. "/?.lua;" .. package.path

local json = require("json")
local unpack = unpack or table.unpack

local out = io.stdout
local function send(message)
  out:write(json.encode(message), "\n")
  out:flush()
end

local lastError = nil
local function reportError(message)
  message = tostring(message)
  if message == lastError then return end
  lastError = message
  send({ type = "error", message = message })
end

-- 用户脚本可用的安全环境: 不提供 io / os.execute / loadfile
local scriptEnv = {
  math = math,
  string = string,
  table = table,
  tonumber = tonumber,
  tostring = tostring,
  type = type,
  pairs = pairs,
  ipairs = ipairs,
  next = next,
  select = select,
  unpack = unpack,
  error = error,
  assert = assert,
  pcall = pcall,
  print = function() end,
  os = { time = os.time, clock = os.clock },
}
scriptEnv._G = scriptEnv

local components = {}
local machineRedstone = true

local function isScalar(value)
  local t = type(value)
  if t == "number" then
    -- NaN / inf 无法编码成 JSON, 直接跳过
    return value == value and value ~= math.huge and value ~= -math.huge
  end
  return t == "boolean" or t == "string"
end

local function copyState(state)
  local result = {}
  if type(state) ~= "table" then return result end
  for key, value in pairs(state) do
    if type(key) == "string" and isScalar(value) then result[key] = value end
  end
  return result
end

local function sortedKeys(source)
  local keys = {}
  if type(source) == "table" then
    for key in pairs(source) do
      if type(key) == "string" then keys[#keys + 1] = key end
    end
  end
  table.sort(keys)
  return keys
end

local function buildDefinition()
  local list = {}
  for index, component in ipairs(components) do
    local def = component.def
    local readonly = {}
    if type(def.readonly) == "table" then
      for _, key in ipairs(def.readonly) do readonly[key] = true end
    end

    local props = {}
    for _, key in ipairs(sortedKeys(component.state)) do
      local meta = type(def.props) == "table" and def.props[key] or nil
      meta = type(meta) == "table" and meta or {}
      local kind = type(meta.type) == "string" and meta.type or type(component.state[key])
      if kind ~= "number" and kind ~= "boolean" and kind ~= "string" then
        kind = type(component.state[key])
      end
      local prop = {
        key = key,
        label = type(meta.label) == "string" and meta.label or key,
        kind = kind,
        unit = type(meta.unit) == "string" and meta.unit or "",
        writable = not readonly[key],
      }
      if kind == "number" then
        prop.min = tonumber(meta.min)
        prop.max = tonumber(meta.max)
      end
      props[#props + 1] = prop
    end

    local methods = {}
    for _, name in ipairs(sortedKeys(def.methods)) do
      if type(def.methods[name]) == "function" then methods[#methods + 1] = name end
    end

    local actions = {}
    for _, name in ipairs(sortedKeys(def.actions)) do
      if type(def.actions[name]) == "function" then actions[#actions + 1] = name end
    end

    list[index] = {
      type = type(def.type) == "string" and def.type or ("machine_component_" .. index),
      label = type(def.label) == "string" and def.label or "",
      props = props,
      methods = methods,
      actions = actions,
    }
  end
  return list
end

local function snapshot()
  local result = { type = "state", components = {} }
  for index, component in ipairs(components) do
    local methods = {}
    if type(component.def.methods) == "table" then
      for name, fn in pairs(component.def.methods) do
        if type(fn) == "function" then
          local ok, value = pcall(fn, component.state)
          if ok and isScalar(value) then methods[name] = value end
        end
      end
    end
    result.components[index] = {
      state = copyState(component.state),
      methods = methods,
    }
  end
  result.error = lastError
  send(result)
end

local function init(message)
  local scriptPath = message.script
  if type(scriptPath) ~= "string" or scriptPath == "" then
    reportError("缺少 machine.lua 路径")
    return
  end

  local chunk, loadError = loadfile(scriptPath)
  if not chunk then
    reportError(loadError)
    return
  end
  if setfenv then
    setfenv(chunk, scriptEnv)
  else
    chunk = assert(loadfile(scriptPath, "t", scriptEnv))
  end

  local ok, definition = pcall(chunk)
  if not ok then
    reportError(definition)
    return
  end
  if type(definition) ~= "table" or type(definition.components) ~= "table" then
    reportError("machine.lua 必须返回包含 components 的表")
    return
  end

  components = {}
  local savedStates = type(message.state) == "table" and message.state or {}
  for index, componentDef in ipairs(definition.components) do
    if type(componentDef) == "table" then
      local state = copyState(componentDef.state)
      local saved = savedStates[tostring(index)]
      if type(saved) == "table" then
        for key, value in pairs(saved) do
          if state[key] ~= nil and type(state[key]) == type(value) then
            state[key] = value
          end
        end
      end
      components[#components + 1] = { def = componentDef, state = state }
    end
  end

  if #components == 0 then
    reportError("machine.lua 没有定义任何组件")
    return
  end

  machineRedstone = definition.redstone ~= false
  send({
    type = "ready",
    redstone = machineRedstone,
    components = buildDefinition(),
  })
  snapshot()
end

local function handleSet(message)
  local component = components[tonumber(message.component) or 0]
  if not component or type(message.key) ~= "string" then return end
  local key = message.key
  local current = component.state[key]
  if current == nil then return end

  local value = message.value
  local kind = type(current)
  if kind == "number" then
    value = tonumber(value)
  elseif kind == "boolean" then
    value = (value == true or value == 1 or value == "true")
  elseif kind == "string" then
    value = tostring(value)
  else
    return
  end
  if value == nil then return end

  component.state[key] = value
  snapshot()
end

local function handleAction(message)
  local component = components[tonumber(message.component) or 0]
  if not component then return end
  local fn = type(component.def.actions) == "table" and component.def.actions[message.action] or nil
  if type(fn) ~= "function" then return end
  local args = type(message.args) == "table" and message.args or {}
  local ok, actionError = pcall(fn, component.state, unpack(args))
  if not ok then reportError(actionError) end
  snapshot()
end

local function handleTick(message)
  local dt = tonumber(message.dt) or 1
  lastError = nil
  for _, component in ipairs(components) do
    if type(component.def.tick) == "function" then
      local ok, tickError = pcall(component.def.tick, component.state, dt)
      if not ok then reportError(tickError) end
    end
  end
  snapshot()
end

while true do
  local line = io.stdin:read("*l")
  if not line then break end
  if line ~= "" then
    local ok, message = pcall(json.decode, line)
    if ok and type(message) == "table" then
      local kind = message.type
      if kind == "init" then
        init(message)
      elseif kind == "tick" then
        if #components > 0 then handleTick(message) end
      elseif kind == "set" then
        if #components > 0 then handleSet(message) end
      elseif kind == "action" then
        if #components > 0 then handleAction(message) end
      elseif kind == "quit" then
        break
      end
    end
  end
end
