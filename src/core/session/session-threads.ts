/**
 * Session Threads — the per-thread rows the multi-agent surface is built on.
 *
 * A thread is one context-isolated conversation inside a session: it has its
 * own event stream (the `events.thread_id` rows), its own status, and its own
 * execution chain. Every session owns exactly one primary thread, whose
 * `parent_thread_id` is NULL and whose stream is what the session-level routes
 * publish; child threads are spawned by the coordinator's `send_to_agent`.
 *
 * The table and the helpers live here rather than inside `SessionManager`
 * because the lifecycle they describe is narrower than the session's: a thread
 * is created, it transitions through the same internal statuses a session
 * does, and it is archived — while the session row it belongs to keeps its own
 * aggregate status, recomputed from the threads rather than written directly.
 *
 * The primary thread's id is derivable — `sth_` plus the session id's suffix —
 * which is why `primaryThreadId` never scans the table. The same derivation is
 * what the migration used to back-fill one primary row per existing session,
 * so a thread lookup on a pre-thread workspace resolves the row the migration
 * wrote rather than minting a second one.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session, SessionStatus } from '@/types/session.js';

// ============================================================
// Row shape and read model
// ============================================================

export type SessionThreadKind = 'primary' | 'subagent' | 'advisor' | 'workflow';

export interface SessionThreadRow {
  id: string;
  session_id: string;
  parent_thread_id: string | null;
  agent_name: string;
  agent_definition: string;
  agent_id: string | null;
  agent_version: number | null;
  status: string;
  thread_kind: SessionThreadKind;
  workflow_run_id: string | null;
  usage_tokens_in: number;
  usage_tokens_out: number;
  usage_cache_read_tokens: number;
  usage_cache_write_tokens: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/**
 * One thread as the runtime works with it.
 *
 * `agentDefinition` is the resolved snapshot the thread executes — the
 * coordinator's own for the primary thread, or the roster member's pinned
 * definition for a child — stored as JSON in the row so the thread never
 * re-resolves a name the roster captured at spawn.
 */
export interface SessionThread {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  agentName: string;
  agentDefinition: AgentDefinition;
  agentId: string | null;
  agentVersion: number | null;
  status: SessionStatus;
  /** What this thread represents; the 25-slot cap counts `subagent` only. */
  kind: SessionThreadKind;
  /** The workflow run this thread belongs to, or null for every other kind. */
  workflowRunId: string | null;
  usage: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export function rowToThread(row: SessionThreadRow): SessionThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentThreadId: row.parent_thread_id,
    agentName: row.agent_name,
    agentDefinition: JSON.parse(row.agent_definition) as AgentDefinition,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    status: row.status as SessionStatus,
    kind: row.thread_kind as SessionThreadKind,
    workflowRunId: row.workflow_run_id,
    usage: {
      tokensIn: row.usage_tokens_in,
      tokensOut: row.usage_tokens_out,
      cacheReadTokens: row.usage_cache_read_tokens,
      cacheWriteTokens: row.usage_cache_write_tokens,
    },
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
  };
}

// ============================================================
// Primary-thread derivation
// ============================================================

/**
 * The id the migration assigned, and `ensurePrimaryThread` assigns, to a
 * session's primary thread: `sth_` plus the session id's own suffix.
 *
 * Derivable rather than stored on the session because the primary thread has
 * exactly one owner — the session row — and a second key for the same
 * relationship could only disagree with it.
 */
export function primaryThreadIdForSession(sessionId: string): string {
  return `sth_${sessionId.replace(/^sess_/, '')}`;
}

// ============================================================
// Thread store
// ============================================================

export class SessionThreadStore {
  constructor(private readonly db: Database) {}

  /**
   * The primary thread id for a session — derived, never stored a second time.
   * Asserting the session exists is the caller's job; this is a pure function
   * of the id.
   */
  primaryThreadId(sessionId: string): string {
    return primaryThreadIdForSession(sessionId);
  }

  /**
   * Return the session's primary thread row, creating it when it does not
   * exist.
   *
   * A session written after the migration lands already has its row, written
   * in the same insert that created the session. The create-arm exists for the
   * one path the migration cannot have covered: a session row inserted by a
   * workspace that was opened, migrated, and then written to before the
   * primary-thread writer existed on this build — which is exactly the
   * pre-3.1 history a fresh checkout cannot produce but a migrated one can.
   * It is idempotent on the derived id, so a raced insert is a no-op rather
   * than a second primary thread.
   */
  ensurePrimaryThread(session: Session): SessionThread {
    const id = primaryThreadIdForSession(session.id);
    const existing = this.get(id);
    if (existing) return existing;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_threads (
        id, session_id, parent_thread_id, agent_name, agent_definition,
        agent_id, agent_version, status, thread_kind, workflow_run_id,
        usage_tokens_in, usage_tokens_out, usage_cache_read_tokens, usage_cache_write_tokens,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'primary', NULL, 0, 0, 0, 0, ?, ?, ?)
    `).run(
      id,
      session.id,
      session.agentName,
      JSON.stringify(session.agentDefinition ?? {}),
      session.agentId,
      session.agentVersion ?? null,
      session.status,
      now,
      now,
      session.archivedAt ? session.archivedAt.toISOString() : null,
    );
    return this.get(id)!;
  }

  get(threadId: string): SessionThread | undefined {
    const row = this.db.prepare('SELECT * FROM session_threads WHERE id = ?')
      .get(threadId) as SessionThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  /**
   * List a session's threads — primary first, then children in creation order.
   * Archived rows are included: the listing is the thread inventory the
   * contract publishes, and a caller reads `archived_at` off the row rather
   * than a second flag.
   */
  listBySession(sessionId: string): SessionThread[] {
    const rows = this.db.prepare(
      `SELECT * FROM session_threads
       WHERE session_id = ?
       ORDER BY datetime(created_at) ASC, id ASC`,
    ).all(sessionId) as unknown as SessionThreadRow[];
    return rows.map(rowToThread);
  }

  /**
   * A thread's non-archived, non-primary siblings still holding a concurrency
   * slot — the running set the 25-thread cap counts. Terminal and archived
   * rows are out of the count by definition: a terminated thread released its
   * slot, and the contract frees one on archive.
   */
  activeChildCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM session_threads
       WHERE session_id = ? AND parent_thread_id IS NOT NULL AND archived_at IS NULL
         AND thread_kind = 'subagent'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending', 'archived')`,
    ).get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * Insert a child thread row and return it.
   *
   * `status` starts as the caller passes — the coordinator inserts a child in
   * `queued` and the thread runner's first turn moves it to `running`, so the
   * row never reports a state the log has not also recorded.
   */
  insertThread(thread: {
    sessionId: string;
    parentThreadId: string;
    agentName: string;
    agentDefinition: AgentDefinition;
    agentId: string | null;
    agentVersion: number | null;
    status?: SessionStatus;
    /** Defaults to `subagent`; advisor and workflow rows name their kind. */
    kind?: SessionThreadKind;
    /** Required for `workflow` threads, null/omitted otherwise. */
    workflowRunId?: string | null;
  }): SessionThread {
    const id = `sth_${nanoid(16)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_threads (
        id, session_id, parent_thread_id, agent_name, agent_definition,
        agent_id, agent_version, status, thread_kind, workflow_run_id,
        usage_tokens_in, usage_tokens_out, usage_cache_read_tokens, usage_cache_write_tokens,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, NULL)
    `).run(
      id,
      thread.sessionId,
      thread.parentThreadId,
      thread.agentName,
      JSON.stringify(thread.agentDefinition),
      thread.agentId,
      thread.agentVersion,
      thread.status ?? 'queued',
      thread.kind ?? 'subagent',
      thread.workflowRunId ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  /**
   * Write a thread's status. The aggregate on `sessions` is recomputed by the
   * caller afterwards — the two are deliberately separate writes so the
   * session's published state is always a function of its threads rather than
   * a second value that could disagree.
   */
  updateStatus(threadId: string, status: SessionStatus): void {
    this.db.prepare(
      `UPDATE session_threads SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(status, threadId);
  }

  /** Mark a thread archived — the only lifecycle write besides status. */
  archiveThread(threadId: string): void {
    this.db.prepare(
      `UPDATE session_threads SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(threadId);
  }

  /**
   * Add one model request's usage to the thread's materialized counters.
   *
   * Called exactly where `EventLogger.recordUsage` adds the same figures to
   * the session aggregate, so the thread's cache stays in lock-step with the
   * canonical record rather than drifting behind a projection.
   */
  recordUsage(
    threadId: string,
    tokensIn: number,
    tokensOut: number,
    cache?: { read?: number; write?: number },
  ): void {
    this.db.prepare(`
      UPDATE session_threads
      SET usage_tokens_in = usage_tokens_in + ?,
          usage_tokens_out = usage_tokens_out + ?,
          usage_cache_read_tokens = usage_cache_read_tokens + ?,
          usage_cache_write_tokens = usage_cache_write_tokens + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(tokensIn, tokensOut, cache?.read ?? 0, cache?.write ?? 0, threadId);
  }
}
