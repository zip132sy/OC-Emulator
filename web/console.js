// ============================================================
// console.js - VM console (canvas rendering + toolbar + hardware panel)
//
// Screen payloads (s2c.screen from vmManager):
//   full:  { w, h, cells: [[bg,fg,char],...] }  length = w*h
//   dirty: { dirty: [[x,y,bg,fg,char],...] }   incremental, x/y are 1-based
// ============================================================

const Console = (() => {
  // OC 16-color palette (0xRRGGBB)
  const PALETTE = [
    0x000000, 0xff3333, 0x33ff33, 0xffff33,
    0x3333ff, 0xff33ff, 0x33ffff, 0xffffff,
    0x666666, 0xff6666, 0x66ff66, 0xffff66,
    0x6666ff, 0xff66ff, 0x66ffff, 0xd0d0d0,
  ];

  // ---------- Bitmap Font (OC hexfont) ----------
  // OC uses GNU Unifont .hex bitmap fonts: 8x16 or 16x16 pixels per glyph
  let hexFont = null; // Map<codePoint, {width: 8|16, bytes: Uint8Array}>
  let glyphCache = null; // Map<codePoint, HTMLCanvasElement> pre-rendered glyphs

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
      // Repaint every visible VM once the font is loaded
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

  // Get the pre-rendered glyph canvas (created and cached on demand)
  function getGlyphCanvas(cp) {
    const cached = glyphCache.get(cp);
    if (cached) return cached;
    const glyph = hexFont.get(cp) || hexFont.get(0x20);
    if (!glyph) return null;
    // Offscreen canvas with a white glyph on transparent background (used as an alpha mask)
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
    // Bound the cache size
    if (glyphCache.size > 3000) {
      // Keep the common ASCII range and evict the rest
      for (const key of glyphCache.keys()) {
        if (key > 127) glyphCache.delete(key);
      }
    }
    return cv;
  }

  // Wide-glyph lookup cache (avoids hitting hexFont on every call)
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

  // VM view cache: vmName -> { canvas, ctx, offscreen, offCtx, w, h, cells, charW, charH, logLines }
  const views = new Map();

  // Warn only once when the WebSocket is unavailable, to keep the log readable
  let inputDropWarned = false;

  // FPS overlay (client preference persisted in localStorage)
  const SHOW_FPS_KEY = 'oc-show-fps';
  let showFps = false;
  try { showFps = localStorage.getItem(SHOW_FPS_KEY) === '1'; } catch (e) { /* ignore */ }

  function isShowFps() { return showFps; }

  function setShowFps(on) {
    showFps = !!on;
    try {
      if (showFps) localStorage.setItem(SHOW_FPS_KEY, '1');
      else localStorage.removeItem(SHOW_FPS_KEY);
    } catch (e) { /* ignore */ }
    views.forEach((view) => {
      if (view.fpsEl) view.fpsEl.style.display = showFps ? '' : 'none';
      view._fpsFrames = 0;
    });
  }

  // ---------- Frontend logging ----------
  // Shares the Log level setting:
  //   full  -> render stats plus wheel and input diagnostics
  //   error -> errors only (default)
  //   off   -> everything off
  const LOG_RANK = { off: 0, error: 1, full: 2 };
  const diag = { wheelSeen: 0, wheelSent: 0, wheelSkipped: 0, wheelInside: false, inputDropped: 0 };
  let _renderStats = { since: Date.now(), frames: 0, cells: 0, full: 0 };

  function logRank() {
    const lv = (window.App && App.state && App.state.logLevel) || 'error';
    const rank = LOG_RANK[lv];
    return rank == null ? 1 : rank;
  }

  function flog(level, ...args) {
    const rank = logRank();
    if (rank === 0) return;
    if (level === 'debug' && rank < 2) return;
    console.log('[oc]', ...args);
  }

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
        stoppedAppearance: null,  // null | 'black' (clean shutdown) | 'gray' (abnormal stop)
        expectCleanStop: false,   // A user-pressed stop/restart counts as a clean shutdown
      });
    }
    return views.get(vmName);
  }

  function renderVMView(pane, vmName) {
    const view = getView(vmName);
    const t = I18N.t;
    flog('debug', 'render view:', vmName);
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
            <div class="vmouse-pointer" id="vmouse-pointer-${cssEsc(vmName)}" aria-hidden="true"></div>
            <div class="paused-overlay" id="paused-overlay-${cssEsc(vmName)}" style="display:none;">
              <div class="paused-text">${t('paused.overlay')}</div>
              <div class="paused-hint">${t('paused.overlay.hint')}</div>
            </div>
            <div class="restarting-overlay" id="restarting-overlay-${cssEsc(vmName)}" style="display:none;">
              <div class="restarting-spinner"></div>
              <div class="restarting-text">${t('restarting.overlay')}</div>
              <div class="restarting-hint">${t('restarting.overlay.hint')}</div>
            </div>
            <div class="fps-overlay" id="fps-${cssEsc(vmName)}" style="display:none;">0 FPS</div>
          </div>
          <button class="fs-btn" id="fs-btn-${cssEsc(vmName)}" title="${t('fs.btn.title')}">${t('fs.btn')}</button>
          <button class="ime-btn" id="ime-btn-${cssEsc(vmName)}" title="${t('ime.btn.title')}">${t('ime.btn')}</button>
          <textarea class="ime-input" id="ime-input-${cssEsc(vmName)}" rows="1" enterkeyhint="enter" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-hidden="true"></textarea>
          <div class="scroll-pad" id="scroll-pad-${cssEsc(vmName)}">
            <button class="scroll-btn" id="scroll-up-${cssEsc(vmName)}" title="${t('scroll.up.title')}" aria-label="${t('scroll.up.title')}">▲</button>
            <button class="scroll-btn" id="scroll-down-${cssEsc(vmName)}" title="${t('scroll.down.title')}" aria-label="${t('scroll.down.title')}">▼</button>
          </div>
          <button class="vkbd-btn" id="vkbd-btn-${cssEsc(vmName)}" title="${t('vkbd.btn.title')}">${t('vkbd.btn')}</button>
          <button class="vmouse-btn" id="vmouse-btn-${cssEsc(vmName)}" title="${t('vmouse.btn.title')}" aria-label="${t('vmouse.btn.title')}" aria-pressed="false">${t('vmouse.btn')}</button>
          <div class="vkbd" id="vkbd-${cssEsc(vmName)}" aria-hidden="true">
            <div class="vkbd-head">
              <span class="vkbd-title">${t('vkbd.title')}</span>
              <span class="vkbd-hint">${t('vkbd.hint')}</span>
              <button class="vkbd-close" id="vkbd-close-${cssEsc(vmName)}" title="${t('vkbd.close.title')}">✕</button>
            </div>
            <div class="vkbd-rows" id="vkbd-rows-${cssEsc(vmName)}"></div>
          </div>
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
    view.imeBtn = pane.querySelector(`#ime-btn-${cssEsc(vmName)}`);
    view.imeInput = pane.querySelector(`#ime-input-${cssEsc(vmName)}`);
    view.vkbdBtn = pane.querySelector(`#vkbd-btn-${cssEsc(vmName)}`);
    view.vkbdPanel = pane.querySelector(`#vkbd-${cssEsc(vmName)}`);
    view.vkbdRows = pane.querySelector(`#vkbd-rows-${cssEsc(vmName)}`);
    view.vkbdClose = pane.querySelector(`#vkbd-close-${cssEsc(vmName)}`);
    view.vmouseBtn = pane.querySelector(`#vmouse-btn-${cssEsc(vmName)}`);
    view.vmousePointer = pane.querySelector(`#vmouse-pointer-${cssEsc(vmName)}`);
    view.fpsEl = pane.querySelector(`#fps-${cssEsc(vmName)}`);
    if (view.fpsEl) view.fpsEl.style.display = showFps ? '' : 'none';

    // Log panel minimize / expand
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
    // On phones the log is a bottom drawer, collapsed by default so it does not cover half the canvas
    const isPhone = !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    if (view.logMinimized === undefined) view.logMinimized = isPhone;
    if (view.logContainer) view.logContainer.style.display = view.logMinimized ? 'none' : '';
    if (showHandle) showHandle.style.display = view.logMinimized ? '' : 'none';

    pane.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onToolbarAction(btn.dataset.action, vmName));
    });

    // Refresh once from the known state after a tab rebuild: button availability and the
    // "stopped" look, because the freshly created canvas still needs its black/gray fill.
    updateStateBadge(vmName);
    applyStoppedVisual(vmName);

    // Keyboard forwarding (keydown/keyup; keypress is deprecated)
    view.canvas.setAttribute('tabindex', '0');
    view.canvas.addEventListener('keydown', (e) => onKey(e, vmName));
    view.canvas.addEventListener('keyup', (e) => onKey(e, vmName));
    // Mouse events: down/up/move/wheel, all with preventDefault, plus context-menu suppression
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
      // Throttle drag events through requestAnimationFrame so fast moves do not stall
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
    // Window-level mouseup: catches releases that happen outside the canvas
    window.addEventListener('mouseup', (e) => {
      if (view._mouseDown) {
        view._mouseDown = false;
        onMouse(e, vmName, 'drop');
      }
    });
    view.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Wheel: bound to the whole VM pane (toolbar, screen, canvas margins), excluding only the log panel.
    //
    // Browsers hit-test wheel events, so binding only .console-canvas-wrap means a slightly off
    // pointer (canvas margin or toolbar) lands outside the listener and looks like "the wheel is dead".
    // Hence the whole pane, with the log panel excluded so the wheel can still scroll the log.
    // Bind once: renderVMView runs repeatedly, and duplicate bindings emit several scroll signals per notch.
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

    // Touch: browsers synthesize only late mouse events on touch screens, so drags never produce
    // mousemove. Map touchstart/touchmove/touchend to touch/drag/drop instead. Calling
    // preventDefault in touchstart also suppresses the duplicate mouse events and page scroll/zoom.
    const findTouch = (list, id) => {
      for (let i = 0; i < (list ? list.length : 0); i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    };
    view.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      e.preventDefault();
      view._touchId = touch.identifier;
      // Focus the canvas on tap (which also dismisses the soft keyboard if it is open)
      try { view.canvas.focus({ preventScroll: true }); } catch (err) { view.canvas.focus(); }
      // Virtual mouse: the finger only moves the crosshair, the click is sent on release
      if (view.vmouseOn) {
        view._pressPoint = null;
        view._lpFired = false;
        startVirtualMouse(view, vmName, touch);
        return;
      }
      // Fullscreen + running: defer the press; holding long enough emits right click, a quick release emits left
      if (isRightClickGesture(view)) {
        view._pressPoint = { x: touch.clientX, y: touch.clientY };
        view._lpFired = false;
        clearLongPress(view);
        view._lpTimer = setTimeout(() => {
          view._lpTimer = null;
          if (!view._pressPoint) return;
          const p = view._pressPoint;
          view._pressPoint = null;
          view._lpFired = true;
          sendTouchAt(vmName, p.x, p.y, 'touch', 1);
          sendTouchAt(vmName, p.x, p.y, 'drop', 1);
        }, LONG_PRESS_MS);
        return;
      }
      view._pressPoint = null;
      view._lpFired = false;
      onTouch(touch, vmName, 'touch');
    }, { passive: false });
    view.canvas.addEventListener('touchmove', (e) => {
      if (view._touchId == null) return;
      if (view._lpFired) return; // Right click already sent; this touch must not become a drag
      const touch = findTouch(e.changedTouches, view._touchId) || e.touches[0];
      if (!touch) return;
      e.preventDefault();
      if (view.vmouseOn) {
        moveVirtualMouse(view, vmName, touch);
        return;
      }
      // Press not sent yet: past the threshold it becomes a drag, so send the left press first
      if (view._pressPoint) {
        const dx = touch.clientX - view._pressPoint.x;
        const dy = touch.clientY - view._pressPoint.y;
        if (dx * dx + dy * dy <= LONG_PRESS_DIST * LONG_PRESS_DIST) return;
        clearLongPress(view);
        const p = view._pressPoint;
        view._pressPoint = null;
        sendTouchAt(vmName, p.x, p.y, 'touch');
      }
      // Coalesce per frame like mouse drags, so fast moves do not flood the socket
      if (view._touchPending) {
        view._touchMoveEvent = touch;
        return;
      }
      view._touchPending = true;
      view._touchMoveEvent = touch;
      requestAnimationFrame(() => {
        view._touchPending = false;
        if (view._touchMoveEvent && view._touchId != null) {
          onTouch(view._touchMoveEvent, vmName, 'drag');
        }
        view._touchMoveEvent = null;
      });
    }, { passive: false });
    view.canvas.addEventListener('touchend', (e) => {
      const touch = findTouch(e.changedTouches, view._touchId);
      if (!touch) return;
      e.preventDefault();
      if (view.vmouseOn) {
        // endVirtualMouse clears the pending move itself and flushes it as a drag
        view._touchId = null;
        view._pressPoint = null;
        view._lpFired = false;
        endVirtualMouse(view, vmName, touch);
        return;
      }
      view._touchId = null;
      view._touchPending = false;
      view._touchMoveEvent = null;
      clearLongPress(view);
      if (view._lpFired) {
        view._lpFired = false;
        view._pressPoint = null;
        return;
      }
      if (view._pressPoint) {
        // Below the long-press duration: a single left click
        view._pressPoint = null;
        sendTouchAt(vmName, touch.clientX, touch.clientY, 'touch');
        sendTouchAt(vmName, touch.clientX, touch.clientY, 'drop');
        return;
      }
      onTouch(touch, vmName, 'drop');
    }, { passive: false });
    view.canvas.addEventListener('touchcancel', () => {
      view._touchId = null;
      view._touchPending = false;
      view._touchMoveEvent = null;
      view._pressPoint = null;
      view._lpFired = false;
      clearLongPress(view);
      cancelVirtualMouse(view);
    });
    // Double click:
    // - not fullscreen: enter fullscreen
    // - fullscreen and not running/erroring: leave fullscreen
    // - fullscreen while running: do not toggle (two taps are two left clicks, long press is right click)
    view.canvas.addEventListener('dblclick', (e) => {
      const view = getView(vmName);
      if (!view.isFullscreen) {
        e.preventDefault();
        toggleFullscreen(vmName);
      } else if (view.state !== 'running') {
        e.preventDefault();
        toggleFullscreen(vmName);
      }
      // Fullscreen and running: do not intercept, pass the double click to the guest
    });

    const fsBtn = pane.querySelector(`#fs-btn-${cssEsc(vmName)}`);
    if (fsBtn) {
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen(vmName);
      });
    }

    bindImeInput(view, vmName);
    bindVirtualKeyboard(view, vmName);
    bindVirtualMouse(view, vmName);

    // Virtual wheel: shown in touch fullscreen, scrolls at the pointer's last position
    const scrollUpBtn = pane.querySelector(`#scroll-up-${cssEsc(vmName)}`);
    const scrollDownBtn = pane.querySelector(`#scroll-down-${cssEsc(vmName)}`);
    if (scrollUpBtn) {
      scrollUpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendScrollAtPointer(vmName, 1);
      });
    }
    if (scrollDownBtn) {
      scrollDownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendScrollAtPointer(vmName, -1);
      });
    }

    // On resize, refit the canvas and repaint every cell
    view._resizeHandler = () => {
      // Re-evaluate the CSS-rotation fallback after a phone rotation
      syncFsRotation(vmName);
      fitCanvasToContainer(vmName);
      repaintAll(vmName);
    };
    window.addEventListener('resize', view._resizeHandler);

    reloadView(vmName);

    setTimeout(() => {
      view.canvas.focus();
      fitCanvasToContainer(vmName);
      repaintAll(vmName);
    }, 100);
  }

  // Re-fetch authoritative state and the latest frame from the server.
    // Called when a tab opens and by the toolbar Refresh button, to force a sync
    // after a WebSocket drop or a lost state message.
  function reloadView(vmName) {
    const view = getView(vmName);
    return App.api(`vms/${encodeURIComponent(vmName)}/state`).then(s => {
      if (!s || !view) return null;
      view.state = s.state || 'stopped';
      updateStateBadge(vmName);
      const isStopped = (view.state === 'stopped' || view.state === 'error');
      // Never repaint a stopped VM's stale last frame: it would cover the black/gray look
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
    // Enable / disable buttons
    const start = document.getElementById(`btn-start-${cssEsc(vmName)}`);
    const stop = document.getElementById(`btn-stop-${cssEsc(vmName)}`);
    const pause = document.getElementById(`btn-pause-${cssEsc(vmName)}`);
    const restart = document.getElementById(`btn-restart-${cssEsc(vmName)}`);
    const isRunning = (view.state === 'running' || view.state === 'paused');
    const isBusy = (view.state === 'starting');  // asynchronous transitions such as restarting
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
    // Pause overlay
    const overlay = document.getElementById(`paused-overlay-${cssEsc(vmName)}`);
    if (overlay) {
      overlay.style.display = (view.state === 'paused') ? 'flex' : 'none';
    }
    // Reboot overlay: shown while state === 'starting'; the canvas is cleared because the old frame no longer matches
    const restartingOverlay = document.getElementById(`restarting-overlay-${cssEsc(vmName)}`);
    if (restartingOverlay) {
      const showRestarting = (view.state === 'starting');
      if (showRestarting) {
        // Clear the canvas so the stale frame cannot mislead
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
      // Optimistic UI: disable Start immediately to block double clicks
      const view = getView(vmName);
      view.state = 'running';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/start`, { method: 'POST' });
      } catch (e) {
        view.state = 'stopped';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] ${I18N.t('log.start-failed')}${e.message}`, 'error');
      }
      App.wsSubscribe(vmName);
    } else if (action === 'stop') {
      // Optimistic UI: show the stopping state immediately to block double clicks
      const view = getView(vmName);
      const wasRunning = view.state;
      view.expectCleanStop = true;   // User-initiated stop -> render as a clean shutdown (black)
      view.state = 'stopped';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' });
      } catch (e) {
        view.expectCleanStop = false;
        view.state = wasRunning;
        updateStateBadge(vmName);
        appendLog(vmName, `[error] ${I18N.t('log.stop-failed')}${e.message}`, 'error');
      }
    } else if (action === 'pause') {
      // Optimistic UI: show the paused state immediately
      const view = getView(vmName);
      view.state = 'paused';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/pause`, { method: 'POST' });
      } catch (e) {
        view.state = 'running';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] ${I18N.t('log.pause-failed')}${e.message}`, 'error');
      }
    } else if (action === 'resume') {
      // Optimistic UI: show the running state immediately
      const view = getView(vmName);
      view.state = 'running';
      updateStateBadge(vmName);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/resume`, { method: 'POST' });
      } catch (e) {
        view.state = 'paused';
        updateStateBadge(vmName);
        appendLog(vmName, `[error] ${I18N.t('log.resume-failed')}${e.message}`, 'error');
      }
    } else if (action === 'restart') {
      // Optimistic UI: show restarting through the temporary 'starting' state, which disables run/pause
      const view = getView(vmName);
      view.expectCleanStop = true;   // The stop phase of a restart also counts as a clean shutdown
      view.state = 'starting';
      updateStateBadge(vmName);
      appendLog(vmName, `[info] ${I18N.t('log.restarting')}${vmName}...`);
      try {
        await App.api(`vms/${encodeURIComponent(vmName)}/restart`, { method: 'POST' });
        // The server pushes s2c.state for a restart, so do not guess the final state here
      } catch (e) {
        appendLog(vmName, `[error] ${I18N.t('log.restart-failed')}${e.message}`, 'error');
        // On failure, fetch the real state from the server
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
          title: `${vmName} / ${I18N.t('hw.disk1')}`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert(I18N.t('hw.no-disk1'));
      }
    } else if (action === 'edit-disk2') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      const f = cfg?.hardware?.disk2;
      if (f) {
        App.openTab({
          id: 'disk-' + vmName + '-disk2',
          type: 'disk-editor',
          title: `${vmName} / ${I18N.t('hw.disk2')}`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert(I18N.t('hw.no-disk2'));
      }
    } else if (action === 'edit-floppy') {
      const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
      const f = cfg?.hardware?.floppy;
      if (f) {
        App.openTab({
          id: 'disk-' + vmName + '-floppy',
          type: 'disk-editor',
          title: `${vmName} / ${I18N.t('hw.floppy')}`,
          vm: vmName,
          diskPath: `vms/${vmName}/${f}`,
        });
      } else {
        alert(I18N.t('hw.no-floppy'));
      }
    }
  }

  // Floppy size dialog: resolves to Promise<number|null>, null when cancelled
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
              <input type="number" id="floppy-custom-size" min="0.001" step="0.001" placeholder="MB" style="width:140px;">
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
        let size = 524288; // default 512 KB
        if (checked) {
          if (checked.value === 'custom') {
            const mb = parseFloat(document.querySelector('#floppy-custom-size').value);
            if (!isFinite(mb) || mb <= 0) {
              alert(t('hw.floppy-size-invalid'));
              return;
            }
            size = Math.max(1, Math.round(mb * 1024 * 1024));
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

  // New disk dialog: resolves to Promise<{diskName, mirrorPath}|null>
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
            <input type="number" id="new-disk-size-custom" min="0.001" step="0.001" value="4" style="flex:1;">
            <span style="color:var(--muted); font-size:12px; margin-left:6px;">MB</span>
          </div>
          <div class="form-row" id="row-disk-tier">
            <label>${t('hw.disk-tier')}</label>
            <select id="new-disk-tier" style="flex:1;">
              <option value="1">Tier 1 (1 MB)</option>
              <option value="2">Tier 2 (2 MB)</option>
              <option value="3" selected>Tier 3 (4 MB+)</option>
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

      // Mode switch
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

      // T1 / T2 have a fixed capacity; only T3 accepts a custom size (default 4 MB).
      const tierSelect = document.getElementById('new-disk-tier');
      const FIXED_TIER_SIZE = { 1: '1048576', 2: '2097152' };
      const SIZE_TO_TIER = { 1048576: '1', 2097152: '2', 4194304: '3' };
      function syncFromTier() {
        const fixed = FIXED_TIER_SIZE[tierSelect.value];
        if (fixed) {
          sizeSelect.value = fixed;
          sizeSelect.disabled = true;
          sizeCustomRow.style.display = 'none';
        } else {
          sizeSelect.disabled = false;
          if (sizeSelect.value === '1048576' || sizeSelect.value === '2097152') {
            sizeSelect.value = '4194304';
          }
        }
      }
      sizeSelect.addEventListener('change', () => {
        const custom = sizeSelect.value === 'custom';
        sizeCustomRow.style.display = custom ? 'flex' : 'none';
        // A custom capacity always belongs to a T3 disk.
        if (custom) {
          tierSelect.value = '3';
          tierSelect.disabled = true;
        } else {
          tierSelect.disabled = false;
          if (SIZE_TO_TIER[sizeSelect.value]) tierSelect.value = SIZE_TO_TIER[sizeSelect.value];
        }
      });
      tierSelect.addEventListener('change', syncFromTier);
      syncFromTier();

      // Browse folder: the path is typed through a prompt
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

        let size;
        if (tier === 1) {
          size = 1048576;
        } else if (tier === 2) {
          size = 2097152;
        } else {
          size = parseInt(sizeSelect.value, 10);
          if (isNaN(size)) {
            const mb = parseFloat(sizeCustomInput.value);
            if (!isFinite(mb) || mb <= 0) {
              alert(t('hw.disk-size-invalid'));
              return;
            }
            size = Math.max(1, Math.round(mb * 1024 * 1024));
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

    // Fetch the storage device list
    let storage = { eeproms: [], disks: [], floppy: null };
    try {
      storage = await App.api(`vms/${encodeURIComponent(vmName)}/storage`);
    } catch (e) { /* ignore */ }

    // Fetch disk templates (every .ocd under disks/)
    let diskTemplates = [];
    try {
      diskTemplates = await App.api('disks/templates');
    } catch (e) { /* fallback */ }

    // Build dropdown options
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
      { value: 'custom', label: t('hw.option-mem-custom') },
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
    // Signal strength: 1 = isolated (cannot see other VMs), >= 2 = networked
    const strengthOpts = (() => {
      const arr = [
        { value: '', label: t('hw.strength-auto') },
        { value: '1', label: '1 · ' + t('hw.strength-isolated') },
      ];
      for (let s = 2; s <= 16; s++) arr.push({ value: String(s), label: `${s} · ${t('hw.strength-networked')}` });
      return arr;
    })();

    const cur = cfg?.hardware || {};
    // Custom memory size (MB): when set, that dropdown shows "custom"
    const curMemMB = Array.isArray(cur.memoryMB) ? cur.memoryMB : [null, null];
    const memSelectValue = (i) => (curMemMB[i] != null ? 'custom' : (cur.memory || [3, 3])[i]);
    const memInputValue = (i) => (curMemMB[i] != null ? curMemMB[i] : 8);
    const exp = cur.expansion || [null, null, null];
    const disabled = isStopped ? '' : 'disabled';

    // Build the EEPROM option list
    const curEeprom = cur.eeprom || 'built-in';
    const eepromItems = [];
    // Built-in BIOS (cannot be removed)
    eepromItems.push({
      value: 'built-in',
      label: t('hw.option-builtin-bios'),
      removable: false,
      selected: curEeprom === 'built-in',
    });
    // Saved EEPROM files
    for (const e of (storage.eeproms || [])) {
      eepromItems.push({
        value: e.filename,
        label: e.label || e.filename,
        removable: true,
        selected: e.filename === curEeprom,
      });
    }

    // Build the disk option lists
    const disk1Items = [];
    const disk2Items = [];
    // No-mount option
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
    // Append disk templates found under disks/
    for (const tpl of (diskTemplates || [])) {
      // Keep 'openos' for backward compatibility; others use 'disk_template:xxx.ocd'
      const val = tpl.path === 'openos.ocd' ? 'openos' : 'disk_template:' + tpl.path;
      disk1Items.push({
        value: val,
        label: tpl.name + I18N.t('disk.template-suffix'),
        removable: false,
        selected: false,
        isTemplate: true,
      });
      disk2Items.push({
        value: val,
        label: tpl.name + I18N.t('disk.template-suffix'),
        removable: false,
        selected: false,
        isTemplate: true,
      });
    }
    // Make sure disk1/disk2 contain the current value as an option
    if (cur.disk1 && !disk1Items.find(d => d.value === cur.disk1)) {
      disk1Items.push({ value: cur.disk1, label: cur.disk1, removable: false, selected: true });
    }
    if (cur.disk2 && !disk2Items.find(d => d.value === cur.disk2)) {
      disk2Items.push({ value: cur.disk2, label: cur.disk2, removable: true, selected: true });
    }

    // EEPROM options HTML
    const eepromListHTML = eepromItems.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''}" data-value="${escapeAttr(item.value)}" data-removable="${item.removable}">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
        ${item.removable ? `<button class="storage-remove" title="${t('hw.remove')}" data-filename="${escapeAttr(item.value)}">×</button>` : ''}
      </div>
    `).join('');

    // Disk 1 options HTML
    const disk1ListHTML = disk1Items.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''} ${item.isNone ? 'storage-option-none' : ''} ${item.isTemplate ? 'storage-option-template' : ''}" data-value="${escapeAttr(item.value)}" data-slot="disk1">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
      </div>
    `).join('');

    // Disk 2 options HTML
    const disk2ListHTML = disk2Items.map((item, i) => `
      <div class="storage-option ${item.selected ? 'selected' : ''} ${item.isNone ? 'storage-option-none' : ''} ${item.isTemplate ? 'storage-option-template' : ''}" data-value="${escapeAttr(item.value)}" data-slot="disk2" data-removable="${item.removable}">
        <span class="storage-radio">${item.selected ? '◉' : '○'}</span>
        <span class="storage-label">${escapeHTML(item.label)}</span>
        ${item.removable && !item.isNone && !item.isTemplate ? `<button class="storage-remove" title="${t('hw.remove')}" data-filename="${escapeAttr(item.value)}">×</button>` : ''}
      </div>
    `).join('');

    // Floppy options (loaded dynamically from the API)
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
          <div class="hw-value">
            <select id="hw-mem1" ${disabled}>${opts(memOpts, memSelectValue(0))}</select>
            <div id="hw-mem1-mb-row" style="display:${curMemMB[0] != null ? 'flex' : 'none'}; align-items:center; gap:6px; margin-top:6px;">
              <input type="number" id="hw-mem1-mb" min="0.001" step="0.001" value="${memInputValue(0)}" style="width:120px;" ${disabled}>
              <span class="hint">MB</span>
            </div>
          </div>
          <label>${t('hw.mem2')}</label>
          <div class="hw-value">
            <select id="hw-mem2" ${disabled}>${opts(memOpts, memSelectValue(1))}</select>
            <div id="hw-mem2-mb-row" style="display:${curMemMB[1] != null ? 'flex' : 'none'}; align-items:center; gap:6px; margin-top:6px;">
              <input type="number" id="hw-mem2-mb" min="0.001" step="0.001" value="${memInputValue(1)}" style="width:120px;" ${disabled}>
              <span class="hint">MB</span>
            </div>
          </div>
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
                // For a floppy.ocf, match the template name through the label reported by storage
                let floppyDisplay = cur.floppy;
                let templateMatched = false;
                // Look up the template that matches the floppy label
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
                // A floppy that matches no option still needs a "current" entry at the top
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

    // --- EEPROM option interactions ---
    const eepromList = document.querySelector('#hw-eeprom-list');
    if (eepromList) {
      eepromList.addEventListener('click', (e) => {
        // Remove button
        const removeBtn = e.target.closest('.storage-remove');
        if (removeBtn) {
          e.stopPropagation();
          const filename = removeBtn.dataset.filename;
          if (confirm(t('hw.confirm-remove-eeprom').replace('{name}', filename))) {
            App.api(`vms/${encodeURIComponent(vmName)}/eeprom-delete`, {
              method: 'POST',
              body: { filename },
            }).then(() => {
              // Refresh the config and reopen the editor
              App.api(`vms/${encodeURIComponent(vmName)}`).then(newCfg => {
                openHardwareEditor(vmName, newCfg);
              });
            });
          }
          return;
        }
        // Selecting an option
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

    // EEPROM file upload
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
          // Refresh the config and reopen the editor
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

    // --- Memory size: "custom" reveals the MB input ---
    const bindMemRow = (selId, rowId) => {
      const sel = document.querySelector(selId);
      const row = document.querySelector(rowId);
      if (!sel || !row) return;
      const sync = () => { row.style.display = sel.value === 'custom' ? 'flex' : 'none'; };
      sel.addEventListener('change', sync);
      sync();
    };
    bindMemRow('#hw-mem1', '#hw-mem1-mb-row');
    bindMemRow('#hw-mem2', '#hw-mem2-mb-row');

    // --- Disk 2 option interactions ---
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

    // Disk 1 option interactions
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

    // Disk 2: new disk / OpenOS
    const disk2NewBtn = document.querySelector('#hw-disk2-new');
    const disk2OpenosBtn = document.querySelector('#hw-disk2-openos');
    if (disk2NewBtn) disk2NewBtn.addEventListener('click', async () => {
      // Create the disk through the new-disk dialog
      try {
        const result = await askNewDisk(vmName, 'disk2');
        if (!result) return;
        const diskPath = `vms/${vmName}/${result.diskName}`;

        if (result.mode === 'mirror' && result.mirrorPath) {
          // Mirror mode: create an empty disk first, then set the mirror path
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          // Update the config with disk2 + disk2Mirror
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk2: result.diskName, disk2Mirror: result.mirrorPath, disk2Size: result.size, disk2Tier: result.tier } },
          });
        } else {
          // Plain .ocd mode
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk2: result.diskName, disk2Size: result.size, disk2Tier: result.tier } },
          });
        }
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });
    if (disk2OpenosBtn) disk2OpenosBtn.addEventListener('click', async () => {
      // Copy the OpenOS template to disk2
      try {
        // Set disk2 = 'openos' through PUT and let the server do the copy
        await App.api(`vms/${encodeURIComponent(vmName)}`, {
          method: 'PUT',
          body: { hardware: { disk2: 'openos' } },
        });
        const newCfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        openHardwareEditor(vmName, newCfg);
      } catch (e) {
        alert(t('hw.disk-create-fail') + ': ' + e.message);
      }
    });

    // Disk 1: new disk / OpenOS / import
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
            body: { hardware: { disk1: result.diskName, disk1Mirror: result.mirrorPath, disk1Size: result.size, disk1Tier: result.tier } },
          });
        } else {
          await App.api('disks/create', {
            method: 'POST',
            body: { path: diskPath, label: result.label, size: result.size, tier: result.tier },
          });
          await App.api(`vms/${encodeURIComponent(vmName)}`, {
            method: 'PUT',
            body: { hardware: { disk1: result.diskName, disk1Size: result.size, disk1Tier: result.tier } },
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
          // Assign as disk1
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

    // Disk 2 import
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

    // Boot order list
    const bootOrderList = document.querySelector('#hw-boot-order-list');
    // Default order
    const defaultOrder = ['disk1', 'disk2', 'floppy'];
    let bootOrder = cur.bootOrder && Array.isArray(cur.bootOrder) ? [...cur.bootOrder] : [...defaultOrder];
    // Drop entries that are not bootable devices
    bootOrder = bootOrder.filter(d => defaultOrder.includes(d));
    // Append missing devices
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
    // Publish bootOrder on window so saveHardware can read it
    window._bootOrder = bootOrder;

    const saveBtn = document.querySelector('#btn-save-hw');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => saveHardware(vmName, cfg));
    }

    const hotplugBtn = document.querySelector('#btn-hotplug');
    if (hotplugBtn) {
      hotplugBtn.addEventListener('click', () => saveHardware(vmName, cfg, true));
    }

    document.querySelector('.modal-footer button[data-action="modal-close"]')
      .addEventListener('click', () => Modal.close());
  }

  async function saveHardware(vmName, oldCfg, isHotplug = false) {
    const t = I18N.t;
    const patch = { hardware: {} };

    // Collect every field
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    };

    // Read the selected value from a storage-option list
    const getSelectedFromList = (listId) => {
      const list = document.getElementById(listId);
      if (!list) return null;
      const selected = list.querySelector('.storage-option.selected');
      return selected ? selected.dataset.value : null;
    };

    if (!isHotplug) {
      // Everything is editable while stopped
      patch.hardware.apu = { tier: getVal('hw-apu') };
      // Memory: read the MB input when the dropdown is on "custom"
      const oldTiers = Array.isArray(oldCfg?.hardware?.memory) ? oldCfg.hardware.memory : [3, 3];
      const readMem = (i) => {
        const sel = getVal(i === 0 ? 'hw-mem1' : 'hw-mem2');
        if (sel !== 'custom') return { tier: parseFloat(sel), mb: null };
        const mb = Number(getVal(i === 0 ? 'hw-mem1-mb' : 'hw-mem2-mb'));
        if (!Number.isFinite(mb) || mb <= 0) return null;
        return { tier: oldTiers[i] != null ? oldTiers[i] : 3, mb };
      };
      const mem1 = readMem(0);
      const mem2 = readMem(1);
      if (!mem1 || !mem2) {
        alert(t('hw.mem-invalid'));
        return;
      }
      patch.hardware.memory = [mem1.tier, mem2.tier];
      patch.hardware.memoryMB = [mem1.mb, mem2.mb];
      // EEPROM from the option list
      const eepromVal = getSelectedFromList('hw-eeprom-list') || 'built-in';
      patch.hardware.eeprom = eepromVal;
      // A file was selected, so record its label
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
      // Note: screen lives at config.screen, not config.hardware.screen
      patch.screen = { tier: parseInt(getVal('hw-screen'), 10) };
    }

    // Disk 1 from the option list
    const d1Val = getSelectedFromList('hw-disk1-list');
    if (d1Val !== null) {
      patch.hardware.disk1 = d1Val || null;
    }

    // Disk 2 from the option list
    const d2Val = getSelectedFromList('hw-disk2-list');
    patch.hardware.disk2 = d2Val || null;

    // Floppy: read the value before the empty-floppy dialog, since Modal replaces the DOM
    let floppyVal = getVal('hw-floppy') || null;
    // Expansion cards: read before askFloppySize for the same reason
    const exp1 = getVal('hw-exp1') || null;
    const exp2 = getVal('hw-exp2') || null;
    const exp3 = getVal('hw-exp3') || null;

    // Choosing "empty floppy" opens the size picker; cancelling aborts the save
    if (floppyVal === 'empty') {
      const size = await askFloppySize();
      if (!size) {
        // Cancelled: reopen the hardware editor
        const cfg = await App.api(`vms/${encodeURIComponent(vmName)}`);
        if (cfg) openHardwareEditor(vmName, cfg);
        return;
      } else {
        patch.hardware.floppySize = size;
      }
    }
    patch.hardware.floppy = floppyVal;
    patch.hardware.expansion = [exp1, exp2, exp3];
    // Signal strength: empty = auto (follows the card tier)
    const strengthVal = getVal('hw-modem-strength');
    patch.hardware.modemStrength = strengthVal ? parseInt(strengthVal, 10) : null;

    // Boot order
    if (!isHotplug && window._bootOrder) {
      patch.hardware.bootOrder = window._bootOrder;
    }

    // Disk 1: changing it while running crashes the guest, so warn first
    if (isHotplug) {
      if (d1Val !== oldCfg.hardware.disk1) {
        if (!confirm(t('hw.confirm-disk1-remove'))) return;
        patch.hardware.disk1 = d1Val || null;
        // Crash handling: persist the config, then stop the VM
        await App.api(`vms/${encodeURIComponent(vmName)}`, {
          method: 'PUT',
          body: patch,
        });
        await App.api(`vms/${encodeURIComponent(vmName)}/stop`, { method: 'POST' });
        // Show the error dialog
        alert(t('hw.crash-msg').replace('{name}', vmName));
        Modal.close();
        return;
      }
    } else {
      // While stopped disk1 can also change, including unmounting
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
    App.api(`vms/${encodeURIComponent(vmName)}/state`).then(s => {
      if (s) {
        const view = getView(vmName);
        view.state = s.state || 'stopped';
        updateStateBadge(vmName);
      }
    });
  }

  // ---------- Screen rendering ----------
  function resizeCanvas(vmName) {
    const view = getView(vmName);
    if (!view.canvas || !view.canvasStage) return;
    const stage = view.canvasStage;
    const sw = stage.clientWidth - 4;
    const sh = stage.clientHeight - 4;
    if (sw <= 0 || sh <= 0 || !view.w || !view.h) return;

    // Standard OC character aspect ratio: 1:2 (width = height / 2)
    const ratio = 1 / 2;

    // Target CSS pixels per character, so the grid fills the container
    let targetCw = sw / view.w;
    let targetCh = targetCw / ratio;
    if (targetCh * view.h > sh) {
      targetCh = sh / view.h;
      targetCw = targetCh * ratio;
    }

    // Internal resolution: a fixed 8x16 pixels per character (Unifont's native size)
    const cw = 8;
    const ch = 16;

    view.charW = cw; view.charH = ch;
    const dpr = window.devicePixelRatio || 1;

    // Main canvas: DPR-scaled, nearest-neighbor when drawImage runs
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

    // Offscreen canvas: 1:1 pixels, used for bitmap font rendering
    if (!view.offscreen) {
      view.offscreen = document.createElement('canvas');
      view.offCtx = view.offscreen.getContext('2d');
    }
    view.offscreen.width = view.w * cw;
    view.offscreen.height = view.h * ch;
    // ImageData: write pixels directly instead of thousands of fillRect calls
    view.imgData = view.offCtx.createImageData(view.w * cw, view.h * ch);
    view._pixelBuf = view.imgData.data; // Cached reference to avoid repeated property lookups

    // Re-snap the virtual mouse toggle to the resized canvas
    layoutVirtualMouse(vmName);
  }

  // Backward-compatible alias: recompute and repaint
  function fitCanvasToContainer(vmName) {
    resizeCanvas(vmName);
  }

  // ---------- Fullscreen / landscape ----------
  function isTouchDevice() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  // screen.orientation.lock exists only in some browsers (not in iOS Safari)
  function orientationLockSupported() {
    return !!(window.screen && screen.orientation && typeof screen.orientation.lock === 'function');
  }

  function lockLandscape() {
    if (!orientationLockSupported()) return;
    try {
      const p = screen.orientation.lock('landscape');
      if (p && p.catch) p.catch(() => { /* keep the current orientation when the browser refuses */ });
    } catch (e) { /* ignore */ }
  }

  function unlockOrientation() {
    try {
      if (window.screen && screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    } catch (e) { /* ignore */ }
  }

  // Native fullscreen: orientation can only be locked inside fullscreen, hence the chained steps
  function requestNativeFullscreen(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(el, { navigationUI: 'hide' });
      if (p && p.then) p.then(lockLandscape, () => { /* ignore when unsupported */ });
      else lockLandscape();
    } catch (e) { /* ignore */ }
  }

  function exitNativeFullscreen() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    try {
      const p = fn.call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Without orientation lock (iOS Safari), portrait fullscreen rotates the stage 90° instead.
  // The stage wraps only the canvas, so buttons and other controls stay upright.
  function syncFsRotation(vmName) {
    const view = getView(vmName);
    const wrap = view.canvasWrap;
    if (!wrap) return;
    const rotate = !!view.isFullscreen
      && isTouchDevice()
      && !orientationLockSupported()
      && window.innerHeight > window.innerWidth;
    if (rotate === !!view.fsRotated) return;
    view.fsRotated = rotate;
    wrap.classList.toggle('fs-rotate', rotate);
    // Class changes do not fire resize, so refit the canvas manually
    requestAnimationFrame(() => {
      fitCanvasToContainer(vmName);
      repaintAll(vmName);
    });
  }

  // Fullscreen toggle
  function setFullscreen(vmName, on) {
    const view = getView(vmName);
    const wrap = view.canvasWrap;
    if (!wrap || view.isFullscreen === on) return;
    view.isFullscreen = on;
    // Drop unfinished touch gestures when toggling fullscreen, so a half press does not leak into the new mode
    view._pressPoint = null;
    view._lpFired = false;
    clearLongPress(view);
    wrap.classList.toggle('fullscreen', on);
    // ESC exits fullscreen (intercepted in the capture phase so it never reaches canvas onKey)
    if (on) {
      view._escHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setFullscreen(vmName, false);
        }
      };
      document.addEventListener('keydown', view._escHandler, true);
      // Refocus the canvas on any click inside fullscreen (except the IME button/input)
      view._fsFocusHandler = (e) => {
        const target = e.target;
        if (target === view.canvas) return;
        if (target && target.closest && target.closest('.ime-btn, .ime-input')) return;
        view.canvas.focus();
      };
      wrap.addEventListener('mousedown', view._fsFocusHandler, true);
      // Mobile: enter native fullscreen and lock landscape
      if (isTouchDevice()) requestNativeFullscreen(wrap);
      syncFsRotation(vmName);
      // Focus the canvas right after entering, otherwise keydown never arrives
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
      unlockOrientation();
      exitNativeFullscreen();
      view.fsRotated = false;
      wrap.classList.remove('fs-rotate');
      // Dismiss the soft keyboard when leaving fullscreen
      if (view.imeInput) view.imeInput.blur();
      setTimeout(() => { fitCanvasToContainer(vmName); repaintAll(vmName); }, 30);
    }
  }

  function toggleFullscreen(vmName) {
    setFullscreen(vmName, !getView(vmName).isFullscreen);
  }

  // A system gesture or ESC that leaves native fullscreen must also reset the in-page state
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    views.forEach((view, vmName) => {
      if (view.isFullscreen) setFullscreen(vmName, false);
    });
  });

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

  // Copy the offscreen canvas onto the main canvas (DPR scaling)
  function flushScreen(view) {
    if (hexFont && view.offscreen) {
      view.ctx.drawImage(view.offscreen, 0, 0);
    }
  }

  // Render throttle: rAF coalescing plus dirty cells (only changed cells repaint)
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

  // Mark a cell dirty (cellIdx = y * w + x, 0-based)
  function _markDirtyCell(vmName, cellIdx) {
    let info = _dirtyVMs.get(vmName);
    if (!info) {
      info = { full: false, cells: new Set() };
      _dirtyVMs.set(vmName, info);
    }
    if (!info.full) {
      info.cells.add(cellIdx);
      // Too many dirty cells degrade to a full repaint, avoiding many tiny updates
      if (info.cells.size > 200) {
        info.full = true;
        info.cells.clear();
      }
    }
  }

  // Actual paint, two passes: backgrounds first, then glyphs, so wide glyphs keep their right half
  function _doPaint(vmName, info) {
    const view = getView(vmName);
    if (!view.ctx || !view.cells || !view.w || !view.h) return;
    // After a clean shutdown the screen stays black; repainting would let the offscreen buffer restore the old frame
    if (view.stoppedAppearance === 'black') return;
    const cw = view.charW, ch = view.charH;
    const cells = view.cells;
    const w = view.w, h = view.h;
    const target = (hexFont && view.offCtx) ? view.offCtx : view.ctx;

    // Collect the cell indices to repaint (de-duplicated)
    const repaint = new Set();
    if (info.full) {
      for (let i = 0; i < cells.length; i++) repaint.add(i);
    } else {
      for (const idx of info.cells) {
        repaint.add(idx);
        const y = Math.floor(idx / w);
        const x = idx - y * w;
        // If this cell is the tail of a wide glyph, repaint the cell before it
        if (x > 0) {
          const prevCell = cells[idx - 1];
          if (prevCell && prevCell[2] && isWideGlyph(prevCell[2])) {
            repaint.add(idx - 1);
          }
        }
        // If this cell holds a wide glyph, the next cell's background must repaint too
        if (x < w - 1) {
          const cell = cells[idx] || [0, 0xffffff, ' '];
          if (cell[2] && isWideGlyph(cell[2])) {
            repaint.add(idx + 1);
          }
        }
      }
    }

    // Pass 1: fill every background
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

    // Pass 2: draw every glyph (a wide glyph's right half is not overwritten)
    for (const idx of repaint) {
      const y = Math.floor(idx / w);
      const x = idx - y * w;
      const cell = cells[idx] || [0, 0xffffff, ' '];
      const ch_ = cell[2];
      if (!ch_ || ch_ === ' ') continue;

      const fg = cell[1];
      const px = x * cw, py = y * ch;

      // Hex font: exact bitmap rendering
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

      // Fallback: TTF fillText
      target.fillStyle = colorToCSS(fg);
      target.textBaseline = 'middle';
      target.textAlign = 'center';
      target.fillText(ch_, px + cw / 2, py + ch / 2);
    }
    flushScreen(view);

    // Cursor
    if (view.cursor) {
      const cx = (view.cursor.x || 1) - 1;
      const cy = (view.cursor.y || 1) - 1;
      if (cx >= 0 && cy >= 0 && cx < w && cy < h && view.cursorBlinkOn) {
        target.fillStyle = view.cursor.blink ? '#ffffff' : '#cccccc';
        target.fillRect(cx * cw, cy * ch + ch - 2, cw, 2);
        flushScreen(view);
      }
    }

    // Render stats (full level only, one line every 5 seconds)
    if (showFps) view._fpsFrames = (view._fpsFrames || 0) + 1;
    _renderStats.frames++;
    _renderStats.cells += repaint.size;
    if (info.full) _renderStats.full++;
    const now = Date.now();
    if (now - _renderStats.since >= 5000) {
      const sec = ((now - _renderStats.since) / 1000).toFixed(1);
      flog('debug', I18N.t('log.render-stats', {
        frames: _renderStats.frames,
        cells: _renderStats.cells,
        full: _renderStats.full,
        sec,
      }));
      _renderStats = { since: now, frames: 0, cells: 0, full: 0 };
    }
  }

  function paintScreen(vmName, msg) {
    const view = getView(vmName);
    if (!view.ctx) return;

    // Deliberately do not clear the stopped appearance when a frame arrives.
    // Subscribing to a stopped VM replays its last snapshot, and trusting frames
    // would mark it running again and show the stale colored screen.
    // Appearance is driven by s2c.state only (see onServerMessage).
    if (msg.cursor) {
      view.cursor = msg.cursor;
    }

    if (msg.full && msg.cells) {
      // Full frame: the standard cells array
      view.w = msg.w || view.w;
      view.h = msg.h || view.h;
      view.cells = msg.cells;
      resizeCanvas(vmName);
      _schedulePaint(vmName, true);
    } else if (msg.dirty) {
      // Dirty update
      const w = view.w;
      for (const [x, y, bg, fg, ch_] of msg.dirty) {
        const idx = (y - 1) * w + (x - 1);
        view.cells[idx] = [bg, fg, ch_];
        _markDirtyCell(vmName, idx);
      }
      _schedulePaint(vmName, false);
    } else {
      // Cursor-only update
      _schedulePaint(vmName, false);
    }
  }

  function repaintAll(vmName) {
    _schedulePaint(vmName, true);
  }

  // Screen appearance after the system stops.
  //   'black'  clean shutdown (guest shut itself down, or the user pressed stop/restart)
  //   'gray'   abnormal stop (crash, killed process, server disconnect, unknown state)
  //   null     normal display
  // A clean shutdown clears the screen to black; an abnormal stop keeps the last frame but
  // desaturates it, so "shut down" and "vanished while running" are distinguishable at a glance.
  function setStoppedAppearance(vmName, mode) {
    const view = getView(vmName);
    if (!view) return;
    const next = mode || null;
    if (view.stoppedAppearance === next) return;
    view.stoppedAppearance = next;
    applyStoppedVisual(vmName);
  }

  // Draw the recorded stopped appearance. The canvas may not exist yet (tab not opened),
  // in which case only the state is stored and applied later by renderVMView.
  function applyStoppedVisual(vmName) {
    const view = getView(vmName);
    if (!view || !view.canvas) return;
    const next = view.stoppedAppearance;

    // Gray uses a CSS filter, so it works whether the canvas is drawn per pixel or composited;
    // the whole canvas is simply desaturated and dimmed.
    try {
      view.canvas.style.filter = (next === 'gray') ? 'grayscale(1) brightness(0.55)' : '';
    } catch (e) {}

    if (next === 'black') {
      // Clear the visible canvas and the offscreen buffer, and drop the cell cache; otherwise a later
      // flushScreen or cursor blink would paint the old frame back.
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

    // A stopped VM must not keep blinking its cursor, which suggests it is still alive
    if (next && view.cursorTimer) {
      clearInterval(view.cursorTimer);
      view.cursorTimer = null;
    }
  }

  // Apply one server state consistently: state, button availability and stopped appearance.
  // Called by both s2c.state and the 5-second poll, so a lost state message
  // is corrected on the next poll without reloading the page.
  function applyServerState(vmName, state, exitCode, cleanStop) {
    const view = getView(vmName);
    if (!view) return;
    if (state) view.state = state;
    updateStateBadge(vmName);

    const st = view.state;
    if (st === 'stopped' || st === 'error') {
      // Only a genuine abnormal exit counts as gray:
      //   numeric exitCode != 0 -> crashed / killed
      //   exitCode === 0 -> the guest shut itself down
      //   exitCode and cleanStop both missing -> never ran this session (unknown);
      //     treating that as a crash would gray out every freshly loaded clean state
      //     and look like a broken refresh.
      const crashed = (typeof exitCode === 'number' && exitCode !== 0);
      const clean = !crashed || cleanStop === true || view.expectCleanStop === true;
      setStoppedAppearance(vmName, clean ? 'black' : 'gray');
    } else if (st === 'running' || st === 'starting' || st === 'paused') {
      view.expectCleanStop = false;
      setStoppedAppearance(vmName, null);
    }
  }

  // Lost the server (shutdown / restart / network drop): running or paused VMs
  // turn gray to show they were interrupted.
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

    // Background first
    ctx.fillStyle = bgCSS;
    ctx.fillRect(px, py, cw, ch);

    if (!ch_ || ch_ === ' ') return;

    // Hex font: exact bitmap rendering (one fillRect per horizontal run)
    if (hexFont) {
      const cp = ch_.codePointAt(0);
      const glyph = hexFont.get(cp);
      if (glyph) {
        const gw = glyph.width;
        const bytes = glyph.bytes;
        const rowBytes = gw / 8;
        ctx.fillStyle = fgCSS;
        // Draw contiguous runs per row to reduce fillRect calls
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

    // Fallback: TTF fillText
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

  // ---------- Input events ----------
  function sendInput(vmName, ev) {
    // wsSend returns false while the connection is down. All input (keyboard/mouse/wheel)
    // goes through it; warn once, because silent drops make "keys do nothing" hard to diagnose.
    const ok = App.wsSend({ type: 'c2s.input', ...ev });
    if (ok === false) {
      diag.inputDropped++;
      if (!inputDropWarned) {
        inputDropWarned = true;
        appendLog(vmName, `[frontend] ${I18N.t('log.input-not-sent')}`, 'warn');
      }
    }
    return ok;
  }

  // ============================================================
  // Wheel compatibility mode
  //
  // Some mice, drivers or tools map the wheel to PageUp / PageDown instead of wheel events
  // (observed: the server only receives {"event":"key_down","code":209}, no wheel at all).
  // The emulator then never sees a scroll signal and the guest simply cannot scroll.
  // With this switch on, PageUp/PageDown landing on the VM screen become scroll signals
  // identical to a real wheel, and the keys are not forwarded to the guest.
  // ============================================================
  const WHEEL_KEY_COMPAT_KEY = 'oc-wheel-key-compat';
  function isWheelKeyCompat() {
    try { return localStorage.getItem(WHEEL_KEY_COMPAT_KEY) === '1'; } catch (e) { return false; }
  }
  function setWheelKeyCompat(on) {
    try {
      if (on) localStorage.setItem(WHEEL_KEY_COMPAT_KEY, '1');
      else localStorage.removeItem(WHEEL_KEY_COMPAT_KEY);
    } catch (e) { /* ignore */ }
  }

  // Shared send path for real wheel events and wheel-mapped keys
  function sendScroll(vmName, x, y, px, py, delta) {
    diag.wheelSent++;
    const sent = sendInput(vmName, { event: 'scroll', x, y, px, py, delta });
    if (diag.wheelSent <= 10 || diag.wheelSent % 50 === 0) {
      flog('debug', `scroll #${diag.wheelSent} x=${x} y=${y} delta=${delta} sent=${sent !== false}`);
    }
    return sent;
  }

  function onKey(e, vmName) {
    const view = getView(vmName);
    // In fullscreen ESC only exits fullscreen and is not forwarded
    if (view.isFullscreen && e.key === 'Escape') {
      e.preventDefault();
      return;
    }
    // Compatibility: treat wheel-mapped PageUp/PageDown as a real wheel
    if (isWheelKeyCompat() && (e.code === 'PageUp' || e.code === 'PageDown')) {
      e.preventDefault();
      if (e.type === 'keydown' && !e.repeat) {
        // Up = +1, down = -1, matching the real wheel convention
        const delta = (e.code === 'PageUp') ? 1 : -1;
        const pt = view.lastPt || { x: view.w >> 1, y: view.h >> 1, px: (view.w >> 1) * 6, py: (view.h >> 1) * 9 };
        sendScroll(vmName, pt.x, pt.y, pt.px, pt.py, delta);
      }
      return;  // Swallow keyup as well, so no dangling key_up is emitted
    }
    // OC signal: key_down(address, char:number, code:number, playerName)
    const code = mapKeyCode(e);
    if (code == null) return;
    e.preventDefault();
    // char is the Unicode code point (a number), or 0 for keys without one
    const charCode = (e.key && e.key.length === 1) ? e.key.charCodeAt(0) : 0;
    sendInput(vmName, { event: e.type === 'keyup' ? 'key_up' : 'key_down', char: charCode, code });
  }

  function onKeyPress(e, vmName) {
    // keypress is deprecated, so emit key_down + key_up
    if (!e.charCode) return;
    e.preventDefault();
    sendInput(vmName, { event: 'key_down', char: e.charCode, code: e.charCode });
    sendInput(vmName, { event: 'key_up',   char: e.charCode, code: e.charCode });
  }

  // Mobile IME (soft keyboard) bridge: the canvas only receives physical key events, while
  // soft keyboards need a focusable element. A hidden textarea captures the committed
  // text/delete/enter and translates them into key_down/key_up.
  const IME_SPECIAL_KEYS = {
    Enter: 0x1C, Backspace: 0x0E, Tab: 0x0F, Escape: 0x01,
    ArrowUp: 0xC8, ArrowDown: 0xD0, ArrowLeft: 0xCB, ArrowRight: 0xCD,
    Home: 0xC7, End: 0xCF, Delete: 0xD3, PageUp: 0xC9, PageDown: 0xD1,
  };

  // ASCII character -> PS/2 scan code; non-ASCII characters have no key, so 0
  function charScanCode(ch) {
    const lower = {
      ' ': 0x39,
      '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
      '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0A, '0': 0x0B,
      'a': 0x1E, 'b': 0x30, 'c': 0x2E, 'd': 0x20, 'e': 0x12,
      'f': 0x21, 'g': 0x22, 'h': 0x23, 'i': 0x17, 'j': 0x24,
      'k': 0x25, 'l': 0x26, 'm': 0x32, 'n': 0x31, 'o': 0x18,
      'p': 0x19, 'q': 0x10, 'r': 0x13, 's': 0x1F, 't': 0x14,
      'u': 0x16, 'v': 0x2F, 'w': 0x11, 'x': 0x2D, 'y': 0x15,
      'z': 0x2C,
      '-': 0x0C, '=': 0x0D, '[': 0x1A, ']': 0x1B, '\\': 0x2B,
      ';': 0x27, "'": 0x28, '`': 0x29, ',': 0x33, '.': 0x34, '/': 0x35,
    };
    const shifted = {
      '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
      '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
      '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`',
      '<': ',', '>': '.', '?': '/',
    };
    if (ch >= 'A' && ch <= 'Z') ch = ch.toLowerCase();
    if (shifted[ch]) ch = shifted[ch];
    return lower[ch] || 0;
  }

  // ============================================================
  // Virtual keyboard (mobile)
  //
  // Soft keyboards lack F1-F12, Insert, Delete and friends, which guest programs often need.
  // Hence the full key set: a normal key sends one key_down + key_up;
  // Ctrl / Alt / Shift are one-shot modifiers: tap one, then tap the target key.
  // ============================================================
  const VKBD_MODS = {
    ctrl: { char: 0, code: 0x1D },
    alt: { char: 0, code: 0x38 },
    shift: { char: 0, code: 0x2A },
  };

  const VKBD_ROWS = [
    [
      { l: 'Esc', c: 0x01, w: 1.4 },
      { l: 'F1', c: 0x3B }, { l: 'F2', c: 0x3C }, { l: 'F3', c: 0x3D }, { l: 'F4', c: 0x3E },
      { l: 'F5', c: 0x3F }, { l: 'F6', c: 0x40 }, { l: 'F7', c: 0x41 }, { l: 'F8', c: 0x42 },
      { l: 'F9', c: 0x43 }, { l: 'F10', c: 0x44 }, { l: 'F11', c: 0x45 }, { l: 'F12', c: 0x46 },
    ],
    [
      { l: '`', c: 0x29, ch: 0x60 },
      { l: '1', c: 0x02, ch: 0x31 }, { l: '2', c: 0x03, ch: 0x32 }, { l: '3', c: 0x04, ch: 0x33 },
      { l: '4', c: 0x05, ch: 0x34 }, { l: '5', c: 0x06, ch: 0x35 }, { l: '6', c: 0x07, ch: 0x36 },
      { l: '7', c: 0x08, ch: 0x37 }, { l: '8', c: 0x09, ch: 0x38 }, { l: '9', c: 0x0A, ch: 0x39 },
      { l: '0', c: 0x0B, ch: 0x30 },
      { l: '-', c: 0x0C, ch: 0x2D }, { l: '=', c: 0x0D, ch: 0x3D },
      { l: '⌫', c: 0x0E, ch: 0x08, w: 1.9, wide: true },
    ],
    [
      { l: 'Tab', c: 0x0F, ch: 0x09, w: 1.5, wide: true },
      { l: 'Q', c: 0x10, ch: 0x71, alpha: true }, { l: 'W', c: 0x11, ch: 0x77, alpha: true },
      { l: 'E', c: 0x12, ch: 0x65, alpha: true }, { l: 'R', c: 0x13, ch: 0x72, alpha: true },
      { l: 'T', c: 0x14, ch: 0x74, alpha: true }, { l: 'Y', c: 0x15, ch: 0x79, alpha: true },
      { l: 'U', c: 0x16, ch: 0x75, alpha: true }, { l: 'I', c: 0x17, ch: 0x69, alpha: true },
      { l: 'O', c: 0x18, ch: 0x6F, alpha: true }, { l: 'P', c: 0x19, ch: 0x70, alpha: true },
      { l: '[', c: 0x1A, ch: 0x5B }, { l: ']', c: 0x1B, ch: 0x5D },
      { l: '\\', c: 0x2B, ch: 0x5C, w: 1.5 },
    ],
    [
      { l: 'Caps', c: 0x3A, w: 1.7, wide: true },
      { l: 'A', c: 0x1E, ch: 0x61, alpha: true }, { l: 'S', c: 0x1F, ch: 0x73, alpha: true },
      { l: 'D', c: 0x20, ch: 0x64, alpha: true }, { l: 'F', c: 0x21, ch: 0x66, alpha: true },
      { l: 'G', c: 0x22, ch: 0x67, alpha: true }, { l: 'H', c: 0x23, ch: 0x68, alpha: true },
      { l: 'J', c: 0x24, ch: 0x6A, alpha: true }, { l: 'K', c: 0x25, ch: 0x6B, alpha: true },
      { l: 'L', c: 0x26, ch: 0x6C, alpha: true },
      { l: ';', c: 0x27, ch: 0x3B }, { l: "'", c: 0x28, ch: 0x27 },
      { l: 'Enter', c: 0x1C, ch: 0x0D, w: 2, wide: true },
    ],
    [
      { l: 'Shift', mod: 'shift', w: 1.9, wide: true },
      { l: 'Z', c: 0x2C, ch: 0x7A, alpha: true }, { l: 'X', c: 0x2D, ch: 0x78, alpha: true },
      { l: 'C', c: 0x2E, ch: 0x63, alpha: true }, { l: 'V', c: 0x2F, ch: 0x76, alpha: true },
      { l: 'B', c: 0x30, ch: 0x62, alpha: true }, { l: 'N', c: 0x31, ch: 0x6E, alpha: true },
      { l: 'M', c: 0x32, ch: 0x6D, alpha: true },
      { l: ',', c: 0x33, ch: 0x2C }, { l: '.', c: 0x34, ch: 0x2E },
      { l: '/', c: 0x35, ch: 0x2F },
      { l: 'Shift', mod: 'shift', w: 1.9, wide: true },
    ],
    [
      { l: 'Ctrl', mod: 'ctrl', w: 1.3, wide: true },
      { l: 'Alt', mod: 'alt', w: 1.3, wide: true },
      { l: 'Space', c: 0x39, ch: 0x20, w: 4.5 },
      { l: 'Alt', mod: 'alt', w: 1.3, wide: true },
      { l: 'Ctrl', mod: 'ctrl', w: 1.3, wide: true },
    ],
    [
      { l: '←', c: 0xCB, w: 1.2 }, { l: '↑', c: 0xC8, w: 1.2 },
      { l: '↓', c: 0xD0, w: 1.2 }, { l: '→', c: 0xCD, w: 1.2 },
      { l: 'Ins', c: 0xD2, w: 1.2 }, { l: 'Del', c: 0xD3, w: 1.2 },
      { l: 'Home', c: 0xC7, w: 1.2 }, { l: 'End', c: 0xCF, w: 1.2 },
      { l: 'PgUp', c: 0xC9, w: 1.2 }, { l: 'PgDn', c: 0xD1, w: 1.2 },
    ],
  ];

  function updateVkbdMods(view) {
    if (!view.vkbdRows) return;
    view.vkbdRows.querySelectorAll('.vkbd-key[data-mod]').forEach((el) => {
      el.classList.toggle('active', !!view.vkMods[el.dataset.mod]);
    });
  }

  function sendVkbdKey(view, vmName, key) {
    const held = Object.keys(VKBD_MODS).filter((m) => view.vkMods[m]);
    for (const m of held) {
      sendInput(vmName, { event: 'key_down', char: VKBD_MODS[m].char, code: VKBD_MODS[m].code });
    }
    let ch = key.ch || 0;
    if (key.alpha && view.vkMods.shift) ch = key.ch - 32;
    sendInput(vmName, { event: 'key_down', char: ch, code: key.c });
    sendInput(vmName, { event: 'key_up', char: ch, code: key.c });
    for (const m of held.slice().reverse()) {
      sendInput(vmName, { event: 'key_up', char: VKBD_MODS[m].char, code: VKBD_MODS[m].code });
    }
    // Modifiers are one-shot, so the next press does not carry Ctrl/Shift by accident
    if (held.length) {
      view.vkMods = { ctrl: false, alt: false, shift: false };
      updateVkbdMods(view);
    }
  }

  function bindVirtualKeyboard(view, vmName) {
    const btn = view.vkbdBtn;
    const panel = view.vkbdPanel;
    const rowsEl = view.vkbdRows;
    if (!btn || !panel || !rowsEl) return;
    view.vkMods = { ctrl: false, alt: false, shift: false };

    rowsEl.innerHTML = VKBD_ROWS.map((row, r) =>
      '<div class="vkbd-row">' + row.map((k, i) =>
        `<button type="button" class="vkbd-key${k.wide ? ' wide' : ''}${k.mod ? ' mod' : ''}"`
        + ` data-r="${r}" data-i="${i}"${k.mod ? ` data-mod="${k.mod}"` : ''}`
        + ` style="flex-grow:${k.w || 1}">${k.l}</button>`
      ).join('') + '</div>'
    ).join('');

    const setOpen = (open) => {
      panel.classList.toggle('open', open);
      btn.classList.toggle('active', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    };

    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!panel.classList.contains('open'));
    });
    if (view.vkbdClose) {
      view.vkbdClose.addEventListener('mousedown', (e) => e.stopPropagation());
      view.vkbdClose.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(false);
      });
    }

    rowsEl.addEventListener('click', (e) => {
      const el = e.target.closest('.vkbd-key');
      if (!el) return;
      e.stopPropagation();
      const key = VKBD_ROWS[Number(el.dataset.r)][Number(el.dataset.i)];
      if (!key) return;
      if (key.mod) {
        view.vkMods[key.mod] = !view.vkMods[key.mod];
        updateVkbdMods(view);
        return;
      }
      sendVkbdKey(view, vmName, key);
    });
  }

  function bindImeInput(view, vmName) {
    const btn = view.imeBtn;
    const input = view.imeInput;
    if (!btn || !input) return;

    // Some IMEs only fire keydown (enter/backspace), others only input; listen to both and
    // de-duplicate within a 200 ms window so one press does not send two signals.
    let lastKey = '';
    let lastKeyAt = 0;
    const markKey = (name) => {
      lastKey = name;
      lastKeyAt = Date.now();
    };
    const isRecent = (name) => lastKey === name && (Date.now() - lastKeyAt) < 200;

    const sendKeyPair = (code, char) => {
      sendInput(vmName, { event: 'key_down', char: char || 0, code });
      sendInput(vmName, { event: 'key_up', char: char || 0, code });
    };

    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (document.activeElement === input) {
        input.blur();
      } else {
        input.value = '';
        input.focus();
      }
    });

    input.addEventListener('focus', () => btn.classList.add('active'));
    input.addEventListener('blur', () => {
      input.value = '';
      btn.classList.remove('active');
    });

    input.addEventListener('input', (e) => {
      // Never clear or forward while composing: it breaks pinyin, Japanese, etc.
      if (e.isComposing) return;
      const inputType = e.inputType || '';
      // Backspace/delete usually arrive only as input events, without a usable keydown
      if (inputType.indexOf('delete') === 0) {
        input.value = '';
        const isForward = inputType.indexOf('Forward') >= 0;
        const name = isForward ? 'Delete' : 'Backspace';
        if (!isRecent(name)) {
          markKey(name);
          sendKeyPair(isForward ? 0xD3 : 0x0E, 0);
        }
        return;
      }

      const text = input.value;
      input.value = '';
      if (!text) return;

      for (const ch of Array.from(text)) {
        if (ch === '\n' || ch === '\r') {
          if (!isRecent('Enter')) {
            markKey('Enter');
            sendKeyPair(0x1C, 0);
          }
          continue;
        }
        const codePoint = ch.codePointAt(0);
        // OpenOS string.char accepts only 0-255; higher code points make the guest throw
        if (codePoint < 32 || codePoint > 255) continue;
        const code = charScanCode(ch);
        sendInput(vmName, { event: 'key_down', char: codePoint, code });
        sendInput(vmName, { event: 'key_up', char: codePoint, code });
      }
    });

    input.addEventListener('keydown', (e) => {
      // Leave composing keys alone and let the input event handle them
      if (e.isComposing || e.keyCode === 229) return;
      const code = IME_SPECIAL_KEYS[e.key];
      if (code == null) return;
      e.preventDefault();
      markKey(e.key);
      sendKeyPair(code, 0);
    });
  }

  // Map browser coordinates to OC cell and pixel coordinates (OC standard: 6x9 pixels per cell)
  function computePoint(view, clientX, clientY) {
    let localX, localY, boxW, boxH;
    if (view.fsRotated) {
      // Stage rotated 90°: invert the real transform matrix to map screen coordinates back to layout space
      const stage = view.canvasStage;
      let local = null;
      try {
        const m = new DOMMatrixReadOnly(getComputedStyle(stage).transform);
        local = m.inverse().transformPoint({ x: clientX, y: clientY });
      } catch (e) {
        local = null;
      }
      if (!local) {
        // Very old browsers lack DOMMatrix: invert rotate(90deg) translateY(-100%) by hand
        local = { x: clientY, y: stage.offsetHeight - clientX };
      }
      localX = local.x - view.canvas.offsetLeft;
      localY = local.y - view.canvas.offsetTop;
      boxW = view.canvas.offsetWidth;
      boxH = view.canvas.offsetHeight;
    } else {
      const rect = view.canvas.getBoundingClientRect();
      // getBoundingClientRect already reflects CSS transform scaling
      localX = clientX - rect.left;
      localY = clientY - rect.top;
      boxW = rect.width;
      boxH = rect.height;
    }
    // Canvas-local position, used by the virtual mouse crosshair
    view.lastLocal = { lx: localX, ly: localY, boxW: boxW, boxH: boxH };
    const realCharW = boxW / view.w;
    const realCharH = boxH / view.h;
    const x = Math.max(1, Math.min(view.w, Math.floor(localX / realCharW) + 1));
    const y = Math.max(1, Math.min(view.h, Math.floor(localY / realCharH) + 1));
    // Pointer position inside the current cell (0-1)
    const fx = localX / realCharW - (x - 1);
    const fy = localY / realCharH - (y - 1);
    // Pixel coordinates are 1-based; total = cells * pixels per cell
    const px = Math.max(1, Math.min(view.w * 6, (x - 1) * 6 + Math.floor(fx * 6) + 1));
    const py = Math.max(1, Math.min(view.h * 9, (y - 1) * 9 + Math.floor(fy * 9) + 1));
    // Remember the last on-screen pointer position: wheel-mapped PageUp/PageDown carry no coordinates
    view.lastPt = { x, y, px, py };
    return { x, y, px, py };
  }

  function onMouse(e, vmName, evName) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) return;
    const point = computePoint(view, e.clientX, e.clientY);
    const btn = e.button === 0 ? 0 : e.button === 2 ? 1 : 2;
    sendInput(vmName, { event: evName, ...point, btn });
  }

  // Touch mirrors mouse semantics (touch / drag / drop), driven by touchstart/touchmove/touchend
  function onTouch(touch, vmName, evName, btn = 0) {
    sendTouchAt(vmName, touch.clientX, touch.clientY, evName, btn);
  }

  // Send a touch event by screen coordinates (the original touch may be gone when the long-press timer fires)
  function sendTouchAt(vmName, x, y, evName, btn = 0) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) return;
    const point = computePoint(view, x, y);
    sendInput(vmName, { event: evName, ...point, btn });
  }

  // Right-click gesture availability: fullscreen and running (no right click on error/stopped)
  function isRightClickGesture(view) {
    return !!view.isFullscreen && view.state === 'running';
  }

  // Long press: emit a right click after the delay; moving past the threshold becomes a drag
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_DIST = 15;

  function clearLongPress(view) {
    if (view._lpTimer) {
      clearTimeout(view._lpTimer);
      view._lpTimer = null;
    }
  }

  // ---------- Virtual mouse (touch only) ----------
  // Floating toggle for phones/tablets. While it is on, a finger press sends the left
  // button down immediately and every move is forwarded as a drag, so dragging works
  // like a mouse drag (window titles, sliders, text selection). A crosshair shows where
  // the press landed. The toggle itself can be dragged and snaps to the closest canvas
  // edge to keep the screen readable; the coarse-pointer media query keeps it hidden on
  // desktops.
  const VMOUSE_EDGE = 4;   // minimum distance from the console edge
  const VMOUSE_GAP = 6;    // distance kept between the toggle and the canvas
  const VMOUSE_SLOP = 6;   // movement that turns a tap into a drag

  function setVirtualMouse(vmName, on) {
    const view = getView(vmName);
    view.vmouseOn = !!on;
    if (view.vmouseBtn) {
      view.vmouseBtn.classList.toggle('active', view.vmouseOn);
      view.vmouseBtn.setAttribute('aria-pressed', view.vmouseOn ? 'true' : 'false');
    }
    if (!view.vmouseOn) {
      hideVirtualPointer(view);
      cancelVirtualMouse(view);
    }
  }

  function hideVirtualPointer(view) {
    if (view.vmousePointer) view.vmousePointer.style.display = 'none';
  }

  // Move the crosshair to a client position; returns the OC point for that spot
  function placeVirtualPointer(view, clientX, clientY) {
    const canvas = view.canvas;
    const ptr = view.vmousePointer;
    if (!canvas || !ptr || !view.w || !view.h) return null;
    const point = computePoint(view, clientX, clientY);
    const local = view.lastLocal;
    if (!local) return point;
    const lx = Math.max(0, Math.min(local.boxW, local.lx));
    const ly = Math.max(0, Math.min(local.boxH, local.ly));
    ptr.style.left = (canvas.offsetLeft + lx) + 'px';
    ptr.style.top = (canvas.offsetTop + ly) + 'px';
    ptr.style.display = 'block';
    return point;
  }

  function cancelVirtualMouse(view) {
    view._vmGesture = null;
    view._touchPending = false;
    view._touchMoveEvent = null;
  }

  function startVirtualMouse(view, vmName, touch) {
    cancelVirtualMouse(view);
    view._vmGesture = { x: touch.clientX, y: touch.clientY };
    placeVirtualPointer(view, touch.clientX, touch.clientY);
    // Drag style: the left button goes down on press, so any move becomes a real drag
    sendTouchAt(vmName, touch.clientX, touch.clientY, 'touch');
  }

  function moveVirtualMouse(view, vmName, touch) {
    const g = view._vmGesture;
    if (!g) return;
    g.x = touch.clientX;
    g.y = touch.clientY;
    placeVirtualPointer(view, touch.clientX, touch.clientY);
    // Coalesce per frame like mouse drags, so fast moves do not flood the socket
    if (view._touchPending) {
      view._touchMoveEvent = touch;
      return;
    }
    view._touchPending = true;
    view._touchMoveEvent = touch;
    requestAnimationFrame(() => {
      view._touchPending = false;
      if (view._touchMoveEvent && view._vmGesture) {
        const pending = view._touchMoveEvent;
        sendTouchAt(vmName, pending.clientX, pending.clientY, 'drag');
      }
      view._touchMoveEvent = null;
    });
  }

  function endVirtualMouse(view, vmName, touch) {
    const g = view._vmGesture;
    if (!g) return;
    const x = touch ? touch.clientX : g.x;
    const y = touch ? touch.clientY : g.y;
    const hadPendingMove = view._touchPending;
    view._vmGesture = null;
    view._touchPending = false;
    view._touchMoveEvent = null;
    placeVirtualPointer(view, x, y);
    // A move that never reached the next frame still has to reach the guest
    if (hadPendingMove) sendTouchAt(vmName, x, y, 'drag');
    sendTouchAt(vmName, x, y, 'drop');
  }

  // Clamp a candidate position so the toggle stays fully inside the console area
  function clampVirtualMouseButton(view, left, top) {
    const wrap = view.canvasWrap;
    const btn = view.vmouseBtn;
    if (!wrap || !btn) return null;
    const bw = btn.offsetWidth || 44;
    const bh = btn.offsetHeight || 44;
    const maxLeft = Math.max(VMOUSE_EDGE, wrap.clientWidth - bw - VMOUSE_EDGE);
    const maxTop = Math.max(VMOUSE_EDGE, wrap.clientHeight - bh - VMOUSE_EDGE);
    return {
      left: Math.max(VMOUSE_EDGE, Math.min(maxLeft, left)),
      top: Math.max(VMOUSE_EDGE, Math.min(maxTop, top)),
    };
  }

  function applyVirtualMouseButton(view, pos) {
    const btn = view.vmouseBtn;
    if (!btn || !pos) return;
    btn.style.left = pos.left + 'px';
    btn.style.top = pos.top + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    view._vmPos = pos;
  }

  // Snap the toggle just outside the closest canvas edge; anchor is a console-local point
  function layoutVirtualMouse(vmName, anchor) {
    const view = getView(vmName);
    const wrap = view.canvasWrap;
    const canvas = view.canvas;
    const btn = view.vmouseBtn;
    if (!wrap || !canvas || !btn) return;
    if (wrap.clientWidth < 80 || wrap.clientHeight < 80) return;
    const bw = btn.offsetWidth || 44;
    const bh = btn.offsetHeight || 44;
    const prev = view._vmPos || {
      left: wrap.clientWidth - bw - 8,
      top: wrap.clientHeight - bh - 8,
    };
    const ax = anchor ? anchor.left : prev.left + bw / 2;
    const ay = anchor ? anchor.top : prev.top + bh / 2;
    const wr = wrap.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const cl = cr.left - wr.left;
    const ct = cr.top - wr.top;
    const cw = cr.width;
    const ch = cr.height;
    const spots = [
      { left: cl - bw - VMOUSE_GAP, top: ay - bh / 2 },
      { left: cl + cw + VMOUSE_GAP, top: ay - bh / 2 },
      { left: ax - bw / 2, top: ct - bh - VMOUSE_GAP },
      { left: ax - bw / 2, top: ct + ch + VMOUSE_GAP },
    ];
    let best = null;
    for (const spot of spots) {
      const pos = clampVirtualMouseButton(view, spot.left, spot.top);
      if (!pos) continue;
      const dx = pos.left + bw / 2 - ax;
      const dy = pos.top + bh / 2 - ay;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { pos: pos, d: d };
    }
    if (best) applyVirtualMouseButton(view, best.pos);
  }

  function moveVirtualMouseButton(view, clientX, clientY) {
    const wrap = view.canvasWrap;
    const btn = view.vmouseBtn;
    if (!wrap || !btn) return;
    const wr = wrap.getBoundingClientRect();
    const bw = btn.offsetWidth || 44;
    const bh = btn.offsetHeight || 44;
    applyVirtualMouseButton(view, clampVirtualMouseButton(view, clientX - wr.left - bw / 2, clientY - wr.top - bh / 2));
  }

  function bindVirtualMouse(view, vmName) {
    const btn = view.vmouseBtn;
    if (!btn) return;
    // Restore the state and position after a tab rebuild
    setVirtualMouse(vmName, !!view.vmouseOn);
    layoutVirtualMouse(vmName);

    let dragId = null;
    let startX = 0;
    let startY = 0;
    let moved = false;

    btn.addEventListener('pointerdown', (e) => {
      if (dragId !== null) return;
      e.preventDefault();
      e.stopPropagation();
      dragId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore when unsupported */ }
    });
    btn.addEventListener('pointermove', (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && dx * dx + dy * dy <= VMOUSE_SLOP * VMOUSE_SLOP) return;
      moved = true;
      moveVirtualMouseButton(view, e.clientX, e.clientY);
    });
    const finishDrag = (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      dragId = null;
      try { btn.releasePointerCapture(e.pointerId); } catch (err) { /* ignore when unsupported */ }
      if (!moved) {
        setVirtualMouse(vmName, !view.vmouseOn);
        return;
      }
      moved = false;
      const wrap = view.canvasWrap;
      const wr = wrap ? wrap.getBoundingClientRect() : { left: 0, top: 0 };
      layoutVirtualMouse(vmName, { left: e.clientX - wr.left, top: e.clientY - wr.top });
    };
    btn.addEventListener('pointerup', finishDrag);
    btn.addEventListener('pointercancel', (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      dragId = null;
      moved = false;
    });
    // Keep the console-level handlers from treating button presses as screen input
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => e.stopPropagation());
  }

  // Virtual wheel: use the last pointer position, else the screen center
  function sendScrollAtPointer(vmName, delta) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) return;
    const point = view.lastPt || {
      x: Math.ceil(view.w / 2),
      y: Math.ceil(view.h / 2),
      px: Math.ceil(view.w * 3),
      py: Math.ceil(view.h * 4.5),
    };
    sendScroll(vmName, point.x, point.y, point.px, point.py, delta);
  }

  function onWheel(e, vmName) {
    const view = getView(vmName);
    if (!view.canvas || !view.w || !view.h) {
      diag.wheelSkipped++;
      flog('debug', 'wheel ignored: canvas not ready');
      return;
    }
    const point = computePoint(view, e.clientX, e.clientY);
    // OC scroll signal: scroll(address, x, y, direction, playerName)
    // Convention: positive direction scrolls up, negative scrolls down.
    // Browser wheel deltaY > 0 means "scroll down", the opposite of OC, hence the negation.
    // x/y use the same space as touch signals (pixel coordinates in precise mode).
    const delta = e.deltaY < 0 ? 1 : -1;
    sendScroll(vmName, point.x, point.y, point.px, point.py, delta);
  }

  function mapKeyCode(e) {
    // OC key codes are PS/2 scan codes (used by OpenOS keyboard.lua)
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
      // Letter keys (PS/2 set 1 scan codes)
      'KeyA': 0x1E, 'KeyB': 0x30, 'KeyC': 0x2E, 'KeyD': 0x20, 'KeyE': 0x12,
      'KeyF': 0x21, 'KeyG': 0x22, 'KeyH': 0x23, 'KeyI': 0x17, 'KeyJ': 0x24,
      'KeyK': 0x25, 'KeyL': 0x26, 'KeyM': 0x32, 'KeyN': 0x31, 'KeyO': 0x18,
      'KeyP': 0x19, 'KeyQ': 0x10, 'KeyR': 0x13, 'KeyS': 0x1F, 'KeyT': 0x14,
      'KeyU': 0x16, 'KeyV': 0x2F, 'KeyW': 0x11, 'KeyX': 0x2D, 'KeyY': 0x15,
      'KeyZ': 0x2C,
      // Digit keys
      'Digit0': 0x0B, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
      'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
      'Digit8': 0x09, 'Digit9': 0x0A,
      // Symbol keys
      'Minus': 0x0C, 'Equal': 0x0D, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
      'Backslash': 0x2B, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
      'Comma': 0x33, 'Period': 0x34, 'Slash': 0x35,
    };
    if (map[e.code] != null) return map[e.code];
    if (e.code && e.code.startsWith('F')) {
      const n = parseInt(e.code.substring(1), 10);
      if (n >= 1 && n <= 12) return 0x3A + n;  // F1=0x3B, F2=0x3C, ...
    }
    // Unknown printable characters use code 0 and travel through the char field only
    if (e.key && e.key.length === 1) {
      return 0;
    }
    return null;
  }

  // ---------- Server message routing ----------
  function onServerMessage(msg) {
    if (!msg.vm) return;
    const view = getView(msg.vm);

    if (msg.type === 's2c.state') {
      appendLog(msg.vm, `[state] ${msg.state}${msg.exitCode != null ? ' (exit=' + msg.exitCode + ')' : ''}`);
      // State, button availability and stopped appearance all go through applyServerState.
      // expectCleanStop is deliberately not reset during a stop (one stop can push several
      // "stopped" messages, and resetting would flip the black screen back to gray); only run/start clears it.
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
    // Keep a copy for log export
    if (!view.logLines) view.logLines = [];
    view.logLines.push({ text, level, time: Date.now() });
    // Scroll to the bottom
    view.logPanel.scrollTop = view.logPanel.scrollHeight;
    // Cap at 1000 lines
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

  // Document-level wheel diagnostics (full level only): turns "no event delivered" apart from "hit outside the VM"
  document.addEventListener('wheel', (e) => {
    diag.wheelSeen++;
    const tgt = e.target;
    diag.wheelInside = !!(tgt && tgt.closest && tgt.closest('.console-wrap'));
    if (diag.wheelSeen === 1) {
      flog('debug', 'wheel event received, inside console area=', diag.wheelInside);
    }
  }, { capture: true, passive: true });

  // Load the hex font asynchronously at page load; the view repaints once it arrives
  loadHexFont();

  // Refresh the FPS readout once per second
  setInterval(() => {
    if (!showFps) return;
    views.forEach((view) => {
      if (!view.fpsEl) return;
      const frames = view._fpsFrames || 0;
      view._fpsFrames = 0;
      view.fpsEl.textContent = frames + ' FPS';
    });
  }, 1000);

  return { renderVMView, onServerMessage, loadHexFont, onConnectionLost, applyServerState, reloadView, diag, isWheelKeyCompat, setWheelKeyCompat, isShowFps, setShowFps };
})();

window.Console = Console;
