// ============================================================
// VM 进程管理 + stdin/stdout JSON 桥
// 管理 Lua VM 子进程的启动/停止/输入/输出
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getBatteryInfo, getToolMemoryInfo, forgetProcess } = require('./sysInfo');

class VMManager {
  constructor({ projectDir, luaExe, emuScript, modemHub, internetProxy, diskIO, logger, logLevel, vmsDir, kind, deviceBus }) {
    this.projectDir = projectDir;
    this.luaExe = luaExe;
    this.emuScript = emuScript;
    this.modemHub = modemHub;
    this.internetProxy = internetProxy;
    this.diskIO = diskIO;
    this.deviceBus = deviceBus || null;
    this.logger = logger || console;
    this.logLevel = logLevel || 'full'; // full | error | off
    this.vmsDir = vmsDir || path.join(projectDir, 'vms');
    this.kind = kind || 'vm';
    this.processes = new Map();  // name -> { proc, state, screen, subscribers, config, modemAddress }
    this.subscribers = new Map(); // name -> Set<ws>
    this.pendingNetRequests = new Map(); // reqId -> { vmName, resolve }
    this.reqIdCounter = 0;
    this.tickTimers = new Map(); // name -> timer handle
  }

  // ---------- VM 列表 ----------
  list() {
    if (!fs.existsSync(this.vmsDir)) return [];
    return fs.readdirSync(this.vmsDir)
      .filter(d => {
        const cfgPath = path.join(this.vmsDir, d, 'config.json');
        return fs.existsSync(cfgPath);
      })
      .map(name => {
        const cfg = this.getConfig(name);
        const proc = this.processes.get(name);
        return {
          name,
          state: proc ? proc.state : 'stopped',
          // 供前端在轮询时同步"已停止"的画面表现(黑屏 / 灰屏)。
          // 这样即使某条 WebSocket 状态消息漏掉, 前端也能在下次轮询时自行纠正。
          exitCode: (proc && proc.lastExitCode != null) ? proc.lastExitCode : undefined,
          cleanStop: proc ? proc.lastStopRequested === true : undefined,
          config: cfg ? { name: cfg.name, apu: cfg.hardware.apu, memory: cfg.hardware.memory } : null,
        };
      });
  }

  // ---------- 配置管理 ----------
  getConfig(name) {
    const cfgPath = path.join(this.vmsDir, name, 'config.json');
    if (!fs.existsSync(cfgPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      this.logger.error(`[vmManager] cannot read config for ${name}: ${e.message}`);
      return null;
    }
  }

  saveConfig(name, config) {
    const vmDir = path.join(this.vmsDir, name);
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });
    const cfgPath = path.join(vmDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  }

  create(spec) {
    const name = spec.name;
    if (!name || !name.match(/^[A-Za-z0-9_-]{1,32}$/)) {
      throw new Error('Invalid VM name (use alphanumeric, underscore, hyphen, max 32 chars)');
    }
    const vmDir = path.join(this.vmsDir, name);
    // 通过 config.json 判断 VM 是否已存在 (允许磁盘文件先写入目录)
    const cfgPath = path.join(vmDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      throw new Error(`VM "${name}" already exists`);
    }
    fs.mkdirSync(vmDir, { recursive: true });

    // 构建配置
    const config = {
      name,
      version: 4,
      created: new Date().toISOString(),
      hardware: {
        apu: spec.hardware.apu || { tier: 2 },
        memory: spec.hardware.memory || [3, 3],
        disk1: spec.hardware.disk1 || null,
        disk2: spec.hardware.disk2 || null,
        floppy: spec.hardware.floppy || null,
        eeprom: spec.hardware.eeprom || 'built-in',
        expansion: spec.hardware.expansion || [null, null, null],
        // 无线信号强度: 1 = 隔离, >=2 = 可与其他虚拟机互通
        ...(spec.hardware.modemStrength != null ? { modemStrength: spec.hardware.modemStrength } : {}),
        // 镜像模式: 存储文件夹相对路径, VM 启动时同步
        ...(spec.hardware.disk1Mirror ? { disk1Mirror: spec.hardware.disk1Mirror } : {}),
        ...(spec.hardware.disk2Mirror ? { disk2Mirror: spec.hardware.disk2Mirror } : {}),
      },
      screen: spec.screen || { tier: 3 },
      state: { running: false, lastBoot: null },
    };
    this.saveConfig(name, config);
    return config;
  }

  updateConfig(name, patch) {
    const cfg = this.getConfig(name);
    if (!cfg) throw new Error(`VM "${name}" not found`);
    const updated = { ...cfg, ...patch, hardware: { ...cfg.hardware, ...(patch.hardware || {}) } };
    this.saveConfig(name, updated);
    return updated;
  }

  delete(name) {
    const proc = this.processes.get(name);
    if (proc) this.stop(name);
    const vmDir = path.join(this.vmsDir, name);
    if (fs.existsSync(vmDir)) {
      fs.rmSync(vmDir, { recursive: true, force: true });
    }
  }

  // ---------- 进程管理 ----------
  start(name) {
    const config = this.getConfig(name);
    if (!config) return { ok: false, error: 'VM not found' };

    const existing = this.processes.get(name);
    // 进程仍在运行的标志: exitCode 为 null 且 killed 为 false
    if (existing && existing.proc && existing.proc.exitCode === null && !existing.proc.killed) {
      return { ok: false, error: 'VM already running' };
    }

    // 镜像模式: VM 启动前将文件夹内容同步到磁盘文件
    if (this.diskIO && config.hardware) {
      const vmDir = path.join(this.vmsDir, name);
      for (const slot of ['disk1', 'disk2']) {
        const mirrorKey = slot + 'Mirror';
        const mirrorPath = config.hardware[mirrorKey];
        if (mirrorPath && config.hardware[slot]) {
          const diskFile = config.hardware[slot];
          const diskPath = path.join(vmDir, diskFile);
          const folderPath = path.isAbsolute(mirrorPath)
            ? mirrorPath
            : path.join(this.projectDir, mirrorPath);
          if (fs.existsSync(folderPath)) {
            try {
              this.diskIO.syncFolderToDisk(folderPath, diskPath, {
                label: `${name}-${slot}`,
                size: config.hardware[slot + 'Size'] || 4194304,
                tier: config.hardware[slot + 'Tier'] || 3,
              });
              this.logger.log(`[vmManager] mirror sync: ${mirrorPath} → ${diskFile}`);
            } catch (e) {
              this.logger.error(`[vmManager] mirror sync failed for ${slot}: ${e.message}`);
            }
          }
        }
      }
    }

    const vmDir = path.join(this.vmsDir, name);
    // 外部设备清单: 写入 VM 目录, 让程序启动时就能看到组件 (运行中再热插拔由消息推送)
    if (this.deviceBus) {
      try {
        fs.writeFileSync(
          path.join(vmDir, 'devices.json'),
          JSON.stringify(this.deviceBus.getSnapshot()),
          'utf8',
        );
      } catch (e) {
        this.logger.error(`[vmManager] cannot write devices.json for ${name}: ${e.message}`);
      }
    }
    const args = [
      this.emuScript,
      '--vm', vmDir,
      '--json-io',
      '--log-level', this.logLevel,
    ];

    this.logger.log(`[vmManager] starting ${name}: ${this.luaExe} ${args.join(' ')}`);

    const proc = spawn(this.luaExe, args, {
      cwd: this.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // OC_VM_SEED: 给每台 VM 一个唯一的随机种子。
      // 没有它时, 每个 Lua 进程的随机序列相同, 会生成一模一样的组件地址,
      // 导致跨 VM 的 modem 地址表被覆盖, 虚拟机之间无法互通。
      env: {
        ...process.env,
        OC_VM_SEED: `${name}:${Date.now()}:${Math.random()}:${process.pid}`,
      },
    });

    const vmState = {
      proc,
      state: 'starting',
      screen: { width: 80, height: 25, cells: [], dirty: [] },
      config,
      modemAddress: null,
      modemTier: null,
      openPorts: new Set(),
      lineBuffer: '',
      stderrBuf: [],        // stderr 合并缓冲 (避免高频 chunk 拖慢事件循环)
      stderrBufSize: 0,
      stderrTimer: null,
      hwStatsBusy: false,   // 硬件状态同步去重标志
      lastBattery: null,    // 上次广播的电量 (仅变化时推送)
      lastExitCode: null,   // 上次退出码 (0 = 正常关机), 供前端判断黑屏还是灰屏
      lastStopRequested: false,  // 上次停止是否由用户主动发起 (刷新页面后仍能判定为正常关闭)
    };
    this.processes.set(name, vmState);

    // stdout: JSON lines
    proc.stdout.on('data', (data) => {
      vmState.lineBuffer += data.toString('utf8');
      let nl;
      while ((nl = vmState.lineBuffer.indexOf('\n')) >= 0) {
        const line = vmState.lineBuffer.substring(0, nl);
        vmState.lineBuffer = vmState.lineBuffer.substring(nl + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            this._onVMMessage(name, msg);
          } catch (e) {
            this.logger.log(`[vmManager] ${name} stdout: ${line}`);
          }
        }
      }
    });

    // stderr: 日志直通 (合并缓冲)
    // 注意: 不能每个 data chunk 都同步 console.log + WebSocket 广播。
    //   在 Windows 上, 写到前台控制台是同步阻塞的; 若 VM 处于热路径输出
    //   (如 verbose 日志), 每秒上百次写会占满事件循环, 导致 VM 卡顿。
    //   这里按 250ms 合并一次, 单批最多 64KB。
    proc.stderr.on('data', (data) => {
      vmState.stderrBuf.push(data);
      vmState.stderrBufSize += data.length;
      if (vmState.stderrBufSize >= 65536) {
        this._flushStderr(name);
        return;
      }
      if (!vmState.stderrTimer) {
        vmState.stderrTimer = setTimeout(() => this._flushStderr(name), 250);
      }
    });

    proc.on('exit', (code, signal) => {
      this._flushStderr(name);  // 退出前冲刷剩余日志
      vmState.lastExitCode = code;  // 记录退出码, 供前端区分正常关闭/异常停止
      this.logger.log(`[vmManager] ${name} exited: code=${code} signal=${signal}`);
      const tickTimer = this.tickTimers.get(name);
      if (tickTimer) { clearTimeout(tickTimer); this.tickTimers.delete(name); }
      if (vmState.hwStatsInterval) { clearInterval(vmState.hwStatsInterval); vmState.hwStatsInterval = null; }
      if (vmState.proc && vmState.proc.pid) forgetProcess(vmState.proc.pid);
      this.modemHub.unregister(name);
      // 镜像模式: 进程退出后同步磁盘内容回文件夹
      this._syncDiskToMirrorFolders(name);

      // 退出码 2 = reboot, 自动重启
      if (code === 2) {
        this.logger.log(`[vmManager] ${name} reboot requested (exit code 2), restarting...`);
        vmState.state = 'starting';
        this._broadcast(name, { type: 's2c.state', vm: name, state: 'starting' });
        // 清理旧进程条目, start() 会重新创建
        this.processes.delete(name);
        // 短暂延迟后重启, 确保清理完成
        setTimeout(() => {
          this.start(name);
        }, 500);
        return;
      }

      vmState.state = 'stopped';
      this._broadcast(name, {
        type: 's2c.state',
        vm: name,
        state: 'stopped',
        exitCode: code,
        cleanStop: vmState.lastStopRequested === true,
      });
    });

    proc.on('error', (err) => {
      this.logger.error(`[vmManager] ${name} spawn error: ${err.message}`);
      vmState.state = 'error';
      this._broadcast(name, { type: 's2c.state', vm: name, state: 'error', error: err.message });
    });

    // 防止 stdin 写入已关闭 pipe 时崩溃 (write EOF)
    proc.stdin.on('error', (err) => {
      this.logger.log(`[vmManager] ${name} stdin error (ignored): ${err.message}`);
    });

    vmState.state = 'running';
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'running' });
    // 设备总线: 虚拟机启动后立即拿到外部设备 (核电站等) 的列表与状态
    if (this.deviceBus) this.deviceBus.sendDevices(this, name);

    // 注册 modem (如果有无线网卡)
    const hasWireless = (config.hardware.expansion || []).some(
      c => c === 'wireless_t1' || c === 'wireless_t2'
    );
    if (hasWireless) {
      const tier = (config.hardware.expansion || []).find(
        c => c === 'wireless_t1' || c === 'wireless_t2'
      ) === 'wireless_t2' ? 2 : 1;
      // 生成随机 modem 地址 (等到 VM 报告自己的地址)
      vmState.modemTier = tier;
    }

    // 硬件状态同步: 每 20 秒推送电量 + RAM 使用情况
    // 必须是异步 + 低频: 电量/RAM 变化很慢, 而查询本身在 Windows 上会启动
    // PowerShell (耗时可达数秒), 同步执行会冻结事件循环导致 VM 卡顿。
    if (vmState.hwStatsInterval) clearInterval(vmState.hwStatsInterval);
    vmState.hwStatsInterval = setInterval(() => {
      this._syncHwStats(name).catch(() => {});
    }, 20000);
    this._syncHwStats(name).catch(() => {});

    return { ok: true };
  }

  // 同步硬件状态 (电量 + RAM) 到 VM 和前端
  // 关键: 全程 await 异步查询, 绝不阻塞 Node 事件循环。
  //   否则 pull_signal <-> tick 往返会被拖慢, VM 表现为严重卡顿。
  async _syncHwStats(name) {
    const vmState = this.processes.get(name);
    if (!vmState || vmState.state !== 'running') return;
    if (vmState.hwStatsBusy) return;   // 上一轮还没结束, 跳过本轮
    vmState.hwStatsBusy = true;
    try {
      // ---- 内存: 本工具占用宿主内存的百分比, 提供给 VM 内的系统 ----
      // toolPercent = (node 服务进程 + 所有 VM 子进程) 的常驻内存 / 宿主总内存
      try {
        const pids = [];
        for (const st of this.processes.values()) {
          if (st && st.state === 'running' && st.proc && !st.proc.killed && st.proc.pid) {
            pids.push(st.proc.pid);
          }
        }
        const mem = await getToolMemoryInfo(pids);
        const config = vmState.config;
        const ramSize = config && config.hardware && config.hardware.memory
          ? this._memTierToSize(config.hardware.memory[0] || 0)
            + this._memTierToSize(config.hardware.memory[1] || 0)
          : 2 * 1024 * 1024;
        // 把"工具占宿主内存的百分比"按比例映射到模拟机的内存预算上,
        // 这样 VM 内的系统读到的内存占用比例 = 本工具真实占用宿主内存的比例。
        const toolPercent = Math.max(0, Math.min(100, mem.percent));
        const usedRam = Math.round(ramSize * toolPercent / 100);
        vmState.ramStats = {
          used: usedRam,
          total: ramSize,
          toolPercent: toolPercent,
          hostUsed: mem.toolUsed,
          hostTotal: mem.hostTotal,
        };
        this._send(name, {
          type: 'ram_update',
          used: usedRam,
          total: ramSize,
        });
      } catch (e) {
        // 忽略内存统计错误
      }

      // ---- 电量: 读取系统电量 ----
      try {
        const bat = await getBatteryInfo();
        const maxEnergy = 100000; // 模拟二级电池容量
        const energy = Math.floor(maxEnergy * (bat.percent / 100));
        this._send(name, {
          type: 'battery',
          energy: energy,
          maxEnergy: maxEnergy,
          percent: bat.percent,
          charging: bat.charging,
        });
        // 电量变化很慢, 仅在变化时广播给前端, 避免无谓的 WebSocket 流量
        const last = vmState.lastBattery;
        if (!last || last.percent !== bat.percent || last.charging !== bat.charging) {
          vmState.lastBattery = { percent: bat.percent, charging: bat.charging };
          this._broadcast(name, {
            type: 's2c.battery',
            vm: name,
            percent: bat.percent,
            charging: bat.charging,
          });
        }
      } catch (e) {
        // 忽略电量同步错误
      }
    } finally {
      vmState.hwStatsBusy = false;
    }
  }

  // 内存等级转换为字节数 (与 Lua 端 memTierToSize 保持一致)
  _memTierToSize(tier) {
    const t = parseFloat(tier) || 0;
    if (t === 0.5) return 16 * 1024;     // 16 KB
    if (t === 1) return 32 * 1024;        // 32 KB
    if (t === 1.5) return 64 * 1024;      // 64 KB
    if (t === 2) return 128 * 1024;       // 128 KB
    if (t === 2.5) return 256 * 1024;     // 256 KB
    if (t === 3) return 512 * 1024;       // 512 KB
    if (t === 3.5) return 1024 * 1024;    // 1 MB
    if (t === 4) return 2 * 1024 * 1024;  // 2 MB
    if (t === 4.5) return 4 * 1024 * 1024;// 4 MB
    if (t === 5) return 8 * 1024 * 1024;  // 8 MB
    if (t === 6) return 16 * 1024 * 1024; // 16 MB
    if (t > 6) return t * 1024 * 1024;    // 直接 MB 数
    return 0;
  }

  stop(name, { timeoutMs = 3000 } = {}) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) return;

    // 记录"这次是用户主动发起的停止", 前端据此把画面判为正常关闭(黑屏)。
    // 即使 guest 不响应 shutdown 而被强制杀掉(退出码非 0), 也不会误判成异常停止。
    vmState.lastStopRequested = true;

    // 先显式请求一次落盘 (双保险): 若 guest 正忙于安装/IO 而不响应 shutdown,
    // 3 秒后会被强杀, 因此强杀前必须先保存磁盘, 否则安装结果会全部丢失。
    // 这里先让模拟器把内存中的磁盘写回文件, 再发关机信号。
    this._send(name, { type: 'command', cmd: 'flush' });

    // 发送 shutdown 命令
    this._send(name, { type: 'command', cmd: 'shutdown' });

    // 超时后 SIGTERM
    setTimeout(() => {
      if (vmState.proc && !vmState.proc.killed) {
        this.logger.log(`[vmManager] ${name} force kill after ${timeoutMs}ms`);
        try { vmState.proc.kill('SIGTERM'); } catch (e) {}
      }
    }, timeoutMs);

    const tickTimer = this.tickTimers.get(name);
    if (tickTimer) { clearTimeout(tickTimer); this.tickTimers.delete(name); }
  }

  // 镜像模式: 将 .ocd 磁盘内容同步回文件夹
  _syncDiskToMirrorFolders(name) {
    const config = this.getConfig(name);
    if (!config || !config.hardware || !this.diskIO) return;
    const vmDir = path.join(this.vmsDir, name);
    for (const slot of ['disk1', 'disk2']) {
      const mirrorKey = slot + 'Mirror';
      const mirrorPath = config.hardware[mirrorKey];
      if (mirrorPath && config.hardware[slot]) {
        const diskFile = config.hardware[slot];
        const diskPath = path.join(vmDir, diskFile);
        const folderPath = path.isAbsolute(mirrorPath)
          ? mirrorPath
          : path.join(this.projectDir, mirrorPath);
        try {
          // 读取磁盘中的所有文件, 写回文件夹
          const tree = this.diskIO.listTree(diskPath);
          // listTree 返回 { name, type, children } 树结构
          // 递归遍历, 提取所有文件
          const files = [];
          const collect = (node, basePath) => {
            if (!node.children) return;
            for (const child of node.children) {
              const childPath = basePath + '/' + child.name;
              if (child.type === 'file') {
                files.push(childPath);
              } else if (child.type === 'dir' && child.children) {
                collect(child, childPath);
              }
            }
          };
          collect(tree, '');
          for (const filePath of files) {
            try {
              const fileData = this.diskIO.read(diskPath, filePath);
              if (fileData.ok && fileData.content != null) {
                const fullPath = path.join(folderPath, filePath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, fileData.content, 'utf8');
              }
            } catch (e) {
              // 单个文件读取失败不中断
            }
          }
          this.logger.log(`[vmManager] mirror sync back: ${diskFile} → ${mirrorPath} (${files.length} files)`);
        } catch (e) {
          this.logger.error(`[vmManager] mirror sync back failed for ${slot}: ${e.message}`);
        }
      }
    }
  }

  pause(name) {
    const vmState = this.processes.get(name);
    if (!vmState || vmState.state !== 'running') return;
    vmState.state = 'paused';
    this._send(name, { type: 'command', cmd: 'pause' });
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'paused' });
  }

  resume(name) {
    const vmState = this.processes.get(name);
    if (!vmState || vmState.state !== 'paused') return;
    vmState.state = 'running';
    this._send(name, { type: 'command', cmd: 'resume' });
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'running' });
  }

  // 重启: 先停止再启动, 等待进程完全退出后再重新 spawn
  restart(name) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) {
      // 未运行, 直接启动
      return this.start(name);
    }
    // 进程已退出 (exit handler 已清理), 直接 start
    if (vmState.proc.exitCode !== null) {
      this.logger.log(`[vmManager] ${name} already exited, starting directly`);
      return this.start(name);
    }

    // 标记重启中, UI 收到 s2c.state 后会显示 "重启中"
    vmState.state = 'starting';
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'starting' });
    this.logger.log(`[vmManager] restarting ${name}`);

    const proc = vmState.proc;
    // 监听 exit 事件, 进程退出后立即重新启动
    // 注意: start() 内部已绑定的 exit handler 会处理 tickTimer / modemHub / 镜像同步 / 广播 stopped
    // 这里只需在 exit 后调用 start() 即可
    let forceKillTimer = null;
    proc.once('exit', () => {
      if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
      this.logger.log(`[vmManager] ${name} exited for restart, respawning`);
      // 删除旧进程条目, start() 会重新创建
      this.processes.delete(name);
      // 重新启动
      this.start(name);
    });

    // 发送 shutdown 命令
    this._send(name, { type: 'command', cmd: 'shutdown' });

    // 超时强制 kill (与 stop 一致 3s)
    // 必须只针对旧进程, 否则旧进程已退出、新进程已启动时会把新进程杀掉。
    forceKillTimer = setTimeout(() => {
      if (proc && proc.exitCode === null && !proc.killed) {
        this.logger.log(`[vmManager] ${name} force kill during restart`);
        try { proc.kill('SIGTERM'); } catch (e) {}
      }
    }, 3000);

    return { ok: true };
  }

  getState(name) {
    const vmState = this.processes.get(name);
    if (!vmState) return { state: 'stopped' };
    return {
      state: vmState.state,
      screen: vmState.screen,
      config: vmState.config,
    };
  }

  // ---------- 输入转发 ----------
  sendInput(name, inputEvent) {
    this.logger.log(`[vmManager] sendInput ${name}: ${JSON.stringify(inputEvent)}`);
    this._send(name, { type: 'input', ...inputEvent });
  }

  sendCommand(name, cmd, data) {
    const msg = { type: 'command', cmd };
    if (data !== undefined) msg.data = data;
    this._send(name, msg);
  }

  // 检查 VM 是否在运行
  isRunning(name) {
    const vmState = this.processes.get(name);
    return !!(vmState && vmState.proc && vmState.proc.exitCode === null && !vmState.proc.killed);
  }

  // ---------- 订阅管理 ----------
  subscribe(name, ws) {
    if (!this.subscribers.has(name)) this.subscribers.set(name, new Set());
    this.subscribers.get(name).add(ws);
    const vmState = this.processes.get(name);
    if (!vmState) return;
    // 先下发当前状态: 前端据此决定画面是"运行中"还是"已停止(黑屏 / 灰屏)"。
    // 必须早于屏幕快照, 否则会出现"先画出彩色旧画面"的误导。
    try {
      ws.send(JSON.stringify({
        type: 's2c.state',
        vm: name,
        state: vmState.state,
        exitCode: vmState.lastExitCode != null ? vmState.lastExitCode : undefined,
        cleanStop: vmState.lastStopRequested === true,
      }));
    } catch (e) { /* 忽略发送失败 */ }
    // 发送当前屏幕快照
    if (vmState.screen.cells.length > 0) {
      ws.send(JSON.stringify({
        type: 's2c.screen',
        vm: name,
        w: vmState.screen.width,
        h: vmState.screen.height,
        full: true,
        cells: vmState.screen.cells,
      }));
    }
  }

  unsubscribe(name, ws) {
    const subs = this.subscribers.get(name);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) this.subscribers.delete(name);
    }
  }

  // ---------- 内部方法 ----------
  _send(name, msg) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) return;
    // VM 已停止时不发送
    if (vmState.state === 'stopped' || vmState.state === 'error') return;
    if (vmState.proc.exitCode !== null) return;
    try {
      // Escape Latin-1 characters (code 128-255) to \u00XX so binary data
      // survives the JSON -> stdin -> Lua JSON decoder pipeline. Without this,
      // Node.js writes these as multi-byte UTF-8, which the Lua decoder
      // misinterprets as separate bytes (corrupting e.g. .pic image data).
      // Characters > 255 (e.g. CJK) are left as raw UTF-8 since the Lua
      // decoder's string.char() only handles codes 0-255.
      const raw = JSON.stringify(msg);
      const data = raw.replace(/[\u0080-\u00ff]/g, (c) => {
        return '\\u00' + c.charCodeAt(0).toString(16).padStart(2, '0');
      }) + '\n';
      const ok = vmState.proc.stdin.write(data);
      if (!ok) {
        // 背压: 缓冲区已满，等待 drain 事件 (不阻塞，只是记录日志)
        this.logger.log(`[vmManager] ${name} stdin buffer full, waiting for drain`);
      }
    } catch (e) {
      this.logger.error(`[vmManager] cannot send to ${name}: ${e.message}`);
    }
  }

  // pullSignal 超时心跳: VM 在 pullSignal(timeout) 等待时,
  // server 在 timeout 到期后发 tick
  _scheduleTick(name, timeoutMs) {
    const existing = this.tickTimers.get(name);
    if (existing) clearTimeout(existing);
    // timeout <= 0 表示非阻塞轮询, 立即回 tick (让 VM 能读到输入消息)
    // 否则最少 50ms, 最多 10s
    let delay;
    if (timeoutMs <= 0) {
      delay = 0;
    } else {
      delay = Math.max(50, Math.min(timeoutMs, 10000));
    }
    const timer = setTimeout(() => {
      this._send(name, { type: 'tick', wall: Date.now() });
      this.tickTimers.delete(name);
    }, delay);
    this.tickTimers.set(name, timer);
  }

  _onVMMessage(name, msg) {
    const vmState = this.processes.get(name);
    if (!vmState) return;

    // 设备总线消息 (ext_list_request / ext_command) 由总线处理
    if (this.deviceBus && this.deviceBus.handleMessage(this, name, msg)) return;

    switch (msg.type) {
      case 'screen':
        if (msg.w) vmState.screen.width = msg.w;
        if (msg.h) vmState.screen.height = msg.h;
        if (msg.full && msg.cells) {
          vmState.screen.cells = msg.cells;
        } else if (msg.dirty) {
          // 增量更新: dirty 是 [[x,y,bg,fg,char],...]
          for (const [x, y, bg, fg, ch] of msg.dirty) {
            // 更新缓存 (cells 是一维数组, 索引 = (y-1)*w + (x-1))
            const idx = (y - 1) * vmState.screen.width + (x - 1);
            vmState.screen.cells[idx] = [bg, fg, ch];
          }
        }
        this._broadcast(name, {
          type: 's2c.screen',
          vm: name,
          w: msg.w, h: msg.h,
          full: msg.full || false,
          cells: msg.full ? msg.cells : undefined,
          dirty: msg.dirty,
          cursor: msg.cursor,
        });
        break;

      case 'log':
        this.logger.log(`[vm:${name}] ${msg.msg}`);
        this._broadcast(name, { type: 's2c.log', vm: name, level: msg.level || 'info', msg: msg.msg });
        break;

      case 'state':
        vmState.state = msg.state;
        this._broadcast(name, { type: 's2c.state', vm: name, state: msg.state });
        break;

      case 'pull_signal':
        // VM 正在等待信号, 参数是 timeout
        this._scheduleTick(name, msg.timeout || 1000);
        break;

      case 'net_request':
        this._handleNetRequest(name, msg);
        break;

      case 'modem_send':
        this._handleModemSend(name, msg);
        break;

      case 'modem_broadcast':
        this._handleModemBroadcast(name, msg);
        break;

      case 'modem_register':
        // VM 注册其 modem 地址和 tier
        vmState.modemAddress = msg.address;
        vmState.modemTier = msg.tier;
        vmState.modemWired = msg.wired || msg.tier >= 2;
        this.modemHub.register(name, {
          address: msg.address,
          tier: msg.tier,
          ports: [],
          wired: vmState.modemWired,
          strength: msg.strength,
        });
        // 注册消息投递 handler; 未注册时 modem 消息会被静默丢弃
        this.modemHub.setHandler(name, (payload) => {
          this._send(name, {
            type: 'modem_message',
            from: payload.fromAddr,
            port: payload.port,
            data: payload.messages,
            distance: payload.distance || 0,
            wired: payload.wired || false,
          });
        });
        this.logger.log(`[vmManager] ${name} registered modem ${msg.address} tier ${msg.tier} wired=${vmState.modemWired} strength=${msg.strength}`);
        break;

      case 'modem_strength':
        // 虚拟机内调用 modem.setStrength: 强度 < 2 会把这台 VM 与外部隔离
        this.modemHub.setStrength(name, msg.strength);
        this.logger.log(`[vmManager] ${name} modem strength -> ${msg.strength}`);
        break;

      case 'modem_open_port':
        this.modemHub.openPort(name, msg.port);
        break;

      case 'modem_close_port':
        this.modemHub.closePort(name, msg.port);
        break;

      default:
        this.logger.log(`[vmManager] ${name} unknown msg: ${JSON.stringify(msg).substring(0, 200)}`);
    }
  }

  async _handleNetRequest(name, msg) {
    this.logger.log(`[vmManager] net_request from ${name}: reqId=${msg.reqId} url=${(msg.url || '').substring(0, 80)} method=${msg.method || 'GET'}`);
    try {
      this.logger.log(`[vmManager] calling internetProxy.request for ${name}...`);
      const resp = await this.internetProxy.request({
        url: msg.url,
        method: msg.method || 'GET',
        headers: msg.headers || {},
        body: msg.postData || msg.body,
        reqId: msg.reqId,
      });
      this.logger.log(`[vmManager] internetProxy.request returned for ${name}: status=${resp.status} chunks=${(resp.chunks || []).length} error=${resp.error || 'none'}`);
      this._send(name, {
        type: 'net_response',
        reqId: msg.reqId,
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
        chunks: resp.chunks,
        error: resp.error,
      });
      this.logger.log(`[vmManager] net_response sent to ${name}`);
    } catch (e) {
      this.logger.error(`[vmManager] net_request error for ${name}: ${e.message}`);
      this._send(name, {
        type: 'net_response',
        reqId: msg.reqId,
        status: 0,
        error: e.message,
      });
    }
  }

  _handleModemSend(name, msg) {
    const vmState = this.processes.get(name);
    // 兼容两种字段名: from/to 或仅 dest; 缺 from 时使用已注册的 modem 地址
    const fromAddr = msg.from || (vmState && vmState.modemAddress) || '';
    const toAddr = msg.to || msg.dest;
    this.modemHub.route(name, fromAddr, toAddr, msg.port, ...(msg.data || []));
  }

  _handleModemBroadcast(name, msg) {
    const vmState = this.processes.get(name);
    const fromAddr = msg.from || (vmState && vmState.modemAddress) || '';
    this.modemHub.broadcast(name, fromAddr, msg.port, ...(msg.data || []));
  }

  // 冲刷 stderr 缓冲: 一次性写控制台 + 广播给前端
  _flushStderr(name) {
    const vmState = this.processes.get(name);
    if (!vmState) return;
    if (vmState.stderrTimer) {
      clearTimeout(vmState.stderrTimer);
      vmState.stderrTimer = null;
    }
    if (!vmState.stderrBuf.length) return;
    const text = Buffer.concat(vmState.stderrBuf).toString('utf8').replace(/\s+$/, '');
    vmState.stderrBuf.length = 0;
    vmState.stderrBufSize = 0;
    if (!text) return;
    this.logger.log(`[vm:${name}] ${text}`);
    this._broadcast(name, { type: 's2c.log', vm: name, level: 'info', msg: text });
  }

  _broadcast(name, msg) {
    const subs = this.subscribers.get(name);
    // 屏幕帧频率很高, 不逐帧打日志 (否则会严重拖慢事件循环)
    if (!subs) return;
    const text = JSON.stringify(msg);
    for (const ws of subs) {
      try {
        if (ws.readyState === 1) ws.send(text);
      } catch (e) {}
    }
  }
}

module.exports = { VMManager };
