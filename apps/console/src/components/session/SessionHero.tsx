import { Archive, ChevronDown, Clock, Cloud, Monitor, PauseCircle, Settings, Square, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResourceBadge, StatusPill } from '../Common';
import { formatDuration, relativeDate, shortId } from '../../lib/format';
import type { Agent, Session } from '../../types';
import type { SessionDisplayStatus } from './conversation';

export type SessionUsageReceipt = {
  inputTokens: number;
  outputTokens: number;
  /** List cost amount in cents, when the runtime reports one. */
  costAmount?: string;
  costCurrency?: string;
};

/**
 * The session header: breadcrumb, title/status pill, agent and environment
 * badges, and the Actions menu (settings, define outcome, interrupt, archive,
 * delete). While a turn is live the run-state strip below keeps the one
 * action that matters — Interrupt — resident instead of buried in the menu.
 */
export function SessionHero({
  session,
  displayStatus,
  agent,
  environmentName,
  usage,
  onBack,
  onOpenAgent,
  onSettings,
  onDefineOutcome,
  onInterrupt,
  onArchive,
  onDelete,
}: {
  session: Session;
  displayStatus: SessionDisplayStatus;
  agent: Agent | undefined;
  environmentName?: string;
  usage?: SessionUsageReceipt;
  onBack: () => void;
  onOpenAgent: (agent: Agent) => void;
  onSettings: () => void;
  onDefineOutcome: () => void;
  onInterrupt: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <>
      <div className="sessionCrumb">
        <button type="button" className="textButton" onClick={onBack}>Sessions</button>
        <span>/</span>
        <strong>{shortId(session.id)}</strong>
      </div>

      <div className="sessionHero">
        <div className="sessionHeroMain">
          <div className="titleLine">
            <h1>{session.id}</h1>
            <StatusPill status={displayStatus} />
          </div>
          <div className="sessionMetaRow">
            <button className="resourceBadge" type="button" onClick={() => agent ? onOpenAgent(agent) : undefined}>
              <Monitor size={15} />
              {session.agent.name}
            </button>
            <ResourceBadge icon={<Cloud size={15} />} label={environmentName ?? session.environment_id} />
            <span className="sessionTimeMeta"><Clock size={15} /><span>{relativeDate(session.created_at)} · {formatDuration(session.created_at, session.updated_at)}</span></span>
          </div>
        </div>
        <div className="sessionHeroActions">
          <div className="menuWrap">
            <button className="secondaryButton largeAction" type="button" onClick={() => setActionsOpen((open) => !open)}>
              Actions <ChevronDown size={16} />
            </button>
            {actionsOpen ? (
              <div className="agentMenu sessionActionsMenu">
                <button type="button" onClick={() => { setActionsOpen(false); onSettings(); }}><Settings size={18} />Session settings</button>
                {displayStatus !== 'terminated' && displayStatus !== 'archived' ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onDefineOutcome(); }}><Target size={18} />Define outcome</button>
                ) : null}
                <button type="button" onClick={() => { setActionsOpen(false); onInterrupt(); }}><Square size={18} />Send interrupt</button>
                {!session.archived_at ? (
                  <button type="button" onClick={() => { setActionsOpen(false); onArchive(); }}><Archive size={18} />Archive session</button>
                ) : null}
                <button type="button" className="dangerMenuItem" onClick={() => { setActionsOpen(false); onDelete(); }}><Trash2 size={18} />Delete session</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <RunStateStrip displayStatus={displayStatus} usage={usage} onInterrupt={onInterrupt} />
    </>
  );
}

/**
 * The live-run readout: what the session is doing right now, what it has
 * cost so far, and — while it is doing something — the always-visible
 * Interrupt. An idle, finished session renders nothing here.
 */
function RunStateStrip({
  displayStatus,
  usage,
  onInterrupt,
}: {
  displayStatus: SessionDisplayStatus;
  usage?: SessionUsageReceipt;
  onInterrupt: () => void;
}) {
  const live = displayStatus === 'running' || displayStatus === 'awaiting_action' || displayStatus === 'rescheduling';
  const receipt = usage ? formatUsageReceipt(usage) : '';
  if (!live && !receipt) return null;
  return (
    <div className="runStateStrip" role="status">
      {live ? (
        <span className="runStatePill">
          {displayStatus === 'awaiting_action' ? (
            <><PauseCircle size={15} /> Needs approval</>
          ) : displayStatus === 'rescheduling' ? (
            <><Clock size={15} /> Rescheduling</>
          ) : (
            <><span className="runDot" aria-hidden="true" /> Running</>
          )}
        </span>
      ) : null}
      {receipt ? <span className="costReceipt">{receipt}</span> : null}
      <span className="spacer" />
      {live ? (
        <button className="dangerButton compactButton" type="button" onClick={onInterrupt}>
          <Square size={13} /> Interrupt
        </button>
      ) : null}
    </div>
  );
}

function formatUsageReceipt(usage: SessionUsageReceipt): string {
  const parts = [`${formatTokenCount(usage.inputTokens)} in`, `${formatTokenCount(usage.outputTokens)} out`];
  if (usage.costAmount !== undefined) {
    const usd = Number(usage.costAmount) / 100;
    if (Number.isFinite(usd)) parts.push(`$${usd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
