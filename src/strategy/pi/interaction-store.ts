/**
 * Durable pending-interaction store for the Pi RPC gate.
 *
 * The gate's one-shot guarantee lives here. A Pi `tool_call` opens exactly one
 * row; the row can be consumed exactly once, by a conditional UPDATE whose
 * affected-row count is the proof. A duplicate approval, a late approval for a
 * turn that already moved on, or an approval for a different tool therefore
 * cannot execute anything — they find no pending row and the bridge denies.
 *
 * A table is used rather than event metadata because the gate must record a
 * decision that has no user event to attach to: in `preauthorized_once` mode a
 * platform rule decides, and writing that as a `user.*` event would present an
 * automatic decision as a human click. The event log also has no way to express
 * "consume once", while `decision IS NULL` does.
 */

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Database } from '@/core/db/database.js';

export type PiInteractionDecision = 'allow' | 'deny';

/** Who decided. `platform` must never be reported to a client as a user action. */
export type PiInteractionSource = 'user' | 'platform' | 'system';

export interface PiInteractionRecord {
  id: string;
  sessionId: string;
  turnId: string;
  piRequestId: string;
  toolUseId: string;
  toolName: string;
  originalInput: Record<string, unknown>;
  inputFingerprint: string;
  state: 'pending' | 'allowed' | 'denied';
  decisionSource?: PiInteractionSource;
  decidedInput?: Record<string, unknown>;
  denyMessage?: string;
}

export type PiInteractionConsumeResult =
  /** This call consumed the pending record; the decision is now durable. */
  | { kind: 'consumed'; record: PiInteractionRecord }
  /** No pending record with this id. Includes a replayed or stale approval. */
  | { kind: 'unknown_request' }
  /** The record exists but was already decided; a second decision never executes. */
  | { kind: 'already_decided'; record: PiInteractionRecord }
  /** The record exists but does not belong to the named tool use or session. */
  | { kind: 'mismatch'; record: PiInteractionRecord };

export interface PiInteractionOpenInput {
  sessionId: string;
  turnId: string;
  piRequestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Stable digest of a tool input.
 *
 * Used to detect that the arguments a decision was made against are not the
 * arguments an execution would use. Key order is normalized so a re-serialized
 * but semantically identical input is not reported as a change.
 */
export function fingerprintPiToolInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export class PiInteractionStore {
  constructor(private readonly db: Database, private readonly dataDir?: string) {}

  /**
   * Record a pending interaction.
   *
   * Idempotent per `(session_id, tool_use_id)`: a repeated `tool_execution_start`
   * for the same call must not reset a decision that has already been made,
   * because `INSERT OR IGNORE` leaves an existing row (and its decision) alone.
   */
  open(input: PiInteractionOpenInput): PiInteractionRecord {
    const id = `pint_${randomUUID()}`;
    const fingerprint = fingerprintPiToolInput(input.input);
    this.db.prepare(`
      INSERT OR IGNORE INTO pi_tool_interactions (
        id, session_id, turn_id, pi_request_id, tool_use_id, tool_name,
        original_input, input_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      input.sessionId,
      input.turnId,
      input.piRequestId,
      input.toolUseId,
      input.toolName,
      JSON.stringify(input.input),
      fingerprint,
    );
    return this.findByToolUse(input.sessionId, input.toolUseId)
      ?? {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        piRequestId: input.piRequestId,
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        originalInput: input.input,
        inputFingerprint: fingerprint,
        state: 'pending',
      };
  }

  findByToolUse(sessionId: string, toolUseId: string): PiInteractionRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM pi_tool_interactions WHERE session_id = ? AND tool_use_id = ?',
    ).get(sessionId, toolUseId) as InteractionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  findPendingByRequest(sessionId: string, piRequestId: string): PiInteractionRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM pi_tool_interactions WHERE session_id = ? AND pi_request_id = ?',
    ).get(sessionId, piRequestId) as InteractionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Atomically consume one pending interaction.
   *
   * The `decision IS NULL` predicate and the affected-row count are the whole
   * one-shot mechanism: SQLite applies the update once, so a concurrent or
   * replayed decision observes `changes === 0` and is refused. `expected` lets
   * the caller bind the decision to a turn and a tool use; a mismatch is
   * reported instead of consumed.
   */
  consume(params: {
    sessionId: string;
    piRequestId: string;
    toolUseId?: string;
    expectedTurnId?: string;
    decision: PiInteractionDecision;
    source: PiInteractionSource;
    denyMessage?: string;
    decidedInput?: Record<string, unknown>;
  }): PiInteractionConsumeResult {
    const existing = this.findPendingByRequest(params.sessionId, params.piRequestId);
    if (!existing) return { kind: 'unknown_request' };
    if (existing.state !== 'pending') return { kind: 'already_decided', record: existing };
    if (params.toolUseId !== undefined && params.toolUseId !== existing.toolUseId) {
      return { kind: 'mismatch', record: existing };
    }
    if (params.expectedTurnId !== undefined && params.expectedTurnId !== existing.turnId) {
      return { kind: 'mismatch', record: existing };
    }

    const update = this.db.prepare(`
      UPDATE pi_tool_interactions
      SET decision = ?, decision_source = ?, deny_message = ?, decided_input = ?, decided_at = datetime('now')
      WHERE session_id = ? AND pi_request_id = ? AND decision IS NULL
    `).run(
      params.decision,
      params.source,
      params.denyMessage ?? null,
      params.decidedInput ? JSON.stringify(params.decidedInput) : null,
      params.sessionId,
      params.piRequestId,
    );

    const record = this.findPendingByRequest(params.sessionId, params.piRequestId) ?? existing;
    if (update.changes !== 1) return { kind: 'already_decided', record };
    return { kind: 'consumed', record };
  }

  /**
   * Retire pending interactions after a runtime restart when no live Pi child
   * can reattach to the blocking dialog. This is a durable denial, not a user
   * decision, so stale confirmations cannot later revive an orphaned tool call.
   */
  retirePending(reason: string): PiInteractionRecord[] {
    const pending = (this.db.prepare(
      'SELECT * FROM pi_tool_interactions WHERE decision IS NULL ORDER BY created_at ASC, rowid ASC',
    ).all() as unknown as InteractionRow[])
      .map(rowToRecord)
      .filter((record) => !this.hasLiveSessionLease(record.sessionId));
    const update = this.db.prepare(`
      UPDATE pi_tool_interactions
      SET decision = 'deny', decision_source = 'system', deny_message = ?, decided_at = datetime('now')
      WHERE id = ? AND decision IS NULL
    `);
    this.db.transaction(() => {
      for (const record of pending) update.run(reason, record.id);
    });
    return pending;
  }

  /** Do not retire an interaction owned by another live runtime process. */
  private hasLiveSessionLease(sessionId: string): boolean {
    const row = this.db.prepare(
      'SELECT session_file FROM pi_session_state WHERE session_id = ?',
    ).get(sessionId) as { session_file?: string } | undefined;
    const sessionFile = row?.session_file
      ?? (this.dataDir && /^sess_[A-Za-z0-9_-]+$/.test(sessionId)
        ? resolve(this.dataDir, 'pi-sessions', `${sessionId}.jsonl`)
        : undefined);
    if (!sessionFile) return false;
    try {
      const lease = JSON.parse(readFileSync(`${sessionFile}.lease`, 'utf8')) as { expiresAt?: unknown };
      return typeof lease.expiresAt === 'string' && Date.parse(lease.expiresAt) > Date.now();
    } catch {
      return false;
    }
  }

  /** Every interaction recorded for a session, oldest first. */
  listForSession(sessionId: string): PiInteractionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM pi_tool_interactions WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(sessionId) as unknown as InteractionRow[];
    return rows.map(rowToRecord);
  }
}

interface InteractionRow {
  id: string;
  session_id: string;
  turn_id: string;
  pi_request_id: string;
  tool_use_id: string;
  tool_name: string;
  original_input: string;
  input_fingerprint: string;
  decision: string | null;
  decision_source: string | null;
  decided_input: string | null;
  deny_message: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToRecord(row: InteractionRow): PiInteractionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    piRequestId: row.pi_request_id,
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    originalInput: parseJsonObject(row.original_input),
    inputFingerprint: row.input_fingerprint,
    state: row.decision === 'allow' ? 'allowed' : row.decision === 'deny' ? 'denied' : 'pending',
    ...(row.decision_source === 'user' || row.decision_source === 'platform' || row.decision_source === 'system'
      ? { decisionSource: row.decision_source }
      : {}),
    ...(row.decided_input ? { decidedInput: parseJsonObject(row.decided_input) } : {}),
    ...(row.deny_message ? { denyMessage: row.deny_message } : {}),
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Deterministic serialization so equal inputs share a fingerprint. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
