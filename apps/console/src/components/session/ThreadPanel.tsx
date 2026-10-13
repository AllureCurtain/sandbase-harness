import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Square, Archive } from 'lucide-react';
import { postJson } from '../../api';
import { StatusDot, type Tone } from '../console-ui';
import type { Session, SessionThread } from '../../types';

/**
 * The session's thread list — the multi-agent surface in the Console.
 *
 * Rendered beside the timeline whenever a session has more than one thread
 * (a coordinator's roster spawned children through `send_to_agent`). The
 * primary thread sits on top; each row shows the thread's agent name, wire
 * status, and usage counters once it has transitioned. Selecting a row
 * switches the timeline to that thread's own event stream; the primary row
 * returns to the session-level view.
 *
 * Row actions: an interrupt scoped by `session_thread_id`, and — for
 * non-primary idle threads — archive, which frees the concurrency slot. The
 * primary thread carries no archive action (the route refuses it with
 * `primary_thread_not_archivable`).
 *
 * The roster itself is fetched by the page through `useSessionThreads` and
 * handed down — the timeline reads the same snapshot to label tool cards
 * with their source thread.
 */

function threadTone(status: SessionThread['status'], archived: boolean): Tone {
  if (archived || status === 'terminated') return 'neutral';
  if (status === 'running') return 'ok';
  if (status === 'rescheduling') return 'warning';
  return 'pending';
}

function threadStatusLabel(status: SessionThread['status'], archived: boolean, t: (key: `detail.threads.status.${SessionThread['status']}` | 'detail.threads.archived') => string): string {
  if (archived) return t('detail.threads.archived');
  return t(`detail.threads.status.${status}`);
}

function ThreadRow({
  thread,
  isPrimary,
  selected,
  onSelect,
  onInterrupt,
  onArchive,
  acting,
}: {
  thread: SessionThread;
  isPrimary: boolean;
  selected: boolean;
  onSelect: () => void;
  onInterrupt: (thread: SessionThread) => void;
  onArchive: (thread: SessionThread) => void;
  acting: boolean;
}) {
  const { t } = useTranslation('sessions');
  const [menuOpen, setMenuOpen] = useState(false);
  const archived = thread.archived_at !== null;
  const agentName = typeof thread.agent?.name === 'string' ? thread.agent.name : thread.id;
  const usage = thread.usage;
  // Interrupt applies to anything still live; archive only to a non-primary
  // idle thread (running/retrying → thread_running, primary → refused).
  const canInterrupt = !archived && thread.status !== 'terminated';
  const canArchive = !isPrimary && !archived && thread.status === 'idle';
  const showMenu = !isPrimary || canInterrupt;

  return (
    <div className={`threadRow${selected ? ' selected' : ''}${archived ? ' archived' : ''}`}>
      <button type="button" className="threadRowMain" onClick={onSelect} aria-current={selected}>
        <span className="threadRowHead">
          <strong className="threadRowName">{agentName}</strong>
          <StatusDot tone={threadTone(thread.status, archived)} label={threadStatusLabel(thread.status, archived, t)} />
        </span>
        <span className="threadRowMeta">
          {isPrimary ? <span className="threadRowBadge">{t('detail.threads.primary')}</span> : null}
          {usage ? (
            <span>{t('detail.threads.usage', { in: usage.input_tokens, out: usage.output_tokens })}</span>
          ) : (
            <span>{t('detail.threads.notStarted')}</span>
          )}
        </span>
      </button>
      {showMenu ? (
        <div className="threadRowMenu">
          <button
            type="button"
            className="iconButton quiet"
            aria-label={t('detail.threads.actions', { name: agentName })}
            aria-expanded={menuOpen}
            disabled={acting}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen ? (
            <div className="threadMenu" role="menu">
              {canInterrupt ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={acting}
                  onClick={() => { setMenuOpen(false); onInterrupt(thread); }}
                >
                  <Square size={13} /> {t('detail.threads.interrupt')}
                </button>
              ) : null}
              {canArchive ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={acting}
                  onClick={() => { setMenuOpen(false); onArchive(thread); }}
                >
                  <Archive size={13} /> {t('detail.threads.archive')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadPanel({
  session,
  threads,
  loading,
  selectedThreadId,
  onSelectThread,
  onChanged,
}: {
  session: Session;
  /** The roster from `useSessionThreads` — this panel does not poll itself. */
  threads: SessionThread[];
  loading: boolean;
  /** `null` = the primary stream (the session-level view). */
  selectedThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
  /** Threads changed state (archived, interrupted) — parent should refresh. */
  onChanged: () => void;
}) {
  const { t } = useTranslation('sessions');
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);

  const primaryThreadId = `sth_${session.id.replace(/^sess_/, '')}`;

  // A selected thread that disappeared (deleted session, stale read) falls
  // back to the primary stream rather than showing an empty timeline.
  useEffect(() => {
    if (selectedThreadId && threads.length > 0 && !threads.some((thread) => thread.id === selectedThreadId)) {
      onSelectThread(null);
    }
  }, [threads, selectedThreadId, onSelectThread]);

  const interrupt = async (thread: SessionThread) => {
    setActing(true);
    setError('');
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/events`, {
        events: [{ type: 'user.interrupt', session_thread_id: thread.id }],
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const archive = async (thread: SessionThread) => {
    setActing(true);
    setError('');
    try {
      await postJson(
        `/v1/sessions/${encodeURIComponent(session.id)}/threads/${encodeURIComponent(thread.id)}/archive`,
        {},
      );
      if (selectedThreadId === thread.id) onSelectThread(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  // Single-threaded sessions have nothing to list — the primary row alone
  // would be the session's own stream restated.
  if (!loading && threads.length <= 1) return null;

  return (
    <aside className="threadPanel" aria-label={t('detail.threads.title')}>
      <div className="threadPanelHeader">
        <strong>{t('detail.threads.title')}</strong>
        <span>{t('detail.threads.count', { n: threads.length })}</span>
      </div>
      {error ? <div className="banner error inlineBanner">{error}</div> : null}
      <div className="threadList">
        {threads.map((thread) => {
          const isPrimary = thread.id === primaryThreadId || thread.parent_thread_id === null;
          return (
            <ThreadRow
              key={thread.id}
              thread={thread}
              isPrimary={isPrimary}
              selected={isPrimary ? selectedThreadId === null : selectedThreadId === thread.id}
              onSelect={() => onSelectThread(isPrimary ? null : thread.id)}
              onInterrupt={(target) => void interrupt(target)}
              onArchive={(target) => void archive(target)}
              acting={acting}
            />
          );
        })}
      </div>
    </aside>
  );
}
