'use strict';
const express = require('express');
const E = require('./engine');
const S = require('./services');
const V = require('./validate');
const { audit, getThresholds } = require('./db');
const { hasPerm } = require('./auth');

const { HttpError, bad } = V;

module.exports = function opsRoutes({ db, auth, backupDir }) {
  const r = express.Router();
  r.use(auth.requireAuth);
  const tx = (fn) => db.transaction(fn)();
  const wrap = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
  const intParam = (v, n = 'id') => { const x = Number(v); if (!Number.isInteger(x) || x < 1) throw bad(`${n} is invalid`); return x; };
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  // ---------- master data ----------
  r.get('/materials', (req, res) => res.json(q('SELECT * FROM materials ORDER BY name')));
  r.post('/materials', wrap((req, res) => {
    if (!['owner', 'admin', 'project_manager', 'storekeeper', 'accountant'].includes(req.user.role)) throw new HttpError(403, 'Not allowed for your role');
    const name = V.str(req.body.name, 'name', { max: 120 });
    if (one('SELECT 1 FROM materials WHERE lower(name) = lower(?)', name)) throw new HttpError(409, 'Material already exists');
    const id = db.prepare('INSERT INTO materials(name,unit,default_price) VALUES (?,?,?)').run(name, V.str(req.body.unit, 'unit', { max: 20 }), V.num(req.body.default_price ?? 0, 'default_price', { min: 0 })).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'material', entity_id: id, after: req.body });
    res.status(201).json({ id });
  }));
  r.get('/suppliers', (req, res) => res.json(q('SELECT * FROM suppliers ORDER BY name')));
  r.post('/suppliers', wrap((req, res) => {
    if (!hasPerm(req.user.role, 'po.manage')) throw new HttpError(403, 'Not allowed for your role');
    const name = V.str(req.body.name, 'name', { max: 160 });
    if (one('SELECT 1 FROM suppliers WHERE lower(name) = lower(?)', name)) throw new HttpError(409, 'Supplier already exists');
    const id = db.prepare('INSERT INTO suppliers(name,phone,email) VALUES (?,?,?)').run(name, V.str(req.body.phone, 'phone', { required: false }), V.str(req.body.email, 'email', { required: false })).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'supplier', entity_id: id, after: req.body });
    res.status(201).json({ id });
  }));

  // ---------- material requests ----------
  const loadReq = (id, pid) => { const x = one('SELECT * FROM material_requests WHERE id = ? AND project_id = ?', id, pid); if (!x) throw new HttpError(404, 'Request not found'); return x; };
  const reqStage = (x) => {
    if (x.status !== 'approved') return x.status;
    if (x.qty_issued >= x.qty_approved - 1e-9) return 'issued';
    if (x.qty_received > 0) return 'received';
    if (x.qty_delivered > 0) return 'delivered';
    if (x.qty_purchased > 0) return 'purchased';
    return 'approved';
  };
  r.get('/projects/:pid/requests', auth.project('view'), (req, res) =>
    res.json(q(`SELECT mr.*, m.name AS material_name, m.unit, a.code AS activity_code, u.name AS requested_by_name
      FROM material_requests mr JOIN materials m ON m.id = mr.material_id LEFT JOIN activities a ON a.id = mr.activity_id LEFT JOIN users u ON u.id = mr.requested_by
      WHERE mr.project_id = ? ORDER BY mr.id DESC`, req.project.id).map((x) => ({ ...x, stage: reqStage(x) }))));
  r.post('/projects/:pid/requests', auth.project('request.create'), wrap((req, res) => {
    const b = req.body; const pid = req.project.id;
    const material_id = intParam(b.material_id, 'material_id');
    if (!one('SELECT 1 FROM materials WHERE id = ?', material_id)) throw new HttpError(404, 'Material not found');
    let activity_id = null;
    if (b.activity_id) { activity_id = intParam(b.activity_id, 'activity_id'); if (!one('SELECT 1 FROM activities WHERE id = ? AND project_id = ?', activity_id, pid)) throw new HttpError(404, 'Activity not found'); }
    const needed_date = V.date(b.needed_date, 'needed_date');
    const qty = V.num(b.qty_requested, 'qty_requested', { gt: 0 });
    const store = S.stockFor(db, pid, material_id).store;
    const chk = E.stockCheck(qty, store, S.reservedStock(db, pid, material_id));
    const id = db.prepare(`INSERT INTO material_requests(project_id,activity_id,material_id,needed_date,qty_requested,stock_at_request,requested_by,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(pid, activity_id, material_id, needed_date, qty, chk.free, req.user.id, V.str(b.note, 'note', { required: false })).lastInsertRowid;
    audit(db, { user: req.user, action: 'request', entity: 'material_request', entity_id: id, project_id: pid, after: { material_id, qty, needed_date } });
    res.status(201).json({ id, status: 'requested', stock_check: chk });
  }));
  r.post('/projects/:pid/requests/:id/decide', auth.project('request.approve'), wrap((req, res) => {
    const x = loadReq(intParam(req.params.id), req.project.id);
    if (x.status !== 'requested') throw new HttpError(409, `Request is already ${x.status}`);
    const approve = req.body.approve === true;
    const note = V.str(req.body.note, 'note', { required: !approve });
    tx(() => {
      if (!approve) {
        db.prepare("UPDATE material_requests SET status='rejected', decided_by=?, decided_at=datetime('now'), note=COALESCE(?,note) WHERE id=?").run(req.user.id, note, x.id);
      } else {
        const qa = V.num(req.body.qty_approved ?? x.qty_requested, 'qty_approved', { gt: 0, max: x.qty_requested });
        const store = S.stockFor(db, x.project_id, x.material_id).store;
        const chk = E.stockCheck(qa, store, S.reservedStock(db, x.project_id, x.material_id, x.id));
        db.prepare("UPDATE material_requests SET status='approved', qty_approved=?, qty_from_stock=?, qty_to_purchase=?, decided_by=?, decided_at=datetime('now') WHERE id=?")
          .run(qa, chk.from_stock, chk.to_purchase, req.user.id, x.id);
      }
      audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'material_request', entity_id: x.id, project_id: x.project_id, reason: note });
    });
    res.json({ ok: true, request: { ...loadReq(x.id, x.project_id) } });
  }));
  r.post('/projects/:pid/requests/:id/cancel', auth.project('request.create'), wrap((req, res) => {
    const x = loadReq(intParam(req.params.id), req.project.id);
    if (!['requested', 'approved'].includes(x.status)) throw new HttpError(409, `Request is ${x.status}`);
    if (x.qty_purchased > 0 || x.qty_issued > 0) throw new HttpError(409, 'Cannot cancel: purchasing or issuing has started');
    if (x.requested_by !== req.user.id && !hasPerm(req.user.role, 'request.approve')) throw new HttpError(403, 'Only the requester or an approver can cancel');
    const reason = V.reason(req.body.reason);
    db.prepare("UPDATE material_requests SET status='cancelled' WHERE id=?").run(x.id);
    audit(db, { user: req.user, action: 'cancel', entity: 'material_request', entity_id: x.id, project_id: x.project_id, reason });
    res.json({ ok: true });
  }));

  // ---------- purchasing ----------
  const poView = (pid) => q(`SELECT po.*, m.name AS material_name, m.unit, s.name AS supplier_name, a.code AS activity_code,
      COALESCE((SELECT SUM(qty_delivered) FROM deliveries d WHERE d.po_id = po.id AND d.status <> 'cancelled'),0) AS qty_delivered,
      COALESCE((SELECT SUM(qty_received) FROM deliveries d WHERE d.po_id = po.id AND d.status = 'received'),0) AS qty_received
    FROM purchase_orders po JOIN materials m ON m.id = po.material_id JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN activities a ON a.id = po.activity_id
    WHERE po.project_id = ? ORDER BY po.id DESC`, pid).map((p) => ({
    ...p, value: E.round2(p.qty * p.unit_price),
    committed: p.status === 'open' ? E.round2(Math.max(p.qty - p.qty_received, 0) * p.unit_price) : 0, basis: 'estimated',
  }));
  r.get('/projects/:pid/purchase-orders', auth.project('view'), (req, res) => res.json(poView(req.project.id)));
  r.post('/projects/:pid/purchase-orders', auth.project('po.manage'), wrap((req, res) => {
    const b = req.body; const pid = req.project.id;
    const supplier_id = intParam(b.supplier_id, 'supplier_id');
    if (!one('SELECT 1 FROM suppliers WHERE id = ?', supplier_id)) throw new HttpError(404, 'Supplier not found');
    let material_id; let activity_id = null; let request = null;
    if (b.request_id) {
      request = loadReq(intParam(b.request_id, 'request_id'), pid);
      if (request.status !== 'approved') throw new HttpError(409, 'Only approved requests can be purchased');
      material_id = request.material_id; activity_id = request.activity_id;
    } else {
      material_id = intParam(b.material_id, 'material_id');
      if (b.activity_id) activity_id = intParam(b.activity_id, 'activity_id');
    }
    if (!one('SELECT 1 FROM materials WHERE id = ?', material_id)) throw new HttpError(404, 'Material not found');
    if (activity_id && !one('SELECT 1 FROM activities WHERE id = ? AND project_id = ?', activity_id, pid)) throw new HttpError(404, 'Activity not found');
    const qty = V.num(b.qty, 'qty', { gt: 0 });
    const unit_price = V.num(b.unit_price, 'unit_price', { min: 0 });
    if (request) {
      const left = request.qty_to_purchase - request.qty_purchased;
      if (qty > left + 1e-9) throw bad(`Quantity exceeds what still needs purchasing for this request (${E.round2(left)})`);
    }
    const id = tx(() => {
      const id = db.prepare('INSERT INTO purchase_orders(project_id,request_id,supplier_id,material_id,activity_id,qty,unit_price,created_by) VALUES (?,?,?,?,?,?,?,?)')
        .run(pid, request ? request.id : null, supplier_id, material_id, activity_id, qty, unit_price, req.user.id).lastInsertRowid;
      if (request) db.prepare('UPDATE material_requests SET qty_purchased = qty_purchased + ? WHERE id = ?').run(qty, request.id);
      audit(db, { user: req.user, action: 'create', entity: 'purchase_order', entity_id: id, project_id: pid, after: { material_id, qty, unit_price, supplier_id } });
      return id;
    });
    S.refreshAlerts(db, req.project, V.today());
    res.status(201).json({ id, committed: E.round2(qty * unit_price), basis: 'estimated' });
  }));
  r.post('/projects/:pid/purchase-orders/:id/cancel', auth.project('po.manage'), wrap((req, res) => {
    const po = one('SELECT * FROM purchase_orders WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!po) throw new HttpError(404, 'Purchase order not found');
    if (po.status !== 'open') throw new HttpError(409, `Order is ${po.status}`);
    if (one("SELECT 1 FROM deliveries WHERE po_id = ? AND status <> 'cancelled'", po.id)) throw new HttpError(409, 'Cannot cancel an order that already has deliveries');
    const reason = V.reason(req.body.reason);
    tx(() => {
      db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=?").run(po.id);
      if (po.request_id) db.prepare('UPDATE material_requests SET qty_purchased = MAX(qty_purchased - ?, 0) WHERE id = ?').run(po.qty, po.request_id);
      audit(db, { user: req.user, action: 'cancel', entity: 'purchase_order', entity_id: po.id, project_id: po.project_id, reason });
    });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));

  r.get('/projects/:pid/deliveries', auth.project('view'), (req, res) =>
    res.json(q(`SELECT d.*, m.name AS material_name, m.unit, s.name AS supplier_name, po.unit_price FROM deliveries d
      JOIN purchase_orders po ON po.id = d.po_id JOIN materials m ON m.id = po.material_id JOIN suppliers s ON s.id = po.supplier_id
      WHERE d.project_id = ? ORDER BY d.id DESC`, req.project.id)));
  // Delivery arrives (note recorded) -> inventory NOT changed yet.
  r.post('/projects/:pid/purchase-orders/:id/deliveries', auth.project('delivery.confirm'), wrap((req, res) => {
    const po = one('SELECT * FROM purchase_orders WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!po) throw new HttpError(404, 'Purchase order not found');
    if (po.status !== 'open') throw new HttpError(409, `Order is ${po.status}`);
    const note = V.str(req.body.delivery_note_no, 'delivery_note_no', { max: 60 });
    const qty = V.num(req.body.qty_delivered, 'qty_delivered', { gt: 0 });
    const delivered = one("SELECT COALESCE(SUM(qty_delivered),0) s FROM deliveries WHERE po_id = ? AND status <> 'cancelled'", po.id).s;
    if (delivered + qty > po.qty * 1.1 + 1e-9) throw bad('Total delivered would exceed the order quantity by more than the 10% tolerance');
    if (one('SELECT 1 FROM deliveries WHERE po_id = ? AND delivery_note_no = ?', po.id, note)) throw new HttpError(409, 'This delivery note was already recorded');
    const id = db.prepare('INSERT INTO deliveries(po_id,project_id,delivery_note_no,qty_delivered,delivered_date) VALUES (?,?,?,?,?)')
      .run(po.id, po.project_id, note, qty, V.date(req.body.delivered_date || V.today(), 'delivered_date')).lastInsertRowid;
    if (po.request_id) db.prepare('UPDATE material_requests SET qty_delivered = qty_delivered + ? WHERE id = ?').run(qty, po.request_id);
    audit(db, { user: req.user, action: 'create', entity: 'delivery', entity_id: id, project_id: po.project_id, after: { note, qty } });
    res.status(201).json({ id, status: 'delivered' });
  }));
  // Storekeeper confirms what was actually accepted -> inventory + actual material cost.
  r.post('/projects/:pid/deliveries/:id/confirm', auth.project('delivery.confirm'), wrap((req, res) => {
    const d = one('SELECT * FROM deliveries WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!d) throw new HttpError(404, 'Delivery not found');
    if (d.status !== 'delivered') throw new HttpError(409, `Delivery is already ${d.status}`);
    const qr = V.num(req.body.qty_received, 'qty_received', { min: 0, max: d.qty_delivered });
    const po = one('SELECT * FROM purchase_orders WHERE id = ?', d.po_id);
    tx(() => {
      db.prepare("UPDATE deliveries SET status='received', qty_received=?, confirmed_by=?, confirmed_at=datetime('now') WHERE id=?").run(qr, req.user.id, d.id);
      if (qr > 0) {
        db.prepare("INSERT INTO inventory_txns(project_id,material_id,type,qty,unit_price,ref_type,ref_id,request_id,created_by) VALUES (?,?,'receive',?,?,'delivery',?,?,?)")
          .run(d.project_id, po.material_id, qr, po.unit_price, d.id, po.request_id, req.user.id);
        S.postCost(db, { project_id: d.project_id, activity_id: po.activity_id, category: 'material', description: `Material received (note ${d.delivery_note_no})`,
          amount: E.round2(qr * po.unit_price), entry_date: V.today(), source_type: 'delivery', source_id: d.id, created_by: req.user.id });
      }
      if (po.request_id) db.prepare('UPDATE material_requests SET qty_received = qty_received + ? WHERE id = ?').run(qr, po.request_id);
      const rec = one("SELECT COALESCE(SUM(qty_received),0) s FROM deliveries WHERE po_id = ? AND status='received'", po.id).s;
      if (rec >= po.qty - 1e-9) db.prepare("UPDATE purchase_orders SET status='closed' WHERE id=?").run(po.id);
      audit(db, { user: req.user, action: 'confirm', entity: 'delivery', entity_id: d.id, project_id: d.project_id, after: { qty_received: qr, rejected: E.round2(d.qty_delivered - qr) } });
    });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true, qty_received: qr, rejected: E.round2(d.qty_delivered - qr) });
  }));
  // Short-delivered orders can be closed so commitment disappears.
  r.post('/projects/:pid/purchase-orders/:id/close', auth.project('po.manage'), wrap((req, res) => {
    const po = one('SELECT * FROM purchase_orders WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!po || po.status !== 'open') throw new HttpError(404, 'Open purchase order not found');
    if (one("SELECT 1 FROM deliveries WHERE po_id = ? AND status = 'delivered'", po.id)) throw new HttpError(409, 'Confirm pending deliveries first');
    const reason = V.reason(req.body.reason);
    db.prepare("UPDATE purchase_orders SET status='closed' WHERE id=?").run(po.id);
    audit(db, { user: req.user, action: 'close', entity: 'purchase_order', entity_id: po.id, project_id: po.project_id, reason });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));

  // ---------- issue to site / adjustments ----------
  r.post('/projects/:pid/issues', auth.project('stock.issue'), wrap((req, res) => {
    const pid = req.project.id; const b = req.body;
    const material_id = intParam(b.material_id, 'material_id'); const qty = V.num(b.qty, 'qty', { gt: 0 });
    let request = null;
    if (b.request_id) {
      request = loadReq(intParam(b.request_id, 'request_id'), pid);
      if (request.status !== 'approved' || request.material_id !== material_id) throw new HttpError(409, 'Request does not match this material or is not approved');
      if (request.qty_issued + qty > request.qty_approved + 1e-9) throw bad('Issue exceeds the approved quantity for this request');
    }
    const store = S.stockFor(db, pid, material_id).store;
    const reserved = S.reservedStock(db, pid, material_id, request ? request.id : null);
    if (qty > store + 1e-9) throw new HttpError(409, `Insufficient store stock: ${store} available`);
    if (!request && qty > store - reserved + 1e-9) throw new HttpError(409, `Only ${E.round2(store - reserved)} is unreserved; the rest is reserved for approved requests`);
    tx(() => {
      db.prepare("INSERT INTO inventory_txns(project_id,material_id,type,qty,ref_type,ref_id,request_id,created_by) VALUES (?,?,'issue',?,'issue',NULL,?,?)").run(pid, material_id, qty, request ? request.id : null, req.user.id);
      if (request) {
        db.prepare('UPDATE material_requests SET qty_issued = qty_issued + ? WHERE id = ?').run(qty, request.id);
        if (request.qty_issued + qty >= request.qty_approved - 1e-9) db.prepare("UPDATE material_requests SET status='closed' WHERE id=?").run(request.id);
      }
      audit(db, { user: req.user, action: 'issue', entity: 'inventory', project_id: pid, after: { material_id, qty, request_id: request && request.id } });
    });
    S.refreshAlerts(db, req.project, V.today());
    res.status(201).json({ ok: true });
  }));
  r.post('/projects/:pid/stock/adjust', auth.project('stock.issue'), wrap((req, res) => {
    const pid = req.project.id; const material_id = intParam(req.body.material_id, 'material_id');
    const qty = V.num(req.body.qty, 'qty'); if (qty === 0) throw bad('qty cannot be 0');
    const reason = V.reason(req.body.reason);
    if (qty < 0 && -qty > S.stockFor(db, pid, material_id).store + 1e-9) throw new HttpError(409, 'Adjustment would make store stock negative');
    db.prepare("INSERT INTO inventory_txns(project_id,material_id,type,qty,reason,ref_type,created_by) VALUES (?,?,'adjust',?,?,'adjustment',?)").run(pid, material_id, qty, reason, req.user.id);
    audit(db, { user: req.user, action: 'adjust', entity: 'inventory', project_id: pid, reason, after: { material_id, qty } });
    res.status(201).json({ ok: true });
  }));
  r.get('/projects/:pid/inventory', auth.project('stock.view'), (req, res) => {
    const pid = req.project.id; const totals = S.stockTotals(db, pid); const oo = S.onOrder(db, pid);
    const mats = q('SELECT * FROM materials ORDER BY name');
    const rq = q(`SELECT material_id, SUM(qty_requested) requested, SUM(qty_approved) approved, SUM(qty_purchased) purchased, SUM(qty_delivered) delivered,
      SUM(qty_received) received_for_requests, SUM(qty_issued) issued_for_requests FROM material_requests WHERE project_id = ? AND status <> 'cancelled' AND status <> 'rejected' GROUP BY material_id`, pid);
    const rqMap = Object.fromEntries(rq.map((x) => [x.material_id, x]));
    const rows = [];
    for (const m of mats) {
      const t = totals[m.id]; const x = rqMap[m.id];
      if (!t && !x) continue;
      const pos = E.stockPosition(t || {});
      const reserved = S.reservedStock(db, pid, m.id);
      rows.push({
        material_id: m.id, name: m.name, unit: m.unit, store: pos.store, site: pos.site, reserved: E.round2(reserved), free_store: E.round2(Math.max(pos.store - reserved, 0)),
        on_order: E.round2(oo[m.id] || 0),
        // each stage tracked separately:
        requested: x ? x.requested : 0, approved: x ? x.approved : 0, purchased: x ? x.purchased : 0, delivered: x ? x.delivered : 0,
        received: (t && t.receive) || 0, issued: (t && t.issue) || 0, consumed: (t && t.consume) || 0, wasted: (t && t.waste) || 0,
      });
    }
    res.json(rows);
  });
  r.get('/projects/:pid/inventory/ledger', auth.project('stock.view'), (req, res) =>
    res.json(q(`SELECT t.*, m.name AS material_name, u.name AS user_name FROM inventory_txns t JOIN materials m ON m.id = t.material_id LEFT JOIN users u ON u.id = t.created_by
      WHERE t.project_id = ? ORDER BY t.id DESC LIMIT 500`, req.project.id)));

  // ---------- finance ----------
  const fin = (perm) => auth.project(perm);
  r.get('/projects/:pid/costs', fin('finance.view'), (req, res) =>
    res.json(q(`SELECT c.*, a.code AS activity_code, (SELECT 1 FROM cost_entries x WHERE x.reverses_id = c.id) AS reversed
      FROM cost_entries c LEFT JOIN activities a ON a.id = c.activity_id WHERE c.project_id = ? ORDER BY c.id DESC LIMIT 1000`, req.project.id)
      .map((c) => ({ ...c, basis: c.status }))));
  r.post('/projects/:pid/costs', fin('finance.write'), wrap((req, res) => {
    const b = req.body; const pid = req.project.id;
    const category = V.oneOf(b.category, 'category', ['subcontract', 'overhead', 'other', 'material', 'labour', 'equipment']);
    const amount = V.num(b.amount, 'amount', { gt: 0 });
    const entry_date = V.date(b.entry_date || V.today(), 'entry_date');
    const description = V.str(b.description, 'description', { max: 300 });
    let activity_id = null;
    if (b.activity_id) { activity_id = intParam(b.activity_id, 'activity_id'); if (!one('SELECT 1 FROM activities WHERE id = ? AND project_id = ?', activity_id, pid)) throw new HttpError(404, 'Activity not found'); }
    const status = V.oneOf(b.status || 'actual', 'status', ['actual', 'estimated', 'awaiting_approval']);
    if (one("SELECT 1 FROM cost_entries WHERE project_id=? AND category=? AND amount=? AND entry_date=? AND lower(description)=lower(?) AND COALESCE(activity_id,0)=COALESCE(?,0) AND reverses_id IS NULL AND source_type IS NULL",
      pid, category, amount, entry_date, description, activity_id)) throw new HttpError(409, 'Duplicate cost entry: an identical entry already exists');
    const id = db.prepare(`INSERT INTO cost_entries(project_id,activity_id,category,description,amount,status,entry_date,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(pid, activity_id, category, description, amount, status, entry_date, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'cost_entry', entity_id: id, project_id: pid, after: { category, amount, status } });
    S.refreshAlerts(db, req.project, V.today());
    res.status(201).json({ id });
  }));
  r.post('/projects/:pid/costs/:id/approve', auth.roles('owner', 'admin'), auth.project('view'), wrap((req, res) => {
    const c = one('SELECT * FROM cost_entries WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!c || c.status !== 'awaiting_approval') throw new HttpError(404, 'No cost awaiting approval with this id');
    const approve = req.body.approve === true; const note = V.str(req.body.note, 'note', { required: !approve });
    db.prepare('UPDATE cost_entries SET status = ?, reason = COALESCE(?, reason) WHERE id = ?').run(approve ? 'actual' : 'estimated', note, c.id);
    audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'cost_entry', entity_id: c.id, project_id: c.project_id, reason: note });
    S.refreshAlerts(db, req.project, V.today());
    res.json({ ok: true });
  }));
  // Corrections never edit or delete: they add a negative, linked entry with a reason.
  r.post('/projects/:pid/costs/:id/reverse', fin('finance.write'), wrap((req, res) => {
    const c = one('SELECT * FROM cost_entries WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!c) throw new HttpError(404, 'Cost entry not found');
    if (c.reverses_id) throw new HttpError(409, 'A reversal cannot be reversed');
    if (one('SELECT 1 FROM cost_entries WHERE reverses_id = ?', c.id)) throw new HttpError(409, 'Already reversed');
    const reason = V.reason(req.body.reason);
    const id = db.prepare(`INSERT INTO cost_entries(project_id,activity_id,category,description,amount,status,entry_date,reverses_id,reason,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(c.project_id, c.activity_id, c.category, `Reversal of #${c.id}: ${c.description}`.slice(0, 300), -c.amount, c.status, V.today(), c.id, reason, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'reverse', entity: 'cost_entry', entity_id: c.id, project_id: c.project_id, reason, after: { reversal_id: id } });
    S.refreshAlerts(db, req.project, V.today());
    res.status(201).json({ id });
  }));

  const outstanding = (inv) => E.round2(inv.amount - one("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE invoice_id = ? AND status = 'approved'", inv.id).s);
  r.get('/projects/:pid/invoices', fin('finance.view'), (req, res) =>
    res.json(q('SELECT * FROM invoices WHERE project_id = ? ORDER BY issue_date DESC, id DESC', req.project.id).map((i) => ({ ...i, outstanding: i.status === 'cancelled' ? 0 : outstanding(i), overdue: i.status === 'issued' && outstanding(i) > 0 && i.due_date < V.today() }))));
  r.post('/projects/:pid/invoices', fin('finance.write'), wrap((req, res) => {
    const b = req.body; const number = V.str(b.number, 'number', { max: 60 });
    if (one('SELECT 1 FROM invoices WHERE project_id = ? AND lower(number) = lower(?)', req.project.id, number)) throw new HttpError(409, 'Invoice number already exists');
    const issue_date = V.date(b.issue_date || V.today(), 'issue_date'); const due_date = V.date(b.due_date, 'due_date');
    if (due_date < issue_date) throw bad('due_date cannot be before issue_date');
    const amount = V.num(b.amount, 'amount', { gt: 0 });
    const invoiced = one("SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE project_id = ? AND status='issued'", req.project.id).s;
    const rev = one("SELECT COALESCE(SUM(revenue_amount),0) s FROM budget_variations WHERE project_id = ? AND status='approved'", req.project.id).s;
    if (invoiced + amount > req.project.contract_value + rev + 1e-9) throw bad('Total invoiced would exceed the contract value (including approved variations)');
    const id = db.prepare('INSERT INTO invoices(project_id,number,amount,issue_date,due_date,created_by) VALUES (?,?,?,?,?,?)').run(req.project.id, number, amount, issue_date, due_date, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'invoice', entity_id: id, project_id: req.project.id, after: { number, amount } });
    res.status(201).json({ id });
  }));
  r.post('/projects/:pid/invoices/:id/cancel', fin('finance.write'), wrap((req, res) => {
    const i = one('SELECT * FROM invoices WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!i || i.status !== 'issued') throw new HttpError(404, 'Open invoice not found');
    if (one("SELECT 1 FROM cash_transactions WHERE invoice_id = ? AND status IN ('approved','pending_approval')", i.id)) throw new HttpError(409, 'Invoice has payments; reverse them first');
    const reason = V.reason(req.body.reason);
    db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(i.id);
    audit(db, { user: req.user, action: 'cancel', entity: 'invoice', entity_id: i.id, project_id: i.project_id, reason });
    res.json({ ok: true });
  }));

  const billPaid = (b) => one("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE bill_id = ? AND status IN ('approved','pending_approval')", b.id).s;
  r.get('/projects/:pid/bills', fin('finance.view'), (req, res) =>
    res.json(q('SELECT b.*, s.name AS supplier_name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE project_id = ? ORDER BY b.id DESC', req.project.id)
      .map((b) => ({ ...b, paid_or_pending: E.round2(billPaid(b)), outstanding: b.status === 'cancelled' ? 0 : E.round2(b.amount - billPaid(b)) }))));
  r.post('/projects/:pid/bills', fin('finance.write'), wrap((req, res) => {
    const b = req.body; const supplier_id = intParam(b.supplier_id, 'supplier_id'); const bill_no = V.str(b.bill_no, 'bill_no', { max: 60 });
    if (!one('SELECT 1 FROM suppliers WHERE id = ?', supplier_id)) throw new HttpError(404, 'Supplier not found');
    if (one('SELECT 1 FROM supplier_bills WHERE supplier_id = ? AND lower(bill_no) = lower(?)', supplier_id, bill_no)) throw new HttpError(409, 'This supplier bill is already recorded');
    const bill_date = V.date(b.bill_date || V.today(), 'bill_date'); const due_date = V.date(b.due_date, 'due_date');
    const id = db.prepare('INSERT INTO supplier_bills(project_id,supplier_id,bill_no,amount,bill_date,due_date,created_by) VALUES (?,?,?,?,?,?,?)').run(req.project.id, supplier_id, bill_no, V.num(b.amount, 'amount', { gt: 0 }), bill_date, due_date, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'supplier_bill', entity_id: id, project_id: req.project.id, after: b });
    res.status(201).json({ id });
  }));

  r.get('/projects/:pid/cash', fin('finance.view'), (req, res) =>
    res.json(q('SELECT c.*, u.name AS created_by_name FROM cash_transactions c LEFT JOIN users u ON u.id = c.created_by WHERE project_id = ? ORDER BY txn_date DESC, id DESC', req.project.id)
      .map((c) => ({ ...c, basis: c.status === 'approved' ? 'actual' : c.status === 'pending_approval' ? 'awaiting_approval' : c.status }))));
  r.post('/projects/:pid/cash', fin('finance.write'), wrap((req, res) => {
    const b = req.body; const pid = req.project.id;
    const kind = V.oneOf(b.kind, 'kind', ['client_payment', 'supplier_payment', 'payroll', 'expense']);
    const direction = kind === 'client_payment' ? 'in' : 'out';
    const amount = V.num(b.amount, 'amount', { gt: 0 });
    const reference = V.str(b.reference, 'reference', { max: 100 });
    const txn_date = V.date(b.txn_date || V.today(), 'txn_date');
    if (txn_date > V.today()) throw bad('Transaction date cannot be in the future');
    if (one('SELECT 1 FROM cash_transactions WHERE project_id = ? AND kind = ? AND lower(reference) = lower(?)', pid, kind, reference)) throw new HttpError(409, 'Duplicate transaction: this reference is already recorded');
    let invoice_id = null; let bill_id = null;
    if (kind === 'client_payment') {
      if (!b.invoice_id) throw bad('invoice_id is required for client payments');
      const inv = one('SELECT * FROM invoices WHERE id = ? AND project_id = ?', intParam(b.invoice_id, 'invoice_id'), pid);
      if (!inv || inv.status !== 'issued') throw new HttpError(404, 'Invoice not found or cancelled');
      if (amount > outstanding(inv) + 1e-9) throw bad(`Payment exceeds the invoice outstanding balance (${outstanding(inv)})`);
      invoice_id = inv.id;
    }
    if (kind === 'supplier_payment') {
      if (!b.bill_id) throw bad('bill_id is required for supplier payments');
      const bill = one('SELECT * FROM supplier_bills WHERE id = ? AND project_id = ?', intParam(b.bill_id, 'bill_id'), pid);
      if (!bill || bill.status !== 'open') throw new HttpError(404, 'Bill not found or cancelled');
      if (amount > bill.amount - billPaid(bill) + 1e-9) throw bad('Payment exceeds the bill outstanding balance (including payments awaiting approval)');
      bill_id = bill.id;
    }
    // Client receipts are facts; outgoing money needs human approval.
    const status = direction === 'in' ? 'approved' : 'pending_approval';
    const id = db.prepare(`INSERT INTO cash_transactions(project_id,direction,kind,amount,txn_date,reference,invoice_id,bill_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, direction, kind, amount, txn_date, reference, invoice_id, bill_id, status, req.user.id).lastInsertRowid;
    audit(db, { user: req.user, action: 'create', entity: 'cash_transaction', entity_id: id, project_id: pid, after: { kind, amount, status } });
    res.status(201).json({ id, status, basis: status === 'approved' ? 'actual' : 'awaiting_approval' });
  }));
  r.post('/projects/:pid/cash/:id/decide', auth.roles('owner', 'admin'), auth.project('view'), wrap((req, res) => {
    const c = one('SELECT * FROM cash_transactions WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!c) throw new HttpError(404, 'Transaction not found');
    if (c.status !== 'pending_approval') throw new HttpError(409, `Transaction is ${c.status}`);
    const approve = req.body.approve === true; const note = V.str(req.body.note, 'note', { required: !approve });
    db.prepare("UPDATE cash_transactions SET status = ?, approved_by = ?, reason = COALESCE(?, reason) WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, note, c.id);
    audit(db, { user: req.user, action: approve ? 'approve' : 'reject', entity: 'cash_transaction', entity_id: c.id, project_id: c.project_id, reason: note });
    res.json({ ok: true });
  }));
  r.post('/projects/:pid/cash/:id/reverse', auth.roles('owner', 'admin', 'accountant'), auth.project('finance.write'), wrap((req, res) => {
    const c = one('SELECT * FROM cash_transactions WHERE id = ? AND project_id = ?', intParam(req.params.id), req.project.id);
    if (!c || c.status !== 'approved') throw new HttpError(404, 'Approved transaction not found');
    const reason = V.reason(req.body.reason);
    db.prepare("UPDATE cash_transactions SET status='reversed', reason=? WHERE id=?").run(reason, c.id);
    audit(db, { user: req.user, action: 'reverse', entity: 'cash_transaction', entity_id: c.id, project_id: c.project_id, reason, before: { status: 'approved' }, after: { status: 'reversed' } });
    res.json({ ok: true });
  }));

  r.get('/projects/:pid/cashflow', fin('finance.view'), (req, res) => res.json(cashflow(req.project.id)));
  function cashflow(pid) {
    const cash = q("SELECT substr(txn_date,1,7) month, direction, SUM(amount) s FROM cash_transactions WHERE project_id = ? AND status='approved' GROUP BY month, direction", pid);
    const cost = q("SELECT substr(entry_date,1,7) month, SUM(amount) s FROM cost_entries WHERE project_id = ? AND status='actual' GROUP BY month", pid);
    const months = [...new Set([...cash.map((c) => c.month), ...cost.map((c) => c.month)])].sort();
    let cum = 0;
    return months.map((m) => {
      const inn = cash.find((c) => c.month === m && c.direction === 'in')?.s || 0;
      const out = cash.find((c) => c.month === m && c.direction === 'out')?.s || 0;
      cum += inn - out;
      return { month: m, cash_in: E.round2(inn), cash_out: E.round2(out), net_cash: E.round2(inn - out), cumulative_cash: E.round2(cum),
        accounting_cost: E.round2(cost.find((c) => c.month === m)?.s || 0), basis: 'actual' };
    });
  }

  // ---------- dashboards ----------
  const accessible = (u) => (auth.isGlobal(u)
    ? q('SELECT * FROM projects ORDER BY created_at DESC')
    : q('SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC', u.id));
  const canSeeMoney = (u) => hasPerm(u.role, 'finance.view');

  r.get('/dashboard', wrap((req, res) => {
    const today = V.today(); const money = canSeeMoney(req.user);
    const projects = accessible(req.user).filter((p) => !['cancelled'].includes(p.status));
    const rows = projects.map((p) => {
      const m = S.metricsFor(db, p, today); const sh = S.shortagesFor(db, p, m).filter((x) => x.short);
      const alerts = q('SELECT severity, COUNT(*) n FROM alerts WHERE project_id = ? AND resolved_at IS NULL GROUP BY severity', p.id);
      const row = {
        id: p.id, code: p.code, name: p.name, client_name: p.client_name, status: p.status, baseline_approved: !!p.baseline_approved,
        start_date: p.start_date, end_date: p.end_date, progress_pct: m.progress_pct,
        delay_days: m.schedule.delay_days, forecast_end: m.schedule.forecast_end, delayed: m.schedule.delay_days >= m.thresholds.delay_warning_days,
        material_shortages: sh.length, alerts: Object.fromEntries(alerts.map((a) => [a.severity, a.n])),
      };
      if (money) Object.assign(row, {
        contract_value: m.profit.contract_value, revised_budget: m.budget.revised, actual_cost: m.costs.actual, committed_cost: m.costs.committed,
        budget_consumption_pct: m.costs.consumption_pct, forecast_final_cost: m.costs.forecast_final_cost, forecast_profit: m.profit.forecast_profit,
        forecast_margin_pct: m.profit.forecast_margin_pct, over_budget: m.costs.forecast_final_cost > m.budget.revised && m.budget.revised > 0,
        cash_received: m.cash.received, cash_paid: m.cash.paid, receivable: m.cash.receivable,
        bases: { actual_cost: 'actual', committed_cost: 'estimated', forecast_final_cost: 'forecast', forecast_profit: 'forecast', cash_received: 'actual' },
      });
      return row;
    });
    const act = rows.filter((x) => x.status === 'active');
    const totals = { projects: rows.length, active: act.length, delayed: rows.filter((x) => x.delayed).length, material_shortages: rows.reduce((s, x) => s + x.material_shortages, 0) };
    if (money) Object.assign(totals, {
      contract_value: E.round2(act.reduce((s, x) => s + x.contract_value, 0)), actual_cost: E.round2(act.reduce((s, x) => s + x.actual_cost, 0)),
      forecast_profit: E.round2(act.reduce((s, x) => s + x.forecast_profit, 0)), forecast_final_cost: E.round2(act.reduce((s, x) => s + x.forecast_final_cost, 0)),
      over_budget: rows.filter((x) => x.over_budget).length, cash_received: E.round2(act.reduce((s, x) => s + x.cash_received, 0)),
      cash_paid: E.round2(act.reduce((s, x) => s + x.cash_paid, 0)), receivable: E.round2(act.reduce((s, x) => s + x.receivable, 0)),
    });
    res.json({ date: today, totals, projects: rows, show_money: money });
  }));

  r.get('/projects/:pid/dashboard', auth.project('view'), wrap((req, res) => {
    const today = V.today(); const money = canSeeMoney(req.user);
    const { metrics, shortages } = S.refreshAlerts(db, req.project, today);
    const out = {
      project: req.project, progress_pct: metrics.progress_pct, schedule: metrics.schedule, shortages,
      requirements: S.resourceRequirements(db, req.project, metrics),
      alerts: q('SELECT * FROM alerts WHERE project_id = ? AND resolved_at IS NULL ORDER BY severity DESC, id DESC', req.project.id),
      activities: metrics.activities.map((a) => money ? a : { id: a.id, code: a.code, name: a.name, unit: a.unit, planned_qty: a.planned_qty, done_qty: a.done_qty, remaining_qty: a.remaining_qty, progress_pct: a.progress_pct, schedule: a.schedule }),
      show_money: money,
    };
    if (money) Object.assign(out, { budget: metrics.budget, costs: metrics.costs, profit: metrics.profit, cash: metrics.cash, thresholds: metrics.thresholds, cashflow: cashflow(req.project.id) });
    res.json(out);
  }));

  r.get('/alerts', (req, res) => {
    const ids = accessible(req.user).map((p) => p.id);
    if (!ids.length) return res.json([]);
    res.json(q(`SELECT a.*, p.code AS project_code FROM alerts a JOIN projects p ON p.id = a.project_id WHERE a.resolved_at IS NULL AND a.project_id IN (${ids.map(() => '?').join(',')})
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.id DESC`, ...ids));
  });
  r.post('/alerts/refresh', auth.roles('owner', 'admin', 'project_manager'), (req, res) => { S.refreshAllAlerts(db, V.today()); res.json({ ok: true }); });

  // ---------- settings ----------
  r.get('/settings', (req, res) => res.json(getThresholds(db)));
  r.put('/settings', auth.roles('owner', 'admin'), wrap((req, res) => {
    const before = getThresholds(db); const next = {};
    for (const k of Object.keys(before)) if (req.body[k] !== undefined) next[k] = V.num(req.body[k], k, { min: -100, max: 1000 });
    if (!Object.keys(next).length) throw bad('No valid settings supplied');
    const reason = V.reason(req.body.reason);
    const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(() => { for (const [k, v] of Object.entries(next)) up.run(k, String(v)); audit(db, { user: req.user, action: 'update', entity: 'settings', reason, before, after: next }); });
    S.refreshAllAlerts(db, V.today());
    res.json(getThresholds(db));
  }));

  // ---------- audit ----------
  r.get('/projects/:pid/audit', auth.project('finance.view'), (req, res) =>
    res.json(q(`SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.project_id = ? ORDER BY l.id DESC LIMIT 500`, req.project.id)));
  r.get('/audit', auth.roles('owner', 'admin'), (req, res) =>
    res.json(q('SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 500')));

  // ---------- management reports (JSON) ----------
  function managementReport(user, period, onDate) {
    const end = onDate || V.today();
    const days = { daily: 1, weekly: 7, monthly: 30 }[period];
    const start = E.addDays(end, -(days - 1));
    return accessible(user).map((p) => {
      const m = S.metricsFor(db, p, end);
      const rep = one("SELECT COUNT(*) n FROM daily_reports WHERE project_id = ? AND status='approved' AND report_date BETWEEN ? AND ?", p.id, start, end).n;
      const qty = one(`SELECT COALESCE(SUM(rl.completed_qty),0) s FROM report_lines rl JOIN daily_reports r ON r.id = rl.report_id WHERE r.project_id = ? AND r.status='approved' AND r.report_date BETWEEN ? AND ?`, p.id, start, end).s;
      const row = { project: p.code, name: p.name, period, from: start, to: end, approved_reports: rep, quantity_completed: E.round2(qty),
        progress_pct: m.progress_pct, delay_days: m.schedule.delay_days, open_alerts: one('SELECT COUNT(*) n FROM alerts WHERE project_id = ? AND resolved_at IS NULL', p.id).n };
      if (canSeeMoney(user)) {
        row.cost_in_period = E.round2(one("SELECT COALESCE(SUM(amount),0) s FROM cost_entries WHERE project_id = ? AND status='actual' AND entry_date BETWEEN ? AND ?", p.id, start, end).s);
        row.cash_in_period = E.round2(one("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE project_id = ? AND status='approved' AND direction='in' AND txn_date BETWEEN ? AND ?", p.id, start, end).s);
        row.cash_out_period = E.round2(one("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE project_id = ? AND status='approved' AND direction='out' AND txn_date BETWEEN ? AND ?", p.id, start, end).s);
        row.actual_cost_total = m.costs.actual; row.forecast_final_cost = m.costs.forecast_final_cost; row.forecast_profit = m.profit.forecast_profit; row.forecast_margin_pct = m.profit.forecast_margin_pct;
      }
      return row;
    });
  }
  r.get('/reports/management', wrap((req, res) => {
    const period = V.oneOf(req.query.period || 'weekly', 'period', ['daily', 'weekly', 'monthly']);
    res.json(managementReport(req.user, period, req.query.date ? V.date(req.query.date, 'date') : null));
  }));

  // ---------- exports ----------
  const ExcelJS = require('exceljs'); const PDFDocument = require('pdfkit');
  const sheet = (wb, name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 16 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((x) => ws.addRow(x));
    cols.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00'; });
    return ws;
  };
  r.get('/projects/:pid/export/excel', auth.project('finance.view'), wrap(async (req, res) => {
    const today = V.today(); const m = S.metricsFor(db, req.project, today);
    const wb = new ExcelJS.Workbook(); wb.creator = 'BuildTrack Pro';
    sheet(wb, 'Summary', [{ h: 'Item', k: 'i', w: 34 }, { h: 'Amount', k: 'a', w: 18, money: true }, { h: 'Basis', k: 'b', w: 20 }], [
      { i: 'Contract value', a: m.profit.contract_value, b: 'actual' }, { i: 'Original budget', a: m.budget.original, b: 'actual' },
      { i: 'Approved variations', a: m.budget.approved_variations, b: 'actual' }, { i: 'Pending variations', a: m.budget.pending_variations, b: 'awaiting_approval' },
      { i: 'Revised budget', a: m.budget.revised, b: 'actual' }, { i: 'Actual cost', a: m.costs.actual, b: 'actual' }, { i: 'Committed cost', a: m.costs.committed, b: 'estimated' },
      { i: 'Forecast final cost', a: m.costs.forecast_final_cost, b: 'forecast' }, { i: 'Forecast profit', a: m.profit.forecast_profit, b: 'forecast' },
      { i: 'Forecast margin %', a: m.profit.forecast_margin_pct, b: 'forecast' }, { i: 'Cash received', a: m.cash.received, b: 'actual' }, { i: 'Cash paid', a: m.cash.paid, b: 'actual' },
      { i: 'Receivable', a: m.cash.receivable, b: 'actual' }, { i: 'Progress %', a: m.progress_pct, b: 'actual' }, { i: 'Forecast delay (days)', a: m.schedule.delay_days, b: 'forecast' },
    ]);
    sheet(wb, 'Activities', [{ h: 'Code', k: 'code' }, { h: 'Activity', k: 'name', w: 36 }, { h: 'Unit', k: 'unit', w: 8 }, { h: 'Planned qty', k: 'planned_qty' }, { h: 'Done qty', k: 'done_qty' },
      { h: 'Progress %', k: 'progress_pct' }, { h: 'Original budget', k: 'original_budget', money: true }, { h: 'Revised budget', k: 'revised_budget', money: true },
      { h: 'Actual cost', k: 'actual_cost', money: true }, { h: 'Committed', k: 'committed_cost', money: true }, { h: 'Forecast final', k: 'forecast_final_cost', money: true },
      { h: 'Cost flag', k: 'cost_flag' }], m.activities);
    sheet(wb, 'Cash flow', [{ h: 'Month', k: 'month' }, { h: 'Cash in', k: 'cash_in', money: true }, { h: 'Cash out', k: 'cash_out', money: true }, { h: 'Net cash', k: 'net_cash', money: true },
      { h: 'Cumulative', k: 'cumulative_cash', money: true }, { h: 'Accounting cost', k: 'accounting_cost', money: true }], cashflow(req.project.id));
    sheet(wb, 'Costs', [{ h: 'Date', k: 'entry_date' }, { h: 'Category', k: 'category' }, { h: 'Description', k: 'description', w: 44 }, { h: 'Amount', k: 'amount', money: true }, { h: 'Status', k: 'status' }],
      q('SELECT * FROM cost_entries WHERE project_id = ? ORDER BY id', req.project.id));
    audit(db, { user: req.user, action: 'export', entity: 'project_report', project_id: req.project.id, after: { format: 'xlsx' } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.project.code}-report-${today}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }));
  r.get('/projects/:pid/export/pdf', auth.project('finance.view'), wrap((req, res) => {
    const today = V.today(); const m = S.metricsFor(db, req.project, today);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.project.code}-report-${today}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' }); doc.pipe(res);
    const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    doc.fontSize(18).text(`${req.project.code} - ${req.project.name}`); doc.fontSize(10).fillColor('#555').text(`Management report - ${today}`).moveDown();
    doc.fillColor('#000').fontSize(12).text('Financial summary').moveDown(0.3);
    const lines = [['Contract value', m.profit.contract_value, 'actual'], ['Revised budget', m.budget.revised, 'actual'], ['Actual cost', m.costs.actual, 'actual'], ['Committed cost', m.costs.committed, 'estimated'],
      ['Forecast final cost', m.costs.forecast_final_cost, 'forecast'], ['Forecast profit', m.profit.forecast_profit, 'forecast'], ['Cash received', m.cash.received, 'actual'], ['Cash paid', m.cash.paid, 'actual']];
    doc.fontSize(10);
    for (const [k, v, b] of lines) doc.text(`${k}: ${money(v)}   [${b}]`);
    doc.text(`Forecast margin: ${m.profit.forecast_margin_pct}%   [forecast]`).text(`Progress: ${m.progress_pct}%   Forecast delay: ${m.schedule.delay_days} days`).moveDown();
    doc.fontSize(12).text('Activities').moveDown(0.3).fontSize(9);
    for (const a of m.activities) doc.text(`${a.code}  ${a.name}  |  ${a.progress_pct}%  |  budget ${money(a.revised_budget)}  actual ${money(a.actual_cost)}  forecast ${money(a.forecast_final_cost)}  ${a.cost_flag !== 'ok' ? '[' + a.cost_flag + ']' : ''}`);
    doc.end();
    audit(db, { user: req.user, action: 'export', entity: 'project_report', project_id: req.project.id, after: { format: 'pdf' } });
  }));
  r.get('/reports/management/export', wrap(async (req, res) => {
    const period = V.oneOf(req.query.period || 'weekly', 'period', ['daily', 'weekly', 'monthly']);
    const rows = managementReport(req.user, period, null);
    if ((req.query.format || 'xlsx') === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="management-${period}.pdf"`);
      const doc = new PDFDocument({ margin: 40 }); doc.pipe(res);
      doc.fontSize(16).text(`Management report (${period})`).moveDown().fontSize(9);
      for (const x of rows) doc.text(`${x.project} ${x.name}: progress ${x.progress_pct}%, delay ${x.delay_days}d, reports ${x.approved_reports}, qty ${x.quantity_completed}` +
        (x.cost_in_period !== undefined ? `, cost ${x.cost_in_period}, cash in ${x.cash_in_period}, cash out ${x.cash_out_period}, forecast profit ${x.forecast_profit}` : ''));
      return doc.end();
    }
    const wb = new ExcelJS.Workbook();
    const cols = Object.keys(rows[0] || { project: 1 }).map((k) => ({ h: k, k, w: 18 }));
    sheet(wb, period, cols, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="management-${period}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }));

  // ---------- backups ----------
  r.post('/admin/backup', auth.roles('owner', 'admin'), wrap(async (req, res) => {
    const file = await runBackup(db, backupDir);
    audit(db, { user: req.user, action: 'backup', entity: 'database', after: { file } });
    res.json({ file });
  }));
  r.get('/admin/backups', auth.roles('owner', 'admin'), (req, res) => {
    const fs = require('fs');
    res.json(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().reverse() : []);
  });
  return r;
};

async function runBackup(db, dir) {
  const fs = require('fs'); const path = require('path');
  fs.mkdirSync(dir, { recursive: true });
  const name = `buildtrack-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  await db.backup(path.join(dir, name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const old of files.slice(0, Math.max(files.length - 30, 0))) fs.unlinkSync(path.join(dir, old)); // keep newest 30
  return name;
}
module.exports.runBackup = runBackup;
