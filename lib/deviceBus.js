// ============================================================
// deviceBus.js - 外部设备总线
//
// 有些设备本身不是计算机 (例如 IC2 核电站), 真实环境里通过适配器接入
// 组件网络, 由计算机以组件方式访问。模拟器没有方块摆放, 因此把所有这类
// 设备放在同一条总线上:
//   * 虚拟机启动时收到设备列表 (ext_devices) 与状态快照 (ext_state)
//   * 状态每秒推送一次, 组件方法读取本地快照
//   * 写操作 (如 setActive) 通过 ext_command 发回服务端执行
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

  // 设备当前连接的虚拟机; null 表示未连接 (接线未插上)
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
      }));
  }

  // 供虚拟机启动前写入 devices.json
  getDeviceList(vmName) {
    return this._deviceList(vmName);
  }

  // 列表 + 当前状态: 程序启动瞬间就能读到有效数据
  getSnapshot(vmName) {
    const out = [];
    for (const device of this.devices.values()) {
      if (!this._visibleTo(device, vmName)) continue;
      let state = {};
      try {
        state = device.state();
      } catch {
        /* 单个设备取状态失败时返回空快照 */
      }
      out.push({ address: device.address, type: device.type, name: device.name, state });
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

  // 给指定虚拟机推送设备表与当前状态
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

  // 虚拟机发来的设备相关消息; 返回 true 表示已处理
  handleMessage(manager, vmName, msg) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'ext_list_request') {
      this.sendDevices(manager, vmName);
      return true;
    }

    if (msg.type === 'ext_command') {
      const device = this.devices.get(msg.address);
      if (!device || typeof device.command !== 'function') return true;
      // 只有接线到这台虚拟机的设备才允许下发命令
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
