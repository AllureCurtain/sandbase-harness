import { Plus, Send } from 'lucide-react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionDisplayStatus } from './conversation';

/**
 * The message composer at the foot of the session timeline. A terminal or
 * archived session renders a closed notice with a link to start a new one;
 * an idle session explains a retry-exhausted or budget stop inline because
 * both resolve through this composer (send again, or raise the budget).
 */
export function SessionComposer({
  displayStatus,
  idleStopReason,
  messageDraft,
  messageError,
  sendingMessage,
  canSendMessage,
  onDraft,
  onSend,
  onNewSession,
  onAdjustBudget,
}: {
  displayStatus: SessionDisplayStatus;
  idleStopReason: string | undefined;
  messageDraft: string;
  messageError: string;
  sendingMessage: boolean;
  canSendMessage: boolean;
  onDraft: (value: string) => void;
  onSend: (event?: FormEvent) => void;
  onNewSession: () => void;
  onAdjustBudget: () => void;
}) {
  const { t } = useTranslation('sessions');
  if (displayStatus === 'terminated' || displayStatus === 'archived') {
    return (
      <div className="sessionComposerClosed" role="note">
        <span>
          {t('detail.composer.closed', { status: displayStatus })}
        </span>
        <button className="button secondary" type="button" onClick={onNewSession}>
          <Plus size={16} />{t('detail.composer.newSession')}
        </button>
      </div>
    );
  }
  return (
    <form className="sessionComposer" onSubmit={(event) => onSend(event)}>
      {displayStatus === 'idle' && idleStopReason === 'retries_exhausted' ? (
        <div className="sessionComposerHint" role="note">
          {t('detail.composer.retriesExhausted')}
        </div>
      ) : null}
      {displayStatus === 'idle' && idleStopReason === 'budget_reached' ? (
        <div className="sessionComposerHint" role="note">
          {t('detail.composer.budgetReached')}
          <button className="linkButton" type="button" onClick={onAdjustBudget}>{t('detail.composer.adjustBudget')}</button>
        </div>
      ) : null}
      <textarea
        value={messageDraft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder={t('detail.composer.placeholder')}
        aria-label={t('detail.composer.placeholder')}
        disabled={sendingMessage}
      />
      <button className="button primary" type="submit" disabled={!canSendMessage}>
        <Send size={16} />
        {sendingMessage ? t('detail.composer.sending') : t('detail.composer.send')}
      </button>
      {messageError ? <div className="sessionComposerError">{messageError}</div> : null}
    </form>
  );
}
