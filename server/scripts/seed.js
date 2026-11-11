'use strict';
/**
 * Demo data. Goes through the real API so every business rule is exercised.
 * Usage: DATA_DIR=./data node scripts/seed.js     (refuses to run if users already exist)
 */
process.env.NODE_ENV = 'test';
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hash } = require('../src/auth');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = openDb(path.join(dataDir, 'buildtrack.db'));
if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { console.error('Database already has users. Seed aborted.'); process.exit(1); }

const PW = 'Demo12345';
const people = [['Aline Uwase (Owner)', 'owner@buildtrack.rw', 'owner', 'rw'], ['Patrick Habimana (PM)', 'pm@buildtrack.rw', 'project_manager', 'en'],
  ['Eric Niyonzima (Engineer)', 'engineer@buildtrack.rw', 'engineer', 'rw'], ['Solange Mukamana (Store)', 'store@buildtrack.rw', 'storekeeper', 'fr'],
  ['Jean Bosco (Accountant)', 'accountant@buildtrack.rw', 'accountant', 'en'], ['Diane Ingabire (PM 2)', 'pm2@buildtrack.rw', 'project_manager', 'rw']];
for (const [n, e, r, l] of people) db.prepare('INSERT INTO users(name,email,password_hash,role,lang) VALUES (?,?,?,?,?)').run(n, e, hash(PW), r, l);

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const app = createApp(db, { secret: 'seed-only' });
const tokens = {};
let base;

async function call(who, method, url, body) {
  const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [, e, , ] of people) {
    const k = e.split('@')[0];
    tokens[k] = (await call(null, 'POST', '/auth/login', { email: e, password: PW })).token;
  }
  const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e + '@buildtrack.rw').id;

  const cement = (await call('pm', 'POST', '/materials', { name: 'Cement 50kg', unit: 'bag', default_price: 14000 })).id;
  const steel = (await call('pm', 'POST', '/materials', { name: 'Rebar Y12', unit: 'kg', default_price: 1100 })).id;
  const sand = (await call('pm', 'POST', '/materials', { name: 'Sand', unit: 'm3', default_price: 18000 })).id;
  const bricks = (await call('pm', 'POST', '/materials', { name: 'Bricks', unit: 'pcs', default_price: 250 })).id;
  const sup1 = (await call('accountant', 'POST', '/suppliers', { name: 'Kigali Building Supplies', phone: '+250788000001' })).id;
  const sup2 = (await call('accountant', 'POST', '/suppliers', { name: 'Rwanda Steel Ltd', phone: '+250788000002' })).id;

  async function makeProject(p, pm, acts) {
    const id = (await call('owner', 'POST', '/projects', p)).id;
    for (const u of [pm, 'engineer', 'store', 'accountant']) await call('owner', 'POST', `/projects/${id}/members`, { user_id: uid(u) });
    const ids = {};
    for (const a of acts) {
      ids[a.code] = (await call(pm, 'POST', `/projects/${id}/activities`, { ...a, resources: undefined })).id;
      for (const r of a.resources || []) await call(pm, 'POST', `/projects/${id}/activities/${ids[a.code]}/resources`, r.type ? r : r);
    }
    return { id, ids };
  }

  // ---- Project 1: healthy ----
  const p1 = await makeProject({ code: 'KH-001', name: 'Kigali Heights Apartments', client_name: 'Horizon Developers Ltd', client_contact: 'info@horizon.rw', location: 'Kigali, Gasabo',
    contract_value: 240000000, start_date: day(-40), end_date: day(80), status: 'planning' }, 'pm', [
    { code: 'A1', name: 'Excavation', unit: 'm3', planned_qty: 800, rate: 8000, budget_cost: 5000000, planned_start: day(-40), planned_end: day(-25), productivity_per_day: 55 },
    { code: 'A2', name: 'Foundation concrete', unit: 'm3', planned_qty: 300, rate: 260000, budget_cost: 62000000, planned_start: day(-24), planned_end: day(-4), productivity_per_day: 15,
      resources: [{ type: 'material', material_id: cement, qty_per_unit: 7, unit_cost: 14000 }, { type: 'material', material_id: sand, qty_per_unit: 0.5, unit_cost: 18000 }] },
    { code: 'A3', name: 'Columns and slab', unit: 'm3', planned_qty: 400, rate: 300000, budget_cost: 96000000, planned_start: day(-3), planned_end: day(40), productivity_per_day: 10,
      resources: [{ type: 'material', material_id: cement, qty_per_unit: 8, unit_cost: 14000 }, { type: 'material', material_id: steel, qty_per_unit: 110, unit_cost: 1100 }] },
    { code: 'A4', name: 'Masonry walls', unit: 'm2', planned_qty: 2500, rate: 15000, budget_cost: 25000000, planned_start: day(41), planned_end: day(75), productivity_per_day: 75,
      resources: [{ type: 'material', material_id: bricks, qty_per_unit: 55, unit_cost: 250 }] },
  ]);
  for (const [a, b] of [['A2', 'A1'], ['A3', 'A2'], ['A4', 'A3']]) await call('pm', 'POST', `/projects/${p1.id}/activities/${p1.ids[a]}/deps`, { depends_on_id: p1.ids[b] });
  await call('pm', 'POST', `/projects/${p1.id}/baseline/approve`);

  // ---- Project 2: delayed + over budget ----
  const p2 = await makeProject({ code: 'MH-002', name: 'Musanze Health Center', client_name: 'District of Musanze', location: 'Musanze',
    contract_value: 105000000, start_date: day(-60), end_date: day(30), status: 'planning' }, 'pm2', [
    { code: 'B1', name: 'Site clearing and setting out', unit: 'm2', planned_qty: 1500, rate: 2000, budget_cost: 2500000, planned_start: day(-60), planned_end: day(-50), productivity_per_day: 150 },
    { code: 'B2', name: 'Strip foundations', unit: 'm3', planned_qty: 120, rate: 250000, budget_cost: 24000000, planned_start: day(-49), planned_end: day(-20), productivity_per_day: 4,
      resources: [{ type: 'material', material_id: cement, qty_per_unit: 7, unit_cost: 14000 }, { type: 'material', material_id: steel, qty_per_unit: 90, unit_cost: 1100 }] },
    { code: 'B3', name: 'Walls to roof level', unit: 'm2', planned_qty: 900, rate: 40000, budget_cost: 27000000, planned_start: day(-19), planned_end: day(10), productivity_per_day: 30,
      resources: [{ type: 'material', material_id: bricks, qty_per_unit: 55, unit_cost: 250 }, { type: 'material', material_id: cement, qty_per_unit: 0.3, unit_cost: 14000 }] },
    { code: 'B4', name: 'Roofing and finishes', unit: 'm2', planned_qty: 600, rate: 60000, budget_cost: 30000000, planned_start: day(11), planned_end: day(28), productivity_per_day: 35 },
  ]);
  for (const [a, b] of [['B2', 'B1'], ['B3', 'B2'], ['B4', 'B3']]) await call('pm2', 'POST', `/projects/${p2.id}/activities/${p2.ids[a]}/deps`, { depends_on_id: p2.ids[b] });
  await call('pm2', 'POST', `/projects/${p2.id}/baseline/approve`);

  // ---- helper: full material cycle ----
  async function buy(pm, pid, actId, material, supplier, qty, price, dn) {
    const rq = await call('engineer', 'POST', `/projects/${pid}/requests`, { material_id: material, activity_id: actId, needed_date: day(0), qty_requested: qty });
    await call(pm, 'POST', `/projects/${pid}/requests/${rq.id}/decide`, { approve: true });
    const po = await call('accountant', 'POST', `/projects/${pid}/purchase-orders`, { request_id: rq.id, supplier_id: supplier, qty, unit_price: price });
    const d = await call('store', 'POST', `/projects/${pid}/purchase-orders/${po.id}/deliveries`, { delivery_note_no: dn, qty_delivered: qty });
    await call('store', 'POST', `/projects/${pid}/deliveries/${d.id}/confirm`, { qty_received: qty });
    await call('store', 'POST', `/projects/${pid}/issues`, { material_id: material, qty, request_id: rq.id });
  }
  const report = async (pm, pid, offset, lines, labour, materials, equipment = []) => {
    const r = await call('engineer', 'POST', `/projects/${pid}/reports`, { report_date: day(offset), weather: 'Sunny', lines, labour, materials, equipment, submit: true });
    await call(pm, 'POST', `/projects/${pid}/reports/${r.id}/review`, { approve: true });
  };

  // P1: excavation done, foundation complete, columns started
  await report('pm', p1.id, -35, [{ activity_id: p1.ids.A1, planned_qty: 400, completed_qty: 400 }], [{ activity_id: p1.ids.A1, trade: 'Laborer', workers: 20, hours: 8, hourly_rate: 1250 }], [], [{ activity_id: p1.ids.A1, name: 'Excavator', hours: 8, hourly_rate: 25000 }]);
  await report('pm', p1.id, -28, [{ activity_id: p1.ids.A1, planned_qty: 400, completed_qty: 400 }], [{ activity_id: p1.ids.A1, trade: 'Laborer', workers: 20, hours: 8, hourly_rate: 1250 }], [], [{ activity_id: p1.ids.A1, name: 'Excavator', hours: 8, hourly_rate: 25000 }]);
  await buy('pm', p1.id, p1.ids.A2, cement, sup1, 2200, 14000, 'KB-1001');
  await buy('pm', p1.id, p1.ids.A2, sand, sup1, 160, 18000, 'KB-1002');
  await report('pm', p1.id, -15, [{ activity_id: p1.ids.A2, planned_qty: 150, completed_qty: 150 }], [{ activity_id: p1.ids.A2, trade: 'Mason', workers: 25, hours: 8, hourly_rate: 1800 }],
    [{ activity_id: p1.ids.A2, material_id: cement, qty_consumed: 1050, qty_wasted: 20 }, { activity_id: p1.ids.A2, material_id: sand, qty_consumed: 75, qty_wasted: 2 }]);
  await report('pm', p1.id, -8, [{ activity_id: p1.ids.A2, planned_qty: 150, completed_qty: 150 }], [{ activity_id: p1.ids.A2, trade: 'Mason', workers: 25, hours: 8, hourly_rate: 1800 }],
    [{ activity_id: p1.ids.A2, material_id: cement, qty_consumed: 1050, qty_wasted: 30 }, { activity_id: p1.ids.A2, material_id: sand, qty_consumed: 75, qty_wasted: 3 }]);
  await buy('pm', p1.id, p1.ids.A3, steel, sup2, 20000, 1100, 'RS-221');
  await report('pm', p1.id, -2, [{ activity_id: p1.ids.A3, planned_qty: 12, completed_qty: 12 }], [{ activity_id: p1.ids.A3, trade: 'Steel fixer', workers: 12, hours: 8, hourly_rate: 2000 }],
    [{ activity_id: p1.ids.A3, material_id: steel, qty_consumed: 1300, qty_wasted: 40 }]);
  // open order = commitment, not cost
  {
    const rq = await call('engineer', 'POST', `/projects/${p1.id}/requests`, { material_id: cement, activity_id: p1.ids.A3, needed_date: day(3), qty_requested: 1500 });
    await call('pm', 'POST', `/projects/${p1.id}/requests/${rq.id}/decide`, { approve: true });
    await call('accountant', 'POST', `/projects/${p1.id}/purchase-orders`, { request_id: rq.id, supplier_id: sup1, qty: 1500, unit_price: 14000 });
  }
  // finance P1
  const inv1 = await call('accountant', 'POST', `/projects/${p1.id}/invoices`, { number: 'KH-INV-001', amount: 90000000, issue_date: day(-30), due_date: day(-5) });
  await call('accountant', 'POST', `/projects/${p1.id}/cash`, { kind: 'client_payment', amount: 90000000, reference: 'RTGS-4471', invoice_id: inv1.id, txn_date: day(-20) });
  const inv1b = await call('accountant', 'POST', `/projects/${p1.id}/invoices`, { number: 'KH-INV-002', amount: 70000000, issue_date: day(-6), due_date: day(10) });
  await call('accountant', 'POST', `/projects/${p1.id}/cash`, { kind: 'client_payment', amount: 20000000, reference: 'RTGS-5102', invoice_id: inv1b.id, txn_date: day(-3) });
  const b1 = await call('accountant', 'POST', `/projects/${p1.id}/bills`, { supplier_id: sup1, bill_no: 'KB-INV-8812', amount: 40000000, bill_date: day(-14), due_date: day(16) });
  const pay1 = await call('accountant', 'POST', `/projects/${p1.id}/cash`, { kind: 'supplier_payment', amount: 25000000, reference: 'PAY-0001', bill_id: b1.id, txn_date: day(-5) });
  await call('owner', 'POST', `/projects/${p1.id}/cash/${pay1.id}/decide`, { approve: true });
  await call('accountant', 'POST', `/projects/${p1.id}/costs`, { category: 'overhead', description: 'Site office, security and utilities', amount: 3200000, entry_date: day(-10) });

  // P2: slow and expensive
  await report('pm2', p2.id, -55, [{ activity_id: p2.ids.B1, planned_qty: 750, completed_qty: 750 }], [{ activity_id: p2.ids.B1, trade: 'Laborer', workers: 15, hours: 8, hourly_rate: 1250 }]);
  await report('pm2', p2.id, -50, [{ activity_id: p2.ids.B1, planned_qty: 750, completed_qty: 750 }], [{ activity_id: p2.ids.B1, trade: 'Laborer', workers: 15, hours: 8, hourly_rate: 1250 }]);
  await buy('pm2', p2.id, p2.ids.B2, cement, sup1, 700, 15500, 'KB-2001');
  await buy('pm2', p2.id, p2.ids.B2, steel, sup2, 9000, 1250, 'RS-310');
  await report('pm2', p2.id, -30, [{ activity_id: p2.ids.B2, planned_qty: 20, completed_qty: 18 }], [{ activity_id: p2.ids.B2, trade: 'Mason', workers: 14, hours: 9, hourly_rate: 2200 }],
    [{ activity_id: p2.ids.B2, material_id: cement, qty_consumed: 140, qty_wasted: 12 }, { activity_id: p2.ids.B2, material_id: steel, qty_consumed: 1800, qty_wasted: 150 }]);
  await report('pm2', p2.id, -14, [{ activity_id: p2.ids.B2, planned_qty: 20, completed_qty: 20 }], [{ activity_id: p2.ids.B2, trade: 'Mason', workers: 14, hours: 9, hourly_rate: 2200 }],
    [{ activity_id: p2.ids.B2, material_id: cement, qty_consumed: 160, qty_wasted: 18 }, { activity_id: p2.ids.B2, material_id: steel, qty_consumed: 1900, qty_wasted: 120 }]);
  await report('pm2', p2.id, -3, [{ activity_id: p2.ids.B2, planned_qty: 20, completed_qty: 14 }], [{ activity_id: p2.ids.B2, trade: 'Mason', workers: 14, hours: 9, hourly_rate: 2200 }],
    [{ activity_id: p2.ids.B2, material_id: cement, qty_consumed: 140, qty_wasted: 10 }]);
  await call('accountant', 'POST', `/projects/${p2.id}/costs`, { category: 'subcontract', description: 'Rock breaking subcontractor (unexpected rock)', amount: 6500000, entry_date: day(-25), activity_id: p2.ids.B2 });
  const v = await call('pm2', 'POST', `/projects/${p2.id}/variations`, { activity_id: p2.ids.B2, cost_amount: 4000000, revenue_amount: 0, reason: 'Unexpected rock layer needs breaking' });
  void v; // left pending on purpose: shows "awaiting approval"
  const inv2 = await call('accountant', 'POST', `/projects/${p2.id}/invoices`, { number: 'MH-INV-001', amount: 50000000, issue_date: day(-40), due_date: day(-10) });
  await call('accountant', 'POST', `/projects/${p2.id}/cash`, { kind: 'client_payment', amount: 30000000, reference: 'BK-9921', invoice_id: inv2.id, txn_date: day(-25) });

  const { refreshAllAlerts } = require('../src/services');
  refreshAllAlerts(db, day(0));
  server.close();
  console.log('Seed complete. Demo accounts (password: ' + PW + '):');
  for (const [n, e, r] of people) console.log(`  ${r.padEnd(16)} ${e}  (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
