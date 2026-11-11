import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { I18nContext, LANGS, makeT } from './i18n';
import { ToastProvider } from './ui';
import AuthScreen from './AuthScreen';
import Profile from './pages/Profile';
import { go } from './nav';
import Dashboard from './pages/Dashboard';
import ProjectPage from './pages/Project';
import { ManagementReports, SettingsPage, UsersPage, ProjectsAdmin } from './pages/Admin';

function useHash() {
  const [h, setH] = useState(window.location.hash || '#/');
  useEffect(() => {
    const f = () => setH(window.location.hash || '#/');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h.replace(/^#/, '') || '/';
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState(() => { try { return localStorage.getItem('bt_lang') || 'en'; } catch { return 'en'; } });
  const route = useHash();
  const [pending, setPending] = useState(0);

  const logout = useCallback(() => { setToken(null); setUser(null); go('/'); }, []);
  useEffect(() => { setUnauthorizedHandler(logout); }, [logout]);
  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api.get('/me').then((u) => { setUser(u); }).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (user && ['owner', 'admin'].includes(user.role)) api.get('/access-requests').then((r) => setPending(r.filter((x) => x.status === 'pending').length)).catch(() => {});
  }, [user, route]);

  const setLang = useCallback((l) => {
    setLangState(l);
    try { localStorage.setItem('bt_lang', l); } catch { /* ignore */ }
    document.documentElement.lang = l;
    if (getToken()) api.patch('/me', { lang: l }).catch(() => {});
  }, []);
  const ctx = useMemo(() => ({ lang, setLang, t: makeT(lang) }), [lang, setLang]);
  const { t } = ctx;

  const onLogin = (r) => {
    if (!r || !r.token) return;
    setToken(r.token); setUser(r.user);
    setLang(r.user.lang || lang);
  };

  if (!ready) return null;
  const isAdmin = user && ['owner', 'admin'].includes(user.role);

  let page = null;
  if (user) {
    const parts = route.split('/').filter(Boolean);
    if (parts[0] === 'p' && parts[1]) page = <ProjectPage key={parts[1]} id={parts[1]} tab={parts[2] || 'overview'} user={user} />;
    else if (parts[0] === 'profile') page = <Profile user={user} />;
    else if (parts[0] === 'reports') page = <ManagementReports user={user} />;
    else if (parts[0] === 'admin' && isAdmin && parts[1] === 'users') page = <UsersPage />;
    else if (parts[0] === 'admin' && isAdmin && parts[1] === 'settings') page = <SettingsPage />;
    else if (parts[0] === 'projects') page = <ProjectsAdmin user={user} />;
    else page = <Dashboard user={user} />;
  }

  return (
    <I18nContext.Provider value={ctx}>
      <ToastProvider>
        {!user ? (
          <AuthScreen onLogin={onLogin} t={t} lang={lang} setLang={setLang} />
        ) : (
          <>
            <header className="top">
              <span className="brand" onClick={() => go('/')}>BuildTrack</span>
              <nav className="navs">
                <button className={`link ${route === '/' ? 'on' : ''}`} onClick={() => go('/')}>{t('Dashboard')}</button>
                <button className={`link ${route.startsWith('/projects') ? 'on' : ''}`} onClick={() => go('/projects')}>{t('Projects')}</button>
                <button className={`link ${route.startsWith('/reports') ? 'on' : ''}`} onClick={() => go('/reports')}>{t('Reports')}</button>
                {isAdmin && <button className={`link ${route.startsWith('/admin/users') ? 'on' : ''}`} onClick={() => go('/admin/users')}>{t('Users')}{pending > 0 && <span className="pill">{pending}</span>}</button>}
                {isAdmin && <button className={`link ${route.startsWith('/admin/settings') ? 'on' : ''}`} onClick={() => go('/admin/settings')}>{t('Settings')}</button>}
              </nav>
              <select aria-label={t('Language')} value={lang} onChange={(e) => setLang(e.target.value)}>
                {LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
              </select>
              <button className={`link ${route.startsWith('/profile') ? 'on' : ''}`} onClick={() => go('/profile')} title={user.email}>{user.name.split(' ')[0]}</button>
              <button className="link" onClick={logout}>{t('Sign out')}</button>
            </header>
            <main>{page}</main>
          </>
        )}
      </ToastProvider>
    </I18nContext.Provider>
  );
}
