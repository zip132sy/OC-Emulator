// ============================================================
// machineHost.js - Lua host process for scriptable machines
//
// Every machine-type Mod runs in its own Lua process:
//   * on start the host receives machine.lua and the persisted state
//   * the server sends one tick per second and the host reports each component's latest state
//   * property writes / action calls are sent to the host to execute
// ============================================================
const { spawn } = require('child_process');

class MachineHost {
  constructor(opts) {
    this.name = opts.name;
    this.luaExe = opts.luaExe;
    this.hostScript = opts.hostScript;
    this.projectDir = opts.projectDir;
    this.scriptPath = opts.scriptPath;
    this.initialState = opts.initialState || {};
    this.logger = opts.logger || console;
    this.onReady = opts.onReady || (() => {});
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.onExit = opts.onExit || (() => {});

    this.proc = null;
    this.alive = false;
    this.ready = false;
    this.stopping = false;
    this.lineBuffer = '';
    this.lastError = null;
  }

  start() {
    if (this.alive) return;
    let proc;
    try {
      proc = spawn(this.luaExe, [this.hostScript, this.projectDir], {
        cwd: this.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.logger.error(`[machine:${this.name}] spawn failed: ${e.message}`);
      this.onError(e.message);
      return;
    }
    this.proc = proc;
    this.alive = true;
    this.ready = false;
    this.stopping = false;
    this.lineBuffer = '';

    proc.stdout.on('data', (data) => {
      this.lineBuffer += data.toString('utf8');
      let nl;
      while ((nl = this.lineBuffer.indexOf('\n')) >= 0) {
        const line = this.lineBuffer.substring(0, nl);
        this.lineBuffer = this.lineBuffer.substring(nl + 1);
        if (!line.trim()) continue;
        try {
          this._onMessage(JSON.parse(line));
        } catch (e) {
          this.logger.log(`[machine:${this.name}] stdout: ${line}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString('utf8').trim();
      if (text) this.logger.error(`[machine:${this.name}] ${text}`);
    });

    proc.on('exit', (code) => {
      this.alive = false;
      this.ready = false;
      this.proc = null;
      if (!this.stopping) {
        this.logger.error(`[machine:${this.name}] host exited with code ${code}`);
      }
      this.onExit(code, this.stopping);
    });

    this._send({ type: 'init', script: this.scriptPath, state: this.initialState });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.lastError = null;
      this.onReady(msg);
    } else if (msg.type === 'state') {
      this.onState(msg);
    } else if (msg.type === 'error') {
      this.lastError = String(msg.message || 'unknown error');
      this.onError(this.lastError);
    }
  }

  _send(message) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    } catch {
      /* ignore write failures once the process has exited */
    }
  }

  tick(dt = 1) {
    if (!this.ready) return;
    this._send({ type: 'tick', dt });
  }

  setValue(componentIndex, key, value) {
    if (!this.ready) return;
    this._send({ type: 'set', component: componentIndex + 1, key, value });
  }

  action(componentIndex, action, args) {
    if (!this.ready) return;
    this._send({ type: 'action', component: componentIndex + 1, action, args: args || [] });
  }

  stop() {
    this.stopping = true;
    if (!this.proc) return;
    this._send({ type: 'quit' });
    const proc = this.proc;
    // A user script may hang, so force-kill when the quit request does not take effect
    setTimeout(() => {
      if (this.proc === proc && this.alive) {
        try { proc.kill(); } catch { /* process already gone */ }
      }
    }, 1000).unref?.();
  }

  // Kill the child immediately when the server exits, avoiding orphaned Lua processes
  kill() {
    this.stopping = true;
    if (!this.proc) return;
    try { this.proc.kill(); } catch { /* process already gone */ }
  }
}

module.exports = { MachineHost };
