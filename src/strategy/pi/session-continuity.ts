import { existsSync, readFileSync } from 'node:fs';
import type { Database } from '@/core/db/database.js';
import type { LoopEngineContinuityBinding } from '@/strategy/loop-engine/adapter.js';

export const PI_RESUME_REFUSED_MARKER = 'Stored session working directory does not exist';

/**
 * The recorded work directory or policy fingerprint is not the one being
 * resumed.
 *
 * Deliberately not `pi_session_discontinuous`: the file and the row still agree
 * about which Pi conversation this is, so the caller has to learn *which* half of
 * the contract drifted — the work directory it would run in, or the compiled
 * policy, model, and approval mode it would run under. Reporting both as a
 * generic discontinuity is how an operator ends up repairing the wrong fact.
 */
export const PI_POLICY_MISMATCH_CODE = 'pi_policy_mismatch';

/**
 * The binding a resume must reproduce, as far as the caller can state it.
 *
 * Both fields are optional because a caller may not be able to state the whole
 * contract — a print-mode launch carries no compiled policy fingerprint — while
 * a recorded row created before the binding existed carries no value at all.
 */
export type PiContinuityBinding = Partial<LoopEngineContinuityBinding>;

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
  /** Host work directory the recorded turns ran in, when one was recorded. */
  workDir?: string;
  /** Digest of the policy, model, provider, and approval mode, when recorded. */
  policyFingerprint?: string;
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
  expected: PiContinuityBinding = {},
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
  // A session file proves which conversation this is, not which contract it ran
  // under. The comparison is against the *recorded* value, so a row written
  // before the binding existed has nothing to compare and still resumes; a row
  // that recorded one refuses anything but the value it recorded.
  if (state.workDir !== undefined && state.workDir !== expected.workDir) {
    throw new PiContinuityError(
      PI_POLICY_MISMATCH_CODE,
      'Pi session work directory is not the one its recorded turns ran in',
    );
  }
  if (state.policyFingerprint !== undefined && state.policyFingerprint !== expected.policyFingerprint) {
    throw new PiContinuityError(
      PI_POLICY_MISMATCH_CODE,
      'Pi session tool policy, model, provider, or approval mode is not the one its recorded turns ran under',
    );
  }
  return { header, state };
}

export function getPiSessionState(db: Database, sessionId: string): PiSessionState | undefined {
  const row = db.prepare(`
    SELECT session_id, session_file, pi_session_id, schema_version, status,
           work_dir, policy_fingerprint, continuity_notice
    FROM pi_session_state WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    session_file: string;
    pi_session_id: string;
    schema_version: string;
    status: string;
    work_dir: string | null;
    policy_fingerprint: string | null;
    continuity_notice: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    sessionFile: row.session_file,
    piSessionId: row.pi_session_id,
    schemaVersion: row.schema_version,
    status: row.status,
    ...(row.work_dir ? { workDir: row.work_dir } : {}),
    ...(row.policy_fingerprint ? { policyFingerprint: row.policy_fingerprint } : {}),
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
  binding: PiContinuityBinding = {},
): void {
  // `COALESCE` on the two binding columns is what keeps the recorded contract
  // stable: a caller that cannot state a fingerprint (a launch path that carries
  // none) records the identity without erasing the binding that is already
  // there, so a later resume still compares against what the session ran under.
  db.prepare(`
    INSERT INTO pi_session_state (
      session_id, session_file, pi_session_id, schema_version, status, continuity_notice,
      work_dir, policy_fingerprint, last_turn_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      session_file = excluded.session_file,
      pi_session_id = excluded.pi_session_id,
      schema_version = excluded.schema_version,
      status = excluded.status,
      continuity_notice = excluded.continuity_notice,
      work_dir = COALESCE(excluded.work_dir, pi_session_state.work_dir),
      policy_fingerprint = COALESCE(excluded.policy_fingerprint, pi_session_state.policy_fingerprint),
      last_turn_at = excluded.last_turn_at
  `).run(
    sessionId,
    sessionFile,
    header.id,
    header.schemaVersion,
    status,
    continuityNotice ?? null,
    binding.workDir ?? null,
    binding.policyFingerprint ?? null,
  );
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
