import { useTranslation } from 'react-i18next';
import { FormField, InfoRow, OptionsJsonField, StatusBadge, ToggleSwitch } from '../../FormPrimitives';
import type { RuntimeSettingsConfig } from '../../../types';
import { AdapterSelect, optionDefaultsForAdapter, type SettingsFormProps } from './RuntimeSettingsFormShared';

type WebSearchConfig = NonNullable<RuntimeSettingsConfig['web_search']>;

/**
 * The `web_search` section is optional: absent means no provider is configured
 * and the tool stays unavailable at admission. The toggle therefore adds or
 * removes the whole section rather than flipping a flag inside it.
 */
export function WebSearchSettingsForm({ adapters, config, onChange, errors, resetKey }: SettingsFormProps) {
  const { t } = useTranslation('settings');
  const webSearch = config.web_search;
  const enabled = Boolean(webSearch);
  const provider = adapters.find((adapter) => adapter.id === webSearch?.provider);
  const apiKey = typeof webSearch?.options.api_key === 'string' ? webSearch.options.api_key : '';
  const baseUrl = typeof webSearch?.options.base_url === 'string' ? webSearch.options.base_url : '';

  const update = (next: WebSearchConfig) => onChange({ ...config, web_search: next });
  const updateOption = (key: string, value: unknown) => webSearch
    && update({ ...webSearch, options: { ...webSearch.options, [key]: value } });

  return (
    <>
      <div className="settingsHeroCard">
        <div>
          <span className="settingsHeroEyebrow">{t('forms.webSearch.eyebrow')}</span>
          <h2>{enabled ? t('forms.webSearch.enabledTitle') : t('forms.webSearch.disabledTitle')}</h2>
          <p>{enabled ? t('forms.webSearch.enabledBody') : t('forms.webSearch.disabledBody')}</p>
        </div>
        <StatusBadge tone={enabled ? 'active' : 'disabled'}>
          {enabled ? t('forms.webSearch.enabled') : t('forms.webSearch.disabled')}
        </StatusBadge>
      </div>
      <FormField label={t('forms.webSearch.toggle')} description={t('forms.webSearch.toggleHint')}>
        <ToggleSwitch
          checked={enabled}
          onChange={(on) => {
            if (!on) {
              const { web_search: _removed, ...rest } = config;
              onChange(rest);
              return;
            }
            const available = adapters.find((adapter) => adapter.status === 'available')?.id ?? adapters[0]?.id ?? 'tavily';
            onChange({
              ...config,
              web_search: {
                provider: available as WebSearchConfig['provider'],
                options: optionDefaultsForAdapter(adapters, available),
              },
            });
          }}
          onLabel={t('forms.webSearch.toggleOn')}
          offLabel={t('forms.webSearch.toggleOff')}
        />
      </FormField>
      {webSearch ? (
        <>
          <FormField label={t('forms.webSearch.provider')} description={t('forms.webSearch.providerHint')} error={errors?.['web_search.provider']}>
            <AdapterSelect
              label={t('forms.webSearch.provider')}
              adapters={adapters}
              value={webSearch.provider}
              onChange={(next) => update({
                provider: next as WebSearchConfig['provider'],
                options: optionDefaultsForAdapter(adapters, next),
              })}
            />
          </FormField>
          <InfoRow>
            <span>{t('forms.webSearch.selectedProvider')}</span>
            <code>{provider?.label ?? webSearch.provider}</code>
            <StatusBadge tone={provider?.status === 'available' ? 'active' : provider?.status === 'invalid' ? 'error' : 'disabled'}>
              {provider?.status ?? 'unknown'}
            </StatusBadge>
          </InfoRow>
          <FormField
            label={t('forms.webSearch.apiKey')}
            description={t('forms.webSearch.apiKeyHint')}
            error={errors?.['web_search.options.api_key']}
          >
            <input
              type="password"
              value={apiKey}
              onChange={(event) => updateOption('api_key', event.target.value || undefined)}
              placeholder="${TAVILY_API_KEY}"
            />
          </FormField>
          <FormField
            label={t('forms.webSearch.baseUrl')}
            description={t('forms.webSearch.baseUrlHint')}
            error={errors?.['web_search.options.base_url']}
          >
            <input
              value={baseUrl}
              onChange={(event) => updateOption('base_url', event.target.value || undefined)}
              placeholder="https://api.tavily.com"
            />
          </FormField>
          <OptionsJsonField
            label={t('forms.optionsJson')}
            value={webSearch.options}
            onChange={(options) => update({ ...webSearch, options })}
            onInvalid={() => onChange(config)}
            error={errors?.['web_search.options']}
            resetKey={resetKey}
          />
        </>
      ) : null}
    </>
  );
}
