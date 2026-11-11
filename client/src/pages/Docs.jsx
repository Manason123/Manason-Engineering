import { useState } from 'react';
import { api, openFile } from '../api';
import { useI18n } from '../i18n';
import { can } from '../nav';
import { Card, Field, Loading, Table, useAct, useLoad } from '../ui';

export function Documents({ project, user }) {
  const { t } = useI18n();
  const base = `/projects/${project.id}`;
  const docs = useLoad(() => api.get(`${base}/documents`), [base]);
  const [act, busy] = useAct();
  const [kind, setKind] = useState('document');
  const [files, setFiles] = useState([]);
  const upload = (e) => {
    e.preventDefault();
    const fd = new FormData(); fd.append('kind', kind); files.forEach((f) => fd.append('files', f));
    act(() => api.upload(`${base}/documents`, fd), { ok: t('Save'), onDone: () => { setFiles([]); e.target.reset(); docs.reload(); } });
  };
  return (
    <>
      {can(user, 'doc.upload') && (
        <Card title={t('Documents')}>
          <form onSubmit={upload}>
            <div className="form-grid">
              <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value)}>{['document', 'contract', 'drawing', 'photo', 'delivery_note', 'other'].map((k) => <option key={k}>{k}</option>)}</select></Field>
              <Field label="File (max 15 MB)"><input type="file" multiple required onChange={(e) => setFiles([...e.target.files])} /></Field>
            </div>
            <button className="btn" disabled={busy || !files.length}>{t('Add')}</button>
          </form>
        </Card>
      )}
      <Card title={t('Documents')}>
        {!docs.data ? <Loading state={docs} /> : (
          <Table rows={docs.data} cols={[
            { h: 'Name', render: (d) => <a href="#/" onClick={(e) => { e.preventDefault(); act(() => openFile(`${base}/documents/${d.id}/download`)); }}>{d.original_name}</a> },
            { h: 'Type', render: (d) => d.kind }, { h: 'Date', render: (d) => d.created_at }, { h: 'Quantity', num: true, render: (d) => `${Math.round((d.size || 0) / 1024)} KB` },
          ]} />
        )}
      </Card>
    </>
  );
}

export function AuditLog({ project }) {
  const { t } = useI18n();
  const log = useLoad(() => api.get(`/projects/${project.id}/audit`), [project.id]);
  if (!log.data) return <Loading state={log} />;
  return (
    <Card title={t('Audit')}>
      <Table rows={log.data} cols={[
        { h: 'Date', k: 'created_at' }, { h: 'Name', render: (l) => l.user_name || '-' }, { h: 'Status', render: (l) => `${l.action} ${l.entity}${l.entity_id ? ' #' + l.entity_id : ''}` },
        { h: 'Reason', render: (l) => l.reason || '' },
        { h: 'Note', render: (l) => (l.after_json ? <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{l.after_json.slice(0, 160)}</code> : '') },
      ]} />
    </Card>
  );
}
