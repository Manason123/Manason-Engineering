import { api } from '../api';
import { useI18n } from '../i18n';
import { Bar, Basis, Badge, Card, CashChart, Loading, Money, Stat, Status, Table, useLoad } from '../ui';

export default function Overview({ project }) {
  const { t } = useI18n();
  const d = useLoad(() => api.get(`/projects/${project.id}/dashboard`), [project.id]);
  if (!d.data) return <Loading state={d} />;
  const x = d.data;
  const m = x.show_money;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label={t('Progress')} value={`${x.progress_pct}%`} sub={<Bar pct={x.progress_pct} label={t('Progress')} />} />
        <Stat label={t('Forecast end')} value={x.schedule.forecast_end || '-'} basis="forecast" tone={x.schedule.delay_days >= 3 ? 'red' : 'green'} sub={`${t('Planned end')}: ${x.schedule.planned_end} · ${x.schedule.delay_days} ${t('Delay (days)')}`} />
        {m && <Stat label={t('Contract value')} value={<Money v={x.profit.contract_value} />} />}
        {m && <Stat label={t('Original budget')} value={<Money v={x.budget.original} />} basis="actual" />}
        {m && <Stat label={t('Approved variations')} value={<Money v={x.budget.approved_variations} />} basis="actual" sub={x.budget.pending_variations ? <span>{t('Pending variations')}: <Money v={x.budget.pending_variations} /> <Basis kind="awaiting_approval" /></span> : null} />}
        {m && <Stat label={t('Revised budget')} value={<Money v={x.budget.revised} />} />}
        {m && <Stat label={t('Actual cost')} value={<Money v={x.costs.actual} />} basis="actual" sub={`${t('Budget used')}: ${x.costs.consumption_pct}%`} tone={x.costs.consumption_pct >= 100 ? 'red' : x.costs.consumption_pct >= x.thresholds.cost_warning_pct ? 'amber' : ''} />}
        {m && <Stat label={t('Committed cost')} value={<Money v={x.costs.committed} />} basis="estimated" />}
        {m && <Stat label={t('Remaining budget')} value={<Money v={x.costs.remaining_budget} />} sub="= budget − actual − committed" tone={x.costs.remaining_budget < 0 ? 'red' : ''} />}
        {m && <Stat label={t('Forecast final cost')} value={<Money v={x.costs.forecast_final_cost} />} basis="forecast" />}
        {m && <Stat label={t('Forecast profit')} value={<Money v={x.profit.forecast_profit} />} basis="forecast" tone={x.profit.forecast_profit < 0 ? 'red' : 'green'} sub={`${t('Forecast margin')}: ${x.profit.forecast_margin_pct}%`} />}
        {m && <Stat label={t('Cash received')} value={<Money v={x.cash.received} />} basis="actual" sub={`${t('Receivable')}: ${Math.round(x.cash.receivable).toLocaleString()}`} />}
        {m && <Stat label={t('Cash paid')} value={<Money v={x.cash.paid} />} basis="actual" sub={`${t('Net cash')}: ${Math.round(x.cash.net).toLocaleString()}`} />}
      </div>
      {m && <p className="note">{t('Profit is calculated from costs, never from cash received.')} {t('Original and approved budget are kept separate.')}</p>}

      <Card title={t('Alerts')}>
        {!x.alerts.length && <p className="muted">{t('No alerts')}</p>}
        {x.alerts.map((a) => <div key={a.id} className={`alert ${a.severity}`}>{a.message}</div>)}
      </Card>

      <Card title={t('Activities')}>
        <div className="tbl-wrap">
          <table className="tbl stack">
            <thead><tr>
              <th>{t('Activity')}</th><th>{t('Progress')}</th>
              {m && <><th className="r">{t('Revised budget')}</th><th className="r">{t('Actual cost')}</th><th className="r">{t('Forecast final cost')}</th></>}
              <th>{t('Forecast end')}</th>
            </tr></thead>
            <tbody>
              {x.activities.map((a) => (
                <tr key={a.id}>
                  <td data-label={t('Activity')}><strong>{a.code}</strong> {a.name}<div className="muted">{a.done_qty}/{a.planned_qty} {a.unit}</div>{a.cost_flag && a.cost_flag !== 'ok' && <Status s={a.cost_flag} />}</td>
                  <td data-label={t('Progress')} style={{ minWidth: 110 }}>{a.progress_pct}%<Bar pct={a.progress_pct} label={t('Progress')} /></td>
                  {m && <>
                    <td data-label={t('Revised budget')} className="r"><Money v={a.revised_budget} />{a.approved_variations ? <div className="muted">({t('Original budget')}: <Money v={a.original_budget} />)</div> : null}</td>
                    <td data-label={t('Actual cost')} className="r"><Money v={a.actual_cost} />{a.committed_cost ? <div className="muted">+ <Money v={a.committed_cost} /> <Basis kind="estimated" /></div> : null}</td>
                    <td data-label={t('Forecast final cost')} className="r"><Money v={a.forecast_final_cost} /></td>
                  </>}
                  <td data-label={t('Forecast end')}>{a.schedule.finish}{a.schedule.delay_days > 0 && <div><Badge tone="red">+{a.schedule.delay_days}d</Badge></div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('Material shortages')}>
        <Table rows={x.shortages.filter((s) => s.short)} empty={t('No alerts')} rowKey="material_id" cols={[
          { h: 'Materials', render: (s) => s.name }, { h: 'Required', num: true, render: (s) => `${s.required} ${s.unit}` },
          { h: 'Store', num: true, k: 'store' }, { h: 'Site', num: true, k: 'site' }, { h: 'On order', num: true, k: 'on_order' },
          { h: 'Shortage', num: true, render: (s) => <strong className="err">{s.shortage} {s.unit}</strong> },
        ]} />
        <p className="muted" style={{ fontSize: 12 }}>Required = remaining quantity × approved material rate per unit (technical specification).</p>
      </Card>

      {m && x.cashflow && x.cashflow.length > 0 && <Card title={t('Cash flow')}><CashChart rows={x.cashflow} /><p className="muted" style={{ fontSize: 12 }}>{t('Amounts are accounting costs, not cash.')}</p></Card>}
    </>
  );
}
