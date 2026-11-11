process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hash } = require('../src/auth');

const today = new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let server, base, db;
const tokens = {};

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tokens[who]}`;
  const res = await fetch(base + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* file or empty */ }
  return { status: res.status, body: json };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

test.before(async () => {
  db = openDb(':memory:');
  const users = [['Olivia Owner', 'owner@t.rw', 'owner'], ['Paul PM', 'pm@t.rw', 'project_manager'], ['Eric Eng', 'eng@t.rw', 'engineer'],
    ['Sam Store', 'store@t.rw', 'storekeeper'], ['Amy Acct', 'acct@t.rw', 'accountant'], ['Other Eng', 'eng2@t.rw', 'engineer']];
  for (const [n, e, r] of users) db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)').run(n, e, hash('Passw0rd!'), r);
  const app = createApp(db, { secret: 'test-secret' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, e] of [['owner', 'owner@t.rw'], ['pm', 'pm@t.rw'], ['eng', 'eng@t.rw'], ['store', 'store@t.rw'], ['acct', 'acct@t.rw'], ['eng2', 'eng2@t.rw']]) {
    const r = await call(null, 'POST', '/auth/login', { email: e, password: 'Passw0rd!' });
    assert.equal(r.status, 200); tokens[k] = r.body.token;
  }
});
test.after(() => server.close());

let pid, aid1, aid2, cement, supplier;

test('authentication: bad password rejected, lockout after repeated failures', async () => {
  assert.equal((await call(null, 'GET', '/projects')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call(null, 'POST', '/auth/login', { email: 'eng2@t.rw', password: 'nope' })).status, 401);
  assert.equal((await call(null, 'POST', '/auth/login', { email: 'eng2@t.rw', password: 'Passw0rd!' })).status, 423);
  db.prepare("UPDATE users SET locked_until = NULL WHERE email = 'eng2@t.rw'").run();
});

test('only owner/admin create projects; members only see assigned projects', async () => {
  const body = { code: 'P-001', name: 'Kigali Apartments', client_name: 'ACME', contract_value: 1000000, start_date: addDays(-20), end_date: addDays(40) };
  assert.equal((await call('pm', 'POST', '/projects', body)).status, 403);
  pid = (await ok('owner', 'POST', '/projects', body)).id;
  assert.equal((await call('owner', 'POST', '/projects', body)).status, 409);
  const users = await ok('owner', 'GET', '/users');
  const id = (e) => users.find((u) => u.email === e).id;
  for (const e of ['pm@t.rw', 'eng@t.rw', 'store@t.rw', 'acct@t.rw']) await ok('owner', 'POST', `/projects/${pid}/members`, { user_id: id(e) });
  assert.equal((await call('eng2', 'GET', `/projects/${pid}`)).status, 404, 'unassigned user must not see the project');
  assert.equal((await ok('eng2', 'GET', '/projects')).length, 0);
  assert.equal((await ok('eng', 'GET', '/projects')).length, 1);
});

test('baseline: activities, resources, import, approval freezes original budget', async () => {
  aid1 = (await ok('pm', 'POST', `/projects/${pid}/activities`, { code: 'A1', name: 'Foundation', unit: 'm3', planned_qty: 100, rate: 6000, budget_cost: 500000, planned_start: addDays(-15), planned_end: addDays(15), productivity_per_day: 4 })).id;
  aid2 = (await ok('pm', 'POST', `/projects/${pid}/activities`, { code: 'A2', name: 'Columns', unit: 'm3', planned_qty: 40, rate: 9000, budget_cost: 300000, planned_start: addDays(16), planned_end: addDays(35), productivity_per_day: 2 })).id;
  assert.equal((await call('pm', 'POST', `/projects/${pid}/activities`, { code: 'A1', name: 'dup', unit: 'm', planned_qty: 1, budget_cost: 1 })).status, 409);
  assert.equal((await call('pm', 'POST', `/projects/${pid}/activities`, { code: 'X', name: 'bad', unit: 'm', planned_qty: -1, budget_cost: 1 })).status, 400);
  assert.equal((await call('pm', 'POST', `/projects/${pid}/activities/${aid2}/deps`, { depends_on_id: aid1 })).status, 201);
  assert.equal((await call('pm', 'POST', `/projects/${pid}/activities/${aid1}/deps`, { depends_on_id: aid2 })).status, 400, 'cycle rejected');
  cement = (await ok('pm', 'POST', '/materials', { name: 'Cement', unit: 'bag', default_price: 12000 })).id;
  await ok('pm', 'POST', `/projects/${pid}/activities/${aid1}/resources`, { type: 'material', material_id: cement, qty_per_unit: 8, unit_cost: 12000 });

  // Excel import
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('BOQ');
  ws.addRow(['Code', 'Description', 'Unit', 'Quantity', 'Rate']);
  ws.addRow(['A3', 'Slab', 'm2', 50, 1000]);
  ws.addRow(['A4', 'Walls', 'm2', 80, 500]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const form = new FormData(); form.append('file', new Blob([buf]), 'boq.xlsx');
  let res = await fetch(`${base}/api/projects/${pid}/activities/import`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.pm}` }, body: form });
  assert.equal(res.status, 201);
  const acts = await ok('pm', 'GET', `/projects/${pid}/activities`);
  assert.equal(acts.length, 4);
  for (const a of acts.filter((x) => ['A3', 'A4'].includes(x.code))) await ok('pm', 'DELETE', `/projects/${pid}/activities/${a.id}`);

  assert.equal((await call('eng', 'POST', `/projects/${pid}/baseline/approve`)).status, 403);
  await ok('pm', 'POST', `/projects/${pid}/baseline/approve`);
  assert.equal((await call('pm', 'PUT', `/projects/${pid}/activities/${aid1}`, { budget_cost: 1 })).status, 409, 'baseline locked');
  const bl = await ok('pm', 'GET', `/projects/${pid}/baseline`);
  assert.equal(bl.total_budget, 800000);
});

test('variations: pending does not change budget, approval needs owner, original preserved', async () => {
  const v = await ok('pm', 'POST', `/projects/${pid}/variations`, { activity_id: aid1, cost_amount: 50000, revenue_amount: 60000, reason: 'Extra depth required' });
  let d = await ok('pm', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.budget.revised, 800000); assert.equal(d.budget.pending_variations, 50000);
  assert.equal((await call('pm', 'POST', `/projects/${pid}/variations/${v.id}/decide`, { approve: true })).status, 403);
  await ok('owner', 'POST', `/projects/${pid}/variations/${v.id}/decide`, { approve: true, note: 'Client agreed' });
  d = await ok('pm', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.budget.original, 800000); assert.equal(d.budget.approved_variations, 50000); assert.equal(d.budget.revised, 850000);
  assert.equal(d.profit.forecast_revenue, 1060000);
  const bl = await ok('pm', 'GET', `/projects/${pid}/baseline`);
  assert.equal(bl.total_budget, 800000, 'baseline snapshot untouched');
  assert.equal((await call('owner', 'POST', `/projects/${pid}/variations/${v.id}/decide`, { approve: false, note: 'x' })).status, 409);
});

test('materials: request -> approve -> PO commits cost (not actual) -> delivery -> confirm updates stock & cost', async () => {
  supplier = (await ok('acct', 'POST', '/suppliers', { name: 'BuildMart' })).id;
  const rq = await ok('eng', 'POST', `/projects/${pid}/requests`, { material_id: cement, activity_id: aid1, needed_date: addDays(2), qty_requested: 100 });
  assert.equal(rq.stock_check.to_purchase, 100);
  assert.equal((await call('eng', 'POST', `/projects/${pid}/requests/${rq.id}/decide`, { approve: true })).status, 403, 'engineer cannot approve');
  await ok('pm', 'POST', `/projects/${pid}/requests/${rq.id}/decide`, { approve: true });
  let inv = await ok('store', 'GET', `/projects/${pid}/inventory`);
  assert.equal(inv.find((x) => x.material_id === cement).store, 0, 'requested is not stock');
  assert.equal((await call('acct', 'POST', `/projects/${pid}/purchase-orders`, { request_id: rq.id, supplier_id: supplier, qty: 150, unit_price: 12000 })).status, 400, 'cannot over-purchase');
  const po = await ok('acct', 'POST', `/projects/${pid}/purchase-orders`, { request_id: rq.id, supplier_id: supplier, qty: 100, unit_price: 12000 });
  assert.equal(po.committed, 1200000);
  let d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.costs.committed, 1200000); assert.equal(d.costs.actual, 0); assert.equal(d.cash.paid, 0, 'committed is not cash');

  const del = await ok('store', 'POST', `/projects/${pid}/purchase-orders/${po.id}/deliveries`, { delivery_note_no: 'DN-1', qty_delivered: 100 });
  assert.equal((await call('store', 'POST', `/projects/${pid}/purchase-orders/${po.id}/deliveries`, { delivery_note_no: 'DN-1', qty_delivered: 1 })).status, 409, 'duplicate note');
  inv = await ok('store', 'GET', `/projects/${pid}/inventory`);
  assert.equal(inv.find((x) => x.material_id === cement).store, 0, 'delivered but not received');
  await ok('store', 'POST', `/projects/${pid}/deliveries/${del.id}/confirm`, { qty_received: 95 });
  assert.equal((await call('store', 'POST', `/projects/${pid}/deliveries/${del.id}/confirm`, { qty_received: 95 })).status, 409);
  inv = await ok('store', 'GET', `/projects/${pid}/inventory`);
  assert.equal(inv.find((x) => x.material_id === cement).store, 95);
  d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.costs.actual, 95 * 12000);
  assert.equal(d.cash.paid, 0);

  assert.equal((await call('store', 'POST', `/projects/${pid}/issues`, { material_id: cement, qty: 96 })).status, 409, 'cannot issue more than store');
  await ok('store', 'POST', `/projects/${pid}/issues`, { material_id: cement, qty: 60, request_id: rq.id });
  inv = await ok('store', 'GET', `/projects/${pid}/inventory`);
  const c = inv.find((x) => x.material_id === cement);
  assert.equal(c.store, 35); assert.equal(c.site, 60); assert.equal(c.consumed, 0, 'issued is not consumed');
});

test('daily report: approval gate, no self-approval, consumption cannot exceed issued stock, cost recognition', async () => {
  const body = {
    report_date: addDays(-1), weather: 'Sunny', delays: 'Rain delay 1h',
    lines: [{ activity_id: aid1, planned_qty: 10, completed_qty: 8 }],
    labour: [{ activity_id: aid1, trade: 'Mason', workers: 5, hours: 8, hourly_rate: 1000 }],
    equipment: [{ activity_id: aid1, name: 'Mixer', hours: 6, hourly_rate: 5000 }],
    materials: [{ activity_id: aid1, material_id: cement, qty_consumed: 70, qty_wasted: 1 }],
    submit: true,
  };
  const rep = await ok('eng', 'POST', `/projects/${pid}/reports`, body);
  assert.equal((await call('eng', 'POST', `/projects/${pid}/reports`, body)).status, 409, 'one report per day');
  assert.equal((await call('eng', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: true })).status, 403);
  let d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.progress_pct, 0, 'unapproved report does not count');
  const r1 = await call('pm', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: true });
  assert.equal(r1.status, 409, r1.body && r1.body.error); // 71 > 60 issued

  assert.equal((await call('pm', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: false })).status, 400, 'rejection needs a note');
  await ok('pm', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: false, note: 'Cement figures exceed what was issued' });
  assert.equal((await call('pm', 'PUT', `/projects/${pid}/reports/${rep.id}`, body)).status, 403, 'only the author edits (PM is not global)');
  await ok('eng', 'PUT', `/projects/${pid}/reports/${rep.id}`, { ...body, materials: [{ activity_id: aid1, material_id: cement, qty_consumed: 50, qty_wasted: 2 }] });
  await ok('pm', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: true });
  assert.equal((await call('pm', 'POST', `/projects/${pid}/reports/${rep.id}/review`, { approve: true })).status, 409, 'cannot approve twice');
  assert.equal((await call('eng', 'PUT', `/projects/${pid}/reports/${rep.id}`, body)).status, 409, 'approved report is locked');

  const inv = await ok('store', 'GET', `/projects/${pid}/inventory`);
  const c = inv.find((x) => x.material_id === cement);
  assert.equal(c.consumed, 50); assert.equal(c.wasted, 2); assert.equal(c.site, 8);
  d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  const a1 = d.activities.find((a) => a.id === aid1);
  assert.equal(a1.done_qty, 8);
  assert.equal(a1.actual_cost, 95 * 12000 + 5 * 8 * 1000 + 6 * 5000); // material at receipt + labour + equipment
  const lab = await ok('acct', 'GET', `/projects/${pid}/costs`);
  assert.equal(lab.filter((x) => x.category === 'labour').length, 1);
});

test('finance: duplicates blocked, outgoing payments need approval, profit never from cash', async () => {
  const before = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  const inv = await ok('acct', 'POST', `/projects/${pid}/invoices`, { number: 'INV-1', amount: 400000, due_date: addDays(30) });
  assert.equal((await call('acct', 'POST', `/projects/${pid}/invoices`, { number: 'inv-1', amount: 1, due_date: addDays(30) })).status, 409);
  assert.equal((await call('acct', 'POST', `/projects/${pid}/invoices`, { number: 'INV-BIG', amount: 99999999, due_date: addDays(30) })).status, 400, 'cannot invoice above contract');
  const pay = await ok('acct', 'POST', `/projects/${pid}/cash`, { kind: 'client_payment', amount: 300000, reference: 'TX-100', invoice_id: inv.id });
  assert.equal(pay.status, 'approved');
  assert.equal((await call('acct', 'POST', `/projects/${pid}/cash`, { kind: 'client_payment', amount: 300000, reference: 'tx-100', invoice_id: inv.id })).status, 409, 'duplicate reference');
  assert.equal((await call('acct', 'POST', `/projects/${pid}/cash`, { kind: 'client_payment', amount: 200000, reference: 'TX-101', invoice_id: inv.id })).status, 400, 'over-payment');

  const bill = await ok('acct', 'POST', `/projects/${pid}/bills`, { supplier_id: supplier, bill_no: 'B-77', amount: 1000000, due_date: addDays(30) });
  const sp = await ok('acct', 'POST', `/projects/${pid}/cash`, { kind: 'supplier_payment', amount: 500000, reference: 'PAY-1', bill_id: bill.id });
  assert.equal(sp.status, 'pending_approval');
  let d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.cash.paid, 0, 'pending payment is not cash paid');
  assert.equal((await call('acct', 'POST', `/projects/${pid}/cash/${sp.id}/decide`, { approve: true })).status, 403);
  await ok('owner', 'POST', `/projects/${pid}/cash/${sp.id}/decide`, { approve: true });
  d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.cash.paid, 500000); assert.equal(d.cash.received, 300000); assert.equal(d.cash.receivable, 100000);
  assert.equal(d.profit.forecast_profit, before.profit.forecast_profit, 'cash movements do not change profit');
  assert.equal(d.costs.actual, before.costs.actual, 'cash movements do not change cost');

  // corrections are traceable reversals
  assert.equal((await call('acct', 'POST', `/projects/${pid}/cash/${pay.id}/reverse`, {})).status, 400, 'reason required');
  await ok('acct', 'POST', `/projects/${pid}/cash/${pay.id}/reverse`, { reason: 'Bank bounced' });
  d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.cash.received, 0);

  const cost = await ok('acct', 'POST', `/projects/${pid}/costs`, { category: 'overhead', description: 'Site office rent', amount: 20000 });
  assert.equal((await call('acct', 'POST', `/projects/${pid}/costs`, { category: 'overhead', description: 'site office rent', amount: 20000 })).status, 409, 'duplicate cost');
  const c1 = (await ok('owner', 'GET', `/projects/${pid}/dashboard`)).costs.actual;
  await ok('acct', 'POST', `/projects/${pid}/costs/${cost.id}/reverse`, { reason: 'Entered twice by mistake' });
  assert.equal((await ok('owner', 'GET', `/projects/${pid}/dashboard`)).costs.actual, c1 - 20000);
  assert.equal((await call('acct', 'POST', `/projects/${pid}/costs/${cost.id}/reverse`, { reason: 'again' })).status, 409);

  const audit = await ok('owner', 'GET', `/projects/${pid}/audit`);
  assert.ok(audit.some((a) => a.action === 'reverse' && a.reason === 'Bank bounced' && a.user_name === 'Amy Acct'), 'audit shows who/why');
});

test('roles: engineers and storekeepers never see money; viewers read only', async () => {
  const d = await ok('eng', 'GET', `/projects/${pid}/dashboard`);
  assert.equal(d.show_money, false); assert.equal(d.costs, undefined); assert.equal(d.profit, undefined);
  assert.equal((await call('eng', 'GET', `/projects/${pid}/costs`)).status, 403);
  assert.equal((await call('store', 'GET', `/projects/${pid}/cash`)).status, 403);
  const ov = await ok('eng', 'GET', '/dashboard'); assert.equal(ov.projects[0].forecast_profit, undefined);
});

test('schedule: delay forecast creates a revision proposal; approval changes plan, not baseline', async () => {
  const s = await ok('pm', 'GET', `/projects/${pid}/schedule`);
  const a1 = s.activities.find((a) => a.id === aid1);
  assert.ok(a1.delay_days > 0, 'activity 1 is behind plan');
  const rev = await ok('pm', 'POST', `/projects/${pid}/revisions/propose`, { reason: 'Rain and slow start' });
  assert.equal((await call('pm', 'POST', `/projects/${pid}/revisions/propose`, { reason: 'again' })).status, 409);
  assert.equal((await call('eng', 'POST', `/projects/${pid}/revisions/${rev.id}/decide`, { approve: true })).status, 403);
  const before = await ok('pm', 'GET', `/projects/${pid}/activities`);
  await ok('pm', 'POST', `/projects/${pid}/revisions/${rev.id}/decide`, { approve: true, note: 'Accepted' });
  const after = await ok('pm', 'GET', `/projects/${pid}/activities`);
  assert.notEqual(before.find((a) => a.id === aid1).planned_end, after.find((a) => a.id === aid1).planned_end);
  const bl = await ok('pm', 'GET', `/projects/${pid}/baseline`);
  assert.equal(bl.activities.find((a) => a.activity_id === aid1).planned_end, before.find((a) => a.id === aid1).planned_end, 'baseline dates preserved');
});

test('alerts, shortages, management report and exports', async () => {
  const d = await ok('owner', 'GET', `/projects/${pid}/dashboard`);
  assert.ok(d.alerts.length > 0);
  const short = d.shortages.find((x) => x.material_id === cement);
  assert.ok(short, 'cement requirement for remaining work is computed');
  assert.equal(short.required, 92 * 8); // remaining 92 m3 x 8 bags
  const all = await ok('owner', 'GET', '/dashboard');
  assert.equal(all.totals.projects, 1);
  const mg = await ok('owner', 'GET', '/reports/management?period=weekly');
  assert.equal(mg[0].approved_reports, 1);
  for (const url of [`/projects/${pid}/export/excel`, `/projects/${pid}/export/pdf`, '/reports/management/export?format=xlsx', '/reports/management/export?format=pdf']) {
    const res = await fetch(base + '/api' + url, { headers: { Authorization: `Bearer ${tokens.owner}` } });
    assert.equal(res.status, 200, url);
    assert.ok((await res.arrayBuffer()).byteLength > 500, url);
  }
  assert.equal((await fetch(`${base}/api/projects/${pid}/export/pdf`, { headers: { Authorization: `Bearer ${tokens.eng}` } })).status, 403);
  await ok('owner', 'PUT', '/settings', { cost_warning_pct: 50, reason: 'Stricter' });
  assert.equal((await ok('owner', 'GET', '/settings')).cost_warning_pct, 50);
  assert.equal((await call('pm', 'PUT', '/settings', { cost_warning_pct: 10, reason: 'x' })).status, 403);
});

test('input validation and SQL-injection-style input are handled safely', async () => {
  assert.equal((await call('pm', 'GET', `/projects/abc`)).status, 404);
  assert.equal((await call('acct', 'POST', `/projects/${pid}/costs`, { category: 'overhead', description: "x'); DROP TABLE users;--", amount: 5 })).status, 201);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM users').get().n >= 6);
  assert.equal((await call('acct', 'POST', `/projects/${pid}/costs`, { category: 'bogus', description: 'x', amount: 5 })).status, 400);
  assert.equal((await call('acct', 'POST', `/projects/${pid}/costs`, { category: 'other', description: 'x', amount: -5 })).status, 400);
});

test('access requests: public sign-up is inert until an admin approves with a role and projects', async () => {
  const req = { name: 'New Person', email: 'New@T.rw', password: 'Passw0rd1', phone: '0788', message: 'Site engineer' };
  assert.equal((await call(null, 'POST', '/auth/register', { ...req, password: 'short' })).status, 400);
  assert.equal((await call(null, 'POST', '/auth/register', req)).status, 202);
  // existing email and duplicate pending give the same answer and create nothing
  assert.equal((await call(null, 'POST', '/auth/register', { ...req, email: 'owner@t.rw' })).status, 202);
  assert.equal((await call(null, 'POST', '/auth/register', req)).status, 202);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM access_requests WHERE status='pending'").get().n, 1);
  assert.equal((await call(null, 'POST', '/auth/login', { email: 'new@t.rw', password: 'Passw0rd1' })).status, 401, 'cannot log in before approval');
  assert.equal((await call('pm', 'GET', '/access-requests')).status, 403);
  const list = await ok('owner', 'GET', '/access-requests');
  assert.equal(list.length, 1); assert.equal(list[0].password_hash, undefined);
  assert.equal((await call('pm', 'POST', `/access-requests/${list[0].id}/decide`, { approve: true, role: 'engineer' })).status, 403);
  assert.equal((await call('owner', 'POST', `/access-requests/${list[0].id}/decide`, { approve: true, role: 'bogus' })).status, 400);
  await ok('owner', 'POST', `/access-requests/${list[0].id}/decide`, { approve: true, role: 'engineer', project_ids: [pid] });
  assert.equal((await call('owner', 'POST', `/access-requests/${list[0].id}/decide`, { approve: false, note: 'x' })).status, 409);
  const login = await call(null, 'POST', '/auth/login', { email: 'new@t.rw', password: 'Passw0rd1' });
  assert.equal(login.status, 200);
  tokens.newbie = login.body.token;
  assert.equal((await ok('newbie', 'GET', '/projects')).length, 1, 'assigned to the chosen project only');
  assert.equal((await call('newbie', 'GET', `/projects/${pid}/costs`)).status, 403, 'engineer role: no money');
  // rejection needs a reason
  await call(null, 'POST', '/auth/register', { name: 'Spam', email: 'spam@x.rw', password: 'Passw0rd1' });
  const spam = (await ok('owner', 'GET', '/access-requests')).find((x) => x.email === 'spam@x.rw');
  assert.equal((await call('owner', 'POST', `/access-requests/${spam.id}/decide`, { approve: false })).status, 400);
  await ok('owner', 'POST', `/access-requests/${spam.id}/decide`, { approve: false, note: 'Unknown person' });
  assert.equal((await call(null, 'POST', '/auth/login', { email: 'spam@x.rw', password: 'Passw0rd1' })).status, 401);
});
