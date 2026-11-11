'use strict';
/**
 * Pure calculation engine (no database access) so every figure can be unit-tested.
 *
 * Money rules enforced here:
 *  - Actual cost (accrual) is never mixed with cash. Profit uses cost, never cash receipts.
 *  - Committed cost (open purchase orders not yet received) is never counted as paid or actual.
 *  - Original budget and approved variations are kept apart; only APPROVED variations count.
 *  - Every money figure is returned with a `basis` label: actual | estimated | forecast | awaiting_approval.
 */

const DAY = 86400000;
const DEFAULT_THRESHOLDS = {
  cost_warning_pct: 90,    // budget consumption warning
  cost_critical_pct: 100,  // budget exceeded
  delay_warning_days: 3,
  delay_critical_days: 14,
  margin_warning_pct: 10,
  margin_critical_pct: 0,
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function parseDate(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fmtDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(s, n) { return fmtDate(parseDate(s) + n * DAY); }
function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / DAY); } // a - b

/** Stock position for one material from ledger totals. */
function stockPosition(t) {
  const store = (t.receive || 0) - (t.issue || 0) + (t.adjust || 0);
  const site = (t.issue || 0) - (t.consume || 0) - (t.waste || 0);
  return { store: round2(store), site: round2(site) };
}

/**
 * Schedule forecast per activity.
 * activities: [{id, planned_qty, done_qty, planned_start, planned_end, productivity_per_day, first_report_date, deps:[ids]}]
 */
function forecastSchedule(activities, today) {
  const byId = new Map(activities.map((a) => [a.id, a]));
  const memo = new Map();
  const visiting = new Set();

  function calc(a) {
    if (memo.has(a.id)) return memo.get(a.id);
    if (visiting.has(a.id)) return { start: a.planned_start, finish: a.planned_end, delay_days: 0, rate: 0, complete: false, cycle: true };
    visiting.add(a.id);

    const done = a.done_qty || 0;
    const remaining = Math.max(a.planned_qty - done, 0);
    let res;
    if (remaining <= 1e-9) {
      res = { start: a.first_report_date || a.planned_start, finish: a.planned_end, delay_days: 0, rate: 0, complete: true };
    } else {
      let predFinish = null;
      for (const d of a.deps || []) {
        const p = byId.get(d);
        if (!p) continue;
        const pf = calc(p).finish;
        if (!predFinish || parseDate(pf) > parseDate(predFinish)) predFinish = pf;
      }
      const plannedDuration = Math.max(diffDays(a.planned_end, a.planned_start) + 1, 1);
      let rate;
      let base;
      if (done > 0 && a.first_report_date) {
        const elapsed = Math.max(diffDays(today, a.first_report_date) + 1, 1);
        // Little history is noisy: blend measured pace with the approved productivity until ~14 days of data exist.
        const planned = a.productivity_per_day > 0 ? a.productivity_per_day : a.planned_qty / plannedDuration;
        const w = Math.min(elapsed / 14, 1);
        rate = w * (done / elapsed) + (1 - w) * planned;
        base = parseDate(today) > parseDate(a.planned_start) ? today : a.planned_start;
      } else {
        rate = a.productivity_per_day > 0 ? a.productivity_per_day : a.planned_qty / plannedDuration;
        base = parseDate(today) > parseDate(a.planned_start) ? today : a.planned_start;
      }
      if (predFinish) {
        const earliest = addDays(predFinish, 1);
        if (parseDate(earliest) > parseDate(base) && !(done > 0)) base = earliest;
      }
      const daysNeeded = Math.max(Math.ceil(remaining / rate - 1e-9), 1);
      const finish = addDays(base, daysNeeded - 1 + (done > 0 ? 1 : 0));
      const start = done > 0 && a.first_report_date ? a.first_report_date : base;
      res = {
        start,
        finish,
        delay_days: Math.max(diffDays(finish, a.planned_end), 0),
        rate: round2(rate),
        complete: false,
      };
    }
    visiting.delete(a.id);
    memo.set(a.id, res);
    return res;
  }

  const out = {};
  for (const a of activities) out[a.id] = calc(a);
  return out;
}

/** Cost, progress and profit metrics for one project. */
function projectMetrics(input) {
  const { project, activities, variations = [], unallocatedActual = 0, cash = {}, invoiced = 0, today } = input;
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };

  const approved = variations.filter((v) => v.status === 'approved');
  const pending = variations.filter((v) => v.status === 'pending');
  const sum = (arr, k) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);

  const originalBudget = sum(activities, 'budget_cost');
  const approvedCostVar = sum(approved, 'cost_amount');
  const approvedRevVar = sum(approved, 'revenue_amount');
  const revisedBudget = originalBudget + approvedCostVar;
  const pendingCostVar = sum(pending, 'cost_amount');

  const sched = forecastSchedule(activities.map((a) => ({ ...a })), today);

  let earned = 0, actualActivities = 0, eacActivities = 0, committedTotal = 0, activityBudgetTotal = 0;
  const rows = activities.map((a) => {
    const actVar = approved.filter((v) => v.activity_id === a.id).reduce((s, v) => s + Number(v.cost_amount), 0);
    const budget = a.budget_cost + actVar;
    const done = a.done_qty || 0;
    const pct = Math.min(done / a.planned_qty, 1);
    const ac = a.actual_cost || 0;
    const committed = a.committed_cost || 0;
    let etc;
    if (pct >= 1) etc = 0;
    else if (pct >= 0.1 && done > 0) etc = (Math.max(a.planned_qty - done, 0)) * (ac / done); // current unit cost
    else etc = Math.max((1 - pct) * budget, 0);                                               // too early: budget-based
    const eac = ac + (pct >= 1 ? 0 : Math.max(etc, committed));
    earned += pct * budget;
    actualActivities += ac;
    eacActivities += eac;
    committedTotal += committed;
    activityBudgetTotal += budget;
    const consumption = budget > 0 ? (ac / budget) * 100 : (ac > 0 ? Infinity : 0);
    let flag = 'ok';
    if (ac > budget) flag = 'over_budget';
    else if (consumption >= th.cost_warning_pct && pct < 1) flag = 'near_budget';
    return {
      id: a.id, code: a.code, name: a.name, unit: a.unit,
      planned_qty: a.planned_qty, done_qty: round2(done), remaining_qty: round2(Math.max(a.planned_qty - done, 0)),
      progress_pct: round2(pct * 100),
      original_budget: round2(a.budget_cost), approved_variations: round2(actVar), revised_budget: round2(budget),
      actual_cost: round2(ac), committed_cost: round2(committed),
      earned_value: round2(pct * budget), cost_variance: round2(pct * budget - ac),
      forecast_final_cost: round2(eac), variance_at_completion: round2(budget - eac),
      consumption_pct: Number.isFinite(consumption) ? round2(consumption) : null,
      cost_flag: flag,
      schedule: { ...sched[a.id], planned_start: a.planned_start, planned_end: a.planned_end },
    };
  });

  const actualCost = actualActivities + unallocatedActual;
  const forecastFinalCost = eacActivities + unallocatedActual;
  const unallocatedBudget = revisedBudget - activityBudgetTotal; // project-level variations / contingency
  const forecastRevenue = Number(project.contract_value) + approvedRevVar;
  // Unspent project-level contingency is not assumed to be spent (conservative neutral view): only actual spend counts.
  const forecastProfit = forecastRevenue - forecastFinalCost;
  const margin = forecastRevenue > 0 ? (forecastProfit / forecastRevenue) * 100 : 0;
  const progress = activityBudgetTotal > 0 ? (earned / activityBudgetTotal) * 100 : 0;

  const projectDelay = rows.reduce((m, r) => Math.max(m, r.schedule.delay_days || 0), 0);
  const forecastEnd = rows.reduce((m, r) => (!m || parseDate(r.schedule.finish) > parseDate(m) ? r.schedule.finish : m), null);

  const cashIn = cash.in || 0;
  const cashOut = cash.out || 0;

  return {
    today,
    budget: {
      original: round2(originalBudget), approved_variations: round2(approvedCostVar),
      revised: round2(revisedBudget), pending_variations: round2(pendingCostVar), unallocated: round2(unallocatedBudget),
      basis: 'approved',
    },
    costs: {
      actual: round2(actualCost), committed: round2(committedTotal),
      actual_plus_committed: round2(actualCost + committedTotal),
      remaining_budget: round2(revisedBudget - actualCost - committedTotal),
      consumption_pct: revisedBudget > 0 ? round2((actualCost / revisedBudget) * 100) : 0,
      earned_value: round2(earned), cost_variance: round2(earned - actualCost),
      forecast_final_cost: round2(forecastFinalCost), variance_at_completion: round2(revisedBudget - forecastFinalCost),
      bases: { actual: 'actual', committed: 'estimated', forecast_final_cost: 'forecast', pending_variations: 'awaiting_approval' },
    },
    profit: {
      contract_value: round2(project.contract_value), approved_revenue_variations: round2(approvedRevVar),
      forecast_revenue: round2(forecastRevenue), forecast_profit: round2(forecastProfit),
      forecast_margin_pct: round2(margin), basis: 'forecast',
      // Profit to date on an accrual basis: earned revenue share minus actual cost. Never from cash.
      earned_revenue: round2(forecastRevenue * (progress / 100)),
      profit_to_date: round2(forecastRevenue * (progress / 100) - actualCost),
    },
    cash: {
      received: round2(cashIn), paid: round2(cashOut), net: round2(cashIn - cashOut),
      invoiced: round2(invoiced), receivable: round2(invoiced - cashIn), basis: 'actual',
    },
    progress_pct: round2(progress),
    schedule: { delay_days: projectDelay, forecast_end: forecastEnd, planned_end: project.end_date },
    activities: rows,
    thresholds: th,
  };
}

/** Material shortages: required for REMAINING work vs what is on hand or on order. */
function materialShortages(requirements, availability) {
  // requirements: {material_id: {name, unit, required}} ; availability: {material_id: {store, site, on_order}}
  const out = [];
  for (const [id, r] of Object.entries(requirements)) {
    const a = availability[id] || { store: 0, site: 0, on_order: 0 };
    const available = (a.store || 0) + (a.site || 0) + (a.on_order || 0);
    const shortage = Math.max(r.required - available, 0);
    out.push({
      material_id: Number(id), name: r.name, unit: r.unit,
      required: round2(r.required), store: round2(a.store || 0), site: round2(a.site || 0), on_order: round2(a.on_order || 0),
      available: round2(available), shortage: round2(shortage), short: shortage > 1e-9,
    });
  }
  return out.sort((x, y) => y.shortage - x.shortage);
}

/** Request stock check: how much can come from store, how much must be purchased. */
function stockCheck(qtyRequested, storeQty, reservedQty = 0) {
  const free = Math.max(storeQty - reservedQty, 0);
  const fromStock = Math.min(qtyRequested, free);
  return { free: round2(free), from_stock: round2(fromStock), to_purchase: round2(qtyRequested - fromStock) };
}

/** Alerts derived from metrics and thresholds. Keys are stable so re-runs do not duplicate. */
function buildAlerts(projectId, m, shortages = []) {
  const th = m.thresholds;
  const alerts = [];
  const add = (type, severity, message, extra = '') =>
    alerts.push({ project_id: projectId, type, severity, message, alert_key: `${projectId}:${type}${extra}` });

  const c = m.costs.consumption_pct;
  if (c > th.cost_critical_pct) add('budget_exceeded', 'critical', `Actual cost is ${c}% of the revised budget`);
  else if (c >= th.cost_warning_pct) add('budget_warning', 'warning', `Actual cost reached ${c}% of the revised budget`);

  if (m.costs.forecast_final_cost > m.budget.revised && m.budget.revised > 0)
    add('forecast_overrun', 'warning', `Forecast final cost exceeds revised budget by ${round2(m.costs.forecast_final_cost - m.budget.revised)}`);

  if (m.profit.forecast_margin_pct <= th.margin_critical_pct) add('margin_critical', 'critical', `Forecast margin is ${m.profit.forecast_margin_pct}%`);
  else if (m.profit.forecast_margin_pct < th.margin_warning_pct) add('margin_warning', 'warning', `Forecast margin is ${m.profit.forecast_margin_pct}%`);

  const d = m.schedule.delay_days;
  if (d >= th.delay_critical_days) add('schedule_critical', 'critical', `Project forecast to finish ${d} days late`);
  else if (d >= th.delay_warning_days) add('schedule_warning', 'warning', `Project forecast to finish ${d} days late`);

  for (const a of m.activities) {
    if (a.cost_flag === 'over_budget') add('activity_over_budget', 'warning', `${a.code} ${a.name} exceeds its budget`, `:${a.id}`);
  }
  for (const s of shortages.filter((x) => x.short))
    add('material_shortage', 'warning', `${s.name}: short by ${s.shortage} ${s.unit}`, `:${s.material_id}`);

  return alerts;
}

/** Propose revised dates from the forecast. Never applied without approval. */
function proposeRevision(metrics) {
  return metrics.activities
    .filter((a) => !a.schedule.complete && (a.schedule.finish !== a.schedule.planned_end || a.schedule.start !== a.schedule.planned_start))
    .filter((a) => a.schedule.delay_days > 0)
    .map((a) => ({
      activity_id: a.id, code: a.code,
      old_start: a.schedule.planned_start, old_end: a.schedule.planned_end,
      new_start: parseDate(a.schedule.start) > parseDate(a.schedule.planned_start) ? a.schedule.start : a.schedule.planned_start,
      new_end: a.schedule.finish,
    }));
}

module.exports = {
  DEFAULT_THRESHOLDS, round2, parseDate, addDays, diffDays,
  stockPosition, forecastSchedule, projectMetrics, materialShortages, stockCheck, buildAlerts, proposeRevision,
};
