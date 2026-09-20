/**
 * Canonical file-resource mount paths.
 *
 * The published contract treats `mount_path` as a logical path inside the
 * session: `"/data.csv"` maps to `/mnt/session/uploads/data.csv` and omitting
 * the field defaults to the file id. The previous implementation required the
 * caller to supply the internal `/uploads/` prefix, which leaked a sandbox
 * layout detail into the public field and rejected the documented example.
 *
 * Two rules matter here:
 *
 * - the full relative path is preserved, so `"/src/main.py"` must not be
 *   flattened to its basename — a nested layout is meaningful to the agent;
 * - validation runs on the canonical path before mapping, because the internal
 *   prefix must never be the thing that makes a traversal attempt look valid.
 */

/** Internal directory every file resource is mounted under. */
export const FILE_MOUNT_ROOT = '/mnt/session/uploads';

/** Canonical logical root. A `mount_path` is an absolute path in this space. */
export const FILE_MOUNT_LOGICAL_ROOT = '/';

export interface MountPathResult {
  ok: boolean;
  /** Canonical logical path, echoed on the resource. */
  mountPath?: string;
  /** Absolute sandbox path the bytes are written to. */
  sandboxPath?: string;
  message?: string;
}

/**
 * Validate a caller-supplied canonical `mount_path` and derive the sandbox path.
 *
 * A separate `validateOnly` mode exists for paths that arrive already
 * normalized (an existing session row read back from storage), so revalidation
 * cannot accidentally re-map an already-mapped path.
 */
export function resolveFileMountPath(rawMountPath: string | undefined, fileId: string): MountPathResult {
  const canonical = rawMountPath === undefined || rawMountPath.trim() === ''
    ? `/${fileId}`
    : rawMountPath.trim();

  const invalid = validateCanonicalMountPath(canonical);
  if (invalid) return { ok: false, message: invalid };

  return {
    ok: true,
    mountPath: canonical,
    sandboxPath: sandboxPathFor(canonical),
  };
}

/**
 * Reject a canonical path that could escape the mount root or is ambiguous.
 *
 * Backslashes and NUL are rejected rather than normalized: on Windows a
 * backslash is a separator, so accepting one would make a single logical path
 * mean two different sandbox paths depending on the host.
 */
export function validateCanonicalMountPath(mountPath: string): string | undefined {
  if (!mountPath.startsWith(FILE_MOUNT_LOGICAL_ROOT)) return 'mount_path must be an absolute path';
  if (mountPath.includes('\0')) return 'mount_path must not contain a NUL byte';
  if (mountPath.includes('\\')) return 'mount_path must not contain a backslash';
  if (mountPath === '/') return 'mount_path must name a file, not the root directory';

  const segments = mountPath.slice(1).split('/');
  if (segments.some((segment) => segment === '')) {
    return 'mount_path must not contain an empty path segment';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'mount_path must not contain "." or ".." segments';
  }
  return undefined;
}

/**
 * Map a canonical mount path to its sandbox location.
 *
 * Only the leading `/` is consumed; the rest of the path is kept whole so a
 * nested relative layout survives the mapping.
 */
export function sandboxPathFor(mountPath: string): string {
  return `${FILE_MOUNT_ROOT}/${mountPath.slice(1)}`;
}

/**
 * Recover the canonical path from a sandbox path.
 *
 * Used when reading a session row whose resource was written by an older build
 * that stored the internal path directly, so the two spellings converge on one
 * canonical value instead of being echoed back unchanged.
 */
export function canonicalPathFromSandboxPath(sandboxPath: string): string | undefined {
  if (!sandboxPath.startsWith(`${FILE_MOUNT_ROOT}/`)) return undefined;
  return `/${sandboxPath.slice(FILE_MOUNT_ROOT.length + 1)}`;
}
