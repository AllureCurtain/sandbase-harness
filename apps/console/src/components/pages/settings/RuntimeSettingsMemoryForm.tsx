import { useTranslation } from 'react-i18next';
import { FormField, InfoRow, OptionsJsonField, StatusBadge, ToggleSwitch } from '../../FormPrimitives';
import { AdapterSelect, type SettingsFormProps } from './RuntimeSettingsFormShared';

export function MemorySettingsForm({ adapters, config, onChange, errors, resetKey }: SettingsFormProps) {
  const { t } = useTranslation('settings');
  const provider = adapters.find((adapter) => adapter.id === config.memory.provider);

  return (
    <>
      <div className="settingsHeroCard">
        <div>
          <span className="settingsHeroEyebrow">{t('forms.memory.eyebrow')}</span>
          <h2>{config.memory.enabled ? t('forms.memory.enabledTitle') : t('forms.memory.disabledTitle')}</h2>
          <p>{config.memory.enabled ? t('forms.memory.enabledBody') : t('forms.memory.disabledBody')}</p>
        </div>
        <StatusBadge tone={config.memory.enabled ? 'active' : 'disabled'}>
          {config.memory.enabled ? t('forms.memory.enabled') : t('forms.memory.disabled')}
        </StatusBadge>
      </div>
      <FormField label={t('forms.memory.toggle')} description={t('forms.memory.toggleHint')}>
        <ToggleSwitch
          checked={config.memory.enabled}
          onChange={(enabled) => onChange({ ...config, memory: { ...config.memory, enabled } })}
          onLabel={t('forms.memory.toggleOn')}
          offLabel={t('forms.memory.toggleOff')}
        />
      </FormField>
      <FormField label={t('forms.memory.provider')} description={t('forms.memory.providerHint')} error={errors?.['memory.provider']}>
        <AdapterSelect
          label={t('forms.memory.provider')}
          adapters={adapters}
          value={config.memory.provider}
          onChange={(provider) => onChange({ ...config, memory: { ...config.memory, provider: provider as typeof config.memory.provider } })}
        />
      </FormField>
      <InfoRow>
        <span>{t('forms.memory.selectedProvider')}</span>
        <code>{provider?.label ?? config.memory.provider}</code>
        <StatusBadge tone={provider?.status === 'available' ? 'active' : provider?.status === 'invalid' ? 'error' : 'disabled'}>
          {provider?.status ?? 'unknown'}
        </StatusBadge>
      </InfoRow>
      <OptionsJsonField
        label={t('forms.optionsJson')}
        value={config.memory.options}
        onChange={(options) => onChange({ ...config, memory: { ...config.memory, options } })}
        onInvalid={() => onChange(config)}
        error={errors?.['memory.options']}
        resetKey={resetKey}
      />
    </>
  );
}
