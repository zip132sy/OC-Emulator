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
const reactorModel = require('./reactor');

const MOD_TYPES = new Set(['robot', 'drone', 'microcontroller', 'reactor']);
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

class ModsManager extends VMManager {
  constructor(opts) {
    super({ ...opts, vmsDir: opts.modsDir, kind: 'mod' });
    this.modsDir = opts.modsDir;
    this.efiTemplate = path.join(opts.projectDir, 'mods-efi.lua');
    // 核电站运行时状态: name -> { elapsed, hullHeat, absorbed, generatedEu, remainingCapacity, status }
    this.reactorRuntimes = new Map();
    this.reactorTimer = setInterval(() => this._tickReactors(), 1000);
    if (this.reactorTimer.unref) this.reactorTimer.unref();
    fs.mkdirSync(this.modsDir, { recursive: true });
    // 已存在的核电站要重新挂到设备总线上
    this._loadReactorDevices();
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

  // 把核电站注册成 reactor 组件, 供所有虚拟机访问
  _registerReactor(name) {
    if (!this.deviceBus) return null;
    const address = this._ensureAddress(name);
    this.deviceBus.register({
      address,
      type: 'reactor',
      name,
      state: () => this._reactorDeviceState(name),
      command: (method, args) => this._reactorCommand(name, method, args),
    });
    return address;
  }

  _reactorDeviceState(name) {
    const config = this.readReactorFile(name);
    const stats = reactorModel.computeStats(config);
    const runtime = this.getReactorRuntime(name, stats);
    const slots = new Array(stats.columns * stats.rows).fill(null);
    for (const cell of stats.cells) {
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
        active: cell.active !== false,
      };
    }
    return {
      name,
      active: config.active,
      columns: stats.columns,
      rows: stats.rows,
      euPerTick: stats.euPerTick,
      heatPerTick: stats.heatPerTick,
      hullHeat: runtime ? runtime.hullHeat : 0,
      hullHeatCapacity: stats.hullHeatCapacity,
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
    if (method === 'setActive' || method === 'activate' || method === 'deactivate') {
      const next = method === 'deactivate' ? false
        : method === 'activate' ? true
          : !!(args && args[0]);
      const nextConfig = { ...config, active: next };
      nextConfig.updated = new Date().toISOString();
      fs.writeFileSync(this.reactorPath(name), JSON.stringify(nextConfig, null, 2), 'utf8');
      this._notifyMachineState(name);
      return { ok: true, active: next };
    }
    return { ok: false, error: `unknown method: ${method}` };
  }

  // ---------- 路径 ----------
  modDir(name) { return path.join(this.modsDir, name); }
  metaPath(name) { return path.join(this.modsDir, name, 'mod.json'); }
  efiPath(name) { return path.join(this.modsDir, name, 'efi.lua'); }
  diskPath(name) { return path.join(this.modsDir, name, 'disk.ocd'); }
  reactorPath(name) { return path.join(this.modsDir, name, 'reactor.json'); }

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
            status: stats.status,
            counts: stats.counts,
          };
        } catch { /* 布局损坏时不影响列表 */ }
      }

      out.push({
        name,
        type,
        computer: isComputer,
        description: typeof meta.description === 'string' ? meta.description : '',
        markers: Array.isArray(meta.markers) ? meta.markers : [],
        // 机器类设备没有进程: 开关打开即视为运行中
        state: isComputer ? runtimeState : (reactor && reactor.active ? 'running' : 'stopped'),
        address,
        efi: isComputer ? (efiExists ? 'built-in' : 'missing') : null,
        disk: isComputer ? fs.existsSync(this.diskPath(name)) : false,
        created: meta.created || (cfg && cfg.created) || null,
        position: modState && modState.position ? modState.position : null,
        lastError: modState ? (modState.lastError || null) : null,
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
    return {
      config,
      stats,
      components: reactorModel.COMPONENTS,
      limits: {
        rows: reactorModel.ROWS,
        minColumns: reactorModel.MIN_COLUMNS,
        maxColumns: reactorModel.MAX_COLUMNS,
      },
      runtime: this.getReactorRuntime(name, stats),
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
      if (!config.active) continue;
      const stats = reactorModel.computeStats(config);
      reactorModel.stepRuntime(this.reactorRuntimes.get(name), stats, 1);
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
    return reactorModel.runtimeSnapshot(runtime, st, active);
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
      return { ok: false, error: '该设备不是计算机, 请直接修改设备自身的运行开关' };
    }
    try {
      this.provision(name);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return super.start(name);
  }

  // 机器类设备没有进程, 停止操作空转即可
  stop(name) {
    const meta = this.readMeta(name);
    if (meta && !COMPUTER_TYPES.has(meta.type)) return;
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
