/**
 * Thread-scoped event log writer.
 *
 * The strategy's event surface is `EventLogWriter`, and nothing in the engine
 * loop names a thread: a `send_to_agent` child runs the same `DefaultStrategy`
 * the primary thread runs, just against a different slice of the log. The seam
 * is therefore the writer, not the loop — this facade wraps the real
 * `EventLogger` and stamps the running thread's id on every append and usage
 * record, so a turn's `agent.message`, `agent.tool_use`, and `span.*` rows all
 * land on the child thread's `thread_id` without the strategy knowing a second
 * thread exists.
 *
 * `cross_posted` is the one flag the facade never sets: it is the coordinator
 * plumbing's own marker, written by the send/reply path for the events the
 * contract lifts onto the primary stream — not a property of an ordinary
 * turn's writes, which stay on their own thread.
 */

import type { SessionEvent } from '@/types/session.js';
import type { AuxiliaryModelUsage, EventLogWriter } from '@/types/strategy.js';
import type { EventLogger } from './event-logger.js';

/**
 * Wrap an `EventLogger` so every write it accepts is attributed to `threadId`.
 *
 * Reads (`getLatestSeq`, `getEvents`) are deliberately not scoped: a seq is
 * session-wide, and the consumers that read the log back — `parkedCalls`,
 * `eventsToMessages` — select the thread's rows themselves by `thread_id`.
 * Only the *writes* are pinned, which is the half that would otherwise misroute.
 */
export class ThreadEventLogWriter implements EventLogWriter {
  constructor(
    private readonly inner: EventLogger,
    private readonly threadId: string,
  ) {}

  append(
    sessionId: string,
    event: Parameters<EventLogWriter['append']>[1],
  ): SessionEvent {
    return this.inner.append(sessionId, { ...event, threadId: this.threadId });
  }

  getLatestSeq(sessionId: string): number {
    return this.inner.getLatestSeq(sessionId);
  }

  recordUsage(
    sessionId: string,
    tokensIn: number,
    tokensOut: number,
    cache?: { read?: number; write?: number },
    threadId?: string,
  ): void {
    this.inner.recordUsage(sessionId, tokensIn, tokensOut, cache, threadId ?? this.threadId);
  }

  recordAuxiliaryModelUsage(
    sessionId: string,
    usage: AuxiliaryModelUsage | undefined,
    options: { purpose: string; modelUsed?: string; durationMs?: number; threadId?: string },
  ): SessionEvent {
    // Delegate to the inner logger's own method rather than re-appending: it
    // owns the canonical split of the usage into the span plus the session
    // aggregate, and a hand-rolled append here would drop the aggregate half.
    // The thread id travels in the options so the span and the aggregate land
    // on the same thread the request ran on.
    return this.inner.recordAuxiliaryModelUsage(sessionId, usage, {
      ...options,
      threadId: options.threadId ?? this.threadId,
    });
  }
}
