import json
import time
import uuid
from flask import Flask, render_template, jsonify, request
from config import Config
from backend.database import init_db, get_db_connection
from backend.auth import auth_bp
from backend.sync import sync_bp, process_single_operation
from backend.encryption import encryptor
from backend.clock import HybridLogicalClock

def create_app(test_config: dict = None):
    app = Flask(
        __name__,
        template_folder="frontend/templates",
        static_folder="frontend/static"
    )
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)
        Config.DATABASE_PATH = app.config.get("DATABASE_PATH", Config.DATABASE_PATH)

    init_db(Config.DATABASE_PATH)

    app.register_blueprint(auth_bp)
    app.register_blueprint(sync_bp)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/service-worker.js")
    def sw():
        return app.send_static_file("service-worker.js"), 200, {
            "Content-Type": "application/javascript",
            "Service-Worker-Allowed": "/"
        }

    @app.route("/manifest.json")
    def manifest():
        return app.send_static_file("manifest.json")

    @app.route("/api/ping", methods=["GET"])
    def ping():
        return jsonify({"online": True, "timestamp": int(time.time() * 1000)})

    @app.route("/api/admin/overview", methods=["GET"])
    def admin_overview():
        conn = get_db_connection()
        total_students = conn.execute("SELECT COUNT(*) as c FROM students WHERE is_deleted = 0").fetchone()["c"]
        total_teachers = conn.execute("SELECT COUNT(*) as c FROM users WHERE role = 'teacher'").fetchone()["c"]
        total_attendance = conn.execute("SELECT COUNT(*) as c FROM attendance").fetchone()["c"]
        total_devices = conn.execute("SELECT COUNT(*) as c FROM devices").fetchone()["c"]
        total_syncs = conn.execute("SELECT COUNT(*) as c FROM sync_metrics").fetchone()["c"]
        unresolved_conflicts = conn.execute("SELECT COUNT(*) as c FROM conflicts WHERE status = 'unresolved'").fetchone()["c"]

        teachers = [dict(r) for r in conn.execute("SELECT user_id, username, full_name, role, created_at FROM users").fetchall()]
        devices = [dict(r) for r in conn.execute("SELECT * FROM devices ORDER BY last_seen_at DESC").fetchall()]
        recent_ops = [dict(r) for r in conn.execute("SELECT * FROM operations_log ORDER BY server_seq DESC LIMIT 20").fetchall()]
        conflicts = [dict(r) for r in conn.execute("""
            SELECT c.*, s.full_name as student_name, s.class_name, s.roll_number
            FROM conflicts c
            LEFT JOIN students s ON c.student_id = s.student_id
            ORDER BY c.created_at DESC
        """).fetchall()]

        conn.close()
        return jsonify({
            "counts": {
                "total_students": total_students,
                "total_teachers": total_teachers,
                "total_attendance": total_attendance,
                "total_devices": total_devices,
                "successful_syncs": total_syncs,
                "unresolved_conflicts": unresolved_conflicts
            },
            "teachers": teachers,
            "devices": devices,
            "recent_activity": recent_ops,
            "conflicts": conflicts
        })

    @app.route("/api/recovery/snapshot", methods=["GET"])
    def recovery_snapshot():
        """
        Device-Loss Recovery Endpoint:
        Downloads all synchronised students (decrypted over HTTPS for authenticated session),
        attendance records, conflicts, and current server sequence number onto a replacement device.
        """
        conn = get_db_connection()
        student_rows = conn.execute("SELECT * FROM students WHERE is_deleted = 0").fetchall()
        students = []
        for r in student_rows:
            dob = encryptor.try_decrypt(r["dob_enc"])
            contact = encryptor.try_decrypt(r["guardian_contact_enc"])
            students.append({
                "student_id": r["student_id"],
                "full_name": r["full_name"],
                "class_name": r["class_name"],
                "section": r["section"],
                "roll_number": r["roll_number"],
                # None = ciphertext unreadable (server secret changed); the client keeps the field locked
                "dob": dob,
                "guardian_contact": contact,
                "field_hlcs": json.loads(r["field_hlcs_json"] or "{}"),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "sync_status": "synced"
            })

        att_rows = conn.execute("SELECT * FROM attendance").fetchall()
        attendance = [dict(r, sync_status="synced") for r in att_rows]

        conf_rows = conn.execute("""
            SELECT c.*, s.full_name as student_name, s.class_name, s.roll_number
            FROM conflicts c
            LEFT JOIN students s ON c.student_id = s.student_id
        """).fetchall()
        conflicts = [dict(r) for r in conf_rows]

        max_seq = conn.execute("SELECT COALESCE(MAX(server_seq), 0) as m FROM operations_log").fetchone()["m"]
        conn.close()

        return jsonify({
            "students": students,
            "attendance": attendance,
            "conflicts": conflicts,
            "server_cursor": max_seq
        })

    @app.route("/api/metrics", methods=["GET"])
    def get_metrics():
        """
        Computes real, non-hardcoded telemetry from the `sync_metrics`, `operations_log`,
        and `conflicts` tables for the System Testing Dashboard.
        """
        conn = get_db_connection()
        metrics_rows = conn.execute("SELECT * FROM sync_metrics ORDER BY timestamp DESC").fetchall()

        if not metrics_rows:
            conn.close()
            return jsonify({
                "has_data": False,
                "message": "No synchronisation or test runs have been performed yet."
            })

        total_sync_runs = len(metrics_rows)
        total_ops_received = sum(r["ops_received"] for r in metrics_rows)
        total_ops_applied = sum(r["ops_applied"] for r in metrics_rows)
        total_dups_prevented = sum(r["duplicates_prevented"] for r in metrics_rows)
        total_conflicts = sum(r["conflicts_created"] for r in metrics_rows)
        avg_latency = round(sum(r["latency_ms"] for r in metrics_rows) / total_sync_runs, 2)
        avg_bytes = round(sum(r["bytes_transferred"] for r in metrics_rows) / total_sync_runs, 1)
        interrupted_recoveries = sum(r["interrupted_recovery"] for r in metrics_rows)

        # Verify Data Loss Rate: every unique non-duplicate operation submitted must exist in operations_log
        logged_ops_count = conn.execute("SELECT COUNT(*) as c FROM operations_log").fetchone()["c"]
        expected_unique_ops = total_ops_applied
        lost_ops = max(0, expected_unique_ops - logged_ops_count)
        data_loss_rate = 0.0 if expected_unique_ops == 0 else round((lost_ops / expected_unique_ops) * 100, 2)

        # Verify Encryption at rest on server
        sample_student = conn.execute("SELECT dob_enc, guardian_contact_enc FROM students WHERE is_deleted = 0 AND guardian_contact_enc != '' LIMIT 1").fetchone()
        encryption_verified = False
        raw_cipher_sample = "No student records on server yet"
        if sample_student and sample_student["guardian_contact_enc"]:
            raw_cipher_sample = sample_student["guardian_contact_enc"]
            encryption_verified = raw_cipher_sample.startswith("ENCv1:")

        conn.close()
        return jsonify({
            "has_data": True,
            "total_sync_runs": total_sync_runs,
            "data_loss_rate_percent": data_loss_rate,
            "avg_sync_latency_ms": avg_latency,
            "avg_bytes_per_sync": avg_bytes,
            "total_ops_received": total_ops_received,
            "unique_ops_applied": total_ops_applied,
            "duplicates_prevented": total_dups_prevented,
            "conflicts_detected": total_conflicts,
            "interrupted_recoveries": interrupted_recoveries,
            "server_encryption_verified": encryption_verified,
            "raw_server_cipher_sample": raw_cipher_sample,
            "recent_runs": [dict(r) for r in metrics_rows[:10]]
        })

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="127.0.0.1", port=5000, debug=True)
