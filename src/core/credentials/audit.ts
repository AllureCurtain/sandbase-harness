/**
 * Credential audit events (migration M028).
 *
 * `credential_audit_events` is append-only and records what happened to a secret
 * without ever recording the secret: rotation, explicit use, runtime injection and
 * runtime denial all land here as metadata-only rows.
 *
 * Both writers — the injection boundary and the vault management API — go through
 * `appendCredentialAuditEvent`, so the row shape cannot drift between them. An
 * event is deliberately a *separate* row from the credential, so archiving or
 * deleting a credential never erases its history.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';

/** Actions the runtime writes today. Stored as free text, not an enum column. */
export type CredentialAuditAction =
  | 'runtime_inject'
  | 'runtime_denied'
  | 'rotate'
  | 'mark_used'
  | 'archive'
  | 'delete';

export interface CredentialAuditEvent {
  id: string;
  type: 'credential_audit_event';
  vault_id: string;
  credential_id: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AppendCredentialAuditInput {
  vaultId: string;
  credentialId: string;
  action: CredentialAuditAction | string;
  /** Who caused the event. Defaults to `system`, the column default. */
  actor?: string;
  metadata?: Record<string, unknown>;
  /**
   * Also stamp `credential_records.last_used_at`, which is what the injection
   * boundary records alongside the event. Kept on this call so both writes stay
   * one operation.
   */
  touchLastUsed?: boolean;
}

export function appendCredentialAuditEvent(
  db: Database,
  input: AppendCredentialAuditInput,
): CredentialAuditEvent {
  const event: CredentialAuditEvent = {
    id: `caud_${nanoid(18)}`,
    type: 'credential_audit_event',
    vault_id: input.vaultId,
    credential_id: input.credentialId,
    action: input.action,
    actor: input.actor ?? 'system',
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };
  if (input.touchLastUsed) {
    db.prepare(
      `UPDATE credential_records
       SET last_used_at = ?, updated_at = ?
       WHERE id = ? AND vault_id = ?`,
    ).run(event.created_at, event.created_at, event.credential_id, event.vault_id);
  }
  db.prepare(
    `INSERT INTO credential_audit_events (id, vault_id, credential_id, action, actor, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.vault_id,
    event.credential_id,
    event.action,
    event.actor,
    JSON.stringify(event.metadata),
    event.created_at,
  );
  return event;
}

/**
 * List audit events newest first, for one credential or for a whole vault.
 *
 * A vault-level listing answers "what happened in this vault"; a credential
 * listing answers "what happened to this secret". Both are needed, because a
 * deleted credential still has history but no longer appears in the vault.
 */
export function listCredentialAuditEvents(
  db: Database,
  opts: { vaultId: string; credentialId?: string; limit?: number },
): CredentialAuditEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const rows = (opts.credentialId
    ? db.prepare(
      `SELECT *
       FROM credential_audit_events
       WHERE vault_id = ? AND credential_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    ).all(opts.vaultId, opts.credentialId, limit)
    : db.prepare(
      `SELECT *
       FROM credential_audit_events
       WHERE vault_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    ).all(opts.vaultId, limit)) as unknown as CredentialAuditRow[];
  return rows.map(toCredentialAuditEvent);
}

type CredentialAuditRow = {
  id: string;
  vault_id: string;
  credential_id: string;
  action: string;
  actor: string;
  metadata: string;
  created_at: string;
};

function toCredentialAuditEvent(row: CredentialAuditRow): CredentialAuditEvent {
  return {
    id: row.id,
    type: 'credential_audit_event',
    vault_id: row.vault_id,
    credential_id: row.credential_id,
    action: row.action,
    actor: row.actor,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
  };
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
