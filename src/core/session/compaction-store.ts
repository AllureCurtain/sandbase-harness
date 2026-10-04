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

export interface CompactionBoundary {
  id: string;
  sessionId: string;
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

  latest(sessionId: string): CompactionBoundary | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM compaction_boundaries
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as BoundaryRow | undefined;
    return row ? toBoundary(row) : undefined;
  }

  insert(input: NewCompactionBoundary): CompactionBoundary {
    const id = `cmpb_${nanoid(16)}`;
    this.db
      .prepare(
        `INSERT INTO compaction_boundaries
           (id, session_id, summary, event_id_before, event_seq_before,
            compacted_event_id, tokens_before, tokens_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.summary,
        input.eventIdBefore,
        input.eventSeqBefore,
        input.compactedEventId ?? null,
        input.tokensBefore,
        input.tokensAfter,
      );
    return this.latest(input.sessionId)!;
  }
}
