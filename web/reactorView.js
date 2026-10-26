// ============================================================
// reactorView.js - IC2 风格核电站 GUI
//
// 两个入口:
//   ReactorView.render(root, modName, data, opts)
//     配置用: 可编辑网格 + 组件托盘 + 实时统计 + 保存
//   ReactorView.renderInfo(root, data)
//     只读用: 2D 网格 + 每个格子的详细信息 (设备页的「反应堆」标签)
//
// 网格与原版一致: 固定 6 行, 3 ~ 9 列 (每列相当于一个 Reactor Chamber)
// 组件按等级区分: 铀/MOX 燃料棒 ×1/×2/×4, 冷却单元 10k/30k/60k,
//                 冷凝模块 RSH 20k / LZH 100k
// ============================================================

const ReactorView = (() => {
  const ROWS = 6;
  const MIN_COLUMNS = 3;
  const MAX_COLUMNS = 9;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // 后端未提供组件表时的最小回退 (正常情况下组件表由 /reactor 接口下发)
  const FALLBACK_PARTS = {
    uranium_1x: { icon: '☢', cls: 'fuel', tier: '1×', category: 'fuel', label: '铀燃料棒（单联）', rods: 1, eu: 5, heat: 4 },
    coolant_10k: { icon: '❄', cls: 'coolant', tier: '10k', category: 'coolant', label: '冷却单元 10k', capacity: 10000 },
    condensator_20k: { icon: '🔋', cls: 'condensator', tier: '20k', category: 'condensator', label: '冷凝模块 RSH（20k）', capacity: 20000 },
  };

  const T = (key, fallback) => {
    try {
      const v = I18N.t(key);
      return v === key ? fallback : v;
    } catch {
      return fallback;
    }
  };

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function clampColumns(value) {
    let n = parseInt(value, 10);
    if (!Number.isFinite(n)) n = MIN_COLUMNS;
    return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, n));
  }

  function emptyGrid(columns) {
    const grid = [];
    for (let r = 0; r < ROWS; r++) grid.push(new Array(columns).fill(null));
    return grid;
  }

  // 组件表归一化: 统一成前端需要的字段
  function partsFrom(components) {
    const src = components && typeof components === 'object' && Object.keys(components).length
      ? components : FALLBACK_PARTS;
    const out = {};
    for (const id of Object.keys(src)) {
      const c = src[id] || {};
      out[id] = {
        id,
        icon: c.icon || '▣',
        cls: c.cls || '',
        tier: c.tier || '',
        category: c.category || 'fuel',
        label: c.label || id,
        rods: Number(c.rods) || 0,
        eu: Number(c.eu) || 0,
        heat: Number(c.heat) || 0,
        capacity: Number(c.capacity) || 0,
      };
    }
    return out;
  }

  function partLabel(parts, id) {
    const p = id ? parts[id] : null;
    if (!p) return T('reactor.cell-empty', '空槽');
    return T('reactor.part.' + id, p.label);
  }

  function normalizeConfig(input, parts) {
    const src = input && typeof input === 'object' ? input : {};
    const columns = clampColumns(src.columns);
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < columns; c++) {
        const cell = src.grid && Array.isArray(src.grid[r]) ? src.grid[r][c] : null;
        // 后端保存时会再归一化一次, 这里保留原始 id 以免丢失未知组件
        row.push(typeof cell === 'string' && cell ? cell : null);
      }
      grid.push(row);
    }
    return { columns, rows: ROWS, active: src.active !== false, grid };
  }

  function inside(r, c, columns) {
    return r >= 0 && r < ROWS && c >= 0 && c < columns;
  }

  function computeStats(config, parts) {
    const { columns, grid } = config;
    const cells = [];
    let euPerTick = 0;
    let heatPerTick = 0;
    let fuelRods = 0;
    let heatCapacity = 0;
    let effectiveHeatCapacity = 0;

    const pulsesAt = (r, c) => {
      let pulses = 1;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inside(nr, nc, columns)) continue;
        const nb = parts[grid[nr][nc]];
        if (nb && nb.category === 'fuel') pulses += nb.rods;
      }
      return pulses;
    };

    const nearFuel = (r, c) => {
      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inside(nr, nc, columns)) continue;
        const nb = parts[grid[nr][nc]];
        if (nb && nb.category === 'fuel') return true;
      }
      return false;
    };

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < columns; c++) {
        const id = grid[r][c];
        const p = id ? parts[id] : null;
        if (!p) continue;

        if (p.category === 'fuel') {
          const pulses = pulsesAt(r, c);
          const eu = p.eu * pulses;
          const heat = p.heat * pulses;
          euPerTick += eu;
          heatPerTick += heat;
          fuelRods += p.rods;
          cells.push({ r, c, id, category: 'fuel', tier: p.tier, rods: p.rods, pulses, neighbors: pulses - 1, eu, heat, active: true });
        } else if (p.category === 'coolant') {
          const active = nearFuel(r, c);
          heatCapacity += p.capacity;
          if (active) effectiveHeatCapacity += p.capacity;
          cells.push({ r, c, id, category: 'coolant', tier: p.tier, capacity: p.capacity, active });
        } else if (p.category === 'condensator') {
          heatCapacity += p.capacity;
          effectiveHeatCapacity += p.capacity;
          cells.push({ r, c, id, category: 'condensator', tier: p.tier, capacity: p.capacity, active: true });
        }
      }
    }

    if (!config.active) {
      euPerTick = 0;
      heatPerTick = 0;
    }

    let status = 'idle';
    let safeSeconds = null;
    if (!config.active) {
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
    }

    return {
      columns,
      rows: ROWS,
      active: config.active,
      cells,
      counts: countByCategory(cells),
      fuelRods,
      euPerTick,
      heatPerTick,
      heatCapacity,
      effectiveHeatCapacity,
      hullHeatCapacity: 10000 + (columns - MIN_COLUMNS) * 1000,
      safeSeconds,
      status,
      totalSlots: columns * ROWS,
      usedSlots: cells.length,
    };
  }

  function countByCategory(cells) {
    const out = { fuel: 0, coolant: 0, condensator: 0 };
    for (const cell of cells) {
      if (out[cell.category] !== undefined) out[cell.category]++;
    }
    return out;
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

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // 运行状态优先于布局推算的状态
  function effectiveStatus(stats, runtime) {
    return runtime && runtime.running ? runtime.status : stats.status;
  }

  // 单个格子的信息文本 (配置 GUI 的 tooltip 与 2D 面板的明细共用)
  function cellSummary(parts, cell) {
    if (!cell) return T('reactor.cell-empty', '空槽');
    const p = parts[cell.id];
    const name = partLabel(parts, cell.id);
    if (!p) return name;
    if (cell.category === 'fuel') {
      return `${name} · ${T('reactor.info.pulses', '脉冲')} ${cell.pulses} · ${cell.eu} EU/t · ${cell.heat} heat/t`;
    }
    if (cell.category === 'coolant') {
      const state = cell.active ? T('reactor.info.active', '生效') : T('reactor.info.inactive', '未生效');
      return `${name} · ${fmtNum(cell.capacity)} · ${state}`;
    }
    return `${name} · ${fmtNum(cell.capacity)}`;
  }

  function cellClass(parts, id) {
    const p = id ? parts[id] : null;
    return p ? 'filled ' + p.cls : '';
  }

  // ============================================================
  // 配置界面 (可编辑)
  // ============================================================
  function render(root, modName, data, opts = {}) {
    if (!root) return null;
    const parts = partsFrom(data && data.components);
    const config = normalizeConfig(data && data.config, parts);
    const state = {
      modName,
      columns: config.columns,
      rows: ROWS,
      active: config.active,
      grid: config.grid,
      selectedPart: firstPartId(parts, 'fuel'),
      dirty: false,
    };

    const colOptions = [];
    for (let c = MIN_COLUMNS; c <= MAX_COLUMNS; c++) {
      colOptions.push(`<option value="${c}" ${c === state.columns ? 'selected' : ''}>${c}</option>`);
    }

    root.innerHTML = `
      <div class="ic2-reactor">
        <div class="ic2-head">
          <div class="ic2-title">☢ ${escapeHTML(T('reactor.title', '核电站'))}</div>
          <div class="ic2-sub">${escapeHTML(T('reactor.subtitle', 'IC2 反应堆'))} · <span data-role="col-label">${state.columns}</span> × ${ROWS}</div>
        </div>
        <div class="ic2-body">
          <div class="ic2-grid-wrap">
            <div class="ic2-grid" data-role="grid"></div>
            <div class="ic2-size-row">
              <label>${escapeHTML(T('reactor.size', '大小'))}
                <select data-role="columns">${colOptions.join('')}</select>
                ${escapeHTML(T('reactor.columns', '列'))}
              </label>
              <span class="ic2-slots-label" data-role="slots"></span>
            </div>
            <div class="ic2-fixed">${escapeHTML(T('reactor.fixed-rows', '行数固定为 6（与原版一致）'))}</div>
          </div>
          <div class="ic2-side">
            <div class="ic2-status idle" data-role="status">${escapeHTML(T('reactor.status.idle', '待机'))}</div>
            <div class="ic2-gauge">
              <span>${escapeHTML(T('reactor.eu', 'EU/t'))}</span>
              <b data-stat="eu">0</b>
            </div>
            <div class="ic2-gauge">
              <span>${escapeHTML(T('reactor.heat', '热量/t'))}</span>
              <b data-stat="heat">0</b>
            </div>
            <div class="ic2-gauge">
              <span>${escapeHTML(T('reactor.heat-capacity', '吸热容量'))}</span>
              <b data-stat="capacity">0</b>
            </div>
            <div class="ic2-gauge">
              <span>${escapeHTML(T('reactor.safe-time', '安全时间'))}</span>
              <b data-stat="safe">∞</b>
            </div>
            <label class="ic2-active">
              <input type="checkbox" data-role="active" ${state.active ? 'checked' : ''}>
              <span>${escapeHTML(T('reactor.active', '运行'))}</span>
            </label>
            <div class="ic2-note" data-role="note"></div>
          </div>
        </div>
        <div class="ic2-palette" data-role="palette"></div>
        <div class="ic2-hint">${escapeHTML(T('reactor.design-hint', '统计按冷却单元满容量计算；实际运行状态请看设备页的「反应堆」面板。'))}</div>
        <div class="ic2-actions">
          <button type="button" class="ic2-tool-btn" data-action="clear">${escapeHTML(T('reactor.clear', '清空'))}</button>
          <button type="button" class="ic2-tool-btn" data-action="sample">${escapeHTML(T('reactor.sample', '示例布局'))}</button>
        </div>
        <div class="ic2-hint">${escapeHTML(T('reactor.hint', '选择组件后点击格子放置；右键清除；修改大小后可用格子会相应增减。'))}</div>
        <div class="ic2-hint">${escapeHTML(T('reactor.component-hint', '燃料棒 ×1/×2/×4 · 冷却单元 10k/30k/60k · 冷凝模块 20k/100k'))}</div>
        <div class="ic2-hint">${escapeHTML(T('reactor.coolant-adjacency', '冷却单元只有与燃料棒相邻时才计入吸热容量；冷凝模块放在任意位置都生效。'))}</div>
        <div class="ic2-actions">
          <span class="ic2-save-state" data-role="save-state"></span>
          <span class="ic2-save-hint">${escapeHTML(T('reactor.save-hint', '保存后立即生效，不需要重启设备。'))}</span>
          <button type="button" class="btn btn-primary" data-action="save">${escapeHTML(T('reactor.save', '保存反应堆'))}</button>
        </div>
      </div>
    `;

    const gridEl = root.querySelector('[data-role="grid"]');
    const paletteEl = root.querySelector('[data-role="palette"]');
    const columnsEl = root.querySelector('[data-role="columns"]');
    const activeEl = root.querySelector('[data-role="active"]');
    const statusEl = root.querySelector('[data-role="status"]');
    const noteEl = root.querySelector('[data-role="note"]');
    const slotsEl = root.querySelector('[data-role="slots"]');
    const colLabelEl = root.querySelector('[data-role="col-label"]');
    const saveStateEl = root.querySelector('[data-role="save-state"]');

    function buildPalette() {
      const groups = [
        { key: 'fuel', title: T('reactor.group.fuel', '燃料棒') },
        { key: 'coolant', title: T('reactor.group.coolant', '冷却单元') },
        { key: 'condensator', title: T('reactor.group.condensator', '冷凝模块') },
      ];
      const html = groups.map(g => {
        const buttons = Object.keys(parts)
          .filter(id => parts[id].category === g.key)
          .map(id => {
            const p = parts[id];
            return `<button type="button" class="ic2-part" data-part="${id}" title="${escapeHTML(partLabel(parts, id))}">
              <span class="ic2-part-icon">${p.icon}</span>
              <span class="ic2-part-name">${escapeHTML(partLabel(parts, id))}</span>
              <span class="ic2-part-count" data-count="${id}">0</span>
            </button>`;
          }).join('');
        if (!buttons) return '';
        return `<div class="ic2-palette-group">
          <div class="ic2-group-title">${escapeHTML(g.title)}</div>
          <div class="ic2-group-items">${buttons}</div>
        </div>`;
      }).join('');
      paletteEl.innerHTML = `${html}
        <div class="ic2-palette-group">
          <div class="ic2-group-title">${escapeHTML(T('reactor.tools', '工具'))}</div>
          <div class="ic2-group-items">
            <button type="button" class="ic2-part ic2-tool" data-part="eraser" title="${escapeHTML(T('reactor.eraser', '擦除'))}">
              <span class="ic2-part-icon">🧽</span>
              <span class="ic2-part-name">${escapeHTML(T('reactor.eraser', '擦除'))}</span>
            </button>
          </div>
        </div>`;
      paletteEl.querySelectorAll('.ic2-part').forEach(btn => {
        btn.addEventListener('click', () => selectPart(btn.dataset.part));
        if (btn.dataset.part === state.selectedPart) btn.classList.add('active');
      });
    }

    function renderGrid() {
      const stats = computeStats(state, parts);
      const byPos = new Map(stats.cells.map(cell => [`${cell.r}:${cell.c}`, cell]));
      gridEl.style.gridTemplateColumns = `repeat(${state.columns}, 42px)`;
      colLabelEl.textContent = String(state.columns);
      const cells = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < state.columns; c++) {
          const id = state.grid[r][c];
          const p = id ? parts[id] : null;
          const info = byPos.get(`${r}:${c}`);
          const tip = `${cellSummary(parts, info || (p ? { id, category: p.category, tier: p.tier, capacity: p.capacity, pulses: 1, eu: p.eu, heat: p.heat, active: true } : null))} (${r + 1}, ${c + 1})`;
          cells.push(`<button type="button" class="ic2-slot ${cellClass(parts, id)}"
            data-r="${r}" data-c="${c}"
            title="${escapeHTML(tip)}"
            aria-label="${escapeHTML(partLabel(parts, id))}">
            ${p ? p.icon : ''}
            ${p && p.tier ? `<span class="ic2-slot-tier">${escapeHTML(p.tier)}</span>` : ''}
          </button>`);
        }
      }
      gridEl.innerHTML = cells.join('');
    }

    function updateCounts() {
      const perId = {};
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < state.columns; c++) {
          const id = state.grid[r][c];
          if (!parts[id]) continue;
          perId[id] = (perId[id] || 0) + 1;
        }
      }
      paletteEl.querySelectorAll('[data-count]').forEach(el => {
        el.textContent = String(perId[el.dataset.count] || 0);
      });
    }

    function updateStats() {
      const stats = computeStats(state, parts);
      root.querySelector('[data-stat="eu"]').textContent = String(stats.euPerTick);
      root.querySelector('[data-stat="heat"]').textContent = String(stats.heatPerTick);
      root.querySelector('[data-stat="capacity"]').textContent = fmtNum(stats.effectiveHeatCapacity);
      root.querySelector('[data-stat="safe"]').textContent = formatSafeTime(stats.safeSeconds);
      statusEl.className = `ic2-status ${stats.status}`;
      statusEl.textContent = T(`reactor.status.${stats.status}`, stats.status);
      noteEl.textContent = T(`reactor.note.${stats.status}`, '');
      slotsEl.textContent = `${T('reactor.used', '已用')} ${stats.usedSlots} / ${T('reactor.total', '总计')} ${stats.totalSlots} ${T('reactor.slots', '格')}`;
      updateCounts();
      return stats;
    }

    function markDirty() {
      state.dirty = true;
      saveStateEl.textContent = '';
    }

    function selectPart(part) {
      state.selectedPart = part;
      paletteEl.querySelectorAll('.ic2-part').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.part === part);
      });
    }

    function refresh() {
      renderGrid();
      updateStats();
    }

    function changeColumns(next) {
      const newColumns = clampColumns(next);
      if (newColumns === state.columns) return;
      if (newColumns < state.columns) {
        let removed = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = newColumns; c < state.columns; c++) {
            if (state.grid[r][c]) removed++;
          }
        }
        if (removed > 0 && !confirm(T('reactor.confirm-shrink', '缩小反应堆会移除超出范围的组件，继续？'))) {
          columnsEl.value = String(state.columns);
          return;
        }
      }
      const newGrid = [];
      for (let r = 0; r < ROWS; r++) {
        const row = [];
        for (let c = 0; c < newColumns; c++) {
          row.push(c < state.columns ? state.grid[r][c] : null);
        }
        newGrid.push(row);
      }
      state.columns = newColumns;
      state.grid = newGrid;
      refresh();
      markDirty();
    }

    function fillSample() {
      const fuelId = hasPart(parts, 'uranium_2x') ? 'uranium_2x' : firstPartId(parts, 'fuel');
      const coolantId = hasPart(parts, 'coolant_30k') ? 'coolant_30k' : firstPartId(parts, 'coolant');
      const condId = hasPart(parts, 'condensator_20k') ? 'condensator_20k' : firstPartId(parts, 'condensator');
      state.grid = emptyGrid(state.columns);
      state.grid[0][0] = fuelId;
      if (state.columns >= 2) {
        state.grid[0][1] = coolantId;
        state.grid[1][0] = coolantId;
        state.grid[1][1] = coolantId;
      }
      if (state.columns >= 3) {
        state.grid[0][2] = condId;
      }
      refresh();
      markDirty();
    }

    function toggleCell(r, c) {
      if (!Number.isInteger(r) || !Number.isInteger(c)) return;
      if (state.selectedPart === 'eraser' || state.grid[r][c] === state.selectedPart) {
        state.grid[r][c] = null;
      } else {
        state.grid[r][c] = state.selectedPart;
      }
      refresh();
      markDirty();
    }

    gridEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.ic2-slot');
      if (!cell) return;
      toggleCell(parseInt(cell.dataset.r, 10), parseInt(cell.dataset.c, 10));
    });

    gridEl.addEventListener('contextmenu', (e) => {
      const cell = e.target.closest('.ic2-slot');
      if (!cell) return;
      e.preventDefault();
      const r = parseInt(cell.dataset.r, 10);
      const c = parseInt(cell.dataset.c, 10);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return;
      state.grid[r][c] = null;
      refresh();
      markDirty();
    });

    columnsEl.addEventListener('change', () => changeColumns(columnsEl.value));
    activeEl.addEventListener('change', () => {
      state.active = activeEl.checked;
      updateStats();
      markDirty();
    });

    root.querySelector('[data-action="clear"]').addEventListener('click', () => {
      state.grid = emptyGrid(state.columns);
      refresh();
      markDirty();
    });

    root.querySelector('[data-action="sample"]').addEventListener('click', fillSample);

    root.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const saveBtn = root.querySelector('[data-action="save"]');
      const oldText = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = '…';
      try {
        const result = await App.api(`mods/${encodeURIComponent(modName)}/reactor`, {
          method: 'PUT',
          body: {
            columns: state.columns,
            rows: ROWS,
            active: state.active,
            grid: state.grid,
          },
        });
        if (result && result.error) throw new Error(result.error);
        state.dirty = false;
        saveStateEl.textContent = T('reactor.saved', '反应堆配置已保存');
        setTimeout(() => { saveStateEl.textContent = ''; }, 2200);
        if (result && result.stats) updateStatsFrom(result.stats);
        if (window.App) App.refreshMods(true);
        if (opts.onSaved) opts.onSaved(result);
      } catch (e) {
        alert(T('reactor.save-failed', '保存反应堆失败') + ': ' + e.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = oldText;
      }
    });

    function updateStatsFrom(stats) {
      if (!stats) return;
      root.querySelector('[data-stat="eu"]').textContent = String(stats.euPerTick);
      root.querySelector('[data-stat="heat"]').textContent = String(stats.heatPerTick);
      root.querySelector('[data-stat="capacity"]').textContent = fmtNum(stats.effectiveHeatCapacity);
      root.querySelector('[data-stat="safe"]').textContent = formatSafeTime(stats.safeSeconds);
      statusEl.className = `ic2-status ${stats.status}`;
      statusEl.textContent = T(`reactor.status.${stats.status}`, stats.status);
      noteEl.textContent = T(`reactor.note.${stats.status}`, '');
      slotsEl.textContent = `${T('reactor.used', '已用')} ${stats.usedSlots} / ${T('reactor.total', '总计')} ${stats.totalSlots} ${T('reactor.slots', '格')}`;
      updateCounts();
    }

    buildPalette();
    selectPart(state.selectedPart);
    refresh();
    return state;
  }

  // ============================================================
  // 只读 2D 面板: 每个格子的详细信息 (设备页「反应堆」标签)
  // ============================================================
  // 运行中才显示: 堆芯热量 / 剩余吸热 / 累计发电 / 运行时长
  function runtimeBlockHTML(runtime) {
    if (!runtime) return '';
    const hullPct = Math.round(Math.max(0, Math.min(1, runtime.hullRatio || 0)) * 100);
    const capPct = Math.round(Math.max(0, Math.min(1, runtime.capacityRatio || 0)) * 100);
    return `
      <div class="ic2-runtime" data-role="runtime">
        <div class="ic2-rt-row">
          <span>${escapeHTML(T('reactor.info.hull-heat', '堆芯热量'))}</span>
          <div class="ic2-bar"><i data-info="hull-bar" style="width:${hullPct}%"></i></div>
          <b data-info="hull-text">${fmtNum(Math.round(runtime.hullHeat))} / ${fmtNum(runtime.hullHeatCapacity)}</b>
        </div>
        <div class="ic2-rt-row">
          <span>${escapeHTML(T('reactor.info.remaining', '剩余吸热'))}</span>
          <div class="ic2-bar ok"><i data-info="cap-bar" style="width:${capPct}%"></i></div>
          <b data-info="cap-text">${fmtNum(runtime.remainingCapacity)} / ${fmtNum(runtime.totalCapacity)}</b>
        </div>
        <div class="ic2-rt-row ic2-rt-stats">
          <span>${escapeHTML(T('reactor.info.generated', '累计发电'))}</span><b data-info="generated">${fmtNum(Math.round(runtime.generatedEu))} EU</b>
          <span>${escapeHTML(T('reactor.info.elapsed', '运行时长'))}</span><b data-info="elapsed">${formatDuration(runtime.elapsed)}</b>
          <span>${escapeHTML(T('reactor.info.absorbed-total', '已吸收热量'))}</span><b data-info="absorbed">${fmtNum(Math.round(runtime.absorbed))}</b>
        </div>
      </div>`;
  }

  // 只更新随运行变化的数值, 不重建 DOM (保留格位选择与滚动位置)
  function updateInfo(root, data) {
    if (!root) return null;
    const parts = partsFrom(data && data.components);
    const config = normalizeConfig(data && data.config, parts);
    const stats = computeStats(config, parts);
    const runtime = (data && data.runtime) || null;
    const status = effectiveStatus(stats, runtime);

    const statusEl = root.querySelector('[data-role="status"]');
    if (statusEl) {
      statusEl.className = `ic2-status ${status}`;
      statusEl.textContent = T('reactor.status.' + status, status);
    }

    const set = (key, value) => {
      const el = root.querySelector(`[data-info="${key}"]`);
      if (el) el.textContent = value;
    };
    const setBar = (key, ratio) => {
      const el = root.querySelector(`[data-info="${key}"]`);
      if (!el) return;
      const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
      el.style.width = pct.toFixed(1) + '%';
    };

    set('eu', String(stats.euPerTick));
    set('heat', String(stats.heatPerTick));
    set('capacity', fmtNum(stats.effectiveHeatCapacity));
    set('safe', formatSafeTime(runtime && runtime.running ? runtime.safeSeconds : stats.safeSeconds));
    set('running', runtime && runtime.running ? T('reactor.info.on', '是') : T('reactor.info.off', '否'));

    if (runtime) {
      set('hull-text', `${fmtNum(Math.round(runtime.hullHeat))} / ${fmtNum(runtime.hullHeatCapacity)}`);
      set('cap-text', `${fmtNum(runtime.remainingCapacity)} / ${fmtNum(runtime.totalCapacity)}`);
      set('generated', `${fmtNum(Math.round(runtime.generatedEu))} EU`);
      set('elapsed', formatDuration(runtime.elapsed));
      set('absorbed', fmtNum(Math.round(runtime.absorbed)));
      setBar('hull-bar', runtime.hullRatio);
      setBar('cap-bar', runtime.capacityRatio);
    }
    return stats;
  }

  function renderInfo(root, data) {
    if (!root) return null;
    const parts = partsFrom(data && data.components);
    const config = normalizeConfig(data && data.config, parts);
    const stats = computeStats(config, parts);
    const runtime = (data && data.runtime) || null;
    const status = effectiveStatus(stats, runtime);
    const byPos = new Map(stats.cells.map(cell => [`${cell.r}:${cell.c}`, cell]));

    const prevSel = root.__ic2Sel || null;
    const keepSel = prevSel && byPos.has(`${prevSel.r}:${prevSel.c}`) ? prevSel : null;
    const defaultSel = keepSel || (stats.cells.find(x => x.category === 'fuel') || stats.cells[0] || null);

    root.innerHTML = `
      <div class="ic2-info">
        <div class="ic2-info-head">
          <div class="ic2-title">☢ ${escapeHTML(T('reactor.info.title', '反应堆状态'))}</div>
          <div class="ic2-sub">${escapeHTML(T('reactor.subtitle', 'IC2 反应堆'))} · ${stats.columns} × ${stats.rows}</div>
          <div class="ic2-status ${status}" data-role="status">${escapeHTML(T('reactor.status.' + status, status))}</div>
        </div>
        <div class="ic2-info-gauges">
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.eu', 'EU/t'))}</span><b data-info="eu">${stats.euPerTick}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.heat', '热量/t'))}</span><b data-info="heat">${stats.heatPerTick}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.heat-capacity', '吸热容量'))}</span><b data-info="capacity">${fmtNum(stats.effectiveHeatCapacity)}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.safe-time', '安全时间'))}</span><b data-info="safe">${formatSafeTime(runtime && runtime.running ? runtime.safeSeconds : stats.safeSeconds)}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.info.fuel-rods', '燃料棒'))}</span><b>${stats.fuelRods}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.info.used', '占用'))}</span><b>${stats.usedSlots} / ${stats.totalSlots}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.info.hull', '外壳热量'))}</span><b>${fmtNum(stats.hullHeatCapacity)}</b></div>
          <div class="ic2-info-gauge"><span>${escapeHTML(T('reactor.active', '反应堆运行'))}</span><b data-info="running">${runtime && runtime.running ? T('reactor.info.on', '是') : T('reactor.info.off', '否')}</b></div>
        </div>
        ${runtimeBlockHTML(runtime)}
        <div class="ic2-info-actions">
          <button type="button" class="ic2-tool-btn" data-role="reactor-start" ${config.active ? 'disabled' : ''}>${escapeHTML(T('vm.start', '▶ 启动'))}</button>
          <button type="button" class="ic2-tool-btn" data-role="reactor-stop" ${config.active ? '' : 'disabled'}>${escapeHTML(T('vm.stop', '■ 停止'))}</button>
          <button type="button" class="ic2-tool-btn" data-role="reset-core">${escapeHTML(T('reactor.info.reset-core', '复位堆芯'))}</button>
        </div>
        <div class="ic2-info-body">
          <div class="ic2-info-grid-wrap">
            <div class="ic2-info-grid" data-role="grid" style="grid-template-columns:repeat(${stats.columns}, 42px)"></div>
            <div class="ic2-info-hint">${escapeHTML(T('reactor.info.hint', '点击格子查看该位置的信息。'))}</div>
          </div>
          <div class="ic2-info-detail" data-role="detail"></div>
        </div>
        <div class="ic2-info-table-wrap">
          <div class="ic2-group-title">${escapeHTML(T('reactor.info.table', '组件明细'))}</div>
          <table class="ic2-info-table">
            <thead>
              <tr>
                <th>${escapeHTML(T('reactor.info.position', '位置'))}</th>
                <th>${escapeHTML(T('reactor.info.component', '组件'))}</th>
                <th>${escapeHTML(T('reactor.info.tier', '等级'))}</th>
                <th>${escapeHTML(T('reactor.info.pulses', '脉冲'))}</th>
                <th>${escapeHTML(T('reactor.eu', 'EU/t'))}</th>
                <th>${escapeHTML(T('reactor.heat', '热量/t'))}</th>
                <th>${escapeHTML(T('reactor.info.absorb', '吸热'))}</th>
                <th>${escapeHTML(T('reactor.info.state', '状态'))}</th>
              </tr>
            </thead>
            <tbody data-role="tbody"></tbody>
          </table>
        </div>
      </div>
    `;

    const gridEl = root.querySelector('[data-role="grid"]');
    const detailEl = root.querySelector('[data-role="detail"]');
    const tbodyEl = root.querySelector('[data-role="tbody"]');

    function slotButton(r, c) {
      const id = config.grid[r][c];
      const p = id ? parts[id] : null;
      const info = byPos.get(`${r}:${c}`);
      const sel = root.__ic2Sel;
      const isSel = sel && sel.r === r && sel.c === c;
      const tip = `${cellSummary(parts, info)} (${r + 1}, ${c + 1})`;
      return `<button type="button" class="ic2-slot ${cellClass(parts, id)} ${isSel ? 'selected' : ''}"
        data-r="${r}" data-c="${c}" title="${escapeHTML(tip)}" aria-label="${escapeHTML(partLabel(parts, id))}">
        ${p ? p.icon : ''}
        ${p && p.tier ? `<span class="ic2-slot-tier">${escapeHTML(p.tier)}</span>` : ''}
      </button>`;
    }

    function renderGrid() {
      const cells = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < stats.columns; c++) cells.push(slotButton(r, c));
      }
      gridEl.innerHTML = cells.join('');
    }

    function renderDetail() {
      const sel = root.__ic2Sel;
      if (!sel) {
        detailEl.innerHTML = `<div class="ic2-detail-empty">${escapeHTML(T('reactor.info.pick', '选择左侧任意格子查看详情'))}</div>`;
        return;
      }
      const cell = byPos.get(`${sel.r}:${sel.c}`);
      const p = cell ? parts[cell.id] : null;
      const rows = [];
      rows.push([T('reactor.info.position', '位置'), `${sel.r + 1} , ${sel.c + 1}`]);
      rows.push([T('reactor.info.component', '组件'), cell ? partLabel(parts, cell.id) : T('reactor.cell-empty', '空槽')]);
      if (cell && p) {
        rows.push([T('reactor.info.tier', '等级'), `${p.tier || '-'}`]);
        if (cell.category === 'fuel') {
          rows.push([T('reactor.info.rods', '联数'), String(cell.rods)]);
          rows.push([T('reactor.info.pulses', '脉冲'), String(cell.pulses)]);
          rows.push([T('reactor.info.neighbors', '相邻燃料棒'), String(cell.neighbors)]);
          rows.push([T('reactor.eu', 'EU/t'), String(cell.eu)]);
          rows.push([T('reactor.heat', '热量/t'), String(cell.heat)]);
        } else {
          rows.push([T('reactor.info.absorb', '吸热'), fmtNum(cell.capacity)]);
          rows.push([T('reactor.info.state', '状态'), cell.active
            ? T('reactor.info.active', '生效')
            : T('reactor.info.inactive', '未生效')]);
        }
      }
      detailEl.innerHTML = `
        <div class="ic2-group-title">${escapeHTML(T('reactor.info.slot', '格位详情'))}</div>
        <table class="ic2-detail-table">
          ${rows.map(([k, v]) => `<tr><th>${escapeHTML(k)}</th><td>${escapeHTML(v)}</td></tr>`).join('')}
        </table>
      `;
    }

    function renderTable() {
      if (!stats.cells.length) {
        tbodyEl.innerHTML = `<tr><td colspan="8" class="ic2-empty-row">${escapeHTML(T('reactor.info.no-parts', '还没有放置任何组件'))}</td></tr>`;
        return;
      }
      tbodyEl.innerHTML = stats.cells.map(cell => {
        const p = parts[cell.id] || {};
        const isFuel = cell.category === 'fuel';
        const state = cell.active
          ? T('reactor.info.active', '生效')
          : T('reactor.info.inactive', '未生效');
        return `<tr data-r="${cell.r}" data-c="${cell.c}" class="${cell.active ? '' : 'inactive'}">
          <td>${cell.r + 1} , ${cell.c + 1}</td>
          <td>${escapeHTML(p.icon || '')} ${escapeHTML(partLabel(parts, cell.id))}</td>
          <td>${escapeHTML(p.tier || '-')}</td>
          <td class="num">${isFuel ? cell.pulses : '-'}</td>
          <td class="num">${isFuel ? cell.eu : '-'}</td>
          <td class="num">${isFuel ? cell.heat : '-'}</td>
          <td class="num">${isFuel ? '-' : fmtNum(cell.capacity || 0)}</td>
          <td>${escapeHTML(state)}</td>
        </tr>`;
      }).join('');
    }

    function select(r, c) {
      root.__ic2Sel = { r, c };
      renderGrid();
      renderDetail();
    }

    gridEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.ic2-slot');
      if (!btn) return;
      select(parseInt(btn.dataset.r, 10), parseInt(btn.dataset.c, 10));
    });

    tbodyEl.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-r]');
      if (!tr) return;
      select(parseInt(tr.dataset.r, 10), parseInt(tr.dataset.c, 10));
    });

    root.__ic2Sel = defaultSel ? { r: defaultSel.r, c: defaultSel.c } : null;
    renderGrid();
    renderDetail();
    renderTable();
    return stats;
  }

  function hasPart(parts, id) {
    return !!parts[id];
  }

  function firstPartId(parts, category) {
    const id = Object.keys(parts).find(x => parts[x].category === category);
    return id || null;
  }

  return { render, renderInfo, updateInfo, partsFrom, computeStats, formatSafeTime };
})();

window.ReactorView = ReactorView;
