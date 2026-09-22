/**
 * Persistence for handoff bundles.
 *
 * Bundles are written once and read many times. Nothing here updates a payload:
 * a bundle is evidence of a session at a moment, and rewritable evidence is not
 * evidence. A recipient that already has bundle `hb_x` must be able to assume
 * the bytes have not changed.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { buildHandoffBundle, type HandoffBundle, type HandoffBundleDeps, type HandoffBundleOptions } from './bundle.js';

/** Listing projection: everything except the full payload. */
export type HandoffBundleSummary = {
  id: string;
  type: 'handoff_bundle';
  session_id: string;
  label: string | null;
  schema_version: string;
  replay_mode: string;
  includes_message_content: boolean;
  includes_file_content: boolean;
  event_count: number;
  file_count: number;
  payload_sha256: string;
  signature_key_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type HandoffBundleRow = {
  id: string;
  session_id: string;
  label: string | null;
  schema_version: string;
  replay_mode: string;
  includes_message_content: number;
  includes_file_content: number;
  event_count: number;
  file_count: number;
  payload: string;
  payload_sha256: string;
  signature_key_id: string;
  metadata: string;
  created_at: string;
};

/** Build a bundle from live session state and persist it. */
export function createHandoffBundle(
  deps: HandoffBundleDeps,
  sessionId: string,
  options: HandoffBundleOptions = {},
): HandoffBundle {
  const bundle = buildHandoffBundle(deps, sessionId, options);
  persistHandoffBundle(deps.db, bundle);
  return bundle;
}

export function persistHandoffBundle(db: Database, bundle: HandoffBundle): void {
  const keyId = (bundle.attestation.dsse_envelope.signatures as Array<{ keyid: string }> | undefined)?.[0]?.keyid ?? 'unknown';
  db.prepare(
    `INSERT INTO handoff_bundles (
       id, session_id, label, schema_version, replay_mode,
       includes_message_content, includes_file_content, event_count, file_count,
       payload, payload_sha256, signature_key_id, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bundle.id,
    bundle.session_id,
    bundle.label,
    bundle.schema_version,
    bundle.replay.mode,
    bundle.content.message_bodies_included ? 1 : 0,
    bundle.content.file_bytes_included ? 1 : 0,
    bundle.transcript.event_count,
    bundle.files.entry_count,
    JSON.stringify(bundle),
    bundle.integrity.payload_sha256,
    keyId,
    JSON.stringify({ label: bundle.label }),
    bundle.created_at,
  );
}

/** Read a stored bundle payload. Returns null when the id is unknown. */
export function getHandoffBundle(db: Database, bundleId: string): HandoffBundle | null {
  const row = db.prepare('SELECT payload FROM handoff_bundles WHERE id = ?').get(bundleId) as
    | { payload: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as HandoffBundle;
  } catch {
    // A payload that will not parse is a corrupt row, not a missing bundle.
    // Returning null would report it as "not found" and hide the corruption.
    return null;
  }
}

export function listHandoffBundles(
  db: Database,
  opts: { sessionId?: string; limit?: number } = {},
): HandoffBundleSummary[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const clause = opts.sessionId ? 'WHERE session_id = ?' : '';
  const params: string[] = opts.sessionId ? [opts.sessionId] : [];
  const rows = db.prepare(
    `SELECT id, session_id, label, schema_version, replay_mode,
            includes_message_content, includes_file_content, event_count, file_count,
            payload_sha256, signature_key_id, metadata, created_at
     FROM handoff_bundles ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, limit) as unknown as Array<Omit<HandoffBundleRow, 'payload'>>;

  return rows.map(toSummary);
}

export function deleteHandoffBundle(db: Database, bundleId: string): boolean {
  const result = db.prepare('DELETE FROM handoff_bundles WHERE id = ?').run(bundleId);
  return result.changes > 0;
}

export function newHandoffBundleId(): string {
  return `hb_${nanoid(18)}`;
}

function toSummary(row: Omit<HandoffBundleRow, 'payload'>): HandoffBundleSummary {
  return {
    id: row.id,
    type: 'handoff_bundle',
    session_id: row.session_id,
    label: row.label,
    schema_version: row.schema_version,
    replay_mode: row.replay_mode,
    includes_message_content: row.includes_message_content === 1,
    includes_file_content: row.includes_file_content === 1,
    event_count: row.event_count,
    file_count: row.file_count,
    payload_sha256: row.payload_sha256,
    signature_key_id: row.signature_key_id,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
