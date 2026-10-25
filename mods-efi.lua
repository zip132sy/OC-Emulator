-- Mods built-in EFI: reports state and accepts wireless control on port 7777.
local PORT = 7777
local IV = 0.2
local function emit(t) if modsEmit then modsEmit(t) end end
local function log(l, m) emit({ type = "mod_log", level = l or "info", msg = tostring(m) }) end
local function now() if modWallTime then return modWallTime() end return os.clock() end
local function pack(ok, ...)
  local n = select("#", ...)
  local r = { ok = ok == true, n = n }
  for i = 1, n do r[i] = select(i, ...) end
  return r
end
log("info", "Mods EFI 1.0.0")
local a = component.list("mods")()
if not a then log("error", "no mods component"); error("no mods component") end
local m = component.proxy(a)
local dt = m.getDeviceType and m.getDeviceType() or "robot"
local name = m.name()
local ma = component.list("modem")()
local modem = ma and component.proxy(ma) or nil
if modem then
  if pcall(function() modem.open(PORT) end) then
    log("info", "wireless control ready " .. tostring(modem.address) .. " port " .. PORT)
  else
    log("warn", "open port failed")
  end
else
  log("warn", "no wireless modem")
end
local function st() local s = m.getState(); s.deviceType = dt; return s end
local function invoke(method, args)
  local f = m[method]
  if type(f) ~= "function" then return pack(false, "no method " .. tostring(method)) end
  args = args or {}
  local n = tonumber(args.n) or #args
  local ok, x, y, z, w = pcall(f, table.unpack(args, 1, n))
  if not ok then return pack(false, tostring(x)) end
  return pack(true, x, y, z, w)
end
local function handle(c)
  if type(c) ~= "table" then return pack(false, "table expected") end
  local op = c.op or c.cmd
  if op == "discover" or op == "info" then
    return { ok = true, mod = { name = name, type = dt, address = modem and modem.address } }
  end
  if op == "state" then return { ok = true, state = st() } end
  if op == "invoke" then return invoke(c.method, c.args) end
  if op == "move" then
    if c.dx or c.dy or c.dz then return pack(m.move(c.dx or 0, c.dy or 0, c.dz or 0)) end
    return pack(m.move(c.direction or c.side or 3))
  end
  if op == "turn" then return pack(m.turn(c.clockwise ~= false)) end
  if op == "shutdown" then pcall(function() computer.shutdown() end); return { ok = true } end
  if op == "reboot" then pcall(function() computer.shutdown("reboot") end); return { ok = true } end
  return invoke(op, c.args)
end
local function rep(to, port, id, r)
  if not modem or not to or not port then return end
  r.reqId = id
  r.mod = name
  pcall(function() modem.send(to, port, r) end)
end
local function desc(c) if type(c) == "table" then return tostring(c.op or c.cmd or "?") end return tostring(c) end
local function emitState()
  emit({ type = "mod_state", state = st(), address = modem and modem.address, deviceType = dt })
end
emitState()
local last = now()
while true do
  local s = table.pack(computer.pullSignal(IV))
  if s.n > 0 then
    if s[1] == "modem_message" then
      local p = s[6]
      if type(p) == "table" then
        local r = handle(p)
        rep(s[3], s[4], p.reqId, r)
        log("info", "wireless " .. desc(p) .. " -> " .. tostring(r.ok))
      end
    elseif s[1] == "mod_command" then
      local r = handle(s[2])
      log("info", "local " .. desc(s[2]) .. " -> " .. tostring(r.ok))
    elseif s[1] == "shutdown" then
      pcall(function() computer.shutdown() end)
    end
  end
  if now() - last >= IV then emitState(); last = now() end
end
