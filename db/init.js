// Sets up the SQLite database on first run.
// SQLite is plenty for a fleet under ~500 devices; swap for Postgres later if you scale past that.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'fleet.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    employee_name TEXT NOT NULL,
    imei TEXT UNIQUE NOT NULL,
    model TEXT,
    enrolled_at TEXT NOT NULL,
    last_seen_at TEXT,
    device_token TEXT UNIQUE NOT NULL
  );

  -- One row per backup attempt (e.g. "today's contacts backup for device X").
  CREATE TABLE IF NOT EXISTS backup_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    content_type TEXT NOT NULL,       -- 'contacts' | 'call_log' | 'media' | 'chat'
    file_name TEXT NOT NULL,
    total_size_bytes INTEGER NOT NULL,
    bytes_received INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER,               -- e.g. number of contacts or calls in this file
    checksum_sha256 TEXT,             -- set by client at init; verified once upload completes
    status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | complete | failed | corrupt
    started_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  -- Tracks which byte ranges have been received, so a resumed upload
  -- never re-sends or double-writes a chunk that already landed.
  CREATE TABLE IF NOT EXISTS chunks (
    session_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (session_id, chunk_index),
    FOREIGN KEY (session_id) REFERENCES backup_sessions(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

module.exports = db;
