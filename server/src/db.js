'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_THRESHOLDS } = require('./engine');

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) ins.run(k, String(v));
  return db;
}

function getThresholds(db) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in out) out[r.key] = Number(r.value);
  }
  return out;
}

/** Every important change goes through here: who, what, when, why, before/after. */
function audit(db, { user, action, entity, entity_id = null, project_id = null, reason = null, before = null, after = null }) {
  db.prepare(
    `INSERT INTO audit_log(user_id, action, entity, entity_id, project_id, reason, before_json, after_json)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    user ? user.id : null, action, entity, entity_id, project_id, reason,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
  );
}

module.exports = { openDb, getThresholds, audit };
