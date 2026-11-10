// ============================================================
// lib/reactor.js - IC2 nuclear reactor model
//
// Grid size matches the original:
//   * always 6 rows
//   * 3 ~ 9 columns (each extra column stands in for one Reactor Chamber)
//   * 3x6 = 18 slots minimum, 9x6 = 54 slots fully upgraded
//
// Components are tiered like the original:
//   * fuel rods     uranium / MOX, each as single / dual / quad
//   * coolant cells 10k / 30k / 60k
//   * condensators  RSH 20k / LZH 100k
//
// Calculations use simplified rules suited to the emulator:
//   * each fuel rod: 5 EU/t, 4 heat/t (MOX: 6 heat/t)
//   * pulses per fuel rod = 1 + total rods in adjacent slots
//   * coolant cells only add absorption capacity when adjacent to a fuel rod;
//     condensators work from any position
// ============================================================

const ROWS = 6;
const MIN_COLUMNS = 3;
const MAX_COLUMNS = 9;
const BASE_HULL_HEAT = 10000;
const HULL_HEAT_PER_COLUMN = 1000;

const COMPONENTS = {
  // ---------- fuel rods ----------
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

  // ---------- coolant cells ----------
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

  // ---------- condensators ----------
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

// Component id aliases: un-tiered ids map to the current tiered ids
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
// IC2 item mapping
//
// Transposer and inventory-oriented programs address grid slots and storages by
// IC2 item name and metadata, so component ids convert both ways here:
//   * fuel rods are all ic2:nuclear, metadata 11~16 encodes uranium / MOX and
//     single / dual / quad
//   * coolant cells and condensators have their own item names; damage carries
//     the consumed durability
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

// Transposer sides: 0 reactor core, 1 fuel storage, 2 waste storage
const TRANSPOSER_SIDES = { reactor: 0, fuel: 1, waste: 2 };
// Each storage has a fixed 54 slots (9 columns x 6 rows)
const INVENTORY_SIZE = ROWS * MAX_COLUMNS;

// Maximum durability of a component: lifetime for fuel rods, heat capacity otherwise
function componentCapacity(id) {
  const comp = COMPONENTS[id];
  if (!comp) return 0;
  return comp.category === 'fuel' ? FUEL_DURABILITY : (comp.capacity || 0);
}

// Component id -> IC2 item name and metadata
function itemOfComponent(id) {
  return IC2_ITEMS[id] || null;
}

// IC2 item name and metadata -> component id
function componentOfItem(name, metadata = 0) {
  if (typeof name !== 'string') return null;
  const meta = Number.isFinite(Number(metadata)) ? Number(metadata) : 0;
  return ITEM_COMPONENTS[`${name}:${meta}`] || ITEM_COMPONENTS[`${name}:0`] || null;
}

// Component + remaining durability -> IC2 item stack
//   fuel rods follow IC2 convention: metadata holds the damage and there is no
//   durability bar (maxDamage = 0)
//   for other components damage is the consumed durability and maxDamage the
//   heat capacity
//   durability / maxDurability expose the remaining durability for programs
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

// IC2 item stack -> component + remaining durability; unknown items return null
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

// Inventory: fixed 54 slots, each { id, durability } or null
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
    // Shut down automatically once every fuel rod is depleted
    stopWhenDepleted: true,
    grid: emptyGrid(MIN_COLUMNS),
    // The two virtual storages exposed to a transposer (fuel / waste)
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

// Pulses hitting each fuel rod: rods in the same component + rods in adjacent slots
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
        // Rods inside the component pulse each other, plus the rods in adjacent components
        const pulses = pulsesAt(grid, r, c, rows, columns, comp.rods);
        const eu = comp.eu * pulses;
        // IC2: a single fuel rod with p pulses generates 2 * p * (p + 1) heat per second
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
  // Design-time stats also account for the hull's own cooling
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
// Runtime: once the device starts, core heat / cooling reserve / accumulated
// output advance per second
// ============================================================
const TICKS_PER_SECOND = 20;
// Fuel component lifetime (seconds): independent of pulses, 1 point per second
const FUEL_DURABILITY = 10000;
// Heat a coolant cell sheds on its own per second
const COOLANT_SELF_COOLING = 1;
// Extra heat multiplier for MOX fuel
const MOX_HEAT_FACTOR = 1.5;
// External cooling of the reactor body + each expansion chamber (IC2: body 1, chamber 2)
const HULL_COOLING_BASE = 1;
const HULL_COOLING_PER_CHAMBER = 2;

// Hull cooling per second (ambient air / water cooling not included)
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

// Per-slot durability: runtime.cells maps "r:c" -> remaining durability, consumed per component
function ensureCellStates(runtime, stats) {
  if (!runtime.cells || typeof runtime.cells !== 'object') runtime.cells = {};
  if (!stats || !Array.isArray(stats.cells)) return;
  for (const cell of stats.cells) {
    const key = cellKey(cell);
    if (!Number.isFinite(runtime.cells[key])) runtime.cells[key] = initialCellDurability(cell);
  }
}

// Sum of remaining capacity of all heat-absorbing components adjacent to fuel rods
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

// Spread heat evenly across the absorbing components, return the unabsorbed part
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

// Current / maximum durability of one component
//   fuel components: 10000 s lifetime, 1 point per second (independent of pulses)
//   coolant cells / condensators: decrease as they absorb heat (inactive ones stay full)
function cellDurability(cell, runtime, stats) {
  if (!cell) return { durability: 0, maxDurability: 0 };
  const max = cell.category === 'fuel' ? FUEL_DURABILITY : (cell.capacity || 0);
  if (runtime && runtime.cells) {
    const value = runtime.cells[cellKey(cell)];
    if (Number.isFinite(value)) {
      return { durability: Math.max(0, Math.round(Math.min(max, value))), maxDurability: max };
    }
  }
  // Fall back to the legacy global figures when there is no per-slot state
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

// Temperature of one component: ambient is the core temperature, rising with the
// component's own stored-heat ratio up to the temperature limit
//   stored-heat ratio = consumed durability / max durability (fuel by lifetime,
//   coolant / condensator by absorbed heat)
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

// Fill in durability / maxDurability / temperature for stats.cells
// A depleted fuel rod stops producing EU and heat: eu / heat report 0
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

// Slot with durability (result of withDurability) -> IC2 item stack
function stackForCell(cell) {
  if (!cell) return null;
  return stackForEntry(cell.id, cell.durability);
}

// ============================================================
// Temperature: core heat offset by ambient temperature (1 heat = 1 °C).
//   displayed temperature = 20 °C + core heat, limit = hull heat capacity + 20 °C
// Reaching the hull heat capacity counts as overheating; the caller shuts down.
// ============================================================
const AMBIENT_TEMPERATURE = 20;

// Upper bound of the displayed temperature
function temperatureLimit(stats) {
  return stats && Number.isFinite(stats.hullHeatCapacity)
    ? stats.hullHeatCapacity + AMBIENT_TEMPERATURE
    : 0;
}

function isOverheated(runtime, stats) {
  const capacity = stats && Number.isFinite(stats.hullHeatCapacity) ? stats.hullHeatCapacity : 0;
  return !!runtime && capacity > 0 && (runtime.hullHeat || 0) >= capacity;
}

// Set the displayed temperature, clamped between ambient and the limit; returns the result
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
    // When restoring persisted state, count active rods by remaining durability (0 while shut down)
    if (stats.active) {
      for (const cell of stats.cells) {
        if (cell.category === 'fuel' && runtime.cells[cellKey(cell)] > 0) runtime.activeRods++;
      }
    }
  }
  return runtime;
}

// Advance dt seconds, mutating runtime in place and returning it
function stepRuntime(runtime, stats, dt) {
  if (!runtime || !stats || !(dt > 0)) return runtime;
  ensureCellStates(runtime, stats);

  if (!stats.active) {
    // After shutdown the hull cools at the IC2 body + chamber rate
    const cooling = hullCoolingRate(stats) * dt;
    runtime.hullHeat = Math.max(0, runtime.hullHeat - cooling);
    // Keep the state after an overheat shutdown until fully cooled; depleted stays as is
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

  // A coolant cell sheds 1 heat per second on its own
  for (const cell of stats.cells) {
    if (cell.category !== 'coolant') continue;
    const key = cellKey(cell);
    const max = cell.capacity || 0;
    if (max > 0) {
      runtime.cells[key] = Math.min(max, (runtime.cells[key] || 0) + COOLANT_SELF_COOLING * dt);
    }
  }

  const fuelCells = [];
  // Heat absorbers: coolant cells and condensators, only when adjacent to a fuel rod
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

  // Fuel components burn a 10000 s lifetime (independent of pulses); once spent they stop producing
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

  // Fuel rods hand heat to adjacent components: condensators first (unlimited
  // intake, capped by durability), then coolant cells, and the rest enters the hull
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
  // The hull keeps cooling at runtime too (IC2 body + chambers)
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
    // Every fuel rod is spent (IC2 stops producing EU and heat at that point)
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

// Read-only snapshot for the API / frontend
function runtimeSnapshot(runtime, stats, running) {
  if (!runtime) return null;
  const total = stats ? stats.effectiveHeatCapacity : 0;
  const remaining = Number.isFinite(runtime.remainingCapacity) ? runtime.remainingCapacity : total;
  // Output drops once fuel rods are spent, so prefer the runtime figures
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
    // Displayed temperature = ambient temperature + core heat
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
    // Real-time output falls to 0 once the fuel rods are spent
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
