// ============================================================
// lib/reactor.js - IC2 核电站模型
//
// 与原版一致的网格尺寸:
//   * 固定 6 行
//   * 3 ~ 9 列 (每增加一列相当于增加一个 Reactor Chamber)
//   * 3x6 = 18 格起步, 9x6 = 54 格满配
//
// 组件按原版分等级:
//   * 燃料棒   铀 / MOX, 各有单联 / 双联 / 四联
//   * 冷却单元 10k / 30k / 60k
//   * 冷凝模块 RSH 20k / LZH 100k
//
// 计算采用适合模拟器的简化规则:
//   * 每根燃料棒 5 EU/t、4 heat/t (MOX 为 6 heat/t)
//   * 单根燃料棒的脉冲 = 1 + 相邻格子里的燃料棒总根数
//   * 冷却单元必须与燃料棒相邻才计入有效吸热容量; 冷凝模块任意位置生效
// ============================================================

const ROWS = 6;
const MIN_COLUMNS = 3;
const MAX_COLUMNS = 9;
const BASE_HULL_HEAT = 10000;
const HULL_HEAT_PER_COLUMN = 1000;

const COMPONENTS = {
  // ---------- 燃料棒 ----------
  uranium_1x: {
    id: 'uranium_1x', category: 'fuel', kind: 'uranium', tier: '1×',
    label: '铀燃料棒（单联）', icon: '☢', cls: 'fuel',
    rods: 1, eu: 5, heat: 4,
  },
  uranium_2x: {
    id: 'uranium_2x', category: 'fuel', kind: 'uranium', tier: '2×',
    label: '铀燃料棒（双联）', icon: '☢', cls: 'fuel',
    rods: 2, eu: 10, heat: 8,
  },
  uranium_4x: {
    id: 'uranium_4x', category: 'fuel', kind: 'uranium', tier: '4×',
    label: '铀燃料棒（四联）', icon: '☢', cls: 'fuel',
    rods: 4, eu: 20, heat: 16,
  },
  mox_1x: {
    id: 'mox_1x', category: 'fuel', kind: 'mox', tier: '1×',
    label: 'MOX 燃料棒（单联）', icon: '☢', cls: 'fuel-mox',
    rods: 1, eu: 5, heat: 6,
  },
  mox_2x: {
    id: 'mox_2x', category: 'fuel', kind: 'mox', tier: '2×',
    label: 'MOX 燃料棒（双联）', icon: '☢', cls: 'fuel-mox',
    rods: 2, eu: 10, heat: 12,
  },
  mox_4x: {
    id: 'mox_4x', category: 'fuel', kind: 'mox', tier: '4×',
    label: 'MOX 燃料棒（四联）', icon: '☢', cls: 'fuel-mox',
    rods: 4, eu: 20, heat: 24,
  },

  // ---------- 冷却单元 ----------
  coolant_10k: {
    id: 'coolant_10k', category: 'coolant', tier: '10k',
    label: '冷却单元 10k', icon: '❄', cls: 'coolant',
    capacity: 10000,
  },
  coolant_30k: {
    id: 'coolant_30k', category: 'coolant', tier: '30k',
    label: '冷却单元 30k', icon: '❄', cls: 'coolant',
    capacity: 30000,
  },
  coolant_60k: {
    id: 'coolant_60k', category: 'coolant', tier: '60k',
    label: '冷却单元 60k', icon: '❄', cls: 'coolant',
    capacity: 60000,
  },

  // ---------- 冷凝模块 ----------
  condensator_20k: {
    id: 'condensator_20k', category: 'condensator', tier: '20k',
    label: '冷凝模块 RSH（20k）', icon: '🔋', cls: 'condensator',
    capacity: 20000,
  },
  condensator_100k: {
    id: 'condensator_100k', category: 'condensator', tier: '100k',
    label: '冷凝模块 LZH（100k）', icon: '🔋', cls: 'condensator',
    capacity: 100000,
  },
};

// 组件 id 别名: 把不含等级的 id 映射到当前的分级 id
const LEGACY_IDS = {
  fuel_rod: 'uranium_1x',
  coolant_cell: 'coolant_10k',
  condensator: 'condensator_20k',
};

function resolveId(id) {
  if (typeof id !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(COMPONENTS, id)) return id;
  const upgraded = LEGACY_IDS[id];
  return upgraded && Object.prototype.hasOwnProperty.call(COMPONENTS, upgraded) ? upgraded : null;
}

// ============================================================
// IC2 物品映射
//
// 传动器 / 红石程序按 IC2 的物品名与 metadata 读取反应堆格位与库存,
// 这里提供组件 id 与 IC2 物品之间的双向换算:
//   * 燃料棒对应 ic2:nuclear, metadata 11~16 区分铀 / MOX 与单 / 双 / 四联
//   * 冷却单元与冷凝模块各自有独立物品名, damage 表示已损耗的耐久
// ============================================================
const IC2_ITEMS = {
  uranium_1x: { name: 'ic2:nuclear', metadata: 11 },
  uranium_2x: { name: 'ic2:nuclear', metadata: 12 },
  uranium_4x: { name: 'ic2:nuclear', metadata: 13 },
  mox_1x: { name: 'ic2:nuclear', metadata: 14 },
  mox_2x: { name: 'ic2:nuclear', metadata: 15 },
  mox_4x: { name: 'ic2:nuclear', metadata: 16 },
  coolant_10k: { name: 'ic2:coolant10k', metadata: 0 },
  coolant_30k: { name: 'ic2:coolant30k', metadata: 0 },
  coolant_60k: { name: 'ic2:coolant60k', metadata: 0 },
  condensator_20k: { name: 'ic2:rsh_condensator', metadata: 0 },
  condensator_100k: { name: 'ic2:lzh_condensator', metadata: 0 },
};

const ITEM_COMPONENTS = Object.create(null);
for (const id of Object.keys(IC2_ITEMS)) {
  const item = IC2_ITEMS[id];
  ITEM_COMPONENTS[`${item.name}:${item.metadata}`] = id;
}

// 传动器侧面: 0 反应堆堆芯, 1 燃料箱, 2 废料箱
const TRANSPOSER_SIDES = { reactor: 0, fuel: 1, waste: 2 };
// 侧面 0 的槽位数与最大格位一致 (9 列 x 6 行)
const INVENTORY_SIZE = ROWS * MAX_COLUMNS;

// 组件的最大耐久: 燃料棒按寿命, 冷却 / 冷凝按蓄热容量
function componentCapacity(id) {
  const comp = COMPONENTS[id];
  if (!comp) return 0;
  return comp.category === 'fuel' ? FUEL_DURABILITY : (comp.capacity || 0);
}

// 组件 id -> IC2 物品名与 metadata
function itemOfComponent(id) {
  return IC2_ITEMS[id] || null;
}

// IC2 物品名与 metadata -> 组件 id
function componentOfItem(name, metadata = 0) {
  if (typeof name !== 'string') return null;
  const meta = Number.isFinite(Number(metadata)) ? Number(metadata) : 0;
  return ITEM_COMPONENTS[`${name}:${meta}`] || ITEM_COMPONENTS[`${name}:0`] || null;
}

// 组件 + 剩余耐久 -> IC2 物品栈
//   燃料棒的 damage 按 IC2 习惯存 metadata, 没有耐久条 (maxDamage = 0)
//   其它组件的 damage 是已损耗耐久, maxDamage 是蓄热容量
//   durability / maxDurability 是模拟器附带的剩余耐久, 方便程序直接读取
function stackForEntry(componentId, durability) {
  const id = resolveId(componentId);
  if (!id) return null;
  const item = IC2_ITEMS[id];
  const comp = COMPONENTS[id];
  if (!item || !comp) return null;
  const max = componentCapacity(id);
  let remain = Number(durability);
  if (!Number.isFinite(remain)) remain = max;
  remain = Math.max(0, Math.min(max, remain));
  if (comp.category === 'fuel') {
    return {
      name: item.name, damage: item.metadata, maxDamage: 0,
      size: 1, label: comp.label, hasTag: false,
      durability: Math.round(remain), maxDurability: max,
    };
  }
  return {
    name: item.name, damage: Math.max(0, Math.round(max - remain)), maxDamage: max,
    size: 1, label: comp.label, hasTag: false,
    durability: Math.round(remain), maxDurability: max,
  };
}

// IC2 物品栈 -> 组件 + 剩余耐久; 无法识别的物品返回 null
function componentFromStack(stack) {
  if (!stack || typeof stack !== 'object') return null;
  const name = typeof stack.name === 'string' ? stack.name : '';
  const damage = Number(stack.damage);
  const id = componentOfItem(name, Number.isFinite(damage) ? damage : 0);
  if (!id) return null;
  const comp = COMPONENTS[id];
  if (!comp) return null;
  const max = componentCapacity(id);
  if (comp.category === 'fuel') return { id, durability: max };
  const used = Number.isFinite(damage) ? damage : 0;
  return { id, durability: Math.max(0, max - used) };
}

// 库存: 固定 54 槽, 每槽是 { id, durability } 或 null
function emptyInventory() {
  return new Array(INVENTORY_SIZE).fill(null);
}

function normalizeInventory(input) {
  const out = emptyInventory();
  if (!Array.isArray(input)) return out;
  for (let i = 0; i < INVENTORY_SIZE && i < input.length; i++) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') continue;
    const id = resolveId(entry.id);
    if (!id) continue;
    const max = componentCapacity(id);
    let durability = Number(entry.durability);
    if (!Number.isFinite(durability)) durability = max;
    out[i] = { id, durability: Math.max(0, Math.min(max, durability)) };
  }
  return out;
}

function emptyGrid(columns, rows = ROWS) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid.push(new Array(columns).fill(null));
  }
  return grid;
}

function defaultReactor() {
  return {
    version: 2,
    columns: MIN_COLUMNS,
    rows: ROWS,
    active: true,
    // 燃料棒全部耗尽后自动停机
    stopWhenDepleted: true,
    grid: emptyGrid(MIN_COLUMNS),
    // 传动器可访问的两个虚拟库存 (燃料箱 / 废料箱)
    inventories: { fuel: emptyInventory(), waste: emptyInventory() },
    updated: null,
  };
}

function normalizeColumns(value) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) n = MIN_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, n));
}

function normalizeReactor(input) {
  const src = input && typeof input === 'object' ? input : {};
  const columns = normalizeColumns(src.columns);
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    const srcRow = Array.isArray(src.grid) && Array.isArray(src.grid[r]) ? src.grid[r] : [];
    for (let c = 0; c < columns; c++) {
      row.push(resolveId(srcRow[c]));
    }
    grid.push(row);
  }
  return {
    version: 2,
    columns,
    rows: ROWS,
    active: src.active !== false,
    stopWhenDepleted: src.stopWhenDepleted !== false,
    grid,
    inventories: {
      fuel: normalizeInventory(src.inventories && src.inventories.fuel),
      waste: normalizeInventory(src.inventories && src.inventories.waste),
    },
    updated: typeof src.updated === 'string' ? src.updated : null,
  };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function inside(r, c, rows, columns) {
  return r >= 0 && r < rows && c >= 0 && c < columns;
}

// 每根燃料棒受到的脉冲数: 同一组件内的燃料棒 + 相邻格子中的燃料棒总根数
function pulsesAt(grid, r, c, rows, columns, selfRods) {
  let pulses = selfRods;
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inside(nr, nc, rows, columns)) continue;
    const id = grid[nr][nc];
    const comp = id ? COMPONENTS[id] : null;
    if (comp && comp.category === 'fuel') pulses += comp.rods;
  }
  return pulses;
}

function adjacentToFuel(grid, r, c, rows, columns) {
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inside(nr, nc, rows, columns)) continue;
    const id = grid[nr][nc];
    const comp = id ? COMPONENTS[id] : null;
    if (comp && comp.category === 'fuel') return true;
  }
  return false;
}

function computeStats(input) {
  const reactor = normalizeReactor(input);
  const { columns, rows, grid } = reactor;

  const counts = {};
  for (const id of Object.keys(COMPONENTS)) counts[id] = 0;

  const cells = [];
  let euPerTick = 0;
  let heatPerSecond = 0;
  let fuelRods = 0;
  let heatCapacity = 0;
  let effectiveHeatCapacity = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const id = grid[r][c];
      if (!id) continue;
      const comp = COMPONENTS[id];
      if (!comp) continue;
      counts[id]++;

      if (comp.category === 'fuel') {
        // 组件内的棒彼此提供脉冲, 再加相邻组件的燃料棒数
        const pulses = pulsesAt(grid, r, c, rows, columns, comp.rods);
        const eu = comp.eu * pulses;
        // IC2: 单根燃料棒 p 脉冲时每秒产生 2 * p * (p + 1) 点热量
        const factor = comp.kind === 'mox' ? MOX_HEAT_FACTOR : 1;
        const heat = 2 * pulses * (pulses + 1) * comp.rods * factor;
        euPerTick += eu;
        heatPerSecond += heat;
        fuelRods += comp.rods;
        cells.push({
          r, c, id, category: 'fuel', kind: comp.kind, tier: comp.tier,
          rods: comp.rods, pulses, neighbors: pulses - comp.rods, eu,
          heat, heatPerSecond: heat, active: true,
        });
      } else if (comp.category === 'coolant') {
        const active = adjacentToFuel(grid, r, c, rows, columns);
        heatCapacity += comp.capacity;
        if (active) effectiveHeatCapacity += comp.capacity;
        cells.push({
          r, c, id, category: 'coolant', tier: comp.tier,
          capacity: comp.capacity, active,
        });
      } else if (comp.category === 'condensator') {
        const active = adjacentToFuel(grid, r, c, rows, columns);
        heatCapacity += comp.capacity;
        if (active) effectiveHeatCapacity += comp.capacity;
        cells.push({
          r, c, id, category: 'condensator', tier: comp.tier,
          capacity: comp.capacity, active,
        });
      }
    }
  }

  if (!reactor.active) {
    euPerTick = 0;
    heatPerSecond = 0;
  }

  let status = 'idle';
  let safeSeconds = null;
  // 设计态也计入外壳自身散热
  const netHeat = heatPerSecond - hullCoolingRate({ columns });

  if (!reactor.active) {
    status = 'off';
  } else if (fuelRods === 0) {
    status = 'idle';
  } else if (netHeat > 0 && effectiveHeatCapacity <= 0) {
    status = 'critical';
    safeSeconds = 0;
  } else if (netHeat > 0) {
    safeSeconds = effectiveHeatCapacity / netHeat;
    if (safeSeconds < 60) status = 'critical';
    else if (safeSeconds < 600) status = 'warning';
    else status = 'stable';
  } else {
    status = 'stable';
  }

  const usedSlots = cells.length;

  return {
    columns,
    rows,
    active: reactor.active,
    totalSlots: columns * rows,
    usedSlots,
    fuelRods,
    counts,
    cells,
    euPerTick,
    heatPerSecond,
    heatPerTick: Math.round((heatPerSecond / TICKS_PER_SECOND) * 1000) / 1000,
    heatCapacity,
    effectiveHeatCapacity,
    hullHeatCapacity: BASE_HULL_HEAT + (columns - MIN_COLUMNS) * HULL_HEAT_PER_COLUMN,
    hullCooling: hullCoolingRate({ columns }),
    safeSeconds,
    status,
  };
}

function formatSafeTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '∞';
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ============================================================
// 运行时: 设备启动后按秒推进堆芯热量 / 冷却余量 / 累计发电
// ============================================================
const TICKS_PER_SECOND = 20;
// 燃料组件寿命 (秒): 与脉冲数无关, 每秒消耗 1 点
const FUEL_DURABILITY = 10000;
// 冷却单元每秒自行散去的热量
const COOLANT_SELF_COOLING = 1;
// MOX 燃料的额外发热倍率
const MOX_HEAT_FACTOR = 1.5;
// 反应堆本体 + 每个扩展舱的外部散热 (IC2: 本体 1, 每舱 2)
const HULL_COOLING_BASE = 1;
const HULL_COOLING_PER_CHAMBER = 2;

// 外壳每秒散热量 (不计算周围空气/水的环境散热)
function hullCoolingRate(stats) {
  const columns = stats && Number.isFinite(stats.columns) ? stats.columns : MIN_COLUMNS;
  return HULL_COOLING_BASE + Math.max(0, columns - MIN_COLUMNS) * HULL_COOLING_PER_CHAMBER;
}

function cellKey(cell) {
  return `${cell.r}:${cell.c}`;
}

function initialCellDurability(cell) {
  return cell.category === 'fuel' ? FUEL_DURABILITY : (cell.capacity || 0);
}

// 逐格耐久: runtime.cells 保存 "r:c" -> 剩余耐久, 每个组件单独消耗
function ensureCellStates(runtime, stats) {
  if (!runtime.cells || typeof runtime.cells !== 'object') runtime.cells = {};
  if (!stats || !Array.isArray(stats.cells)) return;
  for (const cell of stats.cells) {
    const key = cellKey(cell);
    if (!Number.isFinite(runtime.cells[key])) runtime.cells[key] = initialCellDurability(cell);
  }
}

// 所有与燃料棒相邻的吸热组件剩余容量之和
function remainingCooling(runtime, stats) {
  if (!stats || !Array.isArray(stats.cells)) return 0;
  let total = 0;
  for (const cell of stats.cells) {
    if (cell.category !== 'coolant' && cell.category !== 'condensator') continue;
    if (cell.active !== true) continue;
    const value = runtime && runtime.cells ? runtime.cells[cellKey(cell)] : undefined;
    if (Number.isFinite(value)) total += Math.max(0, value);
  }
  return total;
}

// 把热量平摊给可吸热的组件, 返回没有被吸收的部分
function distributeHeat(runtime, candidates, amount) {
  let remaining = amount;
  let pool = candidates.slice();
  while (remaining > 1e-9 && pool.length) {
    const share = remaining / pool.length;
    let consumed = 0;
    const next = [];
    for (const cell of pool) {
      const key = cellKey(cell);
      const space = Math.max(0, runtime.cells[key] || 0);
      const take = Math.min(space, share);
      runtime.cells[key] = space - take;
      consumed += take;
      if (space - take > 1e-9) next.push(cell);
    }
    if (consumed <= 0) break;
    remaining -= consumed;
    pool = next;
  }
  return remaining;
}

// 单个组件的当前耐久 / 最大耐久
//   燃料组件: 10000 秒寿命, 每秒消耗 1 点 (与脉冲数无关)
//   冷却单元 / 冷凝模块: 各自吸收热量后减少 (未生效的保持满耐久)
function cellDurability(cell, runtime, stats) {
  if (!cell) return { durability: 0, maxDurability: 0 };
  const max = cell.category === 'fuel' ? FUEL_DURABILITY : (cell.capacity || 0);
  if (runtime && runtime.cells) {
    const value = runtime.cells[cellKey(cell)];
    if (Number.isFinite(value)) {
      return { durability: Math.max(0, Math.round(Math.min(max, value))), maxDurability: max };
    }
  }
  // 没有逐格状态时按旧的全局数据估算
  if (cell.category === 'fuel') {
    const used = runtime ? Math.min(max, (runtime.elapsed || 0) * TICKS_PER_SECOND) : 0;
    return { durability: Math.max(0, Math.round(max - used)), maxDurability: max };
  }
  const effective = cell.category === 'condensator' || cell.active === true;
  if (!runtime || !effective) return { durability: max, maxDurability: max };
  const total = stats ? stats.effectiveHeatCapacity : 0;
  const ratio = total > 0
    ? Math.max(0, Math.min(1, (runtime.remainingCapacity || 0) / total))
    : 0;
  return { durability: Math.round(max * ratio), maxDurability: max };
}

// 单个组件温度: 以堆芯温度为环境温度, 按自身蓄热比例升高到温度上限
//   蓄热比例 = 已损耗耐久 / 最大耐久 (燃料棒按寿命消耗, 冷却/冷凝按已吸收热量)
function cellTemperature(cell, runtime, stats) {
  if (!cell) return 0;
  const max = temperatureLimit(stats);
  if (max <= 0) return 0;
  const ambient = runtime && Number.isFinite(runtime.hullHeat)
    ? Math.max(AMBIENT_TEMPERATURE, Math.min(max, runtime.hullHeat + AMBIENT_TEMPERATURE))
    : AMBIENT_TEMPERATURE;
  const capacity = cell.category === 'fuel' ? FUEL_DURABILITY : (cell.capacity || 0);
  if (capacity <= 0) return Math.round(ambient);
  let used = 0;
  if (runtime && runtime.cells) {
    const value = runtime.cells[cellKey(cell)];
    if (Number.isFinite(value)) used = Math.max(0, Math.min(1, 1 - value / capacity));
  }
  return Math.round(ambient + (max - ambient) * used);
}

// 给 stats.cells 补上 durability / maxDurability / temperature
// 燃料棒耗尽后不再发电放热, eu / heat 显示为 0
function withDurability(stats, runtime) {
  if (!stats || !Array.isArray(stats.cells)) return stats;
  return {
    ...stats,
    cells: stats.cells.map(cell => {
      const durability = cellDurability(cell, runtime, stats);
      const depleted = cell.category === 'fuel' && durability.durability <= 0;
      const result = {
        ...cell,
        ...durability,
        temperature: cellTemperature(cell, runtime, stats),
        maxTemperature: temperatureLimit(stats),
        depleted,
      };
      if (depleted) {
        result.eu = 0;
        result.heat = 0;
        result.heatPerSecond = 0;
        result.producing = false;
      } else if (cell.category === 'fuel') {
        result.producing = true;
      }
      return result;
    }),
  };
}

// 带耐久的格位 (withDurability 的结果) -> IC2 物品栈
function stackForCell(cell) {
  if (!cell) return null;
  return stackForEntry(cell.id, cell.durability);
}

// ============================================================
// 温度: 堆芯热量叠加环境温度 (1 点热量 = 1 °C)。
//   显示温度 = 20 °C + 堆芯热量, 上限 = 外壳热容量 + 20 °C
// 堆芯热量达到外壳热容量即视为过热, 由调用方停堆。
// ============================================================
const AMBIENT_TEMPERATURE = 20;

// 显示温度上限
function temperatureLimit(stats) {
  return stats && Number.isFinite(stats.hullHeatCapacity)
    ? stats.hullHeatCapacity + AMBIENT_TEMPERATURE
    : 0;
}

function isOverheated(runtime, stats) {
  const capacity = stats && Number.isFinite(stats.hullHeatCapacity) ? stats.hullHeatCapacity : 0;
  return !!runtime && capacity > 0 && (runtime.hullHeat || 0) >= capacity;
}

// 设置显示温度, 自动夹在环境温度 ~ 上限之间, 返回设置后的温度
function setTemperature(runtime, stats, value) {
  if (!runtime || !stats) return 0;
  const max = temperatureLimit(stats);
  const capacity = stats.hullHeatCapacity;
  let t = Number(value);
  if (!Number.isFinite(t)) t = AMBIENT_TEMPERATURE;
  t = Math.max(AMBIENT_TEMPERATURE, Math.min(max, t));
  runtime.hullHeat = Math.max(0, Math.min(capacity, t - AMBIENT_TEMPERATURE));
  if (!stats.active) runtime.status = 'off';
  else if (isOverheated(runtime, stats)) runtime.status = 'overheat';
  return Math.round(runtime.hullHeat + AMBIENT_TEMPERATURE);
}

function initRuntime(stats) {
  const runtime = {
    elapsed: 0,
    hullHeat: 0,
    absorbed: 0,
    generatedEu: 0,
    remainingCapacity: 0,
    heatPerSecond: stats ? (stats.heatPerSecond || 0) : 0,
    euPerSecond: stats ? stats.euPerTick * TICKS_PER_SECOND : 0,
    activeRods: 0,
    status: stats ? stats.status : 'idle',
    cells: {},
  };
  if (stats) {
    ensureCellStates(runtime, stats);
    runtime.remainingCapacity = remainingCooling(runtime, stats);
    // 恢复持久化状态时按剩余耐久统计活跃燃料棒 (停机时为 0)
    if (stats.active) {
      for (const cell of stats.cells) {
        if (cell.category === 'fuel' && runtime.cells[cellKey(cell)] > 0) runtime.activeRods++;
      }
    }
  }
  return runtime;
}

// 推进 dt 秒, 直接更新 runtime 并返回它
function stepRuntime(runtime, stats, dt) {
  if (!runtime || !stats || !(dt > 0)) return runtime;
  ensureCellStates(runtime, stats);

  if (!stats.active) {
    // 停机后外壳按 IC2 的本体 + 扩展舱速率冷却
    const cooling = hullCoolingRate(stats) * dt;
    runtime.hullHeat = Math.max(0, runtime.hullHeat - cooling);
    // 过热停堆时保留状态直到完全冷却; 燃料耗尽状态保持
    if (runtime.status !== 'depleted' && !(runtime.status === 'overheat' && runtime.hullHeat > 0)) {
      runtime.status = 'off';
    }
    runtime.heatPerSecond = 0;
    runtime.euPerSecond = 0;
    runtime.activeRods = 0;
    runtime.remainingCapacity = remainingCooling(runtime, stats);
    return runtime;
  }
  if (stats.fuelRods === 0) {
    runtime.status = 'idle';
    runtime.heatPerSecond = 0;
    runtime.euPerSecond = 0;
    runtime.activeRods = 0;
    runtime.remainingCapacity = remainingCooling(runtime, stats);
    return runtime;
  }

  // 冷却单元每秒自行散去 1 点热量
  for (const cell of stats.cells) {
    if (cell.category !== 'coolant') continue;
    const key = cellKey(cell);
    const max = cell.capacity || 0;
    if (max > 0) {
      runtime.cells[key] = Math.min(max, (runtime.cells[key] || 0) + COOLANT_SELF_COOLING * dt);
    }
  }

  const fuelCells = [];
  // 能吸热的组件: 冷却单元与冷凝模块, 只有和燃料棒相邻才参与
  const absorbers = new Map();
  for (const cell of stats.cells) {
    if (cell.category === 'fuel') {
      fuelCells.push(cell);
    } else if (cell.category === 'coolant' || cell.category === 'condensator') {
      absorbers.set(cellKey(cell), cell);
    }
  }

  let produced = 0;
  let eu = 0;
  let rods = 0;
  const heatSources = [];

  // 燃料组件按 10000 秒寿命消耗耐久 (与脉冲数无关), 耗尽后不再发电放热
  for (const cell of fuelCells) {
    const key = cellKey(cell);
    const durability = runtime.cells[key];
    if (!(durability > 0)) continue;
    rods += cell.rods || 0;
    eu += cell.eu * TICKS_PER_SECOND * dt;
    const heat = cell.heatPerSecond * dt;
    produced += heat;
    heatSources.push({ cell, heat });
    runtime.cells[key] = Math.max(0, durability - dt);
  }

  // 燃料棒把热量交给相邻组件: 冷凝模块优先 (可无限吸收, 受耐久限制),
  // 余热再分给冷却单元, 最后进入堆芯
  let absorbed = 0;
  for (const source of heatSources) {
    const condensators = [];
    const coolants = [];
    for (const [dr, dc] of DIRS) {
      const nb = absorbers.get(`${source.cell.r + dr}:${source.cell.c + dc}`);
      if (!nb || !(runtime.cells[cellKey(nb)] > 0)) continue;
      if (nb.category === 'condensator') condensators.push(nb);
      else coolants.push(nb);
    }

    let remaining = source.heat;
    if (condensators.length) remaining = distributeHeat(runtime, condensators, remaining);
    if (remaining > 0 && coolants.length) remaining = distributeHeat(runtime, coolants, remaining);
    absorbed += source.heat - remaining;
  }

  const leftover = produced - absorbed;
  // 外壳自身的散热在运行时也持续生效 (IC2 本体 + 扩展舱)
  const hullGain = leftover - hullCoolingRate(stats) * dt;
  runtime.hullHeat = Math.max(0, Math.min(stats.hullHeatCapacity, runtime.hullHeat + hullGain));
  runtime.absorbed += absorbed;
  runtime.generatedEu += eu;
  runtime.elapsed += dt;
  runtime.remainingCapacity = remainingCooling(runtime, stats);
  runtime.heatPerSecond = produced / dt;
  runtime.euPerSecond = eu / dt;
  runtime.activeRods = rods;

  if (runtime.hullHeat >= stats.hullHeatCapacity) {
    runtime.status = 'overheat';
  } else if (rods === 0 || produced <= 0) {
    // 所有燃料棒都已耗尽 (IC2 中表现为不再发电放热)
    runtime.status = stats.fuelRods > 0 ? 'depleted' : 'idle';
  } else if (hullGain > 1e-9) {
    runtime.status = 'critical';
  } else if (runtime.heatPerSecond > hullCoolingRate(stats)
    && runtime.remainingCapacity / (runtime.heatPerSecond - hullCoolingRate(stats)) < 600) {
    runtime.status = 'warning';
  } else {
    runtime.status = 'stable';
  }
  return runtime;
}

// 供接口/前端使用的只读快照
function runtimeSnapshot(runtime, stats, running) {
  if (!runtime) return null;
  const total = stats ? stats.effectiveHeatCapacity : 0;
  const remaining = Number.isFinite(runtime.remainingCapacity) ? runtime.remainingCapacity : total;
  // 燃料棒耗尽后实际发热量会下降, 优先使用运行时统计
  const heatPerSecond = Number.isFinite(runtime.heatPerSecond)
    ? runtime.heatPerSecond
    : (stats ? (stats.heatPerSecond || 0) : 0);
  const euPerSecond = Number.isFinite(runtime.euPerSecond)
    ? runtime.euPerSecond
    : (stats ? stats.euPerTick * TICKS_PER_SECOND : 0);
  const hullCapacity = stats ? stats.hullHeatCapacity : 0;
  const maxTemperature = temperatureLimit(stats);
  return {
    running: !!running,
    elapsed: runtime.elapsed,
    hullHeat: runtime.hullHeat,
    hullHeatCapacity: hullCapacity,
    hullRatio: hullCapacity > 0 ? Math.min(1, runtime.hullHeat / hullCapacity) : 0,
    // 显示温度 = 环境温度 + 堆芯热量
    temperature: maxTemperature > 0 ? Math.round(runtime.hullHeat + AMBIENT_TEMPERATURE) : 0,
    maxTemperature,
    temperatureRatio: hullCapacity > 0 ? Math.min(1, runtime.hullHeat / hullCapacity) : 0,
    overheated: hullCapacity > 0 && runtime.hullHeat >= hullCapacity,
    remainingCapacity: Math.max(0, remaining),
    totalCapacity: total,
    capacityRatio: total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0,
    absorbed: runtime.absorbed,
    generatedEu: runtime.generatedEu,
    heatPerSecond,
    // 燃料棒耗尽后实时输出会降到 0
    heatPerTick: Math.round((heatPerSecond / TICKS_PER_SECOND) * 100) / 100,
    euPerSecond,
    euPerTick: Math.round((euPerSecond / TICKS_PER_SECOND) * 100) / 100,
    activeRods: Number.isFinite(runtime.activeRods) ? runtime.activeRods : 0,
    safeSeconds: heatPerSecond > hullCoolingRate(stats)
      ? Math.max(0, remaining) / (heatPerSecond - hullCoolingRate(stats))
      : null,
    status: runtime.status,
  };
}

module.exports = {
  ROWS,
  MIN_COLUMNS,
  MAX_COLUMNS,
  COMPONENTS,
  LEGACY_IDS,
  IC2_ITEMS,
  TRANSPOSER_SIDES,
  INVENTORY_SIZE,
  componentCapacity,
  itemOfComponent,
  componentOfItem,
  stackForEntry,
  stackForCell,
  componentFromStack,
  emptyInventory,
  normalizeInventory,
  TICKS_PER_SECOND,
  FUEL_DURABILITY,
  COOLANT_SELF_COOLING,
  HULL_COOLING_BASE,
  HULL_COOLING_PER_CHAMBER,
  hullCoolingRate,
  emptyGrid,
  resolveId,
  defaultReactor,
  normalizeReactor,
  computeStats,
  withDurability,
  cellDurability,
  cellTemperature,
  formatSafeTime,
  temperatureLimit,
  isOverheated,
  setTemperature,
  initRuntime,
  stepRuntime,
  runtimeSnapshot,
};
