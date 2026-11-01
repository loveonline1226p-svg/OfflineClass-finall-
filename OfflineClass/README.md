# OfflineClass — Offline-First School Sync Platform

A Flask + vanilla JavaScript Progressive Web App prototype for student records, attendance, offline local storage, operation-based synchronisation and attendance conflict resolution.

## Requirements
- Windows 10/11
- Python 3.10 or newer
- VS Code (optional)
- Chrome or Edge recommended for PWA/offline testing

## 1. Set up on Windows

Open this folder in VS Code. Open Terminal → New Terminal (PowerShell), then run:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

If PowerShell blocks activation, run this once in the terminal:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Create your local environment file:
```powershell
Copy-Item .env.example .env
```
Open `.env` and replace both secret values with long random values. Do not share or commit `.env`.

## 2. Run the application

```powershell
python app.py
```

Open http://127.0.0.1:5000 in Chrome or Edge. The SQLite database and demo users are created automatically on first run.

### Demo accounts
| Role | Username | Password |
|---|---|---|
| Teacher | `teacher1` | `teacher123` |
| Teacher | `teacher2` | `teacher123` |
| Administrator | `admin` | `admin123` |

These are development-only credentials. Change or remove them before any real deployment.

## 3. Run automated tests

Stop the Flask server if it is running, then run:

```powershell
pytest -v
```

The tests are the source of truth for what currently passes. The original Word document included a sample expected output; this project package does not assume those results until pytest has actually run on your machine.

## 4. Test offline behaviour

1. Start the server and open the site once while online.
2. Sign in as `teacher1`.
3. Add a student and mark attendance. The browser stores local changes in IndexedDB and queues operations.
4. Use the top-bar device switcher to switch between Device A and Device B. Each slot maintains its own local data.
5. Use **Go Offline (Simulate)** to simulate a disconnected device. This is useful for the demo; it is not the same as physically disconnecting the network.
6. Make independent changes on the two device slots.
7. Reconnect and press **Sync Now**.
8. To test a conflict, go offline on both device slots, mark the same student's attendance with different statuses on each, then sync both. Sign in as `admin` (use a second browser profile or Incognito window - see below) and use the conflict resolution screen.
9. To remove a student, use **Remove** on the Student Records page. The student, their attendance and any conflicts are deleted on every device after the next sync, and the personal details are scrubbed from the server's operation log.

**One login per browser profile.** All tabs of a browser share one login cookie, so signing in as `admin` in one tab signs the other tabs in as `admin` too. To use a teacher and the admin at the same time, use two browser profiles (or a normal and an Incognito window).

For a more realistic browser-offline test, open the app in two separate browser profiles (for example, a normal Chrome profile and an Incognito window), load it once first, then use Chrome DevTools → Network → Offline. Note that both browser profiles still need to reach the same Flask server when syncing.

## 5. Important architecture notes

- Flask and SQLite provide the central API and server-side operation log.
- IndexedDB stores local student/attendance data and pending operations.
- The service worker caches the app shell so it can reopen after its first successful load.
- Operations have unique IDs; the server uses a uniqueness constraint to make replay idempotent.
- Student fields use per-field HLC metadata for merge decisions.
- Incompatible attendance values for the same student/date are preserved as explicit conflicts for administrator review. A conflict only arises from *concurrent* edits: each attendance edit carries `base_hlc` (the version the teacher was looking at). If the device had already seen the server's current value, the edit is an ordinary correction, not a conflict.
- Students are removed with a tombstone operation (`delete`), so a device that is still offline cannot bring a removed student back later.
- Local encryption uses one school-wide key (derived from `SERVER_ENCRYPTION_SECRET`) so every account on a device can read the shared records. If that secret is changed, the app detects it and re-downloads its local cache on the next sync. Records already stored on the *server* under the old secret cannot be decrypted any more: they show as "Unreadable" until the field is edited again, so set the secrets in `.env` **before** entering real data and do not change them afterwards.
- The HLC helps order events; it does not establish which attendance value is factually correct.

## 6. Prototype limitations and safety

This is a hackathon prototype, not a production school information system. Do not enter real children's personal data.

Before any real deployment, the project needs a security review and additional work, including:
- Enforcing authentication and role checks on every protected API route.
- CSRF protection, secure cookie settings, rate limiting and HTTPS deployment.
- A proper key-management and rotation strategy.
- Reviewing multi-device conflict handling, transaction boundaries and sync cursor semantics.
- Testing real network interruption and multi-browser/device behaviour.
- A reliable encrypted export/restore workflow and documented recovery procedure.
- Accessibility, privacy, retention and backup policies.

The demo credentials and fallback development secrets in the source are not suitable for deployment. Use unique secrets in `.env`, keep `.env` private, and never commit it.

## Folder map

```text
OfflineClass/
├── app.py
├── config.py
├── requirements.txt
├── .env.example
├── README.md
├── backend/
│   ├── __init__.py
│   ├── auth.py
│   ├── clock.py
│   ├── database.py
│   ├── encryption.py
│   └── sync.py
├── frontend/
│   ├── templates/
│   │   └── index.html
│   └── static/
│       ├── css/styles.css
│       ├── js/
│       ├── manifest.json
│       └── service-worker.js
├── tests/
│   ├── conftest.py
│   └── test_suite.py
└── instance/
```
