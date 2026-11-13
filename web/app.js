// ============================================================
// app.js - main app: VM list / WebSocket / tab management
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
    logLevel: 'error',   // full | error | off, kept in sync with the server setting
    sidebarMode: 'vm',  // 'vm' | 'mod'
    connText: 'disconnected', // last connection-state key, re-rendered after a language switch
    connKind: 'err',
    _modsSig: '',       // Mods list signature, so polling does not rebuild the DOM needlessly
    tabPanes: new Map(), // tabId -> HTMLElement (cached panes avoid rebuilding on switch)
  };

  // ---------- Utilities ----------
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

  // ---------- HTTP requests ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch { return txt; }
  }

  // Streaming request: the server pushes NDJSON lines { stage, percent, line } ... { done, result }
  async function apiStream(path, onEvent, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Very old browsers lack ReadableStream; fall back to reading the whole body
    if (!res.body || typeof res.body.getReader !== 'function') {
      const txt = await res.text();
      let final = null;
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        let evt = null;
        try { evt = JSON.parse(line); } catch (e) { continue; }
        if (evt && evt.done && evt.result) final = evt.result;
        if (evt && onEvent) onEvent(evt);
      }
      return final;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let final = null;
    const handleLine = (line) => {
      if (!line) return;
      let evt = null;
      try { evt = JSON.parse(line); } catch (e) { return; }
      if (evt && evt.done && evt.result) final = evt.result;
      if (onEvent) onEvent(evt);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    }
    handleLine(buf.trim());
    return final;
  }

  // ---------- App version (header badge) ----------
  // The server formats it per channel: v2.1(R) for Release, v2.1.2(B) for Beta
  let versionText = '';

  function welcomeSubtitle() {
    const base = I18N.t('welcome.subtitle');
    return versionText ? base + ' ' + versionText : base;
  }

  function loadAppVersion() {
    const el = document.getElementById('app-version');
    api('version').then((v) => {
      versionText = (v && (v.display || (v.version ? 'v' + v.version : ''))) || '';
      if (el && versionText) el.textContent = versionText;
      // The welcome page shows the same string; refresh it when it is on screen
      const sub = document.getElementById('welcome-subtitle');
      if (sub) sub.textContent = welcomeSubtitle();
    }).catch(() => { /* unreachable server: leave the badge empty */ });
  }

  // ---------- Lua detection ----------
  async function checkLua() {
    const badge = $('#lua-badge');
    badge.textContent = I18N.t('lua.checking');
    badge.className = 'brand-sub';
    try {
      const r = await api('lua/check', { method: 'POST' });
      if (r && r.ok) {
        // r.version looks like "Lua 5.3"; only add the prefix when it is missing
        const ver = String(r.version || '');
        badge.textContent = (/^lua/i.test(ver) ? ver : 'Lua ' + ver) + (r.cached ? I18N.t('lua.cached') : '');
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

  // ---------- Log level ----------
  // Frontend and VM logs share one setting: full / error / off
  async function loadLogLevel() {
    try {
      const s = await api('settings');
      if (s && s.logLevel) state.logLevel = s.logLevel;
    } catch {
      /* keep the default "error" when reading fails */
    }
  }

  // ---------- Settings dialog ----------
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
          <div class="form-row" id="settings-lua-browse" style="display:none;">
            <label></label>
            <div class="path-browser">
              <div class="path-browser-bar">
                <button class="btn" type="button" id="settings-lua-browse-up">${I18N.t('settings.browse.up')}</button>
                <span class="path-browser-path" id="settings-lua-browse-path"></span>
              </div>
              <div class="path-browser-hint">${I18N.t('settings.browse.hint')}</div>
              <div class="path-browser-list" id="settings-lua-list"></div>
            </div>
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
            <label for="settings-showfps">${I18N.t('settings.show-fps')}</label>
            <label class="checkbox-line">
              <input type="checkbox" id="settings-showfps" ${(window.Console && Console.isShowFps && Console.isShowFps()) ? 'checked' : ''}>
              <span id="settings-showfps-state">${(window.Console && Console.isShowFps && Console.isShowFps()) ? I18N.t('settings.show-fps-on') : I18N.t('settings.show-fps-off')}</span>
            </label>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.show-fps-hint')}</span>
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
            <label>${I18N.t('settings.update-source')}</label>
            <select id="settings-update-source" style="flex:1;padding:6px 8px;background:var(--bg-input);color:var(--fg-primary);border:1px solid var(--border);border-radius:3px;">
              <option value="auto" ${cur.updateSource !== 'gitee' && cur.updateSource !== 'github' ? 'selected' : ''}>${I18N.t('settings.update-source-auto')}</option>
              <option value="gitee" ${cur.updateSource === 'gitee' ? 'selected' : ''}>Gitee</option>
              <option value="github" ${cur.updateSource === 'github' ? 'selected' : ''}>GitHub</option>
            </select>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.update-source-hint')}</span>
          </div>
          <div class="form-row">
            <label>${I18N.t('settings.update-channel')}</label>
            <select id="settings-update-channel" style="flex:1;padding:6px 8px;background:var(--bg-input);color:var(--fg-primary);border:1px solid var(--border);border-radius:3px;">
              <option value="release" ${cur.updateChannel !== 'beta' ? 'selected' : ''}>${I18N.t('settings.update-channel-release')}</option>
              <option value="beta" ${cur.updateChannel === 'beta' ? 'selected' : ''}>${I18N.t('settings.update-channel-beta')}</option>
            </select>
          </div>
          <div class="form-row">
            <label></label>
            <span class="hint">${I18N.t('settings.update-channel-hint')}</span>
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
          // Console-window toggle: applies immediately (hides / shows the server console window)
          const showConsoleBox = body.querySelector('#settings-showconsole');
          const consoleStateEl = body.querySelector('#settings-console-state');
          if (showConsoleBox) {
            showConsoleBox.addEventListener('change', async () => {
              const want = showConsoleBox.checked;
              try {
                const r = await api('settings', { method: 'PUT', body: { showConsole: want } });
                const res = r && r.consoleResult;
                // Map platform-specific failures to a precise message; anything else falls back to the generic one
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
          // Wheel compatibility mode (frontend-only switch, applies immediately, not persisted)
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
          // Show FPS (frontend-only switch, applies immediately)
          const fpsBox = body.querySelector('#settings-showfps');
          const fpsState = body.querySelector('#settings-showfps-state');
          if (fpsBox) {
            fpsBox.addEventListener('change', () => {
              const on = fpsBox.checked;
              if (window.Console && Console.setShowFps) Console.setShowFps(on);
              if (fpsState) {
                fpsState.textContent = on ? I18N.t('settings.show-fps-on') : I18N.t('settings.show-fps-off');
              }
            });
          }
          // Auto-update toggle (stored in settings.json, applied on the next launcher start)
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
          // Update source: which mirror the updater talks to (auto = speed test)
          const updateSourceSel = body.querySelector('#settings-update-source');
          if (updateSourceSel) {
            updateSourceSel.addEventListener('change', async () => {
              try {
                await api('settings', { method: 'PUT', body: { updateSource: updateSourceSel.value } });
                setStatus(I18N.t('settings.saved'));
              } catch (e) {
                setStatus(I18N.t('settings.save-failed'), 'err');
              }
            });
          }
          // Update channel: Release follows main, Beta follows the beta branch
          const updateChannelSel = body.querySelector('#settings-update-channel');
          if (updateChannelSel) {
            updateChannelSel.addEventListener('change', async () => {
              try {
                await api('settings', { method: 'PUT', body: { updateChannel: updateChannelSel.value } });
                setStatus(I18N.t('settings.saved'));
              } catch (e) {
                setStatus(I18N.t('settings.save-failed'), 'err');
              }
            });
          }
          // Skip integrity check (stored in settings.json, applied on the next launcher start)
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
          // Version rollback
          const rollbackBtn = body.querySelector('#settings-rollback');
          if (rollbackBtn) rollbackBtn.addEventListener('click', () => openRollbackDialog());
          // Browse: expand the server directory list; folders navigate, files fill in the full path
          const browseBtn = body.querySelector('#settings-browse');
          const browsePanel = body.querySelector('#settings-lua-browse');
          const browseList = body.querySelector('#settings-lua-list');
          const browsePathText = body.querySelector('#settings-lua-browse-path');
          const browseUpBtn = body.querySelector('#settings-lua-browse-up');
          let browseParent = null;

          const loadDir = async (target) => {
            browseList.innerHTML = `<div class="path-browser-empty">${I18N.t('settings.browse.loading')}</div>`;
            let r = null;
            try {
              r = await api('fs/list?path=' + encodeURIComponent(target || ''));
            } catch { /* a failed request is treated as a read error */ }
            if (!r || !r.ok) {
              browseParent = (r && r.parent) || null;
              browsePathText.textContent = (r && r.path) || target || '';
              browseUpBtn.disabled = !browseParent;
              browseList.innerHTML = `<div class="path-browser-empty">${I18N.t('settings.browse.error')}</div>`;
              return;
            }
            browseParent = r.parent;
            browsePathText.textContent = r.path || '';
            browseUpBtn.disabled = !browseParent;
            if (!r.entries.length) {
              browseList.innerHTML = `<div class="path-browser-empty">${I18N.t('settings.browse.empty')}</div>`;
              return;
            }
            browseList.innerHTML = '';
            for (const entry of r.entries) {
              const row = document.createElement('button');
              row.type = 'button';
              row.className = 'path-browser-row' + (entry.isDir ? ' is-dir' : entry.isExec ? ' is-exec' : '');
              const icon = document.createElement('span');
              icon.className = 'path-browser-icon';
              icon.textContent = entry.isDir ? '📁' : entry.isExec ? '⚙' : '📄';
              const name = document.createElement('span');
              name.className = 'path-browser-name';
              name.textContent = entry.name;
              row.appendChild(icon);
              row.appendChild(name);
              row.addEventListener('click', () => {
                if (entry.isDir) { loadDir(entry.path); return; }
                input.value = entry.path;
                browsePanel.style.display = 'none';
                input.focus();
              });
              browseList.appendChild(row);
            }
          };

          browseBtn.addEventListener('click', () => {
            const visible = browsePanel.style.display !== 'none';
            browsePanel.style.display = visible ? 'none' : '';
            if (!visible) loadDir(input.value.trim());
          });
          browseUpBtn.addEventListener('click', () => {
            if (browseParent) loadDir(browseParent);
          });
          document.querySelector('#settings-save').addEventListener('click', async () => {
            const newPath = input.value.trim();
            if (!newPath) { alert(I18N.t('settings.lua-empty')); return; }
            const newLang = langSelect.value;
            const langChanged = newLang !== I18N.getLang();
            const newLogLevel = logLevelSelect.value;
            try {
              const r = await api('settings', { method: 'PUT', body: { luaExe: newPath, logLevel: newLogLevel } });
              if (r && r.ok) {
                state.logLevel = newLogLevel;
                if (langChanged) {
                  // A language change reloads the page so every rendered view, badge and dialog is retranslated
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

  // ---------- Mobile sidebar drawer ----------
  // The toggle only renders on narrow screens; calling it on desktop is harmless (no styles match the class).
  function toggleNav(force) {
    const open = (force === undefined)
      ? !document.body.classList.contains('nav-open')
      : !!force;
    document.body.classList.toggle('nav-open', open);
  }

  // ---------- Service-level control ----------
  // Restart: the server stops all VMs, exits with code 5, and run.bat / run.sh immediately starts it again.
  async function restartServer(skipConfirm) {
    if (!skipConfirm && !confirm(I18N.t('confirm.restart-server'))) return;
    try {
      await api('server/restart', { method: 'POST' });
    } catch (e) {
      // The server may already be exiting, so an aborted request is expected
    }
    setStatus(I18N.t('server.restarting'));
  }

  // Stop: the server stops all VMs and exits with code 4, which the watchdog does not restart.
  async function stopServer() {
    if (!confirm(I18N.t('confirm.stop-server'))) return;
    try {
      await api('server/stop', { method: 'POST' });
    } catch (e) {
      // same as above
    }
    setStatus(I18N.t('server.stopped'));
  }

  // ---------- Update check / rollback ----------
  // Results always appear in a dialog (changelog included); restarting afterwards is the user's call,
  // never automatic, so running VMs are not interrupted against their will.
  let updateBusy = false;

  function trLang(zh, en) { return I18N.getLang() === 'zh' ? zh : en; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Busy dialog: shows that the action started while disabled buttons prevent double clicks
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

  // Restart warning: mention running VMs that would be interrupted
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

  // Update result dialog (mode: available / uptodate / error / info)
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
        ${d.source ? `<div style="margin-bottom:10px;color:var(--fg-muted);font-size:12px;">${escapeHtml(trLang('更新源', 'Source'))}: ${escapeHtml(String(d.source))}</div>` : ''}
        <div style="margin:10px 0 4px;color:var(--fg-muted);font-size:12px;">${escapeHtml(trLang('本次更新内容', 'Changes in this update'))}</div>
        <ul style="margin:0;padding-left:18px;max-height:280px;overflow:auto;font-size:12px;">${commitListHtml(d.log)}</ul>`;
      footer = `<button class="btn" data-action="modal-close">${escapeHtml(trLang('取消', 'Cancel'))}</button>`
             + `<button class="btn btn-primary" id="update-apply">${escapeHtml(trLang('立即更新', 'Update now'))}</button>`;
    } else if (mode === 'uptodate') {
      const d = o.data || {};
      title = trLang('已是最新版本', 'Already up to date');
      body = `
        <div style="margin-bottom:10px;">${escapeHtml(trLang(`当前版本：${d.current}`, `current version: ${d.current}`))}</div>
        ${d.source ? `<div style="margin-bottom:10px;color:var(--fg-muted);font-size:12px;">${escapeHtml(trLang('更新源', 'Source'))}: ${escapeHtml(String(d.source))}</div>` : ''}
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

  // Check for updates (result shown in a dialog)
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

  // Progress dialog: real percentage, current stage, and git's raw progress line
  function openUpdateProgressModal() {
    Modal.open({
      title: I18N.t('update.progress-title'),
      size: 'small',
      bodyHTML: `
        <div class="update-progress">
          <div class="update-progress-head">
            <span class="update-progress-stage" data-role="stage">${escapeHtml(I18N.t('update.stage.prepare'))}</span>
            <span class="update-progress-pct" data-role="pct">0%</span>
          </div>
          <div class="update-progress-bar"><div class="update-progress-fill" data-role="fill"></div></div>
          <div class="update-progress-detail" data-role="detail"></div>
        </div>`,
      footerHTML: '',
    });
    const body = document.getElementById('modal-body');
    const rootEl = body.querySelector('.update-progress');
    const stageEl = body.querySelector('[data-role="stage"]');
    const pctEl = body.querySelector('[data-role="pct"]');
    const fillEl = body.querySelector('[data-role="fill"]');
    const detailEl = body.querySelector('[data-role="detail"]');
    return {
      update(evt) {
        if (!evt || evt.done) return;
        if (evt.stage && stageEl) {
          const label = I18N.t('update.stage.' + evt.stage);
          stageEl.textContent = label === 'update.stage.' + evt.stage ? evt.stage : label;
        }
        if (typeof evt.percent === 'number') {
          const pct = Math.max(0, Math.min(100, Math.round(evt.percent)));
          if (fillEl) fillEl.style.width = pct + '%';
          if (pctEl) pctEl.textContent = pct + '%';
        }
        if (detailEl && typeof evt.line === 'string') detailEl.textContent = evt.line;
      },
      // If the stream ends without a progress event, force the bar to 100%
      complete(text) {
        if (rootEl) rootEl.classList.add('done');
        if (fillEl) fillEl.style.width = '100%';
        if (pctEl) pctEl.textContent = '100%';
        if (stageEl) stageEl.textContent = I18N.t('update.stage.done');
        if (detailEl && text) detailEl.textContent = text;
      },
      setDetail(text) { if (detailEl) detailEl.textContent = text || ''; },
    };
  }

  // The backend is briefly unreachable during a restart; reload once it is back.
  async function waitForServerAndReload(maxMs = 90000) {
    setStatus(I18N.t('update.restart-wait'));
    const start = Date.now();
    // Wait first so the old process really exits and requests do not hit the closing instance
    await new Promise((r) => setTimeout(r, 2500));
    while (Date.now() - start < maxMs) {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (r && r.ok) { location.reload(); return; }
      } catch (e) { /* server not up yet */ }
      await new Promise((r) => setTimeout(r, 1200));
    }
    // On timeout reload anyway so the user at least sees the newest page
    location.reload();
  }

  // Run the update with live progress; reload the page when done
  async function applyUpdateFlow() {
    if (updateBusy) return;
    updateBusy = true;
    setStatus(I18N.t('update.applying'));
    const ui = openUpdateProgressModal();

    let result = null, err = null;
    try {
      result = await apiStream('update/apply', (evt) => ui.update(evt), { method: 'POST' });
    } catch (e) {
      err = e;
    }
    updateBusy = false;

    if (err) {
      Modal.close();
      setStatus(I18N.t('update.failed'));
      showUpdateModal('error', { message: trLang('更新失败: ', 'Update failed: ') + err.message });
      return;
    }
    if (!result || !result.ok) {
      Modal.close();
      setStatus(I18N.t('update.failed'));
      showUpdateModal('error', { message: trLang('更新失败: ', 'Update failed: ') + String((result && (result.output || result.error)) || '') });
      return;
    }

    ui.complete(result.after ? `${result.before} → ${result.after}` : '');

    if (!result.changed) {
      Modal.close();
      setStatus(I18N.t('update.up-to-date'));
      showUpdateModal('info', { message: trLang('已是最新版本，无需重启。', 'Already up to date; no restart needed.') });
      return;
    }

    setStatus(I18N.t('update.done'));
    ui.setDetail(I18N.t('update.reload-hint'));

    const ask = trLang(
      `更新完成（${result.before} → ${result.after}${result.source ? `，来源 ${result.source}` : ''}）。\n\n是否立即重启后端使更新生效？\n（无论是否重启，界面都会自动刷新）`,
      `Update complete (${result.before} -> ${result.after}${result.source ? ` via ${result.source}` : ''}).\n\nRestart the backend now to apply the update?\n(The page will reload either way.)`
    ) + restartWarn();
    const wantRestart = confirm(ask);
    Modal.close();

    if (wantRestart) {
      await restartServer(true);
      await waitForServerAndReload();
    } else {
      // The new frontend files are already on disk, so a reload picks them up
      setTimeout(() => location.reload(), 600);
    }
  }

  // Settings "rollback": list historical versions to pick from
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

  // ---------- VM list ----------
  // manual = true means the user pressed Refresh: besides fetching the list, force a resync of
  // the open tab's VM state and screen (manual correction after a WebSocket drop or lost message).
  async function refreshVMs(manual) {
    try {
      const vms = await api('vms');
      state.vms = vms || [];
      renderVMList();
      // Push server state into each VM view: button availability and the "stopped" screen look.
      // This is the 5-second safety poll, so when a WebSocket state message is lost
      // the controls still self-correct without reloading the whole page.
      if (window.Console && Console.applyServerState) {
        for (const vm of state.vms) {
          Console.applyServerState(vm.name, vm.state, vm.exitCode, vm.cleanStop);
        }
      }
      // Manual refresh: re-subscribe over WebSocket and re-fetch the active VM state and screen
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

    // Rebuilding the list loses the selection highlight, so re-apply it from the active tab,
    // otherwise the 5-second auto refresh would clear the highlight of the VM being viewed.
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
        <button class="vm-more" type="button" title="${escapeAttr(I18N.t('ctx.more'))}" aria-label="${escapeAttr(I18N.t('ctx.more'))}">⋮</button>
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
        if (Array.isArray(vm.config.memory)) {
          const mbArr = Array.isArray(vm.config.memoryMB) ? vm.config.memoryMB : null;
          const sticks = [0, 1].map((i) =>
            (mbArr && mbArr[i] != null ? mbArr[i] + 'MB' : 'T' + vm.config.memory[i]));
          metaParts.push(I18N.t('vm.meta.ram') + ' ' + sticks.join('/'));
        }
      }
      const stateKey = 'vm.state.' + (vm.state || 'unknown');
      metaParts.push(I18N.t(stateKey));
      li.querySelector('.vm-meta').textContent = metaParts.join(' · ');
      li.addEventListener('click', () => openVMTab(vm.name));
      // Touch long-press no longer opens a menu; use the ⋮ button on the right instead
      let lastTouchAt = 0;
      li.addEventListener('touchstart', () => { lastTouchAt = Date.now(); }, { passive: true });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (Date.now() - lastTouchAt < 900) return;
        showVMContextMenu(vm.name, e.clientX, e.clientY);
      });
      const moreBtn = li.querySelector('.vm-more');
      if (moreBtn) {
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = moreBtn.getBoundingClientRect();
          showVMContextMenu(vm.name, rect.left, rect.bottom + 4);
        });
      }
      ul.appendChild(li);
    }
  }

  // ---------- Mods list ----------
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
      // Rebuild only when data changes or the user refreshes, so the 5-second poll does not swallow clicks
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
      { label: I18N.t('ctx.export-mod'), action: () => exportMod(modName) },
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

  // Export a mod: fetch the zip built by the server and start the browser download
  async function exportMod(modName) {
    try {
      const res = await fetch(`/api/mods/${encodeURIComponent(modName)}/export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${modName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus(I18N.t('mods.export.done').replace('{name}', modName));
    } catch (e) {
      alert(e.message);
    }
  }

  // Import a mod: upload a local zip or download from a URL (direct link / GitHub / Gitee repo)
  function openImportModDialog() {
    Modal.open({
      title: I18N.t('mods.import.title'),
      size: 'small',
      bodyHTML: `
        <div class="form-row"><label>${I18N.t('mods.import.source')}</label>
          <select id="import-mod-source">
            <option value="file">${I18N.t('mods.import.source-file')}</option>
            <option value="url">${I18N.t('mods.import.source-url')}</option>
          </select>
        </div>
        <div class="form-row" id="import-mod-file-row">
          <label>${I18N.t('mods.import.file')}</label>
          <input type="file" id="import-mod-file" accept=".zip,application/zip">
        </div>
        <div class="form-row hidden" id="import-mod-url-row">
          <label>${I18N.t('mods.import.url')}</label>
          <input type="text" id="import-mod-url" placeholder="https://github.com/owner/repo" style="flex:1;">
        </div>
        <div class="form-row hidden" id="import-mod-url-hint-row">
          <div></div>
          <div class="hint">${I18N.t('mods.import.url-hint')}</div>
        </div>
        <div class="form-row">
          <label>${I18N.t('mods.import.name')}</label>
          <input type="text" id="import-mod-name" placeholder="${I18N.t('mods.import.name-placeholder')}" style="flex:1;">
        </div>
      `,
      footerHTML: `
        <button class="btn" data-action="modal-close">${I18N.t('wizard.cancel')}</button>
        <button class="btn btn-primary" id="import-mod-ok">${I18N.t('mods.import.ok')}</button>
      `,
      onMount(body, footer) {
        const sourceSel = body.querySelector('#import-mod-source');
        const fileRow = body.querySelector('#import-mod-file-row');
        const urlRow = body.querySelector('#import-mod-url-row');
        const urlHintRow = body.querySelector('#import-mod-url-hint-row');
        const fileInput = body.querySelector('#import-mod-file');
        const urlInput = body.querySelector('#import-mod-url');
        const nameInput = body.querySelector('#import-mod-name');
        const okBtn = footer.querySelector('#import-mod-ok');
        const cancel = footer.querySelector('[data-action="modal-close"]');
        if (cancel) cancel.addEventListener('click', () => Modal.close());

        sourceSel.addEventListener('change', () => {
          const isFile = sourceSel.value === 'file';
          fileRow.classList.toggle('hidden', !isFile);
          urlRow.classList.toggle('hidden', isFile);
          urlHintRow.classList.toggle('hidden', isFile);
        });

        okBtn.addEventListener('click', async () => {
          const name = nameInput.value.trim();
          if (name && !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
            alert(I18N.t('mods.new.invalid-name'));
            return;
          }
          okBtn.disabled = true;
          try {
            let result;
            if (sourceSel.value === 'file') {
              const file = fileInput.files && fileInput.files[0];
              if (!file) {
                alert(I18N.t('mods.import.no-file'));
                okBtn.disabled = false;
                return;
              }
              if (file.size > 64 * 1024 * 1024) {
                alert(I18N.t('mods.import.too-large'));
                okBtn.disabled = false;
                return;
              }
              const buf = await file.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              }
              result = await api('mods/import', { method: 'POST', body: { name, data: btoa(bin) } });
            } else {
              const url = urlInput.value.trim();
              if (!url) {
                alert(I18N.t('mods.import.no-url'));
                okBtn.disabled = false;
                return;
              }
              setStatus(I18N.t('mods.import.downloading'));
              result = await api('mods/download', { method: 'POST', body: { name, url } });
            }
            Modal.close();
            await refreshMods(true);
            setSidebarMode('mod');
            if (result && result.name) openModTab(result.name);
          } catch (e) {
            alert(e.message);
            okBtn.disabled = false;
          }
        });
      },
    });
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
            // The server appends -1, -2, ... when the name is already taken
            const created = await api('mods', { method: 'POST', body: { name, type, description } });
            const finalName = (created && created.name) || name;
            Modal.close();
            await refreshMods();
            setSidebarMode('mod');
            openModTab(finalName);
            if (autostart) {
              await api(`mods/${encodeURIComponent(finalName)}/start`, { method: 'POST' });
              setTimeout(() => refreshMods(true), 500);
            }
          } catch (e) {
            alert(e.message);
          }
        });
      },
    });
  }

  // ---------- Tab management ----------
  function openVMTab(vmName) {
    const id = 'vm-' + vmName;
    let tab = state.tabs.find(t => t.id === id);
    if (!tab) {
      tab = { id, vm: vmName, type: 'vm', title: vmName };
      state.tabs.push(tab);
    }
    activateTab(id);
    $$('.vm-item').forEach(li => {
      li.classList.toggle('active', li.dataset.vmName === vmName);
    });
  }

  function openTab(tab) {
    // Never duplicate a tab with the same id; merge into the existing one
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
    // Drop the cached pane
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
    // Handle the WebSocket subscription switch
    const tab = state.tabs.find(t => t.id === id);
    const targetVm = (tab && tab.type === 'vm') ? tab.vm : null;
    const targetMod = (tab && tab.type === 'mod') ? tab.mod : null;
    if (targetVm !== state.wsSubscribedVm || targetMod !== state.wsSubscribedMod) {
      wsSubscribe(targetVm, targetMod);
    }
    // Fire a resize after switching so canvases get correct sizes (hidden -> visible)
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
    // Hide every cached pane
    state.tabPanes.forEach(pane => { pane.style.display = 'none'; });

    if (!state.activeTabId) {
      let welcome = container.querySelector('.welcome');
      if (!welcome) {
        welcome = document.createElement('div');
        welcome.className = 'welcome';
        welcome.innerHTML = `
          <div class="welcome-logo">⬣</div>
          <h1 id="welcome-title">${I18N.t('welcome.title')}</h1>
          <p id="welcome-subtitle">${welcomeSubtitle()}</p>
          <p class="hint" id="welcome-hint">${I18N.t('welcome.hint')}</p>`;
        container.appendChild(welcome);
      }
      welcome.style.display = '';
      return;
    }
    const welcome = container.querySelector('.welcome');
    if (welcome) welcome.style.display = 'none';

    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;

    // Reuse the cached pane when there is one
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
      // Re-subscribe after reconnecting
      if (state.wsSubscribedVm) {
        wsSend({ type: 'c2s.subscribe', vm: state.wsSubscribedVm });
      }
      if (state.wsSubscribedMod) {
        wsSend({ type: 'c2s.mod.subscribe', mod: state.wsSubscribedMod });
      }
    };
    state.ws.onclose = () => {
      setConnStatus('disconnected', 'err');
      // Lost the server (shutdown / restart / network drop): running VMs turn gray
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
        // Not JSON; ignore
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

  // true = sent, false = connection unavailable (callers must warn the user instead of dropping input)
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

  // ---------- Server message handling ----------
  function onServerMessage(msg) {
    // s2c.* payloads are handled by Console / DiskEditor / ModView
    if (!msg.type) return;

    // Route to the console controller of that VM
    if (msg.vm) {
      Console.onServerMessage(msg);
    }
    // Route to the matching Mod view
    if (msg.mod && window.ModView) {
      ModView.onServerMessage(msg);
    }

    if (msg.type === 's2c.state') {
      // VM state changed; refresh its sidebar entry
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
      // Screen frame, already handled by Console.onServerMessage
    } else if (msg.type === 's2c.log') {
      // Log line, already handled by Console
    }
  }

  // ---------- Context menu ----------
  let vmMenuEl = null;
  let vmMenuClose = null;

  function closeVMContextMenu() {
    if (vmMenuEl && vmMenuEl.parentNode) vmMenuEl.parentNode.removeChild(vmMenuEl);
    vmMenuEl = null;
    if (vmMenuClose) {
      document.removeEventListener('click', vmMenuClose, true);
      document.removeEventListener('keydown', vmMenuClose, true);
      window.removeEventListener('blur', vmMenuClose, true);
      window.removeEventListener('resize', vmMenuClose, true);
      vmMenuClose = null;
    }
  }

  // ---------- Edit disk: ask which disk when the VM has two ----------
  const DISK_CHOICE_PREFIX = 'oc-disk-choice-';

  function getDiskChoice(vmName) {
    try {
      const v = localStorage.getItem(DISK_CHOICE_PREFIX + vmName);
      return (v === 'disk1' || v === 'disk2') ? v : null;
    } catch (e) {
      return null;
    }
  }

  function setDiskChoice(vmName, slot) {
    try {
      if (slot) localStorage.setItem(DISK_CHOICE_PREFIX + vmName, slot);
      else localStorage.removeItem(DISK_CHOICE_PREFIX + vmName);
    } catch (e) { /* storage failures must not break this operation */ }
  }

  function openDiskEditorTab(vmName, slot, diskFile) {
    openTab({
      id: 'disk-' + vmName + '-' + slot,
      type: 'disk-editor',
      title: `${vmName} / ${I18N.t('hw.' + slot)}`,
      vm: vmName,
      diskPath: `vms/${vmName}/${diskFile}`,
    });
  }

  function openEditDisk(vmName) {
    api(`vms/${encodeURIComponent(vmName)}`).then(cfg => {
      const hw = (cfg && cfg.hardware) || {};
      const slots = ['disk1', 'disk2'].filter(s => !!hw[s]);
      if (slots.length === 0) {
        alert(I18N.t('ctx.edit-disk.none'));
        return;
      }
      // A remembered disk that still exists opens directly
      const remembered = getDiskChoice(vmName);
      if (remembered && hw[remembered]) {
        openDiskEditorTab(vmName, remembered, hw[remembered]);
        return;
      }
      if (slots.length === 1) {
        openDiskEditorTab(vmName, slots[0], hw[slots[0]]);
        return;
      }
      Modal.open({
        title: I18N.t('ctx.edit-disk.title'),
        size: 'small',
        bodyHTML: `
          <div class="form-row">
            <label></label>
            <div class="disk-pick">
              ${slots.map((s, i) => `
                <label class="disk-pick-item">
                  <input type="radio" name="disk-pick" value="${s}" ${i === 0 ? 'checked' : ''}>
                  <span>${I18N.t('hw.' + s)}</span>
                </label>`).join('')}
            </div>
          </div>
          <div class="form-row">
            <label></label>
            <label class="disk-pick-item">
              <input type="checkbox" id="disk-pick-remember">
              <span>${I18N.t('ctx.edit-disk.remember')}</span>
            </label>
          </div>`,
        footerHTML: `
          <button class="btn" data-action="modal-close">${I18N.t('settings.cancel')}</button>
          <button class="btn btn-primary" id="disk-pick-ok">${I18N.t('ctx.edit-disk.confirm')}</button>`,
        onMount(body, footer) {
          const cancel = footer.querySelector('[data-action="modal-close"]');
          if (cancel) cancel.addEventListener('click', () => Modal.close());
          footer.querySelector('#disk-pick-ok').addEventListener('click', () => {
            const chosen = body.querySelector('input[name="disk-pick"]:checked');
            const slot = chosen ? chosen.value : slots[0];
            if (body.querySelector('#disk-pick-remember').checked) setDiskChoice(vmName, slot);
            Modal.close();
            openDiskEditorTab(vmName, slot, hw[slot]);
          });
        },
      });
    });
  }

  function showVMContextMenu(vmName, x, y) {
    closeVMContextMenu();
    const items = [
      { label: I18N.t('ctx.open'), action: () => openVMTab(vmName) },
      { label: I18N.t('ctx.start'), action: () => api(`vms/${encodeURIComponent(vmName)}/start`, { method: 'POST' }).then(refreshVMs) },
      { label: I18N.t('ctx.stop'), action: () => api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' }).then(refreshVMs) },
      { label: I18N.t('ctx.edit-disk'), action: () => openEditDisk(vmName) },
      ...(getDiskChoice(vmName)
        ? [{ label: I18N.t('ctx.edit-disk.forget'), action: () => setDiskChoice(vmName, null) }]
        : []),
      { separator: true },
      { label: I18N.t('ctx.rename'), action: () => openRenameVM(vmName) },
      { label: I18N.t('ctx.export-vm'), action: () => ExportWizard.open(vmName) },
      { label: I18N.t('ctx.import-vm'), action: () => ExportWizard.openImport() },
      { separator: true },
      { label: I18N.t('ctx.delete'), danger: true, action: async () => {
        if (confirm(I18N.t('ctx.confirm-delete-vm').replace('{name}', vmName))) {
          await api(`vms/${encodeURIComponent(vmName)}`, { method: 'DELETE' });
          const related = state.tabs.filter(t => t.vm === vmName);
          for (const t of related) closeTab(t.id);
          refreshVMs();
        }
      } },
    ];

    const menu = document.createElement('div');
    menu.className = 'disk-context-menu';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'disk-context-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'disk-context-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        closeVMContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    vmMenuEl = menu;

    const openedAt = Date.now();
    vmMenuClose = (ev) => {
      if (ev && ev.type === 'keydown' && ev.key !== 'Escape') return;
      // Care only about window blur: element blur bubbles to window's capture phase and would close the menu on click
      if (ev && ev.type === 'blur' && ev.target !== window) return;
      if (ev && ev.type === 'click') {
        // Let the items handle clicks inside the menu: removing the node during capture makes mobile
        // miss this click, which looks like "the menu opens but its items do nothing"
        if (menu.contains(ev.target)) return;
        // The click that opened the menu (including the synthesized touch click) must not close it immediately
        if (Date.now() - openedAt < 250) return;
      }
      closeVMContextMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', vmMenuClose, true);
      document.addEventListener('keydown', vmMenuClose, true);
      window.addEventListener('blur', vmMenuClose, true);
      window.addEventListener('resize', vmMenuClose, true);
    }, 0);
  }

  // Rename a VM: the folder and display name change together, and open tabs follow
  function openRenameVM(vmName) {
    Modal.open({
      title: I18N.t('ctx.rename.title'),
      size: 'small',
      bodyHTML: `
        <div class="form-row">
          <label>${I18N.t('ctx.rename.label')}</label>
          <input type="text" id="rename-vm-input" value="${escapeAttr(vmName)}" maxlength="32">
        </div>
        <div class="form-row">
          <label></label>
          <span class="hint">${I18N.t('ctx.rename.hint')}</span>
        </div>`,
      footerHTML: `
        <button class="btn" data-action="modal-close">${I18N.t('settings.cancel')}</button>
        <button class="btn btn-primary" id="rename-vm-save">${I18N.t('ctx.rename.confirm')}</button>`,
      onMount(body, footer) {
        const input = body.querySelector('#rename-vm-input');
        const saveBtn = footer.querySelector('#rename-vm-save');
        const submit = async () => {
          const newName = (input.value || '').trim();
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(newName)) {
            alert(I18N.t('ctx.rename.invalid'));
            return;
          }
          if (newName === vmName) { Modal.close(); return; }
          saveBtn.disabled = true;
          let r = null;
          try {
            r = await api(`vms/${encodeURIComponent(vmName)}/rename`, { method: 'POST', body: { name: newName } });
          } catch (e) {
            r = { ok: false, error: e.message };
          }
          saveBtn.disabled = false;
          if (!r || !r.ok) {
            const raw = String((r && r.error) || '');
            const text = /running/i.test(raw) ? I18N.t('ctx.rename.running')
              : /already exists/i.test(raw) ? I18N.t('ctx.rename.exists')
              : raw;
            alert(I18N.t('ctx.rename.failed') + text);
            return;
          }
          const related = state.tabs.filter(t => t.vm === vmName);
          for (const t of related) closeTab(t.id);
          Modal.close();
          await refreshVMs();
          // If a VM tab was open, reopen it under the new name
          if (related.some(t => t.type === 'vm')) openVMTab(newName);
        };
        if (saveBtn) saveBtn.addEventListener('click', submit);
        if (input) {
          input.focus();
          input.select();
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
          });
        }
      },
    });
  }

  // ---------- Menu events ----------
  function bindMenu() {
    // Mobile "⋮" menu: toggles on click and closes on any item or outside click
    function closeMenu() { document.body.classList.remove('menu-open'); }
    const menuToggle = $('.menu-toggle');
    if (menuToggle) {
      menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        document.body.classList.toggle('menu-open');
      });
    }
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('menu-open')) return;
      if (e.target && e.target.closest && e.target.closest('.menu')) return;
      closeMenu();
    });

    // Welcome page "About this tool" button
    const welcomeAbout = document.getElementById('welcome-about');
    if (welcomeAbout) {
      welcomeAbout.addEventListener('click', () => openAbout());
    }

    $$('.menu-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'new-vm') Wizard.open(refreshVMs);
        else if (action === 'new-mod') openNewModDialog();
        else if (action === 'import-mod') openImportModDialog();
        else if (action === 'refresh') { refreshVMs(true); refreshMods(true); }
        else if (action === 'check-update') checkUpdate();
        else if (action === 'lua-recheck') checkLua();
        else if (action === 'import-vm') ExportWizard.openImport();
        else if (action === 'openos') openOpenOSVersions();
        else if (action === 'settings') openSettings();
        else if (action === 'about') openAbout();
        else if (action === 'restart-server') restartServer();
        else if (action === 'stop-server') stopServer();
        else if (action === 'toggle-nav') toggleNav();
        // The "⋮" toggle itself keeps the menu open; every other action closes it
        if (action !== 'toggle-nav' && action !== 'toggle-menu') closeMenu();
      });
    });

    // Sidebar: VMs / Mods switch
    $$('.side-tab').forEach(btn => {
      btn.addEventListener('click', () => setSidebarMode(btn.dataset.side));
    });

    // Mobile drawer scrim: click to close the drawer
    $$('.nav-scrim').forEach(el => {
      el.addEventListener('click', () => toggleNav(false));
    });
    // Picking a VM / Mod on mobile closes the drawer
    const vmListEl = document.getElementById('vm-list');
    if (vmListEl) vmListEl.addEventListener('click', () => toggleNav(false));
    const modListEl = document.getElementById('mod-list');
    if (modListEl) modListEl.addEventListener('click', () => toggleNav(false));

    $$('.modal-close, .modal-backdrop').forEach(el => {
      el.addEventListener('click', () => Modal.close());
    });
    // Modal contents are rebuilt on every Modal.open, so per-button binding is error-prone. Delegate instead,
    // which covers everything with data-action="modal-close".
    const modalContainer = document.getElementById('modal-container');
    if (modalContainer) {
      modalContainer.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-action="modal-close"]') : null;
        if (!btn) return;
        e.preventDefault();
        Modal.close();
      });
      // Usage guide buttons (the footer is rebuilt per step, so delegate once here)
      modalContainer.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-guide]') : null;
        if (!btn) return;
        e.preventDefault();
        handleGuideAction(btn.getAttribute('data-guide'));
      });
    }
  }

  // ---------- Usage guide (shown once, after the language is picked) ----------
  const GUIDE_PENDING_KEY = 'oc-emu-guide-pending';
  const GUIDE_DONE_KEY = 'oc-emu-guide-done';
  let guideIndex = 0;
  let guideSettings = null;      // last known /api/settings response
  let guideFlashTimer = null;

  function guidePending() {
    try { return localStorage.getItem(GUIDE_PENDING_KEY) === '1'; } catch (e) { return false; }
  }

  function guideDone() {
    try { return localStorage.getItem(GUIDE_DONE_KEY) === '1'; } catch (e) { return true; }
  }

  function finishGuide() {
    try {
      localStorage.setItem(GUIDE_DONE_KEY, '1');
      localStorage.removeItem(GUIDE_PENDING_KEY);
    } catch (e) { /* ignore private mode */ }
  }

  function guidePages() {
    const pages = [];
    for (let i = 1; i <= 4; i++) {
      pages.push({ title: I18N.t('guide.' + i + '.title'), body: I18N.t('guide.' + i + '.body') });
    }
    // Last step: the basic settings can be changed right here
    pages.push({ title: I18N.t('guide.5.title'), body: '', settings: true });
    return pages;
  }

  function drawGuide() {
    const pages = guidePages();
    const page = pages[guideIndex];
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');
    if (!page || !body || !footer) return;
    const step = I18N.t('guide.step', { n: guideIndex + 1, total: pages.length });
    if (page.settings) {
      body.innerHTML = guideSettingsHTML(step);
      bindGuideSettings(body);
    } else {
      const items = String(page.body).split('\n').filter(Boolean)
        .map(line => '<li>' + line + '</li>').join('');
      body.innerHTML = `
        <div class="guide-page">
          <div class="guide-step">${step}</div>
          <div class="guide-page-title">${page.title}</div>
          <ul class="guide-list">${items}</ul>
        </div>`;
    }
    const last = guideIndex === pages.length - 1;
    footer.innerHTML = `
      <button class="btn" data-guide="skip">${I18N.t('guide.skip')}</button>
      <div class="guide-spacer"></div>
      <button class="btn" data-guide="prev"${guideIndex === 0 ? ' disabled' : ''}>${I18N.t('guide.prev')}</button>
      <button class="btn btn-primary" data-guide="next">${last ? I18N.t('guide.done') : I18N.t('guide.next')}</button>`;
  }

  // Settings step: change the common options without opening the settings dialog
  function guideSettingsHTML(step) {
    const t = I18N.t;
    const cur = guideSettings || {};
    const logLevel = cur.logLevel || 'error';
    const autoUpdate = cur.autoUpdate !== false;
    const showFps = !!(window.Console && Console.isShowFps && Console.isShowFps());
    const opt = (value, label, selected) =>
      `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
    return `
      <div class="guide-page">
        <div class="guide-step">${step}</div>
        <div class="guide-page-title">${t('guide.5.title')}</div>
        <div class="guide-hint">${t('guide.5.hint')}</div>
        <div class="guide-setting">
          <label for="guide-log-level">${t('settings.log-level')}</label>
          <select id="guide-log-level">
            ${opt('full', t('settings.log-level.full'), logLevel === 'full')}
            ${opt('error', t('settings.log-level.error'), logLevel === 'error')}
            ${opt('off', t('settings.log-level.off'), logLevel === 'off')}
          </select>
        </div>
        <div class="guide-setting">
          <label for="guide-auto-update">${t('settings.auto-update')}</label>
          <label class="checkbox-line"><input type="checkbox" id="guide-auto-update"${autoUpdate ? ' checked' : ''}></label>
        </div>
        <div class="guide-setting">
          <label for="guide-show-fps">${t('settings.show-fps')}</label>
          <label class="checkbox-line"><input type="checkbox" id="guide-show-fps"${showFps ? ' checked' : ''}></label>
        </div>
        <div class="guide-saved" id="guide-saved"></div>
        <div class="guide-where">${t('guide.5.where')}</div>
      </div>`;
  }

  function bindGuideSettings(body) {
    const savedEl = body.querySelector('#guide-saved');
    const flashSaved = () => {
      if (!savedEl) return;
      savedEl.textContent = I18N.t('guide.5.saved');
      if (guideFlashTimer) clearTimeout(guideFlashTimer);
      guideFlashTimer = setTimeout(() => {
        if (savedEl) savedEl.textContent = '';
      }, 1500);
    };
    const save = async (patch) => {
      try {
        await api('settings', { method: 'PUT', body: patch });
        guideSettings = Object.assign({}, guideSettings, patch);
        flashSaved();
      } catch (e) {
        // Leave the control as it is when the server rejects the change
      }
    };
    const logSel = body.querySelector('#guide-log-level');
    if (logSel) logSel.addEventListener('change', () => save({ logLevel: logSel.value }));
    const autoBox = body.querySelector('#guide-auto-update');
    if (autoBox) autoBox.addEventListener('change', () => save({ autoUpdate: autoBox.checked }));
    const fpsBox = body.querySelector('#guide-show-fps');
    if (fpsBox) {
      fpsBox.addEventListener('change', () => {
        // Client-side preference: applies immediately and is stored in localStorage
        if (window.Console && Console.setShowFps) Console.setShowFps(fpsBox.checked);
        flashSaved();
      });
    }
  }

  function openGuide(startIndex) {
    guideIndex = startIndex || 0;
    Modal.open({
      title: I18N.t('guide.title'),
      bodyHTML: '',
      footerHTML: '',
      onMount() { drawGuide(); },
    });
    // Load the server settings so the settings step shows the real values
    api('settings').then(cur => {
      guideSettings = cur || {};
      const pages = guidePages();
      if (pages[guideIndex] && pages[guideIndex].settings) drawGuide();
    }).catch(() => { /* keep the defaults */ });
  }

  function handleGuideAction(action) {
    const pages = guidePages();
    if (action === 'skip') {
      finishGuide();
      Modal.close();
      return;
    }
    if (action === 'prev') {
      if (guideIndex > 0) {
        guideIndex--;
        drawGuide();
      }
      return;
    }
    if (action === 'next') {
      if (guideIndex < pages.length - 1) {
        guideIndex++;
        drawGuide();
      } else {
        finishGuide();
        Modal.close();
      }
    }
  }

  function maybeShowGuide() {
    if (!guidePending() || guideDone()) return;
    // Let the first render finish before the dialog appears
    setTimeout(() => {
      if (guidePending() && !guideDone()) openGuide(0);
    }, 400);
  }

  // ---------- About ----------
  function openAbout() {
    const t = I18N.t;
    const credits = String(t('about.credits.text')).split('\n').filter(Boolean)
      .map(line => '<div>' + line + '</div>').join('');
    const projects = [
      { name: 'OpenComputers', note: t('about.p1'), url: 'https://github.com/MightyPirates/OpenComputers' },
      { name: 'MineOS', note: t('about.p2'), url: 'https://github.com/IgorTimofeev/MineOS' },
      { name: 'Lua 5.3', note: t('about.p3'), url: 'https://www.lua.org/' },
      { name: 'Node.js', note: t('about.p4'), url: 'https://nodejs.org/' },
    ].map(p => `<li><a href="${p.url}" target="_blank" rel="noopener">${p.name}</a>` +
      `<span>${p.note}</span></li>`).join('');
    Modal.open({
      title: t('about.title'),
      bodyHTML: `
        <div class="about-box">
          <div class="about-name">OC Emulator</div>
          <div class="about-desc">${t('about.desc')}</div>
          <div class="about-line"><span>${t('about.version')}</span><b id="about-version">v2.0(R)</b></div>
          <div class="about-line"><span>${t('about.license')}</span><b>AGPL-3.0-or-later</b></div>
          <div class="about-line"><span>${t('about.links')}</span><b>
            <a href="https://github.com/zip132sy/OC-Emulator" target="_blank" rel="noopener">GitHub</a>
            · <a href="https://gitee.com/zip132sy/OC-Emulator" target="_blank" rel="noopener">Gitee</a>
          </b></div>
          <div class="about-section">${t('about.projects')}</div>
          <ul class="about-list">${projects}</ul>
          <div class="about-section">${t('about.contributors')}</div>
          <div class="about-credits">${credits}</div>
        </div>`,
      footerHTML: `<button class="btn" data-action="modal-close">${t('about.close')}</button>`,
    });
    // Replace the fallback version with the one reported by the server
    api('version').then(v => {
      const el = document.getElementById('about-version');
      if (!el || !v) return;
      el.textContent = v.display || (v.version ? 'v' + v.version : el.textContent);
    }).catch(() => { /* keep the fallback */ });
  }

  // ---------- System disks: prebuilt images + OpenOS built from source ----------
  // Prebuilt images come from the separate OC-Emulator-Disks repository; OpenOS
  // releases can also be assembled locally from the upstream loot tree.
  async function openOpenOSVersions() {
    let data = null;
    try {
      data = await api('openos/catalog');
    } catch (e) {
      setStatus(I18N.t('openos.list-failed') + e.message, 'err');
      return;
    }
    const catalog = (data && data.catalog) || { disks: [] };
    const builds = (data && data.build) || [];
    const disks = catalog.disks || [];

    const diskRows = disks.map((d) => `
      <div class="form-row" data-disk="${escapeAttr(d.file)}">
        <label>${escapeHtml(d.label)}</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-small" data-install="${escapeAttr(d.file)}"${d.installed ? ' disabled' : ''}>
            ${d.installed ? I18N.t('openos.cached') : I18N.t('openos.download')}
          </button>
          <span class="hint" data-status>${d.installed ? I18N.t('openos.cached-hint') : ''}</span>
        </div>
      </div>`).join('');

    const buildRows = builds.map((v) => `
      <div class="form-row" data-version="${escapeAttr(v.id)}">
        <label>${escapeHtml(v.label)}</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-small" data-dl="${escapeAttr(v.id)}"${v.cached ? ' disabled' : ''}>
            ${v.cached ? I18N.t('openos.cached') : I18N.t('openos.download')}
          </button>
          <span class="hint" data-status>${v.cached ? I18N.t('openos.cached-hint') : ''}</span>
        </div>
      </div>`).join('');

    const repoNote = catalog.ok
      ? (catalog.stale ? `<p class="hint" style="margin:0 0 8px;">${I18N.t('openos.stale')}</p>` : '')
      : `<p class="hint" style="margin:0 0 8px;">${escapeHtml(I18N.t('openos.repo-unavailable', { error: catalog.error || '' }))}</p>`;

    Modal.open({
      title: I18N.t('openos.title'),
      size: 'small',
      bodyHTML: `
        <p class="hint" style="margin:0 0 12px;line-height:1.6;">${I18N.t('openos.hint')}</p>
        <div class="section-title">${I18N.t('openos.repo-section')}</div>
        ${repoNote}
        ${diskRows || `<p class="hint" style="margin:0 0 8px;">${I18N.t('openos.repo-empty')}</p>`}
        <div class="section-title" style="margin-top:16px;">${I18N.t('openos.build-section')}</div>
        ${buildRows}`,
      footerHTML: `<button class="btn" data-action="modal-close">${I18N.t('settings.cancel')}</button>`,
      onMount(body) {
        body.querySelectorAll('button[data-install]').forEach((btn) => {
          btn.addEventListener('click', () => installDisk(btn));
        });
        body.querySelectorAll('button[data-dl]').forEach((btn) => {
          btn.addEventListener('click', () => downloadOpenOS(btn));
        });
      },
    });
  }

  // Read an NDJSON progress stream and return the final result object
  async function streamEndpoint(url, body, onEvent) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch (e) { continue; }
        if (evt.done) result = evt.result;
        else if (onEvent) onEvent(evt);
      }
    }
    return result;
  }

  // Download a prebuilt image from the disk repository
  async function installDisk(btn) {
    const file = btn.getAttribute('data-install');
    const row = btn.closest('[data-disk]');
    const statusEl = row ? row.querySelector('[data-status]') : null;
    const setRowStatus = (text) => { if (statusEl) statusEl.textContent = text; };
    btn.disabled = true;
    setRowStatus(I18N.t('openos.starting'));
    try {
      const result = await streamEndpoint('/api/openos/install', { file }, (evt) => {
        if (evt.percent != null) setRowStatus(I18N.t('openos.progress', { percent: evt.percent }));
      });
      if (!result || !result.ok) throw new Error((result && result.error) || I18N.t('openos.failed'));
      setRowStatus(I18N.t('openos.done', { path: result.path }));
      btn.textContent = I18N.t('openos.cached');
      setStatus(I18N.t('openos.done', { path: result.path }));
    } catch (e) {
      btn.disabled = false;
      setRowStatus(I18N.t('openos.failed') + ' ' + e.message);
    }
  }

  // Build an OpenOS release from the upstream sources (fallback without the repo)
  async function downloadOpenOS(btn) {
    const id = btn.getAttribute('data-dl');
    const row = btn.closest('[data-version]');
    const statusEl = row ? row.querySelector('[data-status]') : null;
    const setRowStatus = (text) => { if (statusEl) statusEl.textContent = text; };
    btn.disabled = true;
    setRowStatus(I18N.t('openos.starting'));
    try {
      const result = await streamEndpoint('/api/openos/build', { version: id }, (evt) => {
        if (evt.percent != null) setRowStatus(I18N.t('openos.progress', { percent: evt.percent }));
      });
      if (!result || !result.ok) throw new Error((result && result.error) || I18N.t('openos.failed'));
      setRowStatus(I18N.t('openos.done', { path: result.path }));
      btn.textContent = I18N.t('openos.cached');
      setStatus(I18N.t('openos.done', { path: result.path }));
    } catch (e) {
      btn.disabled = false;
      setRowStatus(I18N.t('openos.failed') + ' ' + e.message);
    }
  }

  // ---------- Startup ----------
  function init() {
    // First run: ask for a language
    if (I18N.isFirstTime()) {
      showLanguageSelector(true);
    } else {
      applyLanguage();
      // First visit after the language was picked: show the guide once
      maybeShowGuide();
    }
    bindMenu();
    checkLua();
    loadAppVersion();
    loadLogLevel();
    refreshVMs();
    refreshMods();
    wsConnect();
    // Periodic VM / Mods refresh (light safety polling; manual refresh uses refreshX(true))
    setInterval(() => { refreshVMs(false); refreshMods(false); }, 5000);
  }

  // ---------- Language ----------
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
        const pick = (lang) => {
          I18N.setLang(lang);
          // The reload below starts the app again: mark that the guide has to follow
          try { localStorage.setItem(GUIDE_PENDING_KEY, '1'); } catch (e) { /* ignore private mode */ }
          Modal.close();
          location.reload();
        };
        body.querySelector('#lang-zh').addEventListener('click', () => pick('zh'));
        body.querySelector('#lang-en').addEventListener('click', () => pick('en'));
      },
    });
  }

  function applyLanguage() {
    const t = I18N.t;
    document.title = t('app.page-title');
    document.documentElement.lang = I18N.getLang() === 'en' ? 'en' : 'zh-CN';
    const luaBadge = $('#lua-badge');
    if (luaBadge) luaBadge.title = t('lua.badge-title');
    // Connection status and ARIA labels
    setConnStatus(state.connText, state.connKind);
    const navToggle = $('.nav-toggle');
    if (navToggle) navToggle.setAttribute('aria-label', t('sidebar.vm-library'));
    const menuToggle = $('.menu-toggle');
    if (menuToggle) menuToggle.setAttribute('aria-label', t('menu.toggle'));
    const modalClose = $('.modal-close');
    if (modalClose) modalClose.setAttribute('aria-label', t('tab.close'));
    // Top menu
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    set('menu-new-vm', 'menu.new-vm');
    set('menu-new-mod', 'menu.new-mod');
    set('menu-import-mod', 'menu.import-mod');
    set('menu-import-vm', 'menu.import-vm');
    set('menu-openos', 'menu.openos');
    set('menu-refresh', 'menu.refresh');
    set('menu-check-update', 'menu.check-update');
    set('menu-lua-recheck', 'menu.lua-recheck');
    set('menu-settings', 'menu.settings');
    set('menu-about', 'menu.about');
    set('menu-restart-server', 'menu.restart-server');
    set('menu-stop-server', 'menu.stop-server');
    // Sidebar
    set('side-tab-vm', 'sidebar.vm-tab');
    set('side-tab-mod', 'sidebar.mod-tab');
    updateSidebarCount();
    // Welcome page
    set('welcome-title', 'welcome.title');
    const welcomeSub = $('#welcome-subtitle');
    if (welcomeSub) welcomeSub.textContent = welcomeSubtitle();
    set('welcome-hint', 'welcome.hint');
    set('welcome-about', 'welcome.about');
    // Tab close button tooltip
    renderTabs();
    // Refresh list text
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

// ---------- Modal dialog ----------
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
      // Use min() to follow the viewport: on phones a dialog must not exceed the screen or right-side buttons fall off
      const dlg = container.querySelector('.modal-dialog');
      dlg.style.minWidth = 'min(480px, calc(100vw - 24px))';
      dlg.style.maxWidth = 'min(800px, calc(100vw - 24px))';
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

// Boot the app
document.addEventListener('DOMContentLoaded', () => App.init());
