import { MessageSquare, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, PageBody, PageHeader, StatusDot, type Tone } from '../console-ui';
import { CopyableId, ListToolbar, listSummary, SearchField } from '../list-ui';
import { ConsoleSelect } from '../console-select';
import { formatDateShort, formatUsage, shortId } from '../../lib/format';
import type { ConsoleData, Session } from '../../types';
import './sessions.css';

function sessionTone(session: Session): Tone {
  if (session.archived_at) return 'neutral';
  if (session.status === 'running') return 'ok';
  if (session.status === 'rescheduling') return 'warning';
  return 'neutral';
}

type SessionStatusKey = 'status.running' | 'status.idle' | 'status.rescheduling' | 'status.terminated' | 'status.archived';

function sessionStatusKey(session: Session): SessionStatusKey {
  if (session.archived_at) return 'status.archived';
  if (session.status === 'running') return 'status.running';
  if (session.status === 'rescheduling') return 'status.rescheduling';
  if (session.status === 'terminated') return 'status.terminated';
  return 'status.idle';
}

export function Sessions({ data, onNewSession, onOpenSession }: { data: ConsoleData; onNewSession: () => void; onOpenSession: (session: Session) => void }) {
  const { t } = useTranslation('sessions');
  const { t: tPages } = useTranslation('pages');
  const { t: tCommon, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [showArchived, setShowArchived] = useState(false);
  const [agentId, setAgentId] = useState('all');
  const sessions = data.sessions.filter((session) => {
    const q = query.toLowerCase();
    if (!showArchived && session.archived_at) return false;
    const matchesStatus = status === 'all' || (status === 'active'
      ? session.status !== 'terminated'
      : session.status === status);
    const matchesAgent = agentId === 'all' || session.agent.id === agentId;
    const matchesQuery = session.id.toLowerCase().includes(q) || session.agent.name.toLowerCase().includes(q) || (session.title ?? '').toLowerCase().includes(q);
    return matchesStatus && matchesAgent && matchesQuery;
  });
  const filtering = Boolean(query) || status !== 'active' || agentId !== 'all' || showArchived;
  return (
    <section className="page-section console-page sessions-list-page" aria-labelledby="sessions-heading">
      <PageHeader
        headingId="sessions-heading"
        title={tPages('sessions.title')}
        help={tPages('sessions.description')}
        actions={(
          <button className="button primary" type="button" onClick={onNewSession}>
            <Plus size={15} aria-hidden="true" />
            {tPages('sessions.newSession')}
          </button>
        )}
      />
      <PageBody>
        <ListToolbar
          label={t('view.filterLabel')}
          summary={listSummary(tCommon, sessions.length, data.sessions.length, { locale: i18n.resolvedLanguage })}
        >
          <SearchField value={query} onChange={setQuery} placeholder={t('view.searchPlaceholder')} label={t('view.filterLabel')} />
          <ConsoleSelect
            label={t('view.agentFilter')}
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: 'all', label: t('view.statusOptions.all') },
              ...data.agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
          <ConsoleSelect
            label={t('view.status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: t('view.statusOptions.active') },
              { value: 'all', label: t('view.statusOptions.all') },
              { value: 'idle', label: t('view.statusOptions.idle') },
              { value: 'running', label: t('view.statusOptions.running') },
              { value: 'rescheduling', label: t('view.statusOptions.rescheduling') },
              { value: 'terminated', label: t('view.statusOptions.terminated') },
            ]}
          />
          <label className="checkboxLine toolbarCheck">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            {t('view.showArchived')}
          </label>
        </ListToolbar>
        {sessions.length ? (
          <div className="table-frame sessions-table-frame">
            <table className="data-table" aria-label={tPages('sessions.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('view.columns.id')}</th>
                  <th scope="col">{t('view.columns.name')}</th>
                  <th scope="col">{t('view.columns.status')}</th>
                  <th scope="col">{t('view.columns.agent')}</th>
                  <th scope="col">{t('view.columns.tokens')}</th>
                  <th scope="col">{t('view.columns.created')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="clickable-row" onClick={() => onOpenSession(session)}>
                    <td>
                      <strong className="monoText">{shortId(session.id)}</strong>
                    </td>
                    <td>{session.title || '—'}</td>
                    <td><StatusDot tone={sessionTone(session)} label={t(sessionStatusKey(session))} /></td>
                    <td>{session.agent.name}</td>
                    <td>{formatUsage(session.usage)}</td>
                    <td>{formatDateShort(session.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={MessageSquare}
            title={data.sessions.length && filtering ? t('list.noMatch') : t('list.noSessions')}
            action={query ? <button className="button outline" type="button" onClick={() => setQuery('')}>{tCommon('actions.clearSearch')}</button> : null}
          />
        )}
        <div className="session-card-list">
          {sessions.map((session) => (
            <div className="session-card" key={session.id}>
              <button className="session-card-open" type="button" onClick={() => onOpenSession(session)} aria-label={t('view.open', { name: session.title || session.id })}>
                <strong>{session.title || session.id}</strong>
                <span className="session-card-meta">
                  <span>{session.agent.name}</span>
                  <StatusDot tone={sessionTone(session)} label={t(sessionStatusKey(session))} />
                </span>
              </button>
              <CopyableId id={session.id} compact />
            </div>
          ))}
        </div>
      </PageBody>
    </section>
  );
}
