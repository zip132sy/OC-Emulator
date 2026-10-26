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
    updated: typeof src.updated === 'string' ? src.updated : null,
  };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function inside(r, c, rows, columns) {
  return r >= 0 && r < rows && c >= 0 && c < columns;
}

// 每根燃料棒受到的脉冲数: 1 + 相邻格子中的燃料棒总根数
function pulsesAt(grid, r, c, rows, columns) {
  let pulses = 1;
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
  let heatPerTick = 0;
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
        const pulses = pulsesAt(grid, r, c, rows, columns);
        const eu = comp.eu * pulses;
        const heat = comp.heat * pulses;
        euPerTick += eu;
        heatPerTick += heat;
        fuelRods += comp.rods;
        cells.push({
          r, c, id, category: 'fuel', kind: comp.kind, tier: comp.tier,
          rods: comp.rods, pulses, neighbors: pulses - 1, eu, heat,
          active: true,
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
        heatCapacity += comp.capacity;
        effectiveHeatCapacity += comp.capacity;
        cells.push({
          r, c, id, category: 'condensator', tier: comp.tier,
          capacity: comp.capacity, active: true,
        });
      }
    }
  }

  if (!reactor.active) {
    euPerTick = 0;
    heatPerTick = 0;
  }

  let status = 'idle';
  let safeSeconds = null;

  if (!reactor.active) {
    status = 'off';
  } else if (fuelRods === 0) {
    status = 'idle';
  } else if (heatPerTick > 0 && effectiveHeatCapacity <= 0) {
    status = 'critical';
    safeSeconds = 0;
  } else if (heatPerTick > 0) {
    safeSeconds = effectiveHeatCapacity / heatPerTick;
    if (safeSeconds < 60) status = 'critical';
    else if (safeSeconds < 600) status = 'warning';
    else status = 'stable';
  } else {
    status = 'idle';
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
    heatPerTick,
    heatCapacity,
    effectiveHeatCapacity,
    hullHeatCapacity: BASE_HULL_HEAT + (columns - MIN_COLUMNS) * HULL_HEAT_PER_COLUMN,
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
// 单根燃料棒的模拟寿命 (tick), 运行中每 tick 消耗 1 点
const FUEL_DURABILITY_TICKS = 10000;

function cellKey(cell) {
  return `${cell.r}:${cell.c}`;
}

function initialCellDurability(cell) {
  return cell.category === 'fuel' ? FUEL_DURABILITY_TICKS : (cell.capacity || 0);
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

// 所有生效组件剩余吸热容量之和 (未生效的冷却单元不计入)
function remainingCooling(runtime, stats) {
  if (!stats || !Array.isArray(stats.cells)) return 0;
  let total = 0;
  for (const cell of stats.cells) {
    if (cell.category === 'fuel') continue;
    if (cell.category === 'coolant' && cell.active !== true) continue;
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
//   燃料棒: 按自身脉冲数消耗
//   冷却单元 / 冷凝模块: 各自吸收热量后减少 (未生效的冷却单元保持满耐久)
function cellDurability(cell, runtime, stats) {
  if (!cell) return { durability: 0, maxDurability: 0 };
  const max = cell.category === 'fuel' ? FUEL_DURABILITY_TICKS : (cell.capacity || 0);
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
  const capacity = cell.category === 'fuel' ? FUEL_DURABILITY_TICKS : (cell.capacity || 0);
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
        result.producing = false;
      } else if (cell.category === 'fuel') {
        result.producing = true;
      }
      return result;
    }),
  };
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
    heatPerSecond: stats ? stats.heatPerTick * TICKS_PER_SECOND : 0,
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
    runtime.status = 'off';
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

  const fuelCells = [];
  const condensators = [];
  const coolantByPos = new Map();
  for (const cell of stats.cells) {
    if (cell.category === 'fuel') fuelCells.push(cell);
    else if (cell.category === 'condensator') condensators.push(cell);
    else if (cell.category === 'coolant' && cell.active) coolantByPos.set(cellKey(cell), cell);
  }

  let produced = 0;
  let eu = 0;
  let rods = 0;
  const heatSources = [];

  // 燃料棒各自按脉冲消耗耐久, 耗尽后不再发电放热
  for (const cell of fuelCells) {
    const key = cellKey(cell);
    const durability = runtime.cells[key];
    if (!(durability > 0)) continue;
    rods++;
    eu += cell.eu * TICKS_PER_SECOND * dt;
    const heat = cell.heat * TICKS_PER_SECOND * dt;
    produced += heat;
    heatSources.push({ cell, heat });
    runtime.cells[key] = Math.max(0, durability - cell.pulses * TICKS_PER_SECOND * dt);
  }

  // 每根燃料棒的热量先分给相邻的冷却单元, 再分给所有冷凝模块, 剩余进入堆芯
  let absorbed = 0;
  for (const source of heatSources) {
    const candidates = [];
    for (const [dr, dc] of DIRS) {
      const nb = coolantByPos.get(`${source.cell.r + dr}:${source.cell.c + dc}`);
      if (nb && runtime.cells[cellKey(nb)] > 0) candidates.push(nb);
    }
    for (const cond of condensators) {
      if (runtime.cells[cellKey(cond)] > 0) candidates.push(cond);
    }
    if (!candidates.length) continue;
    absorbed += source.heat - distributeHeat(runtime, candidates, source.heat);
  }

  const leftover = produced - absorbed;
  runtime.hullHeat = Math.min(stats.hullHeatCapacity, runtime.hullHeat + leftover);
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
  } else if (runtime.remainingCapacity <= 0 || leftover > 1e-9) {
    runtime.status = 'critical';
  } else if (runtime.heatPerSecond > 0 && runtime.remainingCapacity / runtime.heatPerSecond < 600) {
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
    : (stats ? stats.heatPerTick * TICKS_PER_SECOND : 0);
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
    safeSeconds: heatPerSecond > 0 ? Math.max(0, remaining) / heatPerSecond : null,
    status: runtime.status,
  };
}

module.exports = {
  ROWS,
  MIN_COLUMNS,
  MAX_COLUMNS,
  COMPONENTS,
  LEGACY_IDS,
  TICKS_PER_SECOND,
  FUEL_DURABILITY_TICKS,
  emptyGrid,
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
