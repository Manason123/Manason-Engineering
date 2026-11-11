import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { can, isGlobal } from '../nav';
import { Basis, Badge, Bar, Card, Field, Loading, Money, Status, Table, useAct, useLoad, ask } from '../ui';

export function Schedule({ project, user }) {
  const { t } = useI18n();
  const base = `/projects/${project.id}`;
  const s = useLoad(() => api.get(`${base}/schedule`), [base]);
  const revs = useLoad(() => api.get(`${base}/revisions`), [base]);
  const [act, busy] = useAct();
  const propose = () => { const reason = ask(t('Reason')); if (reason) act(() => api.post(`${base}/revisions/propose`, { reason }), { ok: t('Submit'), onDone: revs.reload }); };
  const decide = (r, approve) => {
    const note = ask(approve ? t('Note') : t('Reason')); if (!note) return;
    act(() => api.post(`${base}/revisions/${r.id}/decide`, { approve, note }), { ok: approve ? t('Approved') : t('Rejected'), onDone: () => { revs.reload(); s.reload(); } });
  };
  if (!s.data) return <Loading state={s} />;
  return (
    <>
      <Card title={t('Schedule')} actions={can(user, 'revision.request') && <button className="btn small" disabled={busy || s.data.delay_days <= 0} onClick={propose}>{t('Propose revised schedule')}</button>}>
        <p>{t('Planned end')}: <strong>{s.data.planned_end}</strong> · {t('Forecast end')}: <strong>{s.data.forecast_end}</strong> <Basis kind="forecast" /> · <Badge tone={s.data.delay_days > 0 ? 'red' : 'green'}>{s.data.delay_days} {t('Delay (days)')}</Badge></p>
        <Table rows={s.data.activities} cols={[
          { h: 'Activity', render: (a) => `${a.code} ${a.name}` }, { h: 'Progress', render: (a) => <><span>{a.progress_pct}%</span><Bar pct={a.progress_pct} label={a.code} /></> },
          { h: 'Planned end', render: (a) => `${a.planned_start} → ${a.planned_end}` }, { h: 'Forecast end', render: (a) => (a.complete ? '✓' : `${a.start} → ${a.finish}`) },
          { h: 'Delay (days)', num: true, render: (a) => (a.delay_days > 0 ? <Badge tone="red">+{a.delay_days}</Badge> : '0') }, { h: 'Planned qty', num: true, render: (a) => (a.complete ? '-' : `${a.rate}/day`) },
        ]} />
        <p className="muted" style={{ fontSize: 12 }}>Forecast = remaining quantity ÷ productivity (measured pace blended with approved productivity), respecting dependencies. The approved baseline dates are never overwritten.</p>
      </Card>
      <Card title="Schedule revisions">
        {!revs.data ? <Loading state={revs} /> : (
          <Table rows={revs.data} cols={[
            { h: 'Date', k: 'created_at' }, { h: 'Reason', k: 'reason' }, { h: 'Status', render: (r) => <Status s={r.status} /> },
            { h: 'Activities', render: (r) => r.proposal.map((p) => <div key={p.activity_id}>{p.code}: {p.old_end} → <strong>{p.new_end}</strong></div>) },
            { h: 'Actions', render: (r) => r.status === 'pending' && can(user, 'revision.approve') && <span className="row gap"><button className="btn ok small" onClick={() => decide(r, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(r, false)}>{t('Reject')}</button></span> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function Variations({ project, user }) {
  const { t } = useI18n();
  const base = `/projects/${project.id}`;
  const v = useLoad(() => api.get(`${base}/variations`), [base]);
  const acts = useLoad(() => api.get(`${base}/activities`), [base]);
  const [act, busy] = useAct();
  const [f, setF] = useState({ activity_id: '', cost_amount: '', revenue_amount: '0', reason: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const money = can(user, 'finance.view');
  const submit = (e) => { e.preventDefault(); act(() => api.post(`${base}/variations`, f), { ok: t('Submit'), onDone: () => { setF({ ...f, cost_amount: '', reason: '' }); v.reload(); } }); };
  const decide = (x, approve) => { const note = ask(approve ? t('Note') : t('Reason')); if (!approve && !note) return; act(() => api.post(`${base}/variations/${x.id}/decide`, { approve, note }), { ok: approve ? t('Approved') : t('Rejected'), onDone: v.reload }); };
  return (
    <>
      {can(user, 'variation.request') && project.baseline_approved && (
        <Card title={t('Variations')}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label={t('Activity')}><select value={f.activity_id} onChange={set('activity_id')}><option value="">(project)</option>{(acts.data || []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
              <Field label="Cost change (+/−)"><input type="number" step="any" value={f.cost_amount} onChange={set('cost_amount')} required /></Field>
              <Field label="Revenue change (+/−)"><input type="number" step="any" value={f.revenue_amount} onChange={set('revenue_amount')} /></Field>
            </div>
            <Field label={t('Reason')}><input value={f.reason} onChange={set('reason')} required /></Field>
            <button className="btn" disabled={busy}>{t('Submit')}</button>
          </form>
          <p className="note">{t('Original and approved budget are kept separate.')} A variation does not affect any figure until the owner approves it.</p>
        </Card>
      )}
      <Card title={t('Variations')}>
        {!v.data ? <Loading state={v} /> : (
          <Table rows={v.data} cols={[
            { h: 'Date', k: 'created_at' }, { h: 'Name', render: (x) => x.requested_by_name }, { h: 'Activity', render: (x) => acts.data?.find((a) => a.id === x.activity_id)?.code || '(project)' },
            ...(money ? [{ h: 'Amount', num: true, render: (x) => <><Money v={x.cost_amount} /> <Basis kind={x.basis} /><div className="muted">rev <Money v={x.revenue_amount} /></div></> }] : []),
            { h: 'Reason', render: (x) => <>{x.reason}{x.decision_note && <div className="muted">{x.decision_note}</div>}</> }, { h: 'Status', render: (x) => <Status s={x.status} /> },
            { h: 'Actions', render: (x) => x.status === 'pending' && isGlobal(user) && <span className="row gap"><button className="btn ok small" onClick={() => decide(x, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(x, false)}>{t('Reject')}</button></span> },
          ]} />
        )}
      </Card>
    </>
  );
}
