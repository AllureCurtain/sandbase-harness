import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPage, postJson } from '../../../api';
import { Kpi, KpiStrip, PageHeader } from '../../console-ui';
import { ConsoleSelect } from '../../console-select';
import { pathName } from '../../../lib/format';
import type { ConsoleData, RuntimeLogEntry, RuntimeLogLevel } from '../../../types';

const LOG_LEVELS: Array<RuntimeLogLevel | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];

export function SettingsLogs({ data }: { data: ConsoleData }) {
  const { t } = useTranslation('settings');
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [logLevel, setLogLevel] = useState<RuntimeLogLevel | 'all'>('all');
  const [restartStatus, setRestartStatus] = useState('');
  const [restarting, setRestarting] = useState(false);

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (logLevel !== 'all') params.set('level', logLevel);
      const page = await getPage<RuntimeLogEntry>(`/v1/x/logs?${params.toString()}`);
      setLogs(page.data);
      setLogsError('');
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
    const timer = window.setInterval(() => void loadLogs(), 5000);
    return () => window.clearInterval(timer);
  }, [logLevel]);

  const restartRuntime = async () => {
    if (!window.confirm(t('logs.restartConfirm'))) return;
    setRestarting(true);
    setRestartStatus(t('logs.restarting'));
    try {
      await postJson<{ restarting: boolean; status: string }>('/v1/x/restart', {});
      setRestartStatus(t('logs.restartScheduled'));
    } catch (err) {
      setRestartStatus(err instanceof Error ? err.message : String(err));
      setRestarting(false);
    }
  };

  return (
    <section className="stack settingsLogsPage">
      <PageHeader
        title={t('logs.title')}
        description={t('logs.description')}
        actions={(
          <>
            <button className="secondaryButton" type="button" onClick={() => void loadLogs()} disabled={logsLoading}>
              <RefreshCw size={16} />
              {t('logs.refreshLogs')}
            </button>
            <button className="primaryButton" type="button" onClick={() => void restartRuntime()} disabled={restarting}>
              <RefreshCw size={16} />
              {t('logs.restartRuntime')}
            </button>
          </>
        )}
      />
      <KpiStrip label={t('logs.title')}>
        <Kpi label={t('logs.kpis.runtime')} value={data.runtime?.status ?? 'starting'} />
        <Kpi label={t('logs.kpis.logLines')} value={logs.length} />
        <Kpi label={t('logs.kpis.errors')} value={logs.filter((entry) => entry.level === 'error').length} />
        <Kpi label={t('logs.kpis.dataDir')} value={pathName(data.workspace?.dataDir) || t('logs.dataDirFallback')} />
      </KpiStrip>
      <div className="sectionHeaderRow">
        <div>
          <h2>{t('logs.section.title')}</h2>
          <p>{t('logs.section.description')}</p>
        </div>
        <div className="toolbarActions">
          <ConsoleSelect
            label={t('logs.levelLabel')}
            value={logLevel}
            onChange={(value) => setLogLevel(value as RuntimeLogLevel | 'all')}
            options={LOG_LEVELS.map((level) => ({ value: level, label: t(`logs.levels.${level}`) }))}
          />
          <button className="iconButton" type="button" title={t('logs.refreshLogs')} aria-label={t('logs.refreshLogs')} onClick={() => void loadLogs()} disabled={logsLoading}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="runtimeLogPanel">
        {restartStatus ? <div className="runtimeStatus">{restartStatus}</div> : null}
        {logsError ? <div className="runtimeStatus error">{logsError}</div> : null}
        {logs.length === 0 ? (
          <div className="emptyValue">{logsLoading ? t('logs.loading') : t('logs.empty')}</div>
        ) : (
          <div className="runtimeLogList" role="log" aria-live="polite">
            {logs.map((entry, index) => (
              <div className={`runtimeLogLine ${entry.level}`} key={`${entry.time}-${index}`}>
                <span className="runtimeLogMeta">{formatRuntimeLogTime(entry.time)} {entry.level.toUpperCase()}</span>
                <span className="runtimeLogMessage">{formatRuntimeLog(entry)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function formatRuntimeLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRuntimeLog(entry: RuntimeLogEntry) {
  const extras = Object.entries(entry)
    .filter(([key]) => !['level', 'time', 'msg', 'line'].includes(key))
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatRuntimeLogValue(value)}`);
  return extras.length > 0 ? `${entry.msg} ${extras.join(' ')}` : entry.msg;
}

function formatRuntimeLogValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
