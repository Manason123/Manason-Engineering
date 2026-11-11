'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ExcelJS = require('exceljs');
const E = require('./engine');
const S = require('./services');
const V = require('./validate');
const { audit } = require('./db');
const { ROLES, passwordProblem, publicUser, hash } = require('./auth');

const { HttpError, bad } = V;
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic)|application\/pdf|application\/vnd\.(openxmlformats|ms-excel|ms-word).*|application\/msword|text\/plain|text\/csv)$/;

module.exports = function coreRoutes({ db, auth, uploadDir }) {
  const r = express.Router();
  const tx = (fn) => db.transaction(fn)();
  const wrap = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
  const intParam = (v, n = 'id') => { const x = Number(v); if (!Number.isInteger(x) || x < 1) throw bad(`${n} is invalid`); return x; };

  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname).toLowerCase().slice(0, 8)),
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 10 },
    fileFilter: (_q, f, cb) => (ALLOWED_MIME.test(f.mimetype) ? cb(null, true) : cb(new HttpError(400, `File type not allowed: ${f.mimetype}`))),
  });
  const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  // ---------- auth ----------
  r.post('/auth/login', wrap((req, res) => res.json(auth.login(req.body.email, req.body.password))));
  r.get('/me', auth.requireAuth, (req, res) => res.json(publicUser(req.user)));
  r.post('/me/password', auth.requireAuth, wrap((req, res) => {
    const { current, next } = req.body;
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    const p = passwordProblem(next); if (p) throw bad(p);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(next), req.user.id);
    audit(db, { user: req.user, action: 'password_change', entity: 'user', entity_id: req.user.id });
    res.json({ ok: true });
  }));
  r.patch('/me', auth.requireAuth, wrap((req, res) => {
    const lang = V.oneOf(req.body.lang, 'lang', ['en', 'rw', 'fr']);
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
    res.json({ ok: true, lang });
  }));

  // Public: ask for an account. Same answer whether or not the email exists (no account enumeration).
  r.post('/auth/register', wrap((req, res) => {
    const b = req.body || {};
    const name = V.str(b.name, 'name', { max: 120 });
    const email = V.str(b.email, 'email', { max: 200 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email is invalid');
    const pe = passwordProblem(b.password); if (pe) throw bad(pe);
    const phone = V.str(b.phone, 'phone', { required: false, max: 40 });
    const message = V.str(b.message, 'message', { required: false, max: 500 });
    const taken = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)
      || db.prepare("SELECT 1 FROM access_requests WHERE lower(email) = ? AND status = 'pending'").get(email);
    if (!taken) {
      const id = db.prepare('INSERT INTO access_requests(name,email,phone,message,password_hash) VALUES (?,?,?,?,?)').run(name, email, phone, message, hash(b.password)).lastInsertRowid;
      audit(db, { user: null, action: 'request', entity: 'access_request', entity_id: id, after: { name, email } });
    }
    res.status(202).json({ ok: true });
  }));

  r.use(auth.requireAuth);

  // ---------- users ----------
  r.get('/users', auth.roles('owner', 'admin', 'project_manager'), (req, res) =>
    res.json(db.prepare('SELECT id,name,email,role,lang,active FROM users ORDER BY name').all()));
  // ---------- access requests (owner/admin) ----------
  r.get('/access-requests', auth.roles('owner', 'admin'), (req, res) =>
    res.json(db.prepare("SELECT id,name,email,phone,message,status,created_at,decision_note FROM access_requests ORDER BY (status='pending') DESC, id DESC LIMIT 200").all()));
  r.post('/access-requests/:id/decide', auth.roles('owner', 'admin'), wrap((req, res) => {
    const ar = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(intParam(req.params.id));
    if (!ar) throw new HttpError(404, 'Request not found');
    if (ar.status !== 'pending') throw new HttpError(409, `Already ${ar.status}`);
    const approve = req.body.approve === true;
    const note = V.str(req.body.note, 'note', { required: !approve, max: 500 });
    let userId = null;
    tx(() => {
      if (approve) {
        const role = V.oneOf(req.body.role, 'role', ROLES);
        if (role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only an owner can create owners');
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(ar.email)) throw new HttpError(409, 'Email already registered');
        userId = db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)').run(ar.name, ar.email, ar.password_hash, role).lastInsertRowid;
        const ids = Array.isArray(req.body.project_ids) ? req.body.project_ids : [];
        for (const pid of ids) {
          const p = intParam(pid, 'project_id');
          if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(p)) throw new HttpError(404, `Project ${p} not found`);
          db.prepare('INSERT OR IGNORE INTO project_members(project_id,user_id) VALUES (?,?)').run(p, userId);
        }
        audit(db, { user: req.user, action: 'create', entity: 'user', entity_id: userId, after: { email: ar.email, role, via: 'access_request', projects: ids } });
      }
      db.prepare("UPDATE access_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, note, ar.id);
      audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'access_request', entity_id: ar.id, reason: note });
    });
    res.json({ ok: true, user_id: userId });
  }));

  r.post('/users', auth.roles('owner', 'admin'), wrap((req, res) => {
    const b = req.body;
    const name = V.str(b.name, 'name', { max: 120 });
    const email = V.str(b.email, 'email', { max: 200 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email is invalid');
    const role = V.oneOf(b.role, 'role', ROLES);
    if (role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only an owner can create owners');
    const pe = passwordProblem(b.password); if (pe) throw bad(pe);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Email already registered');
    const lang = V.oneOf(b.lang || 'en', 'lang', ['en', 'rw', 'fr']);
    const id = db.prepare('INSERT INTO users(name,email,password_hash,role,lang) VALUES (?,?,?,?,?)').run(name, email, hash(b.password), role, lang).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'user', entity_id: id, after: { name, email, role } });
    res.status(201).json({ id });
  }));
  r.patch('/users/:id', auth.roles('owner', 'admin'), wrap((req, res) => {
    const id = intParam(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only an owner can change an owner');
    const b = req.body;
    const reason = V.reason(b.reason);
    const role = b.role ? V.oneOf(b.role, 'role', ROLES) : u.role;
    if (role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only an owner can grant owner');
    const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
    if (id === req.user.id && (!active || role !== u.role)) throw bad('You cannot disable or change your own role');
    let ph = u.password_hash;
    if (b.password) { const pe = passwordProblem(b.password); if (pe) throw bad(pe); ph = hash(b.password); }
    db.prepare('UPDATE users SET role=?, active=?, password_hash=?, name=? WHERE id=?').run(role, active, ph, b.name ? V.str(b.name, 'name') : u.name, id);
    audit(db, { user: req.user, action: 'update', entity: 'user', entity_id: id, reason, before: { role: u.role, active: u.active }, after: { role, active } });
    res.json({ ok: true });
  }));

  // ---------- projects ----------
  r.get('/projects', (req, res) => {
    const rows = auth.isGlobal(req.user)
      ? db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
      : db.prepare('SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC').all(req.user.id);
    res.json(rows);
  });
  r.post('/projects', auth.roles('owner', 'admin'), wrap((req, res) => {
    const b = req.body;
    const p = {
      code: V.str(b.code, 'code', { max: 40 }), name: V.str(b.name, 'name', { max: 200 }),
      client_name: V.str(b.client_name, 'client_name', { required: false, max: 200 }),
      client_contact: V.str(b.client_contact, 'client_contact', { required: false, max: 200 }),
      location: V.str(b.location, 'location', { required: false, max: 200 }),
      contract_value: V.num(b.contract_value, 'contract_value', { min: 0 }),
      start_date: V.date(b.start_date, 'start_date'), end_date: V.date(b.end_date, 'end_date'),
      status: V.oneOf(b.status || 'planning', 'status', ['planning', 'active', 'on_hold', 'completed', 'cancelled']),
    };
    if (p.end_date < p.start_date) throw bad('end_date cannot be before start_date');
    if (db.prepare('SELECT 1 FROM projects WHERE code = ?').get(p.code)) throw new HttpError(409, 'Project code already exists');
    const id = tx(() => {
      const id = db.prepare(`INSERT INTO projects(code,name,client_name,client_contact,location,contract_value,start_date,end_date,status,created_by)
        VALUES (@code,@name,@client_name,@client_contact,@location,@contract_value,@start_date,@end_date,@status,@created_by)`)
        .run({ ...p, created_by: req.user.id }).lastInsertRowid;
      audit(db, { user: req.user, action: 'create', entity: 'project', entity_id: id, project_id: id, after: p });
      return id;
    });
    res.status(201).json({ id });
  }));
  r.get('/projects/:pid', auth.project('view'), (req, res) => {
    const members = db.prepare(`SELECT u.id,u.name,u.email,u.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`).all(req.project.id);
    res.json({ ...req.project, members });
  });
  r.patch('/projects/:pid', auth.project('project.manage'), wrap((req, res) => {
    const p = req.project; const b = req.body;
    const next = {
      name: b.name ? V.str(b.name, 'name', { max: 200 }) : p.name,
      client_name: b.client_name !== undefined ? V.str(b.client_name, 'client_name', { required: false }) : p.client_name,
      client_contact: b.client_contact !== undefined ? V.str(b.client_contact, 'client_contact', { required: false }) : p.client_contact,
      location: b.location !== undefined ? V.str(b.location, 'location', { required: false }) : p.location,
      status: b.status ? V.oneOf(b.status, 'status', ['planning', 'active', 'on_hold', 'completed', 'cancelled']) : p.status,
      start_date: b.start_date ? V.date(b.start_date, 'start_date') : p.start_date,
      end_date: b.end_date ? V.date(b.end_date, 'end_date') : p.end_date,
      contract_value: p.contract_value,
    };
    if (b.contract_value !== undefined && Number(b.contract_value) !== p.contract_value) {
      if (!auth.isGlobal(req.user)) throw new HttpError(403, 'Only owner/admin can change contract value (use an approved variation instead)');
      next.contract_value = V.num(b.contract_value, 'contract_value', { min: 0 });
    }
    const reason = (next.contract_value !== p.contract_value || next.end_date !== p.end_date || next.status !== p.status) ? V.reason(b.reason) : null;
    if (next.end_date < next.start_date) throw bad('end_date cannot be before start_date');
    db.prepare(`UPDATE projects SET name=@name, client_name=@client_name, client_contact=@client_contact, location=@location, status=@status,
      start_date=@start_date, end_date=@end_date, contract_value=@contract_value WHERE id=@id`).run({ ...next, id: p.id });
    audit(db, { user: req.user, action: 'update', entity: 'project', entity_id: p.id, project_id: p.id, reason, before: p, after: next });
    res.json({ ok: true });
  }));

  r.post('/projects/:pid/members', auth.roles('owner', 'admin'), auth.project('view'), wrap((req, res) => {
    const uid = intParam(req.body.user_id, 'user_id');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(uid)) throw new HttpError(404, 'User not found');
    db.prepare('INSERT OR IGNORE INTO project_members(project_id,user_id) VALUES (?,?)').run(req.project.id, uid);
    audit(db, { user: req.user, action: 'assign', entity: 'project_member', entity_id: uid, project_id: req.project.id });
    res.status(201).json({ ok: true });
  }));
  r.delete('/projects/:pid/members/:uid', auth.roles('owner', 'admin'), auth.project('view'), wrap((req, res) => {
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.project.id, intParam(req.params.uid));
    audit(db, { user: req.user, action: 'unassign', entity: 'project_member', entity_id: Number(req.params.uid), project_id: req.project.id });
    res.json({ ok: true });
  }));

  // ---------- documents & photos ----------
  r.get('/projects/:pid/documents', auth.project('view'), (req, res) =>
    res.json(db.prepare('SELECT id,kind,original_name,mime,size,report_id,created_at FROM documents WHERE project_id = ? ORDER BY id DESC').all(req.project.id)));
  r.post('/projects/:pid/documents', auth.project('doc.upload'), upload.array('files', 10), wrap((req, res) => {
    if (!req.files || !req.files.length) throw bad('No files uploaded');
    const kind = V.oneOf(req.body.kind || 'document', 'kind', ['document', 'contract', 'drawing', 'photo', 'delivery_note', 'other']);
    const ids = req.files.map((f) => db.prepare(`INSERT INTO documents(project_id,kind,original_name,stored_name,mime,size,uploaded_by) VALUES (?,?,?,?,?,?,?)`)
      .run(req.project.id, kind, f.originalname.slice(0, 200), f.filename, f.mimetype, f.size, req.user.id).lastInsertRowid);
    audit(db, { user: req.user, action: 'upload', entity: 'document', project_id: req.project.id, after: { ids } });
    res.status(201).json({ ids });
  }));
  r.get('/projects/:pid/documents/:id/download', auth.project('view'), wrap((req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?').get(intParam(req.params.id), req.project.id);
    if (!d) throw new HttpError(404, 'Document not found');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.original_name)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(d.mime || 'application/octet-stream').sendFile(path.resolve(uploadDir, d.stored_name));
  }));

  // ---------- baseline: activities, resources, dependencies ----------
  const lockedMsg = 'Baseline is approved. Use budget variations or schedule revisions to change it.';
  const actBody = (b, p) => {
    const a = {
      code: V.str(b.code, 'code', { max: 40 }), name: V.str(b.name, 'name', { max: 300 }), unit: V.str(b.unit, 'unit', { max: 20 }),
      planned_qty: V.num(b.planned_qty, 'planned_qty', { gt: 0 }), rate: V.num(b.rate ?? 0, 'rate', { min: 0 }),
      budget_cost: V.num(b.budget_cost, 'budget_cost', { min: 0 }),
      planned_start: V.date(b.planned_start || p.start_date, 'planned_start'), planned_end: V.date(b.planned_end || p.end_date, 'planned_end'),
      productivity_per_day: V.num(b.productivity_per_day ?? 0, 'productivity_per_day', { min: 0 }),
    };
    if (a.planned_end < a.planned_start) throw bad('planned_end cannot be before planned_start');
    return a;
  };
  r.get('/projects/:pid/activities', auth.project('view'), (req, res) => {
    const acts = db.prepare('SELECT * FROM activities WHERE project_id = ? ORDER BY code').all(req.project.id);
    const deps = db.prepare('SELECT d.* FROM activity_deps d JOIN activities a ON a.id = d.activity_id WHERE a.project_id = ?').all(req.project.id);
    const resources = db.prepare(`SELECT ar.*, m.name AS material_name FROM activity_resources ar JOIN activities a ON a.id = ar.activity_id
      LEFT JOIN materials m ON m.id = ar.material_id WHERE a.project_id = ?`).all(req.project.id);
    res.json(acts.map((a) => ({
      ...a, deps: deps.filter((d) => d.activity_id === a.id).map((d) => d.depends_on_id),
      resources: resources.filter((x) => x.activity_id === a.id),
    })));
  });
  r.post('/projects/:pid/activities', auth.project('baseline.edit'), wrap((req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    const a = actBody(req.body, req.project);
    if (db.prepare('SELECT 1 FROM activities WHERE project_id = ? AND code = ?').get(req.project.id, a.code)) throw new HttpError(409, 'Activity code already exists');
    const id = db.prepare(`INSERT INTO activities(project_id,code,name,unit,planned_qty,rate,budget_cost,planned_start,planned_end,productivity_per_day)
      VALUES (@project_id,@code,@name,@unit,@planned_qty,@rate,@budget_cost,@planned_start,@planned_end,@productivity_per_day)`).run({ ...a, project_id: req.project.id }).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'activity', entity_id: id, project_id: req.project.id, after: a });
    res.status(201).json({ id });
  }));
  r.put('/projects/:pid/activities/:aid', auth.project('baseline.edit'), wrap((req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    const id = intParam(req.params.aid);
    const old = db.prepare('SELECT * FROM activities WHERE id = ? AND project_id = ?').get(id, req.project.id);
    if (!old) throw new HttpError(404, 'Activity not found');
    const a = actBody({ ...old, ...req.body }, req.project);
    db.prepare(`UPDATE activities SET code=@code,name=@name,unit=@unit,planned_qty=@planned_qty,rate=@rate,budget_cost=@budget_cost,
      planned_start=@planned_start,planned_end=@planned_end,productivity_per_day=@productivity_per_day WHERE id=@id`).run({ ...a, id });
    audit(db, { user: req.user, action: 'update', entity: 'activity', entity_id: id, project_id: req.project.id, before: old, after: a });
    res.json({ ok: true });
  }));
  r.delete('/projects/:pid/activities/:aid', auth.project('baseline.edit'), wrap((req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    const id = intParam(req.params.aid);
    const old = db.prepare('SELECT * FROM activities WHERE id = ? AND project_id = ?').get(id, req.project.id);
    if (!old) throw new HttpError(404, 'Activity not found');
    db.prepare('DELETE FROM activities WHERE id = ?').run(id);
    audit(db, { user: req.user, action: 'delete', entity: 'activity', entity_id: id, project_id: req.project.id, before: old });
    res.json({ ok: true });
  }));

  r.post('/projects/:pid/activities/import', auth.project('baseline.edit'), memUpload.single('file'), wrap(async (req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    if (!req.file) throw bad('Excel file is required');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.file.buffer); } catch { throw bad('Could not read the Excel file (.xlsx expected)'); }
    const ws = wb.worksheets[0];
    if (!ws) throw bad('Workbook is empty');
    const head = {};
    ws.getRow(1).eachCell((c, i) => { head[String(c.value ?? '').trim().toLowerCase()] = i; });
    const col = (...names) => names.map((n) => head[n]).find(Boolean);
    const cCode = col('code', 'item', 'item no'), cName = col('description', 'name', 'activity'), cUnit = col('unit'),
      cQty = col('quantity', 'qty'), cRate = col('rate', 'unit rate'), cBud = col('budget', 'budget cost', 'budget_cost'),
      cStart = col('start', 'start date', 'planned_start'), cEnd = col('end', 'end date', 'planned_end'), cProd = col('productivity', 'productivity_per_day');
    if (!cCode || !cName || !cUnit || !cQty) throw bad('Header row must contain: Code, Description, Unit, Quantity (optional: Rate, Budget, Start, End, Productivity)');
    const cellVal = (row, c) => { if (!c) return undefined; const v = row.getCell(c).value; return v && typeof v === 'object' && 'result' in v ? v.result : (v instanceof Date ? v.toISOString().slice(0, 10) : v); };
    const parsed = []; const errors = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      if (!cellVal(row, cCode) && !cellVal(row, cName)) return;
      try {
        const qty = cellVal(row, cQty); const rate = cellVal(row, cRate) ?? 0;
        const budget = cellVal(row, cBud) ?? (Number(qty) * Number(rate));
        parsed.push(actBody({
          code: cellVal(row, cCode), name: cellVal(row, cName), unit: cellVal(row, cUnit), planned_qty: qty, rate, budget_cost: budget,
          planned_start: cellVal(row, cStart), planned_end: cellVal(row, cEnd), productivity_per_day: cellVal(row, cProd) ?? 0,
        }, req.project));
      } catch (e) { errors.push(`Row ${n}: ${e.message}`); }
    });
    if (errors.length) return res.status(400).json({ error: 'Import rejected. Nothing was saved.', details: errors.slice(0, 50) });
    if (!parsed.length) throw bad('No activity rows found');
    const codes = new Set(); for (const a of parsed) { if (codes.has(a.code)) throw bad(`Duplicate code in file: ${a.code}`); codes.add(a.code); }
    const exist = db.prepare('SELECT code FROM activities WHERE project_id = ?').all(req.project.id).map((x) => x.code);
    const dup = parsed.filter((a) => exist.includes(a.code)).map((a) => a.code);
    if (dup.length) throw new HttpError(409, `Codes already exist: ${dup.slice(0, 10).join(', ')}`);
    tx(() => {
      const ins = db.prepare(`INSERT INTO activities(project_id,code,name,unit,planned_qty,rate,budget_cost,planned_start,planned_end,productivity_per_day)
        VALUES (@project_id,@code,@name,@unit,@planned_qty,@rate,@budget_cost,@planned_start,@planned_end,@productivity_per_day)`);
      for (const a of parsed) ins.run({ ...a, project_id: req.project.id });
      audit(db, { user: req.user, action: 'import', entity: 'boq', project_id: req.project.id, after: { rows: parsed.length } });
    });
    res.status(201).json({ imported: parsed.length });
  }));

  r.post('/projects/:pid/activities/:aid/deps', auth.project('baseline.edit'), wrap((req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    const a = intParam(req.params.aid), d = intParam(req.body.depends_on_id, 'depends_on_id');
    const ok = (id) => db.prepare('SELECT 1 FROM activities WHERE id = ? AND project_id = ?').get(id, req.project.id);
    if (!ok(a) || !ok(d)) throw new HttpError(404, 'Activity not found');
    if (a === d) throw bad('An activity cannot depend on itself');
    // cycle check: does d (transitively) depend on a?
    const seen = new Set(); const stack = [d];
    while (stack.length) {
      const x = stack.pop(); if (x === a) throw bad('This dependency would create a cycle');
      if (seen.has(x)) continue; seen.add(x);
      for (const y of db.prepare('SELECT depends_on_id FROM activity_deps WHERE activity_id = ?').all(x)) stack.push(y.depends_on_id);
    }
    db.prepare('INSERT OR IGNORE INTO activity_deps(activity_id,depends_on_id) VALUES (?,?)').run(a, d);
    audit(db, { user: req.user, action: 'create', entity: 'activity_dep', entity_id: a, project_id: req.project.id, after: { depends_on_id: d } });
    res.status(201).json({ ok: true });
  }));
  r.delete('/projects/:pid/activities/:aid/deps/:did', auth.project('baseline.edit'), wrap((req, res) => {
    if (req.project.baseline_approved) throw new HttpError(409, lockedMsg);
    db.prepare('DELETE FROM activity_deps WHERE activity_id = ? AND depends_on_id = ?').run(intParam(req.params.aid), intParam(req.params.did));
    res.json({ ok: true });
  }));

  r.post('/projects/:pid/activities/:aid/resources', auth.project('baseline.edit'), wrap((req, res) => {
    const aid = intParam(req.params.aid);
    if (!db.prepare('SELECT 1 FROM activities WHERE id = ? AND project_id = ?').get(aid, req.project.id)) throw new HttpError(404, 'Activity not found');
    const b = req.body; const type = V.oneOf(b.type, 'type', ['material', 'labour', 'equipment']);
    let material_id = null; let name = V.str(b.name, 'name', { required: type !== 'material', max: 200 });
    if (type === 'material') {
      material_id = intParam(b.material_id, 'material_id');
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(material_id); if (!m) throw new HttpError(404, 'Material not found');
      name = m.name; b.unit = b.unit || m.unit;
    }
    const id = db.prepare('INSERT INTO activity_resources(activity_id,type,material_id,name,unit,qty_per_unit,unit_cost) VALUES (?,?,?,?,?,?,?)')
      .run(aid, type, material_id, name, V.str(b.unit, 'unit', { max: 20 }), V.num(b.qty_per_unit, 'qty_per_unit', { min: 0 }), V.num(b.unit_cost ?? 0, 'unit_cost', { min: 0 })).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'activity_resource', entity_id: id, project_id: req.project.id, after: b });
    res.status(201).json({ id });
  }));
  r.delete('/projects/:pid/activities/:aid/resources/:rid', auth.project('baseline.edit'), wrap((req, res) => {
    db.prepare('DELETE FROM activity_resources WHERE id = ? AND activity_id = ?').run(intParam(req.params.rid), intParam(req.params.aid));
    res.json({ ok: true });
  }));

  r.post('/projects/:pid/baseline/approve', auth.roles('owner', 'admin', 'project_manager'), auth.project('baseline.edit'), wrap((req, res) => {
    const p = req.project;
    if (p.baseline_approved) throw new HttpError(409, 'Baseline already approved');
    const acts = db.prepare('SELECT * FROM activities WHERE project_id = ?').all(p.id);
    if (!acts.length) throw bad('Add at least one activity before approving the baseline');
    const total = acts.reduce((s, a) => s + a.budget_cost, 0);
    const id = tx(() => {
      const bid = db.prepare('INSERT INTO baselines(project_id,version,approved_by,total_budget,contract_value) VALUES (?,1,?,?,?)').run(p.id, req.user.id, total, p.contract_value).lastInsertRowid;
      const ins = db.prepare('INSERT INTO baseline_activities(baseline_id,activity_id,code,name,planned_qty,budget_cost,planned_start,planned_end) VALUES (?,?,?,?,?,?,?,?)');
      for (const a of acts) ins.run(bid, a.id, a.code, a.name, a.planned_qty, a.budget_cost, a.planned_start, a.planned_end);
      db.prepare("UPDATE projects SET baseline_approved = 1, status = CASE WHEN status = 'planning' THEN 'active' ELSE status END WHERE id = ?").run(p.id);
      audit(db, { user: req.user, action: 'approve', entity: 'baseline', entity_id: bid, project_id: p.id, after: { total_budget: total, activities: acts.length } });
      return bid;
    });
    res.status(201).json({ baseline_id: id, total_budget: E.round2(total) });
  }));
  r.get('/projects/:pid/baseline', auth.project('view'), (req, res) => {
    const b = db.prepare('SELECT * FROM baselines WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(req.project.id);
    if (!b) return res.json(null);
    res.json({ ...b, activities: db.prepare('SELECT * FROM baseline_activities WHERE baseline_id = ? ORDER BY code').all(b.id) });
  });

  // ---------- budget variations ----------
  r.get('/projects/:pid/variations', auth.project('view'), (req, res) =>
    res.json(db.prepare('SELECT v.*, u.name AS requested_by_name FROM budget_variations v LEFT JOIN users u ON u.id = v.requested_by WHERE project_id = ? ORDER BY v.id DESC').all(req.project.id)
      .map((v) => ({ ...v, basis: v.status === 'approved' ? 'actual' : 'awaiting_approval' }))));
  r.post('/projects/:pid/variations', auth.project('variation.request'), wrap((req, res) => {
    const b = req.body; let activity_id = null;
    if (b.activity_id) { activity_id = intParam(b.activity_id, 'activity_id'); if (!db.prepare('SELECT 1 FROM activities WHERE id = ? AND project_id = ?').get(activity_id, req.project.id)) throw new HttpError(404, 'Activity not found'); }
    const v = { cost_amount: V.num(b.cost_amount, 'cost_amount'), revenue_amount: V.num(b.revenue_amount ?? 0, 'revenue_amount'), reason: V.reason(b.reason) };
    if (v.cost_amount === 0 && v.revenue_amount === 0) throw bad('A variation must change cost or revenue');
    const id = db.prepare('INSERT INTO budget_variations(project_id,activity_id,cost_amount,revenue_amount,reason,requested_by) VALUES (?,?,?,?,?,?)')
      .run(req.project.id, activity_id, v.cost_amount, v.revenue_amount, v.reason, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'request', entity: 'budget_variation', entity_id: id, project_id: req.project.id, reason: v.reason, after: { ...v, activity_id } });
    res.status(201).json({ id, status: 'pending' });
  }));
  r.post('/projects/:pid/variations/:id/decide', auth.roles('owner', 'admin'), auth.project('view'), wrap((req, res) => {
    const v = db.prepare('SELECT * FROM budget_variations WHERE id = ? AND project_id = ?').get(intParam(req.params.id), req.project.id);
    if (!v) throw new HttpError(404, 'Variation not found');
    if (v.status !== 'pending') throw new HttpError(409, `Already ${v.status}`);
    const approve = req.body.approve === true;
    const note = approve ? V.str(req.body.note, 'note', { required: false }) : V.str(req.body.note, 'note');
    db.prepare("UPDATE budget_variations SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, note, v.id);
    audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'budget_variation', entity_id: v.id, project_id: req.project.id, reason: note, before: { status: 'pending' }, after: { status: approve ? 'approved' : 'rejected' } });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));

  // ---------- schedule: forecast and revisions ----------
  r.get('/projects/:pid/schedule', auth.project('view'), (req, res) => {
    const m = S.metricsFor(db, req.project, V.today());
    res.json({ today: m.today, delay_days: m.schedule.delay_days, forecast_end: m.schedule.forecast_end, planned_end: m.schedule.planned_end,
      activities: m.activities.map((a) => ({ id: a.id, code: a.code, name: a.name, progress_pct: a.progress_pct, ...a.schedule, basis: 'forecast' })) });
  });
  r.get('/projects/:pid/revisions', auth.project('view'), (req, res) =>
    res.json(db.prepare('SELECT * FROM schedule_revisions WHERE project_id = ? ORDER BY id DESC').all(req.project.id).map((x) => ({ ...x, proposal: JSON.parse(x.proposal_json), proposal_json: undefined }))));
  r.post('/projects/:pid/revisions/propose', auth.project('revision.request'), wrap((req, res) => {
    const m = S.metricsFor(db, req.project, V.today());
    const proposal = E.proposeRevision(m);
    if (!proposal.length) throw new HttpError(409, 'No schedule change is needed: no delayed activities');
    if (db.prepare("SELECT 1 FROM schedule_revisions WHERE project_id = ? AND status = 'pending'").get(req.project.id)) throw new HttpError(409, 'A revision is already awaiting approval');
    const reason = V.reason(req.body.reason);
    const id = db.prepare('INSERT INTO schedule_revisions(project_id,reason,proposal_json,requested_by) VALUES (?,?,?,?)').run(req.project.id, reason, JSON.stringify(proposal), req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'request', entity: 'schedule_revision', entity_id: id, project_id: req.project.id, reason, after: proposal });
    res.status(201).json({ id, status: 'pending', proposal });
  }));
  r.post('/projects/:pid/revisions/:id/decide', auth.project('revision.approve'), wrap((req, res) => {
    const rev = db.prepare('SELECT * FROM schedule_revisions WHERE id = ? AND project_id = ?').get(intParam(req.params.id), req.project.id);
    if (!rev) throw new HttpError(404, 'Revision not found');
    if (rev.status !== 'pending') throw new HttpError(409, `Already ${rev.status}`);
    const approve = req.body.approve === true;
    const note = V.str(req.body.note, 'note', { required: !approve });
    tx(() => {
      if (approve) {
        const up = db.prepare('UPDATE activities SET planned_start = ?, planned_end = ? WHERE id = ? AND project_id = ?');
        for (const c of JSON.parse(rev.proposal_json)) up.run(c.new_start, c.new_end, c.activity_id, req.project.id); // baseline_activities stay untouched
      }
      db.prepare("UPDATE schedule_revisions SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, rev.id);
      audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'schedule_revision', entity_id: rev.id, project_id: req.project.id, reason: note });
    });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));

  // ---------- daily reports ----------
  const loadReport = (id, pid) => {
    const rep = db.prepare('SELECT * FROM daily_reports WHERE id = ? AND project_id = ?').get(id, pid);
    if (!rep) throw new HttpError(404, 'Report not found');
    return rep;
  };
  const fullReport = (rep) => ({
    ...rep,
    lines: db.prepare('SELECT rl.*, a.code, a.name, a.unit FROM report_lines rl JOIN activities a ON a.id = rl.activity_id WHERE report_id = ?').all(rep.id),
    labour: db.prepare('SELECT * FROM report_labour WHERE report_id = ?').all(rep.id),
    materials: db.prepare('SELECT rm.*, m.name, m.unit FROM report_materials rm JOIN materials m ON m.id = rm.material_id WHERE report_id = ?').all(rep.id),
    equipment: db.prepare('SELECT * FROM report_equipment WHERE report_id = ?').all(rep.id),
    photos: db.prepare('SELECT id,original_name,mime,kind FROM documents WHERE report_id = ?').all(rep.id),
  });
  const writeReportParts = (rep, b, pid) => {
    const actOk = (id) => { if (!db.prepare('SELECT 1 FROM activities WHERE id = ? AND project_id = ?').get(id, pid)) throw bad(`Activity ${id} is not in this project`); return id; };
    db.prepare('DELETE FROM report_lines WHERE report_id = ?').run(rep);
    db.prepare('DELETE FROM report_labour WHERE report_id = ?').run(rep);
    db.prepare('DELETE FROM report_materials WHERE report_id = ?').run(rep);
    db.prepare('DELETE FROM report_equipment WHERE report_id = ?').run(rep);
    const seen = new Set();
    for (const l of b.lines || []) {
      const aid = actOk(intParam(l.activity_id, 'activity_id')); if (seen.has(aid)) throw bad('Duplicate activity in report lines'); seen.add(aid);
      db.prepare('INSERT INTO report_lines(report_id,activity_id,planned_qty,completed_qty) VALUES (?,?,?,?)').run(rep, aid, V.num(l.planned_qty ?? 0, 'planned_qty', { min: 0 }), V.num(l.completed_qty ?? 0, 'completed_qty', { min: 0 }));
    }
    for (const l of b.labour || []) db.prepare('INSERT INTO report_labour(report_id,activity_id,trade,workers,hours,hourly_rate) VALUES (?,?,?,?,?,?)')
      .run(rep, l.activity_id ? actOk(intParam(l.activity_id)) : null, V.str(l.trade, 'trade', { max: 80 }), V.num(l.workers, 'workers', { min: 0 }), V.num(l.hours, 'hours', { min: 0, max: 24 }), V.num(l.hourly_rate ?? 0, 'hourly_rate', { min: 0 }));
    for (const l of b.materials || []) {
      const mid = intParam(l.material_id, 'material_id'); if (!db.prepare('SELECT 1 FROM materials WHERE id = ?').get(mid)) throw bad(`Material ${mid} not found`);
      db.prepare('INSERT INTO report_materials(report_id,activity_id,material_id,qty_consumed,qty_wasted) VALUES (?,?,?,?,?)')
        .run(rep, l.activity_id ? actOk(intParam(l.activity_id)) : null, mid, V.num(l.qty_consumed ?? 0, 'qty_consumed', { min: 0 }), V.num(l.qty_wasted ?? 0, 'qty_wasted', { min: 0 }));
    }
    for (const l of b.equipment || []) db.prepare('INSERT INTO report_equipment(report_id,activity_id,name,hours,hourly_rate) VALUES (?,?,?,?,?)')
      .run(rep, l.activity_id ? actOk(intParam(l.activity_id)) : null, V.str(l.name, 'name', { max: 120 }), V.num(l.hours, 'hours', { min: 0, max: 24 }), V.num(l.hourly_rate ?? 0, 'hourly_rate', { min: 0 }));
  };
  r.get('/projects/:pid/reports', auth.project('view'), (req, res) =>
    res.json(db.prepare(`SELECT r.*, u.name AS submitted_by_name,
      (SELECT COALESCE(SUM(workers),0) FROM report_labour WHERE report_id = r.id) AS workers
      FROM daily_reports r LEFT JOIN users u ON u.id = r.submitted_by WHERE project_id = ? ORDER BY report_date DESC`).all(req.project.id)));
  r.get('/projects/:pid/reports/:id', auth.project('view'), wrap((req, res) => res.json(fullReport(loadReport(intParam(req.params.id), req.project.id)))));
  r.post('/projects/:pid/reports', auth.project('report.write'), wrap((req, res) => {
    const b = req.body;
    if (!req.project.baseline_approved) throw new HttpError(409, 'Approve the project baseline before submitting site reports');
    const report_date = V.date(b.report_date, 'report_date');
    if (report_date > V.today()) throw bad('Report date cannot be in the future');
    if (db.prepare('SELECT 1 FROM daily_reports WHERE project_id = ? AND report_date = ?').get(req.project.id, report_date)) throw new HttpError(409, 'A report already exists for this date');
    const id = tx(() => {
      const id = db.prepare('INSERT INTO daily_reports(project_id,report_date,weather,delays,problems,submitted_by,status) VALUES (?,?,?,?,?,?,?)')
        .run(req.project.id, report_date, V.str(b.weather, 'weather', { required: false }), V.str(b.delays, 'delays', { required: false, max: 2000 }), V.str(b.problems, 'problems', { required: false, max: 2000 }), req.user.id, b.submit ? 'submitted' : 'draft').lastInsertRowid;
      writeReportParts(id, b, req.project.id);
      audit(db, { user: req.user, action: b.submit ? 'submit' : 'create', entity: 'daily_report', entity_id: id, project_id: req.project.id, after: { report_date } });
      return id;
    });
    res.status(201).json({ id, status: b.submit ? 'submitted' : 'draft' });
  }));
  r.put('/projects/:pid/reports/:id', auth.project('report.write'), wrap((req, res) => {
    const rep = loadReport(intParam(req.params.id), req.project.id);
    if (!['draft', 'rejected'].includes(rep.status)) throw new HttpError(409, `A ${rep.status} report cannot be edited`);
    if (rep.submitted_by !== req.user.id && !auth.isGlobal(req.user)) throw new HttpError(403, 'Only the author can edit this report');
    const b = req.body;
    tx(() => {
      db.prepare('UPDATE daily_reports SET weather=?, delays=?, problems=?, status=? WHERE id=?')
        .run(V.str(b.weather, 'weather', { required: false }), V.str(b.delays, 'delays', { required: false, max: 2000 }), V.str(b.problems, 'problems', { required: false, max: 2000 }), b.submit ? 'submitted' : 'draft', rep.id);
      writeReportParts(rep.id, b, req.project.id);
      audit(db, { user: req.user, action: b.submit ? 'submit' : 'update', entity: 'daily_report', entity_id: rep.id, project_id: req.project.id });
    });
    res.json({ ok: true });
  }));
  r.post('/projects/:pid/reports/:id/submit', auth.project('report.write'), wrap((req, res) => {
    const rep = loadReport(intParam(req.params.id), req.project.id);
    if (!['draft', 'rejected'].includes(rep.status)) throw new HttpError(409, `Report is ${rep.status}`);
    db.prepare("UPDATE daily_reports SET status = 'submitted' WHERE id = ?").run(rep.id);
    audit(db, { user: req.user, action: 'submit', entity: 'daily_report', entity_id: rep.id, project_id: req.project.id });
    res.json({ ok: true });
  }));
  r.post('/projects/:pid/reports/:id/review', auth.project('report.approve'), wrap((req, res) => {
    const rep = loadReport(intParam(req.params.id), req.project.id);
    if (rep.status !== 'submitted') throw new HttpError(409, `Only submitted reports can be reviewed (this one is ${rep.status})`);
    if (rep.submitted_by === req.user.id && !auth.isGlobal(req.user)) throw new HttpError(403, 'You cannot approve your own report');
    const approve = req.body.approve === true;
    const note = V.str(req.body.note, 'note', { required: !approve, max: 1000 });
    tx(() => {
      if (approve) S.applyApprovedReport(db, rep, req.user);
      db.prepare("UPDATE daily_reports SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, note, rep.id);
      audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'daily_report', entity_id: rep.id, project_id: req.project.id, reason: note });
    });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));
  r.post('/projects/:pid/reports/:id/photos', auth.project('doc.upload'), upload.array('files', 10), wrap((req, res) => {
    const rep = loadReport(intParam(req.params.id), req.project.id);
    if (rep.status === 'approved') throw new HttpError(409, 'Approved reports cannot receive new attachments');
    if (!req.files || !req.files.length) throw bad('No files uploaded');
    const ids = req.files.map((f) => db.prepare('INSERT INTO documents(project_id,kind,original_name,stored_name,mime,size,report_id,uploaded_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.project.id, f.mimetype.startsWith('image/') ? 'photo' : 'document', f.originalname.slice(0, 200), f.filename, f.mimetype, f.size, rep.id, req.user.id).lastInsertRowid);
    audit(db, { user: req.user, action: 'upload', entity: 'daily_report', entity_id: rep.id, project_id: req.project.id, after: { ids } });
    res.status(201).json({ ids });
  }));

  return r;
};
