import os
import tempfile
import pytest
from app import create_app

@pytest.fixture
def client():
    db_fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    app = create_app({
        "TESTING": True,
        "DATABASE_PATH": db_path
    })
    with app.test_client() as client:
        yield client
    os.close(db_fd)
    if os.path.exists(db_path):
        os.remove(db_path)
