'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { makeAuth, loadSecret } = require('./auth');
const { HttpError } = require('./validate');

function createApp(db, { dataDir = null, secret, clientDir = path.join(__dirname, '..', '..', 'client', 'dist') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"] } } }));
  app.use(express.json({ limit: '1mb' }));

  // Optional CORS so the UI can live on another domain (e.g. Netlify). CORS_ORIGIN = comma-separated list of exact origins.
  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (origins.length) {
    app.use('/api', (req, res, next) => {
      const o = req.headers.origin;
      if (o && origins.includes(o)) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  const auth = makeAuth(db, secret || loadSecret(dataDir));
  const uploadDir = path.join(dataDir || path.join(__dirname, '..', 'data'), 'uploads');
  const backupDir = path.join(dataDir || path.join(__dirname, '..', 'data'), 'backups');

  if (process.env.NODE_ENV !== 'test') {
    app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } }));
    app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again later.' } }));
    app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', require('./routes_core')({ db, auth, uploadDir }));
  app.use('/api', require('./routes_ops')({ db, auth, backupDir }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  else app.get('/', (_req, res) => res.json({ name: 'BuildTrack Pro API', ok: true }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 15 MB)' });
    if (err && /SQLITE_CONSTRAINT/.test(err.code || '')) return res.status(409).json({ error: 'Operation rejected by data rules: ' + err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err); // eslint-disable-line no-console
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
