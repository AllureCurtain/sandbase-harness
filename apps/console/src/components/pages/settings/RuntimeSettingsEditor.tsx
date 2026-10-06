import { MoreVertical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { postJson, putJson } from '../../../api';
import { JsonCodeEditor } from '../../CodeEditor';
import { LoadingState } from '../../Common';
import { ActionNotice, FormActions, InlineStatus } from '../../FormPrimitives';
import { SegmentedControl } from '../../console-ui';
import type { ConsoleData, RuntimeSettingsConfig } from '../../../types';
import {
  LoopEngineSettingsForm,
  MemorySettingsForm,
  ModelSettingsForm,
  SandboxSettingsForm,
  StorageSettingsForm,
} from './RuntimeSettingsForms';
import {
  applyRuntimeSettingsDefaults,
  configKeyForSection,
  isSettingsPathInSection,
  mergeRuntimeSettingsSectionJson,
  preserveCandidateSecrets,
  runtimeSettingsSectionJson,
  stableSettingsJson,
  testAreaForSection,
  type RuntimeSettingsSection,
} from './RuntimeSettingsEditorState';

export {
  applyRuntimeSettingsDefaults,
  mergeRuntimeSettingsSectionJson,
  preserveCandidateSecrets,
  runtimeSettingsSectionJson,
} from './RuntimeSettingsEditorState';

export function RuntimeSettingsEditor({
  data,
  section,
  onRefresh,
}: {
  data: ConsoleData;
  section: RuntimeSettingsSection;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');
  const settings = data.settings;
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [draft, setDraft] = useState<RuntimeSettingsConfig | null>(
    settings ? applyRuntimeSettingsDefaults(settings.saved_config, settings.adapters) : null,
  );
  const [json, setJson] = useState(
    settings ? runtimeSettingsSectionJson(applyRuntimeSettingsDefaults(settings.saved_config, settings.adapters), section) : '',
  );
  const [error, setError] = useState('');
  // Message tone is tracked separately from the text: the displayed copy is
  // localized, so prefix matching against it is not reliable.
  const [positive, setPositive] = useState(false);
  const [canRestart, setCanRestart] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [validationState, setValidationState] = useState<'unknown' | 'valid' | 'invalid'>('unknown');
  const [validatedJson, setValidatedJson] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [formResetKey, setFormResetKey] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);

  useEffect(() => {
    const hydrated = settings ? applyRuntimeSettingsDefaults(settings.saved_config, settings.adapters) : null;
    setDraft(hydrated);
    setJson(hydrated ? runtimeSettingsSectionJson(hydrated, section) : '');
    setError('');
    setPositive(false);
    setCanRestart(false);
    setValidationState('unknown');
    setValidatedJson('');
    setValidationErrors({});
    setFormResetKey((key) => key + 1);
  }, [settings?.revision, section]);

  if (!settings || !draft) return <LoadingState label={t('editor.loading')} />;

  const savedConfig = applyRuntimeSettingsDefaults(settings.saved_config, settings.adapters);
  const savedJson = runtimeSettingsSectionJson(savedConfig, section);
  const savedFingerprint = stableSettingsJson(savedConfig);
  const currentJsonCandidate = mode === 'json' ? mergeRuntimeSettingsSectionJson(draft, section, json) : draft;
  const currentJson = mode === 'json' ? json : runtimeSettingsSectionJson(draft, section);
  const currentFingerprint = currentJsonCandidate ? stableSettingsJson(currentJsonCandidate) : null;
  const isDirty = currentFingerprint ? currentFingerprint !== savedFingerprint : currentJson !== savedJson;
  const sectionActivationErrors = settings.activation_status === 'failed'
    ? settings.activation_errors.filter((item) => isSettingsPathInSection(item.path || 'config', section))
    : [];
  const activationErrorCount = sectionActivationErrors.length;
  const visibleErrors = {
    ...Object.fromEntries(sectionActivationErrors.map((item) => [item.path || 'config', item.message])),
    ...validationErrors,
  };
  const setConfig = (next: RuntimeSettingsConfig, validation: 'unknown' | 'valid' = 'unknown') => {
    const hydrated = applyRuntimeSettingsDefaults(next, settings.adapters);
    setDraft(hydrated);
    setJson(runtimeSettingsSectionJson(hydrated, section));
    setValidationState(validation);
    setValidatedJson(validation === 'valid' ? stableSettingsJson(hydrated) : '');
    if (validation === 'unknown') setValidationErrors({});
  };
  const adapters = section === 'models' ? settings.adapters.model
    : section === 'loop-engine' ? settings.adapters.loop_engine
      : section === 'memory' ? settings.adapters.memory
        : section === 'sandbox' ? settings.adapters.sandbox
          : [];
  const title = t(`editor.sections.${section}.title`);
  const subtitle = t(`editor.sections.${section}.subtitle`);

  const fail = (message: string) => {
    setError(message);
    setPositive(false);
    setCanRestart(false);
  };

  const validate = async (): Promise<RuntimeSettingsConfig | null> => {
    try {
      const candidate = mode === 'json' ? mergeRuntimeSettingsSectionJson(draft, section, json) : draft;
      if (!candidate) throw new Error(t('editor.messages.invalidJson'));
      const result = await postJson<{
        valid: boolean;
        normalized_config?: RuntimeSettingsConfig;
        errors: Array<{ path: string; message: string }>;
      }>('/v1/x/settings/validate', candidate);
      if (!result.valid) {
        setValidationErrors(Object.fromEntries(result.errors.map((item) => [item.path, item.message])));
        fail(result.errors.map((item) => `${item.path || 'config'}: ${item.message}`).join('\n'));
        setValidationState('invalid');
        setValidatedJson('');
        return null;
      }
      const normalized = result.normalized_config
        ? preserveCandidateSecrets(result.normalized_config, candidate)
        : candidate;
      setConfig(normalized, 'valid');
      setValidationErrors({});
      setError(t('editor.messages.valid'));
      setPositive(true);
      setCanRestart(false);
      return normalized;
    } catch (err) {
      fail(err instanceof Error ? err.message : t('editor.messages.invalidJson'));
      setValidationState('invalid');
      setValidatedJson('');
      setValidationErrors({ config: err instanceof Error ? err.message : t('editor.messages.invalidJson') });
      return null;
    }
  };
  const save = async () => {
    if (!currentFingerprint || !isDirty) {
      fail(t('editor.messages.nothingToSave'));
      return;
    }
    let configToSave = draft;
    if (validationState !== 'valid' || validatedJson !== currentFingerprint) {
      const validated = await validate();
      if (!validated) return;
      configToSave = validated;
    }
    setSaving(true);
    try {
      await putJson('/v1/x/settings', { revision: settings.revision, config: configToSave });
      setError(t('editor.messages.saved'));
      setPositive(true);
      setCanRestart(true);
      onRefresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : t('editor.messages.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  const testConnection = async () => {
    setActionsOpen(false);
    setTesting(true);
    try {
      const candidate = mode === 'json' ? mergeRuntimeSettingsSectionJson(draft, section, json) : draft;
      if (!candidate) throw new Error(t('editor.messages.invalidJson'));
      const areas = section === 'storage'
        ? [
          { area: 'storage.metadata', config: candidate.storage.metadata, full_config: candidate },
          { area: 'storage.artifacts', config: candidate.storage.artifacts, full_config: candidate },
        ]
        : [{ area: testAreaForSection(section), config: candidate[configKeyForSection(section)], full_config: candidate }];
      const results = await Promise.all(areas.map((item) => postJson<{
        ok: boolean;
        status: string;
        checks: Array<{ name: string; status: string; message: string }>;
        errors?: Array<{ path: string; message: string }>;
      }>('/v1/x/settings/test', item)));
      const messages = results.flatMap((result) => {
        if (result.checks.length === 0 && result.errors?.length) return result.errors.map((item) => `${item.path}: ${item.message}`);
        return result.checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.message}`);
      });
      syncConfigAfterConnectionTest(candidate);
      // Check statuses are published API vocabulary ("OK", "SKIPPED", "FAIL"),
      // not UI copy, so they stay matched on the raw values.
      const joined = messages.join('\n') || t('editor.messages.testComplete');
      const failed = results.some((result) => !result.ok);
      setError(joined);
      setPositive(!failed);
      setCanRestart(false);
    } catch (err) {
      fail(err instanceof Error ? err.message : t('editor.messages.testFailed'));
    } finally {
      setTesting(false);
    }
  };
  const restart = async () => {
    setRestarting(true);
    try {
      await postJson('/v1/x/restart', {});
      setError(t('editor.messages.restartScheduled'));
      setPositive(true);
      setCanRestart(true);
    } catch (err) {
      fail(err instanceof Error ? err.message : t('editor.messages.restartFailed'));
    } finally {
      setRestarting(false);
    }
  };
  const discard = () => {
    setActionsOpen(false);
    setDraft(savedConfig);
    setJson(savedJson);
    setError('');
    setPositive(false);
    setCanRestart(false);
    setValidationState('unknown');
    setValidatedJson('');
    setValidationErrors({});
    setFormResetKey((key) => key + 1);
  };
  const syncConfigAfterConnectionTest = (next: RuntimeSettingsConfig) => {
    const hydrated = applyRuntimeSettingsDefaults(next, settings.adapters);
    const fingerprint = stableSettingsJson(hydrated);
    setDraft(hydrated);
    setJson(runtimeSettingsSectionJson(hydrated, section));
    if (validatedJson !== fingerprint) {
      setValidationState('unknown');
      setValidatedJson('');
      setValidationErrors({});
    }
  };

  return (
    <section className="stack runtimeSettingsEditor">
      <div className="pageIntro">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          {sectionActivationErrors.length > 0 ? <InlineStatus tone="error">
            <span>{t('editor.activation.notActive')}</span>
            <span>{activationErrorCount === 1 ? t('editor.activation.fixOne') : t('editor.activation.fixMany', { n: activationErrorCount })}</span>
          </InlineStatus> : null}
        </div>
      </div>
      <SegmentedControl label={t('editor.modes.label')} value={mode} onChange={setMode} options={[{ value: 'form', label: t('editor.modes.form') }, { value: 'json', label: t('editor.modes.json') }]} />
      {mode === 'form' ? <div className="panel formStack runtimeSettingsForm">
        {section === 'models' ? <ModelSettingsForm adapters={adapters} config={draft} onChange={setConfig} errors={visibleErrors} resetKey={formResetKey} apiKeyConfigured={settings.secret_states.model.api_key === 'configured'} /> : null}
        {section === 'loop-engine' ? <LoopEngineSettingsForm adapters={adapters} config={draft} onChange={setConfig} errors={visibleErrors} resetKey={formResetKey} /> : null}
        {section === 'storage' ? (
          <StorageSettingsForm
            metadataAdapters={settings.adapters.storage.metadata}
            artifactAdapters={settings.adapters.storage.artifacts}
            config={draft}
            onChange={setConfig}
            errors={visibleErrors}
            resetKey={formResetKey}
            diagnostics={settings.diagnostics.metadata}
          />
        ) : null}
        {section === 'memory' ? <MemorySettingsForm adapters={adapters} config={draft} onChange={setConfig} errors={visibleErrors} resetKey={formResetKey} /> : null}
        {section === 'sandbox' ? <SandboxSettingsForm adapters={adapters} config={draft} onChange={setConfig} errors={visibleErrors} resetKey={formResetKey} /> : null}
      </div> : <div className="stack">
        <p className="formHint">{t('editor.jsonHint', { section: title })}</p>
        <JsonCodeEditor value={json} onChange={(value) => {
          setJson(value);
          setValidationState('unknown');
          setValidatedJson('');
          setValidationErrors({});
        }} />
      </div>}
      {error ? positive ? (
        <ActionNotice>
          <span>{error}</span>
          {canRestart ? <button className="button secondary" type="button" onClick={() => void restart()} disabled={restarting}>{restarting ? t('editor.actions.restarting') : t('editor.actions.restartNow')}</button> : null}
        </ActionNotice>
      ) : <div className="formError">{error}</div> : null}
      <FormActions>
        <div className="menuWrap settingsActionsMenu">
          <button className="iconButton" type="button" onClick={() => setActionsOpen((open) => !open)} title={t('editor.actions.more')} aria-label={t('editor.actions.more')}>
            <MoreVertical size={18} />
          </button>
          {actionsOpen ? (
            <div className="agentMenu settingsMoreMenu">
              <button type="button" onClick={() => { setActionsOpen(false); void validate(); }}>{t('editor.actions.validate')}</button>
              <button type="button" onClick={() => void testConnection()} disabled={testing}>{testing ? t('editor.actions.checking') : t('editor.actions.check')}</button>
            </div>
          ) : null}
        </div>
        {isDirty ? <button className="button secondary" type="button" onClick={discard} disabled={saving}>{t('editor.actions.discard')}</button> : null}
        <button className="button primary" type="button" onClick={() => void save()} disabled={!isDirty || saving}>{saving ? t('editor.actions.saving') : t('editor.actions.save')}</button>
      </FormActions>
    </section>
  );
}
