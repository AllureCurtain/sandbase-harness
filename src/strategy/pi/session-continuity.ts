import { existsSync, readFileSync } from 'node:fs';
import type { Database } from '@/core/db/database.js';

export const PI_RESUME_REFUSED_MARKER = 'Stored session working directory does not exist';

export interface PiSessionHeader {
  id: string;
  schemaVersion: string;
}

export interface PiSessionState {
  sessionId: string;
  sessionFile: string;
  piSessionId: string;
  schemaVersion: string;
  status: string;
  continuityNotice?: string;
}

export class PiContinuityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PiContinuityError';
    this.code = code;
  }
}

/** Read and validate only the Pi session header; the file is not event authority. */
export function inspectPiSessionFile(sessionFile: string): PiSessionHeader | undefined {
  if (!existsSync(sessionFile)) return undefined;
  const source = readFileSync(sessionFile, 'utf8');
  const firstLine = source.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new PiContinuityError('pi_session_file_corrupt', `Pi session file has an invalid JSON header: ${sessionFile}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PiContinuityError('pi_session_file_schema_invalid', 'Pi session header must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'session' || typeof record.id !== 'string' || !record.id) {
    throw new PiContinuityError('pi_session_file_schema_invalid', 'Pi session header is missing type=session or id');
  }
  const schema = record.version ?? record.schemaVersion ?? record.schema_version ?? 'unknown';
  return { id: record.id, schemaVersion: String(schema) };
}

/** Refuse a non-empty file unless SQLite can prove it is the same Pi session. */
export function assertPiSessionContinuity(
  db: Database,
  sessionId: string,
  sessionFile: string,
): { header?: PiSessionHeader; state?: PiSessionState } {
  const header = inspectPiSessionFile(sessionFile);
  const state = getPiSessionState(db, sessionId);
  if (!header && !state) return {};
  if (!header && state) {
    throw new PiContinuityError('pi_session_discontinuous', 'Pi session state exists but its managed session file is empty');
  }
  if (header && !state) {
    throw new PiContinuityError('pi_session_discontinuous', 'Pi session file exists without matching SandBase continuity state');
  }
  if (!header || !state) return {};
  if (state.status !== 'active') {
    throw new PiContinuityError('pi_session_discontinuous', `Pi continuity state is ${state.status}; resume is refused until it is repaired`);
  }
  if (state.sessionFile !== sessionFile || state.piSessionId !== header.id || state.schemaVersion !== header.schemaVersion) {
    throw new PiContinuityError('pi_session_discontinuous', 'Pi session file identity or schema does not match SandBase continuity state');
  }
  return { header, state };
}

export function getPiSessionState(db: Database, sessionId: string): PiSessionState | undefined {
  const row = db.prepare(`
    SELECT session_id, session_file, pi_session_id, schema_version, status, continuity_notice
    FROM pi_session_state WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    session_file: string;
    pi_session_id: string;
    schema_version: string;
    status: string;
    continuity_notice: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    sessionFile: row.session_file,
    piSessionId: row.pi_session_id,
    schemaVersion: row.schema_version,
    status: row.status,
    ...(row.continuity_notice ? { continuityNotice: row.continuity_notice } : {}),
  };
}

export function recordPiSessionState(
  db: Database,
  sessionId: string,
  sessionFile: string,
  header: PiSessionHeader,
  status = 'active',
  continuityNotice?: string,
): void {
  db.prepare(`
    INSERT INTO pi_session_state (
      session_id, session_file, pi_session_id, schema_version, status, continuity_notice, last_turn_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      session_file = excluded.session_file,
      pi_session_id = excluded.pi_session_id,
      schema_version = excluded.schema_version,
      status = excluded.status,
      continuity_notice = excluded.continuity_notice,
      last_turn_at = excluded.last_turn_at
  `).run(sessionId, sessionFile, header.id, header.schemaVersion, status, continuityNotice ?? null);
}

export function markPiSessionContinuityFailure(
  db: Database,
  sessionId: string,
  sessionFile: string,
  code: string,
  message: string,
): void {
  const existing = getPiSessionState(db, sessionId);
  if (existing) {
    db.prepare(`UPDATE pi_session_state SET status = ?, continuity_notice = ? WHERE session_id = ?`)
      .run(code, message, sessionId);
    return;
  }
  db.prepare(`
    INSERT OR IGNORE INTO pi_session_state (
      session_id, session_file, pi_session_id, schema_version, status, continuity_notice
    ) VALUES (?, ?, '', '', ?, ?)
  `).run(sessionId, sessionFile, code, message);
}
