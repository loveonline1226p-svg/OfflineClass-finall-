import time
from dataclasses import dataclass

@dataclass(frozen=True)
class HLCTimestamp:
    wall_time: int  # milliseconds
    logical: int
    node_id: str

    def pack(self) -> str:
        """Packs into a lexicographically sortable string: 15-digit wall_time:06-digit logical:node_id"""
        return f"{self.wall_time:015d}:{self.logical:06d}:{self.node_id}"

    @staticmethod
    def unpack(packed: str) -> "HLCTimestamp":
        parts = packed.split(":", 2)
        if len(parts) != 3:
            raise ValueError(f"Invalid HLC string: {packed}")
        return HLCTimestamp(
            wall_time=int(parts[0]),
            logical=int(parts[1]),
            node_id=parts[2]
        )


class HybridLogicalClock:
    def __init__(self, node_id: str = "server"):
        self.node_id = node_id
        self.last_wall_time = 0
        self.logical = 0

    def _now_ms(self, override_ms: int = None) -> int:
        return override_ms if override_ms is not None else int(time.time() * 1000)

    def now(self, physical_time_ms: int = None) -> str:
        """Generates an HLC timestamp for a local event."""
        phys = self._now_ms(physical_time_ms)
        if phys > self.last_wall_time:
            self.last_wall_time = phys
            self.logical = 0
        else:
            self.logical += 1
        return HLCTimestamp(self.last_wall_time, self.logical, self.node_id).pack()

    def update(self, remote_packed: str, physical_time_ms: int = None) -> str:
        """Updates local HLC upon receiving a remote event and returns the new HLC."""
        phys = self._now_ms(physical_time_ms)
        remote = HLCTimestamp.unpack(remote_packed)

        if phys > self.last_wall_time and phys > remote.wall_time:
            self.last_wall_time = phys
            self.logical = 0
        elif self.last_wall_time == remote.wall_time:
            self.logical = max(self.logical, remote.logical) + 1
        elif remote.wall_time > self.last_wall_time:
            self.last_wall_time = remote.wall_time
            self.logical = remote.logical + 1
        else:
            self.logical += 1

        return HLCTimestamp(self.last_wall_time, self.logical, self.node_id).pack()

    @staticmethod
    def compare(hlc_a: str, hlc_b: str) -> int:
        """Returns -1 if a < b, 1 if a > b, 0 if equal."""
        a = HLCTimestamp.unpack(hlc_a)
        b = HLCTimestamp.unpack(hlc_b)
        if a.wall_time != b.wall_time:
            return -1 if a.wall_time < b.wall_time else 1
        if a.logical != b.logical:
            return -1 if a.logical < b.logical else 1
        if a.node_id != b.node_id:
            return -1 if a.node_id < b.node_id else 1
        return 0
