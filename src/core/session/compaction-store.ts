/**
 * Compaction boundary persistence.
 *
 * A boundary records which event-log prefix a summary covers: every event with
 * `seq <= event_seq_before` is represented by `summary`, and everything after
 * it projects verbatim. The `agent.thread_context_compacted` log event is only
 * a notification — the summary lives here, so it never reaches `GET /events`.
 */

import { nanoid } from 'nanoid';
import type { Database } from '../db/database.js';
import { primaryThreadIdForSession } from './session-threads.js';

export interface CompactionBoundary {
  id: string;
  sessionId: string;
  /**
   * The thread whose context this boundary covers.
   *
   * A session's event `seq` is shared by every thread, so a boundary without a
   * thread would truncate every other thread's context from the same sequence
   * and inject this thread's summary into it.
   */
  threadId: string;
  summary: string;
  /** Id of the last event covered by the summary. */
  eventIdBefore: string;
  /** Events with `seq <= eventSeqBefore` are covered by the summary. */
  eventSeqBefore: number;
  /** The notification event written when this boundary was recorded. */
  compactedEventId: string | null;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
}

export interface NewCompactionBoundary {
  sessionId: string;
  threadId: string;
  summary: string;
  eventIdBefore: string;
  eventSeqBefore: number;
  compactedEventId?: string | null;
  tokensBefore: number;
  tokensAfter: number;
}

interface BoundaryRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  summary: string;
  event_id_before: string;
  event_seq_before: number;
  compacted_event_id: string | null;
  tokens_before: number;
  tokens_after: number;
  created_at: string;
}

function toBoundary(row: BoundaryRow): CompactionBoundary {
  return {
    id: row.id,
    sessionId: row.session_id,
    // A row that predates `063_thread_compaction` is back-filled by the
    // migration; the fallback covers a boundary written by an older build into
    // a workspace whose migration has not run (which then reads as primary).
    threadId: row.thread_id ?? primaryThreadIdForSession(row.session_id),
    summary: row.summary,
    eventIdBefore: row.event_id_before,
    eventSeqBefore: row.event_seq_before,
    compactedEventId: row.compacted_event_id,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    createdAt: row.created_at,
  };
}

export class CompactionStore {
  constructor(private readonly db: Database) {}

  /**
   * The newest boundary for one thread, or for the session when no thread is
   * named (the pre-thread callers and embedders that compact one stream).
   */
  latest(sessionId: string, threadId?: string): CompactionBoundary | undefined {
    const sql = threadId === undefined
      ? `SELECT * FROM compaction_boundaries
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      : `SELECT * FROM compaction_boundaries
         WHERE session_id = ? AND thread_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const row = (threadId === undefined
      ? this.db.prepare(sql).get(sessionId)
      : this.db.prepare(sql).get(sessionId, threadId)) as BoundaryRow | undefined;
    return row ? toBoundary(row) : undefined;
  }

  insert(input: NewCompactionBoundary): CompactionBoundary {
    const id = `cmpb_${nanoid(16)}`;
    this.db
      .prepare(
        `INSERT INTO compaction_boundaries
           (id, session_id, thread_id, summary, event_id_before, event_seq_before,
            compacted_event_id, tokens_before, tokens_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.threadId,
        input.summary,
        input.eventIdBefore,
        input.eventSeqBefore,
        input.compactedEventId ?? null,
        input.tokensBefore,
        input.tokensAfter,
      );
    return this.latest(input.sessionId, input.threadId)!;
  }
}
