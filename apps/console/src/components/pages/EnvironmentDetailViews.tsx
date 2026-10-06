import { TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Kpi, KpiStrip } from '../console-ui';
import { formatDateShort, relativeDate, shortId } from '../../lib/format';
import type { Environment, Session } from '../../types';
import {
  declaredHostingType,
  effectiveSandboxProvider,
  environmentKeys,
  environmentHostingType,
  environmentMetadataEntries,
} from './EnvironmentPageModel';

export function CloudEnvironment({ environment }: { environment: Environment }) {
  const { t } = useTranslation('environments');
  const metadata = environmentMetadataEntries(environment);
  const executionType = environmentHostingType(environment);
  const effectiveProvider = effectiveSandboxProvider(environment);
  const resources = environment.config.resources && typeof environment.config.resources === 'object' && !Array.isArray(environment.config.resources)
    ? environment.config.resources as Record<string, unknown>
    : {};
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>{t('detail.execution.title')}</h2>
        <p>{t('detail.execution.readonlyHint')}</p>
        {effectiveProvider === 'local' ? (
          <div className="warningNotice" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>{t('detail.execution.readonlyWarning')}</span>
          </div>
        ) : null}
        <div className="readonlyFields">
          <ReadonlyField label={t('detail.execution.fields.hostingType')} value={t(`kind.${declaredHostingType(environment)}`)} />
          <ReadonlyField label={t('detail.execution.fields.effectiveBackend')} value={effectiveProvider} />
          {executionType === 'docker' ? <ReadonlyField label={t('detail.execution.fields.dockerImage')} value={String(environment.config.image ?? 'node:22-slim')} /> : null}
          {executionType === 'docker' && resources.memory ? <ReadonlyField label={t('detail.execution.fields.memoryLimit')} value={String(resources.memory)} /> : null}
          {executionType === 'docker' && resources.cpu ? <ReadonlyField label={t('detail.execution.fields.cpuLimit')} value={String(resources.cpu)} /> : null}
        </div>
      </section>
      <section className="environmentSection">
        <h2>{t('detail.metadata.title')}</h2>
        <p>{t('detail.metadata.hint')}</p>
        <ReadonlyTable
          empty={t('detail.metadata.empty')}
          rows={metadata}
          columns={[t('detail.metadata.keyColumn'), t('detail.metadata.valueColumn')]}
        />
      </section>
    </div>
  );
}

export function SelfHostedEnvironment({ environment, sessions }: { environment: Environment; sessions: Session[] }) {
  const { t } = useTranslation('environments');
  const keys = environmentKeys(environment);
  const idleSessions = sessions.filter((session) => session.status === 'idle');
  const runningSessions = sessions.filter((session) => session.status === 'running');
  const completedSessions = sessions.filter((session) => session.status === 'terminated');
  const oldestActiveSession = [...idleSessions, ...runningSessions].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>{t('detail.selfHosted.overviewTitle')}</h2>
        <p>{t('detail.selfHosted.overviewHint')}</p>
        <KpiStrip label={t('detail.selfHosted.overviewTitle')}>
          <Kpi label={t('detail.selfHosted.idle')} value={idleSessions.length} />
          <Kpi label={t('detail.selfHosted.running')} value={runningSessions.length} />
          <Kpi label={t('detail.selfHosted.completed')} value={completedSessions.length} />
          <Kpi label={t('detail.selfHosted.oldestActive')} value={oldestActiveSession ? relativeDate(oldestActiveSession.created_at) : t('detail.selfHosted.none')} />
        </KpiStrip>
      </section>
      <div className="selfHostedGrid">
        <section className="environmentSection">
          <h2>{t('detail.selfHosted.keysTitle')}</h2>
          <p>{t('detail.selfHosted.keysHint')}</p>
          <ReadonlyTable
            empty={t('detail.selfHosted.keysEmpty')}
            rows={keys.map((key) => [key.name, shortId(key.id), formatDateShort(key.created_at), formatDateShort(key.expires_at)])}
            columns={[t('detail.selfHosted.columns.name'), t('detail.selfHosted.columns.id'), t('detail.selfHosted.columns.created'), t('detail.selfHosted.columns.expires')]}
          />
        </section>
        <section className="setupCard">
          <div className="setupHeader">
            <h2>{t('detail.selfHosted.setupTitle')}</h2>
            <button className="iconButton quiet" type="button" title={t('detail.selfHosted.dismiss')}><X size={18} /></button>
          </div>
          <p>{t('detail.selfHosted.setupHint')}</p>
          <SetupStep index={1} title={t('detail.selfHosted.step1Title')} body={t('detail.selfHosted.step1Body')} />
          <SetupStep index={2} title={t('detail.selfHosted.step2Title')} body={t('detail.selfHosted.step2Body')} code={`export MANAGED_AGENTS_ENVIRONMENT_KEY='env-key-...'`} />
          <SetupStep index={3} title={t('detail.selfHosted.step3Title')} body={t('detail.selfHosted.step3Body')} code={`npm install -g managed-agents`} />
          <SetupStep index={4} title={t('detail.selfHosted.step4Title')} body={t('detail.selfHosted.step4Body')} code={`managed-agents worker poll \\\n  --environment-id "${environment.id}" \\\n  --workdir "/workspace"`} />
        </section>
      </div>
    </div>
  );
}

export function ReadonlyTable({ columns, rows, empty }: { columns: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="readonlyTable">
      {rows.length === 0 ? <div className="emptyValue">{empty}</div> : (
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.join('-')}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReadonlyField({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`readonlyField ${wide ? 'wide' : ''}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function SetupStep({ index, title, body, code }: { index: number; title: string; body: string; code?: string }) {
  return (
    <div className="setupStep">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {code ? <pre>{code}</pre> : null}
      </div>
    </div>
  );
}
