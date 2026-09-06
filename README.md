# Fleet backup API

Backend for the company device backup system. Handles device enrollment and
resumable chunked uploads of contacts, call logs, media, and chat exports —
built so a field employee's dropped mobile connection resumes automatically
instead of restarting the whole backup.

## Run it

```
npm install
npm start
```

Runs on port 4000 by default (set `PORT` to change). Uses SQLite, stored at
`db/fleet.db` — no external database server needed. Fine for a fleet up to a
few hundred devices; swap in Postgres later if you outgrow it.

## See it working with 5 real employees right now

With the server running (`npm start`, in a separate terminal), run:

```
node seed-demo.js
```

This enrolls 5 sample field employees and backs up realistic contacts, call
log, and media data for each through the actual resumable upload protocol —
the same code path a real phone would use. One employee's upload is
deliberately interrupted partway through and resumes automatically, so you
can see the reconnect-and-resume behavior actually happen, not just take it
on faith. It prints a verification summary at the end confirming every
file's checksum matches after upload — proof nothing was corrupted or lost.

Then open `dashboard-live.html` (in the demo folder) in a browser — it reads
directly from this running server, so you'll see these 5 employees' real
backup data, live.

This was already run once in development and verified working end to end
(all 5 employees, all checksums verified, including the simulated drop) —
running it yourself will reproduce the same result with fresh random data.

## How to test it manually

1. Enroll a device:
```
curl -X POST http://localhost:4000/devices/enroll \
  -H "Content-Type: application/json" \
  -d '{"employee_name":"Ritika Sharma","imei":"356938035643809","model":"Samsung Galaxy A54"}'
```
This returns a `device_token` — the phone app stores this and sends it as the
`X-Device-Token` header on every request after.

2. Start a backup session for a file:
```
curl -X POST http://localhost:4000/uploads/init \
  -H "X-Device-Token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"content_type":"contacts","file_name":"contacts.json","total_size_bytes":5000}'
```

3. Upload chunks (repeat with increasing offset until the file is done):
```
curl -X PATCH http://localhost:4000/uploads/<session_id> \
  -H "X-Device-Token: <token>" \
  -H "X-Chunk-Index: 0" \
  -H "X-Byte-Offset: 0" \
  --data-binary @chunk0.bin
```

4. If the connection drops, check where to resume from before continuing:
```
curl http://localhost:4000/uploads/<session_id>/status -H "X-Device-Token: <token>"
```
The response's `resume_from_byte` is exactly where the next chunk should start.
Re-sending an already-received chunk index is safe — it's ignored, not duplicated.

## What's not built yet (for your developer)

- **Auth for the admin dashboard itself** — this only covers device auth.
  Add a login for your IT/HR staff (e.g. a simple email+password with sessions,
  or SSO if your company already has it).
- **File storage** — currently writes to a local `storage/` folder. For
  production, swap the `fs.writeSync` calls in `routes/uploads.js` for S3 (or
  equivalent) so backups survive a server disk failure.
- **Encryption at rest** — turn on server-side encryption on whatever storage
  you move to; this matters given the data is contacts/call logs/chat content.
- **Remote lock/wipe/locate** — the demo dashboard shows these as buttons;
  they need a corresponding command channel to the phone app (the phone app
  polls for pending commands, or you use Firebase Cloud Messaging to push them).
