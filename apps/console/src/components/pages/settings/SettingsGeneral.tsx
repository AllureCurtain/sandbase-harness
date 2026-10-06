import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, Play, RotateCw } from 'lucide-react';
import { postJson, putJson } from '../../../api';
import { pathName, workspaceConfigDir } from '../../../lib/format';
import { pendingRestartNote, providerSavedMessage, setupModelProvider } from '../../../lib/modelSetupGuidance';
import { KeyValuePanel } from '../../Common';
import { Kpi, KpiStrip, PageHeader } from '../../console-ui';
import { ConsoleSelect } from '../../console-select';
import { FormField } from '../../FormPrimitives';
import { SetupAgentModels } from './SetupAgentModels';
import type { ConsoleData, RuntimeSettings, RuntimeSettingsConfig, ViewId, Workspace } from '../../../types';

const MODEL_VENDORS: Array<RuntimeSettingsConfig['model']['vendor']> = ['openai', 'anthropic', 'minimax', 'openai_compatible'];

export function SettingsGeneral({
  data,
  setView,
  onRefresh,
}: {
  data: ConsoleData;
  setView: (view: ViewId) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');
  const workspaceLabel = data.workspace?.name && data.workspace.name !== 'managed-agents'
    ? data.workspace.name
    : t('general.workspaceDefault');
  const settings = data.settings;
  const savedModel = settings?.saved_config.model;
  const [vendor, setVendor] = useState<RuntimeSettingsConfig['model']['vendor']>(savedModel?.vendor ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(savedModel?.base_url ?? defaultModelBaseUrl(savedModel?.vendor));
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState(false);
  const baseUrlVendor = vendor === 'openai_compatible' || vendor === 'minimax';
  const provider = setupModelProvider(settings);
  const restartNote = pendingRestartNote(settings?.restart_required, settings?.activation_status, t);

  useEffect(() => {
    setVendor(savedModel?.vendor ?? 'openai');
    setBaseUrl(savedModel?.base_url ?? defaultModelBaseUrl(savedModel?.vendor));
    setApiKey('');
  }, [savedModel?.vendor, savedModel?.base_url, settings?.revision]);

  const apiKeyConfigured = settings?.secret_states.model.api_key === 'configured';
  const canSave = Boolean(settings) && !saving;

  async function saveModelProvider() {
    if (!settings) return;
    setSaving(true);
    setMessage(null);
    try {
      const trimmedKey = apiKey.trim();
      const nextConfig: RuntimeSettingsConfig = {
        ...settings.saved_config,
        model: {
          ...settings.saved_config.model,
          vendor,
          base_url: baseUrlVendor ? baseUrl.trim() || defaultModelBaseUrl(vendor) || undefined : undefined,
          api_key: trimmedKey || (apiKeyConfigured ? settings.saved_config.model.api_key : undefined),
        },
      };
      await putJson<RuntimeSettings>('/v1/x/settings', { revision: settings.revision, config: nextConfig });
      // Saving the provider is only half of setup: the model id lives on the
      // agent, and the saved provider is not the runtime's effective one until
      // the next start, so the Console has to point at both remaining steps
      // instead of reporting a finished setup.
      setMessage(providerSavedMessage(t));
      setProviderSaved(true);
      setApiKey('');
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('general.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function restartRuntime() {
    // Same gate as the other two callers of `/v1/x/restart`: the endpoint
    // interrupts active sessions, and this button is one click from the page a
    // new user lands on.
    if (!window.confirm(t('general.restartConfirm'))) return;
    setRestarting(true);
    setMessage(null);
    try {
      await postJson('/v1/x/restart', {});
      // The runtime is going down, so this page's data is deliberately left as it
      // is and the message asks for the reload, the same way the settings editors
      // handle their own restart: refetching now would race the restart.
      setMessage(t('general.restartScheduled'));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('general.restartFailed'));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <section className="stack">
      <PageHeader title={t('general.title')} description={t('general.description')} />
      <KpiStrip label={t('general.title')}>
        <Kpi label={t('general.kpis.workspace')} value={workspaceLabel} />
        <Kpi label={t('general.kpis.target')} value={data.workspace?.target ?? 'local'} />
        <Kpi label={t('general.kpis.runtime')} value={data.runtime?.status ?? 'starting'} />
        <Kpi label={t('general.kpis.auth')} value={data.runtime?.auth_enabled ? t('general.auth.enabled') : t('general.auth.disabled')} />
      </KpiStrip>
      <div className="builderSetupGrid">
        <div className="panel subtlePanel builderSetupPanel">
          <div className="builderSetupHeader">
            <span className="softIcon"><Bot size={18} /></span>
            <div>
              <h2>{t('general.provider.title')}</h2>
              <p>{t('general.provider.description')}</p>
            </div>
          </div>
          {settings ? (
            <form className="builderProviderForm" onSubmit={(event) => {
              event.preventDefault();
              void saveModelProvider();
            }}>
              <FormField label={t('general.provider.vendor')} description={t('general.provider.vendorHint')}>
                <ConsoleSelect
                  label={t('general.provider.vendor')}
                  value={vendor}
                  onChange={(value) => {
                    const nextVendor = value as RuntimeSettingsConfig['model']['vendor'];
                    setVendor(nextVendor);
                    setBaseUrl(defaultModelBaseUrl(nextVendor));
                  }}
                  options={MODEL_VENDORS.map((id) => ({ value: id, label: t(`general.provider.vendors.${id}`) }))}
                />
              </FormField>
              {baseUrlVendor ? (
                <FormField label={t('general.provider.baseUrl')} description={t('general.provider.baseUrlHint')}>
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
                </FormField>
              ) : null}
              <FormField
                label={t('general.provider.apiKey')}
                description={apiKeyConfigured ? t('general.provider.apiKeyHintConfigured') : t('general.provider.apiKeyHint')}
              >
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={apiKeyConfigured ? t('general.provider.apiKeyPlaceholderConfigured') : t('general.provider.apiKeyPlaceholder')}
                  type="password"
                  autoComplete="off"
                />
              </FormField>
              {message ? <div className="inlineStatus neutral">{message}</div> : null}
              {restartNote ? <div className="setupProviderWarning">{restartNote}</div> : null}
              <div className="formActions">
                <button className="primaryButton" type="submit" disabled={!canSave}>{saving ? t('general.provider.saving') : t('general.provider.save')}</button>
                {providerSaved || restartNote ? (
                  <button className="secondaryButton" type="button" onClick={() => void restartRuntime()} disabled={restarting}>
                    <RotateCw size={14} /> {restarting ? t('general.provider.restarting') : t('general.provider.restart')}
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="mutedText">{t('general.provider.loading')}</p>
          )}
        </div>
        <div className="stack">
          <div className="panel subtlePanel">
            <h2>{t('general.project.title')}</h2>
            <p>{t('general.project.description')}</p>
            <KeyValuePanel rows={[
              [t('general.project.workspace'), workspaceLabel],
              [t('general.project.rootFolder'), pathName(data.workspace?.root) || data.workspace?.name],
              [t('general.project.configFolder'), workspaceConfigDir(data.workspace)],
            ]} />
          </div>
          <div className="panel subtlePanel">
            <div className="builderSetupHeader compact">
              <span className="softIcon success"><CheckCircle2 size={18} /></span>
              <div>
                <h2>{t('general.defaults.title')}</h2>
                <p>{t('general.defaults.description')}</p>
              </div>
            </div>
            <KeyValuePanel rows={[
              [t('general.defaults.agentRuntime'), settings?.saved_config.loop_engine.provider ?? 'builtin'],
              [t('general.defaults.metadata'), metadataStorageLabel(settings, data.workspace)],
              [t('general.defaults.artifacts'), artifactStorageLabel(settings, data.workspace)],
              [t('general.defaults.memory'), memoryLabel(settings, data.runtime?.memory)],
              [t('general.defaults.sandbox'), settings?.saved_config.sandbox.provider ?? data.runtime?.sandbox_providers[0] ?? 'local'],
            ]} />
            <button className="secondaryButton fitButton" type="button" onClick={() => setView('advanced')}>{t('general.defaults.advancedLink')}</button>
          </div>
          <div className="panel subtlePanel">
            <div className="builderSetupHeader compact">
              <span className="softIcon"><Play size={18} /></span>
              <div>
                <h2>{t('general.nextStep.title')}</h2>
                <p>{t('general.nextStep.description')}</p>
              </div>
            </div>
            <div className="buttonRow">
              <button className="primaryButton" type="button" onClick={() => setView('agents')}>{t('general.nextStep.createAgent')}</button>
              <button className="secondaryButton" type="button" onClick={() => setView('sessions')}>{t('general.nextStep.startSession')}</button>
            </div>
          </div>
        </div>
        <SetupAgentModels
          data={data}
          provider={provider}
          emphasize={providerSaved}
          restartRequired={settings?.restart_required}
          onRefresh={onRefresh}
        />
      </div>
    </section>
  );
}

function runtimeDatabasePath(workspace: Workspace | null) {
  return workspace?.databasePath
    ?? workspace?.directories?.database
    ?? (workspace?.dataDir ? `${workspace.dataDir.replace(/\/$/, '')}/data.db` : undefined);
}

function defaultModelBaseUrl(vendor: RuntimeSettingsConfig['model']['vendor'] | undefined): string {
  if (vendor === 'minimax') return 'https://api.minimax.io/v1';
  return '';
}

function metadataStorageLabel(settings: RuntimeSettings | null, workspace: Workspace | null) {
  const provider = settings?.saved_config.storage.metadata.provider ?? 'sqlite';
  const path = runtimeDatabasePath(workspace) ?? settings?.diagnostics.metadata.path;
  return path ? `${provider} · ${pathName(path)}` : provider;
}

function artifactStorageLabel(settings: RuntimeSettings | null, workspace: Workspace | null) {
  const provider = settings?.saved_config.storage.artifacts.provider ?? 'local';
  const root = workspace?.directories?.data ?? workspace?.dataDir;
  return root ? `${provider} · ${pathName(root)}` : provider;
}

function memoryLabel(settings: RuntimeSettings | null, runtimeMemory?: string) {
  if (!settings) return runtimeMemory ?? 'sqlite';
  return settings.saved_config.memory.enabled ? settings.saved_config.memory.provider : 'off';
}
