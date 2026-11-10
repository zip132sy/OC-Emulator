// ============================================================
// deviceBus.js - external device bus
//
// Some devices are not computers themselves (e.g. an IC2 reactor). In the real
// world they join a component network through an adapter and computers access
// them as components. The emulator has no block placement, so all such devices
// share one bus:
//   * a VM receives the device list (ext_devices) and a state snapshot (ext_state) at startup
//   * state is pushed once per second and component methods read the local snapshot
//   * writes (e.g. setActive) go back to the server as ext_command
// ============================================================
class DeviceBus {
  constructor({ logger } = {}) {
    this.logger = logger || console;
    this.devices = new Map();   // address -> { address, type, name, state(), command(method, args) }
    this.managers = new Set();
    this.timer = setInterval(() => this.broadcastStates(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  attach(manager) {
    if (manager) this.managers.add(manager);
  }

  register(device) {
    if (!device || !device.address || !device.type) return null;
    this.devices.set(device.address, device);
    this.broadcastDevices();
    return device.address;
  }

  unregister(address) {
    if (this.devices.delete(address)) this.broadcastDevices();
  }

  // VM the device is currently wired to; null means unconnected (cable not plugged in)
  _connectedVm(device) {
    try {
      const value = typeof device.vm === 'function' ? device.vm() : device.vm;
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  _visibleTo(device, vmName) {
    return !!vmName && this._connectedVm(device) === vmName;
  }

  _deviceList(vmName) {
    return Array.from(this.devices.values())
      .filter((d) => this._visibleTo(d, vmName))
      .map(d => ({
        address: d.address,
        type: d.type,
        name: d.name,
        meta: d.meta || null,
      }));
  }

  // Written to devices.json before the VM starts
  getDeviceList(vmName) {
    return this._deviceList(vmName);
  }

  // List + current state: programs can read valid data the moment they start
  getSnapshot(vmName) {
    const out = [];
    for (const device of this.devices.values()) {
      if (!this._visibleTo(device, vmName)) continue;
      let state = {};
      try {
        state = device.state();
      } catch {
        /* return an empty snapshot when one device fails to report its state */
      }
      out.push({
        address: device.address,
        type: device.type,
        name: device.name,
        meta: device.meta || null,
        state,
      });
    }
    return out;
  }

  _states(vmName) {
    const out = [];
    for (const device of this.devices.values()) {
      if (!this._visibleTo(device, vmName)) continue;
      try {
        out.push({ address: device.address, state: device.state() });
      } catch (e) {
        this.logger.error(`[deviceBus] state of ${device.address} failed: ${e.message}`);
      }
    }
    return out;
  }

  // Push the device list and current state to the given VM
  sendDevices(manager, vmName) {
    manager._send(vmName, { type: 'ext_devices', devices: this._deviceList(vmName) });
    manager._send(vmName, { type: 'ext_state', devices: this._states(vmName) });
  }

  broadcastDevices() {
    for (const manager of this.managers) {
      for (const [name, state] of manager.processes) {
        if (state.state === 'running') this.sendDevices(manager, name);
      }
    }
  }

  broadcastStates() {
    if (!this.devices.size) return;
    for (const manager of this.managers) {
      for (const [name, state] of manager.processes) {
        if (state.state !== 'running') continue;
        const devices = this._states(name);
        manager._send(name, { type: 'ext_state', devices });
      }
    }
  }

  // Device-related messages from a VM; returns true when handled
  handleMessage(manager, vmName, msg) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'ext_list_request') {
      this.sendDevices(manager, vmName);
      return true;
    }

    if (msg.type === 'ext_command') {
      const device = this.devices.get(msg.address);
      if (!device || typeof device.command !== 'function') return true;
      // Commands are only allowed for devices wired to this VM
      if (!this._visibleTo(device, vmName)) return true;
      const args = Array.isArray(msg.args) ? msg.args : [];
      try {
        device.command(msg.method, args);
      } catch (e) {
        this.logger.error(`[deviceBus] command ${msg.method} on ${msg.address} failed: ${e.message}`);
      }
      return true;
    }

    return false;
  }
}

module.exports = { DeviceBus };
