import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { can } from '../nav';
import { Basis, Card, Field, Loading, Money, Status, Table, Tabs, useAct, useLoad, ask, today } from '../ui';

export default function Materials({ project, user }) {
  const { t } = useI18n();
  const [tab, setTab] = useState('inventory');
  const base = `/projects/${project.id}`;
  const money = can(user, 'finance.view');
  const tabs = [['inventory', t('Inventory')], ['requests', t('Material requests')], ['po', t('Purchase orders')], ['deliveries', t('Deliveries')]];
  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'inventory' && <Inventory base={base} user={user} />}
      {tab === 'requests' && <Requests base={base} user={user} />}
      {tab === 'po' && <PurchaseOrders base={base} user={user} money={money} />}
      {tab === 'deliveries' && <Deliveries base={base} user={user} />}
    </>
  );
}

function Inventory({ base, user }) {
  const { t } = useI18n();
  const inv = useLoad(() => api.get(`${base}/inventory`), [base]);
  const ledger = useLoad(() => api.get(`${base}/inventory/ledger`), [base]);
  const [act] = useAct();
  const [showLedger, setShowLedger] = useState(false);
  const issue = (m) => {
    const qty = ask(`${t('Issue to site')}: ${m.name} (${m.free_store} ${m.unit})`); if (!qty) return;
    act(() => api.post(`${base}/issues`, { material_id: m.material_id, qty: Number(qty) }), { ok: t('Issued'), onDone: () => { inv.reload(); ledger.reload(); } });
  };
  const adjust = (m) => {
    const qty = ask(`${t('Stock adjustment')} ${m.name} (+/-)`); if (!qty) return;
    const reason = ask(t('Reason')); if (!reason) return;
    act(() => api.post(`${base}/stock/adjust`, { material_id: m.material_id, qty: Number(qty), reason }), { onDone: () => { inv.reload(); ledger.reload(); } });
  };
  return (
    <>
      <Card title={t('Inventory')} actions={<button className="btn alt small" onClick={() => setShowLedger(!showLedger)}>Ledger</button>}>
        {!inv.data ? <Loading state={inv} /> : (
          <Table rows={inv.data} rowKey="material_id" cols={[
            { h: 'Materials', render: (m) => <strong>{m.name}</strong> },
            { h: 'Requested', num: true, render: (m) => `${m.requested} ${m.unit}` }, { h: 'Approved', num: true, k: 'approved' }, { h: 'Purchased', num: true, k: 'purchased' },
            { h: 'Delivered', num: true, k: 'delivered' }, { h: 'Received', num: true, k: 'received' }, { h: 'Issued', num: true, k: 'issued' },
            { h: 'Consumed', num: true, k: 'consumed' }, { h: 'Wasted', num: true, k: 'wasted' },
            { h: 'Store', num: true, render: (m) => <strong>{m.store}</strong> }, { h: 'Site', num: true, render: (m) => <strong>{m.site}</strong> },
            { h: 'Reserved', num: true, k: 'reserved' }, { h: 'On order', num: true, k: 'on_order' },
            { h: 'Issue to site', render: (m) => (can(user, 'stock.issue') ? <span className="row gap"><button className="btn small" onClick={() => issue(m)}>{t('Issue to site')}</button><button className="btn alt small" onClick={() => adjust(m)}>±</button></span> : null) },
          ]} />
        )}
        <p className="muted" style={{ fontSize: 12 }}>Requested ≠ purchased ≠ delivered ≠ received ≠ issued ≠ consumed. Stock changes only when a receipt, issue, consumption or adjustment is confirmed.</p>
      </Card>
      {showLedger && ledger.data && (
        <Card title="Ledger"><Table rows={ledger.data} cols={[{ h: 'Date', render: (r) => r.created_at }, { h: 'Materials', render: (r) => r.material_name }, { h: 'Status', k: 'type' }, { h: 'Quantity', num: true, k: 'qty' }, { h: 'Name', render: (r) => r.user_name }, { h: 'Reason', render: (r) => r.reason || '' }]} /></Card>
      )}
    </>
  );
}

function Requests({ base, user }) {
  const { t } = useI18n();
  const reqs = useLoad(() => api.get(`${base}/requests`), [base]);
  const mats = useLoad(() => api.get('/materials'));
  const acts = useLoad(() => api.get(`${base}/activities`), [base]);
  const [act, busy] = useAct();
  const [f, setF] = useState({ material_id: '', activity_id: '', needed_date: today(), qty_requested: '', note: '' });
  const [check, setCheck] = useState(null);
  const [newMat, setNewMat] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    act(() => api.post(`${base}/requests`, f), { ok: t('Requested'), onDone: (r) => { setCheck(r.stock_check); setF({ ...f, qty_requested: '', note: '' }); reqs.reload(); } });
  };
  const decide = (r, approve) => {
    let body = { approve };
    if (approve) { const q = ask(`${t('Approve')} ${r.material_name}: ${t('Quantity')} (max ${r.qty_requested})`, r.qty_requested); if (q === null) return; body.qty_approved = Number(q); }
    else { const n = ask(t('Reason')); if (!n) return; body.note = n; }
    act(() => api.post(`${base}/requests/${r.id}/decide`, body), { ok: approve ? t('Approved') : t('Rejected'), onDone: reqs.reload });
  };
  const cancel = (r) => { const reason = ask(t('Reason')); if (reason) act(() => api.post(`${base}/requests/${r.id}/cancel`, { reason }), { onDone: reqs.reload }); };
  const addMaterial = () => {
    const name = ask(t('Name')); if (!name) return; const unit = ask(t('Unit')); if (!unit) return; const price = ask(t('Unit price')) || 0;
    act(() => api.post('/materials', { name, unit, default_price: Number(price) }), { onDone: () => mats.reload() });
  };

  return (
    <>
      {can(user, 'request.create') && (
        <Card title={t('New request')}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label={t('Materials')}><select value={f.material_id} onChange={set('material_id')} required><option value="" />{(mats.data || []).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select></Field>
              <Field label={t('Activity')}><select value={f.activity_id} onChange={set('activity_id')}><option value="" />{(acts.data || []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
              <Field label={t('Needed date')}><input type="date" value={f.needed_date} onChange={set('needed_date')} required /></Field>
              <Field label={t('Quantity')}><input type="number" step="any" min="0" value={f.qty_requested} onChange={set('qty_requested')} required /></Field>
            </div>
            <Field label={t('Note')}><input value={f.note} onChange={set('note')} /></Field>
            <div className="row gap"><button className="btn" disabled={busy}>{t('Submit')}</button><button type="button" className="btn alt" onClick={addMaterial}>+ {t('Materials')}</button></div>
          </form>
          {check && <p className="note">Stock check: free in store {check.free} → from stock {check.from_stock}, to purchase {check.to_purchase}.</p>}
        </Card>
      )}
      <Card title={t('Material requests')}>
        {!reqs.data ? <Loading state={reqs} /> : (
          <Table rows={reqs.data} cols={[
            { h: 'Date', render: (r) => <>{r.needed_date}<div className="muted">{r.requested_by_name}</div></> },
            { h: 'Materials', render: (r) => <>{r.material_name}<div className="muted">{r.activity_code}</div></> },
            { h: 'Requested', num: true, render: (r) => `${r.qty_requested} ${r.unit}` },
            { h: 'Approved', num: true, render: (r) => (r.status === 'approved' || r.status === 'closed' ? <>{r.qty_approved}<div className="muted">stock {r.qty_from_stock} / buy {r.qty_to_purchase}</div></> : '-') },
            { h: 'Purchased', num: true, k: 'qty_purchased' }, { h: 'Delivered', num: true, k: 'qty_delivered' }, { h: 'Received', num: true, k: 'qty_received' }, { h: 'Issued', num: true, k: 'qty_issued' },
            { h: 'Status', render: (r) => <Status s={r.stage} /> },
            { h: 'Actions', render: (r) => (
              <span className="row gap wrap">
                {r.status === 'requested' && can(user, 'request.approve') && <><button className="btn ok small" onClick={() => decide(r, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(r, false)}>{t('Reject')}</button></>}
                {['requested', 'approved'].includes(r.status) && !r.qty_purchased && !r.qty_issued && (r.requested_by === user.id || can(user, 'request.approve')) && <button className="btn alt small" onClick={() => cancel(r)}>{t('Cancel')}</button>}
              </span>) },
          ]} />
        )}
      </Card>
    </>
  );
}

function PurchaseOrders({ base, user, money }) {
  const { t } = useI18n();
  const pos = useLoad(() => api.get(`${base}/purchase-orders`), [base]);
  const reqs = useLoad(() => api.get(`${base}/requests`), [base]);
  const sups = useLoad(() => api.get('/suppliers'));
  const [act, busy] = useAct();
  const [f, setF] = useState({ request_id: '', supplier_id: '', qty: '', unit_price: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const open = (reqs.data || []).filter((r) => r.status === 'approved' && r.qty_to_purchase - r.qty_purchased > 0);
  const manage = can(user, 'po.manage');
  const submit = (e) => {
    e.preventDefault();
    act(() => api.post(`${base}/purchase-orders`, f), { ok: t('Create'), onDone: () => { setF({ ...f, qty: '', unit_price: '' }); pos.reload(); reqs.reload(); } });
  };
  const addSupplier = () => { const name = ask(t('Supplier')); if (name) act(() => api.post('/suppliers', { name }), { onDone: sups.reload }); };
  const cancelPo = (p) => { const reason = ask(t('Reason')); if (reason) act(() => api.post(`${base}/purchase-orders/${p.id}/cancel`, { reason }), { onDone: pos.reload }); };
  const closePo = (p) => { const reason = ask(t('Reason')); if (reason) act(() => api.post(`${base}/purchase-orders/${p.id}/close`, { reason }), { onDone: pos.reload }); };
  const addDelivery = (p) => {
    const dn = ask(t('Delivery note')); if (!dn) return; const qty = ask(`${t('Delivered')} (${p.unit})`); if (!qty) return;
    act(() => api.post(`${base}/purchase-orders/${p.id}/deliveries`, { delivery_note_no: dn, qty_delivered: Number(qty) }), { ok: t('Delivered'), onDone: pos.reload });
  };
  return (
    <>
      {manage && (
        <Card title={t('Create') + ' ' + t('Purchase orders')}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label={t('Material requests')}><select value={f.request_id} onChange={(e) => { const r = open.find((x) => x.id === Number(e.target.value)); setF({ ...f, request_id: e.target.value, qty: r ? r.qty_to_purchase - r.qty_purchased : '' }); }} required><option value="" />{open.map((r) => <option key={r.id} value={r.id}>#{r.id} {r.material_name} — to buy {r.qty_to_purchase - r.qty_purchased} {r.unit}</option>)}</select></Field>
              <Field label={t('Supplier')}><select value={f.supplier_id} onChange={set('supplier_id')} required><option value="" />{(sups.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label={t('Quantity')}><input type="number" step="any" min="0" value={f.qty} onChange={set('qty')} required /></Field>
              <Field label={t('Unit price')}><input type="number" step="any" min="0" value={f.unit_price} onChange={set('unit_price')} required /></Field>
            </div>
            <div className="row gap"><button className="btn" disabled={busy}>{t('Create')}</button><button type="button" className="btn alt" onClick={addSupplier}>+ {t('Supplier')}</button></div>
          </form>
          <p className="note">A purchase order is a <strong>commitment</strong> (estimated). It becomes an actual cost only when the storekeeper confirms receipt; it is never cash paid.</p>
        </Card>
      )}
      <Card title={t('Purchase orders')}>
        {!pos.data ? <Loading state={pos} /> : (
          <Table rows={pos.data} cols={[
            { h: 'Code', render: (p) => `PO-${p.id}` }, { h: 'Supplier', render: (p) => p.supplier_name }, { h: 'Materials', render: (p) => <>{p.material_name}<div className="muted">{p.activity_code}</div></> },
            { h: 'Quantity', num: true, render: (p) => `${p.qty} ${p.unit}` }, { h: 'Delivered', num: true, k: 'qty_delivered' }, { h: 'Received', num: true, k: 'qty_received' },
            ...(money ? [{ h: 'Unit price', num: true, render: (p) => <Money v={p.unit_price} /> }, { h: 'Committed cost', num: true, render: (p) => <><Money v={p.committed} /> <Basis kind="estimated" /></> }] : []),
            { h: 'Status', render: (p) => <Status s={p.status} /> },
            { h: 'Actions', render: (p) => p.status === 'open' && (
              <span className="row gap wrap">
                {can(user, 'delivery.confirm') && <button className="btn small" onClick={() => addDelivery(p)}>{t('Delivered')}</button>}
                {manage && <><button className="btn alt small" onClick={() => closePo(p)}>{t('Close')}</button><button className="btn danger small" onClick={() => cancelPo(p)}>{t('Cancel')}</button></>}
              </span>) },
          ]} />
        )}
      </Card>
    </>
  );
}

function Deliveries({ base, user }) {
  const { t } = useI18n();
  const d = useLoad(() => api.get(`${base}/deliveries`), [base]);
  const [act] = useAct();
  const confirm = (x) => {
    const q = ask(`${t('Confirm receipt')}: ${x.material_name} — ${t('Delivered')} ${x.qty_delivered} ${x.unit}. ${t('Received')}?`); if (q === null) return;
    act(() => api.post(`${base}/deliveries/${x.id}/confirm`, { qty_received: Number(q) }), { ok: t('Received'), onDone: d.reload });
  };
  return (
    <Card title={t('Deliveries')}>
      {!d.data ? <Loading state={d} /> : (
        <Table rows={d.data} cols={[
          { h: 'Date', render: (x) => x.delivered_date }, { h: 'Delivery note', render: (x) => x.delivery_note_no }, { h: 'Supplier', render: (x) => x.supplier_name }, { h: 'Materials', render: (x) => x.material_name },
          { h: 'Delivered', num: true, render: (x) => `${x.qty_delivered} ${x.unit}` }, { h: 'Received', num: true, render: (x) => (x.qty_received ?? '-') },
          { h: 'Status', render: (x) => <Status s={x.status} /> },
          { h: 'Actions', render: (x) => x.status === 'delivered' && can(user, 'delivery.confirm') && <button className="btn ok small" onClick={() => confirm(x)}>{t('Confirm receipt')}</button> },
        ]} />
      )}
    </Card>
  );
}
