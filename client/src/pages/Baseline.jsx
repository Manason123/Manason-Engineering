import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { can } from '../nav';
import { Card, Field, Loading, Money, Table, useAct, useLoad, ask, today } from '../ui';

export default function Baseline({ project, user, reloadProject }) {
  const { t } = useI18n();
  const acts = useLoad(() => api.get(`/projects/${project.id}/activities`), [project.id]);
  const bl = useLoad(() => api.get(`/projects/${project.id}/baseline`), [project.id, project.baseline_approved]);
  const mats = useLoad(() => api.get('/materials'));
  const [act, busy] = useAct();
  const [f, setF] = useState({ code: '', name: '', unit: '', planned_qty: '', rate: '', budget_cost: '', planned_start: project.start_date, planned_end: project.end_date, productivity_per_day: '' });
  const [res, setRes] = useState({ activity_id: '', type: 'material', material_id: '', name: '', unit: '', qty_per_unit: '', unit_cost: '' });
  const edit = can(user, 'baseline.edit') && !project.baseline_approved;
  const base = `/projects/${project.id}`;
  const reload = () => { acts.reload(); bl.reload(); reloadProject(); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const add = (e) => {
    e.preventDefault();
    act(() => api.post(`${base}/activities`, { ...f, budget_cost: f.budget_cost === '' ? Number(f.planned_qty) * Number(f.rate || 0) : f.budget_cost }), {
      ok: t('Save'), onDone: () => { setF({ ...f, code: '', name: '', planned_qty: '', rate: '', budget_cost: '' }); reload(); },
    });
  };
  const importXlsx = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    act(() => api.upload(`${base}/activities/import`, fd), { ok: 'Imported', onDone: reload });
    e.target.value = '';
  };
  const addDep = (a) => {
    const code = ask(`${a.code}: depends on which activity code?`); if (!code) return;
    const d = acts.data.find((x) => x.code === code);
    if (!d) return act(async () => { throw new Error('Activity code not found'); });
    act(() => api.post(`${base}/activities/${a.id}/deps`, { depends_on_id: d.id }), { onDone: reload });
  };
  const addRes = (e) => {
    e.preventDefault();
    act(() => api.post(`${base}/activities/${res.activity_id}/resources`, { ...res }), { ok: t('Save'), onDone: () => { setRes({ ...res, qty_per_unit: '' }); reload(); } });
  };
  const approve = () => {
    if (!window.confirm('Approve the baseline? Budget and schedule will be frozen. Later changes need approved variations / schedule revisions.')) return;
    act(() => api.post(`${base}/baseline/approve`), { ok: t('Approved'), onDone: reload });
  };
  const codeOf = (id) => acts.data.find((a) => a.id === id)?.code;
  const total = (acts.data || []).reduce((s, a) => s + a.budget_cost, 0);

  return (
    <>
      {project.baseline_approved && bl.data && (
        <p className="note">{t('Baseline')} v{bl.data.version} · {t('Approved')} {bl.data.approved_at} · {t('Original budget')}: <Money v={bl.data.total_budget} />. {t('Original and approved budget are kept separate.')}</p>
      )}
      <Card title={`${t('Activities')} (${acts.data ? acts.data.length : 0})`} actions={edit && <>
        <label className="btn alt small">{t('Import BOQ from Excel')}<input type="file" accept=".xlsx" hidden onChange={importXlsx} /></label>
        <button className="btn ok small" disabled={busy || !acts.data?.length} onClick={approve}>{t('Approve baseline')}</button>
      </>}>
        {!acts.data ? <Loading state={acts} /> : (
          <>
            <div className="tbl-wrap"><table className="tbl stack">
              <thead><tr><th>{t('Code')}</th><th>{t('Activity')}</th><th className="r">{t('Quantity')}</th><th className="r">{t('Original budget')}</th><th>{t('Schedule')}</th><th>Depends on</th><th>Resources / unit</th>{edit && <th />}</tr></thead>
              <tbody>{acts.data.map((a) => (
                <tr key={a.id}>
                  <td data-label={t('Code')}>{a.code}</td><td data-label={t('Activity')}>{a.name}</td>
                  <td data-label={t('Quantity')} className="r">{a.planned_qty} {a.unit}</td>
                  <td data-label={t('Original budget')} className="r"><Money v={a.budget_cost} /></td>
                  <td data-label={t('Schedule')}>{a.planned_start} → {a.planned_end}<div className="muted">{a.productivity_per_day || '-'} {a.unit}/day</div></td>
                  <td data-label="Depends on">{a.deps.map(codeOf).join(', ') || '-'}</td>
                  <td data-label="Resources">{a.resources.map((r) => <div key={r.id}>{r.type === 'material' ? r.material_name : r.name}: {r.qty_per_unit} {r.unit}</div>)}</td>
                  {edit && <td><button className="btn alt small" onClick={() => addDep(a)}>+dep</button> <button className="btn danger small" onClick={() => window.confirm(`${t('Delete')} ${a.code}?`) && act(() => api.del(`${base}/activities/${a.id}`), { onDone: reload })}>{t('Delete')}</button></td>}
                </tr>))}</tbody>
            </table></div>
            <p><strong>{t('Original budget')}: <Money v={total} /></strong></p>
          </>
        )}
      </Card>

      {edit && (
        <Card title={t('Add') + ' ' + t('Activity')}>
          <form onSubmit={add}>
            <div className="form-grid">
              <Field label={t('Code')}><input value={f.code} onChange={set('code')} required /></Field>
              <Field label={t('Name')}><input value={f.name} onChange={set('name')} required /></Field>
              <Field label={t('Unit')}><input value={f.unit} onChange={set('unit')} required /></Field>
              <Field label={t('Quantity')}><input type="number" step="any" min="0" value={f.planned_qty} onChange={set('planned_qty')} required /></Field>
              <Field label="Rate"><input type="number" step="any" min="0" value={f.rate} onChange={set('rate')} /></Field>
              <Field label={t('Original budget')} hint="Empty = quantity × rate"><input type="number" step="any" min="0" value={f.budget_cost} onChange={set('budget_cost')} /></Field>
              <Field label="Start"><input type="date" value={f.planned_start} onChange={set('planned_start')} required /></Field>
              <Field label="End"><input type="date" value={f.planned_end} onChange={set('planned_end')} required /></Field>
              <Field label="Productivity / day"><input type="number" step="any" min="0" value={f.productivity_per_day} onChange={set('productivity_per_day')} /></Field>
            </div>
            <button className="btn" disabled={busy}>{t('Add')}</button>
          </form>
          <p className="muted" style={{ fontSize: 12 }}>Excel columns: Code, Description, Unit, Quantity, Rate (optional: Budget, Start, End, Productivity).</p>
        </Card>
      )}

      {can(user, 'baseline.edit') && acts.data && acts.data.length > 0 && (
        <Card title="Resource requirements per unit of activity">
          <form onSubmit={addRes}>
            <div className="form-grid">
              <Field label={t('Activity')}><select value={res.activity_id} onChange={(e) => setRes({ ...res, activity_id: e.target.value })} required><option value="" />{acts.data.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
              <Field label="Type"><select value={res.type} onChange={(e) => setRes({ ...res, type: e.target.value })}><option value="material">{t('Materials')}</option><option value="labour">{t('Labour')}</option><option value="equipment">{t('Equipment')}</option></select></Field>
              {res.type === 'material'
                ? <Field label={t('Materials')}><select value={res.material_id} onChange={(e) => { const m = mats.data.find((x) => x.id === Number(e.target.value)); setRes({ ...res, material_id: e.target.value, unit: m ? m.unit : '', unit_cost: m ? m.default_price : '' }); }} required><option value="" />{(mats.data || []).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select></Field>
                : <Field label={t('Name')}><input value={res.name} onChange={(e) => setRes({ ...res, name: e.target.value })} required /></Field>}
              <Field label={t('Unit')}><input value={res.unit} onChange={(e) => setRes({ ...res, unit: e.target.value })} required /></Field>
              <Field label="Qty per activity unit"><input type="number" step="any" min="0" value={res.qty_per_unit} onChange={(e) => setRes({ ...res, qty_per_unit: e.target.value })} required /></Field>
              <Field label={t('Unit price')}><input type="number" step="any" min="0" value={res.unit_cost} onChange={(e) => setRes({ ...res, unit_cost: e.target.value })} /></Field>
            </div>
            <button className="btn" disabled={busy}>{t('Add')}</button>
          </form>
          <p className="muted" style={{ fontSize: 12 }}>Used to compute material needs for remaining work and shortages. Resource lines can be added after approval (they do not change the budget).</p>
        </Card>
      )}
      {!today && null}
    </>
  );
}
