import type { ApiSessionStatus, SessionEvent, SessionStatus } from '@/types/session.js';

export const STATUS_PROJECTION: Record<SessionStatus, {
  wire: ApiSessionStatus;
  event: SessionEvent['type'] | undefined;
  terminal: boolean;
}> = {
  queued: { wire: 'idle', event: undefined, terminal: false },
  running: { wire: 'running', event: 'session.status_running', terminal: false },
  retrying: { wire: 'rescheduling', event: 'session.status_rescheduled', terminal: false },
  paused: { wire: 'idle', event: 'session.status_idle', terminal: false },
  requires_action: { wire: 'idle', event: 'session.status_idle', terminal: false },
  completed: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  failed: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  cancelled: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  timed_out: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  cleanup_pending: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  archived: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
};

export function eventTypeForStatus(status: SessionStatus): SessionEvent['type'] | undefined {
  return STATUS_PROJECTION[status].event;
}

/**
 * The `session.thread_status_*` counterpart of {@link eventTypeForStatus}.
 *
 * The same internal status drives both names: a thread transitions through
 * the same lifecycle a session does, and the wire distinguishes only whose
 * transition it reports. `queued` maps to no event — a thread that exists
 * but has not run publishes `session.thread_created`, not a status event.
 */
export function threadEventTypeForStatus(status: SessionStatus): SessionEvent['type'] | undefined {
  switch (status) {
    case 'running':
      return 'session.thread_status_running';
    case 'retrying':
      return 'session.thread_status_rescheduled';
    case 'paused':
    case 'requires_action':
      return 'session.thread_status_idle';
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'timed_out':
    case 'cleanup_pending':
    case 'archived':
      return 'session.thread_status_terminated';
    default:
      return undefined;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  );
}
