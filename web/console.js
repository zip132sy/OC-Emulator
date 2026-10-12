// ============================================================
// console.js - VM 控制台 (Canvas 渲染 + 工具栏 + 硬件面板)
//
// 屏幕数据格式 (来自 vmManager 的 s2c.screen):
//   full:  { w, h, cells: [[bg,fg,char],...] }  长度 = w*h
//   dirty: { dirty: [[x,y,bg,fg,char],...] }   增量, x/y 从 1 开始
// ============================================================

const Console = (() => {
  // OC 16 色调色板 (0xRRGGBB)
  const PALETTE = [
    0x000000, 0xff3333, 0x33ff33, 0xffff33,
    0x3333ff, 0xff33ff, 0x33ffff, 0xffffff,
    0x666666, 0xff6666, 0x66ff66, 0xffff66,
    0x6666ff, 0xff66ff, 0x66ffff, 0xd0d0d0,
  ];

  // ---------- Bitmap Font (OC hexfont) ----------
  // OC 使用 GNU Unifont .hex 格式位图字体, 每字符 8x16 或 16x16 像素
  let hexFont = null; // Map<codePoint, {width: 8|16, bytes: Uint8Array}>
  let glyphCache = null; // Map<codePoint, HTMLCanvasElement> 预渲染字形

  async function loadHexFont() {
    try {
      const resp = await fetch('fonts/font.hex');
      const text = await resp.text();
      hexFont = new Map();
      glyphCache = new Map();
      for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const cp = parseInt(line.slice(0, colon), 16);
        const bitmap = line.slice(colon + 1).trim();
        if (!bitmap) continue;
        const rowBytes = bitmap.length / 2 / 16;
        if (rowBytes !== 1 && rowBytes !== 2) continue;
        const width = rowBytes === 1 ? 8 : 16;
        const bytes = new Uint8Array(bitmap.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(bitmap.slice(i * 2, i * 2 + 2), 16);
        }
        hexFont.set(cp, { width, bytes });
      }
      console.log(`[hexFont] Loaded ${hexFont.size} glyphs from font.hex`);
      // 字体加载后重绘所有可见 VM
      for (const [name, view] of views) {
        if (view.cells && view.cells.length && view.ctx) {
          resizeCanvas(name);
          repaintAll(name);
        }
      }
    } catch (e) {
      console.error('[hexFont] Failed to load font.hex:', e);
    }
  }

  // 获取预渲染的字形 canvas (按需创建并缓存)
  function getGlyphCanvas(cp) {
    const cached = glyphCache.get(cp);
    if (cached) return cached;
    const glyph = hexFont.get(cp) || hexFont.get(0x20);
    if (!glyph) return null;
    // 创建离屏 canvas, 白色字形 + 透明背景 (用作 alpha 蒙版)
    const cv = document.createElement('canvas');
    cv.width = glyph.width;
    cv.height = 16;
    const ctx = cv.getContext('2d');
    const imgData = ctx.createImageData(glyph.width, 16);
    const data = imgData.data;
    const gw = glyph.width;
    const bytes = glyph.bytes;
    const rowBytes = gw / 8;
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < gw; col++) {
        const byteIdx = row * rowBytes + Math.floor(col / 8);
        const bit = 7 - (col % 8);
        const isOn = (bytes[byteIdx] >> bit) & 1;
        const idx = (row * gw + col) * 4;
        if (isOn) {
          data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
        } else {
          data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 0;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    glyphCache.set(cp, cv);
    // 限制缓存大小
    if (glyphCache.size > 3000) {
      // 保留最常用的 ASCII 范围, 清空其他
      for (const key of glyphCache.keys()) {
        if (key > 127) glyphCache.delete(key);
      }
    }
    return cv;
  }

  // 宽字符快速判断缓存 (避免每次都查 hexFont)
  const _wideCache = new Map();
  function isWideGlyph(ch) {
    if (!ch || ch.length === 0) return false;
    const cached = _wideCache.get(ch);
    if (cached !== undefined) return cached;
    const cp = ch.codePointAt(0);
    const glyph = hexFont.get(cp);
    const result = !!(glyph && glyph.width === 16);
    _wideCache.set(ch, result);
    if (_wideCache.size > 2000) _wideCache.clear();
    return result;
  }

  // VM 视图缓存: vmName -> { canvas, ctx, offscreen, offCtx, w, h, cells, charW, charH, logLines }
  const views = new Map();

  // 轻量诊断计数 (不写日志, 避免刷屏): 用于快速判断"滚轮/输入到底有没有发出去"。
  // 在浏览器控制台执行 Console.diag 即可查看。
  const diag = { wheelSeen: 0, wheelSent: 0, wheelSkipped: 0, wheelInside: false, inputDropped: 0, inputDropWarned: false };
  // 最近一次渲染的虚拟机名 (供文档级诊断日志使用)
  let lastVmName = null;

  function getView(vmName) {
    if (!views.has(vmName)) {
      views.set(vmName, {
        canvas: null, ctx: null,
        offscreen: null, offCtx: null,
        w: 80, h: 25,
        cells: [],
        charW: 8, charH: 16,
        cursor: null,
        cursorBlinkOn: true,
        cursorTimer: null,
        logLines: [],
        state: 'stopped',
        subscribed: false,
        isFullscreen: false,
        stoppedAppearance: null,  // null | 'black'(正常关闭) | 'gray'(异常停止)
        expectCleanStop: false,   // 用户主动点停止/重启 -> 归入"正常关闭"
      });
    }
    return views.get(vmName);
  }

  function renderVMView(pane, vmName) {
    const view = getView(vmName);
    const t = I18N.t;
    lastVmName = vmName;
    pane.innerHTML = `
      <div class="console-wrap">
        <div class="vm-toolbar">
          <span class="vm-title">⚡ ${escapeHTML(vmName)}</span>
          <span class="vm-state" id="vm-state-${cssEsc(vmName)}">${t('vm.state.unknown')}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-action="start" id="btn-start-${cssEsc(vmName)}">${t('vm.start')}</button>
          <button class="btn btn-warn" data-action="pause" id="btn-pause-${cssEsc(vmName)}">${t('vm.pause')}</button>
          <button class="btn btn-danger" data-action="stop" id="btn-stop-${cssEsc(vmName)}">${t('vm.stop')}</button>
          <button class="btn btn-warn" data-action="restart" id="btn-restart-${cssEsc(vmName)}">${t('vm.restart')}</button>
          <button class="btn" data-action="edit-hardware">${t('vm.hardware')}</button>
          <button class="btn" data-action="edit-disk1">${t('vm.disk1')}</button>
          <button class="btn" data-action="edit-disk2">${t('vm.disk2')}</button>
          <button class="btn" data-action="edit-floppy">${t('vm.floppy')}</button>
        </div>
        <div class="console-canvas-wrap" id="canvas-wrap-${cssEsc(vmName)}">
          <div class="canvas-stage" id="canvas-stage-${cssEsc(vmName)}">
            <canvas id="console-canvas-${cssEsc(vmName)}" width="720" height="400"></canvas>
            <div class="paused-overlay" id="paused-overlay-${cssEsc(vmName)}" style="display:none;">
              <div class="paused-text">${t('paused.overlay')}</div>
              <div class="paused-hint">${t('paused.overlay.hint')}</div>
            </div>
            <div class="restarting-overlay" id="restarting-overlay-${cssEsc(vmName)}" style="display:none;">
              <div class="restarting-spinner"></div>
              <div class="restarting-text">${t('restarting.overlay')}</div>
              <div class="restarting-hint">${t('restarting.overlay.hint')}</div>
            </div>
          </div>
          <button class="fs-btn" id="fs-btn-${cssEsc(vmName)}" title="${t('fs.btn.title')}">${t('fs.btn')}</button>
        </div>
        <div class="log-panel" id="log-panel-${cssEsc(vmName)}">
          <div class="log-panel-header" id="log-header-${cssEsc(vmName)}">
            <span class="log-title">${t('log.title')}</span>
            <div class="log-header-actions">
              <button class="log-btn" data-action="export-log" id="log-export-${cssEsc(vmName)}" title="${t('log.export.title')}">${t('log.export')}</button>
              <button class="log-btn" data-action="clear-log" id="log-clear-${cssEsc(vmName)}" title="${t('log.clear.title')}">${t('log.clear')}</button>
              <button class="log-btn" data-action="toggle-log" id="log-toggle-${cssEsc(vmName)}" title="${t('log.hide.title')}">▾ ${t('log.hide')}</button>
            </div>
          </div>
          <div class="log-panel-body" id="log-body-${cssEsc(vmName)}">
            <div class="log-line info">${t('log.waiting')}</div>
          </div>
        </div>
        <div class="log-show-handle" id="log-show-handle-${cssEsc(vmName)}" style="display:none;" title="${t('log.show.title')}">
          <span>▴ ${t('log.show')}</span>
        </div>
      </div>
    `;
    view.canvas = pane.querySelector(`#console-canvas-${cssEsc(vmName)}`);
    view.ctx = view.canvas.getContext('2d');
    view.logPanel = pane.querySelector(`#log-body-${cssEsc(vmName)}`);
    view.logContainer = pane.querySelector(`#log-panel-${cssEsc(vmName)}`);
    view.canvasWrap = pane.querySelector(`#canvas-wrap-${cssEsc(vmName)}`);
    view.canvasStage = pane.querySelector(`#canvas-stage-${cssEsc(vmName)}`);
    console.log(`[console.js v39] renderVMView: ${vmName}, canvasWrap=`, !!view.canvasWrap, 'canvas=', !!view.canvas);
    appendLog(vmName, `[debug] console.js v39 loaded, canvasWrap=${!!view.canvasWrap}, canvas=${!!view.canvas}`, 'info');

    // 日志面板最小化/展开
    const logHeader = pane.querySelector(`#log-header-${cssEsc(vmName)}`);
    const logToggle = pane.querySelector(`#log-toggle-${cssEsc(vmName)}`);
    const logClear = pane.querySelector(`#log-clear-${cssEsc(vmName)}`);
    if (logHeader && logToggle) {
      logHeader.addEventListener('click', (e) => {
        if (e.target === logToggle || e.target === logClear) return;
        toggleLogPanel(vmName);
      });
      logToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLogPanel(vmName);
      });
    }
    if (logClear) {
      logClear.addEventListener('click', (e) => {
        e.stopPropagation();
        clearLog(vmName);
      });
    }
    const logExport = pane.querySelector(`#log-export-${cssEsc(vmName)}`);
    if (logExport) {
      logExport.addEventListener('click', (e) => {
        e.stopPropagation();
        exportLog(vmName);
      });
    }
    const showHandle = pane.querySelector(`#log-show-handle-${cssEsc(vmName)}`);
    if (showHandle) {
      showHandle.addEventListener('click', () => {
        toggleLogPanel(vmName);
      });
    }

    // 工具栏事件
    pane.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onToolbarAction(btn.dataset.action, vmName));
    });

    // 标签页重建后立即按当前已知状态刷新一次: 按钮可用性, 以及"已停止"的
    // 画面表现: 画布是刚创建的, 需要在这里补画黑屏/灰屏。
    updateStateBadge(vmName);
    applyStoppedVisual(vmName);

    // 键盘事件转发 (使用 keydown/keyup, 不使用已废弃的 keypress)
    view.canvas.setAttribute('tabindex', '0');
    view.canvas.addEventListener('keydown', (e) => onKey(e, vmName));
    view.canvas.addEventListener('keyup', (e) => onKey(e, vmName));
    // 鼠标事件: down/up/move/wheel, 全部阻止默认 + 屏蔽右键菜单
    view.canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.canvas.focus();
      view._mouseDown = true;
      onMouse(e, vmName, 'touch');
    });
    view.canvas.addEventListener('mouseup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view._mouseDown) {
        view._mouseDown = false;
        onMouse(e, vmName, 'drop');
      }
    });
    view.canvas.addEventListener('mousemove', (e) => {
      if (!view._mouseDown) return;
      // 拖拽事件节流: 用 requestAnimationFrame 合并, 避免高频事件卡顿
      if (view._dragPending) {
        view._dragEvent = e;
        return;
      }
      view._dragPending = true;
      view._dragEvent = e;
      requestAnimationFrame(() => {
        view._dragPending = false;
        if (view._dragEvent && view._mouseDown) {
          onMouse(view._dragEvent, vmName, 'drag');
        }
        view._dragEvent = null;
      });
    });
    // window 上的 mouseup: 鼠标移出 canvas 后松开时兜底
    window.addEventListener('mouseup', (e) => {
      if (view._mouseDown) {
        view._mouseDown = false;
        onMouse(e, vmName, 'drop');
      }
    });
    view.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // 滚轮事件: 绑定在【整个虚拟机面板】上 (工具栏 / 屏幕 / 画布四周留白都算), 只排除日志面板。
    //
    // 真机滚轮由浏览器做命中测试: 若只绑在 .console-canvas-wrap 上, 鼠标稍微偏到画布留白
    // 或工具栏上, 事件就不落在监听元素里 —— 表现为"滚轮完全没反应", 容易被误判成鼠标或
    // 模拟器坏了。因此放大到整个面板, 并把日志面板排除在外 (否则没法用滚轮翻日志)。
    // 只绑定一次: renderVMView 可能被多次调用, 重复绑会让一次滚轮发出多条 scroll 信号。
    if (!pane.dataset.ocWheelBound) {
      pane.dataset.ocWheelBound = '1';
      pane.addEventListener('wheel', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('.log-panel, .log-show-handle')) return;
        e.preventDefault();
        e.stopPropagation();
        onWheel(e, vmName);
      }, { passive: false });
    }
    view.canvasWrap.addEventListener('mousedown', () => view.canvas.focus());
    // 双击逻辑:
    // - 非全屏时: 双击进入全屏
    // - 全屏且系统未运行/报错时: 双击退出全屏
    // - 全屏且系统运行中: 双击正常映射到系统, 不切换全屏
    view.canvas.addEventListener('dblclick', (e) => {
      const view = getView(vmName);
      if (!view.isFullscreen) {
        // 非全屏 → 双击进入全屏
        e.preventDefault();
        toggleFullscreen(vmName);
      } else if (view.state !== 'running') {
        // 全屏 + 系统未运行 → 双击退出全屏
        e.preventDefault();
        toggleFullscreen(vmName);
      }
      // 全屏 + 运行中 → 不拦截, 双击映射到系统
    });

    // 全屏按钮
    const fsBtn = pane.querySelector(`#fs-btn-${cssEsc(vmName)}`);
    if (fsBtn) {
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen(vmName);
      });
    }

    // 窗口大小变化时重绘画布并重新渲染所有单元格
    view._resizeHandler = () => {
      fitCanvasToContainer(vmName);
      repaintAll(vmName);
    };
    window.addEventListener('resize', view._resizeHandler);

    // 拉取最新状态
    reloadView(vmName);

    // 自动获取焦点
    setTimeout(() => {
      view.canvas.focus();
      fitCanvasToContainer(vmName);
      repaintAll(vmName);
    }, 100);
  }

  // 从服务端重新拉取一次权威状态与最新画面。
  // 打开标签页时调用一次; 顶部的"刷新"按钮也会调用它, 用于在 WebSocket 掉线、
  // 或某条状态消息丢失时, 手动强制同步虚拟机状态与画面。
  function reloadView(vmName) {
    const view = getView(vmName);
    return App.api(`vms/${encodeURIComponent(vmName)}/state`).then(s => {
      if (!s || !view) return null;
      view.state = s.state || 'stopped';
      updateStateBadge(vmName);
      const isStopped = (view.state === 'stopped' || view.state === 'error');
      // 已停止的 VM 不要画回服务端残留的最后一帧 (否则会盖掉黑屏/灰屏表现)
      if (!isStopped && s.screen && s.screen.cells && s.screen.cells.length > 0) {
        view.w = s.screen.width;
        view.h = s.screen.height;
        view.cells = s.screen.cells;
        resizeCanvas(vmName);
        paintScreen(vmName, { full: true, cells: view.cells, w: view.w, h: view.h });
      }
      return s;
    }).catch(() => null);
  }

  function cssEsc(s) { return s.replace(/[^a-z0-9_-]/gi, '-'); }

  function updateStateBadge(vmName) {
    const view = getView(vmName);
    const badge = document.getElementById(`vm-state-${cssEsc(vmName)}`);
    const stateKey = 'vm.state.' + (view.state || 'unknown');
    if (badge) badge.textContent = I18N.t(stateKey);
    // 启用/禁用按钮
    const start = document.getElementById(`btn-start-${cssEsc(vmName)}`);
    const stop = document.getElementById(`btn-stop-${cssEsc(vmName)}`);
    const pause = document.getElementById(`btn-pause-${cssEsc(vmName)}`);
    const restart = document.getElementById(`btn-restart-${cssEsc(vmName)}`);
    const isRunning = (view.state === 'running' || view.state === 'paused');
    const isBusy = (view.state === 'starting');  // 重启中等异步过程
    if (start) start.disabled = isBusy || isRunning;
    if (stop) stop.disabled = isBusy || !isRunning;
    if (restart) restart.disabled = isBusy || !isRunning;
    if (pause) {
      pause.disabled = isBusy || !isRunning;
      if (view.state === 'paused') {
        pause.textContent = I18N.t('vm.resume');
        pause.dataset.action = 'resume';
      } else {
        pause.textContent = I18N.t('vm.pause');
        pause.dataset.action = 'pause';
      }
    }
    // 暂停遮罩
    const overlay = document.getElementById(`paused-overlay-${cssEsc(vmName)}`);
    if (overlay) {
      overlay.style.display = (view.state === 'paused') ? 'flex' : 'none';
    }
    // 重启遮罩: state === 'starting' 时显示, 并清空画布 (旧画面与当前系统状态不符)
    const restartingOverlay = document.getElementById(`restarting-overlay-${cssEsc(vmName)}`);
    if (restartingOverlay) {
      const showRestarting = (view.state === 'starting');
      if (showRestarting) {
        // 清空画布, 避免旧画面误导
        const ctx = view.ctx;
        if (ctx) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, view.canvas.width, view.canvas.height);
        }
        view.cells = [];
      }
      restartingOverlay.style.display = showRestarting ? 'flex' : 'none';
    }
  }

  async function onToolbarAction(action, vmName) {
    if (action === 'start') {
      // 乐观 UI: 立即禁用启动按钮, 防止重复点击
      const view = getView(vmName);
      view.state = 'running';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/start`, { method: 'POST' });
      } catch (e) {
        view.state = 'stopped';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] 启动失败: ${e.message}`, 'error');
      }
      App.wsSubscribe(vmName);
    } else if (action === 'stop') {
      // 乐观 UI: 立即显示停止中状态, 防止重复点击
      const view = getView(vmName);
      const wasRunning = view.state;
      view.expectCleanStop = true;   // 主动停止 -> 画面走"正常关闭"(黑屏)
      view.state = 'stopped';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' });
      } catch (e) {
        view.expectCleanStop = false;
        view.state = wasRunning;
        updateStateBadge(vmName);
        appendLog(vmName, `[error] 停止失败: ${e.message}`, 'error');
      }
    } else if (action === 'pause') {
      // 乐观 UI: 立即显示暂停状态
      const view = getView(vmName);
      view.state = 'paused';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/pause`, { method: 'POST' });
      } catch (e) {
        view.state = 'running';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] 暂停失败: ${e.message}`, 'error');
      }
    } else if (action === 'resume') {
      // 乐观 UI: 立即显示运行状态
      const view = getView(vmName);
      view.state = 'running';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/resume`, { method: 'POST' });
      } catch (e) {
        view.state = 'paused';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] 恢复失败: ${e.message}`, 'error');
      }
    } else if (action === 'restart') {
      // 乐观 UI: 显示重启中状态 (用 'starting' 临时态, 运行/暂停按钮都会被禁用)
      const view = getView(vmName);
      view.expectCleanStop = true;   // 重启过程中的停止阶段也按"正常关闭"处理
      view.state = 'starting';
      updateStateBadge(vmName);
      appendLog(vmName, `[info] 正在重启 ${vmName}...`);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/restart`, { method: 'POST' });
        // 重启由服务器推 s2c.state, 不在此处乐观设置最终态
      } catch (e) {
        appendLog(vmName, `[error] 重启失败: ${e.message}`, 'error');
        // 失败: 拉取服务器真实状态
        App.api(`vms/${encodeURIComponent(vmName)}/state`).then(s => {
          if (s) {
            view.state = s.state || 'stopped';
            updateStateBadge(vmName);
          }
        });
      }
    } else if (action === 'edit-hardware') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      openHardwareEditor(vmName, cfg);
    } else if (action === 'edit-disk1') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      const f = cfg?.hardware?.disk1;
      if (f) {
        App.openTab({
          id: 'disk-' + vmName + '-disk1',
          type: 'disk-editor',
          title: `${vmName} / 磁盘1`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert('该虚拟机未挂载磁盘1');
      }
    } else if (action === 'edit-disk2') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      const f = cfg?.hardware?.disk2;
      if (f) {
        App.openTab({
          id: 'disk-' + vmName + '-disk2',
          type: 'disk-editor',
          title: `${vmName} / 磁盘2`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert('该虚拟机未挂载磁盘2');
      }
    } else if (action === 'edit-floppy') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      const f = cfg?.hardware?.floppy;
      if (f) {
        App.openTab({
          id: 'disk-' + vmName + '-floppy',
          type: 'disk-editor',
          title: `${vmName} / 软盘`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert('该虚拟机未挂载软盘');
      }
    }
  }

  // 软盘大小选择 modal: 返回 Promise<number|null>, 用户取消则 resolve(null)
  function askFloppySize() {
    const t = I18N.t;
    return new Promise((resolve) => {
      Modal.open({
        title: t('hw.floppy-size-title'),
        size: 'small',
        bodyHTML: `
          <div class="hint" style="margin-bottom:8px;">${t('hw.floppy-size-hint')}</div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${[
              ['131072', t('hw.floppy-size-128k')],
              ['262144', t('hw.floppy-size-256k')],
              ['524288', t('hw.floppy-size-512k')],
              ['1048576', t('hw.floppy-size-1m')],
              ['2097152', t('hw.floppy-size-2m')],
              ['4194304', t('hw.floppy-size-4m')],
            ].map(([sz, label]) =>
              `<label><input type="radio" name="floppy-size" value="${sz}"> ${label}</label>`
            ).join('')}
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="radio" name="floppy-size" value="custom">
              <span>${t('hw.floppy-size-custom')}</span>
              <input type="number" id="floppy-custom-size" min="131072" max="4194304" step="1024" placeholder="131072~4194304" style="width:140px;">
              <span style="color:var(--muted); font-size:12px;">${t('hw.floppy-size-custom-hint')}</span>
            </label>
          </div>
        `,
        footerHTML: `
          <button class="btn" data-action="modal-close">${t('btn.cancel')}</button>
          <button class="btn btn-primary" id="floppy-size-ok">${t('hw.floppy-size-confirm')}</button>
        `,
      });
      const okBtn = document.querySelector('#floppy-size-ok');
      const cancel = () => { Modal.close(); resolve(null); };
      okBtn.addEventListener('click', () => {
        const checked = document.querySelector('input[name="floppy-size"]:checked');
        let size = 524288; // 默认 512KB
        if (checked) {
          if (checked.value === 'custom') {
            const v = parseInt(document.querySelector('#floppy-custom-size').value, 10);
            if (!v || v < 131072 || v > 4194304 || (v % 1024 !== 0)) {
              alert(t('hw.floppy-size-invalid'));
              return;
            }
            size = v;
          } else {
            size = parseInt(checked.value, 10);
          }
        }
        Modal.close();
        resolve(size);
      });
      document.querySelector('.modal-footer button[data-action="modal-close"]')
        .addEventListener('click', cancel);
    });
  }

  // 新建磁盘对话框: 返回 Promise<{diskName, mirrorPath}|null>
  function askNewDisk(vmName, slot) {
    const t = I18N.t;
    return new Promise((resolve) => {
      const defaultName = slot === 'disk1' ? 'disk1.ocd' : 'disk2.ocd';
      const defaultMirror = slot === 'disk1' ? `vms/${vmName}/disk1_mirror` : `vms/${vmName}/disk2_mirror`;

      Modal.open({
        title: t('hw.new-disk-title'),
        size: 'medium',
        bodyHTML: `
          <div class="form-row">
            <label>${t('hw.disk-mode')}</label>
            <div style="display:flex; gap:12px;">
              <label style="display:flex; align-items:center; gap:4px;">
                <input type="radio" name="disk-mode" value="ocd" checked>
                <span>${t('hw.disk-mode-ocd')}</span>
              </label>
              <label style="display:flex; align-items:center; gap:4px;">
                <input type="radio" name="disk-mode" value="mirror">
                <span>${t('hw.disk-mode-mirror')}</span>
              </label>
            </div>
          </div>
          <div class="form-row">
            <label>${t('hw.disk-name')}</label>
            <input type="text" id="new-disk-name" value="${defaultName}" style="flex:1;">
          </div>
          <div class="form-row">
            <label>${t('hw.disk-label')}</label>
            <input type="text" id="new-disk-label" value="${vmName}-${slot}" style="flex:1;">
          </div>
          <div class="form-row" id="row-disk-size">
            <label>${t('hw.disk-size')}</label>
            <select id="new-disk-size" style="flex:1;">
              <option value="1048576">1 MB (T1)</option>
              <option value="2097152">2 MB (T2)</option>
              <option value="4194304" selected>4 MB (T3)</option>
              <option value="custom">${t('hw.disk-size-custom')}</option>
            </select>
          </div>
          <div class="form-row" id="row-disk-size-custom" style="display:none;">
            <label></label>
            <input type="number" id="new-disk-size-custom" min="131072" max="16777216" step="1024" value="4194304" style="flex:1;">
            <span style="color:var(--muted); font-size:12px; margin-left:6px;">bytes</span>
          </div>
          <div class="form-row" id="row-disk-tier">
            <label>${t('hw.disk-tier')}</label>
            <select id="new-disk-tier" style="flex:1;">
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3" selected>Tier 3</option>
            </select>
          </div>
          <div class="form-row" id="row-disk-mirror" style="display:none;">
            <label>${t('hw.disk-mirror-path')}</label>
            <input type="text" id="new-disk-mirror" value="${defaultMirror}" style="flex:1;">
          </div>
          <div class="form-row" id="row-disk-mirror-dir" style="display:none;">
            <label></label>
            <div style="flex:1; display:flex; gap:8px;">
              <button type="button" class="btn btn-sm" id="btn-mirror-folder">${t('hw.disk-mirror-browse')}</button>
              <span style="color:var(--muted); font-size:12px;">${t('hw.disk-mirror-hint')}</span>
            </div>
          </div>
          <div class="hint" style="margin-top:8px;" id="new-disk-hint">
            ${t('hw.disk-mode-ocd-hint')}
          </div>
        `,
        footerHTML: `
          <button class="btn" data-action="modal-close">${t('btn.cancel')}</button>
          <button class="btn btn-primary" id="new-disk-ok">${t('btn.create')}</button>
        `,
      });

      // 模式切换
      const modeRadios = document.querySelectorAll('input[name="disk-mode"]');
      const sizeRow = document.getElementById('row-disk-size');
      const sizeCustomRow = document.getElementById('row-disk-size-custom');
      const tierRow = document.getElementById('row-disk-tier');
      const mirrorRow = document.getElementById('row-disk-mirror');
      const mirrorDirRow = document.getElementById('row-disk-mirror-dir');
      const hint = document.getElementById('new-disk-hint');
      const sizeSelect = document.getElementById('new-disk-size');
      const sizeCustomInput = document.getElementById('new-disk-size-custom');

      function updateMode() {
        const mode = document.querySelector('input[name="disk-mode"]:checked').value;
        if (mode === 'mirror') {
          mirrorRow.style.display = 'flex';
          mirrorDirRow.style.display = 'flex';
          hint.textContent = t('hw.disk-mode-mirror-hint');
        } else {
          mirrorRow.style.display = 'none';
          mirrorDirRow.style.display = 'none';
          hint.textContent = t('hw.disk-mode-ocd-hint');
        }
      }
      modeRadios.forEach(r => r.addEventListener('change', updateMode));

      sizeSelect.addEventListener('change', () => {
        sizeCustomRow.style.display = sizeSelect.value === 'custom' ? 'flex' : 'none';
      });

      // 浏览文件夹: 用 prompt 输入路径
      document.getElementById('btn-mirror-folder').addEventListener('click', () => {
        const current = document.getElementById('new-disk-mirror').value;
        const p = prompt(t('hw.disk-mirror-browse-prompt'), current);
        if (p) document.getElementById('new-disk-mirror').value = p;
      });

      const cancel = () => { Modal.close(); resolve(null); };

      document.getElementById('new-disk-ok').addEventListener('click', () => {
        const mode = document.querySelector('input[name="disk-mode"]:checked').value;
        const diskName = document.getElementById('new-disk-name').value.trim();
        const label = document.getElementById('new-disk-label').value.trim();
        const tier = parseInt(document.getElementById('new-disk-tier').value, 10);

        if (!diskName) {
          alert(t('hw.disk-name-empty'));
          return;
        }
        if (!diskName.endsWith('.ocd')) {
          alert(t('hw.disk-name-extension'));
          return;
        }

        let size = parseInt(sizeSelect.value, 10);
        if (isNaN(size)) {
          size = parseInt(sizeCustomInput.value, 10);
          if (!size || size < 131072 || size > 16777216 || (size % 1024 !== 0)) {
            alert(t('hw.disk-size-invalid'));
            return;
          }
        }

        const result = {
          mode,
          diskName,
          label,
          size,
          tier,
          mirrorPath: mode === 'mirror' ? document.getElementById('new-disk-mirror').value.trim() : null,
        };
        Modal.close();
        resolve(result);
      });

      document.querySelector('.modal-footer button[data-action="modal-close"]')
        .addEventListener('click', cancel);
    });
  }

  async function openHardwareEditor(vmName, cfg) {
    const view = getView(vmName);
    const t = I18N.t;
    const isStopped = view.state === 'stopped' || view.state === 'paused';
    const isRunning = view.state === 'running';

    // 获取存储设备列表
    let storage = { eeproms: [], disks: [], floppy: null };
    try {
      storage = await App.api(`vms/${encodeURIComponent(vmName)}/storage`);
    } catch (e) { /* 忽略 */ }

    // 获取磁盘模板列表 (disks/ 目录下的所有 .ocd 文件)
    let diskTemplates = [];
    try {
      diskTemplates = await App.api('disks/templates');
    } catch (e) { /* fallback */ }

    // 构建下拉选项
    const opts = (arr, cur) => arr.map(o =>
      `<option value="${o.value}" ${String(o.value) === String(cur) ? 'selected' : ''}>${o.label}</option>`
    ).join('');

    const apuOpts = [
      { value: 1, label: t('hw.option-apu-t1') },
      { value: 2, label: t('hw.option-apu-t2') },
      { value: 3, label: t('hw.option-apu-t3') },
      { value: 'creative', label: t('hw.option-apu-creative') },
    ];
    const memOpts = [
      { value: 1, label: t('hw.option-mem-t1') }, { value: 1.5, label: t('hw.option-mem-t15') },
      { value: 2, label: t('hw.option-mem-t2') }, { value: 2.5, label: t('hw.option-mem-t25') },
      { value: 3, label: t('hw.option-mem-t3') }, { value: 3.5, label: t('hw.option-mem-t35') },
    ];
    const expOpts = [
      { value: '', label: t('hw.option-empty-slot') },
      { value: 'internet', label: t('hw.option-internet') },
      { value: 'data_t1', label: t('hw.option-data-t1') },
      { value: 'data_t2', label: t('hw.option-data-t2') },
      { value: 'data_t3', label: t('hw.option-data-t3') },
      { value: 'wireless_t1', label: t('hw.option-wireless-t1') },
      { value: 'wireless_t2', label: t('hw.option-wireless-t2') },
    ];
    // 无线信号强度: 1 = 隔离(无法发现其他虚拟机), >=2 = 可互通
    const strengthOpts = (() => {
      const arr = [
        { value: '', label: t('hw.strength-auto') },
        { value: '1', label: '1 · ' + t('hw.strength-isolated') },
      ];
      for (let s = 2; s <= 16; s++) arr.push({ value: String(s), label: `${s} · ${t('hw.strength-networked')}` });
      return arr;
    })();

    const cur = cfg?.hardware || {};
    const exp = cur.expansion || [null, null, null];
    const disabled = isStopped ? '' : 'disabled';

    // 构建 EEPROM 选项列表
    const curEeprom = cur.eeprom || 'built-in';
    const eepromItems = [];
    // 内置 BIOS (不可移除)
    eepromItems.push({
      value: 'built-in',
      label: t('hw.option-builtin-bios'),
      removable: false,
      selected: curEeprom === 'built-in',
    });
    // 已保存的 EEPROM 文件
    for (const e of (storage.eeproms || [])) {
      eepromItems.push({
        value: e.filename,
        label: e.label || e.filename,
        removable: true,
        selected: e.filename === curEeprom,
      });
    }

    // 构建磁盘选项列表
    const disk1Items = [];
    const disk2Items = [];
    // 不挂载选项
    disk1Items.push({
      value: '',
      label: t('hw.option-no-disk'),
      removable: false,
      selected: !cur.disk1,
      isNone: true,
    });
    disk2Items.push({
      value: '',
      label: t('hw.option-no-disk'),
      removable: false,
      selected: !cur.disk2,
      isNone: true,
    });
    for (const d of (storage.disks || [])) {
      if (d.isDisk1 || (!d.isDisk2 && !cur.disk2)) {
        disk1Items.push({
          value: d.filename,
          label: d.label || d.filename,
          removable: false,
          selected: d.filename === cur.disk1,
        });
      }
      if (d.isDisk2 || (!d.isDisk1 && !cur.disk1)) {
        disk2Items.push({
          value: d.filename,
          label: d.label || d.filename,
          removable: true,
          selected: d.filename === cur.disk2,
        });
      }
    }
    // 添加磁盘模板选项 (来自 disks/ 目录)
    for (const tpl of (diskTemplates || [])) {
      // OpenOS 保持向后兼容用 'openos', 其他用 'disk_template:xxx.ocd'
      const val = tpl.path === 'openos.ocd' ? 'openos' : 'disk_template:' + tpl.path;
      disk1Items.push({
        value: val,
        label: tpl.name + ' (模板)',
        removable: false,
        selected: false,
        isTemplate: true,
      });
      disk2Items.push({
        value: val,
        label: tpl.name + ' (模板)',
        removable: false,
        selected: false,
        isTemplate: true,
      });
    }
    // 确保 disk1/disk2 有当前选项
    if (cur.disk1 && !disk1Items.find(d => d.value === cur.disk1)) {
      disk1Items.push({ value: cur.disk1, label: cur.disk1, removable: false, selected: true });
    }
    if (cur.disk2 && !disk2Items.find(d => d.value === cur.disk2)) {
      disk2Items.push({ value: cur.disk2, label: cur.disk2, removable: true, selected: true });
    }

    // 构建 EEPROM 选项 HTML
    const eepromListHTML = eepromItems.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''}" data-value="${escapeAttr(item.value)}" data-removable="${item.removable}">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
        ${item.removable ? `<button class="storage-remove" title="${t('hw.remove')}" data-filename="${escapeAttr(item.value)}">×</button>` : ''}
      </div>
    `).join('');

    // 构建磁盘1选项 HTML
    const disk1ListHTML = disk1Items.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''} ${item.isNone ? 'storage-option-none' : ''} ${item.isTemplate ? 'storage-option-template' : ''}" data-value="${escapeAttr(item.value)}" data-slot="disk1">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
      </div>
    `).join('');

    // 构建磁盘2选项 HTML
    const disk2ListHTML = disk2Items.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''} ${item.isNone ? 'storage-option-none' : ''} ${item.isTemplate ? 'storage-option-template' : ''}" data-value="${escapeAttr(item.value)}" data-slot="disk2" data-removable="${item.removable}">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
        ${item.removable && !item.isNone && !item.isTemplate ? `<button class="storage-remove" title="${t('hw.remove')}" data-filename="${escapeAttr(item.value)}">×</button>` : ''}
      </div>
    `).join('');

    // 软盘选项（从 API 动态获取）
    let floppyTemplates = [];
    try {
      floppyTemplates = await App.api('floppy/templates');
    } catch (e) { /* fallback */ }

    const floppyOpts = [
      { value: '', label: t('hw.option-empty'), disabled: false },
      ...floppyTemplates.map(tpl => ({
        value: tpl.key,
        label: tpl.label + (tpl.disabled ? ' (' + t('hw.floppy-disabled') + ')' : ''),
        disabled: tpl.disabled === true,
        disabledReason: tpl.disabledReason,
      })),
      { value: 'empty', label: t('hw.option-floppy-empty'), disabled: false },
    ];

    Modal.open({
      title: `${vmName} - ${t('hw.title')} ${isStopped ? t('hw.editable') : isRunning ? t('hw.running-hotplug') : ''}`,
      size: 'large',
      bodyHTML: `
        ${isRunning ? `<div class="hint" style="margin-bottom:12px;color:var(--warn);">${t('hw.warning-running')}</div>` : ''}
        ${!isStopped && !isRunning ? `<div class="hint" style="margin-bottom:12px;">${t('hw.state-label')}${view.state}</div>` : ''}
        <div class="hw-grid">
          <label>${t('hw.apu-tier')}</label>
          <div class="hw-value"><select id="hw-apu" ${disabled}>${opts(apuOpts, cur.apu?.tier ?? 2)}</select></div>
          <label>${t('hw.mem1')}</label>
          <div class="hw-value"><select id="hw-mem1" ${disabled}>${opts(memOpts, (cur.memory || [3,3])[0])}</select></div>
          <label>${t('hw.mem2')}</label>
          <div class="hw-value"><select id="hw-mem2" ${disabled}>${opts(memOpts, (cur.memory || [3,3])[1])}</select></div>
          <label>${t('hw.eeprom')}</label>
          <div class="hw-value">
            <div class="storage-list" id="hw-eeprom-list">${eepromListHTML}</div>
            <div class="storage-add-row">
              <button type="button" class="btn btn-sm" id="hw-eeprom-add-oce" ${disabled}>+ ${t('hw.option-custom-oce')}</button>
              <button type="button" class="btn btn-sm" id="hw-eeprom-add-lua" ${disabled}>+ ${t('hw.option-custom-lua')}</button>
            </div>
            <input type="file" id="hw-eeprom-file-oce" accept=".oce" style="display:none;">
            <input type="file" id="hw-eeprom-file-lua" accept=".lua" style="display:none;">
          </div>
          <label>${t('hw.disk1')}</label>
          <div class="hw-value">
            <div class="storage-list" id="hw-disk1-list">${disk1ListHTML}</div>
            <div class="storage-add-row">
              <button type="button" class="btn btn-sm" id="hw-disk1-new" ${disabled}>+ ${t('hw.option-new-disk')}</button>
              <button type="button" class="btn btn-sm" id="hw-disk1-openos" ${disabled}>+ ${t('hw.option-openos')}</button>
              <button type="button" class="btn btn-sm" id="hw-disk1-import" ${disabled}>+ ${t('hw.option-import-disk')}</button>
            </div>
            <input type="file" id="hw-disk1-import-file" accept=".ocd" style="display:none;">
          </div>
          <label>${t('hw.disk2')}</label>
          <div class="hw-value">
            <div class="storage-list" id="hw-disk2-list">${disk2ListHTML}</div>
            <div class="storage-add-row">
              <button type="button" class="btn btn-sm" id="hw-disk2-new" ${disabled}>+ ${t('hw.option-new-disk')}</button>
              <button type="button" class="btn btn-sm" id="hw-disk2-openos" ${disabled}>+ ${t('hw.option-openos')}</button>
              <button type="button" class="btn btn-sm" id="hw-disk2-import" ${disabled}>+ ${t('hw.option-import-disk')}</button>
            </div>
            <input type="file" id="hw-disk2-import-file" accept=".ocd" style="display:none;">
          </div>
          <label>${t('hw.floppy')}</label>
          <div class="hw-value">
            <select id="hw-floppy">
              ${(() => {
                const hasFloppy = cur.floppy && cur.floppy !== '';
                // 如果是 floppy.ocf, 用 storage 返回的标签匹配模板名
                let floppyDisplay = cur.floppy;
                let templateMatched = false;
                // 从 storage 软盘标签查找对应模板
                if (hasFloppy && cur.floppy !== 'empty' && storage.floppy && storage.floppy.label) {
                  const fLabel = storage.floppy.label;
                  const matchedTpl = floppyTemplates.find(tpl => tpl.label === fLabel);
                  if (matchedTpl) {
                    floppyDisplay = matchedTpl.key;
                    templateMatched = true;
                  }
                }
                let anySelected = false;
                const html = floppyOpts.map(o => {
                  let sel = false;
                  if (templateMatched && o.value === floppyDisplay) { sel = true; anySelected = true; }
                  else if (cur.floppy === o.value) { sel = true; anySelected = true; }
                  else if (!cur.floppy && o.value === '') { sel = true; anySelected = true; }
                  return `<option value="${o.value}" ${sel ? 'selected' : ''} ${o.disabled ? 'disabled' : ''} title="${o.disabledReason || ''}">${o.label}</option>`;
                }).join('');
                // 如果有软盘但没匹配到任何选项，在前面加一个 "current" 选项
                if (hasFloppy && !anySelected) {
                  const curLabel = storage.floppy && storage.floppy.label ? storage.floppy.label : cur.floppy;
                  return `<option value="${cur.floppy}" selected>${curLabel}</option>` + html;
                }
                return html;
              })()}
            </select>
          </div>
          <label>${t('hw.exp1')}</label>
          <div class="hw-value"><select id="hw-exp1">${opts(expOpts, exp[0] || '')}</select></div>
          <label>${t('hw.exp2')}</label>
          <div class="hw-value"><select id="hw-exp2">${opts(expOpts, exp[1] || '')}</select></div>
          <label>${t('hw.exp3')}</label>
          <div class="hw-value"><select id="hw-exp3">${opts(expOpts, exp[2] || '')}</select></div>
          <label>${t('hw.modem-strength')}</label>
          <div class="hw-value">
            <select id="hw-modem-strength" ${disabled}>${opts(strengthOpts, cur.modemStrength != null ? String(cur.modemStrength) : '')}</select>
            <div class="hint" style="font-size:12px;color:var(--muted);margin-top:4px;">${t('hw.modem-strength-hint')}</div>
          </div>
          <label>${t('hw.screen')}</label>
          <div class="hw-value"><select id="hw-screen" ${disabled}>
            <option value="1" ${cur.screen?.tier == 1 ? 'selected' : ''}>${t('hw.option-screen-t1')}</option>
            <option value="2" ${cur.screen?.tier == 2 ? 'selected' : ''}>${t('hw.option-screen-t2')}</option>
            <option value="3" ${(cur.screen?.tier ?? 3) == 3 ? 'selected' : ''}>${t('hw.option-screen-t3')}</option>
          </select></div>
          <label>${t('hw.boot-order')}</label>
          <div class="hw-value">
            <div class="hint" style="font-size:12px;color:var(--muted);margin-bottom:6px;">${t('hw.boot-order-hint')}</div>
            <div class="boot-order-list" id="hw-boot-order-list"></div>
          </div>
        </div>
      `,
      footerHTML: `
        <button class="btn" data-action="modal-close">${t('btn.cancel')}</button>
        <button class="btn btn-primary" data-action="save-hw" ${isStopped ? '' : 'disabled'} id="btn-save-hw">${t('btn.save-cfg')}</button>
        ${isRunning ? `<button class="btn btn-warn" data-action="hotplug" id="btn-hotplug">${t('hw.hotplug')}</button>` : ''}
      `,
    });

    // --- EEPROM 选项交互 ---
    const eepromList = document.querySelector('#hw-eeprom-list');
    if (eepromList) {
      eepromList.addEventListener('click', (e) => {
        // 点击移除按钮
        const removeBtn = e.target.closest('.storage-remove');
        if (removeBtn) {
          e.stopPropagation();
          const filename = removeBtn.dataset.filename;
          if (confirm(t('hw.confirm-remove-eeprom').replace('{name}', filename))) {
            App.api(`vms/${encodeURIComponent(vmName)}/eeprom-delete`, {
              method: 'POST',
              body: { filename },
            }).then(() => {
              // 刷新配置并重新打开
              App.api(`vms/${encodeURIComponent(vmName)}`).then(newCfg => {
                openHardwareEditor(vmName, newCfg);
              });
            });
          }
          return;
        }
        // 点击选项
        const opt = e.target.closest('.storage-option');
        if (opt) {
          eepromList.querySelectorAll('.storage-option').forEach(o => {
            o.classList.remove('selected');
            o.querySelector('.storage-radio').textContent = '○';
          });
          opt.classList.add('selected');
          opt.querySelector('.storage-radio').textContent = '◉';
        }
      });
    }

    // EEPROM 文件上传
    const fileInputOce = document.querySelector('#hw-eeprom-file-oce');
    const fileInputLua = document.querySelector('#hw-eeprom-file-lua');
    const addOceBtn = document.querySelector('#hw-eeprom-add-oce');
    const addLuaBtn = document.querySelector('#hw-eeprom-add-lua');

    async function uploadEeprom(file, format) {
      try {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const result = await App.api('eeprom/import', {
          method: 'POST',
          body: { vmName, content: b64, format, filename: file.name.replace(/\.(lua|oce)$/i, '') },
        });
        if (result && result.ok) {
          // 刷新配置并重新打开
          const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
          openHardwareEditor(vmName, newCfg);
        }
      } catch (e) {
        alert(t('hw.eeprom-upload-fail') + ': ' + e.message);
      }
    }

    if (addOceBtn) addOceBtn.addEventListener('click', () => fileInputOce.click());
    if (addLuaBtn) addLuaBtn.addEventListener('click', () => fileInputLua.click());
    if (fileInputOce) fileInputOce.addEventListener('change', () => {
      if (fileInputOce.files[0]) uploadEeprom(fileInputOce.files[0], 'oce');
    });
    if (fileInputLua) fileInputLua.addEventListener('change', () => {
      if (fileInputLua.files[0]) uploadEeprom(fileInputLua.files[0], 'lua');
    });

    // --- 磁盘2 选项交互 ---
    const disk2List = document.querySelector('#hw-disk2-list');
    if (disk2List) {
      disk2List.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.storage-remove');
        if (removeBtn) {
          e.stopPropagation();
          const filename = removeBtn.dataset.filename;
          if (confirm(t('hw.confirm-remove-disk').replace('{name}', filename))) {
            App.api(`vms/${encodeURIComponent(vmName)}/disk-delete`, {
              method: 'POST',
              body: { filename },
            }).then(() => {
              App.api(`vms/${encodeURIComponent(vmName)}`).then(newCfg => {
                openHardwareEditor(vmName, newCfg);
              });
            });
          }
          return;
        }
        const opt = e.target.closest('.storage-option');
        if (opt) {
          disk2List.querySelectorAll('.storage-option').forEach(o => {
            o.classList.remove('selected');
            o.querySelector('.storage-radio').textContent = '○';
          });
          opt.classList.add('selected');
          opt.querySelector('.storage-radio').textContent = '◉';
        }
      });
    }

    // 磁盘1 选项交互
    const disk1List = document.querySelector('#hw-disk1-list');
    if (disk1List) {
      disk1List.addEventListener('click', (e) => {
        const opt = e.target.closest('.storage-option');
        if (opt) {
          disk1List.querySelectorAll('.storage-option').forEach(o => {
            o.classList.remove('selected');
            o.querySelector('.storage-radio').textContent = '○';
          });
          opt.classList.add('selected');
          opt.querySelector('.storage-radio').textContent = '◉';
        }
      });
    }

    // 磁盘2 新建/OpenOS
    const disk2NewBtn = document.querySelector('#hw-disk2-new');
    const disk2OpenosBtn = document.querySelector('#hw-disk2-openos');
    if (disk2NewBtn) disk2NewBtn.addEventListener('click', async () => {
      // 使用新对话框创建磁盘
      try {
        const result = await askNewDisk(vmName, 'disk2');
        if (!result) return;
        const diskPath = `vms/${vmName}/${result.diskName}`;

        if (result.mode === 'mirror' && result.mirrorPath) {
          // 镜像模式：先创建空磁盘，再设置 mirror 路径
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          // 更新配置：disk2 + disk2Mirror
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk2: result.diskName, disk2Mirror: result.mirrorPath } },
          });
        } else {
          // 普通 .ocd 模式
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk2: result.diskName } },
          });
        }
        // 刷新
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });
    if (disk2OpenosBtn) disk2OpenosBtn.addEventListener('click', async () => {
      // 复制 OpenOS 模板到 disk2
      try {
        // 通过 PUT 设置 disk2 = 'openos' 让 server 处理
        await App.api(`vms/${encodeURIComponent(vmName)}`, {
          method: 'PUT',
          body: { hardware: { disk2: 'openos' } },
        });
        // 刷新
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });

    // 磁盘1 新建/OpenOS/导入
    const disk1NewBtn = document.querySelector('#hw-disk1-new');
    const disk1OpenosBtn = document.querySelector('#hw-disk1-openos');
    const disk1ImportBtn = document.querySelector('#hw-disk1-import');
    const disk1ImportFile = document.querySelector('#hw-disk1-import-file');

    if (disk1NewBtn) disk1NewBtn.addEventListener('click', async () => {
      try {
        const result = await askNewDisk(vmName, 'disk1');
        if (!result) return;
        const diskPath = `vms/${vmName}/${result.diskName}`;
        if (result.mode === 'mirror' && result.mirrorPath) {
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk1: result.diskName, disk1Mirror: result.mirrorPath } },
          });
        } else {
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk1: result.diskName } },
          });
        }
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });
    if (disk1OpenosBtn) disk1OpenosBtn.addEventListener('click', async () => {
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}`, {
          method: 'PUT',
          body: { hardware: { disk1: 'openos' } },
        });
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });
    if (disk1ImportBtn) disk1ImportBtn.addEventListener('click', () => disk1ImportFile.click());
    if (disk1ImportFile) disk1ImportFile.addEventListener('change', async () => {
      const file = disk1ImportFile.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const result = await App.api('disks/import', {
          method: 'POST',
          body: { vmName, content: b64, filename: file.name },
        });
        if (result && result.ok) {
          // 设置为 disk1
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk1: result.filename } },
          });
          const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
          openHardwareEditor(vmName, newCfg);
        }
      } catch (e) {
        alert(t('hw.disk-import-fail') + ': ' + e.message);
      }
    });

    // 磁盘2 导入
    const disk2ImportBtn = document.querySelector('#hw-disk2-import');
    const disk2ImportFile = document.querySelector('#hw-disk2-import-file');
    if (disk2ImportBtn) disk2ImportBtn.addEventListener('click', () => disk2ImportFile.click());
    if (disk2ImportFile) disk2ImportFile.addEventListener('change', async () => {
      const file = disk2ImportFile.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const result = await App.api('disks/import', {
          method: 'POST',
          body: { vmName, content: b64, filename: file.name },
        });
        if (result && result.ok) {
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk2: result.filename } },
          });
          const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
          openHardwareEditor(vmName, newCfg);
        }
      } catch (e) {
        alert(t('hw.disk-import-fail') + ': ' + e.message);
      }
    });

    // 启动顺序列表
    const bootOrderList = document.querySelector('#hw-boot-order-list');
    // 默认顺序
    const defaultOrder = ['disk1', 'disk2', 'floppy'];
    let bootOrder = cur.bootOrder && Array.isArray(cur.bootOrder) ? [...cur.bootOrder] : [...defaultOrder];
    // 过滤掉不在默认列表中的项
    bootOrder = bootOrder.filter(d => defaultOrder.includes(d));
    // 补充缺失的设备
    for (const d of defaultOrder) {
      if (!bootOrder.includes(d)) bootOrder.push(d);
    }
    function renderBootOrder() {
      if (!bootOrderList) return;
      bootOrderList.innerHTML = bootOrder.map((dev, i) => `
        <div class="boot-order-item" data-dev="${dev}">
          <span class="boot-order-num">${i + 1}.</span>
          <span class="boot-order-label">${t('hw.boot-device-' + dev)}</span>
          <div class="boot-order-actions">
            <button type="button" class="btn btn-xs" data-action="up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="btn btn-xs" data-action="down" ${i === bootOrder.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
        </div>
      `).join('');
    }
    renderBootOrder();
    if (bootOrderList) {
      bootOrderList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const item = btn.closest('.boot-order-item');
        if (!item) return;
        const dev = item.dataset.dev;
        const action = btn.dataset.action;
        const idx = bootOrder.indexOf(dev);
        if (action === 'up' && idx > 0) {
          [bootOrder[idx - 1], bootOrder[idx]] = [bootOrder[idx], bootOrder[idx - 1]];
          renderBootOrder();
        } else if (action === 'down' && idx < bootOrder.length - 1) {
          [bootOrder[idx + 1], bootOrder[idx]] = [bootOrder[idx], bootOrder[idx + 1]];
          renderBootOrder();
        }
      });
    }
    // 把 bootOrder 挂到 window 上供 saveHardware 读取
    window._bootOrder = bootOrder;

    // 保存按钮
    const saveBtn = document.querySelector('#btn-save-hw');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => saveHardware(vmName, cfg));
    }

    // 热插拔按钮
    const hotplugBtn = document.querySelector('#btn-hotplug');
    if (hotplugBtn) {
      hotplugBtn.addEventListener('click', () => saveHardware(vmName, cfg, true));
    }

    // 关闭按钮
    document.querySelector('.modal-footer button[data-action="modal-close"]')
      .addEventListener('click', () => Modal.close());
  }

  async function saveHardware(vmName, oldCfg, isHotplug = false) {
    const t = I18N.t;
    const patch = { hardware: {} };

    // 收集所有字段
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    };

    // 从 storage-option 列表中获取选中的值
    const getSelectedFromList = (listId) => {
      const list = document.getElementById(listId);
      if (!list) return null;
      const selected = list.querySelector('.storage-option.selected');
      return selected ? selected.dataset.value : null;
    };

    if (!isHotplug) {
      // 停机时可修改全部
      patch.hardware.apu = { tier: getVal('hw-apu') };
      const m1 = parseFloat(getVal('hw-mem1'));
      const m2 = parseFloat(getVal('hw-mem2'));
      patch.hardware.memory = [m1, m2];
      // EEPROM: 从选项列表获取
      const eepromVal = getSelectedFromList('hw-eeprom-list') || 'built-in';
      patch.hardware.eeprom = eepromVal;
      // 如果选中的是文件, 设置 eepromLabel
      if (eepromVal !== 'built-in') {
        const list = document.getElementById('hw-eeprom-list');
        if (list) {
          const selected = list.querySelector('.storage-option.selected');
          if (selected) {
            const labelEl = selected.querySelector('.storage-label');
            if (labelEl) patch.hardware.eepromLabel = labelEl.textContent;
          }
        }
      } else {
        patch.hardware.eepromLabel = null;
      }
      // 注意: screen 在 config 外层 (config.screen), 不是 config.hardware.screen
      patch.screen = { tier: parseInt(getVal('hw-screen'), 10) };
    }

    // 磁盘1: 从选项列表获取
    const d1Val = getSelectedFromList('hw-disk1-list');
    if (d1Val !== null) {
      patch.hardware.disk1 = d1Val || null;
    }

    // 磁盘2: 从选项列表获取
    const d2Val = getSelectedFromList('hw-disk2-list');
    patch.hardware.disk2 = d2Val || null;

    // 软盘: 先读取值, 再处理空软盘弹窗 (避免 Modal 替换后 DOM 丢失)
    let floppyVal = getVal('hw-floppy') || null;
    // 扩展卡: 在 askFloppySize 之前读取, 避免 Modal 替换后 DOM 丢失
    const exp1 = getVal('hw-exp1') || null;
    const exp2 = getVal('hw-exp2') || null;
    const exp3 = getVal('hw-exp3') || null;

    // 选中"空软盘"时, 弹出大小选择界面; 取消则中止保存
    if (floppyVal === 'empty') {
      const size = await askFloppySize();
      if (!size) {
        // 用户取消, 重新打开硬件编辑器
        const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        if (cfg) openHardwareEditor(vmName, cfg);
        return;
      } else {
        patch.hardware.floppySize = size;
      }
    }
    patch.hardware.floppy = floppyVal;
    patch.hardware.expansion = [exp1, exp2, exp3];
    // 无线信号强度: 空 = 自动(跟随网卡等级)
    const strengthVal = getVal('hw-modem-strength');
    patch.hardware.modemStrength = strengthVal ? parseInt(strengthVal, 10) : null;

    // 启动顺序
    if (!isHotplug && window._bootOrder) {
      patch.hardware.bootOrder = window._bootOrder;
    }

    // 磁盘1: 如果运行中且改了, 警告崩溃
    if (isHotplug) {
      if (d1Val !== oldCfg.hardware.disk1) {
        if (!confirm(t('hw.confirm-disk1-remove'))) return;
        patch.hardware.disk1 = d1Val || null;
        // 崩溃处理: 先保存配置, 再停止VM
        await App.api(`vms/${encodeURIComponent(vmName)}`, {
          method: 'PUT',
          body: patch,
        });
        await App.api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' });
        // 显示错误弹窗
        alert(t('hw.crash-msg').replace('{name}', vmName));
        Modal.close();
        return;
      }
    } else {
      // 停机时也可改 disk1，支持不挂载
      if ((d1Val || '') !== (oldCfg.hardware.disk1 || '')) {
        patch.hardware.disk1 = d1Val || null;
      }
    }

    try {
      const result = await App.api(`vms/${encodeURIComponent(vmName)}`, {
        method: 'PUT',
        body: patch,
      });
      if (result && result.error) {
        alert(t('hw.save-error') + ': ' + result.error);
        return;
      }
    } catch (e) {
      alert(t('hw.save-error') + ': ' + e.message);
      return;
    }
    Modal.close();
    // 刷新状态
    App.api(`vms/${encodeURIComponent(vmName)}/state`).then(s => {
      if (s) {
        const view = getView(vmName);
        view.state = s.state || 'stopped';
        updateStateBadge(vmName);
      }
    });
  }

  // ---------- 屏幕渲染 ----------
  function resizeCanvas(vmName) {
    const view = getView(vmName);
    if (!view.canvas || !view.canvasStage) return;
    const stage = view.canvasStage;
    const sw = stage.clientWidth - 4;
    const sh = stage.clientHeight - 4;
    if (sw <= 0 || sh <= 0 || !view.w || !view.h) return;

    // OC 标准字符宽高比: 1:2 (宽度 = 高度 / 2)
    const ratio = 1 / 2;

    // 计算每字符的目标CSS像素 (使网格填满容器)
    let targetCw = sw / view.w;
    let targetCh = targetCw / ratio;
    if (targetCh * view.h > sh) {
      targetCh = sh / view.h;
      targetCw = targetCh * ratio;
    }

    // 内部渲染分辨率: 每字符用固定的 8x16 像素 (Unifont 原生尺寸)
    const cw = 8;
    const ch = 16;

    view.charW = cw; view.charH = ch;
    const dpr = window.devicePixelRatio || 1;

    // 主 Canvas: DPR 缩放, drawImage 时用最近邻插值
    view.canvas.width = Math.round(view.w * cw * dpr);
    view.canvas.height = Math.round(view.h * ch * dpr);
    view.canvas.style.width = (view.w * targetCw) + 'px';
    view.canvas.style.height = (view.h * targetCh) + 'px';
    view.canvas.style.transform = '';
    view._renderScale = targetCw / cw;

    view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.ctx.imageSmoothingEnabled = false;
    view.ctx.font = `${ch}px "Unifont", "SFMono-Regular", Consolas, "Source Code Pro", Menlo, "Microsoft YaHei", "微软雅黑", "SimSun", "宋体", monospace`;
    view.ctx.textBaseline = 'middle';
    view.ctx.textAlign = 'center';

    // 离屏 Canvas: 1:1 像素, 用于位图字体渲染
    if (!view.offscreen) {
      view.offscreen = document.createElement('canvas');
      view.offCtx = view.offscreen.getContext('2d');
    }
    view.offscreen.width = view.w * cw;
    view.offscreen.height = view.h * ch;
    // ImageData: 直接像素操作, 避免几千次 fillRect 调用
    view.imgData = view.offCtx.createImageData(view.w * cw, view.h * ch);
    view._pixelBuf = view.imgData.data; // 缓存引用, 避免重复访问
  }

  // 兼容旧调用: 重新计算并渲染
  function fitCanvasToContainer(vmName) {
    resizeCanvas(vmName);
  }

  // 全屏切换
  function toggleFullscreen(vmName) {
    const view = getView(vmName);
    const wrap = view.canvasWrap;
    if (!wrap) return;
    view.isFullscreen = !view.isFullscreen;
    wrap.classList.toggle('fullscreen', view.isFullscreen);
    // ESC 退出全屏 (在 capture 阶段拦截, 防止冒泡到 canvas 的 onKey)
    if (view.isFullscreen) {
      view._escHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          toggleFullscreen(vmName);
        }
      };
      document.addEventListener('keydown', view._escHandler, true);
      // 全屏区域内点击任意位置都把焦点拉回 canvas
      view._fsFocusHandler = (e) => {
        if (e.target !== view.canvas) view.canvas.focus();
      };
      wrap.addEventListener('mousedown', view._fsFocusHandler, true);
      // 进入全屏后立即聚焦 canvas, 否则 keydown 收不到
      setTimeout(() => {
        view.canvas.focus();
        fitCanvasToContainer(vmName);
        repaintAll(vmName);
      }, 30);
    } else {
      if (view._escHandler) {
        document.removeEventListener('keydown', view._escHandler, true);
        view._escHandler = null;
      }
      if (view._fsFocusHandler) {
        wrap.removeEventListener('mousedown', view._fsFocusHandler, true);
        view._fsFocusHandler = null;
      }
      setTimeout(() => { fitCanvasToContainer(vmName); repaintAll(vmName); }, 30);
    }
  }

  function clearLog(vmName) {
    const view = getView(vmName);
    if (view.logPanel) {
      view.logPanel.innerHTML = '';
    }
    if (view.logLines) {
      view.logLines = [];
    }
  }

  function exportLog(vmName) {
    const view = getView(vmName);
    if (!view.logLines || view.logLines.length === 0) return;
    const lines = view.logLines.map(item => {
      const d = new Date(item.time);
      const ts = d.toISOString().replace('T', ' ').replace('Z', '');
      return `[${ts}] [${item.level}] ${item.text}`;
    });
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = vmName.replace(/[^\w-]/g, '_');
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.download = `${safeName}-log-${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 将离屏 Canvas 内容刷新到主 Canvas (DPR 缩放)
  function flushScreen(view) {
    if (hexFont && view.offscreen) {
      view.ctx.drawImage(view.offscreen, 0, 0);
    }
  }

  // 渲染节流: rAF 合并 + 脏更新 (只重绘变化的单元格)
  let _rafPending = false;
  let _dirtyVMs = new Map();  // vmName -> { full: bool, cells: Set }

  function _schedulePaint(vmName, fullRefresh) {
    let info = _dirtyVMs.get(vmName);
    if (!info) {
      info = { full: false, cells: new Set() };
      _dirtyVMs.set(vmName, info);
    }
    if (fullRefresh) info.full = true;
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      for (const [vm, info] of _dirtyVMs) {
        _doPaint(vm, info);
      }
      _dirtyVMs.clear();
    });
  }

  // 标记单元格为脏 (cellIdx = y * w + x, 0-based)
  function _markDirtyCell(vmName, cellIdx) {
    let info = _dirtyVMs.get(vmName);
    if (!info) {
      info = { full: false, cells: new Set() };
      _dirtyVMs.set(vmName, info);
    }
    if (!info.full) {
      info.cells.add(cellIdx);
      // 脏格太多时退化为全屏重绘 (避免过多的小更新)
      if (info.cells.size > 200) {
        info.full = true;
        info.cells.clear();
      }
    }
  }

  // 真正执行渲染 (两趟: 先填背景, 再画字符, 避免宽字符右半边被覆盖)
  function _doPaint(vmName, info) {
    const view = getView(vmName);
    if (!view.ctx || !view.cells || !view.w || !view.h) return;
    // 正常关闭后画面固定为黑色, 不重绘 (否则离屏缓冲会把旧画面刷回来)
    if (view.stoppedAppearance === 'black') return;
    const cw = view.charW, ch = view.charH;
    const cells = view.cells;
    const w = view.w, h = view.h;
    const target = (hexFont && view.offCtx) ? view.offCtx : view.ctx;

    // 收集需要重绘的单元格索引 (去重)
    const repaint = new Set();
    if (info.full) {
      for (let i = 0; i < cells.length; i++) repaint.add(i);
    } else {
      for (const idx of info.cells) {
        repaint.add(idx);
        const y = Math.floor(idx / w);
        const x = idx - y * w;
        // 若当前格是宽字符的续接格, 需要重绘前一格 (宽字符占两格)
        if (x > 0) {
          const prevCell = cells[idx - 1];
          if (prevCell && prevCell[2] && isWideGlyph(prevCell[2])) {
            repaint.add(idx - 1);
          }
        }
        // 若当前格字符是宽字符, 下一格也要重绘背景
        if (x < w - 1) {
          const cell = cells[idx] || [0, 0xffffff, ' '];
          if (cell[2] && isWideGlyph(cell[2])) {
            repaint.add(idx + 1);
          }
        }
      }
    }

    // 第一趟: 填充所有背景
    const bgCSSCache = new Map();
    for (const idx of repaint) {
      const y = Math.floor(idx / w);
      const x = idx - y * w;
      const cell = cells[idx] || [0, 0xffffff, ' '];
      const bg = cell[0];
      let bgCSS = bgCSSCache.get(bg);
      if (!bgCSS) { bgCSS = colorToCSS(bg); bgCSSCache.set(bg, bgCSS); }
      target.fillStyle = bgCSS;
      target.fillRect(x * cw, y * ch, cw, ch);
    }

    // 第二趟: 绘制所有字符 (宽字符右半边不会被覆盖)
    for (const idx of repaint) {
      const y = Math.floor(idx / w);
      const x = idx - y * w;
      const cell = cells[idx] || [0, 0xffffff, ' '];
      const ch_ = cell[2];
      if (!ch_ || ch_ === ' ') continue;

      const fg = cell[1];
      const px = x * cw, py = y * ch;

      // hex font: 用位图精确渲染
      if (hexFont) {
        const cp = ch_.codePointAt(0);
        const glyph = hexFont.get(cp);
        if (glyph) {
          const gw = glyph.width;
          const bytes = glyph.bytes;
          const rowBytes = gw / 8;
          const fgCSS = colorToCSS(fg);
          target.fillStyle = fgCSS;
          for (let row = 0; row < ch; row++) {
            let segStart = -1;
            for (let col = 0; col <= gw; col++) {
              const isOn = col < gw ? ((bytes[row * rowBytes + (col >> 3)] >> (7 - (col & 7))) & 1) : 0;
              if (isOn && segStart === -1) {
                segStart = col;
              } else if (!isOn && segStart !== -1) {
                target.fillRect(px + segStart, py + row, col - segStart, 1);
                segStart = -1;
              }
            }
          }
          continue;
        }
      }

      // 备用渲染: TTF fillText
      target.fillStyle = colorToCSS(fg);
      target.textBaseline = 'middle';
      target.textAlign = 'center';
      target.fillText(ch_, px + cw / 2, py + ch / 2);
    }
    flushScreen(view);

    // 光标
    if (view.cursor) {
      const cx = (view.cursor.x || 1) - 1;
      const cy = (view.cursor.y || 1) - 1;
      if (cx >= 0 && cy >= 0 && cx < w && cy < h && view.cursorBlinkOn) {
        target.fillStyle = view.cursor.blink ? '#ffffff' : '#cccccc';
        target.fillRect(cx * cw, cy * ch + ch - 2, cw, 2);
        flushScreen(view);
      }
    }
  }

  function paintScreen(vmName, msg) {
    const view = getView(vmName);
    if (!view.ctx) return;

    // 注意: 这里刻意不根据"收到画面帧"来清除已停止的外观。
    // 订阅一个已停止的 VM 时, 服务端会把最后一次屏幕快照发过来, 若按帧判断
    // 会误认为系统仍在运行, 于是又显示出彩色旧画面。
    // 画面外观只由 s2c.state 驱动 (见 onServerMessage)。
    if (msg.cursor) {
      view.cursor = msg.cursor;
    }

    if (msg.full && msg.cells) {
      // 全屏: 标准 cells 数组格式
      view.w = msg.w || view.w;
      view.h = msg.h || view.h;
      view.cells = msg.cells;
      resizeCanvas(vmName);
      _schedulePaint(vmName, true);
    } else if (msg.dirty) {
      // 脏更新
      const w = view.w;
      for (const [x, y, bg, fg, ch_] of msg.dirty) {
        const idx = (y - 1) * w + (x - 1);
        view.cells[idx] = [bg, fg, ch_];
        _markDirtyCell(vmName, idx);
      }
      _schedulePaint(vmName, false);
    } else {
      // 只有光标更新
      _schedulePaint(vmName, false);
    }
  }

  function repaintAll(vmName) {
    _schedulePaint(vmName, true);
  }

  // 系统停止后的画面表现。
  //   mode = 'black' 正常关闭 (guest 自己 shutdown, 或用户主动点停止/重启)
  //          'gray'  异常停止 (进程崩溃、被意外杀掉、服务端断开、状态未知)
  //          null    恢复正常显示
  // 正常关闭时整个画面清黑; 异常停止时保留最后一帧并整体置灰, 这样一眼就能
  // 分辨"系统是正常关了"还是"运行中突然没了"。
  function setStoppedAppearance(vmName, mode) {
    const view = getView(vmName);
    if (!view) return;
    const next = mode || null;
    if (view.stoppedAppearance === next) return;
    view.stoppedAppearance = next;
    applyStoppedVisual(vmName);
  }

  // 把已记录的"停止外观"画到画布上。画布可能还没创建 (标签页没打开),
  // 这时只记录状态, 等 renderVMView 建好画布后再应用。
  function applyStoppedVisual(vmName) {
    const view = getView(vmName);
    if (!view || !view.canvas) return;
    const next = view.stoppedAppearance;

    // 灰屏用 CSS 滤镜实现: 不关心画布是 hex 位图逐像素绘制还是离屏合成,
    // 直接对整块画布去色变暗即可。
    try {
      view.canvas.style.filter = (next === 'gray') ? 'grayscale(1) brightness(0.55)' : '';
    } catch (e) {}

    if (next === 'black') {
      // 清空可见画布与离屏缓冲, 并丢弃单元格缓存 (否则后续 flushScreen
      // 或光标闪烁会把旧画面重新刷回来)
      const clear = (c) => {
        try {
          c.fillStyle = '#000';
          c.fillRect(0, 0, c.canvas.width, c.canvas.height);
        } catch (e) {}
      };
      if (view.ctx) clear(view.ctx);
      if (view.offCtx) clear(view.offCtx);
      view.cells = [];
    }

    // 停止后光标不应继续闪烁 (会让人以为系统还活着)
    if (next && view.cursorTimer) {
      clearInterval(view.cursorTimer);
      view.cursorTimer = null;
    }
  }

  // 统一应用一次服务器状态: 更新状态、按钮可用性, 以及停止后的画面表现。
  // 同时被 WebSocket 的 s2c.state 与 5 秒轮询调用; 因此即使某条状态消息漏掉,
  // 控制按钮也会在下次轮询时自动纠正, 不需要刷新整个页面。
  function applyServerState(vmName, state, exitCode, cleanStop) {
    const view = getView(vmName);
    if (!view) return;
    if (state) view.state = state;
    updateStateBadge(vmName);

    const st = view.state;
    if (st === 'stopped' || st === 'error') {
      // 只有"确实异常退出"才判为灰屏:
      //   exitCode 是数字且非 0 -> 崩溃/被杀
      //   exitCode === 0 -> guest 自己 shutdown (正常关机)
      //   exitCode / cleanStop 都缺失 -> 这台 VM 本次会话从未运行过 (未知),
      //     不能当成崩溃, 否则每次刷新/首次打开都会给一台"干净停止"的机器
      //     套上灰屏滤镜, 看起来像是状态刷新错了。
      const crashed = (typeof exitCode === 'number' && exitCode !== 0);
      const clean = !crashed || cleanStop === true || view.expectCleanStop === true;
      setStoppedAppearance(vmName, clean ? 'black' : 'gray');
    } else if (st === 'running' || st === 'starting' || st === 'paused') {
      view.expectCleanStop = false;
      setStoppedAppearance(vmName, null);
    }
  }

  // 与服务器断开连接 (服务端关机 / 重启 / 网络中断):
  // 正在运行或暂停中的 VM 画面转为灰色, 表示"运行中被意外中止"。
  function onConnectionLost() {
    for (const [vmName, view] of views) {
      const st = view.state;
      if (st === 'running' || st === 'paused' || st === 'starting') {
        setStoppedAppearance(vmName, 'gray');
      }
    }
  }

  function startCursorBlink(vmName) {
    const view = getView(vmName);
    if (view.cursorTimer) return;
    view.cursorTimer = setInterval(() => {
      view.cursorBlinkOn = !view.cursorBlinkOn;
      paintCursor(vmName);
    }, 500);
  }

  function paintCursor(vmName) {
    _schedulePaint(vmName);
  }

  function paintCell(ctx, x, y, cell, cw, ch) {
    const [bg, fg, ch_] = cell;
    const px = x * cw, py = y * ch;
    const bgCSS = colorToCSS(bg);
    const fgCSS = colorToCSS(fg);

    // 先填充背景
    ctx.fillStyle = bgCSS;
    ctx.fillRect(px, py, cw, ch);

    if (!ch_ || ch_ === ' ') return;

    // hex font: 用位图精确渲染 (逐像素段 fillRect)
    if (hexFont) {
      const cp = ch_.codePointAt(0);
      const glyph = hexFont.get(cp);
      if (glyph) {
        const gw = glyph.width;
        const bytes = glyph.bytes;
        const rowBytes = gw / 8;
        ctx.fillStyle = fgCSS;
        // 逐行绘制连续像素段 (减少 fillRect 调用)
        for (let row = 0; row < ch; row++) {
          let segStart = -1;
          for (let col = 0; col <= gw; col++) {
            const isOn = col < gw ? ((bytes[row * rowBytes + (col >> 3)] >> (7 - (col & 7))) & 1) : 0;
            if (isOn && segStart === -1) {
              segStart = col;
            } else if (!isOn && segStart !== -1) {
              ctx.fillRect(px + segStart, py + row, col - segStart, 1);
              segStart = -1;
            }
          }
        }
        return;
      }
    }

    // 备用渲染: TTF fillText
    ctx.fillStyle = fgCSS;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(ch_, px + cw / 2, py + ch / 2);
  }

  function colorToCSS(c) {
    if (c == null) return '#000';
    if (typeof c === 'number') {
      const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
      return `rgb(${r},${g},${b})`;
    }
    return String(c);
  }

  // ---------- 输入事件 ----------
  function sendInput(vmName, ev) {
    // wsSend 在连接不可用时返回 false。输入 (键盘/鼠标/滚轮) 全部走这条通道,
    // 显式告警一次: 静默丢弃会让"键盘/滚轮无反应"难以定位。
    const ok = App.wsSend({ type: 'c2s.input', ...ev });
    if (ok === false) {
      diag.inputDropped++;
      if (!diag.inputDropWarned) {
        diag.inputDropWarned = true;
        appendLog(vmName, '[frontend] 输入未发送: WebSocket 未连接, 请等待重连后再试', 'warn');
      }
    }
    return ok;
  }

  // ============================================================
  // 滚轮兼容模式
  //
  // 有些鼠标/驱动/工具会把滚轮映射成 PageUp / PageDown 按键, 而不是 wheel 事件
  // (实测: 服务端只收到 {"event":"key_down","code":209}, 页面里根本收不到 wheel)。
  // 这种情况下模拟器永远拿不到 scroll 信号, 客户机自然"滚不动"。
  // 打开本开关后, 当 PageUp/PageDown 落在虚拟机屏幕上时转成 scroll 信号
  // (与真滚轮完全一致), 不把这两个键原样发给客户机。
  // ============================================================
  const WHEEL_KEY_COMPAT_KEY = 'oc-wheel-key-compat';
  function isWheelKeyCompat() {
    try { return localStorage.getItem(WHEEL_KEY_COMPAT_KEY) === '1'; } catch (e) { return false; }
  }
  function setWheelKeyCompat(on) {
    try {
      if (on) localStorage.setItem(WHEEL_KEY_COMPAT_KEY, '1');
      else localStorage.removeItem(WHEEL_KEY_COMPAT_KEY);
    } catch (e) { /* 忽略 */ }
  }

  // 真 wheel 与"滚轮被映射成按键"两条路共用的发送逻辑
  function sendScroll(vmName, x, y, px, py, delta) {
    diag.wheelSent++;
    const sent = sendInput(vmName, { event: 'scroll', x, y, px, py, delta });
    updateWheelStatus();
    // 前几次留痕, 便于和服务端日志对照 (次数用完后再滚就没有反馈, 会让人误判)
    if (diag.wheelSent <= 4) {
      appendLog(vmName,
        `[frontend] 滚轮 x=${x} y=${y} px=${px} py=${py} delta=${delta} 已发送=${sent !== false}`,
        'info');
    }
    return sent;
  }

  function onKey(e, vmName) {
    const view = getView(vmName);
    // 全屏模式下 ESC 仅用于退出全屏, 不转发给 VM
    if (view.isFullscreen && e.key === 'Escape') {
      e.preventDefault();
      return;
    }
    // 兼容模式: 把被映射成 PageUp/PageDown 的滚轮当成真滚轮
    if (isWheelKeyCompat() && (e.code === 'PageUp' || e.code === 'PageDown')) {
      e.preventDefault();
      if (e.type === 'keydown' && !e.repeat) {
        // 上 = +1, 下 = -1, 与真 wheel 约定一致
        const delta = (e.code === 'PageUp') ? 1 : -1;
        const pt = view.lastPt || { x: view.w >> 1, y: view.h >> 1, px: (view.w >> 1) * 6, py: (view.h >> 1) * 9 };
        sendScroll(vmName, pt.x, pt.y, pt.px, pt.py, delta);
      }
      return;  // keyup 一并吞掉, 避免发出悬空的 key_up
    }
    // 转发为 key_down / key_up
    // OC 信号格式: key_down(address, char:number, code:number, playerName)
    const code = mapKeyCode(e);
    if (code == null) return;
    e.preventDefault();
    // char 是字符的 Unicode 码点 (数字), 无字符则为 0
    const charCode = (e.key && e.key.length === 1) ? e.key.charCodeAt(0) : 0;
    sendInput(vmName, { event: e.type === 'keyup' ? 'key_up' : 'key_down', char: charCode, code });
  }

  function onKeyPress(e, vmName) {
    // 浏览器 keypress 已废弃, 转为 key_down + key_up
    if (!e.charCode) return;
    e.preventDefault();
    sendInput(vmName, { event: 'key_down', char: e.charCode, code: e.charCode });
    sendInput(vmName, { event: 'key_up',   char: e.charCode, code: e.charCode });
  }

  function onMouse(e, vmName, evName) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) return;
    const rect = view.canvas.getBoundingClientRect();
    // getBoundingClientRect 已反映 CSS transform 缩放后的实际渲染尺寸
    const realCharW = rect.width / view.w;
    const realCharH = rect.height / view.h;
    const x = Math.max(1, Math.min(view.w, Math.floor((e.clientX - rect.left) / realCharW) + 1));
    const y = Math.max(1, Math.min(view.h, Math.floor((e.clientY - rect.top) / realCharH) + 1));
    const btn = e.button === 0 ? 0 : e.button === 2 ? 1 : 2;
    // 精确像素坐标 (OC 标准: 每字符 6x9 像素)
    // 计算鼠标在当前字符内的相对位置 (0-1)
    const fx = (e.clientX - rect.left) / realCharW - (x - 1);
    const fy = (e.clientY - rect.top) / realCharH - (y - 1);
    // 像素坐标: 1-based, 总像素 = 字符数 * 每字符像素数
    const px = Math.max(1, Math.min(view.w * 6, (x - 1) * 6 + Math.floor(fx * 6) + 1));
    const py = Math.max(1, Math.min(view.h * 9, (y - 1) * 9 + Math.floor(fy * 9) + 1));
    // 记住鼠标在屏幕内的最后位置: 兼容模式下 PageUp/PageDown 没有坐标, 用这个位置滚
    view.lastPt = { x, y, px, py };
    sendInput(vmName, { event: evName, x, y, px, py, btn });
  }

  function onWheel(e, vmName) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) {
      diag.wheelSkipped++;
      appendLog(vmName, `[frontend] onWheel skipped: canvas=${!!view.canvas} w=${view.w} h=${view.h}`, 'warn');
      return;
    }
    const rect = view.canvas.getBoundingClientRect();
    const realCharW = rect.width / view.w;
    const realCharH = rect.height / view.h;
    const x = Math.max(1, Math.min(view.w, Math.floor((e.clientX - rect.left) / realCharW) + 1));
    const y = Math.max(1, Math.min(view.h, Math.floor((e.clientY - rect.top) / realCharH) + 1));
    // 精确像素坐标 (OC 标准: 每字符 6x9 像素)
    const fx = (e.clientX - rect.left) / realCharW - (x - 1);
    const fy = (e.clientY - rect.top) / realCharH - (y - 1);
    const px = Math.max(1, Math.min(view.w * 6, (x - 1) * 6 + Math.floor(fx * 6) + 1));
    const py = Math.max(1, Math.min(view.h * 9, (y - 1) * 9 + Math.floor(fy * 9) + 1));
    // OC scroll 信号: scroll(address, x, y, direction, playerName)
    // 官方约定: direction 正值 = 向上滚动, 负值 = 向下滚动。
    // 浏览器 wheel 事件的 deltaY > 0 表示"向下滚", 方向与 OC 相反, 因此取反。
    // 参考 OpenOS bin/edit.lua 的消费方式:
    //   onScroll(direction) -> setCursor(cbx, cby - direction * 12)
    // 注意: x/y 坐标空间与 touch 信号保持一致 (精确模式下用像素坐标)。
    const delta = e.deltaY < 0 ? 1 : -1;
    view.lastPt = { x, y, px, py };
    sendScroll(vmName, x, y, px, py, delta);
  }

  function mapKeyCode(e) {
    // OC 键码 = PS/2 扫描码 (OpenOS keyboard.lua 使用)
    const map = {
      'Escape': 0x01, 'Backspace': 0x0E, 'Enter': 0x1C, 'Tab': 0x0F,
      'Home': 0xC7, 'End': 0xCF, 'ArrowUp': 0xC8, 'ArrowDown': 0xD0,
      'ArrowLeft': 0xCB, 'ArrowRight': 0xCD, 'Delete': 0xD3,
      'PageUp': 0xC9, 'PageDown': 0xD1, 'Space': 0x39,
      'ShiftLeft': 0x2A, 'ShiftRight': 0x36,
      'ControlLeft': 0x1D, 'ControlRight': 0x9D,
      'AltLeft': 0x38, 'AltRight': 0xB8,
      'CapsLock': 0x3A, 'NumLock': 0x45, 'ScrollLock': 0x46,
      'ContextMenu': 0x5D, 'Insert': 0xD2,
      'Numpad0': 0x52, 'Numpad1': 0x4F, 'Numpad2': 0x50, 'Numpad3': 0x51,
      'Numpad4': 0x4B, 'Numpad5': 0x4C, 'Numpad6': 0x4D, 'Numpad7': 0x47,
      'Numpad8': 0x48, 'Numpad9': 0x49,
      'NumpadAdd': 0x4E, 'NumpadSubtract': 0x4A,
      'NumpadMultiply': 0x37, 'NumpadDivide': 0xB5,
      'NumpadDecimal': 0x53, 'NumpadEnter': 0x9C,
      // 字母键 (PS/2 set 1 扫描码)
      'KeyA': 0x1E, 'KeyB': 0x30, 'KeyC': 0x2E, 'KeyD': 0x20, 'KeyE': 0x12,
      'KeyF': 0x21, 'KeyG': 0x22, 'KeyH': 0x23, 'KeyI': 0x17, 'KeyJ': 0x24,
      'KeyK': 0x25, 'KeyL': 0x26, 'KeyM': 0x32, 'KeyN': 0x31, 'KeyO': 0x18,
      'KeyP': 0x19, 'KeyQ': 0x10, 'KeyR': 0x13, 'KeyS': 0x1F, 'KeyT': 0x14,
      'KeyU': 0x16, 'KeyV': 0x2F, 'KeyW': 0x11, 'KeyX': 0x2D, 'KeyY': 0x15,
      'KeyZ': 0x2C,
      // 数字键
      'Digit0': 0x0B, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
      'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
      'Digit8': 0x09, 'Digit9': 0x0A,
      // 符号键
      'Minus': 0x0C, 'Equal': 0x0D, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
      'Backslash': 0x2B, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
      'Comma': 0x33, 'Period': 0x34, 'Slash': 0x35,
    };
    if (map[e.code] != null) return map[e.code];
    if (e.code && e.code.startsWith('F')) {
      const n = parseInt(e.code.substring(1), 10);
      if (n >= 1 && n <= 12) return 0x3A + n;  // F1=0x3B, F2=0x3C, ...
    }
    // 未知可打印字符: 用 0 作为 code, 仅靠 char 字段传递
    if (e.key && e.key.length === 1) {
      return 0;
    }
    return null;
  }

  // ---------- 服务器消息路由 ----------
  function onServerMessage(msg) {
    if (!msg.vm) return;
    const view = getView(msg.vm);

    if (msg.type === 's2c.state') {
      appendLog(msg.vm, `[state] ${msg.state}${msg.exitCode != null ? ' (exit=' + msg.exitCode + ')' : ''}`);
      // 状态、按钮可用性与停止后的画面表现统一交由 applyServerState 处理。
      // 注意 expectCleanStop 在停止过程中不会被重置 (一次停止可能先后推送多条
      // "stopped", 重置会让后一条把黑屏翻回灰屏), 只在重新运行/启动时清除。
      applyServerState(msg.vm, msg.state, msg.exitCode, msg.cleanStop);
    } else if (msg.type === 's2c.screen') {
      paintScreen(msg.vm, msg);
    } else if (msg.type === 's2c.log') {
      appendLog(msg.vm, msg.msg, msg.level);
    }
  }

  function appendLog(vmName, text, level = 'info') {
    const view = getView(vmName);
    if (!view.logPanel) return;
    const div = document.createElement('div');
    div.className = 'log-line ' + level;
    div.textContent = text;
    view.logPanel.appendChild(div);
    // 存入数组供导出使用
    if (!view.logLines) view.logLines = [];
    view.logLines.push({ text, level, time: Date.now() });
    // 滚动到底部
    view.logPanel.scrollTop = view.logPanel.scrollHeight;
    // 限制 1000 行
    while (view.logPanel.children.length > 1000) {
      view.logPanel.removeChild(view.logPanel.firstChild);
      view.logLines.shift();
    }
  }

  function toggleLogPanel(vmName) {
    const view = getView(vmName);
    if (!view.logContainer) return;
    view.logMinimized = !view.logMinimized;
    view.logContainer.style.display = view.logMinimized ? 'none' : '';
    const handle = document.getElementById(`log-show-handle-${cssEsc(vmName)}`);
    if (handle) handle.style.display = view.logMinimized ? '' : 'none';
  }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // 滚轮自检 (文档级, 捕获阶段, 被动: 只统计, 绝不干预其它逻辑)
  //
  // 用来把两种完全不同的情况分开:
  //   a) 浏览器根本没把 wheel 事件投递给页面 —— 操作系统/窗口焦点层面的事
  //      (例如 Windows 未开启"在我悬停的窗口上滚动", 且浏览器窗口没有焦点,
  //       或者输入设备的手势被系统/其它程序吃掉)。这种情况页面里任何代码都救不了。
  //   b) 事件投递到了页面, 但没有落在虚拟机的监听区域 (布局/命中范围问题)。
  //
  // 结果实时显示在底部状态栏右下角, 滚动时数字会立刻变化 —— 不需要看日志,
  // 也不需要开控制台。完整计数在控制台执行 Console.diag 查看。
  // 不用"只打印前 N 次"的做法: 次数用完后再滚就没有任何反馈, 反而让人以为没生效。
  // ============================================================
  function updateWheelStatus() {
    const el = document.getElementById('status-right');
    if (!el) return;
    el.textContent = `滚轮: 页面收到 ${diag.wheelSeen} / 已发给虚拟机 ${diag.wheelSent}`
      + ` · 最近落点${diag.wheelInside ? '在虚拟机区域' : '在其它区域'}`;
  }

  document.addEventListener('wheel', (e) => {
    diag.wheelSeen++;
    const tgt = e.target;
    diag.wheelInside = !!(tgt && tgt.closest && tgt.closest('[data-oc-wheel-bound]'));
    // 第一次收到时在日志面板也留一行 (方便对照服务端日志)
    if (diag.wheelSeen === 1 && lastVmName) {
      appendLog(lastVmName,
        `[frontend] 浏览器已投递滚轮事件 (落点在虚拟机区域内=${diag.wheelInside})`,
        'info');
    }
    updateWheelStatus();
  }, { capture: true, passive: true });

  // 页面加载时异步加载 hexfont, 加载完成后自动重绘
  loadHexFont();

  return { renderVMView, onServerMessage, loadHexFont, onConnectionLost, applyServerState, reloadView, diag, isWheelKeyCompat, setWheelKeyCompat };
})();

window.Console = Console;
