import { useEffect, useState } from 'react';
import { api, checkApi } from './api';
import { LANGS } from './i18n';
import { Field, Tabs, useAct } from './ui';

/** Original illustration: blueprint grid, tower crane and a building going up. No external images needed. */
function Hero() {
  const floors = [0, 1, 2, 3, 4, 5, 6];
  return (
    <svg className="hero-svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#06292a" /><stop offset=".6" stopColor="#0f4a47" /><stop offset="1" stopColor="#1c7c6f" /></linearGradient>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#fff" strokeOpacity=".07" /></pattern>
        <linearGradient id="glow" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#e8a317" stopOpacity=".35" /><stop offset="1" stopColor="#e8a317" stopOpacity="0" /></linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#sky)" />
      <rect width="800" height="600" fill="url(#grid)" />
      <rect y="380" width="800" height="120" fill="url(#glow)" />
      {/* distant skyline */}
      <g fill="#0b3b3a" opacity=".9">
        <rect x="20" y="360" width="60" height="140" /><rect x="90" y="330" width="45" height="170" /><rect x="150" y="380" width="70" height="120" />
        <rect x="560" y="350" width="70" height="150" /><rect x="640" y="320" width="50" height="180" /><rect x="700" y="372" width="80" height="128" />
      </g>
      {/* building frame under construction */}
      <g stroke="#cfe9e4" strokeOpacity=".75" strokeWidth="3" fill="none">
        {floors.map((i) => <line key={`f${i}`} x1="250" x2="500" y1={470 - i * 34} y2={470 - i * 34} />)}
        {[250, 312, 375, 437, 500].map((x) => <line key={`c${x}`} x1={x} x2={x} y1="470" y2="232" />)}
      </g>
      <g fill="#e8a317" opacity=".85">
        {[[270, 436], [395, 402], [455, 368], [330, 334], [395, 300], [270, 266]].map(([x, y], i) => <rect key={i} x={x} y={y} width="30" height="20" rx="2" />)}
      </g>
      {/* tower crane */}
      <g stroke="#e8a317" strokeWidth="4" fill="none" strokeLinejoin="round">
        <path d="M560 500V130M590 500V130M560 500l30-60M560 440l30-60M560 380l30-60M560 320l30-60M560 260l30-60M560 200l30-60" strokeWidth="3" />
        <path d="M575 130H250l-40 0M575 130L690 130M575 120L370 70M575 120L690 130" />
        <path d="M575 130V90l-20-30h40z" fill="#e8a317" />
      </g>
      <g stroke="#cfe9e4" strokeWidth="2" opacity=".9"><line x1="300" y1="130" x2="300" y2="236" /><line x1="300" y1="236" x2="285" y2="250" /><line x1="300" y1="236" x2="315" y2="250" /></g>
      <rect x="283" y="250" width="34" height="14" fill="#e8a317" />
      <rect y="500" width="800" height="100" fill="#06292a" />
      <path d="M0 500H800" stroke="#e8a317" strokeOpacity=".5" strokeWidth="2" strokeDasharray="14 10" />
    </svg>
  );
}

const FEATURES = [
  ['Every project on one dashboard', '▦'],
  ['Budget, cash and profit you can trust', '◎'],
  ['Daily reports from the site, on any phone', '✓'],
];

export default function AuthScreen({ onLogin, t, lang, setLang }) {
  const [tab, setTab] = useState('login');
  const [act, busy] = useAct();
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '', message: '', confirm: '' });
  const [sent, setSent] = useState(false);
  const [conn, setConn] = useState(null);
  useEffect(() => { checkApi().then(setConn); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const login = (e) => { e.preventDefault(); act(() => api.post('/auth/login', { email: f.email, password: f.password }), { onDone: onLogin }); };
  const register = (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return act(async () => { throw new Error(t('Passwords do not match')); });
    act(() => api.post('/auth/register', { name: f.name, email: f.email, phone: f.phone, message: f.message, password: f.password }), { onDone: () => setSent(true) });
  };

  return (
    <div className="auth">
      <aside className="auth-hero">
        <Hero />
        <div className="auth-hero-text">
          <div className="logo"><svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#e8a317" /><path d="M7 25V12l9-5 9 5v13M12 25v-8h8v8" fill="none" stroke="#06292a" strokeWidth="2.4" strokeLinejoin="round" /></svg> BuildTrack Pro</div>
          <h1>{t('Build on time. Stay on budget.')}</h1>
          <p>{t('Control every site, cost and schedule from one place.')}</p>
          <ul>{FEATURES.map(([txt, ic]) => <li key={txt}><span>{ic}</span>{t(txt)}</li>)}</ul>
        </div>
      </aside>
      <section className="auth-panel">
        <div className="auth-lang">
          <select aria-label={t('Language')} value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </div>
        {conn && !conn.ok && (
          <div className="conn-warn" role="alert">
            <strong>{t('The server is not connected')}</strong>
            <div>{conn.reason === 'network'
              ? t('The web app cannot reach the API, or the API refuses this website (set CORS_ORIGIN on the API).')
              : t('No API was found at this address. Deploy the API and set VITE_API_URL, then redeploy the web app.')}</div>
            <code>API: {conn.base || t('(not set)')}</code>
          </div>
        )}
        <div className="auth-card card">
          <Tabs tabs={[['login', t('Sign in')], ['register', t('Request access')]]} value={tab} onChange={(k) => { setTab(k); setSent(false); }} />
          {tab === 'login' ? (
            <form onSubmit={login}>
              <Field label={t('Email')}><input type="email" autoComplete="username" value={f.email} onChange={set('email')} required /></Field>
              <Field label={t('Password')}><input type="password" autoComplete="current-password" value={f.password} onChange={set('password')} required /></Field>
              <button className="btn" disabled={busy || (conn && !conn.ok)} style={{ width: '100%' }}>{t('Sign in')}</button>
              <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>{t('Forgot your password? Ask your administrator to reset it.')}</p>
            </form>
          ) : sent ? (
            <div className="sent">
              <div className="tick">✓</div>
              <h3>{t('Request received')}</h3>
              <p className="muted">{t('An administrator will review your request and activate your account. You can then sign in with the email and password you chose.')}</p>
              <button className="btn alt" onClick={() => { setTab('login'); setSent(false); }}>{t('Sign in')}</button>
            </div>
          ) : (
            <form onSubmit={register}>
              <Field label={t('Full name')}><input value={f.name} onChange={set('name')} autoComplete="name" required /></Field>
              <Field label={t('Email')}><input type="email" value={f.email} onChange={set('email')} autoComplete="email" required /></Field>
              <Field label={t('Phone')}><input type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></Field>
              <Field label={t('Password')} hint={t('At least 8 characters, with letters and digits')}><input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required /></Field>
              <Field label={t('Confirm password')}><input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required /></Field>
              <Field label={t('Who are you and which project do you work on?')}><textarea rows="2" value={f.message} onChange={set('message')} maxLength={500} /></Field>
              <button className="btn" disabled={busy || (conn && !conn.ok)} style={{ width: '100%' }}>{t('Request access')}</button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
