import time
import sqlite3
from config import Config
from backend.clock import HybridLogicalClock

def login(client, username, password, device_id="dev-login"):
    res = client.post("/api/auth/login", json={"username": username, "password": password, "device_id": device_id})
    assert res.status_code == 200
    return res.get_json()


def student_op(op_id, sid, device, hlc, op_type="create", **payload):
    return {
        "operation_id": op_id, "entity_type": "student", "entity_id": sid, "operation_type": op_type,
        "payload": {"student_id": sid, **payload}, "device_id": device, "user_id": "teacher1", "hlc": hlc,
    }


def att_op(op_id, sid, date, status, device, hlc, base_hlc=None):
    return {
        "operation_id": op_id, "entity_type": "attendance", "entity_id": f"att-{op_id}",
        "operation_type": "mark",
        "payload": {"attendance_id": f"att-{op_id}", "student_id": sid, "attendance_date": date,
                    "status": status, "teacher_id": "teacher1", "base_hlc": base_hlc},
        "device_id": device, "user_id": "teacher1", "hlc": hlc,
    }


def sync(client, device, ops, since=0, **extra):
    return client.post("/api/sync", json={"device_id": device, "since_seq": since, "operations": ops, **extra}).get_json()


def test_1_auth_and_offline_operation_sync(client):
    """Test 1: Login & offline-created student + attendance operation synchronisation."""
    res = client.post("/api/auth/login", json={
        "username": "teacher1",
        "password": "teacher123",
        "device_id": "dev-test-1"
    })
    assert res.status_code == 200
    data = res.get_json()
    assert data["role"] == "teacher"
    assert "crypto_token" in data

    hlc = HybridLogicalClock("dev-test-1")
    op_stu = {
        "operation_id": "op-stu-1",
        "entity_type": "student",
        "entity_id": "stu-uuid-101",
        "operation_type": "create",
        "payload": {
            "student_id": "stu-uuid-101",
            "full_name": "Aarav Kumar",
            "class_name": "7",
            "section": "A",
            "roll_number": "1",
            "dob": "2013-04-10",
            "guardian_contact": "9988776655"
        },
        "device_id": "dev-test-1",
        "user_id": "teacher1",
        "hlc": hlc.now()
    }
    sync_res = client.post("/api/sync", json={
        "device_id": "dev-test-1",
        "since_seq": 0,
        "operations": [op_stu]
    }).get_json()
    assert "op-stu-1" in sync_res["acknowledged_ids"]
    assert sync_res["stats"]["ops_applied"] == 1


def test_2_independent_changes_and_field_crdt_merge(client):
    """Test 2: Device A and Device B make independent student & field edits; both survive."""
    hlc_a = HybridLogicalClock("dev-A")
    hlc_b = HybridLogicalClock("dev-B")

    op_create = {
        "operation_id": "op-create-rahul",
        "entity_type": "student",
        "entity_id": "stu-rahul",
        "operation_type": "create",
        "payload": {
            "student_id": "stu-rahul",
            "full_name": "Rahul Verma",
            "class_name": "8",
            "section": "A",
            "roll_number": "10",
            "dob": "2012-01-01",
            "guardian_contact": "9000000001"
        },
        "device_id": "dev-A",
        "user_id": "teacher1",
        "hlc": hlc_a.now()
    }
    client.post("/api/sync", json={"device_id": "dev-A", "since_seq": 0, "operations": [op_create]})

    # Device A updates section to 'B'; Device B updates guardian_contact to '9999999999'
    op_update_a = {
        "operation_id": "op-upd-section",
        "entity_type": "student",
        "entity_id": "stu-rahul",
        "operation_type": "update",
        "payload": {"section": "B"},
        "device_id": "dev-A",
        "user_id": "teacher1",
        "hlc": hlc_a.now()
    }
    op_update_b = {
        "operation_id": "op-upd-contact",
        "entity_type": "student",
        "entity_id": "stu-rahul",
        "operation_type": "update",
        "payload": {"guardian_contact": "9999999999"},
        "device_id": "dev-B",
        "user_id": "teacher2",
        "hlc": hlc_b.now()
    }
    client.post("/api/sync", json={"device_id": "dev-A", "since_seq": 0, "operations": [op_update_a]})
    client.post("/api/sync", json={"device_id": "dev-B", "since_seq": 0, "operations": [op_update_b]})

    snap = client.get("/api/recovery/snapshot").get_json()
    rahul = next(s for s in snap["students"] if s["student_id"] == "stu-rahul")
    assert rahul["section"] == "B"
    assert rahul["guardian_contact"] == "9999999999"


def test_3_and_4_conflicting_attendance_and_admin_resolution(client):
    """Test 3 & 4: Device A marks Rahul Present, Device B marks Rahul Absent; conflict is created and resolved by Admin."""
    hlc_a = HybridLogicalClock("dev-A")
    hlc_b = HybridLogicalClock("dev-B")

    op_a = {
        "operation_id": "op-att-present",
        "entity_type": "attendance",
        "entity_id": "att-1",
        "operation_type": "mark",
        "payload": {
            "attendance_id": "att-1",
            "student_id": "stu-rahul",
            "attendance_date": "2026-10-31",
            "status": "Present",
            "teacher_id": "teacher1"
        },
        "device_id": "dev-A",
        "user_id": "teacher1",
        "hlc": hlc_a.now()
    }
    op_b = {
        "operation_id": "op-att-absent",
        "entity_type": "attendance",
        "entity_id": "att-2",
        "operation_type": "mark",
        "payload": {
            "attendance_id": "att-2",
            "student_id": "stu-rahul",
            "attendance_date": "2026-10-31",
            "status": "Absent",
            "teacher_id": "teacher2"
        },
        "device_id": "dev-B",
        "user_id": "teacher2",
        "hlc": hlc_b.now()
    }

    client.post("/api/sync", json={"device_id": "dev-A", "since_seq": 0, "operations": [op_a]})
    res_b = client.post("/api/sync", json={"device_id": "dev-B", "since_seq": 0, "operations": [op_b]}).get_json()

    assert res_b["stats"]["conflicts_created"] == 1
    conflicts = res_b["conflicts"]
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["existing_value"] == "Present"
    assert c["incoming_value"] == "Absent"
    assert c["status"] == "unresolved"

    # Test 4: Admin resolves conflict (the role comes from the signed-in session, not the body)
    login(client, "admin", "admin123")
    res_resolve = client.post("/api/conflicts/resolve", json={
        "conflict_id": c["conflict_id"],
        "resolved_value": "Absent"
    }).get_json()
    assert res_resolve["status"] == "resolved"
    assert res_resolve["resolved_value"] == "Absent"

    snap = client.get("/api/recovery/snapshot").get_json()
    att = next(a for a in snap["attendance"] if a["student_id"] == "stu-rahul")
    assert att["status"] == "Absent"
    assert att["has_conflict"] == 0


def test_5_idempotent_duplicate_operation_replay(client):
    """Test 5: Sending the exact same operation_id multiple times processes it only once."""
    hlc = HybridLogicalClock("dev-dup")
    op = {
        "operation_id": "op-idempotent-123",
        "entity_type": "student",
        "entity_id": "stu-idem",
        "operation_type": "create",
        "payload": {
            "student_id": "stu-idem",
            "full_name": "Meera Joshi",
            "class_name": "6",
            "section": "A",
            "roll_number": "22"
        },
        "device_id": "dev-dup",
        "user_id": "teacher1",
        "hlc": hlc.now()
    }
    r1 = client.post("/api/sync", json={"device_id": "dev-dup", "since_seq": 0, "operations": [op]}).get_json()
    r2 = client.post("/api/sync", json={"device_id": "dev-dup", "since_seq": 0, "operations": [op]}).get_json()
    r3 = client.post("/api/sync", json={"device_id": "dev-dup", "since_seq": 0, "operations": [op]}).get_json()

    assert r1["stats"]["ops_applied"] == 1
    assert r2["stats"]["ops_applied"] == 0 and r2["stats"]["duplicates_prevented"] == 1
    assert r3["stats"]["ops_applied"] == 0 and r3["stats"]["duplicates_prevented"] == 1

    snap = client.get("/api/recovery/snapshot").get_json()
    assert len([s for s in snap["students"] if s["student_id"] == "stu-idem"]) == 1


def test_6_interrupted_sync_and_resumable_batch(client):
    """Test 6: Mid-batch network interruption preserves acknowledged ops and safely resumes remaining ops."""
    hlc = HybridLogicalClock("dev-int")
    ops = [
        {
            "operation_id": f"op-batch-{i}",
            "entity_type": "student",
            "entity_id": f"stu-batch-{i}",
            "operation_type": "create",
            "payload": {
                "student_id": f"stu-batch-{i}",
                "full_name": f"Student {i}",
                "class_name": "5",
                "section": "A",
                "roll_number": str(i)
            },
            "device_id": "dev-int",
            "user_id": "teacher1",
            "hlc": hlc.now()
        }
        for i in range(3)
    ]

    # Simulate drop after 1 operation
    interrupted = client.post("/api/sync", json={
        "device_id": "dev-int",
        "since_seq": 0,
        "operations": ops,
        "simulate_interrupt_after": 1
    })
    assert interrupted.status_code == 503
    int_data = interrupted.get_json()
    assert int_data["acknowledged_ids"] == ["op-batch-0"]

    # Retry sending all 3 (or remaining 2)
    resumed = client.post("/api/sync", json={
        "device_id": "dev-int",
        "since_seq": 0,
        "operations": ops,
        "is_retry": True
    }).get_json()
    assert len(resumed["acknowledged_ids"]) == 3
    assert resumed["stats"]["ops_applied"] == 2
    assert resumed["stats"]["duplicates_prevented"] == 1


def test_7_clock_skew_hlc_ordering():
    """Test 7: Verify Hybrid Logical Clock maintains causal ordering even when Device B's wall clock is 1 hour behind."""
    clock_fast = HybridLogicalClock("device-fast")
    clock_slow = HybridLogicalClock("device-slow")

    base_ms = int(time.time() * 1000)
    t_event_1 = clock_fast.now(physical_time_ms=base_ms + 3600_000)  # +1 hour ahead
    t_event_2 = clock_slow.update(t_event_1, physical_time_ms=base_ms - 3600_000)  # -1 hour behind

    assert HybridLogicalClock.compare(t_event_2, t_event_1) > 0


def test_8_9_10_recovery_encryption_and_regression(client):
    """Tests 8, 9 & 10: Verify encryption at rest in SQLite, device snapshot recovery, and post-sync regression."""
    hlc = HybridLogicalClock("dev-sec")
    op = {
        "operation_id": "op-sec-1",
        "entity_type": "student",
        "entity_id": "stu-sec-1",
        "operation_type": "create",
        "payload": {
            "student_id": "stu-sec-1",
            "full_name": "Kabir Bedi",
            "class_name": "9",
            "section": "A",
            "roll_number": "55",
            "dob": "2011-11-11",
            "guardian_contact": "9811122233"
        },
        "device_id": "dev-sec",
        "user_id": "teacher1",
        "hlc": hlc.now()
    }
    client.post("/api/sync", json={"device_id": "dev-sec", "since_seq": 0, "operations": [op]})

    # Test 9: Inspect raw SQLite file to verify sensitive fields are not stored as plaintext
    conn = sqlite3.connect(Config.DATABASE_PATH)
    row = conn.execute("SELECT dob_enc, guardian_contact_enc FROM students WHERE student_id = 'stu-sec-1'").fetchone()
    conn.close()
    assert row[0].startswith("ENCv1:") and "2011-11-11" not in row[0]
    assert row[1].startswith("ENCv1:") and "9811122233" not in row[1]

    # Test 8: Replacement device snapshot recovery
    snap = client.get("/api/recovery/snapshot").get_json()
    kabir = next(s for s in snap["students"] if s["student_id"] == "stu-sec-1")
    assert kabir["guardian_contact"] == "9811122233"

    # Test 10: Regression - mark attendance after sync
    op_att = {
        "operation_id": "op-reg-att-1",
        "entity_type": "attendance",
        "entity_id": "att-reg-1",
        "operation_type": "mark",
        "payload": {
            "attendance_id": "att-reg-1",
            "student_id": "stu-sec-1",
            "attendance_date": "2026-10-31",
            "status": "Late",
            "teacher_id": "teacher1"
        },
        "device_id": "dev-sec",
        "user_id": "teacher1",
        "hlc": hlc.now()
    }
    res_reg = client.post("/api/sync", json={"device_id": "dev-sec", "since_seq": snap["server_cursor"], "operations": [op_att]}).get_json()
    assert res_reg["stats"]["ops_applied"] == 1


# ---------------------------------------------------------------------------------------------
# Regression tests for the bug-fix round
# ---------------------------------------------------------------------------------------------

def test_conflict_not_raised_when_second_device_saw_the_first_value(client):
    """A teacher on Device B who had ALREADY synced Device A's 'Present' and then corrects it to
    'Absent' is making an informed edit. That is not a conflict (it used to be flagged as one)."""
    a, b = HybridLogicalClock("dev-A"), HybridLogicalClock("dev-B")
    h1 = a.now()
    sync(client, "dev-A", [att_op("o1", "stu-x", "2026-10-31", "Present", "dev-A", h1)])
    b.update(h1)  # device B pulled A's record, so its clock moved past h1
    r = sync(client, "dev-B", [att_op("o2", "stu-x", "2026-10-31", "Absent", "dev-B", b.now(), base_hlc=h1)])
    assert r["stats"]["conflicts_created"] == 0
    assert r["conflicts"] == []
    snap = client.get("/api/recovery/snapshot").get_json()
    att = next(x for x in snap["attendance"] if x["student_id"] == "stu-x")
    assert att["status"] == "Absent" and att["has_conflict"] == 0


def test_conflict_raised_for_stale_or_blind_edit(client):
    """Device B edits without having seen A's newer version (stale base_hlc) -> real conflict."""
    a, b = HybridLogicalClock("dev-A"), HybridLogicalClock("dev-B")
    h_b_old = b.now()                       # B saw an old version ...
    sync(client, "dev-A", [att_op("o1", "stu-y", "2026-10-31", "Present", "dev-A", a.now())])
    sync(client, "dev-A", [att_op("o1b", "stu-y", "2026-10-31", "Late", "dev-A", a.now())])  # ... A moved on
    r = sync(client, "dev-B", [att_op("o2", "stu-y", "2026-10-31", "Absent", "dev-B", b.now(), base_hlc=h_b_old)])
    assert r["stats"]["conflicts_created"] == 1
    assert r["conflicts"][0]["existing_value"] == "Late" and r["conflicts"][0]["incoming_value"] == "Absent"


def test_conflict_not_raised_for_same_value_or_same_device_revision(client):
    a = HybridLogicalClock("dev-A")
    sync(client, "dev-A", [att_op("o1", "stu-z", "2026-10-31", "Present", "dev-A", a.now())])
    r = sync(client, "dev-A", [att_op("o2", "stu-z", "2026-10-31", "Absent", "dev-A", a.now())])
    assert r["stats"]["conflicts_created"] == 0
    r = sync(client, "dev-B", [att_op("o3", "stu-z", "2026-10-31", "Absent", "dev-B", HybridLogicalClock("dev-B").now())])
    assert r["stats"]["conflicts_created"] == 0   # both devices agree


def test_device_changing_its_mind_updates_open_conflict_instead_of_duplicating(client):
    a, b = HybridLogicalClock("dev-A"), HybridLogicalClock("dev-B")
    sync(client, "dev-A", [att_op("o1", "stu-m", "2026-10-31", "Present", "dev-A", a.now())])
    sync(client, "dev-B", [att_op("o2", "stu-m", "2026-10-31", "Absent", "dev-B", b.now())])
    r = sync(client, "dev-B", [att_op("o3", "stu-m", "2026-10-31", "Late", "dev-B", b.now())])
    open_c = [c for c in r["conflicts"] if c["status"] == "unresolved"]
    assert len(open_c) == 1 and open_c[0]["incoming_value"] == "Late"
    # B now agrees with A -> the conflict closes by itself
    r = sync(client, "dev-B", [att_op("o4", "stu-m", "2026-10-31", "Present", "dev-B", b.now())])
    assert [c["status"] for c in r["conflicts"]] == ["resolved"]


def test_admin_resolution_requires_admin_session_and_closes_all_open_conflicts(client):
    a, b, c3 = HybridLogicalClock("dev-A"), HybridLogicalClock("dev-B"), HybridLogicalClock("dev-C")
    sync(client, "dev-A", [att_op("o1", "stu-r", "2026-10-31", "Present", "dev-A", a.now())])
    sync(client, "dev-B", [att_op("o2", "stu-r", "2026-10-31", "Absent", "dev-B", b.now())])
    res = sync(client, "dev-C", [att_op("o3", "stu-r", "2026-10-31", "Late", "dev-C", c3.now())])
    open_ids = [c["conflict_id"] for c in res["conflicts"] if c["status"] == "unresolved"]
    assert len(open_ids) == 2

    # not signed in -> 401, a *claimed* role in the body is ignored
    r = client.post("/api/conflicts/resolve", json={"conflict_id": open_ids[0], "resolved_value": "Present", "role": "admin"})
    assert r.status_code == 401
    # signed in as a teacher -> 403 with an explanatory message
    login(client, "teacher1", "teacher123")
    r = client.post("/api/conflicts/resolve", json={"conflict_id": open_ids[0], "resolved_value": "Present", "role": "admin"})
    assert r.status_code == 403 and "teacher1" in r.get_json()["error"]
    # admin -> works, and every open conflict for that student/date is closed
    login(client, "admin", "admin123")
    r = client.post("/api/conflicts/resolve", json={"conflict_id": open_ids[0], "resolved_value": "Late"})
    assert r.status_code == 200
    again = sync(client, "dev-A", [])
    assert all(c["status"] == "resolved" for c in again["conflicts"])
    snap = client.get("/api/recovery/snapshot").get_json()
    att = next(x for x in snap["attendance"] if x["student_id"] == "stu-r")
    assert att["status"] == "Late" and att["has_conflict"] == 0
    # resolving twice is rejected cleanly
    assert client.post("/api/conflicts/resolve", json={"conflict_id": open_ids[0], "resolved_value": "Late"}).status_code == 409


def test_student_removal_cascades_and_ignores_stale_operations(client):
    hlc = HybridLogicalClock("dev-A")
    sync(client, "dev-A", [student_op("c1", "stu-del", "dev-A", hlc.now(), full_name="Nina Rao", class_name="5",
                                      section="A", roll_number="9", dob="2014-02-02", guardian_contact="9000011111")])
    sync(client, "dev-A", [att_op("a1", "stu-del", "2026-10-31", "Present", "dev-A", hlc.now())])
    sync(client, "dev-B", [att_op("a2", "stu-del", "2026-10-31", "Absent", "dev-B", HybridLogicalClock("dev-B").now())])
    assert client.get("/api/recovery/snapshot").get_json()["conflicts"]

    r = sync(client, "dev-A", [student_op("d1", "stu-del", "dev-A", hlc.now(), op_type="delete")])
    assert r["stats"]["ops_applied"] == 1
    snap = client.get("/api/recovery/snapshot").get_json()
    assert not [s for s in snap["students"] if s["student_id"] == "stu-del"]
    assert not [a for a in snap["attendance"] if a["student_id"] == "stu-del"]
    assert snap["conflicts"] == []

    # stale ops from a device that has not heard about the removal are acknowledged but ignored
    r = sync(client, "dev-B", [
        student_op("u1", "stu-del", "dev-B", HybridLogicalClock("dev-B").now(), op_type="update", section="Z"),
        att_op("a3", "stu-del", "2026-11-01", "Present", "dev-B", HybridLogicalClock("dev-B").now()),
    ])
    assert r["acknowledged_ids"] == ["u1", "a3"] and r["stats"]["ops_applied"] == 0
    snap = client.get("/api/recovery/snapshot").get_json()
    assert not [s for s in snap["students"] if s["student_id"] == "stu-del"]
    assert not [a for a in snap["attendance"] if a["student_id"] == "stu-del"]

    # PII is gone from the database and from the operation log
    conn = sqlite3.connect(Config.DATABASE_PATH)
    row = conn.execute("SELECT full_name, dob_enc, guardian_contact_enc, is_deleted FROM students WHERE student_id='stu-del'").fetchone()
    log = " ".join(r[0] for r in conn.execute("SELECT payload_json FROM operations_log WHERE entity_id='stu-del'"))
    conn.close()
    assert row == ("", "", "", 1)
    assert "Nina" not in log and "9000011111" not in log

    # admin overview does not count removed students; other devices receive the delete op
    login(client, "admin", "admin123")
    assert client.get("/api/admin/overview").get_json()["counts"]["total_students"] == 0
    pulled = sync(client, "dev-C", [], since=0)
    assert any(o["operation_type"] == "delete" and o["entity_id"] == "stu-del" for o in pulled["remote_operations"])


def test_update_survives_unreadable_ciphertext_and_does_not_destroy_it(client):
    """If SERVER_ENCRYPTION_SECRET changes, old ciphertext cannot be read. Editing the student's
    name must still sync (it used to crash with HTTP 500 = 'Sync Error')."""
    hlc = HybridLogicalClock("dev-A")
    sync(client, "dev-A", [student_op("c1", "stu-enc", "dev-A", hlc.now(), full_name="Old", class_name="6",
                                      section="A", roll_number="3", dob="2013-03-03", guardian_contact="9111111111")])
    conn = sqlite3.connect(Config.DATABASE_PATH)
    conn.execute("UPDATE students SET dob_enc='ENCv1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE student_id='stu-enc'")
    conn.commit(); conn.close()

    r = client.post("/api/sync", json={"device_id": "dev-A", "since_seq": 0, "operations": [
        student_op("u1", "stu-enc", "dev-A", hlc.now(), op_type="update", full_name="New Name")]})
    assert r.status_code == 200
    snap = client.get("/api/recovery/snapshot")
    assert snap.status_code == 200
    st = next(s for s in snap.get_json()["students"] if s["student_id"] == "stu-enc")
    assert st["full_name"] == "New Name"
    assert st["dob"] is None                       # unreadable -> flagged, not a fake value
    assert st["guardian_contact"] == "9111111111"  # untouched field still readable


def test_all_accounts_get_the_same_vault_key(client):
    """Per-user keys made one teacher's data show as [Encrypted] for another account."""
    t1 = login(client, "teacher1", "teacher123")["crypto_token"]
    t2 = login(client, "teacher2", "teacher123")["crypto_token"]
    ad = login(client, "admin", "admin123")["crypto_token"]
    assert t1 == t2 == ad
    assert client.get("/api/auth/me").get_json()["crypto_token"] == t1


def test_invalid_attendance_status_does_not_poison_the_sync_queue(client):
    r = client.post("/api/sync", json={"device_id": "dev-bad", "since_seq": 0, "operations": [
        att_op("bad1", "stu-q", "2026-10-31", "Maybe", "dev-bad", HybridLogicalClock("dev-bad").now())]})
    assert r.status_code == 200 and r.get_json()["acknowledged_ids"] == ["bad1"]
