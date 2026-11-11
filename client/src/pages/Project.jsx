import { api, download } from '../api';
import { useI18n } from '../i18n';
import { go, can } from '../nav';
import { Badge, Loading, Status, Tabs, useAct, useLoad } from '../ui';
import Overview from './Overview';
import Baseline from './Baseline';
import Reports from './Reports';
import Materials from './Materials';
import Finance from './Finance';
import { Schedule, Variations } from './Schedule';
import { Documents, AuditLog } from './Docs';

export default function ProjectPage({ id, tab, user }) {
  const { t } = useI18n();
  const p = useLoad(() => api.get(`/projects/${id}`), [id]);
  const [act] = useAct();
  if (!p.data) return <Loading state={p} />;
  const project = p.data;
  const money = can(user, 'finance.view');

  const tabs = [['overview', t('Overview')], ['baseline', t('Baseline')], ['reports', t('Daily reports')], ['materials', t('Materials')]];
  if (money) tabs.push(['finance', t('Finance')]);
  tabs.push(['schedule', t('Schedule')], ['variations', t('Variations')], ['documents', t('Documents')]);
  if (money) tabs.push(['audit', t('Audit')]);

  const props = { project, user, reloadProject: p.reload };
  const body = {
    overview: <Overview {...props} />, baseline: <Baseline {...props} />, reports: <Reports {...props} />, materials: <Materials {...props} />,
    finance: money && <Finance {...props} />, schedule: <Schedule {...props} />, variations: <Variations {...props} />, documents: <Documents {...props} />,
    audit: money && <AuditLog {...props} />,
  }[tab] || <Overview {...props} />;

  return (
    <>
      <div className="row between wrap gap" style={{ marginBottom: 10 }}>
        <div>
          <button className="btn alt small" onClick={() => go('/')}>← {t('Dashboard')}</button>
          <h2 style={{ marginTop: 8 }}>{project.code} · {project.name}</h2>
          <div className="muted">{project.client_name} {project.location ? `· ${project.location}` : ''} <Status s={project.status} /> {!project.baseline_approved && <Badge tone="amber">{t('Baseline')}: {t('Draft')}</Badge>}</div>
        </div>
        {money && (
          <div className="row gap wrap">
            <button className="btn alt small" onClick={() => act(() => download(`/projects/${project.id}/export/excel`, 'report.xlsx'))}>{t('Export Excel')}</button>
            <button className="btn alt small" onClick={() => act(() => download(`/projects/${project.id}/export/pdf`, 'report.pdf'))}>{t('Export PDF')}</button>
          </div>
        )}
      </div>
      <Tabs tabs={tabs} value={tabs.some(([k]) => k === tab) ? tab : 'overview'} onChange={(k) => go(`/p/${project.id}/${k}`)} />
      {body}
    </>
  );
}
