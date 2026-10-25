// ============================================================
// wizard.js - 创建虚拟机向导 (VMware 风格)
//
// 步骤: 名称 → 硬件配置 → 确认 → 创建
// 硬件: 磁盘1/磁盘2/软盘/EEPROM/APU/内存1+2/扩展卡1+2+3
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

  // 选项定义 (与 server.js / vmManager.js 配置兼容)
  // 磁盘选项会从 API 动态加载，这里仅定义固定选项
  let diskTemplates = [];
  const OPTIONS = {
    disk: [
      { value: 'new',    labelKey: 'wizard.new-disk-option' },
      { value: 'openos', labelKey: 'hw.option-openos' },
      { value: '',       labelKey: 'wizard.no-mount' },
    ],
    diskTier: [
      { value: 1, label: 'T1 (≤1MB)' },
      { value: 2, label: 'T2 (≤2MB)' },
      { value: 3, label: 'T3 (≤4MB)' },
    ],
    diskSize: {
      1: 1 * 1024 * 1024,
      2: 2 * 1024 * 1024,
      3: 4 * 1024 * 1024,
    },
    diskMinSize: 128 * 1024,  // 最小 128KB
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

  // 无线信号强度: 1 = 隔离, >=2 = 可与其他虚拟机互通
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
          <select id="wz-eeprom">${renderSelect(OPTIONS.eeprom, hw.eeprom)}</select>
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
          <select id="wz-mem1">${renderSelect(OPTIONS.memory, hw.memory[0])}</select>
        </div>
        <div class="form-row">
          <label>${T('wizard.mem2', '内存 2 等级')}</label>
          <select id="wz-mem2">${renderSelect(OPTIONS.memory, hw.memory[1])}</select>
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
    const fmtMem = t => optLabel(OPTIONS.memory, t);
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
        <div class="form-row"><label>${T('hw.eeprom', 'EEPROM')}</label><span>${hw.eeprom === 'built-in' ? T('hw.option-builtin-bios', '内置 BIOS') : T('wizard.import-prefix', '导入: ') + escapeHTML(hw.eepromImportPath || T('wizard.not-selected', '(未选择)'))}</span></div>
        <div class="section-title">${T('wizard.cpu-mem', '处理器与内存')}</div>
        <div class="form-row"><label>${T('hw.apu-tier', 'APU 等级')}</label><span>${fmtTier(hw.apu.tier)}</span></div>
        <div class="form-row"><label>${T('hw.mem1', '内存 1')}</label><span>${fmtMem(hw.memory[0])}</span></div>
        <div class="form-row"><label>${T('hw.mem2', '内存 2')}</label><span>${fmtMem(hw.memory[1])}</span></div>
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
        if (hw.disk1 === 'new') {
          // 打开磁盘配置弹窗
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
    const mem1Sel = body.querySelector('#wz-mem1');
    if (mem1Sel) mem1Sel.addEventListener('change', () => { hw.memory[0] = parseFloat(mem1Sel.value); });
    const mem2Sel = body.querySelector('#wz-mem2');
    if (mem2Sel) mem2Sel.addEventListener('change', () => { hw.memory[1] = parseFloat(mem2Sel.value); });
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
        // 验证名称
        if (!spec.name || !spec.name.match(/^[A-Za-z0-9_-]{1,32}$/)) {
          alert(T('wizard.name-invalid', '名称只能包含字母、数字、下划线、连字符,最多 32 字符'));
          return;
        }
        // 检查重名
        try {
          const exists = await App.api(`vms/${encodeURIComponent(spec.name)}`);
          if (exists && !exists.error) {
            alert(I18N.t('wizard.name-exists', { name: spec.name }));
            return;
          }
        } catch { /* ignore - 不存在正常 */ }
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
    // 暂存 EEPROM 导入意图, 在 VM 创建之后再上传文件
    let eepromImportFile = null;
    let eepromFormat = 'oce';
    if (spec.hardware.eeprom === 'import' || spec.hardware.eeprom === 'import-lua') {
      const fileInput = document.getElementById('wz-eeprom-file');
      if (fileInput && fileInput.files[0]) {
        eepromImportFile = fileInput.files[0];
        // 根据选项或文件扩展名确定格式
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

    // 1. 调用 POST /api/vms 创建 VM (会自动创建磁盘/软盘)
    try {
      const result = await App.api('vms', { method: 'POST', body: spec });
      if (result && result.error) {
        alert(T('wizard.create-failed', '创建失败: ') + result.error);
        return;
      }
    } catch (e) {
      alert(T('wizard.create-failed', '创建失败: ') + e.message);
      return;
    }

    // 2. 创建后再上传 EEPROM 文件
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

    // 从 API 加载磁盘模板
    try {
      const templates = await App.api('disks/templates');
      if (Array.isArray(templates) && templates.length > 0) {
        diskTemplates = templates;
        // 重建磁盘选项: 新建 + 每个模板 + 不挂载
        const diskOpts = [{ value: 'new', labelKey: 'wizard.new-disk-option' }];
        for (const tpl of templates) {
          // 保留 'openos' 作为向后兼容的 value
          const val = tpl.path === 'openos.ocd' ? 'openos' : 'disk_template:' + tpl.path;
          diskOpts.push({ value: val, label: tpl.name + T('wizard.template-suffix', ' (预装系统)') });
        }
        diskOpts.push({ value: '', labelKey: 'wizard.no-mount' });
        OPTIONS.disk = diskOpts;
      }
    } catch (e) { /* fallback to defaults */ }

    Modal.open({
      title: T('wizard.title', '新建虚拟机'),
      size: 'large',
      bodyHTML: renderBody(),
      footerHTML: renderFooter(),
      onMount: bindStepEvents,
    });
  }

  // ---------- 工具 ----------
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

  // ---------- 磁盘配置弹窗 ----------
  function openDiskConfig(diskKey) {
    // diskKey = 'disk1' or 'disk2'
    const hw = spec.hardware;
    const tier = hw[diskKey + 'Tier'] || 3;
    const label = hw[diskKey + 'Label'] || (spec.name ? (spec.name + '-' + diskKey) : 'NewDisk');
    const maxSize = OPTIONS.diskSize[tier];
    const currentSize = hw[diskKey + 'Size'] || maxSize;

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
            <option value="1" ${tier===1?'selected':''}>T1 (≤ 1MB)</option>
            <option value="2" ${tier===2?'selected':''}>T2 (≤ 2MB)</option>
            <option value="3" ${tier===3?'selected':''}>T3 (≤ 4MB)</option>
          </select>
        </div>
        <div class="form-row">
          <label>${T('wizard.disk-size', '磁盘大小')}</label>
          <input type="number" id="dc-size-kb" value="${Math.floor(currentSize / 1024)}" min="${Math.floor(OPTIONS.diskMinSize / 1024)}" max="${Math.floor(maxSize / 1024)}" step="1" style="width:100px;"> KB
          <span class="hint" id="dc-size-hint">${I18N.t('wizard.disk-range', { min: formatSize(OPTIONS.diskMinSize), max: formatSize(maxSize) })}</span>
        </div>
        <div class="form-row">
          <div></div>
          <div class="hint">${T('wizard.disk-tier-hint', '不同等级的磁盘在 OC 中容量上限不同: T1=1MB, T2=2MB, T3=4MB')}</div>
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

    // 打开二级弹窗
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
        const sizeInput = modalBody.querySelector('#dc-size-kb');
        const sizeHint = modalBody.querySelector('#dc-size-hint');

        // 等级变化时自动调整大小和范围
        tierSel.addEventListener('change', () => {
          const newTier = parseInt(tierSel.value, 10);
          const newMax = OPTIONS.diskSize[newTier];
          sizeInput.max = Math.floor(newMax / 1024);
          sizeHint.textContent = I18N.t('wizard.disk-range', { min: formatSize(OPTIONS.diskMinSize), max: formatSize(newMax) });
          // 如果当前大小超过新上限, 调整为最大
          const currentKB = parseInt(sizeInput.value, 10);
          if (currentKB > newMax / 1024) {
            sizeInput.value = Math.floor(newMax / 1024);
          }
        });

        // 文件夹选择按钮
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
              const sizeKB = parseInt(sizeInput.value, 10);
              const maxKB = Math.floor(OPTIONS.diskSize[newTier] / 1024);
              const minKB = Math.floor(OPTIONS.diskMinSize / 1024);
              const finalSizeKB = Math.max(minKB, Math.min(maxKB, sizeKB || maxKB));

              hw[diskKey] = 'new';
              hw[diskKey + 'Tier'] = newTier;
              hw[diskKey + 'Size'] = finalSizeKB * 1024;
              hw[diskKey + 'Label'] = newLabel;

              // 检查是否有文件夹导入
              const files = folderInput ? folderInput.files : [];
              const isMirror = modalBody.querySelector('#dc-mirror')?.checked;

              if (files.length > 0) {
                // 读取所有文件并 base64 编码
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
                  // 镜像模式: 存储相对路径, 服务端在 VM 启动时同步
                  // 浏览器无法获取绝对路径, 所以用户需要手动输入
                  // 这里我们存储 topFolder 作为提示, 实际路径在服务端解析
                  hw[diskKey + 'Mirror'] = topFolder; // 相对项目目录
                  hw[diskKey + 'MirrorFiles'] = fileEntries; // 同时打包初始文件
                }

                // 无论是否镜像, 都打包初始文件到磁盘
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
