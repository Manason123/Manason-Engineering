import { useState } from 'react';
import { api, openFile } from '../api';
import { useI18n } from '../i18n';
import { can } from '../nav';
import { Card, Field, Loading, Status, Table, useAct, useLoad, ask, today } from '../ui';

const blank = () => ({ report_date: today(), weather: '', delays: '', problems: '', lines: [], labour: [], materials: [], equipment: [] });

export default function Reports({ project, user }) {
  const { t } = useI18n();
  const list = useLoad(() => api.get(`/projects/${project.id}/reports`), [project.id]);
  const acts = useLoad(() => api.get(`/projects/${project.id}/activities`), [project.id]);
  const mats = useLoad(() => api.get('/materials'));
  const [act, busy] = useAct();
  const [form, setForm] = useState(null);   // null = list view
  const [editId, setEditId] = useState(null);
  const [files, setFiles] = useState([]);
  const [open, setOpen] = useState(null);
  const base = `/projects/${project.id}`;

  const startNew = () => {
    const f = blank();
    f.lines = (acts.data || []).slice(0, 1).map((a) => ({ activity_id: a.id, planned_qty: '', completed_qty: '' }));
    setEditId(null); setFiles([]); setForm(f);
  };
  const startEdit = async (id) => {
    const r = await api.get(`${base}/reports/${id}`);
    setEditId(id); setFiles([]);
    setForm({ report_date: r.report_date, weather: r.weather || '', delays: r.delays || '', problems: r.problems || '',
      lines: r.lines, labour: r.labour, materials: r.materials, equipment: r.equipment });
  };
  const upd = (key, i, k, v) => setForm((f) => ({ ...f, [key]: f[key].map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const addRow = (key, row) => setForm((f) => ({ ...f, [key]: [...f[key], row] }));
  const delRow = (key, i) => setForm((f) => ({ ...f, [key]: f[key].filter((_, j) => j !== i) }));
  const firstAct = acts.data && acts.data[0] ? acts.data[0].id : '';

  const save = async (submit) => {
    const body = { ...form, submit };
    const r = await act(() => (editId ? api.put(`${base}/reports/${editId}`, body).then(() => ({ id: editId })) : api.post(`${base}/reports`, body)), { ok: submit ? t('Submitted') : t('Draft') });
    if (!r) return;
    if (files.length) {
      const fd = new FormData(); files.forEach((f) => fd.append('files', f));
      await act(() => api.upload(`${base}/reports/${r.id}/photos`, fd), { ok: t('Photos') });
    }
    setForm(null); list.reload();
  };
  const review = (r, approve) => {
    const note = approve ? null : ask(t('Reason'));
    if (!approve && !note) return;
    act(() => api.post(`${base}/reports/${r.id}/review`, { approve, note }), { ok: approve ? t('Approved') : t('Rejected'), onDone: () => { list.reload(); setOpen(null); } });
  };
  const view = async (id) => setOpen(await api.get(`${base}/reports/${id}`));

  if (form) {
    const A = (acts.data || []);
    const actSel = (v, on, allowEmpty) => (
      <select value={v ?? ''} onChange={(e) => on(e.target.value)}>{allowEmpty && <option value="">-</option>}{A.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
    );
    return (
      <Card title={editId ? t('Daily reports') : t('New report')} actions={<button className="btn alt small" onClick={() => setForm(null)}>{t('Cancel')}</button>}>
        <div className="form-grid">
          <Field label={t('Report date')}><input type="date" max={today()} value={form.report_date} disabled={!!editId} onChange={(e) => setForm({ ...form, report_date: e.target.value })} /></Field>
          <Field label={t('Weather')}><input value={form.weather} onChange={(e) => setForm({ ...form, weather: e.target.value })} /></Field>
        </div>
        <Field label={t('Delays')}><textarea rows="2" value={form.delays} onChange={(e) => setForm({ ...form, delays: e.target.value })} /></Field>
        <Field label={t('Problems')}><textarea rows="2" value={form.problems} onChange={(e) => setForm({ ...form, problems: e.target.value })} /></Field>

        <div className="sub-lines"><h3>{t('Activities')}</h3>
          {form.lines.map((l, i) => (
            <div className="line" key={i}>
              <Field label={t('Activity')}>{actSel(l.activity_id, (v) => upd('lines', i, 'activity_id', Number(v)))}</Field>
              <Field label={t('Planned qty')}><input type="number" step="any" min="0" value={l.planned_qty} onChange={(e) => upd('lines', i, 'planned_qty', e.target.value)} /></Field>
              <Field label={t('Done qty')}><input type="number" step="any" min="0" value={l.completed_qty} onChange={(e) => upd('lines', i, 'completed_qty', e.target.value)} /></Field>
              <button type="button" className="btn danger small" onClick={() => delRow('lines', i)}>×</button>
            </div>))}
          <button type="button" className="btn alt small" onClick={() => addRow('lines', { activity_id: firstAct, planned_qty: '', completed_qty: '' })}>+ {t('Activity')}</button>
        </div>

        <div className="sub-lines"><h3>{t('Labour')}</h3>
          {form.labour.map((l, i) => (
            <div className="line" key={i}>
              <Field label={t('Activity')}>{actSel(l.activity_id, (v) => upd('labour', i, 'activity_id', v ? Number(v) : null), true)}</Field>
              <Field label={t('Trade')}><input value={l.trade} onChange={(e) => upd('labour', i, 'trade', e.target.value)} /></Field>
              <Field label={t('Workers')}><input type="number" min="0" value={l.workers} onChange={(e) => upd('labour', i, 'workers', e.target.value)} /></Field>
              <Field label={t('Hours')}><input type="number" step="any" min="0" max="24" value={l.hours} onChange={(e) => upd('labour', i, 'hours', e.target.value)} /></Field>
              {can(user, 'finance.view') && <Field label="Rate/h"><input type="number" step="any" min="0" value={l.hourly_rate} onChange={(e) => upd('labour', i, 'hourly_rate', e.target.value)} /></Field>}
              <button type="button" className="btn danger small" onClick={() => delRow('labour', i)}>×</button>
            </div>))}
          <button type="button" className="btn alt small" onClick={() => addRow('labour', { activity_id: firstAct, trade: '', workers: '', hours: 8, hourly_rate: 0 })}>+ {t('Labour')}</button>
        </div>

        <div className="sub-lines"><h3>{t('Materials')} ({t('Consumed')})</h3>
          {form.materials.map((l, i) => (
            <div className="line" key={i}>
              <Field label={t('Activity')}>{actSel(l.activity_id, (v) => upd('materials', i, 'activity_id', v ? Number(v) : null), true)}</Field>
              <Field label={t('Materials')}><select value={l.material_id ?? ''} onChange={(e) => upd('materials', i, 'material_id', Number(e.target.value))}><option value="" />{(mats.data || []).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select></Field>
              <Field label={t('Consumed')}><input type="number" step="any" min="0" value={l.qty_consumed} onChange={(e) => upd('materials', i, 'qty_consumed', e.target.value)} /></Field>
              <Field label={t('Wasted')}><input type="number" step="any" min="0" value={l.qty_wasted} onChange={(e) => upd('materials', i, 'qty_wasted', e.target.value)} /></Field>
              <button type="button" className="btn danger small" onClick={() => delRow('materials', i)}>×</button>
            </div>))}
          <button type="button" className="btn alt small" onClick={() => addRow('materials', { activity_id: firstAct, material_id: '', qty_consumed: '', qty_wasted: 0 })}>+ {t('Materials')}</button>
          <p className="muted" style={{ fontSize: 12 }}>Only stock already issued to site can be consumed. Requested stock is never counted as consumed.</p>
        </div>

        <div className="sub-lines"><h3>{t('Equipment')}</h3>
          {form.equipment.map((l, i) => (
            <div className="line" key={i}>
              <Field label={t('Activity')}>{actSel(l.activity_id, (v) => upd('equipment', i, 'activity_id', v ? Number(v) : null), true)}</Field>
              <Field label={t('Name')}><input value={l.name} onChange={(e) => upd('equipment', i, 'name', e.target.value)} /></Field>
              <Field label={t('Hours')}><input type="number" step="any" min="0" max="24" value={l.hours} onChange={(e) => upd('equipment', i, 'hours', e.target.value)} /></Field>
              {can(user, 'finance.view') && <Field label="Rate/h"><input type="number" step="any" min="0" value={l.hourly_rate} onChange={(e) => upd('equipment', i, 'hourly_rate', e.target.value)} /></Field>}
              <button type="button" className="btn danger small" onClick={() => delRow('equipment', i)}>×</button>
            </div>))}
          <button type="button" className="btn alt small" onClick={() => addRow('equipment', { activity_id: firstAct, name: '', hours: 8, hourly_rate: 0 })}>+ {t('Equipment')}</button>
        </div>

        <Field label={t('Photos')}><input type="file" accept="image/*,application/pdf" capture="environment" multiple onChange={(e) => setFiles([...e.target.files])} /></Field>
        <div className="row gap wrap">
          <button className="btn alt" disabled={busy} onClick={() => save(false)}>{t('Save')} ({t('Draft')})</button>
          <button className="btn" disabled={busy} onClick={() => save(true)}>{t('Submit')}</button>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title={t('Daily reports')} actions={can(user, 'report.write') && project.baseline_approved && <button className="btn small" onClick={startNew}>{t('New report')}</button>}>
        {!project.baseline_approved && <p className="note">{t('Approve baseline')} →</p>}
        {!list.data ? <Loading state={list} /> : (
          <Table rows={list.data} cols={[
            { h: 'Date', render: (r) => <a href="#/" onClick={(e) => { e.preventDefault(); view(r.id); }}>{r.report_date}</a> },
            { h: 'Status', render: (r) => <Status s={r.status} /> }, { h: 'Workers', num: true, k: 'workers' }, { h: 'Name', render: (r) => r.submitted_by_name },
            { h: 'Delays', render: (r) => r.delays || '-' },
            { h: 'Actions', render: (r) => (
              <span className="row gap wrap">
                {['draft', 'rejected'].includes(r.status) && (r.submitted_by === user.id || ['owner', 'admin'].includes(user.role)) && <button className="btn alt small" onClick={() => startEdit(r.id)}>{t('Save')}</button>}
                {r.status === 'submitted' && can(user, 'report.approve') && r.submitted_by !== user.id && <><button className="btn ok small" onClick={() => review(r, true)}>{t('Approve')}</button><button className="btn danger small" onClick={() => review(r, false)}>{t('Reject')}</button></>}
              </span>) },
          ]} />
        )}
      </Card>
      {open && (
        <Card title={`${open.report_date} · ${open.status}`} actions={<button className="btn alt small" onClick={() => setOpen(null)}>{t('Close')}</button>}>
          <p>{open.weather} {open.delays && <><br /><strong>{t('Delays')}:</strong> {open.delays}</>} {open.problems && <><br /><strong>{t('Problems')}:</strong> {open.problems}</>} {open.review_note && <><br /><em>{open.review_note}</em></>}</p>
          <Table rows={open.lines} cols={[{ h: 'Activity', render: (l) => `${l.code} ${l.name}` }, { h: 'Planned qty', num: true, render: (l) => `${l.planned_qty} ${l.unit}` }, { h: 'Done qty', num: true, render: (l) => `${l.completed_qty} ${l.unit}` }]} />
          {open.labour.length > 0 && <p><strong>{t('Labour')}:</strong> {open.labour.map((l) => `${l.trade} ${l.workers}×${l.hours}h`).join(', ')}</p>}
          {open.materials.length > 0 && <p><strong>{t('Materials')}:</strong> {open.materials.map((m) => `${m.name} ${m.qty_consumed} ${m.unit} (${t('Wasted')} ${m.qty_wasted})`).join(', ')}</p>}
          {open.equipment.length > 0 && <p><strong>{t('Equipment')}:</strong> {open.equipment.map((e) => `${e.name} ${e.hours}h`).join(', ')}</p>}
          {open.photos.length > 0 && <div className="row gap wrap">{open.photos.map((p) => <button key={p.id} className="btn alt small" onClick={() => act(() => openFile(`/projects/${project.id}/documents/${p.id}/download`))}>{p.original_name}</button>)}</div>}
        </Card>
      )}
    </>
  );
}
