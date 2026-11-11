// ============================================================
// lib/modsManager.js - Mods device management
//
// Two device kinds:
//   * Computer-like (robot / drone / microcontroller): Mods/<name>/ holds a
//     standalone Lua VM with EFI, boot disk and hardware config, driven over wireless.
//   * Machine-like (reactor): runs no program, only sits on the device bus as a
//     component read by other computers; config is just the machine's own parameters.
//
//   Mods/<name>/
//     mod.json      metadata (type / description / component address / 3D marker)
//     config.json   computer-like devices only
//     efi.lua       computer-like devices only
//     disk.ocd      computer-like devices only
//     reactor.json  reactors only
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VMManager } = require('./vmManager');
const { MachineHost } = require('./machineHost');
const reactorModel = require('./reactor');

const MOD_TYPES = new Set(['robot', 'drone', 'microcontroller', 'reactor', 'machine']);
// These types are real computers and need a VM / EFI / disk
const COMPUTER_TYPES = new Set(['robot', 'drone', 'microcontroller']);
const MOD_PORT = 7777;
const MOD_LOG_LIMIT = 300;
const EFI_MAX_BYTES = 4096;
const APU_TIERS = new Set([1, 2, 3, 'creative']);
const MEM_TIERS = new Set([1, 1.5, 2, 2.5, 3, 3.5]);
const SCREEN_TIERS = new Set([1, 2, 3]);
const EXPANSIONS = new Set(['', 'internet', 'data_t1', 'data_t2', 'data_t3', 'wireless_t1', 'wireless_t2']);

// Robot-only config: tools equippable in the main / off hand
const ROBOT_TOOLS = [
  { id: '', label: '空手' },
  { id: 'diamond_pickaxe', label: '钻石镐' },
  { id: 'diamond_axe', label: '钻石斧' },
  { id: 'diamond_shovel', label: '钻石铲' },
  { id: 'diamond_sword', label: '钻石剑' },
  { id: 'diamond_hoe', label: '钻石锄' },
  { id: 'wrench', label: '扳手' },
  { id: 'shears', label: '剪刀' },
  { id: 'flint_and_steel', label: '打火石' },
];
const ROBOT_TOOL_IDS = new Set(ROBOT_TOOLS.map((t) => t.id));

// Valid ranges for device-specific settings
const ROBOT_LIMITS = {
  inventorySize: { min: 4, max: 32, label: '物品栏格数' },
  tankCount: { min: 0, max: 4, label: '内部储罐数量' },
};
const DRONE_LIMITS = {
  maxVelocity: { min: 1, max: 32, label: '最大速度' },
  acceleration: { min: 1, max: 32, label: '加速度' },
  inventorySize: { min: 4, max: 32, label: '物品栏格数' },
};

// Sample script written when creating a custom machine
const MACHINE_SCRIPT_TEMPLATE = `-- 自定义机器示例: 太阳能板
-- 修改后保存即可生效; 完整说明见 MODS.md「自定义脚本机器」
return {
  components = {
    {
      type = "solar_panel",
      label = "太阳能板",
      state = {
        energy = 0,
        maxEnergy = 10000,
        active = true,
        efficiency = 0,
      },
      readonly = { "maxEnergy", "efficiency" },
      props = {
        energy = { label = "能量", unit = "EU", min = 0, max = 10000 },
        maxEnergy = { label = "容量", unit = "EU", min = 0, max = 100000 },
        active = { label = "运行", type = "boolean" },
        efficiency = { label = "效率", unit = "%", min = 0, max = 100 },
      },
      tick = function(self, dt)
        if self.active then
          self.energy = math.min(self.maxEnergy, self.energy + 5 * dt)
        end
        self.efficiency = math.floor(self.energy / self.maxEnergy * 100)
      end,
      methods = {
        isFull = function(self) return self.energy >= self.maxEnergy end,
      },
      actions = {
        reset = function(self) self.energy = 0 end,
      },
    },
  },
}
`;

function defaultRobotProfile() {
  return { toolMain: '', toolOff: '', inventorySize: 16, tankCount: 1 };
}

function defaultDroneProfile() {
  return { maxVelocity: 8, acceleration: 4, inventorySize: 16 };
}

// Validate on save: reject out-of-range values
function clampField(value, rule, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
    throw new Error(`${rule.label} 必须是 ${rule.min}-${rule.max} 的整数`);
  }
  return n;
}

// Lenient on read: silently fall back to the default for corrupted values
function readField(value, rule, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < rule.min || n > rule.max) return fallback;
  return n;
}

function normalizeRobotProfile(input = {}) {
  const def = defaultRobotProfile();
  const toolMain = input.toolMain == null ? def.toolMain : String(input.toolMain);
  const toolOff = input.toolOff == null ? def.toolOff : String(input.toolOff);
  if (!ROBOT_TOOL_IDS.has(toolMain)) throw new Error('无效的主手工具');
  if (!ROBOT_TOOL_IDS.has(toolOff)) throw new Error('无效的副手工具');
  return {
    toolMain,
    toolOff,
    inventorySize: clampField(input.inventorySize, ROBOT_LIMITS.inventorySize, def.inventorySize),
    tankCount: clampField(input.tankCount, ROBOT_LIMITS.tankCount, def.tankCount),
  };
}

function readRobotProfile(input = {}) {
  const def = defaultRobotProfile();
  return {
    toolMain: ROBOT_TOOL_IDS.has(input.toolMain) ? input.toolMain : def.toolMain,
    toolOff: ROBOT_TOOL_IDS.has(input.toolOff) ? input.toolOff : def.toolOff,
    inventorySize: readField(input.inventorySize, ROBOT_LIMITS.inventorySize, def.inventorySize),
    tankCount: readField(input.tankCount, ROBOT_LIMITS.tankCount, def.tankCount),
  };
}

function normalizeDroneProfile(input = {}) {
  const def = defaultDroneProfile();
  return {
    maxVelocity: clampField(input.maxVelocity, DRONE_LIMITS.maxVelocity, def.maxVelocity),
    acceleration: clampField(input.acceleration, DRONE_LIMITS.acceleration, def.acceleration),
    inventorySize: clampField(input.inventorySize, DRONE_LIMITS.inventorySize, def.inventorySize),
  };
}

function readDroneProfile(input = {}) {
  const def = defaultDroneProfile();
  return {
    maxVelocity: readField(input.maxVelocity, DRONE_LIMITS.maxVelocity, def.maxVelocity),
    acceleration: readField(input.acceleration, DRONE_LIMITS.acceleration, def.acceleration),
    inventorySize: readField(input.inventorySize, DRONE_LIMITS.inventorySize, def.inventorySize),
  };
}

// Custom machine property write: coerce to the declared type and clamp to range
function coerceMachineValue(prop, value) {
  if (!prop) return null;
  if (prop.kind === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    let result = num;
    if (Number.isFinite(prop.min)) result = Math.max(prop.min, result);
    if (Number.isFinite(prop.max)) result = Math.min(prop.max, result);
    return result;
  }
  if (prop.kind === 'boolean') {
    return value === true || value === 1 || value === 'true' || value === '1';
  }
  if (prop.kind === 'string') return String(value == null ? '' : value);
  return null;
}

class ModsManager extends VMManager {
  constructor(opts) {
    super({ ...opts, vmsDir: opts.modsDir, kind: 'mod' });
    this.modsDir = opts.modsDir;
    this.efiTemplate = path.join(opts.projectDir, 'mods-efi.lua');
    // Reactor runtime state: name -> { elapsed, hullHeat, absorbed, generatedEu, remainingCapacity, status }
    this.reactorRuntimes = new Map();
    // Script machines: host process / definitions / state / errors / device addresses
    this.machineHosts = new Map();
    this.machineDefinitions = new Map();
    this.machineStates = new Map();
    this.machineErrors = new Map();
    this.machineDeviceAddresses = new Map();
    this.machineOutputs = new Map();
    this.machineStateTexts = new Map();
    this.machineStopped = new Set();
    this.machineTimers = new Map();
    this.reactorTimer = setInterval(() => {
      this._tickReactors();
      this._tickMachines();
    }, 1000);
    if (this.reactorTimer.unref) this.reactorTimer.unref();
    fs.mkdirSync(this.modsDir, { recursive: true });
    // Re-attach existing reactors / script machines to the device bus
    this._loadReactorDevices();
    this._loadMachineMods();
    // Kill all machine script processes when the server exits
    process.once('exit', () => {
      for (const host of this.machineHosts.values()) {
        try { host.kill(); } catch { /* process already gone */ }
      }
    });
  }

  // ---------- Device bus ----------
  _loadReactorDevices() {
    if (!fs.existsSync(this.modsDir)) return;
    for (const name of fs.readdirSync(this.modsDir)) {
      const meta = this.readMeta(name);
      if (!meta || meta.type !== 'reactor') continue;
      try {
        this._ensureAddress(name);
        this.resetReactorRuntime(name);
        this._registerReactor(name);
      } catch {
        /* one failed device init must not affect the others */
      }
    }
  }

  // Component address: a UUID like OC's, persisted to mod.json on first creation
  _ensureAddress(name) {
    const meta = this.readMeta(name) || {};
    if (typeof meta.componentAddress === 'string' && meta.componentAddress) {
      return meta.componentAddress;
    }
    const address = crypto.randomUUID();
    this.writeMeta(name, { ...meta, componentAddress: address });
    return address;
  }

  // The redstone I/O component gets its own address, distinct from reactor_chamber
  _ensureRedstoneAddress(name) {
    const meta = this.readMeta(name) || {};
    if (typeof meta.redstoneAddress === 'string' && meta.redstoneAddress) {
      return meta.redstoneAddress;
    }
    let address = crypto.randomUUID();
    if (address === meta.componentAddress) address = crypto.randomUUID();
    this.writeMeta(name, { ...meta, redstoneAddress: address });
    return address;
  }

  // The transposer component gets its own address for moving items between tanks and core
  _ensureTransposerAddress(name) {
    const meta = this.readMeta(name) || {};
    if (typeof meta.transposerAddress === 'string' && meta.transposerAddress) {
      return meta.transposerAddress;
    }
    let address = crypto.randomUUID();
    while (address === meta.componentAddress || address === meta.redstoneAddress) {
      address = crypto.randomUUID();
    }
    this.writeMeta(name, { ...meta, transposerAddress: address });
    return address;
  }

  // Each reactor exposes three components to connected VMs:
  //   reactor_chamber: read-only telemetry (heat / maxHeat / EU/t) used by MineOS IC2Reactors etc.
  //   redstone:        redstone I/O control port
  //   transposer:      item transfer between core / fuel tank / waste tank
  _registerReactor(name) {
    if (!this.deviceBus) return null;
    const chamberAddress = this._ensureAddress(name);
    const redstoneAddress = this._ensureRedstoneAddress(name);
    const transposerAddress = this._ensureTransposerAddress(name);
    const vm = () => this.getConnectedVm(name);
    const state = () => this._reactorDeviceState(name);

    this.deviceBus.register({
      address: chamberAddress,
      type: 'reactor_chamber',
      name,
      vm,
      state,
      command: (method, args) => this._reactorCommand(name, method, args),
    });

    this.deviceBus.register({
      address: redstoneAddress,
      type: 'redstone',
      name,
      vm,
      state,
      command: (method, args) => this._reactorCommand(name, method, args),
    });

    this.deviceBus.register({
      address: transposerAddress,
      type: 'transposer',
      name,
      vm,
      state: () => this._transposerDeviceState(name),
      command: (method, args) => this._transposerCommand(name, method, args),
    });

    return redstoneAddress;
  }

  // VM this device is wired to; null means unconnected
  getConnectedVm(name) {
    const meta = this.readMeta(name);
    return meta && typeof meta.connectedVm === 'string' && meta.connectedVm ? meta.connectedVm : null;
  }

  // Connect / disconnect: a machine device is visible only to the wired VM
  connectDevice(name, vmName) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name) || {};
    if (COMPUTER_TYPES.has(meta.type)) throw new Error('Not a machine device');
    let target = null;
    if (vmName != null && vmName !== '') {
      if (typeof vmName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(vmName)) {
        throw new Error('Invalid VM name');
      }
      const cfgPath = path.join(this.projectDir, 'vms', vmName, 'config.json');
      if (!fs.existsSync(cfgPath)) throw new Error('VM not found');
      target = vmName;
    }
    const nextMeta = { ...meta };
    if (target) nextMeta.connectedVm = target;
    else delete nextMeta.connectedVm;
    this.writeMeta(name, nextMeta);
    // Visibility changed: push the new device table to running VMs immediately
    if (this.deviceBus) this.deviceBus.broadcastDevices();
    return { ok: true, connectedVm: target };
  }

  // Clear wirings pointing at a deleted VM so none dangle
  clearVmConnections(vmName) {
    if (!fs.existsSync(this.modsDir)) return;
    for (const name of fs.readdirSync(this.modsDir)) {
      const meta = this.readMeta(name);
      if (!meta || meta.connectedVm !== vmName) continue;
      const next = { ...meta };
      delete next.connectedVm;
      try {
        this.writeMeta(name, next);
      } catch {
        /* one failed device write must not affect the others */
      }
    }
  }

  // Rewrite wiring targets to the new VM name after a rename
  renameVmConnection(oldName, newName) {
    if (!fs.existsSync(this.modsDir)) return;
    for (const name of fs.readdirSync(this.modsDir)) {
      const meta = this.readMeta(name);
      if (!meta || meta.connectedVm !== oldName) continue;
      const next = { ...meta, connectedVm: newName };
      try {
        this.writeMeta(name, next);
      } catch {
        /* one failed device write must not affect the others */
      }
    }
  }

  _reactorDeviceState(name) {
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    // Per-cell durability lives in the raw runtime state; snapshots are for display only
    const raw = this.reactorRuntimes.get(name) || null;
    const runtime = this.getReactorRuntime(name, stats);
    const withDur = reactorModel.withDurability(stats, raw);
    const slots = new Array(stats.columns * stats.rows).fill(null);
    for (const cell of withDur.cells) {
      const comp = reactorModel.COMPONENTS[cell.id] || {};
      slots[cell.r * stats.columns + cell.c] = {
        id: cell.id,
        label: comp.label || cell.id,
        category: cell.category,
        tier: cell.tier || '',
        rods: cell.rods || 0,
        pulses: cell.pulses || 0,
        eu: cell.eu || 0,
        heat: cell.heat || 0,
        capacity: cell.capacity || 0,
        durability: cell.durability || 0,
        maxDurability: cell.maxDurability || 0,
        temperature: cell.temperature || 0,
        maxTemperature: cell.maxTemperature || 0,
        depleted: cell.depleted === true,
        active: cell.active !== false,
      };
    }
    return {
      name,
      active: config.active,
      stopWhenDepleted: config.stopWhenDepleted !== false,
      columns: stats.columns,
      rows: stats.rows,
      // Runtime output: 0 once the fuel rods are depleted
      euPerTick: runtime ? runtime.euPerTick : stats.euPerTick,
      heatPerTick: runtime ? runtime.heatPerTick : stats.heatPerTick,
      heatPerSecond: runtime ? runtime.heatPerSecond : stats.heatPerSecond,
      fuelRods: stats.fuelRods,
      activeRods: runtime ? runtime.activeRods : stats.fuelRods,
      hullHeat: runtime ? runtime.hullHeat : 0,
      hullHeatCapacity: stats.hullHeatCapacity,
      hullCooling: stats.hullCooling,
      temperature: runtime ? runtime.temperature : 0,
      maxTemperature: runtime ? runtime.maxTemperature : reactorModel.temperatureLimit(stats),
      overheated: !!runtime && !!runtime.overheated,
      remainingCapacity: runtime ? runtime.remainingCapacity : stats.effectiveHeatCapacity,
      totalCapacity: stats.effectiveHeatCapacity,
      generatedEu: runtime ? runtime.generatedEu : 0,
      elapsed: runtime ? runtime.elapsed : 0,
      status: runtime ? runtime.status : stats.status,
      slots,
    };
  }

  _reactorCommand(name, method, args) {
    const config = this.readReactorFile(name);
    const applyActive = (next) => {
      const nextConfig = { ...config, active: !!next };
      nextConfig.updated = new Date().toISOString();
      fs.writeFileSync(this.reactorPath(name), JSON.stringify(nextConfig, null, 2), 'utf8');
      this._notifyMachineState(name);
      return { ok: true, active: !!next };
    };

    if (method === 'setActive' || method === 'activate' || method === 'deactivate') {
      return applyActive(method === 'deactivate' ? false
        : method === 'activate' ? true
          : !!(args && args[0]));
    }

    // Redstone I/O: any output channel toggles the reactor (> 0 = running).
    // Programs like IC2Reactors let users pick the I/O port and side, so side is not constrained.
    if (method === 'setOutput') {
      const value = Number(args && args[1]) || 0;
      return applyActive(value > 0);
    }
    if (method === 'setBundledOutput') {
      const mask = Number(args && args[1]) || 0;
      return applyActive((mask & 1) !== 0);
    }

    // Temperature write: clamped to 0..max; the runtime clock shuts the reactor down at max
    if (method === 'setTemperature' || method === 'setHullHeat') {
      return this.setReactorTemperature(name, args && args[0]);
    }

    return { ok: false, error: `unknown method: ${method}` };
  }

  // ---------- Transposer ----------
  // Side 0 = reactor core, 1 = fuel tank, 2 = waste tank
  // The core side has as many slots as the current columns x 6
  _transposerSides(name) {
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    let runtime = this.reactorRuntimes.get(name) || null;
    if (!runtime) {
      this.resetReactorRuntime(name);
      runtime = this.reactorRuntimes.get(name) || null;
    }
    const withDur = reactorModel.withDurability(stats, runtime);
    const reactor = new Array(stats.columns * stats.rows).fill(null);
    for (const cell of withDur.cells) {
      const index = cell.r * stats.columns + cell.c;
      if (index >= 0 && index < reactor.length) {
        reactor[index] = { id: cell.id, durability: cell.durability };
      }
    }
    return {
      config,
      stats,
      runtime,
      inventories: {
        0: reactor,
        1: config.inventories.fuel.map(entry => (entry ? { ...entry } : null)),
        2: config.inventories.waste.map(entry => (entry ? { ...entry } : null)),
      },
    };
  }

  _transposerDeviceState(name) {
    const data = this._transposerSides(name);
    const sides = {};
    for (const key of ['0', '1', '2']) {
      const entries = data.inventories[key] || [];
      const slots = {};
      entries.forEach((entry, index) => {
        if (!entry) return;
        const stack = reactorModel.stackForEntry(entry.id, entry.durability);
        if (stack) slots[String(index)] = stack;
      });
      sides[key] = { size: entries.length, slots };
    }
    return { sides, mapping: reactorModel.TRANSPOSER_SIDES };
  }

  _transposerCommand(name, method, args) {
    if (method === 'transferItem') return this._transposerTransfer(name, args || []);
    return { ok: false, error: `unknown method: ${method}` };
  }

  // Slots are 1-based; 0 means auto (first non-empty source, first empty target)
  _transposerSlot(list, requested, source) {
    const slot = Math.floor(Number(requested) || 0);
    if (slot > 0) {
      const index = slot - 1;
      return index < list.length ? index : -1;
    }
    for (let i = 0; i < list.length; i++) {
      const empty = !list[i];
      if (source ? !empty : empty) return i;
    }
    return -1;
  }

  _transposerTransfer(name, args) {
    const fromSide = Number(args[0]);
    const toSide = Number(args[1]);
    const data = this._transposerSides(name);
    const from = data.inventories[fromSide];
    const to = data.inventories[toSide];
    if (!from || !to) return { ok: false, error: 'invalid side' };
    const srcIndex = this._transposerSlot(from, args[3], true);
    if (srcIndex < 0 || !from[srcIndex]) return { ok: false, error: 'source empty' };
    const dstIndex = this._transposerSlot(to, args[4], false);
    if (dstIndex < 0) return { ok: false, error: 'target full' };
    if (to[dstIndex]) return { ok: false, error: 'target occupied' };
    to[dstIndex] = from[srcIndex];
    from[srcIndex] = null;
    this._applyTransposerInventories(name, data);
    return { ok: true, from: srcIndex + 1, to: dstIndex + 1 };
  }

  // Write back to reactor.json and sync core slot durability into the runtime
  _applyTransposerInventories(name, data) {
    const { config, stats, runtime } = data;
    const grid = config.grid.map(row => row.slice());
    const limit = stats.columns * stats.rows;
    const entries = data.inventories[0];
    for (let i = 0; i < limit; i++) {
      const r = Math.floor(i / stats.columns);
      const c = i % stats.columns;
      if (!grid[r]) continue;
      const entry = entries[i];
      grid[r][c] = entry ? entry.id : null;
      if (runtime) {
        const key = `${r}:${c}`;
        if (entry) runtime.cells[key] = entry.durability;
        else delete runtime.cells[key];
      }
    }
    const fuel = data.inventories[1].map(entry => (entry ? { ...entry } : null));
    const waste = data.inventories[2].map(entry => (entry ? { ...entry } : null));
    const next = {
      ...config,
      grid,
      inventories: { fuel, waste },
      updated: new Date().toISOString(),
    };
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
    this._notifyMachineState(name);
    if (this.deviceBus) this.deviceBus.broadcastDevices();
  }

  // ---------- Fuel / waste tanks ----------
  // Item catalog: IC2 item names and metadata; the UI builds its item picker from it
  reactorItemCatalog() {
    const items = {};
    for (const id of Object.keys(reactorModel.COMPONENTS)) {
      const item = reactorModel.itemOfComponent(id);
      if (!item) continue;
      items[id] = {
        name: item.name,
        metadata: item.metadata,
        label: reactorModel.COMPONENTS[id].label,
        category: reactorModel.COMPONENTS[id].category,
        capacity: reactorModel.componentCapacity(id),
        stack: reactorModel.stackForEntry(id, reactorModel.componentCapacity(id)),
      };
    }
    return items;
  }

  getReactorInventory(name) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const config = this.readReactorFile(name);
    return {
      fuel: config.inventories.fuel,
      waste: config.inventories.waste,
      items: this.reactorItemCatalog(),
      size: reactorModel.INVENTORY_SIZE,
      sides: reactorModel.TRANSPOSER_SIDES,
    };
  }

  // Edit the fuel / waste tank: write to the given slot, or clear it when no id is given;
  // without a slot, use the first empty one
  setReactorInventory(name, payload = {}) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const config = this.readReactorFile(name);
    const box = payload.box === 'waste' ? 'waste' : 'fuel';
    const list = config.inventories[box].slice();
    const slot = Math.floor(Number(payload.slot) || 0);
    const id = payload.id ? reactorModel.resolveId(payload.id) : null;
    if (payload.id && !id) throw new Error('未知的组件');
    let index = -1;
    if (slot > 0 && slot <= list.length) index = slot - 1;
    else if (id) index = list.findIndex(entry => !entry);
    if (index < 0) throw new Error('没有可用的库存槽位');
    if (!id) list[index] = null;
    else {
      const max = reactorModel.componentCapacity(id);
      const durability = Number.isFinite(Number(payload.durability))
        ? Math.max(0, Math.min(max, Number(payload.durability)))
        : max;
      list[index] = { id, durability };
    }
    const next = {
      ...config,
      inventories: {
        ...config.inventories,
        [box]: reactorModel.normalizeInventory(list),
      },
      updated: new Date().toISOString(),
    };
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
    if (this.deviceBus) this.deviceBus.broadcastDevices();
    return { ok: true, fuel: next.inventories.fuel, waste: next.inventories.waste };
  }

  // Runtime options: auto-stop when fuel is depleted (on by default)
  setReactorOptions(name, options = {}) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    const config = this.readReactorFile(name);
    const next = { ...config, updated: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(options, 'stopWhenDepleted')) {
      next.stopWhenDepleted = options.stopWhenDepleted !== false;
    }
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
    this._notifyMachineState(name);
    return { ok: true, stopWhenDepleted: next.stopWhenDepleted };
  }

  // Set core temperature; returns the applied temperature and the limit
  setReactorTemperature(name, value) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    let runtime = this.reactorRuntimes.get(name);
    if (!runtime) {
      this.resetReactorRuntime(name);
      runtime = this.reactorRuntimes.get(name);
    }
    const temperature = reactorModel.setTemperature(runtime, stats, value);
    return {
      ok: true,
      temperature,
      maxTemperature: stats.hullHeatCapacity,
      overheated: reactorModel.isOverheated(runtime, stats),
      runtime: this.getReactorRuntime(name, stats),
    };
  }

  // ---------- Script machines ----------
  _loadMachineMods() {
    if (!fs.existsSync(this.modsDir)) return;
    for (const name of fs.readdirSync(this.modsDir)) {
      const meta = this.readMeta(name);
      if (!meta || meta.type !== 'machine') continue;
      try {
        this._ensureMachineFiles(name);
        this._startMachineHost(name);
      } catch {
        /* one failed machine start must not affect the others */
      }
    }
  }

  _ensureMachineFiles(name) {
    const dir = this.modDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = this.machineScriptPath(name);
    if (!fs.existsSync(scriptPath)) {
      fs.writeFileSync(scriptPath, MACHINE_SCRIPT_TEMPLATE, 'utf8');
    }
    const filePath = this.machinePath(name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, addresses: {}, state: {} }, null, 2), 'utf8');
    }
  }

  readMachineFile(name) {
    try {
      const data = JSON.parse(fs.readFileSync(this.machinePath(name), 'utf8'));
      return {
        version: 1,
        addresses: data && typeof data.addresses === 'object' ? data.addresses : {},
        state: data && typeof data.state === 'object' ? data.state : {},
      };
    } catch {
      return { version: 1, addresses: {}, state: {} };
    }
  }

  writeMachineFile(name, data) {
    fs.writeFileSync(this.machinePath(name), JSON.stringify(data, null, 2), 'utf8');
  }

  _startMachineHost(name) {
    const existing = this.machineHosts.get(name);
    if (existing && existing.alive) return;
    if (this.machineStopped.has(name)) return;
    this._ensureMachineFiles(name);
    const file = this.readMachineFile(name);
    const host = new MachineHost({
      name,
      luaExe: this.luaExe,
      hostScript: path.join(this.projectDir, 'machine-host.lua'),
      projectDir: this.projectDir,
      scriptPath: this.machineScriptPath(name),
      initialState: file.state || {},
      logger: this.logger,
      onReady: (definition) => {
        this.machineDefinitions.set(name, definition);
        this.machineErrors.delete(name);
        this._registerMachine(name);
        this._notifyMachineState(name);
      },
      onState: (message) => {
        this.machineStates.set(name, Array.isArray(message.components) ? message.components : []);
        if (typeof message.error === 'string' && message.error) {
          this.machineErrors.set(name, message.error);
        } else {
          this.machineErrors.delete(name);
        }
        this._persistMachineState(name);
      },
      onError: (message) => {
        this.machineErrors.set(name, message);
      },
      onExit: () => {
        // On restart the old process may exit after the new one; only handle events for the current host
        if (this.machineHosts.get(name) !== host) return;
        this.machineHosts.delete(name);
        this.machineDefinitions.delete(name);
        this.machineStates.delete(name);
        this.machineErrors.set(name, '脚本进程已退出');
        this._unregisterMachine(name);
        this._notifyMachineState(name);
        if (!this.machineStopped.has(name)) this._scheduleMachineRestart(name);
      },
    });
    this.machineHosts.set(name, host);
    host.start();
  }

  _scheduleMachineRestart(name) {
    if (this.machineTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.machineTimers.delete(name);
      if (this.machineStopped.has(name)) return;
      if (!fs.existsSync(this.modDir(name))) return;
      this._startMachineHost(name);
    }, 3000);
    if (timer.unref) timer.unref();
    this.machineTimers.set(name, timer);
  }

  _restartMachineHost(name, startAfter = true) {
    const host = this.machineHosts.get(name);
    this.machineStopped.add(name);
    if (host) host.stop();
    this.machineHosts.delete(name);
    this.machineDefinitions.delete(name);
    this.machineStates.delete(name);
    this.machineErrors.delete(name);
    this._unregisterMachine(name);
    const timer = setTimeout(() => {
      this.machineTimers.delete(name);
      if (!startAfter) return;
      this.machineStopped.delete(name);
      this._startMachineHost(name);
    }, 150);
    if (timer.unref) timer.unref();
    this.machineTimers.set(name, timer);
  }

  _tickMachines() {
    for (const host of this.machineHosts.values()) {
      if (host.alive) host.tick(1);
    }
  }

  _persistMachineState(name) {
    const states = this.machineStates.get(name) || [];
    const saved = {};
    states.forEach((entry, index) => {
      saved[String(index)] = entry && entry.state ? entry.state : {};
    });
    const text = JSON.stringify(saved);
    if (this.machineStateTexts.get(name) === text) return;
    this.machineStateTexts.set(name, text);
    const file = this.readMachineFile(name);
    file.state = saved;
    try {
      this.writeMachineFile(name, file);
    } catch {
      /* a failed write must not block the script */
    }
  }

  _ensureMachineAddress(name, key, file) {
    if (!file.addresses[key]) file.addresses[key] = crypto.randomUUID();
    return file.addresses[key];
  }

  // Attach script-defined components to the device bus, one address per component
  _registerMachine(name) {
    if (!this.deviceBus) return;
    const definition = this.machineDefinitions.get(name);
    if (!definition) return;
    this._unregisterMachine(name);

    const file = this.readMachineFile(name);
    const vm = () => this.getConnectedVm(name);
    const addresses = [];

    for (let index = 0; index < definition.components.length; index++) {
      const component = definition.components[index];
      const address = this._ensureMachineAddress(name, String(index), file);
      addresses.push(address);
      this.deviceBus.register({
        address,
        type: component.type,
        name,
        vm,
        meta: {
          label: component.label,
          props: component.props,
          methods: component.methods,
          actions: component.actions,
        },
        state: () => this._machineComponentState(name, index),
        command: (method, args) => this._machineCommand(name, index, method, args),
      });
    }

    if (definition.redstone !== false) {
      const address = this._ensureMachineAddress(name, 'redstone', file);
      addresses.push(address);
      this.deviceBus.register({
        address,
        type: 'redstone',
        name,
        vm,
        meta: { machine: true },
        state: () => this._machineRedstoneState(name),
        command: (method, args) => this._machineRedstoneCommand(name, method, args),
      });
    }

    this.writeMachineFile(name, file);
    this.machineDeviceAddresses.set(name, addresses);
    this.deviceBus.broadcastDevices();
  }

  _unregisterMachine(name) {
    const addresses = this.machineDeviceAddresses.get(name) || [];
    if (this.deviceBus) {
      for (const address of addresses) this.deviceBus.unregister(address);
    }
    this.machineDeviceAddresses.delete(name);
    this.machineOutputs.delete(name);
  }

  _machineComponentState(name, index) {
    const definition = this.machineDefinitions.get(name);
    const component = definition ? definition.components[index] : null;
    const entry = (this.machineStates.get(name) || [])[index] || {};
    return {
      type: component ? component.type : 'machine_component',
      label: component ? component.label : '',
      index,
      ...(entry.state || {}),
      ...(entry.methods || {}),
    };
  }

  _machineCommand(name, index, method, args) {
    const definition = this.machineDefinitions.get(name);
    const host = this.machineHosts.get(name);
    const component = definition ? definition.components[index] : null;
    if (!host || !host.ready || !component) return { ok: false, error: 'machine offline' };
    const list = Array.isArray(args) ? args : [];

    if (method === 'setValue' || method === 'set') {
      const key = list[0];
      const prop = (component.props || []).find(p => p.key === key);
      if (!prop || !prop.writable) return { ok: false, error: 'read-only property' };
      const value = coerceMachineValue(prop, list[1]);
      if (value === null) return { ok: false, error: 'invalid value' };
      host.setValue(index, key, value);
      return { ok: true, key, value };
    }

    if (method === 'action') {
      const action = list[0];
      if (!(component.actions || []).includes(action)) return { ok: false, error: 'unknown action' };
      host.action(index, action, Array.isArray(list[1]) ? list[1] : []);
      return { ok: true, action };
    }

    return { ok: false, error: `unknown method: ${method}` };
  }

  // Redstone channels: every numeric / boolean property, in component order
  _machineChannels(name) {
    const definition = this.machineDefinitions.get(name);
    const channels = [];
    if (!definition) return channels;
    definition.components.forEach((component, index) => {
      for (const prop of component.props || []) {
        if (prop.kind !== 'number' && prop.kind !== 'boolean') continue;
        channels.push({
          index,
          key: prop.key,
          label: prop.label || prop.key,
          kind: prop.kind,
          min: Number(prop.min),
          max: Number(prop.max),
          writable: !!prop.writable,
        });
      }
    });
    return channels;
  }

  _machineInputSignal(prop, value) {
    if (prop.kind === 'boolean') return value ? 15 : 0;
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const min = Number.isFinite(prop.min) ? prop.min : 0;
    const max = Number.isFinite(prop.max) ? prop.max : 0;
    if (max > min) {
      return Math.max(0, Math.min(15, Math.round(((num - min) / (max - min)) * 15)));
    }
    return Math.max(0, Math.min(15, Math.round(num)));
  }

  _machineRedstoneState(name) {
    const channels = this._machineChannels(name);
    const entries = this.machineStates.get(name) || [];
    const outputs = this.machineOutputs.get(name) || new Array(channels.length).fill(0);
    return {
      machine: true,
      sideCount: channels.length,
      inputs: channels.map((channel) => {
        const entry = entries[channel.index] || {};
        return this._machineInputSignal(channel, (entry.state || {})[channel.key]);
      }),
      outputs,
      channels: channels.map(channel => ({
        key: channel.key,
        label: channel.label,
        writable: channel.writable,
      })),
    };
  }

  _machineRedstoneCommand(name, method, args) {
    if (method !== 'setOutput') return 0;
    const list = Array.isArray(args) ? args : [];
    const side = Number(list[0]) || 0;
    const value = Math.max(0, Math.min(15, Number(list[1]) || 0));
    const channels = this._machineChannels(name);
    const channel = channels[side];
    if (!channel) return value;

    const outputs = this.machineOutputs.get(name) || new Array(channels.length).fill(0);
    outputs[side] = value;
    this.machineOutputs.set(name, outputs);

    if (channel.writable) {
      const host = this.machineHosts.get(name);
      if (host && host.ready) {
        const mapped = channel.kind === 'boolean'
          ? value > 0
          : (channel.max > channel.min
            ? channel.min + (value / 15) * (channel.max - channel.min)
            : value);
        host.setValue(channel.index, channel.key, mapped);
      }
    }
    return value;
  }

  // For the API / UI: script contents + component definitions + current state
  getMachine(name) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    if (!meta || meta.type !== 'machine') throw new Error('Not a machine mod');
    this._ensureMachineFiles(name);
    const file = this.readMachineFile(name);
    const definition = this.machineDefinitions.get(name) || { components: [], redstone: true };
    const entries = this.machineStates.get(name) || [];
    const host = this.machineHosts.get(name);
    return {
      name,
      running: !!(host && host.alive),
      error: this.machineErrors.get(name) || null,
      redstone: definition.redstone !== false,
      script: fs.readFileSync(this.machineScriptPath(name), 'utf8'),
      connectedVm: this.getConnectedVm(name),
      components: (definition.components || []).map((component, index) => ({
        type: component.type,
        label: component.label,
        props: component.props || [],
        actions: component.actions || [],
        address: (file.addresses || {})[String(index)] || null,
        state: (entries[index] && entries[index].state) || {},
        methods: (entries[index] && entries[index].methods) || {},
      })),
    };
  }

  saveMachineScript(name, script) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    if (!meta || meta.type !== 'machine') throw new Error('Not a machine mod');
    if (typeof script !== 'string') throw new Error('Invalid script');
    if (Buffer.byteLength(script, 'utf8') > 256 * 1024) throw new Error('Script too large');
    const wasStopped = this.machineStopped.has(name) || !this.machineHosts.has(name);
    this._ensureMachineFiles(name);
    fs.writeFileSync(this.machineScriptPath(name), script, 'utf8');
    this._restartMachineHost(name, !wasStopped);
    return { ok: true };
  }

  setMachineState(name, componentIndex, key, value) {
    return this._machineCommand(name, componentIndex, 'setValue', [key, value]);
  }

  runMachineAction(name, componentIndex, action, args) {
    return this._machineCommand(name, componentIndex, 'action', [action, Array.isArray(args) ? args : []]);
  }

  // ---------- Paths ----------
  modDir(name) { return path.join(this.modsDir, name); }
  metaPath(name) { return path.join(this.modsDir, name, 'mod.json'); }
  efiPath(name) { return path.join(this.modsDir, name, 'efi.lua'); }
  diskPath(name) { return path.join(this.modsDir, name, 'disk.ocd'); }
  reactorPath(name) { return path.join(this.modsDir, name, 'reactor.json'); }
  machinePath(name) { return path.join(this.modsDir, name, 'machine.json'); }
  machineScriptPath(name) { return path.join(this.modsDir, name, 'machine.lua'); }

  // ---------- Metadata ----------
  readMeta(name) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  writeMeta(name, meta) {
    fs.writeFileSync(this.metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
  }

  // ---------- Auto-provisioning: EFI / boot disk / config ----------
  provision(name, typeHint) {
    const dir = this.modDir(name);
    fs.mkdirSync(dir, { recursive: true });

    let meta = this.readMeta(name);
    let type = typeHint && MOD_TYPES.has(typeHint) ? typeHint : null;
    if (!meta) {
      type = type || 'robot';
      meta = {
        name,
        type,
        description: '',
        markers: [],
        efi: 'built-in',
        created: new Date().toISOString(),
      };
      this.writeMeta(name, meta);
    } else if (MOD_TYPES.has(meta.type)) {
      type = meta.type;
    }
    type = type || 'robot';

    // Machine devices (reactors) run no program: no EFI / boot disk / hardware config,
    // only their layout file, and they hang off the device bus as a reactor component
    if (type === 'reactor') {
      const reactorPath = this.reactorPath(name);
      if (!fs.existsSync(reactorPath)) {
        fs.writeFileSync(reactorPath, JSON.stringify(reactorModel.defaultReactor(), null, 2), 'utf8');
      }
      this._ensureAddress(name);
      if (!this.reactorRuntimes.has(name)) this.resetReactorRuntime(name);
      this._registerReactor(name);
      return { name, type, meta, config: null };
    }

    // Script machine: just machine.lua + machine.json, executed by a host process
    if (type === 'machine') {
      this._ensureMachineFiles(name);
      this._startMachineHost(name);
      return { name, type, meta, config: null };
    }

    // Built-in EFI: install when missing, empty, or larger than the 4KB EEPROM limit
    const efiPath = this.efiPath(name);
    const needEfi = !fs.existsSync(efiPath)
      || fs.statSync(efiPath).size === 0
      || fs.statSync(efiPath).size > 4096;
    if (needEfi) {
      if (!fs.existsSync(this.efiTemplate)) {
        throw new Error('内置 EFI 模板缺失: mods-efi.lua');
      }
      fs.copyFileSync(this.efiTemplate, efiPath);
    }

    // Empty boot disk: the EFI needs a filesystem to finish the boot sequence
    const diskPath = this.diskPath(name);
    if (!fs.existsSync(diskPath)) {
      if (!this.diskIO) throw new Error('DiskIO 不可用, 无法创建启动盘');
      this.diskIO.save(diskPath, {
        label: `${name}-mods`,
        files: { '/': { type: 'directory', modified: Date.now() / 1000 } },
        size: 1024 * 1024,
        tier: 1,
        locked: false,
      });
    }

    // VM config: create when missing, otherwise backfill the fields a Mods device needs
    let cfg = this.getConfig(name);
    if (!cfg) {
      cfg = {
        name,
        version: 4,
        created: new Date().toISOString(),
        modsDevice: true,
        hardware: {
          apu: { tier: 1 },
          memory: [1, 1],
          disk1: 'disk.ocd',
          disk2: null,
          floppy: null,
          eeprom: 'efi.lua',
          eepromLabel: 'Mods EFI',
          expansion: ['wireless_t2', null, null],
          mods: true,
          modsName: name,
          modsType: type,
          bootOrder: ['disk1'],
        },
        screen: { tier: 1 },
        state: { running: false, lastBoot: null },
      };
      this.saveConfig(name, cfg);
    } else {
      let changed = false;
      cfg.modsDevice = true;
      if (!cfg.hardware) { cfg.hardware = {}; changed = true; }
      const hw = cfg.hardware;
      if (!hw.eeprom) { hw.eeprom = 'efi.lua'; changed = true; }
      if (!hw.disk1) { hw.disk1 = 'disk.ocd'; changed = true; }
      if (hw.modsName !== name) { hw.modsName = name; changed = true; }
      if (hw.modsType !== type) { hw.modsType = type; changed = true; }
      if (hw.mods !== true) { hw.mods = true; changed = true; }
      const hasWireless = (hw.expansion || []).some(c => typeof c === 'string' && c.indexOf('wireless') === 0);
      if (!hasWireless) {
        hw.expansion = hw.expansion || [null, null, null];
        hw.expansion[0] = 'wireless_t2';
        changed = true;
      }
      if (changed) this.saveConfig(name, cfg);
    }

    // Device-specific config: separate fields for robots / drones
    if (type === 'robot' && !cfg.hardware.robot) {
      cfg.hardware.robot = defaultRobotProfile();
      this.saveConfig(name, cfg);
    } else if (type === 'drone' && !cfg.hardware.drone) {
      cfg.hardware.drone = defaultDroneProfile();
      this.saveConfig(name, cfg);
    }

    return { name, type, meta, config: cfg };
  }

  // ---------- Listing / details ----------
  listMods() {
    if (!fs.existsSync(this.modsDir)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.modsDir)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) continue;
      const dir = this.modDir(name);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const hasMeta = fs.existsSync(this.metaPath(name));
      const cfg = this.getConfig(name);
      if (!hasMeta && !cfg) continue;

      const meta = this.readMeta(name) || {};
      const proc = this.processes.get(name);
      const type = MOD_TYPES.has(meta.type) ? meta.type
        : (cfg && cfg.hardware && MOD_TYPES.has(cfg.hardware.modsType) ? cfg.hardware.modsType : 'robot');
      const isComputer = COMPUTER_TYPES.has(type);
      const runtimeState = proc ? proc.state : 'stopped';
      const modState = proc && proc.modState ? proc.modState : null;
      const address = isComputer
        ? (proc ? (proc.modAddress || proc.modemAddress || null) : null)
        : (meta.componentAddress || null);
      const efiExists = isComputer
        && fs.existsSync(this.efiPath(name))
        && fs.statSync(this.efiPath(name)).size > 0;

      let reactor = null;
      if (type === 'reactor') {
        try {
          const rcfg = this.readReactorFile(name);
          const stats = reactorModel.computeStats(rcfg);
          reactor = {
            columns: stats.columns,
            rows: stats.rows,
            active: stats.active,
            euPerTick: stats.euPerTick,
            heatPerTick: stats.heatPerTick,
            heatPerSecond: stats.heatPerSecond,
            status: stats.status,
            counts: stats.counts,
          };
        } catch { /* a corrupt layout must not break the listing */ }
      }

      const machineHost = type === 'machine' ? this.machineHosts.get(name) : null;
      out.push({
        name,
        type,
        computer: isComputer,
        description: typeof meta.description === 'string' ? meta.description : '',
        markers: Array.isArray(meta.markers) ? meta.markers : [],
        // Machine devices have no process: reactors follow the switch, script machines the host
        state: isComputer ? runtimeState
          : (type === 'machine'
            ? (machineHost && machineHost.alive ? 'running' : 'stopped')
            : (reactor && reactor.active ? 'running' : 'stopped')),
        address,
        efi: isComputer ? (efiExists ? 'built-in' : 'missing') : null,
        disk: isComputer ? fs.existsSync(this.diskPath(name)) : false,
        created: meta.created || (cfg && cfg.created) || null,
        position: modState && modState.position ? modState.position : null,
        lastError: type === 'machine'
          ? (this.machineErrors.get(name) || null)
          : (modState ? (modState.lastError || null) : null),
        connectedVm: (type === 'reactor' || type === 'machine') ? this.getConnectedVm(name) : null,
        reactor,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  getMod(name) {
    const list = this.listMods();
    const item = list.find(m => m.name === name);
    if (!item) return null;
    const runtime = this.getRuntime(name);
    const isComputer = item.computer !== false;
    return {
      ...item,
      state: isComputer ? runtime.state : item.state,
      address: isComputer ? (runtime.address || item.address) : item.address,
      modState: isComputer ? runtime.modState : null,
      logs: isComputer ? runtime.logs : [],
      config: this.getConfig(name),
      reactor: item.type === 'reactor' ? this.getReactor(name) : null,
      machine: item.type === 'machine' ? this.getMachine(name) : null,
      profile: this.getProfile(name),
    };
  }

  // ---------- Device-specific config ----------
  // Only robots / drones return one; other types return null and the UI hides the tab
  getProfile(name) {
    if (!fs.existsSync(this.modDir(name))) return null;
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const hw = (cfg && cfg.hardware) || {};
    const type = (meta && meta.type) || hw.modsType || 'robot';

    if (type === 'robot') {
      return {
        type,
        value: readRobotProfile(hw.robot || {}),
        tools: ROBOT_TOOLS,
        limits: ROBOT_LIMITS,
      };
    }
    if (type === 'drone') {
      return {
        type,
        value: readDroneProfile(hw.drone || {}),
        tools: null,
        limits: DRONE_LIMITS,
      };
    }
    return null;
  }

  // ---------- Reactor layout ----------
  readReactorFile(name) {
    const file = this.reactorPath(name);
    if (!fs.existsSync(file)) return reactorModel.defaultReactor();
    try {
      return reactorModel.normalizeReactor(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return reactorModel.defaultReactor();
    }
  }

  getReactor(name) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    const runtime = this.getReactorRuntime(name, stats);
    return {
      config,
      stats: reactorModel.withDurability(stats, this.reactorRuntimes.get(name) || null),
      components: reactorModel.COMPONENTS,
      connectedVm: this.getConnectedVm(name),
      limits: {
        rows: reactorModel.ROWS,
        minColumns: reactorModel.MIN_COLUMNS,
        maxColumns: reactorModel.MAX_COLUMNS,
      },
      runtime,
    };
  }

  // ---------- Reactor runtime ----------
  // A reactor is not a computer: it advances while the "running" switch is on,
  // independent of any VM process.
  _tickReactors() {
    for (const name of Array.from(this.reactorRuntimes.keys())) {
      let config;
      try {
        config = this.readReactorFile(name);
      } catch {
        continue;
      }
      const stats = reactorModel.computeStats(config);
      const runtime = this.reactorRuntimes.get(name);
      // Advance even when stopped: the hull cools at the IC2 rate
      reactorModel.stepRuntime(runtime, stats, 1);
      if (!config.active) continue;
      // At max temperature: shut down automatically, writing the file once
      if (reactorModel.isOverheated(runtime, stats)) {
        this._overheatShutdown(name, runtime);
      } else if (config.stopWhenDepleted !== false
        && stats.fuelRods > 0
        && runtime
        && runtime.activeRods === 0) {
        // All fuel rods depleted: auto-stop when the option is enabled
        this._depletedShutdown(name, runtime);
      }
    }
  }

  // Depletion guard: turn the reactor off and mark the status depleted
  _depletedShutdown(name, runtime) {
    if (runtime) runtime.status = 'depleted';
    try {
      const config = this.readReactorFile(name);
      if (!config.active) return;
      const next = { ...config, active: false, updated: new Date().toISOString() };
      fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
      this._notifyMachineState(name);
      if (this.deviceBus) this.deviceBus.broadcastDevices();
    } catch {
      /* the next tick retries if the write fails */
    }
  }

  // Overheat guard: turn the reactor off and keep the core state (a reset is needed to restart)
  _overheatShutdown(name, runtime) {
    if (runtime) runtime.status = 'overheat';
    try {
      const config = this.readReactorFile(name);
      if (!config.active) return;
      const next = { ...config, active: false, updated: new Date().toISOString() };
      fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
      this._notifyMachineState(name);
      if (this.deviceBus) this.deviceBus.broadcastDevices();
    } catch {
      /* the next tick retries if the write fails */
    }
  }

  resetReactorRuntime(name) {
    let stats;
    try {
      stats = reactorModel.computeStats(this.readReactorFile(name));
    } catch {
      stats = null;
    }
    this.reactorRuntimes.set(name, reactorModel.initRuntime(stats));
  }

  // Start / stop: only toggles the switch, never resets the core state
  setReactorActive(name, active) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    const config = this.readReactorFile(name);
    const next = { ...config, active: !!active, updated: new Date().toISOString() };
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
    // Zero the live output right after stopping instead of waiting for the next tick
    const runtime = this.reactorRuntimes.get(name);
    if (runtime && !next.active) {
      runtime.status = 'off';
      runtime.euPerSecond = 0;
      runtime.heatPerSecond = 0;
      runtime.activeRods = 0;
    }
    this._notifyMachineState(name);
    const stats = reactorModel.computeStats(next);
    return { ok: true, active: next.active, stats, runtime: this.getReactorRuntime(name, stats) };
  }

  // Reset the core: replace coolant cells and clear core heat
  resetReactor(name) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    this.resetReactorRuntime(name);
    const stats = reactorModel.computeStats(this.readReactorFile(name));
    return { ok: true, runtime: this.getReactorRuntime(name, stats) };
  }

  getReactorRuntime(name, stats) {
    const runtime = this.reactorRuntimes.get(name);
    if (!runtime) return null;
    let st = stats;
    if (!st) {
      try {
        st = reactorModel.computeStats(this.readReactorFile(name));
      } catch {
        st = null;
      }
    }
    // For machine devices "running" simply means the switch is on
    const active = st ? st.active : true;
    const snapshot = reactorModel.runtimeSnapshot(runtime, st, active);
    if (snapshot && !active) {
      snapshot.euPerTick = 0;
      snapshot.euPerSecond = 0;
      snapshot.heatPerTick = 0;
      snapshot.heatPerSecond = 0;
      snapshot.activeRods = 0;
      // Keep the overheat / depleted reason after a stop
      if (snapshot.status !== 'overheat' && snapshot.status !== 'depleted') {
        snapshot.status = 'off';
      }
    }
    return snapshot;
  }

  saveReactor(name, input) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    const current = this.readReactorFile(name);
    // The UI saves layouts without inventories, so keep the existing tank contents
    const normalized = reactorModel.normalizeReactor({
      ...(input && typeof input === 'object' ? input : {}),
      inventories: (input && input.inventories) || current.inventories,
    });
    normalized.updated = new Date().toISOString();
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(normalized, null, 2), 'utf8');
    // Layout changed: restart the core from scratch
    this.resetReactorRuntime(name);
    this._notifyMachineState(name);
    const stats = reactorModel.computeStats(normalized);
    return {
      ok: true,
      config: normalized,
      stats,
      runtime: this.getReactorRuntime(name, stats),
    };
  }

  // ---------- EFI editing ----------
  getEfi(name) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const efiPath = this.efiPath(name);
    const content = fs.existsSync(efiPath) ? fs.readFileSync(efiPath, 'utf8') : '';
    const template = fs.existsSync(this.efiTemplate) ? fs.readFileSync(this.efiTemplate, 'utf8') : '';
    return {
      content,
      template,
      size: Buffer.byteLength(content, 'utf8'),
      maxSize: EFI_MAX_BYTES,
    };
  }

  saveEfi(name, content) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    if (typeof content !== 'string') throw new Error('EFI 内容必须是字符串');
    // Strip a BOM that may have been pasted in from an editor
    content = content.replace(/^\uFEFF/, '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.trim() === '') throw new Error('EFI 不能为空');
    if (bytes > EFI_MAX_BYTES) {
      throw new Error(`EFI 不能超过 ${EFI_MAX_BYTES} 字节（当前 ${bytes} 字节）`);
    }
    fs.writeFileSync(this.efiPath(name), content, 'utf8');
    return { ok: true, size: bytes, maxSize: EFI_MAX_BYTES };
  }

  // ---------- Hardware config ----------
  updateHardware(name, patch = {}) {
    const cfg = this.getConfig(name);
    if (!cfg) throw new Error('Mod config not found');
    if (!cfg.hardware) cfg.hardware = {};
    const hw = cfg.hardware;

    if (patch.apu !== undefined) {
      const tier = patch.apu && typeof patch.apu === 'object' ? patch.apu.tier : patch.apu;
      if (!APU_TIERS.has(tier)) throw new Error('无效的 APU 等级');
      hw.apu = { tier };
    }

    if (patch.memory !== undefined) {
      const mem = Array.isArray(patch.memory) ? patch.memory : null;
      if (!mem || mem.length < 2) throw new Error('内存配置格式错误');
      const total = Number(mem[0]);
      if (!MEM_TIERS.has(total)) throw new Error('无效的内存容量');
      hw.memory = [total, total];
      // Clear custom capacity when switching back to tiers so stale values do not win
      delete hw.memoryMB;
    }

    if (patch.memoryMB !== undefined) {
      const mb = Number(patch.memoryMB);
      if (!Number.isFinite(mb) || mb <= 0) throw new Error('无效的内存容量');
      // Custom capacity on one stick, the other left empty (0 = empty slot)
      hw.memoryMB = [mb, 0];
    }

    if (patch.expansion !== undefined) {
      if (!Array.isArray(patch.expansion)) throw new Error('扩展卡配置格式错误');
      const exp = [null, null, null];
      for (let i = 0; i < 3; i++) {
        let v = patch.expansion[i];
        if (v === undefined || v === null || v === '') v = '';
        if (!EXPANSIONS.has(v)) throw new Error(`无效的扩展卡: ${v}`);
        exp[i] = v === '' ? null : v;
      }
      hw.expansion = exp;
    }

    if (patch.modemStrength !== undefined) {
      const s = patch.modemStrength;
      if (s === null || s === '' || s === 'auto') {
        hw.modemStrength = null;
      } else {
        const n = parseInt(s, 10);
        if (!Number.isFinite(n) || n < 1 || n > 16) throw new Error('无线信号强度必须是 1-16 或 auto');
        hw.modemStrength = n;
      }
    }

    if (patch.screenTier !== undefined) {
      const tier = Number(patch.screenTier);
      if (!SCREEN_TIERS.has(tier)) throw new Error('无效的屏幕等级');
      cfg.screen = cfg.screen || {};
      cfg.screen.tier = tier;
    }

    if (patch.profile !== undefined) {
      const meta = this.readMeta(name);
      const type = (meta && meta.type) || hw.modsType || 'robot';
      if (type === 'robot') {
        hw.robot = normalizeRobotProfile(patch.profile || {});
      } else if (type === 'drone') {
        hw.drone = normalizeDroneProfile(patch.profile || {});
      } else {
        throw new Error('该设备类型没有专属配置');
      }
    }

    // Maintained by the Mods runtime; the hardware form must not override them
    hw.eeprom = 'efi.lua';
    hw.disk1 = 'disk.ocd';
    hw.mods = true;
    hw.modsName = name;
    hw.modsType = this.readMeta(name)?.type || hw.modsType || 'robot';

    this.saveConfig(name, cfg);
    const proc = this.processes.get(name);
    return {
      ok: true,
      config: cfg,
      restartRequired: !!(proc && (proc.state === 'running' || proc.state === 'starting')),
    };
  }

  getRuntime(name) {
    const proc = this.processes.get(name);
    if (!proc) {
      return { state: 'stopped', modState: null, deviceType: null, address: null, logs: [] };
    }
    return {
      state: proc.state,
      modState: proc.modState || null,
      deviceType: proc.modDeviceType || null,
      address: proc.modAddress || proc.modemAddress || null,
      logs: (proc.modLogs || []).slice(-MOD_LOG_LIMIT),
    };
  }

  // ---------- Create / delete ----------
  create(spec = {}) {
    const name = String(spec.name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      throw new Error('Mod 名称只能包含字母、数字、下划线、连字符, 最多 32 个字符');
    }
    if (fs.existsSync(this.modDir(name))) {
      throw new Error(`Mod "${name}" 已存在`);
    }
    const type = MOD_TYPES.has(spec.type) ? spec.type : 'robot';
    fs.mkdirSync(this.modDir(name), { recursive: true });
    this.writeMeta(name, {
      name,
      type,
      description: typeof spec.description === 'string' ? spec.description : '',
      markers: Array.isArray(spec.markers) ? spec.markers : [],
      efi: 'built-in',
      created: new Date().toISOString(),
    });
    this.provision(name, type);
    return this.getMod(name);
  }

  delete(name) {
    try { this.stop(name); } catch { /* ignore stop failures */ }
    const timer = this.machineTimers.get(name);
    if (timer) clearTimeout(timer);
    this.machineTimers.delete(name);
    this.machineHosts.delete(name);
    this.machineDefinitions.delete(name);
    this.machineStates.delete(name);
    this.machineErrors.delete(name);
    this.machineStopped.delete(name);
    this.machineStateTexts.delete(name);
    this._unregisterMachine(name);
    const meta = this.readMeta(name);
    if (meta && this.deviceBus) {
      for (const address of [meta.componentAddress, meta.redstoneAddress, meta.transposerAddress]) {
        if (address) this.deviceBus.unregister(address);
      }
    }
    const dir = this.modDir(name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.processes.delete(name);
    this.reactorRuntimes.delete(name);
    return true;
  }

  // ---------- Start / control ----------
  start(name) {
    if (!fs.existsSync(this.modDir(name))) {
      return { ok: false, error: 'Mod not found' };
    }
    // Machine devices have no program; their own config acts as the switch
    const meta = this.readMeta(name);
    if (meta && !COMPUTER_TYPES.has(meta.type)) {
      if (meta.type === 'reactor') return this.setReactorActive(name, true);
      if (meta.type === 'machine') {
        this.machineStopped.delete(name);
        this._startMachineHost(name);
        return { ok: true };
      }
      return { ok: false, error: '该设备不是计算机, 请直接修改设备自身的运行开关' };
    }
    try {
      this.provision(name);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return super.start(name);
  }

  // Script machine: restart the script host
  restart(name) {
    const meta = this.readMeta(name);
    if (meta && meta.type === 'machine') {
      this._restartMachineHost(name);
      return { ok: true };
    }
    return super.restart(name);
  }

  // Machine devices have no process, so stop is a no-op
  stop(name) {
    const meta = this.readMeta(name);
    if (meta && !COMPUTER_TYPES.has(meta.type)) {
      if (meta.type === 'reactor') this.setReactorActive(name, false);
      if (meta.type === 'machine') {
        this.machineStopped.add(name);
        const timer = this.machineTimers.get(name);
        if (timer) clearTimeout(timer);
        this.machineTimers.delete(name);
        const host = this.machineHosts.get(name);
        if (host) host.stop();
        this.machineHosts.delete(name);
        this.machineDefinitions.delete(name);
        this.machineStates.delete(name);
        this._unregisterMachine(name);
        this._notifyMachineState(name);
      }
      return;
    }
    super.stop(name);
  }

  sendModCommand(name, command) {
    this.sendCommand(name, 'mod_command', command);
  }

  // ---------- WebSocket ----------
  subscribe(name, ws) {
    if (!this.subscribers.has(name)) this.subscribers.set(name, new Set());
    this.subscribers.get(name).add(ws);

    const runtime = this.getRuntime(name);
    const meta = this.readMeta(name) || {};
    const isComputer = COMPUTER_TYPES.has(meta.type);
    try {
      ws.send(JSON.stringify({
        type: 's2c.mod.state',
        mod: name,
        state: runtime.modState,
        deviceType: runtime.deviceType,
        address: isComputer ? runtime.address : (meta.componentAddress || null),
        // Machine devices have no process: switch on means running
        runtimeState: isComputer ? runtime.state : this._machineState(name),
      }));
      for (const log of runtime.logs) {
        ws.send(JSON.stringify({ type: 's2c.mod.log', mod: name, ...log }));
      }
    } catch (e) { /* ignore send failures */ }
  }

  _machineState(name) {
    const meta = this.readMeta(name) || {};
    if (meta.type === 'machine') {
      const host = this.machineHosts.get(name);
      return host && host.alive ? 'running' : 'stopped';
    }
    try {
      return this.readReactorFile(name).active ? 'running' : 'stopped';
    } catch {
      return 'stopped';
    }
  }

  // Push machine switch changes to the UI
  _notifyMachineState(name) {
    const meta = this.readMeta(name) || {};
    this._broadcast(name, {
      type: 's2c.mod.state',
      mod: name,
      state: null,
      deviceType: meta.type || null,
      address: meta.componentAddress || null,
      runtimeState: this._machineState(name),
    });
  }

  // ---------- Message handling ----------
  _broadcast(name, msg) {
    super._broadcast(name, msg);
    // Also mirror process state changes (starting/running/stopped/error) into the Mod view,
    // or the toolbar keeps showing "running" after a stop until the next poll.
    if (msg && msg.type === 's2c.state') {
      const proc = this.processes.get(name);
      super._broadcast(name, {
        type: 's2c.mod.state',
        mod: name,
        state: proc ? (proc.modState || null) : null,
        deviceType: proc ? (proc.modDeviceType || null) : null,
        address: proc ? (proc.modAddress || proc.modemAddress || null) : null,
        runtimeState: msg.state,
      });
    }
  }

  _onVMMessage(name, msg) {
    const proc = this.processes.get(name);
    if (!proc) return;

    if (msg.type === 'mod_state') {
      proc.modState = msg.state || null;
      if (msg.deviceType) proc.modDeviceType = msg.deviceType;
      if (msg.address) proc.modAddress = msg.address;
      this._broadcast(name, {
        type: 's2c.mod.state',
        mod: name,
        state: proc.modState,
        deviceType: proc.modDeviceType || null,
        address: proc.modAddress || proc.modemAddress || null,
        runtimeState: proc.state,
      });
      return;
    }

    if (msg.type === 'mod_log') {
      const entry = {
        ts: Date.now(),
        level: msg.level || 'info',
        msg: String(msg.msg == null ? '' : msg.msg),
      };
      if (!proc.modLogs) proc.modLogs = [];
      proc.modLogs.push(entry);
      if (proc.modLogs.length > MOD_LOG_LIMIT) {
        proc.modLogs.splice(0, proc.modLogs.length - MOD_LOG_LIMIT);
      }
      this._broadcast(name, { type: 's2c.mod.log', mod: name, ...entry });
      return;
    }

    if (msg.type === 'modem_register') {
      super._onVMMessage(name, msg);
      this.modemHub.markModAddress(msg.address);
      proc.modAddress = msg.address;
      return;
    }

    super._onVMMessage(name, msg);
  }
}

module.exports = { ModsManager, MOD_PORT };
