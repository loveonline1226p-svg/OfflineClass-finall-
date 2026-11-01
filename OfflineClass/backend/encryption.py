import os
import base64
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from config import Config

class ServerEncryptor:
    def __init__(self, secret: str = None):
        raw_secret = (secret or Config.SERVER_ENCRYPTION_SECRET).encode("utf-8")
        # Derive a 32-byte (256-bit) key deterministically from the environment secret
        self.key = hashlib.sha256(raw_secret).digest()
        self.aesgcm = AESGCM(self.key)

    def encrypt(self, plaintext: str) -> str:
        if not plaintext:
            return ""
        nonce = os.urandom(12)
        ciphertext = self.aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        combined = nonce + ciphertext
        return "ENCv1:" + base64.b64encode(combined).decode("utf-8")

    def decrypt(self, encrypted_str: str) -> str:
        if not encrypted_str:
            return ""
        if not encrypted_str.startswith("ENCv1:"):
            return encrypted_str
        raw = base64.b64decode(encrypted_str[6:])
        nonce = raw[:12]
        ciphertext = raw[12:]
        plaintext = self.aesgcm.decrypt(nonce, ciphertext, None)
        return plaintext.decode("utf-8")

    def try_decrypt(self, encrypted_str: str):
        """Like decrypt() but returns None instead of raising when the ciphertext cannot be
        read (e.g. SERVER_ENCRYPTION_SECRET was changed after the row was written)."""
        try:
            return self.decrypt(encrypted_str)
        except Exception:
            return None

encryptor = ServerEncryptor()
