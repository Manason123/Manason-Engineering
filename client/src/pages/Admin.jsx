import { useState } from 'react';
import { api, download } from '../api';
import { useI18n } from '../i18n';
import { go, isGlobal } from '../nav';
import { Badge, Card, Field, Loading, Money, Status, Table, useAct, useLoad, ask, today } from '../ui';

const ROLES = ['owner', 'admin', 'project_manager', 'engineer', 'storekeeper', 'accountant', 'viewer'];

export function ProjectsAdmin({ user }) {
  const { t } = useI18n();
  const list = useLoad(() => api.get('/projects'));
  const [act, busy] = useAct();
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ code: '', name: '', client_name: '', client_contact: '', location: '', contract_value: '', start_date: today(), end_date: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post('/projects', f), { ok: t('Create'), onDone: (r) => go(`/p/${r.id}/baseline`) }); };
  return (
    <>
      <Card title={t('Projects')} actions={isGlobal(user) && <button className="btn small" onClick={() => setShow(!show)}>{t('New project')}</button>}>
        {show && (
          <form onSubmit={submit} style={{ marginBottom: 14 }}>
            <div className="form-grid">
              <Field label={t('Code')}><input value={f.code} onChange={set('code')} required /></Field>
              <Field label={t('Name')}><input value={f.name} onChange={set('name')} required /></Field>
              <Field label={t('Client')}><input value={f.client_name} onChange={set('client_name')} /></Field>
              <Field label="Client contact"><input value={f.client_contact} onChange={set('client_contact')} /></Field>
              <Field label="Location"><input value={f.location} onChange={set('location')} /></Field>
              <Field label={t('Contract value')}><input type="number" step="any" min="0" value={f.contract_value} onChange={set('contract_value')} required /></Field>
              <Field label="Start"><input type="date" value={f.start_date} onChange={set('start_date')} required /></Field>
              <Field label="End"><input type="date" value={f.end_date} onChange={set('end_date')} required /></Field>
            </div>
            <button className="btn" disabled={busy}>{t('Create')}</button>
          </form>
        )}
        {!list.data ? <Loading state={list} /> : (
          <Table rows={list.data} cols={[
            { h: 'Code', render: (p) => <a href={`#/p/${p.id}/overview`}>{p.code}</a> }, { h: 'Name', k: 'name' }, { h: 'Client', k: 'client_name' },
            { h: 'Contract value', num: true, render: (p) => (['owner', 'admin', 'project_manager', 'accountant'].includes(user.role) ? <Money v={p.contract_value} /> : '-') },
            { h: 'Schedule', render: (p) => `${p.start_date} → ${p.end_date}` }, { h: 'Status', render: (p) => <Status s={p.status} /> },
          ]} />
        )}
      </Card>
      {isGlobal(user) && list.data && <Members projects={list.data} />}
    </>
  );
}

function Members({ projects }) {
  const { t } = useI18n();
  const users = useLoad(() => api.get('/users'));
  const [pid, setPid] = useState('');
  const detail = useLoad(() => (pid ? api.get(`/projects/${pid}`) : Promise.resolve(null)), [pid]);
  const [uid, setUid] = useState('');
  const [act] = useAct();
  return (
    <Card title={t('Members')}>
      <div className="form-grid">
        <Field label={t('Project')}><select value={pid} onChange={(e) => setPid(e.target.value)}><option value="" />{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></Field>
      </div>
      {detail.data && (
        <>
          <div className="tag-line">{detail.data.members.map((m) => (
            <Badge key={m.id} tone="blue">{m.name} ({m.role}) <a href="#/" style={{ marginLeft: 6 }} onClick={(e) => { e.preventDefault(); act(() => api.del(`/projects/${pid}/members/${m.id}`), { onDone: detail.reload }); }}>×</a></Badge>
          ))}</div>
          <div className="row gap" style={{ marginTop: 10 }}>
            <select value={uid} onChange={(e) => setUid(e.target.value)}><option value="" />{(users.data || []).filter((u) => u.active && !['owner', 'admin'].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}</select>
            <button className="btn small" disabled={!uid} onClick={() => act(() => api.post(`/projects/${pid}/members`, { user_id: Number(uid) }), { onDone: () => { setUid(''); detail.reload(); } })}>{t('Add')}</button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Owner and admin see every project. Everyone else only sees projects they are assigned to.</p>
        </>
      )}
    </Card>
  );
}

function AccessRequests({ onChanged }) {
  const { t } = useI18n();
  const reqs = useLoad(() => api.get('/access-requests'));
  const projects = useLoad(() => api.get('/projects'));
  const [act] = useAct();
  const [sel, setSel] = useState({});   // id -> { role, projects: [] }
  const pending = (reqs.data || []).filter((r) => r.status === 'pending');
  const get = (id) => sel[id] || { role: 'engineer', projects: [] };
  const upd = (id, patch) => setSel({ ...sel, [id]: { ...get(id), ...patch } });
  const toggle = (id, pid) => { const cur = get(id).projects; upd(id, { projects: cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid] }); };
  const decide = (r, approve) => {
    let note = null;
    if (!approve) { note = ask(t('Reason')); if (!note) return; }
    const g = get(r.id);
    act(() => api.post(`/access-requests/${r.id}/decide`, { approve, note, role: g.role, project_ids: g.projects }), { ok: approve ? t('Approved') : t('Rejected'), onDone: () => { reqs.reload(); onChanged(); } });
  };
  if (!pending.length) return null;
  return (
    <Card title={`${t('Access requests')} (${pending.length})`}>
      {pending.map((r) => (
        <div key={r.id} className="req">
          <div><strong>{r.name}</strong> · {r.email}{r.phone ? ` · ${r.phone}` : ''}<div className="muted">{r.created_at}{r.message ? ` — ${r.message}` : ''}</div></div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label={t('Role')}><select value={get(r.id).role} onChange={(e) => upd(r.id, { role: e.target.value })}>{ROLES.map((x) => <option key={x}>{x}</option>)}</select></Field>
            <div className="field"><span>{t('Projects')}</span><div className="tag-line">{(projects.data || []).map((p) => (
              <label key={p.id} className="chk"><input type="checkbox" checked={get(r.id).projects.includes(p.id)} onChange={() => toggle(r.id, p.id)} /> {p.code}</label>
            ))}</div></div>
          </div>
          <div className="row gap"><button className="btn ok small" onClick={() => decide(r, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => decide(r, false)}>{t('Reject')}</button></div>
        </div>
      ))}
    </Card>
  );
}

export function UsersPage() {
  const { t } = useI18n();
  const users = useLoad(() => api.get('/users'));
  const [act, busy] = useAct();
  const [f, setF] = useState({ name: '', email: '', role: 'engineer', password: '', lang: 'en' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => { e.preventDefault(); act(() => api.post('/users', f), { ok: t('Create'), onDone: () => { setF({ ...f, name: '', email: '', password: '' }); users.reload(); } }); };
  const change = (u, patch) => { const reason = ask(t('Reason')); if (reason) act(() => api.patch(`/users/${u.id}`, { ...patch, reason }), { onDone: users.reload }); };
  return (
    <>
      <AccessRequests onChanged={users.reload} />
      <Card title={t('Add user')}>
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label={t('Name')}><input value={f.name} onChange={set('name')} required /></Field>
            <Field label={t('Email')}><input type="email" value={f.email} onChange={set('email')} required /></Field>
            <Field label={t('Role')}><select value={f.role} onChange={set('role')}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
            <Field label={t('Password')} hint="8+ characters, letters and digits"><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></Field>
            <Field label={t('Language')}><select value={f.lang} onChange={set('lang')}><option value="en">English</option><option value="rw">Kinyarwanda</option><option value="fr">Français</option></select></Field>
          </div>
          <button className="btn" disabled={busy}>{t('Create')}</button>
        </form>
      </Card>
      <Card title={t('Users')}>
        {!users.data ? <Loading state={users} /> : (
          <Table rows={users.data} cols={[
            { h: 'Name', k: 'name' }, { h: 'Email', k: 'email' }, { h: 'Role', render: (u) => <select value={u.role} onChange={(e) => change(u, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select> },
            { h: 'Status', render: (u) => (u.active ? <Badge tone="green">active</Badge> : <Badge tone="red">disabled</Badge>) },
            { h: 'Actions', render: (u) => <span className="row gap"><button className="btn alt small" onClick={() => change(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button><button className="btn alt small" onClick={() => { const pw = ask(t('Password')); if (pw) change(u, { password: pw }); }}>{t('Password')}</button></span> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const s = useLoad(() => api.get('/settings'));
  const backups = useLoad(() => api.get('/admin/backups'));
  const audit = useLoad(() => api.get('/audit'));
  const [act, busy] = useAct();
  const [v, setV] = useState(null);
  const vals = v || s.data || {};
  const LABELS = { cost_warning_pct: 'Cost warning at % of budget', cost_critical_pct: 'Cost critical at % of budget', delay_warning_days: 'Schedule warning (days late)', delay_critical_days: 'Schedule critical (days late)', margin_warning_pct: 'Margin warning below %', margin_critical_pct: 'Margin critical at or below %' };
  const save = (e) => { e.preventDefault(); const reason = ask(t('Reason')); if (reason) act(() => api.put('/settings', { ...vals, reason }), { ok: t('Save'), onDone: () => { setV(null); s.reload(); } }); };
  if (!s.data) return <Loading state={s} />;
  return (
    <>
      <Card title={t('Thresholds')}>
        <form onSubmit={save}>
          <div className="form-grid">{Object.keys(LABELS).map((k) => <Field key={k} label={LABELS[k]}><input type="number" step="any" value={vals[k] ?? ''} onChange={(e) => setV({ ...vals, [k]: e.target.value })} /></Field>)}</div>
          <button className="btn" disabled={busy}>{t('Save')}</button>
        </form>
      </Card>
      <Card title={t('Backups')} actions={<button className="btn small" disabled={busy} onClick={() => act(() => api.post('/admin/backup'), { ok: t('Save'), onDone: backups.reload })}>{t('Back up now')}</button>}>
        {(backups.data || []).slice(0, 10).map((b) => <div key={b} className="muted">{b}</div>)}
        <p className="muted" style={{ fontSize: 12 }}>Automatic daily backups; the newest 30 are kept in DATA_DIR/backups. Copy them off the server regularly.</p>
      </Card>
      <Card title={`${t('Audit')} (global)`}>
        {audit.data && <Table rows={audit.data.slice(0, 100)} cols={[{ h: 'Date', k: 'created_at' }, { h: 'Name', render: (l) => l.user_name || '-' }, { h: 'Status', render: (l) => `${l.action} ${l.entity}${l.entity_id ? ' #' + l.entity_id : ''}` }, { h: 'Reason', render: (l) => l.reason || '' }]} />}
      </Card>
    </>
  );
}

export function ManagementReports() {
  const { t } = useI18n();
  const [period, setPeriod] = useState('weekly');
  const r = useLoad(() => api.get(`/reports/management?period=${period}`), [period]);
  const [act] = useAct();
  return (
    <Card title={t('Management report')} actions={<>
      <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 'auto' }}><option value="daily">{t('Daily')}</option><option value="weekly">{t('Weekly')}</option><option value="monthly">{t('Monthly')}</option></select>
      <button className="btn alt small" onClick={() => act(() => download(`/reports/management/export?period=${period}&format=xlsx`, 'management.xlsx'))}>{t('Export Excel')}</button>
      <button className="btn alt small" onClick={() => act(() => download(`/reports/management/export?period=${period}&format=pdf`, 'management.pdf'))}>{t('Export PDF')}</button>
    </>}>
      {!r.data ? <Loading state={r} /> : (
        <Table rowKey="project" rows={r.data} cols={[
          { h: 'Project', render: (x) => <><strong>{x.project}</strong> {x.name}<div className="muted">{x.from} → {x.to}</div></> },
          { h: 'Progress', render: (x) => `${x.progress_pct}%` }, { h: 'Daily reports', num: true, render: (x) => x.approved_reports }, { h: 'Done qty', num: true, render: (x) => x.quantity_completed },
          { h: 'Delay (days)', num: true, render: (x) => x.delay_days },
          ...(r.data[0] && r.data[0].cost_in_period !== undefined ? [
            { h: 'Actual cost', num: true, render: (x) => <Money v={x.cost_in_period} /> }, { h: 'Cash received', num: true, render: (x) => <Money v={x.cash_in_period} /> },
            { h: 'Cash paid', num: true, render: (x) => <Money v={x.cash_out_period} /> }, { h: 'Forecast profit', num: true, render: (x) => <Money v={x.forecast_profit} /> },
          ] : []),
          { h: 'Alerts', num: true, render: (x) => x.open_alerts },
        ]} />
      )}
    </Card>
  );
}
