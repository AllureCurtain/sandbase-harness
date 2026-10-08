import { Archive, Check, ChevronDown, Database, FileText, History, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { deleteJson, getJson, postJson } from '../../api';
import { EmptyState, Kpi, KpiStrip, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { ConfirmDeleteModal } from '../DangerZone';
import { Modal } from '../Modal';
import { ListToolbar, listSummary, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import { formatBytes, formatDateShort, shortId, truncateMiddle } from '../../lib/format';
import type { ConsoleData, MemoryRecord, MemoryStore, MemoryVersion } from '../../types';
import './resources.css';

function storeTone(store: MemoryStore): Tone {
  if (store.archived_at || store.status === 'archived') return 'neutral';
  return store.status === 'active' ? 'ok' : 'neutral';
}

function storeStatusLabel(t: TFunction<'memory'>, store: MemoryStore): string {
  if (store.archived_at) return t('list.statusOptions.archived');
  return store.status === 'active' ? t('list.statusOptions.active') : store.status;
}

export function MemoryStores({ data, onNew, onOpenMemoryStore }: { data: ConsoleData; onNew: () => void; onOpenMemoryStore: (store: MemoryStore) => void }) {
  const { t } = useTranslation('memory');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  // `include_archived` is the only filter the store listing publishes — it is
  // set for any view that can show archived rows, and the status narrowing +
  // text search stay client-side over the loaded pages.
  const paged = usePagedCollection<MemoryStore>(
    `/v1/memory_stores?limit=50${status === 'active' ? '' : '&include_archived=true'}`,
    data.memoryStores,
  );
  const stores = paged.items.filter((store) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || (status === 'active' ? !store.archived_at : status === 'archived' ? !!store.archived_at : store.status === status);
    const matchesQuery = store.id.toLowerCase().includes(q) || store.name.toLowerCase().includes(q) || store.description.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });
  const filtering = Boolean(query) || status !== 'active';
  const activeStores = data.memoryStores.filter((store) => store.status === 'active').length;
  const totalMemories = data.memoryStores.reduce((sum, store) => sum + store.memories.length, 0);
  const empty = (
    <EmptyState
      icon={Database}
      title={(paged.items.length || paged.loading) && filtering ? t('list.noMatch') : t('list.empty')}
      description={(paged.items.length || paged.loading) && filtering ? undefined : t('list.emptyBody')}
      action={query
        ? <button className="button outline" type="button" onClick={() => setQuery('')}>{tCommon('actions.clearSearch')}</button>
        : <button className="button primary" type="button" onClick={onNew}><Plus size={15} />{t('list.createStore')}</button>}
    />
  );
  return (
    <section className="page-section console-page memory-list-page" aria-labelledby="memory-heading">
      <PageHeader
        headingId="memory-heading"
        title={tPages('memory-stores.title')}
        help={tPages('memory-stores.description')}
        actions={(
          <button className="button primary" type="button" onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
            {tPages('memory-stores.newStore')}
          </button>
        )}
      />
      <PageBody>
        <KpiStrip label={t('list.filterLabel')}>
          <Kpi label={t('list.kpis.stores')} value={data.memoryStores.length} />
          <Kpi label={t('list.kpis.active')} value={activeStores} />
          <Kpi label={t('list.kpis.memories')} value={totalMemories} />
        </KpiStrip>
        <ListToolbar
          label={t('list.filterLabel')}
          summary={listSummary(tCommon, stores.length, paged.items.length, { hasMore: paged.hasMore, locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('list.searchPlaceholder')} label={t('list.filterLabel')} />
          <ConsoleSelect
            label={t('list.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: t('list.statusOptions.active') },
              { value: 'all', label: t('list.statusOptions.all') },
              { value: 'archived', label: t('list.statusOptions.archived') },
            ]}
          />
        </ListToolbar>
        {paged.error ? <p className="mutedLine" role="alert">{paged.error}</p> : null}
        {stores.length ? (
          <div className="table-frame memory-table-frame">
            <table className="data-table" aria-label={tPages('memory-stores.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('list.columns.id')}</th>
                  <th scope="col">{t('list.columns.name')}</th>
                  <th scope="col">{t('list.columns.status')}</th>
                  <th scope="col">{t('list.columns.created')}</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((store) => (
                  <tr key={store.id} className="clickable-row" onClick={() => onOpenMemoryStore(store)}>
                    <td><strong className="monoText">{shortId(store.id)}</strong></td>
                    <td>{store.name}</td>
                    <td><StatusDot tone={storeTone(store)} label={storeStatusLabel(t, store)} /></td>
                    <td>{formatDateShort(store.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : empty}
        <div className="mobileResourceList">
          {stores.map((store) => (
            <button className="mobileResourceCard" type="button" key={store.id} onClick={() => onOpenMemoryStore(store)} aria-label={t('list.open', { name: store.name })}>
              <span className="mobileAgentMain">
                <strong>{store.name}</strong>
                <small className="monoText">{store.id}</small>
              </span>
              <span className="mobileAgentMeta">
                <span>{t('list.memoryCount', { n: store.memories.length })}</span>
                <StatusDot tone={storeTone(store)} label={storeStatusLabel(t, store)} />
              </span>
            </button>
          ))}
          {stores.length === 0 ? empty : null}
        </div>
        {paged.hasMore ? (
          <button className="button outline loadMoreButton" type="button" onClick={paged.loadMore} disabled={paged.loadingMore}>
            {tCommon('actions.loadMore')}
          </button>
        ) : null}
      </PageBody>
    </section>
  );
}

export function MemoryStoreDetail({
  store,
  onBack,
  onRefresh,
  onNewMemory,
}: {
  store: MemoryStore;
  onBack: () => void;
  onRefresh: () => void;
  onNewMemory: () => void;
}) {
  const { t } = useTranslation('memory');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editStoreOpen, setEditStoreOpen] = useState(false);
  const [deleteStoreOpen, setDeleteStoreOpen] = useState(false);
  const selected = selectedId ? store.memories.find((memory) => memory.id === selectedId) ?? null : null;
  const [content, setContent] = useState(selected?.content ?? '');
  const totalBytes = store.memories.reduce((sum, memory) => sum + memory.content_size_bytes, 0);
  const latestMemory = [...store.memories].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];

  useEffect(() => {
    setSelectedId((current) => current && store.memories.some((memory) => memory.id === current) ? current : null);
  }, [store.id, store.memories]);

  useEffect(() => {
    setContent(selected?.content ?? '');
    setEditing(false);
    setVersionsFor(null);
  }, [selected?.id]);

  const save = async () => {
    if (!selected) return;
    await postJson(`/v1/memory_stores/${store.id}/memories/${selected.id}`, { content });
    setEditing(false);
    onRefresh();
  };

  const archiveStore = async () => {
    await postJson(`/v1/memory_stores/${store.id}/archive`, {});
    setMenuOpen(false);
    onBack();
    onRefresh();
  };

  return (
    <section className="environmentDetail memoryStoreDetail">
      <div className="detailCrumb">
        <button type="button" className="textButton" onClick={onBack}>{t('detail.back')}</button>
        <span>/</span>
        <strong>{store.name}</strong>
      </div>
      <div className="resourceHero">
        <div>
          <div className="titleLine">
            <h1>{store.name}</h1>
            <StatusDot tone={storeTone(store)} label={storeStatusLabel(t, store)} />
          </div>
          <p className="mutedLine"><span className="monoText">{shortId(store.id)}</span> · {t('detail.created', { time: formatDateShort(store.created_at) })}</p>
          {store.description ? <p className="agentDescription">{store.description}</p> : null}
        </div>
        <div className="agentHeroActions">
          <button className="button primary largeAction" type="button" onClick={onNewMemory}>
            <Plus size={15} />
            {t('detail.addMemory')}
          </button>
          <button className="button outline largeAction" type="button" onClick={() => setEditStoreOpen(true)}>
            <Pencil size={15} />
            {t('detail.edit')}
          </button>
          <div className="menuWrap">
            <button className="iconButton" type="button" onClick={() => setMenuOpen((open) => !open)} title={t('detail.actions')}>
              <MoreVertical size={18} />
            </button>
            {menuOpen ? (
              <div className="agentMenu">
                <button type="button" onClick={() => void archiveStore()}><Archive size={18} />{t('detail.archive')}</button>
                <button
                  type="button"
                  className="dangerMenuItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteStoreOpen(true);
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
        <Kpi label={t('detail.kpis.memories')} value={store.memories.length} />
        <Kpi label={t('detail.kpis.storedContext')} value={formatBytes(totalBytes)} />
        <Kpi label={t('detail.kpis.lastUpdate')} value={latestMemory ? formatDateShort(latestMemory.updated_at) : t('detail.noMemories')} />
      </KpiStrip>

      <div className="memoryBrowser tablePanel">
        <div className="memoryTree">
          <MemoryTree memories={store.memories} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        </div>
        <div className="memoryContent">
          {selected ? (
            <>
              <div className="memoryContentHeader">
                <div>
                  <h2>{selected.path}</h2>
                  <p>
                    <span className="monoText">{shortId(selected.id)}</span>
                    {' '}· {selected.content_size_bytes} B · sha256:{truncateMiddle(selected.content_sha256, 18)}
                    {' '}· {t('detail.contentHeader.updated', { time: formatDateShort(selected.updated_at) })}
                  </p>
                </div>
                <div className="toolbarActions">
                  <button
                    className="button outline"
                    type="button"
                    onClick={() => setVersionsFor((current) => current === selected.id ? null : selected.id)}
                    aria-expanded={versionsFor === selected.id}
                  >
                    <History size={14} />{t('detail.versions')}
                  </button>
                  {editing ? (
                    <>
                      <button className="button outline" type="button" onClick={() => { setEditing(false); setContent(selected.content ?? ''); }}><X size={14} />{t('detail.cancel')}</button>
                      <button className="button primary" type="button" onClick={() => void save()}><Check size={14} />{t('detail.save')}</button>
                    </>
                  ) : (
                    <button className="button outline" type="button" onClick={() => setEditing(true)}><Pencil size={14} />{t('detail.edit')}</button>
                  )}
                </div>
              </div>
              {versionsFor === selected.id ? (
                <MemoryVersionsPanel
                  storeId={store.id}
                  memory={selected}
                  onRedacted={onRefresh}
                />
              ) : null}
              {editing ? (
                <textarea className="memoryEditor" value={content} onChange={(event) => setContent(event.target.value)} />
              ) : (
                <pre className="memoryPreview">{selected.content}</pre>
              )}
            </>
          ) : store.memories.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={t('detail.noMemoriesYet')}
              description={t('detail.noMemoriesBody')}
              action={<button className="button outline" type="button" onClick={onNewMemory}><Plus size={15} />{t('detail.addMemory')}</button>}
            />
          ) : (
            <EmptyState icon={Database} title={t('detail.selectMemory')} description={t('detail.selectMemoryBody')} />
          )}
        </div>
      </div>
      {editStoreOpen ? (
        <MemoryStoreEditModal
          store={store}
          onClose={() => setEditStoreOpen(false)}
          onSaved={() => {
            setEditStoreOpen(false);
            onRefresh();
          }}
        />
      ) : null}
      {deleteStoreOpen ? (
        <MemoryStoreDeleteModal
          store={store}
          onClose={() => setDeleteStoreOpen(false)}
          onDeleted={() => {
            setDeleteStoreOpen(false);
            onBack();
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

function MemoryStoreEditModal({ store, onClose, onSaved }: { store: MemoryStore; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('memory');
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // The published update verb is POST with patch semantics: only the
      // fields the operator changed are merged server-side.
      await postJson(`/v1/memory_stores/${store.id}`, { name, description });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={t('modals.editTitle')} onClose={onClose} size="medium">
      <form className="modalForm" onSubmit={submit}>
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <label className="editField">
          {t('modals.name')}
          <input value={name} onChange={(event) => setName(event.target.value)} required />
          <small>{t('modals.nameHint')}</small>
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

function MemoryStoreDeleteModal({ store, onClose, onDeleted }: { store: MemoryStore; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation('memory');
  return (
    <ConfirmDeleteModal
      title={t('modals.deleteTitle')}
      subject={t('modals.deleteSubject', { name: store.name, n: store.memories.length })}
      consequence={t('modals.deleteConsequence')}
      confirmLabel={t('modals.deleteConfirm')}
      onClose={onClose}
      onConfirm={async () => {
        await deleteJson(`/v1/memory_stores/${store.id}`);
        onDeleted();
      }}
    />
  );
}

/**
 * The version history of one memory. Every write records a version, so this
 * panel is where the published redaction action lives: redacting clears the
 * recorded payload while keeping the version listable — except the head
 * version, whose redaction would orphan the memory's current content and is
 * refused with `memory_version_is_head`.
 */
function MemoryVersionsPanel({ storeId, memory, onRedacted }: { storeId: string; memory: MemoryRecord; onRedacted: () => void }) {
  const { t } = useTranslation('memory');
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [error, setError] = useState('');
  const [redactingId, setRedactingId] = useState<string | null>(null);

  const load = () => {
    getJson<{ data: MemoryVersion[] } | MemoryVersion[]>(
      `/v1/memory_stores/${storeId}/memory_versions?memory_id=${encodeURIComponent(memory.id)}`,
    )
      .then((page) => setVersions(Array.isArray(page) ? page : page.data ?? []))
      .catch((err: any) => setError(err?.message ?? t('detail.versionsPanel.loadError')));
  };

  useEffect(load, [storeId, memory.id]);

  const redact = async (version: MemoryVersion) => {
    setRedactingId(version.id);
    setError('');
    try {
      await postJson(`/v1/memory_stores/${storeId}/memory_versions/${version.id}/redact`, {});
      load();
      onRedacted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRedactingId(null);
    }
  };

  if (error && !versions) return <div className="banner error inlineBanner" role="alert">{error}</div>;
  if (!versions) return <p className="mutedValue">{t('detail.versionsPanel.loading')}</p>;
  if (versions.length === 0) return <p className="mutedValue">{t('detail.versionsPanel.empty')}</p>;

  return (
    <div className="memoryVersions">
      {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
      <table className="deliveriesTable">
        <thead>
          <tr>
            <th>{t('detail.versionsPanel.columns.version')}</th>
            <th>{t('detail.versionsPanel.columns.operation')}</th>
            <th>{t('detail.versionsPanel.columns.size')}</th>
            <th>{t('detail.versionsPanel.columns.created')}</th>
            <th>{t('detail.versionsPanel.columns.redacted')}</th>
            <th>{t('detail.versionsPanel.columns.action')}</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => {
            const isHead = version.id === memory.memory_version_id;
            return (
              <tr key={version.id}>
                <td><code>{truncateMiddle(version.id, 18)}</code>{isHead ? <small className="mutedValue"> {t('detail.versionsPanel.current')}</small> : null}</td>
                <td><code>{version.operation}</code></td>
                <td>{version.content_size_bytes !== null ? `${version.content_size_bytes} B` : '-'}</td>
                <td>{formatDateShort(version.created_at)}</td>
                <td>{version.redacted_at ? formatDateShort(version.redacted_at) : '-'}</td>
                <td>
                  <button
                    className="button ghost"
                    type="button"
                    disabled={isHead || Boolean(version.redacted_at) || redactingId === version.id}
                    title={isHead ? t('detail.versionsPanel.cannotRedactHead') : version.redacted_at ? t('detail.versionsPanel.alreadyRedacted') : t('detail.versionsPanel.redactTooltip')}
                    onClick={() => void redact(version)}
                  >
                    {redactingId === version.id ? t('detail.versionsPanel.redacting') : t('detail.versionsPanel.redact')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MemoryTree({ memories, selectedId, onSelect }: { memories: MemoryRecord[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation('memory');
  const groups = useMemo(() => groupMemoriesByFolder(memories), [memories]);
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title={t('detail.treeEmpty')}
        description={t('detail.treeEmptyBody')}
      />
    );
  }
  return (
    <>
      {groups.map((group) => (
        <div className="memoryFolder" key={group.folder}>
          <div className="memoryFolderTitle">
            <ChevronDown size={16} />
            <Database size={16} />
            <span>{group.folder}</span>
          </div>
          {group.items.map((memory) => (
            <button
              type="button"
              key={memory.id}
              className={`memoryNode ${selectedId === memory.id ? 'active' : ''}`}
              onClick={() => onSelect(memory.id)}
            >
              <FileText size={15} />
              <span>{memoryName(memory.path)}</span>
              <small>{memory.content_size_bytes} B</small>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function groupMemoriesByFolder(memories: MemoryRecord[]): Array<{ folder: string; items: MemoryRecord[] }> {
  const folders = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const segments = memory.path.split('/').filter(Boolean);
    const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : 'root';
    const items = folders.get(folder) ?? [];
    items.push(memory);
    folders.set(folder, items);
  }
  return [...folders.entries()].map(([folder, items]) => ({ folder, items }));
}

function memoryName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
