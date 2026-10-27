// ============================================================
// lib/modsManager.js - Mods 设备管理
//
// 设备分两类:
//   * 计算机类 (robot / drone / microcontroller): Mods/<name>/ 下是一台
//     独立的 Lua VM, 带 EFI、启动盘与硬件配置, 通过无线网卡接受控制。
//   * 机器类 (reactor): 不运行程序, 只作为组件挂在设备总线上, 由其它
//     计算机用 component 访问; 配置只有机器本身的参数。
//
//   Mods/<name>/
//     mod.json      元数据 (类型 / 描述 / 组件地址 / 3D 标记点)
//     config.json   仅计算机类设备需要
//     efi.lua       仅计算机类设备需要
//     disk.ocd      仅计算机类设备需要
//     reactor.json  仅核电站需要
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VMManager } = require('./vmManager');
const { MachineHost } = require('./machineHost');
const reactorModel = require('./reactor');

const MOD_TYPES = new Set(['robot', 'drone', 'microcontroller', 'reactor', 'machine']);
// 这些类型是真正的计算机, 需要 VM / EFI / 磁盘
const COMPUTER_TYPES = new Set(['robot', 'drone', 'microcontroller']);
const MOD_PORT = 7777;
const MOD_LOG_LIMIT = 300;
const EFI_MAX_BYTES = 4096;
const APU_TIERS = new Set([1, 2, 3, 'creative']);
const MEM_TIERS = new Set([1, 1.5, 2, 2.5, 3, 3.5]);
const SCREEN_TIERS = new Set([1, 2, 3]);
const EXPANSIONS = new Set(['', 'internet', 'data_t1', 'data_t2', 'data_t3', 'wireless_t1', 'wireless_t2']);

// 机器人专属配置: 主手 / 副手可装备的工具
const ROBOT_TOOLS = [
  { id: '', label: '空手' },
  { id: 'diamond_drill', label: '钻石钻头' },
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

// 设备专属配置的取值范围
const ROBOT_LIMITS = {
  inventorySize: { min: 4, max: 32, label: '物品栏格数' },
  tankCount: { min: 0, max: 4, label: '内部储罐数量' },
};
const DRONE_LIMITS = {
  maxVelocity: { min: 1, max: 32, label: '最大速度' },
  acceleration: { min: 1, max: 32, label: '加速度' },
  inventorySize: { min: 4, max: 32, label: '物品栏格数' },
};

// 新建自定义机器时写入的示例脚本
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

// 保存时校验: 非法值直接报错
function clampField(value, rule, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
    throw new Error(`${rule.label} 必须是 ${rule.min}-${rule.max} 的整数`);
  }
  return n;
}

// 读取时宽松处理: 损坏的旧值静默回退到默认值
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

// 自定义机器属性写入: 按定义的类型转换并夹在范围内
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
    // 核电站运行时状态: name -> { elapsed, hullHeat, absorbed, generatedEu, remainingCapacity, status }
    this.reactorRuntimes = new Map();
    // 自定义脚本机器: 宿主进程 / 定义 / 状态 / 错误 / 设备地址
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
    // 已存在的核电站 / 自定义机器要重新挂到设备总线上
    this._loadReactorDevices();
    this._loadMachineMods();
    // 服务端退出时结束所有机器脚本进程
    process.once('exit', () => {
      for (const host of this.machineHosts.values()) {
        try { host.kill(); } catch { /* 进程已结束 */ }
      }
    });
  }

  // ---------- 设备总线 ----------
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
        /* 单个设备初始化失败不影响其它设备 */
      }
    }
  }

  // 组件地址: 与 OC 一样使用 UUID, 首次创建时写入 mod.json
  _ensureAddress(name) {
    const meta = this.readMeta(name) || {};
    if (typeof meta.componentAddress === 'string' && meta.componentAddress) {
      return meta.componentAddress;
    }
    const address = crypto.randomUUID();
    this.writeMeta(name, { ...meta, componentAddress: address });
    return address;
  }

  // 红石 I/O 组件使用独立地址, 与 reactor_chamber 区分
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

  // 每台核电站向已连接的虚拟机暴露两个组件:
  //   reactor_chamber: 只读遥测 (heat / maxHeat / EU/t), 供 MineOS IC2Reactors 等程序使用
  //   redstone:        红石 I/O 控制端口
  _registerReactor(name) {
    if (!this.deviceBus) return null;
    const chamberAddress = this._ensureAddress(name);
    const redstoneAddress = this._ensureRedstoneAddress(name);
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

    return redstoneAddress;
  }

  // 设备当前接线的虚拟机; null 表示未连接
  getConnectedVm(name) {
    const meta = this.readMeta(name);
    return meta && typeof meta.connectedVm === 'string' && meta.connectedVm ? meta.connectedVm : null;
  }

  // 连接 / 断开: 机器类设备通过"接线"只对指定虚拟机可见
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
    // 可见性改变: 立刻把新的设备表推给运行中的虚拟机
    if (this.deviceBus) this.deviceBus.broadcastDevices();
    return { ok: true, connectedVm: target };
  }

  // 虚拟机删除后清理指向它的接线, 避免悬空连接
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
        /* 单个设备写入失败不影响其它设备 */
      }
    }
  }

  _reactorDeviceState(name) {
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    // 逐格耐久保存在运行时原始状态里, 快照只用于展示
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
      // 运行时输出: 燃料棒耗尽后为 0
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

    // 红石 I/O: 任一输出通道都可控制反应堆开关 (值 > 0 = 运行)
    // IC2Reactors 等程序允许用户自选 I/O 端口和侧面, 因此不限定 side。
    if (method === 'setOutput') {
      const value = Number(args && args[1]) || 0;
      return applyActive(value > 0);
    }
    if (method === 'setBundledOutput') {
      const mask = Number(args && args[1]) || 0;
      return applyActive((mask & 1) !== 0);
    }

    // 温度写入: 越界自动夹在 0 ~ 上限; 达到上限时由运行时钟停堆
    if (method === 'setTemperature' || method === 'setHullHeat') {
      return this.setReactorTemperature(name, args && args[0]);
    }

    return { ok: false, error: `unknown method: ${method}` };
  }

  // 运行选项: 燃料耗尽后是否自动停机 (默认开启)
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

  // 设置堆芯温度, 返回设置后的温度与上限
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

  // ---------- 自定义脚本机器 ----------
  _loadMachineMods() {
    if (!fs.existsSync(this.modsDir)) return;
    for (const name of fs.readdirSync(this.modsDir)) {
      const meta = this.readMeta(name);
      if (!meta || meta.type !== 'machine') continue;
      try {
        this._ensureMachineFiles(name);
        this._startMachineHost(name);
      } catch {
        /* 单个机器启动失败不影响其它设备 */
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
        // 重启时旧进程可能晚于新进程退出, 只处理当前进程的事件
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
      /* 写入失败不阻塞脚本运行 */
    }
  }

  _ensureMachineAddress(name, key, file) {
    if (!file.addresses[key]) file.addresses[key] = crypto.randomUUID();
    return file.addresses[key];
  }

  // 把脚本定义的组件挂到设备总线上, 每个组件一个地址
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

  // 红石通道: 所有数值 / 布尔属性按组件顺序排列
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

  // 供 API / 前端使用: 脚本内容 + 组件定义 + 当前状态
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

  // ---------- 路径 ----------
  modDir(name) { return path.join(this.modsDir, name); }
  metaPath(name) { return path.join(this.modsDir, name, 'mod.json'); }
  efiPath(name) { return path.join(this.modsDir, name, 'efi.lua'); }
  diskPath(name) { return path.join(this.modsDir, name, 'disk.ocd'); }
  reactorPath(name) { return path.join(this.modsDir, name, 'reactor.json'); }
  machinePath(name) { return path.join(this.modsDir, name, 'machine.json'); }
  machineScriptPath(name) { return path.join(this.modsDir, name, 'machine.lua'); }

  // ---------- 元数据 ----------
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

  // ---------- 自动安装 EFI / 启动盘 / 配置 ----------
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

    // 机器类设备 (核电站) 不运行程序: 没有 EFI / 启动盘 / 硬件配置,
    // 只维护自己的布局文件, 并作为 reactor 组件挂到设备总线上
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

    // 自定义脚本机器: 只有一个 machine.lua + machine.json, 由宿主进程执行
    if (type === 'machine') {
      this._ensureMachineFiles(name);
      this._startMachineHost(name);
      return { name, type, meta, config: null };
    }

    // 内置 EFI: 缺失、为空或超过 EEPROM 4KB 限制时自动安装
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

    // 空启动盘: EFI 需要文件系统存在才能完成启动流程
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

    // VM 配置: 缺失时生成; 已存在时补齐 Mods 设备必需字段
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

    // 设备专属配置: 机器人 / 无人机各自独立的字段
    if (type === 'robot' && !cfg.hardware.robot) {
      cfg.hardware.robot = defaultRobotProfile();
      this.saveConfig(name, cfg);
    } else if (type === 'drone' && !cfg.hardware.drone) {
      cfg.hardware.drone = defaultDroneProfile();
      this.saveConfig(name, cfg);
    }

    return { name, type, meta, config: cfg };
  }

  // ---------- 列表 / 详情 ----------
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
        } catch { /* 布局损坏时不影响列表 */ }
      }

      const machineHost = type === 'machine' ? this.machineHosts.get(name) : null;
      out.push({
        name,
        type,
        computer: isComputer,
        description: typeof meta.description === 'string' ? meta.description : '',
        markers: Array.isArray(meta.markers) ? meta.markers : [],
        // 机器类设备没有进程: 核电站看开关, 自定义机器看脚本宿主
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

  // ---------- 设备专属配置 ----------
  // 只对机器人 / 无人机返回; 其他类型返回 null, UI 据此隐藏专属页签
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

  // ---------- 核电站布局 ----------
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

  // ---------- 核电站运行时 ----------
  // 核电站不是计算机: 只要「反应堆运行」开关打开就持续推进, 与 VM 进程无关。
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
      // 停机状态也要推进: 外壳会按 IC2 速率冷却
      reactorModel.stepRuntime(runtime, stats, 1);
      if (!config.active) continue;
      // 温度达到上限: 自动停堆, 只写一次盘
      if (reactorModel.isOverheated(runtime, stats)) {
        this._overheatShutdown(name, runtime);
      } else if (config.stopWhenDepleted !== false
        && stats.fuelRods > 0
        && runtime
        && runtime.activeRods === 0) {
        // 燃料棒全部耗尽: 按开关自动停机
        this._depletedShutdown(name, runtime);
      }
    }
  }

  // 燃料耗尽保护: 关闭反应堆开关, 状态标记为 depleted
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
      /* 写入失败时下一个 tick 会重试 */
    }
  }

  // 过热保护: 关闭反应堆开关, 保留堆芯状态 (需要复位后重新启动)
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
      /* 写入失败时下一个 tick 会重试 */
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

  // 启动 / 停止: 只切换运行开关, 不重置堆芯状态
  setReactorActive(name, active) {
    if (!fs.existsSync(this.modDir(name))) throw new Error('Mod not found');
    const meta = this.readMeta(name);
    const cfg = this.getConfig(name);
    const type = (meta && meta.type) || (cfg && cfg.hardware && cfg.hardware.modsType);
    if (type !== 'reactor') throw new Error('Not a reactor mod');
    const config = this.readReactorFile(name);
    const next = { ...config, active: !!active, updated: new Date().toISOString() };
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(next, null, 2), 'utf8');
    // 停机后立即把实时输出归零, 不必等下一个 tick
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

  // 复位堆芯: 更换冷却单元并把堆芯热量清零
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
    // 机器类设备的"运行中"就是开关打开
    const active = st ? st.active : true;
    const snapshot = reactorModel.runtimeSnapshot(runtime, st, active);
    if (snapshot && !active) {
      snapshot.euPerTick = 0;
      snapshot.euPerSecond = 0;
      snapshot.heatPerTick = 0;
      snapshot.heatPerSecond = 0;
      snapshot.activeRods = 0;
      // 过热 / 燃料耗尽停机时保留原因状态
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
    const normalized = reactorModel.normalizeReactor(input);
    normalized.updated = new Date().toISOString();
    fs.writeFileSync(this.reactorPath(name), JSON.stringify(normalized, null, 2), 'utf8');
    // 布局变了, 堆芯从零开始
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

  // ---------- EFI 编辑 ----------
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
    // 去掉可能从编辑器粘贴进来的 BOM
    content = content.replace(/^\uFEFF/, '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.trim() === '') throw new Error('EFI 不能为空');
    if (bytes > EFI_MAX_BYTES) {
      throw new Error(`EFI 不能超过 ${EFI_MAX_BYTES} 字节（当前 ${bytes} 字节）`);
    }
    fs.writeFileSync(this.efiPath(name), content, 'utf8');
    return { ok: true, size: bytes, maxSize: EFI_MAX_BYTES };
  }

  // ---------- 硬件配置 ----------
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

    // 这些字段由 Mods 运行时维护, 不允许被硬件表单覆盖
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

  // ---------- 创建 / 删除 ----------
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
    try { this.stop(name); } catch { /* 忽略停止失败 */ }
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
    if (meta && meta.componentAddress && this.deviceBus) {
      this.deviceBus.unregister(meta.componentAddress);
    }
    const dir = this.modDir(name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.processes.delete(name);
    this.reactorRuntimes.delete(name);
    return true;
  }

  // ---------- 启动 / 控制 ----------
  start(name) {
    if (!fs.existsSync(this.modDir(name))) {
      return { ok: false, error: 'Mod not found' };
    }
    // 机器类设备没有程序可运行, 开关由设备自己的配置控制
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

  // 自定义机器: 重启脚本宿主
  restart(name) {
    const meta = this.readMeta(name);
    if (meta && meta.type === 'machine') {
      this._restartMachineHost(name);
      return { ok: true };
    }
    return super.restart(name);
  }

  // 机器类设备没有进程, 停止操作空转即可
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
        // 机器类设备没有进程: 开关打开即运行中
        runtimeState: isComputer ? runtime.state : this._machineState(name),
      }));
      for (const log of runtime.logs) {
        ws.send(JSON.stringify({ type: 's2c.mod.log', mod: name, ...log }));
      }
    } catch (e) { /* 忽略发送失败 */ }
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

  // 机器类设备的开关变化要同步给前端
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

  // ---------- 消息处理 ----------
  _broadcast(name, msg) {
    super._broadcast(name, msg);
    // 进程状态变化 (starting/running/stopped/error) 也要同步给 Mod 视图,
    // 否则停止后工具栏会一直显示"运行中"直到下一次轮询。
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
