'use strict';
const path = require('path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { refreshAllAlerts } = require('./services');
const { runBackup } = require('./routes_ops');
const { hash } = require('./auth');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = openDb(path.join(dataDir, 'buildtrack.db'));

// First run: create the owner account from environment variables.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const email = process.env.ADMIN_EMAIL; const pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw || pw.length < 8) {
    console.error('First start: set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 chars) to create the owner account.'); // eslint-disable-line no-console
    process.exit(1);
  }
  db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?, 'owner')").run(process.env.ADMIN_NAME || 'Owner', email.toLowerCase(), hash(pw));
  console.log(`Owner account created: ${email}`); // eslint-disable-line no-console
}

const app = createApp(db, { dataDir });
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`BuildTrack Pro listening on :${port}`)); // eslint-disable-line no-console

const today = () => new Date().toISOString().slice(0, 10);
// Scheduled alerts: every hour. Backups: every 24 h (and once at start).
setInterval(() => { try { refreshAllAlerts(db, today()); } catch (e) { console.error('alert job', e); } }, 60 * 60 * 1000); // eslint-disable-line no-console
const backupDir = path.join(dataDir, 'backups');
const doBackup = () => runBackup(db, backupDir).catch((e) => console.error('backup failed', e)); // eslint-disable-line no-console
setInterval(doBackup, 24 * 60 * 60 * 1000);
setTimeout(doBackup, 5000);
try { refreshAllAlerts(db, today()); } catch (e) { console.error(e); } // eslint-disable-line no-console
