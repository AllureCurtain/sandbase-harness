/**
 * Read an uploaded rubric file as text.
 *
 * A file the runtime cannot read resolves to `undefined` rather than to an empty
 * string. Grading against an empty rubric would still produce a verdict, and
 * that verdict would look like a measurement of the deliverable instead of a
 * missing input.
 *
 * The size ceiling is deliberate: a rubric is a short statement of criteria, and
 * a "rubric" that is megabytes of text is a mis-upload, not a specification to
 * hand a grader.
 */

import type { Database } from '@/core/db/database.js';
import type { ArtifactStore } from '@/core/storage/artifact-store.js';

/** Largest rubric file the runtime will read, in bytes. */
export const MAX_RUBRIC_FILE_BYTES = 64 * 1024;

export function readRubricFileText(
  db: Database,
  store: ArtifactStore,
  fileId: string,
): string | undefined {
  const row = db.prepare(
    'SELECT storage_path, size FROM files WHERE id = ? AND archived_at IS NULL',
  ).get(fileId) as { storage_path?: string; size?: number } | undefined;
  if (!row?.storage_path) return undefined;
  if (typeof row.size === 'number' && row.size > MAX_RUBRIC_FILE_BYTES) return undefined;
  if (!store.exists(row.storage_path)) return undefined;
  const text = store.readFile(row.storage_path).toString('utf8');
  if (text.length === 0) return undefined;
  return text.slice(0, MAX_RUBRIC_FILE_BYTES);
}
