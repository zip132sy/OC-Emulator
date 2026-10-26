// ============================================================
// app.js - 主应用: VM 列表 / WebSocket / 标签页管理
// ============================================================

const App = (() => {
  const state = {
    vms: [],            // [{ name, state, config }]
    mods: [],           // [{ name, type, state, address, ... }]
    tabs: [],           // [{ id, vm, type, title, dirty }]
    activeTabId: null,
    ws: null,
    wsReconnectTimer: null,
    wsSubscribedVm: null,
    wsSubscribedMod: null,
    logLevel: 'error',   // full | error | off, 与服务端设置同步
    sidebarMode: 'vm',  // 'vm' | 'mod'
    connText: 'disconnected', // 最近一次连接状态 key, 语言切换后重绘
    connKind: 'err',
    _modsSig: '',       // Mods 列表签名, 避免轮询时无意义重建 DOM
    tabPanes: new Map(), // tabId -> HTMLElement (缓存 pane 避免切换时重建)
  };

  // ---------- 工具 ----------
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setStatus(text, kind = '') {
    const el = $('#status-text');
    if (el) el.textContent = text;
  }

  function setStatusRight(text) {
    const el = $('#status-right');
    if (el) el.textContent = text;
  }

  function setConnStatus(text, kind = '') {
    const el = $('#conn-status');
    state.connText = text;
    state.connKind = kind;
    el.textContent = I18N.t('ws.' + text);
    el.className = 'conn-status ' + kind;
  }

  // ---------- HTTP 请求 ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch { return txt; }
  }

  // ---------- Lua 检测 ----------
  async function checkLua() {
    const badge = $('#lua-badge');
    badge.textContent = I18N.t('lua.checking');
    badge.className = 'brand-sub';
    try {
      const r = await api('lua/check', { method: 'POST' });
      if (r && r.ok) {
        badge.textContent = 'Lua: ' + r.version + (r.cached ? I18N.t('lua.cached') : '');
        badge.className = 'brand-sub ok';
      } else {
        badge.textContent = I18N.t('lua.failed');
        badge.className = 'brand-sub err';
        const errs = (r && r.errors) ? r.errors.join('; ') : I18N.t('lua.unknown-error');
        setStatus(I18N.t('lua.check-failed') + errs, 'err');
      }
    } catch (e) {
      badge.textContent = I18N.t('lua.error');
      badge.className = 'brand-sub err';
      setStatus(I18N.t('lua.request-failed') + e.message, 'err');
    }
  }

  // ---------- 日志级别 ----------
  // 前端日志与虚拟机日志共用同一个设置: full / error / off
  async function loadLogLevel() {
    try {
      const s = await api('settings');
      if (s && s.logLevel) state.logLevel = s.logLevel;
    } catch {
      /* 读取失败时保持默认 error */
    }
  }

  // ---------- 设置对话框 ----------
  async function openSettings() {
    try {
      const cur = await api('settings') || {};
      const curLang = I18N.getLang();
      Modal.open({
        title: I18N.t('settings.title'),
        size: 'medium',
        bodyHTML: `
          <div class="form-row">
            <label>${I18N.t('settings.lua-path')}</label>
            <div style="display:flex;gap:6px;">
              <input type="text" id="settings-luaexe" value="${escapeAttr(cur.luaExe || '')}" style="flex:1;" placeholder="${escapeAttr(I18N.t('settings.lua-path'))}">
              <button class="btn" id="settings-browse" type="button">${I18N.t('settings.browse')}</button>
            </div>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.lua-hint')}</span>
          </div>
          <div class="form-row">
            <label>${I18N.t('settings.language')}</label>
            <select id="settings-lang" style="flex:1;padding:6px 8px;background:var(--bg-input);color:var(--fg-primary);border:1px solid var(--border);border-radius:3px;">
              <option value="zh" ${curLang === 'zh' ? 'selected' : ''}>简体中文</option>
              <option value="en" ${curLang === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
          <div class="form-row">
            <label>${I18N.t('settings.log-level')}</label>
            <select id="settings-loglevel" style="flex:1;padding:6px 8px;background:var(--bg-input);color:var(--fg-primary);border:1px solid var(--border);border-radius:3px;">
              <option value="full" ${cur.logLevel === 'full' ? 'selected' : ''}>${I18N.t('settings.log-level.full')}</option>
              <option value="error" ${cur.logLevel === 'error' ? 'selected' : ''}>${I18N.t('settings.log-level.error')}</option>
              <option value="off" ${cur.logLevel === 'off' ? 'selected' : ''}>${I18N.t('settings.log-level.off')}</option>
            </select>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.log-level-hint')}</span>
          </div>
          <div class="form-row">
            <label for="settings-showconsole">${I18N.t('settings.show-console')}</label>
            <label class="checkbox-line">
              <input type="checkbox" id="settings-showconsole" ${cur.showConsole !== false ? 'checked' : ''}>
              <span id="settings-console-state">${cur.showConsole !== false ? I18N.t('settings.console-on') : I18N.t('settings.console-off')}</span>
            </label>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.show-console-hint')}</span>
          </div>
          <div class="form-row">
            <label for="settings-wheelkeys">${I18N.t('settings.wheel-keys')}</label>
            <label class="checkbox-line">
              <input type="checkbox" id="settings-wheelkeys" ${(window.Console && Console.isWheelKeyCompat && Console.isWheelKeyCompat()) ? 'checked' : ''}>
              <span id="settings-wheelkeys-state">${(window.Console && Console.isWheelKeyCompat && Console.isWheelKeyCompat()) ? I18N.t('settings.wheel-keys-on') : I18N.t('settings.wheel-keys-off')}</span>
            </label>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.wheel-keys-hint')}</span>
          </div>
          <div class="form-row">
            <label for="settings-autoupdate">${I18N.t('settings.auto-update')}</label>
            <label class="checkbox-line">
              <input type="checkbox" id="settings-autoupdate" ${cur.autoUpdate !== false ? 'checked' : ''}>
              <span id="settings-autoupdate-state">${cur.autoUpdate !== false ? I18N.t('settings.auto-update-on') : I18N.t('settings.auto-update-off')}</span>
            </label>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.auto-update-hint')}</span>
          </div>
          <div class="form-row">
            <label for="settings-skipintegrity">${I18N.t('settings.skip-integrity')}</label>
            <label class="checkbox-line">
              <input type="checkbox" id="settings-skipintegrity" ${cur.skipIntegrityCheck === true ? 'checked' : ''}>
              <span id="settings-skipintegrity-state">${cur.skipIntegrityCheck === true ? I18N.t('settings.auto-update-on') : I18N.t('settings.auto-update-off')}</span>
            </label>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.skip-integrity-hint')}</span>
          </div>
          <div class="form-row">
            <label>${I18N.t('settings.rollback')}</label>
            <div style="display:flex;align-items:center;gap:8px;flex:1;">
              <button class="btn" id="settings-rollback" type="button">${I18N.t('settings.rollback-btn')}</button>
              <span class="hint">${I18N.t('settings.rollback-hint')}</span>
            </div>
          </div>
        `,
        footerHTML: `
          <button class="btn" data-action="modal-close">${I18N.t('settings.cancel')}</button>
          <button class="btn btn-primary" id="settings-save">${I18N.t('settings.save')}</button>
        `,
        onMount(body, footer) {
          const cancelBtn = footer.querySelector('[data-action="modal-close"]');
          if (cancelBtn) cancelBtn.addEventListener('click', () => Modal.close());
          const input = body.querySelector('#settings-luaexe');
          const langSelect = body.querySelector('#settings-lang');
          const logLevelSelect = body.querySelector('#settings-loglevel');
          // 命令行窗口显示开关: 切换即时生效 (立即隐藏 / 显示服务器控制台窗口)
          const showConsoleBox = body.querySelector('#settings-showconsole');
          const consoleStateEl = body.querySelector('#settings-console-state');
          if (showConsoleBox) {
            showConsoleBox.addEventListener('change', async () => {
              const want = showConsoleBox.checked;
              try {
                const r = await api('settings', { method: 'PUT', body: { showConsole: want } });
                const res = r && r.consoleResult;
                // 平台相关的失败原因给更具体的中文提示, 其余回落到通用文案
                const reasonKey = (res && res.reason) ? ({
                  'wayland': 'settings.console-reason-wayland',
                  'missing-xdotool': 'settings.console-reason-xdotool',
                  'cannot-detect-terminal': 'settings.console-reason-unknown-terminal',
                  'cannot-detect-window': 'settings.console-reason-unknown-terminal',
                }[res.reason] || null) : null;
                if (res && (res.supported === false || res.ok === false)) {
                  consoleStateEl.textContent = I18N.t(reasonKey || 'settings.console-unsupported');
                } else {
                  consoleStateEl.textContent = want
                    ? I18N.t('settings.console-on')
                    : I18N.t('settings.console-off');
                }
              } catch (e) {
                consoleStateEl.textContent = I18N.t('settings.save-failed');
              }
            });
          }
          // 滚轮兼容模式 (前端本地开关, 即时生效, 无需保存)
          const wheelKeysBox = body.querySelector('#settings-wheelkeys');
          const wheelKeysState = body.querySelector('#settings-wheelkeys-state');
          if (wheelKeysBox) {
            wheelKeysBox.addEventListener('change', () => {
              const on = wheelKeysBox.checked;
              if (window.Console && Console.setWheelKeyCompat) Console.setWheelKeyCompat(on);
              if (wheelKeysState) {
                wheelKeysState.textContent = on ? I18N.t('settings.wheel-keys-on') : I18N.t('settings.wheel-keys-off');
              }
            });
          }
          // 自动更新开关 (写入 settings.json, 下次启动脚本启动时生效)
          const autoUpdateBox = body.querySelector('#settings-autoupdate');
          const autoUpdateState = body.querySelector('#settings-autoupdate-state');
          if (autoUpdateBox) {
            autoUpdateBox.addEventListener('change', async () => {
              const on = autoUpdateBox.checked;
              if (autoUpdateState) {
                autoUpdateState.textContent = on ? I18N.t('settings.auto-update-on') : I18N.t('settings.auto-update-off');
              }
              try {
                await api('settings', { method: 'PUT', body: { autoUpdate: on } });
              } catch (e) {
                if (autoUpdateState) autoUpdateState.textContent = I18N.t('settings.save-failed');
              }
            });
          }
          // 跳过完整性检测 (写入 settings.json, 下次启动脚本启动时生效)
          const skipIntegrityBox = body.querySelector('#settings-skipintegrity');
          const skipIntegrityState = body.querySelector('#settings-skipintegrity-state');
          if (skipIntegrityBox) {
            skipIntegrityBox.addEventListener('change', async () => {
              const on = skipIntegrityBox.checked;
              if (skipIntegrityState) {
                skipIntegrityState.textContent = on ? I18N.t('settings.auto-update-on') : I18N.t('settings.auto-update-off');
              }
              try {
                await api('settings', { method: 'PUT', body: { skipIntegrityCheck: on } });
              } catch (e) {
                if (skipIntegrityState) skipIntegrityState.textContent = I18N.t('settings.save-failed');
              }
            });
          }
          // 版本回退
          const rollbackBtn = body.querySelector('#settings-rollback');
          if (rollbackBtn) rollbackBtn.addEventListener('click', () => openRollbackDialog());
          // 浏览按钮 (隐藏的 file input)
          const browseBtn = body.querySelector('#settings-browse');
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          // 不加 accept 过滤: Lua 可执行文件在 Windows 是 .exe, 在 Linux/macOS 没有扩展名
          fileInput.style.display = 'none';
          body.appendChild(fileInput);
          browseBtn.addEventListener('click', () => fileInput.click());
          fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
              input.value = fileInput.files[0].name;
              alert(I18N.t('settings.path-restricted'));
              input.focus();
              input.select();
            }
          });
          // 保存
          document.querySelector('#settings-save').addEventListener('click', async () => {
            const newPath = input.value.trim();
            if (!newPath) { alert(I18N.t('settings.lua-empty')); return; }
            // 保存语言
            const newLang = langSelect.value;
            const langChanged = newLang !== I18N.getLang();
            // 日志级别
            const newLogLevel = logLevelSelect.value;
            try {
              const r = await api('settings', { method: 'PUT', body: { luaExe: newPath, logLevel: newLogLevel } });
              if (r && r.ok) {
                state.logLevel = newLogLevel;
                if (langChanged) {
                  // 语言切换后整页重载, 保证已经渲染的视图/徽章/弹窗全部换用新语言
                  I18N.setLang(newLang);
                  location.reload();
                  return;
                }
                Modal.close();
                setStatus(I18N.t('settings.saved'));
                checkLua();
                applyLanguage();
              } else {
                alert(I18N.t('settings.save-failed'));
              }
            } catch (e) {
              alert(I18N.t('settings.save-failed') + ': ' + e.message);
            }
          });
        },
      });
    } catch (e) {
      alert(I18N.t('settings.load-failed') + e.message);
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  // ---------- 手机端侧边栏抽屉 ----------
  // 抽屉开关只在窄屏出现; 宽屏调用也没有副作用 (class 不会被任何样式命中)。
  function toggleNav(force) {
    const open = (force === undefined)
      ? !document.body.classList.contains('nav-open')
      : !!force;
    document.body.classList.toggle('nav-open', open);
  }

  // ---------- 服务级控制 ----------
  // 重启服务: 服务器先停掉所有 VM, 再以退出码 5 退出, 由 run.bat / run.sh 立即拉起。
  async function restartServer(skipConfirm) {
    if (!skipConfirm && !confirm(I18N.t('confirm.restart-server'))) return;
    try {
      await api('server/restart', { method: 'POST' });
    } catch (e) {
      // 服务器可能已经开始退出, 请求被中断属于正常现象
    }
    setStatus(I18N.t('server.restarting'));
  }

  // 停止服务: 服务器停掉所有 VM 后以退出码 4 退出, 守护脚本不再拉起。
  async function stopServer() {
    if (!confirm(I18N.t('confirm.stop-server'))) return;
    try {
      await api('server/stop', { method: 'POST' });
    } catch (e) {
      // 同上
    }
    setStatus(I18N.t('server.stopped'));
  }

  // ---------- 检查更新 / 版本回退 ----------
  // 结果统一在弹窗里展示 (含更新日志); 更新或回退后由用户决定是否重启后端,
  // 不自动重启, 避免正在运行虚拟机时被迫中断。
  let updateBusy = false;

  function trLang(zh, en) { return I18N.getLang() === 'zh' ? zh : en; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // "处理中"弹窗: 让用户知道操作已开始, 同时按钮被禁用防止重复点击
  function openBusyModal(titleKey, hintKey) {
    Modal.open({
      title: I18N.t(titleKey),
      size: 'small',
      bodyHTML: `<div style="text-align:center;padding:18px 8px;color:var(--fg-muted);font-size:13px;">${I18N.t(hintKey)}</div>`,
      footerHTML: '',
    });
  }

  function runningVmCount() {
    try {
      return (state.vms || []).filter((v) => v.state === 'running' || v.state === 'paused' || v.state === 'starting').length;
    } catch (e) {
      return 0;
    }
  }

  // 重启提醒: 有虚拟机在运行时额外提示会被中断
  function restartWarn() {
    const n = runningVmCount();
    return n > 0
      ? trLang(`\n\n注意：当前有 ${n} 台虚拟机正在运行，重启会中断它们。`, `\n\nNote: ${n} VM(s) are running; restarting will interrupt them.`)
      : '';
  }

  function commitListHtml(commits) {
    const items = (commits || []).map((c) => `
      <li style="margin:6px 0;list-style:disc;">
        <code style="color:var(--accent);">${escapeHtml(c.short || c.sha || '')}</code>
        <span style="margin-left:6px;">${escapeHtml(c.subject || '')}</span>
        <span style="color:var(--fg-muted);margin-left:6px;font-size:11px;">${escapeHtml(c.date || '')}</span>
      </li>`).join('');
    return items || `<li style="list-style:disc;color:var(--fg-muted);">${escapeHtml(trLang('（无提交记录）', '(no commits)'))}</li>`;
  }

  // 更新结果窗口 (mode: available / uptodate / error / info)
  function showUpdateModal(mode, opts) {
    const o = opts || {};
    let title, body, footer;

    if (mode === 'available') {
      const d = o.data || {};
      title = trLang('发现新版本', 'Update available');
      body = `
        <div style="margin-bottom:10px;">${escapeHtml(trLang(
          `本地 ${d.current}，远端 ${d.latest}，落后 ${d.behind} 个提交`,
          `local ${d.current}, remote ${d.latest}, ${d.behind} commit(s) behind`
        ))}</div>
        <div style="margin:10px 0 4px;color:var(--fg-muted);font-size:12px;">${escapeHtml(trLang('本次更新内容', 'Changes in this update'))}</div>
        <ul style="margin:0;padding-left:18px;max-height:280px;overflow:auto;font-size:12px;">${commitListHtml(d.log)}</ul>`;
      footer = `<button class="btn" data-action="modal-close">${escapeHtml(trLang('取消', 'Cancel'))}</button>`
             + `<button class="btn btn-primary" id="update-apply">${escapeHtml(trLang('立即更新', 'Update now'))}</button>`;
    } else if (mode === 'uptodate') {
      const d = o.data || {};
      title = trLang('已是最新版本', 'Already up to date');
      body = `
        <div style="margin-bottom:10px;">${escapeHtml(trLang(`当前版本：${d.current}`, `current version: ${d.current}`))}</div>
        <div style="margin:10px 0 4px;color:var(--fg-muted);font-size:12px;">${escapeHtml(trLang('当前版本更新日志', 'Changelog of the current version'))}</div>
        <ul style="margin:0;padding-left:18px;max-height:280px;overflow:auto;font-size:12px;">${commitListHtml(d.log)}</ul>`;
      footer = `<button class="btn" data-action="modal-close">${escapeHtml(trLang('关闭', 'Close'))}</button>`;
    } else {
      title = (mode === 'error') ? trLang('检查更新失败', 'Update check failed') : trLang('提示', 'Notice');
      body = `<div style="word-break:break-word;${mode === 'error' ? 'color:var(--err);' : ''}">${escapeHtml(o.message || '')}</div>`;
      footer = `<button class="btn" data-action="modal-close">${escapeHtml(trLang('关闭', 'Close'))}</button>`;
    }

    Modal.open({
      title,
      size: 'medium',
      bodyHTML: body,
      footerHTML: footer,
      onMount(_bodyEl, footerEl) {
        const applyBtn = footerEl && footerEl.querySelector('#update-apply');
        if (applyBtn) applyBtn.addEventListener('click', () => applyUpdateFlow());
      },
    });
  }

  // 检查更新 (结果在弹窗中展示)
  async function checkUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    const btn = document.getElementById('menu-check-update');
    if (btn) btn.disabled = true;

    setStatus(I18N.t('update.checking'));
    openBusyModal('update.checking', 'update.checking-hint');

    let r = null, err = null;
    try {
      r = await api('update/check');
    } catch (e) {
      err = e;
    }
    Modal.close();
    updateBusy = false;
    if (btn) btn.disabled = false;

    if (err) {
      setStatus(I18N.t('update.failed'));
      showUpdateModal('error', { message: trLang('检查更新失败: ', 'Update check failed: ') + err.message });
      return;
    }
    if (!r || !r.ok) {
      setStatus(I18N.t('update.failed'));
      const map = {
        'not-a-repo': trLang('当前目录不是 git 仓库，无法检查更新。', 'Not a git repository; cannot check for updates.'),
        'fetch-failed': trLang('无法连接远端仓库，请检查网络或 git 配置。', 'Cannot reach the remote repository. Check your network or git settings.'),
        'no-upstream': trLang('未找到远端跟踪分支，无法比较版本。', 'No remote tracking branch found; cannot compare versions.'),
      };
      showUpdateModal('error', { message: map[r && r.error] || String((r && (r.detail || r.error)) || '') });
      return;
    }

    if (r.available) {
      setStatus(I18N.t('update.available'));
      showUpdateModal('available', { data: r });
    } else {
      setStatus(I18N.t('update.up-to-date'));
      showUpdateModal('uptodate', { data: r });
    }
  }

  // 执行更新; 完成后询问是否重启后端
  async function applyUpdateFlow() {
    if (updateBusy) return;
    updateBusy = true;
    setStatus(I18N.t('update.applying'));
    openBusyModal('update.applying', 'update.applying-hint');

    let a = null, err = null;
    try {
      a = await api('update/apply', { method: 'POST' });
    } catch (e) {
      err = e;
    }
    Modal.close();
    updateBusy = false;

    if (err) { setStatus(I18N.t('update.failed')); showUpdateModal('error', { message: trLang('更新失败: ', 'Update failed: ') + err.message }); return; }
    if (!a || !a.ok) { setStatus(I18N.t('update.failed')); showUpdateModal('error', { message: trLang('更新失败: ', 'Update failed: ') + String((a && (a.output || a.error)) || '') }); return; }
    if (!a.changed) { setStatus(I18N.t('update.up-to-date')); showUpdateModal('info', { message: trLang('已是最新版本，无需重启。', 'Already up to date; no restart needed.') }); return; }

    setStatus(I18N.t('update.done'));
    const ask = trLang(
      `更新完成（${a.before} → ${a.after}）。\n\n是否立即重启后端使更新生效？`,
      `Update complete (${a.before} -> ${a.after}).\n\nRestart the backend now to apply the update?`
    ) + restartWarn();
    if (confirm(ask)) await restartServer(true);
  }

  // 设置里的"版本回退": 列出历史版本供选择
  async function openRollbackDialog() {
    if (updateBusy) return;
    updateBusy = true;
    openBusyModal('update.versions-loading', 'update.versions-loading-hint');

    let v = null, err = null;
    try {
      v = await api('update/versions');
    } catch (e) {
      err = e;
    }
    Modal.close();
    updateBusy = false;

    if (err || !v || !v.ok) {
      showUpdateModal('error', { message: err ? err.message : String((v && v.error) || '') });
      return;
    }

    const rows = (v.versions || []).map((c) => {
      const isCur = (c.short === v.current);
      return `
        <li style="margin:6px 0;">
          <button class="btn rollback-item" data-sha="${escapeAttr(c.sha)}" type="button"
                  style="width:100%;text-align:left;padding:6px 8px;" ${isCur ? 'disabled' : ''}>
            <code style="color:var(--accent);">${escapeHtml(c.short)}</code>
            <span style="margin-left:6px;">${escapeHtml(c.subject)}</span>
            <span style="color:var(--fg-muted);margin-left:6px;font-size:11px;">${escapeHtml(c.date || '')}</span>
            ${isCur ? `<span style="color:var(--fg-muted);font-size:11px;"> ${escapeHtml(trLang('（当前）', '(current)'))}</span>` : ''}
          </button>
        </li>`;
    }).join('');

    Modal.open({
      title: trLang('版本回退', 'Rollback'),
      size: 'medium',
      bodyHTML: `
        <div style="color:var(--fg-muted);font-size:12px;margin-bottom:8px;">
          ${escapeHtml(trLang('选择要回退到的历史版本（会覆盖本地对已跟踪文件的修改）。', 'Choose a previous version (local changes to tracked files will be overwritten).'))}
        </div>
        <ul style="margin:0;padding:0;list-style:none;max-height:300px;overflow:auto;">${rows}</ul>
      `,
      footerHTML: `<button class="btn" data-action="modal-close">${escapeHtml(trLang('关闭', 'Close'))}</button>`,
      onMount(bodyEl) {
        bodyEl.querySelectorAll('.rollback-item').forEach((el) => {
          el.addEventListener('click', () => rollbackFlow(el.dataset.sha));
        });
      },
    });
  }

  async function rollbackFlow(sha) {
    if (updateBusy || !sha) return;
    if (!confirm(trLang(`确定回退到 ${sha} 吗？`, `Roll back to ${sha}?`) + restartWarn())) return;

    updateBusy = true;
    setStatus(trLang('正在回退版本…', 'Rolling back…'));
    openBusyModal('update.rollback-loading', 'update.rollback-loading-hint');

    let a = null, err = null;
    try {
      a = await api('update/rollback', { method: 'POST', body: { ref: sha } });
    } catch (e) {
      err = e;
    }
    Modal.close();
    updateBusy = false;

    if (err) { showUpdateModal('error', { message: err.message }); return; }
    if (!a || !a.ok) { showUpdateModal('error', { message: trLang('回退失败: ', 'Rollback failed: ') + String((a && (a.output || a.error)) || '') }); return; }
    if (!a.changed) { showUpdateModal('info', { message: trLang('已经处于该版本。', 'Already at this version.') }); return; }

    const ask = trLang(
      `版本回退完成（${a.before} → ${a.after}）。\n\n是否立即重启后端使回退生效？`,
      `Rollback complete (${a.before} -> ${a.after}).\n\nRestart the backend now to apply it?`
    ) + restartWarn();
    if (confirm(ask)) await restartServer(true);
  }

  // ---------- VM 列表 ----------
  // manual = true 时表示用户点了"刷新"按钮: 除了拉列表, 还会强制重新同步
  // 当前打开标签页的虚拟机状态与画面 (用于 WebSocket 掉线/丢消息后的手动纠正)。
  async function refreshVMs(manual) {
    try {
      const vms = await api('vms');
      state.vms = vms || [];
      renderVMList();
      // 把服务器状态同步到各 VM 视图: 按钮可用性 + "已停止"的画面表现。
      // 这是 5 秒一次的兜底轮询, 保证某条 WebSocket 状态消息漏掉时,
      // 控制菜单也能自动纠正, 而不需要刷新整个页面。
      if (window.Console && Console.applyServerState) {
        for (const vm of state.vms) {
          Console.applyServerState(vm.name, vm.state, vm.exitCode, vm.cleanStop);
        }
      }
      // 手动刷新: 重新订阅 WebSocket 并重新拉取当前 VM 的权威状态与画面
      if (manual) {
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab && tab.type === 'vm') {
          wsSubscribe(tab.vm);
          if (window.Console && Console.reloadView) Console.reloadView(tab.vm);
        }
      }
      if (state.sidebarMode === 'vm') {
        setStatus(I18N.t('status.vm-loaded').replace('{count}', state.vms.length));
      }
    } catch (e) {
      if (state.sidebarMode === 'vm') {
        setStatus(I18N.t('status.vm-load-failed') + ': ' + e.message, 'err');
      }
    }
  }

  function renderVMList() {
    const ul = $('#vm-list');
    ul.innerHTML = '';
    updateSidebarCount();

    // 重建列表会丢掉选中高亮, 这里根据当前激活标签页重新应用,
    // 否则每 5 秒自动刷新一次就会把"正在查看的虚拟机"的高亮抹掉。
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    const activeVm = (activeTab && activeTab.type === 'vm') ? activeTab.vm : null;

    if (state.vms.length === 0) {
      const li = document.createElement('li');
      li.className = 'vm-empty';
      li.innerHTML = I18N.t('sidebar.no-vm').replace(/\n/g, '<br>');
      ul.appendChild(li);
      return;
    }

    for (const vm of state.vms) {
      const li = document.createElement('li');
      li.className = 'vm-item' + (vm.name === activeVm ? ' active' : '');
      li.dataset.vmName = vm.name;
      li.innerHTML = `
        <span class="vm-icon ${vm.state}"></span>
        <div class="vm-info">
          <div class="vm-name"></div>
          <div class="vm-meta"></div>
        </div>
      `;
      li.querySelector('.vm-name').textContent = vm.name;
      const metaParts = [];
      if (vm.config) {
        if (vm.config.apu) {
          const tierLabel = vm.config.apu.tier === 'creative'
            ? I18N.t('vm.meta.creative')
            : 'T' + vm.config.apu.tier;
          metaParts.push(I18N.t('vm.meta.apu') + ' ' + tierLabel);
        }
        if (Array.isArray(vm.config.memory)) metaParts.push(I18N.t('vm.meta.ram') + ' T' + vm.config.memory.join('/'));
      }
      const stateKey = 'vm.state.' + (vm.state || 'unknown');
      metaParts.push(I18N.t(stateKey));
      li.querySelector('.vm-meta').textContent = metaParts.join(' · ');
      li.addEventListener('click', () => openVMTab(vm.name));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showVMContextMenu(vm.name, e.clientX, e.clientY);
      });
      ul.appendChild(li);
    }
  }

  // ---------- Mods 列表 ----------
  function modTypeInfo(type) {
    if (type === 'drone') return { icon: '🛸', label: I18N.t('mods.type.drone') };
    if (type === 'reactor') return { icon: '☢️', label: I18N.t('mods.type.reactor') };
    if (type === 'machine') return { icon: '⚙️', label: I18N.t('mods.type.machine') };
    if (type === 'microcontroller') return { icon: '🧩', label: I18N.t('mods.type.mcu') };
    return { icon: '🤖', label: I18N.t('mods.type.robot') };
  }

  function modStateLabel(s) {
    return I18N.t('vm.state.' + (s || 'stopped'));
  }

  function modMetaText(mod) {
    const ti = modTypeInfo(mod.type);
    const parts = [ti.label, modStateLabel(mod.state)];
    if (mod.type === 'reactor' && mod.reactor) {
      parts.push(`${mod.reactor.euPerTick || 0} EU/t`);
    }
    if (mod.connectedVm) parts.push(`→ ${mod.connectedVm}`);
    if (mod.address) parts.push(mod.address.slice(0, 8));
    return parts.join(' · ');
  }

  function updateSidebarCount() {
    const title = $('#vm-list-title');
    const count = $('#vm-count');
    if (!title || !count) return;
    if (state.sidebarMode === 'mod') {
      title.textContent = I18N.t('sidebar.mod-library');
      count.textContent = state.mods.length;
    } else {
      title.textContent = I18N.t('sidebar.vm-library');
      count.textContent = state.vms.length;
    }
  }

  function setSidebarMode(mode) {
    state.sidebarMode = mode === 'mod' ? 'mod' : 'vm';
    const vmTab = $('#side-tab-vm');
    const modTab = $('#side-tab-mod');
    if (vmTab) vmTab.classList.toggle('active', state.sidebarMode === 'vm');
    if (modTab) modTab.classList.toggle('active', state.sidebarMode === 'mod');
    const vmList = $('#vm-list');
    const modList = $('#mod-list');
    if (vmList) vmList.classList.toggle('hidden', state.sidebarMode !== 'vm');
    if (modList) modList.classList.toggle('hidden', state.sidebarMode !== 'mod');
    updateSidebarCount();
    if (state.sidebarMode === 'mod') renderModList();
    else renderVMList();
  }

  async function refreshMods(manual) {
    try {
      const mods = await api('mods');
      const list = mods || [];
      const sig = JSON.stringify(list.map(m => [m.name, m.type, m.state, m.address, m.connectedVm || null]));
      const changed = sig !== state._modsSig;
      state._modsSig = sig;
      state.mods = list;
      // 只在数据变化或用户手动刷新时重建列表, 避免每 5 秒替换 DOM 导致点击丢失
      if (changed || manual) renderModList();
      updateSidebarCount();
      if (manual) {
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab && tab.type === 'mod' && window.ModView) ModView.reload(tab.mod);
      }
      if (state.sidebarMode === 'mod') {
        setStatus(I18N.t('status.mod-loaded').replace('{count}', state.mods.length));
      }
    } catch (e) {
      if (state.sidebarMode === 'mod') {
        setStatus(I18N.t('status.mod-load-failed') + ': ' + e.message, 'err');
      }
    }
  }

  function renderModList() {
    const ul = $('#mod-list');
    if (!ul) return;
    ul.innerHTML = '';

    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    const activeMod = (activeTab && activeTab.type === 'mod') ? activeTab.mod : null;

    if (state.mods.length === 0) {
      const li = document.createElement('li');
      li.className = 'vm-empty';
      li.innerHTML = I18N.t('sidebar.no-mod').replace(/\n/g, '<br>');
      ul.appendChild(li);
      return;
    }

    for (const mod of state.mods) {
      const ti = modTypeInfo(mod.type);
      const li = document.createElement('li');
      li.className = 'vm-item' + (mod.name === activeMod ? ' active' : '');
      li.dataset.modName = mod.name;
      li.innerHTML = `
        <span class="vm-icon ${mod.state || 'stopped'}"></span>
        <div class="vm-info">
          <div class="vm-name"></div>
          <div class="vm-meta"></div>
        </div>
      `;
      li.querySelector('.vm-name').textContent = `${ti.icon} ${mod.name}`;
      li.querySelector('.vm-meta').textContent = modMetaText(mod);
      li.title = mod.description || '';
      li.addEventListener('click', () => openModTab(mod.name));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showModContextMenu(mod.name, e.clientX, e.clientY);
      });
      ul.appendChild(li);
    }
  }

  function updateModListItem(name, patch = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) clean[k] = v;
    }
    const mod = state.mods.find(m => m.name === name);
    if (mod) Object.assign(mod, clean);
    const li = $$('#mod-list .vm-item').find(el => el.dataset.modName === name);
    if (!li) return;
    if (clean.state) li.querySelector('.vm-icon').className = `vm-icon ${clean.state}`;
    if (mod) li.querySelector('.vm-meta').textContent = modMetaText(mod);
  }

  function openModTab(modName) {
    const id = 'mod-' + modName;
    let tab = state.tabs.find(t => t.id === id);
    if (!tab) {
      const mod = state.mods.find(m => m.name === modName);
      const ti = modTypeInfo(mod ? mod.type : 'robot');
      tab = {
        id,
        type: 'mod',
        mod: modName,
        title: `${ti.icon} ${modName}`,
        onClose: () => { if (window.ModView) ModView.destroy(modName); },
      };
      state.tabs.push(tab);
    }
    activateTab(id);
    $$('#mod-list .vm-item').forEach(li => {
      li.classList.toggle('active', li.dataset.modName === modName);
    });
  }

  function showModContextMenu(modName, x, y) {
    const items = [
      { label: I18N.t('ctx.open'), action: () => openModTab(modName) },
      { label: I18N.t('ctx.start'), action: () => api(`mods/${encodeURIComponent(modName)}/start`, { method: 'POST' }).then(() => refreshMods(true)) },
      { label: I18N.t('ctx.stop'), action: () => api(`mods/${encodeURIComponent(modName)}/stop`, { method: 'POST' }).then(() => refreshMods(true)) },
      { label: I18N.t('ctx.restart'), action: () => api(`mods/${encodeURIComponent(modName)}/restart`, { method: 'POST' }).then(() => refreshMods(true)) },
      { label: I18N.t('ctx.delete'), action: async () => {
        if (confirm(I18N.t('ctx.confirm-delete-mod').replace('{name}', modName))) {
          await api(`mods/${encodeURIComponent(modName)}`, { method: 'DELETE' });
          const related = state.tabs.filter(t => t.type === 'mod' && t.mod === modName);
          for (const t of related) closeTab(t.id);
          refreshMods();
        }
      } },
    ];
    const choice = items.map((it, i) => `${i}: ${it.label}`).join('\n');
    const idx = prompt(`${I18N.t('ctx.menu-title')}\n${choice}`, '0');
    if (idx !== null) {
      const i = parseInt(idx, 10);
      if (items[i]) items[i].action();
    }
  }

  function openNewModDialog() {
    Modal.open({
      title: I18N.t('mods.new.title'),
      size: 'small',
      bodyHTML: `
        <div class="form-row"><label>${I18N.t('mods.new.name')}</label><input id="new-mod-name" value="Drone-01"></div>
        <div class="form-row"><label>${I18N.t('mods.new.type')}</label>
          <select id="new-mod-type">
            <option value="drone">${I18N.t('mods.type.drone')}</option>
            <option value="robot">${I18N.t('mods.type.robot')}</option>
            <option value="reactor">${I18N.t('mods.type.reactor')}</option>
            <option value="machine">${I18N.t('mods.type.machine')}</option>
          </select>
        </div>
        <div class="form-row"><label>${I18N.t('mods.new.description')}</label><input id="new-mod-desc" value=""></div>
        <p class="hint" style="margin:8px 0 0;color:var(--fg-muted);font-size:12px;line-height:1.6;">
          ${escapeHtml(I18N.t('mods.new.hint'))}
        </p>
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;">
          <input type="checkbox" id="new-mod-autostart" checked>
          ${I18N.t('mods.new.autostart')}
        </label>
      `,
      footerHTML: `
        <button class="btn" data-action="modal-close">${I18N.t('wizard.cancel')}</button>
        <button class="btn btn-primary" id="new-mod-create">${I18N.t('wizard.create')}</button>
      `,
      onMount(body, footer) {
        const cancel = footer.querySelector('[data-action="modal-close"]');
        if (cancel) cancel.addEventListener('click', () => Modal.close());
        footer.querySelector('#new-mod-create').addEventListener('click', async () => {
          const name = body.querySelector('#new-mod-name').value.trim();
          const type = body.querySelector('#new-mod-type').value;
          const description = body.querySelector('#new-mod-desc').value.trim();
          const autostart = body.querySelector('#new-mod-autostart').checked;
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
            alert(I18N.t('mods.new.invalid-name'));
            return;
          }
          try {
            await api('mods', { method: 'POST', body: { name, type, description } });
            Modal.close();
            await refreshMods();
            setSidebarMode('mod');
            openModTab(name);
            if (autostart) {
              await api(`mods/${encodeURIComponent(name)}/start`, { method: 'POST' });
              setTimeout(() => refreshMods(true), 500);
            }
          } catch (e) {
            alert(e.message);
          }
        });
      },
    });
  }

  // ---------- 标签页管理 ----------
  function openVMTab(vmName) {
    const id = 'vm-' + vmName;
    let tab = state.tabs.find(t => t.id === id);
    if (!tab) {
      tab = { id, vm: vmName, type: 'vm', title: vmName };
      state.tabs.push(tab);
    }
    activateTab(id);
    // 高亮 VM 列表项
    $$('.vm-item').forEach(li => {
      li.classList.toggle('active', li.dataset.vmName === vmName);
    });
  }

  function openTab(tab) {
    // 不重复创建相同 id 的 tab, 除非调用方明确要求
    const existing = state.tabs.find(t => t.id === tab.id);
    if (existing) {
      Object.assign(existing, tab);
      activateTab(existing.id);
      return existing;
    }
    state.tabs.push(tab);
    activateTab(tab.id);
    return tab;
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    if (tab.onClose) tab.onClose();
    state.tabs.splice(idx, 1);
    // 清理缓存的 pane
    const cachedPane = state.tabPanes.get(id);
    if (cachedPane) {
      cachedPane.remove();
      state.tabPanes.delete(id);
    }
    if (state.activeTabId === id) {
      const next = state.tabs[idx] || state.tabs[idx - 1];
      if (next) activateTab(next.id);
      else { state.activeTabId = null; renderTabs(); renderTabContent(); }
    } else {
      renderTabs();
    }
  }

  function activateTab(id) {
    state.activeTabId = id;
    renderTabs();
    renderTabContent();
    // 处理 WS 订阅切换
    const tab = state.tabs.find(t => t.id === id);
    const targetVm = (tab && tab.type === 'vm') ? tab.vm : null;
    const targetMod = (tab && tab.type === 'mod') ? tab.mod : null;
    if (targetVm !== state.wsSubscribedVm || targetMod !== state.wsSubscribedMod) {
      wsSubscribe(targetVm, targetMod);
    }
    // 切换后触发一次 resize, 确保 canvas 尺寸正确 (从隐藏→显示时)
    if (tab && (tab.type === 'vm' || tab.type === 'mod')) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  }

  function renderTabs() {
    const bar = $('#tabs-bar');
    bar.innerHTML = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
      el.dataset.tabId = tab.id;
      el.innerHTML = `<span class="tab-title"></span><span class="tab-close" title="${I18N.t('tab.close')}">×</span>`;
      el.querySelector('.tab-title').textContent = tab.title;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          e.stopPropagation();
          closeTab(tab.id);
        } else {
          activateTab(tab.id);
        }
      });
      bar.appendChild(el);
    }
  }

  function renderTabContent() {
    const container = $('#tab-content');
    // 隐藏所有已缓存的 pane
    state.tabPanes.forEach(pane => { pane.style.display = 'none'; });

    if (!state.activeTabId) {
      // 显示欢迎页
      let welcome = container.querySelector('.welcome');
      if (!welcome) {
        welcome = document.createElement('div');
        welcome.className = 'welcome';
        welcome.innerHTML = `
          <div class="welcome-logo">⬣</div>
          <h1 id="welcome-title">${I18N.t('welcome.title')}</h1>
          <p id="welcome-subtitle">${I18N.t('welcome.subtitle')}</p>
          <p class="hint" id="welcome-hint">${I18N.t('welcome.hint')}</p>`;
        container.appendChild(welcome);
      }
      welcome.style.display = '';
      return;
    }
    // 隐藏欢迎页
    const welcome = container.querySelector('.welcome');
    if (welcome) welcome.style.display = 'none';

    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;

    // 检查是否已有缓存的 pane
    let pane = state.tabPanes.get(tab.id);
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'tab-pane';
      container.appendChild(pane);
      state.tabPanes.set(tab.id, pane);

      if (tab.type === 'vm') {
        Console.renderVMView(pane, tab.vm);
      } else if (tab.type === 'mod') {
        if (window.ModView) ModView.render(pane, tab.mod);
      } else if (tab.type === 'disk-editor') {
        DiskEditor.render(pane, tab.diskPath, tab.vm);
      }
    }
    pane.style.display = '';
  }

  // ---------- WebSocket ----------
  function wsConnect() {
    if (state.ws && state.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    setConnStatus('connecting', '');
    try {
      state.ws = new WebSocket(url);
    } catch (e) {
      setConnStatus('error', 'err');
      scheduleReconnect();
      return;
    }
    state.ws.onopen = () => {
      setConnStatus('connected', 'ok');
      // 重新订阅
      if (state.wsSubscribedVm) {
        wsSend({ type: 'c2s.subscribe', vm: state.wsSubscribedVm });
      }
      if (state.wsSubscribedMod) {
        wsSend({ type: 'c2s.mod.subscribe', mod: state.wsSubscribedMod });
      }
    };
    state.ws.onclose = () => {
      setConnStatus('disconnected', 'err');
      // 与服务器断开 (服务端关机 / 重启 / 网络中断): 正在运行的 VM 画面转为灰色
      try { if (window.Console && Console.onConnectionLost) Console.onConnectionLost(); } catch (e) {}
      scheduleReconnect();
    };
    state.ws.onerror = () => {
      setConnStatus('error', 'err');
    };
    state.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        onServerMessage(msg);
      } catch (e) {
        // 非 JSON, 忽略
      }
    };
  }

  function scheduleReconnect() {
    if (state.wsReconnectTimer) return;
    state.wsReconnectTimer = setTimeout(() => {
      state.wsReconnectTimer = null;
      wsConnect();
    }, 2000);
  }

  // 返回 true = 已送出; false = 连接不可用 (调用方应据此提示用户, 而不是静默丢弃)
  function wsSend(msg) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function wsSubscribe(vmName, modName) {
    if (state.wsSubscribedVm && state.wsSubscribedVm !== vmName) {
      wsSend({ type: 'c2s.unsubscribe' });
    }
    if (state.wsSubscribedMod && state.wsSubscribedMod !== modName) {
      wsSend({ type: 'c2s.mod.unsubscribe' });
    }
    state.wsSubscribedVm = vmName || null;
    state.wsSubscribedMod = modName || null;
    if (vmName) {
      wsSend({ type: 'c2s.subscribe', vm: vmName });
    }
    if (modName) {
      wsSend({ type: 'c2s.mod.subscribe', mod: modName });
    }
  }

  // ---------- 处理服务器消息 ----------
  function onServerMessage(msg) {
    // 消息类型 s2c.* 由 Console / DiskEditor / ModView 等处理
    if (!msg.type) return;

    // 路由到对应 VM 的 console 控制器
    if (msg.vm) {
      Console.onServerMessage(msg);
    }
    // 路由到对应 Mod 的视图
    if (msg.mod && window.ModView) {
      ModView.onServerMessage(msg);
    }

    if (msg.type === 's2c.state') {
      // VM 状态变化, 刷新侧边栏对应项
      const vm = state.vms.find(v => v.name === msg.vm);
      if (vm) {
        vm.state = msg.state;
        renderVMList();
      }
    } else if (msg.type === 's2c.mod.state') {
      updateModListItem(msg.mod, {
        state: msg.runtimeState,
        address: msg.address,
        type: msg.deviceType || undefined,
      });
    } else if (msg.type === 's2c.screen') {
      // 屏幕更新, Console.onServerMessage 已处理
    } else if (msg.type === 's2c.log') {
      // 日志, Console 已处理
    }
  }

  // ---------- 上下文菜单 ----------
  function showVMContextMenu(vmName, x, y) {
    // 简易菜单: 启动/停止/编辑/导出/导入/删除
    const items = [
      { label: I18N.t('ctx.open'), action: () => openVMTab(vmName) },
      { label: I18N.t('ctx.start'), action: () => api(`vms/${encodeURIComponent(vmName)}/start`, { method: 'POST' }).then(refreshVMs) },
      { label: I18N.t('ctx.stop'), action: () => api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' }).then(refreshVMs) },
      { label: I18N.t('ctx.edit-disk'), action: () => {
        // 找到该 VM 的 disk1
        api(`vms/${encodeURIComponent(vmName)}`).then(cfg => {
          const hw = cfg && cfg.hardware || {};
          const diskFile = hw.disk1;
          if (diskFile) {
            openTab({
              id: 'disk-' + vmName + '-disk1',
              type: 'disk-editor',
              title: `${vmName} / ${I18N.t('hw.disk1')}`,
              vm: vmName,
              diskPath: `vms/${vmName}/${diskFile}`,
            });
          }
        });
      } },
      { label: I18N.t('ctx.export-vm'), action: () => ExportWizard.open(vmName) },
      { label: I18N.t('ctx.import-vm'), action: () => ExportWizard.openImport() },
      { label: I18N.t('ctx.delete'), action: async () => {
        if (confirm(I18N.t('ctx.confirm-delete-vm').replace('{name}', vmName))) {
          await api(`vms/${encodeURIComponent(vmName)}`, { method: 'DELETE' });
          // 关闭相关 tab
          const related = state.tabs.filter(t => t.vm === vmName);
          for (const t of related) closeTab(t.id);
          refreshVMs();
        }
      } },
    ];
    // 简易实现: 用 confirm/prompt 替代
    const choice = items.map((it, i) => `${i}: ${it.label}`).join('\n');
    const idx = prompt(`${I18N.t('ctx.menu-title')}\n${choice}`, '0');
    if (idx !== null) {
      const i = parseInt(idx, 10);
      if (items[i]) items[i].action();
    }
  }

  // ---------- 菜单事件 ----------
  function bindMenu() {
    $$('.menu-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'new-vm') Wizard.open(refreshVMs);
        else if (action === 'new-mod') openNewModDialog();
        else if (action === 'refresh') { refreshVMs(true); refreshMods(true); }
        else if (action === 'check-update') checkUpdate();
        else if (action === 'lua-recheck') checkLua();
        else if (action === 'import-vm') ExportWizard.openImport();
        else if (action === 'settings') openSettings();
        else if (action === 'restart-server') restartServer();
        else if (action === 'stop-server') stopServer();
        else if (action === 'toggle-nav') toggleNav();
      });
    });

    // 侧边栏: 虚拟机 / Mods 切换
    $$('.side-tab').forEach(btn => {
      btn.addEventListener('click', () => setSidebarMode(btn.dataset.side));
    });

    // 手机端抽屉遮罩: 点击关闭抽屉
    $$('.nav-scrim').forEach(el => {
      el.addEventListener('click', () => toggleNav(false));
    });
    // 手机上选中某个 VM / Mod 后自动收起抽屉
    const vmListEl = document.getElementById('vm-list');
    if (vmListEl) vmListEl.addEventListener('click', () => toggleNav(false));
    const modListEl = document.getElementById('mod-list');
    if (modListEl) modListEl.addEventListener('click', () => toggleNav(false));

    // 模态关闭
    $$('.modal-close, .modal-backdrop').forEach(el => {
      el.addEventListener('click', () => Modal.close());
    });
  }

  // ---------- 启动 ----------
  function init() {
    // 首次使用: 弹出语言选择
    if (I18N.isFirstTime()) {
      showLanguageSelector(true);
    } else {
      applyLanguage();
    }
    bindMenu();
    checkLua();
    loadLogLevel();
    refreshVMs();
    refreshMods();
    wsConnect();
    // 周期刷新 VM / Mods 状态 (轻量兜底轮询; 手动刷新走 refreshXC(true))
    setInterval(() => { refreshVMs(false); refreshMods(false); }, 5000);
  }

  // ---------- 语言 ----------
  function showLanguageSelector(isFirstTime = false) {
    Modal.open({
      title: I18N.t('lang.select.title'),
      size: 'small',
      bodyHTML: `
        <div style="text-align:center;padding:12px 0;">
          <div style="color:var(--fg-muted);margin-bottom:16px;font-size:13px;">
            ${I18N.t('lang.select.hint')}
          </div>
          <div style="display:flex;gap:16px;justify-content:center;">
            <button class="btn" id="lang-zh" style="min-width:120px;padding:12px;font-size:14px;">
              简体中文
            </button>
            <button class="btn" id="lang-en" style="min-width:120px;padding:12px;font-size:14px;">
              English
            </button>
          </div>
        </div>
      `,
      footerHTML: '',
      onMount(body) {
        body.querySelector('#lang-zh').addEventListener('click', () => {
          I18N.setLang('zh');
          Modal.close();
          location.reload();
        });
        body.querySelector('#lang-en').addEventListener('click', () => {
          I18N.setLang('en');
          Modal.close();
          location.reload();
        });
      },
    });
  }

  function applyLanguage() {
    const t = I18N.t;
    document.title = t('app.page-title');
    document.documentElement.lang = I18N.getLang() === 'en' ? 'en' : 'zh-CN';
    const luaBadge = $('#lua-badge');
    if (luaBadge) luaBadge.title = t('lua.badge-title');
    // 连接状态与无障碍标签
    setConnStatus(state.connText, state.connKind);
    const navToggle = $('.nav-toggle');
    if (navToggle) navToggle.setAttribute('aria-label', t('sidebar.vm-library'));
    const modalClose = $('.modal-close');
    if (modalClose) modalClose.setAttribute('aria-label', t('tab.close'));
    // 顶部菜单
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    set('menu-new-vm', 'menu.new-vm');
    set('menu-new-mod', 'menu.new-mod');
    set('menu-import-vm', 'menu.import-vm');
    set('menu-refresh', 'menu.refresh');
    set('menu-check-update', 'menu.check-update');
    set('menu-lua-recheck', 'menu.lua-recheck');
    set('menu-settings', 'menu.settings');
    set('menu-restart-server', 'menu.restart-server');
    set('menu-stop-server', 'menu.stop-server');
    // 侧边栏
    set('side-tab-vm', 'sidebar.vm-tab');
    set('side-tab-mod', 'sidebar.mod-tab');
    updateSidebarCount();
    // 欢迎页
    set('welcome-title', 'welcome.title');
    set('welcome-subtitle', 'welcome.subtitle');
    set('welcome-hint', 'welcome.hint');
    // 标签页关闭按钮提示
    renderTabs();
    // 刷新列表文字
    renderVMList();
    renderModList();
  }

  return {
    state, $, $$, api,
    init, refreshVMs, refreshMods, openVMTab, openModTab, openTab, closeTab, activateTab,
    setSidebarMode,
    wsSend, wsSubscribe, setStatus, setStatusRight,
    onServerMessage, showLanguageSelector, applyLanguage,
  };
})();

// ---------- 模态对话框 ----------
const Modal = (() => {
  function open({ title, bodyHTML, footerHTML, onMount, onClose, size }) {
    const container = document.getElementById('modal-container');
    document.getElementById('modal-title').textContent = title || '';
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');
    body.innerHTML = bodyHTML || '';
    footer.innerHTML = footerHTML || '';
    if (size === 'large') {
      const dlg = container.querySelector('.modal-dialog');
      dlg.style.minWidth = 'min(720px, calc(100vw - 24px))';
      dlg.style.maxWidth = 'min(900px, calc(100vw - 24px))';
    } else {
      container.querySelector('.modal-dialog').style.minWidth = '480px';
      container.querySelector('.modal-dialog').style.maxWidth = '800px';
    }
    container.classList.remove('hidden');
    container.setAttribute('aria-hidden', 'false');
    if (onMount) onMount(body, footer);
    container._onClose = onClose;
  }
  function close() {
    const container = document.getElementById('modal-container');
    container.classList.add('hidden');
    container.setAttribute('aria-hidden', 'true');
    if (container._onClose) container._onClose();
    container._onClose = null;
  }
  return { open, close };
})();

window.App = App;
window.Modal = Modal;

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
