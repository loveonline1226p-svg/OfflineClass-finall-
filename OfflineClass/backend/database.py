import os
import sqlite3
import time
from werkzeug.security import generate_password_hash
from config import Config

def get_db_connection(db_path: str = None):
    path = db_path or Config.DATABASE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Generous busy-timeout: Flask serves requests on several threads and an auto-sync
    # can overlap a manual one; without this SQLite raises "database is locked" -> Sync Error.
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn

def init_db(db_path: str = None):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # 1. Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('teacher', 'admin')),
        full_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    """)

    # 2. Registered Devices table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT,
        last_seen_at INTEGER,
        last_sync_seq INTEGER DEFAULT 0,
        user_agent TEXT
    );
    """)

    # 3. Students table (dob_enc & guardian_contact_enc are encrypted at rest on server)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS students (
        student_id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        class_name TEXT NOT NULL,
        section TEXT NOT NULL,
        roll_number TEXT NOT NULL,
        dob_enc TEXT,
        guardian_contact_enc TEXT,
        field_hlcs_json TEXT NOT NULL DEFAULT '{}',
        is_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    """)

    # Lightweight migration for databases created before student removal existed
    student_cols = {r["name"] for r in cursor.execute("PRAGMA table_info(students)").fetchall()}
    if "is_deleted" not in student_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
    if "deleted_at" not in student_cols:
        cursor.execute("ALTER TABLE students ADD COLUMN deleted_at INTEGER")

    # 4. Attendance table (Unique logical key: student_id + attendance_date)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance (
        attendance_id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        attendance_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Present', 'Absent', 'Late')),
        teacher_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        hlc TEXT NOT NULL,
        has_conflict INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(student_id, attendance_date)
    );
    """)

    # 5. Operation Log table (Idempotency guaranteed by UNIQUE operation_id)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS operations_log (
        server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT UNIQUE NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        device_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        hlc TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL
    );
    """)

    # 6. Conflicts table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        attendance_date TEXT NOT NULL,
        existing_op_id TEXT NOT NULL,
        existing_value TEXT NOT NULL,
        existing_teacher_id TEXT NOT NULL,
        existing_device_id TEXT NOT NULL,
        existing_hlc TEXT NOT NULL,
        incoming_op_id TEXT NOT NULL,
        incoming_value TEXT NOT NULL,
        incoming_teacher_id TEXT NOT NULL,
        incoming_device_id TEXT NOT NULL,
        incoming_hlc TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('unresolved', 'resolved')),
        resolved_value TEXT,
        resolved_by TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL
    );
    """)

    # 7. Telemetry / Sync Metrics table (real metrics for System Testing Dashboard)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sync_metrics (
        metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        ops_received INTEGER NOT NULL,
        ops_applied INTEGER NOT NULL,
        duplicates_prevented INTEGER NOT NULL,
        conflicts_created INTEGER NOT NULL,
        bytes_transferred INTEGER NOT NULL,
        latency_ms REAL NOT NULL,
        interrupted_recovery INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL
    );
    """)

    # Seed Demo Accounts if not present
    now = int(time.time() * 1000)
    cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE username = 'teacher1'")
    if cursor.fetchone()["cnt"] == 0:
        cursor.execute(
            "INSERT INTO users (user_id, username, password_hash, role, full_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("usr-teacher-1", "teacher1", generate_password_hash("teacher123"), "teacher", "Asha Sharma (Teacher)", now)
        )
    cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE username = 'teacher2'")
    if cursor.fetchone()["cnt"] == 0:
        cursor.execute(
            "INSERT INTO users (user_id, username, password_hash, role, full_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("usr-teacher-2", "teacher2", generate_password_hash("teacher123"), "teacher", "Vikram Patel (Teacher)", now)
        )
    cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE username = 'admin'")
    if cursor.fetchone()["cnt"] == 0:
        cursor.execute(
            "INSERT INTO users (user_id, username, password_hash, role, full_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("usr-admin-1", "admin", generate_password_hash("admin123"), "admin", "Principal Rajesh Verma (Admin)", now)
        )

    conn.commit()
    conn.close()
