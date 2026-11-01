const AppState = {
  user: null,
  currentPage: "dashboard",
  editingStudentId: null,
  syncState: "up-to-date",
  syncErrorMsg: ""
};

window.clientHLC = new ClientHLC("dev-init");

// Student names etc. are user-typed text that is written into innerHTML: always escape it.
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOCKED_TEXT = "🔒 Unreadable on this device";

function localToday() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function showToast(msg) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function formatTime(ms) {
  if (!ms) return "Never";
  return new Date(ms).toLocaleString();
}

async function updateTopStatusBar() {
  const connPill = document.getElementById("conn-status-pill");
  const syncPill = document.getElementById("sync-status-pill");
  const pendingBadge = document.getElementById("nav-pending-count");
  const conflictBadge = document.getElementById("nav-conflict-count");
  const simBtn = document.getElementById("toggle-offline-btn");

  const isOnline = window.syncEngine.isOnline();
  if (isOnline) {
    connPill.className = "pill pill-online";
    connPill.textContent = "● Online";
    simBtn.textContent = "Go Offline (Simulate)";
    simBtn.className = "btn btn-outline btn-sm";
  } else {
    connPill.className = "pill pill-offline";
    connPill.textContent = "● Offline Mode";
    simBtn.textContent = "Go Online (Reconnect)";
    simBtn.className = "btn btn-warning btn-sm";
  }

  const pendingOps = await window.localDB.getAll("pending_operations");
  const conflicts = await window.localDB.getAll("conflicts");
  const unresolvedCount = conflicts.filter((c) => c.status === "unresolved").length;

  pendingBadge.textContent = pendingOps.length;
  conflictBadge.textContent = unresolvedCount;

  if (AppState.syncState === "syncing") {
    syncPill.className = "pill pill-syncing";
    syncPill.textContent = "↻ Synchronising...";
  } else if (AppState.syncState === "error") {
    syncPill.className = "pill pill-error";
    syncPill.textContent = `⚠ Sync Error: ${AppState.syncErrorMsg || "Retry needed"}`;
  } else if (pendingOps.length > 0) {
    syncPill.className = "pill pill-offline";
    syncPill.textContent = `⧗ ${pendingOps.length} Pending Local Change(s)`;
  } else {
    syncPill.className = "pill pill-online";
    syncPill.textContent = "✓ Up to date";
  }

  const devId = await window.localDB.getOrCreateDeviceId();
  document.getElementById("active-device-display").textContent = `${window.localDB.currentDeviceSlot} (${devId})`;
}

async function navigateTo(pageId) {
  AppState.currentPage = pageId;
  document.querySelectorAll(".page-section").forEach((s) => s.classList.add("hidden"));
  const target = document.getElementById(`page-${pageId}`);
  if (target) target.classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === pageId);
  });

  await refreshCurrentPage();
}

async function refreshCurrentPage() {
  await updateTopStatusBar();
  const page = AppState.currentPage;
  if (page === "dashboard") await renderTeacherDashboard();
  else if (page === "students") await renderStudentList();
  else if (page === "add-student") await renderStudentForm();
  else if (page === "attendance") await renderAttendancePage();
  else if (page === "attendance-history") await renderAttendanceHistory();
  else if (page === "sync-status") await renderSyncStatusPage();
  else if (page === "conflicts") await renderConflictsPage();
  else if (page === "admin") await renderAdminDashboard();
  else if (page === "testing") await renderTestingDashboard();
}

// 1. Authentication & Offline Session Cache
async function initAuth() {
  const cachedUser = localStorage.getItem("offlineclass_cached_user");
  if (cachedUser) {
    AppState.user = JSON.parse(cachedUser);
    await window.clientCrypto.initFromToken(AppState.user.crypto_token);
  }

  if (window.syncEngine.isOnline()) {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        AppState.user = data;
        localStorage.setItem("offlineclass_cached_user", JSON.stringify(data));
        await window.clientCrypto.initFromToken(data.crypto_token);
      } else if (res.status === 401) {
        // The server no longer knows this session (expired / signed out elsewhere): sign in again
        // instead of showing screens whose actions the server would reject.
        AppState.user = null;
        localStorage.removeItem("offlineclass_cached_user");
      }
    } catch (e) {
      // network unreachable: keep working from the cached offline session
    }
  }

  if (AppState.user) {
    showAuthenticatedShell();
    if (window.syncEngine.isOnline()) {
      await window.syncEngine.syncNow();
    }
    await navigateTo(AppState.user.role === "admin" ? "admin" : "dashboard");
  } else {
    showLoginShell();
  }
}

function showLoginShell() {
  document.getElementById("login-view").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

function showAuthenticatedShell() {
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-badge").textContent = `${AppState.user.full_name} (${AppState.user.role})`;
}

// 2. Teacher Dashboard
async function renderTeacherDashboard() {
  const students = await window.localDB.getStudentsDecrypted();
  const attendance = await window.localDB.getAll("attendance");
  const pending = await window.localDB.getAll("pending_operations");
  const conflicts = await window.localDB.getAll("conflicts");
  const unresolved = conflicts.filter((c) => c.status === "unresolved");

  const today = localToday();
  const todayAtt = attendance.filter((a) => a.attendance_date === today);

  document.getElementById("dash-total-students").textContent = students.length;
  document.getElementById("dash-today-attendance").textContent = `${todayAtt.length} / ${students.length}`;
  document.getElementById("dash-pending-ops").textContent = pending.length;
  document.getElementById("dash-unresolved-conflicts").textContent = unresolved.length;

  const recentTbody = document.getElementById("dash-recent-students");
  recentTbody.innerHTML = "";
  students.slice(0, 5).forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(s.roll_number)}</strong></td>
      <td>${esc(s.full_name)}</td>
      <td>${esc(s.class_name)} - ${esc(s.section)}</td>
      <td><span class="pill ${s.sync_status === "synced" ? "pill-online" : "pill-offline"}">${
      s.sync_status === "synced" ? "Synchronised" : "Saved Locally"
    }</span></td>
    `;
    recentTbody.appendChild(tr);
  });
}

// 3. Student Management & Search
async function renderStudentList() {
  const query = (document.getElementById("student-search-input").value || "").toLowerCase();
  const students = await window.localDB.getStudentsDecrypted();
  const filtered = students.filter(
    (s) =>
      (s.full_name || "").toLowerCase().includes(query) ||
      (s.roll_number || "").toLowerCase().includes(query) ||
      (s.class_name || "").toLowerCase().includes(query)
  );

  const tbody = document.getElementById("students-table-body");
  tbody.innerHTML = "";
  for (const s of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${esc(s.student_id.slice(0, 10))}</code></td>
      <td><strong>${esc(s.roll_number)}</strong></td>
      <td>${esc(s.full_name)}</td>
      <td>Class ${esc(s.class_name)} (${esc(s.section)})</td>
      <td>${s.dob_locked ? `<span class="pill pill-error" title="This device cannot decrypt this value. Press Sync Now to re-download it.">${LOCKED_TEXT}</span>` : esc(s.dob || "-")}</td>
      <td>${s.contact_locked ? `<span class="pill pill-error" title="This device cannot decrypt this value. Press Sync Now to re-download it.">${LOCKED_TEXT}</span>` : esc(s.guardian_contact || "-")}</td>
      <td><span class="pill ${s.sync_status === "synced" ? "pill-online" : "pill-offline"}">${
      s.sync_status === "synced" ? "Synced" : "Local (Pending)"
    }</span></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-outline btn-sm" data-student-id="${esc(s.student_id)}" data-action="edit">Edit</button>
        <button class="btn btn-danger btn-sm" data-student-id="${esc(s.student_id)}" data-action="remove">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// Edit / Remove buttons are wired by data attributes so ids never have to be spliced into JS strings.
async function handleStudentTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.studentId;
  if (btn.dataset.action === "edit") await window.editStudent(id);
  else if (btn.dataset.action === "remove") await window.removeStudent(id);
}

// Remove a student: tombstone operation (so every device removes it on its next sync) and
// immediate local removal of the student, their attendance and conflicts.
window.removeStudent = async function (studentId) {
  const st = await window.localDB.get("students", studentId);
  if (!st) return;
  const label = `${st.full_name || "this student"}${st.roll_number ? " (Roll " + st.roll_number + ")" : ""}`;
  const ok = confirm(
    `Remove ${label}?\n\nThis permanently deletes the student's record and ALL of their attendance ` +
      `records and conflicts from this device and, after sync, from the central server and every other device.\n\nThis cannot be undone.`
  );
  if (!ok) return;

  await window.syncEngine.queueOperation(
    "student",
    studentId,
    "delete",
    { student_id: studentId },
    AppState.user ? AppState.user.username : "teacher1"
  );
  await window.localDB.removeStudentLocally(studentId);
  // queued changes for this student that were never sent are pointless now
  for (const pend of await window.localDB.getAll("pending_operations")) {
    if (pend.operation_type !== "delete" && (pend.entity_id === studentId || (pend.payload && pend.payload.student_id === studentId))) {
      await window.localDB.delete("pending_operations", pend.operation_id);
    }
  }
  if (AppState.editingStudentId === studentId) AppState.editingStudentId = null;
  showToast(`Removed ${label}`);
  if (window.syncEngine.isOnline()) await window.syncEngine.syncNow();
  await refreshCurrentPage();
};

window.editStudent = async function (studentId) {
  AppState.editingStudentId = studentId;
  await navigateTo("add-student");
};

// 4. Add / Edit Student Page
async function renderStudentForm() {
  const title = document.getElementById("student-form-title");
  const form = document.getElementById("student-form");
  form.reset();

  if (AppState.editingStudentId) {
    title.textContent = "Edit Student Record";
    const students = await window.localDB.getStudentsDecrypted();
    const st = students.find((s) => s.student_id === AppState.editingStudentId);
    if (st) {
      document.getElementById("st-full-name").value = st.full_name;
      document.getElementById("st-class").value = st.class_name;
      document.getElementById("st-section").value = st.section;
      document.getElementById("st-roll").value = st.roll_number;
      // A field this device cannot decrypt is left empty (never filled with a placeholder):
      // leaving it empty keeps the stored value, typing something replaces it.
      document.getElementById("st-dob").value = st.dob_locked ? "" : st.dob || "";
      document.getElementById("st-contact").value = st.contact_locked ? "" : st.guardian_contact || "";
      document.getElementById("st-dob").placeholder = st.dob_locked ? LOCKED_TEXT + " – leave empty to keep" : "";
      document.getElementById("st-contact").placeholder = st.contact_locked ? LOCKED_TEXT + " – leave empty to keep" : "";
    } else {
      // the student was removed (e.g. on another device) while this form was open
      AppState.editingStudentId = null;
      title.textContent = "Add New Student (Works Offline)";
    }
  } else {
    title.textContent = "Add New Student (Works Offline)";
    document.getElementById("st-dob").placeholder = "";
    document.getElementById("st-contact").placeholder = "";
  }
}

let studentSaveInProgress = false;

async function handleStudentFormSubmit(e) {
  e.preventDefault();
  // A double click used to run this handler twice and create two students ("clones").
  if (studentSaveInProgress) return;
  studentSaveInProgress = true;
  const saveBtn = document.querySelector("#student-form button[type='submit']");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await saveStudentFromForm();
  } finally {
    studentSaveInProgress = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function saveStudentFromForm() {
  const fullName = document.getElementById("st-full-name").value.trim();
  const className = document.getElementById("st-class").value.trim();
  const section = document.getElementById("st-section").value.trim();
  const rollNumber = document.getElementById("st-roll").value.trim();
  const dob = document.getElementById("st-dob").value.trim();
  const contact = document.getElementById("st-contact").value.trim();

  const now = Date.now();
  const isEdit = Boolean(AppState.editingStudentId);

  // Block accidental duplicates: same class + section + roll number (a different student).
  const allStudents = await window.localDB.getStudentsDecrypted();
  const norm = (v) => String(v || "").trim().toLowerCase();
  const dup = allStudents.find(
    (x) =>
      x.student_id !== AppState.editingStudentId &&
      norm(x.class_name) === norm(className) &&
      norm(x.section) === norm(section) &&
      norm(x.roll_number) === norm(rollNumber)
  );
  if (dup) {
    alert(
      `A student with roll number ${rollNumber} already exists in Class ${className} (${section}): ${dup.full_name}.\n` +
        `Edit that record instead of adding a second copy.`
    );
    return;
  }
  const studentId = isEdit ? AppState.editingStudentId : `stu-${crypto.randomUUID()}`;
  const deviceId = await window.localDB.getOrCreateDeviceId();
  window.clientHLC.setNodeId(deviceId);

  let existing = isEdit ? await window.localDB.get("students", studentId) : null;
  let deltaPayload = {};

  if (!existing) {
    deltaPayload = {
      student_id: studentId,
      full_name: fullName,
      class_name: className,
      section: section,
      roll_number: rollNumber,
      dob: dob,
      guardian_contact: contact,
      created_at: now
    };
  } else {
    // Only send modified fields in the operation payload so field-level CRDT merges cleanly!
    const oldDob = await window.clientCrypto.decryptText(existing.dob_enc || "");
    const oldContact = await window.clientCrypto.decryptText(existing.guardian_contact_enc || "");
    if (fullName !== existing.full_name) deltaPayload.full_name = fullName;
    if (className !== existing.class_name) deltaPayload.class_name = className;
    if (section !== existing.section) deltaPayload.section = section;
    if (rollNumber !== existing.roll_number) deltaPayload.roll_number = rollNumber;
    // null = this device cannot read the stored value: an empty box then means "keep it"
    if (oldDob === null ? dob !== "" : dob !== oldDob) deltaPayload.dob = dob;
    if (oldContact === null ? contact !== "" : contact !== oldContact) deltaPayload.guardian_contact = contact;
  }

  if (isEdit && existing && Object.keys(deltaPayload).length === 0) {
    AppState.editingStudentId = null;
    showToast("No changes to save.");
    await navigateTo("students");
    return;
  }
  if (isEdit && !existing) {
    alert("This student no longer exists (it may have been removed on another device).");
    AppState.editingStudentId = null;
    await navigateTo("students");
    return;
  }

  const op = await window.syncEngine.queueOperation(
    "student",
    studentId,
    isEdit ? "update" : "create",
    deltaPayload,
    AppState.user ? AppState.user.username : "teacher1"
  );

  const fieldHlcs = existing && existing.field_hlcs ? { ...existing.field_hlcs } : {};
  Object.keys(deltaPayload).forEach((k) => {
    fieldHlcs[k] = op.hlc;
  });

  // Start from the stored record so unchanged (possibly unreadable) encrypted fields are kept as-is.
  const toSave = {
    ...(existing || {}),
    student_id: studentId,
    full_name: fullName,
    class_name: className,
    section: section,
    roll_number: rollNumber,
    field_hlcs: fieldHlcs,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    sync_status: "pending"
  };
  if (!existing || "dob" in deltaPayload) toSave.dob = dob;
  if (!existing || "guardian_contact" in deltaPayload) toSave.guardian_contact = contact;
  await window.localDB.saveStudent(toSave);

  AppState.editingStudentId = null;
  showToast("Student saved to local IndexedDB (Encrypted)!");
  if (window.syncEngine.isOnline()) {
    await window.syncEngine.syncNow();
  }
  await navigateTo("students");
}

// 5. Attendance Management Page
async function renderAttendancePage() {
  const dateInput = document.getElementById("att-date-picker");
  if (!dateInput.value) {
    dateInput.value = localToday();
  }
  const selectedDate = dateInput.value;

  const students = await window.localDB.getStudentsDecrypted();
  const allAtt = await window.localDB.getAll("attendance");
  const openConflicts = (await window.localDB.getAll("conflicts")).filter((c) => c.status === "unresolved");
  const attMap = {};
  allAtt
    .filter((a) => a.attendance_date === selectedDate)
    .forEach((a) => {
      attMap[a.student_id] = a;
    });

  const tbody = document.getElementById("attendance-mark-tbody");
  tbody.innerHTML = "";

  for (const s of students) {
    const rec = attMap[s.student_id];
    const conflict = rec && rec.has_conflict
      ? openConflicts.find((c) => c.student_id === s.student_id && c.attendance_date === selectedDate)
      : null;
    // While a conflict is open the "current status" is the disputed pair, not either single value.
    const currentStatus = conflict
      ? `${conflict.existing_value} / ${conflict.incoming_value}`
      : rec
      ? rec.status
      : "Not Marked";
    const markStatus = rec ? rec.status : "Not Marked";
    const syncBadge = !rec
      ? `<span class="pill">Unmarked</span>`
      : rec.has_conflict
      ? `<span class="pill pill-error">⚠ Conflict</span>`
      : rec.sync_status === "synced"
      ? `<span class="pill pill-online">Synced</span>`
      : `<span class="pill pill-offline">Saved Locally</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(s.roll_number)}</strong></td>
      <td>${esc(s.full_name)}</td>
      <td>${esc(s.class_name)}-${esc(s.section)}</td>
      <td><strong>${esc(currentStatus)}</strong></td>
      <td>${syncBadge}</td>
      <td>
        <button class="btn ${markStatus === "Present" ? "btn-success" : "btn-outline"} btn-sm"
          data-student-id="${esc(s.student_id)}" data-status="Present">Present</button>
        <button class="btn ${markStatus === "Absent" ? "btn-danger" : "btn-outline"} btn-sm"
          data-student-id="${esc(s.student_id)}" data-status="Absent">Absent</button>
        <button class="btn ${markStatus === "Late" ? "btn-warning" : "btn-outline"} btn-sm"
          data-student-id="${esc(s.student_id)}" data-status="Late">Late</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

window.markAttendance = async function (studentId, status) {
  const picker = document.getElementById("att-date-picker");
  if (!picker.value) picker.value = localToday();
  const selectedDate = picker.value;
  const logicalKey = `${studentId}_${selectedDate}`;
  const existing = await window.localDB.get("attendance", logicalKey);
  const attendanceId = existing ? existing.attendance_id : `att-${crypto.randomUUID()}`;
  const deviceId = await window.localDB.getOrCreateDeviceId();
  const teacherId = AppState.user ? AppState.user.username : "teacher1";
  const now = Date.now();

  const payload = {
    attendance_id: attendanceId,
    student_id: studentId,
    attendance_date: selectedDate,
    status: status,
    teacher_id: teacherId,
    // The version of this record the teacher was looking at when making the edit. The server
    // uses it to tell a deliberate correction (informed) from a concurrent edit (conflict).
    base_hlc: existing ? existing.hlc : null,
    created_at: existing ? existing.created_at : now
  };

  const op = await window.syncEngine.queueOperation("attendance", attendanceId, "mark", payload, teacherId);

  await window.localDB.put("attendance", {
    logical_key: logicalKey,
    attendance_id: attendanceId,
    student_id: studentId,
    attendance_date: selectedDate,
    status: status,
    teacher_id: teacherId,
    device_id: deviceId,
    hlc: op.hlc,
    has_conflict: existing ? existing.has_conflict : 0,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    sync_status: "pending"
  });

  showToast(`Marked ${status} locally (${selectedDate})`);
  if (window.syncEngine.isOnline()) {
    await window.syncEngine.syncNow();
  }
  await renderAttendancePage();
  await updateTopStatusBar();
};

// 6. Attendance History Page
async function renderAttendanceHistory() {
  const students = await window.localDB.getStudentsDecrypted();
  const stuMap = {};
  students.forEach((s) => (stuMap[s.student_id] = s));

  const records = await window.localDB.getAll("attendance");
  records.sort((a, b) => b.attendance_date.localeCompare(a.attendance_date));

  const tbody = document.getElementById("attendance-history-tbody");
  tbody.innerHTML = "";
  for (const r of records) {
    const st = stuMap[r.student_id] || { full_name: r.student_id, roll_number: "-" };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.attendance_date}</td>
      <td><strong>${esc(st.roll_number)}</strong> - ${esc(st.full_name)}</td>
      <td><strong>${esc(r.status)}</strong></td>
      <td>${esc(r.teacher_id)}</td>
      <td><code>${r.device_id}</code></td>
      <td><small><code>${r.hlc}</code></small></td>
      <td>
        ${
          r.has_conflict
            ? `<span class="pill pill-error">Conflict Flagged</span>`
            : r.sync_status === "synced"
            ? `<span class="pill pill-online">Synced</span>`
            : `<span class="pill pill-offline">Local Only</span>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// 7. Synchronisation Status & Device-Loss Recovery Page
async function renderSyncStatusPage() {
  const devId = await window.localDB.getOrCreateDeviceId();
  const cursorMeta = await window.localDB.get("sync_meta", "server_cursor");
  const lastSyncMeta = await window.localDB.get("sync_meta", "last_sync_time");
  const pendingOps = await window.localDB.getAll("pending_operations");

  document.getElementById("sync-page-device-id").textContent = devId;
  document.getElementById("sync-page-hlc").textContent = window.clientHLC.now();
  document.getElementById("sync-page-cursor").textContent = cursorMeta ? cursorMeta.value : 0;
  document.getElementById("sync-page-last-time").textContent = lastSyncMeta
    ? formatTime(lastSyncMeta.value)
    : "Never";

  const tbody = document.getElementById("pending-ops-tbody");
  tbody.innerHTML = "";
  for (const op of pendingOps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${op.operation_id.slice(0, 14)}...</code></td>
      <td>${op.entity_type} (${op.operation_type})</td>
      <td><code>${op.entity_id.slice(0, 12)}</code></td>
      <td><small><code>${op.hlc}</code></small></td>
      <td><span class="pill pill-offline">Pending Queue</span></td>
    `;
    tbody.appendChild(tr);
  }
}

// Encrypted Local Backup Export & Restore + Server Snapshot Recovery
window.exportEncryptedBackup = async function () {
  const pass = document.getElementById("backup-passphrase").value || "offlineclass-backup-key";
  const students = await window.localDB.getAll("students");
  const attendance = await window.localDB.getAll("attendance");
  const pendingOps = await window.localDB.getAll("pending_operations");
  const syncMeta = await window.localDB.getAll("sync_meta");

  const payload = JSON.stringify({
    exported_at: Date.now(),
    device_slot: window.localDB.currentDeviceSlot,
    students,
    attendance,
    pending_operations: pendingOps,
    sync_meta: syncMeta
  });

  const encryptedBundle = await window.clientCrypto.encryptWithPassphrase(payload, pass);
  const blob = new Blob([encryptedBundle], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `offlineclass-encrypted-backup-${Date.now()}.json`;
  a.click();
  showToast("Encrypted backup exported (AES-GCM 256-bit)!");
};

window.importEncryptedBackup = async function (event) {
  const file = event.target.files[0];
  if (!file) return;
  const pass = document.getElementById("backup-passphrase").value || "offlineclass-backup-key";
  try {
    const text = await file.text();
    const decryptedJson = await window.clientCrypto.decryptWithPassphrase(text, pass);
    const data = JSON.parse(decryptedJson);

    for (const s of data.students || []) await window.localDB.put("students", s);
    for (const a of data.attendance || []) await window.localDB.put("attendance", a);
    for (const p of data.pending_operations || []) await window.localDB.put("pending_operations", p);
    for (const m of data.sync_meta || []) await window.localDB.put("sync_meta", m);

    showToast("Encrypted backup restored into IndexedDB!");
    await refreshCurrentPage();
  } catch (err) {
    alert("Backup decryption failed. Check passphrase: " + err.message);
  }
};

window.restoreFromServerSnapshot = async function () {
  if (!window.syncEngine.isOnline()) {
    alert("Must be online to download synchronised snapshot from central server.");
    return;
  }
  const res = await fetch("/api/recovery/snapshot");
  if (!res.ok) {
    alert("Failed to fetch snapshot from server.");
    return;
  }
  const data = await res.json();
  await window.localDB.clearAllStores();

  for (const s of data.students || []) {
    await window.localDB.saveStudent(s);
  }
  for (const a of data.attendance || []) {
    await window.localDB.put("attendance", {
      ...a,
      logical_key: `${a.student_id}_${a.attendance_date}`
    });
  }
  for (const c of data.conflicts || []) {
    await window.localDB.put("conflicts", c);
  }
  await window.localDB.put("sync_meta", {
    key: "server_cursor",
    value: data.server_cursor || 0,
    updated_at: Date.now()
  });

  showToast(`Restored ${(data.students || []).length} students & ${(data.attendance || []).length} attendance records from central server!`);
  await refreshCurrentPage();
};

// 8. Conflict Resolution Page
async function renderConflictsPage() {
  const conflicts = await window.localDB.getAll("conflicts");
  const container = document.getElementById("conflicts-list-container");
  container.innerHTML = "";

  if (conflicts.length === 0) {
    container.innerHTML = `<div class="card"><p>No attendance conflicts recorded.</p></div>`;
    return;
  }

  const isAdmin = AppState.user && AppState.user.role === "admin";

  for (const c of conflicts) {
    const div = document.createElement("div");
    div.className = c.status === "unresolved" ? "conflict-box" : "card";
    div.innerHTML = `
      <div class="card-header">
        <div>
          <strong>Student:</strong> ${esc(c.student_name || c.student_id)} (Roll: ${esc(c.roll_number || "-")})
          &nbsp;|&nbsp; <strong>Date:</strong> ${c.attendance_date}
        </div>
        <span class="pill ${c.status === "unresolved" ? "pill-error" : "pill-online"}">
          ${c.status.toUpperCase()}
        </span>
      </div>
      <div class="conflict-versions">
        <div class="version-card">
          <h4>Version A (First Synced)</h4>
          <p><strong>Status:</strong> ${c.existing_value}</p>
          <p><small>Teacher: ${c.existing_teacher_id} | Device: <code>${c.existing_device_id}</code></small></p>
          <p><small>Op ID: <code>${c.existing_op_id}</code></small></p>
          <p><small>HLC: <code>${c.existing_hlc}</code></small></p>
        </div>
        <div class="version-card">
          <h4>Version B (Conflicting Edit)</h4>
          <p><strong>Status:</strong> ${c.incoming_value}</p>
          <p><small>Teacher: ${c.incoming_teacher_id} | Device: <code>${c.incoming_device_id}</code></small></p>
          <p><small>Op ID: <code>${c.incoming_op_id}</code></small></p>
          <p><small>HLC: <code>${c.incoming_hlc}</code></small></p>
        </div>
      </div>
      ${
        c.status === "resolved"
          ? `<p><strong>Resolution History:</strong> Resolved to <strong>${c.resolved_value}</strong> by Administrator <strong>${c.resolved_by}</strong> at ${formatTime(c.resolved_at)}</p>`
          : isAdmin
          ? `
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
              <span><strong>Admin Resolution:</strong></span>
              <button class="btn btn-success btn-sm" data-conflict-id="${esc(c.conflict_id)}" data-resolve="Present">Resolve as Present</button>
              <button class="btn btn-danger btn-sm" data-conflict-id="${esc(c.conflict_id)}" data-resolve="Absent">Resolve as Absent</button>
              <button class="btn btn-warning btn-sm" data-conflict-id="${esc(c.conflict_id)}" data-resolve="Late">Resolve as Late</button>
            </div>
          `
          : `<p><small><em>Only an Administrator can resolve this conflict. Switch to the Admin account to resolve.</em></small></p>`
      }
    `;
    container.appendChild(div);
  }
}

window.resolveConflictAction = async function (conflictId, chosenValue) {
  if (!window.syncEngine.isOnline()) {
    alert("Administrator must be online to publish conflict resolution to central server.");
    return;
  }
  const devId = await window.localDB.getOrCreateDeviceId();
  // The SERVER decides who is an administrator from the signed-in session (not from anything
  // this page claims), so show exactly what it answers.
  const res = await fetch("/api/conflicts/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conflict_id: conflictId, resolved_value: chosenValue, device_id: devId })
  });
  if (!res.ok) {
    let err = {};
    try {
      err = await res.json();
    } catch (e) {}
    alert(err.error || "Failed to resolve conflict");
    if (res.status === 401) {
      localStorage.removeItem("offlineclass_cached_user");
      AppState.user = null;
      showLoginShell();
    } else if (res.status === 403 || res.status === 409) {
      await window.syncEngine.syncNow();
      await refreshCurrentPage();
    }
    return;
  }
  showToast(`Conflict resolved to ${chosenValue}! Synchronising...`);
  await window.syncEngine.syncNow();
  await refreshCurrentPage();
};

// 9. Administrator Dashboard
async function renderAdminDashboard() {
  if (!window.syncEngine.isOnline()) {
    document.getElementById("admin-offline-notice").classList.remove("hidden");
    return;
  }
  document.getElementById("admin-offline-notice").classList.add("hidden");

  const res = await fetch("/api/admin/overview");
  if (!res.ok) return;
  const data = await res.json();
  const c = data.counts;
  const pendingLocal = await window.localDB.getAll("pending_operations");

  document.getElementById("adm-students").textContent = c.total_students;
  document.getElementById("adm-teachers").textContent = c.total_teachers;
  document.getElementById("adm-attendance").textContent = c.total_attendance;
  document.getElementById("adm-devices").textContent = c.total_devices;
  document.getElementById("adm-pending").textContent = pendingLocal.length;
  document.getElementById("adm-syncs").textContent = c.successful_syncs;
  document.getElementById("adm-conflicts").textContent = c.unresolved_conflicts;

  const devTbody = document.getElementById("adm-devices-tbody");
  devTbody.innerHTML = "";
  for (const d of data.devices) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${d.device_id}</code></td>
      <td>${d.user_id || "-"}</td>
      <td>${d.last_sync_seq}</td>
      <td>${formatTime(d.last_seen_at)}</td>
    `;
    devTbody.appendChild(tr);
  }

  const actTbody = document.getElementById("adm-activity-tbody");
  actTbody.innerHTML = "";
  for (const op of data.recent_activity) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>#${op.server_seq}</td>
      <td><code>${op.operation_id.slice(0, 12)}...</code></td>
      <td>${op.entity_type} (${op.operation_type})</td>
      <td><code>${op.device_id}</code></td>
      <td><small><code>${op.hlc}</code></small></td>
    `;
    actTbody.appendChild(tr);
  }
}

// 10. System Testing & Real Telemetry Dashboard
async function renderTestingDashboard() {
  if (!window.syncEngine.isOnline()) return;
  const res = await fetch("/api/metrics");
  if (!res.ok) return;
  const data = await res.json();

  const emptyNotice = document.getElementById("metrics-empty-notice");
  const metricsGrid = document.getElementById("metrics-grid-container");

  if (!data.has_data) {
    emptyNotice.classList.remove("hidden");
    metricsGrid.classList.add("hidden");
    return;
  }

  emptyNotice.classList.add("hidden");
  metricsGrid.classList.remove("hidden");

  document.getElementById("met-loss-rate").textContent = `${data.data_loss_rate_percent}%`;
  document.getElementById("met-latency").textContent = `${data.avg_sync_latency_ms} ms`;
  document.getElementById("met-bytes").textContent = `${data.avg_bytes_per_sync} B`;
  document.getElementById("met-conflicts").textContent = `${data.conflicts_detected} Preserved`;
  document.getElementById("met-interrupted").textContent = `${data.interrupted_recoveries} Resumed`;
  document.getElementById("met-dups").textContent = `${data.duplicates_prevented} Blocked`;
  document.getElementById("met-cipher-sample").textContent = data.raw_server_cipher_sample;
}

// Interactive Repeatable End-to-End 10-Scenario Automated Verification Runner
window.runInteractiveDemonstrationSuite = async function () {
  const resultsTbody = document.getElementById("live-test-results-tbody");
  resultsTbody.innerHTML = `<tr><td colspan="3">Running real browser + server tests...</td></tr>`;
  const logs = [];

  function recordResult(testName, passed, details, skipped = false) {
    logs.push({ testName, passed, details, skipped });
  }
  const createdStudentIds = []; // removed again at the end so test runs never leave clones behind

  try {
    // Test 1: Offline Operation
    window.syncEngine.setSimulatedOffline(true);
    const rahulId = `stu-rahul-${crypto.randomUUID().slice(0, 6)}`;
    const priyaId = `stu-priya-${crypto.randomUUID().slice(0, 6)}`;
    createdStudentIds.push(rahulId, priyaId);
    const testDate = localToday();

    await window.localDB.saveStudent({
      student_id: rahulId,
      full_name: "Rahul Verma",
      class_name: "8",
      section: "A",
      roll_number: "101",
      dob: "2012-05-14",
      guardian_contact: "9876543210",
      field_hlcs: {},
      created_at: Date.now(),
      updated_at: Date.now(),
      sync_status: "pending"
    });
    await window.syncEngine.queueOperation("student", rahulId, "create", {
      student_id: rahulId,
      full_name: "Rahul Verma",
      class_name: "8",
      section: "A",
      roll_number: "101",
      dob: "2012-05-14",
      guardian_contact: "9876543210"
    }, "teacher1");

    const localCheck = await window.localDB.get("students", rahulId);
    recordResult(
      "Test 1: Offline Operation (IndexedDB storage without internet)",
      Boolean(localCheck && localCheck.sync_status === "pending"),
      `Created student ${rahulId} while offline.`
    );

    // Test 9: Encryption at Rest (Check raw IndexedDB ciphertext)
    const isEncryptedLocally = localCheck.guardian_contact_enc && localCheck.guardian_contact_enc.startsWith("WEBENCv1:");
    recordResult(
      "Test 9: Encryption at Rest (Web Crypto AES-GCM in IndexedDB)",
      Boolean(isEncryptedLocally),
      `Raw IndexedDB contact field: ${localCheck.guardian_contact_enc.slice(0, 28)}...`
    );

    // Reconnect and sync Rahul
    window.syncEngine.setSimulatedOffline(false);
    await window.syncEngine.syncNow();

    // Test 2: Independent Changes from Device A and Device B
    const opIndepA = {
      operation_id: `op-indep-a-${crypto.randomUUID()}`,
      entity_type: "student",
      entity_id: priyaId,
      operation_type: "create",
      payload: {
        student_id: priyaId,
        full_name: "Priya Nair",
        class_name: "8",
        section: "A",
        roll_number: "102",
        dob: "2012-08-19",
        guardian_contact: "9123456780"
      },
      device_id: "sim-device-A",
      user_id: "teacher1",
      hlc: window.clientHLC.now(),
      created_at: Date.now()
    };
    const opIndepB = {
      operation_id: `op-indep-b-${crypto.randomUUID()}`,
      entity_type: "student",
      entity_id: rahulId,
      operation_type: "update",
      payload: { section: "B" },
      device_id: "sim-device-B",
      user_id: "teacher2",
      hlc: window.clientHLC.now(),
      created_at: Date.now()
    };
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "sim-device-A", since_seq: 0, operations: [opIndepA] })
    });
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "sim-device-B", since_seq: 0, operations: [opIndepB] })
    });
    await window.syncEngine.syncNow();
    const priyaAfter = await window.localDB.get("students", priyaId);
    const rahulAfter = await window.localDB.get("students", rahulId);
    recordResult(
      "Test 2: Independent Changes & Field-Level CRDT Merge",
      Boolean(priyaAfter && rahulAfter && rahulAfter.section === "B"),
      "Device A and Device B independent student & field edits both survived."
    );

    // Test 3: Simultaneous Conflicting Edits (Device A marks Rahul Present, Device B marks Rahul Absent)
    const attIdA = `att-${crypto.randomUUID()}`;
    const attIdB = `att-${crypto.randomUUID()}`;
    const conflictOpA = {
      operation_id: `op-conf-a-${crypto.randomUUID()}`,
      entity_type: "attendance",
      entity_id: attIdA,
      operation_type: "mark",
      payload: {
        attendance_id: attIdA,
        student_id: rahulId,
        attendance_date: testDate,
        status: "Present",
        teacher_id: "teacher1"
      },
      device_id: "sim-device-A",
      user_id: "teacher1",
      hlc: window.clientHLC.now(),
      created_at: Date.now()
    };
    const conflictOpB = {
      operation_id: `op-conf-b-${crypto.randomUUID()}`,
      entity_type: "attendance",
      entity_id: attIdB,
      operation_type: "mark",
      payload: {
        attendance_id: attIdB,
        student_id: rahulId,
        attendance_date: testDate,
        status: "Absent",
        teacher_id: "teacher2"
      },
      device_id: "sim-device-B",
      user_id: "teacher2",
      hlc: window.clientHLC.now(),
      created_at: Date.now()
    };
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "sim-device-A", since_seq: 0, operations: [conflictOpA] })
    });
    const confSyncRes = await (
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: "sim-device-B", since_seq: 0, operations: [conflictOpB] })
      })
    ).json();

    const createdConflict = (confSyncRes.conflicts || []).find(
      (c) => c.student_id === rahulId && c.status === "unresolved"
    );
    recordResult(
      "Test 3: Simultaneous Conflicting Attendance Edits",
      Boolean(createdConflict),
      createdConflict
        ? `Conflict ${createdConflict.conflict_id} created (${createdConflict.existing_value} vs ${createdConflict.incoming_value}).`
        : "Conflict not created"
    );

    // Test 4: Administrator Conflict Resolution
    // Only an administrator session may resolve conflicts (the server checks the session).
    const isAdminSession = AppState.user && AppState.user.role === "admin";
    if (!isAdminSession) {
      recordResult(
        "Test 4: Administrator Conflict Resolution & Audit Trail",
        true,
        "SKIPPED: sign in as admin to run this scenario (only administrators may resolve conflicts).",
        true
      );
    } else {
      let resolvedOk = false;
      let detail = "Administrator resolved Rahul's attendance conflict to 'Present'.";
      if (createdConflict) {
        const resResp = await fetch("/api/conflicts/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conflict_id: createdConflict.conflict_id, resolved_value: "Present" })
        });
        resolvedOk = resResp.ok;
        if (!resResp.ok) {
          try {
            detail = (await resResp.json()).error || detail;
          } catch (e) {}
        }
      }
      recordResult("Test 4: Administrator Conflict Resolution & Audit Trail", resolvedOk, detail);
    }

    // Test 5: Idempotent Duplicate Operation Replay
    const dupRes = await (
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: "sim-device-A",
          since_seq: 0,
          operations: [opIndepA, opIndepA]
        })
      })
    ).json();
    recordResult(
      "Test 5: Idempotent Replay (Duplicate Operation ID Submission)",
      dupRes.stats && dupRes.stats.duplicates_prevented >= 2,
      `Submitted same operation ID twice; duplicates prevented: ${dupRes.stats.duplicates_prevented}`
    );

    // Test 6: Interrupted Synchronisation & Safe Resume
    const intOp1 = await window.syncEngine.queueOperation("student", rahulId, "update", { section: "C" }, "teacher1");
    const intOp2 = await window.syncEngine.queueOperation("student", priyaId, "update", { section: "C" }, "teacher1");
    const failRun = await window.syncEngine.syncNow({ simulateInterruptAfter: 1 });
    const remainingPending = await window.localDB.getAll("pending_operations");
    const resumeRun = await window.syncEngine.syncNow({ isRetry: true });
    const afterResumePending = await window.localDB.getAll("pending_operations");
    recordResult(
      "Test 6: Interrupted Sync Mid-Batch & Resumable Recovery",
      !failRun.ok && remainingPending.length >= 1 && resumeRun.ok && afterResumePending.length === 0,
      `Interrupted after 1 op (${remainingPending.length} kept in queue), then resumed to 0 pending.`
    );

    // Test 7: Hybrid Logical Clock (Clock Skew Verification)
    const clockSkewedPast = new ClientHLC("skew-node-past");
    const clockAhead = new ClientHLC("skew-node-ahead");
    const tAhead = clockAhead.now(Date.now() + 300000); // +5 mins ahead
    const tCausallyAfter = clockSkewedPast.update(tAhead, Date.now() - 300000); // -5 mins behind
    const causalOrderHolds = ClientHLC.compare(tCausallyAfter, tAhead) > 0;
    recordResult(
      "Test 7: Hybrid Logical Clock (HLC) Causal Ordering Under 10-Min Clock Skew",
      causalOrderHolds,
      `Ahead HLC: ${tAhead} -> Causally subsequent HLC on lagging clock: ${tCausallyAfter}`
    );

    // Test 8: Device Restoration from Central Server Snapshot
    await window.localDB.clearAllStores();
    await window.restoreFromServerSnapshot();
    const restoredStudents = await window.localDB.getStudentsDecrypted();
    recordResult(
      "Test 8: Device-Loss Recovery (Clear IndexedDB & Restore Snapshot)",
      restoredStudents.some((s) => s.student_id === rahulId),
      `Restored ${restoredStudents.length} students after wiping local IndexedDB.`
    );

    // Test 10: Post-Sync Regression Check
    const regAttKey = `${priyaId}_${testDate}`;
    document.getElementById("att-date-picker").value = testDate;
    await window.markAttendance(priyaId, "Present");
    const regAtt = await window.localDB.get("attendance", regAttKey);
    recordResult(
      "Test 10: Post-Sync Regression Check",
      Boolean(regAtt && regAtt.status === "Present"),
      "Normal attendance and student operations continue working after sync & recovery."
    );
  } catch (err) {
    recordResult("Unexpected Suite Error", false, err.message);
  }

  // Clean up: the suite creates demo students; remove them (this also removes their attendance
  // and conflicts on the server and on every device) so repeated runs do not pile up clones.
  try {
    for (const id of createdStudentIds) {
      await window.syncEngine.queueOperation("student", id, "delete", { student_id: id }, "teacher1");
      await window.localDB.removeStudentLocally(id);
    }
    window.syncEngine.setSimulatedOffline(false);
    await window.syncEngine.syncNow();
    recordResult("Cleanup: demo students removed", true, `Removed ${createdStudentIds.length} temporary test students from this device and the server.`, true);
  } catch (err) {
    recordResult("Cleanup: demo students removed", false, err.message);
  }

  resultsTbody.innerHTML = "";
  for (const r of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${r.testName}</strong></td>
      <td><span class="pill ${r.skipped ? "pill-offline" : r.passed ? "pill-online" : "pill-error"}">${r.skipped ? "INFO" : r.passed ? "PASS" : "FAIL"}</span></td>
      <td>${esc(r.details)}</td>
    `;
    resultsTbody.appendChild(tr);
  }

  await renderTestingDashboard();
  await updateTopStatusBar();
};

// Event Listeners Setup
window.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }

  await window.localDB.open();
  const slotSelect = document.getElementById("device-slot-selector");
  slotSelect.value = window.localDB.currentDeviceSlot;

  slotSelect.addEventListener("change", async (e) => {
    await window.localDB.switchDeviceSlot(e.target.value);
    showToast(`Switched active local IndexedDB to ${e.target.value}`);
    await refreshCurrentPage();
  });

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const devId = await window.localDB.getOrCreateDeviceId();

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, device_id: devId })
      });
      const data = await res.json();
      if (!res.ok) {
        document.getElementById("login-error").textContent = data.error || "Login failed";
        document.getElementById("login-error").classList.remove("hidden");
        return;
      }
      AppState.user = data;
      localStorage.setItem("offlineclass_cached_user", JSON.stringify(data));
      await window.clientCrypto.initFromToken(data.crypto_token);
      showAuthenticatedShell();
      await window.syncEngine.syncNow();
      await navigateTo(data.role === "admin" ? "admin" : "dashboard");
    } catch (err) {
      document.getElementById("login-error").textContent = "Network unreachable. Log in once online to cache session.";
      document.getElementById("login-error").classList.remove("hidden");
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    localStorage.removeItem("offlineclass_cached_user");
    AppState.user = null;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {}
    showLoginShell();
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page === "add-student") AppState.editingStudentId = null;
      navigateTo(btn.dataset.page);
    });
  });

  document.getElementById("toggle-offline-btn").addEventListener("click", async () => {
    const nextState = !window.syncEngine.simulatedOffline;
    window.syncEngine.setSimulatedOffline(nextState);
    if (!nextState) {
      showToast("Internet restored! Auto-synchronising pending operations...");
      await window.syncEngine.syncNow();
    } else {
      showToast("Offline Mode enabled. All changes will queue in IndexedDB.");
    }
    await refreshCurrentPage();
  });

  document.getElementById("manual-sync-btn").addEventListener("click", async () => {
    const res = await window.syncEngine.syncNow();
    if (res.ok) showToast("Synchronisation complete!");
    else showToast(`Sync not completed: ${res.reason || res.error}`);
    await refreshCurrentPage();
  });

  document.getElementById("student-form").addEventListener("submit", handleStudentFormSubmit);
  document.getElementById("students-table-body").addEventListener("click", handleStudentTableClick);
  document.getElementById("attendance-mark-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-status]");
    if (btn) window.markAttendance(btn.dataset.studentId, btn.dataset.status);
  });
  document.getElementById("conflicts-list-container").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-resolve]");
    if (btn) window.resolveConflictAction(btn.dataset.conflictId, btn.dataset.resolve);
  });
  // Several tabs of the same browser share ONE login cookie. If another tab signs in or out,
  // follow it, otherwise this tab keeps showing a user the server no longer sees.
  window.addEventListener("storage", (e) => {
    if (e.key === "offlineclass_cached_user") window.location.reload();
  });
  // Background sync every 20 s while online so conflicts / removals made on other devices show up
  // without pressing "Sync Now".
  setInterval(async () => {
    if (!AppState.user || !window.syncEngine.isOnline() || window.syncEngine.isSyncing) return;
    if (document.hidden || studentSaveInProgress) return;
    const res = await window.syncEngine.syncNow();
    // never re-render the form while someone is typing in it
    if (res.ok && AppState.currentPage !== "add-student") await refreshCurrentPage();
  }, 20000);
  document.getElementById("student-search-input").addEventListener("input", renderStudentList);
  document.getElementById("att-date-picker").addEventListener("change", renderAttendancePage);

  window.addEventListener("online", async () => {
    if (!window.syncEngine.simulatedOffline) {
      await window.syncEngine.syncNow();
      await refreshCurrentPage();
    }
  });
  window.addEventListener("offline", updateTopStatusBar);
  window.addEventListener("sync-status", async (e) => {
    AppState.syncState = e.detail.state;
    AppState.syncErrorMsg = e.detail.message || "";
    await updateTopStatusBar();
  });

  await initAuth();
});
