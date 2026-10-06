import { Archive, FileText, Info, KeyRound, Lock, MoreVertical, Pencil, Plus, RefreshCw, Search, Shield, Trash2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { deleteJson, postJson } from '../../api';
import { EmptyState, Kpi, KpiStrip, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { RequiredMark } from '../Common';
import { ConfirmDeleteModal } from '../DangerZone';
import { Modal } from '../Modal';
import { ListToolbar, listSummary, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { formatDateShort, relativeDate, shortId } from '../../lib/format';
import type { ConsoleData, CredentialAuthType, Vault, VaultCredential } from '../../types';
import './resources.css';

const MCP_REGISTRY_OPTIONS = [
  { name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
  { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
  { name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
  { name: 'Canva', url: 'https://mcp.canva.com/mcp' },
  { name: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
];

function authLabel(t: TFunction<'credentials'>, type: CredentialAuthType): string {
  return t(`authTypes.${type}`);
}

function statusLabel(t: TFunction<'credentials'>, status: string): string {
  return status === 'active' ? t('list.statusOptions.active') : status === 'archived' ? t('list.statusOptions.archived') : status;
}

function statusTone(status: string): Tone {
  return status === 'active' ? 'ok' : 'neutral';
}

export function CredentialVaults({ data, onNew, onOpenVault }: { data: ConsoleData; onNew: () => void; onOpenVault: (vault: Vault) => void }) {
  const { t } = useTranslation('credentials');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const vaults = data.vaults.filter((vault) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || vault.status === status;
    const matchesQuery = vault.id.toLowerCase().includes(q) || vault.name.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const filtering = Boolean(query) || status !== 'all';
  const activeVaults = data.vaults.filter((vault) => vault.status === 'active').length;
  const totalCredentials = data.vaults.reduce((sum, vault) => sum + vault.credentials.length, 0);
  const activeCredentials = data.vaults.reduce((sum, vault) => sum + vault.credentials.filter((credential) => credential.status === 'active').length, 0);
  const empty = (
    <EmptyState
      icon={Lock}
      title={data.vaults.length && filtering ? t('list.noMatch') : t('list.empty')}
      description={data.vaults.length && filtering ? undefined : t('list.emptyBody')}
      action={query
        ? <button className="button outline" type="button" onClick={() => setQuery('')}>{tCommon('actions.clearSearch')}</button>
        : <button className="button primary" type="button" onClick={onNew}><Plus size={15} />{t('list.createVault')}</button>}
    />
  );
  return (
    <section className="page-section console-page credentials-list-page" aria-labelledby="credentials-heading">
      <PageHeader
        headingId="credentials-heading"
        title={tPages('credential-vaults.title')}
        help={tPages('credential-vaults.description')}
        actions={(
          <button className="button primary" type="button" onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
            {tPages('credential-vaults.newVault')}
          </button>
        )}
      />
      <PageBody>
        <KpiStrip label={t('list.filterLabel')}>
          <Kpi label={t('list.kpis.vaults')} value={data.vaults.length} />
          <Kpi label={t('list.kpis.activeVaults')} value={activeVaults} />
          <Kpi label={t('list.kpis.credentials')} value={totalCredentials} />
          <Kpi label={t('list.kpis.activeCredentials')} value={activeCredentials} />
        </KpiStrip>
        <ListToolbar
          label={t('list.filterLabel')}
          summary={listSummary(tCommon, vaults.length, data.vaults.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('list.searchPlaceholder')} label={t('list.filterLabel')} />
          <ConsoleSelect
            label={t('list.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: t('list.statusOptions.all') },
              { value: 'active', label: t('list.statusOptions.active') },
              { value: 'archived', label: t('list.statusOptions.archived') },
            ]}
          />
        </ListToolbar>
        {vaults.length ? (
          <div className="table-frame credentials-table-frame">
            <table className="data-table" aria-label={tPages('credential-vaults.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('list.columns.id')}</th>
                  <th scope="col">{t('list.columns.name')}</th>
                  <th scope="col">{t('list.columns.credentials')}</th>
                  <th scope="col">{t('list.columns.status')}</th>
                  <th scope="col">{t('list.columns.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {vaults.map((vault) => (
                  <tr key={vault.id} className="clickable-row" onClick={() => onOpenVault(vault)}>
                    <td><strong className="monoText">{shortId(vault.id)}</strong></td>
                    <td>{vault.name}</td>
                    <td>{vault.credentials.length}</td>
                    <td><StatusDot tone={statusTone(vault.status)} label={statusLabel(t, vault.status)} /></td>
                    <td>{formatDateShort(vault.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : empty}
        <div className="mobileResourceList">
          {vaults.map((vault) => (
            <button className="mobileResourceCard" type="button" key={vault.id} onClick={() => onOpenVault(vault)} aria-label={t('list.open', { name: vault.name })}>
              <span className="mobileAgentMain">
                <strong>{vault.name}</strong>
                <small className="monoText">{vault.id}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{t('list.credentialCount', { n: vault.credentials.length })}</span>
                <StatusDot tone={statusTone(vault.status)} label={statusLabel(t, vault.status)} />
              </span>
            </button>
          ))}
          {vaults.length === 0 ? empty : null}
        </div>
      </PageBody>
    </section>
  );
}

export function CredentialVaultDetail({
  vault,
  onBack,
  onRefresh,
  onNewCredential,
}: {
  vault: Vault;
  onBack: () => void;
  onRefresh: () => void;
  onNewCredential: () => void;
}) {
  const { t } = useTranslation('credentials');
  const { t: tCommon, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [credentialMenuId, setCredentialMenuId] = useState<string | null>(null);
  const [rotatingCredential, setRotatingCredential] = useState<VaultCredential | null>(null);
  const [editingCredential, setEditingCredential] = useState<VaultCredential | null>(null);
  const [editVaultOpen, setEditVaultOpen] = useState(false);
  const [deleteVaultOpen, setDeleteVaultOpen] = useState(false);
  const [deletingCredential, setDeletingCredential] = useState<VaultCredential | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const credentials = vault.credentials.filter((credential) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || credential.status === status;
    const matchesQuery = credential.id.toLowerCase().includes(q)
      || credential.name.toLowerCase().includes(q)
      || authLabel(t, credential.auth_type).toLowerCase().includes(q)
      || credential.mcp_server_url.toLowerCase().includes(q)
      || credential.variable_name.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const activeCredentials = vault.credentials.filter((credential) => credential.status === 'active').length;
  const lastUsedCredential = vault.credentials
    .filter((credential) => credential.last_used_at)
    .sort((left, right) => String(right.last_used_at).localeCompare(String(left.last_used_at)))[0];

  const archiveVault = async () => {
    await postJson(`/v1/credential-vaults/${vault.id}/archive`, {});
    setMenuOpen(false);
    onBack();
    onRefresh();
  };
  const archiveCredential = async (credential: VaultCredential) => {
    await postJson(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}/archive`, {});
    setCredentialMenuId(null);
    onRefresh();
  };
  const deleteCredential = async (credential: VaultCredential) => {
    await deleteJson(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}`);
    setCredentialMenuId(null);
    onRefresh();
  };
  const askDeleteCredential = (credential: VaultCredential) => {
    setCredentialMenuId(null);
    setDeletingCredential(credential);
  };

  const credentialsEmpty = (
    <EmptyState
      icon={Shield}
      title={t('detail.credentialsSection.empty')}
      description={t('detail.credentialsSection.emptyBody')}
      action={<button className="button primary" type="button" onClick={onNewCredential}><Plus size={15} />{t('detail.addCredential')}</button>}
    />
  );

  const credentialMenuItems = (credential: VaultCredential) => (
    <>
      <button
        type="button"
        onClick={() => {
          setEditingCredential(credential);
          setCredentialMenuId(null);
        }}
      >
        <Pencil size={18} />{t('detail.rowActions.edit')}
      </button>
      {credential.auth_type !== 'mcp_oauth' ? (
        <button
          type="button"
          onClick={() => {
            setRotatingCredential(credential);
            setCredentialMenuId(null);
          }}
        >
          <RefreshCw size={18} />{t('detail.rowActions.rotate')}
        </button>
      ) : null}
      <button type="button" onClick={() => void archiveCredential(credential)}><Archive size={18} />{t('detail.rowActions.archive')}</button>
      <button type="button" className="dangerMenuItem" onClick={() => askDeleteCredential(credential)}><Trash2 size={18} />{t('detail.rowActions.delete')}</button>
    </>
  );

  return (
    <section className="environmentDetail vaultDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>{t('detail.back')}</button>
        <span>/</span>
        <strong>{vault.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{vault.name}</h1>
            <StatusDot tone={statusTone(vault.status)} label={statusLabel(t, vault.status)} />
          </div>
          <p className="mutedLine"><span className="monoText">{vault.id}</span> · {t('detail.created', { time: formatDateShort(vault.created_at) })} · {t('detail.updated', { time: formatDateShort(vault.updated_at) })}</p>
        </div>
        <div className="agentHeroActions">
          <button className="button primary largeAction" type="button" onClick={onNewCredential}>
            <Plus size={15} />
            {t('detail.addCredential')}
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title={t('detail.actions')}>
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditVaultOpen(true);
                  }}
                >
                  <Pencil size={18} />{t('detail.edit')}
                </button>
                <button type="button" className="dangerMenuItem" onClick={() => void archiveVault()}><Archive size={18} />{t('detail.archive')}</button>
                <button
                  type="button"
                  className="dangerMenuItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteVaultOpen(true);
                  }}
                >
                  <Trash2 size={18} />{t('detail.delete')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <KpiStrip label={t('detail.actions')}>
        <Kpi label={t('detail.kpis.credentials')} value={vault.credentials.length} />
        <Kpi label={t('detail.kpis.active')} value={activeCredentials} />
        <Kpi label={t('detail.kpis.lastUsed')} value={lastUsedCredential?.last_used_at ? relativeDate(lastUsedCredential.last_used_at) : t('detail.neverUsed')} />
      </KpiStrip>
      <div className="resourceTruthStrip" aria-label={t('detail.truth.aria')}>
        <div><span>{t('detail.truth.stored')}</span><strong>{t('detail.truth.storedBody')}</strong></div>
        <div><span>{t('detail.truth.scoped')}</span><strong>{t('detail.truth.scopedBody')}</strong></div>
        <div><span>{t('detail.truth.policy')}</span><strong>{t('detail.truth.policyBody')}</strong></div>
      </div>
      <div className="detailStack wideDetailStack">
        <ListToolbar
          label={t('detail.credentialsSection.credentialActions')}
          summary={listSummary(tCommon, credentials.length, vault.credentials.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('detail.credentialsSection.searchPlaceholder')} label={t('detail.credentialsSection.credentialActions')} />
          <ConsoleSelect
            label={t('list.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: t('list.statusOptions.all') },
              { value: 'active', label: t('list.statusOptions.active') },
              { value: 'archived', label: t('list.statusOptions.archived') },
            ]}
          />
        </ListToolbar>
        {credentials.length ? (
          <div className="table-frame credential-table-frame">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('detail.credentialsSection.columns.id')}</th>
                  <th scope="col">{t('detail.credentialsSection.columns.name')}</th>
                  <th scope="col">{t('detail.credentialsSection.columns.auth')}</th>
                  <th scope="col">{t('detail.credentialsSection.columns.status')}</th>
                  <th scope="col">{t('detail.credentialsSection.columns.lastUsed')}</th>
                  <th scope="col">{t('detail.credentialsSection.columns.updated')}</th>
                  <th scope="col" className="actionsCol" aria-label={t('detail.credentialsSection.columns.actions')} />
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr key={credential.id}>
                    <td><strong className="monoText">{shortId(credential.id)}</strong></td>
                    <td>{credential.name || authLabel(t, credential.auth_type)}</td>
                    <td><CredentialAuthCell credential={credential} /></td>
                    <td><StatusDot tone={statusTone(credential.status)} label={statusLabel(t, credential.status)} /></td>
                    <td>{credential.last_used_at ? relativeDate(credential.last_used_at) : t('detail.neverUsed')}</td>
                    <td>{formatDateShort(credential.updated_at)}</td>
                    <td className="actionsCol">
                      <div className="menuWrap">
                        <button className="iconButton quiet" type="button" title={t('detail.credentialsSection.credentialActions')} onClick={() => setCredentialMenuId((current) => current === credential.id ? null : credential.id)}>
                          <MoreVertical size={18} />
                        </button>
                        {credentialMenuId === credential.id ? (
                          <div className="agentMenu rowMenu">
                            {credentialMenuItems(credential)}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : credentialsEmpty}
        <div className="mobileResourceList">
          {credentials.map((credential) => (
            <article className="mobileResourceCard" key={credential.id}>
              <span className="mobileAgentMain">
                <strong>{credential.name || authLabel(t, credential.auth_type)}</strong>
                <small className="monoText">{credential.id}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{authLabel(t, credential.auth_type)}</span>
                <StatusDot tone={statusTone(credential.status)} label={statusLabel(t, credential.status)} />
              </span>
              <span className="mobileAgentMeta">
                <span>{credential.last_used_at ? t('detail.credentialsSection.usedAgo', { time: relativeDate(credential.last_used_at) }) : t('detail.credentialsSection.neverUsed')}</span>
                <button className="button ghost" type="button" onClick={() => setCredentialMenuId((current) => current === credential.id ? null : credential.id)}>
                  {t('detail.actions')}
                </button>
              </span>
              {credentialMenuId === credential.id ? (
                <div className="mobileActionMenu">
                  {credentialMenuItems(credential)}
                </div>
              ) : null}
            </article>
          ))}
          {credentials.length === 0 ? credentialsEmpty : null}
        </div>
      </div>
      {rotatingCredential ? (
        <RotateCredentialModal
          vaultId={vault.id}
          credential={rotatingCredential}
          onClose={() => setRotatingCredential(null)}
          onSaved={() => {
            setRotatingCredential(null);
            onRefresh();
          }}
        />
      ) : null}
      {editingCredential ? (
        <EditCredentialModal
          vaultId={vault.id}
          credential={editingCredential}
          onClose={() => setEditingCredential(null)}
          onSaved={() => {
            setEditingCredential(null);
            onRefresh();
          }}
        />
      ) : null}
      {editVaultOpen ? (
        <VaultEditModal
          vault={vault}
          onClose={() => setEditVaultOpen(false)}
          onSaved={() => {
            setEditVaultOpen(false);
            onRefresh();
          }}
        />
      ) : null}
      {deleteVaultOpen ? (
        <ConfirmDeleteModal
          title={t('detail.deleteVaultTitle')}
          subject={t('detail.subjectCount', { name: vault.name, n: vault.credentials.length, count: vault.credentials.length })}
          consequence={t('detail.deleteVaultConsequence')}
          confirmLabel={t('detail.deleteVaultConfirm')}
          onClose={() => setDeleteVaultOpen(false)}
          onConfirm={async () => {
            await deleteJson(`/v1/credential-vaults/${vault.id}`);
            onBack();
            onRefresh();
          }}
        />
      ) : null}
      {deletingCredential ? (
        <ConfirmDeleteModal
          title={t('detail.deleteCredentialTitle')}
          subject={deletingCredential.name}
          consequence={t('detail.deleteCredentialConsequence')}
          confirmLabel={t('detail.deleteCredentialConfirm')}
          onClose={() => setDeletingCredential(null)}
          onConfirm={() => deleteCredential(deletingCredential)}
        />
      ) : null}
    </section>
  );
}

function VaultEditModal({ vault, onClose, onSaved }: { vault: Vault; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('credentials');
  const [name, setName] = useState(vault.name);
  const [description, setDescription] = useState(vault.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // `display_name` is the published field; the update is a patch, so
      // fields the operator did not touch keep their stored values.
      await postJson(`/v1/credential-vaults/${vault.id}`, { display_name: name, description });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.editVaultTitle')} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          {t('modals.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} required />
          <small>{t('modals.nameHintEdit')}</small>
        </label>
        <label className="editField">
          {t('modals.description')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('modals.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving || !name.trim()}>{saving ? t('modals.saving') : t('modals.saveChanges')}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Edit one credential. The published patch takes `display_name` plus an
 * `auth` object in the credential's existing `auth.type` — the type itself is
 * immutable — and the write-only secret field differs per type: `token` for
 * bearer, `access_token` for MCP OAuth, `secret_value` for environment
 * variables. Structural fields (`mcp_server_url`, `secret_name`) are locked
 * after creation, so the form shows them read-only.
 */
function EditCredentialModal({ vaultId, credential, onClose, onSaved }: { vaultId: string; credential: VaultCredential; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('credentials');
  const [name, setName] = useState(credential.name);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const publishedType = credential.auth_type === 'bearer_token' ? 'static_bearer' : credential.auth_type;
  const secretField = credential.auth_type === 'environment_variable' ? 'secret_value' : credential.auth_type === 'mcp_oauth' ? 'access_token' : 'token';
  const secretLabel = credential.auth_type === 'environment_variable' ? t('modals.secretLabel.variable') : credential.auth_type === 'mcp_oauth' ? t('modals.secretLabel.oauth') : t('modals.secretLabel.bearer');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials/${credential.id}`, {
        display_name: name,
        auth: {
          type: publishedType,
          // The secret field is write-only: leaving it blank keeps the stored
          // secret; a non-empty value rotates it in place.
          ...(secret.trim() ? { [secretField]: secret } : {}),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.editCredentialTitle')} subtitle={t('modals.editCredentialSubtitle', { type: authLabel(t, credential.auth_type) })} onClose={onClose}>
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          {t('modals.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {credential.auth_type === 'mcp_oauth' ? (
          <label className="editField">
            {t('modals.mcpServerUrl')}
            <input value={credential.mcp_server_url} disabled />
            <small>{t('modals.mcpServerUrlLocked')}</small>
          </label>
        ) : null}
        {credential.auth_type === 'environment_variable' ? (
          <label className="editField">
            {t('modals.variableName')}
            <input value={credential.variable_name} disabled />
            <small>{t('modals.variableNameLocked')}</small>
          </label>
        ) : null}
        <label className="editField">
          {secretLabel}
          <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={credential.value_hint || t('modals.secretPlaceholder')} />
          <small>{t('modals.secretHint')}</small>
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('modals.cancel')}</button>
          <button className="button primary" type="submit" disabled={saving}>{saving ? t('modals.saving') : t('modals.saveChanges')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AddCredentialModal({ vaultId, onClose, onSaved }: { vaultId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('credentials');
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<CredentialAuthType>('mcp_oauth');
  const [mcpServerUrl, setMcpServerUrl] = useState('');
  const [variableName, setVariableName] = useState('');
  const [value, setValue] = useState('');
  const [networkType, setNetworkType] = useState<'limited' | 'unrestricted'>('limited');
  const [allowedHosts, setAllowedHosts] = useState('');
  const [injectHeaders, setInjectHeaders] = useState(true);
  const [injectBody, setInjectBody] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [registryQuery, setRegistryQuery] = useState('');

  const filteredRegistry = MCP_REGISTRY_OPTIONS.filter((option) => {
    const q = registryQuery.toLowerCase();
    return option.name.toLowerCase().includes(q) || option.url.toLowerCase().includes(q);
  });
  const needsSecretAcknowledgement = authType !== 'mcp_oauth';
  const canSubmit = authType === 'mcp_oauth'
    ? Boolean(mcpServerUrl.trim())
    : authType === 'bearer_token'
      ? Boolean(value.trim() && acknowledged)
      : Boolean(variableName.trim() && value.trim() && acknowledged);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials`, {
        name: name.trim() || undefined,
        auth_type: authType,
        ...(authType === 'mcp_oauth' ? { mcp_server_url: mcpServerUrl } : {}),
        ...(authType === 'environment_variable' ? { variable_name: variableName } : {}),
        ...(authType !== 'mcp_oauth' ? {
          value,
          network: { type: networkType, allowed_hosts: splitCsv(allowedHosts) },
          injection_locations: [
            ...(injectHeaders ? ['request_headers'] : []),
            ...(injectBody ? ['request_body'] : []),
          ],
        } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.addTitle')} subtitle={t('modals.addSubtitle')} onClose={onClose} size="medium">
      <form className="credentialForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          <span>{t('modals.name')} <small className="optionalPill">{t('modals.optional')}</small></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('modals.namePlaceholderExample')} />
        </label>
        <div className="editField">
          <span>{t('modals.typeField')}</span>
          <ConsoleSelect
            label={t('modals.typeField')}
            value={authType}
            onChange={(next) => setAuthType(next as CredentialAuthType)}
            options={[
              { value: 'mcp_oauth', label: t('authTypes.mcp_oauth') },
              { value: 'bearer_token', label: t('authTypes.bearer_token') },
              { value: 'environment_variable', label: t('authTypes.environment_variable') },
            ]}
          />
        </div>

        {authType === 'mcp_oauth' ? (
          <div className="mcpRegistryPanel">
            <div className="pickerSearch registrySearch">
              <Search size={18} />
              <input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder={t('modals.registryFilter')} />
            </div>
            <div className="registryList">
              {filteredRegistry.map((option) => (
                <button
                  type="button"
                  key={option.url}
                  onClick={() => {
                    setMcpServerUrl(option.url);
                    if (!name.trim()) setName(option.name);
                  }}
                >
                  <span className="registryIcon">{option.name.slice(0, 1)}</span>
                  <span>
                    <strong>{option.name}</strong>
                    <small>{option.url}</small>
                  </span>
                </button>
              ))}
            </div>
            <label className="editField compactField">
              {t('modals.customMcpUrl')} <RequiredMark />
              <input value={mcpServerUrl} onChange={(event) => setMcpServerUrl(event.target.value)} placeholder="https://mcp.example.com" required />
            </label>
          </div>
        ) : null}

        {authType === 'bearer_token' ? (
          <label className="editField">
            {t('modals.token')} <RequiredMark />
            <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('modals.tokenPlaceholder')} required />
          </label>
        ) : null}

        {authType === 'environment_variable' ? (
          <div className="credentialGrid">
            <label className="editField">
              {t('modals.variableName')} <RequiredMark />
              <input value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="MY_API_KEY" required />
            </label>
            <label className="editField">
              {t('modals.value')} <RequiredMark />
              <input value={value} onChange={(event) => setValue(event.target.value)} required />
            </label>
          </div>
        ) : null}

        {needsSecretAcknowledgement ? (
          <>
            <div className="credentialSection">
              <h3>{t('modals.networking')}</h3>
              <div className="segment credentialSegment">
                <button type="button" className={networkType === 'limited' ? 'active' : ''} aria-pressed={networkType === 'limited'} onClick={() => setNetworkType('limited')}>{t('modals.limited')}</button>
                <button type="button" className={networkType === 'unrestricted' ? 'active' : ''} aria-pressed={networkType === 'unrestricted'} onClick={() => setNetworkType('unrestricted')}>{t('modals.unrestricted')}</button>
              </div>
              <label className="editField">
                {t('modals.allowedHosts')}
                <textarea value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} placeholder={t('modals.allowedHostsPlaceholder')} />
                <small>{t('modals.allowedHostsHint')}</small>
              </label>
            </div>
            <div className="credentialSection">
              <h3>{t('modals.injection')}</h3>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectHeaders} onChange={(event) => setInjectHeaders(event.target.checked)} />
                {t('modals.requestHeaders')}
              </label>
              <label className="checkboxLine">
                <input type="checkbox" checked={injectBody} onChange={(event) => setInjectBody(event.target.checked)} />
                {t('modals.requestBody')}
              </label>
              <p>{t('modals.injectionHint')}</p>
            </div>
            <div className="warningNotice">
              <Info size={18} />
              <span>{t('modals.credentialSharedWarning')} <a href="#api-keys">{t('modals.readGuidance')}</a>.</span>
            </div>
            <label className="checkboxLine acknowledgement">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              {t('modals.acknowledge')}
            </label>
          </>
        ) : null}

        <div className="modalActions stickyActions">
          <button className="button primary" type="submit" disabled={saving || !canSubmit}>{saving ? t('modals.adding') : t('modals.addSubmit')}</button>
        </div>
      </form>
    </Modal>
  );
}

function CredentialAuthCell({ credential }: { credential: VaultCredential }) {
  const { t } = useTranslation('credentials');
  const secondary = credential.auth_type === 'mcp_oauth'
    ? credential.mcp_server_url
    : credential.auth_type === 'environment_variable'
      ? credential.variable_name
      : credential.value_hint;
  return (
    <span className="authCell">
      <strong>{authLabel(t, credential.auth_type)}</strong>
      {secondary ? <small>{secondary}</small> : null}
    </span>
  );
}

function RotateCredentialModal({
  vaultId,
  credential,
  onClose,
  onSaved,
}: {
  vaultId: string;
  credential: VaultCredential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('credentials');
  const [value, setValue] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canSubmit = value.trim().length > 0 && acknowledged && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await postJson(`/v1/credential-vaults/${vaultId}/credentials/${credential.id}/rotate`, {
        value,
        actor: 'console',
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.rotateTitle')} subtitle={t('modals.rotateSubtitle')} onClose={onClose} size="medium">
      <form className="credentialForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner">{error}</div> : null}
        <div className="readonlyFields modalFactGrid">
          <div className="readonlyField"><strong>{t('modals.rotateFields.credential')}</strong><span>{credential.name || credential.id}</span></div>
          <div className="readonlyField"><strong>{t('modals.rotateFields.type')}</strong><span>{authLabel(t, credential.auth_type)}</span></div>
          <div className="readonlyField"><strong>{t('modals.rotateFields.currentHint')}</strong><span>{credential.value_hint || t('modals.notSet')}</span></div>
        </div>
        <label className="editField">
          {t('modals.newSecret')} <RequiredMark />
          <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('modals.newSecretPlaceholder')} type="password" required />
        </label>
        <label className="checkboxLine">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>{t('modals.rotateAck')}</span>
        </label>
        <div className="modalActions">
          <button className="button outline" type="button" onClick={onClose}>{t('modals.cancel')}</button>
          <button className="button primary" type="submit" disabled={!canSubmit}>{saving ? t('modals.rotating') : t('modals.rotateSubmit')}</button>
        </div>
      </form>
    </Modal>
  );
}

function splitCsv(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}
