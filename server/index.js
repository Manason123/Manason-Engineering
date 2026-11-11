import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const {
  PORT = 4000,
  DATABASE_URL,
  JWT_SECRET,
  CORS_ORIGIN = '',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_NAME = 'Administrator',
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

// ---------- DB setup ----------
async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT,
      budget NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      start_date DATE,
      end_date DATE,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'todo',
      progress INT DEFAULT 0,
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      project_id INT REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      category TEXT,
      spent_on DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const email = ADMIN_EMAIL.trim().toLowerCase();
    const exists = await q('SELECT id FROM users WHERE email=$1', [email]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await q(
        `INSERT INTO users (name,email,password_hash,role,status) VALUES ($1,$2,$3,'admin','active')`,
        [ADMIN_NAME, email, hash]
      );
      console.log('Admin created:', email);
    }
  }
}

// ---------- App ----------
const app = express();
const origins = CORS_ORIGIN.split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '2mb' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/', (_req, res) => res.json({ name: 'BuildTrack API', ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- Auth helpers ----------
const sign = (u) =>
  jwt.sign({ id: u.id, role: u.role, email: u.email }, JWT_SECRET, { expiresIn: '7d' });

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
});

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

// ---------- Auth routes ----------
app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const r = await q('SELECT * FROM users WHERE email=$1', [email]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash)))
      return res.status(401).json({ error: 'Wrong email or password' });
    if (u.status !== 'active')
      return res.status(403).json({ error: 'Your account is waiting for admin approval' });
    res.json({ token: sign(u), user: publicUser(u) });
  })
);

app.post(
  '/api/auth/request-access',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !email || password.length < 6)
      return res.status(400).json({ error: 'Name, email and password (min 6 chars) required' });
    const exists = await q('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ($1,$2,$3,'member','pending')`, [
      name,
      email,
      hash,
    ]);
    res.status(201).json({ ok: true, message: 'Request sent. Wait for admin approval.' });
  })
);

app.get(
  '/api/auth/me',
  auth,
  wrap(async (req, res) => {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(r.rows[0]) });
  })
);

// ---------- Users (admin) ----------
app.get(
  '/api/users',
  auth,
  adminOnly,
  wrap(async (_req, res) => {
    const r = await q('SELECT id,name,email,role,status,created_at FROM users ORDER BY id');
    res.json(r.rows);
  })
);

app.post(
  '/api/users/:id/approve',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    await q(`UPDATE users SET status='active' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/users/:id/reject',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    await q(`UPDATE users SET status='rejected' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/users/:id/reset-password',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const pw = String(req.body.password || '');
    if (pw.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- Generic CRUD helper ----------
function crud(path, table, fields) {
  app.get(
    path,
    auth,
    wrap(async (req, res) => {
      const where = req.query.project_id && fields.includes('project_id') ? 'WHERE project_id=$1' : '';
      const params = where ? [req.query.project_id] : [];
      const r = await q(`SELECT * FROM ${table} ${where} ORDER BY id DESC`, params);
      res.json(r.rows);
    })
  );
  app.get(
    `${path}/:id`,
    auth,
    wrap(async (req, res) => {
      const r = await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
      r.rowCount ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
    })
  );
  app.post(
    path,
    auth,
    wrap(async (req, res) => {
      const keys = fields.filter((f) => req.body[f] !== undefined);
      if (!keys.length) return res.status(400).json({ error: 'No data' });
      const extra = table === 'projects' ? ['created_by'] : [];
      const cols = [...keys, ...extra];
      const vals = [...keys.map((k) => req.body[k]), ...extra.map(() => req.user.id)];
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      const r = await q(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
      res.status(201).json(r.rows[0]);
    })
  );
  const update = wrap(async (req, res) => {
    const keys = fields.filter((f) => req.body[f] !== undefined);
    if (!keys.length) return res.status(400).json({ error: 'No data' });
    const set = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
    const r = await q(`UPDATE ${table} SET ${set} WHERE id=$${keys.length + 1} RETURNING *`, [
      ...keys.map((k) => req.body[k]),
      req.params.id,
    ]);
    r.rowCount ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  });
  app.put(`${path}/:id`, auth, update);
  app.patch(`${path}/:id`, auth, update);
  app.delete(
    `${path}/:id`,
    auth,
    wrap(async (req, res) => {
      await q(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    })
  );
}

crud('/api/projects', 'projects', ['name', 'location', 'budget', 'status', 'start_date', 'end_date']);
crud('/api/tasks', 'tasks', ['project_id', 'title', 'status', 'progress', 'due_date']);
crud('/api/expenses', 'expenses', ['project_id', 'description', 'amount', 'category', 'spent_on']);

// ---------- Errors ----------
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.message === 'Not allowed by CORS' ? 403 : 500).json({ error: err.message || 'Server error' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`BuildTrack API on :${PORT}`)))
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });
