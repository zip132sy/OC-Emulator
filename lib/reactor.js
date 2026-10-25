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

module.exports = {
  ROWS,
  MIN_COLUMNS,
  MAX_COLUMNS,
  COMPONENTS,
  LEGACY_IDS,
  emptyGrid,
  defaultReactor,
  normalizeReactor,
  computeStats,
  formatSafeTime,
};
