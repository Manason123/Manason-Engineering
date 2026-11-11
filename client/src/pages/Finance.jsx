import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { can, isGlobal } from '../nav';
import { Basis, Badge, Card, CashChart, Field, Loading, Money, Status, Table, Tabs, useAct, useLoad, ask, today } from '../ui';

export default function Finance({ project, user }) {
  const { t } = useI18n();
  const [tab, setTab] = useState('costs');
  const base = `/projects/${project.id}`;
  const write = can(user, 'finance.write');
  const tabs = [['costs', t('Costs')], ['invoices', t('Invoices')], ['bills', t('Bills')], ['cash', t('Cash book')], ['flow', t('Cash flow')]];
  return (
    <>
      <p className="note">{t('Amounts are accounting costs, not cash.')} {t('Profit is calculated from costs, never from cash received.')}</p>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'costs' && <Costs base={base} user={user} write={write} />}
      {tab === 'invoices' && <Invoices base={base} write={write} />}
      {tab === 'bills' && <Bills base={base} write={write} />}
      {tab === 'cash' && <Cash base={base} user={user} write={write} />}
      {tab === 'flow' && <Flow base={base} />}
    </>
  );
}

function Costs({ base, user, write }) {
  const { t } = useI18n();
  const costs = useLoad(() => api.get(`${base}/costs`), [base]);
  const acts = useLoad(() => api.get(`${base}/activities`), [base]);
  const [act, busy] = useAct();
  const [f, setF] = useState({ category: 'subcontract', description: '', amount: '', entry_date: today(), activity_id: '', status: 'actual' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post(`${base}/costs`, f), { ok: t('Save'), onDone: () => { setF({ ...f, description: '', amount: '' }); costs.reload(); } }); };
  const reverse = (c) => { const reason = ask(`${t('Reverse')} #${c.id} — ${t('Reason')}`); if (reason) act(() => api.post(`${base}/costs/${c.id}/reverse`, { reason }), { onDone: costs.reload }); };
  const decide = (c, approve) => { const note = approve ? null : ask(t('Reason')); if (!approve && !note) return; act(() => api.post(`${base}/costs/${c.id}/approve`, { approve, note }), { onDone: costs.reload }); };
  const total = (costs.data || []).filter((c) => c.status === 'actual').reduce((s, c) => s + c.amount, 0);
  return (
    <>
      {write && (
        <Card title={t('New cost')}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label="Category"><select value={f.category} onChange={set('category')}>{['subcontract', 'overhead', 'other', 'material', 'labour', 'equipment'].map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label={t('Activity')}><select value={f.activity_id} onChange={set('activity_id')}><option value="">(project)</option>{(acts.data || []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
              <Field label={t('Amount')}><input type="number" step="any" min="0" value={f.amount} onChange={set('amount')} required /></Field>
              <Field label={t('Date')}><input type="date" value={f.entry_date} onChange={set('entry_date')} required /></Field>
              <Field label={t('Status')}><select value={f.status} onChange={set('status')}><option value="actual">{t('actual')}</option><option value="estimated">{t('estimated')}</option><option value="awaiting_approval">{t('awaiting_approval')}</option></select></Field>
            </div>
            <Field label={t('Name')}><input value={f.description} onChange={set('description')} required /></Field>
            <button className="btn" disabled={busy}>{t('Save')}</button>
          </form>
          <p className="muted" style={{ fontSize: 12 }}>Material receipts, labour and equipment from approved reports are posted automatically.</p>
        </Card>
      )}
      <Card title={`${t('Costs')} — ${t('Actual cost')}: ${Math.round(total).toLocaleString()}`}>
        {!costs.data ? <Loading state={costs} /> : (
          <Table rows={costs.data} cols={[
            { h: 'Date', k: 'entry_date' }, { h: 'Category', k: 'category' }, { h: 'Activity', render: (c) => c.activity_code || '-' }, { h: 'Name', render: (c) => <>{c.description}{c.reason && <div className="muted">{c.reason}</div>}</> },
            { h: 'Amount', num: true, render: (c) => <span style={{ color: c.amount < 0 ? 'var(--red)' : undefined }}><Money v={c.amount} /></span> },
            { h: 'Status', render: (c) => <Basis kind={c.status} /> },
            { h: 'Actions', render: (c) => (
              <span className="row gap wrap">
                {c.status === 'awaiting_approval' && isGlobal(user) && <><button className="btn ok small" onClick={() => decide(c, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(c, false)}>{t('Reject')}</button></>}
                {write && !c.reverses_id && !c.reversed && c.status !== 'void' && <button className="btn alt small" onClick={() => reverse(c)}>{t('Reverse')}</button>}
                {c.reversed ? <Badge tone="gray">reversed</Badge> : null}
              </span>) },
          ]} />
        )}
      </Card>
    </>
  );
}

function Invoices({ base, write }) {
  const { t } = useI18n();
  const inv = useLoad(() => api.get(`${base}/invoices`), [base]);
  const [act, busy] = useAct();
  const [f, setF] = useState({ number: '', amount: '', issue_date: today(), due_date: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post(`${base}/invoices`, f), { ok: t('Create'), onDone: () => { setF({ ...f, number: '', amount: '' }); inv.reload(); } }); };
  const cancel = (i) => { const reason = ask(t('Reason')); if (reason) act(() => api.post(`${base}/invoices/${i.id}/cancel`, { reason }), { onDone: inv.reload }); };
  return (
    <>
      {write && (
        <Card title={t('New invoice')}>
          <form onSubmit={submit}><div className="form-grid">
            <Field label="Number"><input value={f.number} onChange={set('number')} required /></Field>
            <Field label={t('Amount')}><input type="number" step="any" min="0" value={f.amount} onChange={set('amount')} required /></Field>
            <Field label="Issue date"><input type="date" value={f.issue_date} onChange={set('issue_date')} required /></Field>
            <Field label={t('Due date')}><input type="date" value={f.due_date} onChange={set('due_date')} required /></Field>
          </div><button className="btn" disabled={busy}>{t('Create')}</button></form>
        </Card>
      )}
      <Card title={t('Invoices')}>
        {!inv.data ? <Loading state={inv} /> : (
          <Table rows={inv.data} cols={[
            { h: 'Code', k: 'number' }, { h: 'Date', k: 'issue_date' }, { h: 'Due date', render: (i) => <>{i.due_date}{i.overdue && <> <Badge tone="red">overdue</Badge></>}</> },
            { h: 'Amount', num: true, render: (i) => <Money v={i.amount} /> }, { h: 'Receivable', num: true, render: (i) => <Money v={i.outstanding} /> }, { h: 'Status', render: (i) => <Status s={i.status} /> },
            { h: 'Actions', render: (i) => write && i.status === 'issued' && <button className="btn alt small" onClick={() => cancel(i)}>{t('Cancel')}</button> },
          ]} />
        )}
      </Card>
    </>
  );
}

function Bills({ base, write }) {
  const { t } = useI18n();
  const bills = useLoad(() => api.get(`${base}/bills`), [base]);
  const sups = useLoad(() => api.get('/suppliers'));
  const [act, busy] = useAct();
  const [f, setF] = useState({ supplier_id: '', bill_no: '', amount: '', bill_date: today(), due_date: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post(`${base}/bills`, f), { ok: t('Create'), onDone: () => { setF({ ...f, bill_no: '', amount: '' }); bills.reload(); } }); };
  return (
    <>
      {write && (
        <Card title={t('New bill')}>
          <form onSubmit={submit}><div className="form-grid">
            <Field label={t('Supplier')}><select value={f.supplier_id} onChange={set('supplier_id')} required><option value="" />{(sups.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Bill no."><input value={f.bill_no} onChange={set('bill_no')} required /></Field>
            <Field label={t('Amount')}><input type="number" step="any" min="0" value={f.amount} onChange={set('amount')} required /></Field>
            <Field label={t('Date')}><input type="date" value={f.bill_date} onChange={set('bill_date')} required /></Field>
            <Field label={t('Due date')}><input type="date" value={f.due_date} onChange={set('due_date')} required /></Field>
          </div><button className="btn" disabled={busy}>{t('Create')}</button></form>
          <p className="muted" style={{ fontSize: 12 }}>A supplier bill is a liability. It is not a cash payment and does not add cost by itself (material cost is booked at receipt).</p>
        </Card>
      )}
      <Card title={t('Bills')}>
        {!bills.data ? <Loading state={bills} /> : (
          <Table rows={bills.data} cols={[
            { h: 'Code', k: 'bill_no' }, { h: 'Supplier', k: 'supplier_name' }, { h: 'Due date', k: 'due_date' },
            { h: 'Amount', num: true, render: (b) => <Money v={b.amount} /> }, { h: 'Cash paid', num: true, render: (b) => <Money v={b.paid_or_pending} /> }, { h: 'Receivable', num: true, render: (b) => <Money v={b.outstanding} /> },
          ]} />
        )}
      </Card>
    </>
  );
}

function Cash({ base, user, write }) {
  const { t } = useI18n();
  const cash = useLoad(() => api.get(`${base}/cash`), [base]);
  const invs = useLoad(() => api.get(`${base}/invoices`), [base]);
  const bills = useLoad(() => api.get(`${base}/bills`), [base]);
  const [act, busy] = useAct();
  const [f, setF] = useState({ kind: 'client_payment', amount: '', reference: '', txn_date: today(), invoice_id: '', bill_id: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post(`${base}/cash`, f), { ok: t('Save'), onDone: () => { setF({ ...f, amount: '', reference: '' }); cash.reload(); invs.reload(); bills.reload(); } }); };
  const decide = (c, approve) => { const note = approve ? null : ask(t('Reason')); if (!approve && !note) return; act(() => api.post(`${base}/cash/${c.id}/decide`, { approve, note }), { ok: approve ? t('Approved') : t('Rejected'), onDone: cash.reload }); };
  const reverse = (c) => { const reason = ask(`${t('Reverse')} — ${t('Reason')}`); if (reason) act(() => api.post(`${base}/cash/${c.id}/reverse`, { reason }), { onDone: () => { cash.reload(); invs.reload(); bills.reload(); } }); };
  return (
    <>
      {write && (
        <Card title={t('Record payment')}>
          <form onSubmit={submit}><div className="form-grid">
            <Field label="Type"><select value={f.kind} onChange={set('kind')}><option value="client_payment">Client payment (in)</option><option value="supplier_payment">Supplier payment (out)</option><option value="payroll">Payroll (out)</option><option value="expense">Expense (out)</option></select></Field>
            {f.kind === 'client_payment' && <Field label={t('Invoices')}><select value={f.invoice_id} onChange={set('invoice_id')} required><option value="" />{(invs.data || []).filter((i) => i.status === 'issued' && i.outstanding > 0).map((i) => <option key={i.id} value={i.id}>{i.number} — {i.outstanding}</option>)}</select></Field>}
            {f.kind === 'supplier_payment' && <Field label={t('Bills')}><select value={f.bill_id} onChange={set('bill_id')} required><option value="" />{(bills.data || []).filter((b) => b.outstanding > 0).map((b) => <option key={b.id} value={b.id}>{b.supplier_name} {b.bill_no} — {b.outstanding}</option>)}</select></Field>}
            <Field label={t('Amount')}><input type="number" step="any" min="0" value={f.amount} onChange={set('amount')} required /></Field>
            <Field label={t('Reference')} hint="Unique per type: duplicates are rejected"><input value={f.reference} onChange={set('reference')} required /></Field>
            <Field label={t('Date')}><input type="date" max={today()} value={f.txn_date} onChange={set('txn_date')} required /></Field>
          </div><button className="btn" disabled={busy}>{t('Save')}</button></form>
          <p className="note">Outgoing payments are <Basis kind="awaiting_approval" /> until the owner approves them. Only approved payments count as cash paid.</p>
        </Card>
      )}
      <Card title={t('Cash book')}>
        {!cash.data ? <Loading state={cash} /> : (
          <Table rows={cash.data} cols={[
            { h: 'Date', k: 'txn_date' }, { h: 'Reference', k: 'reference' }, { h: 'Type', render: (c) => `${c.kind.replace('_', ' ')} (${c.direction})` },
            { h: 'Amount', num: true, render: (c) => <span style={{ color: c.direction === 'in' ? 'var(--green)' : 'var(--red)' }}>{c.direction === 'in' ? '+' : '−'}<Money v={c.amount} /></span> },
            { h: 'Status', render: (c) => <><Basis kind={c.basis} /> <Status s={c.status} /></> }, { h: 'Reason', render: (c) => c.reason || '' },
            { h: 'Actions', render: (c) => (
              <span className="row gap wrap">
                {c.status === 'pending_approval' && isGlobal(user) && <><button className="btn ok small" onClick={() => decide(c, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(c, false)}>{t('Reject')}</button></>}
                {c.status === 'approved' && (isGlobal(user) || user.role === 'accountant') && <button className="btn alt small" onClick={() => reverse(c)}>{t('Reverse')}</button>}
              </span>) },
          ]} />
        )}
      </Card>
    </>
  );
}

function Flow({ base }) {
  const { t } = useI18n();
  const f = useLoad(() => api.get(`${base}/cashflow`), [base]);
  if (!f.data) return <Loading state={f} />;
  return (
    <Card title={t('Cash flow')}>
      <CashChart rows={f.data} />
      <Table rows={f.data} rowKey="month" cols={[
        { h: 'Date', k: 'month' }, { h: 'Cash received', num: true, render: (r) => <Money v={r.cash_in} /> }, { h: 'Cash paid', num: true, render: (r) => <Money v={r.cash_out} /> },
        { h: 'Net cash', num: true, render: (r) => <Money v={r.net_cash} /> }, { h: 'Amount', num: true, render: (r) => <><Money v={r.cumulative_cash} /></> }, { h: 'Actual cost', num: true, render: (r) => <Money v={r.accounting_cost} /> },
      ]} />
      <p className="muted" style={{ fontSize: 12 }}>"Amount" = cumulative net cash. Accounting cost is shown for comparison only and is not cash.</p>
    </Card>
  );
}
