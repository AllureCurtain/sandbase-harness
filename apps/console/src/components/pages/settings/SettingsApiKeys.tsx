import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearStoredApiKey, deleteJson, getStoredApiKey, postJson, setStoredApiKey } from '../../../api';
import { copyText, formatDateShort, relativeDate, truncateMiddle } from '../../../lib/format';
import type { ApiKey, ApiKeyCreateResponse, ConsoleData } from '../../../types';
import { RequiredMark, ResourceBadge } from '../../Common';
import { EmptyState, Kpi, KpiStrip, PageHeader, StatusDot } from '../../console-ui';
import { ConfirmDeleteModal } from '../../DangerZone';
import { Modal } from '../../Modal';

export function SettingsApiKeys({ data, onRefresh }: { data: ConsoleData; onRefresh: () => void }) {
  const { t } = useTranslation('settings');
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<ApiKey | null>(null);
  const [storedKey, setStoredKey] = useState(() => getStoredApiKey());
  const activeKeys = data.apiKeys.filter((key) => key.status === 'active');
  const managedKeys = data.apiKeys.filter((key) => key.source === 'managed');
  const configuredKeys = data.apiKeys.filter((key) => key.source === 'config_env');

  const saveStoredKey = () => {
    setStoredApiKey(storedKey);
    onRefresh();
  };

  const clearBrowserKey = () => {
    clearStoredApiKey();
    setStoredKey('');
  };

  const deleteKey = async (key: ApiKey) => {
    await deleteJson(`/v1/api-keys/${encodeURIComponent(key.id)}`);
    onRefresh();
  };

  return (
    <section className="stack">
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.description')}
        actions={(
          <button className="primaryButton" type="button" onClick={() => setModalOpen(true)}>
            <Plus size={18} />{t('apiKeys.create')}
          </button>
        )}
      />
      <KpiStrip label={t('apiKeys.title')}>
        <Kpi label={t('apiKeys.kpis.auth')} value={data.runtime?.auth_enabled ? t('general.auth.enabled') : t('general.auth.disabled')} />
        <Kpi label={t('apiKeys.kpis.activeKeys')} value={String(activeKeys.length)} />
        <Kpi label={t('apiKeys.kpis.managedKeys')} value={String(managedKeys.length)} />
        <Kpi label={t('apiKeys.kpis.configuredKeys')} value={String(configuredKeys.length)} />
      </KpiStrip>
      <div className="table-frame">
        <table className="data-table" aria-label={t('apiKeys.title')}>
          <thead>
            <tr>
              <th scope="col">{t('apiKeys.columns.id')}</th>
              <th scope="col">{t('apiKeys.columns.name')}</th>
              <th scope="col">{t('apiKeys.columns.source')}</th>
              <th scope="col">{t('apiKeys.columns.status')}</th>
              <th scope="col">{t('apiKeys.columns.keyPrefix')}</th>
              <th scope="col">{t('apiKeys.columns.lastUsed')}</th>
              <th scope="col">{t('apiKeys.columns.created')}</th>
              <th scope="col"><span className="srOnly">{t('apiKeys.columns.action')}</span></th>
            </tr>
          </thead>
          <tbody>
            {data.apiKeys.map((key) => (
              <tr key={key.id}>
                <td><code>{truncateMiddle(key.id, 18)}</code></td>
                <td><strong>{key.name}</strong></td>
                <td><ResourceBadge>{key.source === 'managed' ? t('apiKeys.sourceManaged') : t('apiKeys.sourceConfig')}</ResourceBadge></td>
                <td><StatusDot tone={key.status === 'active' ? 'ok' : 'neutral'} label={key.status} /></td>
                <td><code>{key.key_prefix}</code></td>
                <td>{key.last_used_at ? relativeDate(key.last_used_at) : t('apiKeys.never')}</td>
                <td>{formatDateShort(key.created_at)}</td>
                <td className="row-actions-cell">
                  <button className="iconButton quiet" type="button" title={t('apiKeys.copyPrefix')} aria-label={t('apiKeys.copyPrefix')} onClick={() => void copyText(key.key_prefix)}>
                    <Copy size={16} />
                  </button>
                  {key.source === 'managed' ? (
                    <button className="iconButton danger" type="button" title={t('apiKeys.delete')} aria-label={t('apiKeys.delete')} onClick={() => setDeletingKey(key)}>
                      <Trash2 size={16} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.apiKeys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t('apiKeys.empty')}
            description={t('apiKeys.emptyBody')}
            action={<button className="primaryButton" type="button" onClick={() => setModalOpen(true)}><Plus size={18} />{t('apiKeys.create')}</button>}
          />
        ) : null}
      </div>
      <div className="panel subtlePanel">
        <h2>{t('apiKeys.browserToken.title')}</h2>
        <p>{t('apiKeys.browserToken.description')}</p>
        <div className="inlineForm">
          <input
            value={storedKey}
            onChange={(event) => setStoredKey(event.target.value)}
            placeholder={t('apiKeys.browserToken.placeholder')}
            type="password"
            aria-label={t('apiKeys.browserToken.title')}
          />
          <button type="button" className="secondaryButton" onClick={saveStoredKey}>{t('apiKeys.browserToken.save')}</button>
          <button type="button" className="ghostButton" onClick={clearBrowserKey}>{t('apiKeys.browserToken.clear')}</button>
        </div>
      </div>
      {modalOpen ? (
        <ApiKeyModal
          onClose={() => setModalOpen(false)}
          onSaved={(secret) => {
            setStoredApiKey(secret);
            setStoredKey(secret);
            onRefresh();
          }}
        />
      ) : null}
      {deletingKey ? (
        <ConfirmDeleteModal
          title={t('apiKeys.deleteConfirm.title')}
          subject={deletingKey.name}
          consequence={t('apiKeys.deleteConfirm.consequence')}
          confirmLabel={t('apiKeys.deleteConfirm.confirm')}
          onClose={() => setDeletingKey(null)}
          onConfirm={() => deleteKey(deletingKey)}
        />
      ) : null}
    </section>
  );
}

function ApiKeyModal({ onClose, onSaved }: { onClose: () => void; onSaved: (secret: string) => void }) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState('Default API key');
  const [created, setCreated] = useState<ApiKeyCreateResponse | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (created) {
      onClose();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await postJson<ApiKeyCreateResponse>('/v1/api-keys', { name });
      setCreated(response);
      onSaved(response.secret_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('apiKeys.modal.title')} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error">{error}</div> : null}
        {!created ? (
          <>
            <label>
              <span>{t('apiKeys.modal.name')} <RequiredMark /></span>
              <input value={name} onChange={(event) => setName(event.target.value.slice(0, 80))} placeholder={t('apiKeys.modal.namePlaceholder')} required />
            </label>
            <p className="formHint">{t('apiKeys.modal.hint')}</p>
          </>
        ) : (
          <div className="secretReveal">
            <div>
              <strong>{created.name}</strong>
              <span>{created.key_prefix}</span>
            </div>
            <code>{created.secret_key}</code>
            <button type="button" className="secondaryButton" onClick={() => void copyText(created.secret_key)}>
              <Copy size={16} />{t('apiKeys.modal.copyKey')}
            </button>
          </div>
        )}
        <div className="modalActions">
          <button type="button" className="secondaryButton" onClick={onClose}>{created ? t('apiKeys.modal.done') : t('apiKeys.modal.cancel')}</button>
          {!created ? <button className="primaryButton" type="submit" disabled={saving}>{saving ? t('apiKeys.modal.creating') : t('apiKeys.modal.submit')}</button> : null}
        </div>
      </form>
    </Modal>
  );
}
