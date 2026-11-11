import { api } from '../api';
import { useI18n } from '../i18n';
import { Bar, Basis, Badge, Card, Loading, Money, Stat, Status, Table, useLoad } from '../ui';
import { go } from '../nav';

export default function Dashboard() {
  const { t } = useI18n();
  const d = useLoad(() => api.get('/dashboard'));
  const alerts = useLoad(() => api.get('/alerts'));
  if (!d.data) return <Loading state={d} />;
  const { totals: x, projects, show_money: money } = d.data;

  return (
    <>
      <div className="row between wrap gap" style={{ marginBottom: 12 }}>
        <h2>{t('Dashboard')}</h2>
        <span className="muted">{d.data.date}</span>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label={t('Active projects')} value={x.active} sub={`/ ${x.projects}`} />
        <Stat label={t('Delayed projects')} value={x.delayed} tone={x.delayed ? 'red' : 'green'} />
        <Stat label={t('Material shortages')} value={x.material_shortages} tone={x.material_shortages ? 'amber' : 'green'} />
        {money && <Stat label={t('Over budget')} value={x.over_budget} tone={x.over_budget ? 'red' : 'green'} basis="forecast" />}
        {money && <Stat label={t('Contract value')} value={<Money v={x.contract_value} />} />}
        {money && <Stat label={t('Actual cost')} value={<Money v={x.actual_cost} />} basis="actual" />}
        {money && <Stat label={t('Forecast final cost')} value={<Money v={x.forecast_final_cost} />} basis="forecast" />}
        {money && <Stat label={t('Forecast profit')} value={<Money v={x.forecast_profit} />} basis="forecast" tone={x.forecast_profit < 0 ? 'red' : 'green'} />}
        {money && <Stat label={t('Cash received')} value={<Money v={x.cash_received} />} basis="actual" sub={`${t('Receivable')}: ${Math.round(x.receivable).toLocaleString()}`} />}
        {money && <Stat label={t('Cash paid')} value={<Money v={x.cash_paid} />} basis="actual" />}
      </div>

      <Card title={t('Projects')}>
        <div className="tbl-wrap">
          <table className="tbl stack">
            <thead><tr>
              <th>{t('Project')}</th><th>{t('Progress')}</th>
              {money && <><th>{t('Budget used')}</th><th className="r">{t('Forecast final cost')}</th><th className="r">{t('Forecast profit')}</th></>}
              <th>{t('Forecast end')}</th><th>{t('Alerts')}</th>
            </tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="proj" onClick={() => go(`/p/${p.id}/overview`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go(`/p/${p.id}/overview`)}>
                  <td data-label={t('Project')}><strong>{p.code}</strong> {p.name}<div className="muted">{p.client_name}</div><Status s={p.status} /></td>
                  <td data-label={t('Progress')} style={{ minWidth: 120 }}>{p.progress_pct}%<Bar pct={p.progress_pct} label={t('Progress')} /></td>
                  {money && <>
                    <td data-label={t('Budget used')} style={{ minWidth: 120 }}>{p.budget_consumption_pct}%<Bar pct={p.budget_consumption_pct} tone={p.budget_consumption_pct >= 100 ? 'red' : p.budget_consumption_pct >= 90 ? 'amber' : ''} label={t('Budget used')} /></td>
                    <td data-label={t('Forecast final cost')} className="r"><Money v={p.forecast_final_cost} /> <Basis kind="forecast" />{p.over_budget && <div><Badge tone="red">{t('Over budget')}</Badge></div>}</td>
                    <td data-label={t('Forecast profit')} className="r" style={{ color: p.forecast_profit < 0 ? 'var(--red)' : undefined }}><Money v={p.forecast_profit} /><div className="muted">{p.forecast_margin_pct}%</div></td>
                  </>}
                  <td data-label={t('Forecast end')}>{p.forecast_end || '-'}<div className="muted">{t('Planned end')}: {p.end_date}</div>{p.delayed && <Badge tone="red">{p.delay_days} {t('Delay (days)')}</Badge>}</td>
                  <td data-label={t('Alerts')}>
                    {p.alerts.critical ? <Badge tone="red">{p.alerts.critical}</Badge> : null} {p.alerts.warning ? <Badge tone="amber">{p.alerts.warning}</Badge> : null}
                    {p.material_shortages ? <div className="muted">{t('Shortage')}: {p.material_shortages}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!projects.length && <p className="muted">{t('Nothing here yet')}</p>}
      </Card>

      <Card title={t('Alerts')}>
        {alerts.data && !alerts.data.length && <p className="muted">{t('No alerts')}</p>}
        {(alerts.data || []).slice(0, 30).map((a) => (
          <div key={a.id} className={`alert ${a.severity}`}><strong>{a.project_code}</strong><span>{a.message}</span></div>
        ))}
      </Card>
      {money && <p className="muted" style={{ fontSize: 12 }}>{t('Profit is calculated from costs, never from cash received.')}</p>}
    </>
  );
}
