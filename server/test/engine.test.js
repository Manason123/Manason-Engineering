const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const project = { contract_value: 1000000, end_date: '2026-12-31' };
const act = (o) => ({
  id: 1, code: 'A1', name: 'Foundation', unit: 'm3', planned_qty: 100, budget_cost: 500000,
  planned_start: '2026-10-01', planned_end: '2026-10-31', productivity_per_day: 4,
  done_qty: 0, actual_cost: 0, committed_cost: 0, first_report_date: null, deps: [], ...o,
});

test('stockPosition separates store and site; requests never count', () => {
  const s = E.stockPosition({ receive: 100, issue: 40, consume: 25, waste: 5, adjust: -2 });
  assert.equal(s.store, 58);
  assert.equal(s.site, 10);
});

test('stockCheck covers from stock first, purchases the rest', () => {
  assert.deepEqual(E.stockCheck(50, 30, 10), { free: 20, from_stock: 20, to_purchase: 30 });
  assert.deepEqual(E.stockCheck(10, 30), { free: 30, from_stock: 10, to_purchase: 0 });
});

test('budget: only approved variations change revised budget; original is preserved', () => {
  const m = E.projectMetrics({
    project, activities: [act({})], today: '2026-10-05',
    variations: [
      { status: 'approved', activity_id: 1, cost_amount: 50000, revenue_amount: 60000 },
      { status: 'pending', activity_id: 1, cost_amount: 999999, revenue_amount: 0 },
      { status: 'rejected', activity_id: 1, cost_amount: 777777, revenue_amount: 0 },
    ],
  });
  assert.equal(m.budget.original, 500000);
  assert.equal(m.budget.approved_variations, 50000);
  assert.equal(m.budget.revised, 550000);
  assert.equal(m.budget.pending_variations, 999999);
  assert.equal(m.profit.forecast_revenue, 1060000);
});

test('forecast final cost uses current unit cost once 10%+ progress', () => {
  // 50 of 100 done, spent 300000 -> unit cost 6000 -> remaining 50*6000=300000 -> EAC 600000
  const m = E.projectMetrics({ project, activities: [act({ done_qty: 50, actual_cost: 300000, first_report_date: '2026-10-01' })], today: '2026-10-10' });
  const a = m.activities[0];
  assert.equal(a.forecast_final_cost, 600000);
  assert.equal(a.cost_variance, 250000 - 300000);
  assert.equal(m.costs.forecast_final_cost, 600000);
  assert.equal(m.profit.forecast_profit, 400000);
  assert.equal(m.profit.forecast_margin_pct, 40);
});

test('early work (<10%) falls back to budget-based remaining cost', () => {
  const m = E.projectMetrics({ project, activities: [act({ done_qty: 5, actual_cost: 100000, first_report_date: '2026-10-01' })], today: '2026-10-03' });
  // etc = 95% * 500000 = 475000 -> EAC 575000
  assert.equal(m.activities[0].forecast_final_cost, 575000);
});

test('committed cost raises forecast but is not actual cost or cash', () => {
  const m = E.projectMetrics({
    project, activities: [act({ done_qty: 50, actual_cost: 200000, committed_cost: 400000, first_report_date: '2026-10-01' })],
    today: '2026-10-10', cash: { in: 0, out: 0 },
  });
  assert.equal(m.costs.actual, 200000);
  assert.equal(m.costs.committed, 400000);
  assert.equal(m.cash.paid, 0);
  // etc by unit cost = 50*4000=200000 < committed 400000 -> EAC = 200000 + 400000
  assert.equal(m.activities[0].forecast_final_cost, 600000);
  assert.equal(m.costs.remaining_budget, 500000 - 200000 - 400000);
});

test('profit is not derived from cash receipts', () => {
  const base = { project, activities: [act({ done_qty: 50, actual_cost: 300000, first_report_date: '2026-10-01' })], today: '2026-10-10' };
  const a = E.projectMetrics({ ...base, cash: { in: 0, out: 0 } });
  const b = E.projectMetrics({ ...base, cash: { in: 900000, out: 10 }, invoiced: 900000 });
  assert.equal(a.profit.forecast_profit, b.profit.forecast_profit);
  assert.equal(a.profit.profit_to_date, b.profit.profit_to_date);
  assert.equal(b.cash.receivable, 0);
  assert.equal(b.cash.net, 899990);
});

test('unallocated costs count toward actual and forecast', () => {
  const m = E.projectMetrics({ project, activities: [act({})], unallocatedActual: 25000, today: '2026-10-05' });
  assert.equal(m.costs.actual, 25000);
  assert.equal(m.costs.forecast_final_cost, 500000 + 25000);
});

test('activity over budget is flagged', () => {
  const m = E.projectMetrics({ project, activities: [act({ done_qty: 80, actual_cost: 520000, first_report_date: '2026-10-01' })], today: '2026-10-20' });
  assert.equal(m.activities[0].cost_flag, 'over_budget');
});

test('schedule forecast detects delay from actual productivity', () => {
  // 30 of 100 done in 15 days (rate 2/day) -> 35 days more -> finish 2026-11-14 vs planned 10-31
  const f = E.forecastSchedule([act({ done_qty: 30, first_report_date: '2026-09-26' })], '2026-10-10');
  assert.equal(f[1].rate, 2);
  assert.equal(f[1].finish, '2026-11-14');
  assert.equal(f[1].delay_days, 14);
});

test('short history blends measured pace with approved productivity', () => {
  // 8 done in 2 days = 4/day, planned 4/day -> equal; use 2 done in 2 days = 1/day measured, planned 4/day
  const f = E.forecastSchedule([act({ done_qty: 2, first_report_date: '2026-10-09' })], '2026-10-10');
  const w = 2 / 14;
  assert.equal(f[1].rate, Math.round((w * 1 + (1 - w) * 4 + Number.EPSILON) * 100) / 100);
});

test('dependent activity is pushed after predecessor forecast', () => {
  const a1 = act({ done_qty: 30, first_report_date: '2026-09-26' });
  const a2 = act({ id: 2, code: 'A2', planned_start: '2026-11-01', planned_end: '2026-11-10', planned_qty: 10, productivity_per_day: 1, deps: [1] });
  const f = E.forecastSchedule([a1, a2], '2026-10-10');
  assert.equal(f[2].start, '2026-11-15');
  assert.ok(f[2].delay_days > 0);
});

test('completed activity has no delay', () => {
  const f = E.forecastSchedule([act({ done_qty: 100, first_report_date: '2026-10-01' })], '2026-12-01');
  assert.equal(f[1].complete, true);
  assert.equal(f[1].delay_days, 0);
});

test('material shortage = required for remaining work - (store + site + on order)', () => {
  const r = E.materialShortages(
    { 1: { name: 'Cement', unit: 'bag', required: 500 } },
    { 1: { store: 100, site: 50, on_order: 200 } },
  );
  assert.equal(r[0].shortage, 150);
  assert.equal(r[0].short, true);
});

test('alerts follow configurable thresholds and use stable keys', () => {
  const m = E.projectMetrics({
    project, activities: [act({ done_qty: 50, actual_cost: 480000, first_report_date: '2026-10-01' })],
    today: '2026-10-10', thresholds: { cost_warning_pct: 90 },
  });
  const alerts = E.buildAlerts(7, m, []);
  const types = alerts.map((a) => a.type);
  assert.ok(types.includes('budget_warning'));
  assert.ok(types.includes('forecast_overrun'));
  assert.ok(alerts.every((a) => a.alert_key.startsWith('7:')));
  const again = E.buildAlerts(7, m, []);
  assert.deepEqual(alerts.map((a) => a.alert_key), again.map((a) => a.alert_key));
});

test('revision proposal only includes delayed unfinished activities', () => {
  const m = E.projectMetrics({ project, activities: [act({ done_qty: 30, first_report_date: '2026-09-26' })], today: '2026-10-10' });
  const p = E.proposeRevision(m);
  assert.equal(p.length, 1);
  assert.equal(p[0].new_end, '2026-11-14');
  assert.equal(p[0].old_end, '2026-10-31');
});
