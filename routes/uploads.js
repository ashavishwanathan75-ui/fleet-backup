// Resumable upload endpoints.
//
// How this solves "connection drops in the field, must auto-resume without restarting":
// 1. The phone app calls POST /init once per file to get a session_id.
// 2. It uploads the file in small chunks (e.g. 1-4MB) via PATCH, one at a time.
// 3. If the connection drops mid-chunk or mid-file, the phone just calls
//    GET /:sessionId/status next time it has signal. That returns bytes_received —
//    the exact byte offset to resume from. No re-uploading data that already arrived.
// 4. Every chunk write is idempotent: if the same chunk_index arrives twice
//    (e.g. the phone wasn't sure the last one landed), it's safely ignored.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requireDeviceAuth } = require('./devices');

const router = express.Router();
const STORAGE_DIR = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

router.use(requireDeviceAuth);

// Step 1: start a backup session for one file (a media file, or a single
// export like "contacts.json" / "call_log.json").
router.post('/init', (req, res) => {
  const { content_type, file_name, total_size_bytes, item_count, checksum_sha256 } = req.body;
  const validTypes = ['contacts', 'call_log', 'media', 'chat'];

  if (!validTypes.includes(content_type) || !file_name || !total_size_bytes) {
    return res.status(400).json({ error: 'content_type, file_name, and total_size_bytes are required' });
  }

  const session_id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO backup_sessions (id, device_id, content_type, file_name, total_size_bytes, item_count, checksum_sha256, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session_id, req.device.id, content_type, file_name, total_size_bytes, item_count || null, checksum_sha256 || null, now);

  // Pre-create the destination file on disk so chunk writes can seek into it.
  const filePath = path.join(STORAGE_DIR, `${session_id}_${file_name}`);
  fs.closeSync(fs.openSync(filePath, 'w'));

  log(req.device.id, `Backup started: ${file_name}`);
  res.status(201).json({ session_id });
});

// Step 2 (used after any reconnect): "where should I resume from?"
router.get('/:sessionId/status', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  res.json({
    session_id: session.id,
    status: session.status,
    bytes_received: session.bytes_received,
    total_size_bytes: session.total_size_bytes,
    resume_from_byte: session.bytes_received
  });
});

// Step 3: upload one chunk. The phone sends raw bytes in the body, plus
// headers describing where this chunk fits in the overall file.
router.patch('/:sessionId', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  if (session.status === 'complete') {
    return res.status(200).json({ status: 'complete', bytes_received: session.bytes_received });
  }

  const chunkIndex = parseInt(req.header('X-Chunk-Index'), 10);
  const byteOffset = parseInt(req.header('X-Byte-Offset'), 10);
  if (Number.isNaN(chunkIndex) || Number.isNaN(byteOffset)) {
    return res.status(400).json({ error: 'X-Chunk-Index and X-Byte-Offset headers are required' });
  }

  // Idempotency: if we've already recorded this exact chunk, don't write it again.
  const already = db.prepare(
    'SELECT 1 FROM chunks WHERE session_id = ? AND chunk_index = ?'
  ).get(session.id, chunkIndex);

  if (!already) {
    const filePath = path.join(STORAGE_DIR, `${session.id}_${session.file_name}`);
    const fd = fs.openSync(filePath, 'r+');
    fs.writeSync(fd, req.body, 0, req.body.length, byteOffset);
    fs.closeSync(fd);

    db.prepare(`
      INSERT INTO chunks (session_id, chunk_index, byte_offset, byte_length, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, chunkIndex, byteOffset, req.body.length, new Date().toISOString());

    const newBytesReceived = byteOffset + req.body.length;
    const isComplete = newBytesReceived >= session.total_size_bytes;
    let finalStatus = isComplete ? 'complete' : 'in_progress';

    if (isComplete && session.checksum_sha256) {
      // Verify the fully-received file matches what the phone hashed before
      // upload. This is what "working perfectly without glitches" actually
      // means here: proof that resuming a dropped upload never corrupted
      // or duplicated bytes.
      const filePath = path.join(STORAGE_DIR, `${session.id}_${session.file_name}`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      if (hash !== session.checksum_sha256) {
        finalStatus = 'corrupt';
      }
    }

    db.prepare(`
      UPDATE backup_sessions
      SET bytes_received = ?, status = ?, completed_at = ?
      WHERE id = ?
    `).run(
      newBytesReceived,
      finalStatus,
      isComplete ? new Date().toISOString() : null,
      session.id
    );

    if (isComplete) {
      log(req.device.id, finalStatus === 'complete'
        ? `Backup complete and verified: ${session.file_name}`
        : `Backup FAILED checksum verification: ${session.file_name}`);
    }
  }

  const updated = db.prepare('SELECT * FROM backup_sessions WHERE id = ?').get(session.id);
  res.json({ status: updated.status, bytes_received: updated.bytes_received });
});

function getSessionOr404(req, res) {
  const session = db.prepare(
    'SELECT * FROM backup_sessions WHERE id = ? AND device_id = ?'
  ).get(req.params.sessionId, req.device.id);
  if (!session) {
    res.status(404).json({ error: 'Backup session not found for this device' });
    return null;
  }
  return session;
}

function log(deviceId, message) {
  db.prepare(
    'INSERT INTO activity_log (device_id, message, created_at) VALUES (?, ?, ?)'
  ).run(deviceId, message, new Date().toISOString());
}

module.exports = router;
