class LocalDatabase {
  constructor() {
    this.db = null;
    this.currentDeviceSlot = localStorage.getItem("offlineclass_active_slot") || "Device-A";
  }

  get dbName() {
    return `OfflineClassDB_${this.currentDeviceSlot}`;
  }

  async switchDeviceSlot(slotName) {
    this.currentDeviceSlot = slotName;
    localStorage.setItem("offlineclass_active_slot", slotName);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await this.open();
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("students")) {
          db.createObjectStore("students", { keyPath: "student_id" });
        }
        if (!db.objectStoreNames.contains("attendance")) {
          const attStore = db.createObjectStore("attendance", { keyPath: "logical_key" });
          attStore.createIndex("by_date", "attendance_date", { unique: false });
          attStore.createIndex("by_student", "student_id", { unique: false });
        }
        if (!db.objectStoreNames.contains("pending_operations")) {
          db.createObjectStore("pending_operations", { keyPath: "operation_id" });
        }
        if (!db.objectStoreNames.contains("sync_meta")) {
          db.createObjectStore("sync_meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("conflicts")) {
          db.createObjectStore("conflicts", { keyPath: "conflict_id" });
        }
        if (!db.objectStoreNames.contains("device_info")) {
          db.createObjectStore("device_info", { keyPath: "key" });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async put(storeName, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async get(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async clearStore(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async clearAllStores() {
    const stores = ["students", "attendance", "pending_operations", "sync_meta", "conflicts"];
    for (const s of stores) {
      await this.clearStore(s);
    }
    // Remember which key the (now empty) database belongs to so the next sync does not
    // mistake freshly written data for data encrypted with an old key.
    if (window.clientCrypto && window.clientCrypto.keyFingerprint) {
      await this.put("sync_meta", { key: "key_fingerprint", value: window.clientCrypto.keyFingerprint });
    }
  }

  async getOrCreateDeviceId() {
    let info = await this.get("device_info", "device_id");
    if (!info) {
      const newId = `dev-${this.currentDeviceSlot.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`;
      info = { key: "device_id", value: newId, created_at: Date.now() };
      await this.put("device_info", info);
    }
    return info.value;
  }

  // Encrypt sensitive fields before writing to IndexedDB.
  // A field that is `undefined`/`null` (e.g. it could not be decrypted) is NOT re-encrypted: the
  // existing ciphertext in `dob_enc` / `guardian_contact_enc` is kept untouched instead.
  async saveStudent(studentObj) {
    const copy = { ...studentObj };
    if (copy.dob !== undefined && copy.dob !== null) {
      copy.dob_enc = await window.clientCrypto.encryptText(copy.dob);
    }
    if (copy.guardian_contact !== undefined && copy.guardian_contact !== null) {
      copy.guardian_contact_enc = await window.clientCrypto.encryptText(copy.guardian_contact);
    }
    if (copy.dob_enc === undefined) copy.dob_enc = "";
    if (copy.guardian_contact_enc === undefined) copy.guardian_contact_enc = "";
    delete copy.dob;
    delete copy.guardian_contact;
    delete copy.dob_locked;
    delete copy.contact_locked;
    await this.put("students", copy);
  }

  // `dob` / `guardian_contact` are null (and *_locked is true) when the value cannot be decrypted.
  async getStudentsDecrypted() {
    const rawList = await this.getAll("students");
    const out = [];
    for (const r of rawList) {
      const dob = await window.clientCrypto.decryptText(r.dob_enc || "");
      const contact = await window.clientCrypto.decryptText(r.guardian_contact_enc || "");
      out.push({
        ...r,
        dob,
        guardian_contact: contact,
        dob_locked: dob === null,
        contact_locked: contact === null
      });
    }
    return out.sort((a, b) =>
      (a.roll_number || "").localeCompare(b.roll_number || "", undefined, { numeric: true })
    );
  }

  // Remove a student and everything that hangs off it from THIS device's IndexedDB.
  async removeStudentLocally(studentId) {
    await this.delete("students", studentId);
    for (const a of await this.getAll("attendance")) {
      if (a.student_id === studentId) await this.delete("attendance", a.logical_key);
    }
    for (const c of await this.getAll("conflicts")) {
      if (c.student_id === studentId) await this.delete("conflicts", c.conflict_id);
    }
  }
}

window.localDB = new LocalDatabase();
