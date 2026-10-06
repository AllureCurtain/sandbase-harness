import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { getText } from '../../../api';
import type { ConsoleData } from '../../../types';
import { KeyValuePanel } from '../../Common';
import { Kpi, KpiStrip, PageHeader } from '../../console-ui';

type ParsedMetrics = {
  disabled: boolean;
  httpRequests?: number;
  httpErrors?: number;
  httpRequestDurationCount?: number;
  httpRequestDurationSum: number;
};

export function SettingsMonitoring({ data }: { data: ConsoleData }) {
  const { t } = useTranslation('settings');
  const [metricsText, setMetricsText] = useState('');
  const [metricsError, setMetricsError] = useState('');

  useEffect(() => {
    let mounted = true;
    getText('/v1/x/metrics')
      .then((text) => {
        if (!mounted) return;
        setMetricsText(text);
        setMetricsError('');
      })
      .catch((error: Error) => {
        if (!mounted) return;
        setMetricsText('');
        setMetricsError(error.message);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const tokenTotal = data.sessions.reduce((sum, session) => sum + session.usage.input_tokens + session.usage.output_tokens, 0);
  const metrics = parsePrometheusMetrics(metricsText);
  const averageRequestMs = metrics.httpRequestDurationCount
    ? Math.round(metrics.httpRequestDurationSum / metrics.httpRequestDurationCount)
    : null;
  const metricsStatus = metricsError || (metricsText ? (metrics.disabled ? t('monitoring.disabled') : t('monitoring.enabled')) : t('monitoring.loading'));
  const requestCount = metrics.disabled ? t('monitoring.disabled') : (metrics.httpRequests ?? 0);
  const errorCount = metrics.disabled ? t('monitoring.disabled') : (metrics.httpErrors ?? 0);
  const requestSamples = metrics.disabled ? t('monitoring.disabled') : (metrics.httpRequestDurationCount ?? 0);
  const averageDuration = metrics.disabled ? t('monitoring.disabled') : (averageRequestMs === null ? t('monitoring.noSamples') : `${averageRequestMs} ms`);

  return (
    <section className="stack">
      <PageHeader title={t('monitoring.title')} description={t('monitoring.description')} />
      <KpiStrip label={t('monitoring.title')}>
        <Kpi label={t('monitoring.kpis.sessions')} value={data.sessions.length} />
        <Kpi label={t('monitoring.kpis.running')} value={data.sessions.filter((session) => session.status === 'running').length} />
        <Kpi label={t('monitoring.kpis.httpRequests')} value={requestCount} />
        <Kpi label={t('monitoring.kpis.httpErrors')} value={errorCount} />
      </KpiStrip>
      <div className="workspaceGrid">
        <div className="panel subtlePanel">
          <h2>{t('monitoring.metricsPanel.title')}</h2>
          <p><Trans i18nKey="monitoring.metricsPanel.description" ns="settings" components={{ code: <code /> }} /></p>
          <KeyValuePanel rows={[
            [t('monitoring.metricsPanel.status'), metricsStatus],
            [t('monitoring.metricsPanel.samples'), requestSamples],
            [t('monitoring.metricsPanel.avgDuration'), averageDuration],
            [t('monitoring.metricsPanel.sessionTokens'), tokenTotal],
          ]} />
        </div>
        <div className="panel subtlePanel">
          <h2>{t('monitoring.prometheus.title')}</h2>
          <p>{t('monitoring.prometheus.description')}</p>
          <pre className="metricsPreview">{metricsError || metricsText || t('monitoring.metricsPlaceholder')}</pre>
        </div>
      </div>
    </section>
  );
}

function parsePrometheusMetrics(text: string): ParsedMetrics {
  const disabled = text.trim() === '# metrics disabled';
  return {
    disabled,
    httpRequests: readPrometheusMetric(text, 'http_requests_total'),
    httpErrors: readPrometheusMetric(text, 'http_errors_total'),
    httpRequestDurationCount: readPrometheusMetric(text, 'http_request_duration_ms_count'),
    httpRequestDurationSum: readPrometheusMetric(text, 'http_request_duration_ms_sum') ?? 0,
  };
}

function readPrometheusMetric(text: string, name: string): number | undefined {
  const line = text.split('\n').find((item) => item.startsWith(`${name} `));
  if (!line) return undefined;
  const value = Number(line.split(/\s+/)[1]);
  return Number.isFinite(value) ? value : undefined;
}
