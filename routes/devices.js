const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');

const router = express.Router();

// IT/admin calls this once per phone when handing it to an employee.
// Returns a device_token the phone's backup app stores and sends on every request after.
router.post('/enroll', (req, res) => {
  const { employee_name, imei, model } = req.body;
  if (!employee_name || !imei) {
    return res.status(400).json({ error: 'employee_name and imei are required' });
  }

  const existing = db.prepare('SELECT * FROM devices WHERE imei = ?').get(imei);
  if (existing) {
    return res.status(409).json({ error: 'A device with this IMEI is already enrolled' });
  }

  const id = uuidv4();
  const device_token = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO devices (id, employee_name, imei, model, enrolled_at, device_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, employee_name, imei, model || null, now, device_token);

  res.status(201).json({ device_id: id, device_token });
});

// Admin dashboard: list all devices with their latest backup status.
router.get('/', (req, res) => {
  const devices = db.prepare(`
    SELECT d.id, d.employee_name, d.imei, d.model, d.last_seen_at,
           (SELECT status FROM backup_sessions WHERE device_id = d.id ORDER BY started_at DESC LIMIT 1) AS latest_status,
           (SELECT completed_at FROM backup_sessions WHERE device_id = d.id AND status = 'complete' ORDER BY completed_at DESC LIMIT 1) AS last_backup_at
    FROM devices d
    ORDER BY d.enrolled_at DESC
  `).all();
  res.json(devices);
});

// Admin dashboard: full detail for one device, including a per-content-type
// summary (contacts/call log/media/chat counts) and recent activity.
router.get('/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const sessions = db.prepare(`
    SELECT content_type, file_name, item_count, bytes_received, total_size_bytes, status, completed_at
    FROM backup_sessions
    WHERE device_id = ?
    ORDER BY started_at DESC
  `).all(device.id);

  const activity = db.prepare(`
    SELECT message, created_at FROM activity_log
    WHERE device_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(device.id);

  res.json({ ...device, sessions, activity });
});

// Middleware other routes use to authenticate a device by its token.
function requireDeviceAuth(req, res, next) {
  const token = req.header('X-Device-Token');
  if (!token) return res.status(401).json({ error: 'Missing X-Device-Token header' });

  const device = db.prepare('SELECT * FROM devices WHERE device_token = ?').get(token);
  if (!device) return res.status(401).json({ error: 'Invalid device token' });

  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);
  req.device = device;
  next();
}

module.exports = { router, requireDeviceAuth };
