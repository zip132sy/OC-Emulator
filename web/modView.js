// ============================================================
// modView.js - Mods 设备视图
//
// 标签页:
//   1. 3D 场景  - 坐标轴、网格、设备位置、目标点、朝向、速度、标记点
//   2. 物品/状态 - 物品栏、工具、储罐、能量、位置
//   3. 控制台/EFI - 内置 EFI 启动日志与远程命令反馈
// ============================================================

const ModView = (() => {
  const views = new Map(); // modName -> view
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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

  function fmt(n, digits = 2) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
    let s = n.toFixed(digits);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s || '0';
  }

  function vec(v) {
    if (!v) return '-';
    return `${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}`;
  }

  function typeInfo(type) {
    if (type === 'drone') return { label: T('mods.type.drone', '无人机'), icon: '🛸', cls: 'drone' };
    if (type === 'reactor') return { label: T('mods.type.reactor', '核电站'), icon: '☢️', cls: 'reactor' };
    if (type === 'machine') return { label: T('mods.type.machine', '自定义机器'), icon: '⚙️', cls: 'machine' };
    if (type === 'microcontroller') return { label: T('mods.type.mcu', '单片机'), icon: '🧩', cls: 'robot' };
    return { label: T('mods.type.robot', '机器人'), icon: '🤖', cls: 'robot' };
  }

  function stateLabel(state) {
    const key = 'vm.state.' + (state || 'stopped');
    const fallback = state === 'running' ? '运行中'
      : state === 'starting' ? '启动中'
        : state === 'paused' ? '已暂停'
          : state === 'error' ? '错误' : '已停止';
    return T(key, fallback);
  }

  // ---------- 创建视图 ----------
  function render(pane, modName) {
    const info = typeInfo('');
    pane.innerHTML = `
      <div class="mod-view">
        <div class="mod-toolbar">
          <span class="mod-badge ${info.cls}" data-role="badge">${info.icon} ${info.label}</span>
          <span class="mod-title">${escapeHTML(modName)}</span>
          <span class="mod-state stopped" data-role="state">${T('vm.state.stopped')}</span>
          <span class="mod-addr" data-role="addr" title="${T('mods.addr.copy-title')}">${T('mods.addr.placeholder')}</span>
          <span class="mod-badge" data-role="efi">${T('mods.efi.builtin')}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-act="start">${T('vm.start', '▶ 启动')}</button>
          <button class="btn btn-danger" data-act="stop">${T('vm.stop', '■ 停止')}</button>
          <button class="btn btn-warn" data-act="restart">${T('vm.restart', '⟳ 重启')}</button>
          <button class="btn" data-act="config">⚙ ${T('mods.config.title', '配置')}</button>
          <button class="btn" data-act="reload">${T('mods.refresh')}</button>
        </div>
        <div class="mod-tabs">
          <button class="mod-tab active" data-tab="scene">${T('mods.tab.scene')}</button>
          <button class="mod-tab" data-tab="reactor" style="display:none">☢ ${T('reactor.tab', '反应堆')}</button>
          <button class="mod-tab" data-tab="machine" style="display:none">⚙ ${T('mods.tab.machine', '机器')}</button>
          <button class="mod-tab" data-tab="items">${T('mods.tab.items')}</button>
          <button class="mod-tab" data-tab="console">${T('mods.tab.console')}</button>
        </div>
        <div class="mod-panes">
          <div class="mod-pane active" data-pane="scene">
            <div class="scene-layout">
              <div class="scene-canvas-wrap" data-role="canvas-wrap">
                <canvas data-role="canvas"></canvas>
                <div class="scene-legend">
                  <span class="ax-x">X</span>
                  <span class="ax-y">Y</span>
                  <span class="ax-z">Z</span>
                </div>
                <div class="scene-hud" data-role="hud">${T('mods.scene.waiting')}</div>
                <div class="scene-help">${T('mods.scene.help')}</div>
              </div>
              <div class="scene-side">
                <div>
                  <div class="scene-section-title">${T('mods.scene.robot-controls')}</div>
                  <div class="scene-btn-grid" data-role="robot-controls">
                    <button class="btn" data-cmd="move" data-dir="3">${T('mods.cmd.forward')}</button>
                    <button class="btn" data-cmd="move" data-dir="1">${T('mods.cmd.up')}</button>
                    <button class="btn" data-cmd="move" data-dir="2">${T('mods.cmd.back')}</button>
                    <button class="btn" data-cmd="move" data-dir="0">${T('mods.cmd.down')}</button>
                    <button class="btn" data-cmd="turn" data-dir="0">${T('mods.cmd.turn-left')}</button>
                    <button class="btn" data-cmd="turn" data-dir="1">${T('mods.cmd.turn-right')}</button>
                    <button class="btn" data-cmd="swing">${T('mods.cmd.dig')}</button>
                    <button class="btn" data-cmd="place">${T('mods.cmd.place')}</button>
                    <button class="btn" data-cmd="detect">${T('mods.cmd.detect')}</button>
                  </div>
                </div>
                <div>
                  <div class="scene-section-title">${T('mods.scene.drone-offset')}</div>
                  <div class="scene-btn-grid">
                    <button class="btn" data-cmd="dmove" data-dx="0" data-dy="0" data-dz="1">Z+</button>
                    <button class="btn" data-cmd="dmove" data-dx="0" data-dy="1" data-dz="0">Y+</button>
                    <button class="btn" data-cmd="dmove" data-dx="1" data-dy="0" data-dz="0">X+</button>
                    <button class="btn" data-cmd="dmove" data-dx="0" data-dy="0" data-dz="-1">Z-</button>
                    <button class="btn" data-cmd="dmove" data-dx="0" data-dy="-1" data-dz="0">Y-</button>
                    <button class="btn" data-cmd="dmove" data-dx="-1" data-dy="0" data-dz="0">X-</button>
                  </div>
                </div>
                <div>
                  <div class="scene-section-title">${T('mods.scene.move-to')}</div>
                  <div class="scene-coord-row">
                    <input type="number" step="1" placeholder="X" data-role="coord-x">
                    <input type="number" step="1" placeholder="Y" data-role="coord-y">
                    <input type="number" step="1" placeholder="Z" data-role="coord-z">
                  </div>
                  <div class="scene-coord-row" style="margin-top:4px;">
                    <button class="btn" data-cmd="teleport" style="flex:1;">${T('mods.scene.teleport')}</button>
                    <button class="btn" data-cmd="origin" style="flex:1;">${T('mods.scene.origin')}</button>
                  </div>
                  <div class="scene-note">${T('mods.scene.teleport-note')}</div>
                </div>
                <div>
                  <div class="scene-section-title">${T('mods.scene.view')}</div>
                  <div class="scene-btn-grid">
                    <button class="btn" data-cmd="view-reset">${T('mods.scene.view-reset')}</button>
                    <button class="btn" data-cmd="view-top">${T('mods.scene.view-top')}</button>
                    <button class="btn" data-cmd="view-front">${T('mods.scene.view-front')}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="mod-pane" data-pane="reactor">
            <div class="ic2-info-wrap" data-role="reactor-info"></div>
          </div>
          <div class="mod-pane" data-pane="machine">
            <div class="machine-wrap" data-role="machine-info"></div>
          </div>
          <div class="mod-pane" data-pane="items">
            <div class="mod-items-wrap" data-role="items"></div>
          </div>
          <div class="mod-pane" data-pane="console">
            <div class="mod-console" data-role="console">
              <div class="mod-console-empty">${T('mods.console.empty')}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    const view = {
      name: modName,
      pane,
      meta: null,
      state: null,
      runtimeState: 'stopped',
      address: null,
      markers: [],
      logs: [],
      seenLogs: new Set(),
      scene: {
        yaw: 0.72,
        pitch: 0.52,
        zoom: 1,
        dragging: false,
        lastX: 0,
        lastY: 0,
      },
      canvas: $('[data-role="canvas"]', pane),
      canvasWrap: $('[data-role="canvas-wrap"]', pane),
      hud: $('[data-role="hud"]', pane),
      itemsEl: $('[data-role="items"]', pane),
      consoleEl: $('[data-role="console"]', pane),
      badgeEl: $('[data-role="badge"]', pane),
      stateEl: $('[data-role="state"]', pane),
      addrEl: $('[data-role="addr"]', pane),
      efiEl: $('[data-role="efi"]', pane),
      raf: 0,
      timer: null,
      reactorTimer: null,
      resizeObserver: null,
      addrFlashTimer: null,
      fullscreen: false,
      viewRoot: null,
      escHandler: null,
    };
    views.set(modName, view);

    bindToolbar(view);
    bindTabs(view);
    bindScene(view);
    bindAddrCopy(view);
    bindFullscreen(view);
    setupCanvas(view);

    // WebSocket 断开时用低频轮询兜底
    view.timer = setInterval(() => {
      const ws = App.state && App.state.ws;
      if (!ws || ws.readyState !== 1) reload(modName);
    }, 2500);

    reload(modName);
    return view;
  }

  // ---------- 工具栏 ----------
  function bindToolbar(view) {
    $$('[data-act]', view.pane).forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'reload') return reload(view.name);
        if (act === 'config') return openConfig(view.name);
        try {
          await App.api(`mods/${encodeURIComponent(view.name)}/${act}`, { method: 'POST' });
          if (act === 'start') setTimeout(() => reload(view.name), 400);
          if (window.App && App.refreshMods) App.refreshMods();
        } catch (e) {
          appendLog(view.name, { ts: Date.now(), level: 'error', msg: `${T('mods.request-failed', '请求失败: ')}${e.message}` });
        }
      });
    });
  }

  // ---------- 双击复制无线地址 ----------
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* 回退到 execCommand */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function flashAddr(view, text, error) {
    if (view.addrFlashTimer) clearTimeout(view.addrFlashTimer);
    view.addrEl.textContent = text;
    view.addrEl.classList.toggle('copied', !error);
    view.addrEl.classList.toggle('copy-error', !!error);
    view.addrFlashTimer = setTimeout(() => {
      view.addrFlashTimer = null;
      view.addrEl.classList.remove('copied', 'copy-error');
      updateToolbar(view);
    }, 1400);
  }

  function bindAddrCopy(view) {
    view.addrEl.addEventListener('dblclick', async () => {
      const addr = view.address;
      if (!addr) {
        flashAddr(view, T('mods.copy.after-start'), true);
        return;
      }
      const ok = await copyText(addr);
      if (ok) {
        flashAddr(view, T('mods.copy.done') + addr);
        if (window.App && App.setStatus) App.setStatus(T('mods.copy.done-status') + addr);
      } else {
        flashAddr(view, T('mods.copy.failed'), true);
      }
    });
  }

  // ---------- 双击全屏 ----------
  // 机器类设备 (核电站) 始终允许; 计算机类设备由程序通过
  // mods.setDoubleClickFullscreen(false) 关闭。
  function isFullscreenAllowed(view) {
    if (view.meta && view.meta.computer === false) return true;
    return !(view.state && view.state.doubleClickFullscreen === false);
  }

  function toggleFullscreen(view) {
    if (!view.viewRoot) return;
    view.fullscreen = !view.fullscreen;
    view.viewRoot.classList.toggle('mod-fullscreen', view.fullscreen);
    document.body.classList.toggle('mod-fullscreen-open', view.fullscreen);

    if (view.fullscreen) {
      view.escHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          toggleFullscreen(view);
        }
      };
      document.addEventListener('keydown', view.escHandler, true);
    } else if (view.escHandler) {
      document.removeEventListener('keydown', view.escHandler, true);
      view.escHandler = null;
    }

    if (window.App && App.setStatus) {
      App.setStatus(view.fullscreen ? T('mods.fullscreen.enter') : T('mods.fullscreen.exit'));
    }
    // 画布尺寸会随布局变化
    resizeCanvas(view);
    scheduleDraw(view);
  }

  function bindFullscreen(view) {
    view.viewRoot = view.pane.querySelector('.mod-view');
    if (!view.viewRoot) return;
    view.viewRoot.addEventListener('dblclick', (e) => {
      const target = e.target;
      // 交互控件与地址标签保留自己的双击行为
      if (target.closest('button, input, textarea, select, a, .mod-addr')) return;
      if (!isFullscreenAllowed(view)) return;
      toggleFullscreen(view);
    });
  }

  // ---------- 标签页 ----------
  function bindTabs(view) {
    $$('.mod-tab', view.pane).forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.tab;
        $$('.mod-tab', view.pane).forEach(b => b.classList.toggle('active', b === btn));
        $$('.mod-pane', view.pane).forEach(p => p.classList.toggle('active', p.dataset.pane === name));
        if (name === 'scene') {
          resizeCanvas(view);
          scheduleDraw(view);
        }
      });
    });
  }

  // ---------- 场景控件 ----------
  function bindScene(view) {
    $$('[data-cmd]', view.pane).forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'view-reset') {
          view.scene.yaw = 0.72;
          view.scene.pitch = 0.52;
          view.scene.zoom = 1;
          scheduleDraw(view);
          return;
        }
        if (cmd === 'view-top') {
          view.scene.yaw = 0;
          view.scene.pitch = 1.45;
          view.scene.zoom = 1;
          scheduleDraw(view);
          return;
        }
        if (cmd === 'view-front') {
          view.scene.yaw = 0;
          view.scene.pitch = 0.15;
          view.scene.zoom = 1;
          scheduleDraw(view);
          return;
        }
        if (cmd === 'move') {
          const direction = Number(btn.dataset.dir);
          sendCommand(view, { op: 'move', direction });
        } else if (cmd === 'turn') {
          sendCommand(view, { op: 'turn', clockwise: btn.dataset.dir === '1' });
        } else if (cmd === 'swing') {
          sendCommand(view, { op: 'swing', side: 3 });
        } else if (cmd === 'place') {
          sendCommand(view, { op: 'place', side: 3 });
        } else if (cmd === 'detect') {
          sendCommand(view, { op: 'detect', side: 3 });
        } else if (cmd === 'dmove') {
          sendCommand(view, {
            op: 'move',
            dx: Number(btn.dataset.dx) || 0,
            dy: Number(btn.dataset.dy) || 0,
            dz: Number(btn.dataset.dz) || 0,
          });
        } else if (cmd === 'teleport') {
          const x = Number($('[data-role="coord-x"]', view.pane).value);
          const y = Number($('[data-role="coord-y"]', view.pane).value);
          const z = Number($('[data-role="coord-z"]', view.pane).value);
          if ([x, y, z].every(Number.isFinite)) {
            sendCommand(view, { op: 'invoke', method: 'setPosition', args: [x, y, z] });
          }
        } else if (cmd === 'origin') {
          sendCommand(view, { op: 'invoke', method: 'setPosition', args: [0, 0, 0] });
        }
      });
    });
  }

  async function sendCommand(view, command) {
    try {
      await App.api(`mods/${encodeURIComponent(view.name)}/command`, { method: 'POST', body: command });
    } catch (e) {
      appendLog(view.name, { ts: Date.now(), level: 'error', msg: `${T('mods.command-failed', '命令失败: ')}${e.message}` });
    }
  }

  // ---------- 画布 ----------
  function setupCanvas(view) {
    const c = view.canvas;
    c.addEventListener('pointerdown', (e) => {
      view.scene.dragging = true;
      view.scene.lastX = e.clientX;
      view.scene.lastY = e.clientY;
      c.classList.add('dragging');
      c.setPointerCapture && c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!view.scene.dragging) return;
      const dx = e.clientX - view.scene.lastX;
      const dy = e.clientY - view.scene.lastY;
      view.scene.lastX = e.clientX;
      view.scene.lastY = e.clientY;
      view.scene.yaw += dx * 0.01;
      view.scene.pitch = Math.max(-1.45, Math.min(1.45, view.scene.pitch + dy * 0.01));
      scheduleDraw(view);
    });
    const endDrag = () => {
      view.scene.dragging = false;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', endDrag);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.scene.zoom = Math.max(0.3, Math.min(5, view.scene.zoom * Math.exp(-e.deltaY * 0.0012)));
      scheduleDraw(view);
    }, { passive: false });
    c.addEventListener('dblclick', () => {
      view.scene.yaw = 0.72;
      view.scene.pitch = 0.52;
      view.scene.zoom = 1;
      scheduleDraw(view);
    });

    if (window.ResizeObserver) {
      view.resizeObserver = new ResizeObserver(() => {
        resizeCanvas(view);
        scheduleDraw(view);
      });
      view.resizeObserver.observe(view.canvasWrap);
    } else {
      window.addEventListener('resize', () => {
        resizeCanvas(view);
        scheduleDraw(view);
      });
    }
    resizeCanvas(view);
  }

  function resizeCanvas(view) {
    const wrap = view.canvasWrap;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (view.canvas.width !== Math.round(w * dpr) || view.canvas.height !== Math.round(h * dpr)) {
      view.canvas.width = Math.round(w * dpr);
      view.canvas.height = Math.round(h * dpr);
    }
    view.canvas.style.width = w + 'px';
    view.canvas.style.height = h + 'px';
    view.width = w;
    view.height = h;
    const ctx = view.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function scheduleDraw(view) {
    if (view.raf) return;
    view.raf = requestAnimationFrame(() => {
      view.raf = 0;
      drawScene(view);
    });
  }

  function project(view, x, y, z) {
    const w = view.width || 640;
    const h = view.height || 420;
    const cy = Math.cos(view.scene.yaw);
    const sy = Math.sin(view.scene.yaw);
    const cp = Math.cos(view.scene.pitch);
    const sp = Math.sin(view.scene.pitch);

    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;

    const scale = Math.min(w, h) / 14;
    const persp = 1 / (1 + z2 * 0.055);
    return {
      x: w / 2 + x1 * scale * view.scene.zoom * persp,
      y: h / 2 - y1 * scale * view.scene.zoom * persp,
      depth: z2,
      scale: scale * view.scene.zoom * persp,
    };
  }

  function line3d(ctx, view, a, b, color, width = 1, dashed = false) {
    const pa = project(view, a[0], a[1], a[2]);
    const pb = project(view, b[0], b[1], b[2]);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawLabel(ctx, text, x, y, color = '#dbe7f3') {
    ctx.save();
    ctx.font = '11px Consolas, monospace';
    const pad = 3;
    const m = ctx.measureText(text);
    ctx.fillStyle = 'rgba(5, 10, 18, 0.78)';
    ctx.fillRect(x - pad, y - 11, m.width + pad * 2, 15);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawScene(view) {
    const canvas = view.canvas;
    const ctx = canvas.getContext('2d');
    resizeCanvas(view);
    const w = view.width || 640;
    const h = view.height || 420;

    ctx.clearRect(0, 0, w, h);

    // 背景
    const grad = ctx.createRadialGradient(w / 2, h * 0.45, 20, w / 2, h * 0.45, Math.max(w, h) * 0.7);
    grad.addColorStop(0, '#111b26');
    grad.addColorStop(1, '#070a0e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 网格 (XZ 平面)
    const R = 8;
    for (let i = -R; i <= R; i++) {
      const color = i === 0 ? 'rgba(120, 150, 180, 0.35)' : 'rgba(70, 95, 120, 0.16)';
      line3d(ctx, view, [i, 0, -R], [i, 0, R], color, 1);
      line3d(ctx, view, [-R, 0, i], [R, 0, i], color, 1);
    }

    // 坐标轴
    line3d(ctx, view, [-R, 0, 0], [R, 0, 0], 'rgba(255, 107, 107, 0.9)', 2);
    line3d(ctx, view, [0, -R * 0.35, 0], [0, R * 0.75, 0], 'rgba(104, 211, 145, 0.9)', 2);
    line3d(ctx, view, [0, 0, -R], [0, 0, R], 'rgba(99, 179, 237, 0.9)', 2);

    const axisEnd = project(view, R, 0, 0);
    drawLabel(ctx, 'X', axisEnd.x + 6, axisEnd.y, '#ff8a8a');
    const axisEndY = project(view, 0, R * 0.75, 0);
    drawLabel(ctx, 'Y', axisEndY.x + 6, axisEndY.y, '#8be6a8');
    const axisEndZ = project(view, 0, 0, R);
    drawLabel(ctx, 'Z', axisEndZ.x + 6, axisEndZ.y, '#8cc8f5');

    // 原点
    const o = project(view, 0, 0, 0);
    ctx.strokeStyle = 'rgba(220, 230, 240, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 4, o.y); ctx.lineTo(o.x + 4, o.y);
    ctx.moveTo(o.x, o.y - 4); ctx.lineTo(o.x, o.y + 4);
    ctx.stroke();

    const st = view.state;
    const pos = st && st.position ? st.position : null;
    const target = st && st.target ? st.target : null;
    const type = (view.meta && view.meta.type) || (st && st.deviceType) || 'robot';
    const isDrone = type === 'drone';
    const deviceColor = isDrone ? '#56d4e8' : '#ffb454';

    // 自定义标记点
    for (const marker of (view.markers || [])) {
      const x = Number(marker.x) || 0;
      const y = Number(marker.y) || 0;
      const z = Number(marker.z) || 0;
      const p = project(view, x, y, z);
      const color = marker.color || '#c084fc';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y);
      ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x, p.y + 5);
      ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (marker.label) drawLabel(ctx, String(marker.label), p.x + 8, p.y - 6, color);
    }

    if (!st || !pos) {
      ctx.save();
      ctx.fillStyle = '#7e93a8';
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(T('mods.scene.waiting'), w / 2, h / 2 + 40);
      ctx.restore();
      return;
    }

    // 位置 -> 目标 连线
    if (target && (Math.abs(target.x - pos.x) > 0.01 || Math.abs(target.y - pos.y) > 0.01 || Math.abs(target.z - pos.z) > 0.01)) {
      line3d(ctx, view, [pos.x, pos.y, pos.z], [target.x, target.y, target.z], 'rgba(200, 220, 240, 0.55)', 1, true);
      const tp = project(view, target.x, target.y, target.z);
      ctx.save();
      ctx.strokeStyle = 'rgba(200, 220, 240, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      drawLabel(ctx, `${T('mods.scene.target-label', '目标')} (${fmt(target.x, 1)}, ${fmt(target.y, 1)}, ${fmt(target.z, 1)})`, tp.x + 10, tp.y - 8, '#cfe2f5');
    }

    // 设备位置
    const p = project(view, pos.x, pos.y, pos.z);
    ctx.save();
    ctx.shadowColor = deviceColor;
    ctx.shadowBlur = 12;
    ctx.fillStyle = deviceColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawLabel(ctx, `${isDrone ? '🛸' : '🤖'} ${view.name} (${fmt(pos.x, 1)}, ${fmt(pos.y, 1)}, ${fmt(pos.z, 1)})`, p.x + 12, p.y - 10, deviceColor);

    // 朝向箭头
    const facing = st.facing || 1;
    const dirs = { 1: [0, 0, 1], 2: [-1, 0, 0], 3: [0, 0, -1], 4: [1, 0, 0] };
    const dir = dirs[facing] || dirs[1];
    const fp = project(view, pos.x + dir[0] * 1.6, pos.y + dir[1] * 1.6, pos.z + dir[2] * 1.6);
    ctx.save();
    ctx.strokeStyle = isDrone ? '#9be7f5' : '#ffd08a';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(fp.x, fp.y);
    ctx.stroke();
    const ang = Math.atan2(fp.y - p.y, fp.x - p.x);
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);
    ctx.lineTo(fp.x - 8 * Math.cos(ang - 0.4), fp.y - 8 * Math.sin(ang - 0.4));
    ctx.lineTo(fp.x - 8 * Math.cos(ang + 0.4), fp.y - 8 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 无人机速度矢量
    if (isDrone && st.velocity) {
      const vx = Number(st.velocity.x) || 0;
      const vy = Number(st.velocity.y) || 0;
      const vz = Number(st.velocity.z) || 0;
      if (Math.sqrt(vx * vx + vy * vy + vz * vz) > 0.05) {
        const vp = project(view, pos.x + vx * 0.25, pos.y + vy * 0.25, pos.z + vz * 0.25);
        ctx.save();
        ctx.strokeStyle = '#68d391';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(vp.x, vp.y);
        ctx.stroke();
        ctx.restore();
        drawLabel(ctx, `v ${fmt(Math.sqrt(vx * vx + vy * vy + vz * vz), 1)}`, vp.x + 6, vp.y - 6, '#8be6a8');
      }
    }

    // 原点标签
    drawLabel(ctx, 'O', o.x + 7, o.y - 6, '#b8c7d9');
  }

  // ---------- 状态 / HUD ----------
  function updateState(modName, state, extra = {}) {
    const view = views.get(modName);
    if (!view) return;
    if (state) view.state = state;
    if (extra.address !== undefined) view.address = extra.address;
    if (extra.runtimeState !== undefined) view.runtimeState = extra.runtimeState;
    if (extra.deviceType && view.meta) view.meta.type = extra.deviceType;
    if (state && state.deviceType && view.meta) view.meta.type = state.deviceType;

    updateToolbar(view);
    applyTypeLayout(view);
    renderItems(view);
    updateHUD(view);
    scheduleDraw(view);
  }

  // 核电站 / 自定义机器显示专用面板
  function applyTypeLayout(view) {
    const type = (view.meta && view.meta.type) || 'robot';
    const isReactor = type === 'reactor';
    const isMachine = type === 'machine';
    const machineLike = isReactor || isMachine;
    const sceneTab = $('[data-tab="scene"]', view.pane);
    const reactorTab = $('[data-tab="reactor"]', view.pane);
    const machineTab = $('[data-tab="machine"]', view.pane);
    const itemsTab = $('[data-tab="items"]', view.pane);
    const consoleTab = $('[data-tab="console"]', view.pane);
    if (!sceneTab || !reactorTab) return;

    sceneTab.style.display = machineLike ? 'none' : '';
    reactorTab.style.display = isReactor ? '' : 'none';
    if (machineTab) machineTab.style.display = isMachine ? '' : 'none';
    if (itemsTab) itemsTab.style.display = isMachine ? 'none' : '';
    // 机器类设备没有程序, 控制台标签页也没有意义
    if (consoleTab) consoleTab.style.display = machineLike ? 'none' : '';

    if (isReactor && !view.reactorTabApplied) {
      view.reactorTabApplied = true;
      sceneTab.classList.remove('active');
      if (consoleTab) consoleTab.classList.remove('active');
      reactorTab.classList.add('active');
      $$('.mod-pane', view.pane).forEach(p => p.classList.toggle('active', p.dataset.pane === 'reactor'));
    }

    if (isMachine && !view.machineTabApplied) {
      view.machineTabApplied = true;
      sceneTab.classList.remove('active');
      if (consoleTab) consoleTab.classList.remove('active');
      if (machineTab) machineTab.classList.add('active');
      $$('.mod-pane', view.pane).forEach(p => p.classList.toggle('active', p.dataset.pane === 'machine'));
    }

    if (!machineLike) {
      stopReactorPolling(view);
      return;
    }

    // 机器类设备的数值每秒都在变, 打开面板期间持续刷新
    ensureReactorPolling(view, true);

    if (isMachine) {
      renderMachine(view);
      return;
    }

    if (!window.ReactorView) return;
    const data = view.meta && view.meta.reactor;
    const infoRoot = $('[data-role="reactor-info"]', view.pane);
    if (!data || !infoRoot) return;

    // 布局或运行块结构变化时重建面板; 仅数值变化时原地更新
    const cfg = data.config || {};
    const runtime = data.runtime || null;
    const layoutSig = JSON.stringify([cfg.columns, cfg.active, cfg.grid, !!runtime, data.connectedVm || null]);
    if (infoRoot.dataset.layoutSig !== layoutSig) {
      infoRoot.dataset.layoutSig = layoutSig;
      ReactorView.renderInfo(infoRoot, data);
      infoRoot.dataset.runtimeSig = runtimeSig(runtime);
      bindReactorActions(infoRoot, view);
      return;
    }
    const sig = runtimeSig(runtime);
    if (infoRoot.dataset.runtimeSig !== sig) {
      infoRoot.dataset.runtimeSig = sig;
      ReactorView.updateInfo(infoRoot, data);
    }
  }

  function runtimeSig(runtime) {
    if (!runtime) return '';
    return [runtime.running ? 1 : 0, runtime.elapsed, Math.round(runtime.hullHeat),
      Math.round(runtime.remainingCapacity || 0), Math.round(runtime.generatedEu || 0), runtime.status].join('|');
  }

  // 自定义机器: 通用属性面板 + 脚本编辑
  function renderMachine(view) {
    if (!window.MachineView) return;
    const data = view.meta && view.meta.machine;
    const infoRoot = $('[data-role="machine-info"]', view.pane);
    if (!data || !infoRoot) return;
    const opts = {
      modName: view.name,
      onConnect: () => openConnectDialog(view),
      onEditScript: () => openMachineScriptDialog(view.name),
    };
    if (!infoRoot.dataset.machineRendered) {
      infoRoot.dataset.machineRendered = '1';
      MachineView.render(infoRoot, data, opts);
    } else {
      MachineView.update(infoRoot, data);
    }
  }

  async function openMachineScriptDialog(modName) {
    let script = '';
    try {
      const machine = await App.api(`mods/${encodeURIComponent(modName)}/machine`);
      script = (machine && machine.script) || '';
    } catch (e) {
      alert(`${T('machine.load-failed', '读取脚本失败')}: ${e.message}`);
      return;
    }

    Modal.open({
      title: `${T('machine.script-title', '编辑机器脚本')} · ${modName}`,
      size: 'large',
      bodyHTML: `
        <div class="machine-script-wrap">
          <textarea id="machine-script-source" spellcheck="false"></textarea>
          <p class="hint">${escapeHTML(T('machine.script-hint', '脚本返回组件定义表；保存后会重启机器脚本并重建组件。'))}</p>
        </div>
      `,
      footerHTML: `
        <button class="btn" data-action="modal-close">${T('wizard.cancel', '取消')}</button>
        <button class="btn btn-primary" id="machine-script-save">${T('machine.save', '保存并重启')}</button>
      `,
      onMount(body, footer) {
        const area = body.querySelector('#machine-script-source');
        if (area) area.value = script;
        const cancel = footer.querySelector('[data-action="modal-close"]');
        if (cancel) cancel.addEventListener('click', () => Modal.close());
        const save = footer.querySelector('#machine-script-save');
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            const result = await App.api(`mods/${encodeURIComponent(modName)}/machine`, {
              method: 'PUT',
              body: { script: area ? area.value : '' },
            });
            if (result && result.error) throw new Error(result.error);
            Modal.close();
            if (window.App && App.setStatus) App.setStatus(T('machine.saved', '机器脚本已保存'));
            reload(modName);
          } catch (e) {
            save.disabled = false;
            alert(`${T('machine.save-failed', '保存失败')}: ${e.message}`);
          }
        });
      },
    });
  }

  // 启动 / 停止 / 复位堆芯
  function bindReactorActions(infoRoot, view) {
    const setActive = async (active, btn) => {
      btn.disabled = true;
      try {
        const r = await App.api(`mods/${encodeURIComponent(view.name)}/reactor-active`, {
          method: 'POST',
          body: { active },
        });
        if (r && r.error) throw new Error(r.error);
        if (window.App && App.setStatus) {
          App.setStatus(T(active ? 'reactor.info.started' : 'reactor.info.stopped',
            active ? '反应堆已启动' : '反应堆已停止'));
        }
        reload(view.name);
        if (window.App && App.refreshMods) App.refreshMods();
      } catch (e) {
        appendLog(view.name, {
          ts: Date.now(),
          level: 'error',
          msg: `${T('mods.request-failed', '请求失败: ')}${e.message}`,
        });
      } finally {
        btn.disabled = false;
      }
    };

    const startBtn = infoRoot.querySelector('[data-role="reactor-start"]');
    if (startBtn) startBtn.addEventListener('click', () => setActive(true, startBtn));
    const stopBtn = infoRoot.querySelector('[data-role="reactor-stop"]');
    if (stopBtn) stopBtn.addEventListener('click', () => setActive(false, stopBtn));

    const connectBtn = infoRoot.querySelector('[data-role="connect"]');
    if (connectBtn) connectBtn.addEventListener('click', () => openConnectDialog(view));

    const btn = infoRoot.querySelector('[data-role="reset-core"]');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await App.api(`mods/${encodeURIComponent(view.name)}/reactor`, { method: 'POST' });
        if (r && r.error) throw new Error(r.error);
        if (window.App && App.setStatus) App.setStatus(T('reactor.info.reset-done', '堆芯已复位'));
        reload(view.name);
      } catch (e) {
        appendLog(view.name, { ts: Date.now(), level: 'error', msg: `${T('reactor.info.reset-failed', '复位堆芯失败')}: ${e.message}` });
      } finally {
        btn.disabled = false;
      }
    });
  }

  // 连接到虚拟机: 相当于接一根线, 只有选中的虚拟机能看到该组件
  async function openConnectDialog(view) {
    let vms = [];
    try {
      const list = await App.api('vms');
      vms = Array.isArray(list) ? list : [];
    } catch {
      vms = [];
    }
    if (!vms.length) {
      alert(T('reactor.connect.no-vm', '暂无可连接的虚拟机'));
      return;
    }

    const current = (view.meta && ((view.meta.reactor && view.meta.reactor.connectedVm) || view.meta.connectedVm)) || '';
    const options = vms.map(vm => {
      const selected = vm.name === current ? ' selected' : '';
      return `<option value="${escapeHTML(vm.name)}"${selected}>${escapeHTML(vm.name)} ${escapeHTML(stateLabel(vm.state))}</option>`;
    }).join('');

    Modal.open({
      title: T('reactor.connect.title', '连接到虚拟机'),
      size: 'small',
      bodyHTML: `
        <div class="form-row">
          <label>${T('reactor.connect.select', '选择虚拟机')}</label>
          <select id="reactor-connect-vm">
            <option value="">${T('reactor.connect.disconnect', '不连接')}</option>
            ${options}
          </select>
        </div>
        <p class="hint" style="margin:8px 0 0;color:var(--fg-muted);font-size:12px;line-height:1.6;">
          ${escapeHTML(T('reactor.connect.hint', '连接后该设备只会出现在所选虚拟机的组件列表中，相当于接上一条线。'))}
        </p>
      `,
      footerHTML: `
        <button class="btn" data-action="modal-close">${T('wizard.cancel', '取消')}</button>
        <button class="btn btn-primary" id="reactor-connect-save">${T('reactor.connect.save', '连接')}</button>
      `,
      onMount(body, footer) {
        const cancel = footer.querySelector('[data-action="modal-close"]');
        if (cancel) cancel.addEventListener('click', () => Modal.close());

        const save = footer.querySelector('#reactor-connect-save');
        save.addEventListener('click', async () => {
          const vm = body.querySelector('#reactor-connect-vm').value || null;
          save.disabled = true;
          try {
            const r = await App.api(`mods/${encodeURIComponent(view.name)}/connect`, {
              method: 'POST',
              body: { vm },
            });
            if (r && r.error) throw new Error(r.error);
            Modal.close();
            if (window.App && App.setStatus) {
              App.setStatus(vm
                ? I18N.t('reactor.connect.done', { vm })
                : T('reactor.connect.cleared', '已断开连接'));
            }
            reload(view.name);
            if (window.App && App.refreshMods) App.refreshMods();
          } catch (e) {
            save.disabled = false;
            alert(`${T('reactor.connect.failed', '连接失败')}: ${e.message}`);
          }
        });
      },
    });
  }

  function ensureReactorPolling(view, active) {
    if (!active) return stopReactorPolling(view);
    if (view.reactorTimer) return;
    view.reactorTimer = setInterval(() => reload(view.name), 1000);
  }

  function stopReactorPolling(view) {
    if (view.reactorTimer) {
      clearInterval(view.reactorTimer);
      view.reactorTimer = null;
    }
  }

  function updateToolbar(view) {
    const st = view.state;
    const type = (view.meta && view.meta.type) || (st && st.deviceType) || 'robot';
    const ti = typeInfo(type);
    view.badgeEl.className = `mod-badge ${ti.cls}`;
    view.badgeEl.textContent = `${ti.icon} ${ti.label}`;

    const runtime = view.runtimeState || 'stopped';
    view.stateEl.className = `mod-state ${runtime}`;
    view.stateEl.textContent = stateLabel(runtime);

    // 机器类设备 (核电站) 没有程序与无线网卡, 只显示组件地址
    const isMachine = view.meta ? view.meta.computer === false : false;
    const addrLabel = isMachine
      ? T('mods.component-address', '组件地址')
      : T('mods.wireless-address', '无线地址');

    if (!view.addrFlashTimer) {
      if (view.address) {
        view.addrEl.textContent = `${addrLabel}: ${view.address}`;
        view.addrEl.title = T('mods.addr.copy-title');
      } else {
        view.addrEl.textContent = isMachine
          ? `${addrLabel}: -`
          : `${addrLabel}: ${T('mods.addr.placeholder')}`;
        view.addrEl.title = isMachine ? '' : T('mods.addr.after-start');
      }
    }

    const efi = view.meta && view.meta.efi;
    if (isMachine) {
      view.efiEl.style.display = 'none';
    } else {
      view.efiEl.style.display = '';
      view.efiEl.textContent = efi === 'missing' ? T('mods.efi.missing') : T('mods.efi.builtin');
      view.efiEl.style.color = efi === 'missing' ? 'var(--err)' : '';
    }

    // 机器类设备没有启动/停止/重启
    $$('[data-act]', view.pane).forEach(btn => {
      const act = btn.dataset.act;
      if (isMachine && (act === 'start' || act === 'stop' || act === 'restart')) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = '';
      if (act === 'start') btn.disabled = runtime === 'running' || runtime === 'starting';
      if (act === 'stop') btn.disabled = runtime === 'stopped' || runtime === 'error';
    });

    const disabled = runtime !== 'running';
    const isDrone = type === 'drone';
    const isReactor = type === 'reactor';
    $$('[data-cmd]', view.pane).forEach(btn => {
      const cmd = btn.dataset.cmd;
      const viewOnly = ['view-reset', 'view-top', 'view-front'].includes(cmd);
      if (cmd && !viewOnly) {
        btn.disabled = disabled;
      }
      // 机器人移动与无人机偏移只显示对应的控制组
      if (cmd === 'dmove' && !isDrone) btn.disabled = true;
      if ((cmd === 'move' || cmd === 'turn') && isDrone) btn.disabled = true;
      // 核电站不移动, 只保留视角控制
      if (isReactor && !viewOnly) btn.disabled = true;
    });
  }

  function updateHUD(view) {
    const st = view.state;
    if (!st) {
      view.hud.innerHTML = `<span>${T('mods.hud.status')}: ${escapeHTML(stateLabel(view.runtimeState))}</span><span>${T('mods.hud.waiting')}</span>`;
      return;
    }
    const pos = st.position || {};
    const target = st.target || {};
    const vel = st.velocity || {};
    const off = Math.sqrt(
      Math.pow((target.x || 0) - (pos.x || 0), 2) +
      Math.pow((target.y || 0) - (pos.y || 0), 2) +
      Math.pow((target.z || 0) - (pos.z || 0), 2)
    );
    const speed = Math.sqrt((vel.x || 0) ** 2 + (vel.y || 0) ** 2 + (vel.z || 0) ** 2);
    view.hud.innerHTML = `
      <span>${T('mods.hud.position')} <b>${escapeHTML(vec(pos))}</b></span>
      <span>${T('mods.hud.facing')} <b>${escapeHTML(st.facingName || st.facing || '-')}</b></span>
      <span>${T('mods.hud.target')} <b>${escapeHTML(vec(target))}</b> · ${T('mods.hud.distance')} <b>${escapeHTML(fmt(off))}</b></span>
      <span>${T('mods.hud.speed')} <b>${escapeHTML(fmt(speed))}</b> · ${T('mods.hud.energy')} <b>${escapeHTML(fmt(st.energy, 0))}</b></span>
      <span>${T('mods.hud.markers')} <b>${(view.markers || []).length}</b> · ${T('mods.hud.running')} <b>${st.running ? T('common.yes') : T('common.no')}</b></span>
    `;
  }

  // ---------- 物品 / 状态页 ----------
  function renderItems(view) {
    const st = view.state;
    const meta = view.meta || {};
    if (meta.computer === false) {
      renderMachineInfo(view);
      return;
    }
    if (!st) {
      view.itemsEl.innerHTML = `<div class="mod-empty">${T('mods.items.no-state')}</div>`;
      return;
    }

    const cards = [
      { k: T('mods.card.type'), v: typeInfo((meta.type || st.deviceType || 'robot')).label },
      { k: T('mods.card.state'), v: stateLabel(view.runtimeState), cls: view.runtimeState === 'running' ? 'ok' : '' },
      { k: T('mods.card.position'), v: vec(st.position) },
      { k: T('mods.card.facing'), v: st.facingName || String(st.facing || '-') },
      { k: T('mods.card.target'), v: vec(st.target) },
      { k: T('mods.card.energy'), v: `${fmt(st.energy, 0)} / ${fmt(st.maxEnergy, 0)}` },
      { k: T('mods.card.selected'), v: String(st.selected || 1) },
      { k: T('mods.card.light'), v: '#' + Number(st.light || 0).toString(16).padStart(6, '0') },
    ];
    if (st.lastError) cards.push({ k: T('mods.card.last-error'), v: String(st.lastError), cls: 'err' });

    // 核电站摘要
    const reactor = meta.reactor;
    if (reactor && reactor.stats) {
      const rs = reactor.stats;
      cards.push({ k: T('reactor.title', '核电站'), v: `${rs.columns} × ${rs.rows}` });
      cards.push({ k: T('reactor.eu', 'EU/t'), v: String(rs.euPerTick) });
      cards.push({ k: T('reactor.heat', '热量/t'), v: String(rs.heatPerTick) });
      cards.push({ k: T('reactor.heat-capacity', '吸热容量'), v: Number(rs.effectiveHeatCapacity || rs.heatCapacity || 0).toLocaleString() });
      cards.push({ k: T('reactor.status', '状态'), v: T(`reactor.status.${rs.status}`, rs.status) });
    }

    const cardsHTML = cards.map(c => `
      <div class="mod-card">
        <div class="k">${escapeHTML(c.k)}</div>
        <div class="v ${c.cls || ''}">${escapeHTML(c.v)}</div>
      </div>
    `).join('');

    // 工具 (主手 / 副手)
    const toolRow = (label, t) => {
      if (!t) return `<tr><td>${escapeHTML(label)}</td><td>${T('common.empty-hand')}</td><td class="num">-</td></tr>`;
      const dur = (t.durability != null && t.maxDurability)
        ? `${fmt(t.durability, 0)} / ${fmt(t.maxDurability, 0)}` : T('mods.tool.unbreakable');
      return `<tr><td>${escapeHTML(label)}</td><td>${escapeHTML(t.name || '-')}</td><td class="num">${escapeHTML(dur)}</td></tr>`;
    };
    let toolHTML = `<div class="mod-empty">${T('mods.tool.none')}</div>`;
    if (st.tool || st.offhand) {
      toolHTML = `
        <table class="mod-table">
          <tr><th>${T('common.slot')}</th><th>${T('common.tool')}</th><th>${T('common.durability')}</th></tr>
          ${toolRow(T('mods.tool.main'), st.tool)}
          ${toolRow(T('mods.tool.off'), st.offhand)}
        </table>`;
    }

    // 储罐
    let tanksHTML = `<div class="mod-empty">${T('mods.tank.none')}</div>`;
    if (Array.isArray(st.tanks) && st.tanks.length > 0) {
      const rows = st.tanks.map((tk, i) => `
        <tr class="${i + 1 === st.selectedTank ? 'selected' : ''}">
          <td>${i + 1}</td>
          <td>${escapeHTML(tk.fluid || '-')}</td>
          <td class="num">${fmt(tk.amount, 0)}</td>
          <td class="num">${fmt(tk.capacity, 0)}</td>
        </tr>
      `).join('');
      tanksHTML = `
        <table class="mod-table">
          <tr><th>#</th><th>${T('common.fluid')}</th><th>${T('common.amount')}</th><th>${T('common.capacity')}</th></tr>
          ${rows}
        </table>`;
    }

    // 物品栏
    let invHTML = `<div class="mod-empty">${T('mods.inv.empty')}</div>`;
    if (Array.isArray(st.inventory) && st.inventory.length > 0) {
      const rows = st.inventory.map(it => `
        <tr class="${it.slot === st.selected ? 'selected' : ''}">
          <td>${it.slot}</td>
          <td>${escapeHTML(it.name || '-')}</td>
          <td class="num">${fmt(it.count, 0)}</td>
          <td class="num">${fmt(it.maxCount, 0)}</td>
        </tr>
      `).join('');
      invHTML = `
        <table class="mod-table">
          <tr><th>${T('common.slot')}</th><th>${T('common.item')}</th><th>${T('common.count')}</th><th>${T('common.limit')}</th></tr>
          ${rows}
        </table>`;
    }

    view.itemsEl.innerHTML = `
      <div class="mod-info-grid">${cardsHTML}</div>
      ${meta.description ? `<div class="mod-empty" style="text-align:left;">${escapeHTML(meta.description)}</div>` : ''}
      <div>
        <div class="scene-section-title">${T('mods.section.tools')}</div>
        ${toolHTML}
      </div>
      <div>
        <div class="scene-section-title">${T('mods.section.tanks')}</div>
        ${tanksHTML}
      </div>
      <div>
        <div class="scene-section-title">${T('mods.section.inventory')}</div>
        ${invHTML}
      </div>
    `;
  }

  // 机器类设备 (核电站) 的摘要: 没有物品栏与工具, 只显示设备参数
  function renderMachineInfo(view) {
    const meta = view.meta || {};
    const reactor = meta.reactor || null;
    const stats = reactor && reactor.stats ? reactor.stats : null;
    const runtime = reactor && reactor.runtime ? reactor.runtime : null;

    const cards = [
      { k: T('mods.card.type'), v: typeInfo(meta.type || 'reactor').label },
      { k: T('mods.card.state'), v: stateLabel(view.runtimeState), cls: view.runtimeState === 'running' ? 'ok' : '' },
      { k: T('mods.component-address', '组件地址'), v: view.address || '-' },
    ];
    if (stats) {
      cards.push({ k: T('reactor.size', '大小'), v: `${stats.columns} × ${stats.rows}` });
      cards.push({ k: T('reactor.eu', 'EU/t'), v: String(stats.euPerTick) });
      cards.push({ k: T('reactor.heat', '热量/t'), v: String(stats.heatPerTick) });
      cards.push({ k: T('reactor.heat-capacity', '吸热容量'), v: Number(stats.effectiveHeatCapacity || 0).toLocaleString() });
      cards.push({ k: T('reactor.info.fuel-rods', '燃料棒'), v: String(stats.fuelRods) });
    }
    if (runtime) {
      cards.push({ k: T('reactor.info.temperature', '温度'), v: window.ReactorView && ReactorView.temperatureRangeText
        ? ReactorView.temperatureRangeText(runtime)
        : `${Math.round(runtime.temperature || 0)} °C` });
      cards.push({ k: T('reactor.info.generated', '累计发电'), v: `${Math.round(runtime.generatedEu).toLocaleString()} EU` });
      cards.push({ k: T('reactor.info.elapsed', '运行时长'), v: String(Math.floor(runtime.elapsed)) + 's' });
    }

    const cardsHTML = cards.map(c => `
      <div class="mod-card">
        <div class="k">${escapeHTML(c.k)}</div>
        <div class="v ${c.cls || ''}">${escapeHTML(c.v)}</div>
      </div>
    `).join('');

    view.itemsEl.innerHTML = `
      <div class="mod-info-grid">${cardsHTML}</div>
      <div class="mod-empty" style="text-align:left;">${escapeHTML(T('mods.machine-hint', '该设备不是计算机：没有 EFI、硬盘与程序，其它计算机可以通过组件访问它。'))}</div>
    `;
  }

  // ---------- 日志 ----------
  function appendLog(modName, entry) {
    const view = views.get(modName);
    if (!view || !entry) return;
    const key = `${entry.ts || 0}|${entry.msg || ''}`;
    if (view.seenLogs.has(key)) return;
    view.seenLogs.add(key);
    view.logs.push(entry);
    if (view.logs.length > 300) view.logs.shift();

    if (view.logs.length === 1) view.consoleEl.innerHTML = '';
    const el = document.createElement('div');
    el.className = `mod-log-line ${entry.level || 'info'}`;
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    el.innerHTML = `<span class="ts">${escapeHTML(ts)}</span>${escapeHTML(entry.msg || '')}`;
    view.consoleEl.appendChild(el);
    view.consoleEl.scrollTop = view.consoleEl.scrollHeight;
  }

  // ---------- 核电站配置: 只有设备本身, 没有 EFI / 磁盘 ----------
  async function openReactorConfig(modName, mod) {
    let data = mod.reactor || null;
    if (!data) {
      try {
        data = await App.api(`mods/${encodeURIComponent(modName)}/reactor`);
      } catch (e) {
        appendLog(modName, { ts: Date.now(), level: 'error', msg: `${T('mods.config.load-failed', '加载配置失败')}: ${e.message}` });
      }
    }
    Modal.open({
      title: `${T('mods.config.title', '配置')} · ${modName}`,
      size: 'large',
      bodyHTML: '<div class="mod-config"><div id="mod-reactor-root"></div></div>',
      footerHTML: `<button class="btn" data-action="modal-close" type="button">${T('mods.config.close', '关闭')}</button>`,
      onMount(body, footer) {
        const root = body.querySelector('#mod-reactor-root');
        if (root && data && !data.error && window.ReactorView) {
          ReactorView.render(root, modName, data, {
            onSaved: () => {
              if (window.App) App.refreshMods(true);
              reload(modName);
            },
          });
        } else if (root) {
          root.innerHTML = `<div class="hw-note">${T('mods.config.load-failed', '加载配置失败')}</div>`;
        }
        const close = footer.querySelector('[data-action="modal-close"]');
        if (close) close.addEventListener('click', () => Modal.close());
      },
    });
  }

  // ---------- 配置 (EFI / 硬件) ----------
  async function openConfig(modName) {
    let mod, efi;
    try {
      mod = await App.api(`mods/${encodeURIComponent(modName)}`) || {};
      if (mod.error) throw new Error(mod.error);
      // 机器类设备没有程序与硬件, 只配置设备本身
      if (mod.type === 'reactor') return openReactorConfig(modName, mod);
      if (mod.type === 'machine') return openMachineScriptDialog(modName);
      efi = await App.api(`mods/${encodeURIComponent(modName)}/efi`) || {};
      if (efi.error) throw new Error(efi.error);
    } catch (e) {
      const msg = T('mods.config.load-failed', '加载配置失败') + ': ' + e.message;
      appendLog(modName, { ts: Date.now(), level: 'error', msg });
      if (window.App && App.setStatus) App.setStatus(msg, 'err');
      return;
    }

    const cfg = mod.config || {};
    const hw = cfg.hardware || {};
    const exp = Array.isArray(hw.expansion) ? hw.expansion : [null, null, null];
    const curApu = (hw.apu && hw.apu.tier) || 1;
    const curMem = (Array.isArray(hw.memory) && hw.memory.length ? hw.memory[0] : 1);
    const curScreen = (cfg.screen && cfg.screen.tier) || 1;
    const curStrength = hw.modemStrength == null ? '' : String(hw.modemStrength);
    const isRunning = mod.state === 'running' || mod.state === 'starting';
    const maxSize = Number(efi.maxSize) || 4096;

    // 设备专属配置: 机器人 (主手/副手工具) / 无人机 (飞行参数)
    const profile = mod.profile || null;
    const hasProfile = !!(profile && (profile.type === 'robot' || profile.type === 'drone'));
    const isDroneProfile = hasProfile && profile.type === 'drone';
    const pv = (profile && profile.value) || {};
    const pLimits = (profile && profile.limits) || {};
    const limitOf = (name) => pLimits[name] || { min: 0, max: 999 };
    const profLabel = isDroneProfile
      ? T('mods.config.drone-tab', '无人机')
      : T('mods.config.robot-tab', '机器人');
    const profIcon = isDroneProfile ? '🚁' : '🤖';
    const toolOpts = (cur) => ((profile && profile.tools) || [])
      .map(t => `<option value="${escapeHTML(t.id)}" ${t.id === (cur || '') ? 'selected' : ''}>${escapeHTML(T('mods.tool.' + (t.id || 'empty'), t.label))}</option>`)
      .join('');
    const numField = (id, label, value, name) => {
      const lim = limitOf(name);
      return `<div class="form-row"><label>${escapeHTML(label)}</label>
        <input type="number" id="${id}" min="${lim.min}" max="${lim.max}" step="1" value="${escapeHTML(String(value == null ? '' : value))}"></div>`;
    };
    const inventoryField = numField('mod-prof-inventory-size', T('mods.config.inventory-size', '物品栏格数'),
      pv.inventorySize, 'inventorySize');
    const profilePaneHTML = !hasProfile ? '' : (isDroneProfile ? `
          ${numField('mod-prof-max-velocity', T('mods.config.max-velocity', '最大速度'), pv.maxVelocity, 'maxVelocity')}
          ${numField('mod-prof-acceleration', T('mods.config.acceleration', '加速度'), pv.acceleration, 'acceleration')}
          ${inventoryField}
          <div class="hw-note">${T('mods.config.profile-drone-hint', '无人机没有工具槽位，最大速度与加速度决定飞行表现；修改后需要重启 Mod 生效。')}</div>
        ` : `
          <div class="form-row"><label>${T('mods.config.tool-main', '主手工具')}</label><select id="mod-prof-tool-main">${toolOpts(pv.toolMain)}</select></div>
          <div class="form-row"><label>${T('mods.config.tool-off', '副手工具')}</label><select id="mod-prof-tool-off">${toolOpts(pv.toolOff)}</select></div>
          ${inventoryField}
          ${numField('mod-prof-tank-count', T('mods.config.tank-count', '内部储罐'), pv.tankCount, 'tankCount')}
          <div class="hw-note">${T('mods.config.profile-robot-hint', '主手 / 副手工具在设备启动时自动装备，物品栏格数与储罐数量决定内部容量；修改后需要重启 Mod 生效。')}</div>
        `);

    const opt = (value, label, current) =>
      `<option value="${escapeHTML(String(value))}" ${String(value) === String(current) ? 'selected' : ''}>${escapeHTML(label)}</option>`;

    const apuOpts = [
      opt(1, I18N.t('hw.option-apu-t1'), curApu),
      opt(2, I18N.t('hw.option-apu-t2'), curApu),
      opt(3, I18N.t('hw.option-apu-t3'), curApu),
      opt('creative', I18N.t('hw.option-apu-creative'), curApu),
    ].join('');

    const memOpts = [
      [1, '1'], [1.5, '1.5'], [2, '2'], [2.5, '2.5'], [3, '3'], [3.5, '3.5'],
    ].map(([v, l]) => opt(v, l, curMem)).join('');

    const screenOpts = [
      opt(1, I18N.t('hw.option-screen-t1'), curScreen),
      opt(2, I18N.t('hw.option-screen-t2'), curScreen),
      opt(3, I18N.t('hw.option-screen-t3'), curScreen),
    ].join('');

    const expOpts = (cur) => [
      opt('', T('mods.config.empty-slot', '空槽'), cur || ''),
      opt('internet', I18N.t('hw.option-internet'), cur),
      opt('data_t1', I18N.t('hw.option-data-t1'), cur),
      opt('data_t2', I18N.t('hw.option-data-t2'), cur),
      opt('data_t3', I18N.t('hw.option-data-t3'), cur),
      opt('wireless_t1', I18N.t('hw.option-wireless-t1'), cur),
      opt('wireless_t2', I18N.t('hw.option-wireless-t2'), cur),
    ].join('');

    const strengthOpts = [
      opt('', T('mods.config.auto', '自动'), curStrength),
      ...Array.from({ length: 16 }, (_, i) => opt(String(i + 1), String(i + 1), curStrength)),
    ].join('');

    const bodyHTML = `
      <div class="mod-config">
        <div class="mod-config-tabs">
          <button class="mod-config-tab active" data-mctab="efi" type="button">${T('mods.config.efi', 'EFI 程序')}</button>
          <button class="mod-config-tab" data-mctab="hardware" type="button">${T('mods.config.hardware', '硬件')}</button>
          ${hasProfile ? `<button class="mod-config-tab" data-mctab="profile" type="button">${profIcon} ${escapeHTML(profLabel)}</button>` : ''}
        </div>
        <div class="mod-config-pane active" data-mcpane="efi">
          <div class="efi-bar">
            <span>${T('mods.config.efi-limit', 'EEPROM 上限')}: <b>${maxSize}</b> bytes</span>
            <span id="mod-efi-size">0 / ${maxSize}</span>
          </div>
          <textarea id="mod-efi-editor" class="efi-editor" spellcheck="false"></textarea>
          <div class="efi-hint">
            <span>${T('mods.config.efi-hint', 'EFI 就是 Mod 的启动程序；保存后需要重启 Mod 生效。')}</span>
            <button class="btn" id="mod-efi-restore" type="button">${T('mods.config.restore', '恢复内置 EFI')}</button>
          </div>
        </div>
        <div class="mod-config-pane" data-mcpane="hardware">
          <div class="form-row"><label>${T('mods.config.apu', 'APU 等级')}</label><select id="mod-hw-apu">${apuOpts}</select></div>
          <div class="form-row"><label>${T('mods.config.memory', '内存')}</label><select id="mod-hw-memory">${memOpts}</select></div>
          <div class="form-row"><label>${T('mods.config.screen', '屏幕等级')}</label><select id="mod-hw-screen">${screenOpts}</select></div>
          <div class="form-row"><label>${I18N.t('hw.exp1')}</label><select id="mod-hw-exp1">${expOpts(exp[0])}</select></div>
          <div class="form-row"><label>${I18N.t('hw.exp2')}</label><select id="mod-hw-exp2">${expOpts(exp[1])}</select></div>
          <div class="form-row"><label>${I18N.t('hw.exp3')}</label><select id="mod-hw-exp3">${expOpts(exp[2])}</select></div>
          <div class="form-row"><label>${T('mods.config.strength', '无线信号强度')}</label><select id="mod-hw-strength">${strengthOpts}</select></div>
          <div class="form-row"><label>${T('mods.config.eeprom', 'EEPROM')}</label><span class="hint">efi.lua · ${T('mods.config.fixed', '系统维护')}</span></div>
          <div class="form-row"><label>${T('mods.config.boot-disk', '启动盘')}</label><span class="hint">disk.ocd · ${T('mods.config.fixed', '系统维护')}</span></div>
          <div class="hw-note">${T('mods.config.hw-hint', 'EEPROM 固定为 efi.lua，启动盘由系统自动维护；修改硬件后需要重启 Mod 生效。')}</div>
        </div>
        ${hasProfile ? `<div class="mod-config-pane" data-mcpane="profile">${profilePaneHTML}
        </div>` : ''}
      </div>
    `;

    const footerHTML = `
      ${isRunning ? `<label class="checkbox-line" style="margin-right:auto;">
        <input type="checkbox" id="mod-cfg-restart" checked>
        <span>${T('mods.config.restart', '保存后重启 Mod')}</span>
      </label>` : ''}
      <button class="btn" data-action="modal-close" type="button">${T('mods.config.cancel', '取消')}</button>
      <button class="btn btn-primary" id="mod-cfg-save" type="button">${T('mods.config.save', '保存')}</button>
    `;

    Modal.open({
      title: `${T('mods.config.title', '配置')} · ${modName}`,
      size: 'large',
      bodyHTML,
      footerHTML,
      onMount(body, footer) {
        const editor = body.querySelector('#mod-efi-editor');
        const sizeEl = body.querySelector('#mod-efi-size');
        const saveBtn = footer.querySelector('#mod-cfg-save');
        const restoreBtn = body.querySelector('#mod-efi-restore');
        const restartEl = footer.querySelector('#mod-cfg-restart');

        editor.value = efi.content || '';

        const byteLength = (s) => new TextEncoder().encode(s).length;
        const updateSize = () => {
          const bytes = byteLength(editor.value);
          sizeEl.textContent = `${bytes} / ${maxSize}`;
          const over = bytes > maxSize;
          sizeEl.classList.toggle('over', over);
          editor.classList.toggle('over', over);
          saveBtn.disabled = over || editor.value.trim() === '';
        };

        updateSize();
        editor.addEventListener('input', updateSize);

        // Tab 插入两个空格, Ctrl+S 保存
        editor.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const s = editor.selectionStart;
            const t = editor.selectionEnd;
            editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(t);
            editor.selectionStart = editor.selectionEnd = s + 2;
            updateSize();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveBtn.click();
          }
        });

        restoreBtn.addEventListener('click', () => {
          editor.value = efi.template || '';
          updateSize();
          editor.focus();
        });

        const cancel = footer.querySelector('[data-action="modal-close"]');
        if (cancel) cancel.addEventListener('click', () => Modal.close());

        $$('.mod-config-tab', body).forEach(btn => {
          btn.addEventListener('click', () => {
            const name = btn.dataset.mctab;
            $$('.mod-config-tab', body).forEach(b => b.classList.toggle('active', b === btn));
            $$('.mod-config-pane', body).forEach(p => p.classList.toggle('active', p.dataset.mcpane === name));
          });
        });

        saveBtn.addEventListener('click', async () => {
          const content = editor.value;
          if (content.trim() === '') {
            alert(T('mods.config.efi-empty', 'EFI 不能为空'));
            return;
          }
          if (byteLength(content) > maxSize) {
            alert(T('mods.config.efi-too-large', 'EFI 超过 4096 字节限制'));
            return;
          }

          const oldText = saveBtn.textContent;
          saveBtn.disabled = true;
          saveBtn.textContent = '…';
          try {
            const r1 = await App.api(`mods/${encodeURIComponent(modName)}/efi`, {
              method: 'PUT',
              body: { content },
            });
            if (r1 && r1.error) throw new Error(r1.error);

            const apuVal = body.querySelector('#mod-hw-apu').value;
            const memVal = Number(body.querySelector('#mod-hw-memory').value);
            const screenVal = Number(body.querySelector('#mod-hw-screen').value);
            const expVal = [
              body.querySelector('#mod-hw-exp1').value || null,
              body.querySelector('#mod-hw-exp2').value || null,
              body.querySelector('#mod-hw-exp3').value || null,
            ];
            const strengthVal = body.querySelector('#mod-hw-strength').value;
            const patch = {
              apu: { tier: apuVal === 'creative' ? 'creative' : Number(apuVal) },
              memory: [memVal, memVal],
              expansion: expVal,
              modemStrength: strengthVal === '' ? null : Number(strengthVal),
              screenTier: screenVal,
            };
            if (hasProfile) {
              const readNum = (sel) => Number(body.querySelector(sel).value);
              patch.profile = isDroneProfile
                ? {
                  maxVelocity: readNum('#mod-prof-max-velocity'),
                  acceleration: readNum('#mod-prof-acceleration'),
                  inventorySize: readNum('#mod-prof-inventory-size'),
                }
                : {
                  toolMain: body.querySelector('#mod-prof-tool-main').value,
                  toolOff: body.querySelector('#mod-prof-tool-off').value,
                  inventorySize: readNum('#mod-prof-inventory-size'),
                  tankCount: readNum('#mod-prof-tank-count'),
                };
            }
            const r2 = await App.api(`mods/${encodeURIComponent(modName)}/config`, {
              method: 'PUT',
              body: patch,
            });
            if (r2 && r2.error) throw new Error(r2.error);

            const restart = !!(restartEl && restartEl.checked);
            if (restart) {
              const r3 = await App.api(`mods/${encodeURIComponent(modName)}/restart`, { method: 'POST' });
              if (r3 && r3.error) throw new Error(r3.error);
            }

            Modal.close();
            const msg = restart
              ? T('mods.config.restarting', '配置已保存，正在重启 Mod')
              : T('mods.config.saved', '配置已保存');
            appendLog(modName, { ts: Date.now(), level: 'info', msg });
            if (window.App) {
              App.refreshMods(true);
              if (App.setStatus) App.setStatus(msg);
            }
            reload(modName);
          } catch (e) {
            alert(T('mods.config.save-failed', '保存失败') + ': ' + e.message);
            saveBtn.disabled = false;
            saveBtn.textContent = oldText;
          }
        });
      },
    });
  }

  // ---------- 加载 ----------
  async function reload(modName) {
    const view = views.get(modName);
    if (!view) return;
    try {
      const data = await App.api(`mods/${encodeURIComponent(modName)}`);
      if (!data || data.error) throw new Error((data && data.error) || T('mods.load-failed', '加载失败'));
      view.meta = data;
      view.markers = Array.isArray(data.markers) ? data.markers : [];
      view.address = data.address || view.address;
      view.runtimeState = data.state || view.runtimeState;
      if (data.modState) view.state = data.modState;
      if (Array.isArray(data.logs)) {
        for (const log of data.logs) appendLog(modName, log);
      }
      updateToolbar(view);
      updateState(modName, data.modState, {
        address: data.address,
        runtimeState: data.state,
        deviceType: data.type,
      });
    } catch (e) {
      appendLog(modName, { ts: Date.now(), level: 'error', msg: `${T('mods.state-load-failed', '读取 Mod 状态失败: ')}${e.message}` });
    }
  }

  function destroy(modName) {
    const view = views.get(modName);
    if (!view) return;
    if (view.timer) clearInterval(view.timer);
    stopReactorPolling(view);
    if (view.addrFlashTimer) clearTimeout(view.addrFlashTimer);
    if (view.resizeObserver) view.resizeObserver.disconnect();
    if (view.fullscreen) {
      if (view.viewRoot) view.viewRoot.classList.remove('mod-fullscreen');
      document.body.classList.remove('mod-fullscreen-open');
      if (view.escHandler) document.removeEventListener('keydown', view.escHandler, true);
    }
    views.delete(modName);
  }

  // ---------- 服务器消息 ----------
  function onServerMessage(msg) {
    if (!msg || !msg.mod) return;
    if (msg.type === 's2c.mod.state') {
      updateState(msg.mod, msg.state, {
        address: msg.address,
        runtimeState: msg.runtimeState,
        deviceType: msg.deviceType,
      });
    } else if (msg.type === 's2c.mod.log') {
      appendLog(msg.mod, { ts: msg.ts, level: msg.level, msg: msg.msg });
    }
  }

  return { render, reload, destroy, updateState, appendLog, onServerMessage };
})();

window.ModView = ModView;
