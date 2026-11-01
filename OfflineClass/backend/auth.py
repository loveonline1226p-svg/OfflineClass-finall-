import hashlib
from flask import Blueprint, request, jsonify, session
from werkzeug.security import check_password_hash
from backend.database import get_db_connection
from config import Config

auth_bp = Blueprint("auth", __name__)

def get_client_crypto_material(user_id: str = None) -> str:
    """
    Generates the secret token the browser uses to derive its AES-GCM CryptoKey (Web Crypto API).

    The key is deliberately the SAME for every signed-in user. The local IndexedDB is shared by
    everybody who uses the tablet (teacher1, teacher2, admin) and holds *school* records, not
    per-user records. When the key was derived from user_id, data written by one account could
    not be decrypted by another and the UI showed "[Encrypted]". `user_id` is accepted only for
    backwards compatibility and is ignored.
    """
    raw = f"{Config.SERVER_ENCRYPTION_SECRET}:client-vault:school".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

@auth_bp.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    device_id = data.get("device_id", "unknown-device")

    conn = get_db_connection()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

    if not user or not check_password_hash(user["password_hash"], password):
        conn.close()
        return jsonify({"error": "Invalid username or password"}), 401

    session["user_id"] = user["user_id"]
    session["username"] = user["username"]
    session["role"] = user["role"]
    session["full_name"] = user["full_name"]

    # Register/update device
    import time
    now = int(time.time() * 1000)
    conn.execute("""
        INSERT INTO devices (device_id, user_id, last_seen_at, user_agent)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            user_id = excluded.user_id,
            last_seen_at = excluded.last_seen_at,
            user_agent = excluded.user_agent
    """, (device_id, user["user_id"], now, request.headers.get("User-Agent", "")[:120]))
    conn.commit()
    conn.close()

    return jsonify({
        "user_id": user["user_id"],
        "username": user["username"],
        "role": user["role"],
        "full_name": user["full_name"],
        "crypto_token": get_client_crypto_material(user["user_id"])
    })

@auth_bp.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"status": "logged_out"})

@auth_bp.route("/api/auth/me", methods=["GET"])
def me():
    if "user_id" not in session:
        return jsonify({"authenticated": False}), 401
    return jsonify({
        "authenticated": True,
        "user_id": session["user_id"],
        "username": session["username"],
        "role": session["role"],
        "full_name": session["full_name"],
        "crypto_token": get_client_crypto_material(session["user_id"])
    })
