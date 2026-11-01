class ClientHLC {
  constructor(nodeId) {
    this.nodeId = nodeId || "dev-unknown";
    this.storageKey = `offlineclass_hlc_${this.nodeId}`;
    this.lastWallTime = 0;
    this.logical = 0;
    this.clockOffsetMs = 0; // Used for simulating clock skew in tests
    this._load();
  }

  setNodeId(nodeId) {
    if (nodeId === this.nodeId) return; // keep the in-memory state (which includes remote updates)
    this.nodeId = nodeId;
    this.storageKey = `offlineclass_hlc_${this.nodeId}`;
    // Every node has its own saved clock; do not leak the previous node's state into it.
    this.lastWallTime = 0;
    this.logical = 0;
    this._load();
  }

  _load() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.lastWallTime = parsed.lastWallTime || 0;
        this.logical = parsed.logical || 0;
      }
    } catch (e) {
      console.warn("HLC load warning:", e);
    }
  }

  _save() {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ lastWallTime: this.lastWallTime, logical: this.logical })
      );
    } catch (e) {}
  }

  static pack(wallTime, logical, nodeId) {
    const wt = String(wallTime).padStart(15, "0");
    const lg = String(logical).padStart(6, "0");
    return `${wt}:${lg}:${nodeId}`;
  }

  static unpack(packed) {
    const parts = packed.split(":");
    return {
      wallTime: parseInt(parts[0], 10),
      logical: parseInt(parts[1], 10),
      nodeId: parts.slice(2).join(":")
    };
  }

  static compare(hlcA, hlcB) {
    if (!hlcA && !hlcB) return 0;
    if (!hlcA) return -1;
    if (!hlcB) return 1;
    const a = ClientHLC.unpack(hlcA);
    const b = ClientHLC.unpack(hlcB);
    if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
    return 0;
  }

  now(overridePhysicalMs = null) {
    const phys = overridePhysicalMs !== null ? overridePhysicalMs : Date.now() + this.clockOffsetMs;
    if (phys > this.lastWallTime) {
      this.lastWallTime = phys;
      this.logical = 0;
    } else {
      this.logical += 1;
    }
    this._save();
    return ClientHLC.pack(this.lastWallTime, this.logical, this.nodeId);
  }

  update(remotePacked, overridePhysicalMs = null) {
    const phys = overridePhysicalMs !== null ? overridePhysicalMs : Date.now() + this.clockOffsetMs;
    const remote = ClientHLC.unpack(remotePacked);

    if (phys > this.lastWallTime && phys > remote.wallTime) {
      this.lastWallTime = phys;
      this.logical = 0;
    } else if (this.lastWallTime === remote.wallTime) {
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (remote.wallTime > this.lastWallTime) {
      this.lastWallTime = remote.wallTime;
      this.logical = remote.logical + 1;
    } else {
      this.logical += 1;
    }
    this._save();
    return ClientHLC.pack(this.lastWallTime, this.logical, this.nodeId);
  }
}

window.ClientHLC = ClientHLC;
