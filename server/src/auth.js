'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { HttpError } = require('./validate');
const { audit } = require('./db');

const ROLES = ['owner', 'admin', 'project_manager', 'engineer', 'storekeeper', 'accountant', 'viewer'];

// Permission matrix. Owner/admin may act on every project; others only on assigned projects.
const PERMS = {
  owner: ['*'],
  admin: ['*'],
  project_manager: ['view', 'project.manage', 'baseline.edit', 'report.write', 'report.approve', 'request.create', 'request.approve',
    'po.manage', 'finance.view', 'variation.request', 'revision.request', 'revision.approve', 'stock.view', 'doc.upload'],
  engineer: ['view', 'report.write', 'request.create', 'stock.view', 'doc.upload', 'variation.request'],
  storekeeper: ['view', 'request.create', 'delivery.confirm', 'stock.issue', 'stock.view', 'doc.upload'],
  accountant: ['view', 'finance.view', 'finance.write', 'po.manage', 'stock.view', 'doc.upload'],
  viewer: ['view', 'stock.view'],
};
const GLOBAL_ROLES = ['owner', 'admin'];

function hasPerm(role, perm) {
  const p = PERMS[role] || [];
  return p.includes('*') || p.includes(perm);
}

function loadSecret(dataDir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!dataDir) return crypto.randomBytes(32).toString('hex');
  const f = path.join(dataDir, '.jwt_secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and digits';
  return null;
}

function makeAuth(db, secret) {
  const sign = (u) => jwt.sign({ sub: u.id }, secret, { expiresIn: '8h' });

  function login(email, password) {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    const fail = () => new HttpError(401, 'Invalid email or password');
    if (!u || !u.active) throw fail();
    if (u.locked_until && new Date(u.locked_until + 'Z') > new Date()) throw new HttpError(423, 'Account temporarily locked. Try again later.');
    if (!bcrypt.compareSync(String(password || ''), u.password_hash)) {
      const n = u.failed_logins + 1;
      if (n >= 5) {
        db.prepare("UPDATE users SET failed_logins = 0, locked_until = datetime('now','+15 minutes') WHERE id = ?").run(u.id);
      } else db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(n, u.id);
      throw fail();
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
    audit(db, { user: u, action: 'login', entity: 'user', entity_id: u.id });
    return { token: sign(u), user: publicUser(u) };
  }

  function requireAuth(req, _res, next) {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!token) throw new HttpError(401, 'Authentication required');
      let payload;
      try { payload = jwt.verify(token, secret); } catch { throw new HttpError(401, 'Session expired or invalid'); }
      const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(payload.sub);
      if (!u) throw new HttpError(401, 'User not found or disabled');
      req.user = u;
      next();
    } catch (e) { next(e); }
  }

  const isGlobal = (u) => GLOBAL_ROLES.includes(u.role);
  const isMember = (u, projectId) =>
    isGlobal(u) || !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, u.id);

  /** Route guard: project must exist, user must be assigned, and role must hold the permission. */
  function project(perm = 'view') {
    return (req, _res, next) => {
      try {
        const pid = Number(req.params.pid);
        const p = Number.isInteger(pid) ? db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) : null;
        if (!p || !isMember(req.user, pid)) throw new HttpError(404, 'Project not found');
        if (!hasPerm(req.user.role, perm)) throw new HttpError(403, `Your role cannot perform this action (${perm})`);
        req.project = p;
        next();
      } catch (e) { next(e); }
    };
  }
  function global(perm) {
    return (req, _res, next) => {
      if (!hasPerm(req.user.role, perm)) return next(new HttpError(403, `Your role cannot perform this action (${perm})`));
      next();
    };
  }
  function roles(...list) {
    return (req, _res, next) => (list.includes(req.user.role) ? next() : next(new HttpError(403, 'Not allowed for your role')));
  }

  return { login, requireAuth, project, global, roles, isGlobal, isMember };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, lang: u.lang, active: !!u.active };
}
const hash = (pw) => bcrypt.hashSync(pw, 10);

module.exports = { ROLES, PERMS, hasPerm, loadSecret, passwordProblem, makeAuth, publicUser, hash };
