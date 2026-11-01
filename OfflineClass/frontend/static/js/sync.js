const STUDENT_FIELDS = ["full_name", "class_name", "section", "roll_number", "dob", "guardian_contact"];

class SyncEngine {
  constructor() {
    this.isSyncing = false;
    this.simulatedOffline = localStorage.getItem("offlineclass_sim_offline") === "true";
    this.batchSize = 25;
  }

  isOnline() {
    return navigator.onLine && !this.simulatedOffline;
  }

  setSimulatedOffline(val) {
    this.simulatedOffline = Boolean(val);
    localStorage.setItem("offlineclass_sim_offline", String(this.simulatedOffline));
    window.dispatchEvent(new CustomEvent("connectivity-change"));
  }

  async queueOperation(entityType, entityId, operationType, payload, userId) {
    const deviceId = await window.localDB.getOrCreateDeviceId();
    window.clientHLC.setNodeId(deviceId);
    const hlc = window.clientHLC.now();
    const op = {
      operation_id: `op-${crypto.randomUUID()}`,
      entity_type: entityType,
      entity_id: entityId,
      operation_type: operationType,
      payload,
      device_id: deviceId,
      user_id: userId || "usr-teacher-1",
      hlc,
      created_at: Date.now(),
      sync_status: "pending"
    };
    await window.localDB.put("pending_operations", op);
    return op;
  }

  // True when an operation that touches this student (or this student's attendance) is still queued.
  async hasPendingFor(studentId, exceptOperationId = null) {
    const pending = await window.localDB.getAll("pending_operations");
    return pending.some(
      (o) =>
        o.operation_id !== exceptOperationId &&
        (o.entity_id === studentId || (o.payload && o.payload.student_id === studentId))
    );
  }

  async applyRemoteOperationLocally(op) {
    window.clientHLC.setNodeId(await window.localDB.getOrCreateDeviceId());
    window.clientHLC.update(op.hlc);

    if (op.entity_type === "student") {
      const p = op.payload || {};

      // A removed student: wipe it (and its attendance/conflicts/queued ops) from this device.
      if (op.operation_type === "delete") {
        await window.localDB.removeStudentLocally(op.entity_id);
        for (const pend of await window.localDB.getAll("pending_operations")) {
          if (pend.operation_id !== op.operation_id && (pend.entity_id === op.entity_id || (pend.payload && pend.payload.student_id === op.entity_id))) {
            await window.localDB.delete("pending_operations", pend.operation_id);
          }
        }
        return;
      }
      if (p.redacted) return; // scrubbed history of a removed student

      const existing = await window.localDB.get("students", op.entity_id);
      const stillPending = await this.hasPendingFor(op.entity_id, op.operation_id);
      if (!existing) {
        // Never build a record out of a partial "update": it would show up as a half-empty clone.
        if (op.operation_type !== "create" && !p.full_name) return;
        const fieldHlcs = {};
        STUDENT_FIELDS.forEach((f) => {
          if (p[f] !== undefined) fieldHlcs[f] = op.hlc;
        });
        await window.localDB.saveStudent({
          student_id: op.entity_id,
          full_name: p.full_name || "",
          class_name: p.class_name || "",
          section: p.section || "",
          roll_number: p.roll_number || "",
          dob: p.dob || "",
          guardian_contact: p.guardian_contact || "",
          field_hlcs: fieldHlcs,
          created_at: p.created_at || op.created_at,
          updated_at: Date.now(),
          sync_status: stillPending ? "pending" : "synced"
        });
      } else {
        // Copy the stored record as-is (ciphertext stays untouched) and only overwrite the
        // fields that win the per-field HLC comparison.
        const current = { ...existing, field_hlcs: { ...(existing.field_hlcs || {}) } };
        STUDENT_FIELDS.forEach((f) => {
          if (p[f] !== undefined && p[f] !== null) {
            const prevHlc = current.field_hlcs[f] || "000000000000000:000000:init";
            if (ClientHLC.compare(op.hlc, prevHlc) >= 0) {
              current[f] = p[f];
              current.field_hlcs[f] = op.hlc;
            }
          }
        });
        current.sync_status = stillPending ? "pending" : "synced";
        current.updated_at = Date.now();
        await window.localDB.saveStudent(current);
      }
    } else if (op.entity_type === "attendance") {
      const p = op.payload;
      const logicalKey = `${p.student_id}_${p.attendance_date}`;
      const existing = await window.localDB.get("attendance", logicalKey);

      if (op.operation_type === "resolve_conflict") {
        await window.localDB.put("attendance", {
          logical_key: logicalKey,
          attendance_id: p.attendance_id || op.entity_id,
          student_id: p.student_id,
          attendance_date: p.attendance_date,
          status: p.status,
          teacher_id: p.teacher_id,
          device_id: op.device_id,
          hlc: op.hlc,
          has_conflict: 0,
          created_at: p.created_at || op.created_at,
          updated_at: Date.now(),
          sync_status: "synced"
        });
      } else if (!existing || ClientHLC.compare(op.hlc, existing.hlc) >= 0) {
        await window.localDB.put("attendance", {
          logical_key: logicalKey,
          attendance_id: existing ? existing.attendance_id : op.entity_id,
          student_id: p.student_id,
          attendance_date: p.attendance_date,
          status: p.status,
          teacher_id: p.teacher_id || op.user_id,
          device_id: op.device_id,
          hlc: op.hlc,
          has_conflict: existing ? existing.has_conflict : 0,
          created_at: p.created_at || op.created_at,
          updated_at: Date.now(),
          sync_status: "synced"
        });
      }
    }
  }

  // Re-computes every attendance record's conflict flag from the server's list of conflicts.
  // The flag is true ONLY while an unresolved conflict exists for that student + date.
  // (The old code looped over all conflicts, so an old *resolved* conflict could switch the flag
  // back off after a newer unresolved one had switched it on -> "Synced" when it should say
  // "Conflict".)
  async applyConflictList(conflicts) {
    await window.localDB.clearStore("conflicts");
    const openKeys = new Set();
    for (const c of conflicts) {
      await window.localDB.put("conflicts", c);
      if (c.status === "unresolved") openKeys.add(`${c.student_id}_${c.attendance_date}`);
    }
    for (const att of await window.localDB.getAll("attendance")) {
      const flag = openKeys.has(att.logical_key) ? 1 : 0;
      if ((att.has_conflict ? 1 : 0) !== flag) {
        att.has_conflict = flag;
        await window.localDB.put("attendance", att);
      }
    }
  }

  // The cached ciphertext can only be read with the key that wrote it. If the key changed (new
  // server secret) or the data predates the shared key, it is thrown away and re-downloaded
  // from the server AFTER all local pending operations have been pushed.
  async needsRekey() {
    const fp = window.clientCrypto.keyFingerprint;
    if (!fp) return false;
    const meta = await window.localDB.get("sync_meta", "key_fingerprint");
    if (meta && meta.value === fp) return false;
    const hasData = (await window.localDB.getAll("students")).length > 0;
    if (!hasData) {
      await window.localDB.put("sync_meta", { key: "key_fingerprint", value: fp });
      return false;
    }
    return true;
  }

  async syncNow(options = {}) {
    if (!this.isOnline()) {
      window.dispatchEvent(new CustomEvent("sync-status", { detail: { state: "offline" } }));
      return { ok: false, reason: "offline" };
    }
    if (this.isSyncing) return { ok: false, reason: "busy" };

    this.isSyncing = true;
    window.dispatchEvent(new CustomEvent("sync-status", { detail: { state: "syncing" } }));

    try {
      const deviceId = await window.localDB.getOrCreateDeviceId();
      window.clientHLC.setNodeId(deviceId);
      const pendingOps = await window.localDB.getAll("pending_operations");
      pendingOps.sort((a, b) => ClientHLC.compare(a.hlc, b.hlc));

      let cursorMeta = await window.localDB.get("sync_meta", "server_cursor");
      let sinceSeq = cursorMeta ? cursorMeta.value : 0;
      let rekeyPending = await this.needsRekey();

      // Send pending operations in resumable batches
      const totalBatches = Math.max(1, Math.ceil(pendingOps.length / this.batchSize));
      let hasMoreRemote = true;
      let batchIndex = 0;

      while (batchIndex < totalBatches || hasMoreRemote) {
        const batchOps = pendingOps.slice(batchIndex * this.batchSize, (batchIndex + 1) * this.batchSize);
        const payload = {
          device_id: deviceId,
          since_seq: sinceSeq,
          batch_size: this.batchSize,
          operations: batchOps,
          is_retry: Boolean(options.isRetry),
          simulate_interrupt_after: options.simulateInterruptAfter ?? null
        };

        const response = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        let data = {};
        try {
          data = await response.json();
        } catch (e) {
          throw new Error(`Server error (HTTP ${response.status})`);
        }

        if (!response.ok) {
          // Even if interrupted mid-batch (503), remove any operations that the server already acknowledged!
          if (data && Array.isArray(data.acknowledged_ids)) {
            for (const ackId of data.acknowledged_ids) {
              await window.localDB.delete("pending_operations", ackId);
            }
          }
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        // 1. Delete acknowledged operations from pending queue and mark local entities as synced
        for (const ackId of data.acknowledged_ids || []) {
          const ackedOp = batchOps.find((o) => o.operation_id === ackId);
          await window.localDB.delete("pending_operations", ackId);
          if (!ackedOp) continue;
          if (ackedOp.entity_type === "student" && ackedOp.operation_type !== "delete") {
            const st = await window.localDB.get("students", ackedOp.entity_id);
            if (st && !(await this.hasPendingFor(ackedOp.entity_id))) {
              st.sync_status = "synced";
              await window.localDB.put("students", st);
            }
          } else if (ackedOp.entity_type === "attendance") {
            const lKey = `${ackedOp.payload.student_id}_${ackedOp.payload.attendance_date}`;
            const att = await window.localDB.get("attendance", lKey);
            // only mark synced if this acknowledged op is still the latest local edit
            if (att && att.hlc === ackedOp.hlc) {
              att.sync_status = "synced";
              await window.localDB.put("attendance", att);
            }
          }
        }

        // 2. Apply remote delta operations locally
        for (const remOp of data.remote_operations || []) {
          await this.applyRemoteOperationLocally(remOp);
        }

        // 3. Update local conflicts store + recompute every conflict flag
        if (Array.isArray(data.conflicts)) {
          await this.applyConflictList(data.conflicts);
        }

        // 4. Advance durable sync cursor
        sinceSeq = data.server_cursor;
        hasMoreRemote = Boolean(data.has_more);
        batchIndex += 1;

        // 5. Key changed? Once every local change has reached the server, drop the unreadable
        //    cache and pull everything again from the server with the current key.
        if (rekeyPending && batchIndex >= totalBatches) {
          for (const store of ["students", "attendance", "conflicts"]) {
            await window.localDB.clearStore(store);
          }
          sinceSeq = 0;
          hasMoreRemote = true;
          rekeyPending = false;
          await window.localDB.put("sync_meta", { key: "key_fingerprint", value: window.clientCrypto.keyFingerprint });
        }

        await window.localDB.put("sync_meta", {
          key: "server_cursor",
          value: sinceSeq,
          updated_at: Date.now()
        });
        await window.localDB.put("sync_meta", {
          key: "last_sync_time",
          value: Date.now()
        });
      }

      this.isSyncing = false;
      window.dispatchEvent(new CustomEvent("sync-status", { detail: { state: "up-to-date" } }));
      return { ok: true };
    } catch (err) {
      this.isSyncing = false;
      window.dispatchEvent(
        new CustomEvent("sync-status", { detail: { state: "error", message: err.message } })
      );
      return { ok: false, error: err.message };
    }
  }
}

window.syncEngine = new SyncEngine();
