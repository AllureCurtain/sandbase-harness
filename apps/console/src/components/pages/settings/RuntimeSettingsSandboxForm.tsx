import { Trans, useTranslation } from 'react-i18next';
import { BadgeList, FormField, InfoRow, OptionsJsonField, StatusBadge } from '../../FormPrimitives';
import type { RuntimeSettingsConfig } from '../../../types';
import {
  AdapterSelect,
  optionDefaultsForAdapter,
  type SettingsFormProps,
} from './RuntimeSettingsFormShared';

export function SandboxSettingsForm({ adapters, config, onChange, errors, resetKey }: SettingsFormProps) {
  const { t } = useTranslation('settings');
  const changeSandboxProvider = (provider: RuntimeSettingsConfig['sandbox']['provider']) => {
    onChange({
      ...config,
      sandbox: {
        provider,
        options: optionDefaultsForAdapter(adapters, provider) as RuntimeSettingsConfig['sandbox']['options'],
      },
    });
  };

  return (
    <>
      <FormField
        label={t('forms.sandbox.provider')}
        description={<Trans i18nKey="forms.sandbox.providerHint" ns="settings" components={{ a: <a href="#environments" /> }} />}
        error={errors?.['sandbox.provider']}
      >
        <AdapterSelect
          label={t('forms.sandbox.provider')}
          adapters={adapters}
          value={config.sandbox.provider}
          onChange={(provider) => changeSandboxProvider(provider as RuntimeSettingsConfig['sandbox']['provider'])}
        />
      </FormField>
      <FormField label={t('forms.sandbox.timeout')} description={t('forms.sandbox.timeoutHint')} error={errors?.['sandbox.options.timeout_seconds']}>
        <input
          type="number"
          min="1"
          value={config.sandbox.options.timeout_seconds}
          onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, timeout_seconds: Number(event.target.value) } } })}
        />
      </FormField>
      {config.sandbox.provider === 'docker' || config.sandbox.provider === 'kubernetes' ? (
        <FormField label={t('forms.sandbox.image')} description={t('forms.sandbox.imageHint')} error={errors?.['sandbox.options.image']}>
          <input
            value={String(config.sandbox.options.image ?? '')}
            onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, image: event.target.value } } })}
            placeholder="node:22-bookworm"
          />
        </FormField>
      ) : null}
      {config.sandbox.provider === 'kubernetes' ? (
        <>
          <InfoRow>
            <span>{t('forms.sandbox.transport')}</span>
            <code>kubectl exec / kubectl cp</code>
            <StatusBadge tone="active">{t('forms.sandbox.transportBadge')}</StatusBadge>
          </InfoRow>
          <FormField
            label={t('forms.sandbox.namespace')}
            description={t('forms.sandbox.namespaceHint')}
            error={errors?.['sandbox.options.namespace']}
          >
            <input
              value={String(config.sandbox.options.namespace ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, namespace: event.target.value } } })}
              placeholder="default"
            />
          </FormField>
          <FormField
            label={t('forms.sandbox.context')}
            description={t('forms.sandbox.contextHint')}
            error={errors?.['sandbox.options.context']}
          >
            <input
              value={String(config.sandbox.options.context ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, context: event.target.value } } })}
              placeholder="my-cluster"
            />
          </FormField>
          <FormField
            label={t('forms.sandbox.kubeconfig')}
            description={t('forms.sandbox.kubeconfigHint')}
            error={errors?.['sandbox.options.kubeconfig']}
          >
            <input
              value={String(config.sandbox.options.kubeconfig ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, kubeconfig: event.target.value } } })}
              placeholder="~/.kube/config"
            />
          </FormField>
          <FormField
            label={t('forms.sandbox.serviceAccount')}
            description={t('forms.sandbox.serviceAccountHint')}
            error={errors?.['sandbox.options.service_account']}
          >
            <input
              value={String(config.sandbox.options.service_account ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, service_account: event.target.value } } })}
              placeholder="(none)"
            />
          </FormField>
        </>
      ) : null}
      {config.sandbox.provider === 'remote' ? (
        <>
          <InfoRow>
            <span>{t('forms.sandbox.runtimeMapping')}</span>
            <code>remote → self_hosted worker queue</code>
            <StatusBadge tone="active">{t('forms.sandbox.workerBadge')}</StatusBadge>
          </InfoRow>
          <FormField
            label={t('forms.sandbox.workerUrl')}
            description={t('forms.sandbox.workerUrlHint')}
            error={errors?.['sandbox.options.endpoint']}
          >
            <input
              value={String(config.sandbox.options.endpoint ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, endpoint: event.target.value } } })}
              placeholder="${MANAGED_AGENTS_API_URL}"
            />
          </FormField>
          <FormField
            label={t('forms.sandbox.workerKey')}
            description={t('forms.sandbox.workerKeyHint')}
            error={errors?.['sandbox.options.api_key']}
          >
            <input
              type="password"
              value={String(config.sandbox.options.api_key ?? '')}
              onChange={(event) => onChange({ ...config, sandbox: { ...config.sandbox, options: { ...config.sandbox.options, api_key: event.target.value } } })}
              placeholder="${MANAGED_AGENTS_WORKER_API_KEY}"
            />
          </FormField>
        </>
      ) : null}
      <OptionsJsonField
        label={t('forms.optionsJson')}
        value={config.sandbox.options}
        onChange={(options) => onChange({
          ...config,
          sandbox: {
            ...config.sandbox,
            options: { ...options, timeout_seconds: Number(options.timeout_seconds ?? config.sandbox.options.timeout_seconds) } as RuntimeSettingsConfig['sandbox']['options'],
          },
        })}
        onInvalid={() => onChange(config)}
        error={errors?.['sandbox.options']}
        resetKey={resetKey}
      />
      <BadgeList ariaLabel={t('forms.sandbox.badgeLabel')}>
        {adapters.map((adapter) => (
          <StatusBadge key={adapter.id} tone={adapter.status === 'available' ? 'active' : adapter.status === 'invalid' ? 'error' : 'disabled'}>
            {adapter.label}: {adapter.status}
          </StatusBadge>
        ))}
      </BadgeList>
    </>
  );
}
