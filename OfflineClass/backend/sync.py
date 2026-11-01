import json
import time
import uuid
from flask import Blueprint, request, jsonify, session
from backend.database import get_db_connection
from backend.clock import HybridLogicalClock
from backend.encryption import encryptor
from config import Config

sync_bp = Blueprint("sync", __name__)
server_clock = HybridLogicalClock(node_id="central-server")

STUDENT_FIELDS = ["full_name", "class_name", "section", "roll_number", "dob", "guardian_contact"]
# Plain column for each field; the two sensitive ones are encrypted at rest.
STUDENT_COLUMNS = {
    "full_name": "full_name", "class_name": "class_name", "section": "section",
    "roll_number": "roll_number", "dob": "dob_enc", "guardian_contact": "guardian_contact_enc",
}
VALID_STATUSES = ("Present", "Absent", "Late")
INITIAL_HLC = "000000000000000:000000:init"

# Results returned by apply_* functions
APPLIED, CONFLICT, IGNORED = "applied", "conflict", "ignored"


def _remove_student(conn, student_id: str, now: int):
    """
    Tombstone a student. The row is kept (so a stale update/create from a device that has not
    heard about the removal cannot resurrect it) but every personal detail is wiped, together
    with the student's attendance, conflicts and the PII stored in earlier log entries.
    """
    exists = conn.execute("SELECT 1 FROM students WHERE student_id = ?", (student_id,)).fetchone()
    if exists:
        conn.execute("""
            UPDATE students SET full_name = '', class_name = '', section = '', roll_number = '',
                dob_enc = '', guardian_contact_enc = '', field_hlcs_json = '{}',
                is_deleted = 1, deleted_at = ?, updated_at = ?
            WHERE student_id = ?
        """, (now, now, student_id))
    else:
        conn.execute("""
            INSERT INTO students (student_id, full_name, class_name, section, roll_number,
                dob_enc, guardian_contact_enc, field_hlcs_json, is_deleted, deleted_at, created_at, updated_at)
            VALUES (?, '', '', '', '', '', '', '{}', 1, ?, ?, ?)
        """, (student_id, now, now, now))
    conn.execute("DELETE FROM attendance WHERE student_id = ?", (student_id,))
    conn.execute("DELETE FROM conflicts WHERE student_id = ?", (student_id,))
    # Earlier create/update operations carry the plaintext DOB / guardian contact: scrub them.
    conn.execute(
        "UPDATE operations_log SET payload_json = ? WHERE entity_type = 'student' AND entity_id = ? AND operation_type != 'delete'",
        (json.dumps({"redacted": True}), student_id)
    )


def apply_student_operation(conn, op: dict) -> str:
    """
    Domain-Aware CRDT Merging for Student Records:
    - Independent student UUIDs merge automatically (Set-Union).
    - Field-level updates merge automatically per field using HLC comparison
      (so Device A updating 'section' and Device B updating 'guardian_contact' both survive).
    - A 'delete' operation tombstones the student; later stale ops for it are ignored.
    """
    payload = op["payload"] or {}
    student_id = op["entity_id"]
    op_hlc = op["hlc"]
    now = int(time.time() * 1000)

    existing = conn.execute(
        "SELECT * FROM students WHERE student_id = ?", (student_id,)
    ).fetchone()

    if op["operation_type"] == "delete":
        if existing and existing["is_deleted"]:
            return APPLIED
        _remove_student(conn, student_id, now)
        return APPLIED

    if existing and existing["is_deleted"]:
        return IGNORED  # stale op for a student that has been removed

    if not existing:
        field_hlcs = {k: op_hlc for k in STUDENT_FIELDS if k in payload}
        conn.execute("""
            INSERT INTO students (
                student_id, full_name, class_name, section, roll_number,
                dob_enc, guardian_contact_enc, field_hlcs_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            student_id,
            payload.get("full_name", ""),
            payload.get("class_name", ""),
            payload.get("section", ""),
            payload.get("roll_number", ""),
            encryptor.encrypt(payload.get("dob", "")),
            encryptor.encrypt(payload.get("guardian_contact", "")),
            json.dumps(field_hlcs),
            payload.get("created_at", now),
            now
        ))
        return APPLIED

    field_hlcs = json.loads(existing["field_hlcs_json"] or "{}")
    # Only touch the columns that actually win the HLC comparison. We never decrypt (or
    # re-encrypt) fields that are not being changed, so an update cannot fail - or silently
    # destroy data - just because an old ciphertext is unreadable.
    sets, params = [], []
    for field in STUDENT_FIELDS:
        if field in payload and payload[field] is not None:
            prev_hlc = field_hlcs.get(field, INITIAL_HLC)
            if HybridLogicalClock.compare(op_hlc, prev_hlc) >= 0:
                value = payload[field]
                if field in ("dob", "guardian_contact"):
                    value = encryptor.encrypt(value)
                sets.append(f"{STUDENT_COLUMNS[field]} = ?")
                params.append(value)
                field_hlcs[field] = op_hlc

    if sets:
        conn.execute(
            f"UPDATE students SET {', '.join(sets)}, field_hlcs_json = ?, updated_at = ? WHERE student_id = ?",
            (*params, json.dumps(field_hlcs), now, student_id)
        )
    return APPLIED


def _is_informed(base_hlc, existing_hlc) -> bool:
    """True when the writer had already seen the server's current version when it made its edit."""
    if not base_hlc:
        return False
    try:
        return HybridLogicalClock.compare(base_hlc, existing_hlc) >= 0
    except ValueError:
        return False


def apply_attendance_operation(conn, op: dict) -> str:
    """
    Domain-Aware Conflict Detection for Attendance.
    Logical key is (student_id, attendance_date).

    A conflict means two *concurrent* edits: the incoming edit was made WITHOUT knowledge of the
    version currently on the server. The client therefore sends `base_hlc` (the HLC of the
    record it saw when it made the edit):
      - no record yet                           -> insert
      - same status                             -> compatible, nothing to decide
      - same device editing its own entry       -> sequential overwrite
      - base_hlc >= server version's HLC        -> an informed correction, NOT a conflict
      - otherwise (blind / stale edit, different status, different device) -> explicit conflict
    """
    payload = op["payload"]
    student_id = payload.get("student_id")
    attendance_date = payload.get("attendance_date")
    incoming_status = payload.get("status")
    if not student_id or not attendance_date or incoming_status not in VALID_STATUSES:
        return IGNORED

    tomb = conn.execute(
        "SELECT 1 FROM students WHERE student_id = ? AND is_deleted = 1", (student_id,)
    ).fetchone()
    if tomb:
        return IGNORED

    incoming_teacher = payload.get("teacher_id") or op["user_id"]
    incoming_device = op["device_id"]
    incoming_hlc = op["hlc"]
    base_hlc = payload.get("base_hlc")
    now = int(time.time() * 1000)

    existing = conn.execute(
        "SELECT * FROM attendance WHERE student_id = ? AND attendance_date = ?",
        (student_id, attendance_date)
    ).fetchone()

    if not existing:
        conn.execute("""
            INSERT INTO attendance (
                attendance_id, student_id, attendance_date, status,
                teacher_id, device_id, hlc, has_conflict, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """, (
            op["entity_id"], student_id, attendance_date, incoming_status,
            incoming_teacher, incoming_device, incoming_hlc,
            payload.get("created_at", now), now
        ))
        return APPLIED

    open_conflict = conn.execute("""
        SELECT * FROM conflicts WHERE student_id = ? AND attendance_date = ? AND status = 'unresolved'
        ORDER BY created_at DESC LIMIT 1
    """, (student_id, attendance_date)).fetchone()
    party_of_open_conflict = bool(open_conflict) and incoming_device in (
        open_conflict["incoming_device_id"], open_conflict["existing_device_id"])

    # Same status = convergent / compatible
    if existing["status"] == incoming_status and not party_of_open_conflict:
        if HybridLogicalClock.compare(incoming_hlc, existing["hlc"]) > 0:
            conn.execute("""
                UPDATE attendance SET hlc = ?, updated_at = ?
                WHERE student_id = ? AND attendance_date = ?
            """, (incoming_hlc, now, student_id, attendance_date))
        return APPLIED

    if open_conflict:
        # A device that is part of an open conflict and simply changes its mind updates ITS side
        # of that conflict instead of piling up another one.
        if incoming_device == open_conflict["incoming_device_id"]:
            if HybridLogicalClock.compare(incoming_hlc, open_conflict["incoming_hlc"]) > 0:
                conn.execute("""
                    UPDATE conflicts SET incoming_op_id = ?, incoming_value = ?, incoming_teacher_id = ?, incoming_hlc = ?
                    WHERE conflict_id = ?
                """, (op["operation_id"], incoming_status, incoming_teacher, incoming_hlc, open_conflict["conflict_id"]))
                if incoming_status == open_conflict["existing_value"]:
                    _auto_resolve(conn, open_conflict, incoming_status, now)
            return APPLIED
        if incoming_device == open_conflict["existing_device_id"]:
            if HybridLogicalClock.compare(incoming_hlc, open_conflict["existing_hlc"]) > 0:
                conn.execute("""
                    UPDATE conflicts SET existing_op_id = ?, existing_value = ?, existing_teacher_id = ?, existing_hlc = ?
                    WHERE conflict_id = ?
                """, (op["operation_id"], incoming_status, incoming_teacher, incoming_hlc, open_conflict["conflict_id"]))
                conn.execute("""
                    UPDATE attendance SET status = ?, teacher_id = ?, hlc = ?, updated_at = ?
                    WHERE student_id = ? AND attendance_date = ?
                """, (incoming_status, incoming_teacher, incoming_hlc, now, student_id, attendance_date))
                if incoming_status == open_conflict["incoming_value"]:
                    _auto_resolve(conn, open_conflict, incoming_status, now)
            return APPLIED
    else:
        # Same device intentionally changing its own previous entry sequentially
        if existing["device_id"] == incoming_device or _is_informed(base_hlc, existing["hlc"]):
            if HybridLogicalClock.compare(incoming_hlc, existing["hlc"]) > 0 or existing["device_id"] != incoming_device:
                conn.execute("""
                    UPDATE attendance SET status = ?, teacher_id = ?, device_id = ?, hlc = ?, updated_at = ?
                    WHERE student_id = ? AND attendance_date = ?
                """, (incoming_status, incoming_teacher, incoming_device, incoming_hlc, now, student_id, attendance_date))
            return APPLIED

    # Incompatible concurrent/multi-device attendance statuses -> Explicit Conflict!
    conflict_id = f"conf-{student_id}-{attendance_date}-{uuid.uuid4().hex[:6]}"
    orig_op = conn.execute(
        "SELECT operation_id FROM operations_log WHERE entity_type = 'attendance' AND entity_id = ? ORDER BY server_seq DESC LIMIT 1",
        (existing["attendance_id"],)
    ).fetchone()
    existing_op_id = orig_op["operation_id"] if orig_op else "op-initial"

    conn.execute("""
        INSERT INTO conflicts (
            conflict_id, entity_type, entity_id, student_id, attendance_date,
            existing_op_id, existing_value, existing_teacher_id, existing_device_id, existing_hlc,
            incoming_op_id, incoming_value, incoming_teacher_id, incoming_device_id, incoming_hlc,
            status, created_at
        ) VALUES (?, 'attendance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)
    """, (
        conflict_id, existing["attendance_id"], student_id, attendance_date,
        existing_op_id, existing["status"], existing["teacher_id"], existing["device_id"], existing["hlc"],
        op["operation_id"], incoming_status, incoming_teacher, incoming_device, incoming_hlc,
        now
    ))
    conn.execute(
        "UPDATE attendance SET has_conflict = 1, updated_at = ? WHERE student_id = ? AND attendance_date = ?",
        (now, student_id, attendance_date)
    )
    return CONFLICT


def _auto_resolve(conn, conflict, value: str, now: int):
    """Both sides of an open conflict now agree: close it without needing an administrator."""
    conn.execute("""
        UPDATE conflicts SET status = 'resolved', resolved_value = ?, resolved_by = 'system (devices agreed)', resolved_at = ?
        WHERE conflict_id = ?
    """, (value, now, conflict["conflict_id"]))
    remaining = conn.execute("""
        SELECT COUNT(*) AS c FROM conflicts WHERE student_id = ? AND attendance_date = ? AND status = 'unresolved'
    """, (conflict["student_id"], conflict["attendance_date"])).fetchone()["c"]
    conn.execute(
        "UPDATE attendance SET has_conflict = ?, updated_at = ? WHERE student_id = ? AND attendance_date = ?",
        (1 if remaining else 0, now, conflict["student_id"], conflict["attendance_date"])
    )


def process_single_operation(conn, op: dict) -> dict:
    """
    Processes a single operation idempotently.
    Returns {'operation_id', 'status', 'duplicate': bool, 'conflict': bool, 'ignored': bool}
    """
    op_id = op["operation_id"]
    existing_op = conn.execute(
        "SELECT server_seq FROM operations_log WHERE operation_id = ?", (op_id,)
    ).fetchone()

    if existing_op:
        # Idempotent replay: already processed! Return success acknowledgement without re-applying.
        return {"operation_id": op_id, "status": "acknowledged", "duplicate": True, "conflict": False, "ignored": False}

    # Update server Hybrid Logical Clock
    server_clock.update(op["hlc"])
    now = int(time.time() * 1000)

    outcome = APPLIED
    if op["entity_type"] == "student":
        outcome = apply_student_operation(conn, op)
    elif op["entity_type"] == "attendance":
        outcome = apply_attendance_operation(conn, op)

    if outcome == IGNORED:
        # Acknowledged so the client stops retrying it, but NOT logged: other devices must not
        # receive operations about students that no longer exist / malformed operations.
        return {"operation_id": op_id, "status": "acknowledged", "duplicate": False, "conflict": False, "ignored": True}

    conn.execute("""
        INSERT INTO operations_log (
            operation_id, entity_type, entity_id, operation_type,
            payload_json, device_id, user_id, hlc, created_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        op_id,
        op["entity_type"],
        op["entity_id"],
        op["operation_type"],
        json.dumps(op["payload"]),
        op["device_id"],
        op["user_id"],
        op["hlc"],
        op.get("created_at", now),
        now
    ))

    return {"operation_id": op_id, "status": "acknowledged", "duplicate": False,
            "conflict": outcome == CONFLICT, "ignored": False}


@sync_bp.route("/api/sync", methods=["POST"])
def delta_sync():
    """
    Resumable Delta Synchronisation Endpoint:
    1. Receives a batch of pending client operations.
    2. Applies each operation idempotently and collects acknowledgements.
    3. Queries remote operations since `since_seq` (up to `batch_size`).
    4. Returns delta operations, new `server_cursor`, and active conflicts.
    """
    start_time = time.perf_counter()
    raw_bytes = len(request.get_data() or b"")
    data = request.get_json(silent=True) or {}

    device_id = data.get("device_id", "unknown-device")
    user_id = session.get("user_id", data.get("user_id", "usr-teacher-1"))
    since_seq = int(data.get("since_seq", 0))
    batch_size = int(data.get("batch_size", Config.SYNC_BATCH_SIZE))
    incoming_ops = data.get("operations", [])
    is_retry = bool(data.get("is_retry", False))

    # Optional fault injection for testing interrupted sync mid-batch
    fail_after_n = data.get("simulate_interrupt_after")

    conn = get_db_connection()
    acks = []
    duplicates_prevented = 0
    conflicts_created = 0
    ops_applied = 0

    try:
        for idx, op in enumerate(incoming_ops):
            if fail_after_n is not None and idx >= int(fail_after_n):
                conn.commit()  # Commit partial progress up to interruption point
                conn.close()
                return jsonify({
                    "error": "Simulated mid-batch network drop",
                    "acknowledged_ids": list(acks)
                }), 503

            res = process_single_operation(conn, op)
            acks.append(res["operation_id"])
            if res["duplicate"]:
                duplicates_prevented += 1
            elif not res["ignored"]:
                ops_applied += 1
            if res["conflict"]:
                conflicts_created += 1

        # Fetch remote operations that occurred after `since_seq`
        remote_rows = conn.execute("""
            SELECT * FROM operations_log
            WHERE server_seq > ?
            ORDER BY server_seq ASC
            LIMIT ?
        """, (since_seq, batch_size)).fetchall()

        remote_ops = []
        new_cursor = since_seq
        for row in remote_rows:
            new_cursor = max(new_cursor, row["server_seq"])
            payload = json.loads(row["payload_json"])
            remote_ops.append({
                "server_seq": row["server_seq"],
                "operation_id": row["operation_id"],
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "operation_type": row["operation_type"],
                "payload": payload,
                "device_id": row["device_id"],
                "user_id": row["user_id"],
                "hlc": row["hlc"],
                "created_at": row["created_at"]
            })

        # Check if there are still more operations beyond this batch
        max_seq_row = conn.execute("SELECT COALESCE(MAX(server_seq), 0) as max_seq FROM operations_log").fetchone()
        has_more = new_cursor < max_seq_row["max_seq"]

        # Fetch all current conflicts so clients stay updated
        conflict_rows = conn.execute("""
            SELECT c.*, s.full_name as student_name, s.class_name, s.roll_number
            FROM conflicts c
            LEFT JOIN students s ON c.student_id = s.student_id
            ORDER BY c.created_at DESC
        """).fetchall()
        conflicts = [dict(r) for r in conflict_rows]

        now = int(time.time() * 1000)
        conn.execute("""
            INSERT INTO devices (device_id, user_id, last_seen_at, last_sync_seq)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                user_id = excluded.user_id,
                last_seen_at = excluded.last_seen_at,
                last_sync_seq = excluded.last_sync_seq
        """, (device_id, user_id, now, new_cursor))

        response_payload = {
            "acknowledged_ids": acks,
            "remote_operations": remote_ops,
            "server_cursor": new_cursor,
            "has_more": has_more,
            "conflicts": conflicts,
            "server_hlc": server_clock.now(),
            "stats": {
                "ops_received": len(incoming_ops),
                "ops_applied": ops_applied,
                "duplicates_prevented": duplicates_prevented,
                "conflicts_created": conflicts_created
            }
        }

        resp_bytes = len(json.dumps(response_payload).encode("utf-8"))
        total_bytes = raw_bytes + resp_bytes
        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)

        conn.execute("""
            INSERT INTO sync_metrics (
                device_id, ops_received, ops_applied, duplicates_prevented,
                conflicts_created, bytes_transferred, latency_ms, interrupted_recovery, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            device_id, len(incoming_ops), ops_applied, duplicates_prevented,
            conflicts_created, total_bytes, latency_ms, 1 if is_retry else 0, now
        ))

        conn.commit()
        conn.close()
        return jsonify(response_payload)

    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({"error": str(e)}), 500


@sync_bp.route("/api/conflicts/resolve", methods=["POST"])
def resolve_conflict():
    """
    Administrator Conflict Resolution Endpoint:
    Records the chosen value, administrator ID, and timestamp, updates the canonical
    attendance record, and appends a resolution operation to operations_log so all
    devices receive the resolution via delta sync.
    """
    data = request.get_json(silent=True) or {}
    # The signed-in session is the ONLY source of truth for the caller's role. (Previously a
    # `role` field in the request body was accepted as a fallback, which is both insecure and
    # made the outcome depend on whichever account last logged in on the same browser.)
    if "user_id" not in session:
        return jsonify({"error": "Your session has expired. Please sign in again as an administrator.",
                        "code": "not_authenticated"}), 401
    if session.get("role") != "admin":
        return jsonify({
            "error": f"Only administrators can resolve conflicts. This browser is currently signed in as "
                     f"'{session.get('username')}' ({session.get('role')}). Sign out and sign in as admin.",
            "code": "not_admin"
        }), 403

    conflict_id = data.get("conflict_id")
    chosen_value = data.get("resolved_value")
    admin_user = session.get("username", "admin")
    device_id = data.get("device_id", "admin-console")

    if chosen_value not in ("Present", "Absent", "Late"):
        return jsonify({"error": "Invalid attendance status"}), 400

    conn = get_db_connection()
    conflict = conn.execute("SELECT * FROM conflicts WHERE conflict_id = ?", (conflict_id,)).fetchone()
    if not conflict:
        conn.close()
        return jsonify({"error": "Conflict not found"}), 404
    if conflict["status"] == "resolved":
        conn.close()
        return jsonify({"error": "This conflict has already been resolved."}), 409

    now = int(time.time() * 1000)
    res_hlc = server_clock.now()

    # 1. Mark every open conflict for this student+date as resolved (the administrator picked the
    #    final value for that day) and preserve the full history.
    conn.execute("""
        UPDATE conflicts SET
            status = 'resolved',
            resolved_value = ?,
            resolved_by = ?,
            resolved_at = ?
        WHERE student_id = ? AND attendance_date = ? AND status = 'unresolved'
    """, (chosen_value, admin_user, now, conflict["student_id"], conflict["attendance_date"]))
    # 2. Nothing can remain unresolved for this key now
    remaining = 0

    # 3. Update canonical attendance record
    conn.execute("""
        UPDATE attendance SET
            status = ?,
            teacher_id = ?,
            device_id = ?,
            hlc = ?,
            has_conflict = ?,
            updated_at = ?
        WHERE student_id = ? AND attendance_date = ?
    """, (
        chosen_value, admin_user, device_id, res_hlc,
        1 if remaining > 0 else 0, now,
        conflict["student_id"], conflict["attendance_date"]
    ))

    # 4. Emit a resolution operation into operations_log so all devices sync the resolution
    res_op_id = f"op-resolve-{conflict_id}-{uuid.uuid4().hex[:6]}"
    res_payload = {
        "attendance_id": conflict["entity_id"],
        "student_id": conflict["student_id"],
        "attendance_date": conflict["attendance_date"],
        "status": chosen_value,
        "teacher_id": admin_user,
        "resolved_conflict_id": conflict_id,
        "created_at": now
    }
    conn.execute("""
        INSERT INTO operations_log (
            operation_id, entity_type, entity_id, operation_type,
            payload_json, device_id, user_id, hlc, created_at, received_at
        ) VALUES (?, 'attendance', ?, 'resolve_conflict', ?, ?, ?, ?, ?, ?)
    """, (
        res_op_id, conflict["entity_id"], json.dumps(res_payload),
        device_id, admin_user, res_hlc, now, now
    ))

    conn.commit()
    conn.close()
    return jsonify({
        "status": "resolved",
        "conflict_id": conflict_id,
        "resolved_value": chosen_value,
        "resolved_by": admin_user,
        "resolved_at": now,
        "operation_id": res_op_id
    })
