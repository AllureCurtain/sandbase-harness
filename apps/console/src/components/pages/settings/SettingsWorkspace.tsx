import { Box, Copy, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyText, pathName, relativeWorkspacePath, workspaceConfigDir } from '../../../lib/format';
import type { ConsoleData, Workspace } from '../../../types';
import { KeyValuePanel } from '../../Common';
import { Kpi, KpiStrip, PageHeader } from '../../console-ui';

export function WorkspacePathsPanel({ workspace }: { workspace: Workspace | null }) {
  const { t } = useTranslation('settings');
  const configDir = workspaceConfigDir(workspace);
  const directoryRows = [
    { label: t('workspace.paths.agentsDir'), path: workspace?.directories?.agents ?? workspace?.agentsDir, defaultLabel: 'agents/', kind: 'directory' as const },
    { label: t('workspace.paths.skillsDir'), path: workspace?.directories?.skills ?? workspace?.skillsDir, defaultLabel: 'skills/', kind: 'directory' as const },
    { label: t('workspace.paths.stateDir'), path: workspace?.directories?.data ?? workspace?.dataDir, defaultLabel: '.managed-agents/', kind: 'directory' as const },
    { label: t('workspace.paths.configFile'), path: workspace?.directories?.config ?? workspace?.configPath, defaultLabel: '.managed-agents/config.yaml', kind: 'file' as const },
    { label: t('workspace.paths.database'), path: workspace?.directories?.database ?? workspace?.databasePath, defaultLabel: '.managed-agents/data.db', kind: 'file' as const },
    { label: t('workspace.paths.runtimeLog'), path: workspace?.directories?.logFile ?? workspace?.logFile, defaultLabel: '.managed-agents/logs/runtime.log', kind: 'file' as const },
  ];

  return (
    <div className="configFolderPanel">
      <div className="configFolderHeader">
        <div className="configFolderIcon"><Box size={20} /></div>
        <div>
          <span>{t('workspace.paths.configFolder')}</span>
          <strong title={configDir}>{pathName(configDir) || workspace?.name || t('workspace.paths.workspaceFallback')}</strong>
        </div>
        {configDir ? (
          <button className="iconButton quiet" type="button" title={t('workspace.paths.copyPath')} aria-label={t('workspace.paths.copyPath')} onClick={() => copyText(configDir)}>
            <Copy size={16} />
          </button>
        ) : null}
      </div>
      <div className="configPathList">
        {directoryRows.map((row) => (
          <div className="configPathRow" key={row.label} title={row.path ?? undefined}>
            <span>{row.label}</span>
            <strong>{relativeWorkspacePath(row.path, configDir, row.kind) ?? row.defaultLabel}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsWorkspace({ data }: { data: ConsoleData }) {
  const { t } = useTranslation('settings');
  return (
    <section className="stack">
      <PageHeader title={t('workspace.title')} description={t('workspace.description')} />
      <div className="workspaceNotice">
        <Info size={18} />
        <div>
          <strong>{t('workspace.notice.title')}</strong>
          <span>{t('workspace.notice.body')}</span>
        </div>
      </div>
      <KpiStrip label={t('workspace.title')}>
        <Kpi label={t('workspace.kpis.target')} value={data.workspace?.target ?? 'local'} />
        <Kpi label={t('workspace.kpis.agents')} value={data.agents.length} />
        <Kpi label={t('workspace.kpis.skills')} value={data.skills.length} />
        <Kpi label={t('workspace.kpis.memoryStores')} value={data.memoryStores.length} />
      </KpiStrip>
      <div className="workspaceGrid">
        <div className="panel subtlePanel">
          <h2>{t('workspace.current.title')}</h2>
          <p>{data.workspace?.name ?? t('workspace.current.fallbackName')}</p>
          <KeyValuePanel rows={[
            [t('workspace.current.target'), data.workspace?.target],
            [t('workspace.current.mode'), data.runtime ? t('workspace.current.modeConnected') : t('workspace.current.modeStarting')],
            [t('workspace.current.rootFolder'), pathName(data.workspace?.root) || data.workspace?.name],
          ]} />
        </div>
        <div className="panel subtlePanel">
          <h2>{t('workspace.config.title')}</h2>
          <p>{t('workspace.config.description')}</p>
          <WorkspacePathsPanel workspace={data.workspace} />
        </div>
      </div>
    </section>
  );
}
