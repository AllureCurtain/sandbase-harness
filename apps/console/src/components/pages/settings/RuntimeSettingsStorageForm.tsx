import { useTranslation } from 'react-i18next';
import { BadgeList, FormField, FormSection, InfoRow, OptionsJsonField, StatusBadge, ToggleSwitch } from '../../FormPrimitives';
import type { RuntimeSettingsConfig } from '../../../types';
import {
  AdapterSelect,
  optionDefaultsForAdapter,
  type AdapterOption,
  type SettingsFormProps,
} from './RuntimeSettingsFormShared';

export function StorageSettingsForm({
  metadataAdapters,
  artifactAdapters,
  config,
  onChange,
  errors,
  resetKey,
  diagnostics,
}: Omit<SettingsFormProps, 'adapters'> & {
  metadataAdapters: AdapterOption[];
  artifactAdapters: AdapterOption[];
  diagnostics: { path: string | null; health: 'ok' | 'failed' };
}) {
  const { t } = useTranslation('settings');
  const changeMetadataProvider = (provider: RuntimeSettingsConfig['storage']['metadata']['provider']) => {
    onChange({
      ...config,
      storage: {
        ...config.storage,
        metadata: {
          provider,
          options: optionDefaultsForAdapter(metadataAdapters, provider),
        },
      },
    });
  };
  const changeArtifactProvider = (provider: RuntimeSettingsConfig['storage']['artifacts']['provider']) => {
    onChange({
      ...config,
      storage: {
        ...config.storage,
        artifacts: {
          provider,
          options: optionDefaultsForAdapter(artifactAdapters, provider),
        },
      },
    });
  };

  return (
    <>
      <FormSection title={t('forms.storage.metadataSection')}>
        <FormField label={t('forms.storage.provider')} description={t('forms.storage.metadataProviderHint')} error={errors?.['storage.metadata.provider']}>
          <AdapterSelect
            label={t('forms.storage.provider')}
            adapters={metadataAdapters}
            value={config.storage.metadata.provider}
            onChange={(provider) => changeMetadataProvider(provider as RuntimeSettingsConfig['storage']['metadata']['provider'])}
          />
        </FormField>
        {config.storage.metadata.provider === 'sqlite' ? (
          <InfoRow>
            <span>{t('forms.storage.database')}</span>
            <code>{diagnostics.path ?? t('forms.storage.unavailable')}</code>
            <StatusBadge tone={diagnostics.health === 'ok' ? 'active' : 'error'}>{diagnostics.health}</StatusBadge>
          </InfoRow>
        ) : (
          <FormField label={t('forms.storage.connectionString')} description={t('forms.storage.connectionStringHint')} error={errors?.['storage.metadata.options.connection_string']}>
            <input
              value={String(config.storage.metadata.options.connection_string ?? '')}
              onChange={(event) => onChange({
                ...config,
                storage: {
                  ...config.storage,
                  metadata: {
                    ...config.storage.metadata,
                    options: { ...config.storage.metadata.options, connection_string: event.target.value },
                  },
                },
              })}
              placeholder="${DATABASE_URL}"
            />
          </FormField>
        )}
        <OptionsJsonField
          label={t('forms.optionsJson')}
          value={config.storage.metadata.options}
          onChange={(options) => onChange({ ...config, storage: { ...config.storage, metadata: { ...config.storage.metadata, options } } })}
          onInvalid={() => onChange(config)}
          error={errors?.['storage.metadata.options']}
          resetKey={resetKey}
        />
      </FormSection>
      <FormSection title={t('forms.storage.artifactsSection')}>
        <FormField label={t('forms.storage.provider')} description={t('forms.storage.artifactsProviderHint')} error={errors?.['storage.artifacts.provider']}>
          <AdapterSelect
            label={t('forms.storage.provider')}
            adapters={artifactAdapters}
            value={config.storage.artifacts.provider}
            onChange={(provider) => changeArtifactProvider(provider as RuntimeSettingsConfig['storage']['artifacts']['provider'])}
          />
        </FormField>
        {config.storage.artifacts.provider === 'local' ? (
          <FormField label={t('forms.storage.basePath')} description={t('forms.storage.basePathHint')} error={errors?.['storage.artifacts.options.base_path']}>
            <input
              value={String(config.storage.artifacts.options.base_path ?? '')}
              onChange={(event) => onChange({
                ...config,
                storage: {
                  ...config.storage,
                  artifacts: {
                    ...config.storage.artifacts,
                    options: { ...config.storage.artifacts.options, base_path: event.target.value },
                  },
                },
              })}
            />
          </FormField>
        ) : (
          <>
            <FormField label={t('forms.storage.endpoint')} description={t('forms.storage.endpointHint')} error={errors?.['storage.artifacts.options.endpoint']}>
              <input
                value={String(config.storage.artifacts.options.endpoint ?? '')}
                onChange={(event) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, endpoint: event.target.value } } } })}
                placeholder="https://s3.amazonaws.com"
              />
            </FormField>
            <FormField label={t('forms.storage.bucket')} description={t('forms.storage.bucketHint')} error={errors?.['storage.artifacts.options.bucket']}>
              <input
                value={String(config.storage.artifacts.options.bucket ?? '')}
                onChange={(event) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, bucket: event.target.value } } } })}
                placeholder="managed-agents-artifacts"
              />
            </FormField>
            <FormField label={t('forms.storage.region')} description={t('forms.storage.regionHint')} error={errors?.['storage.artifacts.options.region']}>
              <input
                value={String(config.storage.artifacts.options.region ?? '')}
                onChange={(event) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, region: event.target.value } } } })}
                placeholder="us-east-1"
              />
            </FormField>
            <FormField label={t('forms.storage.accessKey')} description={t('forms.storage.accessKeyHint')} error={errors?.['storage.artifacts.options.access_key']}>
              <input
                type="password"
                value={String(config.storage.artifacts.options.access_key ?? '')}
                onChange={(event) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, access_key: event.target.value } } } })}
                placeholder="${AWS_ACCESS_KEY_ID}"
              />
            </FormField>
            <FormField label={t('forms.storage.secretKey')} description={t('forms.storage.secretKeyHint')} error={errors?.['storage.artifacts.options.secret_key']}>
              <input
                type="password"
                value={String(config.storage.artifacts.options.secret_key ?? '')}
                onChange={(event) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, secret_key: event.target.value } } } })}
                placeholder="${AWS_SECRET_ACCESS_KEY}"
              />
            </FormField>
            <FormField label={t('forms.storage.pathStyle')} description={t('forms.storage.pathStyleHint')}>
              <ToggleSwitch
                checked={Boolean(config.storage.artifacts.options.force_path_style)}
                onChange={(checked) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options: { ...config.storage.artifacts.options, force_path_style: checked } } } })}
                onLabel={t('forms.memory.toggleOn')}
                offLabel={t('forms.memory.toggleOff')}
              />
            </FormField>
          </>
        )}
        <OptionsJsonField
          label={t('forms.optionsJson')}
          value={config.storage.artifacts.options}
          onChange={(options) => onChange({ ...config, storage: { ...config.storage, artifacts: { ...config.storage.artifacts, options } } })}
          onInvalid={() => onChange(config)}
          error={errors?.['storage.artifacts.options']}
          resetKey={resetKey}
        />
        <BadgeList ariaLabel={t('forms.storage.badgeLabel')}>
          {[...metadataAdapters.map((adapter) => ({ ...adapter, prefix: t('forms.storage.prefixMetadata') })), ...artifactAdapters.map((adapter) => ({ ...adapter, prefix: t('forms.storage.prefixArtifacts') }))].map((adapter) => (
            <StatusBadge key={`${adapter.prefix}-${adapter.id}`} tone={adapter.status === 'available' ? 'active' : adapter.status === 'invalid' ? 'error' : 'disabled'}>
              {adapter.prefix} {adapter.label}: {adapter.status}
            </StatusBadge>
          ))}
        </BadgeList>
      </FormSection>
    </>
  );
}
