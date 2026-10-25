-- ============================================================
-- mods.lua - Mods 统一组件 (Robot / Drone / Microcontroller)
--
-- 把 OpenComputers 原版的以下三个组件合并到同一个组件里:
--   * robot          机器人
--   * drone          无人机
--   * microcontroller 单片机
--
-- 设计要点:
--   1. 三者共享同一份设备状态 (位置 / 朝向 / 物品栏 / 工具 / 储罐 / 灯光)。
--   2. 同名同义的 API 直接共用一份实现, 不需要按设备区分。
--   3. robot.move(direction) 与 drone.move(dx,dy,dz) 通过参数个数重载共存。
--   4. 额外提供 mods.robot / mods.drone / mods.mcu 三个命名空间,
--      以及 robot_* / drone_* / mcu_* 扁平别名, 便于按原组件习惯调用。
--   5. 模拟器没有真实的 Minecraft 世界, 因此内置一个可由脚本编辑的
--      虚拟世界 (mods.world), 让 detect/swing/place/drop/suck/流体
--      等接口都有真实可观察的行为。
--
-- 该文件是纯 Lua 模块, 不依赖 oc-emulator.lua 的内部变量, 可单独测试。
-- ============================================================

local mods = {}

-- 设备状态 (在下面 resetState 中填充)
local state

local VERSION = "1.0.0"
mods.type = "mods"
mods.tier = 3
mods.version = VERSION

-- ============================================================
-- 基础工具
-- ============================================================
-- 时间源: 普通 VM 使用 os.clock; Mods 设备由模拟器注入服务端墙钟,
-- 保证空闲等待时无人机仍能按真实时间推进。
local clock = function()
  return os.clock()
end

local function now()
  return clock()
end

function mods.setClock(fn)
  if type(fn) ~= "function" then return nil, "function expected" end
  clock = fn
  state.lastTick = clock()
  return true
end

local function deepCopy(v)
  if type(v) ~= "table" then return v end
  local t = {}
  for k, val in pairs(v) do t[k] = deepCopy(val) end
  return t
end

local function toInt(v)
  local n = tonumber(v)
  if not n then return nil end
  return math.floor(n)
end

local function toNumber(v)
  return tonumber(v)
end

-- OC / Minecraft 的 side 编号
--   0 = bottom(down)  1 = top(up)  2 = back   3 = front   4 = right   5 = left
local SIDE_NAMES = { [0] = "bottom", [1] = "top", [2] = "back", [3] = "front", [4] = "right", [5] = "left" }
local SIDE_ALIASES = {
  bottom = 0, down = 0, negy = 0, ["-y"] = 0,
  top = 1, up = 1, posy = 1, ["+y"] = 1,
  back = 2, north = 2, negz = 2, ["-z"] = 2,
  front = 3, south = 3, posz = 3, forward = 3, ["+z"] = 3,
  right = 4, west = 4, negx = 4, ["-x"] = 4,
  left = 5, east = 5, posx = 5, ["+x"] = 5,
}

local function normalizeSide(side)
  if side == nil then return 3 end
  if type(side) == "string" then return SIDE_ALIASES[side:lower()] end
  local n = tonumber(side)
  if not n then return nil end
  n = math.floor(n)
  if n < 0 or n > 5 then return nil end
  return n
end

-- 朝向: 1=south(+z, front) 2=west(-x, right) 3=north(-z, back) 4=east(+x, left)
local FACING = {
  [1] = { name = "south", dx = 0, dz = 1 },
  [2] = { name = "west", dx = -1, dz = 0 },
  [3] = { name = "north", dx = 0, dz = -1 },
  [4] = { name = "east", dx = 1, dz = 0 },
}

local function sideVector(side)
  side = normalizeSide(side)
  if not side then return nil end
  if side == 0 then return 0, -1, 0, SIDE_NAMES[0] end
  if side == 1 then return 0, 1, 0, SIDE_NAMES[1] end
  if side == 2 then
    local f = FACING[state.facing]
    return -f.dx, 0, -f.dz, SIDE_NAMES[2]
  end
  if side == 3 then
    local f = FACING[state.facing]
    return f.dx, 0, f.dz, SIDE_NAMES[3]
  end
  if side == 4 then
    local f = FACING[(state.facing % 4) + 1]
    return f.dx, 0, f.dz, SIDE_NAMES[4]
  end
  local f = FACING[((state.facing + 2) % 4) + 1]
  return f.dx, 0, f.dz, SIDE_NAMES[5]
end

-- ============================================================
-- 虚拟世界
-- ============================================================
local world = {
  blocks = {},    -- ["x,y,z"] = block
  items = {},     -- ["x,y,z"] = { {name,count,meta}, ... }
  entities = {},  -- ["x,y,z"] = entity name
  limit = 256,
}

local LIQUIDS = {
  water = true, lava = true, milk = true, oil = true, fuel = true,
  coolant = true, steam = true, ["hot_water"] = true, ["liquid_oxygen"] = true,
}

local REPLACEABLE = {
  air = true, tallgrass = true, ["tall_grass"] = true,
  snow = true, ["snow_layer"] = true, fire = true,
  deadbush = true, ["dead_bush"] = true, vine = true,
}

local function posKey(x, y, z)
  return tostring(x) .. "," .. tostring(y) .. "," .. tostring(z)
end

local function inBounds(x, y, z)
  local l = world.limit
  return x >= -l and x <= l and y >= -l and y <= l and z >= -l and z <= l
end

local function classifyBlock(b)
  if not b then return "air", false end
  if b.liquid then return "liquid", false end
  if b.replaceable then return "replaceable", false end
  if b.solid == false then return "passable", false end
  return "solid", true
end

local function makeBlock(name, meta, opts)
  opts = opts or {}
  local solid
  local replaceable
  if opts.solid ~= nil then solid = opts.solid else solid = not REPLACEABLE[name] end
  if opts.replaceable ~= nil then replaceable = opts.replaceable else replaceable = REPLACEABLE[name] == true end
  local b = {
    name = name,
    meta = toInt(meta) or 0,
    solid = solid,
    replaceable = replaceable,
  }
  if opts.liquid or LIQUIDS[name] then
    b.liquid = true
    b.solid = false
    b.fluid = opts.fluid or name
    b.capacity = tonumber(opts.capacity) or 1000
    b.amount = tonumber(opts.amount) or 1000
    if b.amount > b.capacity then b.amount = b.capacity end
  end
  if opts.inventory then b.inventory = opts.inventory end
  if opts.drop then b.drop = opts.drop end
  return b
end

-- ============================================================
-- 设备状态
-- ============================================================
local function resetState()
  state = {
    name = "Mods",
    deviceType = "robot",
    running = true,
    lastError = nil,
    sidesOpen = { [0] = true, [1] = true, [2] = true, [3] = true, [4] = true, [5] = true },

    pos = { x = 0, y = 0, z = 0 },
    target = { x = 0, y = 0, z = 0 },
    vel = { x = 0, y = 0, z = 0 },
    facing = 1,
    maxVelocity = 8,
    acceleration = 4,
    lastTick = now(),

    status = "",
    light = 0x00FF00,

    inventorySize = 16,
    inv = {},
    selected = 1,

    tool = nil,
    offhand = nil,
    profile = nil,
    tanks = {},
    selectedTank = 1,

    energy = 100,
    maxEnergy = 100,

    -- 控制面板里双击设备面板是否进入全屏
    doubleClickFullscreen = true,
  }
end

resetState()

local function ensureRunning()
  if not state.running then
    return nil, "microcontroller is stopped"
  end
  return true
end

-- ============================================================
-- 物品栏
-- ============================================================
local function stackMax(name)
  if type(name) ~= "string" then return 64 end
  local n = name:lower()
  if n:find("pickaxe") or n:find("shovel") or n:find("sword") or n:find("hoe")
    or n:find("wrench") or n:find("helmet") or n:find("chestplate")
    or n:find("leggings") or n:find("boots") or n:find("_axe") then
    return 1
  end
  if n:find("bucket") then return 16 end
  return 64
end

local function invGet(slot)
  slot = toInt(slot) or state.selected
  if slot < 1 or slot > state.inventorySize then return nil end
  return state.inv[slot]
end

local function invAdd(name, count, meta, preferSlot)
  count = math.floor(tonumber(count) or 0)
  if count <= 0 then return 0 end
  meta = toInt(meta) or 0
  local max = stackMax(name)
  local added = 0

  local order = {}
  if preferSlot and state.inv[preferSlot] then order[#order + 1] = preferSlot end
  for i = 1, state.inventorySize do
    if i ~= preferSlot then order[#order + 1] = i end
  end

  -- 先堆叠到已有的同类物品
  for _, i in ipairs(order) do
    local st = state.inv[i]
    if st and st.name == name and (st.meta or 0) == meta and st.count < max then
      local put = math.min(max - st.count, count - added)
      st.count = st.count + put
      added = added + put
      if added >= count then return added end
    end
  end

  -- 再放进空格
  for _, i in ipairs(order) do
    if not state.inv[i] then
      local put = math.min(max, count - added)
      state.inv[i] = { name = name, count = put, meta = meta }
      added = added + put
      if added >= count then return added end
    end
  end

  return added
end

local function invRemove(slot, count)
  local st = state.inv[slot]
  if not st then return 0 end
  count = count and math.floor(tonumber(count) or 0) or st.count
  if count <= 0 then return 0 end
  if count > st.count then count = st.count end
  st.count = st.count - count
  if st.count <= 0 then state.inv[slot] = nil end
  return count
end

local function chestAdd(chest, name, count, meta)
  if not chest then return 0 end
  local max = stackMax(name)
  local added = 0
  local slots = chest.slots
  for i = 1, chest.size do
    local st = slots[i]
    if st and st.name == name and (st.meta or 0) == (meta or 0) and st.count < max then
      local put = math.min(max - st.count, count - added)
      st.count = st.count + put
      added = added + put
      if added >= count then return added end
    end
  end
  for i = 1, chest.size do
    if not slots[i] then
      local put = math.min(max, count - added)
      slots[i] = { name = name, count = put, meta = meta or 0 }
      added = added + put
      if added >= count then return added end
    end
  end
  return added
end

local function chestTake(chest, count)
  if not chest then return 0 end
  local taken = 0
  for i = 1, chest.size do
    if taken >= count then break end
    local st = chest.slots[i]
    if st then
      local n = math.min(st.count, count - taken)
      st.count = st.count - n
      taken = taken + n
      if st.count <= 0 then chest.slots[i] = nil end
    end
  end
  return taken
end

-- ============================================================
-- 无人机运动
-- ============================================================
local function distanceToTarget()
  local dx = state.target.x - state.pos.x
  local dy = state.target.y - state.pos.y
  local dz = state.target.z - state.pos.z
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function updateDrone(dt)
  if dt <= 0 then return end
  local dx = state.target.x - state.pos.x
  local dy = state.target.y - state.pos.y
  local dz = state.target.z - state.pos.z
  local dist = math.sqrt(dx * dx + dy * dy + dz * dz)
  if dist < 1e-6 then
    state.vel.x, state.vel.y, state.vel.z = 0, 0, 0
    return
  end

  local ux, uy, uz = dx / dist, dy / dist, dz / dist
  local vx, vy, vz = state.vel.x, state.vel.y, state.vel.z
  local speed = math.sqrt(vx * vx + vy * vy + vz * vz)
  speed = math.min(state.maxVelocity, speed + state.acceleration * dt)
  local step = speed * dt

  if step >= dist then
    state.pos.x, state.pos.y, state.pos.z = state.target.x, state.target.y, state.target.z
    state.vel.x, state.vel.y, state.vel.z = 0, 0, 0
  else
    state.pos.x = state.pos.x + ux * step
    state.pos.y = state.pos.y + uy * step
    state.pos.z = state.pos.z + uz * step
    state.vel.x, state.vel.y, state.vel.z = ux * speed, uy * speed, uz * speed
  end
end

local function tick()
  local t = now()
  local dt = t - state.lastTick
  if dt < 0 then dt = 0 end
  if dt > 5 then dt = 5 end
  state.lastTick = t
  if dt > 0 then updateDrone(dt) end
end

-- ============================================================
-- 机器人 / 无人机共用动作
-- ============================================================
local function robotMove(side)
  local dx, dy, dz = sideVector(side)
  if not dx then return nil, "invalid side" end
  local tx, ty, tz = math.floor(state.pos.x + dx), math.floor(state.pos.y + dy), math.floor(state.pos.z + dz)
  if not inBounds(tx, ty, tz) then return nil, "out of world bounds" end

  local k = posKey(tx, ty, tz)
  if world.entities[k] then return nil, "impossible move: entity in the way" end
  local b = world.blocks[k]
  local kind, blocking = classifyBlock(b)
  if blocking then
    return nil, "impossible move: blocked by " .. tostring(b and b.name or kind)
  end

  state.pos.x, state.pos.y, state.pos.z = tx, ty, tz
  state.target.x, state.target.y, state.target.z = tx, ty, tz
  state.vel.x, state.vel.y, state.vel.z = 0, 0, 0
  return true
end

local function droneMove(dx, dy, dz)
  dx, dy, dz = toNumber(dx), toNumber(dy), toNumber(dz)
  if not dx or not dy or not dz then
    return nil, "move expects (direction) or (dx, dy, dz)"
  end
  local tx = state.target.x + dx
  local ty = state.target.y + dy
  local tz = state.target.z + dz
  if not inBounds(math.floor(tx), math.floor(ty), math.floor(tz)) then
    return nil, "out of world bounds"
  end
  state.target.x, state.target.y, state.target.z = tx, ty, tz
  return true
end

local function targetBlock(side)
  local dx, dy, dz = sideVector(side)
  if not dx then return nil end
  local tx = math.floor(state.pos.x + dx)
  local ty = math.floor(state.pos.y + dy)
  local tz = math.floor(state.pos.z + dz)
  return tx, ty, tz, world.blocks[posKey(tx, ty, tz)]
end

local function damageTool()
  local t = state.tool
  if not t or not t.maxDurability then return end
  t.durability = (t.durability or t.maxDurability) - 1
  if t.durability <= 0 then state.tool = nil end
end

-- ============================================================
-- 基础状态 API
-- ============================================================
function mods.getVersion()
  return VERSION
end

function mods.getType()
  return "mods"
end

function mods.getDeviceType()
  return state.deviceType
end

function mods.setDeviceType(value)
  if value ~= "robot" and value ~= "drone" and value ~= "microcontroller" and value ~= "reactor" then
    return nil, "device type must be robot, drone, microcontroller or reactor"
  end
  state.deviceType = value
  return state.deviceType
end

function mods.name()
  return state.name
end

function mods.setName(value)
  if type(value) ~= "string" or value == "" then return nil, "name expected" end
  state.name = value
  return state.name
end

function mods.getPosition()
  tick()
  return state.pos.x, state.pos.y, state.pos.z
end

function mods.setPosition(x, y, z)
  x, y, z = toNumber(x), toNumber(y), toNumber(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  if not inBounds(math.floor(x), math.floor(y), math.floor(z)) then return nil, "out of world bounds" end
  state.pos.x, state.pos.y, state.pos.z = x, y, z
  state.target.x, state.target.y, state.target.z = x, y, z
  state.vel.x, state.vel.y, state.vel.z = 0, 0, 0
  return true
end

function mods.getFacing()
  tick()
  return state.facing, FACING[state.facing].name
end

function mods.getStatusText()
  return state.status
end

function mods.setStatusText(value)
  state.status = tostring(value or "")
  return state.status
end

function mods.getLightColor()
  return state.light
end

function mods.setLightColor(value)
  local v = toInt(value)
  if not v then return nil, "number expected" end
  state.light = v % 0x1000000
  return state.light
end

function mods.getEnergy()
  return state.energy, state.maxEnergy
end

function mods.getMaxEnergy()
  return state.maxEnergy
end

function mods.setEnergy(value)
  local v = toNumber(value)
  if not v then return nil, "number expected" end
  if v < 0 then v = 0 end
  if v > state.maxEnergy then v = state.maxEnergy end
  state.energy = v
  return state.energy
end

function mods.getOffset()
  tick()
  return distanceToTarget()
end

function mods.getVelocity()
  tick()
  local vx, vy, vz = state.vel.x, state.vel.y, state.vel.z
  return math.sqrt(vx * vx + vy * vy + vz * vz)
end

function mods.getMaxVelocity()
  return state.maxVelocity
end

function mods.setMaxVelocity(value)
  local v = toNumber(value)
  if not v or v <= 0 then return nil, "positive number expected" end
  state.maxVelocity = v
  return state.maxVelocity
end

function mods.getAcceleration()
  return state.acceleration
end

function mods.setAcceleration(value)
  local v = toNumber(value)
  if not v or v <= 0 then return nil, "positive number expected" end
  state.acceleration = v
  return state.acceleration
end

-- ============================================================
-- 单片机 (microcontroller)
-- ============================================================
function mods.start()
  if state.running then return false end
  state.running = true
  state.lastError = nil
  return true
end

function mods.stop()
  if not state.running then return false end
  state.running = false
  return true
end

function mods.isRunning()
  return state.running == true
end

function mods.setSideOpen(side, open)
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  state.sidesOpen[s] = open and true or false
  return true
end

function mods.isSideOpen(side)
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  return state.sidesOpen[s] == true
end

function mods.lastError()
  return state.lastError
end

function mods.reportError(message)
  state.lastError = message ~= nil and tostring(message) or nil
  return state.lastError
end

-- ============================================================
-- 移动 / 转向
-- ============================================================
function mods.move(a, b, c)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end

  -- 无人机形态: move(dx, dy, dz)
  if b ~= nil or c ~= nil then
    return droneMove(a, b, c)
  end

  -- 机器人形态: move(direction)
  local side = normalizeSide(a)
  if side == nil then return nil, "move expects (direction) or (dx, dy, dz)" end
  return robotMove(side)
end

function mods.turn(clockwise)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  if clockwise == nil then clockwise = true end
  if clockwise then
    state.facing = (state.facing % 4) + 1
  else
    state.facing = ((state.facing + 2) % 4) + 1
  end
  return true
end

-- ============================================================
-- 工具
-- ============================================================
-- 控制面板里主手 / 副手工具使用 id, 这里给出对应的默认耐久
local TOOL_DURABILITY = {
  diamond_drill = 2400,
  diamond_pickaxe = 1561,
  diamond_axe = 1561,
  diamond_shovel = 1561,
  diamond_sword = 1561,
  diamond_hoe = 1561,
  wrench = 250,
  shears = 238,
  flint_and_steel = 64,
}

-- 由工具 id 生成装备数据; 空 id 表示空手
local function toolFromId(id)
  if type(id) ~= "string" or id == "" then return nil end
  local maxDur = TOOL_DURABILITY[id]
  return { name = id, durability = maxDur, maxDurability = maxDur }
end

function mods.equip(name, maxDurability)
  if name == nil then
    state.tool = nil
    return true
  end
  if type(name) ~= "string" or name == "" then return nil, "tool name expected" end
  local maxDur = toNumber(maxDurability)
  if maxDur ~= nil and maxDur <= 0 then return nil, "max durability must be > 0" end
  state.tool = {
    name = name,
    durability = maxDur,
    maxDurability = maxDur,
  }
  return true
end

function mods.unequip()
  state.tool = nil
  return true
end

function mods.getEquipped()
  if not state.tool then return nil end
  return state.tool.name, state.tool.durability, state.tool.maxDurability
end

function mods.durability()
  local t = state.tool
  if not t then return nil, "no tool equipped" end
  if not t.maxDurability or t.maxDurability <= 0 then return nil, "tool cannot be damaged" end
  return t.durability / t.maxDurability, t.durability, t.maxDurability
end

-- ---------- 副手 ----------
function mods.equipOffhand(name, maxDurability)
  if name == nil then
    state.offhand = nil
    return true
  end
  if type(name) ~= "string" or name == "" then return nil, "tool name expected" end
  local maxDur = toNumber(maxDurability)
  if maxDur ~= nil and maxDur <= 0 then return nil, "max durability must be > 0" end
  state.offhand = {
    name = name,
    durability = maxDur,
    maxDurability = maxDur,
  }
  return true
end

function mods.unequipOffhand()
  state.offhand = nil
  return true
end

function mods.getOffhand()
  if not state.offhand then return nil end
  return state.offhand.name, state.offhand.durability, state.offhand.maxDurability
end

-- ============================================================
-- 设备专属配置
-- ============================================================
-- 由控制面板写入 config.json 的 hardware.robot / hardware.drone,
-- 启动时通过本函数套用到组件状态 (字段缺省时保持原值)。
function mods.setProfile(profile)
  if type(profile) ~= "table" then return nil, "table expected" end

  if profile.inventorySize ~= nil then
    local n = toInt(profile.inventorySize)
    if n and n > 0 then state.inventorySize = n end
  end

  if profile.maxVelocity ~= nil then
    local v = toNumber(profile.maxVelocity)
    if v and v > 0 then state.maxVelocity = v end
  end

  if profile.acceleration ~= nil then
    local v = toNumber(profile.acceleration)
    if v and v > 0 then state.acceleration = v end
  end

  if profile.tankCount ~= nil then
    local n = toInt(profile.tankCount)
    if n and n >= 0 then
      while #state.tanks > n do table.remove(state.tanks) end
      while #state.tanks < n do
        state.tanks[#state.tanks + 1] = { fluid = nil, amount = 0, capacity = 16000 }
      end
    end
  end

  if profile.toolMain ~= nil then
    state.tool = toolFromId(profile.toolMain)
  end

  if profile.toolOff ~= nil then
    state.offhand = toolFromId(profile.toolOff)
  end

  state.profile = deepCopy(profile)
  return true
end

function mods.getProfile()
  if not state.profile then return nil end
  return deepCopy(state.profile)
end

-- ============================================================
-- 界面行为
-- ============================================================
-- 是否允许在控制面板里双击设备面板进入全屏。
-- 关闭后双击可用于程序自己的交互, 不会再切换到全屏。
function mods.setDoubleClickFullscreen(enabled)
  state.doubleClickFullscreen = enabled ~= false
  return state.doubleClickFullscreen
end

function mods.getDoubleClickFullscreen()
  return state.doubleClickFullscreen == true
end

-- ============================================================
-- 物品栏 API
-- ============================================================
function mods.inventorySize()
  return state.inventorySize
end

function mods.select(slot)
  if slot == nil then return state.selected end
  local s = toInt(slot)
  if not s then return nil, "number expected" end
  if s < 1 or s > state.inventorySize then return nil, "invalid slot" end
  state.selected = s
  return s
end

function mods.count(slot)
  local st = invGet(slot)
  return st and st.count or 0
end

function mods.space(slot)
  local s = toInt(slot) or state.selected
  if s < 1 or s > state.inventorySize then return nil, "invalid slot" end
  local st = state.inv[s]
  if not st then return 64 end
  return math.max(0, stackMax(st.name) - st.count)
end

function mods.compareTo(otherSlot, checkNBT)
  local a = invGet()
  local b = state.inv[toInt(otherSlot) or -1]
  if not a or not b then return false end
  return a.name == b.name and (a.meta or 0) == (b.meta or 0)
end

function mods.transferTo(toSlot, amount)
  local slot = toInt(toSlot)
  if not slot or slot < 1 or slot > state.inventorySize then return false, "invalid slot" end
  if slot == state.selected then return true end

  local from = state.inv[state.selected]
  if not from then return false end

  local to = state.inv[slot]
  local n = toInt(amount) or from.count
  if n <= 0 then return false end

  if not to then
    local moved = math.min(n, from.count)
    state.inv[slot] = { name = from.name, count = moved, meta = from.meta or 0 }
    from.count = from.count - moved
    if from.count <= 0 then state.inv[state.selected] = nil end
    return true
  end

  if to.name == from.name and (to.meta or 0) == (from.meta or 0) then
    local room = stackMax(to.name) - to.count
    local moved = math.min(n, room, from.count)
    if moved <= 0 then return false end
    to.count = to.count + moved
    from.count = from.count - moved
    if from.count <= 0 then state.inv[state.selected] = nil end
    return true
  end

  -- 目标格已有其它物品: 只有整堆移动时才交换
  if n >= from.count then
    state.inv[slot] = from
    state.inv[state.selected] = to
    return true
  end

  return false
end

function mods.getInventory(side)
  local s = normalizeSide(side)
  -- 没有工具腰带: 左侧不暴露任何格子, 右侧(工具腰带)为空
  if side ~= nil and (s == 4 or s == 5) then return {} end
  local out = {}
  for i = 1, state.inventorySize do
    local st = state.inv[i]
    if st then
      out[#out + 1] = {
        slot = i,
        name = st.name,
        count = st.count,
        maxCount = stackMax(st.name),
        meta = st.meta or 0,
      }
    end
  end
  return out
end

function mods.give(name, count, meta)
  if type(name) ~= "string" or name == "" then return nil, "item name expected" end
  local n = toInt(count) or 1
  if n <= 0 then return 0 end
  return invAdd(name, n, toInt(meta) or 0)
end

function mods.take(name, count)
  if type(name) ~= "string" or name == "" then return nil, "item name expected" end
  local wanted = toInt(count) or 1
  if wanted <= 0 then return 0 end
  local removed = 0
  for i = 1, state.inventorySize do
    if removed >= wanted then break end
    local st = state.inv[i]
    if st and st.name == name then
      local n = math.min(st.count, wanted - removed)
      st.count = st.count - n
      removed = removed + n
      if st.count <= 0 then state.inv[i] = nil end
    end
  end
  return removed
end

function mods.clearInventory()
  state.inv = {}
  state.selected = 1
  return true
end

-- ============================================================
-- 储罐 API
-- ============================================================
local function tankGet(tank)
  local t = toInt(tank) or state.selectedTank
  if t < 1 or t > #state.tanks then return nil end
  return state.tanks[t], t
end

function mods.addTank(capacity)
  local cap = toNumber(capacity) or 16000
  if cap <= 0 then return nil, "capacity must be > 0" end
  state.tanks[#state.tanks + 1] = { fluid = nil, amount = 0, capacity = cap }
  return #state.tanks
end

function mods.tankCount()
  return #state.tanks
end

function mods.selectTank(tank)
  if tank == nil then return state.selectedTank end
  local t = toInt(tank)
  if not t or t < 1 or t > #state.tanks then return nil, "invalid tank" end
  state.selectedTank = t
  return t
end

function mods.tankLevel(tank)
  local tk = tankGet(tank)
  if not tk then return nil, "no tank" end
  return tk.amount
end

function mods.tankSpace(tank)
  local tk = tankGet(tank)
  if not tk then return nil, "no tank" end
  return tk.capacity - tk.amount
end

function mods.tankCapacity(tank)
  local tk = tankGet(tank)
  if not tk then return nil, "no tank" end
  return tk.capacity
end

function mods.getTank(tank)
  local tk = tankGet(tank)
  if not tk then return nil end
  return tk.fluid, tk.amount, tk.capacity
end

function mods.setTank(tank, fluid, amount)
  local tk = tankGet(tank)
  if not tk then return nil, "no tank" end
  tk.fluid = fluid
  tk.amount = math.max(0, math.min(tk.capacity, toNumber(amount) or 0))
  if tk.amount == 0 then tk.fluid = nil end
  return true
end

function mods.compareFluidTo(tank)
  local a = tankGet()
  local b = tankGet(tank)
  if not a or not b then return false end
  return a.amount > 0 and b.amount > 0 and a.fluid == b.fluid
end

function mods.transferFluidTo(tank, count)
  local from = tankGet()
  local to = tankGet(tank)
  if not from or not to then return nil, "no tank" end
  if from == to then return true end
  if from.amount <= 0 or not from.fluid then return false, 0 end
  if to.amount > 0 and to.fluid ~= from.fluid then return false, 0 end
  if to.amount >= to.capacity then return false, 0 end

  local n = toInt(count) or 1000
  if n <= 0 then return false, 0 end
  local moved = math.min(n, from.amount, to.capacity - to.amount)
  if moved <= 0 then return false, 0 end

  to.fluid = from.fluid
  to.amount = to.amount + moved
  from.amount = from.amount - moved
  if from.amount <= 0 then from.fluid = nil end
  return true, moved
end

-- ============================================================
-- 世界交互
-- ============================================================
function mods.detect(side)
  tick()
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  local tx, ty, tz, b = targetBlock(s)
  if world.entities[posKey(tx, ty, tz)] then return true, "entity" end
  local kind, blocking = classifyBlock(b)
  return blocking, kind
end

function mods.compare(side, fuzzy)
  tick()
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  local _, _, _, b = targetBlock(s)
  local st = state.inv[state.selected]
  if not b or not st then return false end
  if b.name ~= st.name then return false end
  if fuzzy then return true end
  return (b.meta or 0) == (st.meta or 0)
end

function mods.swing(side, face, sneaky)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  if type(side) == "boolean" then sneaky, side = side, nil end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local tx, ty, tz, b = targetBlock(s)
  if not b then return false, "air" end
  if b.liquid then return false, "liquid" end

  world.blocks[posKey(tx, ty, tz)] = nil
  local dropName = b.drop or b.name
  local added = invAdd(dropName, 1, b.meta or 0)
  if added == 0 then
    local k = posKey(math.floor(state.pos.x), math.floor(state.pos.y), math.floor(state.pos.z))
    local list = world.items[k]
    if not list then list = {}; world.items[k] = list end
    list[#list + 1] = { name = dropName, count = 1, meta = b.meta or 0 }
  end
  damageTool()
  return true, "block_activated"
end

function mods.use(side, face, sneaky, duration)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  if type(side) == "boolean" then sneaky, side = side, nil end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local tx, ty, tz, b = targetBlock(s)
  if world.entities[posKey(tx, ty, tz)] then return true, "entity" end
  if b then return true, "block_activated" end
  return false, "air"
end

function mods.place(side, face, sneaky)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  if type(side) == "boolean" then sneaky, side = side, nil end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local st = state.inv[state.selected]
  if not st then return false, "no item selected" end

  local tx, ty, tz, b = targetBlock(s)
  if world.entities[posKey(tx, ty, tz)] then return false, "entity in the way" end
  if b and not b.replaceable then return false, "blocked by " .. tostring(b.name) end

  world.blocks[posKey(tx, ty, tz)] = makeBlock(st.name, st.meta)
  st.count = st.count - 1
  if st.count <= 0 then state.inv[state.selected] = nil end
  return true
end

function mods.placeInInventory(side, sneaky)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local st = state.inv[state.selected]
  if not st then return false, "no item selected" end
  local _, _, _, b = targetBlock(s)
  if not b or not b.inventory then return false, "no inventory" end

  local moved = chestAdd(b.inventory, st.name, st.count, st.meta)
  if moved <= 0 then return false, "inventory full" end
  invRemove(state.selected, moved)
  return true
end

function mods.drop(side, count)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end

  -- 兼容高层写法 drop(count): 只有一个参数且大于 side 范围时视为数量
  if count == nil and type(side) == "number" and side > 5 then
    count, side = side, nil
  end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local st = state.inv[state.selected]
  if not st then return false, "no item selected" end
  local n = toInt(count) or st.count
  if n <= 0 then return false, "nothing to drop" end
  if n > st.count then n = st.count end

  local tx, ty, tz, b = targetBlock(s)
  local moved = 0
  if b and b.inventory then
    moved = chestAdd(b.inventory, st.name, n, st.meta)
  else
    local k = posKey(tx, ty, tz)
    local list = world.items[k]
    if not list then list = {}; world.items[k] = list end
    list[#list + 1] = { name = st.name, count = n, meta = st.meta or 0 }
    moved = n
  end

  if moved <= 0 then return false, "inventory full" end
  invRemove(state.selected, moved)
  return true
end

function mods.suck(side, count)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end

  if count == nil and type(side) == "number" and side > 5 then
    count, side = side, nil
  end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end

  local wanted = toInt(count) or 64
  if wanted <= 0 then return false end

  local tx, ty, tz, b = targetBlock(s)
  local sucked = 0

  if b and b.inventory then
    while sucked < wanted do
      local moved = 0
      for i = 1, b.inventory.size do
        local st = b.inventory.slots[i]
        if st then
          local n = math.min(st.count, wanted - sucked)
          local added = invAdd(st.name, n, st.meta, state.selected)
          if added > 0 then
            st.count = st.count - added
            if st.count <= 0 then b.inventory.slots[i] = nil end
            sucked = sucked + added
            moved = moved + added
          end
        end
        if sucked >= wanted then break end
      end
      if moved == 0 then break end
    end
  else
    local k = posKey(tx, ty, tz)
    local list = world.items[k]
    if list then
      local remain = {}
      for _, item in ipairs(list) do
        if sucked < wanted then
          local n = math.min(item.count, wanted - sucked)
          local added = invAdd(item.name, n, item.meta, state.selected)
          item.count = item.count - added
          sucked = sucked + added
        end
        if item.count > 0 then remain[#remain + 1] = item end
      end
      if #remain > 0 then world.items[k] = remain else world.items[k] = nil end
    end
  end

  if sucked <= 0 then return false end
  return sucked
end

function mods.compareFluid(side, tank)
  tick()
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  local tk = tankGet(tank)
  if not tk then return false end
  local _, _, _, b = targetBlock(s)
  if not b or not b.liquid or b.amount <= 0 then return false end
  return tk.amount > 0 and tk.fluid == b.fluid
end

function mods.drain(side, amount)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  local tk = tankGet()
  if not tk then return nil, "no tank" end

  local tx, ty, tz, b = targetBlock(s)
  if not b or not b.liquid or b.amount <= 0 then return false, 0 end
  if tk.amount > 0 and tk.fluid ~= b.fluid then return false, 0 end
  local space = tk.capacity - tk.amount
  if space <= 0 then return false, 0 end

  local n = toInt(amount) or 1000
  if n <= 0 then return false, 0 end
  local moved = math.min(n, b.amount, space)
  if moved <= 0 then return false, 0 end

  tk.fluid = b.fluid
  tk.amount = tk.amount + moved
  b.amount = b.amount - moved
  if b.amount <= 0 then world.blocks[posKey(tx, ty, tz)] = nil end
  return true, moved
end

function mods.fill(side, amount)
  tick()
  local ok, err = ensureRunning()
  if not ok then return nil, err end
  local s = normalizeSide(side)
  if not s then return nil, "invalid side" end
  local tk = tankGet()
  if not tk then return nil, "no tank" end
  if tk.amount <= 0 or not tk.fluid then return nil, "no fluid" end

  local n = toInt(amount) or 1000
  if n <= 0 then return false, 0 end

  local tx, ty, tz, b = targetBlock(s)
  if b and not b.liquid and not b.replaceable then return false, 0 end
  if b and b.liquid and b.fluid ~= tk.fluid then return false, 0 end

  local capacity = b and b.capacity or 1000
  local have = b and b.amount or 0
  local moved = math.min(n, tk.amount, capacity - have)
  if moved <= 0 then return false, 0 end

  if not b then
    b = makeBlock(tk.fluid, 0, { amount = moved, capacity = capacity })
  else
    b.amount = have + moved
  end
  world.blocks[posKey(tx, ty, tz)] = b

  tk.amount = tk.amount - moved
  if tk.amount <= 0 then
    tk.amount = 0
    tk.fluid = nil
  end
  return true, moved
end

-- ============================================================
-- 状态快照
-- ============================================================
function mods.getState()
  tick()
  return {
    name = state.name,
    type = "mods",
    deviceType = state.deviceType,
    version = VERSION,
    running = state.running,
    lastError = state.lastError,
    position = { x = state.pos.x, y = state.pos.y, z = state.pos.z },
    target = { x = state.target.x, y = state.target.y, z = state.target.z },
    velocity = { x = state.vel.x, y = state.vel.y, z = state.vel.z },
    facing = state.facing,
    facingName = FACING[state.facing].name,
    status = state.status,
    light = state.light,
    inventorySize = state.inventorySize,
    selected = state.selected,
    inventory = mods.getInventory(),
    tool = state.tool and deepCopy(state.tool) or nil,
    offhand = state.offhand and deepCopy(state.offhand) or nil,
    profile = state.profile and deepCopy(state.profile) or nil,
    tanks = deepCopy(state.tanks),
    selectedTank = state.selectedTank,
    energy = state.energy,
    maxEnergy = state.maxEnergy,
    doubleClickFullscreen = state.doubleClickFullscreen == true,
  }
end

function mods.getInfo()
  local info = mods.getState()
  info.sidesOpen = deepCopy(state.sidesOpen)
  info.world = mods.world.stats()
  return info
end

function mods.reset(keepWorld)
  -- 专属配置来自控制面板, 重置状态后重新套用
  local profile = state.profile
  resetState()
  if profile then mods.setProfile(profile) end
  state.lastTick = now()
  if not keepWorld then
    world.blocks = {}
    world.items = {}
    world.entities = {}
  end
  return true
end

-- ============================================================
-- 虚拟世界 API
-- ============================================================
mods.world = {}

function mods.world.setLimit(value)
  local n = toInt(value)
  if not n or n < 1 then return nil, "positive integer expected" end
  if n > 4096 then n = 4096 end
  world.limit = n
  return world.limit
end

function mods.world.getLimit()
  return world.limit
end

function mods.world.setBlock(x, y, z, name, meta)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  if not inBounds(x, y, z) then return nil, "out of world bounds" end
  if name == nil or name == "" or name == "air" then
    world.blocks[posKey(x, y, z)] = nil
    return true
  end
  world.blocks[posKey(x, y, z)] = makeBlock(tostring(name), meta)
  return true
end

function mods.world.getBlock(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  local b = world.blocks[posKey(x, y, z)]
  if not b then return nil end
  return b.name, b.meta or 0
end

function mods.world.removeBlock(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  world.blocks[posKey(x, y, z)] = nil
  return true
end

function mods.world.setFluid(x, y, z, fluid, amount, capacity)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  if type(fluid) ~= "string" or fluid == "" then return nil, "fluid name expected" end
  if not inBounds(x, y, z) then return nil, "out of world bounds" end
  local b = makeBlock(fluid, 0, { amount = amount, capacity = capacity })
  world.blocks[posKey(x, y, z)] = b
  return true
end

function mods.world.getFluid(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  local b = world.blocks[posKey(x, y, z)]
  if not b or not b.liquid then return nil end
  return b.fluid, b.amount, b.capacity
end

function mods.world.setChest(x, y, z, size)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  local n = toInt(size) or 27
  if n < 1 then n = 1 end
  if n > 256 then n = 256 end
  world.blocks[posKey(x, y, z)] = makeBlock("chest", 0, {
    inventory = { size = n, slots = {} },
  })
  return true
end

function mods.world.getChest(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  local b = world.blocks[posKey(x, y, z)]
  if not b or not b.inventory then return nil end
  local out = {}
  for i = 1, b.inventory.size do
    local st = b.inventory.slots[i]
    if st then
      out[#out + 1] = {
        slot = i,
        name = st.name,
        count = st.count,
        meta = st.meta or 0,
        maxCount = stackMax(st.name),
      }
    end
  end
  return out
end

function mods.world.addItem(x, y, z, name, count, meta)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  if type(name) ~= "string" or name == "" then return nil, "item name expected" end
  local n = toInt(count) or 1
  if n <= 0 then return false end
  local k = posKey(x, y, z)
  local list = world.items[k]
  if not list then list = {}; world.items[k] = list end
  list[#list + 1] = { name = name, count = n, meta = toInt(meta) or 0 }
  return true
end

function mods.world.getItems(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  return deepCopy(world.items[posKey(x, y, z)] or {})
end

function mods.world.clearItems(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  world.items[posKey(x, y, z)] = nil
  return true
end

function mods.world.addEntity(x, y, z, name)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  if type(name) ~= "string" or name == "" then name = "entity" end
  world.entities[posKey(x, y, z)] = name
  return true
end

function mods.world.removeEntity(x, y, z)
  x, y, z = toInt(x), toInt(y), toInt(z)
  if not x or not y or not z then return nil, "x, y, z expected" end
  world.entities[posKey(x, y, z)] = nil
  return true
end

function mods.world.getEntities()
  return deepCopy(world.entities)
end

function mods.world.clear()
  world.blocks = {}
  world.items = {}
  world.entities = {}
  return true
end

function mods.world.stats()
  local blocks, items, entities = 0, 0, 0
  for _ in pairs(world.blocks) do blocks = blocks + 1 end
  for _ in pairs(world.items) do items = items + 1 end
  for _ in pairs(world.entities) do entities = entities + 1 end
  return { blocks = blocks, itemStacks = items, entities = entities, limit = world.limit }
end

function mods.world.dump()
  local blocks = {}
  for k, b in pairs(world.blocks) do
    local x, y, z = k:match("^(-?%d+),(-?%d+),(-?%d+)$")
    if x then
      blocks[#blocks + 1] = {
        x = tonumber(x), y = tonumber(y), z = tonumber(z),
        name = b.name, meta = b.meta or 0,
        liquid = b.liquid or false,
        fluid = b.fluid,
        amount = b.amount,
        capacity = b.capacity,
      }
    end
  end
  return {
    blocks = blocks,
    items = deepCopy(world.items),
    entities = deepCopy(world.entities),
    limit = world.limit,
  }
end

-- 顶层快捷方式 (与 mods.world 等价)
function mods.setBlock(x, y, z, name, meta)
  return mods.world.setBlock(x, y, z, name, meta)
end

function mods.getBlock(x, y, z)
  return mods.world.getBlock(x, y, z)
end

function mods.removeBlock(x, y, z)
  return mods.world.removeBlock(x, y, z)
end

function mods.clearWorld()
  return mods.world.clear()
end

-- ============================================================
-- 命名空间: 按原组件习惯调用
-- ============================================================
mods.robot = setmetatable({}, { __index = mods })
mods.drone = setmetatable({}, { __index = mods })
mods.microcontroller = setmetatable({}, { __index = mods })
mods.mcu = mods.microcontroller

-- ---- Robot 高层 API (require("robot") 风格) ----
function mods.robot.forward() return mods.move(3) end
function mods.robot.back() return mods.move(2) end
function mods.robot.up() return mods.move(1) end
function mods.robot.down() return mods.move(0) end
function mods.robot.turnLeft() return mods.turn(false) end
function mods.robot.turnRight() return mods.turn(true) end

function mods.robot.detect() return mods.detect(3) end
function mods.robot.detectUp() return mods.detect(1) end
function mods.robot.detectDown() return mods.detect(0) end

function mods.robot.compare(fuzzy) return mods.compare(3, fuzzy) end
function mods.robot.compareUp(fuzzy) return mods.compare(1, fuzzy) end
function mods.robot.compareDown(fuzzy) return mods.compare(0, fuzzy) end

function mods.robot.drop(count) return mods.drop(3, count) end
function mods.robot.dropUp(count) return mods.drop(1, count) end
function mods.robot.dropDown(count) return mods.drop(0, count) end

function mods.robot.suck(count) return mods.suck(3, count) end
function mods.robot.suckUp(count) return mods.suck(1, count) end
function mods.robot.suckDown(count) return mods.suck(0, count) end

function mods.robot.place(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.place(3, side, sneaky)
end
function mods.robot.placeUp(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.place(1, side, sneaky)
end
function mods.robot.placeDown(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.place(0, side, sneaky)
end

function mods.robot.swing(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.swing(3, side, sneaky)
end
function mods.robot.swingUp(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.swing(1, side, sneaky)
end
function mods.robot.swingDown(side, sneaky)
  if type(side) == "boolean" then sneaky, side = side, nil end
  return mods.swing(0, side, sneaky)
end

function mods.robot.use(side, sneaky, duration)
  if type(side) == "boolean" then duration, sneaky, side = sneaky, side, nil end
  return mods.use(3, side, sneaky, duration)
end
function mods.robot.useUp(side, sneaky, duration)
  if type(side) == "boolean" then duration, sneaky, side = sneaky, side, nil end
  return mods.use(1, side, sneaky, duration)
end
function mods.robot.useDown(side, sneaky, duration)
  if type(side) == "boolean" then duration, sneaky, side = sneaky, side, nil end
  return mods.use(0, side, sneaky, duration)
end

-- ---- Drone ----
function mods.drone.move(dx, dy, dz) return mods.move(dx, dy, dz) end

-- ---- Microcontroller ----
function mods.microcontroller.start() return mods.start() end
function mods.microcontroller.stop() return mods.stop() end
function mods.microcontroller.isRunning() return mods.isRunning() end
function mods.microcontroller.setSideOpen(side, open) return mods.setSideOpen(side, open) end
function mods.microcontroller.isSideOpen(side) return mods.isSideOpen(side) end
function mods.microcontroller.lastError() return mods.lastError() end
function mods.microcontroller.reportError(message) return mods.reportError(message) end

-- ============================================================
-- 扁平别名: robot_* / drone_* / mcu_* / microcontroller_*
-- ============================================================
local ROBOT_FLAT = {
  "durability", "move", "turn", "name", "swing", "use", "place", "placeInInventory",
  "getLightColor", "setLightColor", "inventorySize", "select", "count", "space",
  "compareTo", "transferTo", "tankCount", "selectTank", "tankLevel", "tankSpace",
  "compareFluidTo", "transferFluidTo", "detect", "compareFluid", "drain", "fill",
  "compare", "drop", "suck", "equip", "unequip", "getEquipped",
  "equipOffhand", "unequipOffhand", "getOffhand", "getPosition",
  "setPosition", "getFacing", "getInventory", "give", "take", "clearInventory",
}

local ROBOT_HIGH = {
  "forward", "back", "up", "down", "turnLeft", "turnRight",
  "detectUp", "detectDown", "compareUp", "compareDown",
  "dropUp", "dropDown", "suckUp", "suckDown",
  "placeUp", "placeDown", "swingUp", "swingDown", "useUp", "useDown",
}

local DRONE_FLAT = {
  "getStatusText", "setStatusText", "move", "getOffset", "getVelocity",
  "getMaxVelocity", "setMaxVelocity", "getAcceleration", "setAcceleration", "name", "swing",
  "use", "place", "placeInInventory", "getLightColor", "setLightColor",
  "inventorySize", "select", "count", "space", "compareTo", "transferTo",
  "tankCount", "selectTank", "tankLevel", "tankSpace", "compareFluidTo",
  "transferFluidTo", "detect", "compareFluid", "drain", "fill", "compare",
  "drop", "suck", "getPosition", "getInventory",
}

local MCU_FLAT = {
  "start", "stop", "isRunning", "setSideOpen", "isSideOpen", "lastError", "reportError",
}

for _, name in ipairs(ROBOT_FLAT) do
  if mods[name] then mods["robot_" .. name] = mods[name] end
end
for _, name in ipairs(ROBOT_HIGH) do
  if mods.robot[name] then mods["robot_" .. name] = mods.robot[name] end
end
for _, name in ipairs(DRONE_FLAT) do
  if mods[name] then mods["drone_" .. name] = mods[name] end
end
mods.drone_move = mods.drone.move
for _, name in ipairs(MCU_FLAT) do
  if mods[name] then
    mods["mcu_" .. name] = mods[name]
    mods["microcontroller_" .. name] = mods[name]
  end
end

-- 高层机器人方法的扁平别名 (mods.forward 等)
for _, name in ipairs(ROBOT_HIGH) do
  if mods.robot[name] then mods[name] = mods.robot[name] end
end

-- ============================================================
-- OC 原版 API -> Mods 映射表
-- ============================================================
local API_ROWS = {}

local function addRows(kind, rows, targetPrefix, flatPrefix, notes)
  for _, row in ipairs(rows) do
    API_ROWS[#API_ROWS + 1] = {
      kind = kind,
      source = row[1],
      sourceName = row[1]:gsub("%b()", ""),
      signature = row[2] or "",
      target = targetPrefix .. "." .. row[1]:gsub("%b()", ""):gsub("^[%w_]+%.", ""),
      flat = flatPrefix and (flatPrefix .. row[1]:gsub("%b()", ""):gsub("^[%w_]+%.", "")) or nil,
      note = row[3] or notes or "",
    }
  end
end

-- 机器人组件 (component robot)
addRows("robot", {
  { "robot.durability()", "", "返回工具耐久度比例、剩余耐久、最大耐久；无工具时返回 nil 与原因。" },
  { "robot.move(direction)", "direction:number", "按 side 编号移动；0=下 1=上 2=后 3=前 4=右 5=左。与无人机 move 通过参数个数重载共存。" },
  { "robot.turn(clockwise)", "clockwise:boolean", "true 顺时针、false 逆时针转向。" },
  { "robot.name()", "", "返回设备名称（可通过 setName 修改）。" },
  { "robot.swing(side[,face[,sneaky]])", "side:number", "左键挖掘/攻击指定方向；成功返回 true 与结果描述。" },
  { "robot.use(side[,face[,sneaky[,duration]]])", "side:number", "右键使用物品；成功返回 true 与结果描述。" },
  { "robot.place(side[,face[,sneaky]])", "side:number", "把选中格物品放到指定方向。" },
  { "robot.placeInInventory(side[,sneaky])", "side:number", "把选中格物品放入相邻容器。" },
  { "robot.getLightColor()", "", "读取灯光颜色（0xRRGGBB）。" },
  { "robot.setLightColor(value)", "value:number", "设置灯光颜色（0xRRGGBB）。" },
  { "robot.inventorySize()", "", "内部物品栏格数。" },
  { "robot.select([slot])", "slot:number", "读取或切换当前选中格。" },
  { "robot.count([slot])", "slot:number", "指定格（默认选中格）的物品数量。" },
  { "robot.space([slot])", "slot:number", "指定格剩余空间。" },
  { "robot.compareTo(otherSlot[,checkNBT])", "otherSlot:number", "比较选中格与目标格的物品。" },
  { "robot.transferTo(toSlot[,amount])", "toSlot:number", "把选中格物品转移到目标格。" },
  { "robot.tankCount()", "", "储罐数量。" },
  { "robot.selectTank([tank])", "tank:number", "读取或切换当前储罐。" },
  { "robot.tankLevel([tank])", "tank:number", "储罐液位。" },
  { "robot.tankSpace([tank])", "tank:number", "储罐剩余容量。" },
  { "robot.compareFluidTo(tank)", "tank:number", "比较选中储罐与指定储罐的液体。" },
  { "robot.transferFluidTo(tank[,count])", "tank:number", "把选中储罐液体转移到指定储罐。" },
  { "robot.detect(side)", "side:number", "检测相邻方块/实体，返回是否阻挡与类型（air/solid/liquid/replaceable/passable/entity）。" },
  { "robot.compareFluid(side[,tank])", "side:number", "比较相邻液体与选中储罐。" },
  { "robot.drain(side[,amount])", "side:number", "从相邻方块/储罐抽取液体到选中储罐。" },
  { "robot.fill(side[,amount])", "side:number", "把选中储罐液体注入相邻方块/储罐。" },
  { "robot.compare(side[,fuzzy])", "side:number", "比较相邻方块与选中物品。" },
  { "robot.drop(side[,count])", "side:number", "把选中格物品丢到指定方向或容器；默认方向为前。" },
  { "robot.suck(side[,count])", "side:number", "从指定方向吸取掉落物或容器物品。" },
}, "mods", "mods.robot_", nil)

-- 无人机组件 (component drone)
addRows("drone", {
  { "drone.getStatusText()", "", "读取无人机状态文本。" },
  { "drone.setStatusText(value)", "value:string", "设置无人机状态文本。" },
  { "drone.move(dx,dy,dz)", "dx,dy,dz:number", "设置无人机目标偏移；三个数字参数触发无人机形态。" },
  { "drone.getOffset()", "", "当前位置到目标位置的距离。" },
  { "drone.getVelocity()", "", "当前速度（格/秒）。" },
  { "drone.getMaxVelocity()", "", "最大速度。" },
  { "drone.setMaxVelocity(value)", "value:number", "设置最大速度并返回新值。" },
  { "drone.getAcceleration()", "", "当前加速度。" },
  { "drone.setAcceleration(value)", "value:number", "设置加速度并返回新值。" },
  { "drone.name()", "", "返回设备名称。" },
  { "drone.swing(side[,face[,sneaky]])", "side:number", "与机器人 swing 共用实现。" },
  { "drone.use(side[,face[,sneaky[,duration]]])", "side:number", "与机器人 use 共用实现。" },
  { "drone.place(side[,face[,sneaky]])", "side:number", "与机器人 place 共用实现。" },
  { "drone.placeInInventory(side[,sneaky])", "side:number", "与机器人 placeInInventory 共用实现。" },
  { "drone.getLightColor()", "", "与机器人 getLightColor 共用实现。" },
  { "drone.setLightColor(value)", "value:number", "与机器人 setLightColor 共用实现。" },
  { "drone.inventorySize()", "", "与机器人 inventorySize 共用实现。" },
  { "drone.select([slot])", "slot:number", "与机器人 select 共用实现。" },
  { "drone.count([slot])", "slot:number", "与机器人 count 共用实现。" },
  { "drone.space([slot])", "slot:number", "与机器人 space 共用实现。" },
  { "drone.compareTo(otherSlot[,checkNBT])", "otherSlot:number", "与机器人 compareTo 共用实现。" },
  { "drone.transferTo(toSlot[,amount])", "toSlot:number", "与机器人 transferTo 共用实现。" },
  { "drone.tankCount()", "", "与机器人 tankCount 共用实现。" },
  { "drone.selectTank([tank])", "tank:number", "与机器人 selectTank 共用实现。" },
  { "drone.tankLevel([tank])", "tank:number", "与机器人 tankLevel 共用实现。" },
  { "drone.tankSpace([tank])", "tank:number", "与机器人 tankSpace 共用实现。" },
  { "drone.compareFluidTo(tank)", "tank:number", "与机器人 compareFluidTo 共用实现。" },
  { "drone.transferFluidTo(tank[,count])", "tank:number", "与机器人 transferFluidTo 共用实现。" },
  { "drone.detect(side)", "side:number", "与机器人 detect 共用实现。" },
  { "drone.compareFluid(side[,tank])", "side:number", "与机器人 compareFluid 共用实现。" },
  { "drone.drain(side[,amount])", "side:number", "与机器人 drain 共用实现。" },
  { "drone.fill(side[,amount])", "side:number", "与机器人 fill 共用实现。" },
  { "drone.compare(side[,fuzzy])", "side:number", "与机器人 compare 共用实现。" },
  { "drone.drop(side[,count])", "side:number", "与机器人 drop 共用实现。" },
  { "drone.suck(side[,count])", "side:number", "与机器人 suck 共用实现。" },
}, "mods", "mods.drone_", nil)

-- 单片机组件 (component microcontroller)
addRows("microcontroller", {
  { "microcontroller.setSideOpen(side,open)", "side:number, open:boolean", "设置指定方向是否开放（状态记录）。" },
  { "microcontroller.start()", "", "启动设备；状态改变时返回 true。" },
  { "microcontroller.isRunning()", "", "设备是否处于运行状态。" },
  { "microcontroller.isSideOpen(side)", "side:number", "查询指定方向是否开放。" },
  { "microcontroller.lastError()", "", "最近一次上报的错误（可由 reportError 写入，VM 崩溃时自动记录）。" },
  { "microcontroller.stop()", "", "停止设备；停止后动作类 API 返回 microcontroller is stopped。" },
}, "mods", "mods.mcu_", nil)

-- 机器人高层 API (OpenOS require("robot") 风格)
addRows("robot_api", {
  { "robot.forward()", "", "向前移动一格。" },
  { "robot.back()", "", "向后移动一格。" },
  { "robot.up()", "", "向上移动一格。" },
  { "robot.down()", "", "向下移动一格。" },
  { "robot.turnLeft()", "", "左转 90 度。" },
  { "robot.turnRight()", "", "右转 90 度。" },
  { "robot.detect()", "", "检测正前方。" },
  { "robot.detectUp()", "", "检测正上方。" },
  { "robot.detectDown()", "", "检测正下方。" },
  { "robot.compare()", "", "比较正前方方块与选中物品。" },
  { "robot.compareUp()", "", "比较正上方方块与选中物品。" },
  { "robot.compareDown()", "", "比较正下方方块与选中物品。" },
  { "robot.drop([count])", "count:number", "把选中格物品丢到正前方。" },
  { "robot.dropUp([count])", "count:number", "丢到正上方。" },
  { "robot.dropDown([count])", "count:number", "丢到正下方。" },
  { "robot.suck([count])", "count:number", "从正前方吸取物品。" },
  { "robot.suckUp([count])", "count:number", "从正上方吸取物品。" },
  { "robot.suckDown([count])", "count:number", "从正下方吸取物品。" },
  { "robot.place([side[,sneaky]])", "side:number", "把选中物品放到正前方；side 是放置面。" },
  { "robot.placeUp([side[,sneaky]])", "side:number", "放到正上方。" },
  { "robot.placeDown([side[,sneaky]])", "side:number", "放到正下方。" },
  { "robot.swing([side[,sneaky]])", "side:number", "挖掘正前方；side 是作用面。" },
  { "robot.swingUp([side[,sneaky]])", "side:number", "挖掘正上方。" },
  { "robot.swingDown([side[,sneaky]])", "side:number", "挖掘正下方。" },
  { "robot.use([side[,sneaky]])", "side:number", "使用正前方；side 是作用面。" },
  { "robot.useUp([side[,sneaky]])", "side:number", "使用正上方。" },
  { "robot.useDown([side[,sneaky]])", "side:number", "使用正下方。" },
  { "robot.equip(name[,maxDurability])", "name:string", "装备工具（扩展）。" },
  { "robot.unequip()", "", "卸下工具（扩展）。" },
  { "robot.equipOffhand(name[,maxDurability])", "name:string", "装备副手工具（扩展）。" },
  { "robot.unequipOffhand()", "", "卸下副手工具（扩展）。" },
  { "robot.getOffhand()", "", "返回副手工具名称与耐久（扩展）。" },
}, "mods.robot", "mods", nil)

-- 扩展 API (原版没有, Mods 额外提供)
local EXTENSION_ROWS = {
  { "mods.getVersion()", "", "组件版本号。" },
  { "mods.getType()", "", "组件类型，固定返回 mods。" },
  { "mods.getDeviceType()", "", "返回设备类型：robot / drone / microcontroller / reactor。" },
  { "mods.setDeviceType(type)", "", "设置设备类型。" },
  { "mods.setClock(fn)", "", "替换时间源（Mods 设备由模拟器注入服务端墙钟）。" },
  { "mods.getPosition()", "", "返回当前坐标 x,y,z。" },
  { "mods.setPosition(x,y,z)", "", "直接设置坐标（调试/初始化用）。" },
  { "mods.getFacing()", "", "返回朝向编号与名称。" },
  { "mods.give(name[,count[,meta]])", "", "向物品栏放入物品。" },
  { "mods.take(name[,count])", "", "从物品栏取出物品，返回实际取出数量。" },
  { "mods.clearInventory()", "", "清空物品栏。" },
  { "mods.getInventory([side])", "", "返回物品栏内容快照。" },
  { "mods.equip(name[,maxDurability])", "", "装备工具。" },
  { "mods.unequip()", "", "卸下工具。" },
  { "mods.getEquipped()", "", "返回已装备工具名称与耐久。" },
  { "mods.equipOffhand(name[,maxDurability])", "", "装备副手工具。" },
  { "mods.unequipOffhand()", "", "卸下副手工具。" },
  { "mods.getOffhand()", "", "返回副手工具名称与耐久。" },
  { "mods.getProfile()", "", "返回控制面板配置的设备专属参数。" },
  { "mods.setProfile(profile)", "", "套用设备专属参数（主手/副手工具、物品栏格数、储罐数量、速度等）。" },
  { "mods.setDoubleClickFullscreen(enabled)", "", "设置双击控制面板中的设备面板是否进入全屏（默认开启）。" },
  { "mods.getDoubleClickFullscreen()", "", "返回是否允许双击进入全屏。" },
  { "mods.addTank([capacity])", "", "安装一个储罐。" },
  { "mods.getTank([tank])", "", "返回储罐液体、液位、容量。" },
  { "mods.setTank([tank],fluid,amount)", "", "直接设置储罐内容。" },
  { "mods.tankCapacity([tank])", "", "储罐容量。" },
  { "mods.getState()", "", "返回设备完整状态快照。" },
  { "mods.getInfo()", "", "返回设备状态 + 方向开放 + 世界统计。" },
  { "mods.reset([keepWorld])", "", "重置设备状态（可选保留世界）。" },
  { "mods.reportError(message)", "", "写入 lastError（单片机风格）。" },
  { "mods.getEnergy()", "", "返回能量与最大能量（扩展状态）。" },
  { "mods.setEnergy(value)", "", "设置能量（扩展状态）。" },
  { "mods.world.setLimit(n)", "", "设置世界坐标边界（默认 256）。" },
  { "mods.world.setBlock(x,y,z,name[,meta])", "", "放置/移除方块。" },
  { "mods.world.getBlock(x,y,z)", "", "读取方块名称与 meta。" },
  { "mods.world.removeBlock(x,y,z)", "", "移除方块。" },
  { "mods.world.setFluid(x,y,z,fluid[,amount[,capacity]])", "", "放置液体方块。" },
  { "mods.world.getFluid(x,y,z)", "", "读取液体名称、数量、容量。" },
  { "mods.world.setChest(x,y,z[,size])", "", "在指定位置创建容器。" },
  { "mods.world.getChest(x,y,z)", "", "读取容器内容。" },
  { "mods.world.addItem(x,y,z,name[,count[,meta]])", "", "在指定位置生成掉落物。" },
  { "mods.world.getItems(x,y,z)", "", "读取指定位置掉落物。" },
  { "mods.world.addEntity(x,y,z[,name])", "", "在指定位置放置实体标记。" },
  { "mods.world.removeEntity(x,y,z)", "", "移除实体标记。" },
  { "mods.world.clear()", "", "清空世界。" },
  { "mods.world.stats()", "", "返回世界统计信息。" },
  { "mods.world.dump()", "", "导出世界内容。" },
  { "mods.setBlock(...)", "", "mods.world.setBlock 的快捷方式。" },
  { "mods.getBlock(...)", "", "mods.world.getBlock 的快捷方式。" },
  { "mods.removeBlock(...)", "", "mods.world.removeBlock 的快捷方式。" },
  { "mods.clearWorld()", "", "mods.world.clear 的快捷方式。" },
  { "mods.getStatusText()", "", "读取状态文本。" },
  { "mods.setStatusText(value)", "", "设置状态文本。" },
  { "mods.getLightColor()", "", "读取灯光颜色。" },
  { "mods.setLightColor(value)", "", "设置灯光颜色。" },
  { "mods.getOffset()", "", "无人机到目标位置的距离。" },
  { "mods.getVelocity()", "", "无人机速度。" },
  { "mods.setMaxVelocity(value)", "", "设置无人机最大速度。" },
  { "mods.setAcceleration(value)", "", "设置无人机加速度。" },
  { "mods.forward()/back()/up()/down()", "", "机器人高层移动快捷方式。" },
  { "mods.turnLeft()/turnRight()", "", "机器人高层转向快捷方式。" },
  { "mods.detectUp()/detectDown()", "", "机器人高层检测快捷方式。" },
  { "mods.compareUp()/compareDown()", "", "机器人高层比较快捷方式。" },
  { "mods.dropUp()/dropDown()/suckUp()/suckDown()", "", "机器人高层丢弃/吸取快捷方式。" },
  { "mods.placeUp()/placeDown()/swingUp()/swingDown()/useUp()/useDown()", "", "机器人高层放置/挖掘/使用快捷方式。" },
  { "mods.apiMap([kind])", "", "返回 OC 原版 API 到 Mods 的映射表；kind 可为 robot/drone/microcontroller/robot_api。" },
  { "mods.map(name)", "", "按 OC 原版名称查询映射目标，例如 mods.map(\"robot.move\")。" },
  { "mods.help([kind])", "", "返回可直接 print 的中文映射帮助。" },
  { "mods.listAPIs()", "", "列出全部可调用 API 名称。" },
}

for _, row in ipairs(EXTENSION_ROWS) do
  API_ROWS[#API_ROWS + 1] = {
    kind = "extension",
    source = row[1],
    sourceName = row[1],
    signature = "",
    target = row[1],
    flat = nil,
    note = row[2],
  }
end

local function rowFilter(kind)
  if kind == nil then return API_ROWS end
  kind = tostring(kind):lower()
  local out = {}
  for _, row in ipairs(API_ROWS) do
    if row.kind == kind then out[#out + 1] = row end
  end
  return out
end

function mods.apiMap(kind)
  return deepCopy(rowFilter(kind))
end

function mods.map(name)
  if type(name) ~= "string" then return nil end
  local needle = name:lower():gsub("%s+", ""):gsub(":", ".")
  for _, row in ipairs(API_ROWS) do
    local source = row.source:lower():gsub("%s+", ""):gsub(":", ".")
    local short = row.sourceName:lower():gsub("%s+", ""):gsub(":", ".")
    if source == needle or short == needle then
      return row.target, row
    end
  end
  return nil
end

function mods.help(kind)
  local rows = rowFilter(kind)
  local lines = {
    "Mods v" .. VERSION .. " - Robot / Drone / Microcontroller 统一组件",
    "用法: local mods = require(\"mods\")    -- 也可以直接用 component.mods",
    "提示: mods.robot / mods.drone / mods.mcu 是命名空间, robot_* / drone_* / mcu_* 是扁平别名。",
    "",
  }
  local current = nil
  local groupTitles = {
    robot = "机器人组件 (component robot)",
    drone = "无人机组件 (component drone)",
    microcontroller = "单片机组件 (component microcontroller)",
    robot_api = "机器人高层 API (require(\"robot\") 风格)",
    extension = "Mods 扩展 API",
  }
  for _, row in ipairs(rows) do
    if row.kind ~= current then
      current = row.kind
      lines[#lines + 1] = "== " .. (groupTitles[current] or current) .. " =="
    end
    local src = row.source
    if row.signature ~= "" then src = src .. "  [" .. row.signature .. "]" end
    lines[#lines + 1] = "  " .. src
    lines[#lines + 1] = "    -> " .. row.target .. (row.flat and ("   (别名 " .. row.flat .. ")") or "")
    if row.note ~= "" then lines[#lines + 1] = "    说明: " .. row.note end
  end
  return table.concat(lines, "\n")
end

function mods.listAPIs()
  local names = {}
  for k, v in pairs(mods) do
    if type(v) == "function" and k:sub(1, 1) ~= "_" then names[#names + 1] = "mods." .. k end
  end
  for _, ns in ipairs({ "robot", "drone", "mcu", "microcontroller", "world" }) do
    local t = mods[ns]
    if type(t) == "table" then
      for k, v in pairs(t) do
        if type(v) == "function" and tostring(k):sub(1, 1) ~= "_" then
          names[#names + 1] = "mods." .. ns .. "." .. tostring(k)
        end
      end
    end
  end
  table.sort(names)
  return names
end

return mods
