import { useTranslation } from 'react-i18next';
import { ConsoleSelect } from '../../console-select';
import { FormField, OptionsJsonField } from '../../FormPrimitives';
import type { RuntimeSettingsConfig } from '../../../types';
import {
  AdapterSelect,
  type SettingsFormProps,
} from './RuntimeSettingsFormShared';

export { parseOptionsJsonDraft } from '../../FormPrimitives';
export { optionDefaultsForAdapter, type AdapterOption, type SettingsFormProps } from './RuntimeSettingsFormShared';
export { MemorySettingsForm } from './RuntimeSettingsMemoryForm';
export { SandboxSettingsForm } from './RuntimeSettingsSandboxForm';
export { StorageSettingsForm } from './RuntimeSettingsStorageForm';

export function ModelSettingsForm({ adapters, config, onChange, errors, resetKey, apiKeyConfigured }: SettingsFormProps & { apiKeyConfigured: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <FormField label={t('forms.model.vendor')} description={t('forms.model.vendorHint')} error={errors?.['model.vendor']}>
        <AdapterSelect
          label={t('forms.model.vendor')}
          adapters={adapters}
          value={config.model.vendor}
          onChange={(vendor) => onChange({ ...config, model: { ...config.model, vendor: vendor as RuntimeSettingsConfig['model']['vendor'] } })}
        />
      </FormField>
      <FormField label={t('forms.model.baseUrl')} description={t('forms.model.baseUrlHint')} error={errors?.['model.base_url']}>
        <input
          value={config.model.base_url ?? ''}
          onChange={(event) => onChange({ ...config, model: { ...config.model, base_url: event.target.value || undefined } })}
          placeholder="https://api.example.com/v1"
        />
      </FormField>
      <FormField
        label={t('forms.model.apiKey')}
        description={apiKeyConfigured ? t('forms.model.apiKeyHintConfigured') : t('forms.model.apiKeyHint')}
        error={errors?.['model.api_key']}
      >
        <input
          type="password"
          value={config.model.api_key ?? ''}
          onChange={(event) => onChange({ ...config, model: { ...config.model, api_key: event.target.value || undefined } })}
          placeholder={apiKeyConfigured ? t('forms.model.apiKeyPlaceholderConfigured') : t('forms.model.apiKeyPlaceholder')}
        />
      </FormField>
    </>
  );
}

export function LoopEngineSettingsForm({ adapters, config, onChange, errors, resetKey }: SettingsFormProps) {
  const { t } = useTranslation('settings');
  // Platform-owned, and off unless an operator selected it: a value the schema
  // does not recognize is displayed as the safe default rather than as itself.
  const approvalMode = config.loop_engine.options.approval_mode === 'preauthorized_once'
    ? 'preauthorized_once'
    : 'interactive';
  return (
    <>
      <FormField label={t('forms.loopEngine.provider')} description={t('forms.loopEngine.providerHint')} error={errors?.['loop_engine.provider']}>
        <AdapterSelect
          label={t('forms.loopEngine.provider')}
          adapters={adapters}
          value={config.loop_engine.provider}
          onChange={(provider) => onChange({ ...config, loop_engine: { ...config.loop_engine, provider: provider as RuntimeSettingsConfig['loop_engine']['provider'] } })}
        />
      </FormField>
      <FormField label={t('forms.loopEngine.maxSteps')} description={t('forms.loopEngine.maxStepsHint')} error={errors?.['loop_engine.options.default_max_steps']}>
        <input
          type="number"
          min="1"
          max="1000"
          value={config.loop_engine.options.default_max_steps}
          onChange={(event) => onChange({ ...config, loop_engine: { ...config.loop_engine, options: { ...config.loop_engine.options, default_max_steps: Number(event.target.value) } } })}
        />
      </FormField>
      <FormField
        label={t('forms.loopEngine.approvalMode')}
        description={t('forms.loopEngine.approvalModeHint')}
        error={errors?.['loop_engine.options.approval_mode']}
      >
        <ConsoleSelect
          label={t('forms.loopEngine.approvalMode')}
          value={approvalMode}
          onChange={(value) => onChange({
            ...config,
            loop_engine: {
              ...config.loop_engine,
              options: {
                ...config.loop_engine.options,
                approval_mode: value as RuntimeSettingsConfig['loop_engine']['options']['approval_mode'],
              },
            },
          })}
          options={[
            { value: 'interactive', label: t('forms.loopEngine.approval.interactive') },
            { value: 'preauthorized_once', label: t('forms.loopEngine.approval.preauthorized_once') },
          ]}
        />
      </FormField>
      <OptionsJsonField
        label={t('forms.optionsJson')}
        value={config.loop_engine.options}
        onChange={(options) => onChange({
          ...config,
          loop_engine: {
            ...config.loop_engine,
            options: { ...options, default_max_steps: Number(options.default_max_steps ?? config.loop_engine.options.default_max_steps) } as RuntimeSettingsConfig['loop_engine']['options'],
          },
        })}
        onInvalid={() => onChange(config)}
        error={errors?.['loop_engine.options']}
        resetKey={resetKey}
      />
    </>
  );
}
