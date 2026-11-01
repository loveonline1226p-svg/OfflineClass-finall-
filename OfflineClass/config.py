import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

class Config:
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "offlineclass-dev-secret-key-2026")
    SERVER_ENCRYPTION_SECRET = os.environ.get(
        "SERVER_ENCRYPTION_SECRET", "bios-hackathon-encryption-master-secret-key-2026"
    )
    INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
    DATABASE_PATH = os.environ.get(
        "DATABASE_PATH", os.path.join(INSTANCE_DIR, "database.sqlite")
    )
    SYNC_BATCH_SIZE = int(os.environ.get("SYNC_BATCH_SIZE", 50))

