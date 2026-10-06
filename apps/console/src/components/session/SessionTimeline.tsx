import { ChevronDown, Copy, Download, Keyboard, MessageSquare, Search, Info, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingState } from '../Common';
import { EmptyState } from '../console-ui';
import { eventKind, eventText, eventTitle, MarkdownMessage, renderEventBody } from './eventRenderers';
import { downloadJson } from '../../lib/format';
import { modelErrorHint, sessionErrorCode } from '../../lib/modelErrorHints';
import type { SessionEvent } from '../../types';
import {
  SESSION_EVENT_KINDS,
  conversationEntries,
  conversationMessages,
  eventLabel,
  eventTime,
  toggleSet,
  type SessionEventKind,
} from './conversation';
import { ConversationToolCard } from './ApprovalCard';
import type { StreamConnection } from './useSessionStream';

/**
 * The session's event timeline: the Transcript conversation pane with its
 * streaming previews and follow-scroll, and the Debug pane with the kind
 * filter, minimap, event list, and inspector. Pure presentation — the event
 * data arrives from `useSessionStream`; approvals are delegated to the page.
 */
export function SessionTimeline({
  sessionId,
  events,
  streamingText,
  loadingEvents,
  eventError,
  streamConnection,
  agentName,
  selectedEvent,
  onSelectEvent,
  confirmingToolIds,
  confirmedToolIds,
  onConfirm,
  onSubmitResult,
  composer,
}: {
  sessionId: string;
  events: SessionEvent[];
  streamingText: Record<string, Record<number, string>>;
  loadingEvents: boolean;
  eventError: string;
  streamConnection: StreamConnection;
  agentName?: string;
  /** Inspector selection. The stream hook owns it so a load can re-pin it. */
  selectedEvent: SessionEvent | null;
  onSelectEvent: (id: string | null) => void;
  confirmingToolIds: Set<string>;
  confirmedToolIds: Set<string>;
  onConfirm: (toolUseId: string, result: 'allow' | 'deny') => void;
  onSubmitResult: (toolUseId: string, customToolUseEventId: string, text: string, isError: boolean) => void;
  composer: ReactNode;
}) {
  const { t } = useTranslation('sessions');
  const [mode, setMode] = useState<'transcript' | 'debug'>('transcript');
  const [detailMode, setDetailMode] = useState<'rendered' | 'raw'>('rendered');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<SessionEventKind>>(new Set(SESSION_EVENT_KINDS));
  const [query, setQuery] = useState('');
  const conversationListRef = useRef<HTMLDivElement>(null);
  const shouldFollowConversation = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const allEventKindsSelected = selectedKinds.size === SESSION_EVENT_KINDS.length;
  const eventFilterLabel = allEventKindsSelected
    ? t('detail.timeline.filterAll')
    : selectedKinds.size === 0
      ? t('detail.timeline.filterNone')
      : t('detail.timeline.filterCount', { n: selectedKinds.size, count: selectedKinds.size });

  useEffect(() => {
    // Entering a session always starts pinned to the latest message.
    initialScrollDoneRef.current = false;
    shouldFollowConversation.current = true;
  }, [sessionId]);

  useEffect(() => {
    if (loadingEvents) return;
    const list = conversationListRef.current;
    if (!list || !shouldFollowConversation.current) return;
    const frame = window.requestAnimationFrame(() => {
      // The first scroll after entering a session jumps instantly instead of
      // animating from the top, and waits one extra frame so the freshly
      // rendered transcript has its full height before measuring.
      const instant = !initialScrollDoneRef.current;
      initialScrollDoneRef.current = true;
      window.requestAnimationFrame(() => {
        list.scrollTo({ top: list.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
        setShowJumpToLatest(false);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, streamingText, loadingEvents]);

  const visibleEvents = events.filter((event) => {
    const kind = eventKind(event);
    if (mode === 'transcript' && !['user', 'agent', 'tool', 'error'].includes(kind)) return false;
    if (!selectedKinds.has(kind)) return false;
    const text = `${event.type} ${eventText(event)} ${event.id}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  return (
    <>
      <div className="sessionToolbar">
        <div className="segment compactSegment">
          <button type="button" className={mode === 'transcript' ? 'active' : ''} onClick={() => setMode('transcript')}>{t('detail.timeline.transcript')}</button>
          <button type="button" className={mode === 'debug' ? 'active' : ''} onClick={() => setMode('debug')}>{t('detail.timeline.debug')}</button>
        </div>
        <div className="filterWrap">
          <button className="filterButton" type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}>
            <span className="filterButtonLabel"><span className="filterButtonDot" />{eventFilterLabel}</span>
            <ChevronDown size={15} />
          </button>
          {filterOpen ? (
            <div className="eventFilterMenu" role="group" aria-label={t('detail.timeline.filterHint')}>
              <div className="eventFilterHeader">
                <strong>{t('detail.timeline.showEvents')}</strong>
                <span>{t('detail.timeline.filterSummary', { n: selectedKinds.size, total: SESSION_EVENT_KINDS.length })}</span>
              </div>
              <div className="eventFilterOptions">
                {SESSION_EVENT_KINDS.map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={selectedKinds.has(kind)}
                      onChange={(event) => toggleSet(kind, event.target.checked, setSelectedKinds)}
                    />
                    <span className="eventFilterCheck" aria-hidden="true">✓</span>
                    <span>{kind[0].toUpperCase() + kind.slice(1)}</span>
                  </label>
                ))}
              </div>
              <div className="eventFilterFooter">
                <span>{t('detail.timeline.filterHint')}</span>
                <button type="button" onClick={() => setSelectedKinds(new Set(SESSION_EVENT_KINDS))}>{t('detail.timeline.resetFilters')}</button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="sessionSearch">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('detail.timeline.searchEvents')} aria-label={t('detail.timeline.searchEvents')} />
        </div>
        <div className="sessionIconActions">
          <button className="iconButton" type="button" title={t('detail.timeline.shortcuts')}><Keyboard size={18} /></button>
          <button className="iconButton" type="button" title={t('detail.timeline.copySessionId')} onClick={() => void navigator.clipboard?.writeText(sessionId)}><Copy size={18} /></button>
          <button className="iconButton" type="button" title={t('detail.timeline.downloadJson')} onClick={() => downloadJson(`${sessionId}-events.json`, events)}><Download size={18} /></button>
        </div>
      </div>

      <div className="sessionTimeline">
        {mode === 'transcript' ? (
          <div className="conversationPane">
            <div className="conversationHeader">
              <div>
                <strong>{t('detail.timeline.conversation')}</strong>
                <span>{t('detail.timeline.messageCount', { n: conversationMessages(events).length, count: conversationMessages(events).length })}</span>
              </div>
              <span className={`streamStatus ${streamConnection}`}>
                <span className="streamStatusDot" />
                {streamConnection === 'connected' ? t('detail.timeline.live') : streamConnection === 'reconnecting' ? t('detail.timeline.reconnecting') : t('detail.timeline.connecting')}
              </span>
            </div>
            {eventError ? <div className="banner error inlineBanner">{eventError}</div> : null}
            {loadingEvents ? <LoadingState /> : null}
            {!loadingEvents ? (
              <div
                ref={conversationListRef}
                className="conversationList"
                aria-live="polite"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
                  shouldFollowConversation.current = nearBottom;
                  setShowJumpToLatest(!nearBottom);
                }}
              >
                {conversationEntries(events).map((entry) => entry.role === 'tool' ? (
                  <ConversationToolCard
                    key={entry.id}
                    entry={entry}
                    confirmingToolIds={confirmingToolIds}
                    confirmedToolIds={confirmedToolIds}
                    onConfirm={onConfirm}
                    onSubmitResult={onSubmitResult}
                  />
                ) : (
                  <article key={entry.id} className={`conversationMessage ${entry.role}`}>
                    <div className="conversationMessageMeta">
                      <span>{entry.role === 'user' ? t('detail.timeline.roleYou') : entry.role === 'error' ? t('detail.timeline.roleSession') : agentName ?? t('detail.timeline.roleAgent')}</span>
                      <time>{eventTime(entry.event)}</time>
                    </div>
                    <div className="conversationBubble">
                      {entry.role === 'agent'
                        ? (
                          <MarkdownMessage text={entry.text} />
                        )
                        : (entry.text || t('detail.timeline.noMessageContent'))}
                    </div>
                    {entry.role === 'error' ? <ModelErrorHint event={entry.event} /> : null}
                  </article>
                ))}
                {Object.entries(streamingText).map(([eventId, blocks]) => {
                  const text = Object.keys(blocks)
                    .map(Number)
                    .sort((a, b) => a - b)
                    .map((index) => blocks[index])
                    .join('');
                  return (
                    <article key={eventId} className="conversationMessage agent streamingMessage">
                      <div className="conversationMessageMeta"><span>{agentName ?? t('detail.timeline.roleAgent')}</span><span>{t('detail.timeline.generatingDots')}</span></div>
                      <div className="conversationBubble">{text || <span className="typingIndicator" aria-label={t('detail.timeline.generating')}><i /><i /><i /></span>}</div>
                    </article>
                  );
                })}
                {conversationMessages(events).length === 0 && Object.keys(streamingText).length === 0 ? (
                  <EmptyState icon={MessageSquare} title={t('detail.timeline.startConversation')} />
                ) : null}
              </div>
            ) : null}
            {showJumpToLatest ? (
              <button
                type="button"
                className="conversationJumpLatest"
                aria-label={t('detail.timeline.jumpLatest')}
                onClick={() => {
                  shouldFollowConversation.current = true;
                  setShowJumpToLatest(false);
                  conversationListRef.current?.scrollTo({ top: conversationListRef.current.scrollHeight, behavior: 'smooth' });
                }}
              >
                {t('detail.timeline.newMessages')}
              </button>
            ) : null}
            {composer}
          </div>
        ) : (
          <>
            <div className="eventMiniMap">
              {events.slice(0, 42).map((event) => <span key={event.id} className={`miniEvent ${eventKind(event)}`} title={event.type} />)}
            </div>
            <div className="eventPane">
              <div className="eventList">
                {eventError ? <div className="banner error inlineBanner">{eventError}</div> : null}
                {loadingEvents ? <LoadingState /> : null}
                {!loadingEvents && visibleEvents.map((event) => (
                  <button type="button" key={event.id} className={`eventRow ${selectedEvent?.id === event.id ? 'active' : ''}`} onClick={() => onSelectEvent(event.id)}>
                    <span className={`eventType ${eventKind(event)}`}>{eventLabel(event, mode)}</span>
                    <strong>{eventTitle(event)}</strong>
                    <time>{eventTime(event)}</time>
                  </button>
                ))}
                {!loadingEvents && visibleEvents.length === 0 ? <EmptyState icon={MessageSquare} title={t('detail.timeline.noEvents')} /> : null}
              </div>
              <div className="eventInspector">
                {selectedEvent ? (
                  <>
                    <div className="eventInspectorHeader">
                      <button className="iconButton" type="button" title={t('detail.timeline.closeSelection')} onClick={() => onSelectEvent(null)}><X size={18} /></button>
                      <div><span className={`eventType ${eventKind(selectedEvent)}`}>{selectedEvent.type}</span><h2>{eventTitle(selectedEvent)}</h2><p>{eventTime(selectedEvent)}</p></div>
                      <div className="inspectorViewControl"><span>{t('detail.timeline.view')}</span><div className="segment tinySegment"><button type="button" className={detailMode === 'rendered' ? 'active' : ''} onClick={() => setDetailMode('rendered')}>{t('detail.timeline.preview')}</button><button type="button" className={detailMode === 'raw' ? 'active' : ''} onClick={() => setDetailMode('raw')}>{t('detail.timeline.raw')}</button></div></div>
                    </div>
                    {detailMode === 'rendered' ? <DebugEventContent event={selectedEvent} /> : <pre className="rawEvent">{JSON.stringify(selectedEvent, null, 2)}</pre>}
                  </>
                ) : <EmptyState icon={MessageSquare} title={t('detail.timeline.selectEvent')} />}
              </div>
            </div>
            {composer}
          </>
        )}
      </div>
    </>
  );
}

function DebugEventContent({ event }: { event: SessionEvent }) {
  return <>{renderEventBody(event)}</>;
}

/**
 * The repair for a model failure, under the message that reported it.
 *
 * The runtime names what is wrong (the variable, the model id) but not where to go
 * in this Console, so the hint is added here rather than in the message. A failure
 * that is not about the model renders nothing at all.
 */
function ModelErrorHint({ event }: { event: SessionEvent }) {
  const hint = modelErrorHint(sessionErrorCode(event));
  if (!hint) return null;
  return (
    <div className="modelErrorHint">
      <Info size={14} />
      <span>{hint}</span>
    </div>
  );
}
