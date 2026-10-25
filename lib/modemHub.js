// lib/modemHub.js
// Cross-VM wireless modem routing hub.
//
// When VM-A's wireless modem "sends" a message, this in-memory hub routes the
// message to VM-B's wireless modem without touching any real network driver.
// T1 and T2 modems can talk to each other ("可以跨等级").
//
// 信号强度 (signal strength)：
//   现实 OC 里无线范围按"格"计算, 模拟器没有空间概念, 于是用离散的
//   "信号强度": 1 表示这台 VM 自成一网 (无法发现/连接本工具里的其他虚拟机),
//   >= 2 表示可以与其他虚拟机互相发现并收发 modem 消息。
const MIN_STRENGTH_FOR_NETWORK = 2;

// 归一化信号强度: 非法值回退到卡片等级 (T1=1, T2=2), 范围 [1, 16]
function normalizeStrength(strength, tier) {
  let s = Number(strength);
  if (!Number.isFinite(s)) s = Number(tier) >= 2 ? 2 : 1;
  s = Math.round(s);
  if (s < 1) s = 1;
  if (s > 16) s = 16;
  return s;
}

class ModemHub {
  constructor() {
    // vmName -> { address, tier, ports: Set<number>, handler }
    this.vms = new Map();
    // address -> vmName (for O(1) route lookup)
    this.addrIndex = new Map();
    // port -> Set<vmName> (for broadcast)
    this.portIndex = new Map();
    // Mods 设备地址: 无论发送方信号强度如何, 都允许与 Mods 设备通信
    this.modAddresses = new Set();
  }

  /**
   * Mark a registered modem address as a Mods device.
   * Mods devices are reachable by T1 and T2 wireless cards alike, and may
   * reply to isolated senders (e.g. T1 cards with signal strength 1).
   */
  markModAddress(address) {
    if (!address) return false;
    this.modAddresses.add(address);
    const vmName = this.addrIndex.get(address);
    if (vmName) {
      const entry = this.vms.get(vmName);
      if (entry) entry.isMod = true;
    }
    return true;
  }

  isModAddress(address) {
    return this.modAddresses.has(address);
  }

  /**
   * A VM is starting up and registering its modem.
   * @param {string} vmName
   * @param {{ address: string, tier?: number, ports?: number[], strength?: number }} modemInfo
   */
  register(vmName, { address, tier = 1, ports = [], wired = false, strength } = {}) {
    if (!vmName) throw new Error("ModemHub.register: vmName required");
    if (!address) throw new Error("ModemHub.register: address required");

    // If the VM was already registered, clean up the old state first.
    if (this.vms.has(vmName)) {
      this.unregister(vmName);
    }

    const entry = {
      vmName,
      address,
      tier,
      strength: normalizeStrength(strength, tier),
      wired: wired || tier >= 2,  // T2+ modems participate in wired (cable) network
      ports: new Set(ports),
      handler: null,
      isMod: this.modAddresses.has(address),
    };
    this.vms.set(vmName, entry);
    this.addrIndex.set(address, vmName);

    // Index the open ports for broadcast.
    for (const port of entry.ports) {
      if (!this.portIndex.has(port)) {
        this.portIndex.set(port, new Set());
      }
      this.portIndex.get(port).add(vmName);
    }

    return entry;
  }

  /**
   * Bind a delivery handler so the hub can push messages into a VM's signal
   * queue. The handler signature is:
   *   handler(payload) where payload = {
   *     type: "modem_message",
   *     fromAddr: string,
   *     toAddr: string|null,   // null on broadcast
   *     port: number,
   *     distance: number,      // logical distance, default 0 (same host)
   *     messages: any[],       // varargs from sender
   *     fromVm: string,
   *   }
   * @param {string} vmName
   * @param {function} handler
   */
  setHandler(vmName, handler) {
    const entry = this.vms.get(vmName);
    if (!entry) return false;
    entry.handler = typeof handler === "function" ? handler : null;
    return true;
  }

  /**
   * 更新一台 VM 的信号强度 (对应虚拟机内 modem.setStrength / 配置里的 modemStrength)。
   * 强度 < 2 时该 VM 被隔离: 无法发现其他虚拟机, 也无法与之通信。
   * @param {string} vmName
   * @param {number} strength
   */
  setStrength(vmName, strength) {
    const entry = this.vms.get(vmName);
    if (!entry) return false;
    entry.strength = normalizeStrength(strength, entry.tier);
    return true;
  }

  /**
   * Open a port on a registered VM's modem.
   * @param {string} vmName
   * @param {number} port
   */
  openPort(vmName, port) {
    const entry = this.vms.get(vmName);
    if (!entry) return false;
    if (entry.ports.has(port)) return true;
    entry.ports.add(port);
    if (!this.portIndex.has(port)) {
      this.portIndex.set(port, new Set());
    }
    this.portIndex.get(port).add(vmName);
    return true;
  }

  /**
   * Close a port on a registered VM's modem.
   * @param {string} vmName
   * @param {number} port
   */
  closePort(vmName, port) {
    const entry = this.vms.get(vmName);
    if (!entry) return false;
    if (!entry.ports.has(port)) return true;
    entry.ports.delete(port);
    const set = this.portIndex.get(port);
    if (set) {
      set.delete(vmName);
      if (set.size === 0) this.portIndex.delete(port);
    }
    return true;
  }

  /**
   * A VM has shut down - drop all of its modem state.
   * @param {string} vmName
   */
  unregister(vmName) {
    const entry = this.vms.get(vmName);
    if (!entry) return false;

    this.addrIndex.delete(entry.address);
    this.modAddresses.delete(entry.address);
    for (const port of entry.ports) {
      const set = this.portIndex.get(port);
      if (set) {
        set.delete(vmName);
        if (set.size === 0) this.portIndex.delete(port);
      }
    }
    this.vms.delete(vmName);
    return true;
  }

  /**
   * Send a unicast message from one VM to another by destination modem
   * address. Cross-tier (T1 <-> T2) is allowed per project spec.
   *
   * @param {string} fromVm   - sender vm name
   * @param {string} fromAddr - sender modem address
   * @param {string} toAddr   - destination modem address
   * @param {number} port     - port number
   * @param {...any} message  - varargs payload (matches OC modem API)
   * @returns {{ delivered: number, skipped: string[], reason?: string }}
   */
  route(fromVm, fromAddr, toAddr, port, ...message) {
    const result = { delivered: 0, skipped: [] };

    if (!toAddr) {
      result.reason = "no destination address";
      return result;
    }

    const destVm = this.addrIndex.get(toAddr);
    if (!destVm) {
      result.reason = "destination address not registered";
      return result;
    }

    // Don't deliver to ourselves.
    if (destVm === fromVm) {
      result.reason = "destination is sender (self-route skipped)";
      return result;
    }

    const dest = this.vms.get(destVm);
    if (!dest || !dest.handler) {
      result.skipped.push(destVm);
      return result;
    }

    // 信号强度隔离: 强度 < 2 的普通 VM 自成一网。
    // Mods 设备例外: T1 / T2 无线网卡都可以与 Mods 设备通信。
    const sender = this.vms.get(fromVm);
    const senderIsolated = !sender || sender.strength < MIN_STRENGTH_FOR_NETWORK;
    const senderIsMod = !!(sender && sender.isMod);
    if (senderIsolated && !senderIsMod && !dest.isMod) {
      result.reason = "sender signal strength too low (isolated)";
      return result;
    }
    if (dest.strength < MIN_STRENGTH_FOR_NETWORK && !dest.isMod && !senderIsMod) {
      result.skipped.push(destVm);
      result.reason = "destination signal strength too low (isolated)";
      return result;
    }

    // Destination must have this port open to receive. (Same as OC: closed
    // ports silently drop the message.)
    if (!dest.ports.has(port)) {
      result.skipped.push(destVm);
      result.reason = "destination port not open";
      return result;
    }

    const isWired = sender && sender.wired && dest.wired;

    const payload = {
      type: "modem_message",
      fromAddr,
      toAddr,
      port,
      distance: 0,
      wired: isWired,  // true if both sender and receiver are T2+ (cable network)
      messages: message,
      fromVm,
    };

    try {
      dest.handler(payload);
      result.delivered = 1;
    } catch (err) {
      result.skipped.push(destVm);
      result.reason = "handler threw: " + (err && err.message || String(err));
    }

    return result;
  }

  /**
   * Send a broadcast on a port. Every VM (other than the sender) that has
   * that port open gets the message. Cross-tier is allowed.
   *
   * @param {string} fromVm
   * @param {string} fromAddr
   * @param {number} port
   * @param {...any} message
   * @returns {{ delivered: number, skipped: string[] }}
   */
  broadcast(fromVm, fromAddr, port, ...message) {
    const result = { delivered: 0, skipped: [] };
    const subscribers = this.portIndex.get(port);
    if (!subscribers || subscribers.size === 0) return result;

    const sender = this.vms.get(fromVm);
    // 信号强度隔离: 普通 VM 之间保持隔离; Mods 设备对 T1 / T2 都可见。
    const senderIsolated = !sender || sender.strength < MIN_STRENGTH_FOR_NETWORK;
    const senderIsMod = !!(sender && sender.isMod);

    for (const vmName of subscribers) {
      if (vmName === fromVm) continue; // don't echo to sender
      const dest = this.vms.get(vmName);
      if (!dest || !dest.handler) {
        result.skipped.push(vmName);
        continue;
      }
      if (senderIsolated && !dest.isMod) {
        result.skipped.push(vmName);
        continue;
      }
      if (dest.strength < MIN_STRENGTH_FOR_NETWORK && !dest.isMod && !senderIsMod) {
        result.skipped.push(vmName);
        continue;
      }
      const isWired = sender && sender.wired && dest.wired;
      const payload = {
        type: "modem_message",
        fromAddr,
        toAddr: null, // broadcast
        port,
        distance: 0,
        wired: isWired,  // true if both sender and receiver are T2+
        messages: message,
        fromVm,
      };
      try {
        dest.handler(payload);
        result.delivered += 1;
      } catch (err) {
        result.skipped.push(vmName);
      }
    }
    return result;
  }

  /**
   * Snapshot for debugging / UI. Returns plain JSON-safe objects.
   */
  snapshot() {
    const vms = [];
    for (const [name, entry] of this.vms) {
      vms.push({
        vmName: name,
        address: entry.address,
        tier: entry.tier,
        strength: entry.strength,
        ports: Array.from(entry.ports),
        hasHandler: !!entry.handler,
        isMod: !!entry.isMod,
      });
    }
    return {
      vms,
      portIndex: Array.from(this.portIndex.entries()).map(([port, set]) => ({
        port,
        subscribers: Array.from(set),
      })),
    };
  }

  /**
   * Look up a registered VM by name.
   * @param {string} vmName
   * @returns {object|null}
   */
  getVm(vmName) {
    const entry = this.vms.get(vmName);
    if (!entry) return null;
    return {
      vmName: entry.vmName,
      address: entry.address,
      tier: entry.tier,
      strength: entry.strength,
      ports: Array.from(entry.ports),
      hasHandler: !!entry.handler,
    };
  }

  /**
   * Look up a registered VM by modem address.
   * @param {string} address
   * @returns {object|null}
   */
  getByAddress(address) {
    const vmName = this.addrIndex.get(address);
    if (!vmName) return null;
    return this.getVm(vmName);
  }
}

module.exports = { ModemHub };
