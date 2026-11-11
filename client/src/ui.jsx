import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { money, useI18n } from './i18n';

// ---------- data loading ----------
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(fn()).then(
      (data) => { if (n === seq.current) setState({ data, error: null, loading: false }); },
      (error) => { if (n === seq.current) setState({ data: null, error: error.message, loading: false }); },
    );
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, type }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), type === 'err' ? 7000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((i) => <div key={i.id} className={`toast ${i.type}`}>{i.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: shows errors as toasts, optional success message, then runs onDone. */
export function useAct() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (fn, { ok, onDone } = {}) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      if (onDone) onDone(r);
      return r;
    } catch (e) {
      toast(e.details && e.details.length ? `${e.message}: ${e.details.slice(0, 3).join('; ')}` : e.message, 'err');
      return null;
    } finally { setBusy(false); }
  }, [toast]);
  return [act, busy];
}

export const ask = (label, def) => {
  const v = window.prompt(label, def === undefined ? '' : String(def));
  return v && v.trim() ? v.trim() : null;
};

// ---------- display ----------
export function Money({ v }) {
  const { lang } = useI18n();
  return <span className="num">{money(v, lang)}</span>;
}

const BASIS_CLASS = { actual: 'b-actual', estimated: 'b-est', forecast: 'b-fc', awaiting_approval: 'b-wait', approved: 'b-actual', pending_approval: 'b-wait', pending: 'b-wait' };
export function Basis({ kind }) {
  const { t } = useI18n();
  if (!kind) return null;
  return <span className={`basis ${BASIS_CLASS[kind] || 'b-est'}`} title={t('Amounts are accounting costs, not cash.')}>{t(kind.replace('pending_approval', 'awaiting_approval'))}</span>;
}

export function Badge({ tone = 'gray', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export const STATUS_TONE = {
  approved: 'green', closed: 'gray', received: 'green', actual: 'green', active: 'green', issued: 'green', open: 'blue', submitted: 'blue', requested: 'blue', draft: 'gray', planning: 'gray',
  pending: 'amber', pending_approval: 'amber', rejected: 'red', cancelled: 'red', reversed: 'red', on_hold: 'amber', completed: 'gray', delivered: 'blue',
  ok: 'green', near_budget: 'amber', over_budget: 'red', critical: 'red', warning: 'amber', info: 'blue',
};
export function Status({ s }) {
  const { t } = useI18n();
  const label = (s || '').replace(/_/g, ' ');
  return <Badge tone={STATUS_TONE[s] || 'gray'}>{t(label.charAt(0).toUpperCase() + label.slice(1))}</Badge>;
}

export function Bar({ pct, tone, label }) {
  const p = Math.max(0, Math.min(Number(pct) || 0, 100));
  return (
    <div className="bar" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={`bar-fill ${tone || ''}`} style={{ width: `${p}%` }} />
    </div>
  );
}

export function Stat({ label, value, basis, tone, sub }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{basis && <Basis kind={basis} />} {sub}</div>
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <header className="card-h"><h3>{title}</h3><div className="row gap">{actions}</div></header>}
      {children}
    </section>
  );
}

export function Table({ cols, rows, empty, rowKey = 'id' }) {
  const { t } = useI18n();
  if (!rows || !rows.length) return <p className="muted">{empty || t('Nothing here yet')}</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl stack">
        <thead><tr>{cols.map((c) => <th key={c.h} className={c.num ? 'r' : ''}>{t(c.h)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i}>
              {cols.map((c) => <td key={c.h} className={c.num ? 'r' : ''} data-label={t(c.h)}>{c.render ? c.render(r) : r[c.k]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

export function Loading({ state }) {
  const { t } = useI18n();
  if (state.loading && !state.data) return <p className="muted">{t('Loading')}…</p>;
  if (state.error) return <p className="err">{state.error}</p>;
  return null;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

/** Simple SVG grouped bar chart for the cash flow. */
export function CashChart({ rows }) {
  const { t } = useI18n();
  if (!rows || !rows.length) return null;
  const max = Math.max(1, ...rows.flatMap((r) => [r.cash_in, r.cash_out, r.accounting_cost]));
  const w = Math.max(rows.length * 90, 300); const h = 180; const pad = 24;
  const y = (v) => h - pad - (v / max) * (h - pad - 10);
  return (
    <div className="tbl-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={t('Cash flow')} style={{ maxWidth: '100%' }}>
        {rows.map((r, i) => {
          const x = 16 + i * 90;
          return (
            <g key={r.month}>
              <rect x={x} y={y(r.cash_in)} width="20" height={h - pad - y(r.cash_in)} className="c-in"><title>{`${r.month} ${t('Cash received')}: ${r.cash_in}`}</title></rect>
              <rect x={x + 24} y={y(r.cash_out)} width="20" height={h - pad - y(r.cash_out)} className="c-out"><title>{`${r.month} ${t('Cash paid')}: ${r.cash_out}`}</title></rect>
              <rect x={x + 48} y={y(r.accounting_cost)} width="20" height={h - pad - y(r.accounting_cost)} className="c-cost"><title>{`${r.month} ${t('Actual cost')}: ${r.accounting_cost}`}</title></rect>
              <text x={x + 34} y={h - 8} textAnchor="middle" className="axis">{r.month}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend"><i className="c-in" /> {t('Cash received')} <i className="c-out" /> {t('Cash paid')} <i className="c-cost" /> {t('Actual cost')}</div>
    </div>
  );
}

export const today = () => new Date().toISOString().slice(0, 10);
export const fmtPct = (n) => (n === null || n === undefined ? '-' : `${n}%`);
