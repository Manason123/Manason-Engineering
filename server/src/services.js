'use strict';
const E = require('./engine');
const { getThresholds } = require('./db');
const { HttpError } = require('./validate');

/** Gather everything the engine needs for one project from the database. */
function projectInputs(db, project, today) {
  const activities = db.prepare(`
    SELECT a.*,
      COALESCE((SELECT SUM(rl.completed_qty) FROM report_lines rl JOIN daily_reports r ON r.id = rl.report_id
                WHERE rl.activity_id = a.id AND r.status = 'approved'), 0) AS done_qty,
      (SELECT MIN(r.report_date) FROM report_lines rl JOIN daily_reports r ON r.id = rl.report_id
                WHERE rl.activity_id = a.id AND r.status = 'approved' AND rl.completed_qty > 0) AS first_report_date,
      COALESCE((SELECT SUM(c.amount) FROM cost_entries c WHERE c.activity_id = a.id AND c.status = 'actual'), 0) AS actual_cost,
      COALESCE((SELECT SUM(MAX(po.qty - COALESCE((SELECT SUM(d.qty_received) FROM deliveries d
                                                   WHERE d.po_id = po.id AND d.status = 'received'), 0), 0) * po.unit_price)
                FROM purchase_orders po WHERE po.activity_id = a.id AND po.status = 'open'), 0) AS committed_cost
    FROM activities a WHERE a.project_id = ? ORDER BY a.code`).all(project.id);

  const deps = db.prepare(`SELECT d.activity_id, d.depends_on_id FROM activity_deps d
                           JOIN activities a ON a.id = d.activity_id WHERE a.project_id = ?`).all(project.id);
  for (const a of activities) a.deps = deps.filter((d) => d.activity_id === a.id).map((d) => d.depends_on_id);

  const variations = db.prepare('SELECT * FROM budget_variations WHERE project_id = ?').all(project.id);
  const unallocatedActual = db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM cost_entries WHERE project_id = ? AND activity_id IS NULL AND status = 'actual'",
  ).get(project.id).s;
  const cashRows = db.prepare(
    "SELECT direction, COALESCE(SUM(amount),0) s FROM cash_transactions WHERE project_id = ? AND status = 'approved' GROUP BY direction",
  ).all(project.id);
  const cash = { in: 0, out: 0 };
  for (const r of cashRows) cash[r.direction] = r.s;
  const invoiced = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE project_id = ? AND status = 'issued'").get(project.id).s;

  return { project, activities, variations, unallocatedActual, cash, invoiced, today, thresholds: getThresholds(db) };
}

function metricsFor(db, project, today) {
  return E.projectMetrics(projectInputs(db, project, today));
}

/** Ledger totals per material: {material_id: {receive, issue, consume, waste, adjust}} */
function stockTotals(db, projectId) {
  const rows = db.prepare(`SELECT material_id, type, SUM(qty) q FROM inventory_txns WHERE project_id = ? GROUP BY material_id, type`).all(projectId);
  const out = {};
  for (const r of rows) (out[r.material_id] ||= {})[r.type] = r.q;
  return out;
}

function stockFor(db, projectId, materialId) {
  const t = stockTotals(db, projectId)[materialId] || {};
  return E.stockPosition(t);
}

/** Store quantity already promised to approved requests but not yet issued. */
function reservedStock(db, projectId, materialId, excludeRequestId = null) {
  return db.prepare(`SELECT COALESCE(SUM(qty_from_stock - qty_issued),0) s FROM material_requests
    WHERE project_id = ? AND material_id = ? AND status = 'approved' AND id <> ?`).get(projectId, materialId, excludeRequestId || 0).s;
}

function onOrder(db, projectId) {
  const rows = db.prepare(`
    SELECT po.material_id, SUM(MAX(po.qty - COALESCE((SELECT SUM(d.qty_received) FROM deliveries d WHERE d.po_id = po.id AND d.status='received'),0), 0)) q
    FROM purchase_orders po WHERE po.project_id = ? AND po.status = 'open' GROUP BY po.material_id`).all(projectId);
  const out = {};
  for (const r of rows) out[r.material_id] = r.q;
  return out;
}

/** Shortages for REMAINING work, using approved productivity/technical specifications (activity_resources). */
function shortagesFor(db, project, metrics) {
  const remainingByAct = new Map(metrics.activities.map((a) => [a.id, a.remaining_qty]));
  const res = db.prepare(`SELECT ar.*, m.name AS mat_name, m.unit AS mat_unit FROM activity_resources ar
    JOIN activities a ON a.id = ar.activity_id JOIN materials m ON m.id = ar.material_id
    WHERE a.project_id = ? AND ar.type = 'material'`).all(project.id);
  const req = {};
  for (const r of res) {
    const rem = remainingByAct.get(r.activity_id) || 0;
    const o = (req[r.material_id] ||= { name: r.mat_name, unit: r.mat_unit, required: 0 });
    o.required += rem * r.qty_per_unit;
  }
  const totals = stockTotals(db, project.id);
  const oo = onOrder(db, project.id);
  const avail = {};
  for (const id of Object.keys(req)) {
    const p = E.stockPosition(totals[id] || {});
    avail[id] = { store: p.store, site: p.site, on_order: oo[id] || 0 };
  }
  return E.materialShortages(req, avail);
}

/** Resource requirements (materials, labour, equipment) for remaining work. */
function resourceRequirements(db, project, metrics) {
  const remaining = new Map(metrics.activities.map((a) => [a.id, a]));
  const rows = db.prepare(`SELECT ar.*, m.name AS mat_name FROM activity_resources ar
    JOIN activities a ON a.id = ar.activity_id LEFT JOIN materials m ON m.id = ar.material_id WHERE a.project_id = ?`).all(project.id);
  return rows.map((r) => {
    const act = remaining.get(r.activity_id);
    const rem = act ? act.remaining_qty : 0;
    return {
      activity_id: r.activity_id, activity_code: act && act.code, type: r.type,
      name: r.mat_name || r.name, unit: r.unit,
      required_for_remaining: E.round2(rem * r.qty_per_unit),
      estimated_cost: E.round2(rem * r.qty_per_unit * r.unit_cost),
      basis: 'estimated',
    };
  });
}

function refreshAlerts(db, project, today) {
  const m = metricsFor(db, project, today);
  const sh = shortagesFor(db, project, m);
  const alerts = E.buildAlerts(project.id, m, sh);
  const up = db.prepare(`INSERT INTO alerts(project_id, type, severity, message, alert_key) VALUES (@project_id,@type,@severity,@message,@alert_key)
    ON CONFLICT(alert_key) DO UPDATE SET message = excluded.message, severity = excluded.severity, resolved_at = NULL`);
  const tx = db.transaction(() => {
    for (const a of alerts) up.run(a);
    const keys = alerts.map((a) => a.alert_key);
    const open = db.prepare('SELECT id, alert_key FROM alerts WHERE project_id = ? AND resolved_at IS NULL').all(project.id);
    const resolve = db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?");
    for (const o of open) if (!keys.includes(o.alert_key)) resolve.run(o.id);
  });
  tx();
  return { metrics: m, shortages: sh, alerts };
}

function refreshAllAlerts(db, today) {
  for (const p of db.prepare("SELECT * FROM projects WHERE status IN ('active','planning')").all()) refreshAlerts(db, p, today);
}

/** Insert an accounting cost once per source. Returns true if inserted, false if it already existed. */
function postCost(db, c) {
  const r = db.prepare(`INSERT OR IGNORE INTO cost_entries
    (project_id, activity_id, category, description, amount, status, entry_date, source_type, source_id, reverses_id, reason, created_by)
    VALUES (@project_id,@activity_id,@category,@description,@amount,@status,@entry_date,@source_type,@source_id,@reverses_id,@reason,@created_by)`)
    .run({ activity_id: null, status: 'actual', source_type: null, source_id: null, reverses_id: null, reason: null, created_by: null, ...c });
  return r.changes > 0;
}

/** Approved report: confirms labour/equipment cost and material consumption/waste. Material cost was booked at receipt. */
function applyApprovedReport(db, report, user) {
  const labour = db.prepare('SELECT * FROM report_labour WHERE report_id = ?').all(report.id);
  const equip = db.prepare('SELECT * FROM report_equipment WHERE report_id = ?').all(report.id);
  const mats = db.prepare('SELECT * FROM report_materials WHERE report_id = ?').all(report.id);

  // Check site stock first: a material cannot be consumed unless it was issued to site.
  const totals = stockTotals(db, report.project_id);
  const need = {};
  for (const m of mats) need[m.material_id] = (need[m.material_id] || 0) + m.qty_consumed + m.qty_wasted;
  for (const [mid, q] of Object.entries(need)) {
    const site = E.stockPosition(totals[mid] || {}).site;
    if (q > site + 1e-9) {
      const name = db.prepare('SELECT name FROM materials WHERE id = ?').get(mid).name;
      throw new HttpError(409, `Cannot approve: ${name} consumed/wasted (${q}) exceeds quantity issued to site (${site}). Issue stock first.`);
    }
  }

  for (const l of labour) {
    const amount = E.round2(l.workers * l.hours * l.hourly_rate);
    if (amount > 0) postCost(db, { project_id: report.project_id, activity_id: l.activity_id, category: 'labour',
      description: `Labour ${l.trade} ${report.report_date}`, amount, entry_date: report.report_date, source_type: 'report_labour', source_id: l.id, created_by: user.id });
  }
  for (const e of equip) {
    const amount = E.round2(e.hours * e.hourly_rate);
    if (amount > 0) postCost(db, { project_id: report.project_id, activity_id: e.activity_id, category: 'equipment',
      description: `Equipment ${e.name} ${report.report_date}`, amount, entry_date: report.report_date, source_type: 'report_equipment', source_id: e.id, created_by: user.id });
  }
  const ins = db.prepare(`INSERT INTO inventory_txns(project_id, material_id, type, qty, unit_price, ref_type, ref_id, created_by)
    VALUES (?,?,?,?,?,'daily_report',?,?)`);
  for (const m of mats) {
    if (m.qty_consumed > 0) ins.run(report.project_id, m.material_id, 'consume', m.qty_consumed, 0, report.id, user.id);
    if (m.qty_wasted > 0) ins.run(report.project_id, m.material_id, 'waste', m.qty_wasted, 0, report.id, user.id);
  }
}

module.exports = {
  projectInputs, metricsFor, stockTotals, stockFor, reservedStock, onOrder, shortagesFor, resourceRequirements,
  refreshAlerts, refreshAllAlerts, postCost, applyApprovedReport,
};
