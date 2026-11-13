// ============================================================
// wizard.js - VM creation wizard (VMware style)
//
// Steps: name → hardware → confirm → create
// Hardware: disk1/disk2/floppy/EEPROM/APU/memory1+2/expansion1+2+3
// ============================================================

const Wizard = (() => {
  const T = (key, fallback) => {
    try {
      const v = I18N.t(key);
      return v === key ? fallback : v;
    } catch {
      return fallback;
    }
  };

  // Option definitions (must stay compatible with the server.js / vmManager.js config)
  // Disk options are fetched from the API at open time; only fixed options live here
  let diskTemplates = [];
  const OPTIONS = {
    disk: [
      { value: 'new',    labelKey: 'wizard.new-disk-option' },
      { value: 'openos', labelKey: 'hw.option-openos' },
      { value: '',       labelKey: 'wizard.no-mount' },
    ],
    // Default capacity per tier; the user can override it with any value.
    diskSize: {
      1: 1 * 1024 * 1024,
      2: 2 * 1024 * 1024,
      3: 4 * 1024 * 1024,
    },
    apu: [
      { value: 1,          labelKey: 'hw.option-apu-t1' },
      { value: 2,          labelKey: 'hw.option-apu-t2' },
      { value: 'creative', labelKey: 'hw.option-apu-creative' },
    ],
    memory: [
      { value: 1,   labelKey: 'hw.option-mem-t1' },
      { value: 1.5, labelKey: 'hw.option-mem-t15' },
      { value: 2,   labelKey: 'hw.option-mem-t2' },
      { value: 2.5, labelKey: 'hw.option-mem-t25' },
      { value: 3,   labelKey: 'hw.option-mem-t3' },
      { value: 3.5, labelKey: 'hw.option-mem-t35' },
      { value: 'custom', labelKey: 'hw.option-mem-custom' },
    ],
    eeprom: [
      { value: 'built-in',   labelKey: 'wizard.eeprom-default' },
      { value: 'import',     labelKey: 'wizard.eeprom-import-oce' },
      { value: 'import-lua', labelKey: 'wizard.eeprom-import-lua' },
    ],
    floppy: [
      { value: '',                labelKey: 'wizard.no-mount' },
      { value: 'OpenOS',          labelKey: 'hw.option-floppy-openos' },
      { value: 'OpenLoader',      labelKey: 'hw.option-floppy-openloader' },
      { value: 'Plan9k',          labelKey: 'hw.option-floppy-plan9k' },
      { value: 'Network',         labelKey: 'hw.option-floppy-network-stack' },
      { value: 'OPPM',            labelKey: 'hw.option-floppy-oppm' },
      { value: 'OpenIRC',         labelKey: 'hw.option-floppy-openirc' },
      { value: 'Data',            labelKey: 'hw.option-floppy-data' },
      { value: 'Builder',         labelKey: 'hw.option-floppy-builder', disabled: true },
      { value: 'Dig',             labelKey: 'hw.option-floppy-dig', disabled: true },
      { value: 'Maze',            labelKey: 'hw.option-floppy-maze', disabled: true },
      { value: 'Generator',       labelKey: 'hw.option-floppy-generator', disabled: true },
      { value: 'empty',           labelKey: 'hw.option-floppy-empty' },
    ],
    expansion: [
      { value: '',              labelKey: 'hw.option-empty-slot' },
      { value: 'data_t1',       labelKey: 'hw.option-data-t1' },
      { value: 'data_t2',       labelKey: 'hw.option-data-t2' },
      { value: 'data_t3',       labelKey: 'hw.option-data-t3' },
      { value: 'internet',      labelKey: 'hw.option-internet' },
      { value: 'wireless_t1',   labelKey: 'hw.option-wireless-t1' },
      { value: 'wireless_t2',   labelKey: 'hw.option-wireless-t2' },
    ],
  };

  // Wireless signal strength: 1 = isolated, >= 2 = can reach other VMs
  function modemStrengthOptions() {
    const arr = [
      { value: '',  label: T('hw.strength-auto', '自动 (跟随网卡等级)') },
      { value: '1', label: `1 · ${T('hw.strength-isolated', '隔离 · 无法发现其他虚拟机')}` },
    ];
    const net = T('hw.strength-networked', '可与其他虚拟机互通');
    for (let s = 2; s <= 16; s++) arr.push({ value: String(s), label: `${s} · ${net}` });
    return arr;
  }

  let currentStep = 0;
  let spec = null;
  let onDone = null;

  function defaults() {
    return {
      name: 'MyVM',
      hardware: {
        disk1: 'openos',
        disk1Tier: 3,
        disk1Size: 4 * 1024 * 1024,
        disk2: '',
        disk2Tier: 3,
        disk2Size: 4 * 1024 * 1024,
        floppy: '',
        eeprom: 'built-in',
        eepromImportPath: '',
        apu: { tier: 2 },
        memory: [3, 3],
        memoryMB: [null, null],
        expansion: ['', '', ''],
        modemStrength: null,
      },
      screen: { tier: 2 },
    };
  }

  function renderSelect(options, value) {
    return options.map(o => {
      const label = o.labelKey ? T(o.labelKey, o.value) : o.label;
      const suffix = o.disabled ? ` [${T('hw.floppy-disabled', '不可用')}]` : '';
      return `<option value="${o.value}"${String(o.value) === String(value) ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${label}${suffix}</option>`;
    }).join('');
  }

  function stepBarHTML() {
    const steps = [
      T('wizard.step.name', '名称'),
      T('wizard.step.hardware', '硬件'),
      T('wizard.step.review', '确认'),
      T('wizard.step.done', '完成'),
    ];
    return `
      <div class="wizard-progress">
        ${steps.map((s, i) => `
          <div class="wizard-progress-step ${i === currentStep ? 'active' : (i < currentStep ? 'done' : '')}">
            ${i + 1}. ${s}
          </div>
        `).join('')}
      </div>
    `;
  }

  function stepNameHTML() {
    return `
      ${stepBarHTML()}
      <div class="wizard-step active">
        <div class="form-row">
          <label>${T('wizard.vm-name', '虚拟机名称')}</label>
          <input type="text" id="wz-name" value="${spec.name}" placeholder="MyVM" maxlength="32">
        </div>
        <div class="form-row">
          <div></div>
          <div class="hint">${T('wizard.vm-name-hint', '只能使用字母、数字、下划线、连字符,最多 32 个字符')}</div>
        </div>
      </div>
    `;
  }

  function stepHardwareHTML() {
    const hw = spec.hardware;
    return `
      ${stepBarHTML()}
      <div class="wizard-step active">
        <div class="section-title">${T('wizard.storage', '存储')}</div>
        <div class="form-row">
          <label>${T('wizard.disk1', '磁盘 1 (主盘)')}</label>
          <select id="wz-disk1">${renderSelect(OPTIONS.disk, hw.disk1)}</select>
          ${hw.disk1 === 'new' && hw.disk1Label ? `<span class="hint" id="wz-disk1-config-summary">T${hw.disk1Tier} · ${formatSize(hw.disk1Size || OPTIONS.diskSize[hw.disk1Tier])} · ${escapeHTML(hw.disk1Label)}</span>` : ''}
        </div>
        <div class="form-row">
          <label>${T('wizard.disk2', '磁盘 2 (从盘)')}</label>
          <select id="wz-disk2">${renderSelect(OPTIONS.disk, hw.disk2)}</select>
          ${hw.disk2 === 'new' && hw.disk2Label ? `<span class="hint" id="wz-disk2-config-summary">T${hw.disk2Tier} · ${formatSize(hw.disk2Size || OPTIONS.diskSize[hw.disk2Tier])} · ${escapeHTML(hw.disk2Label)}</span>` : ''}
        </div>
        <div class="form-row">
          <label>${T('wizard.floppy', '软盘')}</label>
          <select id="wz-floppy">${renderSelect(OPTIONS.floppy, hw.floppy)}</select>
        </div>

        <div class="section-title">${T('wizard.firmware', '固件')}</div>
        <div class="form-row">
          <label>${T('hw.eeprom', 'EEPROM')}</label>
          <select id="wz-eeprom">${renderSelect(hw.eepromAuto && hw.eeprom ? [{ value: hw.eeprom, label: 'EFI: ' + hw.eeprom }].concat(OPTIONS.eeprom) : OPTIONS.eeprom, hw.eeprom)}</select>
        </div>
        <div class="form-row" id="wz-eeprom-import-row" ${(hw.eeprom === 'import' || hw.eeprom === 'import-lua') ? '' : 'style="display:none"'}>
          <label>${T('wizard.eeprom', '导入 EEPROM')}</label>
          <input type="file" id="wz-eeprom-file" accept="${hw.eeprom === 'import-lua' ? '.lua' : '.oce,.lua'}">
          <span class="hint" id="wz-eeprom-hint">${hw.eeprom === 'import-lua' ? T('wizard.eeprom-hint-lua', '选择 .lua 文件 (纯文本, 最大 4KB)') : T('wizard.eeprom-hint-oce', '选择 .oce 文件 (二进制 EEPROM)')}</span>
        </div>

        <div class="section-title">${T('wizard.cpu-mem', '处理器与内存')}</div>
        <div class="form-row">
          <label>${T('hw.apu-tier', 'APU 等级')}</label>
          <select id="wz-apu">${renderSelect(OPTIONS.apu, hw.apu.tier)}</select>
        </div>
        <div class="form-row">
          <label>${T('wizard.mem1', '内存 1 等级')}</label>
          <select id="wz-mem1">${renderSelect(OPTIONS.memory, hw.memoryMB[0] != null ? 'custom' : hw.memory[0])}</select>
        </div>
        <div class="form-row" id="wz-mem1-mb-row" style="display:none">
          <label>${T('wizard.mem1-mb', '内存 1 容量')}</label>
          <div><input type="number" id="wz-mem1-mb" min="0.001" step="0.001" value="${hw.memoryMB[0] != null ? hw.memoryMB[0] : 8}" style="width:120px;"> <span class="hint">MB</span></div>
        </div>
        <div class="form-row">
          <label>${T('wizard.mem2', '内存 2 等级')}</label>
          <select id="wz-mem2">${renderSelect(OPTIONS.memory, hw.memoryMB[1] != null ? 'custom' : hw.memory[1])}</select>
        </div>
        <div class="form-row" id="wz-mem2-mb-row" style="display:none">
          <label>${T('wizard.mem2-mb', '内存 2 容量')}</label>
          <div><input type="number" id="wz-mem2-mb" min="0.001" step="0.001" value="${hw.memoryMB[1] != null ? hw.memoryMB[1] : 8}" style="width:120px;"> <span class="hint">MB</span></div>
        </div>

        <div class="section-title">${T('wizard.expansion', '扩展卡 (3 个插槽)')}</div>
        <div class="form-row">
          <label>${T('wizard.exp1', '扩展卡 1')}</label>
          <select id="wz-exp1">${renderSelect(OPTIONS.expansion, hw.expansion[0])}</select>
        </div>
        <div class="form-row">
          <label>${T('wizard.exp2', '扩展卡 2')}</label>
          <select id="wz-exp2">${renderSelect(OPTIONS.expansion, hw.expansion[1])}</select>
        </div>
        <div class="form-row">
          <label>${T('wizard.exp3', '扩展卡 3')}</label>
          <select id="wz-exp3">${renderSelect(OPTIONS.expansion, hw.expansion[2])}</select>
        </div>
        <div class="form-row">
          <label>${T('hw.modem-strength', '无线信号强度')}</label>
          <select id="wz-modem-strength">${renderSelect(modemStrengthOptions(), hw.modemStrength == null ? '' : String(hw.modemStrength))}</select>
        </div>
        <div class="form-row"><label></label><span class="hint">${T('hw.modem-strength-hint', '1 = 隔离(无法发现其他虚拟机); 2 及以上 = 可与其他虚拟机互通')}</span></div>

        <div class="section-title">${T('wizard.display', '显示')}</div>
        <div class="form-row">
          <label>${T('wizard.screen-tier', '屏幕等级')}</label>
          <select id="wz-screen">
            <option value="1">${T('hw.option-screen-t1', 'T1 (50x16)')}</option>
            <option value="2">${T('hw.option-screen-t2', 'T2 (80x25)')}</option>
            <option value="3" selected>${T('hw.option-screen-t3', 'T3 (160x50)')}</option>
          </select>
        </div>
      </div>
    `;
  }

  function stepReviewHTML() {
    const hw = spec.hardware;
    const optLabel = (options, v) => {
      const o = options.find(x => x.value === v);
      if (!o) return T('hw.option-empty-slot', '(空)');
      return o.labelKey ? T(o.labelKey, String(v)) : o.label;
    };
    const fmtTier = t => (t === 'creative' ? T('wizard.creative', '创造') : 'T' + t);
    const fmtMem = (idx) => {
      if (hw.memoryMB && hw.memoryMB[idx] != null) return `${hw.memoryMB[idx]} MB`;
      return optLabel(OPTIONS.memory, hw.memory[idx]);
    };
    const fmtExp = v => optLabel(OPTIONS.expansion, v);
    const fmtFloppy = v => optLabel(OPTIONS.floppy, v);
    const fmtDisk = v => {
      if (v === 'new') return T('hw.option-new-disk', '新建磁盘');
      if (v === 'openos') return 'OpenOS';
      if (v && v.startsWith('disk_template:')) {
        const tplName = v.substring('disk_template:'.length).replace(/\.ocd$/i, '');
        return tplName;
      }
      return T('wizard.no-mount', '不挂载');
    };
    return `
      ${stepBarHTML()}
      <div class="wizard-step active">
        <div class="section-title">${T('wizard.info', '虚拟机信息')}</div>
        <div class="form-row"><label>${T('wizard.name', '名称')}</label><span>${escapeHTML(spec.name) || T('wizard.empty', '<空>')}</span></div>
        <div class="section-title">${T('wizard.storage', '存储')}</div>
        <div class="form-row"><label>${T('wizard.disk1', '磁盘 1 (主盘)')}</label><span>${fmtDisk(hw.disk1)}${hw.disk1 === 'new' ? ` (T${hw.disk1Tier}, ${formatSize(hw.disk1Size || OPTIONS.diskSize[hw.disk1Tier])}${hw.disk1Label ? ', ' + escapeHTML(hw.disk1Label) : ''})` : ''}</span></div>
        <div class="form-row"><label>${T('wizard.disk2', '磁盘 2 (从盘)')}</label><span>${fmtDisk(hw.disk2)}${hw.disk2 === 'new' ? ` (T${hw.disk2Tier}, ${formatSize(hw.disk2Size || OPTIONS.diskSize[hw.disk2Tier])}${hw.disk2Label ? ', ' + escapeHTML(hw.disk2Label) : ''})` : ''}</span></div>
        <div class="form-row"><label>${T('wizard.floppy', '软盘')}</label><span>${fmtFloppy(hw.floppy)}</span></div>
        <div class="section-title">${T('wizard.firmware', '固件')}</div>
        <div class="form-row"><label>${T('hw.eeprom', 'EEPROM')}</label><span>${hw.eeprom === 'built-in' ? T('hw.option-builtin-bios', '内置 BIOS') : hw.eepromAuto ? 'EFI: ' + escapeHTML(hw.eeprom) : T('wizard.import-prefix', '导入: ') + escapeHTML(hw.eepromImportPath || T('wizard.not-selected', '(未选择)'))}</span></div>
        <div class="section-title">${T('wizard.cpu-mem', '处理器与内存')}</div>
        <div class="form-row"><label>${T('hw.apu-tier', 'APU 等级')}</label><span>${fmtTier(hw.apu.tier)}</span></div>
        <div class="form-row"><label>${T('hw.mem1', '内存 1')}</label><span>${fmtMem(0)}</span></div>
        <div class="form-row"><label>${T('hw.mem2', '内存 2')}</label><span>${fmtMem(1)}</span></div>
        <div class="section-title">${T('wizard.expansion', '扩展卡 (3 个插槽)')}</div>
        <div class="form-row"><label>${T('wizard.exp1', '扩展卡 1')}</label><span>${fmtExp(hw.expansion[0])}</span></div>
        <div class="form-row"><label>${T('wizard.exp2', '扩展卡 2')}</label><span>${fmtExp(hw.expansion[1])}</span></div>
        <div class="form-row"><label>${T('wizard.exp3', '扩展卡 3')}</label><span>${fmtExp(hw.expansion[2])}</span></div>
        <div class="section-title">${T('wizard.display', '显示')}</div>
        <div class="form-row"><label>${T('hw.screen', '屏幕')}</label><span>T${spec.screen.tier}</span></div>
      </div>
    `;
  }

  function stepDoneHTML() {
    return `
      ${stepBarHTML()}
      <div class="wizard-step active">
        <p style="text-align:center; padding: 20px;">
          ${I18N.t('wizard.done-msg', { name: `<strong>${escapeHTML(spec.name)}</strong>` })}
        </p>
      </div>
    `;
  }

  function renderBody() {
    let html;
    if (currentStep === 0) html = stepNameHTML();
    else if (currentStep === 1) html = stepHardwareHTML();
    else if (currentStep === 2) html = stepReviewHTML();
    else if (currentStep === 3) html = stepDoneHTML();
    return html || '';
  }

  function renderFooter() {
    if (currentStep === 0) {
      return `<button class="btn" data-action="cancel">${T('wizard.cancel', '取消')}</button>
              <button class="btn btn-primary" data-action="next">${T('wizard.next', '下一步 →')}</button>`;
    } else if (currentStep === 1) {
      return `<button class="btn" data-action="prev">${T('wizard.prev', '← 上一步')}</button>
              <button class="btn btn-primary" data-action="next">${T('wizard.next', '下一步 →')}</button>`;
    } else if (currentStep === 2) {
      return `<button class="btn" data-action="prev">${T('wizard.prev', '← 上一步')}</button>
              <button class="btn btn-primary" data-action="create">${T('wizard.create', '创建')}</button>`;
    } else {
      return `<button class="btn btn-primary" data-action="finish">${T('wizard.finish', '完成')}</button>`;
    }
  }

  function rerender() {
    const container = document.getElementById('modal-container');
    document.getElementById('modal-body').innerHTML = renderBody();
    document.getElementById('modal-footer').innerHTML = renderFooter();
    bindStepEvents();
  }

  // A downloaded system disk may ship its own EFI (EEPROM boot program).
  // Selecting that template adopts the EFI unless the user imported one.
  function syncTemplateEeprom(value) {
    const tpl = value && value.startsWith('disk_template:')
      ? diskTemplates.find((t) => t.path === value.substring('disk_template:'.length))
      : null;
    if (tpl) {
      spec.hardware.eeprom = tpl.eeprom || 'built-in';
      spec.hardware.eepromAuto = !!tpl.eeprom;
    } else if (spec.hardware.eepromAuto) {
      spec.hardware.eeprom = 'built-in';
      spec.hardware.eepromAuto = false;
    }
  }

  function bindStepEvents() {
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    // Step 0: name
    const nameInput = body.querySelector('#wz-name');
    if (nameInput) {
      nameInput.addEventListener('input', () => { spec.name = nameInput.value; });
    }

    // Step 1: hardware
    const hw = spec.hardware;
    const disk1Sel = body.querySelector('#wz-disk1');
    if (disk1Sel) {
      disk1Sel.addEventListener('change', () => {
        hw.disk1 = disk1Sel.value;
        syncTemplateEeprom(hw.disk1);
        if (hw.disk1 === 'new') {
          openDiskConfig('disk1');
        } else {
          rerender();
        }
      });
    }
    const disk2Sel = body.querySelector('#wz-disk2');
    if (disk2Sel) {
      disk2Sel.addEventListener('change', () => {
        hw.disk2 = disk2Sel.value;
        syncTemplateEeprom(hw.disk2);
        if (hw.disk2 === 'new') {
          openDiskConfig('disk2');
        } else {
          rerender();
        }
      });
    }
    const floppySel = body.querySelector('#wz-floppy');
    if (floppySel) floppySel.addEventListener('change', () => { hw.floppy = floppySel.value; });
    const eepromSel = body.querySelector('#wz-eeprom');
    if (eepromSel) {
      eepromSel.addEventListener('change', () => {
        hw.eeprom = eepromSel.value;
        hw.eepromAuto = false;
        const importRow = body.querySelector('#wz-eeprom-import-row');
        importRow.style.display = (hw.eeprom === 'import' || hw.eeprom === 'import-lua') ? '' : 'none';
        const fileInput = body.querySelector('#wz-eeprom-file');
        const eepromHint = body.querySelector('#wz-eeprom-hint');
        if (fileInput) {
          fileInput.accept = hw.eeprom === 'import-lua' ? '.lua' : '.oce,.lua';
        }
        if (eepromHint) {
          eepromHint.textContent = hw.eeprom === 'import-lua'
            ? T('wizard.eeprom-hint-lua', '选择 .lua 文件 (纯文本, 最大 4KB)')
            : T('wizard.eeprom-hint-oce', '选择 .oce 文件 (二进制 EEPROM)');
        }
      });
    }
    const eepromFile = body.querySelector('#wz-eeprom-file');
    if (eepromFile) {
      eepromFile.addEventListener('change', () => {
        if (eepromFile.files[0]) hw.eepromImportPath = eepromFile.files[0].name;
      });
    }
    const apuSel = body.querySelector('#wz-apu');
    if (apuSel) apuSel.addEventListener('change', () => {
      const v = apuSel.value;
      hw.apu.tier = (v === 'creative') ? 'creative' : parseInt(v, 10);
    });
    // Memory: the "custom" option reveals the MB input and stores the value in memoryMB
    const bindMemory = (idx) => {
      const sel = body.querySelector(idx === 0 ? '#wz-mem1' : '#wz-mem2');
      if (!sel) return;
      const row = body.querySelector(idx === 0 ? '#wz-mem1-mb-row' : '#wz-mem2-mb-row');
      const input = body.querySelector(idx === 0 ? '#wz-mem1-mb' : '#wz-mem2-mb');
      const syncRow = () => {
        const custom = sel.value === 'custom';
        if (row) row.style.display = custom ? '' : 'none';
        if (custom && input && hw.memoryMB[idx] != null) input.value = hw.memoryMB[idx];
      };
      syncRow();
      sel.addEventListener('change', () => {
        if (sel.value === 'custom') {
          const v = input ? Number(input.value) : NaN;
          hw.memoryMB[idx] = Number.isFinite(v) && v > 0 ? v : 8;
          if (input) input.value = hw.memoryMB[idx];
        } else {
          hw.memory[idx] = parseFloat(sel.value);
          hw.memoryMB[idx] = null;
        }
        syncRow();
      });
      if (input) input.addEventListener('input', () => {
        const v = Number(input.value);
        hw.memoryMB[idx] = Number.isFinite(v) && v > 0 ? v : null;
      });
    };
    bindMemory(0);
    bindMemory(1);
    const exp1 = body.querySelector('#wz-exp1');
    if (exp1) exp1.addEventListener('change', () => { hw.expansion[0] = exp1.value; });
    const exp2 = body.querySelector('#wz-exp2');
    if (exp2) exp2.addEventListener('change', () => { hw.expansion[1] = exp2.value; });
    const exp3 = body.querySelector('#wz-exp3');
    if (exp3) exp3.addEventListener('change', () => { hw.expansion[2] = exp3.value; });
    const modemStrengthSel = body.querySelector('#wz-modem-strength');
    if (modemStrengthSel) modemStrengthSel.addEventListener('change', () => {
      hw.modemStrength = modemStrengthSel.value ? parseInt(modemStrengthSel.value, 10) : null;
    });
    const screenSel = body.querySelector('#wz-screen');
    if (screenSel) screenSel.addEventListener('change', () => { spec.screen.tier = parseInt(screenSel.value, 10); });

    // Footer buttons
    footer.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onAction(btn.dataset.action));
    });
  }

  async function onAction(action) {
    if (action === 'cancel') Modal.close();
    else if (action === 'next') {
      if (currentStep === 0) {
        if (!spec.name || !spec.name.match(/^[A-Za-z0-9_-]{1,32}$/)) {
          alert(T('wizard.name-invalid', '名称只能包含字母、数字、下划线、连字符,最多 32 字符'));
          return;
        }
        // A taken name is not rejected: the server appends -1, -2, ... when creating
      }
      if (currentStep === 1) {
        // Validate custom memory capacity
        for (let i = 0; i < 2; i++) {
          const v = spec.hardware.memoryMB[i];
          if (v != null && (!Number.isFinite(Number(v)) || Number(v) <= 0)) {
            alert(T('wizard.mem-invalid', '自定义内存容量必须是大于 0 的数值 (单位 MB)'));
            return;
          }
        }
      }
      currentStep++;
      rerender();
    } else if (action === 'prev') {
      currentStep--;
      rerender();
    } else if (action === 'create') {
      await createVM();
    } else if (action === 'finish') {
      Modal.close();
      if (onDone) onDone();
    }
  }

  async function createVM() {
    // Capture the EEPROM import intent now; the file is uploaded after the VM exists
    let eepromImportFile = null;
    let eepromFormat = 'oce';
    if (spec.hardware.eeprom === 'import' || spec.hardware.eeprom === 'import-lua') {
      const fileInput = document.getElementById('wz-eeprom-file');
      if (fileInput && fileInput.files[0]) {
        eepromImportFile = fileInput.files[0];
        // Pick the format from the selected option or the file extension
        if (spec.hardware.eeprom === 'import-lua' || fileInput.files[0].name.endsWith('.lua')) {
          eepromFormat = 'lua';
          spec.hardware.eeprom = 'eeprom.lua';
        } else {
          eepromFormat = 'oce';
          spec.hardware.eeprom = 'eeprom.oce';
        }
      } else {
        spec.hardware.eeprom = 'built-in';
      }
    }

    // 1. Create the VM via POST /api/vms (disks and floppy are created server-side)
    try {
      const result = await App.api('vms', { method: 'POST', body: spec });
      if (result && result.error) {
        alert(T('wizard.create-failed', '创建失败: ') + result.error);
        return;
      }
      // The server appends -1, -2, ... when the name is already taken; every later
      // step (EEPROM upload, confirmation text) has to use the real name.
      if (result && result.name) spec.name = result.name;
    } catch (e) {
      alert(T('wizard.create-failed', '创建失败: ') + e.message);
      return;
    }

    // 2. Upload the EEPROM file only after the VM exists
    if (eepromImportFile) {
      try {
        const buf = await eepromImportFile.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        await App.api('eeprom/import', {
          method: 'POST',
          body: { vmName: spec.name, content: b64, format: eepromFormat },
        });
      } catch (e) {
        alert(T('wizard.eeprom-import-failed', 'EEPROM 导入失败 (但 VM 已创建): ') + e.message);
      }
    }

    currentStep = 3;
    rerender();
  }

  async function open(doneCallback) {
    currentStep = 0;
    spec = defaults();
    onDone = doneCallback;

    // Load disk templates from the API
    try {
      const templates = await App.api('disks/templates');
      if (Array.isArray(templates) && templates.length > 0) {
        diskTemplates = templates;
        // Rebuild disk options: new disk + one per template + no mount
        const diskOpts = [{ value: 'new', labelKey: 'wizard.new-disk-option' }];
        for (const tpl of templates) {
          // Keep 'openos' as the value for backward compatibility
          const val = tpl.path === 'openos.ocd' ? 'openos' : 'disk_template:' + tpl.path;
          diskOpts.push({
            value: val,
            label: tpl.name + T('wizard.template-suffix', ' (预装系统)'),
            eeprom: tpl.eeprom || null,
          });
        }
        diskOpts.push({ value: '', labelKey: 'wizard.no-mount' });
        OPTIONS.disk = diskOpts;
      }
    } catch (e) { /* fallback to defaults */ }

    // The OpenOS floppy template is built from the downloaded sources; take its
    // label (e.g. "OpenOS 1.8.10") so the wizard shows the version too
    try {
      const floppies = await App.api('floppy/templates');
      const openosTpl = Array.isArray(floppies) ? floppies.find((f) => f.key === 'OpenOS') : null;
      const opt = OPTIONS.floppy.find((o) => o.value === 'OpenOS');
      if (opt && openosTpl && openosTpl.label) {
        opt.label = openosTpl.label;
        delete opt.labelKey;
      }
    } catch (e) { /* keep the static label */ }

    Modal.open({
      title: T('wizard.title', '新建虚拟机'),
      size: 'large',
      bodyHTML: renderBody(),
      footerHTML: renderFooter(),
      onMount: bindStepEvents,
    });
  }

  // ---------- Utilities ----------
  function formatSize(bytes) {
    if (!bytes) return '0';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Disk configuration dialog ----------
  function openDiskConfig(diskKey) {
    // diskKey = 'disk1' or 'disk2'
    const hw = spec.hardware;
    const tier = hw[diskKey + 'Tier'] || 3;
    const label = hw[diskKey + 'Label'] || (spec.name ? (spec.name + '-' + diskKey) : 'NewDisk');
    const defaultSize = OPTIONS.diskSize[tier] || 4 * 1024 * 1024;
    const currentSize = hw[diskKey + 'Size'] || defaultSize;

    const bodyHTML = `
      <div class="wizard-step active">
        <div class="section-title">${T('wizard.disk-config', '磁盘配置')}</div>
        <div class="form-row">
          <label>${T('wizard.disk-label', '磁盘标签')}</label>
          <input type="text" id="dc-label" value="${escapeHTML(label)}" maxlength="16" style="width:200px;">
        </div>
        <div class="form-row">
          <div></div>
          <div class="hint">${T('wizard.disk-label-hint', '磁盘显示名称, 最多 16 字符')}</div>
        </div>
        <div class="form-row">
          <label>${T('wizard.disk-tier', '磁盘等级')}</label>
          <select id="dc-tier">
            <option value="1" ${tier===1?'selected':''}>T1</option>
            <option value="2" ${tier===2?'selected':''}>T2</option>
            <option value="3" ${tier===3?'selected':''}>T3</option>
          </select>
        </div>
        <div class="form-row">
          <label>${T('wizard.disk-size', '磁盘大小')}</label>
          <input type="number" id="dc-size-mb" value="${(currentSize / 1024 / 1024).toFixed(3).replace(/\.?0+$/, '')}" min="0.001" step="0.001" style="width:100px;"> MB
          <span class="hint" id="dc-size-hint">${I18N.t('wizard.disk-size-hint', 'T3 默认 4 MB, 可填任意正数; T1 / T2 容量固定')}</span>
        </div>
        <div class="form-row">
          <div></div>
          <div class="hint">${T('wizard.disk-tier-hint', 'T1 固定 1 MB, T2 固定 2 MB, T3 默认 4 MB 且可自定义容量')}</div>
        </div>
        <div class="section-title" style="margin-top:15px;">${T('wizard.import-folder', '从文件夹导入 (可选)')}</div>
        <div class="form-row">
          <label>${T('wizard.import-folder-label', '导入文件夹')}</label>
          <input type="file" id="dc-folder" webkitdirectory multiple style="display:none;">
          <button class="btn" id="dc-folder-btn" type="button">${T('wizard.choose-folder', '选择文件夹...')}</button>
          <span class="hint" id="dc-folder-hint">${T('wizard.import-folder-hint', '将文件夹中的所有文件打包进磁盘')}</span>
        </div>
        <div class="form-row" id="dc-mirror-row">
          <label>${T('wizard.mirror-mode', '镜像模式')}</label>
          <input type="checkbox" id="dc-mirror"> <span class="hint">${T('wizard.mirror-hint', '勾选后, 磁盘与文件夹实时同步 (修改文件夹=修改磁盘)')}</span>
        </div>
      </div>
    `;

    const footerHTML = `
      <button class="btn" data-action="dc-cancel">${T('wizard.cancel', '取消')}</button>
      <button class="btn btn-primary" data-action="dc-ok">${T('wizard.ok', '确定')}</button>
    `;

    Modal.open({
      title: diskKey === 'disk1'
        ? T('wizard.disk-config-title1', '配置磁盘 1 (主盘)')
        : T('wizard.disk-config-title2', '配置磁盘 2 (从盘)'),
      size: 'medium',
      bodyHTML: bodyHTML,
      footerHTML: footerHTML,
      onMount: () => {
        const modalBody = document.getElementById('modal-body');
        const modalFooter = document.getElementById('modal-footer');

        const tierSel = modalBody.querySelector('#dc-tier');
        const sizeInput = modalBody.querySelector('#dc-size-mb');
        const sizeHint = modalBody.querySelector('#dc-size-hint');

        // T1 / T2 have a fixed capacity; only T3 accepts a custom size (default 4 MB).
        const FIXED_TIER_MB = { 1: 1, 2: 2 };
        const DEFAULT_T3_MB = 4;
        function applyTier(t) {
          const fixed = FIXED_TIER_MB[t];
          if (fixed) {
            sizeInput.value = fixed;
            sizeInput.disabled = true;
            sizeHint.textContent = I18N.t('wizard.disk-size-fixed', '该等级容量固定');
          } else {
            if (sizeInput.disabled) sizeInput.value = DEFAULT_T3_MB;
            sizeInput.disabled = false;
            sizeHint.textContent = I18N.t('wizard.disk-size-hint', 'T3 默认 4 MB, 可填任意正数; T1 / T2 容量固定');
          }
        }
        tierSel.addEventListener('change', () => applyTier(parseInt(tierSel.value, 10)));
        applyTier(tier);

        const folderBtn = modalBody.querySelector('#dc-folder-btn');
        const folderInput = modalBody.querySelector('#dc-folder');
        const folderHint = modalBody.querySelector('#dc-folder-hint');
        if (folderBtn && folderInput) {
          folderBtn.addEventListener('click', () => folderInput.click());
          folderInput.addEventListener('change', () => {
            const files = folderInput.files;
            if (files.length > 0) {
              folderHint.textContent = I18N.t('wizard.files-selected', { n: files.length });
            } else {
              folderHint.textContent = T('wizard.import-folder-hint', '将文件夹中的所有文件打包进磁盘');
            }
          });
        }

        modalFooter.querySelectorAll('button[data-action]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            if (action === 'dc-cancel') {
              if (!hw[diskKey + 'Label']) hw[diskKey] = '';
              rerender();
            } else if (action === 'dc-ok') {
              const newTier = parseInt(tierSel.value, 10);
              const newLabel = modalBody.querySelector('#dc-label').value.trim() || (spec.name + '-' + diskKey);
              const sizeMB = newTier === 3 ? parseFloat(sizeInput.value) : (newTier === 2 ? 2 : 1);
              if (!isFinite(sizeMB) || sizeMB <= 0) {
                alert(T('hw.disk-size-invalid', '磁盘容量必须是正数 (单位 MB)'));
                return;
              }
              hw[diskKey] = 'new';
              hw[diskKey + 'Tier'] = newTier;
              hw[diskKey + 'Size'] = Math.max(1, Math.round(sizeMB * 1024 * 1024));
              hw[diskKey + 'Label'] = newLabel;

              const files = folderInput ? folderInput.files : [];
              // No optional chaining: the Android WebView in use is Chrome 74,
              // which rejects "?." at parse time and would break the whole file.
              const mirrorInput = modalBody.querySelector('#dc-mirror');
              const isMirror = !!(mirrorInput && mirrorInput.checked);

              if (files.length > 0) {
                // Read every file and base64-encode it for the API
                const fileEntries = [];
                let topFolder = '';
                for (const f of files) {
                  // webkitRelativePath: "myproject/init.lua" → "/init.lua"
                  const rel = f.webkitRelativePath || f.name;
                  if (!topFolder) topFolder = rel.split('/')[0];
                  let innerPath = rel;
                  if (topFolder && innerPath.startsWith(topFolder + '/')) {
                    innerPath = innerPath.substring(topFolder.length + 1);
                  }
                  if (!innerPath || innerPath === '') continue;
                  innerPath = '/' + innerPath;

                  const buf = await f.arrayBuffer();
                  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                  fileEntries.push({ path: innerPath, content: b64 });
                }

                if (isMirror) {
                  // Mirror mode: store a relative path; the server syncs it when the VM starts
                  // Browsers never expose absolute paths, so only the hint folder name is stored
                  // and the server resolves the real location from it
                  hw[diskKey + 'Mirror'] = topFolder; // relative to the project directory
                  hw[diskKey + 'MirrorFiles'] = fileEntries; // also bundle the initial files
                }

                // Always bundle the initial files into the disk image
                hw[diskKey + 'ImportFiles'] = fileEntries;
              }

              rerender();
            }
          });
        });
      },
    });
  }

  return { open };
})();

window.Wizard = Wizard;
