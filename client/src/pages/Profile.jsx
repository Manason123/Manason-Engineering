import { useState } from 'react';
import { api } from '../api';
import { LANGS, useI18n } from '../i18n';
import { Badge, Card, Field, useAct } from '../ui';

export default function Profile({ user }) {
  const { t, lang, setLang } = useI18n();
  const [act, busy] = useAct();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (f.next !== f.confirm) return act(async () => { throw new Error(t('Passwords do not match')); });
    act(() => api.post('/me/password', { current: f.current, next: f.next }), { ok: t('Save'), onDone: () => setF({ current: '', next: '', confirm: '' }) });
  };
  return (
    <div style={{ maxWidth: 560 }}>
      <Card title={t('My profile')}>
        <p><strong>{user.name}</strong><br /><span className="muted">{user.email}</span><br /><Badge tone="blue">{user.role.replace('_', ' ')}</Badge></p>
        <Field label={t('Language')}>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </Field>
      </Card>
      <Card title={t('Change password')}>
        <form onSubmit={submit}>
          <Field label={t('Current password')}><input type="password" autoComplete="current-password" value={f.current} onChange={set('current')} required /></Field>
          <Field label={t('New password')} hint={t('At least 8 characters, with letters and digits')}><input type="password" autoComplete="new-password" value={f.next} onChange={set('next')} required /></Field>
          <Field label={t('Confirm password')}><input type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required /></Field>
          <button className="btn" disabled={busy}>{t('Save')}</button>
        </form>
      </Card>
    </div>
  );
}
