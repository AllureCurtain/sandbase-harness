/**
 * Memory store semantics (CMA memory stores).
 *
 * The store is a flat set of path-addressed records, and three published rules
 * give it its shape. None are cosmetic:
 *
 * - **Caps.** One memory is at most 100 kB, a store holds at most 10,000
 *   memories, and a session mounts at most 8 stores. Without these a store can
 *   be filled until every later write fails, which is a failure mode the docs
 *   explicitly ask callers to avoid — so the runtime refuses the write that
 *   would cross the line rather than letting the store degrade.
 * - **Read-only enforcement.** `access` is enforced per store, not per caller.
 *   A `read_only` mount must reject writes, because a prompt injection that
 *   lands in a writable store is re-read as trusted memory by later sessions.
 * - **List scoping.** `path_prefix` matches whole path segments, not string
 *   prefixes, so `/notes/` must not select `/notes-archive/todo.md`. A plain
 *   `startsWith` would leak unrelated memories into a scoped listing.
 *
 * The `content_sha256` precondition exists for the same reason a database
 * compare-and-swap does: without it, two writers that both read a memory and
 * both write it silently lose one update. When the precondition does not
 * match, the caller must re-read and retry rather than have the runtime pick a
 * winner.
 */

import { createHash } from 'node:crypto';

/** Maximum size of one memory's content, in bytes. */
export const MAX_MEMORY_CONTENT_BYTES = 100 * 1024;

/** Maximum memories in a store. */
export const MAX_MEMORIES_PER_STORE = 10_000;

/** Maximum memory stores attached to one session. */
export const MAX_MEMORY_STORES_PER_SESSION = 8;

/** Maximum length of the session-level `instructions` field. */
export const MAX_MEMORY_INSTRUCTIONS_CHARS = 4096;

/** Default access mode for an attached store. */
export const DEFAULT_MEMORY_ACCESS = 'read_write';

export type MemoryAccess = 'read_write' | 'read_only';

/** SHA-256 of content, hex encoded. The canonical `content_sha256` value. */
export function memoryContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Size of content in bytes, which is what the 100 kB cap counts. */
export function memoryContentBytes(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

// ============================================================
// Caps
// ============================================================

export type CapCheck =
  | { ok: true }
  | { ok: false; code: 'memory_too_large' | 'store_full' | 'too_many_stores' | 'instructions_too_long'; message: string };

/** Enforce the per-memory content cap. */
export function checkMemorySize(content: string): CapCheck {
  const bytes = memoryContentBytes(content);
  if (bytes > MAX_MEMORY_CONTENT_BYTES) {
    return {
      ok: false,
      code: 'memory_too_large',
      message: `Memory content is ${bytes} bytes, which exceeds the ${MAX_MEMORY_CONTENT_BYTES} byte (100 kB) limit`,
    };
  }
  return { ok: true };
}

/**
 * Enforce the per-store cap.
 *
 * Checked before the insert, so the write that would become the 10,001st
 * memory is the one rejected; existing memories stay readable and editable, as
 * the contract requires.
 */
export function checkStoreCapacity(currentCount: number): CapCheck {
  if (currentCount >= MAX_MEMORIES_PER_STORE) {
    return {
      ok: false,
      code: 'store_full',
      message: `Memory store is at its ${MAX_MEMORIES_PER_STORE} memory limit; existing memories remain readable and editable`,
    };
  }
  return { ok: true };
}

/** Enforce the per-session store count. */
export function checkSessionStoreCount(currentCount: number): CapCheck {
  if (currentCount >= MAX_MEMORY_STORES_PER_SESSION) {
    return {
      ok: false,
      code: 'too_many_stores',
      message: `A session may attach at most ${MAX_MEMORY_STORES_PER_SESSION} memory stores`,
    };
  }
  return { ok: true };
}

/** Enforce the `instructions` length cap. */
export function checkMemoryInstructions(instructions: string | undefined): CapCheck {
  if (instructions !== undefined && instructions.length > MAX_MEMORY_INSTRUCTIONS_CHARS) {
    return {
      ok: false,
      code: 'instructions_too_long',
      message: `instructions is ${instructions.length} characters, which exceeds the ${MAX_MEMORY_INSTRUCTIONS_CHARS} character limit`,
    };
  }
  return { ok: true };
}

// ============================================================
// Path scoping
// ============================================================

export type PathScopeResult =
  | { ok: true; prefix?: string; depth: number }
  | { ok: false; message: string };

/**
 * Validate `path_prefix` and `depth` for a memory listing.
 *
 * `path_prefix` must end with `/` so it can only name a directory, and it must
 * start with `/`. `depth` is either omitted or `0` (whole subtree) or `1`
 * (direct children); the contract returns 400 for any other value rather than
 * treating it as an approximate depth.
 */
export function validateMemoryListScope(pathPrefix: unknown, depth: unknown): PathScopeResult {
  let prefix: string | undefined;

  if (pathPrefix !== undefined && pathPrefix !== null) {
    if (typeof pathPrefix !== 'string') {
      return { ok: false, message: 'path_prefix must be a string' };
    }
    if (!pathPrefix.startsWith('/')) {
      return { ok: false, message: 'path_prefix must start with /' };
    }
    if (!pathPrefix.endsWith('/')) {
      return { ok: false, message: 'path_prefix must end with /' };
    }
    prefix = pathPrefix.replace(/\/+/g, '/');
  }

  let resolvedDepth = 0;
  if (depth !== undefined && depth !== null) {
    const parsed = typeof depth === 'string' && depth.trim() !== '' ? Number(depth) : depth;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
      return { ok: false, message: 'depth must be an integer' };
    }
    if (parsed !== 0 && parsed !== 1) {
      return { ok: false, message: 'depth must be 0 (whole subtree) or 1 (direct children)' };
    }
    resolvedDepth = parsed;
  }

  return { ok: true, ...(prefix !== undefined ? { prefix } : {}), depth: resolvedDepth };
}

/**
 * Whether a memory path is selected by a directory prefix.
 *
 * Matching is on whole segments: the prefix must either be the record's
 * directory chain or an ancestor of it. `/notes/` selects `/notes/todo.md` and
 * `/notes/archive/old.md` but never `/notes-archive/todo.md`.
 */
export function matchesPathPrefix(path: string, prefix: string | undefined): boolean {
  if (prefix === undefined) {
    // A root listing (`path_prefix=/`) selects everything including top-level
    // files; a nested file is still inside the root.
    return true;
  }
  if (prefix === '/') return true;
  return path.startsWith(prefix);
}

/**
 * Whether a memory path is within `depth` levels below `prefix`.
 *
 * `depth: 1` means direct children only: with `/notes/`, `/notes/todo.md`
 * qualifies but `/notes/archive/old.md` does not.
 */
export function withinDepth(path: string, prefix: string | undefined, depth: number): boolean {
  if (depth === 0) return true;
  const base = prefix === undefined || prefix === '/' ? '/' : prefix;
  const remainder = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '');
  if (remainder.length === 0) return false;
  const segments = remainder.split('/').filter((segment) => segment.length > 0);
  return segments.length <= depth;
}

/** Filter a memory listing by a validated scope, preserving input order. */
export function applyMemoryListScope<T extends { path: string }>(
  memories: readonly T[],
  scope: { prefix?: string; depth: number },
): T[] {
  return memories.filter(
    (memory) => matchesPathPrefix(memory.path, scope.prefix) && withinDepth(memory.path, scope.prefix, scope.depth),
  );
}

// ============================================================
// Precondition
// ============================================================

export type PreconditionResult =
  | { ok: true }
  | { ok: false; code: 'precondition_failed' | 'invalid_precondition'; message: string };

/**
 * Evaluate a `content_sha256` precondition against the stored content hash.
 *
 * A stale hash is reported as `precondition_failed` with the current hash so
 * the caller can re-read and retry, rather than the runtime overwriting a
 * concurrent write it never saw.
 */
export function evaluateContentPrecondition(
  precondition: unknown,
  currentContent: string,
): PreconditionResult {
  if (precondition === undefined || precondition === null) return { ok: true };
  if (typeof precondition !== 'object' || Array.isArray(precondition)) {
    return { ok: false, code: 'invalid_precondition', message: 'precondition must be an object' };
  }
  const record = precondition as Record<string, unknown>;
  if (record.type !== 'content_sha256') {
    return { ok: false, code: 'invalid_precondition', message: 'precondition.type must be content_sha256' };
  }
  const expected = record.content_sha256;
  if (typeof expected !== 'string' || expected.length === 0) {
    return { ok: false, code: 'invalid_precondition', message: 'precondition.content_sha256 is required' };
  }
  const current = memoryContentHash(currentContent);
  if (expected !== current) {
    return {
      ok: false,
      code: 'precondition_failed',
      message: `precondition failed: content_sha256 is ${current}, not ${expected}; re-read the memory and retry`,
    };
  }
  return { ok: true };
}

// ============================================================
// Mount projection
// ============================================================

/**
 * Slug for a store's mount directory.
 *
 * The published rule: lowercase, and runs of non-alphanumeric characters
 * collapse to a single hyphen. `Demo Memory` becomes `demo-memory`. The
 * resulting path is returned on the resource as `mount_path`, and callers are
 * told to read it from there rather than construct it — so this slug is the
 * single source for both.
 */
export function memoryStoreSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'memory';
}

/** Default mount path for an attached store, under `/mnt/memory/`. */
export function defaultMemoryMountPath(name: string): string {
  return `/mnt/memory/${memoryStoreSlug(name)}`;
}

/**
 * The description lines for one mount, added to the system prompt.
 *
 * Includes display name, mount path, access mode, the store description, and
 * any per-session instructions, matching the documented prompt shape.
 */
export function describeMemoryMount(mount: {
  name: string;
  mountPath: string;
  access: MemoryAccess;
  description?: string;
  instructions?: string;
}): string {
  const lines = [
    `Memory store: ${mount.name}`,
    `Mount path: ${mount.mountPath}`,
    `Access: ${mount.access}`,
  ];
  if (mount.description) lines.push(`Description: ${mount.description}`);
  if (mount.instructions) lines.push(`Instructions: ${mount.instructions}`);
  return lines.join('\n');
}
