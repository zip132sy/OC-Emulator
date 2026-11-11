// ============================================================
// VM process management + stdin/stdout JSON bridge
// Starts/stops Lua VM child processes and pipes input/output
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const { getBatteryInfo, getToolMemoryInfo, forgetProcess } = require('./sysInfo');

// Project info sources, tried in order; any success wins
const PROJECT_INFO_SOURCES = [
  'https://raw.githubusercontent.com/zip132sy/OC-Emulator/main/oc-emulator.lua',
  'https://gitee.com/zip132sy/OC-Emulator/raw/main/oc-emulator.lua',
];

// Custom memory capacity: any positive MB value per stick, 0 means an empty slot.
// Normalize hardware.memoryMB (one MB value per stick; null = derive from tier).
// Returns null when no valid custom value exists, so callers can skip writing config.
function normalizeMemoryMB(input) {
  if (!Array.isArray(input)) return null;
  const out = [null, null];
  let any = false;
  for (let i = 0; i < 2; i++) {
    const raw = input[i];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    out[i] = n;
    any = true;
  }
  return any ? out : null;
}

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
    this.tcpIdCounter = 0;
    this.projectInfoSyncing = false;
    this.syncProjectInfo();
  }

  // ---------- Project info sync ----------
  // Sync project info from the remote source into cache/attribution.txt
  syncProjectInfo() {
    if (this.projectInfoSyncing) return;
    const outFile = path.join(this.projectDir, 'cache', 'attribution.txt');
    if (fs.existsSync(outFile)) return;
    const now = Date.now();
    // Offline: retry at most every 5 minutes instead of on every boot
    if (this.projectInfoRetryAt && now - this.projectInfoRetryAt < 5 * 60 * 1000) return;
    this.projectInfoRetryAt = now;
    this.projectInfoSyncing = true;
    const trySource = (index) => {
      if (index >= PROJECT_INFO_SOURCES.length) {
        try { fs.unlinkSync(outFile); } catch { /* ignore when there is no cache */ }
        this.projectInfoSyncing = false;
        return;
      }
      this.fetchText(PROJECT_INFO_SOURCES[index], (err, body) => {
        if (err || !body) return trySource(index + 1);
        const match = /local infoText = "(源码提供:(?:[^"\\]|\\.)*)"/.exec(body);
        if (!match) return trySource(index + 1);
        const text = match[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        try {
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.writeFileSync(outFile, text, 'utf8');
        } catch (e) {
          this.logger.error(`[vmManager] cannot cache project info: ${e.message}`);
        }
        this.projectInfoSyncing = false;
      });
    };
    trySource(0);
  }

  fetchText(url, cb, redirects = 0) {
    const client = url.startsWith('https:') ? https : http;
    let settled = false;
    const done = (err, body) => {
      if (settled) return;
      settled = true;
      cb(err, body);
    };
    let req;
    try {
      req = client.get(url, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
          res.resume();
          settled = true;
          return this.fetchText(new URL(res.headers.location, url).toString(), cb, redirects + 1);
        }
        if (status !== 200) {
          res.resume();
          return done(new Error(`HTTP ${status}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 4 * 1024 * 1024) req.destroy(new Error('response too large'));
        });
        res.on('end', () => done(null, data));
      });
    } catch (e) {
      return done(e);
    }
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done(err));
  }

  // ---------- VM list ----------
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
          // Lets the UI restore the "stopped" screen look (black / grey) while polling,
          // so a missed WebSocket state message self-corrects on the next poll.
          exitCode: (proc && proc.lastExitCode != null) ? proc.lastExitCode : undefined,
          cleanStop: proc ? proc.lastStopRequested === true : undefined,
          config: cfg ? {
            name: cfg.name,
            apu: cfg.hardware.apu,
            memory: cfg.hardware.memory,
            memoryMB: cfg.hardware.memoryMB || null,
          } : null,
        };
      });
  }

  // ---------- Config management ----------
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
    // Use config.json to detect an existing VM (disk files may land in the dir first)
    const cfgPath = path.join(vmDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      throw new Error(`VM "${name}" already exists`);
    }
    fs.mkdirSync(vmDir, { recursive: true });

    const memoryMB = normalizeMemoryMB(spec.hardware.memoryMB);

    const config = {
      name,
      version: 4,
      created: new Date().toISOString(),
      hardware: {
        apu: spec.hardware.apu || { tier: 2 },
        memory: spec.hardware.memory || [3, 3],
        ...(memoryMB ? { memoryMB } : {}),
        disk1: spec.hardware.disk1 || null,
        disk2: spec.hardware.disk2 || null,
        // Keep the size/tier chosen in the wizard so mirror sync and the
        // hardware editor keep using the real capacity instead of a default.
        ...(spec.hardware.disk1Size ? { disk1Size: spec.hardware.disk1Size } : {}),
        ...(spec.hardware.disk1Tier ? { disk1Tier: spec.hardware.disk1Tier } : {}),
        ...(spec.hardware.disk1Label ? { disk1Label: spec.hardware.disk1Label } : {}),
        ...(spec.hardware.disk2Size ? { disk2Size: spec.hardware.disk2Size } : {}),
        ...(spec.hardware.disk2Tier ? { disk2Tier: spec.hardware.disk2Tier } : {}),
        ...(spec.hardware.disk2Label ? { disk2Label: spec.hardware.disk2Label } : {}),
        floppy: spec.hardware.floppy || null,
        eeprom: spec.hardware.eeprom || 'built-in',
        expansion: spec.hardware.expansion || [null, null, null],
        // Wireless strength: 1 = isolated, >=2 = can talk to other VMs
        ...(spec.hardware.modemStrength != null ? { modemStrength: spec.hardware.modemStrength } : {}),
        // Mirror mode: relative storage folder, synced when the VM starts
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
    // Custom memory: drop the field when reverting to tier sizes to keep config clean
    if (patch.hardware && 'memoryMB' in patch.hardware) {
      const memoryMB = normalizeMemoryMB(patch.hardware.memoryMB);
      if (memoryMB) updated.hardware.memoryMB = memoryMB;
      else delete updated.hardware.memoryMB;
    }
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

  // Rename a VM: rename the directory and the name inside config.json
  rename(oldName, newName) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(newName || '')) {
      throw new Error('Invalid VM name (use alphanumeric, underscore, hyphen, max 32 chars)');
    }
    const oldDir = path.join(this.vmsDir, oldName);
    if (!fs.existsSync(path.join(oldDir, 'config.json'))) {
      throw new Error(`VM "${oldName}" not found`);
    }
    if (oldName === newName) return this.getConfig(oldName);
    const newDir = path.join(this.vmsDir, newName);
    if (fs.existsSync(path.join(newDir, 'config.json'))) {
      throw new Error(`VM "${newName}" already exists`);
    }
    const proc = this.processes.get(oldName);
    if (proc && proc.proc && proc.proc.exitCode === null && !proc.proc.killed) {
      throw new Error('VM is running, stop it before renaming');
    }
    fs.renameSync(oldDir, newDir);
    const cfg = this.getConfig(newName);
    if (cfg) {
      cfg.name = newName;
      this.saveConfig(newName, cfg);
    }
    return cfg;
  }

  // ---------- Process management ----------
  start(name) {
    const config = this.getConfig(name);
    if (!config) return { ok: false, error: 'VM not found' };

    const existing = this.processes.get(name);
    // A process is still alive when exitCode is null and killed is false
    if (existing && existing.proc && existing.proc.exitCode === null && !existing.proc.killed) {
      return { ok: false, error: 'VM already running' };
    }

    // Mirror mode: sync the folder into the disk file before boot
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
              // Prefer the size/tier stored in the config; otherwise read the
              // existing image so a custom capacity is not reset to the default.
              let size = config.hardware[slot + 'Size'];
              let tier = config.hardware[slot + 'Tier'];
              if ((!size || !tier) && fs.existsSync(diskPath)) {
                const info = this.diskIO.getInfo(diskPath);
                if (info && info.ok) {
                  size = size || info.size;
                  tier = tier || info.tier;
                }
              }
              this.diskIO.syncFolderToDisk(folderPath, diskPath, {
                label: `${name}-${slot}`,
                size: size || 4194304,
                tier: tier || 3,
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
    // External device list: written into the VM dir so the program sees components at boot
    // (hot-plugging later is pushed as messages)
    if (this.deviceBus) {
      try {
        fs.writeFileSync(
          path.join(vmDir, 'devices.json'),
          JSON.stringify(this.deviceBus.getSnapshot(name)),
          'utf8',
        );
      } catch (e) {
        this.logger.error(`[vmManager] cannot write devices.json for ${name}: ${e.message}`);
      }
    }
    this.syncProjectInfo();
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
      // OC_VM_SEED: give every VM a unique random seed. Without it each Lua process
      // produces the same random sequence and thus identical component addresses,
      // which overwrites the cross-VM modem address table and breaks interconnectivity.
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
      stderrBuf: [],        // merged stderr buffer (dense chunks would slow the event loop)
      stderrBufSize: 0,
      stderrTimer: null,
      hwStatsBusy: false,   // dedupe flag for hw stats sync
      lastBattery: null,    // last broadcast battery (pushed only on change)
      lastExitCode: null,   // last exit code (0 = clean shutdown); the UI picks black vs grey screen
      lastStopRequested: false,  // whether the last stop was user-initiated (still a clean stop after a refresh)
      tcpSockets: new Map(),     // id -> { socket, buffer, closed, pendingReads }
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

    // stderr: pass-through logging (merged buffer)
    // Do NOT console.log + broadcast every chunk: on Windows writing to the foreground
    // console blocks synchronously, so hundreds of writes per second from a hot path
    // (e.g. verbose logs) would saturate the event loop and stall the VM.
    // Batch every 250ms, at most 64KB per batch.
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
      this._flushStderr(name);  // flush remaining logs before exit
      vmState.lastExitCode = code;  // record the exit code so the UI can tell clean shutdown from a crash
      this.logger.log(`[vmManager] ${name} exited: code=${code} signal=${signal}`);
      const tickTimer = this.tickTimers.get(name);
      if (tickTimer) { clearTimeout(tickTimer); this.tickTimers.delete(name); }
      if (vmState.hwStatsInterval) { clearInterval(vmState.hwStatsInterval); vmState.hwStatsInterval = null; }
      if (vmState.proc && vmState.proc.pid) forgetProcess(vmState.proc.pid);
      this._closeTcpSockets(name);
      this.modemHub.unregister(name);
      // Mirror mode: sync disk contents back to the folder after exit
      this._syncDiskToMirrorFolders(name);

      // Exit code 2 = reboot request, restart automatically
      if (code === 2) {
        this.logger.log(`[vmManager] ${name} reboot requested (exit code 2), restarting...`);
        vmState.state = 'starting';
        this._broadcast(name, { type: 's2c.state', vm: name, state: 'starting' });
        // Drop the old process entry; start() recreates it
        this.processes.delete(name);
        // Restart after a short delay so cleanup finishes
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

    // Prevent a crash when writing stdin to an already-closed pipe (EOF)
    proc.stdin.on('error', (err) => {
      this.logger.log(`[vmManager] ${name} stdin error (ignored): ${err.message}`);
    });

    vmState.state = 'running';
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'running' });
    // Device bus: hand the external devices (reactors etc.) and their state to the VM right after boot
    if (this.deviceBus) this.deviceBus.sendDevices(this, name);

    // Register the modem when a wireless card is present
    const hasWireless = (config.hardware.expansion || []).some(
      c => c === 'wireless_t1' || c === 'wireless_t2'
    );
    if (hasWireless) {
      const tier = (config.hardware.expansion || []).find(
        c => c === 'wireless_t1' || c === 'wireless_t2'
      ) === 'wireless_t2' ? 2 : 1;
      // Modem address is assigned randomly; wait for the VM to report its own
      vmState.modemTier = tier;
    }

    // Hardware stats: push battery + RAM usage every 20s.
    // Must stay async and low-frequency: on Windows the query spawns PowerShell
    // (up to seconds), and running it synchronously would freeze the event loop.
    if (vmState.hwStatsInterval) clearInterval(vmState.hwStatsInterval);
    vmState.hwStatsInterval = setInterval(() => {
      this._syncHwStats(name).catch(() => {});
    }, 20000);
    this._syncHwStats(name).catch(() => {});

    return { ok: true };
  }

  // Sync hardware stats (battery + RAM) to the VM and the UI.
  // Always await the async queries; never block the Node event loop, or the
  // pull_signal <-> tick round trip slows down and the VM stutters badly.
  async _syncHwStats(name) {
    const vmState = this.processes.get(name);
    if (!vmState || vmState.state !== 'running') return;
    if (vmState.hwStatsBusy) return;   // previous round still running, skip this one
    vmState.hwStatsBusy = true;
    try {
      // ---- RAM: this tool's share of host memory, reported to the guest OS ----
      // toolPercent = RSS of (node server + all VM children) / total host memory
      try {
        const pids = [];
        for (const st of this.processes.values()) {
          if (st && st.state === 'running' && st.proc && !st.proc.killed && st.proc.pid) {
            pids.push(st.proc.pid);
          }
        }
        const mem = await getToolMemoryInfo(pids);
        const config = vmState.config;
        const ramSize = config && config.hardware ? this.ramSizeOf(config) : 2 * 1024 * 1024;
        // Map the tool's host-memory percentage onto the emulated RAM budget, so the
        // guest reads the same usage ratio this tool really takes on the host.
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
        // Ignore memory stats errors
      }

      // ---- Battery: read the host battery ----
      try {
        const bat = await getBatteryInfo();
        const maxEnergy = 100000; // emulated tier-2 battery capacity
        const energy = Math.floor(maxEnergy * (bat.percent / 100));
        this._send(name, {
          type: 'battery',
          energy: energy,
          maxEnergy: maxEnergy,
          percent: bat.percent,
          charging: bat.charging,
        });
        // Battery changes slowly; broadcast to the UI only on change to avoid useless traffic
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
        // Ignore battery sync errors
      }
    } finally {
      vmState.hwStatsBusy = false;
    }
  }

  // Actual byte size of one memory stick: custom MB first, otherwise the tier size
  _memStickSize(memoryMB, tier, index) {
    const mb = Array.isArray(memoryMB) ? memoryMB[index] : null;
    if (mb !== null && mb !== undefined && mb !== '') {
      const n = Number(mb);
      if (Number.isFinite(n) && n >= 0) return Math.round(n * 1024 * 1024);
    }
    return this._memTierToSize(tier || 0);
  }

  // Total RAM in bytes (must match the Lua side)
  ramSizeOf(config) {
    const hw = (config && config.hardware) || {};
    const tiers = Array.isArray(hw.memory) ? hw.memory : [3, 3];
    return this._memStickSize(hw.memoryMB, tiers[0], 0)
      + this._memStickSize(hw.memoryMB, tiers[1], 1);
  }

  // Convert a memory tier to bytes (must match memTierToSize on the Lua side)
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
    if (t > 6) return t * 1024 * 1024;    // raw MB value
    return 0;
  }

  stop(name, { timeoutMs = 3000 } = {}) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) return;

    // Remember that the user asked for this stop, so the UI treats it as a clean
    // shutdown (black screen) even when an unresponsive guest is force-killed (non-zero exit).
    vmState.lastStopRequested = true;

    // Flush first (belt and braces): a guest busy with installs/IO may ignore shutdown and
    // be killed after 3s, so the disk must be saved first or the work is lost.
    // Make the emulator write in-memory disks back to their files, then send shutdown.
    this._send(name, { type: 'command', cmd: 'flush' });

    // Send the shutdown command
    this._send(name, { type: 'command', cmd: 'shutdown' });

    // SIGTERM after the timeout
    setTimeout(() => {
      if (vmState.proc && !vmState.proc.killed) {
        this.logger.log(`[vmManager] ${name} force kill after ${timeoutMs}ms`);
        try { vmState.proc.kill('SIGTERM'); } catch (e) {}
      }
    }, timeoutMs);

    const tickTimer = this.tickTimers.get(name);
    if (tickTimer) { clearTimeout(tickTimer); this.tickTimers.delete(name); }
  }

  // Mirror mode: sync .ocd disk contents back to the folder
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
          // Read every file from the disk and write it back to the folder
          const tree = this.diskIO.listTree(diskPath);
          // listTree returns a { name, type, children } tree; walk it to collect all files
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
              // one unreadable file must not abort the sync
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

  // Restart: stop then start, respawning only after the process has fully exited
  restart(name) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) {
      // Not running: just start
      return this.start(name);
    }
    // Process already exited (the exit handler cleaned up): start directly
    if (vmState.proc.exitCode !== null) {
      this.logger.log(`[vmManager] ${name} already exited, starting directly`);
      return this.start(name);
    }

    // Mark as starting; the UI shows "restarting" on s2c.state
    vmState.state = 'starting';
    this._broadcast(name, { type: 's2c.state', vm: name, state: 'starting' });
    this.logger.log(`[vmManager] restarting ${name}`);

    const proc = vmState.proc;
    // Respawn as soon as the process exits.
    // The exit handler bound in start() already handles tickTimer / modemHub / mirror sync
    // and the "stopped" broadcast, so only start() is needed here.
    let forceKillTimer = null;
    proc.once('exit', () => {
      if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
      this.logger.log(`[vmManager] ${name} exited for restart, respawning`);
      // Drop the old process entry; start() recreates it
      this.processes.delete(name);
      this.start(name);
    });

    // Send the shutdown command
    this._send(name, { type: 'command', cmd: 'shutdown' });

    // Force kill after 3s (same as stop). Target only the old process, otherwise a
    // freshly spawned process could be killed once the old one has exited.
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

  // ---------- Input forwarding ----------
  sendInput(name, inputEvent) {
    this.logger.log(`[vmManager] sendInput ${name}: ${JSON.stringify(inputEvent)}`);
    this._send(name, { type: 'input', ...inputEvent });
  }

  sendCommand(name, cmd, data) {
    const msg = { type: 'command', cmd };
    if (data !== undefined) msg.data = data;
    this._send(name, msg);
  }

  // Check whether the VM is running
  isRunning(name) {
    const vmState = this.processes.get(name);
    return !!(vmState && vmState.proc && vmState.proc.exitCode === null && !vmState.proc.killed);
  }

  // ---------- Subscription management ----------
  subscribe(name, ws) {
    if (!this.subscribers.has(name)) this.subscribers.set(name, new Set());
    this.subscribers.get(name).add(ws);
    const vmState = this.processes.get(name);
    if (!vmState) return;
    // Send the current state first so the UI knows running vs stopped (black / grey).
    // It must precede the screen snapshot, or a stale colored frame shows up first.
    try {
      ws.send(JSON.stringify({
        type: 's2c.state',
        vm: name,
        state: vmState.state,
        exitCode: vmState.lastExitCode != null ? vmState.lastExitCode : undefined,
        cleanStop: vmState.lastStopRequested === true,
      }));
    } catch (e) { /* ignore send failures */ }
    // Send the current screen snapshot
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

  // ---------- Internals ----------
  _send(name, msg) {
    const vmState = this.processes.get(name);
    if (!vmState || !vmState.proc) return;
    // Do not send while the VM is stopped
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
        // Backpressure: buffer is full, wait for drain (non-blocking, just logged)
        this.logger.log(`[vmManager] ${name} stdin buffer full, waiting for drain`);
      }
    } catch (e) {
      this.logger.error(`[vmManager] cannot send to ${name}: ${e.message}`);
    }
  }

  // pullSignal timeout heartbeat: while the VM waits in pullSignal(timeout),
  // the server sends a tick when the timeout expires
  _scheduleTick(name, timeoutMs) {
    const existing = this.tickTimers.get(name);
    if (existing) clearTimeout(existing);
    // timeout <= 0 is a non-blocking poll (event.pull(0)): the guest blocks on
    // stdin until we answer, so answering after a short delay caps the poll rate
    // at ~50 Hz and keeps the Lua process idle instead of spinning at 100% CPU.
    // Answering immediately would let a polling loop flood the pipe and starve
    // the browser on the same machine (phones running both server and client).
    // Otherwise clamp between 50ms and 10s
    let delay;
    if (timeoutMs <= 0) {
      delay = 20;
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

    // Device bus messages (ext_list_request / ext_command) are handled by the bus
    if (this.deviceBus && this.deviceBus.handleMessage(this, name, msg)) return;

    switch (msg.type) {
      case 'screen':
        if (msg.w) vmState.screen.width = msg.w;
        if (msg.h) vmState.screen.height = msg.h;
        if (msg.full && msg.cells) {
          vmState.screen.cells = msg.cells;
        } else if (msg.dirty) {
          // Incremental update: dirty is [[x,y,bg,fg,char],...]
          for (const [x, y, bg, fg, ch] of msg.dirty) {
            // Update the cache (cells is 1-D, index = (y-1)*w + (x-1))
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
        // The VM waits for a signal; the argument is the timeout
        this._scheduleTick(name, msg.timeout || 1000);
        break;

      case 'net_request':
        this._handleNetRequest(name, msg);
        break;

      case 'net_tcp_connect':
        this._handleTcpConnect(name, msg);
        break;

      case 'net_tcp_read':
        this._handleTcpRead(name, msg);
        break;

      case 'net_tcp_write':
        this._handleTcpWrite(name, msg);
        break;

      case 'net_tcp_close':
        this._handleTcpClose(name, msg);
        break;

      case 'modem_send':
        this._handleModemSend(name, msg);
        break;

      case 'modem_broadcast':
        this._handleModemBroadcast(name, msg);
        break;

      case 'modem_register':
        // The VM registers its modem address and tier
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
        // Register the delivery handler; without it modem messages are dropped silently
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
        // modem.setStrength from the guest: strength < 2 isolates this VM from the outside
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

  // ---------- TCP sockets (internet.connect) ----------
  _handleTcpConnect(name, msg) {
    const st = this.processes.get(name);
    if (!st) {
      return this._send(name, { type: 'net_tcp_connected', reqId: msg.reqId, ok: false, error: 'vm not running' });
    }
    if (!st.tcpSockets) st.tcpSockets = new Map();
    const id = ++this.tcpIdCounter;
    const entry = { socket: null, buffer: Buffer.alloc(0), closed: false, pendingReads: [] };
    const socket = new net.Socket();
    entry.socket = socket;
    st.tcpSockets.set(id, entry);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      st.tcpSockets.delete(id);
      try { socket.destroy(); } catch { /* ignore when already closed */ }
      this._send(name, {
        type: 'net_tcp_connected',
        reqId: msg.reqId,
        ok: false,
        id,
        error: String((err && err.message) || err || 'connect failed'),
      });
    };
    socket.setTimeout(10000);
    socket.once('timeout', () => fail(new Error('connect timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      socket.on('error', () => { entry.closed = true; this._flushTcpReads(name, id); });
      socket.on('data', (chunk) => {
        entry.buffer = Buffer.concat([entry.buffer, chunk]);
        this._flushTcpReads(name, id);
      });
      socket.on('end', () => { entry.closed = true; this._flushTcpReads(name, id); });
      socket.on('close', () => { entry.closed = true; this._flushTcpReads(name, id); });
      this._send(name, { type: 'net_tcp_connected', reqId: msg.reqId, ok: true, id });
    });
    socket.connect({ host: String(msg.host || ''), port: Number(msg.port) || 0 });
  }

  // Answer pending reads in order when data arrives or the socket closes
  _flushTcpReads(name, id) {
    const st = this.processes.get(name);
    const entry = st && st.tcpSockets && st.tcpSockets.get(id);
    if (!entry) return;
    while (entry.pendingReads.length > 0) {
      const req = entry.pendingReads[0];
      if (entry.buffer.length > 0) {
        const take = Math.min(req.count, entry.buffer.length);
        const chunk = entry.buffer.subarray(0, take);
        entry.buffer = entry.buffer.subarray(take);
        entry.pendingReads.shift();
        this._send(name, { type: 'net_tcp_read_result', reqId: req.reqId, data: chunk.toString('base64') });
      } else if (entry.closed) {
        entry.pendingReads.shift();
        this._send(name, { type: 'net_tcp_read_result', reqId: req.reqId, closed: true });
      } else {
        break;
      }
    }
  }

  _handleTcpRead(name, msg) {
    const st = this.processes.get(name);
    const entry = st && st.tcpSockets && st.tcpSockets.get(msg.id);
    if (!entry) {
      return this._send(name, { type: 'net_tcp_read_result', reqId: msg.reqId, closed: true });
    }
    const count = Math.max(1, Math.min(Number(msg.count) || 65536, 65536));
    entry.pendingReads.push({ reqId: msg.reqId, count });
    this._flushTcpReads(name, msg.id);
  }

  _handleTcpWrite(name, msg) {
    const st = this.processes.get(name);
    const entry = st && st.tcpSockets && st.tcpSockets.get(msg.id);
    if (!entry || entry.closed) {
      return this._send(name, { type: 'net_tcp_write_result', reqId: msg.reqId, error: 'socket closed' });
    }
    const data = Buffer.from(String(msg.data || ''), 'base64');
    try {
      entry.socket.write(data, () => {
        this._send(name, { type: 'net_tcp_write_result', reqId: msg.reqId, written: data.length });
      });
    } catch (e) {
      this._send(name, { type: 'net_tcp_write_result', reqId: msg.reqId, error: e.message });
    }
  }

  _handleTcpClose(name, msg) {
    const st = this.processes.get(name);
    const entry = st && st.tcpSockets && st.tcpSockets.get(msg.id);
    if (!entry) return;
    st.tcpSockets.delete(msg.id);
    try { entry.socket.destroy(); } catch { /* ignore when already closed */ }
  }

  _closeTcpSockets(name) {
    const st = this.processes.get(name);
    if (!st || !st.tcpSockets) return;
    for (const [, entry] of st.tcpSockets) {
      try { entry.socket.destroy(); } catch { /* ignore when already closed */ }
    }
    st.tcpSockets.clear();
  }

  _handleModemSend(name, msg) {
    const vmState = this.processes.get(name);
    // Both field styles: from/to or just dest; default "from" to the registered modem address
    const fromAddr = msg.from || (vmState && vmState.modemAddress) || '';
    const toAddr = msg.to || msg.dest;
    this.modemHub.route(name, fromAddr, toAddr, msg.port, ...(msg.data || []));
  }

  _handleModemBroadcast(name, msg) {
    const vmState = this.processes.get(name);
    const fromAddr = msg.from || (vmState && vmState.modemAddress) || '';
    this.modemHub.broadcast(name, fromAddr, msg.port, ...(msg.data || []));
  }

  // Flush the stderr buffer to the console and broadcast it to the UI in one go
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
    // Screen frames are frequent; never log every frame or the event loop crawls
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
