'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (msg) => new HttpError(400, msg);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v, name, { required = true, max = 500 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} is too long`);
  return s;
}
function num(v, name, { required = true, min = -Infinity, max = Infinity, gt } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (n < min) throw bad(`${name} must be at least ${min}`);
  if (n > max) throw bad(`${name} must be at most ${max}`);
  if (gt !== undefined && !(n > gt)) throw bad(`${name} must be greater than ${gt}`);
  return n;
}
function date(v, name, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${name} must be a valid date (YYYY-MM-DD)`);
  return s;
}
function oneOf(v, name, list, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}
function reason(v) {
  return str(v, 'reason', { max: 1000 });
}
const today = () => new Date().toISOString().slice(0, 10);

module.exports = { HttpError, bad, str, num, date, oneOf, reason, today };
