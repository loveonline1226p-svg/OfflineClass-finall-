class ClientEncryption {
  constructor() {
    this.cryptoKey = null;
    this.keyFingerprint = null;
  }

  async initFromToken(tokenString) {
    this.keyFingerprint = await this.fingerprint(tokenString);
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(tokenString),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    this.cryptoKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode("offlineclass-local-indexeddb-salt"),
        iterations: 50000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encryptText(plaintext) {
    if (!plaintext) return "";
    if (!this.cryptoKey) return plaintext;
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.cryptoKey,
      enc.encode(plaintext)
    );
    const cipherArray = new Uint8Array(cipherBuffer);
    const combined = new Uint8Array(iv.length + cipherArray.length);
    combined.set(iv, 0);
    combined.set(cipherArray, iv.length);
    let binary = "";
    for (let i = 0; i < combined.byteLength; i++) {
      binary += String.fromCharCode(combined[i]);
    }
    return "WEBENCv1:" + btoa(binary);
  }

  // Returns the plaintext, or `null` when the value cannot be decrypted with the current key.
  // (Never return a placeholder string here: callers re-encrypt what they read, and a placeholder
  // such as "[Encrypted]" would then be saved - and synced - as if it were the real value.)
  async decryptText(cipherStr) {
    if (!cipherStr) return "";
    if (!cipherStr.startsWith("WEBENCv1:")) return cipherStr;
    if (!this.cryptoKey) return null;
    try {
      const binary = atob(cipherStr.slice(9));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const iv = bytes.slice(0, 12);
      const data = bytes.slice(12);
      const plainBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        this.cryptoKey,
        data
      );
      return new TextDecoder().decode(plainBuffer);
    } catch (e) {
      return null;
    }
  }

  // Short fingerprint of the current key material, used to notice that the key changed
  // (different server secret) and that locally cached ciphertext must be re-downloaded.
  async fingerprint(tokenString) {
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode("fp:" + tokenString));
    return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async encryptWithPassphrase(jsonString, passphrase) {
    const enc = new TextEncoder();
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const cipherBuf = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      enc.encode(jsonString)
    );
    return JSON.stringify({
      version: 1,
      salt: Array.from(salt),
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(cipherBuf))
    });
  }

  async decryptWithPassphrase(bundleJson, passphrase) {
    const bundle = JSON.parse(bundleJson);
    const enc = new TextEncoder();
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const aesKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: new Uint8Array(bundle.salt),
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(bundle.iv) },
      aesKey,
      new Uint8Array(bundle.ciphertext)
    );
    return new TextDecoder().decode(plainBuf);
  }
}

window.clientCrypto = new ClientEncryption();
