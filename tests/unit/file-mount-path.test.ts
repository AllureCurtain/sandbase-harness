/**
 * Canonical file-resource mount paths.
 *
 * The contract defines `mount_path` as a logical path inside the session, with
 * the sandbox location derived from it. These tests pin the two properties the
 * previous implementation got wrong: the documented example must be accepted,
 * and a nested path must survive the mapping intact rather than collapsing to
 * its basename.
 */

import { describe, expect, it } from 'vitest';
import {
  FILE_MOUNT_ROOT,
  canonicalPathFromSandboxPath,
  resolveFileMountPath,
  sandboxPathFor,
  validateCanonicalMountPath,
} from '@/core/session/file-mount-path.js';

describe('resolveFileMountPath', () => {
  it('accepts the documented example and maps it under the session root', () => {
    const result = resolveFileMountPath('/data.csv', 'file_abc');

    expect(result.ok).toBe(true);
    expect(result.mountPath).toBe('/data.csv');
    expect(result.sandboxPath).toBe('/mnt/session/uploads/data.csv');
  });

  it('preserves a nested relative path instead of collapsing to the basename', () => {
    const result = resolveFileMountPath('/src/main.py', 'file_abc');

    expect(result.ok).toBe(true);
    expect(result.mountPath).toBe('/src/main.py');
    expect(result.sandboxPath).toBe('/mnt/session/uploads/src/main.py');
  });

  it('defaults to the file id when mount_path is omitted', () => {
    const result = resolveFileMountPath(undefined, 'file_abc');

    expect(result.ok).toBe(true);
    expect(result.mountPath).toBe('/file_abc');
    expect(result.sandboxPath).toBe('/mnt/session/uploads/file_abc');
  });

  it('treats a blank mount_path as omitted', () => {
    expect(resolveFileMountPath('   ', 'file_abc').mountPath).toBe('/file_abc');
    expect(resolveFileMountPath('', 'file_abc').mountPath).toBe('/file_abc');
  });

  it('rejects a parent-directory segment', () => {
    expect(resolveFileMountPath('/../../etc/passwd', 'file_abc').ok).toBe(false);
    expect(resolveFileMountPath('/a/../b', 'file_abc').ok).toBe(false);
  });

  it('rejects a relative path', () => {
    expect(resolveFileMountPath('data.csv', 'file_abc').ok).toBe(false);
  });

  it('rejects a backslash so one logical path cannot mean two sandbox paths', () => {
    expect(resolveFileMountPath('/a\\b', 'file_abc').ok).toBe(false);
  });

  it('rejects a NUL byte', () => {
    expect(resolveFileMountPath('/a\0b', 'file_abc').ok).toBe(false);
  });

  it('rejects the bare root and empty segments', () => {
    expect(resolveFileMountPath('/', 'file_abc').ok).toBe(false);
    expect(resolveFileMountPath('/a//b', 'file_abc').ok).toBe(false);
  });

  it('rejects an explicit current-directory segment', () => {
    expect(resolveFileMountPath('/a/./b', 'file_abc').ok).toBe(false);
  });

  it('accepts the legacy /uploads/ spelling as a canonical path too', () => {
    // A caller that followed the old documentation sent `/uploads/x`; under the
    // canonical rules that is simply a path with an `uploads` segment, and the
    // sandbox mapping must not silently apply the prefix twice.
    const result = resolveFileMountPath('/uploads/notes.txt', 'file_abc');

    expect(result.ok).toBe(true);
    expect(result.sandboxPath).toBe('/mnt/session/uploads/uploads/notes.txt');
  });
});

describe('validateCanonicalMountPath', () => {
  it('returns no error for a well-formed path', () => {
    expect(validateCanonicalMountPath('/a/b.txt')).toBeUndefined();
  });

  it('never validates a path just because it carries the internal prefix', () => {
    // The old rule keyed off `/uploads/`, which made the internal layout the
    // thing that decided validity. A traversal is still a traversal.
    expect(validateCanonicalMountPath('/uploads/../../escape')).toBeDefined();
  });
});

describe('sandboxPathFor', () => {
  it('consumes only the leading slash', () => {
    expect(sandboxPathFor('/a/b/c.txt')).toBe(`${FILE_MOUNT_ROOT}/a/b/c.txt`);
  });
});

describe('canonicalPathFromSandboxPath', () => {
  it('recovers the canonical path from an internal one', () => {
    expect(canonicalPathFromSandboxPath('/mnt/session/uploads/data.csv')).toBe('/data.csv');
  });

  it('preserves a nested relative layout on the way back', () => {
    expect(canonicalPathFromSandboxPath('/mnt/session/uploads/src/main.py')).toBe('/src/main.py');
  });

  it('returns undefined for a path outside the mount root', () => {
    expect(canonicalPathFromSandboxPath('/tmp/data.csv')).toBeUndefined();
    expect(canonicalPathFromSandboxPath(FILE_MOUNT_ROOT)).toBeUndefined();
  });

  it('round-trips a canonical path', () => {
    const canonical = '/report/2026/q3.pdf';

    expect(canonicalPathFromSandboxPath(sandboxPathFor(canonical))).toBe(canonical);
  });
});
