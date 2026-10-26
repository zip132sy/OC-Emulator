// ============================================================
// machineView.js - 自定义脚本机器的通用控制面板
//
// 数据来自 GET /api/mods/:name 的 machine 字段:
//   { running, error, script, connectedVm,
//     components: [{ type, label, props, actions, address, state, methods }] }
// 属性编辑写入 /machine-state, 动作调用写入 /machine-action。
// ============================================================

const MachineView = (() => {
  const T = (key, fallback) => {
    try {
      const value = I18N.t(key);
      return value === key ? fallback : value;
    } catch {
      return fallback;
    }
  };

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatValue(value) {
    if (typeof value === 'boolean') return value ? '✓' : '✗';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    }
    return String(value == null ? '' : value);
  }

  // 组件定义变化时整块重建, 其余情况只刷新数值
  function signatureOf(data) {
    const components = (data && data.components) || [];
    return JSON.stringify({
      running: !!(data && data.running),
      error: (data && data.error) || null,
      connectedVm: (data && data.connectedVm) || null,
      components: components.map(component => ({
        type: component.type,
        label: component.label,
        props: (component.props || []).map(prop => [prop.key, prop.kind, prop.writable, prop.unit, prop.label]),
        actions: component.actions || [],
        methods: Object.keys(component.methods || {}),
      })),
    });
  }

  function propRow(component, index, prop) {
    const value = component.state ? component.state[prop.key] : undefined;
    const unit = prop.unit ? ` ${prop.unit}` : '';
    let control = '';
    if (prop.writable) {
      if (prop.kind === 'boolean') {
        control = `<label class="machine-switch"><input type="checkbox" data-role="prop" data-comp="${index}"
          data-key="${escapeHTML(prop.key)}" ${value ? 'checked' : ''}> ${escapeHTML(T('machine.enabled', '启用'))}</label>`;
      } else if (prop.kind === 'number') {
        const min = Number.isFinite(prop.min) ? ` min="${prop.min}"` : '';
        const max = Number.isFinite(prop.max) ? ` max="${prop.max}"` : '';
        control = `<input type="number" step="any" data-role="prop" data-comp="${index}"
          data-key="${escapeHTML(prop.key)}" value="${escapeHTML(value == null ? '' : value)}"${min}${max}>
          <button class="btn" data-role="prop-apply" data-comp="${index}" data-key="${escapeHTML(prop.key)}">${escapeHTML(T('machine.set', '设置'))}</button>`;
      } else {
        control = `<input type="text" data-role="prop" data-comp="${index}"
          data-key="${escapeHTML(prop.key)}" value="${escapeHTML(value == null ? '' : value)}">
          <button class="btn" data-role="prop-apply" data-comp="${index}" data-key="${escapeHTML(prop.key)}">${escapeHTML(T('machine.set', '设置'))}</button>`;
      }
    }
    return `<div class="machine-prop">
      <span class="machine-prop-label">${escapeHTML(prop.label || prop.key)}</span>
      <b class="machine-prop-value" data-role="prop-value" data-comp="${index}" data-key="${escapeHTML(prop.key)}">${escapeHTML(formatValue(value))}${escapeHTML(unit)}</b>
      ${control}
    </div>`;
  }

  function componentCard(component, index) {
    const props = (component.props || []).map(prop => propRow(component, index, prop)).join('');
    const methods = Object.entries(component.methods || {}).map(([key, value]) => `
      <div class="machine-method">
        <span>${escapeHTML(key)}</span>
        <b data-role="method" data-comp="${index}" data-key="${escapeHTML(key)}">${escapeHTML(formatValue(value))}</b>
      </div>`).join('');
    const actions = (component.actions || []).map(action => `
      <button class="btn" data-role="machine-action" data-comp="${index}" data-action="${escapeHTML(action)}">${escapeHTML(action)}</button>`).join('');
    return `<section class="machine-card">
      <header class="machine-card-head">
        <b>${escapeHTML(component.label || component.type)}</b>
        <span class="machine-type">${escapeHTML(component.type)}</span>
        <span class="machine-addr" title="${escapeHTML(component.address || '')}">${escapeHTML(component.address || '')}</span>
      </header>
      <div class="machine-props">
        ${props || `<div class="machine-empty">${escapeHTML(T('machine.no-props', '该组件没有属性'))}</div>`}
      </div>
      ${methods ? `<div class="machine-methods">${methods}</div>` : ''}
      ${actions ? `<div class="machine-actions">${actions}</div>` : ''}
    </section>`;
  }

  function render(root, data, opts = {}) {
    if (!root) return null;
    const machine = data || {};
    root.__machineOpts = opts;
    root.__machineSig = signatureOf(machine);
    const components = machine.components || [];
    root.innerHTML = `
      <div class="machine-info">
        <div class="machine-head">
          <span class="machine-status ${machine.running ? 'on' : 'off'}">${escapeHTML(machine.running
            ? T('machine.running', '运行中')
            : T('machine.stopped', '已停止'))}</span>
          <span class="machine-conn ${machine.connectedVm ? 'on' : ''}">${machine.connectedVm
            ? escapeHTML(T('machine.connected', '已连接: {vm}').replace('{vm}', machine.connectedVm))
            : escapeHTML(T('machine.not-connected', '未连接'))}</span>
          <div class="spacer"></div>
          <button class="btn" data-role="machine-connect">${escapeHTML(T('machine.connect', '连接到虚拟机'))}</button>
          <button class="btn" data-role="machine-script">${escapeHTML(T('machine.script-edit', '编辑脚本'))}</button>
        </div>
        ${machine.error ? `<div class="machine-error">${escapeHTML(T('machine.error', '脚本错误'))}: ${escapeHTML(machine.error)}</div>` : ''}
        ${components.length
          ? components.map(componentCard).join('')
          : `<div class="machine-empty">${escapeHTML(T('machine.no-components', '脚本未定义任何组件'))}</div>`}
      </div>
    `;
    bind(root, machine, opts);
    return root;
  }

  function bind(root, machine, opts) {
    const connect = root.querySelector('[data-role="machine-connect"]');
    if (connect && typeof opts.onConnect === 'function') {
      connect.addEventListener('click', () => opts.onConnect());
    }
    const script = root.querySelector('[data-role="machine-script"]');
    if (script && typeof opts.onEditScript === 'function') {
      script.addEventListener('click', () => opts.onEditScript());
    }

    const writeProp = async (index, key, value) => {
      try {
        const result = await App.api(`mods/${encodeURIComponent(opts.modName)}/machine-state`, {
          method: 'POST',
          body: { component: index, key, value },
        });
        if (result && result.error) throw new Error(result.error);
      } catch (e) {
        if (window.App && App.setStatus) App.setStatus(`${T('machine.save-failed', '写入失败')}: ${e.message}`);
      }
    };

    root.querySelectorAll('[data-role="prop-apply"]').forEach(button => {
      button.addEventListener('click', () => {
        const index = parseInt(button.dataset.comp, 10);
        const key = button.dataset.key;
        const input = root.querySelector(`[data-role="prop"][data-comp="${index}"][data-key="${key}"]`);
        if (!input) return;
        writeProp(index, key, input.value);
      });
    });

    root.querySelectorAll('[data-role="prop"]').forEach(input => {
      if (input.type !== 'checkbox') return;
      input.addEventListener('change', () => {
        writeProp(parseInt(input.dataset.comp, 10), input.dataset.key, input.checked);
      });
    });

    root.querySelectorAll('[data-role="machine-action"]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await App.api(`mods/${encodeURIComponent(opts.modName)}/machine-action`, {
            method: 'POST',
            body: {
              component: parseInt(button.dataset.comp, 10),
              action: button.dataset.action,
              args: [],
            },
          });
          if (result && result.error) throw new Error(result.error);
        } catch (e) {
          if (window.App && App.setStatus) App.setStatus(`${T('machine.action-failed', '操作失败')}: ${e.message}`);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function update(root, data) {
    if (!root) return null;
    const machine = data || {};
    const signature = signatureOf(machine);
    if (root.__machineSig !== signature) return render(root, machine, root.__machineOpts || {});
    root.__machineSig = signature;

    const components = machine.components || [];
    root.querySelectorAll('[data-role="prop-value"]').forEach(element => {
      const component = components[parseInt(element.dataset.comp, 10)];
      if (!component) return;
      const prop = (component.props || []).find(item => item.key === element.dataset.key);
      if (!prop) return;
      const value = (component.state || {})[prop.key];
      element.textContent = formatValue(value) + (prop.unit ? ` ${prop.unit}` : '');
    });

    root.querySelectorAll('[data-role="prop"]').forEach(input => {
      if (input === document.activeElement) return;
      const component = components[parseInt(input.dataset.comp, 10)];
      if (!component) return;
      const value = (component.state || {})[input.dataset.key];
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = value == null ? '' : value;
    });

    root.querySelectorAll('[data-role="method"]').forEach(element => {
      const component = components[parseInt(element.dataset.comp, 10)];
      if (!component) return;
      element.textContent = formatValue((component.methods || {})[element.dataset.key]);
    });

    const status = root.querySelector('.machine-status');
    if (status) {
      status.className = `machine-status ${machine.running ? 'on' : 'off'}`;
      status.textContent = machine.running ? T('machine.running', '运行中') : T('machine.stopped', '已停止');
    }
    return root;
  }

  return { render, update };
})();

window.MachineView = MachineView;
